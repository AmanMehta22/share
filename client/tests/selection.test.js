import { describe, it, expect } from 'vitest';
import {
  createSelection,
  createTextSelection,
  buildManifestEntries,
  validateSelection,
  SelectionError,
} from '../src/utils/selection.js';
import { LIMITS } from '../src/config.js';

/**
 * Text-message selections travel through the same selection -> manifest ->
 * engine pipeline as files; these tests pin the flag, the size accounting
 * (characters vs UTF-8 bytes) and the 10 MB cap.
 */

describe('createTextSelection', () => {
  it('builds a single flagged file entry with the right byte size', () => {
    const selection = createTextSelection('hello world');
    expect(selection.isText).toBe(true);
    expect(selection.kind).toBe('text');
    expect(selection.fileCount).toBe(1);
    expect(selection.itemCount).toBe(1);
    expect(selection.dirCount).toBe(0);
    expect(selection.totalBytes).toBe(11);
    expect(selection.characters).toBe(11);
    expect(selection.files[0].text).toBe(true);
    expect(selection.files[0].name).toBe('codeshare-text.txt');
    expect(validateSelection(selection)).toEqual([]);
  });

  it('counts characters and UTF-8 bytes separately', () => {
    const selection = createTextSelection('héllo → 世界');
    expect(selection.characters).toBe(10); // h é l l o _ → _ 世 界
    // é = 2 bytes, → = 3 bytes, each CJK char = 3 bytes
    expect(selection.totalBytes).toBe(new TextEncoder().encode('héllo → 世界').byteLength);
    expect(selection.totalBytes).toBeGreaterThan(selection.characters);
    expect(selection.files[0].size).toBe(selection.totalBytes);
  });

  it('wraps the text in a readable UTF-8 blob', async () => {
    const message = 'line one\nline two ✓';
    const selection = createTextSelection(message);
    await expect(selection.files[0].blob.text()).resolves.toBe(message);
    expect(selection.files[0].blob.type).toContain('text/plain');
  });

  it('rejects empty or non-string input', () => {
    expect(() => createTextSelection('')).toThrow(SelectionError);
    expect(() => createTextSelection('   ')).not.toThrow(); // whitespace is real content
    expect(() => createTextSelection(null)).toThrow(SelectionError);
    expect(() => createTextSelection(undefined)).toThrow(SelectionError);
  });

  it('rejects text above the 10 MB cap', () => {
    const tooBig = 'a'.repeat(LIMITS.maxTextBytes + 1);
    expect(() => createTextSelection(tooBig)).toThrow(/10 MB|limit/i);
    const atCap = 'a'.repeat(LIMITS.maxTextBytes);
    expect(() => createTextSelection(atCap)).not.toThrow();
  });

  it('accepts a custom internal file name', () => {
    const selection = createTextSelection('x', { fileName: 'note.txt' });
    expect(selection.files[0].path).toBe('note.txt');
    expect(buildManifestEntries(selection)[0].name).toBe('note.txt');
  });
});

describe('buildManifestEntries with text', () => {
  it('keeps the text flag on the manifest entry', () => {
    const entries = buildManifestEntries(createTextSelection('flag me'));
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe(true);
    expect(entries[0].dir).toBe(false);
    expect(entries[0].size).toBe(7);
    expect(entries[0].blob).toBeInstanceOf(Blob);
  });

  it('never adds a text flag to ordinary file selections', () => {
    const selection = createSelection({
      kind: 'files',
      records: [{ type: 'file', path: 'a.txt', blob: new Blob(['abc']) }],
    });
    const entries = buildManifestEntries(selection);
    expect(entries[0].text).toBeUndefined();
  });
});
