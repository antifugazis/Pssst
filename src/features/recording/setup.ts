import type { RecordingSetup } from './types';

export function canStartRecording(setup: RecordingSetup): boolean {
  return Boolean(setup.source?.available && setup.course.trim());
}
