export type SourceStatus = 'available' | 'unavailable';

export function canStartRecording({ sourceId, course }: { sourceId: string | null; course: string }): boolean {
  return Boolean(sourceId && course.trim());
}

export function getSourceStatusLabel(status: SourceStatus): string {
  return status === 'available' ? 'Ready' : 'Closed';
}
