# Covers: MEM-026
# Requirement: the Spark chat provider is chosen by MEMRIPAL_CHAT_PROVIDER, one of "meta",
# "baseten", "fireworks" or "local" (default "meta" when unset, so the current all-Meta path is
# unchanged); any other value, including "" and other casings, fails with a ValueError whose
# message names every allowed provider.

import pytest

from memripal import chat_provider

ALLOWED = ("meta", "baseten", "fireworks", "local")


class TestSelectChatProvider:
    def test_allowed_set_is_exactly_the_four_d12_providers(self):
        assert tuple(chat_provider.CHAT_PROVIDERS) == ALLOWED

    def test_default_selects_meta(self, monkeypatch):
        monkeypatch.delenv("MEMRIPAL_CHAT_PROVIDER", raising=False)
        assert chat_provider.select_chat_provider() == "meta"

    @pytest.mark.parametrize("value", ALLOWED)
    def test_each_allowed_provider_selected_from_env(self, monkeypatch, value):
        monkeypatch.setenv("MEMRIPAL_CHAT_PROVIDER", value)
        assert chat_provider.select_chat_provider() == value

    @pytest.mark.parametrize("value", ["openai", "", "META", "Baseten", " local", "fireworks-ai"])
    def test_unknown_provider_raises_value_error_naming_allowed_set(self, monkeypatch, value):
        monkeypatch.setenv("MEMRIPAL_CHAT_PROVIDER", value)
        with pytest.raises(ValueError) as excinfo:
            chat_provider.select_chat_provider()
        message = str(excinfo.value)
        assert "MEMRIPAL_CHAT_PROVIDER" in message
        for name in ALLOWED:
            assert name in message
