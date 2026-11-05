"""Pal's live chat reply (MEM-142): one OpenAI-compatible chat completion over the bubble's history.

Logs carry provider name, latency and exception class only, never a message, provider body or key (MEM-106).
"""

import json
import logging
import time

import httpx

from memripal.backend import REASONING_HEADROOM_TOKENS, BackendCallFailed
from memripal.chat_provider import chat_fallback_from_env, chat_provider_from_env, select_chat_provider
from memripal.loci import SPARK_MODEL
from memripal.meta_spend_guard import meta_asr_client_from_env

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are Pal, the friendly memory-palace companion inside MemriPal, an app that helps people "
    "memorize things by placing them along a route of familiar places. Be warm, encouraging and "
    "concise: reply in one to three short sentences unless asked for more."
)
MAX_COMPLETION_TOKENS = 512 + REASONING_HEADROOM_TOKENS
CHAT_TIMEOUT = httpx.Timeout(20.0, connect=4.0)
FIXTURE_REPLY = (
    "Hi, I'm Pal! I'm in offline demo mode right now, but I can still help you walk your memory palace."
)
MAX_MESSAGE_CHARS = 4000
MAX_HISTORY = 40
ROLES = ("user", "assistant")


def parse_chat_body(raw: bytes) -> tuple[str, list[dict]] | None:
    """(message, history) from a POST /chat body, or None unless every field is well-typed."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    message, history = body.get("message"), body.get("history", [])
    if not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE_CHARS:
        return None
    if not isinstance(history, list) or len(history) > MAX_HISTORY:
        return None
    for item in history:
        if not isinstance(item, dict) or item.get("role") not in ROLES:
            return None
        if not isinstance(item.get("content"), str):
            return None
    return message, [{"role": m["role"], "content": m["content"]} for m in history]


def pal_reply(client, model: str, message: str, history) -> str:
    """The model's reply text (possibly blank); raises BackendCallFailed on a failed or malformed call."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages += [{"role": m["role"], "content": m["content"]} for m in history]
    messages.append({"role": "user", "content": message})
    payload = {"model": model, "max_completion_tokens": MAX_COMPLETION_TOKENS, "messages": messages}
    result = client.post("/chat/completions", payload)
    if not result.ok:
        raise BackendCallFailed(f"pal chat call failed: {result.error}")
    try:
        content = json.loads(result.body)["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise BackendCallFailed("pal chat reply malformed") from exc
    if not isinstance(content, str):
        raise BackendCallFailed("pal chat reply malformed")
    return content.strip()


def _targets_from_env() -> list[tuple[str, object, str]]:
    """(name, client, model): the configured provider (Meta on the server key), then the chat fallback."""
    name = select_chat_provider()
    targets = []
    if name == "meta":
        client = meta_asr_client_from_env()
        if client is not None:
            targets.append(("meta", client, SPARK_MODEL))
    else:
        p = chat_provider_from_env(name, timeout=CHAT_TIMEOUT)
        targets.append((p.name, p.client, p.model))
    fallback = chat_fallback_from_env(timeout=CHAT_TIMEOUT)
    if fallback is not None and fallback.name != name:
        targets.append((fallback.name, fallback.client, fallback.model))
    return targets


def pal_chat_from_env():
    """The default live `(message, history, byok_client=None) -> str`, tried per target until a non-blank
    reply. `byok_client` (the visitor's own Meta key session) goes first. Env providers are built once on
    first use, so chat config never blocks app startup.
    """
    env_targets: list | None = None

    def chat(message: str, history, byok_client=None) -> str:
        nonlocal env_targets
        if env_targets is None:
            env_targets = _targets_from_env()
        targets = [("byok", byok_client, SPARK_MODEL)] if byok_client is not None else []
        targets += env_targets
        for name, client, model in targets:
            started = time.monotonic()
            try:
                text = pal_reply(client, model, message, history)
            except Exception as exc:  # any provider failure falls through to the next one
                logger.warning("pal chat via %s failed: %s", name, type(exc).__name__)
                continue
            if text:
                logger.info("pal chat served by %s in %d ms", name, int((time.monotonic() - started) * 1000))
                return text
            logger.warning("pal chat via %s returned a blank reply", name)
        raise BackendCallFailed("pal chat unavailable")

    return chat
