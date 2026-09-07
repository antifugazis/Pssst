"""Lightweight self-hosted pssst Whisper worker.

This node intentionally has no PostgreSQL, Docker, queue broker, or lecture
library. The desktop owns durable recordings; this service stores only chunks
and the raw segment JSON needed for idempotent retries.
"""
from __future__ import annotations
import hmac, json, os, secrets
from pathlib import Path
from fastapi import FastAPI, Depends, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel

ROOT = Path(os.getenv("PSSST_STORAGE_DIR", "/var/lib/pssst-whisper")); ROOT.mkdir(parents=True, exist_ok=True)
SECRET_FILE = ROOT / "connection-secret"
SECRET = os.getenv("PSSST_CONNECTION_SECRET") or (SECRET_FILE.read_text().strip() if SECRET_FILE.exists() else secrets.token_urlsafe(48))
if not SECRET_FILE.exists(): SECRET_FILE.write_text(SECRET); SECRET_FILE.chmod(0o600)
MODEL = os.getenv("PSSST_MODEL", "medium"); LANGUAGE = os.getenv("PSSST_LANGUAGE", "fr")
DEVICE = os.getenv("PSSST_DEVICE", "cpu"); COMPUTE = os.getenv("PSSST_COMPUTE_TYPE", "int8")
QUALITY = os.getenv("PSSST_QUALITY", "balanced")
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)
app = FastAPI(title="pssst Whisper server", version="1.0")

def auth(authorization: str | None = Header(default=None)):
    if not hmac.compare_digest((authorization or "").removeprefix("Bearer "), SECRET): raise HTTPException(401, "Invalid pssst connection")

def session_dir(session_id: str) -> Path: path = ROOT / "sessions" / session_id; path.mkdir(parents=True, exist_ok=True); return path
def transcript_path(session_id: str) -> Path: return session_dir(session_id) / "transcript.json"
def read_transcript(session_id: str) -> list[dict]:
    path = transcript_path(session_id); return json.loads(path.read_text()) if path.exists() else []

@app.get("/healthz")
def health(): return {"status": "ok", "model": MODEL, "quality": QUALITY, "language": LANGUAGE, "device": DEVICE, "compute": COMPUTE}
@app.get("/connect/{secret}")
def connect(secret: str):
    if not hmac.compare_digest(secret, SECRET): raise HTTPException(401, "Invalid pssst connection link")
    return {"api_base_url": "/v1", "authorization": "bearer", "health": "ok", "capabilities": {"faster_whisper": True, "whisper_model": MODEL, "quality": QUALITY, "languages": [LANGUAGE], "compute": f"{DEVICE} {COMPUTE}"}}
@app.post("/v1/sessions/{session_id}", dependencies=[Depends(auth)])
def register(session_id: str): session_dir(session_id); return {"id": session_id}
@app.post("/v1/sessions/{session_id}/chunks/{sequence}", dependencies=[Depends(auth)])
async def upload(session_id: str, sequence: int, audio: UploadFile):
    target = session_dir(session_id) / f"{sequence:06d}.wav"
    if not target.exists(): target.write_bytes(await audio.read())
    return {"sequence": sequence, "state": "uploaded"}
@app.post("/v1/sessions/{session_id}/chunks/{sequence}/transcribe", dependencies=[Depends(auth)])
def transcribe(session_id: str, sequence: int):
    target = session_dir(session_id) / f"{sequence:06d}.wav"
    if not target.exists(): raise HTTPException(404, "Chunk not found")
    existing = read_transcript(session_id); known = {row["chunk"] for row in existing}
    if sequence in known: return {"state": "complete", "segment_count": len([r for r in existing if r["chunk"] == sequence])}
    segments, _ = model.transcribe(str(target), language=LANGUAGE, vad_filter=True)
    rows = existing + [{"id": f"{session_id}:{sequence}:{index}", "chunk": sequence, "start_ms": int((item.start + sequence * 25) * 1000), "end_ms": int((item.end + sequence * 25) * 1000), "raw_text": item.text.strip(), "corrected_text": None, "final_text": None} for index, item in enumerate(segments)]
    rows.sort(key=lambda row: row["start_ms"]); transcript_path(session_id).write_text(json.dumps(rows, ensure_ascii=False, indent=2)); return {"state": "complete", "segment_count": len(rows)}
@app.get("/v1/sessions/{session_id}/transcript", dependencies=[Depends(auth)])
def transcript(session_id: str): return read_transcript(session_id)
