import {
  CONTROL_TYPES,
  encodeControl,
  classifyFrame,
  validateManifest,
} from './protocol.js';
import { bindEvent, channelIsOpen } from './channel.js';
import { TransferError } from './errors.js';

const PROGRESS_INTERVAL_MS = 100;

/**
 * Receives a manifest, waits for explicit user consent, then reassembles each
 * file from ordered binary chunks and hands the finished blob to `onFile`.
 *
 * Safety properties:
 *  - no bytes are accepted before `accept()` (user clicked Accept)
 *  - every manifest entry is validated before it is shown to the user
 *  - chunk order, file index and total byte count are verified per file
 *  - memory is bounded to one file at a time (parts are released on completion)
 */
export class ReceiverTransfer {
  /**
   * @param {{
   *   channel: RTCDataChannel,
   *   onEvent?: (event:object) => void,
   *   onFile?: (entry:object, blob:Blob|null) => Promise<void>|void,
   *   limits?: object,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.channel = options.channel;
    this.onEvent = options.onEvent ?? (() => {});
    this.onFile = options.onFile ?? (() => {});
    /**
     * Optional streaming sink: when provided, received bytes are written
     * through it as they arrive instead of being buffered into a Blob.
     * Signature: async (entry) => { write(chunk), end(), abort?() } | null
     */
    this.createWriter = options.createWriter ?? null;
    this.limits = options.limits ?? {};
    this.now = options.now ?? (() => Date.now());

    /** @type {null|{files:Array, totalBytes:number, hasDirectories:boolean}} */
    this.manifest = null;
    this.accepted = false;
    this.paused = false;
    this.aborted = false;
    this.finished = false;
    this.receivedBytes = 0;

    /** @type {Array<{received:number, expectedChunk:number, parts:Array<Uint8Array>|null, done:boolean, started:boolean}>} */
    this.#state = [];
    this.#settle = null;
    this.#unbinders = [];
    this.#queue = Promise.resolve();
    this.#fatalError = null;
    this.#lastProgressAt = 0;
    this.#terminalEmitted = new Set();
    this.#currentFile = -1;
  }

  #state;
  #settle;
  #unbinders;
  #queue;
  #fatalError;
  #lastProgressAt;
  #terminalEmitted;
  #currentFile;

  /** Snapshot for the UI. */
  get progress() {
    const total = this.manifest ? this.manifest.totalBytes : 0;
    return {
      receivedBytes: this.receivedBytes,
      totalBytes: total,
      fileIndex: this.#currentFile,
      paused: this.paused,
      finished: this.finished,
      status: this.aborted ? 'cancelled' : this.finished ? 'complete' : 'transferring',
    };
  }

  #emit(event) {
    try {
      this.onEvent(event);
    } catch (error) {
      console.warn('receive event handler failed', error);
    }
  }

  #emitTerminal(event) {
    if (this.#terminalEmitted.has(event.type)) return;
    this.#terminalEmitted.add(event.type);
    this.#emit(event);
  }

  #assertOpen() {
    if (this.#fatalError) throw this.#fatalError;
    if (!channelIsOpen(this.channel)) {
      throw new TransferError('PEER_CLOSED', 'The connection to the sender was lost.');
    }
  }

  #sendControl(message) {
    this.#assertOpen();
    this.channel.send(encodeControl(message));
  }

  #maybeProgress(force = false) {
    const currentTime = this.now();
    if (!force && currentTime - this.#lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.#lastProgressAt = currentTime;
    this.#emit({
      type: 'progress',
      receivedBytes: this.receivedBytes,
      totalBytes: this.manifest ? this.manifest.totalBytes : 0,
      fileIndex: this.#currentFile,
      paused: this.paused,
    });
  }

  #settleResult(result) {
    if (!this.#settle) return;
    const settle = this.#settle;
    this.#settle = null;
    this.finished = true;
    this.#unbind();
    settle(result);
  }

  /** Roll back a partially written file so no truncated file is left behind. */
  #abortActiveWriter() {
    const active = this.#state.find((entry) => entry && entry.writer);
    if (!active?.writer) return;
    try {
      if (typeof active.writer.abort === 'function') active.writer.abort();
    } catch {
      /* ignore */
    }
    active.writer = null;
    active.parts = null;
  }

  #fail(error) {
    if (this.finished || this.aborted) return;
    const normalized =
      error instanceof TransferError
        ? error
        : new TransferError('TRANSFER_FAILED', error?.message ?? 'Transfer failed.');
    this.#fatalError = this.#fatalError ?? normalized;

    // Roll back a partially written file so no half-file is left on disk.
    this.#abortActiveWriter();

    this.#emitTerminal({ type: 'error', error: normalized, reason: normalized.message });
    try {
      if (channelIsOpen(this.channel)) {
        this.channel.send(encodeControl({ type: CONTROL_TYPES.ERROR, message: normalized.message }));
      }
    } catch {
      /* the channel is likely already gone */
    }
    this.#settleResult({
      status: normalized.code === 'CANCELLED' ? 'cancelled' : 'failed',
      error: normalized,
      reason: normalized.message,
      receivedBytes: this.receivedBytes,
      totalBytes: this.manifest ? this.manifest.totalBytes : 0,
    });
  }

  // ------------------------------------------------------------------ events

  #onClose() {
    if (this.finished || this.aborted) return;
    this.#fail(new TransferError('PEER_CLOSED', 'The sender disconnected before the transfer finished.'));
  }

  #onError() {
    if (this.finished || this.aborted) return;
    this.#fail(new TransferError('CHANNEL_ERROR', 'The data channel reported an error.'));
  }

  #onMessage(event) {
    const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
    this.#queue = this.#queue.then(() => this.#processFrame(data)).catch((error) => this.#fail(error));
  }

  #bind() {
    this.#unbinders.push(bindEvent(this.channel, 'message', (event) => this.#onMessage(event)));
    this.#unbinders.push(bindEvent(this.channel, 'close', () => this.#onClose()));
    this.#unbinders.push(bindEvent(this.channel, 'error', () => this.#onError()));
  }

  #unbind() {
    for (const off of this.#unbinders.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
  }

  // ----------------------------------------------------------------- control

  async #processFrame(data) {
    if (this.finished || this.aborted) return;

    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      if (this.finished || this.aborted) return;
      await this.#processFrame(buffer);
      return;
    }

    const frame = classifyFrame(data, this.limits);
    if (frame.kind === 'control') {
      await this.#onControl(frame.message);
      return;
    }
    await this.#onChunk(frame);
  }

  async #onControl(message) {
    switch (message.type) {
      case CONTROL_TYPES.MANIFEST:
        await this.#onManifest(message);
        return;
      case CONTROL_TYPES.FILE_START:
        await this.#onFileStart(message);
        return;
      case CONTROL_TYPES.FILE_END:
        await this.#onFileEnd(message);
        return;
      case CONTROL_TYPES.TRANSFER_COMPLETE:
        this.#onTransferComplete(message);
        return;
      case CONTROL_TYPES.PAUSE:
        this.paused = true;
        this.#emit({ type: 'paused', by: 'sender' });
        return;
      case CONTROL_TYPES.RESUME:
        this.paused = false;
        this.#emit({ type: 'resumed', by: 'sender' });
        return;
      case CONTROL_TYPES.CANCEL: {
        if (this.finished || this.aborted) return;
        this.aborted = true;
        this.#abortActiveWriter();
        const reason = typeof message.reason === 'string' ? message.reason.slice(0, 300) : 'Sender cancelled.';
        this.#emitTerminal({ type: 'cancelled', by: 'sender', reason });
        this.#settleResult({
          status: 'cancelled',
          reason,
          by: 'sender',
          receivedBytes: this.receivedBytes,
          totalBytes: this.manifest ? this.manifest.totalBytes : 0,
        });
        return;
      }
      case CONTROL_TYPES.ERROR: {
        const text =
          typeof message.message === 'string' ? message.message.slice(0, 300) : 'The sender reported an error.';
        this.#fail(new TransferError('PEER_ERROR', text));
        return;
      }
      default:
        // manifest-ack / accept / reject / file-received are sender-side or
        // already handled; anything else is ignored by the receiver.
        return;
    }
  }

  async #onManifest(message) {
    if (this.manifest) {
      this.#fail(new TransferError('PROTOCOL', 'A manifest was already received.'));
      return;
    }
    let manifest;
    try {
      manifest = validateManifest(message, this.limits);
    } catch (error) {
      const normalized =
        error instanceof TransferError
          ? error
          : new TransferError(error.code ?? 'BAD_MANIFEST', error.message);
      try {
        this.#sendControl({ type: CONTROL_TYPES.ERROR, message: normalized.message });
      } catch {
        /* ignore */
      }
      this.#fail(normalized);
      return;
    }

    if (manifest.files.length === 0) {
      const error = new TransferError('EMPTY_TRANSFER', 'The sender did not provide any files.');
      try {
        this.#sendControl({ type: CONTROL_TYPES.ERROR, message: error.message });
      } catch {
        /* ignore */
      }
      this.#fail(error);
      return;
    }

    this.manifest = manifest;
    this.#state = manifest.files.map(() => ({
      received: 0,
      expectedChunk: 0,
      parts: null,
      writer: null,
      done: false,
      started: false,
    }));

    try {
      this.#sendControl({ type: CONTROL_TYPES.MANIFEST_ACK });
    } catch (error) {
      this.#fail(error);
      return;
    }

    this.#emit({
      type: 'manifest',
      files: manifest.files,
      totalBytes: manifest.totalBytes,
      fileCount: manifest.files.length,
      hasDirectories: manifest.hasDirectories,
    });
  }

  async #onFileStart(message) {
    if (!this.manifest) {
      this.#fail(new TransferError('PROTOCOL', 'File data arrived before the manifest.'));
      return;
    }
    const index = message.index;
    if (!Number.isInteger(index) || index < 0 || index >= this.#state.length) {
      this.#fail(new TransferError('PROTOCOL', 'Received an invalid file index.'));
      return;
    }
    const entry = this.manifest.files[index];
    const state = this.#state[index];
    if (state.started || state.done) {
      this.#fail(new TransferError('PROTOCOL', 'File data arrived twice for the same file.'));
      return;
    }
    if (
      !entry.dir &&
      Number.isSafeInteger(message.size) &&
      message.size >= 0 &&
      message.size !== entry.size
    ) {
      this.#fail(new TransferError('SIZE_MISMATCH', 'File size changed mid-transfer.'));
      return;
    }
    state.started = true;
    state.parts = entry.dir ? null : [];

    // Streaming destination (folder save): chunks go straight to disk.
    if (this.createWriter && !entry.dir) {
      try {
        state.writer = await this.createWriter({ ...entry, index });
      } catch (error) {
        this.#fail(
          new TransferError('SAVE_FAILED', `Could not prepare "${entry.path}": ${error?.message ?? error}`)
        );
        return;
      }
      if (state.writer) state.parts = null;
    }

    this.#currentFile = index;
    this.#emit({ type: 'file-start', index, name: entry.name, path: entry.path, size: entry.size });
  }

  async #onChunk({ fileIndex, chunkIndex, payload }) {
    if (!this.manifest || !this.accepted) {
      throw new TransferError('UNEXPECTED_DATA', 'Received file data before the transfer was accepted.');
    }
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= this.#state.length) {
      throw new TransferError('PROTOCOL', 'Chunk refers to an unknown file.');
    }
    const entry = this.manifest.files[fileIndex];
    const state = this.#state[fileIndex];
    if (entry.dir) {
      throw new TransferError('PROTOCOL', 'A directory entry cannot carry file data.');
    }
    if (!state.started || state.done) {
      throw new TransferError('PROTOCOL', 'Chunk arrived outside of an active file.');
    }
    if (chunkIndex !== state.expectedChunk) {
      throw new TransferError(
        'OUT_OF_ORDER',
        `Chunk out of order for "${entry.path}" (expected #${state.expectedChunk}, got #${chunkIndex}).`
      );
    }
    if (state.received + payload.byteLength > entry.size) {
      throw new TransferError('SIZE_MISMATCH', `"${entry.path}" received more bytes than declared.`);
    }

    if (state.writer) {
      // Streaming to disk: awaiting here also applies natural backpressure -
      // a slow disk fills the receive buffer and the sender slows down.
      try {
        await state.writer.write(payload);
      } catch (error) {
        throw new TransferError(
          'SAVE_FAILED',
          `Could not write "${entry.path}": ${error?.message ?? error}`
        );
      }
    } else {
      state.parts.push(payload);
    }
    state.expectedChunk += 1;
    state.received += payload.byteLength;
    this.receivedBytes += payload.byteLength;
    this.#maybeProgress();
  }

  async #onFileEnd(message) {
    if (!this.manifest) {
      this.#fail(new TransferError('PROTOCOL', 'File end arrived before the manifest.'));
      return;
    }
    const index = message.index;
    if (!Number.isInteger(index) || index < 0 || index >= this.#state.length) {
      this.#fail(new TransferError('PROTOCOL', 'Received an invalid file index.'));
      return;
    }
    const entry = this.manifest.files[index];
    const state = this.#state[index];
    if (!state.started || state.done) {
      this.#fail(new TransferError('PROTOCOL', 'File end arrived without matching file data.'));
      return;
    }
    if (state.received !== entry.size) {
      this.#fail(
        new TransferError(
          'SIZE_MISMATCH',
          `"${entry.path}" is incomplete: received ${state.received} of ${entry.size} bytes.`
        )
      );
      return;
    }

    let blob = null;
    if (state.writer) {
      try {
        await state.writer.end();
      } catch (error) {
        this.#fail(
          new TransferError('SAVE_FAILED', `Could not finish writing "${entry.path}": ${error?.message ?? error}`)
        );
        return;
      }
      state.writer = null;
    } else if (!entry.dir) {
      blob = new Blob(state.parts, { type: 'application/octet-stream' });
    }

    try {
      await this.onFile({ ...entry, index }, blob);
    } catch (error) {
      this.#fail(
        new TransferError('SAVE_FAILED', `Could not save "${entry.path}": ${error?.message ?? error}`, {
          cause: error,
        })
      );
      return;
    }

    state.done = true;
    state.parts = null;
    state.writer = null;
    this.#currentFile = -1;
    this.#maybeProgress(true);
    this.#emit({ type: 'file-done', index, path: entry.path, size: entry.size, dir: entry.dir });

    try {
      this.#sendControl({ type: CONTROL_TYPES.FILE_RECEIVED, index, size: entry.size });
    } catch (error) {
      this.#fail(error);
    }
  }

  #onTransferComplete() {
    if (!this.manifest) {
      this.#fail(new TransferError('PROTOCOL', 'Completion arrived before the manifest.'));
      return;
    }
    const pending = this.manifest.files.filter((_, index) => !this.#state[index].done);
    if (pending.length > 0) {
      this.#fail(
        new TransferError(
          'INCOMPLETE',
          `Transfer ended with ${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} missing.`
        )
      );
      return;
    }

    try {
      this.#sendControl({ type: CONTROL_TYPES.TRANSFER_COMPLETE_ACK, totalBytes: this.receivedBytes });
    } catch (error) {
      this.#fail(error);
      return;
    }

    this.#maybeProgress(true);
    this.#emitTerminal({
      type: 'complete',
      receivedBytes: this.receivedBytes,
      totalBytes: this.manifest.totalBytes,
      fileCount: this.manifest.files.length,
    });
    this.#settleResult({
      status: 'complete',
      receivedBytes: this.receivedBytes,
      totalBytes: this.manifest.totalBytes,
      fileCount: this.manifest.files.length,
    });
  }

  // ------------------------------------------------------------- user actions

  /** Called when the receiver clicks Accept. */
  accept() {
    if (!this.manifest) return false;
    if (this.accepted || this.finished || this.aborted) return false;
    try {
      this.#sendControl({ type: CONTROL_TYPES.ACCEPT });
    } catch (error) {
      this.#fail(error);
      return false;
    }
    this.accepted = true;
    this.#emit({ type: 'accepted' });
    this.#maybeProgress(true);
    return true;
  }

  /** Called when the receiver clicks Reject. */
  reject(reason = 'The receiver declined the transfer.') {
    if (this.finished || this.aborted) return false;
    const text = String(reason).slice(0, 300);
    try {
      if (channelIsOpen(this.channel)) {
        this.channel.send(encodeControl({ type: CONTROL_TYPES.REJECT, reason: text }));
      }
    } catch {
      /* best effort */
    }
    this.aborted = true;
    this.#abortActiveWriter();
    this.#emitTerminal({ type: 'rejected', reason: text });
    this.#settleResult({
      status: 'rejected',
      reason: text,
      receivedBytes: 0,
      totalBytes: this.manifest ? this.manifest.totalBytes : 0,
    });
    return true;
  }

  /** Ask the sender to pause (network saving, disk full, ...). */
  pause(by = 'receiver') {
    if (this.paused || this.finished || this.aborted) return;
    this.paused = true;
    this.#emit({ type: 'paused', by });
    try {
      this.#sendControl({ type: CONTROL_TYPES.PAUSE });
    } catch (error) {
      this.#fail(error);
    }
  }

  resume(by = 'receiver') {
    if (!this.paused || this.finished || this.aborted) return;
    this.paused = false;
    this.#emit({ type: 'resumed', by });
    try {
      this.#sendControl({ type: CONTROL_TYPES.RESUME });
    } catch (error) {
      this.#fail(error);
    }
  }

  cancel(reason = 'Cancelled by the receiver', by = 'receiver') {
    if (this.finished || this.aborted) return;
    this.aborted = true;
    this.#abortActiveWriter();
    try {
      if (channelIsOpen(this.channel)) {
        this.channel.send(encodeControl({ type: CONTROL_TYPES.CANCEL, reason: String(reason).slice(0, 200) }));
      }
    } catch {
      /* best effort */
    }
    this.#emitTerminal({ type: 'cancelled', by, reason: String(reason).slice(0, 300) });
    this.#settleResult({
      status: 'cancelled',
      reason: String(reason).slice(0, 300),
      by,
      receivedBytes: this.receivedBytes,
      totalBytes: this.manifest ? this.manifest.totalBytes : 0,
    });
  }

  /** Start listening. Resolves when the transfer finishes, fails or is cancelled. */
  run() {
    if (this.#settle) return Promise.resolve({ status: 'failed', reason: 'Already running.' });
    this.#bind();
    return new Promise((resolve) => {
      this.#settle = resolve;
    });
  }
}

/** Convenience factory used by the receiver hook and by tests. */
export function createReceiverTransfer(options) {
  return new ReceiverTransfer(options);
}
