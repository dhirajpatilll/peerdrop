// ============================================================
// main.js – Application orchestrator
// Wires signaling, peer, transfer, stream, stats, and UI.
// ============================================================

import { CONFIG }          from './config.js';
import { SignalingClient } from './signaling.js';
import { PeerConnection }  from './peer.js';
import { FileSender, FileReceiver } from './transfer.js';
import { VideoStreamer }   from './stream.js';
import { StatsCollector }  from './stats.js';
import { ManualSDP }       from './manual-sdp.js';
import {
  toast, showScreen, setRoomCode, setConnectionStatus,
  setPeerLineState, activateTab, appendLog, setSDP,
  updateStats, addTransferItem, updateTransferProgress,
  markTransferDone, markTransferFailed, markTransferCancelled,
  setDropzoneState, setPeerLabel, iconCheck,
} from './ui.js';
import { escapeHtml, formatBytes, randomId, EMA, formatSpeed, formatDuration } from './utils.js';

// ── App state ─────────────────────────────────────────────────
let signaling   = null;
let peer        = null;
let stats       = null;
let streamer    = null;
let sender      = null;
let receiver    = new FileReceiver();
let isPolite    = false;
let forceRelay  = false;
let activeRoom  = null;
let peerPresent = false;

// Transfer speed tracking
const speedEMAs = new Map();  // id → { ema: EMA, lastBytes, lastTime }

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(getSavedTheme());
  initReceiver();
  showScreen('landing');
  bindLanding();
  bindRoom();
  bindThemeToggle();
  bindHoodToggle();
  bindCopyLog();
  bindForceRelay();
  bindManualSDP();
  bindTabClose();
  bindDropzone();
  bindFileSelect();
  bindStreamTab();
  bindCodeInputs();
  bindCopyRoomCode();
  bindShareLink();
});

// ══════════════════════════════════════════════════════════════
// LANDING SCREEN
// ══════════════════════════════════════════════════════════════

function bindLanding() {
  $('btn-create')?.addEventListener('click', () => {
    startSignaling();
    signaling.on('status', (s) => { if (s === 'connected') signaling.createRoom(); });
    signaling.connect();
  });

  $('btn-join')?.addEventListener('click', () => {
    const code = getCodeFromInputs();
    if (!code || code.length !== 6) {
      shakeCodeInputs();
      toast('Enter a 6-character room code', 'warning');
      return;
    }
    startSignaling();
    signaling.on('status', (s) => {
      if (s === 'connected') signaling.joinRoom(code);
    });
    signaling.connect();
  });

  $('btn-no-server')?.addEventListener('click', () => {
    showScreen('manual');
    bindManualFlow();
  });
}

// ── Code input boxes ──────────────────────────────────────────
function bindCodeInputs() {
  const inputs = document.querySelectorAll('.code-input');
  inputs.forEach((inp, i) => {
    inp.addEventListener('input', (e) => {
      const val = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
      inp.value = val.slice(-1); // keep only last char
      if (val && i < inputs.length - 1) inputs[i + 1].focus();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1].focus();
    });
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData)
        .getData('text').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
      inputs.forEach((inp2, j) => { inp2.value = text[j] || ''; });
      if (text.length === 6) inputs[5].focus();
    });
  });
}

function getCodeFromInputs() {
  return [...document.querySelectorAll('.code-input')].map(i => i.value).join('').toUpperCase();
}

function shakeCodeInputs() {
  const wrap = $('code-input-wrap');
  if (!wrap) return;
  wrap.classList.remove('shake');
  void wrap.offsetWidth;
  wrap.classList.add('shake');
  wrap.addEventListener('animationend', () => wrap.classList.remove('shake'), { once: true });
}

// ══════════════════════════════════════════════════════════════
// SIGNALING
// ══════════════════════════════════════════════════════════════

function startSignaling() {
  if (signaling) signaling.destroy();
  signaling = new SignalingClient(CONFIG.SIGNALING_URL);

  signaling.on('status', (s) => {
    appendLog(`Signaling: ${s}`, 'system');
  });

  signaling.on('log', (msg) => appendLog(msg, 'info'));

  signaling.on('room-created', (code, peerId) => {
    activeRoom  = code;
    isPolite    = false;
    appendLog(`Room created: ${code}  (peerId: ${peerId})`, 'success');
    setRoomCode(code);
    setConnectionStatus('waiting');
    setPeerLineState('disconnected');
    showScreen('room');
    activateTab('files');
    toast(`Room ${code} created – share the code with your peer`, 'success');
    updateShareLink(code);
  });

  signaling.on('room-joined', (code, peerId, peerCount) => {
    activeRoom  = code;
    isPolite    = true;
    appendLog(`Joined room: ${code}  (peerId: ${peerId}, peers: ${peerCount})`, 'success');
    setRoomCode(code);
    setConnectionStatus('connecting');
    setPeerLineState('connecting');
    showScreen('room');
    activateTab('files');
    toast(`Joined room ${code}`, 'success');
    updateShareLink(code);
    initPeer();
  });

  signaling.on('peer-joined', (peerId) => {
    peerPresent = true;
    appendLog(`Peer joined: ${peerId}`, 'success');
    setPeerLabel('Peer');
    setConnectionStatus('connecting');
    setPeerLineState('connecting');
    toast('Peer joined! Connecting…', 'info');
    initPeer();
  });

  signaling.on('peer-left', () => {
    peerPresent = false;
    appendLog('Peer disconnected', 'warn');
    setConnectionStatus('waiting');
    setPeerLineState('disconnected');
    setPeerLabel('—');
    toast('Peer disconnected', 'warning');
    cleanupPeer();
  });

  signaling.on('room-not-found', (code) => {
    shakeCodeInputs();
    toast(`Room "${code}" not found`, 'error');
    appendLog(`Room not found: ${code}`, 'error');
  });

  signaling.on('room-full', (code) => {
    toast(`Room "${code}" is full`, 'error');
  });

  signaling.on('room-expired', () => {
    toast('Room expired', 'warning');
    showScreen('landing');
  });

  signaling.on('server-error', (msg) => {
    appendLog(`Server error: ${msg}`, 'error');
  });

  signaling.on('reconnecting', (delay, attempt) => {
    setConnectionStatus('reconnecting');
    appendLog(`Signaling reconnect in ${(delay/1000).toFixed(1)}s (attempt ${attempt})`, 'warn');
  });

  signaling.on('raw-message', (msg) => {
    // Log ICE candidate summary (not full SDP)
    if (msg.type === 'ice-candidate' && msg.candidate) {
      appendLog(`← ICE candidate: ${msg.candidate.type || 'unknown'} ${msg.candidate.protocol || ''}`, 'ice');
    }
  });
}

// ══════════════════════════════════════════════════════════════
// PEER CONNECTION
// ══════════════════════════════════════════════════════════════

function initPeer() {
  cleanupPeer();
  peer = new PeerConnection(signaling, isPolite, forceRelay);

  peer.on('log',   (msg) => appendLog(msg, 'ice'));
  peer.on('error', (err) => {
    appendLog(`WebRTC error: ${err.message || err}`, 'error');
    toast('WebRTC error – see log', 'error');
  });

  peer.on('state', (s) => {
    setConnectionStatus(s);
    setPeerLineState(s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : 'connecting');
    appendLog(`Peer state → ${s}`, 'system');
    if (s === 'connected') {
      toast('Connected!', 'success');
      startStats();
    }
  });

  peer.on('channel-open', (label, ch) => {
    appendLog(`Data channel open: ${label}`, 'success');
    setupDataChannels();
  });

  peer.on('channel-message', (label, data) => {
    if (label === 'control' && typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'transfer-cancel') {
        sender?.cancel(msg.id);
        receiver?.cancel(msg.id);
        markTransferCancelled(msg.id);
        return;
      }
      if (msg.type === 'video-sync') {
        const rv = $('remote-video');
        if (rv) {
          if (Math.abs(rv.currentTime - msg.time) > 0.5) {
            rv.currentTime = msg.time;
          }
          if (msg.action === 'play') rv.play().catch(() => {});
          else if (msg.action === 'pause') rv.pause();
        }
        return;
      }
      receiver.onControlMessage(msg);
      // Chat messages
      if (msg.type === 'chat') appendChatMessage(msg.from, msg.text, false);
    }
    if (label === 'files' && data instanceof ArrayBuffer) {
      receiver.onFileChunk(data);
    }
  });

  peer.on('track', (streams, track) => {
    appendLog(`Remote track received: ${track.kind}`, 'success');
    attachRemoteStream(streams[0] || new MediaStream([track]));
  });

  // Local description update – show SDP
  peer.pc.addEventListener('signalingstatechange', () => {
    if (peer?.pc?.localDescription)  setSDP('local',  peer.pc.localDescription.sdp);
    if (peer?.pc?.remoteDescription) setSDP('remote', peer.pc.remoteDescription.sdp);
  });
}

function setupDataChannels() {
  if (peer?.fileChannel?.readyState === 'open' && peer?.controlChannel?.readyState === 'open') {
    if (!sender) {
      sender = new FileSender(peer.fileChannel, peer.controlChannel);
      bindSenderEvents(sender);
      appendLog('Ready to send and receive files', 'success');
    }
  }
}

function initReceiver() {
  receiver = new FileReceiver();

  receiver.on('started', ({ id, name, size }) => {
    setPeerLineState('active', 'recv');
    appendLog(`Receiving: ${name} (${formatBytes(size)})`, 'info');
    addTransferItem(id, name, size, 'recv');
    const item = document.getElementById(`xfer-${id}`);
    if (item) item.classList.add('transfer-item--receiving');
    speedEMAs.set(id, { ema: new EMA(), lastBytes: 0, lastTime: Date.now() });

    // If FSA is available and file is large (> 50MB), offer one-click streaming to disk
    if (typeof window.showSaveFilePicker === 'function' && size > 50 * 1024 * 1024) {
      toast(`Large file "${name}". Click "Save to Disk" to stream directly.`, 'info', 6000);
      const actions = item?.querySelector('.xfer-actions');
      if (actions) {
        const fsaBtn = document.createElement('button');
        fsaBtn.className = 'btn-fsa-disk text-xs px-2 py-1 mr-1 text-cyan-400 border border-cyan-400/30 rounded';
        fsaBtn.textContent = 'Save to Disk';
        fsaBtn.title = 'Stream directly to disk to keep RAM low';
        fsaBtn.onclick = async () => {
          try {
            const handle = await window.showSaveFilePicker({ suggestedName: name });
            await receiver.attachFileHandle(id, handle);
            fsaBtn.remove();
            toast('Streaming directly to disk!', 'success');
          } catch (e) {
            // User cancelled picker
          }
        };
        actions.prepend(fsaBtn);
      }
    }
  });

  receiver.on('warning', ({ id, message }) => {
    toast(message, 'warning');
    appendLog(message, 'warn');
  });

  receiver.on('progress', ({ id, received, size }) => {
    const tr = speedEMAs.get(id);
    let speed = 0, eta = null;
    if (tr) {
      const now = Date.now();
      const dt  = (now - tr.lastTime) / 1000;
      if (dt > 0.2) {
        const delta = received - tr.lastBytes;
        speed = tr.ema.update(delta / dt);
        tr.lastBytes = received;
        tr.lastTime  = now;
        if (speed > 0 && size > received) eta = (size - received) / speed;
      }
    }
    const safeTotal = size || 1;
    updateTransferProgress(id, received / safeTotal, speed, eta, `${Math.min(100, (received / safeTotal) * 100).toFixed(0)}%`);
  });

  receiver.on('complete', ({ id, name, blob, fsa, verified, size }) => {
    speedEMAs.delete(id);
    markTransferDone(id, verified);
    if (!sender?._active && !receiver?.activeId) setPeerLineState('connected');
    appendLog(`Received: ${name}${verified ? ' ✓' : ''}`, 'success');
    toast(`${name} received${verified ? ' (verified)' : ''}`, 'success');
    if (!fsa && blob) {
      offerDownload(blob, name);
    }
  });

  receiver.on('cancelled', (id) => {
    speedEMAs.delete(id);
    markTransferCancelled(id);
    if (!sender?._active && !receiver?.activeId) setPeerLineState('connected');
    appendLog(`Transfer ${id} cancelled`, 'warn');
  });
}

function bindSenderEvents(sndr) {
  sndr.on('queued', ({ id, name, size }) => {
    addTransferItem(id, name, size, 'send');
    appendLog(`Queued: ${name} (${formatBytes(size)})`, 'info');
  });

  sndr.on('hashing', (id) => {
    const item = document.getElementById(`xfer-${id}`);
    if (item) item.querySelector('.xfer-status').textContent = 'Hashing…';
  });

  sndr.on('sending', ({ id, name, size }) => {
    setPeerLineState('active', 'send');
    const item = document.getElementById(`xfer-${id}`);
    if (item) item.classList.add('transfer-item--sending');
    appendLog(`Sending: ${name}`, 'info');
    speedEMAs.set(id, { ema: new EMA(), lastBytes: 0, lastTime: Date.now() });
  });

  sndr.on('progress', ({ id, chunkIndex, totalChunks }) => {
    const tr = speedEMAs.get(id);
    let speed = 0, eta = null;
    if (tr) {
      const now      = Date.now();
      const dt       = (now - tr.lastTime) / 1000;
      const bytes    = chunkIndex * CONFIG.CHUNK_SIZE;
      const total    = totalChunks * CONFIG.CHUNK_SIZE;
      if (dt > 0.2) {
        const delta = bytes - tr.lastBytes;
        speed = tr.ema.update(delta / dt);
        tr.lastBytes = bytes;
        tr.lastTime  = now;
        if (speed > 0 && total > 0) eta = (total - bytes) / speed;
      }
      updateTransferProgress(id, chunkIndex / totalChunks, speed, eta);
    }
  });

  sndr.on('done', (id) => {
    speedEMAs.delete(id);
    markTransferDone(id, false); // sender doesn't re-verify; receiver reports
    if (!sender?._active && !receiver?.activeId) setPeerLineState('connected');
    appendLog(`Sent: transfer ${id} complete`, 'success');
    toast('File sent!', 'success');
  });

  sndr.on('failed', (id, reason) => {
    speedEMAs.delete(id);
    markTransferFailed(id, reason);
    if (!sender?._active && !receiver?.activeId) setPeerLineState('connected');
    toast(`Transfer failed: ${reason}`, 'error');
  });

  sndr.on('cancelled', (id) => {
    speedEMAs.delete(id);
    markTransferCancelled(id);
    if (!sender?._active && !receiver?.activeId) setPeerLineState('connected');
  });
}

function cleanupPeer() {
  stats?.stop(); stats = null;
  peer?.destroy(); peer = null;
  sender = null;
}

// ══════════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════════

function startStats() {
  if (!peer?.pc) return;
  stats = new StatsCollector(peer.pc);
  stats.on('stats', (s) => updateStats(s));
  stats.start();
}

// ══════════════════════════════════════════════════════════════
// DROPZONE & FILE INPUT
// ══════════════════════════════════════════════════════════════

function bindDropzone() {
  const dz = $('dropzone');
  if (!dz) return;

  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    setDropzoneState(true);
  });
  dz.addEventListener('dragleave', () => setDropzoneState(false));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    setDropzoneState(false);
    if (!peer || peer.state !== 'connected') {
      toast('Not connected yet', 'warning');
      return;
    }
    sendFiles([...e.dataTransfer.files]);
  });
  dz.addEventListener('click', () => $('file-input')?.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') $('file-input')?.click();
  });
}

function bindFileSelect() {
  const inp = $('file-input');
  if (!inp) return;
  inp.addEventListener('change', () => {
    if (!peer || peer.state !== 'connected') {
      toast('Not connected yet', 'warning');
      inp.value = '';
      return;
    }
    sendFiles([...inp.files]);
    inp.value = '';
  });
}

function sendFiles(files) {
  if (!sender) {
    // Lazy-create sender if channels are open
    if (peer?.fileChannel?.readyState === 'open' && peer?.controlChannel?.readyState === 'open') {
      sender = new FileSender(peer.fileChannel, peer.controlChannel);
      bindSenderEvents(sender);
    } else {
      toast('Data channel not ready', 'warning');
      return;
    }
  }
  for (const f of files) sender.enqueue(f);
}

// Cancel button in transfer list
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.xfer-cancel-btn');
  if (!btn) return;
  const id = btn.dataset.id;
  sender?.cancel(id);
  receiver?.cancel(id, peer?.controlChannel || manualSDP?.controlChannel);
  markTransferCancelled(id);
});

// ══════════════════════════════════════════════════════════════
// DOWNLOAD helper
// ══════════════════════════════════════════════════════════════

function offerDownload(blob, name) {
  if (typeof window.showSaveFilePicker === 'function') {
    // FSA – handled during streaming for large files; for assembled blob:
    window.showSaveFilePicker({ suggestedName: name })
      .then(handle => handle.createWritable())
      .then(writable => {
        const reader = blob.stream().getReader();
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) return writable.close();
          return writable.write(value).then(pump);
        });
        return pump();
      })
      .catch(() => blobDownload(blob, name));
  } else {
    blobDownload(blob, name);
  }
}

function blobDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href    = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ══════════════════════════════════════════════════════════════
// VIDEO STREAMING TAB
// ══════════════════════════════════════════════════════════════

function bindStreamTab() {
  $('btn-stream-file')?.addEventListener('click', () => {
    $('stream-file-input')?.click();
  });

  $('stream-file-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const videoEl = $('local-video-preview');
    if (!videoEl) return;
    const url = URL.createObjectURL(file);
    videoEl.src = url;
    videoEl.style.display = 'block';
    videoEl.play().catch(() => {});
    await startStreaming('file', videoEl);
  });

  $('btn-stream-screen')?.addEventListener('click', () => startStreaming('screen'));
  $('btn-stream-camera')?.addEventListener('click', () => startStreaming('camera'));

  $('btn-stop-stream')?.addEventListener('click', () => {
    streamer?.stop();
    $('stream-status').textContent = 'Stopped';
    $('btn-stop-stream').hidden = true;
    $('btn-mute-stream').hidden = true;
  });

  $('btn-mute-stream')?.addEventListener('click', (e) => {
    const muted = e.target.dataset.muted === 'true';
    streamer?.mute(!muted);
    e.target.dataset.muted = String(!muted);
    e.target.textContent = !muted ? 'Unmute' : 'Mute';
  });

  // Remote video autoplay click overlay
  $('remote-video-play')?.addEventListener('click', () => {
    const rv = $('remote-video');
    if (rv) rv.play().catch(() => {});
    $('remote-video-play').hidden = true;
  });
}

async function startStreaming(source, videoEl) {
  if (!peer || peer.state !== 'connected') {
    toast('Not connected yet', 'warning'); return;
  }
  streamer?.stop();
  streamer = new VideoStreamer(peer.pc);

  streamer.on('started', (src) => {
    appendLog(`Streaming started: ${src}`, 'success');
    toast(`Streaming ${src}`, 'success');
    $('stream-status').textContent = `Streaming (${src})`;
    $('btn-stop-stream').hidden = false;
    $('btn-mute-stream').hidden = false;
  });

  streamer.on('stopped', () => {
    appendLog('Stream stopped', 'info');
    $('stream-status').textContent = 'Stopped';
  });

  streamer.on('error', (msg) => {
    toast(msg, 'error');
    appendLog(`Stream error: ${msg}`, 'error');
  });

  streamer.on('log', (msg) => appendLog(msg, 'info'));

  if (source === 'file')   await streamer.streamFile(videoEl, peer?.controlChannel);
  if (source === 'screen') await streamer.streamScreen();
  if (source === 'camera') await streamer.streamCamera();
}

// Toggle video stats overlay with 'S' key
window.addEventListener('keydown', (e) => {
  if (e.key === 's' || e.key === 'S') {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const overlay = $('video-stats-overlay');
    if (overlay) overlay.hidden = !overlay.hidden;
  }
});

function attachRemoteStream(stream) {
  const rv = $('remote-video');
  if (!rv) return;
  rv.srcObject = stream;
  rv.play().catch(() => {
    // Autoplay blocked – show overlay
    const overlay = $('remote-video-play');
    if (overlay) overlay.hidden = false;
    appendLog('Autoplay blocked – click to play', 'warn');
  });
  $('remote-player').style.display = 'block';
  $('live-badge').hidden = false;
}

// ══════════════════════════════════════════════════════════════
// ROOM HEADER BINDINGS
// ══════════════════════════════════════════════════════════════

function bindRoom() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}

function bindCopyRoomCode() {
  $('btn-copy-code')?.addEventListener('click', async () => {
    const code = $('room-code-display')?.textContent;
    if (!code) return;
    await copyToClipboard(code, $('btn-copy-code'));
  });
}

function bindShareLink() {
  $('btn-share-link')?.addEventListener('click', async () => {
    const url  = buildShareUrl(activeRoom);
    if (!url) return;
    await copyToClipboard(url, $('btn-share-link'), 'Link copied!');
  });
}

function updateShareLink(code) {
  const url = buildShareUrl(code);
  const el  = $('share-url');
  if (el) el.textContent = url;
}

function buildShareUrl(code) {
  if (!code) return null;
  const base = window.location.href.split('?')[0].split('#')[0];
  return `${base}?room=${code}`;
}

async function copyToClipboard(text, btn, msg) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.innerHTML;
      btn.classList.add('btn--copied');
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg><span class="text-xs">${msg || 'Copied!'}</span>`;
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove('btn--copied');
      }, 2000);
    }
    toast(msg || 'Copied to clipboard', 'success');
  } catch {
    toast('Copy failed – select manually', 'warning');
  }
}

// ══════════════════════════════════════════════════════════════
// THEME
// ══════════════════════════════════════════════════════════════

function bindThemeToggle() {
  $('btn-theme')?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const next    = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('pd-theme', next);
  });
}

function getSavedTheme() {
  const saved = localStorage.getItem('pd-theme');
  if (saved) return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('btn-theme');
  if (btn) {
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    btn.innerHTML = theme === 'dark'
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  }
}

// ══════════════════════════════════════════════════════════════
// UNDER THE HOOD
// ══════════════════════════════════════════════════════════════

function bindHoodToggle() {
  $('btn-hood')?.addEventListener('click', () => {
    const drawer = $('hood-drawer');
    if (!drawer) return;
    const open = drawer.dataset.open === 'true';
    drawer.dataset.open = open ? 'false' : 'true';
    $('btn-hood').setAttribute('aria-expanded', !open);
  });
}

function bindCopyLog() {
  $('btn-copy-log')?.addEventListener('click', async () => {
    const entries = [...document.querySelectorAll('.log-entry')]
      .map(e => `[${e.querySelector('.log-time')?.textContent}] ${e.querySelector('.log-msg')?.textContent}`)
      .join('\n');
    await copyToClipboard(entries, $('btn-copy-log'), 'Log copied!');
  });
}

// ══════════════════════════════════════════════════════════════
// FORCE RELAY TOGGLE
// ══════════════════════════════════════════════════════════════

function bindForceRelay() {
  $('toggle-relay')?.addEventListener('change', (e) => {
    forceRelay = e.target.checked;
    appendLog(`Force relay (TURN): ${forceRelay ? 'ON' : 'OFF'}`, 'system');
    toast(`Force relay ${forceRelay ? 'enabled' : 'disabled'}`, 'info');
    if (peer) {
      peer.setForceRelay(forceRelay);
    }
  });
}

// ══════════════════════════════════════════════════════════════
// MANUAL SDP FLOW
// ══════════════════════════════════════════════════════════════

let manualSDP = null;

function bindManualSDP() {
  // Handled in bindManualFlow after showScreen('manual')
}

function bindManualFlow() {
  const btnOffer  = $('manual-btn-offer');
  const btnAnswer = $('manual-btn-answer');
  const btnApply  = $('manual-btn-apply-answer');
  const btnPaste  = $('manual-btn-paste-offer');

  btnOffer?.addEventListener('click', async () => {
    manualSDP = new ManualSDP(forceRelay);
    bindManualPeer(manualSDP);
    btnOffer.disabled = true;
    btnOffer.textContent = 'Generating…';
    const offer = await manualSDP.createOffer();
    $('manual-offer-box').value = offer;
    $('manual-offer-section').hidden  = false;
    $('manual-answer-section').hidden = true;
    btnOffer.textContent = 'Offer generated';
  });

  btnPaste?.addEventListener('click', async () => {
    const offerB64 = $('manual-offer-input')?.value?.trim();
    if (!offerB64) { toast('Paste the offer string first', 'warning'); return; }
    manualSDP = new ManualSDP(forceRelay);
    bindManualPeer(manualSDP);
    btnPaste.disabled = true;
    btnPaste.textContent = 'Processing…';
    try {
      const answer = await manualSDP.applyOffer(offerB64);
      $('manual-answer-box').value = answer;
      $('manual-answer-section').hidden = false;
      btnPaste.textContent = 'Answer generated';
    } catch (e) {
      toast('Invalid offer string', 'error');
      btnPaste.disabled = false;
      btnPaste.textContent = 'Generate Answer';
    }
  });

  btnApply?.addEventListener('click', async () => {
    const answerB64 = $('manual-answer-input')?.value?.trim();
    if (!answerB64) { toast('Paste the answer string first', 'warning'); return; }
    try {
      await manualSDP.applyAnswer(answerB64);
      toast('Answer applied – connecting…', 'info');
    } catch {
      toast('Invalid answer string', 'error');
    }
  });

  // Copy buttons
  $('manual-copy-offer')?.addEventListener('click', async () => {
    await copyToClipboard($('manual-offer-box').value, $('manual-copy-offer'));
  });
  $('manual-copy-answer')?.addEventListener('click', async () => {
    await copyToClipboard($('manual-answer-box').value, $('manual-copy-answer'));
  });

  $('manual-back')?.addEventListener('click', () => {
    manualSDP = null;
    showScreen('landing');
  });
}

function bindManualPeer(msdp) {
  msdp.on('state', (s) => {
    $('manual-status').textContent = s;
    if (s === 'connected') {
      toast('Manual SDP connection established!', 'success');
      showScreen('room');
      setRoomCode('MANUAL');
      setConnectionStatus('connected');
      setPeerLineState('connected');
      activateTab('files');
      // wire up transfer via manual SDP channels
    }
  });
  msdp.on('ice-state', (s) => appendLog(`Manual ICE: ${s}`, 'ice'));
  msdp.on('log', (msg) => appendLog(msg, 'info'));

  msdp.on('channel-open', (label, ch) => {
    appendLog(`Manual channel open: ${label}`, 'success');
    if (label === 'control' || label === 'files') {
      // Wire transfers using manual channels
      if (!sender && msdp.fileChannel && msdp.controlChannel) {
        sender   = new FileSender(msdp.fileChannel, msdp.controlChannel);
        receiver = new FileReceiver();
        bindSenderEvents(sender);
        bindReceiverChannels(msdp.fileChannel, msdp.controlChannel);
      }
    }
  });

  msdp.on('channel-message', (label, data) => {
    if (label === 'control' && typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      receiver.onControlMessage(msg);
    }
    if (label === 'files' && data instanceof ArrayBuffer) {
      receiver.onFileChunk(_currentReceiverId, data);
    }
  });
}

// ══════════════════════════════════════════════════════════════
// TAB CLOSE WARNING
// ══════════════════════════════════════════════════════════════

function bindTabClose() {
  window.addEventListener('beforeunload', (e) => {
    if (sender?._active) {
      e.preventDefault();
      e.returnValue = 'A file transfer is in progress. Leave anyway?';
    }
  });
}

// ══════════════════════════════════════════════════════════════
// CHAT (control channel)
// ══════════════════════════════════════════════════════════════

$('btn-chat-send')?.addEventListener('click', sendChat);
$('chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

function sendChat() {
  const inp  = $('chat-input');
  const text = inp?.value.trim();
  if (!text) return;
  if (!peer?.controlChannel || peer.controlChannel.readyState !== 'open') {
    toast('Not connected', 'warning'); return;
  }
  const msg = { type: 'chat', from: 'You', text };
  peer.controlChannel.send(JSON.stringify(msg));
  appendChatMessage('You', text, true);
  inp.value = '';
}

function appendChatMessage(from, text, self) {
  const list = $('chat-list');
  if (!list) return;
  const el   = document.createElement('div');
  el.className = `chat-msg ${self ? 'chat-msg--self' : 'chat-msg--peer'}`;
  const name = document.createElement('span');
  name.className   = 'chat-name';
  name.textContent = from;
  const body = document.createElement('span');
  body.className   = 'chat-body';
  body.textContent = text;
  el.appendChild(name);
  el.appendChild(body);
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

// ══════════════════════════════════════════════════════════════
// URL PARAM – auto-join room from share link
// ══════════════════════════════════════════════════════════════

(function checkUrlRoom() {
  const params = new URLSearchParams(window.location.search);
  const room   = params.get('room');
  if (room && /^[A-Z2-9]{6}$/i.test(room)) {
    // Pre-fill code inputs
    const code   = room.toUpperCase();
    const inputs = document.querySelectorAll('.code-input');
    inputs.forEach((inp, i) => { inp.value = code[i] || ''; });
    // Remove param from URL
    history.replaceState({}, '', window.location.pathname);
    // Auto-trigger join after a tick
    setTimeout(() => $('btn-join')?.click(), 100);
  }
})();

// (end of main.js)
