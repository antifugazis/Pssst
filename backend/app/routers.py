import uuid
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from .config import settings
from .db import get_db
from .models import AudioChunk, CorrectionBatch, Session, TranscriptSegment
from .correction import OpenRouterCorrectionProvider
from .transcription import FasterWhisperProvider
from .connection import authorize, connection_secret, revoke_and_regenerate

router = APIRouter(prefix="/v1", dependencies=[Depends(authorize)])
connect_router = APIRouter()
whisper = FasterWhisperProvider()
correction = OpenRouterCorrectionProvider()

class CorrectRequest(BaseModel):
    openrouter_api_key: Optional[str] = None
    openrouter_model: Optional[str] = None

@connect_router.get("/connect/{secret}")
async def connect(secret: str):
    import hmac
    if not hmac.compare_digest(secret, connection_secret()): raise HTTPException(401, "Invalid pssst connection link")
    return {"api_base_url": "/v1", "authorization": "bearer", "capabilities": {"faster_whisper": True, "whisper_model": settings.whisper_model, "languages": ["fr"], "chunk_transcription": True, "correction": bool(settings.openrouter_api_key)}, "health": "ok"}

@connect_router.post("/admin/regenerate-connection-link", dependencies=[Depends(authorize)])
async def regenerate_connection_link(): return {"connection_link": revoke_and_regenerate()}
@router.post("/sessions/{session_id}")
async def register_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    if not await db.get(Session, session_id): db.add(Session(id=session_id, state="recorded")); await db.commit()
    return {"id": str(session_id)}
@router.post("/sessions/{session_id}/chunks/{sequence}")
async def upload_chunk(session_id: uuid.UUID, sequence: int, audio: UploadFile, db: AsyncSession = Depends(get_db)):
    if not await db.get(Session, session_id): raise HTTPException(404, "Unknown session")
    existing = await db.scalar(select(AudioChunk).where(AudioChunk.session_id == session_id, AudioChunk.sequence == sequence))
    if existing: return {"id": str(existing.id), "state": existing.state}
    target = settings.storage_dir / str(session_id); target.mkdir(parents=True, exist_ok=True)
    # The native recorder sends self-contained WAV chunks; keep their extension
    # so local diagnostics and faster-whisper both see the actual container.
    destination = target / f"{sequence:06d}.wav"; destination.write_bytes(await audio.read())
    chunk = AudioChunk(session_id=session_id, sequence=sequence, local_reference=str(destination), state="uploaded")
    db.add(chunk); await db.commit(); await db.refresh(chunk)
    return {"id": str(chunk.id), "state": chunk.state}

@router.post("/sessions/{session_id}/chunks/{sequence}/transcribe")
async def transcribe_chunk(session_id: uuid.UUID, sequence: int, db: AsyncSession = Depends(get_db)):
    chunk = await db.scalar(select(AudioChunk).where(AudioChunk.session_id == session_id, AudioChunk.sequence == sequence))
    if not chunk: raise HTTPException(404, "Unknown chunk")
    if chunk.state == "complete": return {"state": "complete"}
    chunk.state = "processing"; await db.commit()
    try:
        segments = whisper.transcribe(Path(chunk.local_reference))
        for segment in segments:
            db.add(TranscriptSegment(session_id=session_id, source_chunk_id=chunk.id, start_ms=segment["start_ms"], end_ms=segment["end_ms"], raw_text=segment["raw_text"]))
        chunk.state = "complete"; await db.commit()
    except Exception:
        chunk.state = "failed"; await db.commit(); raise
    return {"state": "complete", "segment_count": len(segments)}

@router.get("/sessions/{session_id}/transcript")
async def transcript(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    rows = (await db.scalars(select(TranscriptSegment).where(TranscriptSegment.session_id == session_id).order_by(TranscriptSegment.start_ms))).all()
    return [{"id": str(row.id), "start_ms": row.start_ms, "end_ms": row.end_ms, "raw_text": row.raw_text, "corrected_text": row.corrected_text, "final_text": row.final_text} for row in rows]

@router.post("/sessions/{session_id}/correct")
async def correct_transcript(session_id: uuid.UUID, final: bool = False, body: CorrectRequest | None = None, db: AsyncSession = Depends(get_db)):
    """Correction is deliberately independent from Whisper: failures leave raw text intact.

    The desktop app may pass OpenRouter credentials in the JSON body so the
    server can use the user's own API key instead of requiring server-side env
    vars. Falls back to the server's configured settings when no body is sent.

    Segments are batched into ~60s windows before correction so the model has
    enough surrounding context. The corrected batch is split back per-segment
    by line so each row keeps its own corrected/final text.
    """
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Unknown session")
    rows = (await db.scalars(select(TranscriptSegment).where(TranscriptSegment.session_id == session_id).order_by(TranscriptSegment.start_ms))).all()
    if not rows:
        return {"state": "waiting", "segment_count": 0}
    provider = OpenRouterCorrectionProvider(
        api_key=body.openrouter_api_key if body else None,
        model=body.openrouter_model if body else None,
    )
    effective_key = (body.openrouter_api_key if body else None) or settings.openrouter_api_key
    effective_model = (body.openrouter_model if body else None) or settings.openrouter_model or "unconfigured"
    batch = CorrectionBatch(session_id=session_id, provider="openrouter", model=effective_model, status="processing", attempt_count=1)
    db.add(batch); await db.commit()
    try:
        # Group segments into ~60s windows so the model gets enough context.
        BATCH_MS = 60_000
        groups: list[list[int]] = []  # indices into rows
        for i, row in enumerate(rows):
            if not groups:
                groups.append([i])
                continue
            current = groups[-1]
            window_start = rows[current[0]].start_ms
            if row.start_ms - window_start >= BATCH_MS:
                groups.append([i])
            else:
                current.append(i)

        for group in groups:
            raw_lines = [rows[idx].raw_text for idx in group]
            joined = "\n".join(raw_lines)
            corrected_joined = await (provider.correct_final_transcript(joined) if final else provider.correct_live_context(joined))
            corrected_lines = corrected_joined.strip().splitlines()
            # If the model returned fewer/more lines than we sent, fall back to
            # assigning the whole correction to the first segment so we never
            # lose text or misalign rows.
            if len(corrected_lines) == len(group):
                for j, idx in enumerate(group):
                    if final: rows[idx].final_text = corrected_lines[j].strip()
                    else: rows[idx].corrected_text = corrected_lines[j].strip()
            else:
                if final: rows[group[0]].final_text = corrected_joined
                else: rows[group[0]].corrected_text = corrected_joined
                for idx in group[1:]:
                    if final: rows[idx].final_text = ""
                    else: rows[idx].corrected_text = ""
        batch.status = "complete"; await db.commit()
    except Exception as error:
        batch.status = "blocked" if not effective_key else "failed"; await db.commit()
        return {"state": batch.status, "detail": str(error), "segment_count": 0}
    return {"state": "complete", "segment_count": len(rows), "final": final}

@router.get("/sessions/{session_id}/status")
async def session_status(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session: raise HTTPException(404, "Unknown session")
    chunks = (await db.scalars(select(AudioChunk).where(AudioChunk.session_id == session_id))).all()
    corrections = (await db.scalars(select(CorrectionBatch).where(CorrectionBatch.session_id == session_id).order_by(CorrectionBatch.id.desc()))).all()
    return {"session_id": str(session_id), "chunks": {state: sum(1 for chunk in chunks if chunk.state == state) for state in {chunk.state for chunk in chunks}}, "correction_state": corrections[0].status if corrections else "not_started"}
