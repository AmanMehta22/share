import { CheckCircle2, XCircle, Ban, RotateCcw } from 'lucide-react';

const TONES = {
  success: { cls: 'ok', Icon: CheckCircle2 },
  error: { cls: 'bad', Icon: XCircle },
  cancelled: { cls: 'warn', Icon: Ban },
};

/**
 * Final screen for a completed, failed or cancelled transfer.
 *
 * Never claims success the engine did not confirm: `status` must come from
 * the transfer engine's own result.
 */
export function ResultScreen({ status = 'success', title, message, details = [], tips = [], onRestart, restartLabel = 'Start another transfer' }) {
  const tone = TONES[status] ?? TONES.success;
  const { Icon } = tone;

  return (
    <div className="stack stack-4 center">
      <div>
        <div className={`result-badge ${tone.cls}`}>
          <Icon size={36} aria-hidden="true" />
        </div>
        <h2>{title}</h2>
        {message && (
          <p className="muted" style={{ marginTop: 8 }}>
            {message}
          </p>
        )}
      </div>

      {details.length > 0 && (
        <dl className="kv" style={{ justifyContent: 'center' }}>
          {details.map((detail) => (
            <div key={detail.label} style={{ display: 'contents' }}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {tips.length > 0 && (
        <ul className="tips">
          {tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      )}

      {onRestart && (
        <div className="btn-group" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn btn-primary btn-lg" onClick={onRestart}>
            <RotateCcw size={17} aria-hidden="true" />
            {restartLabel}
          </button>
        </div>
      )}
    </div>
  );
}
