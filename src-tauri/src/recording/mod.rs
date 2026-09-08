mod manifest;
mod processing;
mod service;
mod storage;
pub use manifest::{LocalSession, LocalTranscriptSegment, RecordingState, SessionTrack, TrackProcessingState};
pub use processing::{spawn_processing, run_correction};
pub use storage::{recover_sessions, SessionStore};
pub use service::{RecordingService, RecordingSnapshot};

use crate::capture::CaptureApplication;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartRecordingRequest { pub course: String, pub application: CaptureApplication, pub include_microphone: bool }
