/**
 * Tiny console logger that never prints transfer codes, SDP payloads or full
 * connection details. Session references are already hashed by callers.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function format(level, scope, message, meta) {
  const time = new Date().toISOString();
  const base = `[${time}] ${level.toUpperCase().padEnd(5)} ${scope}: ${message}`;
  if (meta === undefined) return base;
  let serialized;
  try {
    serialized = JSON.stringify(meta);
  } catch {
    serialized = '[unserializable meta]';
  }
  // Hard cap so a hostile payload cannot flood logs.
  return `${base} ${serialized.slice(0, 500)}`;
}

export function createLogger({ level = 'info', scope = 'codeshare' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, fn) => (message, meta) => {
    if (LEVELS[lvl] > threshold) return;
    fn(format(lvl, scope, message, meta));
  };
  return {
    level,
    error: write('error', console.error),
    warn: write('warn', console.warn),
    info: write('info', console.log),
    debug: write('debug', console.log),
    child: (childScope) => createLogger({ level, scope: `${scope}:${childScope}` }),
  };
}

/** Redacts anything that looks like a transfer code in free-form text. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\b[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2,4}\b/g, (match) => `${match.slice(0, 4)}-****`);
}
