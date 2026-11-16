// ============================================================
// signaling.js – WebSocket signaling client
// Auto-reconnects with exponential backoff; rejoins room.
// ============================================================

import { EventEmitter, backoff, sleep } from './utils.js';
import { CONFIG } from './config.js';

export class SignalingClient extends EventEmitter {
  constructor(url) {
    super();
    this._url        = url;
    this._ws         = null;
    this._roomCode   = null;
    this._peerId     = null;
    this._attempt    = 0;
    this._dead       = false;
    this._pingTimer  = null;
    this._pongTimer  = null;
  }

  // ── Public API ─────────────────────────────────────────────
  connect() {
    if (this._dead) return;
    this._open();
  }

  createRoom() {
    this._send({ type: 'create-room' });
  }

  joinRoom(code) {
    this._send({ type: 'join-room', code: code.toUpperCase() });
  }

  sendOffer(sdp) {
    this._send({ type: 'offer', sdp });
  }

  sendAnswer(sdp) {
    this._send({ type: 'answer', sdp });
  }

  sendIceCandidate(candidate) {
    this._send({ type: 'ice-candidate', candidate });
  }

  leaveRoom() {
    if (this._roomCode) this._send({ type: 'leave' });
    this._roomCode = null;
  }

  destroy() {
    this._dead = true;
    this._clearPing();
    if (this._ws) this._ws.close(1000, 'destroy');
    this._ws = null;
  }

  get roomCode()  { return this._roomCode; }
  get peerId()    { return this._peerId;   }
  get connected() { return this._ws?.readyState === WebSocket.OPEN; }

  // ── Internal ───────────────────────────────────────────────
  _open() {
    this.emit('status', 'connecting');
    let ws;
    try {
      ws = new WebSocket(this._url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._attempt = 0;
      this.emit('status', 'connected');
      this._startPing();
      // If we were in a room (reconnect scenario), rejoin
      if (this._roomCode) {
        this.emit('log', `Reconnected – rejoining room ${this._roomCode}`);
        this._send({ type: 'join-room', code: this._roomCode });
      }
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); }
      catch { return; }
      this._handleMessage(msg);
    });

    ws.addEventListener('close', (evt) => {
      this._clearPing();
      this.emit('status', 'disconnected');
      if (!this._dead) this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' fires after 'error'; reconnect handled there
    });
  }

  _handleMessage(msg) {
    this.emit('raw-message', msg); // for the debug log
    switch (msg.type) {
      case 'room-created':
        this._roomCode = msg.code;
        this._peerId   = msg.peerId;
        this.emit('room-created', msg.code, msg.peerId);
        break;
      case 'room-joined':
        this._roomCode = msg.code;
        this._peerId   = msg.peerId;
        this.emit('room-joined', msg.code, msg.peerId, msg.peerCount);
        break;
      case 'room-not-found':
        this.emit('room-not-found', msg.code);
        break;
      case 'room-full':
        this.emit('room-full', msg.code);
        break;
      case 'room-expired':
        this._roomCode = null;
        this.emit('room-expired');
        break;
      case 'peer-joined':
        this.emit('peer-joined', msg.peerId);
        break;
      case 'peer-left':
        this.emit('peer-left', msg.peerId);
        break;
      case 'offer':
        this.emit('offer', msg.sdp);
        break;
      case 'answer':
        this.emit('answer', msg.sdp);
        break;
      case 'ice-candidate':
        this.emit('ice-candidate', msg.candidate);
        break;
      case 'pong':
        // Pong received; already handled by _alive flag
        clearTimeout(this._pongTimer);
        break;
      case 'left':
        break;
      case 'error':
        this.emit('server-error', msg.message);
        break;
      default:
        // ignore unknown
    }
  }

  _send(obj) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _startPing() {
    this._clearPing();
    this._pingTimer = setInterval(() => {
      this._send({ type: 'ping' });
      this._pongTimer = setTimeout(() => {
        this.emit('log', 'Pong timeout – reconnecting');
        this._ws?.close();
      }, 5_000);
    }, CONFIG.HEARTBEAT_INTERVAL);
  }

  _clearPing() {
    clearInterval(this._pingTimer);
    clearTimeout(this._pongTimer);
    this._pingTimer = null;
    this._pongTimer = null;
  }

  async _scheduleReconnect() {
    if (this._dead) return;
    const delay = backoff(
      this._attempt++,
      CONFIG.RECONNECT_BASE_MS,
      CONFIG.RECONNECT_MAX_MS,
      CONFIG.RECONNECT_JITTER
    );
    this.emit('reconnecting', delay, this._attempt);
    this.emit('log', `Reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${this._attempt})`);
    await sleep(delay);
    this._open();
  }
}
