# Lint gate (MEM-071, ADR 0037): every pytest run carries one "ruff-lint" item over the whole repo.
# The merge-queue drain runs only pytest (often affected-only), and request_merge.py called directly
# skips scripts/check.sh, so without this a ruff error can reach main.
import subprocess
import sys

import pytest

RUFF_TIMEOUT_S = 120


class RuffLintError(Exception):
    pass


class RuffLintItem(pytest.Item):
    def runtest(self):
        root = self.config.rootpath
        result = subprocess.run(
            [sys.executable, "-m", "ruff", "check", str(root)],
            cwd=str(root),
            check=False,
            capture_output=True,
            text=True,
            timeout=RUFF_TIMEOUT_S,
        )
        if result.returncode != 0:
            raise RuffLintError(result.stdout + result.stderr)

    def repr_failure(self, excinfo):
        if isinstance(excinfo.value, RuffLintError):
            return f"ruff check failed:\n{excinfo.value}"
        return super().repr_failure(excinfo)

    def reportinfo(self):
        return self.config.rootpath, None, "ruff-lint"


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(session, config, items):
    items.append(RuffLintItem.from_parent(session, name="ruff-lint"))
