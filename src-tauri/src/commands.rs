use std::{path::PathBuf, sync::Mutex};

use tauri::State;
use uuid::Uuid;

use crate::{capture::{CaptureApplication, CaptureBackend, CaptureError, CapturePermission}, recording::{RecordingService, RecordingSnapshot, StartRecordingRequest}};

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
    match backend.list_applications() {
        Ok(applications) => Ok(applications),
        Err(CaptureError::PermissionRequired) => Err(CaptureError::PermissionRequired.to_string()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn capture_application_icon(bundle_id: String) -> Option<String> {
    #[cfg(target_os = "macos")]
    { crate::capture::macos::application_icon_data(&bundle_id) }
    #[cfg(not(target_os = "macos"))]
    { let _ = bundle_id; None }
}

#[tauri::command]
pub fn capture_permission_status() -> Result<CapturePermission, String> {
    #[cfg(target_os = "macos")]
    {
        // Core Audio owns the actual capture path. Do not use a CoreGraphics
        // or ScreenCaptureKit preflight here: those APIs request screen access
        // and would make an audio-only recording look like screen sharing.
        return crate::capture::macos::MacCaptureBackend::new()
            .permission_status()
            .map_err(|error| error.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    let backend = crate::capture::simulated::SimulatedCaptureBackend::default();
    #[cfg(not(target_os = "macos"))]
    {
        backend.permission_status().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string()) }
    #[cfg(not(target_os = "macos"))]
    { Err("System audio permissions are managed by your operating system.".into()) }
}

/// Only the explicit first-run action may show the macOS permission prompt.
/// Opening System Settings must never generate the prompt again.
#[tauri::command]
pub fn request_screen_recording_access() -> Result<CapturePermission, String> {
    #[cfg(target_os = "macos")]
    {
        let backend = crate::capture::macos::MacCaptureBackend::new();
        if let Ok(CapturePermission::Granted) = backend.permission_status() {
            return Ok(CapturePermission::Granted);
        }
        backend.permission_status().map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    { Ok(CapturePermission::Granted) }
}

#[tauri::command]
pub fn validate_server_link(controller: State<'_, RecordingController>, link: String) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(&link).send().map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Server returned HTTP {}", status.as_u16()));
    }
    let payload = response.json::<serde_json::Value>().map_err(|error| error.to_string())?;
    if payload.pointer("/capabilities/faster_whisper") != Some(&serde_json::Value::Bool(true)) {
        return Err("This is not a Pssst Whisper server".into());
    }
    if let Ok(service) = controller.0.lock() {
        let config_path = service.store().root().join("server-connection.txt");
        let _ = std::fs::write(config_path, &link);
    }
    std::env::set_var("PSSST_CONNECTION_LINK", &link);
    Ok(payload)
}

#[tauri::command]
pub fn save_openrouter_config(controller: State<'_, RecordingController>, api_key: String, model: String) -> Result<(), String> {
    if let Ok(service) = controller.0.lock() {
        let path = service.store().root().join("openrouter-config.json");
        let payload = serde_json::json!({ "api_key": api_key.trim(), "model": model.trim() });
        std::fs::write(path, payload.to_string()).map_err(|e| e.to_string())?;
    }
    Ok(())
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

#[tauri::command]
pub fn correct_session(controller: State<'_, RecordingController>, session_id: String) -> Result<(), String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "Invalid recording session id".to_string())?;
    let store = {
        let service = controller.0.lock().map_err(|_| "The recording service is unavailable".to_string())?;
        service.store().clone()
    };
    // Spawns correction on a background thread so the UI stays 100% responsive
    // and can stream progress chunks live without beachballing.
    crate::recording::spawn_correction(store, id).map_err(|e| e.to_string())
}
