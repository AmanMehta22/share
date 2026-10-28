import { isValidCode, normalizeCode, hashCode, logRef } from '../utils/code.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { SessionError, SessionState } from './sessionStore.js';

/**
 * Socket.IO signaling: the ONLY traffic that leaves the browser on its way to
 * the peer besides the direct WebRTC connection itself.
 *
 * It carries: transfer codes (hashed on arrival), SDP offers/answers and ICE
 * candidates. It NEVER carries file bytes, filenames or transfer progress.
 */

const MAX_SDP_CHARS = 100_000;
const MAX_CANDIDATE_CHARS = 4_096;
const MAX_SIGNAL_JSON_CHARS = 120_000;
const SIGNAL_KINDS = new Set(['offer', 'answer', 'candidate']);

const ok = (data = {}) => ({ ok: true, ...data });
const fail = (error, message) => ({ ok: false, error, message });

function clientIp(socket, trustProxy) {
  if (trustProxy) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first.slice(0, 64);
    }
  }
  return String(socket.handshake.address ?? 'unknown').slice(0, 64);
}

/** Validates an SDP/candidate payload before it is relayed to the peer. */
export function validateSignalPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, reason: 'Signal payload must be an object.' };
  }
  const { kind, sdp, candidate } = payload;
  if (typeof kind !== 'string' || !SIGNAL_KINDS.has(kind)) {
    return { valid: false, reason: 'Unknown signal kind.' };
  }
  if (kind === 'candidate') {
    if (candidate !== null && typeof candidate === 'object') {
      if (typeof candidate.candidate === 'string' && candidate.candidate.length > MAX_CANDIDATE_CHARS) {
        return { valid: false, reason: 'ICE candidate too large.' };
      }
    } else if (candidate !== undefined) {
      return { valid: false, reason: 'Malformed ICE candidate.' };
    }
  } else if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_CHARS) {
    return { valid: false, reason: 'Malformed SDP.' };
  }
  let size;
  try {
    size = JSON.stringify(payload).length;
  } catch {
    return { valid: false, reason: 'Unserializable signal.' };
  }
  if (size > MAX_SIGNAL_JSON_CHARS) return { valid: false, reason: 'Signal too large.' };
  return { valid: true };
}

/**
 * Attach signaling handlers to a Socket.IO server.
 * @param {import('socket.io').Server} io
 * @param {{store: import('./sessionStore.js').SessionStore, config: object, logger: object}} deps
 */
export function attachSignaling(io, { store, config, logger }) {
  const eventLimiter = createRateLimiter({
    points: config.maxSignalsPerMinute,
    windowMs: 60_000,
  });
  const createLimiter = createRateLimiter({ points: 20, windowMs: 60_000 });

  // When the sweeper expires a session, tell both peers instead of leaving
  // their tabs stuck on a code that can never be used again.
  store.onExpire = (expired, reason) => {
    for (const socketId of [expired.senderSocketId, expired.receiverSocketId]) {
      if (!socketId) continue;
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      socket.emit('peer:expired', { reason });
      if (socket.data.sessionId === expired.id) {
        socket.data.role = null;
        socket.data.sessionId = null;
        socket.data.codeHash = null;
      }
    }
    logger.info('session expired', { session: expired.id, ref: logRef(expired.codeHash), reason });
  };

  io.on('connection', (socket) => {
    const ip = clientIp(socket, config.trustProxy);
    socket.data.ip = ip;
    socket.data.role = null;
    socket.data.sessionId = null;
    socket.data.codeHash = null;

    const session = () => {
      if (!socket.data.sessionId) return undefined;
      return store.get(socket.data.sessionId);
    };

    /**
     * Wrap a handler with rate limiting, ack shaping and error mapping so a
     * malformed message can never crash the process.
     */
    const handle = (event, handler, limiter = eventLimiter) => {
      socket.on(event, (payload, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        try {
          if (!limiter.consume(`${socket.id}:${event}`)) {
            respond(fail('RATE_LIMITED', 'Too many requests. Slow down and retry shortly.'));
            return;
          }
          const result = handler(payload);
          respond(result ?? ok());
        } catch (error) {
          if (error instanceof SessionError) {
            respond(fail(error.code, error.message));
            return;
          }
          logger.warn('unhandled signaling error', { event, error: String(error && error.message) });
          respond(fail('SERVER_ERROR', 'Server error. Please retry.'));
        }
      });
    };

    const detachFromSession = () => {
      socket.data.role = null;
      socket.data.sessionId = null;
      socket.data.codeHash = null;
    };

    const notifyPeer = (event, data) => {
      const current = session();
      if (!current) return;
      const peerId =
        current.senderSocketId === socket.id ? current.receiverSocketId : current.senderSocketId;
      if (!peerId) return;
      const peer = io.sockets.sockets.get(peerId);
      if (peer) peer.emit(event, data);
    };

    // ---------------------------------------------------------------- create
    handle(
      'session:create',
      (payload) => {
        if (socket.data.sessionId) {
          return fail('ALREADY_IN_SESSION', 'This connection already has a transfer session.');
        }
        if (!createLimiter.consume(socket.id)) {
          return fail('RATE_LIMITED', 'Too many sessions created. Wait a minute.');
        }
        const code = normalizeCode(payload && payload.code);
        if (!code || !isValidCode(code)) {
          return fail('INVALID_CODE', 'Invalid transfer code format.');
        }
        const codeHash = hashCode(code);
        const created = store.create({
          codeHash,
          ip,
          senderSocketId: socket.id,
          ttlMs: config.sessionTtlMs,
        });
        socket.data.role = 'sender';
        socket.data.sessionId = created.id;
        socket.data.codeHash = codeHash;
        logger.info('session created', { session: created.id, ref: logRef(codeHash), expiresAt: created.expiresAt });
        return ok({ sessionId: created.id, expiresAt: created.expiresAt });
      },
      createLimiter
    );

    // ------------------------------------------------------------------ join
    handle('session:join', (payload) => {
      if (socket.data.sessionId) {
        return fail('ALREADY_IN_SESSION', 'This connection already has a transfer session.');
      }
      const code = normalizeCode(payload && payload.code);
      if (!code || !isValidCode(code)) {
        return fail('INVALID_CODE', 'Invalid transfer code format.');
      }
      const codeHash = hashCode(code);
      const joined = store.join({ codeHash, ip, receiverSocketId: socket.id });
      socket.data.role = 'receiver';
      socket.data.sessionId = joined.id;
      socket.data.codeHash = codeHash;

      const sender = io.sockets.sockets.get(joined.senderSocketId);
      if (!sender) {
        // Sender vanished between lookup and join: roll back.
        store.close({ sessionId: joined.id, reason: 'sender_gone' });
        detachFromSession();
        return fail('SENDER_GONE', 'The sender is no longer online. Ask them for a new code.');
      }
      sender.emit('peer:joined', { receiverId: socket.id, state: joined.state });
      logger.info('receiver joined', { session: joined.id, ref: logRef(codeHash) });
      return ok({ sessionId: joined.id, expiresAt: joined.expiresAt, senderOnline: true });
    });

    // -------------------------------------------------------------- approve
    handle('session:approve', () => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      if (socket.data.role !== 'sender') return fail('FORBIDDEN', 'Only the sender can approve.');
      const receiverId = store.approve({ sessionId: current.id, socketId: socket.id });
      const receiver = io.sockets.sockets.get(receiverId);
      if (!receiver) {
        store.close({ sessionId: current.id, reason: 'receiver_gone' });
        detachFromSession();
        return fail('RECEIVER_GONE', 'The receiver disconnected. Share the code again.');
      }
      receiver.emit('peer:approved', { senderId: socket.id });
      logger.info('receiver approved', { session: current.id });
      return ok({ approved: true });
    });

    // --------------------------------------------------------------- reject
    handle('session:reject', (payload) => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      if (socket.data.role !== 'sender') return fail('FORBIDDEN', 'Only the sender can reject.');
      const reason =
        typeof (payload && payload.reason) === 'string' ? payload.reason.slice(0, 200) : 'rejected_by_sender';
      const receiverId = store.rejectReceiver({ sessionId: current.id, socketId: socket.id });
      if (receiverId) {
        const receiver = io.sockets.sockets.get(receiverId);
        if (receiver) receiver.emit('peer:rejected', { reason });
      }
      detachFromSession();
      logger.info('receiver rejected', { session: current.id });
      return ok();
    });

    // --------------------------------------------------------------- signal
    handle('session:signal', (payload) => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      if (current.state !== SessionState.APPROVED && current.state !== SessionState.ACTIVE) {
        return fail('INVALID_STATE', 'Signaling is not allowed until the sender approves the receiver.');
      }
      const isSender = current.senderSocketId === socket.id;
      const isReceiver = current.receiverSocketId === socket.id;
      if (!isSender && !isReceiver) return fail('FORBIDDEN', 'You are not a member of this session.');

      const check = validateSignalPayload(payload && payload.signal);
      if (!check.valid) return fail('INVALID_SIGNAL', check.reason);

      const peerId = isSender ? current.receiverSocketId : current.senderSocketId;
      const peer = peerId ? io.sockets.sockets.get(peerId) : undefined;
      if (!peer) return fail('PEER_GONE', 'The other participant is no longer connected.');

      peer.emit('signal', { signal: payload.signal, from: isSender ? 'sender' : 'receiver' });
      return ok();
    });

    // --------------------------------------------------------------- active
    handle('session:active', () => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      store.markActive({ sessionId: current.id, socketId: socket.id });
      return ok();
    });

    // --------------------------------------------------------------- cancel
    handle('session:cancel', (payload) => {
      const current = session();
      if (!current) {
        detachFromSession();
        return ok({ alreadyClosed: true });
      }
      const isSender = current.senderSocketId === socket.id;
      const isReceiver = current.receiverSocketId === socket.id;
      if (!isSender && !isReceiver) return fail('FORBIDDEN', 'You are not a member of this session.');
      const reason =
        typeof (payload && payload.reason) === 'string' ? payload.reason.slice(0, 200) : 'cancelled';
      notifyPeer('peer:cancelled', { reason, by: isSender ? 'sender' : 'receiver' });
      store.close({ sessionId: current.id, reason });
      detachFromSession();
      logger.info('session cancelled', { session: current.id, by: isSender ? 'sender' : 'receiver' });
      return ok();
    });

    // ---------------------------------------------------------------- leave
    handle('session:leave', () => {
      handleDeparture('leave');
      return ok();
    });

    function handleDeparture(reason) {
      const current = session();
      const { role, sessionId } = socket.data;
      if (!current || !sessionId) {
        detachFromSession();
        return;
      }

      if (role === 'sender') {
        store.close({ sessionId, reason: `sender_${reason}` });
        notifyPeerBeforeClose('peer:disconnected', { role: 'sender', reason });
        detachFromSession();
        return;
      }

      // Receiver: allow a clean re-join (page refresh) while still waiting.
      const released = store.releaseReceiver({ sessionId, socketId: socket.id });
      if (released) {
        notifyPeerBeforeClose('peer:waiting-again', { role: 'receiver', reason });
      } else {
        store.close({ sessionId, reason: `receiver_${reason}` });
        notifyPeerBeforeClose('peer:disconnected', { role: 'receiver', reason });
      }
      detachFromSession();
    }

    function notifyPeerBeforeClose(event, data) {
      const stored = store.sessions.get(socket.data.sessionId);
      if (!stored) return;
      const peerId = stored.senderSocketId === socket.id ? stored.receiverSocketId : stored.senderSocketId;
      if (!peerId) return;
      const peer = io.sockets.sockets.get(peerId);
      if (peer) peer.emit(event, data);
    }

    socket.on('disconnect', (reason) => {
      try {
        handleDeparture(String(reason).slice(0, 40));
      } catch (error) {
        logger.warn('disconnect handling failed', { error: String(error && error.message) });
      }
      eventLimiter.reset(socket.id);
      createLimiter.reset(socket.id);
    });
  });
}
