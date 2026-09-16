# Pssst

**Local-first lecture recorder for macOS.** Pssst captures application audio
and microphone audio as separate tracks, streams 25-second chunks to a
self-hosted faster-whisper server, and produces a corrected transcript in
French or English via OpenRouter — while recording itself never depends on
the network, the backend, or even its own UI.

![Recording setup](docs/screenshots/app-setup.png)

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
- **French & English transcription** — faster-whisper on your own server
  auto-detects the lecture's language on the first chunk and pins it for the
  session; raw whisper output is stored immutably and never overwritten.
- **Bilingual interface** — the desktop UI is fully translated in French and
  English, selectable in Settings.
- **OpenRouter correction** — optional second pass that fixes ASR errors
  (homophones, dictated notation like `free -h`) without reformulating. Runs
  locally from the desktop app with your own API key.
- **Independent states** — recording, transcription, and correction each have
  their own state machine and error channel.
- **Library & playback** — browse past lectures, read raw/corrected/final
  transcript versions, click a segment to seek the audio.
- **Guided onboarding** — six-step first run covering the pipeline, whisper
  placement, and macOS permissions.

| Onboarding | Library | Settings |
|---|---|---|
| ![Onboarding](docs/screenshots/onboarding-welcome.png) | ![Library](docs/screenshots/app-library.png) | ![Settings](docs/screenshots/app-settings.png) |

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

## Recording a lecture

1. Start audio in the app that plays the course (Zoom, Chrome, …).
2. In Pssst, type the course name and pick the application.
3. Optionally enable *Inclure mon micro* so your own questions are recorded.
4. Press **Commencer l'enregistrement**. Transcript segments stream in live
   as chunks are transcribed.
5. Stop with the hold-to-stop control. The final partial chunk is exported
   and the queue drains.
6. In the lecture detail view, switch between **Brute** / **Corrigée** /
   **Finale** transcript versions and click any segment to seek playback.
7. With an OpenRouter key saved, press *Corriger la transcription* — the
   corrected text fills in incrementally, raw text untouched.

## Where files live

| What | Path |
|---|---|
| Recordings & manifests | `~/Library/Application Support/com.irisla.pssst.desktop/recordings/sessions/<id>/` |
| Server connection link | `…/recordings/server-connection.txt` |
| OpenRouter config | `…/recordings/openrouter-config.json` |
| Upload queue (per session) | `…/recordings/sessions/<id>/processing-queue.json` |
| Backend chunks + secret | `backend/data/` (or `$PSSST_STORAGE_DIR`) |

Each session directory contains `manifest.json`, `application/track.wav`,
optionally `microphone/track.wav`, and `application/chunks/*.wav` until
uploaded. All tracks are 48 kHz stereo WAV; float32 captures are normalized
to PCM16 automatically.

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
| `POST /v1/sessions/{id}` | Idempotent session registration; optional body `{"language": "fr"\|"en"}` pins the language (default: auto-detect on first chunk) |
| `POST /v1/sessions/{id}/chunks/{seq}` | Idempotent WAV chunk upload |
| `POST /v1/sessions/{id}/chunks/{seq}/transcribe` | Run whisper on a chunk; returns the detected/pinned `language` |
| `GET /v1/sessions/{id}/transcript` | Segments with raw/corrected/final text |
| `POST /v1/sessions/{id}/correct?final=` | OpenRouter correction pass |
| `GET /v1/sessions/{id}/status` | Chunk counts by state + correction state |
| `POST /admin/regenerate-connection-link` | Rotate the bearer secret |

The standalone worker (`server/install.sh`) implements the same `/connect`
and `/v1` surface minus the correction endpoint — correction always runs
from the desktop anyway.

## Project layout

```
src/            React frontend (views: setup, recording, library, detail, settings)
src-tauri/      Rust: capture backends, session store, chunk queue, Tauri commands
backend/        FastAPI + PostgreSQL backend, Alembic migrations, pytest suite
server/         Standalone single-file whisper worker (install.sh embeds it)
docs/           Guides, screenshots, superpowers specs/plans
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

## Troubleshooting

| Symptom | Fix |
|---|---|
| App asks for permission on every launch | Use `pnpm app:mac`, not `tauri dev` — TCC binds to the signed `.app` |
| No applications in the picker | Grant the audio permission via the onboarding/settings button, then relaunch |
| Transcript stays empty | Check the connection link in Settings; the queue retries and syncs when the server is reachable |
| Correction says "blocked" | Save an OpenRouter key + model in Settings → Correction IA |
| `alembic upgrade head` fails: table exists | The DB predates migrations — run `.venv/bin/alembic stamp head` once |

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
