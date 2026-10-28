import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore, SessionState, SessionError } from '../src/services/sessionStore.js';

const CODE_HASH_A = 'a'.repeat(64);
const CODE_HASH_B = 'b'.repeat(64);

function makeStore(options = {}) {
  return new SessionStore({ ttlMs: 1000, maxJoinAttempts: 3, maxSessionsPerIp: 5, ...options });
}

describe('SessionStore.create', () => {
  let store;
  beforeEach(() => {
    store = makeStore();
  });

  it('creates a WAITING session with an expiry', () => {
    const session = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    expect(session.state).toBe(SessionState.WAITING);
    expect(session.senderSocketId).toBe('s1');
    expect(session.receiverSocketId).toBeNull();
    expect(session.expiresAt).toBeGreaterThan(store.now());
  });

  it('rejects an invalid code hash', () => {
    expect(() => store.create({ codeHash: 'short', ip: 'x', senderSocketId: 's1' })).toThrow(SessionError);
  });

  it('rejects a missing socket id', () => {
    expect(() => store.create({ codeHash: CODE_HASH_A, ip: 'x', senderSocketId: '' })).toThrow(SessionError);
  });

  it('rejects a code already owned by another socket', () => {
    store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    expect(() =>
      store.create({ codeHash: CODE_HASH_A, ip: '2.2.2.2', senderSocketId: 's2' })
    ).toThrow(/already in use/i);
  });

  it('is idempotent when the same socket retries the same code', () => {
    const first = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    const second = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    expect(second.id).toBe(first.id);
  });

  it('caps the number of live sessions per IP', () => {
    for (let i = 0; i < 5; i += 1) {
      store.create({ codeHash: String(i).repeat(64), ip: '9.9.9.9', senderSocketId: `s${i}` });
    }
    expect(() =>
      store.create({ codeHash: 'z'.repeat(64), ip: '9.9.9.9', senderSocketId: 's99' })
    ).toThrow(/too many/i);
  });
});

describe('SessionStore join lifecycle', () => {
  let store;
  let session;
  beforeEach(() => {
    store = makeStore();
    session = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
  });

  it('pairs a receiver with the session', () => {
    const joined = store.join({ codeHash: CODE_HASH_A, ip: '2.2.2.2', receiverSocketId: 'r1' });
    expect(joined.id).toBe(session.id);
    expect(joined.state).toBe(SessionState.PAIRED);
    expect(joined.receiverSocketId).toBe('r1');
  });

  it('rejects a wrong code with NOT_FOUND', () => {
    try {
      store.join({ codeHash: CODE_HASH_B, ip: '2.2.2.2', receiverSocketId: 'r1' });
      expect.unreachable();
    } catch (error) {
      expect(error.code).toBe('NOT_FOUND');
    }
  });

  it('rejects a second receiver with RECEIVER_TAKEN', () => {
    store.join({ codeHash: CODE_HASH_A, ip: '2.2.2.2', receiverSocketId: 'r1' });
    try {
      store.join({ codeHash: CODE_HASH_A, ip: '3.3.3.3', receiverSocketId: 'r2' });
      expect.unreachable();
    } catch (error) {
      expect(error.code).toBe('RECEIVER_TAKEN');
    }
  });

  it('releasing a waiting receiver allows a re-join (page refresh)', () => {
    store.join({ codeHash: CODE_HASH_A, ip: '2.2.2.2', receiverSocketId: 'r1' });
    expect(store.releaseReceiver({ sessionId: session.id, socketId: 'r1' })).toBe(true);
    const again = store.join({ codeHash: CODE_HASH_A, ip: '2.2.2.2', receiverSocketId: 'r2' });
    expect(again.receiverSocketId).toBe('r2');
    expect(again.state).toBe(SessionState.PAIRED);
  });

  it('cannot release a receiver that is not part of the session', () => {
    store.join({ codeHash: CODE_HASH_A, ip: '2.2.2.2', receiverSocketId: 'r1' });
    expect(store.releaseReceiver({ sessionId: session.id, socketId: 'intruder' })).toBe(false);
  });
});

describe('SessionStore rate limiting of joins', () => {
  it('blocks a specific IP+code pair after maxJoinAttempts failures', () => {
    const store = makeStore({ maxJoinAttempts: 3 });
    // Three failed joins of the SAME (nonexistent) code from one IP...
    for (let i = 0; i < 3; i += 1) {
      expect(() => store.join({ codeHash: CODE_HASH_B, ip: '5.5.5.5', receiverSocketId: `r${i}` })).toThrow(
        SessionError
      );
    }
    // ...blocks that code for that IP, even once it exists.
    store.create({ codeHash: CODE_HASH_B, ip: '1.1.1.1', senderSocketId: 's1' });
    expect(() => store.join({ codeHash: CODE_HASH_B, ip: '5.5.5.5', receiverSocketId: 'rx' })).toThrow(
      /too many/i
    );
  });

  it('a different code from the same IP still works below the global threshold', () => {
    const store = makeStore({ maxJoinAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(() => store.join({ codeHash: CODE_HASH_B, ip: '5.5.5.5', receiverSocketId: `r${i}` })).toThrow();
    }
    // The correct code, same IP, is a different pair -> still allowed.
    store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    const joined = store.join({ codeHash: CODE_HASH_A, ip: '5.5.5.5', receiverSocketId: 'ry' });
    expect(joined.receiverSocketId).toBe('ry');
  });

  it('caps brute-forcing many different codes from one IP', () => {
    const store = makeStore({ maxJoinAttempts: 2 });
    // 2 * 4 = 8 failures across different codes from the same IP.
    for (let i = 0; i < 8; i += 1) {
      const hash = String(i).padStart(64, 'x');
      expect(() => store.join({ codeHash: hash, ip: '7.7.7.7', receiverSocketId: `r${i}` })).toThrow();
    }
    // Now blocked globally for that IP, even for a fresh, valid code.
    store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    expect(() => store.join({ codeHash: CODE_HASH_A, ip: '7.7.7.7', receiverSocketId: 'ry' })).toThrow(
      /too many/i
    );
  });

  it('does not block other IPs', () => {
    const store = makeStore({ maxJoinAttempts: 1 });
    expect(() => store.join({ codeHash: CODE_HASH_B, ip: '8.8.8.8', receiverSocketId: 'r1' })).toThrow();
    store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    // A different IP can still join the correct code.
    const joined = store.join({ codeHash: CODE_HASH_A, ip: '9.9.9.9', receiverSocketId: 'r2' });
    expect(joined.receiverSocketId).toBe('r2');
  });
});

describe('SessionStore approve / markActive / reject', () => {
  let store;
  let session;
  beforeEach(() => {
    store = makeStore();
    session = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    store.join({ codeHash: CODE_HASH_A, ip: '2.2.2.2', receiverSocketId: 'r1' });
  });

  it('approve moves to APPROVED and returns the receiver id', () => {
    const receiverId = store.approve({ sessionId: session.id, socketId: 's1' });
    expect(receiverId).toBe('r1');
    expect(store.get(session.id).state).toBe(SessionState.APPROVED);
  });

  it('only the sender can approve', () => {
    expect(() => store.approve({ sessionId: session.id, socketId: 'r1' })).toThrow(/only the sender/i);
  });

  it('approve without a paired receiver is INVALID_STATE', () => {
    const lonely = store.create({ codeHash: CODE_HASH_B, ip: '3.3.3.3', senderSocketId: 's3' });
    expect(() => store.approve({ sessionId: lonely.id, socketId: 's3' })).toThrow(/no receiver/i);
  });

  it('markActive moves APPROVED -> ACTIVE', () => {
    store.approve({ sessionId: session.id, socketId: 's1' });
    const active = store.markActive({ sessionId: session.id, socketId: 's1' });
    expect(active.state).toBe(SessionState.ACTIVE);
    expect(active.transferStartedAt).toBeGreaterThan(0);
  });

  it('markActive before approval is INVALID_STATE', () => {
    expect(() => store.markActive({ sessionId: session.id, socketId: 's1' })).toThrow();
  });

  it('rejectReceiver closes the session and returns the receiver id', () => {
    const receiverId = store.rejectReceiver({ sessionId: session.id, socketId: 's1' });
    expect(receiverId).toBe('r1');
    expect(store.get(session.id)).toBeUndefined();
  });
});

describe('SessionStore TTL and expiry', () => {
  it('expires a WAITING session after the TTL', () => {
    let clock = 1_000_000;
    const store = makeStore({ now: () => clock });
    store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    clock += 1001;
    expect(store.getByCodeHash(CODE_HASH_A)).toBeUndefined();
  });

  it('does NOT expire an ACTIVE session (long transfers are fine)', () => {
    let clock = 1_000_000;
    const store = makeStore({ now: () => clock });
    const session = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    store.join({ codeHash: CODE_HASH_A, ip: '2.2.2.2', receiverSocketId: 'r1' });
    store.approve({ sessionId: session.id, socketId: 's1' });
    store.markActive({ sessionId: session.id, socketId: 's1' });
    clock += 60 * 60_000; // one hour later
    expect(store.get(session.id)).toBeDefined();
    expect(store.get(session.id).state).toBe(SessionState.ACTIVE);
  });

  it('sweep closes expired sessions and calls onExpire', () => {
    let clock = 1_000_000;
    const store = makeStore({ now: () => clock });
    const expired = [];
    store.onExpire = (session, reason) => expired.push({ id: session.id, reason });
    store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    clock += 1001;
    const closed = store.sweep();
    expect(closed).toHaveLength(1);
    expect(expired).toHaveLength(1);
    expect(expired[0].reason).toBe('expired');
  });

  it('a broken onExpire listener does not break the sweep', () => {
    let clock = 1_000_000;
    const store = makeStore({ now: () => clock });
    store.onExpire = () => {
      throw new Error('listener bug');
    };
    store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    clock += 1001;
    expect(() => store.sweep()).not.toThrow();
  });

  it('closed sessions become invisible immediately (tombstone)', () => {
    const store = makeStore();
    const session = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    store.close({ sessionId: session.id, reason: 'test' });
    expect(store.get(session.id)).toBeUndefined();
    expect(store.getByCodeHash(CODE_HASH_A)).toBeUndefined();
  });

  it('sweep eventually removes tombstones', () => {
    let clock = 1_000_000;
    const store = makeStore({ now: () => clock });
    const session = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    store.close({ sessionId: session.id, reason: 'test' });
    clock += 1001;
    store.sweep();
    expect(store.sessions.has(session.id)).toBe(false);
  });

  it('approval refreshes the expiry so negotiation is not cut short', () => {
    let clock = 1_000_000;
    const store = makeStore({ now: () => clock });
    const session = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    store.join({ codeHash: CODE_HASH_A, ip: '2.2.2.2', receiverSocketId: 'r1' });
    const before = store.get(session.id).expiresAt;
    clock += 900; // almost expired
    store.approve({ sessionId: session.id, socketId: 's1' });
    expect(store.get(session.id).expiresAt).toBeGreaterThan(before);
  });
});

describe('SessionStore close semantics', () => {
  it('close is idempotent', () => {
    const store = makeStore();
    const session = store.create({ codeHash: CODE_HASH_A, ip: '1.1.1.1', senderSocketId: 's1' });
    const first = store.close({ sessionId: session.id, reason: 'one' });
    const second = store.close({ sessionId: session.id, reason: 'two' });
    expect(first.closedReason).toBe('one');
    expect(second.closedReason).toBe('one'); // unchanged
  });

  it('close of an unknown id returns undefined', () => {
    const store = makeStore();
    expect(store.close({ sessionId: 'nope' })).toBeUndefined();
  });
});
