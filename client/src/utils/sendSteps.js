import { SENDER_PHASE } from '../hooks/useSenderFlow.js';

/**
 * Step indicators and connection status labels shared by the sender screens
 * ("Send files" and "Send text"). Kept in a plain module so component files
 * stay component-only (fast-refresh friendly).
 */

export const STEPS = [
  { key: 'select', label: 'Select' },
  { key: 'code', label: 'Share code' },
  { key: 'transfer', label: 'Transfer' },
];

export function stepForPhase(phase) {
  if (phase === SENDER_PHASE.IDLE || phase === SENDER_PHASE.GENERATING) return 'select';
  if (
    phase === SENDER_PHASE.WAITING ||
    phase === SENDER_PHASE.PAIRED ||
    phase === SENDER_PHASE.CONNECTING ||
    phase === SENDER_PHASE.EXPIRED
  ) {
    return 'code';
  }
  return 'transfer';
}

export const CONNECTION_LABELS = {
  connecting: { label: 'Connecting…', tone: 'info' },
  connected: { label: 'Connected', tone: 'ok' },
  disconnected: { label: 'Reconnecting…', tone: 'warn' },
  failed: { label: 'Connection failed', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
};
