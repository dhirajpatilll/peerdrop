// ============================================================
// peer.js – RTCPeerConnection wrapper
// Implements "perfect negotiation" pattern (polite/impolite).
// Trickle ICE with candidate queuing.
// ICE restart on disconnected/failed.
// ============================================================

import { EventEmitter } from './utils.js';
import { CONFIG } from './config.js';

export class PeerConnection extends EventEmitter {
  /**
   * @param {SignalingClient} signaling
   * @param {boolean} polite  – true for the peer who joined (not the creator)
   * @param {boolean} forceRelay – use 'relay' iceTransportPolicy
   */
  constructor(signaling, polite, forceRelay = false) {
    super();
    this._signaling       = signaling;
    this._polite          = polite;
    this._forceRelay      = forceRelay;
    this._pc              = null;
    this._makingOffer     = false;
    this._ignoreOffer     = false;
    this._pendingCandidates = [];
    this._hasRemoteDesc   = false;
    this._fileChannel     = null;
    this._controlChannel  = null;
    this._state           = 'new'; // new | connecting | connected | reconnecting | failed
    this._iceRestartTimer = null;

    this._init();
    this._listenSignaling();
  }

  // ── State ──────────────────────────────────────────────────
  get state()          { return this._state; }
  get pc()             { return this._pc; }
  get fileChannel()    { return this._fileChannel; }
  get controlChannel() { return this._controlChannel; }

  // ── Init ───────────────────────────────────────────────────
  _init() {
    const config = {
      iceServers:          CONFIG.ICE_SERVERS,
      iceTransportPolicy:  this._forceRelay ? 'relay' : 'all',
      bundlePolicy:        'max-bundle',
      rtcpMuxPolicy:       'require',
    };
    const pc = new RTCPeerConnection(config);
    this._pc             = pc;
    this._makingOffer    = false;
    this._hasRemoteDesc  = false;
    this._pendingCandidates = [];

    pc.addEventListener('negotiationneeded', async () => {
      try {
        this._makingOffer = true;
        this.emit('log', 'negotiationneeded → creating offer');
        await pc.setLocalDescription();
        this._signaling.sendOffer(pc.localDescription.sdp);
        this.emit('log', `Offer sent (${pc.localDescription.sdp.split('\n').length} lines)`);
      } catch (err) {
        this.emit('error', err);
      } finally {
        this._makingOffer = false;
      }
    });

    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        this._signaling.sendIceCandidate(candidate.toJSON());
        this.emit('log', `ICE candidate sent: ${candidate.type} ${candidate.protocol} ${candidate.address || ''}`);
      } else {
        this.emit('log', 'ICE gathering complete');
      }
    });

    pc.addEventListener('icegatheringstatechange', () => {
      this.emit('log', `ICE gathering state: ${pc.iceGatheringState}`);
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      this.emit('log', `ICE connection state: ${pc.iceConnectionState}`);
      this._handleIceState(pc.iceConnectionState);
    });

    pc.addEventListener('connectionstatechange', () => {
      this.emit('log', `Connection state: ${pc.connectionState}`);
      this._handleConnState(pc.connectionState);
    });

    pc.addEventListener('signalingstatechange', () => {
      this.emit('log', `Signaling state: ${pc.signalingState}`);
    });

    pc.addEventListener('datachannel', (evt) => {
      this._attachChannel(evt.channel);
    });

    pc.addEventListener('track', (evt) => {
      this.emit('track', evt.streams, evt.track);
    });

    // Create data channels if polite (the creator/offerer sets them up)
    // Actually in perfect negotiation the IMPOLITE peer (creator) creates channels
    if (!this._polite) {
      this._fileChannel    = this._createFileChannel(pc);
      this._controlChannel = this._createControlChannel(pc);
    }

    this._setState('connecting');
  }

  _createFileChannel(pc) {
    const ch = pc.createDataChannel('files', {
      ordered:  true,
      protocol: 'peerdrop-file',
    });
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = CONFIG.BUFFER_LOW_THRESHOLD;
    this._attachChannel(ch);
    return ch;
  }

  _createControlChannel(pc) {
    const ch = pc.createDataChannel('control', {
      ordered:  true,
      protocol: 'peerdrop-ctrl',
    });
    ch.binaryType = 'arraybuffer';
    this._attachChannel(ch);
    return ch;
  }

  _attachChannel(ch) {
    ch.addEventListener('open',    () => this.emit('channel-open',    ch.label, ch));
    ch.addEventListener('close',   () => this.emit('channel-close',   ch.label, ch));
    ch.addEventListener('error',   (e) => this.emit('channel-error',  ch.label, e));
    ch.addEventListener('message', (e) => this.emit('channel-message', ch.label, e.data));
    ch.addEventListener('bufferedamountlow', () => this.emit('buffered-amount-low', ch.label));

    if (ch.label === 'files')   this._fileChannel    = ch;
    if (ch.label === 'control') this._controlChannel = ch;
  }

  // ── Signaling event listeners ──────────────────────────────
  _listenSignaling() {
    this._signaling.on('offer',          (sdp)       => this._onOffer(sdp));
    this._signaling.on('answer',         (sdp)       => this._onAnswer(sdp));
    this._signaling.on('ice-candidate',  (candidate) => this._onIceCandidate(candidate));
    this._signaling.on('peer-left',      ()          => this._onPeerLeft());
  }

  async _onOffer(sdp) {
    const pc = this._pc;
    const offerCollides = this._makingOffer ||
      pc.signalingState !== 'stable';

    this._ignoreOffer = !this._polite && offerCollides;
    if (this._ignoreOffer) {
      this.emit('log', 'Offer collision – ignoring (impolite peer)');
      return;
    }

    this.emit('log', 'Offer received → setting remote description');
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      this._hasRemoteDesc = true;
      await this._flushCandidates();
      await pc.setLocalDescription();
      this._signaling.sendAnswer(pc.localDescription.sdp);
      this.emit('log', `Answer sent (${pc.localDescription.sdp.split('\n').length} lines)`);
    } catch (err) {
      this.emit('error', err);
    }
  }

  async _onAnswer(sdp) {
    if (this._pc.signalingState === 'stable') {
      this.emit('log', 'Answer received but already stable – ignoring');
      return;
    }
    this.emit('log', 'Answer received → setting remote description');
    try {
      await this._pc.setRemoteDescription({ type: 'answer', sdp });
      this._hasRemoteDesc = true;
      await this._flushCandidates();
    } catch (err) {
      this.emit('error', err);
    }
  }

  async _onIceCandidate(candidate) {
    if (!candidate) return;
    if (this._hasRemoteDesc) {
      try {
        await this._pc.addIceCandidate(candidate);
        this.emit('log', `ICE candidate added: ${candidate.type || ''} ${candidate.candidate?.split(' ')[7] || ''}`);
      } catch (err) {
        if (!this._ignoreOffer) this.emit('error', err);
      }
    } else {
      this._pendingCandidates.push(candidate);
      this.emit('log', 'ICE candidate queued (no remote desc yet)');
    }
  }

  async _flushCandidates() {
    while (this._pendingCandidates.length) {
      const c = this._pendingCandidates.shift();
      try {
        await this._pc.addIceCandidate(c);
        this.emit('log', `Queued ICE candidate added: ${c.type || ''}`);
      } catch (err) {
        // ignore
      }
    }
  }

  _onPeerLeft() {
    this._setState('failed');
    this.emit('peer-left');
  }

  // ── State management ───────────────────────────────────────
  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }

  _handleIceState(state) {
    if (state === 'connected' || state === 'completed') {
      clearTimeout(this._iceRestartTimer);
      this._setState('connected');
    } else if (state === 'disconnected') {
      this._setState('reconnecting');
      this._scheduleIceRestart();
    } else if (state === 'failed') {
      this._setState('failed');
      this._attemptIceRestart();
    } else if (state === 'closed') {
      this._setState('failed');
    }
  }

  _handleConnState(state) {
    if (state === 'connected')    this._setState('connected');
    else if (state === 'failed')  { this._setState('failed'); this._attemptIceRestart(); }
    else if (state === 'closed')  this._setState('failed');
  }

  _scheduleIceRestart() {
    clearTimeout(this._iceRestartTimer);
    this._iceRestartTimer = setTimeout(() => this._attemptIceRestart(), 2_000);
  }

  async _attemptIceRestart() {
    clearTimeout(this._iceRestartTimer);
    if (this._state === 'connected') return;
    this.emit('log', 'Attempting ICE restart…');
    try {
      this._makingOffer = true;
      await this._pc.setLocalDescription(await this._pc.createOffer({ iceRestart: true }));
      this._signaling.sendOffer(this._pc.localDescription.sdp);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._makingOffer = false;
    }
  }

  // ── Track management (for video streaming) ─────────────────
  addTrack(track, ...streams) {
    return this._pc.addTrack(track, ...streams);
  }

  removeTrack(sender) {
    this._pc.removeTrack(sender);
  }

  // ── Force relay toggle ────────────────────────────────────
  setForceRelay(enabled) {
    this._forceRelay = enabled;
    if (this._pc && typeof this._pc.setConfiguration === 'function') {
      try {
        this._pc.setConfiguration({
          iceServers: CONFIG.ICE_SERVERS,
          iceTransportPolicy: enabled ? 'relay' : 'all',
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
        });
        this.emit('log', `Updated iceTransportPolicy: ${enabled ? 'relay' : 'all'} → restarting ICE`);
        this._attemptIceRestart();
        return;
      } catch (e) {
        this.emit('log', `setConfiguration fallback: ${e.message}`);
      }
    }
    // Fallback
    this.destroy();
    this._init();
    this._listenSignaling();
  }

  // ── Cleanup ───────────────────────────────────────────────
  destroy() {
    clearTimeout(this._iceRestartTimer);
    this._pc?.close();
    this._pc              = null;
    this._fileChannel     = null;
    this._controlChannel  = null;
    this._hasRemoteDesc   = false;
    this._pendingCandidates = [];
  }
}
