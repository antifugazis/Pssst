import { invoke } from '@tauri-apps/api/core';

export type NativeApplication = { id: string; name: string; icon_hint: string; available: boolean };
export type Track = { kind: 'application' | 'microphone'; relative_path: string; bytes_written: number; processing_state: string };
export type TranscriptSegment = { backend_id: string; start_ms: number; end_ms: number; raw_text: string; corrected_text: string | null; final_text: string | null };
export type LocalSession = { id: string; course: string; started_at: string; ended_at: string | null; recording_state: string; selected_application: NativeApplication; microphone_included: boolean; tracks: Track[]; transcription_state: string; correction_state: string; last_error: string | null; transcript_segments: TranscriptSegment[] };
export type RecordingSnapshot = { session: LocalSession; elapsed_seconds: number };
export type ServerCapabilities = { capabilities: { faster_whisper: boolean; whisper_model: string; quality: string; languages: string[]; compute: string } };
export const isTauri = () => '__TAURI_INTERNALS__' in window;
export const native = {
  applications: () => invoke<NativeApplication[]>('list_capture_applications'),
  openScreenRecordingSettings: () => invoke<void>('open_screen_recording_settings'),
  validateServerLink: (link: string) => invoke<ServerCapabilities>('validate_server_link', { link }),
  start: (course: string, application: NativeApplication, include_microphone: boolean) => invoke<RecordingSnapshot>('start_recording', { request: { course, application, include_microphone } }),
  stop: (sessionId: string) => invoke<RecordingSnapshot>('stop_recording', { sessionId }),
  list: () => invoke<RecordingSnapshot[]>('list_recording_sessions'),
  get: (sessionId: string) => invoke<RecordingSnapshot>('get_recording_session', { sessionId }),
};
