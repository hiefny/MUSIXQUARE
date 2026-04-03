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
import { isSystemAudioActive, getStereoStream } from '../audio/system-capture.ts';
import type { MediaConnection } from 'peerjs';

import { forceStereoSdp } from './peer.ts';

// ─── SDP Munging: Force Opus Stereo ───────────────────────────────

function applySdpMunge(mc: MediaConnection): void {
  const pc = (mc as any).peerConnection as RTCPeerConnection | undefined;
  if (!pc) {
    log.warn('[SysAudioHost] No peerConnection found on MediaConnection object');
    return;
  }

  // Intercept setLocalDescription (more robust than createOffer for some PeerJS scenarios)
  const originalSetLocal = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async (desc: RTCSessionDescriptionInit) => {
    if (desc && desc.sdp) {
      desc.sdp = forceStereoSdp(desc.sdp);
    }
    return originalSetLocal(desc);
  };
}

// ─── Module State ─────────────────────────────────────────────────

const _mediaConns = new Map<string, MediaConnection>();

// ─── Call Guest ───────────────────────────────────────────────────

function callGuest(guestPeerId: string): void {
  const peer = getPeer();
  const stereoStream = getStereoStream();
  if (!peer || !stereoStream) return;
  if (_mediaConns.has(guestPeerId)) return;

  // Block remote (TURN) peers
  const peers = getState('network.connectedPeers');
  const peerObj = peers.find(p => p.id === guestPeerId);
  if (peerObj && peerObj.connectionType !== 'local') {
    log.info(`[SysAudioHost] Skipping non-local peer ${guestPeerId.slice(0, 8)}`);
    return;
  }

  try {
    const mc = peer.call(guestPeerId, stereoStream, {
      metadata: { type: 'system-audio-stereo' }, // New type for clarity
    });

    applySdpMunge(mc);
    _mediaConns.set(guestPeerId, mc);
    mc.on('close', () => _mediaConns.delete(guestPeerId));
    mc.on('error', () => _mediaConns.delete(guestPeerId));

    log.info(`[SysAudioHost] Called guest ${guestPeerId.slice(0, 8)}: single stereo stream with SDP munge`);
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
  for (const mc of _mediaConns.values()) { try { mc.close(); } catch { /* noop */ } }
  _mediaConns.clear();
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
        if (p.status === 'connected' && p.id && !_mediaConns.has(p.id)) {
          callGuest(p.id);
        }
      }
    }, 500);
  });

  // ICE type resolved → if local and system audio active, call them
  bus.on('orchestrator:peer-evaluated', (peerId: string) => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;
    if (_mediaConns.has(peerId)) return;
    callGuest(peerId);
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    const mc = _mediaConns.get(peerId);
    if (mc) { try { mc.close(); } catch { /* noop */ } _mediaConns.delete(peerId); }
  });

  bus.on('system-audio:force-stop', () => closeAllMediaConns());
  bus.on('system-audio:stop', () => closeAllMediaConns());
}
