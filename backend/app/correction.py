"""OpenRouter correction is isolated from transcription and never mutates raw text."""
from typing import Protocol
import httpx
from .config import settings

SYSTEM_PROMPT = """Tu corriges une transcription automatique de cours universitaire en français.
Détermine ce que le professeur a réellement dit, sans améliorer sa manière de parler.
Corrige uniquement les erreurs probables de reconnaissance vocale. Conserve hésitations,
répétitions, faux départs, expressions orales et grammaire parlée. Ne reformule pas, ne
résume pas, n'ajoute aucune information et ne corrige pas les faits. Quand une notation
technique est clairement dictée, écris-la normalement (free tiret h → free -h, égal égal → ==).
Si c'est incertain, conserve le texte. Retourne uniquement la transcription corrigée."""

class CorrectionProvider(Protocol):
    async def correct_live_context(self, raw_text: str, course_context: str = "") -> str: ...
    async def correct_final_transcript(self, raw_text: str, course_context: str = "") -> str: ...

class OpenRouterCorrectionProvider:
    async def _correct(self, raw_text: str, course_context: str) -> str:
        if not settings.openrouter_api_key or not settings.openrouter_model:
            raise RuntimeError("OpenRouter correction is not configured")
        body = {"model": settings.openrouter_model, "temperature": 0, "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Contexte du cours: {course_context}\n\nTranscription brute:\n{raw_text}"},
        ]}
        async with httpx.AsyncClient(timeout=90) as client:
            response = await client.post(settings.openrouter_endpoint, json=body, headers={"Authorization": f"Bearer {settings.openrouter_api_key}"})
            response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"].strip()
    async def correct_live_context(self, raw_text: str, course_context: str = "") -> str: return await self._correct(raw_text, course_context)
    async def correct_final_transcript(self, raw_text: str, course_context: str = "") -> str: return await self._correct(raw_text, course_context)
