import { describe, it, expect } from 'vitest';
import {
  sanitizeSegment,
  sanitizeRelativePath,
  isPathSafe,
  dedupePaths,
  sanitizeDownloadName,
  sumSizes,
  MAX_SEGMENT_LENGTH,
} from '../src/utils/paths.js';

const NUL = String.fromCharCode(0);
const CTRL = String.fromCharCode(31);
const DEL = String.fromCharCode(127);

describe('sanitizeSegment', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeSegment('report.pdf')).toBe('report.pdf');
    expect(sanitizeSegment('my file.txt')).toBe('my file.txt');
  });

  it('strips path separators', () => {
    expect(sanitizeSegment('a/b')).toBe('ab');
    expect(sanitizeSegment('a\\b')).toBe('ab');
  });

  it('rejects empty and dot-only names', () => {
    expect(sanitizeSegment('')).toBeNull();
    expect(sanitizeSegment('.')).toBeNull();
    expect(sanitizeSegment('..')).toBeNull();
  });

  it('strips control characters (path-level checks reject NULs outright)', () => {
    expect(sanitizeSegment(`a${NUL}b`)).toBe('ab');
    expect(sanitizeSegment(`a${CTRL}b${DEL}c`)).toBe('abc');
  });

  it('truncates overly long segments', () => {
    const long = 'x'.repeat(MAX_SEGMENT_LENGTH + 50);
    const result = sanitizeSegment(long);
    expect(result.length).toBeLessThanOrEqual(MAX_SEGMENT_LENGTH);
  });

  it('replaces Windows-reserved names', () => {
    expect(sanitizeSegment('CON')).not.toBe('CON');
    expect(sanitizeSegment('nul')).not.toBe('nul');
  });
});

describe('sanitizeRelativePath', () => {
  it('accepts a normal nested path', () => {
    const result = sanitizeRelativePath('folder/sub/file.txt');
    expect(result.ok).toBe(true);
    expect(result.path).toBe('folder/sub/file.txt');
  });

  it('rejects absolute paths', () => {
    expect(sanitizeRelativePath('/etc/passwd').ok).toBe(false);
    expect(sanitizeRelativePath('C:\\Windows\\System32').ok).toBe(false);
  });

  it('rejects traversal sequences', () => {
    expect(sanitizeRelativePath('../secret').ok).toBe(false);
    expect(sanitizeRelativePath('a/../../b').ok).toBe(false);
    expect(sanitizeRelativePath('a/../b').ok).toBe(false); // any ".." segment is refused outright
  });

  it('rejects paths with NUL bytes', () => {
    expect(sanitizeRelativePath(`a${NUL}b`).ok).toBe(false);
  });

  it('rejects paths longer than MAX_PATH_LENGTH', () => {
    const long = `${'a/'.repeat(600)}file.txt`;
    expect(sanitizeRelativePath(long).ok).toBe(false);
  });

  it('rejects empty paths', () => {
    expect(sanitizeRelativePath('').ok).toBe(false);
    expect(sanitizeRelativePath('///').ok).toBe(false);
  });

  it('normalizes backslashes to forward slashes', () => {
    const result = sanitizeRelativePath('folder\\sub\\file.txt');
    expect(result.ok).toBe(true);
    expect(result.path).toBe('folder/sub/file.txt');
  });
});

describe('isPathSafe', () => {
  it('true for a benign relative path', () => {
    expect(isPathSafe('a/b.txt')).toBe(true);
  });

  it('false for traversal', () => {
    expect(isPathSafe('../a')).toBe(false);
  });
});

describe('dedupePaths', () => {
  it('leaves unique paths untouched', () => {
    expect(dedupePaths(['a.txt', 'b.txt'])).toEqual(['a.txt', 'b.txt']);
  });

  it('suffixes duplicates deterministically', () => {
    const result = dedupePaths(['a.txt', 'a.txt', 'a.txt']);
    expect(new Set(result).size).toBe(3);
    expect(result[0]).toBe('a.txt');
    expect(result[1]).toMatch(/^a~\d+\.txt$/);
  });

  it('handles duplicates in different folders independently', () => {
    const result = dedupePaths(['x/a.txt', 'y/a.txt']);
    expect(result).toEqual(['x/a.txt', 'y/a.txt']);
  });
});

describe('sanitizeDownloadName', () => {
  it('keeps a normal file name', () => {
    expect(sanitizeDownloadName('photo.png')).toBe('photo.png');
  });

  it('falls back when the name is unusable', () => {
    expect(sanitizeDownloadName('', 'fallback')).toBe('fallback');
    expect(sanitizeDownloadName(null, 'fallback')).toBe('fallback');
  });

  it('strips directory parts', () => {
    expect(sanitizeDownloadName('a/b/c.txt')).toBe('c.txt');
  });
});

describe('sumSizes', () => {
  it('adds safe integers', () => {
    expect(sumSizes([{ size: 10 }, { size: 5 }])).toBe(15);
  });

  it('returns null when any size is invalid', () => {
    expect(sumSizes([{ size: 10 }, { size: -1 }])).toBeNull();
    expect(sumSizes([{ size: NaN }])).toBeNull();
    expect(sumSizes([{ size: 1.5 }])).toBeNull();
  });
});
