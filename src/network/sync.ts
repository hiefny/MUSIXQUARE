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
import {
  initRoomControl,
  resolveRoomControlKickTarget,
  type RequestedKickScope,
} from './room-control.ts';
import { initHeartbeatMonitor, recordPeerHeartbeat } from './heartbeat-monitor.ts';

let _syncPingCounter = 0;
let _needsInitialSync = false;
let _wasPlaying = false;
let _softFileDriftDirection: -1 | 0 | 1 = 0;
let _softFileDriftSamples = 0;
let _lastSoftFileResyncAt = Number.NEGATIVE_INFINITY;

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
  recordPeerHeartbeat(conn);

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

// Keep the legacy standard-room compatibility read at the established sync
// facade while canonical room authority and peer identity checks live in the
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
  // administration and transport liveness to their focused owners.
  initRoomControl(resolveRequestedKickTarget);
  initHeartbeatMonitor();

  resetSoftFileResyncState();
  _lastSoftFileResyncAt = Number.NEGATIVE_INFINITY;

  registerHandlers({
    [MSG.SYNC_PING]: handleSyncPing,
    [MSG.SYNC_PONG]: handleSyncPong,
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

  log.info('[Sync] Handlers registered');
}
