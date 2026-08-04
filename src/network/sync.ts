/**
 * MUSIXQUARE — Sync & Latency Management
 *
 * Manages: Heartbeat, ping/pong latency, manual sync (nudge).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import {
  MSG,
  MANUAL_SYNC_OFFSET_LIMIT_SEC,
  MAX_MSG_LENGTH,
  MAX_SENDER_LABEL_LENGTH,
  PLAYBACK_STATE,
  type PlaybackActivityValue,
  type PlaybackModeValue,
} from '../core/constants.ts';
import type { ConnectedPeer, DataConnection } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import { broadcast, broadcastDeviceList } from './peer.ts';
import {
  play,
  getTrackPosition,
  adjustSync,
  setLocalManualSyncOffset,
} from '../player/transport.ts';
import { getCurrentAudioBuffer, isLocalFilePaused, setLocalFilePaused } from '../player/_state.ts';
import { detachHostPeerConnection } from './host-peer-departure.ts';
import {
  getHostNow,
  registerPing,
  processSyncPong,
  resetClockSamples,
  resetClockState,
  setIsHostClock,
} from './shared-clock.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { showToast } from '../ui/toast.ts';
import { rememberPinnedNotice } from '../chat/protocol.ts';
import { playAnnouncementSound } from '../audio/ui-sounds.ts';
import {
  getPlaybackModeActivity,
  isPlaybackActivityValue,
  isPlaybackModeFile,
  isPlaybackModeYouTube,
  isPlaybackModeValue,
  isPlaybackPendingFile,
  isPlaybackPlayingFile,
} from '../player/ownership.ts';
import {
  getRoomContext,
  isActiveStandardRoomCoordinator,
  verifyPeerCapability,
} from '../rooms/authority.ts';
import { isYouTubeZeroStartProtocolActive } from '../youtube/zero-start.ts';

let _syncPingCounter = 0;
let _needsInitialSync = false;
let _wasPlaying = false;
let _softFileDriftDirection: -1 | 0 | 1 = 0;
let _softFileDriftSamples = 0;
let _lastSoftFileResyncAt = Number.NEGATIVE_INFINITY;
// Heartbeats are transport liveness, not user-visible peer state. Keep the hot
// one-ping-per-peer path off the global immutable state tree: at the 100-peer
// room limit, cloning connectedPeers for every ping turns a linear heartbeat
// stream into quadratic allocation and wakes unrelated state subscribers.
// Keying by the live connection also prevents a reconnect that reuses a peer id
// from inheriting the previous connection's lease.
const _lastHeartbeatByConnection = new WeakMap<DataConnection, number>();

const YOUTUBE_NUDGE_APPLY_DEBOUNCE_MS = 1000;
const FILE_SYNC_END_FENCE_SEC = 0.1;
const FILE_HARD_RESYNC_DRIFT_SEC = 2;
const FILE_SOFT_RESYNC_DRIFT_SEC = 0.05;
const FILE_SOFT_RESYNC_REQUIRED_SAMPLES = 3;
const FILE_SOFT_RESYNC_COOLDOWN_MS = 10_000;

interface SyncPongPlaybackState {
  mode: PlaybackModeValue;
  activity: PlaybackActivityValue;
}

function resetSoftFileResyncState(): void {
  _softFileDriftDirection = 0;
  _softFileDriftSamples = 0;
}

function resetSyncClockRuntime(): void {
  setState('sync.lastLatencyMs', 0);
  setState('sync.latencyHistory', []);
  resetClockState();
  _syncPingCounter = 0;
  _needsInitialSync = false;
  resetSoftFileResyncState();
  _lastSoftFileResyncAt = Number.NEGATIVE_INFINITY;
  // Drop any lingering local lock-screen pause so a fresh/reconnected guest is
  // not stuck suppressing its own bootstrap resume.
  setLocalFilePaused(false);
  clearManagedTimer('sync-youtube-nudge-apply');
}

/**
 * Get the total sync offset in milliseconds.
 */
export function getTotalSyncOffsetMs(): number {
  const localOffset = getState('sync.localOffset');
  return Math.round(localOffset * 1000);
}

function getActiveManualOffsetPath(): 'sync.localOffset' | 'sync.youtubeLocalOffset' {
  return isPlaybackModeYouTube() ? 'sync.youtubeLocalOffset' : 'sync.localOffset';
}

function clampManualSyncOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MANUAL_SYNC_OFFSET_LIMIT_SEC, Math.min(MANUAL_SYNC_OFFSET_LIMIT_SEC, value));
}

function hasManualSyncEndpoint(): boolean {
  const hostConn = getState('network.hostConn');
  if (hostConn?.open) return true;
  const room = getRoomContext();
  return room.kind === 'pro' || isActiveStandardRoomCoordinator();
}

function isProCoordinatorManualSyncEndpoint(): boolean {
  const room = getRoomContext();
  return room.kind === 'pro';
}

function canApplyManualSyncAction(): boolean {
  if (!hasManualSyncEndpoint()) return false;
  if (isPlaybackModeYouTube()) {
    // A standard host owns the canonical YouTube timeline. Moving only its
    // iframe changes the native end boundary (including playlist transitions
    // that do not emit ENDED), so keep the local nudge surface fail-closed.
    // The main Sync button still performs the existing room-wide rendezvous.
    if (getRoomContext().kind === 'standard' && isActiveStandardRoomCoordinator()) return false;
    return !isYouTubeZeroStartProtocolActive();
  }
  return isPlaybackModeFile() && !!getCurrentAudioBuffer();
}

function rejectManualSyncAction(): void {
  bus.emit('sync:close-manual');
  showToast(t('toast.sync_not_ready'));
}

function scheduleYouTubeManualSyncApply(): void {
  clearManagedTimer('sync-youtube-nudge-apply');

  const hostConn = getState('network.hostConn');
  if (!hostConn?.open || !isPlaybackModeYouTube()) return;

  setManagedTimer(
    'sync-youtube-nudge-apply',
    () => {
      const currentHostConn = getState('network.hostConn');
      if (!currentHostConn?.open || !isPlaybackModeYouTube()) return;
      bus.emit('youtube:apply-manual-sync');
    },
    YOUTUBE_NUDGE_APPLY_DEBOUNCE_MS,
  );
}

function adjustYouTubeSync(val: number): void {
  const localOffset = getState('sync.youtubeLocalOffset') || 0;
  const nextOffset = clampManualSyncOffset(localOffset + val);
  if (isProCoordinatorManualSyncEndpoint()) {
    clearManagedTimer('sync-youtube-nudge-apply');
    // The iframe handler stores the offset that was actually achievable at
    // 0/duration boundaries. Do not pre-write the requested value here.
    bus.emit('youtube:set-coordinator-manual-offset', nextOffset);
    return;
  }
  setState('sync.youtubeLocalOffset', nextOffset);
  bus.emit('sync:display-update');
  scheduleYouTubeManualSyncApply();
}

// ─── Auto Sync ──────────────────────────────────────────────────────

export function handleAutoSync(): void {
  const offsetPath = getActiveManualOffsetPath();
  const isProCoordinatorYouTubeReset =
    offsetPath === 'sync.youtubeLocalOffset' &&
    isProCoordinatorManualSyncEndpoint() &&
    isPlaybackModeYouTube();
  if (isProCoordinatorYouTubeReset) {
    clearManagedTimer('sync-youtube-nudge-apply');
    bus.emit('youtube:set-coordinator-manual-offset', 0);
    showToast(t('toast.sync_reset'));
    return;
  }
  if (offsetPath === 'sync.localOffset') {
    setLocalManualSyncOffset(0);
  } else {
    setState(offsetPath, 0);
  }
  bus.emit('sync:display-update');
  showToast(t('toast.sync_reset'));
  clearManagedTimer('sync-youtube-nudge-apply');

  if (offsetPath === 'sync.youtubeLocalOffset') {
    if (hasManualSyncEndpoint() && isPlaybackModeYouTube()) {
      bus.emit('youtube:apply-manual-sync');
    }
    return;
  }

  // Cancel any pending nudge replay from a click burst — otherwise its
  // deferred play() could fire AFTER our reset replay and re-introduce
  // whatever (now-zero) offset it captured. Belt-and-suspenders: the
  // zeroing above already means that deferred play() would compute the
  // same position, but explicit cancel removes the extra round trip.
  clearManagedTimer('sync-nudge-replay');

  // Zeroing localOffset only flips the number. The audio buffer source was
  // started with a startedAt that baked in the OLD offset, so it keeps
  // playing from the offset position until a fresh play() recomputes
  // startedAt from the new (zero) offset. Without this, "Reset" just
  // changes the displayed value while the audio remains desynced, and
  // the only recovery is a host seek or pause+play.
  if (!isPlaybackPlayingFile()) return;
  play(getTrackPosition());
}

// ─── Protocol Handlers ──────────────────────────────────────────────

export function getSyncPongPlaybackState(): SyncPongPlaybackState {
  const lifecycle = getState('playback.lifecycle');
  const playback = getPlaybackModeActivity();

  // During host track switches, stopAllMedia({ silent: true }) intentionally
  // leaves playback.mode/activity at file/playing to avoid UI flicker while
  // the new file decodes and waits for autoPlayTimer. That is not audible
  // playback, so the wire view advertises the paused file shadow.
  if (isPlaybackPlayingFile(playback)) {
    if (lifecycle === PLAYBACK_STATE.PLAYING) {
      return { mode: 'file', activity: 'playing' };
    }

    return { mode: 'file', activity: 'paused' };
  }

  // Do not let a stale file lifecycle create a new wire-visible "playing"
  // state.
  if (isPlaybackPendingFile(playback)) {
    return { mode: 'file', activity: 'pending' };
  }

  return {
    mode: playback.mode,
    activity: playback.activity,
  };
}

export function isSyncPongPlayingFile(data: Record<string, unknown>): boolean {
  if (isPlaybackModeValue(data.mode) && isPlaybackActivityValue(data.activity)) {
    return isPlaybackPlayingFile({ mode: data.mode, activity: data.activity });
  }

  return false;
}

function isSyncPongTrackIdentityCurrent(data: Record<string, unknown>): boolean {
  if (getState('demo.active')) {
    const demoTrackIndex = Number(data.demoTrackIndex);
    return (
      Number.isSafeInteger(demoTrackIndex) && demoTrackIndex === getState('demo.currentTrackIndex')
    );
  }
  return data.queueItemId === getState('playlist.currentQueueItemId');
}

function createSyncPongPayload({
  pingId,
  hostTime,
  position,
  playbackState,
}: {
  pingId: unknown;
  hostTime: number;
  position: number;
  playbackState: SyncPongPlaybackState;
}): Record<string, unknown> {
  const isDemo = getState('demo.active');
  const payload: Record<string, unknown> = {
    type: MSG.SYNC_PONG,
    pingId,
    hostTime,
    position,
    mode: playbackState.mode,
    activity: playbackState.activity,
    queueItemId: isDemo ? null : getState('playlist.currentQueueItemId'),
    ...(isDemo ? { demoTrackIndex: getState('demo.currentTrackIndex') } : {}),
  };

  return payload;
}

function getSafeSyncPongPosition(isFilePlaying: boolean): number {
  if (!isFilePlaying) return 0;

  try {
    return getTrackPosition();
  } catch (error) {
    log.debug('[Sync] Failed to read track position for SYNC_PONG:', error);
    return 0;
  }
}

function getPlayableFileSyncPosition(estimatedHostPos: number): number | null {
  if (!Number.isFinite(estimatedHostPos)) return null;

  const buffer = getCurrentAudioBuffer();
  if (!buffer) return null;

  const duration = Number.isFinite(buffer.duration) ? buffer.duration : 0;
  const syncPosition = Math.max(0, estimatedHostPos);
  if (duration <= 0) return syncPosition;

  const endFence = Math.max(0, duration - FILE_SYNC_END_FENCE_SEC);
  if (syncPosition >= endFence) {
    log.debug(
      `[Sync] Ignoring file sync at ${syncPosition.toFixed(3)}s near ${duration.toFixed(3)}s end; waiting for host playback command`,
    );
    return null;
  }

  return syncPosition;
}

function maybeSoftResyncFile(syncPosition: number, localPosition: number): boolean {
  const signedDrift = syncPosition - localPosition;
  const absDrift = Math.abs(signedDrift);

  if (absDrift < FILE_SOFT_RESYNC_DRIFT_SEC) {
    resetSoftFileResyncState();
    return false;
  }

  const now = Date.now();
  if (now - _lastSoftFileResyncAt < FILE_SOFT_RESYNC_COOLDOWN_MS) {
    resetSoftFileResyncState();
    return false;
  }

  const direction: -1 | 1 = signedDrift > 0 ? 1 : -1;
  if (direction === _softFileDriftDirection) {
    _softFileDriftSamples += 1;
  } else {
    _softFileDriftDirection = direction;
    _softFileDriftSamples = 1;
  }

  if (_softFileDriftSamples < FILE_SOFT_RESYNC_REQUIRED_SAMPLES) return false;

  log.info(
    `[Sync] Soft file resync: drift=${Math.round(signedDrift * 1000)}ms, samples=${_softFileDriftSamples}`,
  );
  _lastSoftFileResyncAt = now;
  resetSoftFileResyncState();
  play(syncPosition);
  return true;
}

function handleSyncPing(data: Record<string, unknown>, conn: DataConnection): void {
  // 1. Liveness update
  try {
    if (conn?.peer) {
      const connectedPeers = getState('network.connectedPeers');
      const p = connectedPeers.find((x) => x.id === conn.peer);
      if (p) _lastHeartbeatByConnection.set(conn, Date.now());
    }
  } catch (e) {
    log.debug('[Sync] Liveness update error:', e);
  }

  // 2. Reply with SYNC_PONG including host time + playback state
  if (!conn?.open) return;
  const hostTime = Date.now(); // Capture BEFORE async import
  const playbackState = getSyncPongPlaybackState();
  const isFilePlaying = playbackState.mode === 'file' && playbackState.activity === 'playing';
  const position = getSafeSyncPongPosition(isFilePlaying);

  if (isFilePlaying) {
    if (conn.open) {
      try {
        conn.send(
          createSyncPongPayload({
            pingId: data.pingId,
            hostTime,
            position,
            playbackState,
          }),
        );
      } catch {
        /* closed */
      }
    }
  } else {
    try {
      conn.send(
        createSyncPongPayload({
          pingId: data.pingId,
          hostTime,
          position,
          playbackState,
        }),
      );
    } catch {
      /* closed */
    }
  }
}

function handleSyncPong(data: Record<string, unknown>, conn?: DataConnection): void {
  // SYNC_PONG is host's reply to a guest's SYNC_PING — host never receives
  // it on the legitimate path, and a guest only receives it from hostConn.
  // Without this guard, any non-host peer could inject a fake
  // hostTime/position which feeds processSyncPong (clock-offset poisoning)
  // and the file-mode play correction (position jump).
  // pingId matching in processSyncPong gives partial protection, but pingIds
  // are sequential and predictable, so per-handler source validation is required.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const pingId = data.pingId as number;
  const hostTime = data.hostTime as number;
  const position = data.position as number;

  // 1. Clock offset calculation (from shared-clock processSyncPong)
  const result = processSyncPong(pingId, hostTime);
  if (!result) return;

  const pongTrackKey = getState('demo.active')
    ? typeof data.demoTrackIndex === 'number' && Number.isSafeInteger(data.demoTrackIndex)
      ? `demo:${data.demoTrackIndex}`
      : null
    : typeof data.queueItemId === 'string'
      ? data.queueItemId
      : null;
  const pongTrackMatches = isSyncPongTrackIdentityCurrent(data);
  const pongPlayingFile = isSyncPongPlayingFile(data);
  bus.emit('sync:diagnostic-standard-pong', {
    trackKey: pongTrackKey,
    trackMatches: pongTrackMatches,
    playing: pongPlayingFile,
    hostTimeMs: hostTime,
    positionSeconds: position,
    rttMs: result.rtt,
    offsetMs: result.offset,
  });

  // 2. Latency history update
  const ms = result.rtt;
  const latencyHistory = getState('sync.latencyHistory');
  const updated = [...latencyHistory, ms];
  if (updated.length > 10) updated.shift();
  setState('sync.latencyHistory', updated);
  setState('sync.lastLatencyMs', Math.min(...updated));
  bus.emit('sync:latency-update', ms);

  // 3. File mode drift correction OR initial-bootstrap kickoff.
  //
  // Two scenarios reach this branch:
  //   (a) Guest is already PLAYING_AUDIO — drift correction (existing).
  //   (b) Guest just finished decoding a buffer (READY/PAUSED/IDLE) but
  //       never received an applicable MSG.PLAY. This happens on the very
  //       first remote-share download: the host had broadcast PLAY before
  //       the guest joined (or before the remote whole object finished
  //       downloading), so pendingPlayTime was either never set or was
  //       cleared. Without bootstrap, the guest sits at 0:00 until the
  //       host pauses/seeks/re-plays — exactly the "first remote download
  //       won't auto-play" symptom.
  if (!pongPlayingFile) {
    resetSoftFileResyncState();
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'skipped',
      reason: 'host-not-playing-file',
    });
    return;
  }
  if (!Number.isFinite(position)) {
    resetSoftFileResyncState();
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'skipped',
      reason: 'invalid-host-position',
    });
    return;
  }
  if (!pongTrackMatches) {
    resetSoftFileResyncState();
    log.debug('[Sync] Ignored pong for a different queue/demo item');
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'skipped',
      reason: 'track-mismatch',
    });
    return;
  }

  // A non-OP guest who locally paused (lock screen / hardware media button —
  // see media-session.ts) must not be auto-resumed by the host's SYNC_PONG
  // bootstrap/drift. Clock-offset + latency above still update so the guest
  // stays calibrated for when it resumes. Mirrors youtube/sync.ts's
  // isLocalYouTubePaused guard; cleared by the authoritative host PLAY/PAUSE
  // handlers (playback.ts) and on sync reset (resetSyncClockRuntime).
  if (isLocalFilePaused()) {
    resetSoftFileResyncState();
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'skipped',
      reason: 'local-pause',
    });
    return;
  }

  const hostElapsed = (getHostNow() - hostTime) / 1000;
  const estimatedHostPos = position + hostElapsed;

  if (!isPlaybackPlayingFile()) {
    resetSoftFileResyncState();
    const lifecycle = getState('playback.lifecycle');
    if (
      lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD ||
      lifecycle === PLAYBACK_STATE.DOWNLOADING ||
      lifecycle === PLAYBACK_STATE.DECODING
    ) {
      log.debug(`[Sync] Bootstrap skipped while ${lifecycle}; waiting for the new buffer`);
      bus.emit('sync:diagnostic-standard-decision', {
        decision: 'skipped',
        expectedPositionSeconds: estimatedHostPos,
        reason: `pipeline-${lifecycle}`,
      });
      return;
    }

    // Bootstrap: only if we have a decoded buffer. Otherwise the audio
    // engine has nothing to start, and play() would no-op (or worse,
    // race with an in-flight decode).
    const syncPosition = getPlayableFileSyncPosition(estimatedHostPos);
    if (syncPosition !== null) {
      log.info(
        `[Sync] Initial bootstrap: starting playback at host position ${syncPosition.toFixed(2)}s`,
      );
      play(syncPosition);
      _needsInitialSync = false;
      bus.emit('sync:arm-initial');
      bus.emit('sync:diagnostic-standard-decision', {
        decision: 'bootstrap',
        expectedPositionSeconds: syncPosition,
      });
    } else {
      bus.emit('sync:diagnostic-standard-decision', {
        decision: 'skipped',
        expectedPositionSeconds: estimatedHostPos,
        reason: 'no-playable-position',
      });
    }
    return;
  }

  const syncPosition = getPlayableFileSyncPosition(estimatedHostPos);
  if (syncPosition === null) {
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'skipped',
      expectedPositionSeconds: estimatedHostPos,
      reason: 'no-playable-position',
    });
    return;
  }

  // First pong after play start: unconditionally lock to host
  if (_needsInitialSync) {
    _needsInitialSync = false;
    resetSoftFileResyncState();
    const localPosition = getTrackPosition();
    play(syncPosition);
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'initial',
      expectedPositionSeconds: syncPosition,
      localPositionSeconds: localPosition,
    });
    return;
  }
  // Ongoing: hard-correct large divergence immediately; soft-correct stable
  // small drift only after repeated same-direction observations to avoid
  // chasing packet jitter with audible buffer restarts.
  const localPosition = getTrackPosition();
  const drift = Math.abs(syncPosition - localPosition);
  if (drift > FILE_HARD_RESYNC_DRIFT_SEC) {
    resetSoftFileResyncState();
    play(syncPosition);
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'hard',
      expectedPositionSeconds: syncPosition,
      localPositionSeconds: localPosition,
    });
    return;
  }
  const softResynced = maybeSoftResyncFile(syncPosition, localPosition);
  bus.emit('sync:diagnostic-standard-decision', {
    decision: softResynced ? 'soft' : 'observe',
    expectedPositionSeconds: syncPosition,
    localPositionSeconds: localPosition,
  });
}

// ─── Register Handlers ──────────────────────────────────────────────

// ─── Member Removal Handler (host-only) ─────────────────────────────────────
// Registered here instead of host.ts to avoid circular dependency
// (host.ts → protocol.ts → peer.ts → host.ts).

type RequestedKickScope = 'member' | 'physical';

function resolveRequestedKickTarget(
  data: Record<string, unknown>,
  conn: DataConnection,
  scope: RequestedKickScope,
): string | null {
  const room = getRoomContext();
  if (getState('network.hostConn') || getState('network.appRole') !== 'host') return null;
  if (room.kind === 'pro') {
    if (
      room.role !== 'coordinator' ||
      !room.coordinatorId ||
      room.epoch < 1 ||
      !room.capabilities.includes('members.manage') ||
      room.roomId !== getState('network.sessionCode')
    ) {
      return null;
    }
  }

  const senderId = conn?.peer;
  if (!senderId || !conn.open || !verifyPeerCapability(conn, 'members.manage')) return null;

  const peers = getState('network.connectedPeers');
  const activeConnections = getState('network.activeHostConnByPeerId');
  const sender = peers.find(
    (peer) =>
      peer.id === senderId &&
      peer.conn === conn &&
      peer.status === 'connected' &&
      activeConnections.get(senderId) === conn,
  );
  if (!sender) return null;

  const targetPeerId = data.targetPeerId as string;
  const coordinatorTransportId = getState('network.myId');
  if (
    targetPeerId === senderId ||
    targetPeerId === coordinatorTransportId ||
    targetPeerId === room.coordinatorId
  ) {
    return null;
  }

  const target = peers.find((peer) => peer.id === targetPeerId);
  const targetConnection = target?.conn as DataConnection | null | undefined;
  if (
    !target ||
    target.status !== 'connected' ||
    !targetConnection?.open ||
    activeConnections.get(targetPeerId) !== targetConnection
  ) {
    return null;
  }

  if (room.kind === 'standard') {
    const sameClaimedMember =
      typeof sender.memberId === 'string' &&
      sender.memberId.length > 0 &&
      sender.memberId === target.memberId;
    const sameAuthenticatedMember =
      sameClaimedMember && sender.isAuthenticated === true && target.isAuthenticated === true;

    if (scope === 'member') {
      // Member-wide removal also revokes account authority, so it must never
      // target the caller's own account or another administrator.
      if (target.isOp || sameClaimedMember) return null;
    } else {
      // Exact removal may disconnect a verified sibling connection while
      // preserving the shared account grant. Unverified identity collisions
      // fail closed, and administrators from other accounts remain protected.
      if (
        (sameClaimedMember && !sameAuthenticatedMember) ||
        (target.isOp && !sameAuthenticatedMember)
      ) {
        return null;
      }
    }
  }

  return targetPeerId;
}

function handleRequestKickDevice(data: Record<string, unknown>, conn: DataConnection): void {
  const targetPeerId = resolveRequestedKickTarget(data, conn, 'member');
  if (!targetPeerId) return;

  // The established member-level path expands authenticated targets to every
  // sibling connection and revokes account-level administrator authority.
  bus.emit('network:kick-device', targetPeerId);
}

function handleRequestKickPhysicalDevice(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  // PRO removals are server-authoritative (`/presence/kick`). Never let a
  // peer frame bypass the Worker’s owner/administrator protections and turn
  // the coordinator transport into an alternate exact-kick endpoint.
  if (getRoomContext().kind !== 'standard') return;
  const targetPeerId = resolveRequestedKickTarget(data, conn, 'physical');
  if (!targetPeerId) return;
  // Exact connection removal deliberately preserves sibling devices and the
  // member's account-level administrator grant.
  bus.emit('network:kick-physical-device', targetPeerId);
}

// ─── Chat Command Request (OP guest → Host) ─────────────────────

function handleRequestChatCommand(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host processes this

  const peerId = conn?.peer;
  if (!peerId) return;

  const peers = getState('network.connectedPeers');
  const peer = peers.find((candidate) => candidate.id === peerId && candidate.conn === conn);
  if (!peer) return;

  const command = data.command as string;
  const args = (data.args as string[]) || [];
  if (getRoomContext().kind === 'standard') {
    const capability = command === 'notice' ? 'chat.notice' : 'room.configure';
    if (!verifyPeerCapability(conn, capability)) return;
  } else if (!peer.isOp) {
    return;
  }

  switch (command) {
    case 'freeze': {
      const flag = args[0]?.toLowerCase();
      if (flag !== 'on' && flag !== 'off') return;
      const on = flag === 'on';
      setState('network.chatFrozen', on);
      broadcast({ type: on ? MSG.CHAT_FREEZE : MSG.CHAT_UNFREEZE });
      bus.emit('chat:system-message', on ? t('chat.cmd_frozen') : t('chat.cmd_unfrozen'));
      break;
    }
    case 'mute': {
      const targetArg = args[0];
      if (!targetArg) return;
      const target = _resolveTargetForHost(targetArg);
      if (!target) return;
      const current = getState('network.mutedPeers');
      setState('network.mutedPeers', new Set([...current, target.peerId]));
      broadcast({ type: MSG.CHAT_MUTE, targetId: target.peerId, targetLabel: target.label });
      bus.emit('chat:system-message', t('chat.cmd_muted', { name: target.label }));
      break;
    }
    case 'unmute': {
      const targetArg = args[0];
      if (!targetArg) return;
      const target = _resolveTargetForHost(targetArg);
      if (!target) return;
      const current = getState('network.mutedPeers');
      const next = new Set([...current]);
      next.delete(target.peerId);
      setState('network.mutedPeers', next);
      broadcast({ type: MSG.CHAT_UNMUTE, targetId: target.peerId, targetLabel: target.label });
      bus.emit('chat:system-message', t('chat.cmd_unmuted', { name: target.label }));
      break;
    }
    case 'clear':
      broadcast({ type: MSG.CHAT_CLEAR });
      bus.emit('chat:clear-all');
      break;
    case 'slowmode': {
      const sec = parseInt(args[0] || '0', 10);
      if (isNaN(sec) || sec < 0 || sec > 60) return;
      setState('network.slowmodeSeconds', sec);
      broadcast({ type: MSG.CHAT_SLOWMODE, seconds: sec });
      bus.emit(
        'chat:system-message',
        sec > 0 ? t('chat.cmd_slowmode_on', { sec }) : t('chat.cmd_slowmode_off'),
      );
      break;
    }
    case 'filter': {
      const on = args[0]?.toLowerCase() === 'on';
      setState('network.filterEnabled', on);
      broadcast({ type: MSG.CHAT_FILTER, on });
      bus.emit('chat:system-message', on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off'));
      break;
    }
    case 'notice': {
      // Cap length before broadcast so an OP can't amplify a 10MB arg to N peers.
      const text = args.join(' ').trim().slice(0, MAX_MSG_LENGTH);
      if (!text) return;
      const peerLabel = (peer.label || 'OP').substring(0, MAX_SENDER_LABEL_LENGTH);
      const noticePayload = {
        type: MSG.CHAT_NOTICE,
        senderLabel: peerLabel,
        text,
        ts: Date.now(),
        attention: true,
      };
      rememberPinnedNotice(noticePayload);
      broadcast(noticePayload);
      bus.emit('chat:notice-message', peerLabel, text, noticePayload.ts);
      playAnnouncementSound();
      break;
    }
    default:
      log.warn(`[Sync] Unknown chat command from OP: ${command}`);
  }
}

function _resolveTargetForHost(arg: string): { peerId: string; label: string } | null {
  const peers = getState('network.connectedPeers');
  if (arg.startsWith('#')) {
    const order = parseInt(arg.slice(1), 10);
    if (!isNaN(order)) {
      const p = peers.find((peer) => peer.joinOrder === order);
      if (p) return { peerId: p.id, label: p.label };
    }
    return null;
  }
  const lower = arg.toLowerCase();
  const p = peers.find((peer) => peer.label.toLowerCase() === lower);
  if (p) return { peerId: p.id, label: p.label };
  return null;
}

export function initSync(): void {
  resetSoftFileResyncState();
  _lastSoftFileResyncAt = Number.NEGATIVE_INFINITY;

  registerHandlers({
    [MSG.SYNC_PING]: handleSyncPing,
    [MSG.SYNC_PONG]: handleSyncPong,
    [MSG.REQUEST_KICK_DEVICE]: handleRequestKickDevice,
    [MSG.REQUEST_KICK_PHYSICAL_DEVICE]: handleRequestKickPhysicalDevice,
    [MSG.REQUEST_CHAT_COMMAND]: handleRequestChatCommand,
  });

  // SharedClock role management
  bus.on('state:network.appRole', () => {
    const role = getState('network.appRole');
    setIsHostClock(role === 'host');
    if (role !== 'host' && role !== 'guest') resetClockState();
  });

  bus.on('state:network.hostConn', () => {
    if (getState('network.appRole') !== 'guest') return;
    resetSyncClockRuntime();
  });

  // Guest: arm initial sync 1s after any play command (audio engine stable by then)
  const armInitialSync = () => {
    setManagedTimer(
      'initial-sync-arm',
      () => {
        _needsInitialSync = true;
      },
      1000,
    );
  };

  // Playback state transitions: arm on IDLE/PAUSED → PLAYING, disarm on pause/stop
  const syncInitialArmFromPlayback = () => {
    const isPlaying = isPlaybackPlayingFile();
    if (isPlaying && !_wasPlaying) {
      armInitialSync();
    }
    if (!isPlaying) {
      clearManagedTimer('initial-sync-arm');
      _needsInitialSync = false;
    }
    _wasPlaying = isPlaying;
  };
  bus.on('state:playback.mode', syncInitialArmFromPlayback);
  bus.on('state:playback.activity', syncInitialArmFromPlayback);

  // Host seek/play while already playing (mode/activity may not change)
  bus.on('sync:arm-initial', armInitialSync);

  // Clean up sync state when session ends
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      resetSyncClockRuntime();
      _wasPlaying = false;
    }
  });

  // Bus event handlers for UI-triggered sync actions
  bus.on('sync:nudge', (ms) => {
    if (!Number.isFinite(ms)) return;
    if (!canApplyManualSyncAction()) {
      rejectManualSyncAction();
      return;
    }
    if (isPlaybackModeYouTube()) {
      adjustYouTubeSync(ms / 1000);
      return;
    }
    adjustSync(ms / 1000);
  });

  bus.on('sync:auto-sync', () => {
    if (!canApplyManualSyncAction()) {
      rejectManualSyncAction();
      return;
    }
    handleAutoSync();
  });

  // Fire an out-of-band SYNC_PING immediately. Used by remote-share's
  // first-load bootstrap path so the SYNC_PONG response can kickstart
  // playback at the host's current position before the next 1s worker
  // tick. Without this, a fresh remote guest who finished decoding
  // AFTER the host's MSG.PLAY had already fired would wait up to 1s
  // before bootstrap fires.
  bus.on('sync:request-immediate-ping', () => {
    const hostConn = getState('network.hostConn');
    if (!hostConn || !hostConn.open) return;
    const pingId = ++_syncPingCounter;
    registerPing(pingId);
    try {
      hostConn.send({ type: MSG.SYNC_PING, pingId, guestTime: Date.now() });
    } catch {
      /* noop */
    }
  });

  // Long background resume recovery: force the next valid SYNC_PONG to
  // re-lock local-file playback even when drift is under the normal 2s
  // correction threshold.
  bus.on('sync:force-resync', () => {
    const hostConn = getState('network.hostConn');
    if (!hostConn?.open) return;
    resetClockSamples();
    _needsInitialSync = true;
    bus.emit('sync:request-immediate-ping');
  });

  // sync:display-update handler is in player-controls.ts (UI module) to maintain
  // network → UI separation. This module only emits the event.

  // Worker tick handler: Guest sends unified SYNC_PING to host
  bus.on('worker:timer-tick', (id) => {
    bus.emit('sync:diagnostic-worker-tick', id);
    const hostConn = getState('network.hostConn');
    if (!hostConn || !hostConn.open) return;

    if (id === 'sync') {
      const pingId = ++_syncPingCounter;
      registerPing(pingId);
      try {
        hostConn.send({ type: MSG.SYNC_PING, pingId, guestTime: Date.now() });
      } catch {
        /* noop */
      }
    }
  });

  // ── Host: Start heartbeat monitor when session starts ──
  bus.on('state:setup.sessionStarted', (started) => {
    if (started) startHeartbeatMonitor();
    else stopHeartbeatMonitor();
  });

  log.info('[Sync] Handlers registered');
}

// ─── Host: Heartbeat Monitor ──────────────────────────────────────
// Checks every 5s for peers whose lastHeartbeat is older than threshold.
// Marks them as disconnected and cleans up.

const HEARTBEAT_STALE_THRESHOLD = 8000; // 8s without heartbeat = stale
const HEARTBEAT_CHECK_INTERVAL = 5000; // check every 5s
// Browser/worker timers may be suspended while a mobile guest is backgrounded.
// A still-open RTC transport is stronger liveness evidence than the absence of
// an application heartbeat, so retain it through a bounded background grace.
// Truly dead/unknown transports keep the short stale threshold so abandoned
// slots cannot consume room capacity indefinitely.
const HEARTBEAT_LIVE_TRANSPORT_GRACE = 90_000;
const HEARTBEAT_RECOVERING_TRANSPORT_GRACE = 30_000;

function heartbeatTransportGrace(conn: DataConnection | undefined): number {
  if (!conn?.open) return HEARTBEAT_STALE_THRESHOLD;

  const pcState = conn.peerConnection?.connectionState;
  const dataState = conn.dataChannel?.readyState;
  const controlState = conn.controlChannel?.readyState;
  if (
    pcState === 'closed' ||
    pcState === 'failed' ||
    dataState === 'closed' ||
    controlState === 'closed'
  ) {
    return HEARTBEAT_STALE_THRESHOLD;
  }

  if (
    pcState === 'connected' &&
    (dataState === undefined || dataState === 'open') &&
    (controlState === undefined || controlState === 'open')
  ) {
    return HEARTBEAT_LIVE_TRANSPORT_GRACE;
  }

  if (pcState === 'disconnected' || pcState === 'connecting' || pcState === 'new') {
    return HEARTBEAT_RECOVERING_TRANSPORT_GRACE;
  }

  return HEARTBEAT_STALE_THRESHOLD;
}

function startHeartbeatMonitor(): void {
  stopHeartbeatMonitor();
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host monitors

  setManagedTimer(
    'heartbeat-monitor',
    () => {
      const hc = getState('network.hostConn');
      if (hc) {
        stopHeartbeatMonitor();
        return;
      } // No longer host

      const now = Date.now();
      const connectedPeers = getState('network.connectedPeers');
      const stalePeers: ConnectedPeer[] = [];

      for (const p of connectedPeers) {
        if (p.status !== 'connected') continue;
        const conn = p.conn as DataConnection | undefined;
        const lastHeartbeat =
          (conn ? _lastHeartbeatByConnection.get(conn) : undefined) ??
          ((p.lastHeartbeat as number) || 0);
        const elapsed = now - lastHeartbeat;
        const staleThreshold = heartbeatTransportGrace(conn);
        if (elapsed > staleThreshold) {
          log.warn(
            `[Heartbeat] Peer ${p.label || p.id} stale (${(elapsed / 1000).toFixed(1)}s; transport=${conn?.peerConnection?.connectionState ?? 'unknown'}) — marking disconnected`,
          );
          stalePeers.push(p);
        }
      }

      if (stalePeers.length > 0) {
        const departures = stalePeers
          .map((peer) =>
            detachHostPeerConnection(peer.id, peer.conn as DataConnection | null | undefined),
          )
          .filter((departure) => departure !== null);

        // Fence stale connections out of host state before physically closing
        // them. Some Chromium builds emit a synchronous RTCDataChannel error
        // from close(); host.ts must see that connection as stale and ignore it.
        for (const departure of departures) {
          try {
            departure.connection?.close();
          } catch {
            /* noop */
          }
        }

        for (const departure of departures) {
          bus.emit('network:peer-disconnected', departure.peer.id);
        }
        if (departures.length > 0) broadcastDeviceList();
      }
    },
    HEARTBEAT_CHECK_INTERVAL,
    { interval: true },
  );

  log.info('[Heartbeat] Monitor started');
}

function stopHeartbeatMonitor(): void {
  clearManagedTimer('heartbeat-monitor');
}
