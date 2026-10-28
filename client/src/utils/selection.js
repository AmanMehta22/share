import { sanitizeRelativePath, dedupePaths, sumSizes } from './paths.js';
import { LIMITS } from '../config.js';

/**
 * Building a transfer selection from user input.
 *
 * Three shapes are supported:
 *   - a single file (typically a .zip)  -> downloaded verbatim
 *   - several loose files               -> grouped, ZIP fallback on receive
 *   - a folder (drag & drop or picker)  -> directory structure preserved
 *
 * Paths are sanitized and de-duplicated on the SENDER so both sides agree on
 * what will be written; the receiver validates again regardless.
 */

export class SelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SelectionError';
    this.code = code;
  }
}

function basename(path) {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** Walk a webkit entry tree (drag & drop) collecting files and directories. */
async function walkEntry(entry, prefix, out) {
  const path = prefix + entry.name;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    out.push({ type: 'file', path, blob: file });
    return;
  }
  if (entry.isDirectory) {
    out.push({ type: 'dir', path });
    const reader = entry.createReader();
    // readEntries yields at most ~100 items per call: loop until it is empty.
    let batch;
    do {
      batch = await new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      for (const child of batch) {
         
        await walkEntry(child, `${path}/`, out);
      }
    } while (batch.length > 0);
  }
}

function ensurePathsAreSafe(paths) {
  const sanitized = [];
  for (const path of paths) {
    const result = sanitizeRelativePath(path);
    if (!result.ok) {
      throw new SelectionError('UNSAFE_PATH', `"${path}" cannot be transferred (${result.reason})`);
    }
    sanitized.push(result.path);
  }
  return dedupePaths(sanitized);
}

/**
 * Turn a list of file records into a validated selection.
 * @param {{kind:'file'|'folder'|'files', name?:string, records:Array<{type:'file'|'dir', path:string, blob?:Blob}>}} input
 */
export function createSelection({ kind, name, records }) {
  const fileCount = records.filter((record) => record.type === 'file').length;

  if (records.length === 0) {
    throw new SelectionError('EMPTY', 'Nothing was selected.');
  }
  if (fileCount === 0) {
    throw new SelectionError('EMPTY', 'The selected folder does not contain any files.');
  }
  if (records.length > LIMITS.maxFiles) {
    throw new SelectionError('TOO_MANY', `A transfer may contain at most ${LIMITS.maxFiles} items.`);
  }

  // Sanitize in the original record order, then de-duplicate as a set.
  const safePaths = ensurePathsAreSafe(records.map((record) => record.path));

  const files = [];
  const dirs = [];
  records.forEach((record, index) => {
    const path = safePaths[index];
    if (record.type === 'dir') {
      dirs.push({ path, name: basename(path) });
      return;
    }
    const size = record.blob ? record.blob.size : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new SelectionError('BAD_SIZE', `"${path}" reports an invalid file size.`);
    }
    files.push({ path, name: basename(path), size, blob: record.blob });
  });

  const totalBytes = sumSizes(files);
  if (totalBytes === null) {
    throw new SelectionError('BAD_SIZE', 'The combined size of the selected files is invalid.');
  }

  const selection = {
    kind,
    name: name || (kind === 'folder' ? 'folder' : files.length === 1 ? files[0].name : `${files.length} files`),
    files,
    dirs,
    totalBytes,
    itemCount: files.length + dirs.length,
    fileCount: files.length,
    dirCount: dirs.length,
  };

  const problems = validateSelection(selection);
  if (problems.length > 0) {
    throw new SelectionError('INVALID', problems.join(' '));
  }

  return selection;
}

/**
 * Build a selection for a plain-text message.
 *
 * The text travels through the exact same engine as files (manifest ->
 * consent -> chunks -> integrity check) but is flagged so the receiver shows
 * it on screen with a copy button instead of writing it to disk.
 *
 * @param {string} text
 * @param {{fileName?: string}} [options]
 * @returns {ReturnType<typeof createSelection> & {isText: true, characters: number}}
 */
export function createTextSelection(text, options = {}) {
  const fileName = options.fileName ?? 'codeshare-text.txt';
  if (typeof text !== 'string' || text.length === 0) {
    throw new SelectionError('EMPTY', 'Type or paste some text first.');
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > LIMITS.maxTextBytes) {
    throw new SelectionError(
      'TOO_LARGE',
      `The text is ${bytes.byteLength} bytes; the limit is ${LIMITS.maxTextBytes} bytes (10 MB).`
    );
  }
  const blob = new Blob([bytes], { type: 'text/plain;charset=utf-8' });
  const selection = {
    kind: 'text',
    name: 'Text message',
    files: [{ path: fileName, name: fileName, size: bytes.byteLength, blob, text: true }],
    dirs: [],
    totalBytes: bytes.byteLength,
    itemCount: 1,
    fileCount: 1,
    dirCount: 0,
    isText: true,
    characters: text.length,
  };
  const problems = validateSelection(selection);
  if (problems.length > 0) {
    throw new SelectionError('INVALID', problems.join(' '));
  }
  return selection;
}

/** Validate an existing selection; returns an array of human-readable problems. */
export function validateSelection(selection) {
  const problems = [];
  if (!selection) return ['Select a ZIP file or a folder first.'];
  if (!Array.isArray(selection.files) || selection.files.length === 0) {
    problems.push('The selection does not contain any files.');
    return problems;
  }
  let total = 0;
  for (const file of selection.files) {
    if (typeof file.path !== 'string' || file.path.length === 0) {
      problems.push('A selected file has no name.');
      break;
    }
    if (file.path.length > LIMITS.maxPathLength) {
      problems.push(`"${file.name}" has a path longer than ${LIMITS.maxPathLength} characters.`);
      break;
    }
    if (file.name.length > LIMITS.maxNameLength) {
      problems.push(`"${file.name}" is longer than ${LIMITS.maxNameLength} characters.`);
      break;
    }
    if (!file.blob || typeof file.blob.slice !== 'function') {
      problems.push(`"${file.name}" is no longer readable. Re-select the file.`);
      break;
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      problems.push(`"${file.name}" reports an invalid size.`);
      break;
    }
    total += file.size;
    if (!Number.isSafeInteger(total)) {
      problems.push('The combined size of the selection is too large.');
      break;
    }
  }
  if (selection.itemCount === 0) problems.push('Nothing is selected.');
  return problems;
}

/**
 * Build the manifest entries that will be sent over the data channel.
 * @param {ReturnType<typeof createSelection>} selection
 */
export function buildManifestEntries(selection) {
  const entries = [];
  let index = 0;
  for (const file of selection.files) {
    const entry = { i: index, name: file.name, path: file.path, size: file.size, dir: false, blob: file.blob };
    if (file.text === true) entry.text = true;
    entries.push(entry);
    index += 1;
  }
  for (const dir of selection.dirs) {
    entries.push({ i: index, name: dir.name, path: dir.path, size: 0, dir: true, blob: null });
    index += 1;
  }
  return entries;
}

/** One-line description used in the UI. */
export function describeSelection(selection) {
  if (!selection) return { title: '', subtitle: '' };
  const parts = [];
  parts.push(`${selection.itemCount} item${selection.itemCount === 1 ? '' : 's'}`);
  if (selection.dirCount > 0) {
    parts.push(`${selection.fileCount} file${selection.fileCount === 1 ? '' : 's'}`);
  }
  return { title: selection.name, subtitle: parts.join(' · ') };
}

/**
 * Build a selection from an <input type="file"> FileList.
 * @param {FileList|File[]} fileList
 * @param {{directory?: boolean}} options
 */
export function collectFromInput(fileList, options = {}) {
  const list = Array.from(fileList ?? []);
  if (list.length === 0) throw new SelectionError('EMPTY', 'No file was selected.');

  const useDirectoryPaths = options.directory === true && list.every((file) => file.webkitRelativePath);

  if (useDirectoryPaths) {
    const paths = list.map((file) => file.webkitRelativePath);
    const roots = new Set(paths.map((path) => path.split('/')[0]));
    const rootName = roots.size === 1 ? [...roots][0] : 'folder';
    return createSelection({
      kind: 'folder',
      name: rootName,
      records: list.map((file, index) => ({ type: 'file', path: paths[index], blob: file })),
    });
  }

  if (list.length === 1) {
    const file = list[0];
    return createSelection({
      kind: 'file',
      name: file.name,
      records: [{ type: 'file', path: file.webkitRelativePath || file.name, blob: file }],
    });
  }

  return createSelection({
    kind: 'files',
    name: `${list.length} files`,
    records: list.map((file) => ({ type: 'file', path: file.webkitRelativePath || file.name, blob: file })),
  });
}

/**
 * True when the browser supports folder selection via
 * <input webkitdirectory>. All modern Chromium and Firefox builds do;
 * Safari partially (relative paths may be missing).
 */
export function supportsDirectorySelection() {
  if (typeof document === 'undefined') return false;
  const input = document.createElement('input');
  input.type = 'file';
  return 'webkitdirectory' in input;
}

/**
 * Build a selection from a drop event.
 *
 * Entry information must be read SYNCHRONOUSLY (browsers clear DataTransfer
 * once the event handler yields), so this function performs no awaits before
 * capturing entries.
 *
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<ReturnType<typeof createSelection>>}
 */
export async function collectFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer?.items ?? []);
  const supportsEntries = items.some((item) => typeof item.webkitGetAsEntry === 'function');

  if (!supportsEntries) {
    const files = Array.from(dataTransfer?.files ?? []);
    if (files.length === 0) throw new SelectionError('EMPTY', 'Nothing was dropped.');
    return collectFromInput(files);
  }

  const roots = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) roots.push(entry);
  }

  if (roots.length === 0) {
    const files = Array.from(dataTransfer?.files ?? []);
    if (files.length === 0) throw new SelectionError('EMPTY', 'Nothing was dropped.');
    return collectFromInput(files);
  }

  const records = [];
  for (const entry of roots) {
     
    await walkEntry(entry, '', records);
  }

  const singleFolder = roots.length === 1 && roots[0].isDirectory && records.some((r) => r.type === 'dir');
  if (singleFolder) {
    const rootPath = records.find((r) => r.type === 'dir').path;
    return createSelection({ kind: 'folder', name: rootPath, records });
  }
  return createSelection({ kind: 'files', name: `${roots.length} dropped item${roots.length === 1 ? '' : 's'}`, records });
}
