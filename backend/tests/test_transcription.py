import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.transcription import FasterWhisperProvider
from tests.conftest import wav_bytes


def test_provider_maps_whisper_segments_to_milliseconds(monkeypatch):
    fake_model = SimpleNamespace(
        transcribe=lambda path, **kwargs: (
            iter([
                SimpleNamespace(start=0.0, end=1.234, text="  bonjour "),
                SimpleNamespace(start=1.234, end=2.5, text=" tout le monde"),
            ]),
            SimpleNamespace(language="fr"),
        )
    )
    monkeypatch.setattr(FasterWhisperProvider, "model", lambda self: fake_model)

    provider = FasterWhisperProvider()
    segments, detected = provider.transcribe(Path("anything.wav"))

    assert segments == [
        {"start_ms": 0, "end_ms": 1234, "raw_text": "bonjour"},
        {"start_ms": 1234, "end_ms": 2500, "raw_text": "tout le monde"},
    ]
    assert detected == "fr"


def test_provider_forwards_language_hint(monkeypatch):
    captured = {}
    def fake_transcribe(path, **kwargs):
        captured.update(kwargs)
        return iter([]), SimpleNamespace(language="en")
    monkeypatch.setattr(FasterWhisperProvider, "model", lambda self: SimpleNamespace(transcribe=fake_transcribe))

    provider = FasterWhisperProvider()
    _, detected = provider.transcribe(Path("anything.wav"), language="en")

    assert captured["language"] == "en"
    assert detected == "en"


@pytest.mark.skipif(
    not os.environ.get("RUN_MODEL_TESTS"),
    reason="real faster-whisper model test requires RUN_MODEL_TESTS=1 and a cached model",
)
def test_real_whisper_transcribes_french_fixture(tmp_path):
    """Contract test against the real model. Produces silence, which whisper
    may transcribe as empty — the contract is that the call returns a list of
    well-formed segments without raising."""
    fixture = tmp_path / "sample.wav"
    fixture.write_bytes(wav_bytes(48000 * 4))  # ~1s of stereo audio

    provider = FasterWhisperProvider()
    segments, detected = provider.transcribe(fixture)
    assert isinstance(segments, list)
    assert isinstance(detected, str)
    for segment in segments:
        assert set(segment) == {"start_ms", "end_ms", "raw_text"}
        assert segment["end_ms"] >= segment["start_ms"] >= 0
