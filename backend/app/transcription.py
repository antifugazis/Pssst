"""Real faster-whisper adapter; loading remains lazy so recording/upload endpoints stay responsive."""
from pathlib import Path

from faster_whisper import WhisperModel

from .config import settings


class FasterWhisperProvider:
    _model: WhisperModel | None = None
    def model(self) -> WhisperModel:
        if self._model is None:
            self._model = WhisperModel(settings.whisper_model, device=settings.whisper_device, compute_type=settings.whisper_compute_type)
        return self._model
    def transcribe(self, audio_path: Path, language: str | None = None) -> tuple[list[dict[str, int | str]], str]:
        # language=None lets faster-whisper detect the spoken language per file;
        # callers pin the detected code per session so later chunks stay consistent.
        segments, info = self.model().transcribe(str(audio_path), language=language, vad_filter=True, condition_on_previous_text=True)
        mapped = [{"start_ms": round(item.start * 1000), "end_ms": round(item.end * 1000), "raw_text": item.text.strip()} for item in segments]
        return mapped, info.language
