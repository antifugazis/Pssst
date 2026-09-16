import { useT } from '../i18n';
import type { CaptureSource } from '../features/recording/types';

interface SourcePickerProps {
  sources: CaptureSource[];
  selected: CaptureSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (source: CaptureSource) => void;
}

function SourceMark({ source }: { source: CaptureSource }) {
  const { id } = source;
  if (source.iconData) {
    return <img aria-hidden="true" className="source-mark source-mark--native" src={source.iconData} alt="" />;
  }
  if (id === 'zoom') {
    return <span aria-hidden="true" className="source-mark source-mark--zoom"><svg viewBox="0 0 24 24"><rect x="3" y="6.5" width="11.5" height="11" rx="3" fill="white"/><path d="m16.3 10 4.2-2.2v8.4L16.3 14V10Z" fill="white"/></svg></span>;
  }
  if (id === 'chrome') {
    return <span aria-hidden="true" className="source-mark source-mark--chrome"><i/><b/><em/></span>;
  }
  return <span aria-hidden="true" className="source-mark source-mark--safari"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="white" strokeWidth="1.6"/><path d="m14.7 8.6-1.6 4.5-4.4 1.7 1.7-4.5 4.4-1.7Z" fill="white"/></svg></span>;
}

export function SourcePicker({ sources, selected, open, onOpenChange, onSelect }: SourcePickerProps) {
  const t = useT();
  const label = selected ? selected.name : t('field.source.choose');

  return <div className="field">
    <div className="field-label-row">
      <label id="source-label" className="field-label">{t('field.source')}</label>
      <span className="field-hint">{t('field.source.hint')}</span>
    </div>
    <div className="source-picker">
      <button
        aria-labelledby="source-label source-value"
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`source-trigger ${selected ? 'is-selected' : ''} ${selected && !selected.available ? 'is-unavailable' : ''}`}
        onClick={() => onOpenChange(!open)}
        type="button"
      >
        {selected ? <SourceMark source={selected} /> : <span className="source-placeholder-mark"><span /></span>}
        <span id="source-value" className="source-trigger-copy">
          <strong>{label}</strong>
          <small>{selected ? (selected.available ? selected.detail : t('field.source.gone')) : t('field.source.pick')}</small>
        </span>
        <span aria-hidden="true" className={`chevron ${open ? 'is-open' : ''}`}>⌄</span>
      </button>
      {open && <div aria-labelledby="source-label" className="source-menu" role="listbox">
        {sources.map((source) => (
          <button
            aria-selected={selected?.id === source.id}
            className={`source-option ${selected?.id === source.id ? 'is-current' : ''}`}
            key={source.id}
            onClick={() => onSelect(source)}
            role="option"
            type="button"
          >
            <SourceMark source={source} />
            <span className="source-option-copy"><strong>{source.name}</strong><small>{source.available ? source.detail : t('field.source.closed')}</small></span>
            {source.available ? <span className="source-status">{t('field.source.active')}</span> : <span className="source-status source-status--closed">{t('field.source.closedTag')}</span>}
          </button>
        ))}
      </div>}
    </div>
    {selected && !selected.available && <p className="availability-note"><span aria-hidden="true">!</span> {t('field.source.notOpen', { name: selected.name })}</p>}
  </div>;
}
