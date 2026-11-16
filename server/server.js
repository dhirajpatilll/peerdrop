// ============================================================
// PeerDrop Signaling Server
// Node.js + ws, deployable on Render free tier (wss://)
// ============================================================

'use strict';

const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ── Constants ────────────────────────────────────────────────
const PORT              = process.env.PORT || 3001;
const MAX_PEERS         = 2;          // raise this constant to allow more peers
const MAX_MSG_BYTES     = 64 * 1024;  // 64 KB message size limit
const HEARTBEAT_MS      = 25_000;
const ROOM_EXPIRE_MS    = 2 * 60 * 60 * 1000; // 2 hours
const RATE_LIMIT_WINDOW = 1_000;      // 1 second
const RATE_LIMIT_MAX    = 30;         // max messages per second per connection
const CLEANUP_INTERVAL  = 60_000;    // sweep expired rooms every minute

const ALLOWED_ORIGINS_ENV = process.env.ALLOWED_ORIGINS || '';
const ALLOWED_ORIGINS = ALLOWED_ORIGINS_ENV
  ? ALLOWED_ORIGINS_ENV.split(',').map(o => o.trim()).filter(Boolean)
  : null; // null = allow all (dev mode)

// ── Logging ──────────────────────────────────────────────────
function log(level, event, data = {}) {
  const entry = {
    ts:    new Date().toISOString(),
    level,
    event,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function info(event, data)  { log('INFO',  event, data); }
function warn(event, data)  { log('WARN',  event, data); }
function error(event, data) { log('ERROR', event, data); }

// ── Room store ───────────────────────────────────────────────
// rooms: Map<code, { peers: Set<WebSocket>, createdAt: number }>
const rooms = new Map();

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { peers: new Set(), createdAt: Date.now() });
    info('room-created', { code });
  }
  return rooms.get(code);
}

function cleanRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.peers.size === 0) {
    rooms.delete(code);
    info('room-deleted', { code, reason: 'empty' });
  }
}

function sweepExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_EXPIRE_MS) {
      for (const peer of room.peers) {
        sendTo(peer, { type: 'room-expired' });
        peer.terminate();
      }
      rooms.delete(code);
      info('room-deleted', { code, reason: 'expired' });
    }
  }
}

// ── Message helpers ──────────────────────────────────────────
function sendTo(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function relayToOthers(ws, obj) {
  const room = rooms.get(ws._roomCode);
  if (!room) return;
  for (const peer of room.peers) {
    if (peer !== ws) sendTo(peer, obj);
  }
}

// ── Origin validation ────────────────────────────────────────
function isOriginAllowed(origin) {
  if (!ALLOWED_ORIGINS) return true; // allow all in dev
  return ALLOWED_ORIGINS.some(o => origin === o || origin.endsWith(o));
}

// ── Code validation ──────────────────────────────────────────
const CODE_RE = /^[A-Z2-9]{6}$/;
function isValidCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

// ── HTTP server (health endpoint) ───────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms:  rooms.size,
      peers:  [...rooms.values()].reduce((n, r) => n + r.peers.size, 0),
      uptime: process.uptime(),
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── WebSocket server ─────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MSG_BYTES,
  verifyClient: ({ origin, req }, cb) => {
    if (!isOriginAllowed(origin || '')) {
      warn('origin-blocked', { origin });
      cb(false, 403, 'Forbidden');
      return;
    }
    cb(true);
  },
});

wss.on('connection', (ws, req) => {
  // Per-connection state
  ws._roomCode  = null;
  ws._alive     = true;
  ws._msgCount  = 0;
  ws._rateReset = Date.now();
  ws._peerId    = Math.random().toString(36).slice(2, 10);

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  info('ws-connected', { peerId: ws._peerId, ip });

  // ── Heartbeat ──────────────────────────────────────────
  ws.on('pong', () => { ws._alive = true; });

  // ── Message handler ───────────────────────────────────
  ws.on('message', (raw) => {
    // Rate limiting
    const now = Date.now();
    if (now - ws._rateReset > RATE_LIMIT_WINDOW) {
      ws._msgCount  = 0;
      ws._rateReset = now;
    }
    ws._msgCount++;
    if (ws._msgCount > RATE_LIMIT_MAX) {
      warn('rate-limited', { peerId: ws._peerId });
      sendTo(ws, { type: 'error', message: 'Rate limit exceeded' });
      return;
    }

    // Parse JSON
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      warn('malformed-json', { peerId: ws._peerId });
      sendTo(ws, { type: 'error', message: 'Malformed JSON' });
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      sendTo(ws, { type: 'error', message: 'Missing type field' });
      return;
    }

    handleMessage(ws, msg);
  });

  // ── Close ─────────────────────────────────────────────
  ws.on('close', () => {
    info('ws-disconnected', { peerId: ws._peerId, roomCode: ws._roomCode });
    if (ws._roomCode) {
      relayToOthers(ws, { type: 'peer-left', peerId: ws._peerId });
      const room = rooms.get(ws._roomCode);
      if (room) {
        room.peers.delete(ws);
        cleanRoom(ws._roomCode);
      }
    }
  });

  ws.on('error', (err) => {
    error('ws-error', { peerId: ws._peerId, msg: err.message });
  });
});

// ── Message dispatcher ───────────────────────────────────────
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'ping':
      sendTo(ws, { type: 'pong' });
      break;

    case 'create-room': {
      if (ws._roomCode) {
        sendTo(ws, { type: 'error', message: 'Already in a room' });
        return;
      }
      const code = generateCode();
      const room = getOrCreateRoom(code);
      room.peers.add(ws);
      ws._roomCode = code;
      sendTo(ws, { type: 'room-created', code, peerId: ws._peerId });
      info('peer-created-room', { peerId: ws._peerId, code });
      break;
    }

    case 'join-room': {
      const { code } = msg;
      if (!isValidCode(code)) {
        sendTo(ws, { type: 'error', message: 'Invalid room code' });
        return;
      }
      if (ws._roomCode) {
        sendTo(ws, { type: 'error', message: 'Already in a room' });
        return;
      }
      const room = rooms.get(code);
      if (!room) {
        sendTo(ws, { type: 'room-not-found', code });
        return;
      }
      if (room.peers.size >= MAX_PEERS) {
        sendTo(ws, { type: 'room-full', code });
        return;
      }
      room.peers.add(ws);
      ws._roomCode = code;
      sendTo(ws, { type: 'room-joined', code, peerId: ws._peerId, peerCount: room.peers.size });
      relayToOthers(ws, { type: 'peer-joined', peerId: ws._peerId });
      info('peer-joined-room', { peerId: ws._peerId, code, peerCount: room.peers.size });
      break;
    }

    case 'offer': {
      if (!assertInRoom(ws)) return;
      // Log that an offer was sent; never log the full SDP body
      info('offer-relayed', {
        from: ws._peerId,
        code: ws._roomCode,
        sdpLines: msg.sdp ? msg.sdp.split('\n').length : 0,
      });
      relayToOthers(ws, { type: 'offer', sdp: msg.sdp });
      break;
    }

    case 'answer': {
      if (!assertInRoom(ws)) return;
      info('answer-relayed', {
        from: ws._peerId,
        code: ws._roomCode,
        sdpLines: msg.sdp ? msg.sdp.split('\n').length : 0,
      });
      relayToOthers(ws, { type: 'answer', sdp: msg.sdp });
      break;
    }

    case 'ice-candidate': {
      if (!assertInRoom(ws)) return;
      info('ice-candidate-relayed', {
        from:      ws._peerId,
        code:      ws._roomCode,
        type:      msg.candidate?.type || 'unknown',
        protocol:  msg.candidate?.protocol,
      });
      relayToOthers(ws, { type: 'ice-candidate', candidate: msg.candidate });
      break;
    }

    case 'leave': {
      if (!ws._roomCode) return;
      relayToOthers(ws, { type: 'peer-left', peerId: ws._peerId });
      const room = rooms.get(ws._roomCode);
      if (room) {
        room.peers.delete(ws);
        cleanRoom(ws._roomCode);
      }
      ws._roomCode = null;
      sendTo(ws, { type: 'left' });
      info('peer-left', { peerId: ws._peerId });
      break;
    }

    default:
      warn('unknown-message-type', { peerId: ws._peerId, msgType: msg.type });
      sendTo(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

function assertInRoom(ws) {
  if (!ws._roomCode || !rooms.has(ws._roomCode)) {
    sendTo(ws, { type: 'error', message: 'Not in a room' });
    return false;
  }
  return true;
}

// ── Code generator ───────────────────────────────────────────
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0,O,1,I
function generateCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

// ── Heartbeat interval ───────────────────────────────────────
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws._alive) {
      info('heartbeat-timeout', { peerId: ws._peerId });
      ws.terminate();
      return;
    }
    ws._alive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

// ── Room expiry sweep ────────────────────────────────────────
const sweepTimer = setInterval(sweepExpiredRooms, CLEANUP_INTERVAL);

// ── Graceful shutdown ────────────────────────────────────────
function shutdown() {
  info('server-shutdown', {});
  clearInterval(heartbeatTimer);
  clearInterval(sweepTimer);
  wss.close(() => server.close(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ── Start ────────────────────────────────────────────────────
server.listen(PORT, () => {
  info('server-started', {
    port:            PORT,
    maxPeers:        MAX_PEERS,
    allowedOrigins:  ALLOWED_ORIGINS || 'ALL',
  });
});
