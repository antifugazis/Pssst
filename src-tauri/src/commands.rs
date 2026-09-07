use std::{path::PathBuf, sync::Mutex};

use tauri::State;
use uuid::Uuid;

use crate::{capture::{CaptureApplication, CaptureBackend, CapturePermission}, recording::{RecordingService, RecordingSnapshot, StartRecordingRequest}};

#[cfg(target_os = "macos")]
type PlatformCaptureBackend = crate::capture::macos::MacCaptureBackend;
#[cfg(not(target_os = "macos"))]
type PlatformCaptureBackend = crate::capture::simulated::SimulatedCaptureBackend;

pub struct RecordingController(pub Mutex<RecordingService<PlatformCaptureBackend>>);

impl RecordingController {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        let backend = crate::capture::macos::MacCaptureBackend::new();
        #[cfg(not(target_os = "macos"))]
        let backend = crate::capture::simulated::SimulatedCaptureBackend::default();
        RecordingService::new(root, backend).map(|service| Self(Mutex::new(service))).map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn list_capture_applications() -> Result<Vec<CaptureApplication>, String> {
    #[cfg(target_os = "macos")]
    let backend = crate::capture::macos::MacCaptureBackend::new();
    #[cfg(not(target_os = "macos"))]
    let backend = crate::capture::simulated::SimulatedCaptureBackend::default();
    backend.list_applications().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn capture_permission_status() -> Result<CapturePermission, String> {
    #[cfg(target_os = "macos")]
    let backend = crate::capture::macos::MacCaptureBackend::new();
    #[cfg(not(target_os = "macos"))]
    let backend = crate::capture::simulated::SimulatedCaptureBackend::default();
    backend.permission_status().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string()) }
    #[cfg(not(target_os = "macos"))]
    { Err("Screen Recording permissions are managed by your operating system.".into()) }
}

#[tauri::command]
pub fn start_recording(controller: State<'_, RecordingController>, request: StartRecordingRequest) -> Result<RecordingSnapshot, String> {
    controller.0.lock().map_err(|_| "The recording service is unavailable".to_string())?.start(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stop_recording(controller: State<'_, RecordingController>, session_id: String) -> Result<RecordingSnapshot, String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "Invalid recording session id".to_string())?;
    controller.0.lock().map_err(|_| "The recording service is unavailable".to_string())?.stop(id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_recording_session(controller: State<'_, RecordingController>, session_id: String) -> Result<RecordingSnapshot, String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "Invalid recording session id".to_string())?;
    controller.0.lock().map_err(|_| "The recording service is unavailable".to_string())?.get(id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_recording_sessions(controller: State<'_, RecordingController>) -> Result<Vec<RecordingSnapshot>, String> {
    controller.0.lock().map_err(|_| "The recording service is unavailable".to_string())?.list().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn recording_track_path(controller: State<'_, RecordingController>, session_id: String, track: crate::capture::TrackKind) -> Result<String, String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "Invalid recording session id".to_string())?;
    controller.0.lock().map_err(|_| "The recording service is unavailable".to_string())?.track_path(id, track).map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
}
