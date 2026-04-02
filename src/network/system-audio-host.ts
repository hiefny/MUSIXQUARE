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

// ─── SDP: Boost Opus Bitrate ──────────────────────────────────────

function boostOpusBitrate(sdp: string): string {
  const rtpMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i);
  if (!rtpMatch) return sdp;
  const pt = rtpMatch[1];

  const fmtpRegex = new RegExp(`(a=fmtp:${pt}\\s+)(.+)`);
  const fmtpMatch = sdp.match(fmtpRegex);

  if (fmtpMatch) {
    let params = fmtpMatch[2];
    params = params.replace(/;?\s*maxaveragebitrate=\d+/g, '');
    params += ';maxaveragebitrate=128000';
    sdp = sdp.replace(fmtpRegex, `${fmtpMatch[1]}${params}`);
  }
  return sdp;
}

function patchMediaConnection(mc: MediaConnection): void {
  const pc = mc.peerConnection as RTCPeerConnection | undefined;
  if (!pc) return;

  const origSetLocal = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async (desc?: RTCLocalSessionDescriptionInit) => {
    if (desc?.sdp) desc = { ...desc, sdp: boostOpusBitrate(desc.sdp) };
    return origSetLocal(desc);
  };

  const origSetRemote = pc.setRemoteDescription.bind(pc);
  pc.setRemoteDescription = async (desc: RTCSessionDescriptionInit) => {
    if (desc.sdp) desc = { ...desc, sdp: boostOpusBitrate(desc.sdp) };
    return origSetRemote(desc);
  };
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

  try {
    // L channel call
    const mcL = peer.call(guestPeerId, streamL, {
      metadata: { type: 'system-audio', channel: 'L' },
    });
    patchMediaConnection(mcL);
    _mediaConnsL.set(guestPeerId, mcL);
    mcL.on('close', () => _mediaConnsL.delete(guestPeerId));
    mcL.on('error', () => _mediaConnsL.delete(guestPeerId));

    // R channel call
    const mcR = peer.call(guestPeerId, streamR, {
      metadata: { type: 'system-audio', channel: 'R' },
    });
    patchMediaConnection(mcR);
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

  bus.on('network:peer-disconnected', (peerId: string) => {
    const mcL = _mediaConnsL.get(peerId);
    if (mcL) { try { mcL.close(); } catch { /* noop */ } _mediaConnsL.delete(peerId); }
    const mcR = _mediaConnsR.get(peerId);
    if (mcR) { try { mcR.close(); } catch { /* noop */ } _mediaConnsR.delete(peerId); }
  });

  bus.on('system-audio:force-stop', () => closeAllMediaConns());
  bus.on('system-audio:stop', () => closeAllMediaConns());
}
