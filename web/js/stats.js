// ============================================================
// stats.js – RTCPeerConnection getStats() poller
// Emits connection type, RTT, throughput, candidate info.
// ============================================================

import { EventEmitter, EMA, formatBytes } from './utils.js';
import { CONFIG } from './config.js';

export class StatsCollector extends EventEmitter {
  constructor(pc) {
    super();
    this._pc         = pc;
    this._timer      = null;
    this._prevBytes  = { sent: 0, recv: 0 };
    this._prevTime   = Date.now();
    this._speedEMA   = { sent: new EMA(0.3), recv: new EMA(0.3) };
  }

  start() {
    this._timer = setInterval(() => this._poll(), CONFIG.STATS_INTERVAL_MS);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _poll() {
    if (!this._pc) return;
    try {
      const stats  = await this._pc.getStats();
      const result = this._parse(stats);
      this.emit('stats', result);
    } catch { /* ignore */ }
  }

  _parse(stats) {
    let connType       = 'unknown';
    let localType      = '—';
    let remoteType     = '—';
    let rttMs          = null;
    let bytesSent      = 0;
    let bytesRecv      = 0;
    let videoStats     = null;
    let bufferLevel    = 0;

    for (const [, r] of stats) {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        rttMs = r.currentRoundTripTime != null ? Math.round(r.currentRoundTripTime * 1000) : null;
        bytesSent = r.bytesSent || 0;
        bytesRecv = r.bytesReceived || 0;

        // Find local/remote candidate types
        const local  = stats.get(r.localCandidateId);
        const remote = stats.get(r.remoteCandidateId);
        if (local)  localType  = local.candidateType;
        if (remote) remoteType = remote.candidateType;

        if (localType === 'host' && remoteType === 'host') {
          connType = 'Direct LAN';
        } else if (localType === 'srflx' || remoteType === 'srflx') {
          connType = 'Direct (STUN)';
        } else if (localType === 'relay' || remoteType === 'relay') {
          connType = 'Relayed (TURN)';
        } else {
          connType = 'Direct';
        }
      }

      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        videoStats = {
          framesPerSecond: r.framesPerSecond,
          frameWidth:      r.frameWidth,
          frameHeight:     r.frameHeight,
          bytesReceived:   r.bytesReceived,
        };
      }

      if (r.type === 'data-channel') {
        bufferLevel += r.bufferedAmount || 0;
      }
    }

    const now  = Date.now();
    const dt   = (now - this._prevTime) / 1000;
    this._prevTime = now;

    const sentDelta  = bytesSent - this._prevBytes.sent;
    const recvDelta  = bytesRecv - this._prevBytes.recv;
    this._prevBytes  = { sent: bytesSent, recv: bytesRecv };

    const sentSpeed  = this._speedEMA.sent.update(sentDelta / dt);
    const recvSpeed  = this._speedEMA.recv.update(recvDelta / dt);

    let videoBitrate = null;
    if (videoStats) {
      if (this._prevVideoBytes != null && dt > 0) {
        const vDelta = (videoStats.bytesReceived || 0) - this._prevVideoBytes;
        videoBitrate = Math.max(0, Math.round((vDelta * 8) / (dt * 1000))); // kbps
      }
      this._prevVideoBytes = videoStats.bytesReceived || 0;
      videoStats.bitrateKbps = videoBitrate;
    }

    return {
      connType, localType, remoteType,
      rttMs,
      bytesSent, bytesRecv,
      sentSpeed: Math.max(0, sentSpeed),
      recvSpeed: Math.max(0, recvSpeed),
      videoStats,
      bufferLevel,
    };
  }
}
