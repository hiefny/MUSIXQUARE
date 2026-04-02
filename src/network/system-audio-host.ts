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
import { getPeer } from './peer-state.ts';
import { broadcast } from './peer-state.ts';
import { isSystemAudioActive, getStreamL, getStreamR } from '../audio/system-capture.ts';
import type { MediaConnection } from 'peerjs';

// ─── Boost Opus Bitrate via RTCRtpSender ─────────────────────────

function boostSenderBitrate(mc: MediaConnection): void {
  const pc = mc.peerConnection as RTCPeerConnection | undefined;
  if (!pc) return;

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'audio') {
          try {
            const params = sender.getParameters();
            if (params.encodings?.[0]) {
              params.encodings[0].maxBitrate = 128000;
              sender.setParameters(params).catch(() => { /* noop */ });
            }
          } catch { /* noop */ }
        }
      }
    }
  });
}

// ─── Module State ─────────────────────────────────────────────────

const _mediaConnsL = new Map<string, MediaConnection>();
const _mediaConnsR = new Map<string, MediaConnection>();

// ─── Call Guest ───────────────────────────────────────────────────

function callGuest(guestPeerId: string): void {
  const peer = getPeer();
  const streamL = getStreamL();
  const streamR = getStreamR();
  if (!peer || !streamL || !streamR) return;
  if (_mediaConnsL.has(guestPeerId)) return;

  // Block remote (TURN) peers — system audio streaming must not go through TURN
  const peers = getState('network.connectedPeers');
  const peerObj = peers.find(p => p.id === guestPeerId);
  if (peerObj && peerObj.connectionType !== 'local') {
    log.info(`[SysAudioHost] Skipping non-local peer ${guestPeerId.slice(0, 8)} (type: ${peerObj.connectionType})`);
    return;
  }

  try {
    // L channel call
    const mcL = peer.call(guestPeerId, streamL, {
      metadata: { type: 'system-audio', channel: 'L' },
    });
    boostSenderBitrate(mcL);
    _mediaConnsL.set(guestPeerId, mcL);
    mcL.on('close', () => _mediaConnsL.delete(guestPeerId));
    mcL.on('error', () => _mediaConnsL.delete(guestPeerId));

    // R channel call
    const mcR = peer.call(guestPeerId, streamR, {
      metadata: { type: 'system-audio', channel: 'R' },
    });
    boostSenderBitrate(mcR);
    _mediaConnsR.set(guestPeerId, mcR);
    mcR.on('close', () => _mediaConnsR.delete(guestPeerId));
    mcR.on('error', () => _mediaConnsR.delete(guestPeerId));

    log.info(`[SysAudioHost] Called guest ${guestPeerId.slice(0, 8)}: L+R streams`);
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

function closeAllMediaConns(): void {
  for (const mc of _mediaConnsL.values()) { try { mc.close(); } catch { /* noop */ } }
  for (const mc of _mediaConnsR.values()) { try { mc.close(); } catch { /* noop */ } }
  _mediaConnsL.clear();
  _mediaConnsR.clear();
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioHostListeners(): void {
  // L/R streams ready → call all connected guests
  bus.on('system-audio:streams-ready', () => {
    callAllGuests();
  });

  // Late-joining guest during active sharing
  bus.on('network:peer-connected', () => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;

    setTimeout(() => {
      broadcast({ type: MSG.SYSTEM_AUDIO_START });
      const peers = getState('network.connectedPeers');
      for (const p of peers) {
        if (p.status === 'connected' && p.id && !_mediaConnsL.has(p.id)) {
          callGuest(p.id);
        }
      }
    }, 500);
  });

  // ICE type resolved → if local and system audio active, call them
  bus.on('orchestrator:peer-evaluated', (peerId: string) => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;
    if (_mediaConnsL.has(peerId)) return;
    callGuest(peerId);
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    const mcL = _mediaConnsL.get(peerId);
    if (mcL) { try { mcL.close(); } catch { /* noop */ } _mediaConnsL.delete(peerId); }
    const mcR = _mediaConnsR.get(peerId);
    if (mcR) { try { mcR.close(); } catch { /* noop */ } _mediaConnsR.delete(peerId); }
  });

  bus.on('system-audio:force-stop', () => closeAllMediaConns());
  bus.on('system-audio:stop', () => closeAllMediaConns());
}
