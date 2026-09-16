import uuid

import pytest

from app import routers
from tests.conftest import AUTH, wav_bytes


def test_v1_endpoints_require_bearer_auth(client):
    response = client.get(f"/v1/sessions/{uuid.uuid4()}/status")
    assert response.status_code == 401


def test_register_session_is_idempotent(client):
    session_id = uuid.uuid4()
    for _ in range(2):
        response = client.post(f"/v1/sessions/{session_id}", headers=AUTH)
        assert response.status_code == 200
        assert response.json() == {"id": str(session_id)}


def test_register_session_accepts_supported_language(client):
    session_id = uuid.uuid4()
    response = client.post(f"/v1/sessions/{session_id}", headers=AUTH, json={"language": "en"})
    assert response.status_code == 200


def test_register_session_rejects_unsupported_language(client):
    response = client.post(f"/v1/sessions/{uuid.uuid4()}", headers=AUTH, json={"language": "de"})
    assert response.status_code == 422


def test_transcribe_pins_detected_language_on_session(client, monkeypatch):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)
    client.post(
        f"/v1/sessions/{session_id}/chunks/0",
        headers=AUTH,
        files={"audio": ("0.wav", wav_bytes(), "audio/wav")},
    )
    monkeypatch.setattr(routers.whisper, "transcribe", lambda path, language=None: ([], "en"))

    response = client.post(f"/v1/sessions/{session_id}/chunks/0/transcribe", headers=AUTH)
    assert response.json()["language"] == "en"


def test_transcribe_uses_session_language_hint(client, monkeypatch):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH, json={"language": "fr"})
    client.post(
        f"/v1/sessions/{session_id}/chunks/0",
        headers=AUTH,
        files={"audio": ("0.wav", wav_bytes(), "audio/wav")},
    )
    seen = {}
    def fake_transcribe(path, language=None):
        seen["language"] = language
        return [], "fr"
    monkeypatch.setattr(routers.whisper, "transcribe", fake_transcribe)

    client.post(f"/v1/sessions/{session_id}/chunks/0/transcribe", headers=AUTH)
    assert seen["language"] == "fr"


def test_chunk_upload_is_idempotent_and_keeps_local_reference(client):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)

    first = client.post(
        f"/v1/sessions/{session_id}/chunks/0",
        headers=AUTH,
        files={"audio": ("0.wav", wav_bytes(), "audio/wav")},
    )
    assert first.status_code == 200
    second = client.post(
        f"/v1/sessions/{session_id}/chunks/0",
        headers=AUTH,
        files={"audio": ("0.wav", wav_bytes(), "audio/wav")},
    )
    assert second.json()["id"] == first.json()["id"]


def test_chunk_upload_requires_known_session(client):
    response = client.post(
        f"/v1/sessions/{uuid.uuid4()}/chunks/0",
        headers=AUTH,
        files={"audio": ("0.wav", wav_bytes(), "audio/wav")},
    )
    assert response.status_code == 404


def test_transcribe_persists_segments_and_is_idempotent(client, monkeypatch):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)
    client.post(
        f"/v1/sessions/{session_id}/chunks/0",
        headers=AUTH,
        files={"audio": ("0.wav", wav_bytes(), "audio/wav")},
    )

    monkeypatch.setattr(
        routers.whisper,
        "transcribe",
        lambda path, language=None: (
            [
                {"start_ms": 0, "end_ms": 1200, "raw_text": "bonjour"},
                {"start_ms": 1200, "end_ms": 2600, "raw_text": "le cours commence"},
            ],
            "fr",
        ),
    )

    response = client.post(f"/v1/sessions/{session_id}/chunks/0/transcribe", headers=AUTH)
    assert response.json() == {"state": "complete", "segment_count": 2, "language": "fr"}

    transcript = client.get(f"/v1/sessions/{session_id}/transcript", headers=AUTH).json()
    assert [row["raw_text"] for row in transcript] == ["bonjour", "le cours commence"]
    assert all(row["corrected_text"] is None and row["final_text"] is None for row in transcript)

    again = client.post(f"/v1/sessions/{session_id}/chunks/0/transcribe", headers=AUTH)
    assert again.json() == {"state": "complete"}


def test_transcribe_unknown_chunk_returns_404(client):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)
    response = client.post(f"/v1/sessions/{session_id}/chunks/9/transcribe", headers=AUTH)
    assert response.status_code == 404


def test_failed_transcription_marks_chunk_failed(client, monkeypatch):
    session_id = uuid.uuid4()
    client.post(f"/v1/sessions/{session_id}", headers=AUTH)
    client.post(
        f"/v1/sessions/{session_id}/chunks/0",
        headers=AUTH,
        files={"audio": ("0.wav", wav_bytes(), "audio/wav")},
    )

    def explode(path, language=None):
        raise RuntimeError("model blew up")

    monkeypatch.setattr(routers.whisper, "transcribe", explode)
    with pytest.raises(RuntimeError, match="model blew up"):
        client.post(f"/v1/sessions/{session_id}/chunks/0/transcribe", headers=AUTH)

    status = client.get(f"/v1/sessions/{session_id}/status", headers=AUTH).json()
    assert status["chunks"] == {"failed": 1}
