"""Cross-origin access for the Capacitor shell (MEM-063): an exact origin allowlist, no credentials."""

import os

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware

from memripal.chat_fallback import HEADER

# Capacitor WebView origins: Android (androidScheme https) and iOS.
DEFAULT_ORIGINS = ("https://localhost", "capacitor://localhost")
ALLOWED_HEADERS = ("X-Memripal-Passcode", "Content-Type")


def cors_origins() -> list[str]:
    """MEMRIPAL_CORS_ORIGINS as a trimmed list; blank/unset means DEFAULT_ORIGINS. '*' fails loudly."""
    raw = os.environ.get("MEMRIPAL_CORS_ORIGINS", "")
    origins = [o.strip() for o in raw.split(",") if o.strip()] or list(DEFAULT_ORIGINS)
    if "*" in origins:
        raise ValueError("MEMRIPAL_CORS_ORIGINS must list exact origins, not *")
    return origins


def add_cors(app: FastAPI) -> None:
    """Intentionally not wired into create_app yet (item 122); call it once the shell ships."""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins(),
        allow_methods=["GET", "POST"],
        allow_headers=list(ALLOWED_HEADERS),
        allow_credentials=False,
        # The shell reads it to show the Spark fallback notice (MEM-107).
        expose_headers=[HEADER],
    )
