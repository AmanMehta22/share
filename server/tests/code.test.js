import { describe, it, expect } from 'vitest';
import {
  CODE_ALPHABET,
  GROUP_SIZE,
  GROUP_COUNT,
  MIN_GROUPS,
  MAX_GROUPS,
  normalizeCode,
  isValidCode,
  hashCode,
  hashesMatch,
  logRef,
  hasOnlyCodeCharacters,
} from '../src/utils/code.js';

// A code that is valid on the alphabet (no I, L, O, 0, 1 anywhere).
const VALID_CODE = 'ABCD-EFGH-JKMN-PQRS';
const VALID_COMPACT = 'ABCDEFGHJKMNPQRS';

describe('code alphabet', () => {
  it('excludes visually confusing characters', () => {
    for (const ch of ['I', 'L', 'O', '0', '1']) {
      expect(CODE_ALPHABET).not.toContain(ch);
    }
  });

  it('has 31 symbols (23 letters + 8 digits)', () => {
    expect(CODE_ALPHABET.length).toBe(31);
  });

  it('has no duplicate characters', () => {
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });

  it('carries at least 40 bits of entropy for the default 4 groups', () => {
    const bits = GROUP_SIZE * GROUP_COUNT * Math.log2(CODE_ALPHABET.length);
    expect(bits).toBeGreaterThanOrEqual(40);
  });
});

describe('normalizeCode', () => {
  it('normalizes a canonical code unchanged', () => {
    expect(normalizeCode(VALID_CODE)).toBe(VALID_CODE);
  });

  it('accepts lowercase input', () => {
    expect(normalizeCode('abcd-efgh-jkmn-pqrs')).toBe(VALID_CODE);
  });

  it('accepts compact input without dashes', () => {
    expect(normalizeCode(VALID_COMPACT)).toBe(VALID_CODE);
  });

  it('accepts spaces and dots as separators', () => {
    expect(normalizeCode('ABCD EFGH JKMN PQRS')).toBe(VALID_CODE);
    expect(normalizeCode('ABCD.EFGH.JKMN.PQRS')).toBe(VALID_CODE);
  });

  it('rejects input shorter than MIN_GROUPS * GROUP_SIZE', () => {
    expect(normalizeCode('ABCD-EFGH')).toBe('');
  });

  it('rejects input longer than MAX_GROUPS * GROUP_SIZE', () => {
    expect(normalizeCode('A'.repeat(MAX_GROUPS * GROUP_SIZE + GROUP_SIZE))).toBe('');
  });

  it('rejects a length that is not a multiple of GROUP_SIZE', () => {
    expect(normalizeCode('ABCDE-FGH')).toBe('');
    expect(normalizeCode('A'.repeat(17))).toBe('');
  });

  it('rejects non-strings', () => {
    expect(normalizeCode(null)).toBe('');
    expect(normalizeCode(undefined)).toBe('');
    expect(normalizeCode(12345)).toBe('');
    expect(normalizeCode({})).toBe('');
  });

  it('accepts 3- and 5-group codes (length flexible)', () => {
    expect(normalizeCode('A'.repeat(MIN_GROUPS * GROUP_SIZE))).toMatch(/^[A-Z-]+$/);
    expect(normalizeCode('B'.repeat(MAX_GROUPS * GROUP_SIZE))).toMatch(/^[A-Z-]+$/);
  });
});

describe('isValidCode', () => {
  it('accepts a well-formed code on the alphabet', () => {
    expect(isValidCode(VALID_CODE)).toBe(true);
  });

  it('rejects codes containing excluded characters', () => {
    expect(isValidCode('ABCD-EFGH-JKMN-PQRI')).toBe(false); // I
    expect(isValidCode('ABCD-EFGH-JKMN-PQRL')).toBe(false); // L
    expect(isValidCode('ABCD-EFGH-JKMN-PQRO')).toBe(false); // O
    expect(isValidCode('ABCD-EFGH-JKMN-PQR0')).toBe(false); // 0
    expect(isValidCode('ABCD-EFGH-JKMN-PQR1')).toBe(false); // 1
  });

  it('rejects garbage', () => {
    expect(isValidCode('')).toBe(false);
    expect(isValidCode('!!!')).toBe(false);
    expect(isValidCode('this is not a code')).toBe(false);
  });
});

describe('hashCode', () => {
  it('produces a hex sha-256 (64 chars)', () => {
    const hash = hashCode(VALID_CODE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never returns the raw code', () => {
    expect(hashCode(VALID_CODE)).not.toContain(VALID_CODE);
  });

  it('is deterministic for the same code regardless of formatting', () => {
    const a = hashCode(VALID_CODE);
    const b = hashCode('abcdefgh jkmn pqrs');
    expect(a).toBe(b);
  });

  it('differs for different codes', () => {
    expect(hashCode(VALID_CODE)).not.toBe(hashCode('ABCD-EFGH-JKMN-PQRT'));
  });

  it('returns empty string for invalid input', () => {
    expect(hashCode('')).toBe('');
    expect(hashCode(null)).toBe('');
  });
});

describe('hashesMatch', () => {
  it('matches identical hashes', () => {
    const h = hashCode(VALID_CODE);
    expect(hashesMatch(h, h)).toBe(true);
  });

  it('rejects different hashes', () => {
    expect(hashesMatch(hashCode(VALID_CODE), hashCode('ABCD-EFGH-JKMN-PQRT'))).toBe(false);
  });

  it('rejects mismatched lengths and non-strings', () => {
    expect(hashesMatch('abc', 'abcd')).toBe(false);
    expect(hashesMatch(null, null)).toBe(false);
    expect(hashesMatch('', '')).toBe(false);
  });
});

describe('logRef', () => {
  it('returns first 10 chars of a long hash', () => {
    const hash = hashCode(VALID_CODE);
    expect(logRef(hash)).toBe(hash.slice(0, 10));
  });

  it('returns "unknown" for short or non-string input', () => {
    expect(logRef('abc')).toBe('unknown');
    expect(logRef(null)).toBe('unknown');
  });
});

describe('hasOnlyCodeCharacters', () => {
  it('accepts alphabet characters with separators', () => {
    expect(hasOnlyCodeCharacters(VALID_CODE)).toBe(true);
  });

  it('rejects excluded characters', () => {
    expect(hasOnlyCodeCharacters('ILO01')).toBe(false);
  });

  it('rejects empty and non-strings', () => {
    expect(hasOnlyCodeCharacters('')).toBe(false);
    expect(hasOnlyCodeCharacters(null)).toBe(false);
  });
});
