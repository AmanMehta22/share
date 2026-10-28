import { RTC_CONFIG, CONNECTION_TIMEOUT_MS, BUFFER_LOW_WATER } from '../config.js';

/**
 * WebRTC peer negotiation.
 *
 * The signaling server only relays SDP and ICE candidates; the actual media /
 * data flows directly between the two browsers, encrypted with DTLS as part of
 * the standard WebRTC handshake. This module never touches file contents.
 *
 * Roles are fixed to avoid offer/answer glare:
 *   sender  -> creates the DataChannel and the offer
 *   receiver -> waits for the offer, answers, receives the DataChannel
 */

export class ConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

export const DATA_CHANNEL_LABEL = 'codeshare';

/** Human-readable labels for RTCPeerConnection states (used by the UI and tests). */
export const CONNECTION_STATE_LABELS = Object.freeze({
  new: 'Starting',
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Reconnecting',
  failed: 'Failed',
  closed: 'Closed',
});

/** True when a state means the connection will not recover on its own. */
export function isTerminalConnectionState(state) {
  return state === 'failed' || state === 'closed';
}

export function supportsWebRTC() {
  return (
    typeof window !== 'undefined' &&
    typeof window.RTCPeerConnection === 'function' &&
    typeof window.RTCDataChannel === 'function'
  );
}

export class PeerSession {
  /**
   * @param {{
   *   role: 'sender'|'receiver',
   *   config?: RTCConfiguration,
   *   emitSignal: (signal:object) => Promise<void>|void,
   *   onDataChannel: (channel:RTCDataChannel) => void,
   *   onStateChange?: (state:string, detail?:object) => void,
   *   onError?: (error:ConnectionError) => void,
   *   timeoutMs?: number,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.role = options.role;
    this.rtcConfig = options.config ?? RTC_CONFIG;
    this.emitSignal = options.emitSignal;
    this.onDataChannel = options.onDataChannel;
    this.onStateChange = options.onStateChange ?? (() => {});
    this.onError = options.onError ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? CONNECTION_TIMEOUT_MS;

    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    /** @type {RTCDataChannel|null} */
    this.channel = null;

    this.state = 'new';
    this.closed = false;

    this.#queue = [];
    this.#candidates = [];
    this.#flushing = false;
    this.#timer = null;
  }

  #queue;
  #candidates;
  #flushing;
  #timer;

  #setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange(state, detail);
  }

  #fail(code, message) {
    if (this.closed) return;
    const error = new ConnectionError(code, message);
    try {
      this.onError(error);
    } finally {
      this.close(code);
    }
  }

  #armTimeout() {
    this.#clearTimeout();
    this.#timer = setTimeout(() => {
      if (this.closed || this.channel) return;
      this.#fail(
        'TIMEOUT',
        'Could not establish a direct connection in time. This usually means a restrictive NAT, ' +
          'firewall or corporate network is blocking peer-to-peer traffic.'
      );
    }, this.timeoutMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  #clearTimeout() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** Create the peer connection, the data channel (sender) and start ICE. */
  async start() {
    if (this.closed) throw new ConnectionError('CLOSED', 'Session already closed.');
    if (typeof window === 'undefined' || typeof window.RTCPeerConnection !== 'function') {
      throw new ConnectionError(
        'UNSUPPORTED_BROWSER',
        'This browser does not support WebRTC. Try an up-to-date version of Chrome, Edge, Firefox or Safari.'
      );
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.pc = pc;
    this.#setState('connecting');

    pc.onicecandidate = (event) => {
      if (this.closed || !event.candidate) return;
      let payload;
      try {
        payload = event.candidate.toJSON();
      } catch {
        return;
      }
      Promise.resolve(this.emitSignal({ kind: 'candidate', candidate: payload })).catch((error) => {
        this.#fail('SIGNAL_FAILED', `Could not exchange connection details: ${error?.message ?? error}`);
      });
    };

    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = pc.connectionState;
      if (state === 'failed') {
        this.#fail(
          'ICE_FAILED',
          'A direct peer-to-peer connection could not be established on these networks. ' +
            'Some NAT types and firewalls require a TURN relay, which CodeShare does not use.'
        );
        return;
      }
      if (state === 'disconnected') this.#setState('disconnected');
      // Only report "connected" when the DATA CHANNEL is open, not merely the
      // peer connection: ICE+DTLS can complete a beat before SCTP finishes
      // opening the channel, and consumers treat "connected" as "safe to
      // send". Reporting it early made the sender engine start on a
      // still-connecting channel and instantly fail with PEER_CLOSED
      // (reproducible on loopback, where that window is hit almost every
      // time). The channel's own 'open' event is the authoritative trigger.
      if (state === 'connected' && this.channel && this.channel.readyState === 'open') {
        this.#setState('connected');
      }
      if (state === 'closed') this.close('pc-closed');
    };

    pc.oniceconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.iceConnectionState === 'failed') {
        this.#fail(
          'ICE_FAILED',
          'Network address traversal failed: the two computers could not reach each other directly.'
        );
      }
    };

    if (this.role === 'receiver') {
      pc.ondatachannel = (event) => this.#adoptChannel(event.channel);
      this.#armTimeout();
    } else {
      const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, {
        ordered: true,
        // Chunked transfer makes negotiation mandatory unreliable mode pointless;
        // ordered + reliable keeps byte integrity simple to verify.
      });
      this.#adoptChannel(channel);
      this.#armTimeout();

      const offer = await pc.createOffer();
      if (this.closed) return;
      await pc.setLocalDescription(offer);
      if (this.closed) return;
      await this.emitSignal({ kind: 'offer', sdp: offer.sdp });
    }

    // Any signal that arrived before the connection existed goes first.
    await this.#flushQueue();
  }

  /** Accept an incoming signal from the peer (via the signaling server). */
  async handleSignal(signal) {
    if (this.closed || !signal || typeof signal !== 'object') return;
    this.#queue.push(signal);
    if (!this.pc || this.#flushing) return;
    await this.#flushQueue();
  }

  async #flushQueue() {
    if (this.#flushing || !this.pc || this.closed) return;
    this.#flushing = true;
    try {
      while (this.#queue.length > 0 && !this.closed) {
        const signal = this.#queue.shift();
        await this.#applySignal(signal);
      }
    } catch (error) {
      this.#fail('SIGNAL_ERROR', `Failed to apply connection details: ${error?.message ?? error}`);
    } finally {
      this.#flushing = false;
    }
  }

  async #applySignal(signal) {
    const pc = this.pc;
    if (!pc) return;

    if (signal.kind === 'offer') {
      if (this.role !== 'receiver') return;
      if (pc.signalingState !== 'stable') return; // duplicates / renegotiation unsupported
      if (typeof signal.sdp !== 'string' || signal.sdp.length === 0) {
        throw new ConnectionError('INVALID_SDP', 'Received a malformed offer.');
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await this.#flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.emitSignal({ kind: 'answer', sdp: answer.sdp });
      return;
    }

    if (signal.kind === 'answer') {
      if (this.role !== 'sender') return;
      if (pc.signalingState !== 'have-local-offer') return;
      if (typeof signal.sdp !== 'string' || signal.sdp.length === 0) {
        throw new ConnectionError('INVALID_SDP', 'Received a malformed answer.');
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      await this.#flushCandidates();
      return;
    }

    if (signal.kind === 'candidate') {
      const candidate = signal.candidate;
      if (!candidate || typeof candidate !== 'object') return;
      if (!pc.remoteDescription) {
        this.#candidates.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        // A single bad candidate must not abort the whole connection.
        console.warn('ignoring ICE candidate', error?.message ?? error);
      }
    }
  }

  async #flushCandidates() {
    const pending = this.#candidates;
    this.#candidates = [];
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn('ignoring buffered ICE candidate', error?.message ?? error);
      }
    }
  }

  #adoptChannel(channel) {
    if (this.channel) return;
    this.channel = channel;
    try {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    } catch {
      /* non-fatal */
    }

    // Expose the channel to the consumer BEFORE any open event can fire, so
    // listeners are always in place when the channel becomes usable.
    try {
      this.onDataChannel(channel);
    } catch (error) {
      this.#fail('CHANNEL_SETUP', `Could not initialize the data channel: ${error?.message ?? error}`);
      return;
    }

    const handleOpen = () => {
      if (this.closed) return;
      this.#clearTimeout();
      this.#setState('connected');
    };
    if (channel.readyState === 'open') handleOpen();
    else channel.addEventListener('open', handleOpen, { once: true });

    this.#clearTimeout();
    this.#armTimeout();
  }

  /** Tear down channels, timers and listeners. Idempotent. */
  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.#clearTimeout();
    this.#queue = [];
    this.#candidates = [];

    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        /* already closed */
      }
    }
    if (this.pc) {
      try {
        this.pc.onicecandidate = null;
        this.pc.ondatachannel = null;
        this.pc.onconnectionstatechange = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.close();
      } catch {
        /* already closed */
      }
    }
    this.#setState('closed', { reason });
  }
}
