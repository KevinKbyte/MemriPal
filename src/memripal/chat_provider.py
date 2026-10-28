"""Spark chat provider toggle and its OpenAI-compatible clients (MEM-026, D12)."""

import os
from dataclasses import dataclass

from memripal.backend import MissingApiKey
from memripal.meta_client import MetaClient

CHAT_PROVIDERS = ("meta", "baseten", "fireworks", "local")
# provider -> (base URL, model id, key env var). Only Spark chat moves; SAM stays on Meta.
_KEYED = {
    "baseten": ("https://inference.baseten.co/v1", "meta-models/muse-spark-open-1026", "BASETEN_API_KEY"),
    "fireworks": (
        "https://api.fireworks.ai/inference/v1",
        "accounts/fireworks/models/muse-spark-open",
        "FIREWORKS_API_KEY",
    ),
}
LOCAL_DEFAULT_URL = "http://localhost:11434/v1"


def select_chat_provider() -> str:
    provider = os.environ.get("MEMRIPAL_CHAT_PROVIDER", "meta")
    if provider not in CHAT_PROVIDERS:
        raise ValueError(f"MEMRIPAL_CHAT_PROVIDER must be one of {CHAT_PROVIDERS}, got {provider!r}")
    return provider


@dataclass(frozen=True)
class ChatProvider:
    """A non-Meta chat target: MetaClient's HTTP machinery pointed at another base URL and model."""

    name: str
    client: MetaClient
    model: str


def chat_provider_from_env(provider: str) -> ChatProvider:
    # Environment only, like META_API_KEY: never read .env files.
    if provider == "local":
        model = os.environ.get("MEMRIPAL_LOCAL_CHAT_MODEL", "")
        if not model:
            raise ValueError("local chat provider requires MEMRIPAL_LOCAL_CHAT_MODEL")
        url = os.environ.get("MEMRIPAL_LOCAL_CHAT_URL") or LOCAL_DEFAULT_URL
        # None: a local Ollama-style server takes no Authorization header.
        return ChatProvider(provider, MetaClient(None, base_url=url), model)
    base_url, model, key_env = _KEYED[provider]
    key = os.environ.get(key_env, "")
    if not key:
        raise MissingApiKey(f"{provider} chat provider requires {key_env} in the environment")
    return ChatProvider(provider, MetaClient(key, base_url=base_url), model)
