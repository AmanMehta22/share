import { describe, it, expect } from 'vitest';
import { SenderTransfer } from '../src/services/transfer/sender.js';
import { ReceiverTransfer } from '../src/services/transfer/receiver.js';
import { encodeControl, encodeChunk, CONTROL_TYPES } from '../src/services/transfer/protocol.js';
import { connectPair, makeFiles, bytesOf } from './helpers/fakeChannel.js';

/**
 * Transfer-engine tests over an in-memory fake RTCDataChannel (see
 * tests/helpers/fakeChannel.js). Chunk ordering, integrity, pause/resume,
 * cancel and error paths are verified without two real browsers.
 */

/** Collect binary (non-string) frames sent on a channel. */
function chunksOf(channel) {
  return channel.sent.filter((frame) => typeof frame !== 'string');
}

// --------------------------------------------------------------- happy path

describe('SenderTransfer + ReceiverTransfer happy path', () => {
  it('transfers a single small file with byte-for-byte integrity', async () => {
    const content = bytesOf(1000, 7);
    const [chA, chB] = connectPair();

    const received = [];
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async (entry, blob) => {
        received.push({ path: entry.path, bytes: new Uint8Array(await blob.arrayBuffer()) });
      },
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'hello.txt', bytes: content }]),
    });

    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;

    expect(senderResult.status).toBe('complete');
    expect(senderResult.sentBytes).toBe(1000);
    expect(receiverResult.status).toBe('complete');
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('hello.txt');
    expect(received[0].bytes).toEqual(content);
  });

  it('transfers multiple files preserving paths', async () => {
    const a = bytesOf(500, 1);
    const b = bytesOf(2000, 2);
    const c = bytesOf(100, 3);
    const [chA, chB] = connectPair();

    const received = [];
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async (entry, blob) => {
        received.push({ path: entry.path, bytes: new Uint8Array(await blob.arrayBuffer()) });
      },
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([
        { path: 'a.txt', bytes: a },
        { path: 'dir/b.txt', bytes: b },
        { path: 'dir/deep/c.txt', bytes: c },
      ]),
    });

    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;

    expect(senderResult.status).toBe('complete');
    expect(receiverResult.status).toBe('complete');
    expect(received.map((f) => f.path)).toEqual(['a.txt', 'dir/b.txt', 'dir/deep/c.txt']);
    expect(received[0].bytes).toEqual(a);
    expect(received[1].bytes).toEqual(b);
    expect(received[2].bytes).toEqual(c);
  });

  it('handles directory entries (no bytes) alongside files', async () => {
    const content = bytesOf(300, 9);
    const [chA, chB] = connectPair();

    const received = [];
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async (entry, blob) => {
        received.push({ path: entry.path, dir: entry.dir, bytes: blob ? new Uint8Array(await blob.arrayBuffer()) : null });
      },
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([
        { path: 'folder', dir: true },
        { path: 'folder/file.txt', bytes: content },
      ]),
    });

    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;

    expect(senderResult.status).toBe('complete');
    expect(receiverResult.status).toBe('complete');
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ path: 'folder', dir: true, bytes: null });
    expect(received[1].bytes).toEqual(content);
  });

  it('sends a binary frame per chunk (no Base64)', async () => {
    const content = bytesOf(100_000, 5); // 4 chunks at 32 KiB
    const [chA, chB] = connectPair();

    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'big.bin', bytes: content }]),
    });

    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    await receiverPromise;

    expect(senderResult.status).toBe('complete');
    const binaryFrames = chunksOf(chA);
    expect(binaryFrames.length).toBe(4); // ceil(100000/32768)
    for (const frame of binaryFrames) {
      expect(frame).toBeInstanceOf(ArrayBuffer);
      expect(frame.byteLength).toBeLessThanOrEqual(10 + 32 * 1024);
    }
  });

  it('reports sent and complete only after the receiver ack', async () => {
    const [chA, chB] = connectPair();
    const events = [];
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'a.txt', bytes: bytesOf(100) }]),
      onEvent: (event) => events.push(event.type),
    });

    const receiverPromise = receiver.run();
    await sender.run();
    await receiverPromise;

    const sentIndex = events.indexOf('sent');
    const completeIndex = events.indexOf('complete');
    expect(sentIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(sentIndex);
  });
});

// ------------------------------------------------------------------ consent

describe('receiver consent gate', () => {
  it('does not read bytes before accept()', async () => {
    const content = bytesOf(500);
    const [chA, chB] = connectPair();

    const received = [];
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: () => {}, // never accepts
      onFile: async (entry) => {
        received.push(entry.path);
      },
    });

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'a.txt', bytes: content }]),
    });

    const receiverPromise = receiver.run();
    const senderPromise = sender.run();

    // Give the manifest time to arrive; the receiver must still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(0);
    expect(receiver.manifest).toBeTruthy();
    expect(receiver.accepted).toBe(false);

    // Now accept and let it finish.
    receiver.accept();
    const senderResult = await senderPromise;
    const receiverResult = await receiverPromise;
    expect(senderResult.status).toBe('complete');
    expect(receiverResult.status).toBe('complete');
    expect(received).toEqual(['a.txt']);
  });

  it('receiver rejection propagates to the sender', async () => {
    const [chA, chB] = connectPair();
    let reject = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && reject) reject();
      },
      onFile: async () => {},
    });
    reject = () => receiver.reject('No thanks');

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'a.txt', bytes: bytesOf(100) }]),
    });

    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;

    expect(senderResult.status).toBe('rejected');
    expect(senderResult.reason).toMatch(/No thanks/);
    expect(receiverResult.status).toBe('rejected');
  });
});

// ------------------------------------------------------- cancel / disconnect

describe('cancellation and disconnects', () => {
  it('sender cancel mid-transfer stops the receiver', async () => {
    const content = bytesOf(500_000); // ~15 chunks
    const [chA, chB] = connectPair({ autoDrain: false });

    let accept = null;
    let cancelSender = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
        if (event.type === 'file-start' && cancelSender) cancelSender();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'big.bin', bytes: content }]),
      highWater: 1000,
    });
    cancelSender = () => sender.cancel('user pressed cancel');

    const drainTimer = setInterval(() => chA.drain(), 2);
    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;
    clearInterval(drainTimer);

    expect(senderResult.status).toBe('cancelled');
    expect(receiverResult.status).toBe('cancelled');
    expect(receiverResult.by).toBe('sender');
  });

  it('receiver cancel mid-transfer stops the sender', async () => {
    const content = bytesOf(500_000);
    const [chA, chB] = connectPair({ autoDrain: false });

    let accept = null;
    let cancelReceiver = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
        if (event.type === 'progress' && event.receivedBytes > 30_000 && cancelReceiver) cancelReceiver();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'big.bin', bytes: content }]),
      highWater: 1000,
      onEvent: () => {},
    });
    cancelReceiver = () => receiver.cancel('receiver changed mind');

    const drainTimer = setInterval(() => chA.drain(), 2);
    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;
    clearInterval(drainTimer);

    expect(senderResult.status).toBe('cancelled');
    expect(receiverResult.status).toBe('cancelled');
  });

  it('sender channel closing mid-transfer fails the receiver with PEER_CLOSED', async () => {
    const content = bytesOf(500_000);
    const [chA, chB] = connectPair({ autoDrain: false });

    let accept = null;
    let closeSender = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
        if (event.type === 'file-start' && closeSender) closeSender();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'big.bin', bytes: content }]),
      highWater: 1000,
    });
    closeSender = () => chA.close();

    const drainTimer = setInterval(() => {
      if (chA.readyState === 'open') chA.drain();
    }, 2);
    const receiverPromise = receiver.run();
    // The sender also fails (its own channel closed).
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;
    clearInterval(drainTimer);

    expect(senderResult.status).toBe('failed');
    expect(receiverResult.status).toBe('failed');
    expect(receiverResult.error.code).toBe('PEER_CLOSED');
  });
});

// ------------------------------------------------------------ pause / resume

describe('pause and resume', () => {
  it('pausing and resuming keeps every byte intact', async () => {
    const content = bytesOf(300_000); // ~10 chunks
    const [chA, chB] = connectPair({ autoDrain: false });

    const received = [];
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async (entry, blob) => {
        received.push({ path: entry.path, bytes: new Uint8Array(await blob.arrayBuffer()) });
      },
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'big.bin', bytes: content }]),
      highWater: 1000,
    });

    const drainTimer = setInterval(() => chA.drain(), 2);
    let pauseFired = false;
    let resumeFired = false;
    const controlTimer = setInterval(() => {
      const binaryCount = chunksOf(chA).length;
      if (binaryCount >= 2 && !pauseFired) {
        pauseFired = true;
        sender.pause();
        expect(sender.progress.paused).toBe(true);
        setTimeout(() => {
          sender.resume();
          resumeFired = true;
        }, 25);
      }
    }, 4);

    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;
    clearInterval(drainTimer);
    clearInterval(controlTimer);

    expect(pauseFired).toBe(true);
    expect(resumeFired).toBe(true);
    expect(senderResult.status).toBe('complete');
    expect(receiverResult.status).toBe('complete');
    expect(received[0].bytes).toEqual(content);
  });
});

// ------------------------------------------------------ protocol violations

describe('protocol violation handling', () => {
  it('rejects a manifest with no files (EMPTY_TRANSFER)', async () => {
    const [chA, chB] = connectPair();
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const receiverPromise = receiver.run();
    // Manually send an empty manifest.
    chA.send(encodeControl({ type: CONTROL_TYPES.MANIFEST, files: [], totalBytes: 0, chunkSize: 1024 }));

    const result = await receiverPromise;
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('EMPTY_TRANSFER');
  });

  it('rejects a malformed manifest', async () => {
    const [chA, chB] = connectPair();
    const receiver = new ReceiverTransfer({ channel: chB, onEvent: () => {}, onFile: async () => {} });
    const receiverPromise = receiver.run();
    chA.send(encodeControl({ type: CONTROL_TYPES.MANIFEST, files: 'not-an-array' }));
    const result = await receiverPromise;
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('BAD_MANIFEST');
  });

  it('detects out-of-order chunks', async () => {
    const content = bytesOf(100_000); // 4 chunks
    const [chA, chB] = connectPair();

    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const receiverPromise = receiver.run();

    // Send a valid manifest for one file of 100_000 bytes.
    chA.send(
      encodeControl({
        type: CONTROL_TYPES.MANIFEST,
        files: [{ i: 0, name: 'a.bin', path: 'a.bin', size: content.length, dir: false }],
        totalBytes: content.length,
        chunkSize: 32 * 1024,
      })
    );
    // Wait for accept to be processed, then send file-start + out-of-order chunks.
    await new Promise((resolve) => setTimeout(resolve, 20));
    chA.send(encodeControl({ type: CONTROL_TYPES.FILE_START, index: 0, size: content.length }));
    // Send chunk #0, then chunk #5 (skipping 1-4) -> OUT_OF_ORDER.
    chA.send(encodeChunk(0, 0, content.subarray(0, 32 * 1024)));
    chA.send(encodeChunk(0, 5, content.subarray(0, 32 * 1024)));

    const result = await receiverPromise;
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('OUT_OF_ORDER');
  });

  it('detects receiving more bytes than declared (SIZE_MISMATCH)', async () => {
    const [chA, chB] = connectPair();
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const receiverPromise = receiver.run();

    // Declare 10 bytes...
    chA.send(
      encodeControl({
        type: CONTROL_TYPES.MANIFEST,
        files: [{ i: 0, name: 'a.bin', path: 'a.bin', size: 10, dir: false }],
        totalBytes: 10,
        chunkSize: 32 * 1024,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    chA.send(encodeControl({ type: CONTROL_TYPES.FILE_START, index: 0, size: 10 }));
    // ...but send 100 bytes.
    chA.send(encodeChunk(0, 0, bytesOf(100)));

    const result = await receiverPromise;
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('SIZE_MISMATCH');
  });

  it('detects an incomplete file at file-end (SIZE_MISMATCH)', async () => {
    const [chA, chB] = connectPair();
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const receiverPromise = receiver.run();

    chA.send(
      encodeControl({
        type: CONTROL_TYPES.MANIFEST,
        files: [{ i: 0, name: 'a.bin', path: 'a.bin', size: 100, dir: false }],
        totalBytes: 100,
        chunkSize: 32 * 1024,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    chA.send(encodeControl({ type: CONTROL_TYPES.FILE_START, index: 0, size: 100 }));
    chA.send(encodeChunk(0, 0, bytesOf(50))); // only half
    chA.send(encodeControl({ type: CONTROL_TYPES.FILE_END, index: 0, size: 100 }));

    const result = await receiverPromise;
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('SIZE_MISMATCH');
  });

  it('rejects chunk data before the manifest', async () => {
    const [chA, chB] = connectPair();
    const receiver = new ReceiverTransfer({ channel: chB, onEvent: () => {}, onFile: async () => {} });
    const receiverPromise = receiver.run();
    // No manifest: send a raw chunk straight away.
    chA.send(encodeChunk(0, 0, bytesOf(10)));
    const result = await receiverPromise;
    expect(result.status).toBe('failed');
  });
});

// -------------------------------------------------------- streaming to disk

describe('streaming writer (folder save mode)', () => {
  it('routes chunks through createWriter instead of buffering', async () => {
    const content = bytesOf(80_000, 11); // 3 chunks
    const [chA, chB] = connectPair();

    const writes = [];
    let ended = false;
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async () => {},
      createWriter: async (entry) => ({
        write: async (chunk) => {
          writes.push({ path: entry.path, bytes: new Uint8Array(chunk) });
        },
        end: async () => {
          ended = true;
        },
        abort: () => {},
      }),
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'dir/file.bin', bytes: content }]),
    });

    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;

    expect(senderResult.status).toBe('complete');
    expect(receiverResult.status).toBe('complete');
    expect(ended).toBe(true);
    expect(writes.length).toBe(3);

    // Reassemble: the streamed bytes must equal the original content.
    const total = writes.reduce((sum, w) => sum + w.bytes.length, 0);
    expect(total).toBe(content.length);
    const rebuilt = new Uint8Array(total);
    let offset = 0;
    for (const w of writes) {
      rebuilt.set(w.bytes, offset);
      offset += w.bytes.length;
    }
    expect(rebuilt).toEqual(content);
  });

  it('aborts the writer on cancel so no partial file is kept', async () => {
    const content = bytesOf(500_000);
    const [chA, chB] = connectPair({ autoDrain: false });

    let aborted = false;
    let accept = null;
    let cancelSender = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
        if (event.type === 'file-start' && cancelSender) cancelSender();
      },
      onFile: async () => {},
      createWriter: async () => ({
        write: async () => {},
        end: async () => {},
        abort: () => {
          aborted = true;
        },
      }),
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'big.bin', bytes: content }]),
      highWater: 1000,
    });
    cancelSender = () => sender.cancel('stop');

    const drainTimer = setInterval(() => chA.drain(), 2);
    const receiverPromise = receiver.run();
    await sender.run();
    await receiverPromise;
    clearInterval(drainTimer);

    expect(aborted).toBe(true);
  });
});

// -------------------------------------------------------------- backpressure

describe('backpressure', () => {
  it('sender respects bufferedAmount and drains before sending more', async () => {
    const content = bytesOf(200_000); // ~7 chunks at 32 KiB
    const [chA, chB] = connectPair({ autoDrain: false });

    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async () => {},
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: makeFiles([{ path: 'big.bin', bytes: content }]),
      highWater: 1000, // force the sender to wait after nearly every chunk
    });

    const drainTimer = setInterval(() => chA.drain(), 2);
    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;
    clearInterval(drainTimer);

    expect(senderResult.status).toBe('complete');
    expect(receiverResult.status).toBe('complete');
    // The sender really hit the high-water mark at least once.
    expect(chA.maxBuffered).toBeGreaterThan(1000);
  });
});

// ------------------------------------------------------------ edge: 0-byte

describe('zero-byte files', () => {
  it('transfers a 0-byte file without stalling', async () => {
    const [chA, chB] = connectPair();
    const received = [];
    let accept = null;
    const receiver = new ReceiverTransfer({
      channel: chB,
      onEvent: (event) => {
        if (event.type === 'manifest' && accept) accept();
      },
      onFile: async (entry, blob) => {
        received.push({ path: entry.path, size: blob ? blob.size : 0 });
      },
    });
    accept = () => receiver.accept();

    const sender = new SenderTransfer({
      channel: chA,
      files: [{ index: 0, name: 'empty.txt', path: 'empty.txt', size: 0, dir: false, blob: new Blob([]) }],
    });

    const receiverPromise = receiver.run();
    const senderResult = await sender.run();
    const receiverResult = await receiverPromise;

    expect(senderResult.status).toBe('complete');
    expect(receiverResult.status).toBe('complete');
    expect(received).toEqual([{ path: 'empty.txt', size: 0 }]);
  });
});
