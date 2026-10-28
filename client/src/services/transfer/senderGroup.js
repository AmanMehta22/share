import { SenderTransfer } from './sender.js';

/**
 * Orchestrates N independent SenderTransfer engines, one per receiver of a
 * one-to-many ("group") transfer.
 *
 * Each receiver has its own WebRTC data channel, so each gets its own engine
 * with its own manifest, consent gate, progress and outcome. This class only
 * fans out and aggregates:
 *  - `startPeer(receiverId, {channel, files})` spins up an engine per receiver
 *  - pause/resume/cancel act on one receiver or on all of them
 *  - aggregate events report per-receiver results and, once every started peer
 *    is terminal, a single `group-result` with an honest per-receiver summary
 *
 * Transport-agnostic like the engines themselves: tests drive it with fake
 * in-memory channels.
 */

export const GROUP_PEER_STATE = Object.freeze({
  CONNECTING: 'connecting',
  AWAITING_ACCEPT: 'awaiting-accept',
  TRANSFERRING: 'transferring',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

const TERMINAL_PEER_STATES = new Set([
  GROUP_PEER_STATE.COMPLETED,
  GROUP_PEER_STATE.REJECTED,
  GROUP_PEER_STATE.CANCELLED,
  GROUP_PEER_STATE.FAILED,
]);

function stateForStatus(status) {
  switch (status) {
    case 'complete':
      return GROUP_PEER_STATE.COMPLETED;
    case 'rejected':
      return GROUP_PEER_STATE.REJECTED;
    case 'cancelled':
      return GROUP_PEER_STATE.CANCELLED;
    default:
      return GROUP_PEER_STATE.FAILED;
  }
}

export class SenderGroup {
  /** @param {{onEvent?: (event:object) => void}} [options] */
  constructor(options = {}) {
    this.onEvent = options.onEvent ?? (() => {});
    /** @type {Map<string, object>} receiverId -> peer record */
    this.peers = new Map();
    this.groupResultEmitted = false;
  }

  /** How many receivers have an engine running (started transfers). */
  get size() {
    return this.peers.size;
  }

  /** True once every started peer reached a terminal outcome (and >=1 started). */
  get allTerminal() {
    if (this.peers.size === 0) return false;
    for (const peer of this.peers.values()) {
      if (!TERMINAL_PEER_STATES.has(peer.state)) return false;
    }
    return true;
  }

  #snapshot(peer) {
    return {
      id: peer.id,
      state: peer.state,
      sentBytes: peer.sentBytes,
      totalBytes: peer.totalBytes,
      paused: peer.paused === true,
      result: peer.result,
      error: peer.error,
    };
  }

  #emit(event) {
    try {
      this.onEvent(event);
    } catch (error) {
      console.warn('group event handler failed', error);
    }
  }

  /**
   * Start sending the manifest and files to one approved receiver.
   * @param {string} receiverId
   * @param {{channel: object, files: object[], chunkSize?: number, highWater?: number, limits?: object}} options
   * @returns {SenderTransfer} the engine for this receiver
   */
  startPeer(receiverId, { channel, files, chunkSize, highWater, limits }) {
    if (typeof receiverId !== 'string' || !receiverId) {
      throw new Error('startPeer requires a receiverId.');
    }
    if (this.peers.has(receiverId)) {
      throw new Error(`Receiver "${receiverId}" already has a transfer in this group.`);
    }

    const engine = new SenderTransfer({
      channel,
      files,
      chunkSize,
      highWater,
      limits,
      onEvent: (event) => this.#onEngineEvent(receiverId, event),
    });

    const peer = {
      id: receiverId,
      state: GROUP_PEER_STATE.AWAITING_ACCEPT,
      engine,
      sentBytes: 0,
      totalBytes: engine.totalBytes,
      paused: false,
      result: null,
      error: null,
    };
    this.peers.set(receiverId, peer);
    this.#emit({ type: 'peer-started', receiverId, peer: this.#snapshot(peer) });

    engine
      .run()
      .then((result) => this.#onEngineResult(receiverId, result))
      .catch((error) =>
        this.#onEngineResult(receiverId, {
          status: 'failed',
          error,
          reason: error?.message,
          sentBytes: engine.sentBytes,
          totalBytes: engine.totalBytes,
        })
      );

    return engine;
  }

  #onEngineEvent(receiverId, event) {
    const peer = this.peers.get(receiverId);
    if (!peer) return;
    switch (event.type) {
      case 'progress':
        peer.sentBytes = event.sentBytes;
        peer.totalBytes = event.totalBytes;
        peer.paused = event.paused === true;
        break;
      case 'accepted':
        peer.state = GROUP_PEER_STATE.TRANSFERRING;
        break;
      case 'paused':
        peer.paused = true;
        break;
      case 'resumed':
        peer.paused = false;
        break;
      default:
        break;
    }
    this.#emit({ type: 'peer-event', receiverId, event, peer: this.#snapshot(peer) });
  }

  #onEngineResult(receiverId, result) {
    const peer = this.peers.get(receiverId);
    if (!peer || TERMINAL_PEER_STATES.has(peer.state)) return;
    peer.state = stateForStatus(result?.status);
    peer.result = result ?? null;
    peer.error = result?.error ?? null;
    if (typeof result?.sentBytes === 'number') peer.sentBytes = result.sentBytes;
    peer.paused = false;
    this.#emit({ type: 'peer-result', receiverId, result, peer: this.#snapshot(peer) });
    this.#maybeEmitGroupResult();
  }

  #maybeEmitGroupResult() {
    if (this.groupResultEmitted || !this.allTerminal) return;
    this.groupResultEmitted = true;
    const summary = this.summary();
    this.#emit({ type: 'group-result', status: summary.status, results: summary.results });
  }

  /** Pause one receiver's transfer (no-op if it already finished). */
  pause(receiverId) {
    const peer = this.peers.get(receiverId);
    if (peer && !TERMINAL_PEER_STATES.has(peer.state)) peer.engine.pause('sender');
  }

  resume(receiverId) {
    const peer = this.peers.get(receiverId);
    if (peer && !TERMINAL_PEER_STATES.has(peer.state)) peer.engine.resume('sender');
  }

  pauseAll() {
    for (const peer of this.peers.values()) {
      if (!TERMINAL_PEER_STATES.has(peer.state)) peer.engine.pause('sender');
    }
  }

  resumeAll() {
    for (const peer of this.peers.values()) {
      if (!TERMINAL_PEER_STATES.has(peer.state)) peer.engine.resume('sender');
    }
  }

  cancel(receiverId, reason = 'Cancelled by the sender') {
    const peer = this.peers.get(receiverId);
    if (peer && !TERMINAL_PEER_STATES.has(peer.state)) peer.engine.cancel(reason, 'sender');
  }

  cancelAll(reason = 'Cancelled by the sender') {
    for (const peer of this.peers.values()) {
      if (!TERMINAL_PEER_STATES.has(peer.state)) peer.engine.cancel(reason, 'sender');
    }
  }

  /** Snapshot of every started peer, in start order. */
  snapshot() {
    return [...this.peers.values()].map((peer) => this.#snapshot(peer));
  }

  /**
   * Honest per-receiver outcome summary.
   * @returns {null | {status:'complete'|'cancelled'|'failed', results: object[]}}
   *   null until at least one peer started and every started peer is terminal.
   */
  summary() {
    if (!this.allTerminal) return null;
    const results = this.snapshot();
    const anyComplete = results.some((peer) => peer.state === GROUP_PEER_STATE.COMPLETED);
    const anyCancelled = results.some((peer) => peer.state === GROUP_PEER_STATE.CANCELLED);
    const status = anyComplete ? 'complete' : anyCancelled ? 'cancelled' : 'failed';
    return { status, results };
  }
}

export function createSenderGroup(options) {
  return new SenderGroup(options);
}
