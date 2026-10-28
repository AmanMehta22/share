/**
 * Wire protocol for the RTCDataChannel.
 *
 * Two frame types share one channel:
 *   1. CONTROL - JSON text frames (manifest, accept, progress markers, cancel)
 *   2. CHUNK   - binary frames carrying raw file bytes
 *
 * Binary frame layout (big-endian):
 *   byte 0      protocol version (1)
 *   byte 1      frame type (1 = FILE_CHUNK)
 *   bytes 2-5   uint32 file index
 *   bytes 6-9   uint32 chunk sequence number
 *   bytes 10+   raw payload bytes
 *
 * No Base64: raw bytes go over the wire, so overhead stays at 10 bytes per
 * chunk instead of ~33% for text encoding.
 */

export const PROTOCOL_VERSION = 1;
export const FRAME_TYPE = Object.freeze({ FILE_CHUNK: 1 });
export const HEADER_BYTES = 10;

/** Upper bound the receiver accepts for a single chunk payload. */
export const MAX_CHUNK_BYTES = 256 * 1024;

/** Every control message type that may appear on the wire. */
export const CONTROL_TYPES = Object.freeze({
  MANIFEST: 'manifest',
  MANIFEST_ACK: 'manifest-ack',
  ACCEPT: 'accept',
  REJECT: 'reject',
  FILE_START: 'file-start',
  FILE_END: 'file-end',
  FILE_RECEIVED: 'file-received',
  TRANSFER_COMPLETE: 'transfer-complete',
  TRANSFER_COMPLETE_ACK: 'transfer-complete-ack',
  PAUSE: 'pause',
  RESUME: 'resume',
  CANCEL: 'cancel',
  ERROR: 'error',
});

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** Serialize a control message as a JSON text frame. */
export function encodeControl(message) {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    throw new ProtocolError('BAD_CONTROL', 'Control messages require a type.');
  }
  return JSON.stringify(message);
}

/**
 * Encode one file chunk.
 * @param {number} fileIndex
 * @param {number} chunkIndex
 * @param {Uint8Array} payload
 */
export function encodeChunk(fileIndex, chunkIndex, payload) {
  if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 0xffffffff) {
    throw new ProtocolError('BAD_INDEX', 'File index out of range.');
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffffffff) {
    throw new ProtocolError('BAD_INDEX', 'Chunk index out of range.');
  }
  if (!(payload instanceof Uint8Array)) {
    throw new ProtocolError('BAD_PAYLOAD', 'Chunk payload must be a Uint8Array.');
  }
  const buffer = new ArrayBuffer(HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, FRAME_TYPE.FILE_CHUNK);
  view.setUint32(2, fileIndex, false);
  view.setUint32(6, chunkIndex, false);
  new Uint8Array(buffer, HEADER_BYTES).set(payload);
  return buffer;
}

/**
 * Decode a raw binary frame.
 * @param {ArrayBuffer|Uint8Array} frame
 * @returns {{fileIndex:number, chunkIndex:number, payload:Uint8Array}}
 */
export function decodeChunk(frame) {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new ProtocolError('SHORT_FRAME', 'Binary frame is shorter than the header.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError('BAD_VERSION', `Unsupported protocol version ${version}.`);
  }
  const type = view.getUint8(1);
  if (type !== FRAME_TYPE.FILE_CHUNK) {
    throw new ProtocolError('BAD_TYPE', `Unknown frame type ${type}.`);
  }
  const fileIndex = view.getUint32(2, false);
  const chunkIndex = view.getUint32(6, false);
  const payload = bytes.subarray(HEADER_BYTES);
  if (payload.byteLength > MAX_CHUNK_BYTES) {
    throw new ProtocolError('CHUNK_TOO_LARGE', 'Chunk exceeds the allowed size.');
  }
  return { fileIndex, chunkIndex, payload };
}

/**
 * Parse and validate a control frame.
 * @param {string} raw
 * @param {{maxManifestChars?: number}} [limits]
 * @returns {{type:string, [key:string]: any}}
 */
export function parseControl(raw, limits = {}) {
  if (typeof raw !== 'string') {
    throw new ProtocolError('BAD_CONTROL', 'Control frames must be text.');
  }
  const maxChars = limits.maxManifestChars ?? 2_000_000;
  if (raw.length > maxChars) {
    throw new ProtocolError('CONTROL_TOO_LARGE', 'Control message is too large.');
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new ProtocolError('BAD_JSON', 'Control message is not valid JSON.');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new ProtocolError('BAD_CONTROL', 'Control message must be an object.');
  }
  if (typeof message.type !== 'string' || !Object.values(CONTROL_TYPES).includes(message.type)) {
    throw new ProtocolError('BAD_CONTROL_TYPE', 'Unknown control message type.');
  }
  return message;
}

function isSafeString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a sender manifest before the receiver shows anything to the user.
 * Everything in here is untrusted peer input.
 *
 * @param {unknown} manifest
 * @param {{maxFiles?:number, maxPathLength?:number, maxNameLength?:number, maxTotalBytes?:number}} limits
 * @returns {{files:Array<{i:number,name:string,path:string,size:number,dir:boolean}>, totalBytes:number, hasDirectories:boolean}}
 */
export function validateManifest(manifest, limits = {}) {
  const maxFiles = limits.maxFiles ?? 100_000;
  const maxPathLength = limits.maxPathLength ?? 1024;
  const maxNameLength = limits.maxNameLength ?? 255;
  const maxTotalBytes = limits.maxTotalBytes ?? Number.MAX_SAFE_INTEGER;

  if (!isPlainObject(manifest)) {
    throw new ProtocolError('BAD_MANIFEST', 'Manifest must be an object.');
  }
  const list = manifest.files;
  if (!Array.isArray(list)) {
    throw new ProtocolError('BAD_MANIFEST', 'Manifest is missing its file list.');
  }
  if (list.length > maxFiles) {
    throw new ProtocolError('TOO_MANY_FILES', `A transfer may contain at most ${maxFiles} entries.`);
  }

  const files = [];
  const seenPaths = new Set();
  let totalBytes = 0;
  let hasDirectories = false;

  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (!isPlainObject(entry)) {
      throw new ProtocolError('BAD_ENTRY', `Entry #${index} is malformed.`);
    }
    if (!Number.isInteger(entry.i) || entry.i !== index) {
      throw new ProtocolError('BAD_ENTRY', `Entry #${index} has an invalid index.`);
    }
    if (!isSafeString(entry.name, maxNameLength)) {
      throw new ProtocolError('BAD_ENTRY', `Entry #${index} has an invalid name.`);
    }
    if (!isSafeString(entry.path, maxPathLength)) {
      throw new ProtocolError('BAD_ENTRY', `Entry #${index} has an invalid path.`);
    }
    const dir = entry.dir === true;
    const size = dir ? 0 : entry.size;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ProtocolError('BAD_ENTRY', `Entry #${index} has an invalid size.`);
    }
    if (entry.path.includes('\u0000')) {
      throw new ProtocolError('BAD_ENTRY', `Entry #${index} path contains a NUL byte.`);
    }
    if (seenPaths.has(entry.path)) {
      throw new ProtocolError('DUPLICATE_PATH', `Duplicate path in manifest: ${entry.path}`);
    }
    seenPaths.add(entry.path);

    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new ProtocolError('BAD_MANIFEST', 'Total transfer size is out of range.');
    }
    if (dir) hasDirectories = true;

    files.push({ i: index, name: entry.name, path: entry.path, size, dir });
  }

  if (totalBytes > maxTotalBytes) {
    throw new ProtocolError('TOO_LARGE', 'The transfer exceeds the allowed total size.');
  }

  return { files, totalBytes, hasDirectories };
}

/**
 * Split any incoming channel payload into a normalized frame description.
 * Strings become control messages; binary becomes a chunk. Blobs are accepted
 * too (converted by the caller) in case a browser ignores binaryType.
 *
 * @param {unknown} data
 * @param {{maxManifestChars?: number}} [limits]
 * @returns {{kind:'control', message:object} | {kind:'chunk', fileIndex:number, chunkIndex:number, payload:Uint8Array}}
 */
export function classifyFrame(data, limits = {}) {
  if (typeof data === 'string') {
    return { kind: 'control', message: parseControl(data, limits) };
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return { kind: 'chunk', ...decodeChunk(data) };
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return { kind: 'blob', blob: data };
  }
  throw new ProtocolError('UNKNOWN_FRAME', 'Received an unsupported frame type.');
}

/** Convenience: bytes -> string (used when a Blob frame shows up). */
export function bytesToString(bytes) {
  return textDecoder.decode(bytes);
}

/** Convenience helper for tests and debugging. */
export function stringToBytes(text) {
  return textEncoder.encode(text);
}
