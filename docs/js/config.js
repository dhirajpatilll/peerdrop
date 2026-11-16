// ============================================================
// PeerDrop – Central Configuration
// Edit SIGNALING_URL after deploying server to Render.
// Edit ICE_SERVERS with your TURN credentials before demo.
// ============================================================

export const CONFIG = {
  // ── Signaling ────────────────────────────────────────────
  // Replace with your Render wss:// URL after deployment.
  // For local testing use: ws://localhost:3001 (auto-detected below)
SIGNALING_URL: (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
  ? `ws://${window.location.hostname}:3001`
  : 'wss://peerdrop-phfl.onrender.com',

  // ── Room settings ────────────────────────────────────────
  ROOM_CODE_LENGTH: 6,

  // ── ICE / STUN / TURN ────────────────────────────────────
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // ── TURN placeholder – fill in before demo ──────────────
    // {
    //   urls:       'turn:YOUR_TURN_HOST:3478',
    //   username:   'YOUR_TURN_USERNAME',
    //   credential: 'YOUR_TURN_CREDENTIAL',
    // },
    // {
    //   urls:       'turns:YOUR_TURN_HOST:5349',
    //   username:   'YOUR_TURN_USERNAME',
    //   credential: 'YOUR_TURN_CREDENTIAL',
    // },
  ],

  // ── Data channel tuning ──────────────────────────────────
  CHUNK_SIZE:            16 * 1024,        // 16 KB per chunk
  BUFFER_HIGH_WATER:     1 * 1024 * 1024,  // pause sending above 1 MB buffered
  BUFFER_LOW_THRESHOLD:  256 * 1024,       // resume sending below 256 KB

  // ── Integrity ────────────────────────────────────────────
  SHA256_MAX_SIZE: 500 * 1024 * 1024,      // 500 MB – compute SHA-256 up to this

  // ── Reconnect / heartbeat ────────────────────────────────
  RECONNECT_BASE_MS:   1_000,
  RECONNECT_MAX_MS:   30_000,
  RECONNECT_JITTER:    0.3,
  HEARTBEAT_INTERVAL: 25_000,

  // ── Stats polling ─────────────────────────────────────────
  STATS_INTERVAL_MS: 1_000,

  // ── Max concurrent inbound transfers ─────────────────────
  MAX_IN_FLIGHT: 3,
};

export default CONFIG;
