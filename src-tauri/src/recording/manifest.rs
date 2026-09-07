use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::capture::{CaptureApplication, TrackKind};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingState { Preparing, Recording, Stopping, Stopped, Recoverable, Failed }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackProcessingState { NotStarted, Queued, Uploading, Uploaded, Failed }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTrack { pub kind: TrackKind, pub relative_path: String, pub bytes_written: u64, pub processing_state: TrackProcessingState }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalSession {
    pub schema_version: u8,
    pub id: Uuid,
    pub course: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub recording_state: RecordingState,
    pub selected_application: CaptureApplication,
    pub microphone_included: bool,
    pub tracks: Vec<SessionTrack>,
    pub transcription_state: TrackProcessingState,
    pub correction_state: TrackProcessingState,
    pub last_error: Option<String>,
    #[serde(default)] pub transcript_segments: Vec<LocalTranscriptSegment>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalTranscriptSegment { pub backend_id: String, pub start_ms: i64, pub end_ms: i64, pub raw_text: String, pub corrected_text: Option<String>, pub final_text: Option<String> }
