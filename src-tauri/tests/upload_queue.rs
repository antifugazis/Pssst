use std::io::Write;

use pssst::{
    capture::{CaptureApplication, TrackKind},
    recording::{refresh_queue, SessionStore, StartRecordingRequest},
};

// Must match the constants in recording/processing.rs: 25s of 48kHz stereo PCM16.
const CHUNK_SECONDS: usize = 25;
const BYTES_PER_SECOND: usize = 48_000 * 2 * 2;
const CHUNK_BYTES: usize = CHUNK_SECONDS * BYTES_PER_SECOND;
const WAV_HEADER: usize = 44;

fn session_with_track(payload_bytes: usize) -> (tempfile::TempDir, SessionStore, uuid::Uuid, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::new(directory.path());
    let session = store
        .create(StartRecordingRequest {
            course: "Architecture des ordinateurs".into(),
            application: CaptureApplication::new("zoom-42", "Zoom Workplace", "zoom"),
            include_microphone: false,
        })
        .unwrap();
    let track = store.track_path(&session, TrackKind::Application).unwrap();
    let mut file = std::fs::File::create(&track).unwrap();
    file.write_all(&vec![0u8; WAV_HEADER]).unwrap();
    file.write_all(&vec![0u8; payload_bytes]).unwrap();
    file.sync_all().unwrap();
    (directory, store, session.id, track)
}

#[test]
fn offline_chunk_keeps_local_reference_and_retry_metadata() {
    let (_dir, store, id, track) = session_with_track(CHUNK_BYTES + 1_000);
    let queue = refresh_queue(&store, id, &track, true).unwrap();

    assert_eq!(queue.items.len(), 2);

    let first = &queue.items[0];
    assert_eq!(first.sequence, 0);
    assert_eq!(first.start_ms, 0);
    assert_eq!(first.end_ms, 25_000);
    assert_eq!(first.state, "queued");
    assert_eq!(first.attempts, 0);
    assert_eq!(first.last_error, None);
    // The local reference points at a real self-contained WAV on disk so an
    // offline queue can resume without the original track.
    assert!(std::path::Path::new(&first.path).exists());
    let chunk = std::fs::read(&first.path).unwrap();
    assert_eq!(&chunk[0..4], b"RIFF");

    let second = &queue.items[1];
    assert_eq!(second.sequence, 1);
    assert_eq!(second.start_ms, 25_000);
    assert!(second.end_ms > 25_000);
}

#[test]
fn refreshing_the_queue_is_idempotent() {
    let (_dir, store, id, track) = session_with_track(CHUNK_BYTES + 1_000);
    let first = refresh_queue(&store, id, &track, true).unwrap();
    let second = refresh_queue(&store, id, &track, true).unwrap();

    assert_eq!(first.items.len(), second.items.len());
    for (a, b) in first.items.iter().zip(second.items.iter()) {
        assert_eq!(a.sequence, b.sequence);
        assert_eq!(a.path, b.path);
    }

    // Persisted queue survives reloads — this is what lets retries resume
    // after an app restart without duplicating uploads.
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(store.queue_path(&id)).unwrap()).unwrap();
    assert_eq!(persisted["items"].as_array().unwrap().len(), 2);
}

#[test]
fn a_live_recording_only_exports_complete_chunk_windows() {
    let (_dir, store, id, track) = session_with_track(CHUNK_BYTES + 1_000);

    // While recording, only whole 25s windows may leave the machine; the
    // partial tail stays local until the finalizer runs.
    let live = refresh_queue(&store, id, &track, false).unwrap();
    assert_eq!(live.items.len(), 1);

    let finalized = refresh_queue(&store, id, &track, true).unwrap();
    assert_eq!(finalized.items.len(), 2);
}

#[test]
fn track_with_no_payload_produces_no_work() {
    let (_dir, store, id, track) = session_with_track(0);
    let queue = refresh_queue(&store, id, &track, true).unwrap();
    assert!(queue.items.is_empty());
}
