use pssst::{capture::CaptureApplication, recording::{recover_sessions, RecordingState, SessionStore, StartRecordingRequest}};

#[test]
fn unfinished_session_recovers_without_losing_separate_track_paths() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::new(directory.path());
    let session = store.create(StartRecordingRequest {
        course: "Architecture des ordinateurs".into(),
        application: CaptureApplication::new("zoom-42", "Zoom Workplace", "zoom"),
        include_microphone: true,
    }).unwrap();

    store.mark_recording(&session.id).unwrap();
    let recovered = recover_sessions(&store).unwrap();

    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].recording_state, RecordingState::Recoverable);
    assert_ne!(recovered[0].tracks[0].relative_path, recovered[0].tracks[1].relative_path);
}
