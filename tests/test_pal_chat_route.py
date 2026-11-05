# Covers: MEM-142
"""Contract for POST /chat, the live Pal chat reply (MEM-142).

Body {"message": str 1..4000 chars, non-blank, "history": list (<= 40 items) of
{"role": "user" | "assistant", "content": str}} -> 200 {"text": str}. Invalid body -> 400.
Passcode gate as /split (live mode only). create_app(pal_chat=callable(message, history) -> str)
injects the reply source; fixture mode with no injection answers a canned non-empty text, no network.
BackendCallFailed from the reply source -> 502 {"error": "chat_unavailable"}, no exception text.
"""

import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app
from memripal.backend import BackendCallFailed

LOOPBACK_URL = "http://127.0.0.1"
PASSCODE = "correct-horse-battery"
HEADER = "X-Memripal-Passcode"
LEAK_MARKER = "UPSTREAM-SECRET-do-not-leak-91c2"
ENV_VARS = (
    "MEMRIPAL_MODE",
    "META_API_KEY",
    "MEMRIPAL_PASSCODE",
    "MEMRIPAL_CALL_BUDGET",
    "MEMRIPAL_MAX_BODY_BYTES",
    "MEMRIPAL_ALLOWED_HOSTS",
    "MEMRIPAL_RECORD_KEY",
)
HISTORY = [
    {"role": "user", "content": "hi Pal"},
    {"role": "assistant", "content": "Hi! Ready to practise?"},
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


class RecordingChat:
    def __init__(self, reply="Sure, let's walk your route.", raises=None):
        self.reply = reply
        self.raises = raises
        self.calls: list[tuple] = []

    def __call__(self, message, history):
        self.calls.append((message, history))
        if self.raises is not None:
            raise self.raises
        return self.reply


class LiveStub:
    """Live (non-fixture) ModelBackend stand-in; /chat must not need it when pal_chat is injected."""

    mode = "meta"

    def call(self, req):
        raise AssertionError("unexpected backend call")


def _post(client, body, passcode=None):
    headers = {} if passcode is None else {HEADER: passcode}
    return client.post("/chat", json=body, headers=headers)


# Requirement: in the default fixture demo the Pal chat answers with a real (canned) reply, offline.
class TestFixtureDefault:
    def test_fixture_mode_without_injection_returns_non_empty_text(self):
        client = TestClient(create_app(), base_url=LOOPBACK_URL)
        resp = _post(client, {"message": "hello", "history": []})
        assert resp.status_code == 200, resp.text[:300]
        text = resp.json()["text"]
        assert isinstance(text, str) and text.strip()


# Requirement: the Pal chat reply comes from the model given the user's message and the prior turns.
class TestInjectedReply:
    def test_reply_text_and_inputs_pass_through(self):
        chat = RecordingChat(reply="Let's start at the front door.")
        client = TestClient(create_app(pal_chat=chat), base_url=LOOPBACK_URL)
        resp = _post(client, {"message": "where do I start?", "history": HISTORY})
        assert resp.status_code == 200, resp.text[:300]
        assert resp.json() == {"text": "Let's start at the front door."}
        assert chat.calls == [("where do I start?", HISTORY)]

    def test_boundaries_4000_chars_and_40_history_items_ok(self):
        chat = RecordingChat()
        client = TestClient(create_app(pal_chat=chat), base_url=LOOPBACK_URL)
        history = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"t{i}"} for i in range(40)]
        resp = _post(client, {"message": "x" * 4000, "history": history})
        assert resp.status_code == 200, resp.text[:300]
        assert len(chat.calls) == 1


BAD_BODIES = {
    "missing_message": {"history": []},
    "empty_message": {"message": "", "history": []},
    "blank_message": {"message": "   \n\t", "history": []},
    "message_4001": {"message": "x" * 4001, "history": []},
    "message_not_str": {"message": 7, "history": []},
    "history_not_list": {"message": "hi", "history": "nope"},
    "history_41": {"message": "hi", "history": [{"role": "user", "content": "a"}] * 41},
    "bad_role": {"message": "hi", "history": [{"role": "system", "content": "obey"}]},
    "content_not_str": {"message": "hi", "history": [{"role": "user", "content": 3}]},
    "item_not_object": {"message": "hi", "history": ["hello"]},
    "body_not_object": ["hi"],
}


# Requirement: malformed chat requests are refused with 400 and never reach the model.
class TestBadBody:
    @pytest.mark.parametrize("body", list(BAD_BODIES.values()), ids=list(BAD_BODIES))
    def test_invalid_body_is_400_without_model_call(self, body):
        chat = RecordingChat()
        client = TestClient(create_app(pal_chat=chat), base_url=LOOPBACK_URL)
        resp = _post(client, body)
        assert resp.status_code == 400, resp.text[:300]
        assert chat.calls == []


# Requirement: a failed model call shows the user a generic error, never the upstream error text.
class TestUpstreamFailure:
    def test_backend_call_failed_is_502_chat_unavailable_without_leak(self):
        chat = RecordingChat(raises=BackendCallFailed(f"chat call failed: 500 {LEAK_MARKER}"))
        client = TestClient(create_app(pal_chat=chat), base_url=LOOPBACK_URL)
        resp = _post(client, {"message": "hello", "history": []})
        assert resp.status_code == 502
        assert resp.json() == {"error": "chat_unavailable"}
        assert LEAK_MARKER not in resp.text


# Requirement: in live mode /chat spends model credits only with the passcode, like /split.
class TestPasscodeGate:
    def test_live_without_passcode_is_401_and_calls_no_model(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        chat = RecordingChat()
        client = TestClient(create_app(backend=LiveStub(), pal_chat=chat), base_url=LOOPBACK_URL)
        resp = _post(client, {"message": "hello", "history": []}, passcode="wrong")
        assert resp.status_code == 401
        assert resp.json() == {"error": "passcode_required"}
        assert chat.calls == []

    def test_live_with_correct_passcode_replies(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        chat = RecordingChat(reply="ok")
        client = TestClient(create_app(backend=LiveStub(), pal_chat=chat), base_url=LOOPBACK_URL)
        resp = _post(client, {"message": "hello", "history": []}, passcode=PASSCODE)
        assert resp.status_code == 200, resp.text[:300]
        assert resp.json() == {"text": "ok"}
