// ============================================================
// ui.js – DOM helpers and UI state machine
// Never uses innerHTML with untrusted data.
// ============================================================

import { escapeHtml, formatBytes, formatSpeed, formatDuration } from './utils.js';

// ── Toast ─────────────────────────────────────────────────────
const toastContainer = document.getElementById('toast-container');
export function toast(message, type = 'info', duration = 4000) {
  if (!toastContainer) return;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const icon = { info: iconInfo(), success: iconCheck(), warning: iconWarning(), error: iconError() }[type] || iconInfo();
  el.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(el);

  requestAnimationFrame(() => el.classList.add('toast--visible'));

  setTimeout(() => {
    el.classList.remove('toast--visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}

// ── Screen transitions ────────────────────────────────────────
const screens = {
  landing: document.getElementById('screen-landing'),
  room:    document.getElementById('screen-room'),
  manual:  document.getElementById('screen-manual'),
};

export function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) {
    if (!el) continue;
    if (k === name) {
      el.classList.remove('screen--hidden');
      el.classList.add('screen--visible');
    } else {
      el.classList.remove('screen--visible');
      el.classList.add('screen--hidden');
    }
  }
}

// ── Room code display ─────────────────────────────────────────
export function setRoomCode(code) {
  const el = document.getElementById('room-code-display');
  if (el) el.textContent = code;
}

// ── Connection status pill ────────────────────────────────────
const STATUS_LABELS = {
  connecting:   'Connecting…',
  connected:    'Connected',
  reconnecting: 'Reconnecting…',
  failed:       'Connection failed',
  waiting:      'Waiting for peer…',
  new:          'Initializing…',
};
const STATUS_CLASSES = {
  connecting:   'status--connecting',
  connected:    'status--connected',
  reconnecting: 'status--reconnecting',
  failed:       'status--failed',
  waiting:      'status--waiting',
  new:          'status--connecting',
};

export function setConnectionStatus(state) {
  const pill  = document.getElementById('status-pill');
  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const srEl  = document.getElementById('status-sr');
  if (!pill) return;

  // Remove old status classes
  for (const cls of Object.values(STATUS_CLASSES)) pill.classList.remove(cls);
  pill.classList.add(STATUS_CLASSES[state] || 'status--connecting');

  if (label) label.textContent = STATUS_LABELS[state] || state;
  if (srEl)  srEl.textContent  = `Connection status: ${STATUS_LABELS[state] || state}`;
}

// ── Peer visualization line state ─────────────────────────────
let _particleTimer = null;
export function setPeerLineState(state, direction = 'send') {
  // state: 'disconnected' | 'connecting' | 'connected' | 'active' | 'reconnecting' | 'failed'
  const line = document.getElementById('peer-line');
  if (!line) return;
  line.dataset.state = state;

  const wrap = line.querySelector('.peer-line-wrap');
  if (!wrap) return;

  // Clear any existing particles and spawn interval
  wrap.querySelectorAll('.line-particle').forEach(p => p.remove());
  if (_particleTimer) {
    clearInterval(_particleTimer);
    _particleTimer = null;
  }

  if (state === 'active') {
    const spawnParticle = () => {
      if (line.dataset.state !== 'active') return;
      const p = document.createElement('div');
      p.className = `line-particle line-particle--${direction === 'recv' ? 'recv' : 'send'}`;
      wrap.appendChild(p);
      setTimeout(() => p.remove(), 1200);
    };
    spawnParticle();
    _particleTimer = setInterval(spawnParticle, 350);
  }
}

// ── Tabs ──────────────────────────────────────────────────────
export function activateTab(name) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('tab-btn--active', active);
    btn.setAttribute('aria-selected', active);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle('tab-panel--active', active);
    panel.hidden = !active;
  });
}

// ── Signaling log (Under the hood) ───────────────────────────
const logEl = document.getElementById('debug-log');
export function appendLog(message, type = 'info') {
  if (!logEl) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-entry--${type}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString();

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = message; // safe: textContent only

  entry.appendChild(time);
  entry.appendChild(msg);
  logEl.appendChild(entry);

  // Keep at most 500 entries
  while (logEl.children.length > 500) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

// ── SDP viewer ────────────────────────────────────────────────
export function setSDP(type, sdp) {
  const el = document.getElementById(`sdp-${type}`);
  if (el) el.textContent = sdp || '(none)';
}

// ── Stats panel ───────────────────────────────────────────────
export function updateStats(s) {
  setText('stat-conntype',  s.connType   || '—');
  setText('stat-local',     s.localType  || '—');
  setText('stat-remote',    s.remoteType || '—');
  setText('stat-rtt',       s.rttMs != null ? `${s.rttMs} ms` : '—');
  setText('stat-sent',      formatBytes(s.bytesSent));
  setText('stat-recv',      formatBytes(s.bytesRecv));
  setText('stat-speed-up',  formatSpeed(s.sentSpeed));
  setText('stat-speed-dn',  formatSpeed(s.recvSpeed));
  setText('stat-buffer',    formatBytes(s.bufferLevel));

  if (s.videoStats) {
    const vs = s.videoStats;
    if (vs.frameWidth && vs.frameHeight) setText('vstat-res', `${vs.frameWidth}×${vs.frameHeight}`);
    if (vs.framesPerSecond != null) setText('vstat-fps', `${Math.round(vs.framesPerSecond)} fps`);
    if (vs.bitrateKbps != null) setText('vstat-bitrate', `${vs.bitrateKbps} kbps`);
  }

  // Connection type badge colour
  const badge = document.getElementById('conn-badge');
  if (badge) {
    badge.textContent = s.connType || '—';
    badge.className = 'conn-badge ' + (
      s.connType?.includes('TURN') ? 'conn-badge--relay' :
      s.connType?.includes('STUN') ? 'conn-badge--stun'  :
      s.connType?.includes('LAN')  ? 'conn-badge--host'  : 'conn-badge--unknown'
    );
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── Transfer list ─────────────────────────────────────────────
export function addTransferItem(id, name, size, role) {
  const list = document.getElementById('transfer-list');
  if (!list) return;

  const empty = document.getElementById('transfer-empty');
  if (empty) empty.style.display = 'none';

  const item = document.createElement('div');
  item.className = 'transfer-item transfer-item--queued';
  item.id        = `xfer-${id}`;
  item.setAttribute('role', 'listitem');

  item.innerHTML = `
    <div class="xfer-icon">${role === 'send' ? iconUpload() : iconDownload()}</div>
    <div class="xfer-body">
      <div class="xfer-name"></div>
      <div class="xfer-meta">
        <span class="xfer-size"></span>
        <span class="xfer-status"></span>
      </div>
      <div class="xfer-bar-wrap"><div class="xfer-bar" style="width:0%"></div></div>
      <div class="xfer-details">
        <span class="xfer-speed"></span>
        <span class="xfer-eta"></span>
      </div>
    </div>
    <div class="xfer-actions">
      <button class="xfer-cancel-btn" aria-label="Cancel transfer" data-id="${escapeHtml(id)}">
        ${iconX()}
      </button>
      <div class="xfer-check hidden"></div>
    </div>
  `;

  // Set text safely
  item.querySelector('.xfer-name').textContent = name;
  item.querySelector('.xfer-size').textContent = formatBytes(size);
  item.querySelector('.xfer-status').textContent = 'Queued';

  list.prepend(item);
  return item;
}

export function updateTransferProgress(id, progress, speed, eta, status) {
  const item = document.getElementById(`xfer-${id}`);
  if (!item) return;
  const pct = progress * 100;
  const bar = item.querySelector('.xfer-bar');
  if (bar) bar.style.width = `${Math.min(100, pct).toFixed(1)}%`;

  const statusEl = item.querySelector('.xfer-status');
  if (statusEl) statusEl.textContent = status || `${pct.toFixed(0)}%`;

  const speedEl = item.querySelector('.xfer-speed');
  if (speedEl && speed != null) speedEl.textContent = formatSpeed(speed);

  const etaEl = item.querySelector('.xfer-eta');
  if (etaEl && eta != null) etaEl.textContent = `ETA ${formatDuration(eta)}`;
}

export function markTransferDone(id, verified) {
  const item = document.getElementById(`xfer-${id}`);
  if (!item) return;
  item.classList.remove('transfer-item--queued', 'transfer-item--sending', 'transfer-item--receiving');
  item.classList.add('transfer-item--done');
  const bar    = item.querySelector('.xfer-bar');
  if (bar) bar.style.width = '100%';
  const status = item.querySelector('.xfer-status');
  if (status) status.textContent = verified ? '✓ Verified' : 'Received';
  item.querySelector('.xfer-cancel-btn')?.remove();
  const check = item.querySelector('.xfer-check');
  if (check) {
    check.classList.remove('hidden');
    check.innerHTML = `
      <svg class="xfer-complete-svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <circle class="xfer-circle" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
        <path class="xfer-check-path" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7 12.5l3.5 3.5 6.5-7"/>
      </svg>
    `;
  }
}

export function markTransferFailed(id, reason) {
  const item = document.getElementById(`xfer-${id}`);
  if (!item) return;
  item.classList.add('transfer-item--failed');
  const status = item.querySelector('.xfer-status');
  if (status) status.textContent = reason || 'Failed';
}

export function markTransferCancelled(id) {
  const item = document.getElementById(`xfer-${id}`);
  if (!item) return;
  item.classList.add('transfer-item--cancelled');
  const status = item.querySelector('.xfer-status');
  if (status) status.textContent = 'Cancelled';
  item.querySelector('.xfer-cancel-btn')?.remove();
}

// ── Empty states ──────────────────────────────────────────────
export function setDropzoneState(active) {
  const dz = document.getElementById('dropzone');
  if (dz) dz.classList.toggle('dropzone--active', active);
}

// ── Peer avatar labels ────────────────────────────────────────
export function setPeerLabel(label) {
  const el = document.getElementById('peer-node-label');
  if (el) el.textContent = label;
}

// ── SVG icon helpers ──────────────────────────────────────────
function iconSvg(path, size = 16) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
export const iconCheck       = () => iconSvg('<polyline points="20 6 9 17 4 12"/>');
export const iconCheckCircle = () => iconSvg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>');
export const iconX           = () => iconSvg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
export const iconInfo        = () => iconSvg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>');
export const iconWarning     = () => iconSvg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>');
export const iconError       = () => iconSvg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>');
export const iconUpload      = () => iconSvg('<polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>');
export const iconDownload    = () => iconSvg('<polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/>');
