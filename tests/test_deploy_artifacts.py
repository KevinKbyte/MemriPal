# Covers: MEM-034
# Requirement: the Cloud Run deploy artifacts (Dockerfile, .dockerignore, scripts/deploy_cloud_run.sh)
# ship a non-root fixture-mode image that holds no secrets, and deploy it with one instance, a call
# budget, a body cap and the key/passcode injected only via Secret Manager.
import json
import re
import shlex
from pathlib import Path, PurePosixPath

import pytest

REPO = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO / "Dockerfile"
DOCKERIGNORE = REPO / ".dockerignore"
DEPLOY_SCRIPT = REPO / "scripts" / "deploy_cloud_run.sh"

SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSCODE|PASSWORD", re.IGNORECASE)
ENV_SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSCODE", re.IGNORECASE)


def _read(path: Path) -> str:
    assert path.is_file(), f"missing deploy artifact: {path.relative_to(REPO).as_posix()}"
    return path.read_text(encoding="utf-8")


def _logical_lines(text: str) -> list[str]:
    """Join backslash continuations; drop blank and comment-only lines."""
    joined = re.sub(r"\\\r?\n", " ", text)
    return [ln.strip() for ln in joined.splitlines() if ln.strip() and not ln.strip().startswith("#")]


def _instructions() -> list[tuple[str, str]]:
    out = []
    for line in _logical_lines(_read(DOCKERFILE)):
        keyword, _, args = line.partition(" ")
        out.append((keyword.upper(), args.strip()))
    return out


def _exec_or_shell(args: str) -> list[str] | str:
    """Exec-form JSON array -> list; shell form -> the raw string."""
    if args.startswith("["):
        return json.loads(args)
    return args


def _env_names(keyword: str, args: str) -> list[str]:
    tokens = shlex.split(args)
    if not tokens:
        return []
    if keyword == "ARG":
        return [tokens[0].split("=", 1)[0]]
    if "=" in tokens[0]:
        return [t.split("=", 1)[0] for t in tokens if "=" in t]
    return [tokens[0]]


# Requirement: the image runs as a non-root user.
def test_dockerfile_final_user_is_not_root():
    users = [args for kw, args in _instructions() if kw == "USER"]
    assert users, "Dockerfile has no USER instruction (would run as root)"
    final_user = users[-1].split(":", 1)[0].strip()
    assert final_user not in {"root", "0"}, f"final USER is {final_user!r}"


# Requirement: no secret-named build arg or env var is baked into the image.
def test_dockerfile_has_no_secret_named_env_or_arg():
    names = [n for kw, args in _instructions() if kw in {"ENV", "ARG"} for n in _env_names(kw, args)]
    leaked = [n for n in names if SECRET_NAME.search(n)]
    assert not leaked, f"secret-named ENV/ARG in Dockerfile: {leaked}"


# Requirement: no secret file (.env, *.dpapi, .secrets, refs/private) is copied into the image.
def test_dockerfile_copies_no_secret_files():
    forbidden = re.compile(r"(^|/)\.env$|\.dpapi$|(^|/)\.secrets(/|$)|(^|/)refs/private(/|$)")
    bad = []
    for kw, args in _instructions():
        if kw not in {"COPY", "ADD"}:
            continue
        parsed = _exec_or_shell(args)
        tokens = parsed if isinstance(parsed, list) else shlex.split(parsed)
        sources = [t for t in tokens if not t.startswith("--")][:-1]
        bad += [s for s in sources if forbidden.search(s.removeprefix("./").rstrip("/"))]
    assert not bad, f"Dockerfile COPY/ADD of secret paths: {bad}"


# Requirement: the container starts uvicorn on 0.0.0.0 at Cloud Run's $PORT (expanded by a shell).
def test_dockerfile_cmd_runs_uvicorn_on_port_env():
    starts = [(kw, args) for kw, args in _instructions() if kw in {"CMD", "ENTRYPOINT"} and "uvicorn" in args]
    assert starts, "Dockerfile has no CMD/ENTRYPOINT running uvicorn"
    parsed = _exec_or_shell(starts[-1][1])
    if isinstance(parsed, list):
        assert len(parsed) >= 3 and parsed[0] in {"sh", "/bin/sh"} and parsed[1] == "-c", (
            f"exec-form {parsed} cannot expand $PORT; wrap it in sh -c"
        )
        command = parsed[2]
    else:
        command = parsed
    assert "uvicorn memripal.app:app" in command
    assert re.search(r"--host[= ]0\.0\.0\.0\b", command), f"no --host 0.0.0.0 in {command!r}"
    assert re.search(r"--port[= ]\"?\$\{?PORT\b", command), f"no --port $PORT in {command!r}"


# Requirement: the image never defaults to live meta mode.
def test_dockerfile_never_sets_meta_mode():
    assert not re.search(r"MEMRIPAL_MODE\s*[= ]\s*[\"']?meta", _read(DOCKERFILE))


def _ignored(rel: str, patterns: list[tuple[bool, str]]) -> bool:
    """Docker-style last-match-wins: a pattern matching a path or any ancestor dir decides it."""
    parts = PurePosixPath(rel).parts
    candidates = [PurePosixPath(*parts[:i]) for i in range(1, len(parts) + 1)]
    excluded = False
    for negated, pattern in patterns:
        if any(c.full_match(pattern) for c in candidates):
            excluded = not negated
    return excluded


def _dockerignore_patterns() -> list[tuple[bool, str]]:
    out = []
    for line in _read(DOCKERIGNORE).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        negated = line.startswith("!")
        pattern = line[1:].strip() if negated else line
        pattern = pattern.strip("/")
        if pattern.startswith("./"):
            pattern = pattern[2:]
        if pattern:
            out.append((negated, pattern))
    return out


# Requirement: the build context excludes VCS data, venvs, private refs, env files, DPAPI blobs, raw fixtures.
@pytest.mark.parametrize(
    "rel",
    [
        ".git/HEAD",
        ".venv/Lib/site-packages/x.py",
        "refs/private/notes.md",
        ".env",
        "key.dpapi",
        "secrets/meta.dpapi",
        "a/b/deep.dpapi",
        "fixtures/raw/photo.jpg",
    ],
)
def test_dockerignore_excludes_sensitive_paths(rel):
    assert _ignored(rel, _dockerignore_patterns()), f".dockerignore does not exclude {rel}"


# Requirement: the build context still includes what the fixture-mode app needs to run.
@pytest.mark.parametrize(
    "rel",
    ["src/memripal/app.py", "static/index.html", "pyproject.toml", "fixtures/demo/photo.jpg"],
)
def test_dockerignore_keeps_runtime_files(rel):
    assert not _ignored(rel, _dockerignore_patterns()), f".dockerignore wrongly excludes {rel}"


def _flag_values(script: str, flag: str) -> list[str]:
    return [m.group(2) for m in re.finditer(rf"{flag}[= ](['\"]?)(\S+?)\1(?=\s|$)", script)]


def _pairs(value: str) -> dict[str, str]:
    """gcloud list syntax: comma-separated, or ^D^-prefixed custom delimiter D."""
    delim = ","
    m = re.match(r"\^(.+?)\^", value)
    if m:
        delim, value = m.group(1), value[m.end() :]
    return dict(item.split("=", 1) if "=" in item else (item, "") for item in value.split(delim) if item)


def _deploy_script() -> str:
    return " ".join(_logical_lines(_read(DEPLOY_SCRIPT)))


# Requirement: the deploy runs gcloud run deploy capped at a single instance.
def test_deploy_script_runs_gcloud_with_one_instance():
    script = _deploy_script()
    assert "gcloud run deploy" in script
    assert re.search(r"--max-instances[= ]1\b", script), "deploy is not capped at --max-instances=1"


# Requirement: the API key and passcode reach Cloud Run only via --set-secrets.
def test_deploy_script_maps_key_and_passcode_as_secrets():
    names = set()
    for value in _flag_values(_deploy_script(), "--set-secrets"):
        names |= set(_pairs(value))
    assert {"META_API_KEY", "MEMRIPAL_PASSCODE"} <= names, f"--set-secrets maps only {sorted(names)}"


# Requirement: plain env vars pin fixture mode, int call budget, int body cap, allowed hosts; never secrets.
def test_deploy_script_env_vars_pin_fixture_mode_and_caps():
    env: dict[str, str] = {}
    for value in _flag_values(_deploy_script(), "--set-env-vars"):
        env |= _pairs(value)
    assert env.get("MEMRIPAL_MODE") == "fixture", f"MEMRIPAL_MODE={env.get('MEMRIPAL_MODE')!r}"
    assert re.fullmatch(r"\d+", env.get("MEMRIPAL_CALL_BUDGET", "")), "MEMRIPAL_CALL_BUDGET not an int"
    assert re.fullmatch(r"\d+", env.get("MEMRIPAL_MAX_BODY_BYTES", "")), "MEMRIPAL_MAX_BODY_BYTES not an int"
    assert "MEMRIPAL_ALLOWED_HOSTS" in env, "MEMRIPAL_ALLOWED_HOSTS not set"
    leaked = [n for n in env if ENV_SECRET_NAME.search(n)]
    assert not leaked, f"secret-named plain env vars: {leaked}"


# Requirement: the deploy script never reads secret values locally (Secret Manager, DPAPI, SecureString).
def test_deploy_script_never_touches_secret_values():
    text = _read(DEPLOY_SCRIPT)
    for needle in ("versions access", "dpapi", "ConvertTo-SecureString"):
        assert needle.lower() not in text.lower(), f"deploy script contains {needle!r}"
