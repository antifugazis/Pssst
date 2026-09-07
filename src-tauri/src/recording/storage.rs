use std::{fs::{self, File}, io::Write, path::{Path, PathBuf}};
use anyhow::{Context, Result};
use chrono::Utc;
use uuid::Uuid;
use super::{LocalSession, RecordingState, SessionTrack, StartRecordingRequest, TrackProcessingState};
use crate::capture::TrackKind;

#[derive(Debug, Clone)]
pub struct SessionStore { root: PathBuf }
impl SessionStore {
    pub fn new(root: impl Into<PathBuf>) -> Self { Self { root: root.into() } }
    pub fn root(&self) -> &Path { &self.root }
    pub fn create(&self, request: StartRecordingRequest) -> Result<LocalSession> {
        let id = Uuid::new_v4(); let directory = self.root.join("sessions").join(id.to_string());
        fs::create_dir_all(directory.join("application"))?;
        let mut tracks = vec![SessionTrack { kind: TrackKind::Application, relative_path: "application/track.wav".into(), bytes_written: 0, processing_state: TrackProcessingState::NotStarted }];
        if request.include_microphone { fs::create_dir_all(directory.join("microphone"))?; tracks.push(SessionTrack { kind: TrackKind::Microphone, relative_path: "microphone/track.wav".into(), bytes_written: 0, processing_state: TrackProcessingState::NotStarted }); }
        for track in &tracks { File::create(directory.join(&track.relative_path))?.sync_all()?; }
        let session = LocalSession { schema_version: 1, id, course: request.course.trim().into(), started_at: Utc::now(), ended_at: None, recording_state: RecordingState::Preparing, selected_application: request.application, microphone_included: request.include_microphone, tracks, transcription_state: TrackProcessingState::NotStarted, correction_state: TrackProcessingState::NotStarted, last_error: None, transcript_segments: vec![] };
        self.save(&session)?; Ok(session)
    }
    pub fn load(&self, id: &Uuid) -> Result<LocalSession> { let text = fs::read_to_string(self.manifest_path(id)).context("session manifest unavailable")?; Ok(serde_json::from_str(&text)?) }
    pub fn save(&self, session: &LocalSession) -> Result<()> {
        let path = self.manifest_path(&session.id); let temporary = path.with_extension("tmp");
        let mut file = File::create(&temporary)?; file.write_all(serde_json::to_string_pretty(session)?.as_bytes())?; file.sync_all()?; drop(file); fs::rename(&temporary, &path)?;
        if let Ok(parent) = File::open(path.parent().expect("manifest has parent")) { let _ = parent.sync_all(); }
        Ok(())
    }
    pub fn mark_recording(&self, id: &Uuid) -> Result<LocalSession> { let mut s = self.load(id)?; s.recording_state = RecordingState::Recording; self.save(&s)?; Ok(s) }
    pub fn stop(&self, id: &Uuid) -> Result<LocalSession> { let mut s = self.load(id)?; s.recording_state = RecordingState::Stopped; s.ended_at = Some(Utc::now()); self.refresh_bytes(&mut s); self.save(&s)?; Ok(s) }
    pub fn track_path(&self, session: &LocalSession, kind: TrackKind) -> Result<PathBuf> { let track = session.tracks.iter().find(|track| track.kind == kind).context("track not configured")?; Ok(self.session_dir(&session.id).join(&track.relative_path)) }
    pub fn queue_path(&self, id: &Uuid) -> PathBuf { self.session_dir(id).join("processing-queue.json") }
    fn refresh_bytes(&self, session: &mut LocalSession) { for track in &mut session.tracks { track.bytes_written = fs::metadata(self.session_dir(&session.id).join(&track.relative_path)).map(|m| m.len()).unwrap_or(0); } }
    fn session_dir(&self, id: &Uuid) -> PathBuf { self.root.join("sessions").join(id.to_string()) }
    fn manifest_path(&self, id: &Uuid) -> PathBuf { self.session_dir(id).join("manifest.json") }
}
pub fn recover_sessions(store: &SessionStore) -> Result<Vec<LocalSession>> {
    let directory = store.root().join("sessions"); if !directory.exists() { return Ok(vec![]); }
    let mut recovered = Vec::new(); for entry in fs::read_dir(directory)? { let entry = entry?; let id = match Uuid::parse_str(&entry.file_name().to_string_lossy()) { Ok(id) => id, Err(_) => continue }; let mut session = store.load(&id)?;
        if matches!(session.recording_state, RecordingState::Preparing | RecordingState::Recording | RecordingState::Stopping) { session.recording_state = RecordingState::Recoverable; session.last_error = Some("The app closed while this lecture was being recorded. Existing audio was preserved.".into()); store.save(&session)?; recovered.push(session); }
    } Ok(recovered)
}
