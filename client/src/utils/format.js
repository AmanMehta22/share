/** Formatting helpers for sizes, speeds and time estimates. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 -> "1.5 KB" */
export function formatBytes(bytes, { decimals } = {}) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = decimals ?? (exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return `${value.toFixed(digits)} ${UNITS[exponent]}`;
}

/** 1048576 -> "1.0 MB/s" */
export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Seconds -> "42s", "3m 05s", "1h 12m". Returns '—' when unknown. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Byte counts -> "12%"; guards divide-by-zero. */
export function formatPercent(sent, total) {
  if (!Number.isFinite(sent) || !Number.isFinite(total) || total <= 0) return '0%';
  const ratio = Math.min(1, Math.max(0, sent / total));
  return `${Math.floor(ratio * 100)}%`;
}

/** Build a {label, value} detail row with formatted bytes (used by result screens). */
export function byteDetail(label, bytes) {
  return { label, value: formatBytes(bytes) };
}

/**
 * Rolling throughput meter: weighted average over recent samples, so the
 * displayed speed is stable but reacts to real changes.
 */
export class SpeedMeter {
  constructor({ windowMs = 4000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.samples = [];
    this.lastTotal = 0;
    this.startedAt = now();
  }

  /** Record a new cumulative byte total. */
  update(totalBytes) {
    const currentTime = this.now();
    const delta = totalBytes - this.lastTotal;
    this.lastTotal = totalBytes;
    if (delta > 0) this.samples.push({ at: currentTime, delta });
    const cutoff = currentTime - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
  }

  /** Bytes per second over the retained window, or 0 before any progress. */
  value() {
    if (this.samples.length === 0) return 0;
    const bytes = this.samples.reduce((sum, sample) => sum + sample.delta, 0);
    if (bytes <= 0) return 0;
    // Span is the age of the oldest retained sample, floored to 1s so the very
    // first instant cannot produce an absurd spike.
    const spanMs = Math.max(this.now() - this.samples[0].at, 1000);
    return Math.round(bytes / (spanMs / 1000));
  }

  /** Seconds remaining for `remaining` bytes, or null when speed is unknown. */
  eta(remaining) {
    const speed = this.value();
    if (speed <= 0 || !Number.isFinite(remaining) || remaining <= 0) return null;
    return remaining / speed;
  }

  reset() {
    this.samples = [];
    this.lastTotal = 0;
    this.startedAt = this.now();
  }
}
