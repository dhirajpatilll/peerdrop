// ============================================================
// transfer.js – File transfer over RTCDataChannel
// Backpressure, lazy chunk reading, SHA-256 integrity,
// FSA streaming for large files.
// ============================================================

import { EventEmitter, sha256, sanitizeFilename, randomId, formatBytes } from './utils.js';
import { CONFIG } from './config.js';

// ── Sender ────────────────────────────────────────────────────
export class FileSender extends EventEmitter {
  constructor(fileChannel, controlChannel) {
    super();
    this._fileCh    = fileChannel;
    this._ctrlCh    = controlChannel;
    this._queue     = [];        // { file, id }[]
    this._active    = false;
    this._cancelled = new Set();
    this._currentId = null;
    this._paused    = false;

    this._fileCh.addEventListener('bufferedamountlow', () => {
      if (this._paused) {
        this._paused = false;
        this.emit('resume', this._currentId);
        this._sendNextChunk();
      }
    });
  }

  enqueue(file) {
    const id = randomId();
    this._queue.push({ file, id });
    this.emit('queued', { id, name: file.name, size: file.size, mime: file.type });
    if (!this._active) this._sendNext();
    return id;
  }

  cancel(id) {
    this._cancelled.add(id);
    if (this._currentId === id) {
      this._sendControl({ type: 'transfer-cancel', id });
    } else {
      this._queue = this._queue.filter(q => q.id !== id);
    }
    this.emit('cancelled', id);
  }

  async _sendNext() {
    if (this._queue.length === 0) { this._active = false; return; }
    this._active = true;
    const { file, id } = this._queue.shift();
    this._currentId = id;

    if (this._cancelled.has(id)) {
      this._cancelled.delete(id);
      this._active = false;
      this._sendNext();
      return;
    }

    const totalChunks = Math.ceil(file.size / CONFIG.CHUNK_SIZE);
    const useSha = file.size <= CONFIG.SHA256_MAX_SIZE;
    let hash = null;

    if (useSha && file.size > 0) {
      this.emit('hashing', id);
      try {
        const buf = await file.arrayBuffer();
        hash = await sha256(buf);
      } catch (e) {
        hash = null;
      }
    }

    this._sendControl({
      type:        'file-meta',
      id,
      name:        file.name,
      size:        file.size,
      mime:        file.type || 'application/octet-stream',
      chunkSize:   CONFIG.CHUNK_SIZE,
      totalChunks,
      sha256:      hash,
    });

    this.emit('sending', { id, name: file.name, size: file.size, totalChunks });

    if (file.size === 0) {
      this._sendControl({ type: 'file-end', id, totalChunks: 0 });
      this.emit('done', id);
      this._currentId = null;
      this._active = false;
      this._sendNext();
      return;
    }

    this._chunkIter = this._chunksOf(file, id, totalChunks);
    this._sendNextChunk();
  }

  async _sendNextChunk() {
    if (!this._chunkIter) return;
    const iter = this._chunkIter;

    for await (const { chunk, chunkIndex, id, totalChunks } of iter) {
      if (this._cancelled.has(id)) {
        this._cancelled.delete(id);
        this._sendControl({ type: 'transfer-cancel', id });
        this.emit('cancelled', id);
        this._currentId = null;
        this._active    = false;
        this._chunkIter = null;
        this._sendNext();
        return;
      }

      // Backpressure
      while (this._fileCh.bufferedAmount > CONFIG.BUFFER_HIGH_WATER) {
        this._paused = true;
        this.emit('paused', id);
        await new Promise(resolve => {
          const onLow = () => {
            this._paused = false;
            resolve();
          };
          this._fileCh.addEventListener('bufferedamountlow', onLow, { once: true });
        });
      }

      if (this._fileCh.readyState !== 'open') {
        this.emit('failed', id, 'Channel closed');
        this._currentId = null;
        this._active    = false;
        this._chunkIter = null;
        return;
      }

      this._fileCh.send(chunk);
      this.emit('progress', { id, chunkIndex, totalChunks });
    }

    // End of file
    const id = this._currentId;
    this._sendControl({ type: 'file-end', id, totalChunks: this._totalChunks });
    this.emit('done', id);
    this._currentId = null;
    this._active    = false;
    this._chunkIter = null;
    this._sendNext();
  }

  async *_chunksOf(file, id, totalChunks) {
    this._totalChunks = totalChunks;
    let offset = 0;
    let chunkIndex = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + CONFIG.CHUNK_SIZE);
      const buf   = await slice.arrayBuffer();
      yield { chunk: buf, chunkIndex, id, totalChunks };
      offset += CONFIG.CHUNK_SIZE;
      chunkIndex++;
    }
  }

  _sendControl(obj) {
    if (this._ctrlCh?.readyState === 'open') {
      this._ctrlCh.send(JSON.stringify(obj));
    }
  }
}

// ── Receiver ──────────────────────────────────────────────────
export class FileReceiver extends EventEmitter {
  constructor() {
    super();
    this._transfers = new Map(); // id → TransferState
    this._activeId  = null;
  }

  get activeId() { return this._activeId; }

  onControlMessage(msg) {
    if (msg.type === 'file-meta') {
      this._startTransfer(msg);
    } else if (msg.type === 'file-end') {
      this._finishTransfer(msg.id, msg.sha256);
    } else if (msg.type === 'transfer-cancel') {
      this._cancelTransfer(msg.id);
    }
  }

  onFileChunk(buffer, explicitId = null) {
    const id = explicitId || this._activeId;
    if (!id) return;
    const t = this._transfers.get(id);
    if (!t) return;

    if (t.writer) {
      // Direct disk streaming via File System Access API
      try {
        t.writer.write(buffer);
      } catch (err) {
        console.error('FSA write error:', err);
      }
    } else {
      t.chunks.push(buffer);
    }

    t.received += buffer.byteLength;
    t.chunkCount++;

    this.emit('progress', {
      id,
      received: t.received,
      size:     t.meta.size,
      chunks:   t.chunkCount,
      total:    t.meta.totalChunks,
    });
  }

  async attachFileHandle(id, handle) {
    const t = this._transfers.get(id);
    if (!t) return;
    try {
      t.writer = await handle.createWritable();
      // Write any chunks buffered prior to handle selection
      if (t.chunks.length > 0) {
        for (const chunk of t.chunks) {
          await t.writer.write(chunk);
        }
        t.chunks = []; // free memory
      }
    } catch (err) {
      console.warn('Could not attach file handle:', err);
    }
  }

  cancel(id, ctrlChannel = null) {
    this._cancelTransfer(id);
    if (ctrlChannel?.readyState === 'open') {
      try {
        ctrlChannel.send(JSON.stringify({ type: 'transfer-cancel', id }));
      } catch {}
    }
  }

  _startTransfer(meta) {
    const name = sanitizeFilename(meta.name);
    this._activeId = meta.id;
    const t = {
      meta:       { ...meta, name },
      chunks:     [],
      received:   0,
      chunkCount: 0,
      writer:     null,
    };
    this._transfers.set(meta.id, t);
    this.emit('started', { id: meta.id, name, size: meta.size, mime: meta.mime });

    // Warning if > 500 MB and no FSA attached yet
    if (meta.size > 500 * 1024 * 1024) {
      this.emit('warning', {
        id: meta.id,
        message: 'Large file (>500 MB). Without disk streaming, browser memory may fill up.',
      });
    }
  }

  async _finishTransfer(id, endSha = null) {
    const t = this._transfers.get(id);
    if (!t) return;
    this._transfers.delete(id);
    if (this._activeId === id) this._activeId = null;

    const { meta, chunks, writer } = t;

    // Zero-byte file
    if (meta.size === 0) {
      const blob = new Blob([], { type: meta.mime });
      this.emit('complete', { id, name: meta.name, blob, verified: true, size: 0 });
      return;
    }

    if (writer) {
      try {
        await writer.close();
        this.emit('complete', {
          id,
          name: meta.name,
          fsa: true,
          verified: t.chunkCount === meta.totalChunks,
          size: meta.size,
        });
        return;
      } catch (err) {
        console.error('Error closing FSA writer:', err);
      }
    }

    // Assemble in memory
    const blob = new Blob(chunks, { type: meta.mime });
    t.chunks = []; // allow GC

    const expectedHash = meta.sha256 || endSha;
    let verified = false;

    if (expectedHash && meta.size <= CONFIG.SHA256_MAX_SIZE) {
      try {
        const buf  = await blob.arrayBuffer();
        const hash = await sha256(buf);
        verified   = hash.toLowerCase() === expectedHash.toLowerCase();
      } catch {
        verified = false;
      }
    } else {
      // For large files or where hash is omitted, verify chunk count + exact byte size
      verified = t.chunkCount === meta.totalChunks && blob.size === meta.size;
    }

    this.emit('complete', { id, name: meta.name, blob, verified, size: meta.size });
  }

  _cancelTransfer(id) {
    const t = this._transfers.get(id);
    if (t?.writer) {
      try { t.writer.abort(); } catch {}
    }
    this._transfers.delete(id);
    if (this._activeId === id) this._activeId = null;
    this.emit('cancelled', id);
  }
}
