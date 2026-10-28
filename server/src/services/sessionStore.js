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
 *
 * Two send modes are supported:
 *  - direct: exactly one receiver (the original one-to-one flow)
 *  - group:  one sender, up to `maxReceivers` receivers, each with its own
 *            independent WebRTC peer connection
 *
 * In both modes every receiver has its own record in `session.receivers`; the
 * direct mode simply clamps maxReceivers to 1. The aggregate `session.state`
 * is derived from the per-receiver states:
 *    any active receiver   -> ACTIVE
 *    else any approved     -> APPROVED
 *    else any waiting      -> PAIRED
 *    else                  -> WAITING
 */

export const SessionState = Object.freeze({
  WAITING: 'waiting', // sender created the code, nobody joined yet
  PAIRED: 'paired', // at least one receiver joined, waiting for sender approval
  APPROVED: 'approved', // at least one receiver approved, WebRTC negotiation may start
  ACTIVE: 'active', // at least one data channel is open, transfer in progress
  CLOSED: 'closed',
});

export const ReceiverState = Object.freeze({
  WAITING: 'waiting', // joined, not yet approved
  APPROVED: 'approved', // sender approved; signaling + WebRTC allowed
  ACTIVE: 'active', // data channel open with this receiver
});

export const SessionMode = Object.freeze({
  DIRECT: 'direct',
  GROUP: 'group',
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
   * @param {{ttlMs?:number, maxJoinAttempts?:number, maxSessionsPerIp?:number, maxReceiversPerSession?:number, now?:() => number}} [options]
   */
  constructor(options = {}) {
    const {
      ttlMs = 15 * 60_000,
      maxJoinAttempts = 5,
      maxSessionsPerIp = 10,
      maxReceiversPerSession = 10,
      now = () => Date.now(),
    } = options;
    if (!Number.isFinite(ttlMs) || ttlMs < 1000) throw new Error('ttlMs must be >= 1000');
    if (!Number.isInteger(maxReceiversPerSession) || maxReceiversPerSession < 1) {
      throw new Error('maxReceiversPerSession must be a positive integer');
    }
    this.ttlMs = ttlMs;
    this.maxJoinAttempts = maxJoinAttempts;
    this.maxSessionsPerIp = maxSessionsPerIp;
    this.maxReceiversPerSession = maxReceiversPerSession;
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

  /** Derive the aggregate session state from the per-receiver states. */
  #syncState(session) {
    let next = SessionState.WAITING;
    for (const receiver of session.receivers.values()) {
      if (receiver.state === ReceiverState.ACTIVE) {
        next = SessionState.ACTIVE;
        break;
      }
      if (receiver.state === ReceiverState.APPROVED) next = SessionState.APPROVED;
      else if (receiver.state === ReceiverState.WAITING && next !== SessionState.APPROVED) {
        next = SessionState.PAIRED;
      }
    }
    session.state = next;
    session.updatedAt = this.now();
    return session;
  }

  /** Clamp a requested group size to this store's hard cap. */
  #clampMaxReceivers(requested) {
    const value = Number.parseInt(String(requested), 10);
    if (!Number.isInteger(value)) return this.maxReceiversPerSession;
    return Math.min(Math.max(value, 1), this.maxReceiversPerSession);
  }

  /**
   * Create a new session for a sender.
   * @param {{codeHash:string, ip:string, senderSocketId:string, ttlMs?:number, mode?:string, maxReceivers?:number}} params
   */
  create({ codeHash, ip, senderSocketId, ttlMs, mode = SessionMode.DIRECT, maxReceivers }) {
    if (typeof codeHash !== 'string' || codeHash.length < 32) {
      throw new SessionError('INVALID_CODE', 'Invalid transfer code.');
    }
    if (typeof senderSocketId !== 'string' || !senderSocketId) {
      throw new SessionError('INVALID_SOCKET', 'Missing connection identity.');
    }
    if (mode !== SessionMode.DIRECT && mode !== SessionMode.GROUP) {
      throw new SessionError('INVALID_MODE', 'Unknown transfer mode. Use "direct" or "group".');
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
      mode,
      // Direct mode is always exactly one receiver; group mode is capped.
      maxReceivers: mode === SessionMode.GROUP ? this.#clampMaxReceivers(maxReceivers) : 1,
      senderSocketId,
      /** @type {Map<string, {id:string, state:string, joinedAt:number, approvedAt:number|null, activatedAt:number|null}>} */
      receivers: new Map(),
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

  /** Look up one receiver record of a session (raw; ignores expiry). */
  getReceiver(session, receiverId) {
    if (!session || typeof receiverId !== 'string') return undefined;
    return session.receivers.get(receiverId);
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
    if (session.receivers.size >= session.maxReceivers) {
      this.#recordFailedJoin(ip, codeHash);
      if (session.mode === SessionMode.DIRECT) {
        throw new SessionError('RECEIVER_TAKEN', 'This transfer already has a receiver connected.');
      }
      throw new SessionError(
        'SESSION_FULL',
        `This one-to-many transfer already has its maximum of ${session.maxReceivers} receivers.`
      );
    }

    session.receivers.set(receiverSocketId, {
      id: receiverSocketId,
      state: ReceiverState.WAITING,
      joinedAt: this.now(),
      approvedAt: null,
      activatedAt: null,
    });
    this.#syncState(session);
    return session;
  }

  /**
   * Sender approves a waiting receiver. Only the session owner may approve.
   * With `receiverId` a specific receiver is approved (group mode); without it
   * the first waiting receiver is approved (direct mode compatibility).
   * @returns {string} the approved receiver's socket id
   */
  approve({ sessionId, socketId, receiverId }) {
    const session = this.get(sessionId);
    if (!session) throw new SessionError('NOT_FOUND', 'Transfer session no longer exists.');
    if (session.senderSocketId !== socketId) {
      throw new SessionError('FORBIDDEN', 'Only the sender can approve a receiver.');
    }
    const target = receiverId ? session.receivers.get(receiverId) : undefined;
    if (receiverId && !target) {
      throw new SessionError('RECEIVER_GONE', 'That receiver is no longer connected.');
    }
    const candidate = target ?? [...session.receivers.values()].find((r) => r.state === ReceiverState.WAITING);
    if (!candidate) {
      throw new SessionError('INVALID_STATE', 'No receiver is waiting for approval.');
    }
    if (candidate.state !== ReceiverState.WAITING) {
      throw new SessionError('INVALID_STATE', 'That receiver is already approved.');
    }
    candidate.state = ReceiverState.APPROVED;
    candidate.approvedAt = this.now();
    // Approval starts a new window so negotiation is never cut short.
    session.expiresAt = candidate.approvedAt + this.ttlMs;
    this.#syncState(session);
    return candidate.id;
  }

  /**
   * Sender approves every waiting receiver at once (group mode convenience).
   * @returns {string[]} ids of the receivers that were approved
   */
  approveAll({ sessionId, socketId }) {
    const session = this.get(sessionId);
    if (!session) throw new SessionError('NOT_FOUND', 'Transfer session no longer exists.');
    if (session.senderSocketId !== socketId) {
      throw new SessionError('FORBIDDEN', 'Only the sender can approve receivers.');
    }
    const waiting = [...session.receivers.values()].filter((r) => r.state === ReceiverState.WAITING);
    if (waiting.length === 0) {
      throw new SessionError('INVALID_STATE', 'No receiver is waiting for approval.');
    }
    const approvedAt = this.now();
    for (const receiver of waiting) {
      receiver.state = ReceiverState.APPROVED;
      receiver.approvedAt = approvedAt;
    }
    // Approval starts a new window so negotiation is never cut short.
    session.expiresAt = approvedAt + this.ttlMs;
    this.#syncState(session);
    return waiting.map((receiver) => receiver.id);
  }

  /**
   * Mark a receiver's WebRTC data channel as open (sender only).
   * Without `receiverId` every approved receiver is marked active.
   */
  markActive({ sessionId, socketId, receiverId }) {
    const session = this.get(sessionId);
    if (!session) throw new SessionError('NOT_FOUND', 'Transfer session no longer exists.');
    if (session.senderSocketId !== socketId) {
      throw new SessionError('FORBIDDEN', 'Only the sender can update transfer state.');
    }
    const targets = [];
    if (receiverId) {
      const receiver = session.receivers.get(receiverId);
      if (!receiver) throw new SessionError('RECEIVER_GONE', 'That receiver is no longer connected.');
      targets.push(receiver);
    } else {
      targets.push(...session.receivers.values());
    }
    for (const receiver of targets) {
      if (receiver.state !== ReceiverState.APPROVED && receiver.state !== ReceiverState.ACTIVE) {
        throw new SessionError('INVALID_STATE', 'Session is not ready for a transfer yet.');
      }
    }
    const activatedAt = this.now();
    for (const receiver of targets) {
      if (receiver.state !== ReceiverState.ACTIVE) {
        receiver.state = ReceiverState.ACTIVE;
        receiver.activatedAt = activatedAt;
      }
    }
    if (session.state !== SessionState.ACTIVE) {
      session.transferStartedAt = session.transferStartedAt ?? activatedAt;
    }
    this.#syncState(session);
    return session;
  }

  /**
   * Sender rejected receiver(s) before approving.
   * With `receiverId` only that receiver is removed (group mode); without it
   * every waiting receiver is removed. The session itself is NOT closed here -
   * policy lives in the signaling layer (direct mode closes, group survives).
   * @returns {string[]} ids of the removed receivers
   */
  rejectReceiver({ sessionId, socketId, receiverId }) {
    const session = this.get(sessionId);
    if (!session) throw new SessionError('NOT_FOUND', 'Transfer session no longer exists.');
    if (session.senderSocketId !== socketId) {
      throw new SessionError('FORBIDDEN', 'Only the sender can reject a receiver.');
    }
    if (receiverId) {
      if (!session.receivers.has(receiverId)) {
        throw new SessionError('RECEIVER_GONE', 'That receiver is no longer connected.');
      }
      session.receivers.delete(receiverId);
      this.#syncState(session);
      return [receiverId];
    }
    const waitingIds = [];
    for (const [id, receiver] of [...session.receivers]) {
      if (receiver.state === ReceiverState.WAITING) {
        session.receivers.delete(id);
        waitingIds.push(id);
      }
    }
    this.#syncState(session);
    return waitingIds;
  }

  /**
   * A receiver left while still waiting for approval: free the slot so another
   * receiver (e.g. after a page refresh) can join the same code.
   * @returns {boolean} true when the slot was released
   */
  releaseReceiver({ sessionId, socketId }) {
    const session = this.sessions.get(sessionId);
    const receiver = session?.receivers.get(socketId);
    if (!receiver || receiver.state !== ReceiverState.WAITING) return false;
    session.receivers.delete(socketId);
    this.#syncState(session);
    return true;
  }

  /**
   * Remove a receiver regardless of its state (approved/active leaving).
   * Returns the removed receiver record, or undefined when not a member.
   * The session survives; callers decide whether to close it.
   */
  removeReceiver({ sessionId, socketId }) {
    const session = this.sessions.get(sessionId);
    const receiver = session?.receivers.get(socketId);
    if (!receiver) return undefined;
    session.receivers.delete(socketId);
    this.#syncState(session);
    return receiver;
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
