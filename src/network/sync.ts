/**
 * MUSIXQUARE — Sync & Latency Management
 *
 * Owns host-relative clock measurement, manual sync, file drift correction,
 * and sync protocol frames. Participant administration and transport-liveness
 * cleanup live in room-control.ts and heartbeat-monitor.ts respectively.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import {
  MSG,
  MANUAL_SYNC_OFFSET_LIMIT_SEC,
  PLAYBACK_STATE,
  type PlaybackActivityValue,
  type PlaybackModeValue,
} from '../core/constants.ts';
import type { DataConnection } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import {
  play,
  getTrackPosition,
  adjustSync,
  setLocalManualSyncOffset,
} from '../player/transport.ts';
import { getCurrentAudioBuffer, isLocalFilePaused, setLocalFilePaused } from '../player/_state.ts';
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
import {
  getPlaybackModeActivity,
  isPlaybackActivityValue,
  isPlaybackModeFile,
  isPlaybackModeYouTube,
  isPlaybackModeValue,
  isPlaybackPendingFile,
  isPlaybackPlayingFile,
} from '../player/ownership.ts';
import { getRoomContext, isActiveStandardRoomCoordinator } from '../rooms/authority.ts';
import { isYouTubeZeroStartProtocolActive } from '../youtube/zero-start.ts';
import { initRoomControl, resolveRoomControlKickTarget } from './room-control.ts';
import { initHeartbeatMonitor, recordPeerHeartbeat } from './heartbeat-monitor.ts';

let syncPingCounter = 0;
let needsInitialSync = false;
let wasPlaying = false;
let softFileDriftDirection: -1 | 0 | 1 = 0;
let softFileDriftSamples = 0;
let lastSoftFileResyncAt = Number.NEGATIVE_INFINITY;

const YOUTUBE_NUDGE_APPLY_DEBOUNCE_MS = 1_000;
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
  softFileDriftDirection = 0;
  softFileDriftSamples = 0;
}

function resetSyncClockRuntime(): void {
  setState('sync.lastLatencyMs', 0);
  setState('sync.latencyHistory', []);
  resetClockState();
  syncPingCounter = 0;
  needsInitialSync = false;
  resetSoftFileResyncState();
  lastSoftFileResyncAt = Number.NEGATIVE_INFINITY;
  // Drop any lingering local lock-screen pause so a fresh/reconnected guest is
  // not stuck suppressing its own bootstrap resume.
  setLocalFilePaused(false);
  clearManagedTimer('sync-youtube-nudge-apply');
}

/** Get the current local manual-sync offset in milliseconds. */
export function getTotalSyncOffsetMs(): number {
  return Math.round(getState('sync.localOffset') * 1_000);
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
  return getRoomContext().kind === 'pro';
}

function canApplyManualSyncAction(): boolean {
  if (!hasManualSyncEndpoint()) return false;
  if (isPlaybackModeYouTube()) {
    // A standard host owns the canonical YouTube timeline. Moving only its
    // iframe changes the native end boundary, so keep local nudge fail-closed.
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

function adjustYouTubeSync(value: number): void {
  const localOffset = getState('sync.youtubeLocalOffset') || 0;
  const nextOffset = clampManualSyncOffset(localOffset + value);
  if (isProCoordinatorManualSyncEndpoint()) {
    clearManagedTimer('sync-youtube-nudge-apply');
    // The iframe handler stores the offset that was actually achievable at
    // zero/duration boundaries. Do not pre-write the requested value here.
    bus.emit('youtube:set-coordinator-manual-offset', nextOffset);
    return;
  }

  setState('sync.youtubeLocalOffset', nextOffset);
  bus.emit('sync:display-update');
  scheduleYouTubeManualSyncApply();
}

// ─── Manual reset ───────────────────────────────────────────────────

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

  clearManagedTimer('sync-nudge-replay');

  // The current AudioBufferSourceNode baked the previous offset into startedAt.
  // Restart at the current canonical position so zeroing the value changes the
  // audible timeline, not only the displayed number.
  if (isPlaybackPlayingFile()) play(getTrackPosition());
}

// ─── Protocol payloads ──────────────────────────────────────────────

export function getSyncPongPlaybackState(): SyncPongPlaybackState {
  const lifecycle = getState('playback.lifecycle');
  const playback = getPlaybackModeActivity();

  // During host track switches, stopAllMedia({ silent: true }) intentionally
  // leaves file/playing projected to avoid UI flicker. It is not yet audible,
  // so advertise a paused file shadow.
  if (isPlaybackPlayingFile(playback)) {
    return lifecycle === PLAYBACK_STATE.PLAYING
      ? { mode: 'file', activity: 'playing' }
      : { mode: 'file', activity: 'paused' };
  }

  if (isPlaybackPendingFile(playback)) {
    return { mode: 'file', activity: 'pending' };
  }

  return {
    mode: playback.mode,
    activity: playback.activity,
  };
}

export function isSyncPongPlayingFile(data: Record<string, unknown>): boolean {
  return (
    isPlaybackModeValue(data.mode) &&
    isPlaybackActivityValue(data.activity) &&
    isPlaybackPlayingFile({ mode: data.mode, activity: data.activity })
  );
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
  return {
    type: MSG.SYNC_PONG,
    pingId,
    hostTime,
    position,
    mode: playbackState.mode,
    activity: playbackState.activity,
    queueItemId: isDemo ? null : getState('playlist.currentQueueItemId'),
    ...(isDemo ? { demoTrackIndex: getState('demo.currentTrackIndex') } : {}),
  };
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

function getPlayableFileSyncPosition(estimatedHostPosition: number): number | null {
  if (!Number.isFinite(estimatedHostPosition)) return null;

  const buffer = getCurrentAudioBuffer();
  if (!buffer) return null;

  const duration = Number.isFinite(buffer.duration) ? buffer.duration : 0;
  const syncPosition = Math.max(0, estimatedHostPosition);
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
  const absoluteDrift = Math.abs(signedDrift);

  if (absoluteDrift < FILE_SOFT_RESYNC_DRIFT_SEC) {
    resetSoftFileResyncState();
    return false;
  }

  const now = Date.now();
  if (now - lastSoftFileResyncAt < FILE_SOFT_RESYNC_COOLDOWN_MS) {
    resetSoftFileResyncState();
    return false;
  }

  const direction: -1 | 1 = signedDrift > 0 ? 1 : -1;
  if (direction === softFileDriftDirection) {
    softFileDriftSamples += 1;
  } else {
    softFileDriftDirection = direction;
    softFileDriftSamples = 1;
  }

  if (softFileDriftSamples < FILE_SOFT_RESYNC_REQUIRED_SAMPLES) return false;

  log.info(
    `[Sync] Soft file resync: drift=${Math.round(signedDrift * 1_000)}ms, samples=${softFileDriftSamples}`,
  );
  lastSoftFileResyncAt = now;
  resetSoftFileResyncState();
  play(syncPosition);
  return true;
}

function handleSyncPing(data: Record<string, unknown>, conn: DataConnection): void {
  recordPeerHeartbeat(conn);
  if (!conn?.open) return;

  const hostTime = Date.now();
  const playbackState = getSyncPongPlaybackState();
  const isFilePlaying = playbackState.mode === 'file' && playbackState.activity === 'playing';
  const position = getSafeSyncPongPosition(isFilePlaying);

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
    /* connection closed after the open check */
  }
}

function emitSkippedSyncDecision(reason: string, expectedPositionSeconds?: number): void {
  bus.emit('sync:diagnostic-standard-decision', {
    decision: 'skipped',
    ...(expectedPositionSeconds === undefined ? {} : { expectedPositionSeconds }),
    reason,
  });
}

function handleSyncPong(data: Record<string, unknown>, conn?: DataConnection): void {
  // A guest accepts SYNC_PONG only from its exact current host connection.
  // Sequential ping ids alone are predictable and cannot authenticate a clock.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const pingId = data.pingId as number;
  const hostTime = data.hostTime as number;
  const position = data.position as number;
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

  const latencyHistory = [...getState('sync.latencyHistory'), result.rtt];
  if (latencyHistory.length > 10) latencyHistory.shift();
  setState('sync.latencyHistory', latencyHistory);
  setState('sync.lastLatencyMs', Math.min(...latencyHistory));
  bus.emit('sync:latency-update', result.rtt);

  if (!pongPlayingFile) {
    resetSoftFileResyncState();
    emitSkippedSyncDecision('host-not-playing-file');
    return;
  }
  if (!Number.isFinite(position)) {
    resetSoftFileResyncState();
    emitSkippedSyncDecision('invalid-host-position');
    return;
  }
  if (!pongTrackMatches) {
    resetSoftFileResyncState();
    log.debug('[Sync] Ignored pong for a different queue/demo item');
    emitSkippedSyncDecision('track-mismatch');
    return;
  }
  if (isLocalFilePaused()) {
    resetSoftFileResyncState();
    emitSkippedSyncDecision('local-pause');
    return;
  }

  const hostElapsed = (getHostNow() - hostTime) / 1_000;
  const estimatedHostPosition = position + hostElapsed;

  if (!isPlaybackPlayingFile()) {
    resetSoftFileResyncState();
    const lifecycle = getState('playback.lifecycle');
    if (
      lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD ||
      lifecycle === PLAYBACK_STATE.DOWNLOADING ||
      lifecycle === PLAYBACK_STATE.DECODING
    ) {
      log.debug(`[Sync] Bootstrap skipped while ${lifecycle}; waiting for the new buffer`);
      emitSkippedSyncDecision(`pipeline-${lifecycle}`, estimatedHostPosition);
      return;
    }

    const syncPosition = getPlayableFileSyncPosition(estimatedHostPosition);
    if (syncPosition === null) {
      emitSkippedSyncDecision('no-playable-position', estimatedHostPosition);
      return;
    }

    log.info(
      `[Sync] Initial bootstrap: starting playback at host position ${syncPosition.toFixed(2)}s`,
    );
    play(syncPosition);
    needsInitialSync = false;
    bus.emit('sync:arm-initial');
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'bootstrap',
      expectedPositionSeconds: syncPosition,
    });
    return;
  }

  const syncPosition = getPlayableFileSyncPosition(estimatedHostPosition);
  if (syncPosition === null) {
    emitSkippedSyncDecision('no-playable-position', estimatedHostPosition);
    return;
  }

  const localPosition = getTrackPosition();
  if (needsInitialSync) {
    needsInitialSync = false;
    resetSoftFileResyncState();
    play(syncPosition);
    bus.emit('sync:diagnostic-standard-decision', {
      decision: 'initial',
      expectedPositionSeconds: syncPosition,
      localPositionSeconds: localPosition,
    });
    return;
  }

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

// ─── Initialization ─────────────────────────────────────────────────

function sendImmediatePing(): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn?.open) return;

  const pingId = ++syncPingCounter;
  registerPing(pingId);
  try {
    hostConn.send({ type: MSG.SYNC_PING, pingId, guestTime: Date.now() });
  } catch {
    /* noop */
  }
}

type RequestedKickScope = 'member' | 'physical';

// Keep the legacy standard-room compatibility read at the established sync
// facade while the actual room authority and peer-identity checks live in the
// focused room-control module.
function resolveRequestedKickTarget(
  data: Record<string, unknown>,
  conn: DataConnection,
  scope: RequestedKickScope,
): string | null {
  if (getState('network.hostConn') || getState('network.appRole') !== 'host') return null;
  return resolveRoomControlKickTarget(data, conn, scope);
}

export function initSync(): void {
  // Preserve the existing single bootstrap boundary while delegating room
  // administration and transport-liveness ownership to focused modules.
  initRoomControl(resolveRequestedKickTarget);
  initHeartbeatMonitor();

  resetSoftFileResyncState();
  lastSoftFileResyncAt = Number.NEGATIVE_INFINITY;

  registerHandlers({
    [MSG.SYNC_PING]: handleSyncPing,
    [MSG.SYNC_PONG]: handleSyncPong,
  });

  bus.on('state:network.appRole', () => {
    const role = getState('network.appRole');
    setIsHostClock(role === 'host');
    if (role !== 'host' && role !== 'guest') resetClockState();
  });

  bus.on('state:network.hostConn', () => {
    if (getState('network.appRole') !== 'guest') return;
    resetSyncClockRuntime();
    if (getState('network.hostConn')?.open) {
      resetClockSamples();
    } else {
      resetClockState();
    }
  });

  const armInitialSync = (): void => {
    setManagedTimer(
      'initial-sync-arm',
      () => {
        needsInitialSync = true;
      },
      1_000,
    );
  };

  const syncInitialArmFromPlayback = (): void => {
    const isPlaying = isPlaybackPlayingFile();
    if (isPlaying && !wasPlaying) armInitialSync();
    if (!isPlaying) {
      clearManagedTimer('initial-sync-arm');
      needsInitialSync = false;
    }
    wasPlaying = isPlaying;
  };
  bus.on('state:playback.mode', syncInitialArmFromPlayback);
  bus.on('state:playback.activity', syncInitialArmFromPlayback);
  bus.on('sync:arm-initial', armInitialSync);

  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      resetSyncClockRuntime();
      wasPlaying = false;
    }
  });

  bus.on('sync:nudge', (milliseconds) => {
    if (!Number.isFinite(milliseconds)) return;
    if (!canApplyManualSyncAction()) {
      rejectManualSyncAction();
      return;
    }
    if (isPlaybackModeYouTube()) {
      adjustYouTubeSync(milliseconds / 1_000);
    } else {
      adjustSync(milliseconds / 1_000);
    }
  });

  bus.on('sync:auto-sync', () => {
    if (!canApplyManualSyncAction()) {
      rejectManualSyncAction();
      return;
    }
    handleAutoSync();
  });

  // Remote-share completion can request an out-of-band ping rather than wait
  // for the next worker tick.
  bus.on('sync:request-immediate-ping', sendImmediatePing);

  // Long background resume forces the next valid PONG to re-lock playback even
  // when drift is below the ordinary hard-correction threshold.
  bus.on('sync:force-resync', () => {
    const hostConn = getState('network.hostConn');
    if (!hostConn?.open) return;
    resetClockSamples();
    needsInitialSync = true;
    sendImmediatePing();
  });

  bus.on('worker:timer-tick', (id) => {
    bus.emit('sync:diagnostic-worker-tick', id);
    if (id === 'sync') sendImmediatePing();
  });

  log.info('[Sync] Handlers registered');
}
