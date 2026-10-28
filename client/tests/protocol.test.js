import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  HEADER_BYTES,
  MAX_CHUNK_BYTES,
  CONTROL_TYPES,
  encodeControl,
  encodeChunk,
  decodeChunk,
  parseControl,
  validateManifest,
  classifyFrame,
  ProtocolError,
} from '../src/services/transfer/protocol.js';

const encoder = new TextEncoder();

describe('encodeChunk / decodeChunk', () => {
  it('round-trips a chunk with correct indices and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = encodeChunk(7, 42, payload);
    const decoded = decodeChunk(frame);
    expect(decoded.fileIndex).toBe(7);
    expect(decoded.chunkIndex).toBe(42);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('uses a 10-byte header', () => {
    const frame = encodeChunk(0, 0, new Uint8Array(100));
    expect(frame.byteLength).toBe(HEADER_BYTES + 100);
  });

  it('stamps the protocol version', () => {
    const frame = encodeChunk(0, 0, new Uint8Array(1));
    expect(new DataView(frame).getUint8(0)).toBe(PROTOCOL_VERSION);
  });

  it('round-trips an empty payload', () => {
    const decoded = decodeChunk(encodeChunk(3, 9, new Uint8Array(0)));
    expect(decoded.payload.byteLength).toBe(0);
  });

  it('handles a Uint8Array view (non-zero byteOffset)', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    const frame = encodeChunk(0, 0, view);
    const decoded = decodeChunk(frame);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
  });

  it('rejects a frame shorter than the header', () => {
    expect(() => decodeChunk(new ArrayBuffer(5))).toThrow(ProtocolError);
  });

  it('rejects an unknown protocol version', () => {
    const frame = encodeChunk(0, 0, new Uint8Array(1));
    new DataView(frame).setUint8(0, 99);
    expect(() => decodeChunk(frame)).toThrow(/version/i);
  });

  it('rejects an unknown frame type', () => {
    const frame = encodeChunk(0, 0, new Uint8Array(1));
    new DataView(frame).setUint8(1, 77);
    expect(() => decodeChunk(frame)).toThrow(/frame type/i);
  });

  it('rejects an oversized chunk', () => {
    const huge = new Uint8Array(MAX_CHUNK_BYTES + 1);
    const frame = encodeChunk(0, 0, huge);
    expect(() => decodeChunk(frame)).toThrow(/size/i);
  });

  it('rejects bad indices in encodeChunk', () => {
    expect(() => encodeChunk(-1, 0, new Uint8Array(1))).toThrow(ProtocolError);
    expect(() => encodeChunk(0, -1, new Uint8Array(1))).toThrow(ProtocolError);
    expect(() => encodeChunk(1.5, 0, new Uint8Array(1))).toThrow(ProtocolError);
    expect(() => encodeChunk(0, 0, 'not-bytes')).toThrow(ProtocolError);
  });
});

describe('encodeControl / parseControl', () => {
  it('round-trips a control message', () => {
    const raw = encodeControl({ type: CONTROL_TYPES.PAUSE });
    expect(parseControl(raw).type).toBe('pause');
  });

  it('rejects non-string frames', () => {
    expect(() => parseControl(new ArrayBuffer(4))).toThrow(ProtocolError);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseControl('{oops')).toThrow(/JSON/i);
  });

  it('rejects non-object JSON', () => {
    expect(() => parseControl('[1,2]')).toThrow(ProtocolError);
    expect(() => parseControl('42')).toThrow(ProtocolError);
    expect(() => parseControl('null')).toThrow(ProtocolError);
  });

  it('rejects unknown control types', () => {
    expect(() => parseControl(JSON.stringify({ type: 'evil' }))).toThrow(/type/i);
  });

  it('rejects an oversized control frame', () => {
    const big = JSON.stringify({ type: 'manifest', padding: 'x'.repeat(3000) });
    expect(() => parseControl(big, { maxManifestChars: 100 })).toThrow(/large/i);
  });

  it('rejects encodeControl without a type', () => {
    expect(() => encodeControl({})).toThrow(ProtocolError);
  });
});

describe('validateManifest', () => {
  const goodEntry = (i, path, size = 10, dir = false) => ({
    i,
    name: path.split('/').pop(),
    path,
    size: dir ? 0 : size,
    dir,
  });

  it('accepts a well-formed manifest', () => {
    const result = validateManifest({ files: [goodEntry(0, 'a.txt'), goodEntry(1, 'b/c.txt', 20)] });
    expect(result.files).toHaveLength(2);
    expect(result.totalBytes).toBe(30);
    expect(result.hasDirectories).toBe(false);
  });

  it('flags directories', () => {
    const result = validateManifest({
      files: [goodEntry(0, 'folder', 0, true), goodEntry(1, 'folder/a.txt', 5)],
    });
    expect(result.hasDirectories).toBe(true);
    expect(result.totalBytes).toBe(5);
  });

  it('rejects a non-object manifest', () => {
    expect(() => validateManifest(null)).toThrow(ProtocolError);
    expect(() => validateManifest([])).toThrow(ProtocolError);
  });

  it('rejects a missing file list', () => {
    expect(() => validateManifest({})).toThrow(/file list/i);
  });

  it('rejects mismatched indices', () => {
    expect(() =>
      validateManifest({ files: [{ ...goodEntry(0, 'a.txt'), i: 5 }] })
    ).toThrow(/index/i);
  });

  it('rejects duplicate paths', () => {
    expect(() =>
      validateManifest({ files: [goodEntry(0, 'a.txt'), goodEntry(1, 'a.txt')] })
    ).toThrow(/duplicate/i);
  });

  it('rejects paths with NUL bytes', () => {
    expect(() => validateManifest({ files: [goodEntry(0, 'a\u0000b.txt')] })).toThrow(/NUL/i);
  });

  it('rejects invalid sizes', () => {
    expect(() => validateManifest({ files: [goodEntry(0, 'a.txt', -5)] })).toThrow(/size/i);
    expect(() => validateManifest({ files: [goodEntry(0, 'a.txt', 1.5)] })).toThrow(/size/i);
  });

  it('rejects an entry that is not an object', () => {
    expect(() => validateManifest({ files: ['a.txt'] })).toThrow(/malformed/i);
  });

  it('rejects too many files', () => {
    const files = Array.from({ length: 10 }, (_, i) => goodEntry(i, `f${i}.txt`));
    expect(() => validateManifest({ files }, { maxFiles: 5 })).toThrow(/at most/i);
  });

  it('rejects an oversized total', () => {
    expect(() =>
      validateManifest({ files: [goodEntry(0, 'a.txt', 1000)] }, { maxTotalBytes: 100 })
    ).toThrow(/size/i);
  });

  it('rejects an over-long path', () => {
    expect(() =>
      validateManifest({ files: [goodEntry(0, `a/${'x'.repeat(2000)}.txt`)] }, { maxPathLength: 1024 })
    ).toThrow(/invalid (name|path)/i);
  });

  it('accepts an empty file list (sender decides what to do)', () => {
    const result = validateManifest({ files: [] });
    expect(result.files).toHaveLength(0);
    expect(result.totalBytes).toBe(0);
  });
});

describe('validateManifest text flag', () => {
  const textEntry = (size, overrides = {}) => ({
    i: 0,
    name: 'codeshare-text.txt',
    path: 'codeshare-text.txt',
    size,
    dir: false,
    text: true,
    ...overrides,
  });

  it('passes a text flag through for a flagged entry', () => {
    const result = validateManifest({ files: [textEntry(12)] });
    expect(result.files[0].text).toBe(true);
    expect(result.totalBytes).toBe(12);
  });

  it('leaves ordinary file entries unflagged', () => {
    const result = validateManifest({
      files: [{ i: 0, name: 'a.txt', path: 'a.txt', size: 5, dir: false }],
    });
    expect(result.files[0].text).toBeUndefined();
  });

  it('drops a non-boolean text flag instead of trusting it', () => {
    const result = validateManifest({ files: [textEntry(12, { text: 'yes' })] });
    expect(result.files[0].text).toBeUndefined();
  });

  it('rejects a text flag on a directory entry', () => {
    expect(() =>
      validateManifest({
        files: [{ i: 0, name: 'folder', path: 'folder', size: 0, dir: true, text: true }],
      })
    ).toThrow(/directory/i);
  });

  it('rejects a text entry above the text size cap', () => {
    expect(() => validateManifest({ files: [textEntry(101)] }, { maxTextBytes: 100 })).toThrow(
      /text message/i
    );
    // Exactly at the cap is fine.
    expect(validateManifest({ files: [textEntry(100)] }, { maxTextBytes: 100 }).files[0].text).toBe(
      true
    );
  });
});

describe('classifyFrame', () => {
  it('classifies a JSON string as control', () => {
    const frame = classifyFrame(encodeControl({ type: CONTROL_TYPES.ACCEPT }));
    expect(frame.kind).toBe('control');
    expect(frame.message.type).toBe('accept');
  });

  it('classifies an ArrayBuffer as chunk', () => {
    const frame = classifyFrame(encodeChunk(0, 0, new Uint8Array([1])));
    expect(frame.kind).toBe('chunk');
    expect(frame.fileIndex).toBe(0);
  });

  it('classifies a Uint8Array view as chunk', () => {
    const frame = classifyFrame(new Uint8Array(encodeChunk(2, 3, new Uint8Array([1]))));
    expect(frame.kind).toBe('chunk');
    expect(frame.chunkIndex).toBe(3);
  });

  it('classifies a Blob as blob (converted by caller)', () => {
    const frame = classifyFrame(new Blob([encoder.encode('x')]));
    expect(frame.kind).toBe('blob');
  });

  it('rejects unknown frame types', () => {
    expect(() => classifyFrame(12345)).toThrow(ProtocolError);
  });
});
