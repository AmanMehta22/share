/**
 * Minimal local ZIP writer (store method, no compression).
 *
 * Used only as a RECEIVER-side fallback when the browser cannot write a
 * directory to disk (no File System Access API). The ZIP is assembled entirely
 * in the browser from bytes that already arrived over WebRTC - nothing is
 * uploaded anywhere.
 *
 * Store-only keeps this file small and dependency-free. The trade-off is a
 * slightly larger archive for already-compressed content (images, videos,
 * existing ZIPs) and a 4 GiB limit inherited from the ZIP format.
 */

import { sanitizeRelativePath } from './paths.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) over a byte array, returned as an unsigned int. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const MAX_UINT32 = 0xffffffff;
const encoder = new TextEncoder();

function dosDateTime(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
}

function localHeader({ nameLength, crc, size, dosTime, dosDate }) {
  const buffer = new ArrayBuffer(30);
  const view = new DataView(buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // version needed to extract
  view.setUint16(6, 0x0800, true); // flags: filenames are UTF-8
  view.setUint16(8, 0, true); // method: stored
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameLength, true);
  view.setUint16(28, 0, true); // extra length
  return new Uint8Array(buffer);
}

function centralHeader({ nameLength, crc, size, dosTime, dosDate, offset, isDirectory }) {
  const buffer = new ArrayBuffer(46);
  const view = new DataView(buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true); // version made by
  view.setUint16(6, 20, true); // version needed
  view.setUint16(8, 0x0800, true); // UTF-8 names
  view.setUint16(10, 0, true); // stored
  view.setUint16(12, dosTime, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameLength, true);
  view.setUint16(30, 0, true); // extra
  view.setUint16(32, 0, true); // comment
  view.setUint16(34, 0, true); // disk start
  view.setUint16(36, 0, true); // internal attrs
  view.setUint32(38, (isDirectory ? 0x10 : 0) << 16, true); // external attrs
  view.setUint32(42, offset, true);
  return new Uint8Array(buffer);
}

function endOfCentralDirectory({ entries, centralSize, centralOffset }) {
  const buffer = new ArrayBuffer(22);
  const view = new DataView(buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return new Uint8Array(buffer);
}

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{path:string, data?: Uint8Array|Blob|ArrayBuffer, dir?:boolean, lastModified?:number}>} entries
 * @param {{onProgress?: (info:{done:number,total:number}) => void}} [options]
 * @returns {Promise<Blob>}
 */
export async function createZipBlob(entries, options = {}) {
  const { onProgress } = options;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ZipError('EMPTY', 'Nothing to package.');
  }
  if (entries.length > 0xffff) {
    throw new ZipError('TOO_MANY_ENTRIES', 'Too many files for a single ZIP archive.');
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const isDirectory = entry.dir === true;
    const rawPath = String(entry.path ?? '');

    // Defense in depth: never write a path that could escape the archive root
    // when the user extracts it (absolute paths, "..", drive letters, NULs).
    const safety = sanitizeRelativePath(rawPath);
    if (!safety.ok) {
      throw new ZipError('UNSAFE_PATH', `Refusing unsafe entry path "${rawPath}": ${safety.reason}`);
    }

    const name = isDirectory && !rawPath.endsWith('/') ? `${rawPath}/` : rawPath;
    const nameBytes = encoder.encode(name);

    let data = new Uint8Array(0);
    if (!isDirectory) {
      if (entry.data instanceof Uint8Array) {
        data = entry.data;
      } else if (entry.data instanceof ArrayBuffer) {
        data = new Uint8Array(entry.data);
      } else if (entry.data && typeof entry.data.arrayBuffer === 'function') {
        data = new Uint8Array(await entry.data.arrayBuffer());
      } else {
        throw new ZipError('MISSING_DATA', `No data for "${name}".`);
      }
    }

    if (data.length > MAX_UINT32) {
      throw new ZipError(
        'ZIP_TOO_LARGE',
        `"${name}" is larger than 4 GB, which the ZIP format cannot store. Save to a folder instead.`
      );
    }

    const crc = isDirectory ? 0 : crc32(data);
    const { dosTime, dosDate } = dosDateTime(entry.lastModified);
    const header = localHeader({ nameLength: nameBytes.length, crc, size: data.length, dosTime, dosDate });

    if (offset + header.length + nameBytes.length + data.length > MAX_UINT32) {
      throw new ZipError('ZIP_TOO_LARGE', 'The archive would exceed the 4 GB ZIP limit.');
    }

    localParts.push(header, nameBytes, data);
    centralParts.push(
      centralHeader({
        nameLength: nameBytes.length,
        crc,
        size: data.length,
        dosTime,
        dosDate,
        offset,
        isDirectory,
      }),
      nameBytes
    );

    offset += header.length + nameBytes.length + data.length;
    // Central directory record = fixed 46-byte header + filename.
    centralSize += 46 + nameBytes.length;

    if (onProgress) onProgress({ done: index + 1, total: entries.length });
  }

  const eocd = endOfCentralDirectory({ entries: entries.length, centralSize, centralOffset: offset });
  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
}
