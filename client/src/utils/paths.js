/**
 * Path safety for received manifests.
 *
 * Every path arriving from a peer is treated as hostile input:
 *  - no absolute paths, drive letters or UNC prefixes
 *  - no "." or ".." segments (path traversal)
 *  - no control characters or NUL bytes
 *  - Windows-illegal characters and reserved device names are neutralized
 *  - depth and length are capped
 *
 * Sanitization is deterministic, so both sides can reason about the result.
 */

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 200;
export const MAX_DEPTH = 32;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ILLEGAL = /[<>:"|?*]/g;
// eslint-disable-next-line no-control-regex -- stripping control chars from paths is exactly the point
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** @typedef {{ok:true, path:string} | {ok:false, reason:string}} PathResult */

/**
 * Sanitize a single path segment (file or directory name).
 * @returns {string|null} null when the segment cannot be made safe
 */
export function sanitizeSegment(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.replace(/[\\/]/g, '').replace(CONTROL, '').replace(ILLEGAL, '_');
  // Windows rejects trailing dots and spaces.
  value = value.replace(/[. ]+$/g, '');
  if (value === '' || value === '.' || value === '..') return null;
  if (WINDOWS_RESERVED.test(value.split('.')[0])) value = `_${value}`;
  if (value.length > MAX_SEGMENT_LENGTH) {
    value = value.slice(0, MAX_SEGMENT_LENGTH);
    // Never leave a dangling surrogate pair from slicing.
    value = value.replace(/[\uD800-\uDBFF]$/, '');
    value = value.replace(/[. ]+$/g, '');
    if (value === '') return null;
  }
  return value;
}

/**
 * Validate and normalize a relative path from a manifest entry.
 * @param {unknown} raw
 * @returns {PathResult}
 */
export function sanitizeRelativePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'Path is missing.' };
  }
  if (raw.length > MAX_PATH_LENGTH * 4) {
    return { ok: false, reason: 'Path is too long.' };
  }
  if (raw.includes('\u0000')) {
    return { ok: false, reason: 'Path contains a NUL byte.' };
  }

  // Treat backslashes as separators (Windows senders) but reject escapes.
  const unified = raw.replace(/\\/g, '/');

  if (unified.startsWith('/')) return { ok: false, reason: 'Path must be relative.' };
  if (/^[a-zA-Z]:/.test(unified)) return { ok: false, reason: 'Drive letters are not allowed.' };
  if (unified.startsWith('//')) return { ok: false, reason: 'Network paths are not allowed.' };

  const rawSegments = unified.split('/');
  if (rawSegments.length > MAX_DEPTH + 1) return { ok: false, reason: 'Folder depth is too deep.' };

  const safeSegments = [];
  for (const segment of rawSegments) {
    if (segment === '' || segment === '.') continue; // collapse duplicate separators
    if (segment === '..') {
      return { ok: false, reason: 'Path contains an illegal ".." segment.' };
    }
    const safe = sanitizeSegment(segment);
    if (safe === null) return { ok: false, reason: 'Path contains an unsafe file name.' };
    safeSegments.push(safe);
  }

  if (safeSegments.length === 0) return { ok: false, reason: 'Path is empty after validation.' };

  const path = safeSegments.join('/');
  if (path.length > MAX_PATH_LENGTH) return { ok: false, reason: 'Path is too long.' };
  return { ok: true, path };
}

/** Convenience boolean check. */
export function isPathSafe(raw) {
  return sanitizeRelativePath(raw).ok === true;
}

/**
 * Make a list of paths unique without changing their meaning.
 * Collisions happen when two different hostile names sanitize identically.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function dedupePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const path of paths) {
    let candidate = path;
    let attempt = 1;
    while (seen.has(candidate)) {
      attempt += 1;
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash + 1);
      const file = slash === -1 ? path : path.slice(slash + 1);
      const dot = file.lastIndexOf('.');
      const base = dot > 0 ? file.slice(0, dot) : file;
      const ext = dot > 0 ? file.slice(dot) : '';
      candidate = `${dir}${base}~${attempt}${ext}`;
      if (attempt > 10_000) break;
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

/** Filename safe for `<a download>` and for ZIP entries. */
export function sanitizeDownloadName(raw, fallback = 'download') {
  const text = typeof raw === 'string' ? raw : '';
  // Keep only the final path component; callers may pass a full relative path.
  const base = text.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const segment = sanitizeSegment(base);
  if (segment === null) return fallback;
  return segment;
}

/** Total byte size of a manifest, guarded against overflow. */
export function sumSizes(entries) {
  let total = 0;
  for (const entry of entries) {
    const size = Number(entry && entry.size);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    total += size;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}
