import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PeerSession, ConnectionError } from '../src/services/webrtc.js';
import { FakeChannel } from './helpers/fakeChannel.js';

/**
 * Regression tests for PeerSession's "connected" reporting.
 *
 * ICE+DTLS (the peer connection) can complete a beat before SCTP finishes
 * opening the data channel. Consumers treat "connected" as "safe to send",
 * so PeerSession must only report it when the DATA CHANNEL is open —
 * otherwise the sender engine starts on a still-connecting channel, its
 * first assertOpen() throws PEER_CLOSED ("The connection to the peer was
 * lost.") and the transfer dies instantly. On loopback (two browsers on one
 * machine) that window is hit almost every time.
 */

/** Minimal RTCPeerConnection double whose connectionState we drive by hand. */
class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.remoteDescription = null;
    this.channels = [];
    this.closedByUs = false;
  }

  createDataChannel(label) {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0 fake-offer' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0 fake-answer' };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.signalingState = 'stable';
  }

  async addIceCandidate() {
    /* pretend the candidate applied */
  }

  close() {
    this.closedByUs = true;
    this.connectionState = 'closed';
  }

  /** Drive connectionState and fire the handler, like a real browser event. */
  setConnectionState(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function makeSession(role, states) {
  return new PeerSession({
    role,
    emitSignal: async () => {},
    onDataChannel: () => {},
    onStateChange: (state) => states.push(state),
    onError: (error) => states.push(`error:${error.code}`),
    timeoutMs: 60_000,
  });
}

describe('PeerSession connected-state reporting', () => {
  let originals;

  beforeEach(() => {
    originals = {
      window: globalThis.window,
      RTCPeerConnection: globalThis.RTCPeerConnection,
      RTCDataChannel: globalThis.RTCDataChannel,
    };
    globalThis.window = globalThis;
    globalThis.RTCPeerConnection = FakePeerConnection;
    globalThis.RTCDataChannel = FakeChannel;
  });

  afterEach(() => {
    globalThis.window = originals.window;
    globalThis.RTCPeerConnection = originals.RTCPeerConnection;
    globalThis.RTCDataChannel = originals.RTCDataChannel;
  });

  it('does not report connected when the peer connection connects before the data channel opens', async () => {
    const states = [];
    const session = makeSession('sender', states);
    await session.start();

    // The channel exists but is still negotiating SCTP.
    expect(session.channel).toBeTruthy();
    expect(session.channel.readyState).toBe('connecting');

    // ICE+DTLS finish: the peer connection is "connected" ...
    session.pc.setConnectionState('connected');
    // ... but the data channel is not open yet.
    expect(session.channel.readyState).toBe('connecting');
    expect(states).not.toContain('connected');
    expect(session.state).toBe('connecting');

    // The channel's own open event is the authoritative trigger.
    session.channel.open();
    expect(session.state).toBe('connected');
    expect(states).toContain('connected');

    session.close();
  });

  it('reports connected on peer-connection connect when the channel is already open', async () => {
    const states = [];
    const session = makeSession('receiver', states);
    await session.start();

    // Sender's channel arrives via ondatachannel and opens immediately
    // (e.g. the answer was applied before this handler attached).
    const channel = new FakeChannel('codeshare');
    session.pc.ondatachannel({ channel });
    channel.open();
    expect(session.state).toBe('connected');

    // The later peer-connection "connected" event must not break anything.
    session.pc.setConnectionState('connected');
    expect(session.state).toBe('connected');

    session.close();
  });

  it('still reports disconnected and failed from the peer connection state', async () => {
    const states = [];
    const session = makeSession('sender', states);
    await session.start();

    session.pc.setConnectionState('connected');
    session.channel.open();
    expect(session.state).toBe('connected');

    session.pc.setConnectionState('disconnected');
    expect(session.state).toBe('disconnected');

    // ICE failure surfaces through onError and closes the session.
    session.pc.setConnectionState('failed');
    expect(session.state).toBe('closed');
    expect(states).toContain('error:ICE_FAILED');
  });

  it('emits connected exactly once per channel open', async () => {
    const states = [];
    const session = makeSession('sender', states);
    await session.start();

    session.channel.open();
    session.pc.setConnectionState('connected');
    session.channel.open(); // duplicate open must be a no-op
    expect(states.filter((s) => s === 'connected')).toHaveLength(1);

    session.close();
  });

  it('rejects start() on unsupported browsers', async () => {
    const session = new PeerSession({
      role: 'sender',
      emitSignal: async () => {},
      onDataChannel: () => {},
    });
    globalThis.window = {};
    globalThis.RTCPeerConnection = undefined;
    await expect(session.start()).rejects.toBeInstanceOf(ConnectionError);
  });
});
