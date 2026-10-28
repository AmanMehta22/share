/**
 * Transfer-code generation and normalization.
 *
 * Alphabet: 31 symbols with no I/L/O/0/1, so codes are easy to read aloud and
 * free of visual ambiguity (23 letters + 8 digits).
 *
 * 16 characters x log2(31) ~ 4.95 bits = ~79 bits of entropy
 * (requirement: >= 40 bits).
 * Randomness comes exclusively from the browser Web Crypto API -
 * never Math.random(), timestamps or sequential identifiers.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GROUP_SIZE = 4;
export const GROUP_COUNT = 4;
export const MIN_GROUPS = 3;
export const MAX_GROUPS = 5;

const ALPHABET_SET = new Set(CODE_ALPHABET);
const GROUP_RE = new RegExp(`^[${CODE_ALPHABET}]{${GROUP_SIZE}}$`);
// Rejection sampling: 248 = 8 * 31, so bytes 0-247 map onto the 31-symbol
// alphabet uniformly; bytes 248-255 are discarded to avoid modulo bias.
const UNBIASED_UPPER = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;

/**
 * Generate a cryptographically secure `XXXX-XXXX-XXXX-XXXX` code.
 *
 * @param {{cryptoImpl?: Crypto, groups?: number}} [options]
 */
export function generateTransferCode(options = {}) {
  const cryptoImpl = options.cryptoImpl ?? globalThis.crypto;
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== 'function') {
    throw new Error('Web Crypto API is unavailable in this browser.');
  }
  const groupCount = options.groups ?? GROUP_COUNT;
  const totalChars = groupCount * GROUP_SIZE;
  const chars = [];
  // Rejection sampling keeps the distribution uniform over the 31 symbols.
  while (chars.length < totalChars) {
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(totalChars));
    for (const byte of bytes) {
      if (byte >= UNBIASED_UPPER) continue;
      chars.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
      if (chars.length === totalChars) break;
    }
  }
  const groups = [];
  for (let i = 0; i < chars.length; i += GROUP_SIZE) {
    groups.push(chars.slice(i, i + GROUP_SIZE).join(''));
  }
  return groups.join('-');
}

/**
 * Normalize user input to canonical form.
 * Handles spaces, dots, underscores, slashes, lowercase and pasted formatting.
 * Returns '' when the input cannot be a valid code.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length < MIN_GROUPS * GROUP_SIZE || compact.length > MAX_GROUPS * GROUP_SIZE) return '';
  if (compact.length % GROUP_SIZE !== 0) return '';
  const groups = [];
  for (let i = 0; i < compact.length; i += GROUP_SIZE) {
    groups.push(compact.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

/** True when input normalizes to a well-formed code on our alphabet. */
export function isValidCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return false;
  return code.split('-').every((group) => GROUP_RE.test(group));
}

/** Human-readable validation error, or null when the code is acceptable. */
export function validateCodeInput(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return 'Enter the transfer code you received from the sender.';
  }
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length < MIN_GROUPS * GROUP_SIZE) return 'The code is too short.';
  if (compact.length > MAX_GROUPS * GROUP_SIZE) return 'The code is too long.';
  if (compact.length % GROUP_SIZE !== 0) {
    return `A code has ${MIN_GROUPS}-${MAX_GROUPS} groups of ${GROUP_SIZE} characters.`;
  }
  const invalid = [...compact].find((ch) => !ALPHABET_SET.has(ch));
  if (invalid) {
    return `The code contains an unsupported character ("${invalid}"). Check for typos - the code never uses I, L, O, 0 or 1.`;
  }
  return null;
}

/** Split into groups for display. */
export function codeGroups(code) {
  return typeof code === 'string' && code.length > 0 ? code.split('-') : [];
}

/** Partially masked form for logs or diagnostics (never a full code). */
export function maskCode(code) {
  const groups = codeGroups(code);
  if (groups.length === 0) return '****';
  return `${groups[0]}-****`;
}
