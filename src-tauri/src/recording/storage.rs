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
    pub fn track_path(&self, session: &LocalSession, kind: TrackKind) -> Result<PathBuf> {
        let track = session.tracks.iter().find(|track| track.kind == kind).context("track not configured")?;
        let path = self.session_dir(&session.id).join(&track.relative_path);
        let _ = ensure_decodable_wav(&path);
        Ok(path)
    }
    pub fn queue_path(&self, id: &Uuid) -> PathBuf { self.session_dir(id).join("processing-queue.json") }
    fn refresh_bytes(&self, session: &mut LocalSession) { for track in &mut session.tracks { track.bytes_written = fs::metadata(self.session_dir(&session.id).join(&track.relative_path)).map(|m| m.len()).unwrap_or(0); } }
    fn session_dir(&self, id: &Uuid) -> PathBuf { self.root.join("sessions").join(id.to_string()) }
    fn manifest_path(&self, id: &Uuid) -> PathBuf { self.session_dir(id).join("manifest.json") }
}

pub fn ensure_decodable_wav(path: &Path) -> Result<()> {
    if !path.exists() { return Ok(()); }
    let data = fs::read(path)?;
    if data.len() < 44 { return Ok(()); }
    if &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" || &data[12..16] != b"fmt " {
        return Ok(());
    }
    let audio_format = u16::from_le_bytes([data[20], data[21]]);
    let channels = u16::from_le_bytes([data[22], data[23]]);
    let sample_rate = u32::from_le_bytes([data[24], data[25], data[26], data[27]]);
    let bits_per_sample = u16::from_le_bytes([data[34], data[35]]);

    if audio_format == 3 && bits_per_sample == 32 {
        let mut pos = 12;
        let mut data_start = None;
        let mut data_size = 0;
        while pos + 8 <= data.len() {
            let chunk_id = &data[pos..pos+4];
            let chunk_len = u32::from_le_bytes([data[pos+4], data[pos+5], data[pos+6], data[pos+7]]) as usize;
            if chunk_id == b"data" {
                data_start = Some(pos + 8);
                data_size = chunk_len.min(data.len().saturating_sub(pos + 8));
                break;
            }
            pos += 8 + chunk_len;
        }

        if let Some(start) = data_start {
            let float_bytes = &data[start..start + data_size];
            let sample_count = float_bytes.len() / 4;
            let mut pcm_bytes = Vec::with_capacity(sample_count * 2);
            for chunk in float_bytes[..sample_count * 4].chunks_exact(4) {
                let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                let clamped = sample.clamp(-1.0, 1.0);
                let pcm = (clamped * 32767.0) as i16;
                pcm_bytes.extend_from_slice(&pcm.to_le_bytes());
            }

            let new_data_len = pcm_bytes.len() as u32;
            let new_riff_len = 36 + new_data_len;
            let new_align = channels * 2;
            let new_byte_rate = sample_rate * new_align as u32;

            let mut out = Vec::with_capacity(44 + pcm_bytes.len());
            out.extend_from_slice(b"RIFF");
            out.extend_from_slice(&new_riff_len.to_le_bytes());
            out.extend_from_slice(b"WAVEfmt ");
            out.extend_from_slice(&16u32.to_le_bytes());
            out.extend_from_slice(&1u16.to_le_bytes());
            out.extend_from_slice(&channels.to_le_bytes());
            out.extend_from_slice(&sample_rate.to_le_bytes());
            out.extend_from_slice(&new_byte_rate.to_le_bytes());
            out.extend_from_slice(&new_align.to_le_bytes());
            out.extend_from_slice(&16u16.to_le_bytes());
            out.extend_from_slice(b"data");
            out.extend_from_slice(&new_data_len.to_le_bytes());
            out.extend_from_slice(&pcm_bytes);

            let temporary = path.with_extension("tmp");
            fs::write(&temporary, out)?;
            fs::rename(temporary, path)?;
        }
    }
    Ok(())
}
pub fn recover_sessions(store: &SessionStore) -> Result<Vec<LocalSession>> {
    let directory = store.root().join("sessions"); if !directory.exists() { return Ok(vec![]); }
    let mut recovered = Vec::new(); for entry in fs::read_dir(directory)? { let entry = entry?; let id = match Uuid::parse_str(&entry.file_name().to_string_lossy()) { Ok(id) => id, Err(_) => continue }; let mut session = store.load(&id)?;
        if matches!(session.recording_state, RecordingState::Preparing | RecordingState::Recording | RecordingState::Stopping) { session.recording_state = RecordingState::Recoverable; session.last_error = Some("The app closed while this lecture was being recorded. Existing audio was preserved.".into()); store.save(&session)?; recovered.push(session); }
    } Ok(recovered)
}
