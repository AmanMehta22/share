import { describe, it, expect } from 'vitest';
import { SenderGroup, GROUP_PEER_STATE } from '../src/services/transfer/senderGroup.js';
import { ReceiverTransfer } from '../src/services/transfer/receiver.js';
import { connectPair, makeFiles, bytesOf } from './helpers/fakeChannel.js';

/**
 * One-to-many group orchestration tests.
 *
 * Each receiver gets its own fake channel pair and a real ReceiverTransfer, so
 * these tests exercise the exact engines used in the browser - only the
 * transport is in-memory. They verify per-receiver independence: one receiver
 * rejecting, disconnecting or cancelling must not corrupt or falsely complete
 * the others.
 */

/** Build a receiver that accepts the manifest, plus its completion promise. */
function makeReceiver(channel, { onManifest, onFile } = {}) {
  const receiver = new ReceiverTransfer({
    channel,
    onEvent: (event) => {
      if (event.type === 'manifest') {
        if (onManifest) onManifest(receiver);
        else receiver.accept();
      }
    },
    onFile: onFile ?? (async () => {}),
  });
  const done = receiver.run().catch((error) => ({ status: 'failed', error }));
  return { receiver, done };
}

/** A group whose `group-result` event is awaitable. */
function makeGroup() {
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const group = new SenderGroup({
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'group-result') resolveDone(event);
    },
  });
  return { group, events, done };
}

const FILES = () => makeFiles([{ path: 'a.txt', bytes: bytesOf(1200, 3) }]);

describe('SenderGroup happy paths', () => {
  it('sends the same files to 3 receivers, each with byte-for-byte integrity', async () => {
    const { group, done } = makeGroup();
    const received = { r1: [], r2: [], r3: [] };
    const channels = {};

    for (const id of Object.keys(received)) {
      const [chA, chB] = connectPair();
      channels[id] = chA;
      makeReceiver(chB, {
        onFile: async (entry, blob) => {
          received[id].push({ path: entry.path, bytes: new Uint8Array(await blob.arrayBuffer()) });
        },
      });
      group.startPeer(id, { channel: chA, files: FILES() });
    }

    const result = await done;
    expect(result.status).toBe('complete');
    expect(result.results).toHaveLength(3);
    for (const peer of result.results) {
      expect(peer.state).toBe(GROUP_PEER_STATE.COMPLETED);
      expect(peer.sentBytes).toBe(1200);
      expect(peer.result.status).toBe('complete');
    }
    // Every receiver got the identical bytes.
    const original = bytesOf(1200, 3);
    for (const id of Object.keys(received)) {
      expect(received[id]).toHaveLength(1);
      expect(received[id][0].path).toBe('a.txt');
      expect(received[id][0].bytes).toEqual(original);
    }
    expect(group.allTerminal).toBe(true);
  });

  it('tracks per-receiver progress events with the right receiverId', async () => {
    const { group, events, done } = makeGroup();
    const [chA1, chB1] = connectPair();
    const [chA2, chB2] = connectPair();
    makeReceiver(chB1);
    makeReceiver(chB2);
    group.startPeer('r1', { channel: chA1, files: FILES() });
    group.startPeer('r2', { channel: chA2, files: FILES() });
    await done;

    const progressIds = new Set(
      events.filter((event) => event.type === 'peer-event' && event.event.type === 'progress').map((e) => e.receiverId)
    );
    expect(progressIds).toEqual(new Set(['r1', 'r2']));
    const startedIds = events.filter((e) => e.type === 'peer-started').map((e) => e.receiverId);
    expect(startedIds).toEqual(['r1', 'r2']);
  });

  it('summary() stays null until every peer is terminal', async () => {
    const { group } = makeGroup();
    expect(group.summary()).toBeNull(); // nothing started yet
    const [chA, chB] = connectPair();
    makeReceiver(chB, { onManifest: () => {} }); // never accepts
    group.startPeer('r1', { channel: chA, files: FILES() });
    expect(group.summary()).toBeNull(); // started but still awaiting consent
    expect(group.allTerminal).toBe(false);
  });
});

describe('SenderGroup mixed outcomes', () => {
  it('one receiver rejecting does not stop or falsify the others', async () => {
    const { group, done } = makeGroup();
    const [chA1, chB1] = connectPair();
    const [chA2, chB2] = connectPair();
    const [chA3, chB3] = connectPair();
    makeReceiver(chB1);
    makeReceiver(chB2, { onManifest: (receiver) => receiver.reject('Not interested.') });
    makeReceiver(chB3);
    group.startPeer('r1', { channel: chA1, files: FILES() });
    group.startPeer('r2', { channel: chA2, files: FILES() });
    group.startPeer('r3', { channel: chA3, files: FILES() });

    const result = await done;
    const byId = Object.fromEntries(result.results.map((peer) => [peer.id, peer]));
    expect(byId.r1.state).toBe(GROUP_PEER_STATE.COMPLETED);
    expect(byId.r2.state).toBe(GROUP_PEER_STATE.REJECTED);
    expect(byId.r2.sentBytes).toBe(0); // a rejection means nothing was read from disk
    expect(byId.r3.state).toBe(GROUP_PEER_STATE.COMPLETED);
    // >=1 receiver completed, so the group outcome is honest-but-positive.
    expect(result.status).toBe('complete');
  });

  it('a receiver dropping mid-transfer is reported as failed, never as success', async () => {
    const { group, done } = makeGroup();
    const [chA1, chB1] = connectPair();
    const [chA2, chB2] = connectPair();
    makeReceiver(chB1);
    const { receiver: stuck } = makeReceiver(chB2); // accepts, then we kill the channel
    group.startPeer('r1', { channel: chA1, files: FILES() });
    group.startPeer('r2', { channel: chA2, files: FILES() });
    // Simulate the receiver's tab closing right after consent.
    chB2.close();

    const result = await done;
    const byId = Object.fromEntries(result.results.map((peer) => [peer.id, peer]));
    expect(byId.r1.state).toBe(GROUP_PEER_STATE.COMPLETED);
    expect(byId.r2.state).toBe(GROUP_PEER_STATE.FAILED);
    expect(byId.r2.error?.code).toBe('PEER_CLOSED');
    expect(result.status).toBe('complete');
    expect(stuck).toBeDefined();
  });

  it('cancelAll cancels every unfinished peer and reports "cancelled"', async () => {
    const { group, events, done } = makeGroup();
    const [chA1, chB1] = connectPair();
    const [chA2, chB2] = connectPair();
    makeReceiver(chB1, { onManifest: () => {} }); // stuck awaiting consent
    makeReceiver(chB2, { onManifest: () => {} });
    group.startPeer('r1', { channel: chA1, files: FILES() });
    group.startPeer('r2', { channel: chA2, files: FILES() });

    group.cancelAll('Sender stopped the group transfer');
    const result = await done;
    expect(result.status).toBe('cancelled');
    for (const peer of result.results) {
      expect(peer.state).toBe(GROUP_PEER_STATE.CANCELLED);
      expect(peer.sentBytes).toBe(0);
    }
    // The cancel control actually reached both receivers.
    const cancelEvents = events.filter((e) => e.type === 'peer-event' && e.event.type === 'cancelled');
    expect(cancelEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('cancel() targets a single receiver', async () => {
    const { group, done } = makeGroup();
    const [chA1, chB1] = connectPair();
    const [chA2, chB2] = connectPair();
    makeReceiver(chB1, { onManifest: () => {} }); // stuck
    makeReceiver(chB2); // completes normally
    group.startPeer('r1', { channel: chA1, files: FILES() });
    group.startPeer('r2', { channel: chA2, files: FILES() });

    group.cancel('r1', 'Only r1 cancelled');

    const result = await done;
    const byId = Object.fromEntries(result.results.map((peer) => [peer.id, peer]));
    expect(byId.r1.state).toBe(GROUP_PEER_STATE.CANCELLED);
    expect(byId.r2.state).toBe(GROUP_PEER_STATE.COMPLETED);
  });
});

describe('SenderGroup controls and guards', () => {
  it('pauseAll + resumeAll drive every peer through a full transfer', async () => {
    const { group, done } = makeGroup();
    const [chA1, chB1] = connectPair();
    const [chA2, chB2] = connectPair();
    makeReceiver(chB1);
    makeReceiver(chB2);
    group.startPeer('r1', { channel: chA1, files: FILES() });
    group.startPeer('r2', { channel: chA2, files: FILES() });

    group.pauseAll();
    // Paused peers must not report progress as complete.
    for (const peer of group.snapshot()) {
      expect(peer.state).toBe(GROUP_PEER_STATE.AWAITING_ACCEPT);
    }
    group.resumeAll();

    const result = await done;
    expect(result.status).toBe('complete');
  });

  it('pause/resume act on one receiver only', async () => {
    const { group, done } = makeGroup();
    const [chA1, chB1] = connectPair();
    const [chA2, chB2] = connectPair();
    makeReceiver(chB1);
    makeReceiver(chB2);
    const engine1 = group.startPeer('r1', { channel: chA1, files: FILES() });
    group.startPeer('r2', { channel: chA2, files: FILES() });

    group.pause('r1');
    expect(engine1.paused).toBe(true);
    group.resume('r1');
    expect(engine1.paused).toBe(false);

    const result = await done;
    expect(result.status).toBe('complete');
  });

  it('rejects starting the same receiver twice', () => {
    const { group } = makeGroup();
    const [chA] = connectPair();
    group.startPeer('r1', { channel: chA, files: FILES() });
    expect(() => group.startPeer('r1', { channel: chA, files: FILES() })).toThrow(/already/i);
  });

  it('rejects a missing receiverId', () => {
    const { group } = makeGroup();
    const [chA] = connectPair();
    expect(() => group.startPeer('', { channel: chA, files: FILES() })).toThrow(/receiverId/i);
  });

  it('controls on unknown receiver ids are no-ops', () => {
    const { group } = makeGroup();
    expect(() => group.pause('ghost')).not.toThrow();
    expect(() => group.resume('ghost')).not.toThrow();
    expect(() => group.cancel('ghost')).not.toThrow();
  });
});
