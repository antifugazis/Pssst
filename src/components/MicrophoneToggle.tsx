import { useT } from '../i18n';

interface MicrophoneToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export function MicrophoneToggle({ enabled, onChange }: MicrophoneToggleProps) {
  const t = useT();
  return <button aria-pressed={enabled} className="mic-toggle" onClick={() => onChange(!enabled)} type="button">
    <span aria-hidden="true" className={`mic-icon ${enabled ? 'is-on' : ''}`}><svg viewBox="0 0 24 24"><rect x="8.2" y="3.4" width="7.6" height="11.2" rx="3.8"/><path d="M5.5 11.4a6.5 6.5 0 0 0 13 0M12 17.9v2.7M8.8 20.6h6.4"/></svg></span>
    <span className="mic-copy"><strong>{t('field.mic')}</strong><small>{enabled ? t('field.mic.on') : t('field.mic.off')}</small></span>
    <span aria-hidden="true" className={`switch ${enabled ? 'is-on' : ''}`}><span /></span>
  </button>;
}
