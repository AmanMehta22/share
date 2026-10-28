import { isValidCode, normalizeCode, hashCode, logRef } from '../utils/code.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { SessionError, SessionMode, ReceiverState } from './sessionStore.js';

/**
 * Socket.IO signaling: the ONLY traffic that leaves the browser on its way to
 * the peer besides the direct WebRTC connection itself.
 *
 * It carries: transfer codes (hashed on arrival), SDP offers/answers and ICE
 * candidates. It NEVER carries file bytes, filenames or transfer progress.
 *
 * Two send modes are served here:
 *  - direct: one sender, one receiver (original flow)
 *  - group:  one sender, up to maxReceivers receivers; every relayed signal is
 *    routed per receiver via receiverId / peerId so each receiver gets its own
 *    independent WebRTC connection.
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

  const emitTo = (socketId, event, data) => {
    if (!socketId) return;
    const target = io.sockets.sockets.get(socketId);
    if (target) target.emit(event, data);
  };

  // When the sweeper expires a session, tell every participant instead of
  // leaving their tabs stuck on a code that can never be used again.
  store.onExpire = (expired, reason) => {
    for (const socketId of [expired.senderSocketId, ...expired.receivers.keys()]) {
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
        const modeRaw = payload && payload.mode;
        let mode;
        if (modeRaw === undefined || modeRaw === SessionMode.DIRECT) mode = SessionMode.DIRECT;
        else if (modeRaw === SessionMode.GROUP) mode = SessionMode.GROUP;
        else return fail('INVALID_MODE', 'Unknown transfer mode. Use "direct" or "group".');

        const codeHash = hashCode(code);
        const created = store.create({
          codeHash,
          ip,
          senderSocketId: socket.id,
          ttlMs: config.sessionTtlMs,
          mode,
          maxReceivers: payload && payload.maxReceivers,
        });
        socket.data.role = 'sender';
        socket.data.sessionId = created.id;
        socket.data.codeHash = codeHash;
        logger.info('session created', {
          session: created.id,
          ref: logRef(codeHash),
          mode: created.mode,
          maxReceivers: created.maxReceivers,
          expiresAt: created.expiresAt,
        });
        return ok({
          sessionId: created.id,
          expiresAt: created.expiresAt,
          mode: created.mode,
          maxReceivers: created.maxReceivers,
        });
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
      sender.emit('peer:joined', {
        receiverId: socket.id,
        state: joined.state,
        receivers: joined.receivers.size,
        maxReceivers: joined.maxReceivers,
      });
      logger.info('receiver joined', {
        session: joined.id,
        ref: logRef(codeHash),
        receivers: joined.receivers.size,
      });
      return ok({
        sessionId: joined.id,
        expiresAt: joined.expiresAt,
        senderOnline: true,
        receiverId: socket.id,
        mode: joined.mode,
      });
    });

    // -------------------------------------------------------------- approve
    handle('session:approve', (payload) => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      if (socket.data.role !== 'sender') return fail('FORBIDDEN', 'Only the sender can approve.');
      const receiverId = typeof (payload && payload.receiverId) === 'string' ? payload.receiverId : null;

      let approvedId;
      try {
        approvedId = store.approve({ sessionId: current.id, socketId: socket.id, receiverId });
      } catch (error) {
        // A group receiver may have dropped between join and approval; report
        // it without tearing down the whole group session.
        if (error instanceof SessionError && error.code === 'RECEIVER_GONE' && current.mode === SessionMode.GROUP) {
          return fail('RECEIVER_GONE', error.message);
        }
        throw error;
      }

      const receiver = io.sockets.sockets.get(approvedId);
      if (!receiver) {
        store.removeReceiver({ sessionId: current.id, socketId: approvedId });
        if (current.mode === SessionMode.GROUP) {
          emitTo(current.senderSocketId, 'peer:disconnected', { role: 'receiver', receiverId: approvedId });
          return fail('RECEIVER_GONE', 'The receiver disconnected before approval.');
        }
        store.close({ sessionId: current.id, reason: 'receiver_gone' });
        detachFromSession();
        return fail('RECEIVER_GONE', 'The receiver disconnected. Share the code again.');
      }
      receiver.emit('peer:approved', { senderId: socket.id });
      logger.info('receiver approved', { session: current.id, receiver: logRef(approvedId) });
      return ok({ approved: true, receiverId: approvedId });
    });

    // ----------------------------------------------------------- approve all
    handle('session:approve-all', () => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      if (socket.data.role !== 'sender') return fail('FORBIDDEN', 'Only the sender can approve receivers.');
      const approvedIds = store.approveAll({ sessionId: current.id, socketId: socket.id });
      let live = 0;
      for (const receiverId of approvedIds) {
        const receiver = io.sockets.sockets.get(receiverId);
        if (!receiver) {
          store.removeReceiver({ sessionId: current.id, socketId: receiverId });
          emitTo(current.senderSocketId, 'peer:disconnected', { role: 'receiver', receiverId });
          continue;
        }
        receiver.emit('peer:approved', { senderId: socket.id });
        live += 1;
      }
      logger.info('all receivers approved', { session: current.id, approved: live });
      return ok({ approved: live });
    });

    // --------------------------------------------------------------- reject
    handle('session:reject', (payload) => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      if (socket.data.role !== 'sender') return fail('FORBIDDEN', 'Only the sender can reject.');
      const reason =
        typeof (payload && payload.reason) === 'string' ? payload.reason.slice(0, 200) : 'rejected_by_sender';
      const receiverId = typeof (payload && payload.receiverId) === 'string' ? payload.receiverId : null;
      const rejectedIds = store.rejectReceiver({ sessionId: current.id, socketId: socket.id, receiverId });
      for (const id of rejectedIds) emitTo(id, 'peer:rejected', { reason });
      if (current.mode === SessionMode.DIRECT) {
        // A direct transfer is over once its only receiver is declined.
        store.close({ sessionId: current.id, reason: 'sender_rejected' });
        detachFromSession();
      }
      logger.info('receiver(s) rejected', { session: current.id, rejected: rejectedIds.length });
      return ok({ rejected: rejectedIds.length });
    });

    // --------------------------------------------------------------- signal
    handle('session:signal', (payload) => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      const check = validateSignalPayload(payload && payload.signal);
      if (!check.valid) return fail('INVALID_SIGNAL', check.reason);

      const isSender = current.senderSocketId === socket.id;
      const maySignal = (receiver) =>
        receiver && (receiver.state === ReceiverState.APPROVED || receiver.state === ReceiverState.ACTIVE);

      if (isSender) {
        const receiverId = payload && payload.receiverId;
        if (current.mode === SessionMode.GROUP && typeof receiverId !== 'string') {
          return fail('INVALID_TARGET', 'Group transfers must say which receiver this signal is for.');
        }
        const receiver =
          typeof receiverId === 'string' ? current.receivers.get(receiverId) : [...current.receivers.values()][0];
        if (!maySignal(receiver)) {
          return fail('INVALID_STATE', 'Signaling is not allowed until the sender approves the receiver.');
        }
        const peer = io.sockets.sockets.get(receiver.id);
        if (!peer) return fail('PEER_GONE', 'The other participant is no longer connected.');
        peer.emit('signal', { signal: payload.signal, from: 'sender', peerId: socket.id });
        return ok();
      }

      const receiver = current.receivers.get(socket.id);
      if (!receiver) return fail('FORBIDDEN', 'You are not a member of this session.');
      if (!maySignal(receiver)) {
        return fail('INVALID_STATE', 'Signaling is not allowed until the sender approves the receiver.');
      }
      const peer = io.sockets.sockets.get(current.senderSocketId);
      if (!peer) return fail('PEER_GONE', 'The other participant is no longer connected.');
      peer.emit('signal', { signal: payload.signal, from: 'receiver', peerId: socket.id });
      return ok();
    });

    // --------------------------------------------------------------- active
    handle('session:active', (payload) => {
      const current = session();
      if (!current) return fail('NO_SESSION', 'No active transfer session.');
      const receiverId = typeof (payload && payload.receiverId) === 'string' ? payload.receiverId : null;
      store.markActive({ sessionId: current.id, socketId: socket.id, receiverId });
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
      const isReceiver = current.receivers.has(socket.id);
      if (!isSender && !isReceiver) return fail('FORBIDDEN', 'You are not a member of this session.');
      const reason =
        typeof (payload && payload.reason) === 'string' ? payload.reason.slice(0, 200) : 'cancelled';

      if (isSender) {
        for (const receiverId of current.receivers.keys()) {
          emitTo(receiverId, 'peer:cancelled', { reason, by: 'sender' });
        }
        store.close({ sessionId: current.id, reason });
        detachFromSession();
        logger.info('session cancelled', { session: current.id, by: 'sender' });
        return ok();
      }

      // Receiver cancelling: in group mode only this receiver leaves; the
      // sender keeps the session for everyone else.
      if (current.mode === SessionMode.GROUP) {
        store.removeReceiver({ sessionId: current.id, socketId: socket.id });
        emitTo(current.senderSocketId, 'peer:cancelled', { reason, by: 'receiver', receiverId: socket.id });
        detachFromSession();
        logger.info('receiver left group', { session: current.id });
        return ok({ left: true });
      }
      emitTo(current.senderSocketId, 'peer:cancelled', { reason, by: 'receiver', receiverId: socket.id });
      store.close({ sessionId: current.id, reason });
      detachFromSession();
      logger.info('session cancelled', { session: current.id, by: 'receiver' });
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
        const receiverIds = [...current.receivers.keys()];
        store.close({ sessionId, reason: `sender_${reason}` });
        for (const receiverId of receiverIds) {
          emitTo(receiverId, 'peer:disconnected', { role: 'sender', reason });
        }
        detachFromSession();
        return;
      }

      // Receiver: allow a clean re-join (page refresh) while still waiting.
      const released = store.releaseReceiver({ sessionId, socketId: socket.id });
      if (released) {
        emitTo(current.senderSocketId, 'peer:waiting-again', {
          role: 'receiver',
          receiverId: socket.id,
          reason,
        });
        detachFromSession();
        return;
      }

      if (current.mode === SessionMode.GROUP) {
        // One receiver of many dropped mid-flow: drop just them and keep the
        // session (and every other transfer) alive.
        store.removeReceiver({ sessionId, socketId: socket.id });
        emitTo(current.senderSocketId, 'peer:disconnected', {
          role: 'receiver',
          receiverId: socket.id,
          reason,
        });
        detachFromSession();
        return;
      }

      // Direct mode: the only receiver is gone, so the session is over.
      store.close({ sessionId, reason: `receiver_${reason}` });
      emitTo(current.senderSocketId, 'peer:disconnected', {
        role: 'receiver',
        receiverId: socket.id,
        reason,
      });
      detachFromSession();
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

