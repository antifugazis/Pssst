export type SourceKind = string;

export interface CaptureSource {
  id: SourceKind;
  name: string;
  detail: string;
  available: boolean;
  iconData?: string | null;
}

export interface RecordingSetup {
  source: Pick<CaptureSource, 'id' | 'available'> | null;
  course: string;
}
