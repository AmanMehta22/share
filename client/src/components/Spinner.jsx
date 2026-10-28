/**
 * Small animated indicator.
 * The spinner itself is decorative (aria-hidden); an optional label carries
 * the meaning for assistive technology.
 */
export function Spinner({ size = 'sm', label } = {}) {
  const spinner = <span className={`spinner ${size === 'lg' ? 'spinner-lg' : ''}`} aria-hidden="true" />;
  if (!label) return spinner;
  return (
    <span className="loading-row">
      {spinner}
      <span className="small muted">{label}</span>
    </span>
  );
}

/**
 * Connection/status badge.
 * @param {{label:string, tone?:'neutral'|'info'|'ok'|'warn'|'danger', pulse?:boolean}} props
 */
export function StatusPill({ label, tone = 'neutral', pulse = false }) {
  return (
    <span className={`pill pill-${tone}`}>
      <span className={`dot ${pulse ? 'dot-pulse' : ''}`} aria-hidden="true" />
      {label}
    </span>
  );
}
