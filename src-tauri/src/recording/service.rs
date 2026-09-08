use std::{collections::HashMap, path::PathBuf};

use anyhow::{anyhow, Result};
use serde::Serialize;
use uuid::Uuid;

use crate::capture::{CaptureBackend, CaptureHandle, CaptureRequest, TrackKind};
use super::{recover_sessions, LocalSession, RecordingState, SessionStore, StartRecordingRequest};

#[derive(Debug, Clone, Serialize)]
pub struct RecordingSnapshot { pub session: LocalSession, pub elapsed_seconds: i64 }

/// Owns the recording-critical lifecycle. UI and network layers only observe
/// the manifest; no capture callback waits on either of them.
pub struct RecordingService<B: CaptureBackend> {
    store: SessionStore,
    backend: B,
    active: HashMap<Uuid, Vec<CaptureHandle>>,
}

impl<B: CaptureBackend> RecordingService<B> {
    pub fn new(root: PathBuf, backend: B) -> Result<Self> {
        let store = SessionStore::new(root);
        recover_sessions(&store)?;
        super::processing::resume_pending(store.clone());
        Ok(Self { store, backend, active: HashMap::new() })
    }

    pub fn start(&mut self, request: StartRecordingRequest) -> Result<RecordingSnapshot> {
        if request.course.trim().is_empty() { return Err(anyhow!("A course is required before recording.")); }
        if !request.application.available { return Err(anyhow!("That application is no longer available.")); }
        let session = self.store.create(request)?;
        let mut handles = Vec::new();
        let app_path = self.store.track_path(&session, TrackKind::Application)?;
        match self.backend.start_capture(CaptureRequest { application: session.selected_application.clone(), track: TrackKind::Application }, &app_path) {
            Ok(handle) => handles.push(handle),
            Err(error) => {
                let mut failed = session.clone();
                failed.recording_state = RecordingState::Failed;
                failed.last_error = Some(error.to_string());
                self.store.save(&failed)?;
                return Err(anyhow!(error));
            }
        }
        let mut microphone_warning = None;
        if session.microphone_included {
            let mic_path = self.store.track_path(&session, TrackKind::Microphone)?;
            match self.backend.start_capture(CaptureRequest { application: session.selected_application.clone(), track: TrackKind::Microphone }, &mic_path) {
                Ok(handle) => handles.push(handle),
                Err(error) => {
                    // The microphone is explicitly optional. A microphone
                    // permission/device failure must never discard an active
                    // application capture or make Start appear broken.
                    microphone_warning = Some(format!("Microphone could not start: {error}"));
                }
            }
        }
        let recording = self.store.mark_recording(&session.id)?;
        let recording = if let Some(warning) = microphone_warning {
            let mut updated = recording.clone();
            updated.last_error = Some(warning);
            self.store.save(&updated)?;
            updated
        } else {
            recording
        };
        self.active.insert(recording.id, handles);
        super::spawn_processing(self.store.clone(), recording.id);
        Ok(snapshot(recording))
    }

    pub fn stop(&mut self, id: Uuid) -> Result<RecordingSnapshot> {
        let session = self.store.load(&id)?;
        if let Some(handles) = self.active.remove(&id) {
            for handle in handles { self.backend.stop_capture(handle).map_err(|error| anyhow!(error))?; }
        }
        let stopped = self.store.stop(&session.id)?;
        // The session worker sees the stopped state and flushes exactly one final partial chunk.
        Ok(snapshot(stopped))
    }

    pub fn get(&self, id: Uuid) -> Result<RecordingSnapshot> { Ok(snapshot(self.store.load(&id)?)) }
    pub fn track_path(&self, id: Uuid, kind: TrackKind) -> Result<PathBuf> {
        let session = self.store.load(&id)?;
        self.store.track_path(&session, kind)
    }
    pub fn list(&self) -> Result<Vec<RecordingSnapshot>> {
        let directory = self.store.root().join("sessions");
        if !directory.exists() { return Ok(vec![]); }
        let mut sessions = std::fs::read_dir(directory)?.filter_map(|entry| entry.ok()).filter_map(|entry| Uuid::parse_str(&entry.file_name().to_string_lossy()).ok()).filter_map(|id| self.store.load(&id).ok()).map(snapshot).collect::<Vec<_>>();
        sessions.sort_by(|a, b| b.session.started_at.cmp(&a.session.started_at));
        Ok(sessions)
    }
}

fn snapshot(session: LocalSession) -> RecordingSnapshot {
    let end = session.ended_at.unwrap_or_else(chrono::Utc::now);
    RecordingSnapshot { elapsed_seconds: (end - session.started_at).num_seconds().max(0), session }
}
