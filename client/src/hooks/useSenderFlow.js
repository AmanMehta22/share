import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SIGNALING_URL,
  CHUNK_SIZE,
  BUFFER_HIGH_WATER,
  LIMITS,
  RTC_CONFIG,
  CONNECTION_TIMEOUT_MS,
  SESSION_TTL_MINUTES,
} from '../config.js';
import { generateTransferCode } from '../utils/code.js';
import { SpeedMeter } from '../utils/format.js';
import { createSignalingClient, SIGNAL_EVENTS } from '../services/signaling.js';
import { PeerSession, supportsWebRTC } from '../services/webrtc.js';
import { SenderTransfer } from '../services/transfer/sender.js';
import { buildManifestEntries, validateSelection } from '../utils/selection.js';
import { describeError } from '../utils/errors.js';

/** Every state the sender screen can be in. */
export const SENDER_PHASE = Object.freeze({
  IDLE: 'idle',
  GENERATING: 'generating',
  WAITING: 'waiting',
  PAIRED: 'paired',
  CONNECTING: 'connecting',
  AWAITING_ACCEPT: 'awaiting-accept',
  TRANSFERRING: 'transferring',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  EXPIRED: 'expired',
});

const TERMINAL_PHASES = new Set([
  SENDER_PHASE.COMPLETED,
  SENDER_PHASE.REJECTED,
  SENDER_PHASE.CANCELLED,
  SENDER_PHASE.FAILED,
  SENDER_PHASE.EXPIRED,
]);

export function isTerminalSenderPhase(phase) {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Drives the whole sender flow:
 *   select files -> generate code -> receiver joins -> approve ->
 *   WebRTC negotiation -> manifest -> receiver accepts -> stream -> confirm.
 */
export function useSenderFlow() {
  const [phase, setPhaseState] = useState(SENDER_PHASE.IDLE);
  const [selection, setSelectionState] = useState(null);
  const [selectionError, setSelectionError] = useState(null);
  const [code, setCode] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [peer, setPeer] = useState({ status: 'none', connection: null });
  const [progress, setProgress] = useState({ sentBytes: 0, totalBytes: 0, fileIndex: -1 });
  const [stats, setStats] = useState({ speed: 0, eta: null });
  const [paused, setPaused] = useState(false);
  const [activeFileName, setActiveFileName] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [result, setResult] = useState(null);
  const [signalingStatus, setSignalingStatus] = useState('idle');

  const refs = useRef({
    phase: SENDER_PHASE.IDLE,
    selection: null,
    signaling: null,
    peer: null,
    engine: null,
    channel: null,
    meter: new SpeedMeter(),
    expiryTimer: null,
    timers: [],
    dirty: false,
  });

  const changePhase = useCallback((next) => {
    const value = typeof next === 'function' ? next(refs.current.phase) : next;
    refs.current.phase = value;
    refs.current.dirty = value !== SENDER_PHASE.IDLE;
    setPhaseState(value);
  }, []);

  const clearTimers = useCallback(() => {
    if (refs.current.expiryTimer) {
      clearTimeout(refs.current.expiryTimer);
      refs.current.expiryTimer = null;
    }
  }, []);

  /**
   * Release the signaling socket and peer connection.
   * `delayMs` exists so queued control frames (cancel) reach the peer before
   * the transport disappears under them.
   */
  const closeSession = useCallback(
    ({ reason = 'closed', notify = false, delayMs = 300 } = {}) => {
      const state = refs.current;
      clearTimers();
      const signaling = state.signaling;
      const peerSession = state.peer;
      state.signaling = null;
      state.peer = null;
      state.channel = null;
      state.engine = null;
      state.dirty = false;

      if (notify && signaling) {
        try {
          signaling.cancel(reason).catch(() => {});
        } catch {
          /* server already gone */
        }
      }
      if (signaling) {
        state.timers.push(
          setTimeout(() => {
            try {
              signaling.close();
            } catch {
              /* ignore */
            }
          }, delayMs)
        );
      }
      if (peerSession) {
        state.timers.push(
          setTimeout(() => {
            try {
              peerSession.close(reason);
            } catch {
              /* ignore */
            }
          }, delayMs)
        );
      }
    },
    [clearTimers]
  );

  const failFlow = useCallback(
    (info) => {
      if (isTerminalSenderPhase(refs.current.phase)) return;
      setError(info);
      changePhase(SENDER_PHASE.FAILED);
      closeSession({ reason: 'failed', notify: false });
    },
    [changePhase, closeSession]
  );

  // ---------------------------------------------------------------- selection

  const setSelection = useCallback((next) => {
    refs.current.selection = next;
    setSelectionState(next);
    setSelectionError(null);
  }, []);

  const clearSelection = useCallback(() => {
    refs.current.selection = null;
    setSelectionState(null);
    setSelectionError(null);
  }, []);

  /** Run an async selection builder and surface any SelectionError nicely. */
  const loadSelection = useCallback(
    async (builder) => {
      try {
        const built = await builder();
        setSelection(built);
        return built;
      } catch (buildError) {
        setSelectionError(describeError(buildError));
        return null;
      }
    },
    [setSelection]
  );

  // ------------------------------------------------------------------ engine

  const handleEngineResult = useCallback(
    (engineResult) => {
      // A user-initiated cancel already moved the UI to a terminal phase.
      if (isTerminalSenderPhase(refs.current.phase)) return;

      if (engineResult.status === 'complete') {
        setStats({ speed: 0, eta: null });
        setResult({
          status: 'complete',
          sentBytes: engineResult.sentBytes,
          totalBytes: engineResult.totalBytes,
          fileCount: refs.current.selection?.fileCount ?? 0,
        });
        changePhase(SENDER_PHASE.COMPLETED);
        closeSession({ reason: 'completed', notify: false });
        return;
      }

      if (engineResult.status === 'cancelled') {
        const by = engineResult.error?.by ?? engineResult.by ?? 'sender';
        setResult({
          status: 'cancelled',
          reason: engineResult.reason ?? 'Transfer cancelled.',
          by,
        });
        changePhase(SENDER_PHASE.CANCELLED);
        closeSession({ reason: 'cancelled', notify: false });
        return;
      }

      if (engineResult.status === 'rejected') {
        setError(
          describeError(
            Object.assign(new Error(engineResult.reason ?? 'The receiver declined the transfer.'), {
              code: 'REJECTED',
            })
          )
        );
        changePhase(SENDER_PHASE.REJECTED);
        closeSession({ reason: 'rejected', notify: false });
        return;
      }

      failFlow(describeError(engineResult.error ?? new Error(engineResult.reason ?? 'Transfer failed.')));
    },
    [changePhase, closeSession, failFlow]
  );

  const handleEngineEvent = useCallback(
    (event) => {
      switch (event.type) {
        case 'progress': {
          const meter = refs.current.meter;
          meter.update(event.sentBytes);
          const remaining = Math.max(0, event.totalBytes - event.sentBytes);
          setProgress({
            sentBytes: event.sentBytes,
            totalBytes: event.totalBytes,
            fileIndex: event.fileIndex,
          });
          setStats({ speed: meter.value(), eta: meter.eta(remaining) });
          setPaused(event.paused === true);
          break;
        }
        case 'accepted':
          changePhase(SENDER_PHASE.TRANSFERRING);
          break;
        case 'file-start':
          setActiveFileName(event.name);
          break;
        case 'file-end':
          setActiveFileName(null);
          break;
        case 'paused':
          setPaused(true);
          break;
        case 'resumed':
          setPaused(false);
          break;
        case 'cancelled':
          setNotice({ kind: 'warn', text: event.reason ?? 'Transfer cancelled.' });
          break;
        case 'error':
          setError(describeError(event.error));
          break;
        default:
          break;
      }
    },
    [changePhase]
  );

  const startEngine = useCallback(
    (channel) => {
      const state = refs.current;
      if (state.engine || !state.selection) return;

      const entries = buildManifestEntries(state.selection);
      state.meter = new SpeedMeter();

      const engine = new SenderTransfer({
        channel,
        files: entries,
        chunkSize: CHUNK_SIZE,
        highWater: BUFFER_HIGH_WATER,
        limits: LIMITS,
        onEvent: handleEngineEvent,
      });
      state.engine = engine;

      setProgress({ sentBytes: 0, totalBytes: engine.totalBytes, fileIndex: -1 });
      setStats({ speed: 0, eta: null });
      setPaused(false);
      setPeer((previous) => ({ ...previous, status: 'connected', connection: 'connected' }));
      changePhase(SENDER_PHASE.AWAITING_ACCEPT);

      if (state.signaling) {
        // Tell the server the channel is live so the session stops counting
        // against the inactivity TTL.
        state.signaling.markActive().catch(() => {});
      }

      engine.run().then(handleEngineResult).catch((runError) => failFlow(describeError(runError)));
    },
    [changePhase, failFlow, handleEngineEvent, handleEngineResult]
  );

  // ------------------------------------------------------------------- WebRTC

  const startPeer = useCallback(
    async (signaling) => {
      const peerSession = new PeerSession({
        role: 'sender',
        config: RTC_CONFIG,
        timeoutMs: CONNECTION_TIMEOUT_MS,
        emitSignal: async (signal) => {
          await signaling.signal(signal);
        },
        onDataChannel: (channel) => {
          refs.current.channel = channel;
        },
        onStateChange: (connectionState) => {
          setPeer((previous) => ({
            ...previous,
            connection: connectionState,
            status: connectionState === 'connected' ? 'connected' : previous.status,
          }));
          if (connectionState === 'connected' && refs.current.channel) {
            startEngine(refs.current.channel);
          }
        },
        onError: (connectionError) => {
          if (isTerminalSenderPhase(refs.current.phase)) return;
          failFlow(describeError(connectionError));
        },
      });

      refs.current.peer = peerSession;
      setPeer({ status: 'connecting', connection: 'connecting' });
      await peerSession.start();
      setPeer((previous) => ({ ...previous, connection: 'connecting' }));
    },
    [failFlow, startEngine]
  );

  // ------------------------------------------------------------------ signaling

  const wireSignalingEvents = useCallback(
    (signaling) => {
      signaling.on(SIGNAL_EVENTS.PEER_JOINED, () => {
        setPeer((previous) => ({ ...previous, status: 'joined' }));
        changePhase((current) => (current === SENDER_PHASE.WAITING ? SENDER_PHASE.PAIRED : current));
        setNotice({ kind: 'info', text: 'A receiver joined. Approve them to continue.' });
      });

      signaling.on(SIGNAL_EVENTS.PEER_WAITING_AGAIN, () => {
        const current = refs.current.phase;
        if (current === SENDER_PHASE.PAIRED || current === SENDER_PHASE.CONNECTING) {
          setPeer({ status: 'none', connection: null });
          changePhase(SENDER_PHASE.WAITING);
          setNotice({ kind: 'warn', text: 'The receiver disconnected before approval. Share the code again.' });
        }
      });

      signaling.on(SIGNAL_EVENTS.PEER_REJECTED, (payload) => {
        if (isTerminalSenderPhase(refs.current.phase)) return;
        setError(
          describeError(Object.assign(new Error(payload?.reason ?? 'The receiver declined.'), { code: 'REJECTED' }))
        );
        changePhase(SENDER_PHASE.REJECTED);
        closeSession({ reason: 'rejected', notify: false });
      });

      signaling.on(SIGNAL_EVENTS.PEER_DISCONNECTED, (payload) => {
        if (isTerminalSenderPhase(refs.current.phase)) return;
        const current = refs.current.phase;
        if (payload?.role === 'receiver' && (current === SENDER_PHASE.WAITING || current === SENDER_PHASE.PAIRED)) {
          setPeer({ status: 'none', connection: null });
          changePhase(SENDER_PHASE.WAITING);
          setNotice({ kind: 'warn', text: 'The receiver disconnected. Share the code with them again.' });
          return;
        }
        failFlow(describeError(Object.assign(new Error('The other computer disconnected.'), { code: 'PEER_CLOSED' })));
      });

      signaling.on(SIGNAL_EVENTS.PEER_CANCELLED, (payload) => {
        if (isTerminalSenderPhase(refs.current.phase)) return;
        const by = payload?.by ?? 'receiver';
        const reason =
          by === 'sender'
            ? payload?.reason ?? 'Cancelled.'
            : `The receiver cancelled the transfer${payload?.reason ? `: ${payload.reason}` : '.'}`;
        setResult({ status: 'cancelled', reason, by });
        changePhase(SENDER_PHASE.CANCELLED);
        closeSession({ reason: 'cancelled', notify: false });
      });

      signaling.on(SIGNAL_EVENTS.PEER_EXPIRED, () => {
        if (isTerminalSenderPhase(refs.current.phase)) return;
        const current = refs.current.phase;
        if (current === SENDER_PHASE.TRANSFERRING || current === SENDER_PHASE.AWAITING_ACCEPT) return;
        setError(
          describeError(
            Object.assign(new Error('The transfer session expired. Generate a new code.'), {
              code: 'NOT_FOUND',
            })
          )
        );
        changePhase(SENDER_PHASE.EXPIRED);
        closeSession({ reason: 'expired', notify: false, delayMs: 0 });
      });

      signaling.on(SIGNAL_EVENTS.SIGNAL, (payload) => {
        const peerSession = refs.current.peer;
        if (!peerSession || !payload?.signal) return;
        Promise.resolve(peerSession.handleSignal(payload.signal)).catch((signalError) => {
          failFlow(describeError(signalError));
        });
      });

      signaling.onConnectionChange((status) => {
        setSignalingStatus(status);
      });
    },
    [changePhase, closeSession, failFlow]
  );

  const startExpiryTimer = useCallback(
    (expiryMs) => {
      if (!Number.isFinite(expiryMs)) return;
      const delay = Math.min(Math.max(expiryMs - Date.now() + 1000, 1000), 60 * 60 * 1000);
      refs.current.expiryTimer = setTimeout(() => {
        const current = refs.current.phase;
        if (current !== SENDER_PHASE.WAITING && current !== SENDER_PHASE.PAIRED) return;
        setError(
          describeError(
            Object.assign(
              new Error('This transfer code expired before anyone used it. Generate a new one.'),
              { code: 'NOT_FOUND' }
            )
          )
        );
        changePhase(SENDER_PHASE.EXPIRED);
        closeSession({ reason: 'expired', notify: true, delayMs: 200 });
      }, delay);
    },
    [changePhase, closeSession]
  );

  // ---------------------------------------------------------------- public API

  const generateCode = useCallback(async () => {
    const currentSelection = refs.current.selection;
    if (!currentSelection) {
      setSelectionError(describeError(new Error('Select a ZIP file or a folder first.')));
      return null;
    }
    const problems = validateSelection(currentSelection);
    if (problems.length > 0) {
      setSelectionError(describeError(new Error(problems.join(' '))));
      return null;
    }
    if (!supportsWebRTC()) {
      failFlow(
        describeError(
          Object.assign(
            new Error('This browser does not support WebRTC, which is required for direct transfers.'),
            { code: 'UNSUPPORTED_BROWSER' }
          )
        )
      );
      return null;
    }

    clearTimers();
    setError(null);
    setNotice(null);
    setResult(null);
    setSelectionError(null);
    setPeer({ status: 'none', connection: null });
    changePhase(SENDER_PHASE.GENERATING);

    const newCode = generateTransferCode();
    const signaling = createSignalingClient({ url: SIGNALING_URL });
    refs.current.signaling = signaling;
    wireSignalingEvents(signaling);

    try {
      await signaling.connect();
      const response = await signaling.createSession(newCode);
      refs.current.code = newCode;
      setCode(newCode);
      const expiry = Number.isFinite(response?.expiresAt)
        ? response.expiresAt
        : Date.now() + SESSION_TTL_MINUTES * 60_000;
      setExpiresAt(expiry);
      startExpiryTimer(expiry);
      changePhase(SENDER_PHASE.WAITING);
      return newCode;
    } catch (sessionError) {
      closeSession({ reason: 'setup-failed', notify: false, delayMs: 0 });
      failFlow(describeError(sessionError));
      return null;
    }
  }, [changePhase, clearTimers, closeSession, failFlow, setSelectionError, startExpiryTimer, wireSignalingEvents]);

  const approveReceiver = useCallback(async () => {
    const state = refs.current;
    if (state.phase !== SENDER_PHASE.PAIRED || !state.signaling) return;
    setError(null);
    setNotice(null);
    changePhase(SENDER_PHASE.CONNECTING);
    setPeer((previous) => ({ ...previous, status: 'approved' }));
    try {
      await state.signaling.approve();
      await startPeer(state.signaling);
    } catch (approvalError) {
      failFlow(describeError(approvalError));
    }
  }, [changePhase, failFlow, startPeer]);

  const declineReceiver = useCallback(async () => {
    const state = refs.current;
    if (state.phase !== SENDER_PHASE.PAIRED) return;
    try {
      if (state.signaling) await state.signaling.rejectPeer('The sender declined this receiver.');
    } catch {
      /* closing the session below is enough */
    }
    setResult({ status: 'cancelled', reason: 'You declined the receiver. Generate a new code to transfer again.' });
    changePhase(SENDER_PHASE.CANCELLED);
    closeSession({ reason: 'declined', notify: false, delayMs: 200 });
  }, [changePhase, closeSession]);

  const pauseTransfer = useCallback(() => {
    const engine = refs.current.engine;
    if (engine && !engine.finished) engine.pause('sender');
  }, []);

  const resumeTransfer = useCallback(() => {
    const engine = refs.current.engine;
    if (engine && !engine.finished) engine.resume('sender');
  }, []);

  const cancelTransfer = useCallback(
    (reason = 'Cancelled by the sender') => {
      if (isTerminalSenderPhase(refs.current.phase)) return;
      const state = refs.current;
      if (state.engine && !state.engine.finished) {
        state.engine.cancel(reason, 'sender');
      }
      setResult({ status: 'cancelled', reason, by: 'sender' });
      changePhase(SENDER_PHASE.CANCELLED);
      // Notify the receiver through signaling as well: this still works when
      // the data channel itself has already broken.
      closeSession({ reason, notify: true });
    },
    [changePhase, closeSession]
  );

  const reset = useCallback(() => {
    closeSession({ reason: 'reset', notify: true, delayMs: 200 });
    refs.current.meter = new SpeedMeter();
    setCode(null);
    setExpiresAt(null);
    setPeer({ status: 'none', connection: null });
    setProgress({ sentBytes: 0, totalBytes: 0, fileIndex: -1 });
    setStats({ speed: 0, eta: null });
    setPaused(false);
    setActiveFileName(null);
    setError(null);
    setNotice(null);
    setResult(null);
    setSelectionError(null);
    changePhase(SENDER_PHASE.IDLE);
  }, [changePhase, closeSession]);

  // ------------------------------------------------------------------- effects

  useEffect(() => {
    const beforeUnload = (event) => {
      if (!refs.current.dirty) return;
      event.preventDefault();
      // Browsers show their own generic message; the text is ignored on Chrome.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      // Detach sockets, timers and peer connections when the view unmounts.
      closeSession({ reason: 'unmount', notify: false, delayMs: 0 });
    };
  }, [closeSession]);

  return {
    phase,
    code,
    expiresAt,
    selection,
    selectionError,
    peer,
    progress,
    stats,
    paused,
    activeFileName,
    error,
    notice,
    result,
    signalingStatus,
    setSelection,
    clearSelection,
    loadSelection,
    generateCode,
    approveReceiver,
    declineReceiver,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    reset,
    isTerminal: isTerminalSenderPhase(phase),
  };
}
