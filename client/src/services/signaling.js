import { io } from 'socket.io-client';
import { SIGNALING_URL } from '../config.js';

/**
 * Thin promise-based wrapper around the Socket.IO signaling client.
 *
 * Only connection metadata travels through here:
 *   - the transfer code (hashed server-side)
 *   - SDP offers/answers and ICE candidates
 *
 * File names, file sizes, progress and file bytes are NEVER sent to this
 * server - they travel directly between the two browsers over WebRTC.
 */

export class SignalingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SignalingError';
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 12_000;

/** Peer lifecycle events the UI subscribes to. */
export const SIGNAL_EVENTS = Object.freeze({
  PEER_JOINED: 'peer:joined',
  PEER_APPROVED: 'peer:approved',
  PEER_REJECTED: 'peer:rejected',
  PEER_DISCONNECTED: 'peer:disconnected',
  PEER_WAITING_AGAIN: 'peer:waiting-again',
  PEER_CANCELLED: 'peer:cancelled',
  PEER_EXPIRED: 'peer:expired',
  SIGNAL: 'signal',
});

/**
 * @param {{url?: string, timeoutMs?: number}} [options]
 */
export function createSignalingClient(options = {}) {
  const { url = SIGNALING_URL, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const target = url ? url.replace(/\/+$/, '') : undefined;

  const socket = io(target, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 4,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
    timeout: CONNECT_TIMEOUT_MS,
    withCredentials: false,
    forceNew: true,
  });

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  let closed = false;

  const forward = (event, ...args) => {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(...args);
      } catch (error) {
        // A UI handler must never break the socket pipeline.
        console.warn('signaling listener failed', event, error);
      }
    }
  };

  for (const event of Object.values(SIGNAL_EVENTS)) {
    socket.on(event, (payload) => forward(event, payload));
  }

  const connectionWatchers = new Set();
  const notifyConnection = (state) => {
    for (const watcher of [...connectionWatchers]) {
      try {
        watcher(state);
      } catch (error) {
        console.warn('connection watcher failed', error);
      }
    }
  };

  socket.on('connect', () => notifyConnection('connected'));
  socket.on('disconnect', (reason) => notifyConnection(`disconnected:${reason}`));
  socket.on('connect_error', (error) => {
    notifyConnection('error');
    forward('connect_error', error);
  });

  function request(event, payload) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new SignalingError('CLIENT_CLOSED', 'The signaling client has been closed.'));
        return;
      }
      if (!socket.connected) {
        reject(
          new SignalingError(
            'NOT_CONNECTED',
            'Not connected to the signaling server. Check that it is running and reachable.'
          )
        );
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new SignalingError('TIMEOUT', 'The signaling server did not respond in time.'));
      }, timeoutMs);

      socket.emit(event, payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!response || typeof response !== 'object') {
          reject(new SignalingError('BAD_RESPONSE', 'The signaling server returned an invalid response.'));
          return;
        }
        if (response.ok === true) {
          resolve(response);
          return;
        }
        reject(
          new SignalingError(
            typeof response.error === 'string' ? response.error : 'REQUEST_FAILED',
            typeof response.message === 'string' ? response.message : 'Signaling request failed.'
          )
        );
      });
    });
  }

  return {
    get connected() {
      return socket.connected;
    },

    get id() {
      return socket.id ?? null;
    },

    /** Open the socket and wait for the handshake (or fail with a clear error). */
    connect() {
      if (closed) return Promise.reject(new SignalingError('CLIENT_CLOSED', 'Client already closed.'));
      if (socket.connected) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.off('connect', onConnect);
          socket.off('connect_error', onError);
          fn(value);
        };
        const onConnect = () => finish(resolve, undefined);
        const onError = (error) =>
          finish(
            reject,
            new SignalingError(
              'UNAVAILABLE',
              `Cannot reach the signaling server (${error?.message ?? 'connection error'}). ` +
                'Start it with "npm run dev:server" or check VITE_SIGNALING_URL.'
            )
          );
        const timer = setTimeout(
          () =>
            finish(
              reject,
              new SignalingError('TIMEOUT', 'Timed out connecting to the signaling server.')
            ),
          CONNECT_TIMEOUT_MS
        );
        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
        socket.connect();
      });
    },

    /** Subscribe to a raw socket event. Returns an unsubscribe function. */
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(event);
      };
    },

    /** Watch connection state changes: 'connected' | 'disconnected:*' | 'error'. */
    onConnectionChange(handler) {
      connectionWatchers.add(handler);
      handler(socket.connected ? 'connected' : 'disconnected:initial');
      return () => connectionWatchers.delete(handler);
    },

    createSession: (code, options = {}) =>
      request('session:create', {
        code,
        mode: options.mode,
        maxReceivers: options.maxReceivers,
      }),
    joinSession: (code) => request('session:join', { code }),
    approve: (receiverId) => request('session:approve', receiverId ? { receiverId } : {}),
    approveAll: () => request('session:approve-all', {}),
    rejectPeer: (reason, receiverId) =>
      request('session:reject', receiverId ? { reason, receiverId } : { reason }),
    signal: (signal, receiverId) => request('session:signal', receiverId ? { signal, receiverId } : { signal }),
    markActive: (receiverId) => request('session:active', receiverId ? { receiverId } : {}),
    cancel: (reason) => request('session:cancel', { reason }),
    leave: () => request('session:leave', {}),

    /** Detach every listener and close the socket. Safe to call twice. */
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      connectionWatchers.clear();
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}
