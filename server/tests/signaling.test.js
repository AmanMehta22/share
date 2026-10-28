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

describe('validation of signal payloads (unit)', () => {
  it('accepts a minimal valid offer', async () => {
    const { validateSignalPayload } = await import('../src/services/signaling.js');
    expect(validateSignalPayload({ kind: 'offer', sdp: 'v=0' }).valid).toBe(true);
  });
});
