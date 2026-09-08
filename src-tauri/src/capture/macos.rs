//! ScreenCaptureKit implementation. It deliberately owns the streams and file
//! writers on the Rust side; a webview redraw or a server outage cannot stop a
//! lecture already being written to disk.
use std::{collections::HashMap, fs::{self, File}, io::{Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::Command, sync::{Arc, Mutex}};

use screencapturekit::{cm::CMSampleBufferExt, prelude::*};

use super::{CaptureApplication, CaptureBackend, CaptureError, CaptureHandle, CapturePermission, CaptureRequest, TrackKind};

struct WavWriter { file: File, bytes: u32 }
impl WavWriter {
    fn create(path: &Path) -> Result<Self, CaptureError> { let mut writer = Self { file: File::create(path).map_err(io_error)?, bytes: 0 }; writer.write_header(0)?; Ok(writer) }
    fn append_audio(&mut self, sample: CMSampleBuffer) -> Result<(), std::io::Error> {
        let Some(buffers) = sample.audio_buffer_list() else { return Ok(()); };
        let parts = buffers.iter().map(|buffer| buffer.data()).filter(|bytes| !bytes.is_empty()).collect::<Vec<_>>();
        if parts.is_empty() { return Ok(()); }
        let result = if parts.len() == 1 { self.file.write_all(parts[0]) } else {
            let frames = parts.iter().map(|part| part.len() / 4).min().unwrap_or(0);
            for frame in 0..frames { for part in &parts { self.file.write_all(&part[frame * 4..frame * 4 + 4])?; } }
            Ok(())
        };
        if result.is_ok() { self.bytes = self.bytes.saturating_add(parts.iter().map(|part| part.len()).sum::<usize>() as u32); }
        result
    }
    fn write_header(&mut self, data_len: u32) -> Result<(), CaptureError> {
        let channels = 2u16; let rate = 48_000u32; let bits = 32u16; let byte_rate = rate * channels as u32 * bits as u32 / 8; let block_align = channels * bits / 8;
        let mut header = Vec::with_capacity(44);
        header.extend_from_slice(b"RIFF"); header.extend_from_slice(&(36u32.saturating_add(data_len)).to_le_bytes()); header.extend_from_slice(b"WAVEfmt "); header.extend_from_slice(&16u32.to_le_bytes()); header.extend_from_slice(&3u16.to_le_bytes()); header.extend_from_slice(&channels.to_le_bytes()); header.extend_from_slice(&rate.to_le_bytes()); header.extend_from_slice(&byte_rate.to_le_bytes()); header.extend_from_slice(&block_align.to_le_bytes()); header.extend_from_slice(&bits.to_le_bytes()); header.extend_from_slice(b"data"); header.extend_from_slice(&data_len.to_le_bytes());
        self.file.seek(SeekFrom::Start(0)).map_err(io_error)?; self.file.write_all(&header).map_err(io_error)?; self.file.seek(SeekFrom::End(0)).map_err(io_error)?; Ok(())
    }
    fn finish(&mut self) -> Result<(), CaptureError> { self.write_header(self.bytes)?; self.file.sync_all().map_err(io_error) }
}

struct AudioHandler { writer: Arc<Mutex<WavWriter>> }
impl SCStreamOutputTrait for AudioHandler { fn did_output_sample_buffer(&self, sample: CMSampleBuffer, _: SCStreamOutputType) { if let Ok(mut writer) = self.writer.lock() { let _ = writer.append_audio(sample); } } }
struct ActiveCapture { stream: SCStream, writer: Arc<Mutex<WavWriter>> }

pub struct MacCaptureBackend { next_handle: u64, active: HashMap<u64, ActiveCapture> }

/// Resolve the real application icon from the running app bundle. The webview
/// receives a data URL, so it can render the same icon macOS shows in Finder
/// without depending on an icon CDN or a hard-coded app list.
pub fn application_icon_data(bundle_id: &str) -> Option<String> {
    let query = format!("kMDItemCFBundleIdentifier == '{}'", bundle_id.replace('\'', "\\'"));
    let output = Command::new("/usr/bin/mdfind").arg(query).output().ok()?;
    let bundle = String::from_utf8_lossy(&output.stdout).lines().next()?.trim().to_string();
    if bundle.is_empty() { return None; }
    let resources = PathBuf::from(&bundle).join("Contents/Resources");
    let icon = fs::read_dir(resources).ok()?.filter_map(Result::ok).map(|entry| entry.path()).find(|path| path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("icns")).unwrap_or(false))?;
    let temp = std::env::temp_dir().join(format!("pssst-icon-{}.png", std::process::id()));
    let _ = Command::new("/usr/bin/sips").args(["-s", "format", "png", icon.to_str()?, "--out", temp.to_str()?]).output().ok()?;
    let bytes = fs::read(&temp).ok()?;
    let _ = fs::remove_file(&temp);
    use base64::Engine;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

impl MacCaptureBackend { pub fn new() -> Self { Self { next_handle: 1, active: HashMap::new() } } }
impl CaptureBackend for MacCaptureBackend {
    fn list_applications(&self) -> Result<Vec<CaptureApplication>, CaptureError> {
        let content = SCShareableContent::get().map_err(|error| CaptureError::Backend(format!("ScreenCaptureKit could not read running applications: {error}")))?;
        let snapshot = content.snapshot().ok_or_else(|| CaptureError::Backend("ScreenCaptureKit returned no application snapshot".into()))?;
        // Keep this response deliberately light. Icon extraction can involve
        // Spotlight and image conversion, so the UI requests it lazily after
        // the application list is already visible.
        Ok(snapshot.applications.iter().filter(|application| application.process_id > 0).map(|application| CaptureApplication { id: format!("sc-{}", application.process_id), name: application.application_name.clone(), icon_hint: application.bundle_identifier.clone(), icon_data: None, available: true }).collect())
    }
    fn permission_status(&self) -> Result<CapturePermission, CaptureError> { SCShareableContent::get().map(|_| CapturePermission::Granted).map_err(|_| CaptureError::PermissionRequired) }
    fn request_permission(&self) -> Result<CapturePermission, CaptureError> { self.permission_status() }
    fn start_capture(&mut self, request: CaptureRequest, output_path: &Path) -> Result<CaptureHandle, CaptureError> {
        let pid = request.application.id.strip_prefix("sc-").and_then(|id| id.parse::<i32>().ok()).ok_or(CaptureError::ApplicationUnavailable)?;
        let content = SCShareableContent::get().map_err(|error| CaptureError::Backend(format!("ScreenCaptureKit could not start capture: {error}")))?;
        let display = content.displays().first().cloned().ok_or_else(|| CaptureError::Backend("No active display is available".into()))?;
        let application = content.applications().iter().find(|application| application.process_id() == pid).cloned().ok_or(CaptureError::ApplicationUnavailable)?;
        let filter = SCContentFilter::create().with_display(&display).with_including_applications(&[&application], &[]).build();
        let config = SCStreamConfiguration::new().with_captures_audio(true).with_sample_rate(48_000).with_channel_count(2).with_captures_microphone(matches!(request.track, TrackKind::Microphone));
        let writer = Arc::new(Mutex::new(WavWriter::create(output_path)?)); let mut stream = SCStream::new(&filter, &config);
        let output = match request.track { TrackKind::Application => SCStreamOutputType::Audio, TrackKind::Microphone => SCStreamOutputType::Microphone };
        stream.add_output_handler(AudioHandler { writer: writer.clone() }, output).ok_or_else(|| CaptureError::Backend("Could not attach the audio output handler".into()))?;
        stream.start_capture().map_err(|error| CaptureError::Backend(error.to_string()))?;
        let handle = self.next_handle; self.next_handle += 1; self.active.insert(handle, ActiveCapture { stream, writer }); Ok(CaptureHandle(handle))
    }
    fn stop_capture(&mut self, handle: CaptureHandle) -> Result<(), CaptureError> {
        let Some(active) = self.active.remove(&handle.0) else { return Ok(()); };
        active.stream.stop_capture().map_err(|error| CaptureError::Backend(error.to_string()))?;
        let result = active.writer.lock().map_err(|_| CaptureError::Backend("Audio writer lock poisoned".into()))?.finish();
        result
    }
}
fn io_error(error: std::io::Error) -> CaptureError { CaptureError::Backend(error.to_string()) }
