/**
 * In-memory fake RTCDataChannel for engine tests.
 *
 * The transfer engines are transport-agnostic: they only use readyState,
 * bufferedAmount, send(), close() and the standard channel events. The fake
 * channel mimics a real one (async delivery via microtasks, explicit
 * backpressure control), so chunk ordering, integrity, pause/resume, cancel
 * and error paths are all verified without needing two real browsers.
 */

export class FakeChannel {
  constructor(name, { autoDrain = true } = {}) {
    this.name = name;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.autoDrain = autoDrain;
    this.listeners = new Map();
    this.sent = [];
    this.maxBuffered = 0;
    this.peer = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type, event = {}) {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    for (const handler of [...handlers]) handler({ type, ...event, target: this });
  }

  open() {
    this.readyState = 'open';
    this.emit('open');
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
    this.sent.push(data);
    const size = typeof data === 'string' ? data.length : (data.byteLength ?? 0);
    this.bufferedAmount += size;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);

    // Deliver to the peer asynchronously (microtask = ordered, like a real channel).
    const peer = this.peer;
    if (peer) queueMicrotask(() => peer.deliver(data));

    // Auto-drain: simulate the transport flushing the buffer.
    if (this.autoDrain) {
      queueMicrotask(() => {
        this.bufferedAmount = 0;
        this.emit('bufferedamountlow');
      });
    }
  }

  deliver(data) {
    if (this.readyState !== 'open') return;
    this.emit('message', { data });
  }

  /** Manually flush the send buffer (used by backpressure tests). */
  drain() {
    this.bufferedAmount = 0;
    this.emit('bufferedamountlow');
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close');
    // Like a real RTCDataChannel: closing one side closes the remote peer too.
    if (this.peer && this.peer.readyState !== 'closed') {
      const peer = this.peer;
      queueMicrotask(() => peer.close());
    }
  }
}

/** Two already-open channels wired to each other. */
export function connectPair(options = {}) {
  const a = new FakeChannel('sender', options);
  const b = new FakeChannel('receiver', options);
  a.peer = b;
  b.peer = a;
  a.open();
  b.open();
  return [a, b];
}

/** Build SenderTransfer-ready file entries from simple byte definitions. */
export function makeFiles(defs) {
  return defs.map((def, index) => ({
    index,
    name: def.path.split('/').pop(),
    path: def.path,
    size: def.dir ? 0 : def.bytes.length,
    dir: def.dir === true,
    blob: def.dir ? null : new Blob([def.bytes]),
  }));
}

/** Deterministic pseudo-random bytes of length n. */
export function bytesOf(n, seed = 0) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (seed + i) % 256;
  return out;
}
