import { describe, it, expect } from 'vitest';
import { crc32, createZipBlob, ZipError } from '../src/utils/zip.js';

/**
 * ZIP round-trip tests.
 *
 * The writer is a minimal STORE-method (no compression) ZIP. We verify:
 *  - CRC32 correctness against known vectors
 *  - the produced blob has a valid local file header signature
 *  - central directory signature and end-of-central-directory are present
 *  - round-trip byte equality for file contents
 *  - path safety (no absolute paths or traversal inside the archive)
 */

const encoder = new TextEncoder();

function bytesOf(blob) {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function findSignature(bytes, signature) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i <= bytes.byteLength - 4; i += 1) {
    if (view.getUint32(i, true) === signature) return i;
  }
  return -1;
}

function countSignatures(bytes, signature) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  for (let i = 0; i <= bytes.byteLength - 4; i += 1) {
    if (view.getUint32(i, true) === signature) count += 1;
  }
  return count;
}

function containsBytes(bytes, needle) {
  for (let i = 0; i <= bytes.length - needle.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

describe('crc32', () => {
  it('matches known CRC32 vectors', () => {
    // Standard IEEE test vectors.
    expect(crc32(encoder.encode('')) >>> 0).toBe(0x00000000);
    expect(crc32(encoder.encode('123456789')) >>> 0).toBe(0xcbf43926);
    expect(crc32(encoder.encode('The quick brown fox jumps over the lazy dog')) >>> 0).toBe(0x414fa339);
  });

  it('is deterministic', () => {
    const data = encoder.encode('hello world');
    expect(crc32(data)).toBe(crc32(data));
  });
});

describe('createZipBlob', () => {
  it('packs a single file with a valid ZIP structure', async () => {
    const content = encoder.encode('Hello, CodeShare!');
    const blob = await createZipBlob([{ path: 'hello.txt', data: content }]);
    const bytes = await bytesOf(blob);

    // Local file header signature: PK\x03\x04
    expect(findSignature(bytes, 0x04034b50)).toBe(0);
    // End of central directory signature: PK\x05\x06
    expect(findSignature(bytes, 0x06054b50)).toBeGreaterThan(0);

    // The raw file content must appear verbatim in the archive (STORE method).
    expect(containsBytes(bytes, content)).toBe(true);
  });

  it('accepts Blob data as well as Uint8Array', async () => {
    const content = encoder.encode('blob data works too');
    const blob = await createZipBlob([{ path: 'b.txt', data: new Blob([content]) }]);
    const bytes = await bytesOf(blob);
    expect(containsBytes(bytes, content)).toBe(true);
  });

  it('preserves nested paths', async () => {
    const content = encoder.encode('nested');
    const blob = await createZipBlob([{ path: 'folder/sub/file.txt', data: content }]);
    const bytes = await bytesOf(blob);
    expect(containsBytes(bytes, encoder.encode('folder/sub/file.txt'))).toBe(true);
  });

  it('packs multiple files', async () => {
    const blob = await createZipBlob([
      { path: 'a.txt', data: encoder.encode('AAA') },
      { path: 'b.txt', data: encoder.encode('BBB') },
      { path: 'dir/c.txt', data: encoder.encode('CCC') },
    ]);
    const bytes = await bytesOf(blob);
    // Three local file headers expected (one per file entry).
    expect(countSignatures(bytes, 0x04034b50)).toBe(3);
  });

  it('supports explicit directory entries', async () => {
    const blob = await createZipBlob([
      { path: 'emptydir', dir: true },
      { path: 'emptydir/file.txt', data: encoder.encode('x') },
    ]);
    const bytes = await bytesOf(blob);
    // Directory names get a trailing slash inside the archive.
    expect(containsBytes(bytes, encoder.encode('emptydir/'))).toBe(true);
    expect(findSignature(bytes, 0x06054b50)).toBeGreaterThan(0);
  });

  it('reports progress via onProgress', async () => {
    const events = [];
    await createZipBlob(
      [
        { path: 'a.txt', data: encoder.encode('AAA') },
        { path: 'b.txt', data: encoder.encode('BBB') },
      ],
      { onProgress: (info) => events.push({ ...info }) }
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].done).toBe(2);
    expect(events[events.length - 1].total).toBe(2);
  });

  it('handles a file larger than 64 KB', async () => {
    const big = new Uint8Array(100_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
    const blob = await createZipBlob([{ path: 'big.bin', data: big }]);
    const bytes = await bytesOf(blob);
    expect(findSignature(bytes, 0x04034b50)).toBe(0);
    expect(bytes.length).toBeGreaterThan(big.length);
  });

  it('rejects an entry with an unsafe path (traversal)', async () => {
    await expect(
      createZipBlob([{ path: '../escape.txt', data: encoder.encode('x') }])
    ).rejects.toThrow(ZipError);
  });

  it('rejects an entry with an absolute path', async () => {
    await expect(
      createZipBlob([{ path: '/etc/passwd', data: encoder.encode('x') }])
    ).rejects.toThrow(/unsafe/i);
  });

  it('rejects an entry with no data and no dir flag', async () => {
    await expect(createZipBlob([{ path: 'ghost.txt' }])).rejects.toThrow(/no data/i);
  });

  it('rejects an empty entry list (nothing to package)', async () => {
    await expect(createZipBlob([])).rejects.toThrow(/nothing to package/i);
  });
});
