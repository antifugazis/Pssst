# Development

## Prerequisites

- macOS 15+ (ScreenCaptureKit capture path), Rust stable, pnpm, Python 3.11+,
  Docker (for PostgreSQL)
- A local faster-whisper model cache if you want to run the gated model test

## Setup

```sh
pnpm install

# PostgreSQL (port 5433)
docker compose up -d db

# Backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env          # then edit as needed
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload
```

The backend prints a connection link of the form
`http://127.0.0.1:8000/connect/<secret>`; paste it into the app's server
settings. The secret is generated into `PSSST_STORAGE_DIR/.connection-secret`
unless `PSSST_CONNECTION_SECRET` is set.

### Database migrations

Schema is owned by Alembic (`backend/migrations/`); the app no longer calls
`create_all` on startup.

```sh
cd backend
.venv/bin/alembic upgrade head        # apply migrations
.venv/bin/alembic revision --autogenerate -m "change"   # after editing models.py
.venv/bin/alembic check               # verify models match the database
```

If a database was created before migrations existed, stamp it once:
`.venv/bin/alembic stamp head`.

## Tests

```sh
pnpm vitest run        # frontend (jsdom)
pnpm build             # tsc + vite production build
cd src-tauri && cargo test     # recording, capture contract, upload queue
cd backend && .venv/bin/pytest # FastAPI suite on isolated SQLite databases
```

Backend tests run against per-test SQLite files; no PostgreSQL is needed.
The real faster-whisper model test is gated:

```sh
RUN_MODEL_TESTS=1 .venv/bin/pytest tests/test_transcription.py -k real
```

## Desktop app

```sh
pnpm exec tauri dev          # development build (simulated backend off macOS)
pnpm app:mac                 # signed debug .app into /Applications (required for capture)
```

Use `pnpm app:mac` — not `tauri dev` — when testing real audio capture.
macOS attaches audio-capture permission to the signed `.app` bundle, not to
Tauri's transient debug executable. See MACOS_CAPTURE_TESTING.md.

## OpenRouter correction

Optional. The desktop app stores the user's API key/model in
`openrouter-config.json` under the app data directory and sends it per request
to `POST /v1/sessions/{id}/correct`; alternatively set
`PSSST_OPENROUTER_API_KEY` / `PSSST_OPENROUTER_MODEL` server-side. Without a
key, correction reports `blocked` and raw transcripts are untouched.

## Environment variables

All backend settings use the `PSSST_` prefix; see `backend/.env.example`.
