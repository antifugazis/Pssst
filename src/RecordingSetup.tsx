import { useMemo, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, Laptop, Mic, Mic2, Sparkles, Volume2 } from 'lucide-react';
import { canStartRecording, getSourceStatusLabel, type SourceStatus } from './captureService';

export type RecordingDetails = { sourceName: string; course: string; micEnabled: boolean };
type Source = { id: string; name: string; detail: string; status: SourceStatus; color: string; glyph: string };

const sources: Source[] = [
  { id: 'zoom', name: 'Zoom Workplace', detail: 'Video call', status: 'available', color: '#4A79E8', glyph: 'Z' },
  { id: 'chrome', name: 'Google Chrome', detail: 'Browser audio', status: 'available', color: '#E9B04C', glyph: '◉' },
  { id: 'safari', name: 'Safari', detail: 'Browser audio', status: 'unavailable', color: '#7B8FA8', glyph: '◌' },
];

function AppIcon({ source, small = false }: { source: Source; small?: boolean }) {
  return <span className={`app-icon ${small ? 'app-icon--small' : ''}`} style={{ '--app-color': source.color } as CSSProperties}><span>{source.glyph}</span></span>;
}

export default function RecordingSetup({ onStart }: { onStart: (details: RecordingDetails) => void }) {
  const [sourceId, setSourceId] = useState<string | null>('zoom');
  const [course, setCourse] = useState('Architecture des ordinateurs');
  const [micEnabled, setMicEnabled] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const selectedSource = useMemo(() => sources.find((source) => source.id === sourceId) ?? null, [sourceId]);
  const ready = canStartRecording({ sourceId: selectedSource?.status === 'available' ? sourceId : null, course });

  function start() {
    if (!ready || isStarting || !selectedSource) return;
    setIsStarting(true);
    window.setTimeout(() => onStart({ sourceName: selectedSource.name, course: course.trim(), micEnabled }), 650);
  }

  return (
    <section className="recording-tray" aria-label="Recording setup">
      <div className="tray-local-status"><span /> audio stays local</div><div className="tray-top-rule" />
      <div className="tray-list">
        <div className="tray-row"><div className="tray-row-mark tray-row-mark--audio"><Volume2 size={18} /></div><div className="tray-row-label"><strong>CLASS AUDIO</strong><small>Capture sound from</small></div><div className={`source-control ${pickerOpen ? 'source-control--open' : ''}`}>
          <button id="source-button" className="source-button" onClick={() => setPickerOpen((open) => !open)} aria-expanded={pickerOpen}>{selectedSource ? <AppIcon source={selectedSource} /> : <span className="source-placeholder-icon"><Volume2 size={17} /></span>}<span className="source-copy"><strong>{selectedSource?.name ?? 'Choose an application'}</strong><small>{selectedSource?.detail ?? 'Application audio'}</small></span><ChevronDown className={pickerOpen ? 'chevron chevron--up' : 'chevron'} size={18} /></button>
          {selectedSource && <div className={`source-status source-status--${selectedSource.status}`}><span /> {getSourceStatusLabel(selectedSource.status)}</div>}
          {pickerOpen && <div className="source-menu"><div className="source-menu-head"><span>Applications</span><span className="source-menu-count">{sources.filter((source) => source.status === 'available').length} available</span></div>{sources.map((source) => <button key={source.id} className={`source-option ${sourceId === source.id ? 'source-option--selected' : ''} ${source.status === 'unavailable' ? 'source-option--unavailable' : ''}`} onClick={() => { setSourceId(source.id); setPickerOpen(false); }}><AppIcon source={source} small /><span className="source-option-copy"><strong>{source.name}</strong><small>{source.detail}</small></span>{source.status === 'available' ? (sourceId === source.id ? <Check size={16} /> : <span className="option-available" />) : <small className="option-closed">Closed</small>}</button>)}<div className="source-menu-foot"><Laptop size={14} /> Only apps currently playing audio appear here.</div></div>}
        </div></div>
        <div className="tray-row"><div className="tray-row-mark tray-row-mark--class"><Sparkles size={18} strokeWidth={1.8} /></div><div className="tray-row-label"><strong>CLASS NAME</strong><small>Keep your notes together</small></div><div className="tray-input"><input id="course" aria-label="Class name" value={course} onChange={(event) => setCourse(event.target.value)} placeholder="Name your class" /></div></div>
      </div>
      <div className="tray-footer"><button className={`mic-choice ${micEnabled ? 'mic-choice--on' : ''}`} onClick={() => setMicEnabled((enabled) => !enabled)} role="switch" aria-checked={micEnabled}><span className="mic-choice-icon"><Mic2 size={17} /></span><span><strong>My microphone</strong><small>{micEnabled ? 'Included in this recording' : 'Not included'}</small></span><span className="mic-choice-check">{micEnabled ? <Check size={14} /> : null}</span></button><button className={`record-button ${!ready ? 'record-button--disabled' : ''} ${isStarting ? 'record-button--starting' : ''}`} disabled={!ready || isStarting} onClick={start}><span className="record-button-icon">{isStarting ? <span className="loader" /> : <Mic size={19} strokeWidth={2.1} />}</span><span>{isStarting ? 'Preparing your recording…' : 'Start recording'}</span></button></div>
      {!ready && <p className="form-hint">Choose a running application and name your class to begin.</p>}
    </section>
  );
}
