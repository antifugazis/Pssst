# pssst

Local-first lecture recorder for macOS. pssst captures application audio and
microphone audio as separate tracks, uploads 25-second chunks to a self-hosted
faster-whisper backend, and corrects the French transcript with OpenRouter —
all while keeping recording fully independent of the network, backend, and UI.

## Architecture

- **Native recorder** (`src-tauri/`, Rust/Tauri 2) — owns durable session
  manifests, audio tracks, ScreenCaptureKit/AVFoundation capture, and the
  resumable upload queue. Recording never depends on React, the network, or
  the backend.
- **Frontend** (`src/`, React/TypeScript/Vite) — setup, recording, library,
  lecture detail, and settings views over typed Tauri command facades.
- **Backend** (`backend/`, FastAPI + PostgreSQL) — chunk ingestion, faster-whisper
  transcription, immutable raw transcript segments, and optional OpenRouter
  correction. Schema is managed by Alembic.
- **Standalone worker** (`server/`) — a single-file self-hosted whisper server
  for machines where Docker/PostgreSQL is not wanted.

Raw whisper text is immutable: corrected and final text live in separate
columns, and recording, transcription, and correction each carry their own
independent state.

## Quickstart

```sh
pnpm install
docker compose up -d db                       # PostgreSQL on :5433
cd backend && alembic upgrade head && cd ..   # schema
cd backend && .venv/bin/uvicorn app.main:app  # API on :8000
pnpm exec tauri dev                           # desktop app
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full setup, test, and
configuration instructions, and
[docs/MACOS_CAPTURE_TESTING.md](docs/MACOS_CAPTURE_TESTING.md) for the manual
macOS capture verification checklist.
