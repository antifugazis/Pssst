//! macOS audio-only capture using Core Audio process taps.
use std::{collections::HashMap, fs, path::{Path, PathBuf}, process::Command};
use serde::Deserialize;
use super::{CaptureApplication, CaptureBackend, CaptureError, CaptureHandle, CapturePermission, CaptureRequest, TrackKind};

#[link(name = "pssst_core_audio_tap", kind = "static")]
extern "C" {
    fn pssst_audio_start(pid: i32, path: *const std::ffi::c_char, handle: *mut u64, error: *mut std::ffi::c_char, error_length: usize) -> i32;
    fn pssst_audio_stop(handle: u64, error: *mut std::ffi::c_char, error_length: usize) -> i32;
    fn pssst_audio_permission_probe(error: *mut std::ffi::c_char, error_length: usize) -> i32;
    fn pssst_audio_list_applications(buffer: *mut std::ffi::c_char, length: usize) -> i32;
}

pub struct MacCaptureBackend { next_handle: u64, active: HashMap<u64, u64> }

pub fn application_icon_data(bundle_id: &str) -> Option<String> {
    let query = format!("kMDItemCFBundleIdentifier == '{}'", bundle_id.replace('\'', "\\'"));
    let output = Command::new("/usr/bin/mdfind").arg(query).output().ok()?;
    let bundle = String::from_utf8_lossy(&output.stdout).lines().next()?.trim().to_string();
    if bundle.is_empty() { return None; }
    let resources = PathBuf::from(&bundle).join("Contents/Resources");
    let icon = fs::read_dir(resources).ok()?.filter_map(Result::ok).map(|entry| entry.path()).find(|path| path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("icns")).unwrap_or(false))?;
    let temp = std::env::temp_dir().join(format!("pssst-icon-{}.png", std::process::id()));
    let _ = Command::new("/usr/bin/sips").args(["-s", "format", "png", icon.to_str()?, "--out", temp.to_str()?]).output().ok()?;
    let bytes = fs::read(&temp).ok()?; let _ = fs::remove_file(&temp);
    use base64::Engine;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

fn audio_error(buffer: &[std::ffi::c_char]) -> String {
    let bytes = buffer.iter().take_while(|byte| **byte != 0).map(|byte| *byte as u8).collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).into_owned()
}

impl MacCaptureBackend { pub fn new() -> Self { Self { next_handle: 1, active: HashMap::new() } } }

#[derive(Deserialize)]
struct RunningApplication { pid: i32, name: String, bundle_id: String }

impl CaptureBackend for MacCaptureBackend {
    fn list_applications(&self) -> Result<Vec<CaptureApplication>, CaptureError> {
        let mut buffer = vec![0 as std::ffi::c_char; 64 * 1024];
        if unsafe { pssst_audio_list_applications(buffer.as_mut_ptr(), buffer.len()) } != 0 {
            return Err(CaptureError::Backend("Could not read the macOS running-application list".into()));
        }
        let applications: Vec<RunningApplication> = serde_json::from_slice(&buffer.iter().take_while(|byte| **byte != 0).map(|byte| *byte as u8).collect::<Vec<_>>())
            .map_err(|error| CaptureError::Backend(format!("Could not decode the macOS running-application list: {error}")))?;
        let mut apps = applications.into_iter()
            .filter(|application| application.pid > 0)
            .map(|application| CaptureApplication { id: format!("audio-{}", application.pid), name: application.name, icon_hint: application.bundle_id, icon_data: None, available: true })
            .collect::<Vec<_>>();
        apps.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        eprintln!("Pssst capture picker: {} regular apps: {}", apps.len(), apps.iter().map(|app| app.name.as_str()).collect::<Vec<_>>().join(", "));
        Ok(apps)
    }

    fn permission_status(&self) -> Result<CapturePermission, CaptureError> {
        let mut error = vec![0 as std::ffi::c_char; 256];
        let status = unsafe { pssst_audio_permission_probe(error.as_mut_ptr(), error.len()) };
        if status == 0 { Ok(CapturePermission::Granted) } else { Err(CaptureError::Backend(format!("Core Audio permission probe failed: {}", audio_error(&error)))) }
    }
    fn request_permission(&self) -> Result<CapturePermission, CaptureError> { self.permission_status() }

    fn start_capture(&mut self, request: CaptureRequest, output_path: &Path) -> Result<CaptureHandle, CaptureError> {
        let pid = match request.track {
            TrackKind::Application => request.application.id.strip_prefix("audio-").and_then(|value| value.parse::<i32>().ok()).ok_or(CaptureError::ApplicationUnavailable)?,
            TrackKind::Microphone => -1,
        };
        let path = std::ffi::CString::new(output_path.to_string_lossy().as_bytes()).map_err(|_| CaptureError::Backend("Audio path contains an invalid character".into()))?;
        let mut native_handle = 0u64; let mut error = vec![0 as std::ffi::c_char; 512];
        let status = unsafe { pssst_audio_start(pid, path.as_ptr(), &mut native_handle, error.as_mut_ptr(), error.len()) };
        if status != 0 { return Err(CaptureError::Backend(audio_error(&error))); }
        let handle = self.next_handle; self.next_handle += 1; self.active.insert(handle, native_handle);
        Ok(CaptureHandle(handle))
    }

    fn stop_capture(&mut self, handle: CaptureHandle) -> Result<(), CaptureError> {
        let Some(native_handle) = self.active.remove(&handle.0) else { return Ok(()); };
        let mut error = vec![0 as std::ffi::c_char; 256];
        let status = unsafe { pssst_audio_stop(native_handle, error.as_mut_ptr(), error.len()) };
        if status != 0 { Err(CaptureError::Backend(audio_error(&error))) } else { Ok(()) }
    }
}
