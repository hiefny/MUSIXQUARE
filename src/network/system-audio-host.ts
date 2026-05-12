/**
 * MUSIXQUARE 4.0 — System Audio Host (Dual-Stream WebRTC)
 *
 * Sends L and R channels as separate mono MediaConnections.
 * Each stream is mono Opus (Chrome's default) — two mono = true stereo.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { setManagedTimer } from '../core/timers.ts';
import { getPeer, safeSend } from './peer-state.ts';
import {
  isSystemAudioActive,
  getStreamL,
  getStreamR,
  getCapturedAudioStream,
} from '../audio/system-capture.ts';
import type { MediaConnection } from '../types/index.ts';

import { forceStereoSdp } from './peer.ts';

// ─── SDP Munging & Track Constraints ──────────────────────────────

/**
 * Boost bitrate and disable DSP for all audio senders in the PeerConnection.
 */
function boostAudioSenders(pc: RTCPeerConnection): void {
  pc.getSenders().forEach((sender) => {
    if (sender.track?.kind === 'audio') {
      const track = sender.track;
      // 1. Disable browser noise handling on the track itself
      try {
        track
          .applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          })
          .catch(() => {
            /* noop */
          });
      } catch {
        /* noop */
      }

      // 2. Lift bitrate limit manually (128kbps per track)
      try {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 128000;
        sender.setParameters(params).catch(() => {
          /* noop */
        });
      } catch {
        /* noop */
      }
    }
  });
}

function applySdpMunge(mc: MediaConnection): void {
  const pc = mc.peerConnection;
  if (!pc) return;

  // Intercept setLocalDescription
  const originalSetLocal = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async (desc: RTCSessionDescriptionInit) => {
    if (desc && desc.sdp) {
      desc.sdp = forceStereoSdp(desc.sdp);
    }
    const result = await originalSetLocal(desc);
    // After setting local description, we can boost the senders
    boostAudioSenders(pc);
    return result;
  };
}

// ─── Module State ─────────────────────────────────────────────────

const _mediaConns = new Map<string, MediaConnection>();
let _remoteDirectFallbackEnabled = false;

function shouldUseDirectMediaCall(connectionType: string | undefined): boolean {
  if (connectionType === 'local') return true;
  if (_remoteDirectFallbackEnabled && connectionType === 'remote') return true;
  return false;
}

// ─── Call Guest ───────────────────────────────────────────────────

function callGuest(guestPeerId: string): void {
  const peer = getPeer();
  const streamL = getStreamL();
  const streamR = getStreamR();
  if (!peer || !streamL || !streamR) return;
  if (!peer.call) {
    log.warn('[SysAudioHost] Current transport does not support direct media calls');
    return;
  }
  if (_mediaConns.has(guestPeerId)) return;

  // Remote peers should use the Cloudflare Realtime SFU path. Direct media calls
  // are kept for local peers and as a fallback when SFU publication fails.
  const peers = getState('network.connectedPeers');
  const peerObj = peers.find((p) => p.id === guestPeerId);
  if (peerObj && !shouldUseDirectMediaCall(peerObj.connectionType)) {
    log.info(`[SysAudioHost] Skipping non-local peer ${guestPeerId.slice(0, 8)} for SFU`);
    return;
  }

  try {
    const capturedAudioStream = getCapturedAudioStream();
    if (capturedAudioStream) {
      const mc = peer.call(guestPeerId, capturedAudioStream, {
        metadata: { type: 'system-audio-stereo' },
      });

      applySdpMunge(mc);
      _mediaConns.set(guestPeerId, mc);
      mc.on('close', () => _mediaConns.delete(guestPeerId));
      mc.on('error', () => {
        try {
          mc.close();
        } catch {
          /* noop */
        }
        _mediaConns.delete(guestPeerId);
      });

      log.info(`[SysAudioHost] Called guest ${guestPeerId.slice(0, 8)}: original stereo stream`);
      return;
    }

    // Fallback: SYNCED DUAL-TRACK SINGLE-STREAM.
    const trackL = streamL.getAudioTracks()[0];
    const trackR = streamR.getAudioTracks()[0];

    const syncedStream = new MediaStream([trackL, trackR]);

    const mc = peer.call(guestPeerId, syncedStream, {
      metadata: {
        type: 'system-audio-synced',
        // Track ID mapping allows guest to correctly route L and R regardless of track order
        mapping: {
          [trackL.id]: 'L',
          [trackR.id]: 'R',
        },
      },
    });

    applySdpMunge(mc);
    _mediaConns.set(guestPeerId, mc);
    mc.on('close', () => _mediaConns.delete(guestPeerId));
    mc.on('error', () => {
      try {
        mc.close();
      } catch {
        /* noop */
      }
      _mediaConns.delete(guestPeerId);
    });

    log.info(
      `[SysAudioHost] Called guest ${guestPeerId.slice(0, 8)}: single-stream, dual-track (synced)`,
    );
  } catch (e) {
    log.warn(`[SysAudioHost] Call failed for ${guestPeerId}:`, e);
  }
}

function callAllGuests(): void {
  const peers = getState('network.connectedPeers');
  for (const p of peers) {
    if (p.status === 'connected' && p.id) callGuest(p.id);
  }
}

function callRemoteGuestsForFallback(): void {
  const peers = getState('network.connectedPeers');
  for (const p of peers) {
    if (p.status !== 'connected' || p.connectionType !== 'remote' || !p.id) continue;
    if (p.conn?.open) safeSend(p.conn, { type: MSG.SYSTEM_AUDIO_START });
    callGuest(p.id);
  }
}

function closeAllMediaConns(): void {
  for (const mc of _mediaConns.values()) {
    try {
      mc.close();
    } catch {
      /* noop */
    }
  }
  _mediaConns.clear();
}

function sendActiveSystemAudioToPeer(peerId: string): void {
  if (!isSystemAudioActive()) return;
  if (getState('network.appRole') !== 'host') return;
  if (_mediaConns.has(peerId)) return;
  const peer = getState('network.connectedPeers').find((p) => p.id === peerId);
  if (peer?.conn?.open) safeSend(peer.conn, { type: MSG.SYSTEM_AUDIO_START });
  callGuest(peerId);
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioHostListeners(): void {
  // L/R streams ready → call all connected guests
  bus.on('system-audio:streams-ready', () => {
    _remoteDirectFallbackEnabled = false;
    callAllGuests();
  });

  // Late-joining guest during active sharing
  bus.on('network:peer-connected', () => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;

    setManagedTimer(
      'sys-audio-late-join',
      () => {
        const peers = getState('network.connectedPeers');
        for (const p of peers) {
          if (p.status === 'connected' && p.id && !_mediaConns.has(p.id)) {
            callGuest(p.id);
          }
        }
      },
      500,
    );
  });

  // ICE type resolved on initial join → if local and system audio active, call them
  bus.on('orchestrator:peer-joined', (peerId: string) => {
    sendActiveSystemAudioToPeer(peerId);
  });

  bus.on('orchestrator:peer-data-target-ready', (peerId: string) => {
    sendActiveSystemAudioToPeer(peerId);
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    const mc = _mediaConns.get(peerId);
    if (mc) {
      try {
        mc.close();
      } catch {
        /* noop */
      }
      _mediaConns.delete(peerId);
    }
  });

  bus.on('system-audio:sfu-fallback', (reason: string) => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;
    if (_remoteDirectFallbackEnabled) return;
    _remoteDirectFallbackEnabled = true;
    log.warn(
      `[SysAudioHost] SFU unavailable; falling back to direct remote media calls: ${reason}`,
    );
    callRemoteGuestsForFallback();
  });

  bus.on('system-audio:force-stop', () => {
    _remoteDirectFallbackEnabled = false;
    closeAllMediaConns();
  });
  bus.on('system-audio:stop', () => {
    _remoteDirectFallbackEnabled = false;
    closeAllMediaConns();
  });
}
