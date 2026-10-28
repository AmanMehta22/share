/**
 * Runtime configuration for the CodeShare frontend.
 *
 * Nothing here is secret: browser code is public by definition. Only the
 * signaling endpoint address is configurable, and it is not a credential.
 */

const rawSignalUrl = (import.meta.env.VITE_SIGNALING_URL ?? '').trim();

/** Empty string means "same origin" (Vite dev proxy or a co-hosted server). */
export const SIGNALING_URL = rawSignalUrl.replace(/\/+$/, '');

/** Chunk size for DataChannel transfers. 32 KiB balances memory and overhead. */
export const CHUNK_SIZE = 32 * 1024;

/** Stop reading the next chunk once this much is queued in the channel. */
export const BUFFER_HIGH_WATER = 1 * 1024 * 1024;

/** Resume reading once the queue drains to this level (fires `bufferedamountlow`). */
export const BUFFER_LOW_WATER = 64 * 1024;

/** How long to wait for ICE + DataChannel to open before reporting failure. */
export const CONNECTION_TIMEOUT_MS = 40_000;

/** Displayed to the user; the real TTL comes from the signaling server. */
export const SESSION_TTL_MINUTES = 15;

/**
 * STUN servers are free, public, best-effort helpers for NAT discovery.
 * They can observe the public address of a peer; they do NOT relay traffic
 * and they do not guarantee that a direct connection is possible.
 */
export const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
  iceCandidatePoolSize: 4,
};

/** Hard caps that protect the receiver from hostile or broken peers. */
export const LIMITS = Object.freeze({
  maxFiles: 100_000,
  maxSingleFileBytes: Number.MAX_SAFE_INTEGER,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
  maxPathLength: 1024,
  maxNameLength: 255,
  maxDepth: 32,
  maxManifestChars: 2_000_000,
  /** Largest plain-text message (UTF-8 bytes), enforced on both sides. */
  maxTextBytes: 10 * 1024 * 1024,
});

/** Browsers with these features get the nicer folder-save experience. */
export function detectCapabilities() {
  const hasDirectoryPicker =
    typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  const hasFileSystem =
    typeof window !== 'undefined' &&
    ('showSaveFilePicker' in window || 'showDirectoryPicker' in window);
  const hasWebRTC =
    typeof window !== 'undefined' &&
    typeof window.RTCPeerConnection === 'function' &&
    typeof window.RTCDataChannel === 'function';
  return { hasDirectoryPicker, hasFileSystem, hasWebRTC };
}
