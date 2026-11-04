# Covers: MEM-104
# Requirement: scripts/create_secrets.sh creates the three Secret Manager secrets deploy_cloud_run.sh
# maps. The access and record keys are generated only when missing (an existing access key is never
# rotated; the access key is printed once, the record key never). The Meta key comes from META_API_KEY
# if set; else from decrypting the DPAPI file at $MEMRIPAL_META_KEY_FILE (default
# $HOME/.secrets/meta-api-key.dpapi) via `powershell -NoProfile -Command`, the path passed in the
# MEMRIPAL_META_KEY_FILE env var, never argv; else a hidden prompt on a terminal; else the script
# exits non-zero naming the key file. The Meta key is piped with no trailing newline, never appears in
# stdout/stderr/gcloud argv, and goes to a new version (never `secrets create`) when meta-api-key exists.
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "create_secrets.sh"
BASH = shutil.which("bash")
META = "meta-SENTINEL-value-123"
META_ENV = "meta-ENVONLY-value-456"
ALL3 = "memripal-access-key,memripal-record-key,meta-api-key"

pytestmark = pytest.mark.skipif(BASH is None, reason="bash not found on PATH")

# Fake gcloud: logs argv (space-joined, one call per line) to FAKE_LOG; for `--data-file=-` it saves
# stdin verbatim to FAKE_DIR/<secret>.<n>. `secrets describe N` succeeds iff N is in FAKE_SECRETS.
FAKE_GCLOUD = r"""#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
  "config get-value project"*) echo fake-proj; exit 0;;
  "secrets describe "*) case ",$FAKE_SECRETS," in *",$3,"*) exit 0;; *) exit 1;; esac;;
  "secrets create "*) name="$3";;
  "secrets versions add "*) name="$4";;
  *) exit 0;;
esac
n=$(ls "$FAKE_DIR" | grep -c "^$name\." || true)
cat > "$FAKE_DIR/$name.$n"
"""

# Fake powershell: logs argv to FAKE_PS_LOG; fails unless the env-named key file exists; prints the
# decrypted sentinel with no trailing newline.
FAKE_POWERSHELL = r"""#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_PS_LOG"
[ -f "$MEMRIPAL_META_KEY_FILE" ] || exit 1
printf %s 'meta-SENTINEL-value-123'
"""


def _run(tmp_path: Path, secrets: str = "", meta: str | None = None, key_file: bool = True):
    assert SCRIPT.is_file(), "missing scripts/create_secrets.sh"
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name, body in (("gcloud", FAKE_GCLOUD), ("powershell", FAKE_POWERSHELL)):
        (bindir / name).write_bytes(body.encode("ascii"))
        os.chmod(bindir / name, 0o755)
    store = tmp_path / "store"
    store.mkdir()
    keyfile = tmp_path / "meta-api-key.dpapi"
    if key_file:
        keyfile.write_bytes(b"dummy-dpapi-blob")
    ps_log = tmp_path / "ps.log"
    drop = {"META_API_KEY", "GCP_PROJECT", "MEMRIPAL_META_KEY_FILE"}
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env.update(
        PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        HOME=str(tmp_path),
        MEMRIPAL_META_KEY_FILE=keyfile.as_posix(),
        FAKE_LOG=str(tmp_path / "gcloud.log"),
        FAKE_PS_LOG=str(ps_log),
        FAKE_DIR=str(store),
        FAKE_SECRETS=secrets,
    )
    if meta is not None:
        env["META_API_KEY"] = meta
    proc = subprocess.run(
        [BASH, SCRIPT.as_posix()],
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=60,
    )
    log = (tmp_path / "gcloud.log").read_text() if (tmp_path / "gcloud.log").exists() else ""
    ps = ps_log.read_text() if ps_log.exists() else ""
    stored = {p.name: p.read_bytes() for p in store.iterdir()}
    return proc, log, ps, stored


def test_creates_all_three_from_dpapi_file_without_env(tmp_path):
    proc, log, ps, stored = _run(tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert stored["meta-api-key.0"] == META.encode()
    for name in ("memripal-access-key.0", "memripal-record-key.0"):
        assert len(stored[name]) >= 24 and not stored[name].endswith(b"\n")
    assert stored["memripal-access-key.0"].decode() in proc.stdout
    assert stored["memripal-record-key.0"].decode() not in proc.stdout
    assert META not in proc.stdout + proc.stderr + log
    assert ps.strip(), "powershell was not invoked to decrypt the DPAPI key file"
    assert META not in ps


def test_existing_secrets_keep_keys_and_meta_gets_new_version(tmp_path):
    proc, log, ps, stored = _run(tmp_path, secrets=ALL3)
    assert proc.returncode == 0, proc.stderr
    assert set(stored) == {"meta-api-key.0"} and stored["meta-api-key.0"] == META.encode()
    assert "secrets versions add meta-api-key" in log
    assert "secrets create" not in log
    assert "ACCESS KEY" not in proc.stdout


def test_refuses_when_key_file_missing_and_no_env_or_terminal(tmp_path):
    proc, log, ps, stored = _run(tmp_path, secrets="memripal-access-key,memripal-record-key", key_file=False)
    assert proc.returncode != 0
    assert "meta-api-key.dpapi" in proc.stderr
    assert "meta-api-key.0" not in stored


def test_env_meta_key_wins_and_skips_powershell(tmp_path):
    proc, log, ps, stored = _run(tmp_path, meta=META_ENV)
    assert proc.returncode == 0, proc.stderr
    assert stored["meta-api-key.0"] == META_ENV.encode()
    assert ps == "", "powershell must not run when META_API_KEY is set"
    assert META_ENV not in proc.stdout + proc.stderr + log
