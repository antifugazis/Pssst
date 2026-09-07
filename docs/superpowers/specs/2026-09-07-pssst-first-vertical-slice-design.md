# pssst First Vertical Slice Design

## Goal

Deliver a genuinely local-first macOS recording path: select a running application, start a session, write selected-application audio and optional microphone audio as independent local tracks, stop it safely, and recover the session after restart. FastAPI/PostgreSQL is included as a runnable repository service, but no backend dependency is allowed on this first recording-critical path.

## Scope

This slice contains:

- Tauri desktop setup flow preserved from the existing pssst screen.
- A typed React session facade showing native-provided recording state only.
- A Rust `CaptureBackend` abstraction, with a macOS ScreenCaptureKit implementation and a test-only simulated implementation.
- Separate `application` and optional `microphone` audio tracks.
- Atomic session manifests, append-only track output, and recovery of unfinished sessions at launch.
- Dedicated active-session and recovered-session UI states in the existing visual language.
- A FastAPI/PostgreSQL skeleton with Docker Compose, health endpoint, typed domain models, and migrations-ready persistence setup.

It intentionally excludes upload, faster-whisper processing, OpenRouter correction, finalization, and library search. The local session schema includes processing slots for those future slices, but no transcription result is fabricated.

## Non-Negotiable Reliability Rules

1. Rust creates the session directory and writes an initial manifest before attempting capture.
2. The native recorder writes local audio independently from React, HTTP, FastAPI, PostgreSQL, Whisper, and OpenRouter.
3. Application and microphone tracks have independent writer handles and metadata. No destructive mixing occurs.
4. Mutating metadata uses atomic replacement: write a temporary manifest, `sync_all`, rename it into place, and sync the parent directory where supported.
5. Track files are durable checkpoints. A session remains recoverable if a crash interrupts capture; its last written audio remains valid and the manifest is marked `recoverable` on the next launch.
6. Backend failures cannot alter recording state. Upload/transcription/correction status is represented independently and begins as `not_started`.
7. React never receives a PID or device identifier. It receives `CaptureApplication { id, name, icon_hint, available }`.

## Repository Structure

```
src-tauri/
  src/
    capture/mod.rs                 # Cross-platform CaptureBackend trait + shared types
    capture/macos.rs               # cfg(target_os = "macos") ScreenCaptureKit implementation
    recording/mod.rs               # SessionRecorder orchestration and typed commands
    recording/manifest.rs          # Durable session/track manifest read-write-recovery
    recording/storage.rs           # App-data paths, atomic files, track paths
    commands.rs                    # Small Tauri command adapters only
    main.rs

src/
  features/session/
    types.ts                       # Mirror-safe command DTOs and state names
    nativeSessionClient.ts         # Tauri command façade; no macOS concepts
    sessionStore.ts                # Reducer/controller for UI fetch lifecycle
  screens/
    SetupScreen.tsx                # Existing screen split from App
    RecordingScreen.tsx            # Active/recovered local-session status
  App.tsx

backend/
  app/
    main.py                        # FastAPI app and health router
    config.py                      # Typed environment settings, no secrets in code
    db.py                          # Async SQLAlchemy/PostgreSQL lifecycle
    models.py                      # Session, track, chunk, segment, correction tables
    schemas.py                     # Request/response shapes
  pyproject.toml
  alembic.ini
  migrations/
docker-compose.yml
```

## Native Capture and Recording Architecture

### Cross-platform boundary

```rust
pub trait CaptureBackend: Send {
    fn list_applications(&self) -> Result<Vec<CaptureApplication>, CaptureError>;
    fn permission_status(&self) -> Result<CapturePermission, CaptureError>;
    fn request_permission(&self) -> Result<(), CaptureError>;
    fn start_capture(&mut self, request: CaptureRequest, sink: TrackSink) -> Result<CaptureHandle, CaptureError>;
    fn stop_capture(&mut self, handle: CaptureHandle) -> Result<(), CaptureError>;
}
```

`CaptureRequest` contains a logical application identifier and a `TrackKind`; it has no React types and no macOS framework objects. `TrackSink` is a writer destination supplied by the recorder. A later WASAPI backend implements the trait without changing session or UI types.

### macOS implementation

`capture/macos.rs` is compiled only on macOS. It enumerates shareable applications through ScreenCaptureKit, maps stable process/application values to opaque IDs, requests Screen Recording/System Audio permission, and starts `SCStream` application-audio output. AVFoundation separately captures microphone frames when enabled. Both adapters forward encoded audio into the recorder-owned sink. Native framework calls remain in this module or a minimal bridge invoked only here.

The implementation must explicitly fail with a typed `PermissionRequired` or `ApplicationUnavailable` error rather than silently falling back to system-wide audio. A simulation backend is enabled only for tests/development where native capture is unavailable, and it is visibly surfaced as development-only state.

### Durable session layout

```text
<app-data>/sessions/<session-id>/
  manifest.json
  application/track.m4a
  microphone/track.m4a             # absent when microphone is disabled
  .manifest.tmp                    # transient atomic-write file only
```

Each manifest includes session identity/course/start time/state, selected application, per-track file locations and byte/checkpoint counts, processing placeholders, and manifest schema version. It does not store secrets or transcript text.

### State machines

Recording state is native-authoritative: `idle → preparing → recording → stopping → stopped`; a startup scan turns a persisted `preparing`, `recording`, or `stopping` state into `recoverable` after validating track paths. A recovered session can be labelled “Recovered recording” in the UI and remains valid for future upload/finalization.

Processing state is metadata-only in this slice: `not_started`. Future `queued`, `processing`, `caught_up`, `delayed`, and `complete` values do not influence the native state machine.

## Tauri Commands

Command adapters contain no file or framework logic. They invoke a managed `RecorderService` and return DTOs.

```text
list_capture_applications() -> CaptureApplication[]
get_capture_permission() -> CapturePermission
request_capture_permission() -> CapturePermission
start_recording(StartRecordingRequest) -> LocalSession
get_recording_status(session_id) -> LocalSession
stop_recording(session_id) -> LocalSession
list_recoverable_sessions() -> LocalSession[]
```

`start_recording` creates/persists the manifest, creates sinks, then starts application and optional microphone capture. If microphone setup fails after application setup, it stops the application capture, records a recoverable manifest with the error, and returns an actionable failure. It never claims success until both required writers are started.

## Frontend Behaviour

The existing opening screen remains the entry point. It requests applications through `nativeSessionClient` and keeps the picker recognisable. When permissions are missing, it adds a concise permission recovery row without exposing technical capture details.

After start, `RecordingScreen` makes the transcript area intentionally quiet in this slice: it displays “Recording locally” and no false live transcript. The header presents elapsed time, source, microphone state, and separate small health statements: `Recording active`, `Transcription not started`, and `Correction not started`. The stop action requires a press-and-hold confirmation (800ms) so accidental clicks cannot end a class.

On launch, the client fetches recoverable sessions. A calm recovery banner lets the student keep the recovered recording; it never deletes or overwrites audio automatically.

## FastAPI/PostgreSQL Foundation

`docker compose up db` starts PostgreSQL with a named volume. `backend` runs with `uvicorn app.main:app --reload`; environment configuration provides the database URL and later OpenRouter settings. The backend exposes `/healthz`, applies database migrations, and has relational models for courses, sessions, tracks, chunks, transcript segments, correction batches, and processing jobs.

At this point it does not accept audio uploads. Database tables preserve fields for immutable `raw_text`, optional `corrected_text`, optional `final_text`, timestamps, and provider/model metadata; their behaviour is introduced only in later slices. There is no Redis, Celery, or separate queue service.

## Security and Privacy

Audio remains in the app data directory. This slice makes no outbound recording request. Errors avoid full paths where possible and never emit audio contents. Backend configuration reads secrets from environment variables only; no OpenRouter key exists in frontend code, local manifests, or logs.

## Tests and Verification

- Rust unit tests: manifest atomic write/load; restart recovery; separate track manifest behaviour; invalid state transition rejection.
- Rust integration tests: simulated backend start/stop writes separate non-empty tracks and leaves a reloadable session.
- React tests: disabled start, permission-required recovery state, active recording UI, recovery banner, and no transcript health conflation.
- Backend tests: `/healthz`; schema creation/migration; raw/corrected/final transcript columns stay independently addressable.
- Manual macOS verification: choose a running app, start recording, confirm separate local files, stop, relaunch, and inspect recovered/completed session metadata. ScreenCaptureKit permissions are tested manually on a real macOS host.

## Deferred Slices

1. Chunk scanning and resumable FastAPI upload.
2. Faster-whisper Medium raw transcription and immutable transcript segments.
3. Asynchronous OpenRouter correction batches.
4. Finalization with full-context correction.
5. Offline queue processing, library/detail playback, settings, and recovery polish.
