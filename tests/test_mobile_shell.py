# Covers: MEM-063
# Requirement: the Android-first Capacitor shell is configured to bundle the built web UI from www/
# (appId com.memripal.app, appName MemriPal, androidScheme https) without pointing the WebView at a
# remote server.url, the generated www/ is never committed, and the server's web CSP stays the exact
# MEM-042 policy plus script-src 'self' 'wasm-unsafe-eval' (SQLite wasm, item 159) with no connect-src
# loosening for the native shell.
import json
from pathlib import Path

from memripal.security_headers import SECURITY_HEADERS

REPO = Path(__file__).resolve().parents[1]
CAP_CONFIG = REPO / "capacitor.config.json"
WEB_CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; "
    "object-src 'none'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)


def _config() -> dict:
    assert CAP_CONFIG.is_file(), "capacitor.config.json missing at repo root"
    return json.loads(CAP_CONFIG.read_text(encoding="utf-8"))


# Covers: MEM-063
# Requirement: capacitor.config.json identifies the app and loads the local www/ bundle over https.
class TestCapacitorConfig:
    def test_app_identity(self):
        cfg = _config()
        assert cfg.get("appId") == "com.memripal.app"
        assert cfg.get("appName") == "MemriPal"

    def test_web_dir_is_www(self):
        assert _config().get("webDir") == "www"

    def test_android_scheme_https(self):
        assert _config().get("server", {}).get("androidScheme") == "https"

    def test_no_remote_server_url(self):
        assert "url" not in _config().get("server", {}), "server.url would bypass the bundled www/"


# Covers: MEM-063
# Requirement: the generated www/ bundle is gitignored.
class TestGitignore:
    def test_www_is_ignored(self):
        lines = [ln.strip() for ln in (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()]
        assert any(ln in ("www/", "/www/") for ln in lines), "www/ missing from .gitignore"


# Covers: MEM-063
# Requirement: the web CSP is not loosened for mobile: still the exact MEM-042 policy (plus only
# script-src 'self' 'wasm-unsafe-eval' so the SQLite wasm compiles, item 159), with no explicit
# connect-src (default-src 'self' governs fetches on the web).
class TestWebCspUnchanged:
    def test_web_csp_exact(self):
        assert SECURITY_HEADERS["Content-Security-Policy"] == WEB_CSP

    def test_web_csp_has_no_connect_src(self):
        assert "connect-src" not in SECURITY_HEADERS["Content-Security-Policy"]
