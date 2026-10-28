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
import { SenderGroup } from '../services/transfer/senderGroup.js';
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

/** The two ways to send: one receiver, or a whole group sharing one code. */
export const SEND_MODE = Object.freeze({
  DIRECT: 'direct',
  GROUP: 'group',
});

/** Group sizes offered in the UI (server may cap lower via MAX_RECEIVERS). */
export const GROUP_SIZE_OPTIONS = Object.freeze([2, 3, 5, 10]);

/** Per-receiver states in a group transfer. */
export const RECEIVER_ROW_STATE = Object.freeze({
  WAITING: 'waiting', // joined, waiting for sender approval
  APPROVED: 'approved', // sender approved, WebRTC negotiation starting
  CONNECTING: 'connecting', // negotiating the peer connection
  AWAITING_ACCEPT: 'awaiting-accept', // manifest sent, receiver reviewing files
  TRANSFERRING: 'transferring', // bytes are flowing
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  DISCONNECTED: 'disconnected',
});

const ROW_TERMINAL_STATES = new Set([
  RECEIVER_ROW_STATE.COMPLETED,
  RECEIVER_ROW_STATE.REJECTED,
  RECEIVER_ROW_STATE.CANCELLED,
  RECEIVER_ROW_STATE.FAILED,
  RECEIVER_ROW_STATE.DISCONNECTED,
]);

const TERMINAL_PHASES = new Set([
  SENDER_PHASE.COMPLETED,
  SENDER_PHASE.REJECTED,
  SENDER_PHASE.CANCELLED,
  SENDER_PHASE.FAILED,
  SENDER_PHASE.EXPIRED,
]);

/** Active (non-terminal) phases a group row set may move between. */
const ACTIVE_PHASES = new Set([
  SENDER_PHASE.WAITING,
  SENDER_PHASE.PAIRED,
  SENDER_PHASE.CONNECTING,
  SENDER_PHASE.AWAITING_ACCEPT,
  SENDER_PHASE.TRANSFERRING,
]);

export function isTerminalSenderPhase(phase) {
  return TERMINAL_PHASES.has(phase);
}

function rowStateForResult(status) {
  if (status === 'complete') return RECEIVER_ROW_STATE.COMPLETED;
  if (status === 'rejected') return RECEIVER_ROW_STATE.REJECTED;
  if (status === 'cancelled') return RECEIVER_ROW_STATE.CANCELLED;
  return RECEIVER_ROW_STATE.FAILED;
}

function makeRow(id) {
  return {
    id,
    state: RECEIVER_ROW_STATE.WAITING,
    connection: null,
    sentBytes: 0,
    totalBytes: 0,
    speed: 0,
    paused: false,
    fileName: null,
    error: null,
    meter: new SpeedMeter(),
    peerSession: null,
    channel: null,
    engineStarted: false,
  };
}

/**
 * Drives the whole sender flow in both modes:
 *   direct: select files -> code -> one receiver joins -> approve -> stream.
 *   group:  select files -> code -> up to N receivers join -> approve each
 *           (or all) -> one independent WebRTC stream per receiver.
 */
export function useSenderFlow() {
  const [phase, setPhaseState] = useState(SENDER_PHASE.IDLE);
  const [selection, setSelectionState] = useState(null);
  const [selectionError, setSelectionError] = useState(null);
  const [code, setCode] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [peer, setPeer] = useState({ status: 'none', connection: null });
  const [receivers, setReceivers] = useState([]); // group mode: one row per receiver
  const [mode, setModeState] = useState(SEND_MODE.DIRECT);
  const [groupSize, setGroupSizeState] = useState(3);
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
    mode: SEND_MODE.DIRECT,
    groupSize: 3,
    /** @type {Map<string, object>} group mode: receiverId -> row */
    receivers: new Map(),
    group: null,
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

  /** Push the row map into React state (snapshot without engine internals). */
  const refreshGroup = useCallback(() => {
    const state = refs.current;
    setReceivers(
      [...state.receivers.values()].map((row) => ({
        id: row.id,
        state: row.state,
        connection: row.connection,
        sentBytes: row.sentBytes,
        totalBytes: row.totalBytes,
        speed: row.meter ? row.meter.value() : 0,
        paused: row.paused === true,
        fileName: row.fileName ?? null,
        error: row.error ?? null,
      }))
    );

    // Aggregate progress/speed across every receiver.
    let sentBytes = 0;
    let totalBytes = 0;
    let anyPaused = false;
    for (const row of state.receivers.values()) {
      sentBytes += row.sentBytes;
      totalBytes += row.totalBytes;
      if (row.paused && !ROW_TERMINAL_STATES.has(row.state)) anyPaused = true;
    }
    if (state.receivers.size > 0) {
      state.meter.update(sentBytes);
      setProgress({ sentBytes, totalBytes, fileIndex: -1 });
      setStats({ speed: state.meter.value(), eta: state.meter.eta(Math.max(0, totalBytes - sentBytes)) });
      setPaused(anyPaused);
    }

    // Derive the screen phase from the rows (group mode only).
    if (!ACTIVE_PHASES.has(state.phase)) return;
    const rows = [...state.receivers.values()];
    if (rows.length === 0) {
      changePhase(SENDER_PHASE.WAITING);
      return;
    }
    if (rows.some((row) => row.state === RECEIVER_ROW_STATE.TRANSFERRING)) {
      changePhase(SENDER_PHASE.TRANSFERRING);
      return;
    }
    if (rows.some((row) => row.state === RECEIVER_ROW_STATE.AWAITING_ACCEPT)) {
      changePhase(SENDER_PHASE.AWAITING_ACCEPT);
      return;
    }
    if (rows.some((row) => row.state === RECEIVER_ROW_STATE.CONNECTING || row.state === RECEIVER_ROW_STATE.APPROVED)) {
      changePhase(SENDER_PHASE.CONNECTING);
      return;
    }
    if (rows.some((row) => row.state === RECEIVER_ROW_STATE.WAITING)) {
      changePhase(SENDER_PHASE.PAIRED);
      return;
    }
    // Every row is terminal but the engines (if any) still decide the outcome.
    changePhase(SENDER_PHASE.WAITING);
  }, [changePhase]);

  /** Snapshot of the rows for result screens (no engine internals). */
  const snapshotRows = useCallback(() => {
    return [...refs.current.receivers.values()].map((row, index) => ({
      id: row.id,
      index: index + 1,
      state: row.state,
      sentBytes: row.sentBytes,
      totalBytes: row.totalBytes,
      reason: row.error?.detail ?? null,
    }));
  }, []);

  /**
   * Release the signaling socket and peer connection(s).
   * `delayMs` exists so queued control frames (cancel) reach the peer before
   * the transport disappears under them.
   */
  const closeSession = useCallback(
    ({ reason = 'closed', notify = false, delayMs = 300 } = {}) => {
      const state = refs.current;
      clearTimers();
      const signaling = state.signaling;
      const peerSession = state.peer;
      const group = state.group;
      state.signaling = null;
      state.peer = null;
      state.channel = null;
      state.engine = null;
      state.dirty = false;
      state.group = null;

      // Group mode: stop leftover engines and close every receiver connection.
      if (group) {
        try {
          group.cancelAll('The transfer session closed.');
        } catch {
          /* engines may already be finished */
        }
      }
      for (const row of state.receivers.values()) {
        try {
          row.peerSession?.close(reason);
        } catch {
          /* already gone */
        }
      }
      state.receivers.clear();
      setReceivers([]);

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

  // ------------------------------------------------------- engine (direct mode)

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

  // ------------------------------------------------------- WebRTC (direct mode)

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

  // -------------------------------------------------- group engine orchestration

  const maybeFinishGroup = useCallback(() => {
    const state = refs.current;
    if (state.mode !== SEND_MODE.GROUP || !state.group) return;
    if (isTerminalSenderPhase(state.phase)) return;
    const rows = [...state.receivers.values()];
    if (rows.some((row) => !ROW_TERMINAL_STATES.has(row.state))) return; // someone still pending
    if (state.group.size > 0 && !state.group.allTerminal) return; // engines still running

    const summary = state.group.summary();
    if (!summary) {
      // Nobody ever started a transfer and no receiver is left: keep the code
      // alive so someone else can still join.
      changePhase(SENDER_PHASE.WAITING);
      setNotice({ kind: 'warn', text: 'No receivers are left. Share the code with someone else.' });
      return;
    }

    const results = summary.results.map((peerResult, index) => ({
      id: peerResult.id,
      index: index + 1,
      state: peerResult.state,
      sentBytes: peerResult.sentBytes ?? 0,
      totalBytes: peerResult.totalBytes ?? 0,
      reason: peerResult.result?.reason ?? peerResult.error?.message ?? null,
    }));
    const completed = results.filter((row) => row.state === RECEIVER_ROW_STATE.COMPLETED);
    const sentBytes = results.reduce((sum, row) => sum + row.sentBytes, 0);

    if (summary.status === 'complete') {
      setStats({ speed: 0, eta: null });
      setResult({
        status: 'complete',
        sentBytes,
        totalBytes: refs.current.selection?.totalBytes ?? sentBytes,
        fileCount: refs.current.selection?.fileCount ?? 0,
        receivers: results,
        completedCount: completed.length,
      });
      changePhase(SENDER_PHASE.COMPLETED);
      closeSession({ reason: 'completed', notify: false });
      return;
    }
    if (summary.status === 'cancelled') {
      setResult({
        status: 'cancelled',
        reason: 'Every receiver cancelled or disconnected.',
        by: 'receiver',
        receivers: results,
      });
      changePhase(SENDER_PHASE.CANCELLED);
      closeSession({ reason: 'cancelled', notify: false });
      return;
    }
    setError(
      describeError(
        Object.assign(new Error('No receiver completed the transfer.'), { code: 'TRANSFER_FAILED' })
      )
    );
    setResult({ status: 'failed', receivers: results });
    changePhase(SENDER_PHASE.FAILED);
    closeSession({ reason: 'failed', notify: false });
  }, [changePhase, closeSession]);

  const handleGroupEvent = useCallback(
    (event) => {
      const state = refs.current;
      const row = state.receivers.get(event.receiverId);
      switch (event.type) {
        case 'peer-started': {
          if (!row) return;
          row.state = RECEIVER_ROW_STATE.AWAITING_ACCEPT;
          row.totalBytes = event.peer.totalBytes;
          break;
        }
        case 'peer-event': {
          if (!row) return;
          const payload = event.event;
          if (payload.type === 'progress') {
            row.sentBytes = payload.sentBytes;
            row.totalBytes = payload.totalBytes;
            row.paused = payload.paused === true;
            row.meter?.update(payload.sentBytes);
          } else if (payload.type === 'accepted') {
            row.state = RECEIVER_ROW_STATE.TRANSFERRING;
            row.paused = false;
          } else if (payload.type === 'file-start') {
            row.fileName = payload.name ?? null;
          } else if (payload.type === 'file-end') {
            row.fileName = null;
          } else if (payload.type === 'paused') {
            row.paused = true;
          } else if (payload.type === 'resumed') {
            row.paused = false;
          }
          break;
        }
        case 'peer-result': {
          if (!row) return;
          row.state = rowStateForResult(event.result?.status);
          row.paused = false;
          row.error =
            event.result?.status === 'failed'
              ? describeError(event.result?.error ?? new Error(event.result?.reason ?? 'Transfer failed.'))
              : null;
          break;
        }
        default:
          return;
      }
      refreshGroup();
      if (event.type === 'peer-result') maybeFinishGroup();
    },
    [maybeFinishGroup, refreshGroup]
  );

  /** Create the per-receiver peer connection + engine for one approved receiver. */
  const startGroupPeer = useCallback(
    async (receiverId) => {
      const state = refs.current;
      const row = state.receivers.get(receiverId);
      if (!row || !state.signaling || !state.selection || !state.group) return;

      row.state = RECEIVER_ROW_STATE.CONNECTING;
      refreshGroup();

      const entries = buildManifestEntries(state.selection);
      const signaling = state.signaling;
      const group = state.group;

      const peerSession = new PeerSession({
        role: 'sender',
        config: RTC_CONFIG,
        timeoutMs: CONNECTION_TIMEOUT_MS,
        emitSignal: async (signal) => {
          await signaling.signal(signal, receiverId);
        },
        onDataChannel: (channel) => {
          row.channel = channel;
        },
        onStateChange: (connectionState) => {
          row.connection = connectionState;
          if (connectionState === 'connected' && row.channel && !row.engineStarted) {
            row.engineStarted = true;
            group.startPeer(receiverId, {
              channel: row.channel,
              files: entries,
              chunkSize: CHUNK_SIZE,
              highWater: BUFFER_HIGH_WATER,
              limits: LIMITS,
            });
            // Tell the server this receiver's channel is live so the session
            // stops counting against the inactivity TTL.
            signaling.markActive(receiverId).catch(() => {});
          }
          refreshGroup();
        },
        onError: (connectionError) => {
          if (ROW_TERMINAL_STATES.has(row.state)) return;
          row.state = RECEIVER_ROW_STATE.FAILED;
          row.error = describeError(connectionError);
          refreshGroup();
          maybeFinishGroup();
        },
      });

      row.peerSession = peerSession;
      refreshGroup();
      try {
        await peerSession.start();
      } catch (startError) {
        if (ROW_TERMINAL_STATES.has(row.state)) return;
        row.state = RECEIVER_ROW_STATE.FAILED;
        row.error = describeError(startError);
        refreshGroup();
        maybeFinishGroup();
      }
    },
    [maybeFinishGroup, refreshGroup]
  );

  const approveGroupReceiver = useCallback(
    async (receiverId) => {
      const state = refs.current;
      const row = state.receivers.get(receiverId);
      if (!row || row.state !== RECEIVER_ROW_STATE.WAITING || !state.signaling) return;
      try {
        await state.signaling.approve(receiverId);
        row.state = RECEIVER_ROW_STATE.APPROVED;
        refreshGroup();
        await startGroupPeer(receiverId);
      } catch (approvalError) {
        if (approvalError?.code === 'RECEIVER_GONE') {
          state.receivers.delete(receiverId);
          setNotice({ kind: 'warn', text: 'A receiver left before you approved them.' });
          refreshGroup();
          maybeFinishGroup();
          return;
        }
        row.state = RECEIVER_ROW_STATE.FAILED;
        row.error = describeError(approvalError);
        refreshGroup();
        maybeFinishGroup();
      }
    },
    [maybeFinishGroup, refreshGroup, startGroupPeer]
  );

  const approveAllReceivers = useCallback(async () => {
    const state = refs.current;
    if (state.mode !== SEND_MODE.GROUP || !state.signaling) return;
    const waiting = [...state.receivers.values()].filter(
      (row) => row.state === RECEIVER_ROW_STATE.WAITING
    );
    if (waiting.length === 0) return;
    try {
      await state.signaling.approveAll();
      for (const row of waiting) {
        const live = state.receivers.get(row.id);
        if (live && live.state === RECEIVER_ROW_STATE.WAITING) {
          live.state = RECEIVER_ROW_STATE.APPROVED;
          startGroupPeer(row.id);
        }
      }
      refreshGroup();
    } catch (approvalError) {
      if (approvalError?.code === 'INVALID_STATE') return;
      setNotice({ kind: 'warn', text: describeError(approvalError).detail });
    }
  }, [refreshGroup, startGroupPeer]);

  const declineGroupReceiver = useCallback(
    async (receiverId) => {
      const state = refs.current;
      if (!state.receivers.has(receiverId)) return;
      try {
        if (state.signaling) {
          await state.signaling.rejectPeer('The sender declined this receiver.', receiverId);
        }
      } catch {
        /* removing the row below is enough */
      }
      state.receivers.delete(receiverId);
      setNotice({ kind: 'info', text: 'A receiver was declined.' });
      refreshGroup();
      maybeFinishGroup();
    },
    [maybeFinishGroup, refreshGroup]
  );

  // ---------------------------------------------------------------- signaling

  const wireSignalingEvents = useCallback(
    (signaling) => {
      signaling.on(SIGNAL_EVENTS.PEER_JOINED, (payload) => {
        if (refs.current.mode === SEND_MODE.GROUP) {
          const receiverId = payload?.receiverId;
          if (receiverId && !refs.current.receivers.has(receiverId)) {
            refs.current.receivers.set(receiverId, makeRow(receiverId));
            refreshGroup();
            setNotice({
              kind: 'info',
              text: `${refs.current.receivers.size} of ${refs.current.groupSize} receivers joined. Approve them to continue.`,
            });
          }
          return;
        }
        setPeer((previous) => ({ ...previous, status: 'joined' }));
        changePhase((current) => (current === SENDER_PHASE.WAITING ? SENDER_PHASE.PAIRED : current));
        setNotice({ kind: 'info', text: 'A receiver joined. Approve them to continue.' });
      });

      signaling.on(SIGNAL_EVENTS.PEER_WAITING_AGAIN, (payload) => {
        if (refs.current.mode === SEND_MODE.GROUP) {
          const row = refs.current.receivers.get(payload?.receiverId);
          if (row && row.state === RECEIVER_ROW_STATE.WAITING) {
            refs.current.receivers.delete(payload.receiverId);
            refreshGroup();
            setNotice({ kind: 'warn', text: 'A receiver left before approval. The code still works.' });
          }
          return;
        }
        const current = refs.current.phase;
        if (current === SENDER_PHASE.PAIRED || current === SENDER_PHASE.CONNECTING) {
          setPeer({ status: 'none', connection: null });
          changePhase(SENDER_PHASE.WAITING);
          setNotice({ kind: 'warn', text: 'The receiver disconnected before approval. Share the code again.' });
        }
      });

      signaling.on(SIGNAL_EVENTS.PEER_REJECTED, (payload) => {
        if (isTerminalSenderPhase(refs.current.phase)) return;
        if (refs.current.mode === SEND_MODE.GROUP) {
          const row = refs.current.receivers.get(payload?.receiverId);
          if (row && !ROW_TERMINAL_STATES.has(row.state)) {
            row.state = RECEIVER_ROW_STATE.REJECTED;
            refreshGroup();
            maybeFinishGroup();
          }
          return;
        }
        setError(
          describeError(Object.assign(new Error(payload?.reason ?? 'The receiver declined.'), { code: 'REJECTED' }))
        );
        changePhase(SENDER_PHASE.REJECTED);
        closeSession({ reason: 'rejected', notify: false });
      });

      signaling.on(SIGNAL_EVENTS.PEER_DISCONNECTED, (payload) => {
        if (isTerminalSenderPhase(refs.current.phase)) return;
        if (refs.current.mode === SEND_MODE.GROUP) {
          const row = refs.current.receivers.get(payload?.receiverId);
          if (row && !ROW_TERMINAL_STATES.has(row.state)) {
            if (row.state === RECEIVER_ROW_STATE.AWAITING_ACCEPT || row.state === RECEIVER_ROW_STATE.TRANSFERRING) {
              // The data channel reports the failure itself; just flag it here.
              row.connection = 'failed';
            } else {
              row.state = RECEIVER_ROW_STATE.DISCONNECTED;
              setNotice({ kind: 'warn', text: 'A receiver disconnected.' });
            }
            refreshGroup();
            maybeFinishGroup();
          }
          return;
        }
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
        if (refs.current.mode === SEND_MODE.GROUP && by === 'receiver') {
          const row = refs.current.receivers.get(payload?.receiverId);
          if (row && !ROW_TERMINAL_STATES.has(row.state)) {
            if (row.state === RECEIVER_ROW_STATE.AWAITING_ACCEPT || row.state === RECEIVER_ROW_STATE.TRANSFERRING) {
              // Their cancel control/close arrives on the channel; the engine
              // reports the final outcome for this receiver.
              row.connection = 'failed';
            } else {
              row.state = RECEIVER_ROW_STATE.CANCELLED;
            }
            refreshGroup();
            maybeFinishGroup();
          }
          return;
        }
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
        if (refs.current.mode === SEND_MODE.GROUP) {
          const row = refs.current.receivers.get(payload?.peerId);
          if (!row?.peerSession || !payload?.signal) return;
          Promise.resolve(row.peerSession.handleSignal(payload.signal)).catch((signalError) => {
            row.state = RECEIVER_ROW_STATE.FAILED;
            row.error = describeError(signalError);
            refreshGroup();
            maybeFinishGroup();
          });
          return;
        }
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
    [changePhase, closeSession, failFlow, maybeFinishGroup, refreshGroup]
  );

  const startExpiryTimer = useCallback(
    (expiryMs) => {
      if (!Number.isFinite(expiryMs)) return;
      const delay = Math.min(Math.max(expiryMs - Date.now() + 1000, 1000), 60 * 60 * 1000);
      refs.current.expiryTimer = setTimeout(() => {
        const current = refs.current.phase;
        if (current !== SENDER_PHASE.WAITING && current !== SENDER_PHASE.PAIRED) return;
        // Group mode: once receivers are present, the server's own sweeper
        // notifies everyone (peer:expired); this timer is the no-join fallback.
        if (refs.current.mode === SEND_MODE.GROUP && refs.current.receivers.size > 0) return;
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

  const setMode = useCallback((nextMode) => {
    if (refs.current.phase !== SENDER_PHASE.IDLE) return;
    const value = nextMode === SEND_MODE.GROUP ? SEND_MODE.GROUP : SEND_MODE.DIRECT;
    refs.current.mode = value;
    setModeState(value);
  }, []);

  const setGroupSize = useCallback((size) => {
    if (refs.current.phase !== SENDER_PHASE.IDLE) return;
    const value = Number.isFinite(size) ? Math.max(2, Math.min(50, Math.floor(size))) : 3;
    refs.current.groupSize = value;
    setGroupSizeState(value);
  }, []);

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
    refs.current.meter = new SpeedMeter();

    if (refs.current.mode === SEND_MODE.GROUP) {
      refs.current.receivers.clear();
      setReceivers([]);
      refs.current.group = new SenderGroup({ onEvent: handleGroupEvent });
    } else {
      refs.current.group = null;
    }

    changePhase(SENDER_PHASE.GENERATING);

    const newCode = generateTransferCode();
    const signaling = createSignalingClient({ url: SIGNALING_URL });
    refs.current.signaling = signaling;
    wireSignalingEvents(signaling);

    try {
      await signaling.connect();
      const response = await signaling.createSession(newCode, {
        mode: refs.current.mode,
        maxReceivers: refs.current.groupSize,
      });
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
  }, [
    changePhase,
    clearTimers,
    closeSession,
    failFlow,
    handleGroupEvent,
    setSelectionError,
    startExpiryTimer,
    wireSignalingEvents,
  ]);

  const approveReceiver = useCallback(
    async (receiverId) => {
      if (refs.current.mode === SEND_MODE.GROUP) {
        await approveGroupReceiver(receiverId);
        return;
      }
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
    },
    [approveGroupReceiver, changePhase, failFlow, startPeer]
  );

  const declineReceiver = useCallback(
    async (receiverId) => {
      if (refs.current.mode === SEND_MODE.GROUP) {
        await declineGroupReceiver(receiverId);
        return;
      }
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
    },
    [changePhase, closeSession, declineGroupReceiver]
  );

  const pauseTransfer = useCallback(() => {
    const state = refs.current;
    if (state.mode === SEND_MODE.GROUP) {
      state.group?.pauseAll();
      return;
    }
    const engine = state.engine;
    if (engine && !engine.finished) engine.pause('sender');
  }, []);

  const resumeTransfer = useCallback(() => {
    const state = refs.current;
    if (state.mode === SEND_MODE.GROUP) {
      state.group?.resumeAll();
      return;
    }
    const engine = state.engine;
    if (engine && !engine.finished) engine.resume('sender');
  }, []);

  const cancelTransfer = useCallback(
    (reason = 'Cancelled by the sender') => {
      if (isTerminalSenderPhase(refs.current.phase)) return;
      const state = refs.current;
      if (state.mode === SEND_MODE.GROUP) {
        // Terminal phase first so engine cancel events cannot double-finish.
        const rows = snapshotRows();
        changePhase(SENDER_PHASE.CANCELLED);
        state.group?.cancelAll(reason);
        setResult({ status: 'cancelled', reason, by: 'sender', receivers: rows });
        closeSession({ reason, notify: true });
        return;
      }
      if (state.engine && !state.engine.finished) {
        state.engine.cancel(reason, 'sender');
      }
      setResult({ status: 'cancelled', reason, by: 'sender' });
      changePhase(SENDER_PHASE.CANCELLED);
      // Notify the receiver through signaling as well: this still works when
      // the data channel itself has already broken.
      closeSession({ reason, notify: true });
    },
    [changePhase, closeSession, snapshotRows]
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
    mode,
    groupSize,
    code,
    expiresAt,
    selection,
    selectionError,
    peer,
    receivers,
    progress,
    stats,
    paused,
    activeFileName,
    error,
    notice,
    result,
    signalingStatus,
    setMode,
    setGroupSize,
    setSelection,
    clearSelection,
    loadSelection,
    generateCode,
    approveReceiver,
    approveAllReceivers,
    declineReceiver,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    reset,
    isTerminal: isTerminalSenderPhase(phase),
  };
}
