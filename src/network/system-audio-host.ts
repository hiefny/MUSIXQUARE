/**
 * MUSIXQUARE — Standard-Room Direct System Audio Host
 *
 * Sends the original captured stereo stream on the direct path. Standard SFU
 * and PRO delivery live in separate modules.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getPeer, safeSend } from './peer-state.ts';
import { createSystemAudioStartFrame } from './system-audio-start.ts';
import { isSystemAudioActive, getCapturedAudioStream } from '../audio/system-capture.ts';
import type { MediaConnection } from '../types/index.ts';
import {
  beginSystemAudioShareDelivery,
  endSystemAudioShareDelivery,
  getFrozenSystemAudioSfuAudience,
  getSystemAudioShareDeliverySnapshot,
  getRemainingDirectSystemAudioCapacity,
  isSystemAudioDirectFailurePeer,
  promoteSystemAudioPeerDeliveryToSfu,
  releaseSystemAudioPeerDelivery,
  reserveSystemAudioFallbackDirect,
  resolveSystemAudioPeerDelivery,
} from './system-audio-delivery.ts';

import { forceStereoSdp } from './peer.ts';
import { getRoomContext, isStandardRoomRole } from '../rooms/authority.ts';

const DIRECT_CALL_CONNECT_TIMEOUT_MS = 5_000;

function directCallTimerName(peerId: string): string {
  return `sys-audio-direct-connect:${peerId}`;
}

function directPeerConnectionIsReady(pc: RTCPeerConnection): boolean {
  return (
    pc.connectionState === 'connected' ||
    pc.iceConnectionState === 'connected' ||
    pc.iceConnectionState === 'completed'
  );
}

function armDirectCallConnectTimeout(peerId: string, mediaConn: MediaConnection): void {
  const pc = mediaConn.peerConnection;
  if (!pc) return;
  const reusedConnectedPeerConnection = directPeerConnectionIsReady(pc);
  mediaConn.on('open', () => {
    if (_mediaConns.get(peerId) !== mediaConn) return;
    clearManagedTimer(directCallTimerName(peerId));
  });
  setManagedTimer(
    directCallTimerName(peerId),
    () => {
      if (_mediaConns.get(peerId) !== mediaConn) return;
      // PeerJS creates a fresh PC for media, so reaching connected proves the
      // call opened. The Cloudflare adapter reuses an already-connected data
      // PC and emits mediaConn.open only after the media answer is applied.
      if (!reusedConnectedPeerConnection && directPeerConnectionIsReady(pc)) return;
      _mediaConns.delete(peerId);
      try {
        mediaConn.close();
      } catch {
        /* noop */
      }
      handoffFailedDirectCall(peerId, 'connect-timeout');
    },
    DIRECT_CALL_CONNECT_TIMEOUT_MS,
  );
}

// ─── SDP Munging & Track Constraints ──────────────────────────────

/**
 * Boost bitrate and disable DSP for all audio senders in the PeerConnection.
 */
function boostAudioSenders(pc: RTCPeerConnection): void {
  pc.getSenders().forEach((sender) => {
    if (sender.track?.kind === 'audio') {
      const track = sender.track;
      // Preserve music dynamics instead of applying microphone-oriented DSP.
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

      // A single stereo track carries both channels, preserving the previous
      // dual-mono aggregate budget on one sender.
      try {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 256000;
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

  // The media-call adapter owns offer creation, so patch this seam to apply the
  // product SDP contract before the browser accepts the local description.
  const originalSetLocal = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async (desc: RTCSessionDescriptionInit) => {
    if (desc && desc.sdp) {
      desc.sdp = forceStereoSdp(desc.sdp);
    }
    const result = await originalSetLocal(desc);
    boostAudioSenders(pc);
    return result;
  };
}

// ─── Module State ─────────────────────────────────────────────────

const _mediaConns = new Map<string, MediaConnection>();
let _remoteDirectFallbackEnabled = false;
const _remoteFallbackPeerIds = new Set<string>();

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
    remoteFallbackPeerIds: [..._remoteFallbackPeerIds],
    delivery: getSystemAudioShareDeliverySnapshot(),
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

  // Resolve the frozen route before checking whether the current transport
  // adapter can create direct calls. Unsupported legacy overflow still needs
  // an immediate STOP to undo the room-wide START placeholder, while SFU and
  // pending peers must bypass direct-only prerequisites entirely.
  const delivery = resolveSystemAudioPeerDelivery(peerObj);
  if (delivery === 'unsupported') {
    if (peerObj?.conn?.open) safeSend(peerObj.conn, { type: MSG.SYSTEM_AUDIO_STOP });
    pushDebugCall({ ...debugBase, action: 'stop-sent', reason: 'unsupported-overflow' });
    return;
  }
  let useRemoteDirectFallback =
    _remoteDirectFallbackEnabled && _remoteFallbackPeerIds.has(guestPeerId);
  if (
    delivery === 'sfu' &&
    _remoteDirectFallbackEnabled &&
    getFrozenSystemAudioSfuAudience(guestPeerId) === 'remote' &&
    !useRemoteDirectFallback
  ) {
    if (!reserveSystemAudioFallbackDirect(guestPeerId)) {
      if (peerObj?.conn?.open) safeSend(peerObj.conn, { type: MSG.SYSTEM_AUDIO_STOP });
      pushDebugCall({ ...debugBase, action: 'stop-sent', reason: 'remote-fallback-full' });
      return;
    }
    _remoteFallbackPeerIds.add(guestPeerId);
    useRemoteDirectFallback = true;
  }
  if (delivery !== 'direct' && !useRemoteDirectFallback) {
    log.info(`[SysAudioHost] Skipping direct call for ${guestPeerId.slice(0, 8)} (${delivery})`);
    pushDebugCall({ ...debugBase, action: 'skip', reason: 'waiting-for-sfu' });
    return;
  }

  const peer = getPeer();
  const capturedAudioStream = getCapturedAudioStream();
  if (!peer) {
    handoffFailedDirectCall(guestPeerId, 'no-peer');
    pushDebugCall({ ...debugBase, action: 'error', reason: 'no-peer' });
    return;
  }
  if (!capturedAudioStream) {
    if (peerObj?.conn?.open) safeSend(peerObj.conn, { type: MSG.SYSTEM_AUDIO_STOP });
    pushDebugCall({ ...debugBase, action: 'stop-sent', reason: 'missing-captured-stream' });
    return;
  }
  if (!peer.call) {
    log.warn('[SysAudioHost] Current transport does not support direct media calls');
    handoffFailedDirectCall(guestPeerId, 'no-call-support');
    pushDebugCall({ ...debugBase, action: 'error', reason: 'no-call-support' });
    return;
  }
  if (_mediaConns.has(guestPeerId)) {
    pushDebugCall({ ...debugBase, action: 'skip', reason: 'already-connected' });
    return;
  }

  try {
    const mc = peer.call(guestPeerId, capturedAudioStream, {
      metadata: { type: 'system-audio-stereo' },
    });

    applySdpMunge(mc);
    _mediaConns.set(guestPeerId, mc);
    armDirectCallConnectTimeout(guestPeerId, mc);
    pushDebugCall({ ...debugBase, action: 'call', metadataType: 'system-audio-stereo' });
    mc.on('close', () => {
      pushDebugCall({
        ...debugBase,
        action: 'close',
        metadataType: readMetadataType(mc.metadata),
      });
      if (_mediaConns.get(guestPeerId) !== mc) return;
      clearManagedTimer(directCallTimerName(guestPeerId));
      _mediaConns.delete(guestPeerId);
      handoffFailedDirectCall(guestPeerId, 'media-connection-closed');
    });
    mc.on('error', (error: unknown) => {
      if (_mediaConns.get(guestPeerId) !== mc) return;
      clearManagedTimer(directCallTimerName(guestPeerId));
      pushDebugCall({
        ...debugBase,
        action: 'error',
        metadataType: readMetadataType(mc.metadata),
        error: errorToDebugString(error),
      });
      _mediaConns.delete(guestPeerId);
      try {
        mc.close();
      } catch {
        /* noop */
      }
      handoffFailedDirectCall(guestPeerId, errorToDebugString(error));
    });

    log.info(`[SysAudioHost] Called guest ${guestPeerId.slice(0, 8)}: original stereo stream`);
  } catch (e) {
    log.warn(`[SysAudioHost] Call failed for ${guestPeerId}:`, e);
    handoffFailedDirectCall(guestPeerId, errorToDebugString(e));
    pushDebugCall({
      ...debugBase,
      action: 'error',
      reason: 'call-threw',
      error: errorToDebugString(e),
    });
  }
}

function handoffFailedDirectCall(peerId: string, reason: string): void {
  if (!isSystemAudioActive() || !isStandardRoomRole('host')) return;
  const peer = getState('network.connectedPeers').find((item) => item.id === peerId);
  if (!peer?.conn?.open || !promoteSystemAudioPeerDeliveryToSfu(peer)) {
    if (peer?.conn?.open) safeSend(peer.conn, { type: MSG.SYSTEM_AUDIO_STOP });
    return;
  }
  _remoteFallbackPeerIds.delete(peerId);
  // STOP -> START is deliberate rolling-release compatibility. Older guests
  // do not understand the explicit handoff marker, but do reset their frozen
  // direct route at this authenticated lifecycle boundary before SFU_READY.
  safeSend(peer.conn, { type: MSG.SYSTEM_AUDIO_STOP });
  safeSend(peer.conn, createSystemAudioStartFrame());
  pushDebugCall({
    peerId,
    peerLabel: peer.label,
    connectionType: peer.connectionType,
    action: 'sfu-handoff',
    reason,
  });
  bus.emit('system-audio:sfu-peer-needed', peerId, reason);
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
    if (getRemainingDirectSystemAudioCapacity(_remoteFallbackPeerIds) <= 0) break;
    if (p.status !== 'connected' || !p.id || getFrozenSystemAudioSfuAudience(p.id) !== 'remote') {
      continue;
    }
    if (isSystemAudioDirectFailurePeer(p.id)) continue;
    if (resolveSystemAudioPeerDelivery(p) !== 'sfu') continue;
    if (!reserveSystemAudioFallbackDirect(p.id)) continue;
    _remoteFallbackPeerIds.add(p.id);
    if (p.conn?.open) {
      safeSend(p.conn, createSystemAudioStartFrame());
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
  const mediaConns = [..._mediaConns.entries()];
  _mediaConns.clear();
  _remoteFallbackPeerIds.clear();
  for (const [peerId, mc] of mediaConns) {
    clearManagedTimer(directCallTimerName(peerId));
    try {
      mc.close();
    } catch {
      /* noop */
    }
  }
}

function cleanupPeerSystemAudioRoute(peerId: string): void {
  const mc = _mediaConns.get(peerId);
  if (mc) {
    _mediaConns.delete(peerId);
    clearManagedTimer(directCallTimerName(peerId));
    try {
      mc.close();
    } catch {
      /* noop */
    }
  }
  _remoteFallbackPeerIds.delete(peerId);
  releaseSystemAudioPeerDelivery(peerId);
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
    safeSend(peer.conn, createSystemAudioStartFrame());
    pushDebugCall({ ...debugBase, action: 'start-sent', reason: 'late-peer' });
  } else {
    pushDebugCall({ ...debugBase, action: 'late-skip', reason: 'no-data-conn' });
  }
  callGuest(peerId);
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioHostListeners(): void {
  // Capture graph ready → call all connected guests.
  bus.on('system-audio:streams-ready', () => {
    if (getRoomContext().kind === 'pro') return;
    _remoteDirectFallbackEnabled = false;
    _remoteFallbackPeerIds.clear();
    beginSystemAudioShareDelivery(getState('network.connectedPeers'));
    callAllGuests();
  });

  // Late-joining guest during active sharing
  bus.on('network:peer-connected', () => {
    if (getRoomContext().kind === 'pro') return;
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
    if (getRoomContext().kind === 'pro') return;
    sendActiveSystemAudioToPeer(peerId);
  });

  bus.on('orchestrator:peer-data-target-ready', (peerId: string) => {
    if (getRoomContext().kind === 'pro') return;
    sendActiveSystemAudioToPeer(peerId);
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    cleanupPeerSystemAudioRoute(peerId);
  });

  // Same peerId, new exact DataConnection: capability and route authority do
  // not carry across. Close any media call owned by the replaced connection
  // without emitting UI leave semantics.
  bus.on('network:peer-connection-replaced', (peerId: string) => {
    cleanupPeerSystemAudioRoute(peerId);
  });

  bus.on('system-audio:sfu-fallback', (reason: string) => {
    if (getRoomContext().kind === 'pro') return;
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;
    if (_remoteDirectFallbackEnabled) return;
    const delivery = getSystemAudioShareDeliverySnapshot();
    const hasLocalSfuTargets = delivery.sfuPeerIds.some(
      (peerId) => getFrozenSystemAudioSfuAudience(peerId) === 'all',
    );
    if (hasLocalSfuTargets) {
      log.warn(
        `[SysAudioHost] SFU unavailable for a bounded large-room share; refusing direct fanout: ${reason}`,
      );
      return;
    }
    _remoteDirectFallbackEnabled = true;
    log.warn(
      `[SysAudioHost] SFU unavailable; falling back to direct remote media calls: ${reason}`,
    );
    callRemoteGuestsForFallback();
  });

  bus.on('system-audio:force-stop', () => {
    _remoteDirectFallbackEnabled = false;
    closeAllMediaConns();
    endSystemAudioShareDelivery();
  });
  bus.on('system-audio:stop', () => {
    _remoteDirectFallbackEnabled = false;
    closeAllMediaConns();
    endSystemAudioShareDelivery();
  });
}
