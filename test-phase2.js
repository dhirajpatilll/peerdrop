// ============================================================
// test-phase2.js – Unit and integration tests for Phase 2:
// RTCDataChannel file transfer, backpressure, integrity, zero-byte,
// cancellation, and lazy slicing.
// ============================================================

import { FileSender, FileReceiver } from './web/js/transfer.js';
import { CONFIG } from './web/js/config.js';
import { sha256 } from './web/js/utils.js';
import assert from 'assert';

console.log('--- Running Phase 2 File Transfer Tests ---');

// Mock DataChannels that pair with each other
class MockChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = CONFIG.BUFFER_LOW_THRESHOLD;
    this._listeners = new Map();
    this.peer = null;
  }

  addEventListener(event, fn, opts) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push({ fn, once: opts?.once });
  }

  emit(event, ...args) {
    const list = this._listeners.get(event) || [];
    const remaining = [];
    for (const item of list) {
      item.fn(...args);
      if (!item.once) remaining.push(item);
    }
    this._listeners.set(event, remaining);
  }

  send(data) {
    if (this.peer) {
      // Simulate asynchronous network delivery
      queueMicrotask(() => {
        this.peer.emit('message', { data });
      });
    }
  }
}

function createMockPair() {
  const fileA = new MockChannel('files');
  const fileB = new MockChannel('files');
  fileA.peer = fileB;
  fileB.peer = fileA;

  const ctrlA = new MockChannel('control');
  const ctrlB = new MockChannel('control');
  ctrlA.peer = ctrlB;
  ctrlB.peer = ctrlA;

  return { senderChs: { file: fileA, ctrl: ctrlA }, receiverChs: { file: fileB, ctrl: ctrlB } };
}

async function runTests() {
  // Test 1: Zero-byte file transfer
  console.log('[Test 1] Zero-byte file transfer...');
  {
    const { senderChs, receiverChs } = createMockPair();
    const sender = new FileSender(senderChs.file, senderChs.ctrl);
    const receiver = new FileReceiver();

    receiverChs.ctrl.addEventListener('message', (e) => {
      receiver.onControlMessage(JSON.parse(e.data));
    });
    receiverChs.file.addEventListener('message', (e) => {
      receiver.onFileChunk(e.data);
    });

    const zeroBlob = new Blob([], { type: 'text/plain' });
    zeroBlob.name = 'empty.txt';

    const completePromise = new Promise((resolve) => {
      receiver.on('complete', (res) => resolve(res));
    });

    sender.enqueue(zeroBlob);
    const result = await completePromise;
    assert.strictEqual(result.name, 'empty.txt');
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.size, 0);
    console.log('✓ Zero-byte file transferred and verified successfully');
  }

  // Test 2: Standard file transfer with SHA-256 integrity verification
  console.log('[Test 2] Multi-chunk file transfer with SHA-256 verification...');
  {
    const { senderChs, receiverChs } = createMockPair();
    const sender = new FileSender(senderChs.file, senderChs.ctrl);
    const receiver = new FileReceiver();

    receiverChs.ctrl.addEventListener('message', (e) => {
      receiver.onControlMessage(JSON.parse(e.data));
    });
    receiverChs.file.addEventListener('message', (e) => {
      receiver.onFileChunk(e.data);
    });

    // Create 64 KB content (multiple 16 KB chunks)
    const testData = new Uint8Array(64 * 1024);
    for (let i = 0; i < testData.length; i++) testData[i] = i % 256;
    const testBlob = new Blob([testData], { type: 'application/octet-stream' });
    testBlob.name = 'sample-data.bin';

    let progressCount = 0;
    receiver.on('progress', (p) => {
      progressCount++;
    });

    const completePromise = new Promise((resolve) => {
      receiver.on('complete', (res) => resolve(res));
    });

    sender.enqueue(testBlob);
    const result = await completePromise;

    assert.strictEqual(result.name, 'sample-data.bin');
    assert.strictEqual(result.verified, true, 'SHA-256 integrity check must pass');
    assert.strictEqual(result.size, 64 * 1024);
    assert(progressCount > 0, 'Progress events must be emitted');

    // Verify blob content
    const receivedBuf = await result.blob.arrayBuffer();
    const expectedHash = await sha256(testData.buffer);
    const actualHash = await sha256(receivedBuf);
    assert.strictEqual(actualHash, expectedHash);
    console.log(`✓ 64 KB file (4 chunks) transferred, SHA-256 verified (${actualHash.slice(0, 16)}...)`);
  }

  // Test 3: Backpressure handling
  console.log('[Test 3] Backpressure handling (pausing on high water mark)...');
  {
    const { senderChs, receiverChs } = createMockPair();
    const sender = new FileSender(senderChs.file, senderChs.ctrl);
    const receiver = new FileReceiver();

    receiverChs.ctrl.addEventListener('message', (e) => {
      receiver.onControlMessage(JSON.parse(e.data));
    });
    receiverChs.file.addEventListener('message', (e) => {
      receiver.onFileChunk(e.data);
    });

    // Simulate channel buffer saturation
    let pausedTriggered = false;
    sender.on('paused', () => {
      pausedTriggered = true;
      // Simulate draining buffer after 50ms
      setTimeout(() => {
        senderChs.file.bufferedAmount = CONFIG.BUFFER_LOW_THRESHOLD - 1000;
        senderChs.file.emit('bufferedamountlow');
      }, 50);
    });

    // Intercept send to artificially inflate bufferedAmount
    const originalSend = senderChs.file.send.bind(senderChs.file);
    senderChs.file.send = (data) => {
      senderChs.file.bufferedAmount += data.byteLength;
      originalSend(data);
    };

    const bigBlob = new Blob([new Uint8Array(1.5 * 1024 * 1024)], { type: 'application/octet-stream' });
    bigBlob.name = 'large-buffer-test.bin';

    const completePromise = new Promise((resolve) => {
      receiver.on('complete', (res) => resolve(res));
    });

    sender.enqueue(bigBlob);
    const result = await completePromise;
    assert.strictEqual(pausedTriggered, true, 'Backpressure paused event must be triggered when buffer is full');
    assert.strictEqual(result.verified, true);
    console.log('✓ Backpressure correctly paused transmission above 1 MB and resumed on bufferedamountlow');
  }

  // Test 4: Cancel mid-transfer
  console.log('[Test 4] Cancellation mid-transfer...');
  {
    const { senderChs, receiverChs } = createMockPair();
    const sender = new FileSender(senderChs.file, senderChs.ctrl);
    const receiver = new FileReceiver();

    receiverChs.ctrl.addEventListener('message', (e) => {
      receiver.onControlMessage(JSON.parse(e.data));
    });
    receiverChs.file.addEventListener('message', (e) => {
      receiver.onFileChunk(e.data);
    });

    const testBlob = new Blob([new Uint8Array(500 * 1024)], { type: 'application/octet-stream' });
    testBlob.name = 'cancel-test.bin';

    let senderCancelled = false;
    let receiverCancelled = false;

    sender.on('cancelled', () => { senderCancelled = true; });
    receiver.on('cancelled', () => { receiverCancelled = true; });

    let id = null;
    sender.on('sending', (info) => {
      id = info.id;
      // Cancel immediately during first chunk
      sender.cancel(id);
    });

    sender.enqueue(testBlob);

    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(senderCancelled, true, 'Sender must emit cancelled');
    assert.strictEqual(receiverCancelled, true, 'Receiver must emit cancelled on control cancel message');
    console.log('✓ Mid-transfer cancellation cleanly aborted transfer on both ends');
  }

  console.log('\n=======================================');
  console.log(' ALL PHASE 2 TESTS PASSED SUCCESSFULLY! ');
  console.log('=======================================\n');
}

runTests().catch((err) => {
  console.error('Phase 2 test failed:', err);
  process.exit(1);
});
