import { describe, it, expect } from 'vitest';
import {
  CODE_ALPHABET,
  GROUP_SIZE,
  GROUP_COUNT,
  generateTransferCode,
  normalizeCode,
  isValidCode,
  validateCodeInput,
  codeGroups,
  maskCode,
} from '../src/utils/code.js';

// Valid test codes: no I, L, O, 0 or 1 anywhere (excluded from the alphabet).
const VALID_CODE = 'ABCD-EFGH-JKMN-PQRS';
const VALID_COMPACT = 'ABCDEFGHJKMNPQRS';

describe('generateTransferCode', () => {
  it('produces a 4-group code of the right shape', () => {
    const code = generateTransferCode();
    const groups = code.split('-');
    expect(groups).toHaveLength(GROUP_COUNT);
    for (const group of groups) {
      expect(group).toHaveLength(GROUP_SIZE);
      for (const ch of group) expect(CODE_ALPHABET).toContain(ch);
    }
  });

  it('is valid according to isValidCode', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isValidCode(generateTransferCode())).toBe(true);
    }
  });

  it('never contains excluded characters', () => {
    for (let i = 0; i < 100; i += 1) {
      const code = generateTransferCode();
      for (const ch of ['I', 'L', 'O', '0', '1']) {
        expect(code).not.toContain(ch);
      }
    }
  });

  it('produces different codes on each call', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(generateTransferCode());
    // ~79 bits of entropy: collisions in 200 draws are astronomically unlikely.
    expect(seen.size).toBeGreaterThan(195);
  });

  it('accepts a custom group count', () => {
    const code = generateTransferCode({ groups: 5 });
    expect(code.split('-')).toHaveLength(5);
    expect(isValidCode(code)).toBe(true);
  });

  it('uses every symbol in the alphabet over many draws (uniform sampling)', () => {
    const seenChars = new Set();
    for (let i = 0; i < 500; i += 1) {
      for (const ch of generateTransferCode()) {
        if (CODE_ALPHABET.includes(ch)) seenChars.add(ch);
      }
    }
    // 500 codes = 2000 symbols; with 31 symbols, missing any is ~0.4% likely.
    expect(seenChars.size).toBe(CODE_ALPHABET.length);
  });

  it('throws when Web Crypto is unavailable', () => {
    expect(() => generateTransferCode({ cryptoImpl: {} })).toThrow();
  });
});

describe('normalizeCode', () => {
  it('canonicalizes mixed formats', () => {
    expect(normalizeCode('abcd-efgh jkmn.pqrs')).toBe(VALID_CODE);
    expect(normalizeCode(VALID_COMPACT)).toBe(VALID_CODE);
  });

  it('returns empty for impossible input', () => {
    expect(normalizeCode('')).toBe('');
    expect(normalizeCode('AB')).toBe('');
    expect(normalizeCode(null)).toBe('');
  });
});

describe('validateCodeInput', () => {
  it('returns null (no message) for a valid code', () => {
    expect(validateCodeInput(VALID_CODE)).toBeNull();
    expect(validateCodeInput(VALID_COMPACT)).toBeNull();
  });

  it('returns a message for an empty input', () => {
    expect(validateCodeInput('')).toBeTruthy();
  });

  it('returns a message for the wrong length', () => {
    expect(validateCodeInput('ABCD-EFGH')).toBeTruthy();
    expect(validateCodeInput('A'.repeat(21))).toBeTruthy();
  });

  it('returns a message when excluded characters are present', () => {
    expect(validateCodeInput('ABCD-EFGH-JKMN-PQRI')).toBeTruthy();
  });

  it('hints about excluded characters in the message', () => {
    const message = validateCodeInput('ABCD-EFGH-JKMN-PQRO');
    expect(message).toMatch(/I|L|O|0|1/);
  });
});

describe('codeGroups / maskCode', () => {
  it('splits a code into groups', () => {
    expect(codeGroups(VALID_CODE)).toEqual(['ABCD', 'EFGH', 'JKMN', 'PQRS']);
  });

  it('masks every group except the first (never leaks a full code)', () => {
    const masked = maskCode(VALID_CODE);
    expect(masked).toContain('ABCD'); // first group shown for correlation
    expect(masked).not.toContain('PQRS'); // remaining groups hidden
    expect(masked).toBe('ABCD-****');
  });
});
