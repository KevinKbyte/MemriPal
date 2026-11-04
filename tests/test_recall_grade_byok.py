"""Contract (MEM-136 BYOK leg; RED): a /recall/audio request carrying the visitor's own Meta key
(X-Memripal-Meta-Key, MEM-122) and "grade": true calls `recall_grader.grade(text, keywords,
byok_client=<that request's ByokSession.asr_client>)`; without the key, byok_client is None.
"""

import base64

import httpx
from fastapi.testclient import TestClient
from test_byok import KEV_KEY, KEY_HEADER, LOOPBACK_URL, USER_KEY, _clean_env, _Net, _wav  # noqa: F401

from memripal.app import create_app
from memripal.backend import MetaBackend
from memripal.meta_client import MetaClient
from memripal.meta_spend_guard import MetaSpendGuard


class FakeGrader:
    def __init__(self):
        self.calls: list[tuple] = []

    def grade(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return None


def _app(tmp_path, grader):
    net = _Net()
    transport = httpx.MockTransport(net)
    guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)
    kev = MetaClient(KEV_KEY, transport=transport, max_retries=0, spend_guard=guard)
    shared = MetaBackend(KEV_KEY, client=kev, cache_root=tmp_path / "live")
    asr = MetaClient(KEV_KEY, transport=transport, max_retries=0, spend_guard=guard)
    app = create_app(
        backend=shared, asr_client=asr, saved_roots=(), byok_transport=transport, recall_grader=grader
    )
    return TestClient(app, base_url=LOOPBACK_URL), asr


def _recall(client, headers=None):
    body = {"audio": base64.b64encode(_wav()).decode(), "keywords": ["lamp"], "grade": True}
    return client.post("/recall/audio", json=body, headers=headers or {})


# Covers: MEM-136
class TestRecallGradeByok:
    # Requirement: a visitor who brought their own Meta key gets Spark grading on that key first.
    def test_visitor_key_passes_its_session_client(self, tmp_path):
        grader = FakeGrader()
        client, shared_asr = _app(tmp_path, grader)
        resp = _recall(client, {KEY_HEADER: USER_KEY})
        assert resp.status_code == 200, resp.text[:200]
        assert len(grader.calls) == 1
        byok_client = grader.calls[0][1].get("byok_client")
        assert isinstance(byok_client, MetaClient)
        assert byok_client is not shared_asr

    def test_no_visitor_key_passes_none(self, tmp_path):
        grader = FakeGrader()
        client, _ = _app(tmp_path, grader)
        resp = _recall(client)
        assert resp.status_code == 200, resp.text[:200]
        assert len(grader.calls) == 1
        assert grader.calls[0][1].get("byok_client") is None
