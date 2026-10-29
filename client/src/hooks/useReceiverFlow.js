import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SIGNALING_URL, LIMITS, RTC_CONFIG, CONNECTION_TIMEOUT_MS } from '../config.js';
import { normalizeCode, validateCodeInput } from '../utils/code.js';
import { SpeedMeter } from '../utils/format.js';
import { createSignalingClient, SIGNAL_EVENTS } from '../services/signaling.js';
import { PeerSession, supportsWebRTC } from '../services/webrtc.js';
import { ReceiverTransfer } from '../services/transfer/receiver.js';
import { describeError } from '../utils/errors.js';
import {
  supportsDirectoryPicker,
  pickDirectory,
  createDirectoryWriter,
  ensureDirectory,
  triggerDownload,
  triggerSequentialDownloads,
} from '../utils/download.js';
import { createZipBlob } from '../utils/zip.js';

/** Every state the receiver screen can be in. */
export const RECEIVER_PHASE = Object.freeze({
  IDLE: 'idle',
  JOINING: 'joining',
  WAITING: 'waiting',
  CONNECTING: 'connecting',
  DECIDING: 'deciding',
  TRANSFERRING: 'transferring',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

/** How the receiver wants the incoming data written to disk. */
export const SAVE_MODE = Object.freeze({
  DOWNLOAD: 'download',
  ZIP: 'zip',
  DIRECTORY: 'directory',
  /** Plain-text message: shown on screen with a copy button, never written. */
  TEXT: 'text',
});

const TERMINAL_PHASES = new Set([
  RECEIVER_PHASE.COMPLETED,
  RECEIVER_PHASE.REJECTED,
  RECEIVER_PHASE.CANCELLED,
  RECEIVER_PHASE.FAILED,
]);

export function isTerminalReceiverPhase(phase) {
  return TERMINAL_PHASES.has(phase);
}

/** Top-level folder name shared by the manifest, used for the ZIP file name. */
function inferArchiveName(files) {
  if (!Array.isArray(files) || files.length === 0) return 'received-files';
  const top = (file) => String(file.path).split('/')[0];
  const first = top(files[0]);
  const shared = files.every((file) => top(file) === first);
  const insideFolder = files.every((file) => String(file.path).includes('/'));
  if (shared && insideFolder) return first;
  return 'received-files';
}

/**
 * Drives the receiver flow:
 *   enter code -> join session -> auto-approved -> WebRTC ->
 *   review manifest -> accept (choose save mode) -> receive -> save.
 */
export function useReceiverFlow() {
  const [phase, setPhaseState] = useState(RECEIVER_PHASE.IDLE);
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState({ receivedBytes: 0, totalBytes: 0, fileIndex: -1 });
  const [stats, setStats] = useState({ speed: 0, eta: null });
  const [paused, setPaused] = useState(false);
  const [activeFileName, setActiveFileName] = useState(null);
  const [saveMode, setSaveMode] = useState(SAVE_MODE.DOWNLOAD);
  const [packaging, setPackaging] = useState(null);
  const [signalingStatus, setSignalingStatus] = useState('idle');
  const [filesSaved, setFilesSaved] = useState(0);
  const [peerState, setPeerState] = useState({ status: 'none', connection: null });

  const refs = useRef({
    phase: RECEIVER_PHASE.IDLE,
    signaling: null,
    peer: null,
    engine: null,
    channel: null,
    manifest: null,
    saverMode: null,
    textBlob: null,
    directoryHandle: null,
    zipEntries: [],
    zipDirs: [],
    downloadItems: [],
    meter: new SpeedMeter(),
    timers: [],
    dirty: false,
  });

  const changePhase = useCallback((next) => {
    const value = typeof next === 'function' ? next(refs.current.phase) : next;
    refs.current.phase = value;
    refs.current.dirty = value !== RECEIVER_PHASE.IDLE;
    setPhaseState(value);
  }, []);

  const closeSession = useCallback(({ reason = 'closed', notify = false, delayMs = 300 } = {}) => {
    const state = refs.current;
    const signaling = state.signaling;
    const peerSession = state.peer;
    state.signaling = null;
    state.peer = null;
    state.channel = null;
    state.engine = null;
    state.directoryHandle = null;
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
  }, []);

  const failFlow = useCallback(
    (info) => {
      if (isTerminalReceiverPhase(refs.current.phase)) return;
      setError(info);
      changePhase(RECEIVER_PHASE.FAILED);
      closeSession({ reason: 'failed', notify: false });
    },
    [changePhase, closeSession]
  );

  // ------------------------------------------------------------------- saving

  const handleCreateWriter = useCallback(async (entry) => {
    const state = refs.current;
    if (state.saverMode !== SAVE_MODE.DIRECTORY || !state.directoryHandle) return null;
    return createDirectoryWriter(state.directoryHandle, entry.path);
  }, []);

  const handleFile = useCallback(async (entry, blob) => {
    const state = refs.current;
    if (state.saverMode === SAVE_MODE.TEXT) {
      // Plain-text message: keep the blob so finalize() can decode it for the
      // on-screen copy box. Nothing is written to disk.
      state.textBlob = blob;
      return;
    }
    if (state.saverMode === SAVE_MODE.DIRECTORY) {
      // Files are already streamed to disk by the writer; only empty
      // directories still need an explicit create.
      if (entry.dir && state.directoryHandle) await ensureDirectory(state.directoryHandle, entry.path);
      return;
    }
    if (entry.dir) {
      state.zipDirs.push(entry.path);
      return;
    }
    if (!blob) return;
    if (state.saverMode === SAVE_MODE.ZIP) {
      state.zipEntries.push({
        path: entry.path,
        data: blob,
        lastModified: Number.isFinite(entry.lastModified) ? entry.lastModified : undefined,
      });
      return;
    }
    state.downloadItems.push({ name: entry.name, path: entry.path, blob });
  }, []);

  /** Turn the completed transfer into something the user actually gets. */
  const finalize = useCallback(
    async (engineResult) => {
      const state = refs.current;
      const summary = {
        receivedBytes: engineResult.receivedBytes ?? 0,
        totalBytes: engineResult.totalBytes ?? 0,
        fileCount: engineResult.fileCount ?? state.manifest?.fileCount ?? 0,
        saveMode: state.saverMode,
      };

      if (state.saverMode === SAVE_MODE.TEXT) {
        if (!state.textBlob) {
          setError(describeError(Object.assign(new Error('No text was received.'), { code: 'INCOMPLETE' })));
          changePhase(RECEIVER_PHASE.FAILED);
          return;
        }
        try {
          const text = await state.textBlob.text();
          const fileName = state.manifest?.files?.[0]?.path ?? 'codeshare-text.txt';
          setResult({ ...summary, savedTo: 'text', text, fileName, characters: text.length });
          changePhase(RECEIVER_PHASE.COMPLETED);
        } catch (decodeError) {
          setError(
            describeError(
              Object.assign(new Error(decodeError?.message ?? 'Could not read the received text.'), {
                code: 'INCOMPLETE',
              })
            )
          );
          changePhase(RECEIVER_PHASE.FAILED);
        }
        return;
      }

      if (state.saverMode === SAVE_MODE.DIRECTORY) {
        setResult({ ...summary, saved: true, savedTo: 'folder' });
        changePhase(RECEIVER_PHASE.COMPLETED);
        return;
      }

      if (state.saverMode === SAVE_MODE.ZIP) {
        try {
          setPackaging({ done: 0, total: state.zipEntries.length });
          const entries = [
            ...state.zipDirs.map((path) => ({ path, dir: true })),
            ...state.zipEntries,
          ];
          const zipName = `${inferArchiveName(state.manifest?.files)}.zip`;
          const zipBlob = await createZipBlob(entries, {
            onProgress: (info) => setPackaging(info),
          });
          triggerDownload(zipBlob, zipName);
          setResult({ ...summary, saved: true, savedTo: 'zip', zipName });
        } catch (zipError) {
          setPackaging(null);
          setError(describeError(zipError));
          changePhase(RECEIVER_PHASE.FAILED);
          return;
        }
        setPackaging(null);
        changePhase(RECEIVER_PHASE.COMPLETED);
        return;
      }

      // Single-file / individual downloads.
      const items = [...state.downloadItems];
      if (items.length === 1) {
        triggerDownload(items[0].blob, items[0].name);
        setResult({ ...summary, saved: true, savedTo: 'download', downloads: items });
      } else if (items.length > 1) {
        try {
          await triggerSequentialDownloads(items);
          setResult({ ...summary, saved: true, savedTo: 'downloads', downloads: items });
        } catch {
          // Blocked by the browser: keep the blobs so the UI can offer buttons.
          setResult({
            ...summary,
            saved: false,
            savedTo: 'downloads',
            downloads: items,
            needsManualDownload: true,
          });
        }
      } else {
        setError(describeError(Object.assign(new Error('No data was received.'), { code: 'INCOMPLETE' })));
        changePhase(RECEIVER_PHASE.FAILED);
        return;
      }
      changePhase(RECEIVER_PHASE.COMPLETED);
    },
    [changePhase]
  );

  const handleEngineResult = useCallback(
    async (engineResult) => {
      // The user may already have cancelled or rejected from this side.
      if (isTerminalReceiverPhase(refs.current.phase)) return;

      if (engineResult.status === 'complete') {
        await finalize(engineResult);
        closeSession({ reason: 'completed', notify: false });
        return;
      }
      if (engineResult.status === 'cancelled') {
        const by = engineResult.by ?? 'sender';
        setResult({
          status: 'cancelled',
          reason: engineResult.reason ?? 'Transfer cancelled.',
          by,
        });
        changePhase(RECEIVER_PHASE.CANCELLED);
        closeSession({ reason: 'cancelled', notify: false });
        return;
      }
      if (engineResult.status === 'rejected') {
        // Sent by this side before accepting.
        setResult({ status: 'rejected', reason: engineResult.reason ?? 'You declined the transfer.' });
        changePhase(RECEIVER_PHASE.REJECTED);
        closeSession({ reason: 'rejected', notify: false });
        return;
      }
      failFlow(describeError(engineResult.error ?? new Error(engineResult.reason ?? 'Transfer failed.')));
    },
    [changePhase, closeSession, failFlow, finalize]
  );

  const handleEngineEvent = useCallback(
    (event) => {
      switch (event.type) {
        case 'manifest': {
          const textFiles = event.files.filter((entry) => entry.text === true && !entry.dir);
          const nextManifest = {
            files: event.files,
            totalBytes: event.totalBytes,
            fileCount: event.fileCount,
            hasDirectories: event.hasDirectories,
            // A single flagged entry means: show this as text, not as a file.
            isText: event.files.length === 1 && textFiles.length === 1,
          };
          refs.current.manifest = nextManifest;
          setManifest(nextManifest);
          setProgress({ receivedBytes: 0, totalBytes: event.totalBytes, fileIndex: -1 });
          setStats({ speed: 0, eta: null });
          setFilesSaved(0);
          changePhase(RECEIVER_PHASE.DECIDING);
          break;
        }
        case 'progress': {
          const meter = refs.current.meter;
          meter.update(event.receivedBytes);
          const remaining = Math.max(0, event.totalBytes - event.receivedBytes);
          setProgress({
            receivedBytes: event.receivedBytes,
            totalBytes: event.totalBytes,
            fileIndex: event.fileIndex,
          });
          setStats({ speed: meter.value(), eta: meter.eta(remaining) });
          setPaused(event.paused === true);
          break;
        }
        case 'accepted':
          changePhase(RECEIVER_PHASE.TRANSFERRING);
          break;
        case 'file-start':
          setActiveFileName(event.name);
          break;
        case 'file-done':
          setActiveFileName(null);
          setFilesSaved((count) => count + 1);
          break;
        case 'paused':
          setPaused(true);
          break;
        case 'resumed':
          setPaused(false);
          break;
        case 'cancelled':
        case 'rejected':
          // Terminal state arrives through the run() result.
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
      if (state.engine) return;
      state.meter = new SpeedMeter();
      state.zipEntries = [];
      state.zipDirs = [];
      state.downloadItems = [];
      state.saverMode = null;
      state.textBlob = null;
      state.directoryHandle = null;

      const engine = new ReceiverTransfer({
        channel,
        limits: LIMITS,
        onEvent: handleEngineEvent,
        onFile: handleFile,
        createWriter: handleCreateWriter,
      });
      state.engine = engine;
      engine.run().then(handleEngineResult).catch((runError) => failFlow(describeError(runError)));
    },
    [failFlow, handleCreateWriter, handleEngineEvent, handleEngineResult, handleFile]
  );

  // ------------------------------------------------------------------ WebRTC

  const startPeer = useCallback(
    async (signaling) => {
      const peerSession = new PeerSession({
        role: 'receiver',
        config: RTC_CONFIG,
        timeoutMs: CONNECTION_TIMEOUT_MS,
        emitSignal: async (signal) => {
          await signaling.signal(signal);
        },
        onDataChannel: (channel) => {
          refs.current.channel = channel;
        },
        onStateChange: (connectionState) => {
          setPeerState((previous) => ({
            ...previous,
            connection: connectionState,
            status: connectionState === 'connected' ? 'connected' : previous.status,
          }));
          if (connectionState === 'connected' && refs.current.channel) {
            startEngine(refs.current.channel);
          }
        },
        onError: (connectionError) => {
          if (isTerminalReceiverPhase(refs.current.phase)) return;
          failFlow(describeError(connectionError));
        },
      });

      refs.current.peer = peerSession;
      await peerSession.start();
    },
    [failFlow, startEngine]
  );

  const wireSignalingEvents = useCallback(
    (signaling) => {
      signaling.on(SIGNAL_EVENTS.PEER_APPROVED, () => {
        if (isTerminalReceiverPhase(refs.current.phase)) return;
        if (refs.current.phase !== RECEIVER_PHASE.WAITING) return;
        setPeerState({ status: 'approved', connection: null });
        changePhase(RECEIVER_PHASE.CONNECTING);
        Promise.resolve(startPeer(signaling)).catch((peerError) => failFlow(describeError(peerError)));
      });

      signaling.on(SIGNAL_EVENTS.PEER_DISCONNECTED, (payload) => {
        if (isTerminalReceiverPhase(refs.current.phase)) return;
        const role = payload?.role;
        if (role === 'sender' && refs.current.phase === RECEIVER_PHASE.WAITING) {
          failFlow(
            describeError(
              Object.assign(
                new Error('The sender closed their page before approving. Ask them for a new code.'),
                { code: 'SENDER_GONE' }
              )
            )
          );
          return;
        }
        failFlow(
          describeError(Object.assign(new Error('The other computer disconnected.'), { code: 'PEER_CLOSED' }))
        );
      });

      signaling.on(SIGNAL_EVENTS.PEER_CANCELLED, (payload) => {
        if (isTerminalReceiverPhase(refs.current.phase)) return;
        const by = payload?.by ?? 'sender';
        const reason =
          by === 'sender'
            ? `The sender cancelled the transfer${payload?.reason ? `: ${payload.reason}` : '.'}`
            : payload?.reason ?? 'Transfer cancelled.';
        setResult({ status: 'cancelled', reason, by });
        changePhase(RECEIVER_PHASE.CANCELLED);
        closeSession({ reason: 'cancelled', notify: false });
      });

      signaling.on(SIGNAL_EVENTS.PEER_EXPIRED, () => {
        if (isTerminalReceiverPhase(refs.current.phase)) return;
        failFlow(
          describeError(
            Object.assign(new Error('The transfer session expired. Ask the sender for a new code.'), {
              code: 'NOT_FOUND',
            })
          )
        );
      });

      signaling.on(SIGNAL_EVENTS.SIGNAL, (payload) => {
        const peerSession = refs.current.peer;
        if (!peerSession || !payload?.signal) return;
        Promise.resolve(peerSession.handleSignal(payload.signal)).catch((signalError) => {
          failFlow(describeError(signalError));
        });
      });

      signaling.onConnectionChange((status) => setSignalingStatus(status));
    },
    [changePhase, closeSession, failFlow, startPeer]
  );

  // ---------------------------------------------------------------- public API

  const connect = useCallback(
    async (rawCode) => {
      const validationMessage = validateCodeInput(rawCode);
      if (validationMessage) {
        setError(describeError(Object.assign(new Error(validationMessage), { code: 'INVALID_CODE' })));
        return false;
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
        return false;
      }
      if (refs.current.signaling) return false;

      const code = normalizeCode(rawCode);
      setError(null);
      setNotice(null);
      setResult(null);
      setManifest(null);
      setPeerState({ status: 'none', connection: null });
      changePhase(RECEIVER_PHASE.JOINING);

      const signaling = createSignalingClient({ url: SIGNALING_URL });
      refs.current.signaling = signaling;
      wireSignalingEvents(signaling);

      try {
        await signaling.connect();
        const response = await signaling.joinSession(code);
        if (Number.isFinite(response?.expiresAt)) {
          const delay = Math.min(Math.max(response.expiresAt - Date.now() + 1000, 1000), 60 * 60 * 1000);
          refs.current.timers.push(
            setTimeout(() => {
              if (isTerminalReceiverPhase(refs.current.phase)) return;
              if (refs.current.phase !== RECEIVER_PHASE.WAITING) return;
              failFlow(
                describeError(
                  Object.assign(new Error('The transfer session expired before it could connect.'), {
                    code: 'NOT_FOUND',
                  })
                )
              );
            }, delay)
          );
        }
        changePhase(RECEIVER_PHASE.WAITING);
        return true;
      } catch (joinError) {
        closeSession({ reason: 'join-failed', notify: false, delayMs: 0 });
        failFlow(describeError(joinError));
        return false;
      }
    },
    [changePhase, closeSession, failFlow, wireSignalingEvents]
  );

  const acceptTransfer = useCallback(
    async (requestedMode = saveMode) => {
      const state = refs.current;
      if (state.phase !== RECEIVER_PHASE.DECIDING || !state.engine) return false;

      setError(null);
      const mode = requestedMode;

      if (mode === SAVE_MODE.DIRECTORY) {
        // Must run inside the click's user activation.
        try {
          state.directoryHandle = await pickDirectory();
        } catch (pickError) {
          if (pickError?.name === 'AbortError') return false; // user closed the dialog
          setError(
            describeError(
              Object.assign(
                new Error(pickError?.message ?? 'Could not open the folder picker.'),
                { code: 'SAVE_FAILED' }
              )
            )
          );
          return false;
        }
      } else {
        state.directoryHandle = null;
      }

      state.saverMode = mode;
      state.zipEntries = [];
      state.zipDirs = [];
      state.downloadItems = [];
      state.textBlob = null;
      setSaveMode(mode);

      const accepted = state.engine.accept();
      if (!accepted) return false;
      changePhase(RECEIVER_PHASE.TRANSFERRING);
      return true;
    },
    [changePhase, saveMode]
  );

  const rejectTransfer = useCallback(
    (reason = 'You declined the transfer.') => {
      const state = refs.current;
      if (state.phase !== RECEIVER_PHASE.DECIDING || !state.engine) return;
      state.engine.reject(reason);
      setResult({ status: 'rejected', reason });
      changePhase(RECEIVER_PHASE.REJECTED);
      closeSession({ reason: 'rejected-by-receiver', notify: true });
    },
    [changePhase, closeSession]
  );

  const pauseTransfer = useCallback(() => {
    const engine = refs.current.engine;
    if (engine && !engine.finished) engine.pause('receiver');
  }, []);

  const resumeTransfer = useCallback(() => {
    const engine = refs.current.engine;
    if (engine && !engine.finished) engine.resume('receiver');
  }, []);

  const cancelTransfer = useCallback(
    (reason = 'Cancelled by the receiver') => {
      if (isTerminalReceiverPhase(refs.current.phase)) return;
      const state = refs.current;
      if (state.engine && !state.engine.finished) state.engine.cancel(reason, 'receiver');
      setResult({ status: 'cancelled', reason, by: 'receiver' });
      changePhase(RECEIVER_PHASE.CANCELLED);
      closeSession({ reason, notify: true });
    },
    [changePhase, closeSession]
  );

  const reset = useCallback(() => {
    closeSession({ reason: 'reset', notify: true, delayMs: 200 });
    const state = refs.current;
    state.manifest = null;
    state.zipEntries = [];
    state.zipDirs = [];
    state.downloadItems = [];
    state.saverMode = null;
    state.textBlob = null;
    state.directoryHandle = null;
    state.meter = new SpeedMeter();
    setManifest(null);
    setProgress({ receivedBytes: 0, totalBytes: 0, fileIndex: -1 });
    setStats({ speed: 0, eta: null });
    setPaused(false);
    setActiveFileName(null);
    setError(null);
    setNotice(null);
    setResult(null);
    setPackaging(null);
    setFilesSaved(0);
    setPeerState({ status: 'none', connection: null });
    changePhase(RECEIVER_PHASE.IDLE);
  }, [changePhase, closeSession]);

  /** Re-run a blocked download (browsers may refuse several at once). */
  const redownload = useCallback((item) => {
    if (item?.blob) triggerDownload(item.blob, item.name);
  }, []);

  const redownloadAll = useCallback(async () => {
    const items = [...refs.current.downloadItems];
    if (items.length > 0) await triggerSequentialDownloads(items);
  }, []);

  /** Save modes offered for the current manifest, best option first. */
  const saveModes = useMemo(() => {
    if (!manifest) return [];
    // Text messages are shown on screen with a copy button - no save options.
    if (manifest.isText) return [];
    const singleFile = manifest.fileCount === 1 && !manifest.hasDirectories;
    const modes = [];
    if (singleFile) {
      modes.push({
        mode: SAVE_MODE.DOWNLOAD,
        label: 'Download the file',
        description: 'Saves it with its original file name using your browser download.',
      });
    } else {
      modes.push({
        mode: SAVE_MODE.ZIP,
        label: 'Download as one ZIP',
        description: 'Packed locally in this browser. Nothing is uploaded.',
      });
    }
    if (supportsDirectoryPicker()) {
      modes.push({
        mode: SAVE_MODE.DIRECTORY,
        label: 'Save into a folder',
        description: 'Writes files straight into a folder you choose - best for large folders.',
      });
    }
    return modes;
  }, [manifest]);

  // ------------------------------------------------------------------- effects

  useEffect(() => {
    const beforeUnload = (event) => {
      if (!refs.current.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      closeSession({ reason: 'unmount', notify: false, delayMs: 0 });
    };
  }, [closeSession]);

  return {
    phase,
    manifest,
    error,
    notice,
    result,
    progress,
    stats,
    paused,
    activeFileName,
    saveMode,
    saveModes,
    packaging,
    filesSaved,
    peer: peerState,
    signalingStatus,
    connect,
    acceptTransfer,
    rejectTransfer,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    reset,
    redownload,
    redownloadAll,
    setSaveMode,
    isTerminal: isTerminalReceiverPhase(phase),
  };
}
