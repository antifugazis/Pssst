import { invoke, isTauri as detectTauriRuntime } from '@tauri-apps/api/core';

export type NativeApplication = { id: string; name: string; icon_hint: string; icon_data?: string | null; available: boolean };
export type CapturePermission = 'granted' | 'required' | 'denied';
export type Track = { kind: 'application' | 'microphone'; relative_path: string; bytes_written: number; processing_state: string };
export type TranscriptSegment = { backend_id: string; start_ms: number; end_ms: number; raw_text: string; corrected_text: string | null; final_text: string | null };
export type LocalSession = { id: string; course: string; started_at: string; ended_at: string | null; recording_state: string; selected_application: NativeApplication; microphone_included: boolean; tracks: Track[]; transcription_state: string; correction_state: string; last_error: string | null; transcript_segments: TranscriptSegment[] };
export type RecordingSnapshot = { session: LocalSession; elapsed_seconds: number };
export type ServerCapabilities = { capabilities: { faster_whisper: boolean; whisper_model: string; quality: string; languages: string[]; compute: string } };
// Tauri v2 exposes a supported `isTauri` marker. Its private bridge object is
// intentionally not a reliable environment check in packaged webviews.
export const isTauri = () => detectTauriRuntime();
export const native = {
  applications: () => invoke<NativeApplication[]>('list_capture_applications'),
  applicationIcon: (bundleId: string) => invoke<string | null>('capture_application_icon', { bundleId }),
  capturePermissionStatus: () => invoke<CapturePermission>('capture_permission_status'),
  openScreenRecordingSettings: () => invoke<void>('open_screen_recording_settings'),
  requestScreenRecordingAccess: () => invoke<CapturePermission>('request_screen_recording_access'),
  validateServerLink: (link: string) => invoke<ServerCapabilities>('validate_server_link', { link }),
  start: (course: string, application: NativeApplication, include_microphone: boolean) => invoke<RecordingSnapshot>('start_recording', { request: { course, application, include_microphone } }),
  stop: (sessionId: string) => invoke<RecordingSnapshot>('stop_recording', { sessionId }),
  list: () => invoke<RecordingSnapshot[]>('list_recording_sessions'),
  get: (sessionId: string) => invoke<RecordingSnapshot>('get_recording_session', { sessionId }),
  saveOpenRouterConfig: (apiKey: string, model: string) => invoke<void>('save_openrouter_config', { apiKey, model }),
  correctSession: (sessionId: string) => invoke<void>('correct_session', { sessionId }),
};

/**
 * Prompt from Pssst itself before sending someone to Settings. This is what
 * creates the TCC entry for the currently-installed signed app.
 */
export async function requestCapturePermission(): Promise<boolean> {
  const permission = await native.requestScreenRecordingAccess();
  if (permission === 'granted') return true;
  await native.openScreenRecordingSettings();
  return false;
}
