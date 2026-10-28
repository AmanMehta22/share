/**
 * Saving received data locally. Nothing here contacts a server: every byte is
 * written to disk or handed to the browser's download manager from memory that
 * already exists on this machine.
 */

import { sanitizeDownloadName, sanitizeSegment } from './paths.js';

/** File System Access API (Chromium, secure contexts). */
export function supportsDirectoryPicker() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export function supportsSaveFilePicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

/** True when the page is in a context where the File System Access API works. */
export function supportsFileAccessApi() {
  return supportsDirectoryPicker() || supportsSaveFilePicker();
}

/**
 * Ask the user to pick a destination directory.
 * Must be called directly from a user gesture (button click).
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function pickDirectory() {
  if (!supportsDirectoryPicker()) {
    throw Object.assign(new Error('Folder saving is not supported in this browser.'), {
      code: 'UNSUPPORTED',
    });
  }
  return window.showDirectoryPicker({ id: 'codeshare-destination', mode: 'readwrite', startIn: 'downloads' });
}

/**
 * Write one file into a directory tree, creating folders as needed.
 * @param {FileSystemDirectoryHandle} root
 * @param {string} relativePath already-sanitized relative path
 * @param {Blob} blob
 */
export async function writeToDirectory(root, relativePath, blob) {
  const segments = String(relativePath).split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('Empty destination path.');

  let directory = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const name = sanitizeSegment(segments[i]);
    if (name === null) throw new Error('Unsafe folder name.');
    directory = await directory.getDirectoryHandle(name, { create: true });
  }

  const fileName = sanitizeSegment(segments[segments.length - 1]);
  if (fileName === null) throw new Error('Unsafe file name.');
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * Open a streaming writer for a relative path inside a chosen directory.
 *
 * Used by the receiver so chunks hit disk as they arrive instead of piling up
 * in memory - the whole file never has to exist in RAM.
 *
 * @param {FileSystemDirectoryHandle} root
 * @param {string} relativePath already-sanitized relative path
 * @returns {Promise<{write:(chunk:ArrayBufferView)=>Promise<void>, end:()=>Promise<void>, abort:()=>Promise<void>}>}
 */
export async function createDirectoryWriter(root, relativePath) {
  const segments = String(relativePath).split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('Empty destination path.');

  let directory = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const name = sanitizeSegment(segments[i]);
    if (name === null) throw new Error('Unsafe folder name.');
     
    directory = await directory.getDirectoryHandle(name, { create: true });
  }

  const fileName = sanitizeSegment(segments[segments.length - 1]);
  if (fileName === null) throw new Error('Unsafe file name.');
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  return {
    write: (chunk) => writable.write(chunk),
    end: async () => {
      await writable.close();
    },
    abort: async () => {
      try {
        await writable.abort();
      } catch {
        /* the writable may already be closed or aborted */
      }
    },
  };
}

/** Create (or reuse) a nested folder inside the chosen directory. */
export async function ensureDirectory(root, relativePath) {
  const segments = String(relativePath).split('/').filter(Boolean);
  let directory = root;
  for (const segment of segments) {
    const name = sanitizeSegment(segment);
    if (name === null) throw new Error('Unsafe folder name.');
     
    directory = await directory.getDirectoryHandle(name, { create: true });
  }
  return directory;
}

/** Trigger a browser download for an in-memory blob. */
export function triggerDownload(blob, filename) {
  const safeName = sanitizeDownloadName(filename, 'download');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  // Revoke after the download has had time to start.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 60_000);
  return safeName;
}

/**
 * Download several blobs one after another. Browsers may ask once for
 * permission to allow multiple downloads; if they block it, the caller shows
 * per-file buttons instead.
 */
export async function triggerSequentialDownloads(items, { delayMs = 400 } = {}) {
  const saved = [];
  for (let i = 0; i < items.length; i += 1) {
    saved.push(triggerDownload(items[i].blob, items[i].name));
    if (i < items.length - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return saved;
}
