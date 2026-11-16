// ============================================================
// stream.js – Video streaming via RTCPeerConnection tracks
// Supports: local video file (captureStream) + screen/camera
// ============================================================

import { EventEmitter } from './utils.js';

export class VideoStreamer extends EventEmitter {
  constructor(pc) {
    super();
    this._pc      = pc;
    this._senders = [];
    this._stream  = null;
    this._source  = null; // 'file' | 'screen' | 'camera'
    this._videoEl = null;
    this._ctrlCh  = null;
  }

  async streamFile(videoEl, ctrlChannel = null) {
    const capture = videoEl.captureStream || videoEl.mozCaptureStream;
    if (!capture) {
      this.emit('error', 'captureStream is not supported in this browser. Try Chrome, Edge, or use Screen Share.');
      return;
    }
    this._source  = 'file';
    this._videoEl = videoEl;
    this._ctrlCh  = ctrlChannel;
    this._stream  = capture.call(videoEl);

    // Sync play/pause/seek events with remote peer
    if (this._ctrlCh) {
      this._onPlay   = () => this._sendSync('play', videoEl.currentTime);
      this._onPause  = () => this._sendSync('pause', videoEl.currentTime);
      this._onSeeked = () => this._sendSync('seek', videoEl.currentTime);
      videoEl.addEventListener('play', this._onPlay);
      videoEl.addEventListener('pause', this._onPause);
      videoEl.addEventListener('seeked', this._onSeeked);
    }

    await this._addTracks();
    this.emit('started', 'file');
  }

  _sendSync(action, time) {
    if (this._ctrlCh?.readyState === 'open') {
      try {
        this._ctrlCh.send(JSON.stringify({ type: 'video-sync', action, time }));
      } catch {}
    }
  }

  async streamScreen() {
    try {
      this._source = 'screen';
      this._stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: true,
      });
      await this._addTracks();
      this.emit('started', 'screen');
    } catch (e) {
      this.emit('error', e.message || 'Screen capture failed');
    }
  }

  async streamCamera() {
    try {
      this._source = 'camera';
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: true, audio: true,
      });
      await this._addTracks();
      this.emit('started', 'camera');
    } catch (e) {
      this.emit('error', e.message || 'Camera access failed');
    }
  }

  async _addTracks() {
    for (const track of this._stream.getTracks()) {
      const sender = this._pc.addTrack(track, this._stream);
      this._senders.push(sender);
      track.addEventListener('ended', () => {
        this.emit('track-ended', track.kind);
        this.stop();
      });
    }
    this.emit('log', `Stream started (${this._source}): ${this._stream.getTracks().map(t => t.kind).join(', ')}`);
  }

  stop() {
    if (this._videoEl) {
      if (this._onPlay)   this._videoEl.removeEventListener('play', this._onPlay);
      if (this._onPause)  this._videoEl.removeEventListener('pause', this._onPause);
      if (this._onSeeked) this._videoEl.removeEventListener('seeked', this._onSeeked);
      this._videoEl = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    for (const sender of this._senders) {
      try { this._pc.removeTrack(sender); } catch { }
    }
    this._senders = [];
    this.emit('stopped');
  }

  mute(muted) {
    if (!this._stream) return;
    this._stream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }

  get active() { return !!this._stream; }
  get source() { return this._source; }
}
