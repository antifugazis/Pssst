use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind { Application, Microphone }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureApplication { pub id: String, pub name: String, pub icon_hint: String, pub icon_data: Option<String>, pub available: bool }
impl CaptureApplication {
    pub fn new(id: impl Into<String>, name: impl Into<String>, icon_hint: impl Into<String>) -> Self {
        Self { id: id.into(), name: name.into(), icon_hint: icon_hint.into(), icon_data: None, available: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapturePermission { Granted, Required, Denied }

#[derive(Debug, Clone)]
pub struct CaptureRequest { pub application: CaptureApplication, pub track: TrackKind }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CaptureHandle(pub u64);
#[derive(Debug, Error)]
pub enum CaptureError { #[error("System audio permission is required")] PermissionRequired, #[error("The selected application is no longer available")] ApplicationUnavailable, #[error("Capture backend error: {0}")] Backend(String) }

pub trait CaptureBackend: Send {
    fn list_applications(&self) -> Result<Vec<CaptureApplication>, CaptureError>;
    fn permission_status(&self) -> Result<CapturePermission, CaptureError>;
    fn request_permission(&self) -> Result<CapturePermission, CaptureError>;
    fn start_capture(&mut self, request: CaptureRequest, output_path: &std::path::Path) -> Result<CaptureHandle, CaptureError>;
    fn stop_capture(&mut self, handle: CaptureHandle) -> Result<(), CaptureError>;
}

pub mod simulated;
#[cfg(target_os = "macos")]
pub mod macos;
