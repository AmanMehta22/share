import { formatBytes, formatDuration } from '../utils/format.js';

/**
 * Real progress bar driven by actual byte counts (never faked).
 *
 * @param {{
 *   sentBytes?: number,
 *   receivedBytes?: number,
 *   totalBytes: number,
 *   speed?: number,
 *   eta?: number|null,
 *   indeterminate?: boolean,
 *   label?: string,
 *   fileName?: string|null,
 *   paused?: boolean,
 * }} props
 */
export function ProgressBar({
  sentBytes = 0,
  receivedBytes = 0,
  totalBytes = 0,
  speed = 0,
  eta = null,
  indeterminate = false,
  label = 'Progress',
  fileName = null,
  paused = false,
}) {
  const done = Math.max(sentBytes, receivedBytes);
  const total = Math.max(totalBytes, 0);
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const rounded = Math.floor(percent);

  const showIndeterminate = indeterminate && total === 0;

  return (
    <div className="progress-shell">
      <div className="progress-head">
        <span>{label}</span>
        {!showIndeterminate && (
          <span className="progress-percent">{rounded}%</span>
        )}
        {paused && <span className="pill pill-warn">Paused</span>}
      </div>

      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={showIndeterminate ? undefined : rounded}
        aria-valuetext={
          showIndeterminate
            ? 'Waiting for data'
            : `${rounded}% - ${formatBytes(done)} of ${formatBytes(total)}`
        }
        aria-label={label}
      >
        <div
          className={`progress-fill ${showIndeterminate ? 'indeterminate' : ''}`}
          style={{ width: `${showIndeterminate ? 34 : percent}%` }}
        />
      </div>

      <div className="progress-meta">
        <span>
          {formatBytes(done)}
          {total > 0 && <> of {formatBytes(total)}</>}
        </span>
        {fileName && (
          <span className="file-name" title={fileName}>
            {fileName}
          </span>
        )}
        <span>
          {speed > 0 && `${formatBytes(speed)}/s`}
          {eta !== null && speed > 0 && ` · ${formatDuration(eta)} left`}
        </span>
      </div>
    </div>
  );
}
