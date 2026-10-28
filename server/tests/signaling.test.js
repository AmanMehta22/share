import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import { attachSignaling } from '../src/services/signaling.js';
import { SessionStore } from '../src/services/sessionStore.js';

/**
 * End-to-end signaling tests over real loopback sockets.
 *
 * These exercise the actual Socket.IO contract the browser uses:
 * ack shapes ({ok:true,...} / {ok:false,error,message}), peer events and
 * membership rules. No WebRTC here - that needs two real browsers and is
 * covered by the manual checklist in the README.
 */

const CODE_A = 'ABCD-EFGH-JKMN-PQRS';
const CODE_B_REAL = 'BCDE-FGHJ-KMNP-QRST';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let httpServer;
let io;
let url;
const stores = [];

function makeConfig(overrides = {}) {
  return {
    sessionTtlMs: 60_000,
    maxSignalsPerMinute: 600,
    trustProxy: false,
    ...overrides,
  };
}

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, {
    cors: { origin: '*' },
    serveClient: false,
  });
  const store = new SessionStore({ ttlMs: 60_000, maxJoinAttempts: 5 });
  stores.push(store);
  attachSignaling(io, { store, config: makeConfig(), logger });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  for (const store of stores) store.stopSweeper();
  io?.close();
  await new Promise((resolve) => httpServer?.close(resolve));
});

beforeEach(() => {
  for (const store of stores) {
    store.sessions.clear();
    store.byCodeHash.clear();
    store.joinFailures.clear();
    store.ipFailures.clear();
  }
});

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = clientIo(url, { transports: ['websocket'], forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function request(socket, event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function disconnect(socket) {
  return new Promise((resolve) => {
    if (!socket.connected) return resolve();
    socket.once('disconnect', resolve);
    socket.disconnect();
  });
}

async function connectedPair() {
  const a = await connectClient();
  const b = await connectClient();
  return { a, b };
}

describe('session:create', () => {
  it('creates a session and returns sessionId + expiresAt', async () => {
    const socket = await connectClient();
    const response = await request(socket, 'session:create', { code: CODE_A });
    expect(response.ok).toBe(true);
    expect(typeof response.sessionId).toBe('string');
    expect(response.expiresAt).toBeGreaterThan(Date.now());
    await disconnect(socket);
  });

  it('normalizes sloppy code input', async () => {
    const socket = await connectClient();
    const response = await request(socket, 'session:create', { code: 'abcd efgH jkmn pqrs' });
    expect(response.ok).toBe(true);
    await disconnect(socket);
  });

  it('rejects an invalid code', async () => {
    const socket = await connectClient();
    const response = await request(socket, 'session:create', { code: 'not-a-code' });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('INVALID_CODE');
    await disconnect(socket);
  });

  it('rejects a second session on the same socket', async () => {
    const socket = await connectClient();
    expect((await request(socket, 'session:create', { code: CODE_A })).ok).toBe(true);
    const second = await request(socket, 'session:create', { code: CODE_B_REAL });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('ALREADY_IN_SESSION');
    await disconnect(socket);
  });

  it('never echoes the raw code back', async () => {
    const socket = await connectClient();
    const response = await request(socket, 'session:create', { code: CODE_A });
    expect(JSON.stringify(response)).not.toContain(CODE_A);
    await disconnect(socket);
  });
});

describe('session:join', () => {
  it('joins an existing session and notifies the sender', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    const joinedPromise = waitFor(a, 'peer:joined');
    const response = await request(b, 'session:join', { code: CODE_A });
    expect(response.ok).toBe(true);
    expect(response.senderOnline).toBe(true);
    const joined = await joinedPromise;
    expect(joined.state).toBe('paired');
    await disconnect(a);
    await disconnect(b);
  });

  it('rejects an unknown code with NOT_FOUND', async () => {
    const b = await connectClient();
    const response = await request(b, 'session:join', { code: CODE_B_REAL });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('NOT_FOUND');
    await disconnect(b);
  });

  it('rejects a second receiver with RECEIVER_TAKEN', async () => {
    const { a, b } = await connectedPair();
    const c = await connectClient();
    await request(a, 'session:create', { code: CODE_A });
    expect((await request(b, 'session:join', { code: CODE_A })).ok).toBe(true);
    const second = await request(c, 'session:join', { code: CODE_A });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('RECEIVER_TAKEN');
    await disconnect(a);
    await disconnect(b);
    await disconnect(c);
  });

  it('rejects an invalid code format', async () => {
    const b = await connectClient();
    const response = await request(b, 'session:join', { code: 'XX' });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('INVALID_CODE');
    await disconnect(b);
  });
});

describe('session:approve', () => {
  it('approves the receiver and emits peer:approved', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    const approvedPromise = waitFor(b, 'peer:approved');
    const response = await request(a, 'session:approve');
    expect(response.ok).toBe(true);
    await approvedPromise;
    await disconnect(a);
    await disconnect(b);
  });

  it('the receiver cannot approve', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    const response = await request(b, 'session:approve');
    expect(response.ok).toBe(false);
    expect(response.error).toBe('FORBIDDEN');
    await disconnect(a);
    await disconnect(b);
  });

  it('approving with no receiver is INVALID_STATE', async () => {
    const a = await connectClient();
    await request(a, 'session:create', { code: CODE_A });
    const response = await request(a, 'session:approve');
    expect(response.ok).toBe(false);
    expect(response.error).toBe('INVALID_STATE');
    await disconnect(a);
  });
});

describe('session:signal', () => {
  async function approvedSession() {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    await request(a, 'session:approve');
    return { a, b };
  }

  it('relays an SDP offer from sender to receiver', async () => {
    const { a, b } = await approvedSession();
    const signalPromise = waitFor(b, 'signal');
    const response = await request(a, 'session:signal', {
      signal: { kind: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' },
    });
    expect(response.ok).toBe(true);
    const relayed = await signalPromise;
    expect(relayed.from).toBe('sender');
    expect(relayed.signal.kind).toBe('offer');
    await disconnect(a);
    await disconnect(b);
  });

  it('relays an answer from receiver to sender', async () => {
    const { a, b } = await approvedSession();
    const signalPromise = waitFor(a, 'signal');
    const response = await request(b, 'session:signal', {
      signal: { kind: 'answer', sdp: 'v=0\r\n' },
    });
    expect(response.ok).toBe(true);
    const relayed = await signalPromise;
    expect(relayed.from).toBe('receiver');
    expect(relayed.signal.kind).toBe('answer');
    await disconnect(a);
    await disconnect(b);
  });

  it('relays ICE candidates', async () => {
    const { a, b } = await approvedSession();
    const signalPromise = waitFor(b, 'signal');
    const response = await request(a, 'session:signal', {
      signal: { kind: 'candidate', candidate: { candidate: 'candidate:1 1 udp 2113937151 192.168.1.2 54321 typ host' } },
    });
    expect(response.ok).toBe(true);
    const relayed = await signalPromise;
    expect(relayed.signal.kind).toBe('candidate');
    await disconnect(a);
    await disconnect(b);
  });

  it('rejects signaling before approval', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    const response = await request(a, 'session:signal', { signal: { kind: 'offer', sdp: 'v=0' } });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('INVALID_STATE');
    await disconnect(a);
    await disconnect(b);
  });

  it('rejects malformed signal payloads', async () => {
    const { a, b } = await approvedSession();
    for (const bad of [
      null,
      'string',
      [],
      { kind: 'unknown' },
      { kind: 'offer' }, // missing sdp
      { kind: 'offer', sdp: '' },
      { kind: 'candidate', candidate: 'not-an-object' },
    ]) {
      const response = await request(a, 'session:signal', { signal: bad });
      expect(response.ok).toBe(false);
      expect(response.error).toBe('INVALID_SIGNAL');
    }
    await disconnect(a);
    await disconnect(b);
  });

  it('rejects an oversized SDP', async () => {
    const { a, b } = await approvedSession();
    const response = await request(a, 'session:signal', {
      signal: { kind: 'offer', sdp: 'x'.repeat(100_001) },
    });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('INVALID_SIGNAL');
    await disconnect(a);
    await disconnect(b);
  });

  it('rejects a non-member trying to signal into a session', async () => {
    const { a, b } = await approvedSession();
    const intruder = await connectClient();
    // The intruder has no session; signal fails with NO_SESSION (they never joined).
    const response = await request(intruder, 'session:signal', { signal: { kind: 'offer', sdp: 'v=0' } });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('NO_SESSION');
    await disconnect(a);
    await disconnect(b);
    await disconnect(intruder);
  });
});

describe('session:active', () => {
  it('marks the session active after approval', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    await request(a, 'session:approve');
    const response = await request(a, 'session:active');
    expect(response.ok).toBe(true);
    await disconnect(a);
    await disconnect(b);
  });

  it('the receiver cannot mark active', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    await request(a, 'session:approve');
    const response = await request(b, 'session:active');
    expect(response.ok).toBe(false);
    expect(response.error).toBe('FORBIDDEN');
    await disconnect(a);
    await disconnect(b);
  });
});

describe('session:cancel', () => {
  it('notifies the peer and closes the session', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    const cancelledPromise = waitFor(b, 'peer:cancelled');
    const response = await request(a, 'session:cancel', { reason: 'sender changed mind' });
    expect(response.ok).toBe(true);
    const cancelled = await cancelledPromise;
    expect(cancelled.by).toBe('sender');
    expect(cancelled.reason).toBe('sender changed mind');
    await disconnect(a);
    await disconnect(b);
  });

  it('is safe to cancel with no session (idempotent)', async () => {
    const a = await connectClient();
    const response = await request(a, 'session:cancel', {});
    expect(response.ok).toBe(true);
    await disconnect(a);
  });
});

describe('disconnect handling', () => {
  it('receiver disconnecting while waiting frees the slot for a re-join', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    const waitingAgain = waitFor(a, 'peer:waiting-again');
    await disconnect(b);
    await waitingAgain;

    // A fresh receiver (page refresh) can now join the same code.
    const c = await connectClient();
    const response = await request(c, 'session:join', { code: CODE_A });
    expect(response.ok).toBe(true);
    await disconnect(a);
    await disconnect(c);
  });

  it('sender disconnecting closes the session and notifies the receiver', async () => {
    const { a, b } = await connectedPair();
    await request(a, 'session:create', { code: CODE_A });
    await request(b, 'session:join', { code: CODE_A });
    const disconnected = waitFor(b, 'peer:disconnected');
    await disconnect(a);
    const payload = await disconnected;
    expect(payload.role).toBe('sender');
    await disconnect(b);
  });
});

describe('one-to-many (group) sessions', () => {
  async function startGroup(maxReceivers = 3) {
    const a = await connectClient();
    const created = await request(a, 'session:create', { code: CODE_A, mode: 'group', maxReceivers });
    expect(created.ok).toBe(true);
    return { a, created };
  }

  async function joinReceiver() {
    const socket = await connectClient();
    const response = await request(socket, 'session:join', { code: CODE_A });
    expect(response.ok).toBe(true);
    return { socket, receiverId: response.receiverId };
  }

  /** Resolves true if the event arrives within 200 ms, otherwise false. */
  function expectSilence(socket, event) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.off(event, onEvent);
        resolve(false);
      }, 200);
      const onEvent = () => {
        clearTimeout(timer);
        resolve(true);
      };
      socket.once(event, onEvent);
    });
  }

  it('creates a group session and echoes mode + maxReceivers', async () => {
    const { a, created } = await startGroup(2);
    expect(created.mode).toBe('group');
    expect(created.maxReceivers).toBe(2);
    await disconnect(a);
  });

  it('rejects an unknown mode with INVALID_MODE', async () => {
    const a = await connectClient();
    const response = await request(a, 'session:create', { code: CODE_A, mode: 'broadcast' });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('INVALID_MODE');
    await disconnect(a);
  });

  it('lets several receivers join and reports capacity in peer:joined', async () => {
    const { a } = await startGroup(3);
    const firstJoined = waitFor(a, 'peer:joined');
    const r1 = await joinReceiver();
    const joinedPayload = await firstJoined;
    expect(joinedPayload.receiverId).toBe(r1.receiverId);
    expect(joinedPayload.receivers).toBe(1);
    expect(joinedPayload.maxReceivers).toBe(3);

    const r2 = await joinReceiver();
    expect(r2.receiverId).not.toBe(r1.receiverId);
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
  });

  it('rejects the next join with SESSION_FULL at capacity', async () => {
    const { a } = await startGroup(2);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    const overflow = await connectClient();
    const response = await request(overflow, 'session:join', { code: CODE_A });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('SESSION_FULL');
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
    await disconnect(overflow);
  });

  it('approves one receiver by receiverId without touching the others', async () => {
    const { a } = await startGroup(2);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    const approvedPromise = waitFor(r1.socket, 'peer:approved');
    const response = await request(a, 'session:approve', { receiverId: r1.receiverId });
    expect(response.ok).toBe(true);
    expect(response.receiverId).toBe(r1.receiverId);
    await approvedPromise;
    expect(await expectSilence(r2.socket, 'peer:approved')).toBe(false);
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
  });

  it('approve-all approves every waiting receiver', async () => {
    const { a } = await startGroup(3);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    const got1 = waitFor(r1.socket, 'peer:approved');
    const got2 = waitFor(r2.socket, 'peer:approved');
    const response = await request(a, 'session:approve-all');
    expect(response.ok).toBe(true);
    expect(response.approved).toBe(2);
    await got1;
    await got2;
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
  });

  it('routes sender signals to the chosen receiver only', async () => {
    const { a } = await startGroup(2);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    await request(a, 'session:approve-all');

    const gotSignal = waitFor(r2.socket, 'signal');
    const response = await request(a, 'session:signal', {
      receiverId: r2.receiverId,
      signal: { kind: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' },
    });
    expect(response.ok).toBe(true);
    const relayed = await gotSignal;
    expect(relayed.from).toBe('sender');
    // The other receiver must not see this offer.
    expect(await expectSilence(r1.socket, 'signal')).toBe(false);
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
  });

  it('tags receiver signals with peerId so the sender can route answers', async () => {
    const { a } = await startGroup(2);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    await request(a, 'session:approve-all');

    const fromR2 = waitFor(a, 'signal');
    await request(r2.socket, 'session:signal', { signal: { kind: 'answer', sdp: 'v=0\r\n' } });
    const relayedR2 = await fromR2;
    expect(relayedR2.from).toBe('receiver');
    expect(relayedR2.peerId).toBe(r2.receiverId);

    const fromR1 = waitFor(a, 'signal');
    await request(r1.socket, 'session:signal', { signal: { kind: 'answer', sdp: 'v=0\r\n' } });
    const relayedR1 = await fromR1;
    expect(relayedR1.peerId).toBe(r1.receiverId);
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
  });

  it('rejects a group signal without a receiverId (INVALID_TARGET)', async () => {
    const { a } = await startGroup(2);
    const r1 = await joinReceiver();
    await request(a, 'session:approve', { receiverId: r1.receiverId });
    const response = await request(a, 'session:signal', { signal: { kind: 'offer', sdp: 'v=0\r\n' } });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('INVALID_TARGET');
    await disconnect(a);
    await disconnect(r1.socket);
  });

  it('a receiver cancelling in group mode only removes that receiver', async () => {
    const { a } = await startGroup(3);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    await request(a, 'session:approve-all');

    const senderSaw = waitFor(a, 'peer:cancelled');
    const response = await request(r2.socket, 'session:cancel', { reason: 'changed my mind' });
    expect(response.ok).toBe(true);
    expect(response.left).toBe(true);
    const cancelled = await senderSaw;
    expect(cancelled.by).toBe('receiver');
    expect(cancelled.receiverId).toBe(r2.receiverId);

    // The session is still alive: r1 can keep signaling.
    const stillWorks = await request(a, 'session:signal', {
      receiverId: r1.receiverId,
      signal: { kind: 'offer', sdp: 'v=0\r\n' },
    });
    expect(stillWorks.ok).toBe(true);
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
  });

  it('an approved receiver disconnecting mid-flow notifies the sender and the session survives', async () => {
    const { a } = await startGroup(3);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    await request(a, 'session:approve', { receiverId: r2.receiverId });

    const disconnected = waitFor(a, 'peer:disconnected');
    await disconnect(r2.socket);
    const payload = await disconnected;
    expect(payload.role).toBe('receiver');
    expect(payload.receiverId).toBe(r2.receiverId);

    // A new receiver can still join with the same code.
    const r3 = await joinReceiver();
    expect(r3.receiverId).not.toBe(r2.receiverId);
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r3.socket);
  });

  it('a waiting receiver disconnecting frees only its slot (peer:waiting-again)', async () => {
    const { a } = await startGroup(2);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    const waitingAgain = waitFor(a, 'peer:waiting-again');
    await disconnect(r1.socket);
    const payload = await waitingAgain;
    expect(payload.receiverId).toBe(r1.receiverId);
    // r2 is untouched and can still be approved.
    const approved = await request(a, 'session:approve', { receiverId: r2.receiverId });
    expect(approved.ok).toBe(true);
    await disconnect(a);
    await disconnect(r2.socket);
  });

  it('the sender cancelling notifies every receiver', async () => {
    const { a } = await startGroup(3);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    const got1 = waitFor(r1.socket, 'peer:cancelled');
    const got2 = waitFor(r2.socket, 'peer:cancelled');
    const response = await request(a, 'session:cancel', { reason: 'sender stopped' });
    expect(response.ok).toBe(true);
    expect((await got1).by).toBe('sender');
    expect((await got2).by).toBe('sender');
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
  });

  it('markActive per receiver keeps the session alive for the others', async () => {
    const { a } = await startGroup(2);
    const r1 = await joinReceiver();
    const r2 = await joinReceiver();
    await request(a, 'session:approve-all');
    const active = await request(a, 'session:active', { receiverId: r1.receiverId });
    expect(active.ok).toBe(true);
    // Signaling for r1 still works (active state allows it).
    const stillWorks = await request(a, 'session:signal', {
      receiverId: r1.receiverId,
      signal: { kind: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.2 1 typ host' } },
    });
    expect(stillWorks.ok).toBe(true);
    // r2 is still only approved -> also allowed.
    const alsoWorks = await request(a, 'session:signal', {
      receiverId: r2.receiverId,
      signal: { kind: 'candidate', candidate: { candidate: 'candidate:2 1 udp 1 192.168.1.3 2 typ host' } },
    });
    expect(alsoWorks.ok).toBe(true);
    await disconnect(a);
    await disconnect(r1.socket);
    await disconnect(r2.socket);
  });
});

describe('validation of signal payloads (unit)', () => {
  it('accepts a minimal valid offer', async () => {
    const { validateSignalPayload } = await import('../src/services/signaling.js');
    expect(validateSignalPayload({ kind: 'offer', sdp: 'v=0' }).valid).toBe(true);
  });
});
