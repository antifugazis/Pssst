use std::{collections::HashMap, fs::OpenOptions, io::Write, path::Path};
use super::{CaptureApplication, CaptureBackend, CaptureError, CaptureHandle, CapturePermission, CaptureRequest};

pub struct SimulatedCaptureBackend { next_handle: u64, open: HashMap<CaptureHandle, std::fs::File> }
impl Default for SimulatedCaptureBackend { fn default() -> Self { Self { next_handle: 1, open: HashMap::new() } } }
impl CaptureBackend for SimulatedCaptureBackend {
    fn list_applications(&self) -> Result<Vec<CaptureApplication>, CaptureError> { Ok(vec![CaptureApplication::new("zoom-development", "Zoom Workplace", "zoom"), CaptureApplication::new("chrome-development", "Google Chrome", "chrome")]) }
    fn permission_status(&self) -> Result<CapturePermission, CaptureError> { Ok(CapturePermission::Granted) }
    fn request_permission(&self) -> Result<CapturePermission, CaptureError> { Ok(CapturePermission::Granted) }
    fn start_capture(&mut self, request: CaptureRequest, output_path: &Path) -> Result<CaptureHandle, CaptureError> {
        let mut file = OpenOptions::new().create(true).append(true).open(output_path).map_err(|e| CaptureError::Backend(e.to_string()))?;
        writeln!(file, "pssst-test-track:{:?}:{}", request.track, request.application.id).map_err(|e| CaptureError::Backend(e.to_string()))?;
        file.sync_all().map_err(|e| CaptureError::Backend(e.to_string()))?;
        let handle = CaptureHandle(self.next_handle); self.next_handle += 1; self.open.insert(handle, file); Ok(handle)
    }
    fn stop_capture(&mut self, handle: CaptureHandle) -> Result<(), CaptureError> { self.open.remove(&handle).ok_or_else(|| CaptureError::Backend("unknown capture handle".into()))?.sync_all().map_err(|e| CaptureError::Backend(e.to_string())) }
}
