use pssst::{
    capture::{
        simulated::SimulatedCaptureBackend, CaptureApplication, CaptureBackend, CaptureHandle,
        CaptureRequest, TrackKind,
    },
    recording::{RecordingService, RecordingState, StartRecordingRequest},
};

fn request(track: TrackKind) -> CaptureRequest {
    CaptureRequest {
        application: CaptureApplication::new("zoom-42", "Zoom Workplace", "zoom"),
        track,
    }
}

#[test]
fn application_and_microphone_requests_write_to_distinct_sinks() {
    let directory = tempfile::tempdir().unwrap();
    let mut backend = SimulatedCaptureBackend::default();

    let app_path = directory.path().join("application.wav");
    let mic_path = directory.path().join("microphone.wav");

    let app_handle = backend.start_capture(request(TrackKind::Application), &app_path).unwrap();
    let mic_handle = backend.start_capture(request(TrackKind::Microphone), &mic_path).unwrap();
    backend.stop_capture(app_handle).unwrap();
    backend.stop_capture(mic_handle).unwrap();

    let app_contents = std::fs::read_to_string(&app_path).unwrap();
    let mic_contents = std::fs::read_to_string(&mic_path).unwrap();

    assert!(app_contents.contains("Application"));
    assert!(app_contents.contains("zoom-42"));
    assert!(mic_contents.contains("Microphone"));
    assert_ne!(app_contents, mic_contents);
}

#[test]
fn stopping_an_unknown_capture_handle_is_a_typed_error() {
    let mut backend = SimulatedCaptureBackend::default();
    assert!(backend.stop_capture(CaptureHandle(999)).is_err());
}

#[test]
fn recording_service_writes_separate_tracks_through_the_backend() {
    let directory = tempfile::tempdir().unwrap();
    let mut service = RecordingService::new(
        directory.path().to_path_buf(),
        SimulatedCaptureBackend::default(),
    )
    .unwrap();

    let snapshot = service
        .start(StartRecordingRequest {
            course: "Architecture des ordinateurs".into(),
            application: CaptureApplication::new("zoom-42", "Zoom Workplace", "zoom"),
            include_microphone: true,
        })
        .unwrap();

    assert_eq!(snapshot.session.recording_state, RecordingState::Recording);
    assert_eq!(snapshot.session.tracks.len(), 2);

    let app_path = service.track_path(snapshot.session.id, TrackKind::Application).unwrap();
    let mic_path = service.track_path(snapshot.session.id, TrackKind::Microphone).unwrap();
    assert_ne!(app_path, mic_path);
    assert!(std::fs::read_to_string(&app_path).unwrap().contains("Application"));
    assert!(std::fs::read_to_string(&mic_path).unwrap().contains("Microphone"));

    let stopped = service.stop(snapshot.session.id).unwrap();
    assert_eq!(stopped.session.recording_state, RecordingState::Stopped);
}

#[test]
fn recording_requires_a_course_and_an_available_application() {
    let directory = tempfile::tempdir().unwrap();
    let mut service = RecordingService::new(
        directory.path().to_path_buf(),
        SimulatedCaptureBackend::default(),
    )
    .unwrap();

    assert!(service
        .start(StartRecordingRequest {
            course: "   ".into(),
            application: CaptureApplication::new("zoom-42", "Zoom Workplace", "zoom"),
            include_microphone: false,
        })
        .is_err());

    let mut unavailable = CaptureApplication::new("safari", "Safari", "safari");
    unavailable.available = false;
    assert!(service
        .start(StartRecordingRequest {
            course: "Systèmes".into(),
            application: unavailable,
            include_microphone: false,
        })
        .is_err());
}
