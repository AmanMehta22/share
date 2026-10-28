import { randomUUID } from 'node:crypto';

/**
 * In-memory store for temporary transfer sessions.
 *
 * Design notes (documented honestly):
 *  - No database is used. All state lives in this process.
 *  - A server restart drops every active session; both peers are notified via
 *    socket disconnect and must start over.
 *  - Running more than one instance breaks pairing (each instance holds its own
 *    sessions). For multiple instances you would need a shared store such as
 *    Redis - which is deliberately NOT added, to keep the project at Rs 0.
 *  - Sessions are keyed by SHA-256(code), never by the raw code.
 */

export const SessionState = Object.freeze({
  WAITING: 'waiting', // sender created the code, nobody joined yet
  PAIRED: 'paired', // receiver joined, waiting for sender approval
  APPROVED: 'approved', // sender approved, WebRTC negotiation may start
  ACTIVE: 'active', // data channel open, transfer in progress
  CLOSED: 'closed',
});

const TERMINAL_STATES = new Set([SessionState.CLOSED]);

export class SessionError extends Error {
  /** @param {string} code machine-readable error code */
  constructor(code, message) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

export class SessionStore {
  /**
   * @param {{ttlMs?:number, maxJoinAttempts?:number, maxSessionsPerIp?:number, now?:() => number}} [options]
   */
  constructor(options = {}) {
    const { ttlMs = 15 * 60_000, maxJoinAttempts = 5, maxSessionsPerIp = 10, now = () => Date.now() } = options;
    if (!Number.isFinite(ttlMs) || ttlMs < 1000) throw new Error('ttlMs must be >= 1000');
    this.ttlMs = ttlMs;
    this.maxJoinAttempts = maxJoinAttempts;
    this.maxSessionsPerIp = maxSessionsPerIp;
    this.now = now;

    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** @type {Map<string, string>} codeHash -> sessionId */
    this.byCodeHash = new Map();
    /** @type {Map<string, {count:number, resetAt:number}>} `${ip}|${codeHash}` -> failures */
    this.joinFailures = new Map();
    /** @type {Map<string, {count:number, resetAt:number}>} ip -> failures across all codes */
    this.ipFailures = new Map();
    /** @type {null|((session:object, reason:string) => void)} called from sweep() for each expired session */
    this.onExpire = null;
  }

  get size() {
    return this.sessions.size;
  }

  #failWindow(ip, codeHash) {
    const currentTime = this.now();
    const ipWindow = currentTime + this.ttlMs;
    let ipEntry = this.ipFailures.get(ip);
    if (!ipEntry || ipEntry.resetAt <= currentTime) {
      ipEntry = { count: 0, resetAt: ipWindow };
      this.ipFailures.set(ip, ipEntry);
    }
    const key = `${ip}|${codeHash}`;
    let entry = this.joinFailures.get(key);
    if (!entry || entry.resetAt <= currentTime) {
      entry = { count: 0, resetAt: ipWindow };
      this.joinFailures.set(key, entry);
    }
    return { ipEntry, entry };
  }

  #recordFailedJoin(ip, codeHash) {
    const { ipEntry, entry } = this.#failWindow(ip, codeHash);
    ipEntry.count += 1;
    entry.count += 1;
  }

  #joinBlocked(ip, codeHash) {
    const currentTime = this.now();
    const ipEntry = this.ipFailures.get(ip);
    const entry = this.joinFailures.get(`${ip}|${codeHash}`);
    // Global per-IP guard: brute-forcing many codes is capped too.
    if (ipEntry && ipEntry.resetAt > currentTime && ipEntry.count >= this.maxJoinAttempts * 4) return true;
    if (entry && entry.resetAt > currentTime && entry.count >= this.maxJoinAttempts) return true;
    return false;
  }

  /** Remove a session and its index entries. Returns the removed session, if any. */
  #remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.sessions.delete(sessionId);
    if (this.byCodeHash.get(session.codeHash) === sessionId) this.byCodeHash.delete(session.codeHash);
    return session;
  }

  /**
   * Create a new session for a sender.
   * @param {{codeHash:string, ip:string, senderSocketId:string, ttlMs?:number}} params
   */
  create({ codeHash, ip, senderSocketId, ttlMs }) {
    if (typeof codeHash !== 'string' || codeHash.length < 32) {
      throw new SessionError('INVALID_CODE', 'Invalid transfer code.');
    }
    if (typeof senderSocketId !== 'string' || !senderSocketId) {
      throw new SessionError('INVALID_SOCKET', 'Missing connection identity.');
    }

    const existingId = this.byCodeHash.get(codeHash);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && !TERMINAL_STATES.has(existing.state)) {
        // A live session already owns this code. Codes are 80-bit random, so
        // this is effectively unreachable unless a client retries blindly.
        if (existing.senderSocketId === senderSocketId) return existing;
        throw new SessionError('CODE_IN_USE', 'That transfer code is already in use. Generate a new one.');
      }
      this.#remove(existingId);
    }

    const ownCount = [...this.sessions.values()].filter(
      (session) => session.ip === ip && !TERMINAL_STATES.has(session.state)
    ).length;
    if (ownCount >= this.maxSessionsPerIp) {
      throw new SessionError('TOO_MANY_SESSIONS', 'Too many active transfers from this address. Close some first.');
    }

    const currentTime = this.now();
    const id = randomUUID();
    const session = {
      id,
      codeHash,
      ip,
      state: SessionState.WAITING,
      senderSocketId,
      receiverSocketId: null,
      createdAt: currentTime,
      updatedAt: currentTime,
      expiresAt: currentTime + (ttlMs ?? this.ttlMs),
      transferStartedAt: null,
    };
    this.sessions.set(id, session);
    this.byCodeHash.set(codeHash, id);
    return session;
  }

  /** Look up by id, lazily expiring stale sessions. Closed sessions are hidden. */
  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === SessionState.CLOSED) return undefined;
    // ACTIVE sessions are bounded by the socket's heartbeat, not by the TTL:
    // a long transfer must not be cut off at the 15-minute mark.
    if (session.state !== SessionState.ACTIVE && session.expiresAt <= this.now()) {
      this.close({ sessionId, reason: 'expired' });
      return undefined;
    }
    return session;
  }

  getByCodeHash(codeHash) {
    const sessionId = this.byCodeHash.get(typeof codeHash === 'string' ? codeHash : '');
    return sessionId ? this.get(sessionId) : undefined;
  }

  /**
   * A receiver attempts to join a session by code hash.
   * @param {{codeHash:string, ip:string, receiverSocketId:string}} params
   */
  join({ codeHash, ip, receiverSocketId }) {
    if (this.#joinBlocked(ip, codeHash)) {
      throw new SessionError('RATE_LIMITED', 'Too many attempts. Wait a few minutes and try again.');
    }

    const session = this.getByCodeHash(codeHash);
    if (!session || session.state === SessionState.CLOSED) {
      this.#recordFailedJoin(ip, codeHash);
      throw new SessionError(
        'NOT_FOUND',
        'Transfer code not found. It may be wrong, already used, or expired.'
      );
    }
    if (session.receiverSocketId) {
      this.#recordFailedJoin(ip, codeHash);
      throw new SessionError('RECEIVER_TAKEN', 'This transfer already has a receiver connected.');
    }

    session.receiverSocketId = receiverSocketId;
    session.state = SessionState.PAIRED;
    session.updatedAt = this.now();
    return session;
  }

  /**
   * Sender approves the paired receiver. Only the session owner may approve.
   * @returns {string} the receiver socket id
   */
  approve({ sessionId, socketId }) {
    const session = this.get(sessionId);
    if (!session) throw new SessionError('NOT_FOUND', 'Transfer session no longer exists.');
    if (session.senderSocketId !== socketId) {
      throw new SessionError('FORBIDDEN', 'Only the sender can approve a receiver.');
    }
    if (session.state !== SessionState.PAIRED || !session.receiverSocketId) {
      throw new SessionError('INVALID_STATE', 'No receiver is waiting for approval.');
    }
    session.state = SessionState.APPROVED;
    session.updatedAt = this.now();
    // Approval starts a new window so negotiation is never cut short.
    session.expiresAt = session.updatedAt + this.ttlMs;
    return session.receiverSocketId;
  }

  /** Mark the WebRTC data channel as open (sender only). */
  markActive({ sessionId, socketId }) {
    const session = this.get(sessionId);
    if (!session) throw new SessionError('NOT_FOUND', 'Transfer session no longer exists.');
    if (session.senderSocketId !== socketId) {
      throw new SessionError('FORBIDDEN', 'Only the sender can update transfer state.');
    }
    if (session.state !== SessionState.APPROVED && session.state !== SessionState.ACTIVE) {
      throw new SessionError('INVALID_STATE', 'Session is not ready for a transfer yet.');
    }
    if (session.state !== SessionState.ACTIVE) {
      session.state = SessionState.ACTIVE;
      session.transferStartedAt = this.now();
      session.updatedAt = this.now();
    }
    return session;
  }

  /** Sender rejected the receiver before approving. */
  rejectReceiver({ sessionId, socketId }) {
    const session = this.get(sessionId);
    if (!session) throw new SessionError('NOT_FOUND', 'Transfer session no longer exists.');
    if (session.senderSocketId !== socketId) {
      throw new SessionError('FORBIDDEN', 'Only the sender can reject a receiver.');
    }
    const receiverId = session.receiverSocketId;
    this.close({ sessionId, reason: 'sender_rejected' });
    return receiverId;
  }

  /**
   * A receiver left while still waiting for approval: free the slot so another
   * receiver (e.g. after a page refresh) can join the same code.
   * @returns {boolean} true when the slot was released
   */
  releaseReceiver({ sessionId, socketId }) {
    const session = this.get(sessionId);
    if (!session || session.receiverSocketId !== socketId) return false;
    if (session.state !== SessionState.PAIRED) return false;
    session.receiverSocketId = null;
    session.state = SessionState.WAITING;
    session.updatedAt = this.now();
    return true;
  }

  /** Close a session permanently. Idempotent. */
  close({ sessionId, reason = 'closed' }) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.state === SessionState.CLOSED) return session;
    session.state = SessionState.CLOSED;
    session.closedReason = reason;
    session.updatedAt = this.now();
    // Keep a tombstone so a late join of a just-closed code reports NOT_FOUND
    // instead of silently doing nothing; sweep() drops it after one TTL.
    this.byCodeHash.delete(session.codeHash);
    return session;
  }

  /**
   * Close every session that has expired. Returns closed sessions so callers
   * can notify peers.
   */
  sweep() {
    const currentTime = this.now();
    const closed = [];
    for (const session of this.sessions.values()) {
      if (session.state === SessionState.CLOSED) {
        // Tombstones only need to survive briefly for accurate error messages.
        if (session.updatedAt + this.ttlMs <= currentTime) this.#remove(session.id);
        continue;
      }
      // A transfer that already started is kept alive by its sockets.
      if (session.state === SessionState.ACTIVE) continue;
      if (session.expiresAt <= currentTime) {
        this.close({ sessionId: session.id, reason: 'expired' });
        closed.push(session);
        if (typeof this.onExpire === 'function') {
          try {
            this.onExpire(session, 'expired');
          } catch {
            /* a listener must never break the sweep */
          }
        }
      }
    }
    // Prune failure counters.
    for (const [key, entry] of this.joinFailures) if (entry.resetAt <= currentTime) this.joinFailures.delete(key);
    for (const [key, entry] of this.ipFailures) if (entry.resetAt <= currentTime) this.ipFailures.delete(key);
    return closed;
  }

  startSweeper(intervalMs = 30_000) {
    const timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        /* never let a sweep crash the server */
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.#sweeper = timer;
    return timer;
  }

  stopSweeper() {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  #sweeper = null;
}
