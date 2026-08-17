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

f