/**
 * Turns technical failures into something a person can act on.
 *
 * The raw `detail` is always the engine/server message (already human
 * readable); `hint` adds the next step. Nothing here hides the real cause.
 */

const HINTS = Object.freeze({
  // --- signaling server -----------------------------------------------------
  UNAVAILABLE: {
    title: 'Signaling server unreachable',
    hint: 'Start the local signaling server with "npm run dev:server" (or "npm run dev" at the project root), then try again. For a deployed site, check VITE_SIGNALING_URL.',
    retryable: true,
  },
  NOT_CONNECTED: {
    title: 'Not connected',
    hint: 'The signaling server connection dropped. Check your network and try again.',
    retryable: true,
  },
  TIMEOUT: {
    title: 'Request timed out',
    hint: 'The signaling server did not answer in time. It may be asleep (common on free hosting tiers) or unreachable.',
    retryable: true,
  },
  SERVER_ERROR: {
    title: 'Server error',
    hint: 'The signaling server reported an internal error. Retry in a moment.',
    retryable: true,
  },

  // --- codes and sessions ---------------------------------------------------
  INVALID_CODE: {
    title: 'Invalid transfer code',
    hint: 'Codes look like ABCD-EFGH-JKLM-NPQR and never contain I, L, O, 0 or 1.',
    retryable: true,
  },
  NOT_FOUND: {
    title: 'Code not found or expired',
    hint: 'Codes expire after 15 minutes and can only be used once. Ask the sender to generate a new one.',
    retryable: true,
  },
  CODE_IN_USE: {
    title: 'Code already in use',
    hint: 'Generate a fresh code on the sender and try again.',
    retryable: true,
  },
  RECEIVER_TAKEN: {
    title: 'Already connected',
    hint: 'This transfer already has a receiver. Only one receiver is supported.',
    retryable: false,
  },
  RATE_LIMITED: {
    title: 'Too many attempts',
    hint: 'Wait a few minutes before trying again. Repeated wrong codes are blocked on purpose.',
    retryable: true,
  },
  TOO_MANY_SESSIONS: {
    title: 'Too many active transfers',
    hint: 'Close other CodeShare tabs or transfers and try again.',
    retryable: true,
  },
  SENDER_GONE: {
    title: 'Sender went offline',
    hint: 'Ask the sender to keep their tab open and share a new code.',
    retryable: true,
  },
  RECEIVER_GONE: {
    title: 'Receiver went offline',
    hint: 'Share the code again with the receiver.',
    retryable: true,
  },
  ALREADY_IN_SESSION: {
    title: 'Already in a session',
    hint: 'Finish or cancel the current transfer before starting another.',
    retryable: false,
  },

  // --- WebRTC ---------------------------------------------------------------
  UNSUPPORTED_BROWSER: {
    title: 'Browser not supported',
    hint: 'Use the latest Chrome, Edge, Firefox or Safari. WebRTC data channels are required.',
    retryable: false,
  },
  ICE_FAILED: {
    title: 'Direct connection failed',
    hint: 'A direct peer-to-peer route could not be found. Try: both devices on the same network; disable VPN or strict firewall temporarily; avoid symmetric/corporate NAT. CodeShare has no TURN relay, so some restricted networks cannot be bridged.',
    retryable: true,
  },
  CHANNEL_ERROR: {
    title: 'Connection error',
    hint: 'The peer connection dropped mid-transfer. Reconnect and restart the transfer.',
    retryable: true,
  },
  PEER_CLOSED: {
    title: 'Peer disconnected',
    hint: 'The other computer closed its page or lost its network. Both sides must stay open for the whole transfer.',
    retryable: true,
  },
  SIGNAL_ERROR: {
    title: 'Negotiation failed',
    hint: 'Connection details could not be exchanged. Retry with a new code.',
    retryable: true,
  },
  SIGNAL_FAILED: {
    title: 'Negotiation failed',
    hint: 'Connection details could not be exchanged. Retry with a new code.',
    retryable: true,
  },

  // --- transfer -------------------------------------------------------------
  REJECTED: {
    title: 'Transfer declined',
    hint: 'The receiver pressed Reject. Start again and make sure both sides confirm the same transfer.',
    retryable: true,
  },
  CANCELLED: {
    title: 'Transfer cancelled',
    hint: 'Nothing was sent after the cancellation.',
    retryable: true,
  },
  SIZE_MISMATCH: {
    title: 'File integrity check failed',
    hint: 'Received bytes did not match the declared size, so the transfer was stopped instead of delivering a corrupt file.',
    retryable: true,
  },
  OUT_OF_ORDER: {
    title: 'Data arrived out of sequence',
    hint: 'The transfer was stopped rather than risk corruption. Restart it.',
    retryable: true,
  },
  READ_FAILED: {
    title: 'Could not read a file',
    hint: 'The file may have been moved, renamed or locked since it was selected. Re-select it.',
    retryable: true,
  },
  SAVE_FAILED: {
    title: 'Could not save the received file',
    hint: 'Check free disk space and folder permissions. For folder saves, allow write access when prompted.',
    retryable: true,
  },
  ZIP_TOO_LARGE: {
    title: 'ZIP fallback not possible',
    hint: 'The browser cannot write this folder directly and the data exceeds the 4 GB ZIP limit. Use Chrome/Edge, which supports saving to a chosen folder.',
    retryable: false,
  },
  INCOMPLETE: {
    title: 'Transfer incomplete',
    hint: 'Some files never arrived. Restart the transfer.',
    retryable: true,
  },
  UNEXPECTED_DATA: {
    title: 'Protocol violation',
    hint: 'The sender transmitted before this side approved. The transfer was aborted.',
    retryable: false,
  },
  PROTOCOL: {
    title: 'Invalid data received',
    hint: 'The peer sent something this app does not expect. The transfer was stopped for safety.',
    retryable: false,
  },
  BAD_MANIFEST: {
    title: 'Invalid transfer description',
    hint: 'The sender announced files in an invalid form. Restart the transfer.',
    retryable: true,
  },
  EMPTY_TRANSFER: {
    title: 'Nothing to transfer',
    hint: 'The selection did not contain any files.',
    retryable: true,
  },
  NO_SESSION: {
    title: 'Session closed',
    hint: 'The transfer session no longer exists. Generate a new code.',
    retryable: true,
  },
  FORBIDDEN: {
    title: 'Not allowed',
    hint: 'That action is only available to the correct participant.',
    retryable: false,
  },
  INVALID_STATE: {
    title: 'Action not available yet',
    hint: 'Wait for the current step to finish, then try again.',
    retryable: true,
  },
});

const GENERIC = {
  title: 'Transfer problem',
  hint: 'Retry the transfer. If it keeps failing, restart both pages and check your network.',
  retryable: true,
};

/**
 * @param {any} error
 * @returns {{code:string, title:string, detail:string, hint:string, retryable:boolean}}
 */
export function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  const detail =
    typeof error?.message === 'string' && error.message.trim().length > 0
      ? error.message.trim()
      : 'Unexpected error.';
  const extra = HINTS[code] ?? GENERIC;
  return {
    code,
    title: extra.title ?? GENERIC.title,
    detail,
    hint: extra.hint ?? GENERIC.hint,
    retryable: extra.retryable ?? GENERIC.retryable,
  };
}

/** True when the flow can reasonably be retried from the current screen. */
export function isRetryable(error) {
  return describeError(error).retryable;
}
