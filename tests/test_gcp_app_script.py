# Covers: MEM-147
# Requirement: scripts/gcp_app.sh lets the operator stop, start, and inspect the deployed GCP app
# without redeploying: `stop` locks Cloud Run ingress to internal and removes the public HTTPS
# forwarding rule if present (idempotent); `start` refuses (pointing at scripts/deploy_edge_gcp.sh)
# when the edge IP or HTTPS proxy is missing, otherwise recreates the rule if absent and reopens
# ingress to the load balancer; `status` is read-only and prints the ingress value and whether the
# rule exists; a missing or unknown command exits 2 with usage. No mode ever deploys, touches
# secrets, or changes env vars.
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "gcp_app.sh"
SH = shutil.which("sh")
END = "@@END@@"
RULE = "forwarding-rules:memripal-https-rule"
ADDR = "addresses:memripal-edge-ip"
PROXY = "target-https-proxies:memripal-https-proxy"
EDGE_READY = f"{ADDR},{PROXY}"

pytestmark = pytest.mark.skipif(SH is None, reason="POSIX sh not found on PATH")

# Fake gcloud: logs each argv (one arg per line, END-terminated). `<kind> describe <name>` succeeds
# iff `kind:name` is in FAKE_GCLOUD_EXISTING or was created earlier in the run, except
# `services describe`, which always succeeds and prints FAKE_GCLOUD_INGRESS. `create` records
# `kind:name`; `delete` forgets it. Everything else exits 0 silently.
FAKE_GCLOUD = r"""#!/bin/sh
log="$FAKE_GCLOUD_LOG"
for a in "$@"; do printf '%s\n' "$a" >> "$log"; done
printf '%s\n' '@@END@@' >> "$log"
state="$log.state"
touch "$state"
verb=""; kind=""; name=""; prev=""
for a in "$@"; do
  if [ -z "$verb" ]; then
    case "$a" in describe|create|delete) verb="$a"; kind="$prev";; esac
    prev="$a"
  elif [ -z "$name" ]; then
    case "$a" in -*) ;; *) name="$a";; esac
  fi
done
case "$*" in
  "config get-value project"*) echo fake-proj; exit 0;;
esac
if [ "$kind" = "services" ] && [ "$verb" = "describe" ]; then
  echo "$FAKE_GCLOUD_INGRESS"; exit 0
fi
key="$kind:$name"
if [ "$verb" = "create" ]; then printf '%s\n' "$key" >> "$state"; exit 0; fi
if [ "$verb" = "delete" ]; then
  grep -vxF "$key" "$state" > "$state.tmp"; mv "$state.tmp" "$state"
  printf '%s\n' "deleted:$key" >> "$state"; exit 0
fi
if [ "$verb" = "describe" ]; then
  found=""
  case ",$FAKE_GCLOUD_EXISTING," in *",$key,"*) found=1;; esac
  grep -qxF "deleted:$key" "$state" && found=""
  grep -qxF "$key" "$state" && found=1
  if [ -z "$found" ]; then echo "NOT_FOUND: $key" >&2; exit 1; fi
  exit 0
fi
exit 0
"""


def _run(tmp_path: Path, *args: str, existing: str = "", ingress: str = "internal"):
    assert SCRIPT.is_file(), f"missing script: {SCRIPT.relative_to(REPO).as_posix()}"
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "gcloud").write_bytes(FAKE_GCLOUD.encode("ascii"))
    os.chmod(bindir / "gcloud", 0o755)
    log = tmp_path / "gcloud.log"
    env = dict(os.environ)
    env.update(
        PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""),
        FAKE_GCLOUD_LOG=log.as_posix(),
        FAKE_GCLOUD_EXISTING=existing,
        FAKE_GCLOUD_INGRESS=ingress,
    )
    proc = subprocess.run(
        [SH, SCRIPT.as_posix(), *args], env=env, capture_output=True, text=True, timeout=120, check=False
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


def _flag(argv: list[str], name: str) -> list[str]:
    """Values of `name`, accepting both `--x=v` and `--x v` forms."""
    vals = []
    for i, a in enumerate(argv):
        if a.startswith(name + "="):
            vals.append(a[len(name) + 1 :])
        elif a == name and i + 1 < len(argv):
            vals.append(argv[i + 1])
    return vals


def _service_updates(calls):
    return [c for c in calls if _has(c, "run", "services", "update", "memripal")]


def _rule_calls(calls, verb: str):
    return [c for c in calls if _has(c, "compute", "forwarding-rules", verb, "memripal-https-rule")]


def _mutations(calls):
    return [c for c in calls if any(v in c for v in ("update", "create", "delete", "deploy"))]


def _assert_ingress(call, value: str):
    assert _flag(call, "--region") == ["us-central1"], call
    assert _flag(call, "--ingress") == [value], call


def _assert_never_unsafe(calls):
    for c in calls:
        assert not _has(c, "run", "deploy"), c
        assert "secrets" not in c, c
        for bad in ("--set-env-vars", "--update-env-vars", "--update-secrets"):
            assert not any(a == bad or a.startswith(bad + "=") for a in c), c


class TestStop:
    def test_stop_sets_internal_ingress_and_deletes_existing_rule(self, tmp_path):
        proc, calls = _run(tmp_path, "stop", existing=f"{RULE},{EDGE_READY}")
        assert proc.returncode == 0, proc.stderr
        updates = _service_updates(calls)
        assert len(updates) == 1, calls
        _assert_ingress(updates[0], "internal")
        deletes = _rule_calls(calls, "delete")
        assert len(deletes) == 1, calls
        assert "--global" in deletes[0] and "--quiet" in deletes[0], deletes[0]
        _assert_never_unsafe(calls)

    def test_stop_with_absent_rule_skips_delete_and_succeeds(self, tmp_path):
        proc, calls = _run(tmp_path, "stop", existing=EDGE_READY)
        assert proc.returncode == 0, proc.stderr
        assert len(_service_updates(calls)) == 1, calls
        _assert_ingress(_service_updates(calls)[0], "internal")
        assert _rule_calls(calls, "delete") == [], calls
        _assert_never_unsafe(calls)

    def test_stop_never_creates_anything(self, tmp_path):
        proc, calls = _run(tmp_path, "stop", existing=f"{RULE},{EDGE_READY}")
        assert proc.returncode == 0, proc.stderr
        assert not [c for c in calls if "create" in c], calls


class TestStart:
    def test_start_creates_absent_rule_then_opens_ingress_to_lb(self, tmp_path):
        proc, calls = _run(tmp_path, "start", existing=EDGE_READY)
        assert proc.returncode == 0, proc.stderr
        creates = _rule_calls(calls, "create")
        assert len(creates) == 1, calls
        c = creates[0]
        assert "--global" in c, c
        assert _flag(c, "--load-balancing-scheme") == ["EXTERNAL_MANAGED"], c
        assert _flag(c, "--address") == ["memripal-edge-ip"], c
        assert _flag(c, "--target-https-proxy") == ["memripal-https-proxy"], c
        assert _flag(c, "--ports") == ["443"], c
        updates = _service_updates(calls)
        assert len(updates) == 1, calls
        _assert_ingress(updates[0], "internal-and-cloud-load-balancing")
        assert calls.index(c) < calls.index(updates[0]), "rule must exist before ingress opens"
        _assert_never_unsafe(calls)

    def test_start_with_existing_rule_skips_create(self, tmp_path):
        proc, calls = _run(tmp_path, "start", existing=f"{RULE},{EDGE_READY}")
        assert proc.returncode == 0, proc.stderr
        assert _rule_calls(calls, "create") == [], calls
        assert len(_service_updates(calls)) == 1, calls
        _assert_ingress(_service_updates(calls)[0], "internal-and-cloud-load-balancing")
        _assert_never_unsafe(calls)

    @pytest.mark.parametrize(
        "existing", [PROXY, ADDR, ""], ids=["missing-address", "missing-proxy", "missing-both"]
    )
    def test_start_refuses_without_edge_and_points_at_deploy_edge(self, tmp_path, existing):
        proc, calls = _run(tmp_path, "start", existing=existing)
        assert proc.returncode != 0, proc.stdout
        assert "scripts/deploy_edge_gcp.sh" in proc.stderr, proc.stderr
        assert not [c for c in calls if "create" in c or "update" in c], calls
        _assert_never_unsafe(calls)


class TestStatus:
    @pytest.mark.parametrize(
        ("existing", "ingress", "rule_word"),
        [
            (EDGE_READY, "internal", "absent"),
            (f"{RULE},{EDGE_READY}", "internal-and-cloud-load-balancing", "present"),
        ],
        ids=["stopped", "started"],
    )
    def test_status_reports_ingress_and_rule_read_only(self, tmp_path, existing, ingress, rule_word):
        proc, calls = _run(tmp_path, "status", existing=existing, ingress=ingress)
        assert proc.returncode == 0, proc.stderr
        assert re.search(rf"ingress:\s*{re.escape(ingress)}\s*$", proc.stdout, re.M), proc.stdout
        assert re.search(rf"rule:\s*{rule_word}\b", proc.stdout), proc.stdout
        assert _mutations(calls) == [], calls
        _assert_never_unsafe(calls)


class TestUsage:
    @pytest.mark.parametrize("args", [(), ("bogus",), ("STOP",)], ids=["no-arg", "unknown", "wrong-case"])
    def test_bad_command_exits_2_with_usage_and_no_gcloud(self, tmp_path, args):
        proc, calls = _run(tmp_path, *args, existing=f"{RULE},{EDGE_READY}")
        assert proc.returncode == 2, (proc.returncode, proc.stderr)
        assert re.search(r"usage", proc.stderr, re.I), proc.stderr
        assert calls == [], calls
