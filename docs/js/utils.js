// ============================================================
// utils.js – Shared utility functions
// ============================================================

/** Escape HTML special chars to prevent XSS */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format bytes as human-readable string */
export function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/** Format duration in seconds to m:ss or h:mm:ss */
export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format speed (bytes/s) as human-readable */
export function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + '/s';
}

/** Sanitize a filename: strip path separators and control chars */
export function sanitizeFilename(name) {
  return String(name)
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 255) || 'file';
}

/** Sleep for ms milliseconds */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Clamp a value between min and max */
export function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/** Generate a random ID string */
export function randomId(len = 8) {
  return Math.random().toString(36).slice(2, 2 + len);
}

/** Compute exponential backoff with jitter */
export function backoff(attempt, baseMs, maxMs, jitter = 0.3) {
  const exp = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const j   = exp * jitter * (Math.random() * 2 - 1);
  return Math.round(exp + j);
}

/** Throttle: call fn at most once per `ms` */
export function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
}

/** Compute SHA-256 of an ArrayBuffer using SubtleCrypto */
export async function sha256(buffer) {
  const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Convert ArrayBuffer to hex string */
export function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Check if File System Access API is available */
export function hasFSA() {
  return typeof window.showSaveFilePicker === 'function';
}

/** Check if a media API exists */
export function hasMediaDevices() {
  return !!(navigator.mediaDevices?.getUserMedia);
}

/** Smooth exponential moving average */
export class EMA {
  constructor(alpha = 0.2) { this.alpha = alpha; this.value = null; }
  update(v) {
    this.value = this.value === null ? v : this.alpha * v + (1 - this.alpha) * this.value;
    return this.value;
  }
}

/** Event emitter (tiny) */
export class EventEmitter {
  constructor() { this._listeners = new Map(); }
  on(event, fn)  {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }
  off(event, fn) { this._listeners.get(event)?.delete(fn); }
  emit(event, ...args) {
    for (const fn of (this._listeners.get(event) || [])) fn(...args);
  }
  once(event, fn) {
    const wrapper = (...args) => { fn(...args); this.off(event, wrapper); };
    this.on(event, wrapper);
  }
}
