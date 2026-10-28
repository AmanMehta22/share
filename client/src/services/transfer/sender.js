import { CONTROL_TYPES, encodeControl, encodeChunk, classifyFrame } from './protocol.js';
import { bindEvent, channelIsOpen, waitForWritable, waitForResume, createNotifier } from './channel.js';
import { TransferError } from './errors.js';

export { TransferError };

const PROGRESS_INTERVAL_MS = 100;
const ACK_TIMEOUT_MS = 30_000;

/**
 * Streams a set of files over an RTCDataChannel with real backpressure.
 *
 * Guarantees:
 *  - the manifest always precedes the bytes it describes
 *  - nothing is read before the receiver explicitly accepts
 *  - `bufferedAmount` is honoured, so large files never sit fully in RAM
 *  - success is only reported after the receiver confirms reconstruction
 */
export class SenderTransfer {
  /**
   * @param {{
   *   channel: RTCDataChannel,
   *   files: Array<{index:number,name:string,path:string,size:number,dir?:boolean,blob?:Blob}>,
   *   chunkSize?: number,
   *   highWater?: number,
   *   onEvent?: (event:object) => void,
   *   limits?: object,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.channel = options.channel;
    this.files = options.files;
    this.chunkSize = options.chunkSize ?? 32 * 1024;
    this.highWater = options.highWater ?? 1024 * 1024;
    this.onEvent = options.onEvent ?? (() => {});
    this.limits = options.limits ?? {};
    this.now = options.now ?? (() => Date.now());

    this.totalBytes = this.files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    this.sentBytes = 0;
    this.paused = false;
    this.aborted = false;
    this.finished = false;
    this.currentFileIndex = -1;

    this.#notifier = createNotifier();
    this.#waiters = new Set();
    this.#unbinders = [];
    this.#queue = Promise.resolve();
    this.#fatalError = null;
    this.#cancelBy = null;
    this.#lastProgressAt = 0;
    this.#terminalEmitted = new Set();
  }

  #notifier;
  #waiters;
  #unbinders;
  #queue;
  #fatalError;
  #cancelBy;
  #lastProgressAt;
  #terminalEmitted;

  /** Emit a terminal event at most once per engine run. */
  #emitTerminal(event) {
    if (this.#terminalEmitted.has(event.type)) return;
    this.#terminalEmitted.add(event.type);
    this.#emit(event);
  }

  /** Snapshot for the UI. */
  get progress() {
    return {
      sentBytes: this.sentBytes,
      totalBytes: this.totalBytes,
      fileIndex: this.currentFileIndex,
      paused: this.paused,
      finished: this.finished,
      status: this.aborted ? 'cancelled' : this.finished ? 'complete' : 'transferring',
    };
  }

  #emit(event) {
    try {
      this.onEvent(event);
    } catch (error) {
      console.warn('transfer event handler failed', error);
    }
  }

  #assertOpen() {
    if (this.#fatalError) throw this.#fatalError;
    if (!channelIsOpen(this.channel)) {
      throw new TransferError('PEER_CLOSED', 'The connection to the peer was lost.');
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
      sentBytes: this.sentBytes,
      totalBytes: this.totalBytes,
      fileIndex: this.currentFileIndex,
      paused: this.paused,
    });
  }

  #waitFor(types, timeoutMs = 0) {
    if (this.#fatalError) return Promise.reject(this.#fatalError);
    if (this.aborted) {
      return Promise.reject(new TransferError('CANCELLED', 'Transfer cancelled.', { by: this.#cancelBy }));
    }
    return new Promise((resolve, reject) => {
      const waiter = { types, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new TransferError('TIMEOUT', 'Timed out waiting for confirmation from the peer.'));
        }, timeoutMs);
        if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      }
      this.#waiters.add(waiter);
    });
  }

  #resolveWaiter(message) {
    for (const waiter of [...this.#waiters]) {
      if (!waiter.types.includes(message.type)) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(message);
      return true;
    }
    return false;
  }

  #rejectWaiters(error) {
    for (const waiter of [...this.#waiters]) {
      if (waiter.timer) clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.reject(error);
    }
  }

  #enqueue(task) {
    this.#queue = this.#queue.then(task).catch((error) => this.#handleFatal(error));
  }

  #handleFatal(error) {
    if (this.finished || this.aborted) return;
    const normalized =
      error instanceof TransferError
        ? error
        : new TransferError('TRANSFER_FAILED', error?.message ?? 'Transfer failed.');
    this.#fatalError = normalized;
    this.#rejectWaiters(normalized);
    this.#emitTerminal({ type: 'error', error: normalized });
    try {
      if (channelIsOpen(this.channel)) {
        this.channel.send(encodeControl({ type: CONTROL_TYPES.ERROR, message: normalized.message }));
      }
    } catch {
      /* channel already gone */
    }
  }

  #onControl(message) {
    switch (message.type) {
      case CONTROL_TYPES.PAUSE:
        this.paused = true;
        this.#emit({ type: 'paused', by: 'receiver' });
        this.#resolveWaiter(message);
        return;
      case CONTROL_TYPES.RESUME:
        this.paused = false;
        this.#notifier.notify();
        this.#emit({ type: 'resumed', by: 'receiver' });
        this.#resolveWaiter(message);
        return;
      case CONTROL_TYPES.CANCEL:
        this.#receiveCancel(message);
        return;
      case CONTROL_TYPES.ERROR: {
        const text =
          typeof message.message === 'string' ? message.message.slice(0, 300) : 'The receiver reported an error.';
        this.#handleFatal(new TransferError('PEER_ERROR', text));
        this.#resolveWaiter(message);
        return;
      }
      default:
        this.#resolveWaiter(message);
    }
  }

  #receiveCancel(message) {
    if (this.aborted || this.finished) return;
    this.aborted = true;
    this.#cancelBy = 'receiver';
    this.#notifier.notify();
    const reason = typeof message.reason === 'string' ? message.reason.slice(0, 300) : 'cancelled';
    this.#rejectWaiters(new TransferError('CANCELLED', reason, { by: 'receiver' }));
    this.#emitTerminal({ type: 'cancelled', by: 'receiver', reason });
  }

  #onMessage(event) {
    const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
    this.#enqueue(() => this.#processFrame(data));
  }

  #onClose() {
    if (this.finished || this.aborted) return;
    this.#handleFatal(
      new TransferError('PEER_CLOSED', 'The connection closed before the transfer finished.')
    );
  }

  #onError() {
    if (this.finished || this.aborted) return;
    this.#handleFatal(new TransferError('CHANNEL_ERROR', 'The data channel reported an error.'));
  }

  async #processFrame(data) {
    if (this.finished || this.aborted) return;
    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      if (this.finished || this.aborted) return;
      this.#processFrame(buffer);
      return;
    }
    const frame = classifyFrame(data, this.limits);
    if (frame.kind === 'control') this.#onControl(frame.message);
    // A sender ignores chunk frames; the receiver is the only chunk consumer.
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
    this.#rejectWaiters(new TransferError('CLEANUP', 'Transfer ended.'));
    this.#notifier.clear();
  }

  /** Sender-side pause (UI button). */
  pause(by = 'sender') {
    if (this.paused || this.finished || this.aborted) return;
    this.paused = true;
    this.#emit({ type: 'paused', by });
    try {
      this.#sendControl({ type: CONTROL_TYPES.PAUSE });
    } catch {
      /* peer may already be gone; the loop will surface it */
    }
  }

  resume(by = 'sender') {
    if (!this.paused || this.finished || this.aborted) return;
    this.paused = false;
    this.#notifier.notify();
    this.#emit({ type: 'resumed', by });
    try {
      this.#sendControl({ type: CONTROL_TYPES.RESUME });
    } catch {
      /* ignore */
    }
  }

  cancel(reason = 'Cancelled by the sender', by = 'sender') {
    if (this.finished || this.aborted) return;
    this.aborted = true;
    this.#cancelBy = by;
    this.#notifier.notify();
    try {
      if (channelIsOpen(this.channel)) {
        this.channel.send(encodeControl({ type: CONTROL_TYPES.CANCEL, reason: String(reason).slice(0, 200) }));
      }
    } catch {
      /* best effort */
    }
    this.#rejectWaiters(new TransferError('CANCELLED', reason, { by }));
    this.#emitTerminal({ type: 'cancelled', by, reason });
  }

  /**
   * Run the whole send sequence.
   * @returns {Promise<{status:'complete'|'cancelled'|'rejected'|'failed', sentBytes:number, totalBytes:number, error?:Error, reason?:string}>}
   */
  async run() {
    this.#bind();
    try {
      this.#assertOpen();

      const manifestFiles = this.files.map((file, index) => ({
        i: index,
        name: file.name,
        path: file.path,
        size: file.size,
        dir: file.dir === true,
      }));

      this.#sendControl({
        type: CONTROL_TYPES.MANIFEST,
        files: manifestFiles,
        totalBytes: this.totalBytes,
        chunkSize: this.chunkSize,
      });
      this.#emit({
        type: 'manifest-sent',
        fileCount: this.files.length,
        totalBytes: this.totalBytes,
      });

      const decision = await this.#waitFor(
        [CONTROL_TYPES.ACCEPT, CONTROL_TYPES.REJECT, CONTROL_TYPES.CANCEL, CONTROL_TYPES.ERROR],
        0
      );

      if (decision.type === CONTROL_TYPES.REJECT) {
        const reason =
          typeof decision.reason === 'string' ? decision.reason.slice(0, 300) : 'The receiver declined the transfer.';
        this.aborted = true;
        this.#cancelBy = 'receiver';
        this.#emit({ type: 'rejected', reason });
        return { status: 'rejected', reason, sentBytes: 0, totalBytes: this.totalBytes };
      }
      if (decision.type !== CONTROL_TYPES.ACCEPT) {
        // cancel or error arrived instead
        const error = this.#fatalError ?? new TransferError('CANCELLED', 'The transfer was cancelled.');
        return {
          status: error.code === 'CANCELLED' ? 'cancelled' : 'failed',
          error,
          reason: error.message,
          sentBytes: this.sentBytes,
          totalBytes: this.totalBytes,
        };
      }

      this.#emit({ type: 'accepted' });
      this.#maybeProgress(true);

      await this.#streamFiles();

      this.#assertOpen();
      this.#sendControl({ type: CONTROL_TYPES.TRANSFER_COMPLETE, totalBytes: this.sentBytes });
      this.#emit({ type: 'sent', sentBytes: this.sentBytes, totalBytes: this.totalBytes });

      await this.#waitFor([CONTROL_TYPES.TRANSFER_COMPLETE_ACK, CONTROL_TYPES.CANCEL], ACK_TIMEOUT_MS);

      this.finished = true;
      this.#maybeProgress(true);
      this.#emit({ type: 'complete', sentBytes: this.sentBytes, totalBytes: this.totalBytes });
      return { status: 'complete', sentBytes: this.sentBytes, totalBytes: this.totalBytes };
    } catch (error) {
      if (this.aborted && !this.#fatalError) {
        return {
          status: 'cancelled',
          error,
          reason: error?.message,
          sentBytes: this.sentBytes,
          totalBytes: this.totalBytes,
        };
      }
      const normalized =
        error instanceof TransferError
          ? error
          : new TransferError('TRANSFER_FAILED', error?.message ?? 'Transfer failed.');
      this.#fatalError = this.#fatalError ?? normalized;
      const status = normalized.code === 'CANCELLED' ? 'cancelled' : 'failed';
      this.#emitTerminal({
        type: status === 'cancelled' ? 'cancelled' : 'error',
        error: normalized,
        reason: normalized.message,
      });
      return {
        status,
        error: normalized,
        reason: normalized.message,
        sentBytes: this.sentBytes,
        totalBytes: this.totalBytes,
      };
    } finally {
      this.finished = true;
      this.#unbind();
    }
  }

  async #streamFiles() {
    for (let index = 0; index < this.files.length; index += 1) {
      const file = this.files[index];
      this.currentFileIndex = index;
      this.#assertOpen();
      this.#sendControl({ type: CONTROL_TYPES.FILE_START, index, size: file.size });
      this.#emit({ type: 'file-start', index, name: file.name, path: file.path, size: file.size });

      if (file.dir === true) {
        // Directories carry no bytes; the receiver creates them when saving.
        this.#sendControl({ type: CONTROL_TYPES.FILE_END, index, size: 0 });
        continue;
      }

      let offset = 0;
      let chunkIndex = 0;

      while (offset < file.size) {
        await waitForResume({
          isPaused: () => this.paused,
          isAborted: () => this.aborted,
          subscribe: (fn) => this.#notifier.subscribe(fn),
        });
        this.#assertOpen();

        await waitForWritable(this.channel, {
          highWater: this.highWater,
          shouldAbort: () => this.aborted || this.#fatalError !== null || !channelIsOpen(this.channel),
        });
        this.#assertOpen();

        const end = Math.min(offset + this.chunkSize, file.size);
        let bytes;
        try {
          const slice = file.blob.slice(offset, end);
          bytes = new Uint8Array(await slice.arrayBuffer());
        } catch (error) {
          throw new TransferError('READ_FAILED', `Could not read "${file.name}": ${error?.message ?? error}`);
        }
        if (bytes.byteLength === 0) {
          // Defensive: never spin forever on an empty read.
          throw new TransferError(
            'READ_FAILED',
            `"${file.name}" ended earlier than its declared size (${file.size} bytes).`
          );
        }

        this.channel.send(encodeChunk(index, chunkIndex, bytes));
        offset += bytes.byteLength;
        chunkIndex += 1;
        this.sentBytes += bytes.byteLength;
        this.#maybeProgress();
      }

      if (offset !== file.size) {
        throw new TransferError(
          'SIZE_MISMATCH',
          `"${file.name}" was read as ${offset} bytes but declared ${file.size} bytes.`
        );
      }

      this.#assertOpen();
      this.#sendControl({ type: CONTROL_TYPES.FILE_END, index, size: file.size });
      this.#maybeProgress(true);
      this.#emit({ type: 'file-end', index, size: file.size });
    }
    this.currentFileIndex = -1;
  }
}

/**
 * Convenience factory used by the sender hook and by tests.
 * @param {ConstructorParameters<typeof SenderTransfer>[0]} options
 */
export function createSenderTransfer(options) {
  return new SenderTransfer(options);
}
