import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Transfer-code helpers shared in spirit with client/src/utils/code.js.
 *
 * The server never stores raw codes: sessions are keyed by a SHA-256 hash so a
 * leaked memory dump or log line cannot reveal a working code.
 *
 * Alphabet excludes visually confusing characters: no I, L, O, 0, 1.
 * 31 symbols (~4.95 bits each), so a 16-character code carries ~79 bits of
 * entropy (requirement: >= 40 bits).
 */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GROUP_SIZE = 4;
export const GROUP_COUNT = 4;
export const MIN_GROUPS = 3;
export const MAX_GROUPS = 5;

const ALPHABET_SET = new Set(CODE_ALPHABET);
const GROUP_RE = new RegExp(`^[${CODE_ALPHABET}]{${GROUP_SIZE}}$`);

/**
 * Normalize any user input into canonical `XXXX-XXXX-XXXX-XXXX` form.
 * Accepts spaces, dots, underscores, slashes, mixed case, pasted rich text.
 * Returns '' when the input cannot be a valid code.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const compact = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (compact.length < MIN_GROUPS * GROUP_SIZE || compact.length > MAX_GROUPS * GROUP_SIZE) return '';
  if (compact.length % GROUP_SIZE !== 0) return '';
  const groups = [];
  for (let i = 0; i < compact.length; i += GROUP_SIZE) {
    groups.push(compact.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

/** True when the input is a well-formed code on the supported alphabet. */
export function isValidCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return false;
  return code.split('-').every((group) => GROUP_RE.test(group));
}

/** SHA-256 hex digest of a normalized code; used as the session lookup key. */
export function hashCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return '';
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** Short, non-reversible identifier safe for logs (first 10 hex chars of hash). */
export function logRef(codeHash) {
  return typeof codeHash === 'string' && codeHash.length >= 10 ? codeHash.slice(0, 10) : 'unknown';
}

/** True when every character of `raw` belongs to the code alphabet. */
export function hasOnlyCodeCharacters(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return [...raw.toUpperCase().replace(/[^A-Z0-9]/g, '')].every((ch) => ALPHABET_SET.has(ch));
}
