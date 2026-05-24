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

interface HostDirectCallDebug {
  at: number;
  peerId: string;
  peerLabel?: string;
  connectionType?: string;
  action: string;
  metadataType?: string;
  reason?: string;
  error?: string;
}

const _debugCalls: HostDirectCallDebug[] = [];

function errorToDebugString(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readMetadataType(metadata: MediaConnection['metadata']): string {
  const type = metadata?.type;
  return typeof type === 'string' ? type : '-';
}

function pushDebugCall(entry: Omit<HostDirectCallDebug, 'at'>): void {
  _debugCalls.push({ ...entry, at: Date.now() });
  if (_debugCalls.length > 30) _debugCalls.splice(0, _debugCalls.length - 30);
}

function shouldUseDirectMediaCall(connectionType: string | undefined): boolean {
  if (connectionType === 'local') return true;
  if (_remoteDirectFallbackEnabled && connectionType === 'remote') return true;
  return false;
}

export function getSystemAudioHostDebugSnapshot() {
  const mediaConns = [..._mediaConns.entries()].map(([peerId, conn]) => ({
    peerId,
    peerShort: peerId.slice(0, 8),
    metadataType: readMetadataType(conn.metadata),
    pcState: conn.peerConnection
      ? {
          connectionState: conn.peerConnection.connectionState,
          iceConnectionState: conn.peerConnection.iceConnectionState,
          signalingState: conn.peerConnection.signalingState,
        }
      : null,
  }));

  return {
    active: isSystemAudioActive(),
    remoteDirectFallbackEnabled: _remoteDirectFallbackEnabled,
    mediaConnCount: _mediaConns.size,
    mediaConns,
    recentCalls: _debugCalls.slice(-12),
    peerConnections: [..._mediaConns.entries()]
      .filter(
        (entry): entry is [string, MediaConnection & { peerConnection: RTCPeerConnection }] =>
          !!entry[1].peerConnection,
      )
      .map(([peerId, conn]) => ({
        label: `host:${peerId.slice(0, 8)}:${readMetadataType(conn.metadata)}`,
        pc: conn.peerConnection,
      })),
  };
}

// ─── Call Guest ───────────────────────────────────────────────────

function callGuest(guestPeerId: string): void {
  const peerObj = getState('network.connectedPeers').find((p) => p.id === guestPeerId);
  const debugBase = {
    peerId: guestPeerId,
    peerLabel: peerObj?.label,
    connectionType: peerObj?.connectionType,
  };
  const peer = getPeer();
  const streamL = getStreamL();
  const streamR = getStreamR();
  if (!peer) {
    pushDebugCall({ ...debugBase, action: 'skip', reason: 'no-peer' });
    return;
  }
  if (!streamL || !streamR) {
    pushDebugCall({ ...debugBase, action: 'skip', reason: 'missing-lr-streams' });
    return;
  }
  if (!peer.call) {
    log.warn('[SysAudioHost] Current transport does not support direct media calls');
    pushDebugCall({ ...debugBase, action: 'skip', reason: 'no-call-support' });
    return;
  }
  if (_mediaConns.has(guestPeerId)) {
    pushDebugCall({ ...debugBase, action: 'skip', reason: 'already-connected' });
    return;
  }

  // Remote peers should use the Cloudflare Realtime SFU path. Direct media calls
  // are kept for local peers and as a fallback when SFU publication fails.
  if (peerObj && !shouldUseDirectMediaCall(peerObj.connectionType)) {
    log.info(`[SysAudioHost] Skipping non-local peer ${guestPeerId.slice(0, 8)} for SFU`);
    pushDebugCall({ ...debugBase, action: 'skip', reason: 'waiting-for-sfu' });
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
      pushDebugCall({ ...debugBase, action: 'call', metadataType: 'system-audio-stereo' });
      mc.on('close', () => {
        pushDebugCall({
          ...debugBase,
          action: 'close',
          metadataType: readMetadataType(mc.metadata),
        });
        _mediaConns.delete(guestPeerId);
      });
      mc.on('error', (error: unknown) => {
        pushDebugCall({
          ...debugBase,
          action: 'error',
          metadataType: readMetadataType(mc.metadata),
          error: errorToDebugString(error),
        });
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
    pushDebugCall({ ...debugBase, action: 'call', metadataType: 'system-audio-synced' });
    mc.on('close', () => {
      pushDebugCall({
        ...debugBase,
        action: 'close',
        metadataType: readMetadataType(mc.metadata),
      });
      _mediaConns.delete(guestPeerId);
    });
    mc.on('error', (error: unknown) => {
      pushDebugCall({
        ...debugBase,
        action: 'error',
        metadataType: readMetadataType(mc.metadata),
        error: errorToDebugString(error),
      });
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
    pushDebugCall({
      ...debugBase,
      action: 'error',
      reason: 'call-threw',
      error: errorToDebugString(e),
    });
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
    if (p.conn?.open) {
      safeSend(p.conn, { type: MSG.SYSTEM_AUDIO_START });
      pushDebugCall({
        peerId: p.id,
        peerLabel: p.label,
        connectionType: p.connectionType,
        action: 'start-sent',
        reason: 'remote-fallback',
      });
    }
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
  const peer = getState('network.connectedPeers').find((p) => p.id === peerId);
  const debugBase = {
    peerId,
    peerLabel: peer?.label,
    connectionType: peer?.connectionType,
  };
  if (!isSystemAudioActive()) {
    pushDebugCall({ ...debugBase, action: 'late-skip', reason: 'inactive' });
    return;
  }
  if (getState('network.appRole') !== 'host') {
    pushDebugCall({ ...debugBase, action: 'late-skip', reason: 'not-host' });
    return;
  }
  if (_mediaConns.has(peerId)) {
    pushDebugCall({ ...debugBase, action: 'late-skip', reason: 'already-connected' });
    return;
  }
  if (peer?.conn?.open) {
    safeSend(peer.conn, { type: MSG.SYSTEM_AUDIO_START });
    pushDebugCall({ ...debugBase, action: 'start-sent', reason: 'late-peer' });
  } else {
    pushDebugCall({ ...debugBase, action: 'late-skip', reason: 'no-data-conn' });
  }
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
