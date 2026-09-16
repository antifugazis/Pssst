# Pssst

**Local-first lecture recorder for macOS.** Pssst captures application audio
and microphone audio as separate tracks, streams 25-second chunks to a
self-hosted faster-whisper server, and produces a corrected French transcript
via OpenRouter — while recording itself never depends on the network, the
backend, or even its own UI.

## Features

- **App + mic on separate tracks** — ScreenCaptureKit captures the selected
  app's audio; AVFoundation records the microphone independently. A mic
  failure never kills an app capture.
- **Crash-safe recording** — every session has an atomic on-disk manifest.
  Force-quit mid-lecture and the audio is still there, marked recoverable on
  next launch.
- **Resumable upload queue** — audio is chunked locally into self-contained
  25s WAV files and uploaded with retry/backoff. Recording continues even if
  the server is down; the queue catches up when it returns.
- **French transcription** — faster-whisper on your own server; raw whisper
  output is stored immutably and never overwritten.
- **OpenRouter correction** — optional second pass that fixes ASR errors
  (homophones, dictated notation like `free -h`) without reformulating. Runs
  locally from the desktop app with your own API key.
- **Independent states** — recording, transcription, and correction each have
  their own state machine and error channel.
- **Library & playback** — browse past lectures, read raw/corrected/final
  transcript versions, click a segment to seek the audio.

## How it works

```mermaid
flowchart LR
    subgraph Mac["Pssst.app (Tauri 2 / Rust)"]
        CAP[ScreenCaptureKit + AVFoundation] --> TRK[Separate WAV tracks]
        TRK --> Q[Durable chunk queue]
        Q -->|25s WAV chunks, retry + backoff| UP[Upload worker]
        MAN[manifest.json per session] --> Q
    end
    subgraph Server["Whisper server (FastAPI)"]
        API[/v1 endpoints/] --> FW[faster-whisper]
        FW --> SEG[(Transcript segments)]
    end
    UP -->|bearer auth| API
    SEG -->|polling sync| MAN
    MAN -->|OpenRouter, your key| COR[Corrected / final text]
```

The React UI is an observer only — it renders the manifest state. Capture,
chunking, upload, and correction all happen in Rust so a hung webview or
dropped connection can never lose audio.

## Requirements

- macOS 15+ (ScreenCaptureKit), Rust stable, pnpm
- For the bundled backend: Docker (PostgreSQL) + Python 3.11+
- *or* any Linux box for the standalone worker — no Docker needed
- Optional: an OpenRouter API key for transcript correction

## Quick start

```sh
pnpm install

# 1. Whisper backend — pick ONE:

#    a) Full backend: PostgreSQL + Alembic + persistent segments
docker compose up -d db
cd backend
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload        # http://127.0.0.1:8000
cd ..

#    b) Standalone worker on a fresh Debian/Ubuntu machine
curl -fsSL https://irisla.com/pssst/install.sh | sudo bash

# 2. Desktop app
pnpm exec tauri dev          # development build
pnpm app:mac                 # signed debug .app → /Applications (needed for real capture)
```

Then paste the server's connection link (`http://<host>:<port>/connect/<secret>`)
into the app's Settings → Server. The link is printed by the installer, or
found at `$PSSST_STORAGE_DIR/.connection-secret` for the bundled backend.

## Configuration

Backend settings use the `PSSST_` prefix (see `backend/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PSSST_DATABASE_URL` | `postgresql+asyncpg://pssst:pssst_dev@localhost:5433/pssst` | PostgreSQL DSN |
| `PSSST_STORAGE_DIR` | `./data` | Uploaded chunks + connection secret |
| `PSSST_WHISPER_MODEL` | `medium` | faster-whisper model name/size |
| `PSSST_WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` |
| `PSSST_WHISPER_COMPUTE_TYPE` | `int8` | faster-whisper compute type |
| `PSSST_OPENROUTER_API_KEY` | — | Server-side correction fallback key |
| `PSSST_OPENROUTER_MODEL` | — | Server-side correction fallback model |
| `PSSST_PUBLIC_BASE_URL` | `http://127.0.0.1:8000` | Base URL for connection links |
| `PSSST_CONNECTION_SECRET` | — | Fixed bearer secret; auto-generated if unset |

Correction credentials can also be saved per-device in the app's Settings —
the desktop sends them with each correction request, so the server needs no
OpenRouter configuration.

## API

All `/v1` routes require `Authorization: Bearer <secret>`.

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness + whisper config |
| `GET /connect/{secret}` | Validates a link, returns server capabilities |
| `POST /v1/sessions/{id}` | Idempotent session registration |
| `POST /v1/sessions/{id}/chunks/{seq}` | Idempotent WAV chunk upload |
| `POST /v1/sessions/{id}/chunks/{seq}/transcribe` | Run whisper on a chunk |
| `GET /v1/sessions/{id}/transcript` | Segments with raw/corrected/final text |
| `POST /v1/sessions/{id}/correct?final=` | OpenRouter correction pass |
| `GET /v1/sessions/{id}/status` | Chunk counts by state + correction state |
| `POST /admin/regenerate-connection-link` | Rotate the bearer secret |

## Project layout

```
src/            React frontend (views: setup, recording, library, detail, settings)
src-tauri/      Rust: capture backends, session store, chunk queue, Tauri commands
backend/        FastAPI + PostgreSQL backend, Alembic migrations, pytest suite
server/         Standalone single-file whisper worker (install.sh embeds it)
docs/           DEVELOPMENT.md, MACOS_CAPTURE_TESTING.md, superpowers specs/plans
scripts/        run-macos-app.sh (signed debug bundle → /Applications)
```

## Tests

```sh
pnpm vitest run                    # frontend (jsdom)
cd src-tauri && cargo test         # recovery, capture contract, upload queue
cd backend && .venv/bin/pytest     # API suite on isolated SQLite DBs
cd backend && .venv/bin/alembic check   # models match migrated schema
```

The real faster-whisper model test is gated:
`RUN_MODEL_TESTS=1 .venv/bin/pytest tests/test_transcription.py -k real`

## Docs

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — full dev setup, migrations, test matrix
- [docs/MACOS_CAPTURE_TESTING.md](docs/MACOS_CAPTURE_TESTING.md) — manual capture/permission/recovery checklist
- [docs/superpowers/](docs/superpowers/) — original spec and v1 implementation plan

## Security notes

- The connection secret is generated locally (`secrets.token_urlsafe(48)`),
  stored `0600`, and never committed. Rotate it from the app or via
  `POST /admin/regenerate-connection-link`.
- `backend/.env`, `backend/data/`, and the app data directory are gitignored.
- No telemetry; audio leaves the Mac only to your own server.
