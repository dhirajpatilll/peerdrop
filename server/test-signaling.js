// test-signaling.js – automated Phase 1 verification
// Run with: node test-signaling.js
// Tests: create room, join room, relay offer/answer/ICE, leave

const { WebSocket } = require('ws');

const URL = 'ws://localhost:3001';
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => resolve(ws));
  });
}

function waitMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), 5000);
    ws.on('message', function handler(data) {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    });
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

async function run() {
  console.log('\n── PeerDrop Phase 1 Signaling Tests ──\n');

  // Test 1: Health check
  try {
    const http  = require('http');
    const health = await new Promise((res, rej) => {
      http.get('http://localhost:3001/health', (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => res({ status: r.statusCode, body: JSON.parse(d) }));
      }).on('error', rej);
    });
    assert(health.status === 200, 'GET /health returns 200');
    assert(health.body.status === 'ok', '/health body.status === ok');
  } catch(e) {
    assert(false, `GET /health: ${e.message}`);
  }

  // Test 2: Create room
  const ws1 = await connect();
  send(ws1, { type: 'create-room' });
  const created = await waitMsg(ws1, 'room-created');
  assert(typeof created.code === 'string' && created.code.length === 6, `Room created with 6-char code: ${created.code}`);
  assert(/^[A-Z2-9]{6}$/.test(created.code), 'Code uses only valid chars (A-Z, 2-9)');
  const roomCode = created.code;

  // Test 3: Join room
  const ws2 = await connect();
  send(ws2, { type: 'join-room', code: roomCode });
  const [joined, peerJoinedMsg] = await Promise.all([
    waitMsg(ws2, 'room-joined'),
    waitMsg(ws1, 'peer-joined'),
  ]);
  assert(joined.code === roomCode, `ws2 joined room ${roomCode}`);
  assert(typeof peerJoinedMsg.peerId === 'string', 'ws1 received peer-joined event');

  // Test 4: Relay offer
  send(ws1, { type: 'offer', sdp: 'v=0\r\no=test 1 2 IN IP4 127.0.0.1\r\n' });
  const offer = await waitMsg(ws2, 'offer');
  assert(offer.type === 'offer', 'Offer relayed to ws2');
  assert(offer.sdp.includes('v=0'), 'Offer SDP content preserved');

  // Test 5: Relay answer
  send(ws2, { type: 'answer', sdp: 'v=0\r\no=answer 1 2 IN IP4 127.0.0.1\r\n' });
  const answer = await waitMsg(ws1, 'answer');
  assert(answer.type === 'answer', 'Answer relayed to ws1');

  // Test 6: Relay ICE candidate
  const icePayload = { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0, type: 'host' };
  send(ws1, { type: 'ice-candidate', candidate: icePayload });
  const ice = await waitMsg(ws2, 'ice-candidate');
  assert(ice.type === 'ice-candidate', 'ICE candidate relayed');
  assert(ice.candidate.candidate.includes('candidate:'), 'ICE candidate payload preserved');

  // Test 7: Room full (3rd peer)
  const ws3 = await connect();
  send(ws3, { type: 'join-room', code: roomCode });
  const full = await waitMsg(ws3, 'room-full');
  assert(full.type === 'room-full', 'Room correctly rejects 3rd peer');
  ws3.close();

  // Test 8: Invalid room code
  const ws4 = await connect();
  send(ws4, { type: 'join-room', code: 'BADCODE!!' });
  const err = await waitMsg(ws4, 'error');
  assert(err.message.toLowerCase().includes('invalid'), 'Invalid room code rejected with error');
  ws4.close();

  // Test 9: Ping/pong
  const ws5 = await connect();
  send(ws5, { type: 'ping' });
  const pong = await waitMsg(ws5, 'pong');
  assert(pong.type === 'pong', 'Ping gets pong response');
  ws5.close();

  // Test 10: Room not found
  const ws6 = await connect();
  send(ws6, { type: 'join-room', code: 'ZZZZZZ' });
  const notFound = await waitMsg(ws6, 'room-not-found');
  assert(notFound.type === 'room-not-found', 'Non-existent room returns room-not-found');
  ws6.close();

  // Test 11: Leave room
  send(ws1, { type: 'leave' });
  const [left, peerLeft] = await Promise.all([
    waitMsg(ws1, 'left'),
    waitMsg(ws2, 'peer-left'),
  ]);
  assert(left.type === 'left', 'Leave acknowledged');
  assert(peerLeft.type === 'peer-left', 'Other peer notified of leave');

  ws1.close();
  ws2.close();

  // ── Results ──
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('Test error:', e.message); process.exit(1); });
