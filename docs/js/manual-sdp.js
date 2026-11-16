// ============================================================
// manual-sdp.js – Serverless manual SDP copy-paste fallback
// Waits for ICE gathering to complete (non-trickle)
// ============================================================

import { EventEmitter } from './utils.js';
import { CONFIG } from './config.js';

export class ManualSDP extends EventEmitter {
  constructor(forceRelay = false) {
    super();
    this._pc          = null;
    this._polite      = false;
    this._forceRelay  = forceRelay;
    this._fileChannel = null;
    this._controlCh   = null;
  }

  async createOffer() {
    this._polite = false;
    this._init();
    this._fileChannel = this._pc.createDataChannel('files', { ordered: true });
    this._fileChannel.binaryType = 'arraybuffer';
    this._controlCh   = this._pc.createDataChannel('control', { ordered: true });
    this._attachChannels();
    await this._pc.setLocalDescription();
    // Wait for ICE gathering
    await this._waitForGathering();
    const sdp    = this._pc.localDescription.sdp;
    const offer  = btoa(unescape(encodeURIComponent(JSON.stringify({ type: 'offer', sdp }))));
    this.emit('offer-ready', offer);
    return offer;
  }

  async applyOffer(offerB64) {
    this._polite = true;
    this._init();
    const { type, sdp } = JSON.parse(decodeURIComponent(escape(atob(offerB64))));
    await this._pc.setRemoteDescription({ type, sdp });
    await this._pc.setLocalDescription();
    await this._waitForGathering();
    const answerSdp = this._pc.localDescription.sdp;
    const answer    = btoa(unescape(encodeURIComponent(JSON.stringify({ type: 'answer', sdp: answerSdp }))));
    this.emit('answer-ready', answer);
    return answer;
  }

  async applyAnswer(answerB64) {
    const { type, sdp } = JSON.parse(decodeURIComponent(escape(atob(answerB64))));
    await this._pc.setRemoteDescription({ type, sdp });
    this.emit('log', 'Manual SDP answer applied – waiting for connection');
  }

  _init() {
    this._pc = new RTCPeerConnection({
      iceServers:         CONFIG.ICE_SERVERS,
      iceTransportPolicy: this._forceRelay ? 'relay' : 'all',
    });

    this._pc.addEventListener('datachannel', (evt) => {
      const ch = evt.channel;
      if (ch.label === 'files') {
        ch.binaryType = 'arraybuffer';
        this._fileChannel = ch;
      }
      if (ch.label === 'control') this._controlCh = ch;
      ch.addEventListener('open',    () => this.emit('channel-open', ch.label, ch));
      ch.addEventListener('close',   () => this.emit('channel-close', ch.label));
      ch.addEventListener('message', (e) => this.emit('channel-message', ch.label, e.data));
      this.emit('channel', ch);
    });

    this._pc.addEventListener('connectionstatechange', () => {
      this.emit('state', this._pc.connectionState);
    });

    this._pc.addEventListener('iceconnectionstatechange', () => {
      this.emit('ice-state', this._pc.iceConnectionState);
    });

    this._pc.addEventListener('track', (evt) => {
      this.emit('track', evt.streams, evt.track);
    });
  }

  _attachChannels() {
    for (const ch of [this._fileChannel, this._controlCh]) {
      if (!ch) continue;
      ch.addEventListener('open',    () => this.emit('channel-open', ch.label, ch));
      ch.addEventListener('close',   () => this.emit('channel-close', ch.label));
      ch.addEventListener('message', (e) => this.emit('channel-message', ch.label, e.data));
    }
  }

  _waitForGathering() {
    return new Promise((resolve) => {
      if (this._pc.iceGatheringState === 'complete') { resolve(); return; }
      this._pc.addEventListener('icegatheringstatechange', function handler() {
        if (this.iceGatheringState === 'complete') {
          this.removeEventListener('icegatheringstatechange', handler);
          resolve();
        }
      });
    });
  }

  get pc()             { return this._pc; }
  get fileChannel()    { return this._fileChannel; }
  get controlChannel() { return this._controlCh; }
}
