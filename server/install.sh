#!/usr/bin/env bash
set -euo pipefail

# Friendly Debian/Ubuntu installer for the lightweight pssst Whisper worker.
# It deliberately keeps implementation knobs out of the normal setup path.
INSTALL_DIR="${PSSST_INSTALL_DIR:-/opt/pssst-whisper}"
DATA_DIR="${PSSST_DATA_DIR:-/var/lib/pssst-whisper}"

if [[ "$(id -u)" != "0" ]]; then echo "Run this installer as root: sudo bash" >&2; exit 1; fi

cores="$(nproc 2>/dev/null || echo 1)"
ram_gb="$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo '?')"
arch="$(uname -m)"
gpu="none"; device="cpu"; compute="int8"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then gpu="NVIDIA GPU"; device="cuda"; compute="float16"; fi

echo
echo "pssst Whisper setup"
echo "───────────────────"
echo "Detected:"
echo "  $arch · $cores CPU cores · ${ram_gb} GB RAM · $gpu"
echo

recommended_model="medium"
if [[ "$ram_gb" =~ ^[0-9]+$ ]] && (( ram_gb < 6 )); then recommended_model="small"; fi
recommended_compute="$device $compute"
echo "Recommended setup:"
echo "  Whisper $(tr '[:lower:]' '[:upper:]' <<< "${recommended_model:0:1}")${recommended_model:1} · $recommended_compute · Balanced quality"
echo

model="${PSSST_MODEL:-}"
if [[ -z "$model" ]]; then
  printf "Whisper model [1] Small  [2] Medium (recommended)  [3] Large-v3  [r] Use recommended: "
  read -r model_choice
  case "${model_choice:-r}" in
    1) model=small;; 2) model=medium;; 3) model=large-v3;; r|R) model="$recommended_model";; *) model="$recommended_model";;
  esac
fi

quality="${PSSST_QUALITY:-}"
if [[ -z "$quality" ]]; then
  printf "Processing quality [1] Fast  [2] Balanced (recommended)  [3] Best accuracy: "
  read -r quality_choice
  case "${quality_choice:-2}" in 1) quality=fast;; 3) quality=best;; *) quality=balanced;; esac
fi

language="${PSSST_LANGUAGE:-fr}"
if [[ -z "${PSSST_LANGUAGE:-}" ]]; then
  printf "Language [1] French (recommended): "
  read -r language_choice
  [[ "${language_choice:-1}" == 1 ]] && language=fr || language=fr
fi

echo
echo "Installing the pssst Whisper worker…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip ffmpeg curl ca-certificates
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --upgrade pip >/dev/null
"$INSTALL_DIR/.venv/bin/pip" install 'fastapi>=0.115,<1' 'uvicorn[standard]>=0.30,<1' 'python-multipart>=0.0.12,<1' 'faster-whisper>=1.1,<2' >/dev/null

cat > "$INSTALL_DIR/worker.py" <<'PSSST_WORKER_PY'
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
PSSST_WORKER_PY

"$INSTALL_DIR/.venv/bin/python" -m py_compile "$INSTALL_DIR/worker.py"

echo "Preparing Whisper $model (the first download can take a while)…"
PSSST_MODEL="$model" "$INSTALL_DIR/.venv/bin/python" -c 'import os; from faster_whisper import WhisperModel; WhisperModel(os.environ["PSSST_MODEL"], device="cpu", compute_type="int8")' >/dev/null

cat > /etc/systemd/system/pssst-whisper.service <<EOF
[Unit]
Description=pssst Whisper transcription worker
After=network-online.target
[Service]
WorkingDirectory=$INSTALL_DIR
Environment=PSSST_STORAGE_DIR=$DATA_DIR
Environment=PSSST_MODEL=$model
Environment=PSSST_QUALITY=$quality
Environment=PSSST_LANGUAGE=$language
Environment=PSSST_DEVICE=$device
Environment=PSSST_COMPUTE_TYPE=$compute
ExecStart=$INSTALL_DIR/.venv/bin/uvicorn worker:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now pssst-whisper
sleep 2
if ! curl -fsS http://127.0.0.1:8000/healthz >/dev/null; then echo "The worker did not become healthy. Check: systemctl status pssst-whisper" >&2; exit 1; fi

host="$(hostname -I | awk '{print $1}')"
secret="$(cat "$DATA_DIR/connection-secret")"
pretty_model="${model^}"
echo
echo "pssst Whisper is ready."
echo "Model: $pretty_model"
echo "Quality: ${quality^}"
echo "Language: French"
echo
echo "Connection link:"
echo "http://$host:8000/connect/$secret"
echo
echo "Paste this link into: pssst → Transcription → My pssst server"
