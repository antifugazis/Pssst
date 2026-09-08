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

#[test]
fn float32_wav_is_automatically_normalized_to_pcm16_on_track_path() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::new(directory.path());
    let session = store.create(StartRecordingRequest {
        course: "Architecture des ordinateurs".into(),
        application: CaptureApplication::new("zoom-42", "Zoom Workplace", "zoom"),
        include_microphone: false,
    }).unwrap();

    let raw_track_path = store.root().join("sessions").join(session.id.to_string()).join("application/track.wav");
    
    // Write a dummy 32-bit float stereo WAV file (format = 3)
    let sample: f32 = 0.5;
    let float_bytes = sample.to_le_bytes();
    let mut data = Vec::new();
    data.extend_from_slice(b"RIFF");
    data.extend_from_slice(&(36u32 + 8u32).to_le_bytes()); // 2 samples = 8 bytes
    data.extend_from_slice(b"WAVEfmt ");
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&3u16.to_le_bytes()); // Float format
    data.extend_from_slice(&2u16.to_le_bytes()); // 2 channels
    data.extend_from_slice(&48000u32.to_le_bytes()); // sample rate
    data.extend_from_slice(&(48000u32 * 8).to_le_bytes()); // byte rate
    data.extend_from_slice(&8u16.to_le_bytes()); // block align
    data.extend_from_slice(&32u16.to_le_bytes()); // 32 bits
    data.extend_from_slice(b"data");
    data.extend_from_slice(&8u32.to_le_bytes());
    data.extend_from_slice(&float_bytes); // L
    data.extend_from_slice(&float_bytes); // R
    std::fs::write(&raw_track_path, &data).unwrap();

    // Calling track_path normalizes the WAV to 16-bit PCM integer
    let resolved_path = store.track_path(&session, pssst::capture::TrackKind::Application).unwrap();
    let content = std::fs::read(&resolved_path).unwrap();

    assert_eq!(&content[0..4], b"RIFF");
    assert_eq!(&content[8..12], b"WAVE");
    assert_eq!(&content[20..22], &1u16.to_le_bytes()); // Format 1 (PCM)
    assert_eq!(&content[34..36], &16u16.to_le_bytes()); // 16 bits per sample
}
