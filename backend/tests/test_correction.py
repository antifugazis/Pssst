import json
import uuid

import httpx
import pytest

from app import routers
from app.correction import SYSTEM_PROMPT, OpenRouterCorrectionProvider
from app.models import TranscriptSegment
from tests.conftest import AUTH


def seed_segments(db, session_id, rows):
    Session, run = db

    async def insert():
        async with Session() as session:
            for start_ms, end_ms, raw_text in rows:
                session.add(TranscriptSegment(
                    session_id=session_id, start_ms=start_ms, end_ms=end_ms, raw_text=raw_text,
                ))
            await session.commit()

    run(insert())


async def test_provider_request_contains_raw_text_system_prompt_and_model():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers["Authorization"]
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "ligne corrigée"}}],
        })

    provider = OpenRouterCorrectionProvider(
        api_key="sk-test", model="test/model",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.correct_live_context("ligne brute", course_context="résaux")

    assert result == "ligne corrigée"
    assert captured["authorization"] == "Bearer sk-test"
    body = captured["body"]
    assert body["model"] == "test/model"
    assert body["messages"][0] == {"role": "system", "content": SYSTEM_PROMPT}
    assert "ligne brute" in body["messages"][1]["content"]
    assert "résaux" in body["messages"][1]["content"]


async def test_provider_fails_fast_when_unconfigured():
    provider = OpenRouterCorrectionProvider(api_key=None, model=None)
    with pytest.raises(RuntimeError, match="not configured"):
        await provider.correct_final_transcript("texte")


def test_correction_writes_corrected_text_and_never_touches_raw(client, db, monkeypatch):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)
    seed_segments(db, session_id, [
        (0, 1000, "le free tiret h"),
        (1000, 2000, "deuxieme ligne"),
    ])

    async def fake_correct(self, raw_text, course_context=""):
        assert "le free tiret h" in raw_text
        return "le free -h\ndeuxième ligne"

    monkeypatch.setattr(OpenRouterCorrectionProvider, "_correct", fake_correct)

    response = client.post(
        f"/v1/sessions/{session_id}/correct",
        headers=AUTH,
        json={"openrouter_api_key": "sk-test", "openrouter_model": "test/model"},
    )
    assert response.json()["state"] == "complete"

    transcript = client.get(f"/v1/sessions/{session_id}/transcript", headers=AUTH).json()
    assert transcript[0]["raw_text"] == "le free tiret h"
    assert transcript[0]["corrected_text"] == "le free -h"
    assert transcript[1]["raw_text"] == "deuxieme ligne"
    assert transcript[1]["corrected_text"] == "deuxième ligne"

    status = client.get(f"/v1/sessions/{session_id}/status", headers=AUTH).json()
    assert status["correction_state"] == "complete"


def test_final_correction_writes_final_text(client, db, monkeypatch):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)
    seed_segments(db, session_id, [(0, 1000, "texte brut")])

    async def fake_correct(self, raw_text, course_context=""):
        return "texte corrigé"

    monkeypatch.setattr(OpenRouterCorrectionProvider, "_correct", fake_correct)

    response = client.post(
        f"/v1/sessions/{session_id}/correct?final=true",
        headers=AUTH,
        json={"openrouter_api_key": "sk-test", "openrouter_model": "test/model"},
    )
    assert response.json()["final"] is True

    transcript = client.get(f"/v1/sessions/{session_id}/transcript", headers=AUTH).json()
    assert transcript[0]["raw_text"] == "texte brut"
    assert transcript[0]["corrected_text"] is None
    assert transcript[0]["final_text"] == "texte corrigé"


def test_correction_without_any_key_is_blocked_not_failed(client, db):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)
    seed_segments(db, session_id, [(0, 1000, "texte")])

    response = client.post(f"/v1/sessions/{session_id}/correct", headers=AUTH)
    assert response.json()["state"] == "blocked"

    transcript = client.get(f"/v1/sessions/{session_id}/transcript", headers=AUTH).json()
    assert transcript[0]["raw_text"] == "texte"
    assert transcript[0]["corrected_text"] is None


def test_correction_on_empty_transcript_waits(client):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)
    response = client.post(
        f"/v1/sessions/{session_id}/correct",
        headers=AUTH,
        json={"openrouter_api_key": "sk-test", "openrouter_model": "test/model"},
    )
    assert response.json()["state"] == "waiting"


def test_routers_uses_injectable_provider(routers_module=routers):
    """The endpoint builds its provider through the module-level class so tests
    can substitute transports; this guard catches accidental hardcoding."""
    assert routers_module.OpenRouterCorrectionProvider is OpenRouterCorrectionProvider
