# Covers: MEM-101, MEM-102
# Requirement: the GCP deploy scripts are safe to run as checked in: deploy_cloud_run.sh takes MODE
# (fixture|meta, default fixture, anything else refused before any change), maps the access and record
# keys always and the Meta key only in meta mode via Secret Manager (never the old passcode, optional
# secrets only when they exist), grants the runtime account read on each mapped secret before deploying,
# and locks ingress to the load balancer with two trusted proxy hops when EDGE_HOST is set;
# deploy_edge_gcp.sh idempotently builds the HTTPS load balancer + Cloud Armor edge on an sslip.io host.
# Neither script ever reads a secret value.
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
DEPLOY = REPO / "scripts" / "deploy_cloud_run.sh"
EDGE = REPO / "scripts" / "deploy_edge_gcp.sh"
SH = shutil.which("sh")
END = "@@END@@"
IP = "34.1.2.3"
HOST = "34-1-2-3.sslip.io"
REQUIRED_SECRETS = "memripal-access-key,memripal-record-key,meta-api-key"

pytestmark = pytest.mark.skipif(SH is None, reason="POSIX sh not found on PATH")

# Fake gcloud: logs each argv (one arg per line, END-terminated). `secrets describe N` succeeds iff N is
# in FAKE_GCLOUD_SECRETS; any other `<kind> describe <name>` succeeds iff `kind:name` is in
# FAKE_GCLOUD_EXISTING ("*" = everything) or was created earlier in the run; `addresses describe`
# prints the IP. `create` records `kind:name`. Everything else exits 0 silently.
FAKE_GCLOUD = r"""#!/bin/sh
log="$FAKE_GCLOUD_LOG"
for a in "$@"; do printf '%s\n' "$a" >> "$log"; done
printf '%s\n' '@@END@@' >> "$log"
state="$log.state"
touch "$state"
verb=""; kind=""; name=""; prev=""
for a in "$@"; do
  if [ -z "$verb" ]; then
    case "$a" in describe|create) verb="$a"; kind="$prev";; esac
    prev="$a"
  elif [ -z "$name" ]; then
    case "$a" in -*) ;; *) name="$a";; esac
  fi
done
case "$*" in
  "config get-value project"*) echo fake-proj; exit 0;;
esac
if [ "$kind" = "projects" ] && [ "$verb" = "describe" ]; then echo 123456789; exit 0; fi
if [ "$kind" = "secrets" ] && [ "$verb" = "describe" ]; then
  case ",$FAKE_GCLOUD_SECRETS," in *",$name,"*) exit 0;; *) echo "NOT_FOUND: $name" >&2; exit 1;; esac
fi
key="$kind:$name"
if [ "$verb" = "create" ]; then printf '%s\n' "$key" >> "$state"; exit 0; fi
if [ "$verb" = "describe" ]; then
  found=""
  [ "$FAKE_GCLOUD_EXISTING" = "*" ] && found=1
  case ",$FAKE_GCLOUD_EXISTING," in *",$key,"*) found=1;; esac
  grep -qxF "$key" "$state" && found=1
  if [ -z "$found" ]; then echo "NOT_FOUND: $key" >&2; exit 1; fi
  [ "$kind" = "addresses" ] && echo "$FAKE_GCLOUD_IP"
  exit 0
fi
exit 0
"""


def _run(script: Path, tmp_path: Path, secrets: str = REQUIRED_SECRETS, existing: str = "", **env):
    assert script.is_file(), f"missing script: {script.relative_to(REPO).as_posix()}"
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "gcloud").write_bytes(FAKE_GCLOUD.encode("ascii"))
    os.chmod(bindir / "gcloud", 0o755)
    log = tmp_path / "gcloud.log"
    full = {k: v for k, v in os.environ.items() if k not in {"MODE", "EDGE_HOST", "EXTRA_HOSTS"}}
    full.update(
        PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        GCP_PROJECT="fake-proj",
        REGION="us-central1",
        SERVICE="memripal",
        FAKE_GCLOUD_LOG=log.as_posix(),
        FAKE_GCLOUD_SECRETS=secrets,
        FAKE_GCLOUD_EXISTING=existing,
        FAKE_GCLOUD_IP=IP,
    )
    full.update(env)
    proc = subprocess.run(
        [SH, script.as_posix()], env=full, capture_output=True, text=True, timeout=120, check=False
    )
    calls, cur = [], []
    if log.exists():
        for line in log.read_text(encoding="utf-8").splitlines():
            if line == END:
                calls.append(cur)
                cur = []
            else:
                cur.append(line)
    return proc, calls


def _has(argv: list[str], *words: str) -> bool:
    n = len(words)
    return any(tuple(argv[i : i + n]) == words for i in range(len(argv) - n + 1))


def _after(argv: list[str], *words: str) -> str | None:
    """First non-flag token after the consecutive `words`."""
    n = len(words)
    for i in range(len(argv) - n + 1):
        if tuple(argv[i : i + n]) == words:
            return next((a for a in argv[i + n :] if not a.startswith("-")), None)
    return None


def _flag(argv: list[str], name: str) -> list[str]:
    vals = []
    for i, a in enumerate(argv):
        if a.startswith(name + "="):
            vals.append(a[len(name) + 1 :])
        elif a == name and i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            vals.append(argv[i + 1])
    return vals


def _pairs(value: str) -> dict[str, str]:
    """gcloud list syntax: comma-separated, or ^D^-prefixed custom delimiter D."""
    delim = ","
    m = re.match(r"\^(.+?)\^", value)
    if m:
        delim, value = m.group(1), value[m.end() :]
    return dict(item.split("=", 1) if "=" in item else (item, "") for item in value.split(delim) if item)


def _deploy(calls):
    deploys = [i for i, c in enumerate(calls) if _has(c, "run", "deploy")]
    assert len(deploys) == 1, f"expected exactly one `run deploy` call, got {len(deploys)}"
    return deploys[0], calls[deploys[0]]


def _secrets(argv) -> dict[str, str]:
    out: dict[str, str] = {}
    for v in _flag(argv, "--set-secrets"):
        out |= _pairs(v)
    return out


def _env(argv) -> dict[str, str]:
    out: dict[str, str] = {}
    for v in _flag(argv, "--set-env-vars"):
        out |= _pairs(v)
    return out


def _ok(proc):
    assert proc.returncode == 0, f"exit {proc.returncode}\nstdout:{proc.stdout}\nstderr:{proc.stderr}"


def test_fixture_mode_maps_access_and_record_keys_only(tmp_path):
    proc, calls = _run(DEPLOY, tmp_path, MODE="fixture")
    _ok(proc)
    _, argv = _deploy(calls)
    sec = _secrets(argv)
    assert sec.get("MEMRIPAL_ACCESS_KEY") == "memripal-access-key:latest", sec
    assert sec.get("MEMRIPAL_RECORD_KEY") == "memripal-record-key:latest", sec
    assert "META_API_KEY" not in sec, f"fixture mode maps the Meta key: {sec}"
    assert _env(argv).get("MEMRIPAL_MODE") == "fixture"


def test_mode_defaults_to_fixture(tmp_path):
    proc, calls = _run(DEPLOY, tmp_path)
    _ok(proc)
    _, argv = _deploy(calls)
    assert _env(argv).get("MEMRIPAL_MODE") == "fixture"
    assert "META_API_KEY" not in _secrets(argv)


def test_meta_mode_adds_meta_key(tmp_path):
    proc, calls = _run(DEPLOY, tmp_path, MODE="meta")
    _ok(proc)
    _, argv = _deploy(calls)
    sec = _secrets(argv)
    assert sec.get("META_API_KEY") == "meta-api-key:latest", sec
    assert sec.get("MEMRIPAL_ACCESS_KEY") == "memripal-access-key:latest", sec
    assert sec.get("MEMRIPAL_RECORD_KEY") == "memripal-record-key:latest", sec
    assert _env(argv).get("MEMRIPAL_MODE") == "meta"


def test_unknown_mode_is_refused_before_any_change(tmp_path):
    proc, calls = _run(DEPLOY, tmp_path, MODE="bogus")
    assert proc.returncode != 0, "MODE=bogus was accepted"
    assert not [c for c in calls if _has(c, "run", "deploy")], "MODE=bogus still deployed"
    assert not [c for c in calls if "add-iam-policy-binding" in c], "MODE=bogus changed IAM"


@pytest.mark.parametrize("mode", ["fixture", "meta"])
def test_passcode_is_never_mapped(tmp_path, mode):
    proc, calls = _run(DEPLOY, tmp_path, secrets=REQUIRED_SECRETS + ",memripal-passcode", MODE=mode)
    _ok(proc)
    _, argv = _deploy(calls)
    sec = _secrets(argv)
    assert "MEMRIPAL_PASSCODE" not in sec, sec
    assert not any(v.startswith("memripal-passcode:") for v in sec.values()), sec


@pytest.mark.parametrize(
    "env_name",
    ["BASETEN_API_KEY", "FIREWORKS_API_KEY", "MODAL_SEG_TOKEN", "MEMRIPAL_MAPILLARY_TOKEN"],
)
def test_optional_secret_mapped_only_when_it_exists(tmp_path, env_name):
    secret = env_name.lower().replace("_", "-")
    absent_dir, present_dir = tmp_path / "absent", tmp_path / "present"
    absent_dir.mkdir()
    present_dir.mkdir()
    proc, calls = _run(DEPLOY, absent_dir, MODE="fixture")
    _ok(proc)
    assert env_name not in _secrets(_deploy(calls)[1]), f"{env_name} mapped though {secret} is missing"
    proc, calls = _run(DEPLOY, present_dir, secrets=f"{REQUIRED_SECRETS},{secret}", MODE="fixture")
    _ok(proc)
    assert _secrets(_deploy(calls)[1]).get(env_name) == f"{secret}:latest"


@pytest.mark.parametrize("mode", ["fixture", "meta"])
def test_each_mapped_secret_gets_accessor_binding_before_deploy(tmp_path, mode):
    proc, calls = _run(DEPLOY, tmp_path, secrets=REQUIRED_SECRETS + ",baseten-api-key", MODE=mode)
    _ok(proc)
    idx, argv = _deploy(calls)
    mapped = sorted(v.split(":", 1)[0] for v in _secrets(argv).values())
    bindings = [(i, c) for i, c in enumerate(calls) if _has(c, "secrets", "add-iam-policy-binding")]
    bound = sorted(_after(c, "secrets", "add-iam-policy-binding") for _, c in bindings)
    assert bound == mapped, f"bindings {bound} != mapped secrets {mapped}"
    for i, c in bindings:
        assert i < idx, f"binding after deploy: {c}"
        assert any("roles/secretmanager.secretAccessor" in r for r in _flag(c, "--role")), c


def test_edge_host_locks_ingress_and_trusts_two_hops(tmp_path):
    proc, calls = _run(DEPLOY, tmp_path, MODE="meta", EDGE_HOST=HOST)
    _ok(proc)
    _, argv = _deploy(calls)
    assert _flag(argv, "--ingress") == ["internal-and-cloud-load-balancing"], argv
    env = _env(argv)
    assert HOST in env.get("MEMRIPAL_ALLOWED_HOSTS", "").split(","), env
    assert env.get("MEMRIPAL_TRUSTED_PROXY_HOPS") == "2", env


def test_no_edge_host_keeps_public_ingress_and_default_hops(tmp_path):
    proc, calls = _run(DEPLOY, tmp_path, MODE="fixture")
    _ok(proc)
    _, argv = _deploy(calls)
    assert _flag(argv, "--ingress") == ["all"], f"ingress not reset to all: {argv}"
    assert "MEMRIPAL_TRUSTED_PROXY_HOPS" not in _env(argv)


@pytest.mark.parametrize("edge", ["", HOST])
def test_deploy_keeps_single_instance_public_invoker_and_no_secret_env(tmp_path, edge):
    extra = {"EDGE_HOST": edge} if edge else {}
    proc, calls = _run(DEPLOY, tmp_path, MODE="meta", **extra)
    _ok(proc)
    _, argv = _deploy(calls)
    assert _flag(argv, "--max-instances") == ["1"], argv
    assert "--allow-unauthenticated" in argv
    leaked = [n for n in _env(argv) if re.search(r"KEY|TOKEN|SECRET|PASSCODE", n)]
    assert not leaked, f"secret-named plain env vars: {leaked}"
    assert not [c for c in calls if _has(c, "versions", "access")], "deploy read a secret value"


def _creates(calls, kind):
    return [c for c in calls if _has(c, kind, "create")]


def test_edge_builds_every_resource_when_nothing_exists(tmp_path):
    proc, calls = _run(EDGE, tmp_path, existing="services:memripal")
    _ok(proc)
    assert [c for c in _creates(calls, "addresses") if "--global" in c], "no global static IP created"
    negs = _creates(calls, "network-endpoint-groups")
    assert negs, "no NEG created"
    assert any(
        _flag(c, "--network-endpoint-type") == ["serverless"]
        and _flag(c, "--cloud-run-service") == ["memripal"]
        for c in negs
    ), negs
    assert _creates(calls, "backend-services"), "no backend service created"
    assert _creates(calls, "security-policies"), "no Cloud Armor policy created"
    attach = [c for c in calls if "backend-services" in c and _flag(c, "--security-policy")]
    assert attach, "Armor policy never attached to the backend service"
    rules = [" ".join(c) for c in _creates(calls, "rules")]
    ban = [r for r in rules if "rate-based-ban" in r]
    assert ban and re.search(r"--enforce-on-key[= ]IP\b", ban[0]), f"no IP-keyed rate-based ban: {rules}"
    for waf in ("sqli", "xss"):
        hit = [r for r in rules if waf in r and re.search(r"sensitivity['\"]?\s*:\s*1\b", r)]
        assert hit, f"no {waf} WAF rule at sensitivity 1: {rules}"
    assert _creates(calls, "url-maps"), "no URL map created"
    certs = _creates(calls, "ssl-certificates")
    domains = [d for c in certs for d in _flag(c, "--domains")]
    assert any(HOST in d for d in domains), f"no managed cert for {HOST}: {certs}"
    assert _creates(calls, "target-https-proxies"), "no target HTTPS proxy created"
    fwd = _creates(calls, "forwarding-rules")
    assert any("443" in p for c in fwd for p in _flag(c, "--ports")), f"no :443 forwarding rule: {fwd}"
    assert HOST in proc.stdout, f"host not printed: {proc.stdout!r}"


def test_edge_is_idempotent_when_everything_exists(tmp_path):
    proc, calls = _run(EDGE, tmp_path, existing="*")
    _ok(proc)
    assert calls, "edge script never called gcloud"
    created = [c for c in calls if "create" in c]
    assert not created, f"re-run created resources: {created}"
    assert HOST in proc.stdout, f"host not printed: {proc.stdout!r}"


@pytest.mark.parametrize("existing", ["services:memripal", "*"])
def test_edge_never_touches_secrets(tmp_path, existing):
    proc, calls = _run(EDGE, tmp_path, existing=existing)
    _ok(proc)
    assert not [c for c in calls if "secrets" in c], "edge script called gcloud secrets"
