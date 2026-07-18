/**
 * MUSIXQUARE — YouTube Player
 *
 * Module coordinator: stopYouTubeMode, initYouTube (bus event wiring),
 * and re-exports from sub-modules.
 *
 * Sub-modules:
 *   _state.ts    — Shared module state (getters/setters)
 *   iframe.ts    — IFrame API loading, player creation, UI loop
 *   handlers.ts  — Protocol message handlers
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer, getManagedTimer } from '../core/timers.ts';
import { IS_ANDROID, IS_IOS } from '../core/platform.ts';
import {
  isPlaybackIdleCompat,
  isPlaybackModeYouTube,
  isPlaybackPlayingYouTube,
  setPlaybackIdle,
  setPlaybackTrackMeta,
  updatePlaybackTrackTitle,
} from '../player/ownership.ts';
import { schedulePreload } from '../storage/preload.ts';
import { broadcast, safeSend, sendToHost } from '../network/peer.ts';
import { getClockOffset, getHostNow, isClockCalibrated } from '../network/shared-clock.ts';
import { getRoomContext, hasRoomCapability, verifyPeerCapability } from '../rooms/authority.ts';
import {
  broadcastTracksAdded,
  localQueueActorName,
  queueActorNameForConnection,
} from '../chat/queue-events.ts';
import {
  acceptStandardQueueMutationRequest,
  sendStandardQueueMutationRequest,
  settleStandardQueueMutationRequest,
  type StandardQueueMutationResultCode,
} from '../network/queue-mutation-authority.ts';
import {
  handleProRoomTrackMetadata,
  handleProRoomYouTube,
} from '../pro-room/legacy-media-hooks.ts';
import {
  YT_AUTO_SYNC_MS,
  STAGE2_RENDEZVOUS_BROADCAST_MS,
  TRACK_TRANSITION_RENDEZVOUS_MS,
  PREV_TRACK_RESTART_THRESHOLD_SEC,
  BROADCAST_SYNC_MIN_INTERVAL_MS,
  IMMEDIATE_ACTION_COOLDOWN_MS,
} from './constants.ts';

interface PendingAutoSyncOptions {
  isTrackTransition?: boolean;
  /** Fresh 0-second shared start; eligible for the zero-start barrier. */
  zeroStart?: boolean;
  targetTime?: number;
  subIndex?: number;
  videoId?: string;
  skipSeek?: boolean;
  rendezvousDelayMs?: number;
  state?: 1 | 2;
}

// YouTube rendezvous-autoplay intent: set by any caller that loaded a track
// with autoplay=false but wants playback to start once the player (or its
// async load) is ready. Consumed by two paths:
//   1. 'youtube:player-ready' (new player instance just initialized)
//   2. iframe.ts onStateChange PLAYING branch (existing player, async
//      loadPlaylist/loadVideoById completed)
// Both route through 'youtube:auto-play' → scheduleYtAutoSync so host and
// guests use the same two-stage rendezvous instead of independent autoplay.
let _pendingAutoSyncOnReady = false;
let _pendingAutoSyncOptions: PendingAutoSyncOptions | null = null;
let _pendingAutoSyncOwner: {
  generation: number;
  queueItemId: QueueItemId | null;
  youtubeSessionId: number;
} | null = null;
let _pendingAutoSyncGeneration = 0;

function clearPendingAutoSync(): void {
  _pendingAutoSyncOnReady = false;
  _pendingAutoSyncOptions = null;
  _pendingAutoSyncOwner = null;
  clearManagedTimer('yt-pending-auto-sync-ready');
}

function pendingAutoSyncMatchesCurrentOwner(): boolean {
  const owner = _pendingAutoSyncOwner;
  if (!owner) return false;
  return (
    owner.queueItemId === getCurrentQueueItemId() &&
    owner.youtubeSessionId === getCurrentSessionId()
  );
}

function pollPendingAutoSyncReady(generation: number, attempt = 0): void {
  setManagedTimer(
    'yt-pending-auto-sync-ready',
    () => {
      if (
        !_pendingAutoSyncOnReady ||
        _pendingAutoSyncOwner?.generation !== generation ||
        !pendingAutoSyncMatchesCurrentOwner()
      ) {
        if (_pendingAutoSyncOnReady && _pendingAutoSyncOwner?.generation === generation) {
          clearPendingAutoSync();
        }
        return;
      }

      const player = getYouTubePlayer();
      let ready: boolean;
      try {
        const state = player?.getPlayerState?.() ?? -1;
        ready = !isYtLoadInProgress() && (state === 1 || state === 2 || state === 5);
      } catch {
        ready = false;
      }

      if (ready) {
        const pending = consumePendingAutoSyncOnReady();
        if (pending) {
          bus.emit('youtube:auto-play', pending);
          return;
        }
      }

      // Playlist scraping can legitimately take about 4.5 seconds. Keep a
      // bounded identity-aware watchdog so a synchronous/missed CUED event
      // cannot strand the next track, while stale B→C events can never consume
      // C's intent.
      if (attempt < 160) pollPendingAutoSyncReady(generation, attempt + 1);
      else clearPendingAutoSync();
    },
    50,
  );
}

export function setPendingAutoSyncOnReady(
  v: boolean,
  options: PendingAutoSyncOptions | null = null,
): void {
  _pendingAutoSyncGeneration += 1;
  if (!v) {
    clearPendingAutoSync();
    return;
  }
  _pendingAutoSyncOnReady = true;
  _pendingAutoSyncOptions = options;
  _pendingAutoSyncOwner = {
    generation: _pendingAutoSyncGeneration,
    queueItemId: getCurrentQueueItemId(),
    youtubeSessionId: getCurrentSessionId(),
  };
  pollPendingAutoSyncReady(_pendingAutoSyncGeneration);
}
function getPendingAutoSyncOnReady(): boolean {
  return _pendingAutoSyncOnReady;
}
export { getPendingAutoSyncOnReady as getPendingAutoSyncOnReadyForTests };
export function consumePendingAutoSyncOnReady(): PendingAutoSyncOptions | null {
  if (!_pendingAutoSyncOnReady) return null;
  if (!pendingAutoSyncMatchesCurrentOwner()) {
    clearPendingAutoSync();
    return null;
  }

  const expectedVideoId = _pendingAutoSyncOptions?.videoId;
  if (expectedVideoId) {
    try {
      const liveVideoId = getYouTubePlayer()?.getVideoData?.()?.video_id || '';
      // An old iframe event can arrive after a new load session was armed.
      // Retain the new intent until the expected video's own CUED/PLAYING
      // transition (or the watchdog) observes matching identity.
      if (liveVideoId && liveVideoId !== expectedVideoId) return null;
    } catch {
      return null;
    }
  }

  const options = _pendingAutoSyncOptions ?? {};
  clearPendingAutoSync();
  return options;
}

function isCompatIdle(): boolean {
  return isPlaybackIdleCompat();
}

import { registerHandlers } from '../network/protocol.ts';
import {
  fetchYouTubePreview,
  extractYouTubeVideoId,
  extractYouTubePlaylistId,
  isYouTubeLiveUrl,
  getYouTubeInputIntent,
  getSelectedYouTubeSearchResult,
  searchYouTubeFromInput,
  resolveYouTubePlaylistEntry,
  clearYouTubeInputState,
  fetchPlaylistSubTitles,
  cancelSubTitleFetch,
} from './search.ts';
import { fetchOEmbedTitle } from './oembed.ts';
import type {
  DataConnection,
  PlaylistItem,
  QueueItemId,
  YouTubeZeroStartPlatform,
} from '../types/index.ts';
import {
  canAppendPlaylistItems,
  commitPlaylistItems,
  createPlaylistSnapshot,
  createQueueItemId,
  findQueueItemIndex,
  getCurrentQueueItemId,
  getQueueItemById,
  selectQueueItemById,
} from '../player/queue-model.ts';

// ─── Sub-module imports ────────────────────────────────────────────

import {
  getYouTubePlayer,
  setYouTubePlayer,
  getCurrentSessionId,
  isYtLoadInProgress,
  setYtLoadInProgress,
  getYtScope,
  setYtScope,
  setCachedYtDuration,
  setLocalYouTubePaused,
  setYtAutoplayIntent,
  setYouTubeSubIndex,
  updateSubItemIds,
  isYtIndexing,
  clearYtIndexingSession,
  isYtPrimed,
  setYtPrimed,
  setYtPriming,
  setYtPrimeBouncePending,
} from './_state.ts';

import {
  loadYouTubeVideo,
  refreshYouTubeDisplay,
  markYtStateBroadcast,
  clearSnapshotRetries,
  showLiveStreamSyncWarning,
} from './iframe.ts';
import { showLoader } from '../ui/toast.ts';

import {
  handleYouTubePlay,
  handleRequestYouTubePlay,
  handleRequestYouTubePause,
  handleRequestYouTubeToggle,
  handleRequestYouTubeSubSeek,
  handleRequestYouTubePlaylistInfo,
} from './handlers.ts';
import { broadcastYouTubeSync, guestRendezvousSync, resetYouTubeSyncState } from './sync.ts';
import {
  clearProCoordinatorYouTubeNudgeAnchor,
  isProCoordinatorYouTubeEndpoint,
  PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
  rebaseProCoordinatorYouTubeNudgeAnchor,
  resolveProCoordinatorYouTubeTarget,
  toCanonicalYouTubeTime,
} from './local-offset.ts';
import { showToast } from '../ui/toast.ts';
import {
  advertiseYouTubeZeroStartCapability,
  beginYouTubeZeroStart,
  cancelYouTubeZeroStart,
  canUseYouTubeZeroStart,
  handleYouTubeZeroStartAbort,
  handleYouTubeZeroStartArmed,
  handleYouTubeZeroStartCapability,
  handleYouTubeZeroStartCommit,
  handleYouTubeZeroStartPeerDisconnected,
  handleYouTubeZeroStartPeerConnectionReplaced,
  handleYouTubeZeroStartPrepare,
  handleYouTubeZeroStartTimeline,
  initYouTubeZeroStart,
  getYouTubeZeroStartSnapshot,
  isYouTubeZeroStartProtocolActive,
  resetYouTubeZeroStart,
  updateYouTubeZeroStartDesiredAudioState,
  type YouTubeZeroStartPlayer,
  type YouTubeZeroStartTargetContext,
  type YouTubeZeroStartWireMessage,
} from './zero-start.ts';

import type { YTNamespace, YouTubePlayerInstance } from './_state.ts';
declare const YT: YTNamespace;

let invalidateYouTubeZeroStartPendingIntegration = (): void => {};

// ─── Re-exports ────────────────────────────────────────────────────
// External modules (e.g. sync.ts) import { getYouTubePlayer } from './player.ts'

export { getYouTubePlayer } from './_state.ts';
export { loadYouTubeVideo, primeYouTubePlayer, precreateYouTubePlayer } from './iframe.ts';

function getYouTubeDuration(player: YouTubePlayerInstance): number {
  try {
    return player.getDuration?.() || 0;
  } catch {
    return 0;
  }
}

function readCanonicalYouTubeTime(player: YouTubePlayerInstance): number {
  return toCanonicalYouTubeTime(player.getCurrentTime?.() || 0, getYouTubeDuration(player));
}

function resolveCoordinatorLocalTarget(
  player: YouTubePlayerInstance,
  canonicalTime: number,
): { canonicalTime: number; localTime: number } {
  if (!isProCoordinatorYouTubeEndpoint()) {
    return { canonicalTime, localTime: canonicalTime };
  }

  // A room-level play/pause/seek supersedes a still-settling local nudge.
  // Its explicit canonical target is now the source of truth.
  clearProCoordinatorYouTubeNudgeAnchor();
  const target = resolveProCoordinatorYouTubeTarget(
    canonicalTime,
    getState('sync.youtubeLocalOffset') || 0,
    getYouTubeDuration(player),
  );
  setState('sync.youtubeCoordinatorAppliedOffset', target.effectiveOffset);
  return target;
}

function getYouTubeZeroStartPlatform(): YouTubeZeroStartPlatform {
  if (IS_IOS) return 'ios';
  if (IS_ANDROID) return 'android';
  return 'other';
}

function getYouTubeZeroStartRole(): 'host' | 'guest' {
  const room = getRoomContext();
  if (room.kind === 'pro') return room.role === 'coordinator' ? 'host' : 'guest';
  return getState('network.appRole') === 'guest' ? 'guest' : 'host';
}

function getZeroStartPlayer(): YouTubeZeroStartPlayer | null {
  const player = getYouTubePlayer();
  if (
    !player?.loadVideoById ||
    !player.playVideo ||
    !player.pauseVideo ||
    !player.seekTo ||
    !player.mute ||
    !player.unMute ||
    !player.isMuted ||
    !player.setVolume ||
    !player.getVolume ||
    !player.getCurrentTime ||
    !player.getPlayerState ||
    !player.getVideoLoadedFraction ||
    !player.getVideoData
  ) {
    return null;
  }
  return player as YouTubeZeroStartPlayer;
}

function getLiveYouTubeGuestPeerIds(): string[] {
  if (getYouTubeZeroStartRole() !== 'host') return [];
  const active = getState('network.activeHostConnByPeerId');
  const ids: string[] = [];
  for (const [peerId, conn] of active) {
    if (peerId && conn?.open === true) ids.push(peerId);
  }
  return ids;
}

function sendYouTubeZeroStartToPeer(peerId: string, message: YouTubeZeroStartWireMessage): boolean {
  const conn = getState('network.activeHostConnByPeerId').get(peerId);
  return !!conn?.open && safeSend(conn, message);
}

function sendYouTubeZeroStartToHost(message: YouTubeZeroStartWireMessage): boolean {
  const conn = getState('network.hostConn');
  return !!conn?.open && safeSend(conn, message);
}

function clampZeroStartTarget(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds)) return 0;
  if (Number.isFinite(duration) && duration > 0) {
    return Math.max(0, Math.min(seconds, duration));
  }
  return Math.max(0, seconds);
}

/**
 * Start the bounded 0-second barrier only when every live participant has
 * advertised support. A mixed-version room fails closed to the existing
 * rendezvous path as one cohort, so an old client can never be stranded.
 */
export function tryBeginYouTubeZeroStart(videoId: string, subIndex: number | null): boolean {
  const queueItemId = getCurrentQueueItemId();
  if (!queueItemId || !videoId || getYouTubeZeroStartRole() !== 'host') return false;
  if (!canUseYouTubeZeroStart()) return false;

  clearManagedTimer('yt-auto-sync');
  clearManagedTimer('yt-clock-action');
  clearManagedTimer('yt-seek-play');
  setYtAutoplayIntent(true);
  return beginYouTubeZeroStart({ queueItemId, videoId, subIndex });
}

// ─── YouTube Auto-Sync (SharedClock) ──────────────────────────────
// Host actions run immediately, then a two-stage broadcast aligns guests.

/**
 * Host action + 2-stage broadcast for guest sync.
 *
 * 1. Execute the action locally (seekTo + play/pause).
 * 2. Stage 1 — broadcast YOUTUBE_STATE so guests run a rough seek+play
 *    immediately (handleYouTubeState's executeImmediate path).
 * 3. Stage 2 — after `rendezvousDelayMs` (default STAGE2_RENDEZVOUS_BROADCAST_MS,
 *    2s) broadcast YOUTUBE_SYNC{isManual:true}. Guests' handleYouTubeSync
 *    routes manual syncs to guestRendezvousSync for precision alignment
 *    using a host snapshot that has had time to settle past the iframe's
 *    seek-buffer window.
 *
 * Do not fire the precision rendezvous immediately for same-video PLAY/SEEK.
 * Skipping Stage 1 exposes the iframe's getPlayerState()/getCurrentTime() race
 * and variable seek-buffer window (150ms-2s+ depending on device/network),
 * made the broadcast carry stale state or position too often. The 2-stage
 * delay always-on is slower but predictable across device + network mixes.
 */
export function scheduleYtAutoSync(
  targetTime: number,
  overrides?: {
    subIndex?: number;
    videoId?: string;
    skipSeek?: boolean;
    rendezvousDelayMs?: number;
    state?: number;
  },
): void {
  invalidateYouTubeZeroStartPendingIntegration();
  // Any ordinary play/pause/seek supersedes a zero-start barrier or its short
  // post-release calibration window. The legacy rendezvous then remains the
  // sole owner of player timers and room broadcasts.
  cancelYouTubeZeroStart('superseded', true);
  const player = getYouTubePlayer();
  if (!player) return;
  const queueItemId = getCurrentQueueItemId();
  if (!queueItemId) return;

  const targetState = overrides?.state ?? 1; // Default to PLAYING
  const subIndex = overrides?.subIndex ?? getState('youtube.currentSubIndex') ?? -1;
  const videoId = (overrides?.videoId ?? player.getVideoData?.()?.video_id) || '';
  const resolvedTarget = resolveCoordinatorLocalTarget(player, targetTime);
  const canonicalTargetTime = resolvedTarget.canonicalTime;
  const localTargetTime = resolvedTarget.localTime;

  // 1. Host: Execute action immediately
  const localOffsetRequiresSeek =
    isProCoordinatorYouTubeEndpoint() &&
    Math.abs(localTargetTime - canonicalTargetTime) > Number.EPSILON;
  if ((!overrides?.skipSeek || localOffsetRequiresSeek) && canonicalTargetTime >= 0) {
    player.seekTo(localTargetTime, true);
  }
  if (targetState === 1) {
    setYtAutoplayIntent(true);
    player.playVideo?.();
  } else if (targetState === 2) {
    player.pauseVideo?.();
  }

  // 2. Stage 1: rough state broadcast — guests do executeImmediate to
  // catch up to roughly the right place while Stage 2's wait elapses.
  markYtStateBroadcast();
  broadcast({
    type: MSG.YOUTUBE_STATE,
    queueItemId,
    state: targetState,
    time: canonicalTargetTime,
    subIndex,
    videoId,
    hostPlayAt: 0,
    hostClock: getHostNow(),
    title: player.getVideoData?.()?.title || '',
  });

  // 3. Stage 2: precision rendezvous after a fixed delay — by then the
  // iframe has had time to settle past its seek-buffer window so
  // getCurrentTime() reflects real playback, and guest-side
  // guestRendezvousSync can extrapolate accurately.
  //
  // Skip Stage 2 entirely when the target is paused: position alignment
  // already happened via the Stage-1 YOUTUBE_STATE message, and the
  // guest's rendezvous handler short-circuits with seek+pause anyway.
  // Firing Stage 2 here would surface as a redundant "host paused,
  // matched position" toast ~2s after the user's pause action. The
  // host's manual Sync button (also isManual=true) bypasses this path
  // entirely — it calls broadcastYouTubeSync directly — so guests still
  // get the rendezvous toast on user-initiated syncs.
  // A PAUSE must also cancel a previously armed PLAY rendezvous. Leaving the
  // old stage-2 timer alive would make guests receive a delayed PLAY snapshot
  // after the coordinator had already paused (notably through Developer API).
  clearManagedTimer('yt-auto-sync');
  if (targetState !== 1) return;
  const waitMs = overrides?.rendezvousDelayMs ?? STAGE2_RENDEZVOUS_BROADCAST_MS;
  setManagedTimer(
    'yt-auto-sync',
    () => {
      const p = getYouTubePlayer();
      if (!p) return;
      // A delayed rendezvous belongs to the queue occurrence that scheduled
      // it. Reorder preserves the ID; selecting/removing another occurrence
      // invalidates it without relying on a mutable array position.
      if (queueItemId !== getCurrentQueueItemId()) return;

      markYtStateBroadcast();
      // Pass targetState as the intent state. Even after the 2s wait, the
      // iframe can briefly land in BUFFERING (3) on slow networks; without
      // the override, broadcastYouTubeSync would read getPlayerState()=3
      // and guests' lastHostSnapshot.hostState would trip
      // guestRendezvousSync's "host paused" branch.
      broadcastYouTubeSync(true, targetState);
      log.debug(`[YouTube] Sync: Mandatory precision rendezvous sent after ${waitMs}ms`);
    },
    waitMs,
  );
}

/** Cancel any pending auto-sync (e.g. user paused during rendezvous). */
export function cancelYtAutoSync(): void {
  invalidateYouTubeZeroStartPendingIntegration();
  clearManagedTimer('yt-auto-sync');
  clearManagedTimer('yt-zero-start-external-fallback');
  clearManagedTimer('yt-zero-start-host-fallback');
  clearManagedTimer('yt-zero-start-replacement-fallback');
  cancelYouTubeZeroStart('cancelled', true);
  bus.emit('youtube:sync-loading', false);
}

function scheduleLateJoinRendezvousSync(
  conn: DataConnection,
  queueItemId: QueueItemId,
  fallbackSubIndex: number,
  fallbackVideoId: string,
): void {
  const peerId = conn.peer || 'unknown';
  setManagedTimer(
    `yt-late-join-rendezvous-${peerId}`,
    () => {
      if (!conn.open || getState('network.hostConn')) return;
      if (!isPlaybackModeYouTube()) return;
      if (queueItemId !== getCurrentQueueItemId()) return;

      // A coordinator-local nudge changes the iframe position before that
      // position is reliably observable. Do not combine an old currentTime
      // with the newly-applied offset in the second late-join snapshot.
      if (getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER)) {
        scheduleLateJoinRendezvousSync(conn, queueItemId, fallbackSubIndex, fallbackVideoId);
        return;
      }

      const player = getYouTubePlayer();
      if (!player?.getCurrentTime) return;

      try {
        const liveState = player.getPlayerState?.() ?? 1;
        if (liveState === 2 || liveState === 0 || liveState === -1) return;
        const currentSubIndex = getState('youtube.currentSubIndex');

        safeSend(conn, {
          type: MSG.YOUTUBE_SYNC,
          queueItemId,
          time: toCanonicalYouTubeTime(player.getCurrentTime(), getYouTubeDuration(player)),
          state: 1,
          subIndex:
            currentSubIndex !== undefined && currentSubIndex >= 0
              ? currentSubIndex
              : fallbackSubIndex,
          videoId: player.getVideoData?.()?.video_id || fallbackVideoId,
          hostClock: getHostNow(),
          isManual: true,
          title: getState('player.currentTrackMeta')?.title,
        });
        log.debug(`[YouTube] Late-join rendezvous sync sent to ${peerId}`);
      } catch (e) {
        log.debug('[YouTube] late-join rendezvous sync skipped:', e);
      }
    },
    STAGE2_RENDEZVOUS_BROADCAST_MS,
  );
}

// ─── Stop YouTube Mode ─────────────────────────────────────────────

export function stopYouTubeMode(opts?: { silent?: boolean }): void {
  const ownerQueueItemId =
    getState('player.currentTrackMeta')?.queueItemId ?? getCurrentQueueItemId();
  getYtScope()?.dispose();
  setYtScope(null);
  setYtLoadInProgress(false);
  setCachedYtDuration(0); // Reset duration cache
  const wasInYouTube = isPlaybackModeYouTube();
  // Preservation: do not reset sub-index to -1 if we are or will be in YouTube mode.
  // This prevents clobbering the sub-index 0 set during the indexing callback.
  if (!wasInYouTube && !isCompatIdle() && !isYtIndexing() && !isYtLoadInProgress()) {
    setYouTubeSubIndex(-1);
  }
  // Unconditionally clear any in-flight indexing session. stopYouTubeMode is
  // the teardown owner for indexing: every real mode exit (stop button, track
  // switch, load timeout, API-script failure) routes through here, and the
  // arming load re-arms its own session AFTER its transient stop
  // (clear-then-arm inside loadYouTubeVideo), so there is no session this
  // could legitimately spare. Placed after the sub-index preservation check
  // above so that check's isYtIndexing() term keeps its read-before-clear
  // semantics within this function.
  if (isYtIndexing()) {
    clearYtIndexingSession();
    // Hide the loader the cleared session showed; gated on an actual clear so
    // a plain track switch can't stomp the incoming flow's loader.
    showLoader(false);
  }
  setPendingAutoSyncOnReady(false); // Clear pending URL-input sync if any

  // Only leave YouTube mode when we're actually
  // leaving — avoids spurious transitions from stopAllMedia→stopYouTubeMode
  // inside loadYouTubeVideo which would kill the guest's YouTube player
  // right after YOUTUBE_PLAY.
  //
  // opts.silent: caller is about to claim a non-idle playback mode immediately
  // (e.g. stopAllMedia({silent:true}) inside YT→Local track switch — the
  // host's _internalPlay claims file playback right after). Skipping the
  // IDLE bounce here keeps body.mode-youtube → body.mode-audio in lockstep
  // with the audio takeover and prevents the brief blank-mode UI flash.
  if (wasInYouTube && !opts?.silent) {
    setPlaybackIdle();
  }

  clearManagedTimer('youtubeUILoop');
  clearManagedTimer('youtubeSyncLoop');
  clearManagedTimer('yt-first-track-fisher');
  clearManagedTimer('yt-playlist-snapshot');
  cancelYtAutoSync(); // Clear pending auto-sync timer + loading state

  // Clear the guest-side yt-clock-action timer (scheduled by
  // handleYouTubeState for delayed play/pause). Without this, the timer
  // fires after the player is destroyed and calls playVideo/pauseVideo
  // on a null player, producing console errors and orphaned toasts.
  clearManagedTimer('yt-clock-action');
  clearManagedTimer('yt-seek-play');
  clearManagedTimer('yt-guest-ended-fallback');

  clearManagedTimer('yt-load-timeout');
  clearManagedTimer('yt-mix-snapshot');
  clearManagedTimer('yt-refresh-display');
  clearManagedTimer('yt-prime-bounce-timeout');
  setYtPriming(false);
  setYtPrimeBouncePending(false);
  setYtAutoplayIntent(false);
  // Stop the background oEmbed fetch loop. Without this, leaving YouTube
  // mode mid-playlist with 100+ items keeps firing oEmbed requests for
  // ~80s and broadcasting YOUTUBE_SUB_TITLE_UPDATE messages — wasted
  // network/CPU/battery and cross-mode peer noise.
  cancelSubTitleFetch();
  // Scope disposal at the top owns the namespaced indexing poll. Clear the
  // page-global scrape timers separately.
  clearManagedTimer('yt-scrape-poll');
  clearManagedTimer('yt-scrape-safety');
  clearSnapshotRetries();

  // Full reset of guest-side sync module state (rendezvous flag, host
  // snapshot, drift-correction cooldown, ad detection, rendezvous timers).
  // Without this, a mid-rendezvous mode exit would leak timers, leave
  // rendezvousInProgress=true (blocking next rendezvous), leave
  // autoSyncUntil pinned to a future timestamp (blocking drift correction),
  // and leave lastHostSnapshot pointing to stale host-clock data.
  // Static import is safe: sync.ts does not import from player.ts.
  resetYouTubeSyncState();

  const player = getYouTubePlayer();
  const retainPlayer = !!player && (IS_IOS || isYtPrimed());
  if (player) {
    try {
      log.debug(
        retainPlayer
          ? '[YouTube] Stopping retained player instance...'
          : '[YouTube] Destroying player instance...',
      );
      player.stopVideo();
      if (!retainPlayer && typeof player.destroy === 'function') player.destroy();
    } catch (e: unknown) {
      log.debug('[YouTube] Cleanup error (non-critical):', (e as Error).message);
    }
    if (!retainPlayer) {
      setYouTubePlayer(null);
      setYtPrimed(false);
    }
  }

  const container = document.getElementById('youtube-player-container');
  if (container && !retainPlayer) container.replaceChildren();

  // A non-iOS teardown destroys the runtime that the latest capability
  // described. Publish the downgrade immediately so the next transition's
  // bounded wait starts from an accurate readiness snapshot.
  advertiseYouTubeZeroStartCapability();

  // Remove iOS sync overlay if present (prevents orphaned overlay on mode exit)
  const iosOverlay = document.getElementById('youtube-ios-sync-overlay');
  if (iosOverlay) iosOverlay.remove();

  const videoEl = document.getElementById('main-video') as HTMLVideoElement | null;
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.style.display = 'none';
    videoEl.load();
  }

  // Notify guests to stop YouTube (Host only) — only when actually leaving YouTube mode
  if (wasInYouTube) {
    const hostConn = getState('network.hostConn');
    if (!hostConn && ownerQueueItemId) {
      broadcast({ type: MSG.YOUTUBE_STOP, queueItemId: ownerQueueItemId });
    }
  }

  log.debug('[YouTube] Mode stopped');
}

// ─── Sub-Video Navigation Helper ───────────────────────────────────

/**
 * Single-video navigation using the host-snapshotted subItemsMap.
 * Never calls `playVideoAt` — we drive the iframe one video at a time via
 * loadVideoById so the native playlist engine never runs.
 *
 * If the subItemsMap is empty, tries emergency population from
 * `player.getPlaylist()` so that fast Next/Prev clicks work before the
 * background snapshot/fetcher fires.
 */
function navigateSubVideo(direction: 1 | -1, callback: (success: boolean) => void): void {
  const player = getYouTubePlayer();
  if (!player?.loadVideoById) {
    callback(false);
    return;
  }

  try {
    const currentTrack = getQueueItemById(getCurrentQueueItemId());
    const pid = currentTrack?.playlistId as string;
    if (!pid) {
      callback(false);
      return;
    }

    let subData = (getState('youtube.subItemsMap') || {})[pid];

    if ((!subData || !subData.ids.length) && player.getPlaylist) {
      const ids = player.getPlaylist() || [];
      if (ids.length > 0) {
        updateSubItemIds(pid, ids);
        subData = { ids, titles: [] }; // Locally use for this tick
      }
    }

    const idx = getState('youtube.currentSubIndex') ?? -1;
    const targetIdx = idx + direction;
    let inBounds =
      direction === 1
        ? idx >= 0 && !!subData?.ids && idx < subData.ids.length - 1
        : idx > 0 && !!subData?.ids;

    // Fallback: about to fall off the end forward, but the iframe may have
    // lazily populated more items since the initial indexing snapshot.
    // Re-read getPlaylist() and retry if the cached list was truncated.
    if (!inBounds && direction === 1 && player.getPlaylist) {
      try {
        const freshIds = player.getPlaylist() || [];
        if (freshIds.length > (subData?.ids?.length ?? 0)) {
          log.info(
            `[YouTube] navigate refresh: ${subData?.ids?.length ?? 0} -> ${freshIds.length} items`,
          );
          updateSubItemIds(pid, freshIds);
          subData = { ids: freshIds, titles: subData?.titles || [] };
          inBounds = idx >= 0 && idx < freshIds.length - 1;
        }
      } catch (e) {
        log.debug('[YouTube] navigate refresh error:', e);
      }
    }

    if (inBounds && subData?.ids) {
      const targetVideoId = subData.ids[targetIdx];
      setYouTubeSubIndex(targetIdx);
      if (tryBeginYouTubeZeroStart(targetVideoId, targetIdx)) {
        callback(true);
        return;
      }
      player.loadVideoById(targetVideoId);
      scheduleYtAutoSync(0, {
        subIndex: targetIdx,
        videoId: targetVideoId,
        skipSeek: true,
        // A sub-video Next/Prev loads a different video, so guests need
        // the longer track-transition rendezvous to loadVideoById before the
        // synced play fires, matching the other loadVideoById paths rather than
        // the 2s STAGE2 default used for same-video restarts.
        rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
      });
      callback(true);
      return;
    }
  } catch (e) {
    log.debug(`[YouTube] navigate ${direction === 1 ? 'next' : 'prev'} error:`, e);
  }
  callback(false);
}

// ─── Init ──────────────────────────────────────────────────────────

export function initYouTube(): void {
  const resolvingProPlaylists = new Set<string>();
  let zeroStartAppliedGuestOffset = 0;
  let zeroStartAuthoritySignature = '';
  let zeroStartHostConnection = getState('network.hostConn');
  let zeroStartExternalFallbackGeneration = 0;
  let zeroStartExternalFallbackCleanup: (() => void) | null = null;
  type ZeroStartLegacyTarget = {
    queueItemId: QueueItemId;
    videoId: string;
    subIndex: number | null;
  };
  let pendingReplacementFallback:
    | (ZeroStartLegacyTarget & { peerId: string; token: number })
    | null = null;
  let replacementFallbackToken = 0;

  const clearZeroStartExternalFallback = (): void => {
    zeroStartExternalFallbackGeneration += 1;
    clearManagedTimer('yt-zero-start-external-fallback');
    const cleanup = zeroStartExternalFallbackCleanup;
    zeroStartExternalFallbackCleanup = null;
    cleanup?.();
  };

  const isCurrentZeroStartLegacyTarget = (target: ZeroStartLegacyTarget): boolean => {
    if (getYouTubeZeroStartRole() !== 'host') return false;
    if (getCurrentQueueItemId() !== target.queueItemId) return false;
    if (
      target.subIndex !== null &&
      (getState('youtube.currentSubIndex') ?? null) !== target.subIndex
    ) {
      return false;
    }
    return true;
  };

  const recoverZeroStartWithLegacyRendezvous = (
    target: ZeroStartLegacyTarget,
    reason: string,
  ): void => {
    const deadline = Date.now() + 3_000;
    let lastError: unknown;

    const finishUnavailable = (): void => {
      clearManagedTimer('yt-zero-start-host-fallback');
      setYtAutoplayIntent(false);
      try {
        getYouTubePlayer()?.pauseVideo?.();
      } catch {
        // The player is already unavailable; cleanup remains best-effort.
      }
      log.warn('[YouTube ZeroStart] Legacy recovery timed out:', lastError ?? reason);
      bus.emit('youtube:sync-loading', false);
    };

    const attemptRecovery = (): void => {
      if (!isCurrentZeroStartLegacyTarget(target)) return;
      if (Date.now() >= deadline) {
        finishUnavailable();
        return;
      }

      const player = getYouTubePlayer();
      if (!player) {
        setManagedTimer('yt-zero-start-host-fallback', attemptRecovery, 50);
        return;
      }

      try {
        player.loadVideoById(target.videoId, 0);
        scheduleYtAutoSync(0, {
          videoId: target.videoId,
          subIndex: target.subIndex ?? undefined,
          skipSeek: true,
          rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
        });
        log.warn(`[YouTube ZeroStart] Falling back to legacy rendezvous: ${reason}`);
      } catch (error) {
        lastError = error;
        try {
          player.pauseVideo?.();
        } catch {
          // A rebuilding iframe can reject both commands; the retry is bounded.
        }
        setManagedTimer('yt-zero-start-host-fallback', attemptRecovery, 50);
      }
    };

    setManagedTimer('yt-zero-start-host-fallback', attemptRecovery, 0);
  };

  const clearPendingReplacementFallback = (): void => {
    replacementFallbackToken += 1;
    pendingReplacementFallback = null;
    clearManagedTimer('yt-zero-start-replacement-fallback');
  };

  invalidateYouTubeZeroStartPendingIntegration = () => {
    clearZeroStartExternalFallback();
    clearPendingReplacementFallback();
    // A host-side prepare failure may be polling for a rebuilt iframe before
    // it hands the transition to the legacy rendezvous. Any newer user action
    // owns that same player, so it must revoke the retry as well as the guest
    // and replacement fallbacks above.
    clearManagedTimer('yt-zero-start-host-fallback');
  };

  const runPendingReplacementFallback = (
    pending: NonNullable<typeof pendingReplacementFallback>,
  ): void => {
    if (pendingReplacementFallback !== pending || pending.token !== replacementFallbackToken) {
      return;
    }
    pendingReplacementFallback = null;
    clearManagedTimer('yt-zero-start-replacement-fallback');
    recoverZeroStartWithLegacyRendezvous(pending, 'peer-connection-replaced');
  };

  const resolveZeroStartLocalTarget = (
    canonicalPositionSec: number,
    context: YouTubeZeroStartTargetContext,
  ): number => {
    const player = getYouTubePlayer();
    const duration = player ? getYouTubeDuration(player) : 0;
    if (context.role === 'host' && isProCoordinatorYouTubeEndpoint()) {
      const target = resolveProCoordinatorYouTubeTarget(
        canonicalPositionSec,
        getState('sync.youtubeLocalOffset') || 0,
        duration,
      );
      setState('sync.youtubeCoordinatorAppliedOffset', target.effectiveOffset);
      return target.localTime;
    }
    if (context.role === 'guest') {
      const requestedOffset = getState('sync.youtubeLocalOffset') || 0;
      const localTarget = clampZeroStartTarget(canonicalPositionSec + requestedOffset, duration);
      zeroStartAppliedGuestOffset = localTarget - canonicalPositionSec;
      return localTarget;
    }
    return clampZeroStartTarget(canonicalPositionSec, duration);
  };

  initYouTubeZeroStart({
    getRole: getYouTubeZeroStartRole,
    getLocalPeerId: () => getState('network.myId') || 'local',
    getHostPeerId: () => getState('network.hostConn')?.peer ?? null,
    getLiveGuestPeerIds: getLiveYouTubeGuestPeerIds,
    getPlayer: getZeroStartPlayer,
    isPlayerReady: () => getZeroStartPlayer() !== null,
    isAudioUnlocked: () => !IS_IOS || isYtPrimed(),
    isClockCalibrated,
    getHostNow,
    getClockOffsetMs: getClockOffset,
    getLocalPlatform: getYouTubeZeroStartPlatform,
    sendToPeer: sendYouTubeZeroStartToPeer,
    sendToHost: sendYouTubeZeroStartToHost,
    resolveLocalTargetSec: resolveZeroStartLocalTarget,
    toCanonicalPositionSec: (localPositionSec, context) => {
      const player = getYouTubePlayer();
      const duration = player ? getYouTubeDuration(player) : 0;
      if (context.role === 'host' && isProCoordinatorYouTubeEndpoint()) {
        return toCanonicalYouTubeTime(localPositionSec, duration);
      }
      if (context.role === 'guest') {
        return clampZeroStartTarget(localPositionSec - zeroStartAppliedGuestOffset, duration);
      }
      return clampZeroStartTarget(localPositionSec, duration);
    },
    onPrepareSelection: ({ queueItemId, subIndex }) => {
      clearZeroStartExternalFallback();
      clearPendingReplacementFallback();
      clearManagedTimer('yt-zero-start-host-fallback');
      zeroStartAppliedGuestOffset = 0;
      clearManagedTimer('yt-auto-sync');
      clearManagedTimer('yt-clock-action');
      clearManagedTimer('yt-seek-play');
      setLocalYouTubePaused(false);
      setYtAutoplayIntent(true);
      bus.emit('ui:seek-reset');

      const item = getQueueItemById(queueItemId as QueueItemId);
      if (item?.type === 'youtube') {
        selectQueueItemById(item.queueItemId);
        setPlaybackTrackMeta(item);
        if (subIndex !== null) {
          setYouTubeSubIndex(subIndex);
          const title = item.playlistId
            ? getState('youtube.subItemsMap')?.[item.playlistId]?.titles?.[subIndex]
            : undefined;
          if (title) updatePlaybackTrackTitle(title, item);
        }
      }
    },
    onBusyChange: (busy) => bus.emit('youtube:sync-loading', busy),
    onPlaybackStarted: () => {
      setLocalYouTubePaused(false);
    },
    onFallbackRequired: (event) => {
      if (getYouTubeZeroStartRole() !== 'guest') return;
      clearZeroStartExternalFallback();
      const generation = zeroStartExternalFallbackGeneration;
      const hostConn = getState('network.hostConn');
      const youtubeSessionId = getCurrentSessionId();
      const deadline = Date.now() + 3_000;
      const context: YouTubeZeroStartTargetContext = {
        role: 'guest',
        queueItemId: event.queueItemId,
        videoId: event.videoId,
        subIndex: getState('youtube.currentSubIndex') ?? null,
      };
      let loadIssued = false;
      let fallbackPlayer: YouTubeZeroStartPlayer | null = null;
      let desiredMuted = false;
      let desiredVolume = 100;

      const abandonFallback = (): void => {
        if (generation !== zeroStartExternalFallbackGeneration) return;
        zeroStartExternalFallbackGeneration += 1;
        clearManagedTimer('yt-zero-start-external-fallback');
        const cleanup = zeroStartExternalFallbackCleanup;
        zeroStartExternalFallbackCleanup = null;
        cleanup?.();
      };

      const attemptFallback = (): void => {
        const snapshot = getYouTubeZeroStartSnapshot();
        if (
          generation !== zeroStartExternalFallbackGeneration ||
          getYouTubeZeroStartRole() !== 'guest' ||
          getState('network.hostConn') !== hostConn ||
          !hostConn?.open ||
          getCurrentSessionId() !== youtubeSessionId ||
          getCurrentQueueItemId() !== event.queueItemId ||
          snapshot?.runId !== event.runId ||
          snapshot.videoId !== event.videoId
        ) {
          abandonFallback();
          return;
        }

        const player = getZeroStartPlayer();
        if (!player) {
          if (Date.now() < deadline) {
            setManagedTimer('yt-zero-start-external-fallback', attemptFallback, 50);
          } else {
            abandonFallback();
          }
          return;
        }

        try {
          if (!loadIssued) {
            fallbackPlayer = player;
            desiredMuted = player.isMuted();
            desiredVolume = player.getVolume();
            zeroStartExternalFallbackCleanup = () => {
              setYtAutoplayIntent(false);
              try {
                fallbackPlayer?.pauseVideo();
                // cueVideoById is the strongest available way to revoke a
                // late autoplay accepted by loadVideoById after our bounded
                // fallback owner has already expired.
                fallbackPlayer?.cueVideoById?.(event.videoId, 0);
                fallbackPlayer?.setVolume(desiredVolume);
                if (desiredMuted) fallbackPlayer?.mute();
                else fallbackPlayer?.unMute();
              } catch {
                // A stale/rebuilt iframe is already prevented from receiving
                // any further fallback commands by the exact identity token.
              }
            };
            loadIssued = true;
            setYtAutoplayIntent(true);
            player.mute();
            player.loadVideoById(event.videoId, 0);
          }
          const currentVideoId = player.getVideoData().video_id ?? '';
          const playerReady = currentVideoId === event.videoId && player.getPlayerState() !== -1;
          if (!playerReady && Date.now() < deadline) {
            setManagedTimer('yt-zero-start-external-fallback', attemptFallback, 50);
            return;
          }
          if (!playerReady) {
            abandonFallback();
            return;
          }

          const releaseWaitMs =
            event.startAtHost !== null && isClockCalibrated()
              ? event.startAtHost - getHostNow()
              : 0;
          if (releaseWaitMs > 0) {
            // The iframe recovered before the authoritative COMMIT deadline.
            // Keep it silent and cued, then revalidate the exact run/connection
            // identity at release instead of letting this guest start early.
            if (Date.now() >= deadline) {
              abandonFallback();
              return;
            }
            const localTarget = resolveZeroStartLocalTarget(0, context);
            player.pauseVideo();
            player.seekTo(localTarget, true);
            setManagedTimer(
              'yt-zero-start-external-fallback',
              attemptFallback,
              Math.max(1, Math.min(releaseWaitMs, deadline - Date.now())),
            );
            return;
          }

          const canonicalTarget = Math.max(
            0,
            event.startAtHost !== null && isClockCalibrated()
              ? (getHostNow() - event.startAtHost) / 1_000
              : (event.targetPositionSec ?? 0),
          );
          const localTarget = resolveZeroStartLocalTarget(canonicalTarget, context);
          player.pauseVideo();
          player.seekTo(localTarget, true);
          player.setVolume(desiredVolume);
          if (desiredMuted) player.mute();
          else player.unMute();
          player.playVideo();
          zeroStartExternalFallbackCleanup = null;
          zeroStartExternalFallbackGeneration += 1;
          log.warn(`[YouTube ZeroStart] Recovered locally: ${event.reason}`);
        } catch (error) {
          if (Date.now() < deadline) {
            setManagedTimer('yt-zero-start-external-fallback', attemptFallback, 50);
          } else {
            log.warn('[YouTube ZeroStart] Local fallback failed:', error);
            abandonFallback();
          }
        }
      };

      log.warn(`[YouTube ZeroStart] Falling back locally: ${event.reason}`);
      try {
        setManagedTimer('yt-zero-start-external-fallback', attemptFallback, 0);
      } catch (error) {
        log.warn('[YouTube ZeroStart] Local fallback failed:', error);
      }
    },
    onHostFallbackRequired: ({ queueItemId, videoId, subIndex, reason }) => {
      recoverZeroStartWithLegacyRendezvous(
        { queueItemId: queueItemId as QueueItemId, videoId, subIndex },
        reason,
      );
    },
    onLearnedTimelineLeadMs: (update) => {
      log.debug('[YouTube ZeroStart] Learned platform lead', update);
    },
    onError: (reason, error) => {
      log.warn(`[YouTube ZeroStart] ${reason}`, error);
    },
    onDebug: (message, detail) => {
      log.debug(`[YouTube ZeroStart] ${message}`, detail);
    },
  });

  const getZeroStartAuthoritySignature = (): string => {
    const room = getRoomContext();
    return [
      room.kind,
      room.roomId ?? '',
      room.role,
      room.coordinatorId ?? '',
      room.epoch,
      getState('network.appRole') ?? '',
      getState('network.hostConn')?.peer ?? '',
    ].join('|');
  };

  const reconcileZeroStartAuthority = (): void => {
    const nextSignature = getZeroStartAuthoritySignature();
    const nextHostConnection = getState('network.hostConn');
    if (
      zeroStartAuthoritySignature &&
      (nextSignature !== zeroStartAuthoritySignature ||
        nextHostConnection !== zeroStartHostConnection)
    ) {
      clearZeroStartExternalFallback();
      clearPendingReplacementFallback();
      resetYouTubeZeroStart();
    }
    zeroStartAuthoritySignature = nextSignature;
    zeroStartHostConnection = nextHostConnection;
    if (getYouTubeZeroStartRole() === 'guest' && nextHostConnection?.open) {
      advertiseYouTubeZeroStartCapability();
    }
  };

  const advertiseZeroStartRuntimeReadiness = (): void => {
    const hostConnection = getState('network.hostConn');
    if (getYouTubeZeroStartRole() !== 'guest' || !hostConnection?.open) return;
    advertiseYouTubeZeroStartCapability();
  };
  zeroStartAuthoritySignature = getZeroStartAuthoritySignature();

  function requestStandardOperatorYouTubeAdd(sourceUrl: string, title: string): boolean {
    const hostConn = getState('network.hostConn');
    if (!hostConn || getRoomContext().kind !== 'standard') return false;
    // A standard guest must never fall through to the local commit path, even
    // if its operator capability is revoked between opening and submitting.
    if (!hasRoomCapability('queue.mutate')) {
      showToast(t('toast.host_only_youtube'));
      return true;
    }
    if (sourceUrl.length > 2048) {
      showToast(t('youtube.invalid_link'));
      return true;
    }
    const normalizedTitle = (title.trim() || sourceUrl).slice(0, 512);
    sendStandardQueueMutationRequest({
      type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
      requestId: createQueueItemId(),
      baseRevision: getState('playlist.revision'),
      sourceUrl,
      title: normalizedTitle,
    });
    return true;
  }

  function isLiveStandardOperatorConnection(conn: DataConnection, roomCode: string): boolean {
    return (
      getRoomContext().kind === 'standard' &&
      getState('network.appRole') === 'host' &&
      !getState('network.hostConn') &&
      getState('network.sessionCode') === roomCode &&
      conn.open === true &&
      getState('network.activeHostConnByPeerId').get(conn.peer) === conn &&
      verifyPeerCapability(conn, 'queue.mutate')
    );
  }

  function sendStandardQueueRequestFailure(
    conn: DataConnection,
    roomCode: string,
    requestId: string,
    code: StandardQueueMutationResultCode,
  ): void {
    if (!isLiveStandardOperatorConnection(conn, roomCode)) return;
    safeSend(conn, {
      type: MSG.PLAYLIST_UPDATE,
      ...createPlaylistSnapshot(),
      refresh: true,
    });
    settleStandardQueueMutationRequest(conn, requestId, {
      outcome: 'rejected',
      code,
    });
  }

  type StandardOperatorYouTubeRequest = {
    requestId: string;
    baseRevision: number;
    sourceUrl: string;
    title: string;
  };

  type PreparedStandardOperatorYouTubeAdd =
    | {
        ok: true;
        videoId: string;
        playlistId: string | null;
        title: string;
      }
    | {
        ok: false;
        code: 'invalid-source' | 'resolution-failed';
      };

  let standardOperatorYouTubeMutationTail: Promise<void> = Promise.resolve();
  let standardOperatorYouTubeMutationRoomCode: string | null = null;

  function prepareStandardOperatorYouTubeAdd(
    data: StandardOperatorYouTubeRequest,
  ): Promise<PreparedStandardOperatorYouTubeAdd> {
    const videoId = extractYouTubeVideoId(data.sourceUrl);
    let playlistId = extractYouTubePlaylistId(data.sourceUrl);
    if (videoId && playlistId?.startsWith('RD')) playlistId = null;
    if (!videoId && !playlistId) {
      log.warn('[YouTube] Rejected operator queue request with a non-YouTube source');
      return Promise.resolve({ ok: false, code: 'invalid-source' });
    }

    if (!videoId && playlistId) {
      return resolveYouTubePlaylistEntry(playlistId)
        .then((entry) => ({
          ok: true as const,
          videoId: entry.videoId,
          playlistId,
          title: data.title === data.sourceUrl ? entry.title : data.title,
        }))
        .catch((error): PreparedStandardOperatorYouTubeAdd => {
          log.warn('[YouTube] Standard operator playlist resolution failed:', error);
          return { ok: false, code: 'resolution-failed' };
        });
    }

    return Promise.resolve({
      ok: true,
      videoId: videoId!,
      playlistId,
      title: data.title,
    });
  }

  async function applyStandardOperatorYouTubeAdd(
    data: StandardOperatorYouTubeRequest,
    conn: DataConnection,
    roomCode: string,
    prepared: Promise<PreparedStandardOperatorYouTubeAdd>,
  ): Promise<void> {
    const resolved = await prepared;
    if (!isLiveStandardOperatorConnection(conn, roomCode)) return;
    if (!resolved.ok) {
      sendStandardQueueRequestFailure(conn, roomCode, data.requestId, resolved.code);
      return;
    }
    if (!canAppendPlaylistItems()) {
      sendStandardQueueRequestFailure(conn, roomCode, data.requestId, 'queue-full');
      return;
    }
    try {
      const actorName = queueActorNameForConnection(conn);
      if (!actorName) {
        sendStandardQueueRequestFailure(conn, roomCode, data.requestId, 'unauthorized');
        return;
      }
      _addYouTubeToPlaylist(
        resolved.videoId,
        resolved.playlistId,
        resolved.title,
        data.sourceUrl,
        actorName,
      );
      if (!isLiveStandardOperatorConnection(conn, roomCode)) return;
      settleStandardQueueMutationRequest(conn, data.requestId, { outcome: 'applied' });
    } catch (error) {
      log.warn('[YouTube] Standard operator queue commit failed:', error);
      sendStandardQueueRequestFailure(conn, roomCode, data.requestId, 'internal-error');
    }
  }

  function enqueueStandardOperatorYouTubeAdd(
    data: StandardOperatorYouTubeRequest,
    conn: DataConnection,
    roomCode: string,
  ): void {
    // Do not let a timed-out resolver from a room that has already ended hold
    // up additions in the next room. The stale task still revalidates its
    // captured room/connection before every side effect.
    if (standardOperatorYouTubeMutationRoomCode !== roomCode) {
      standardOperatorYouTubeMutationRoomCode = roomCode;
      standardOperatorYouTubeMutationTail = Promise.resolve();
    }
    // Resolve playlist metadata immediately and concurrently. Only the commit
    // is serialized, preserving request arrival order without multiplying the
    // resolver's bounded timeout by the number of queued requests.
    const prepared = prepareStandardOperatorYouTubeAdd(data);
    const task = standardOperatorYouTubeMutationTail.then(() =>
      applyStandardOperatorYouTubeAdd(data, conn, roomCode, prepared),
    );
    standardOperatorYouTubeMutationTail = task.catch((error) => {
      log.warn('[YouTube] Standard operator mutation failed:', error);
      sendStandardQueueRequestFailure(conn, roomCode, data.requestId, 'internal-error');
    });
  }

  function handleRequestPlaylistAddYouTube(
    data: StandardOperatorYouTubeRequest,
    conn: DataConnection,
  ): void {
    const fingerprint = JSON.stringify([
      MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
      data.baseRevision,
      data.sourceUrl,
      data.title,
    ]);
    const outcome = acceptStandardQueueMutationRequest({
      conn,
      requestId: data.requestId,
      requestName: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
      fingerprint,
    });
    if (outcome !== 'accepted') {
      if (outcome !== 'unauthorized') {
        safeSend(conn, {
          type: MSG.PLAYLIST_UPDATE,
          ...createPlaylistSnapshot(),
          refresh: true,
        });
      }
      return;
    }
    enqueueStandardOperatorYouTubeAdd(data, conn, getState('network.sessionCode'));
  }

  registerHandlers({
    [MSG.YOUTUBE_PLAY]: handleYouTubePlay,
    [MSG.REQUEST_YOUTUBE_PLAY]: handleRequestYouTubePlay,
    [MSG.REQUEST_YOUTUBE_PAUSE]: handleRequestYouTubePause,
    [MSG.REQUEST_YOUTUBE_TOGGLE]: handleRequestYouTubeToggle,
    [MSG.REQUEST_YOUTUBE_SUB_SEEK]: handleRequestYouTubeSubSeek,
    [MSG.REQUEST_YOUTUBE_PLAYLIST_INFO]: handleRequestYouTubePlaylistInfo,
    [MSG.REQUEST_PLAYLIST_ADD_YOUTUBE]: handleRequestPlaylistAddYouTube,
    [MSG.YOUTUBE_ZERO_START_CAPABILITY]: (data, conn) => {
      if (conn.peer) handleYouTubeZeroStartCapability(conn.peer, data);
    },
    [MSG.YOUTUBE_ZERO_START_PREPARE]: (data, conn) => {
      if (conn.peer) handleYouTubeZeroStartPrepare(conn.peer, data);
    },
    [MSG.YOUTUBE_ZERO_START_ARMED]: (data, conn) => {
      if (conn.peer) handleYouTubeZeroStartArmed(conn.peer, data);
    },
    [MSG.YOUTUBE_ZERO_START_COMMIT]: (data, conn) => {
      if (conn.peer) handleYouTubeZeroStartCommit(conn.peer, data);
    },
    [MSG.YOUTUBE_ZERO_START_ABORT]: (data, conn) => {
      if (conn.peer && handleYouTubeZeroStartAbort(conn.peer, data)) {
        clearZeroStartExternalFallback();
      }
    },
    [MSG.YOUTUBE_ZERO_START_TIMELINE]: (data, conn) => {
      if (conn.peer) handleYouTubeZeroStartTimeline(conn.peer, data);
    },
  });

  bus.on('state:room.context', reconcileZeroStartAuthority);
  bus.on('state:network.appRole', reconcileZeroStartAuthority);
  bus.on('state:network.hostConn', reconcileZeroStartAuthority);
  bus.on('youtube:player-ready', advertiseZeroStartRuntimeReadiness);
  bus.on('youtube:zero-start-readiness-changed', advertiseZeroStartRuntimeReadiness);
  bus.on('sync:latency-update', advertiseZeroStartRuntimeReadiness);
  bus.on('network:peer-connection-replaced', (peerId) => {
    const snapshot = getYouTubeZeroStartSnapshot();
    const target =
      getYouTubeZeroStartRole() === 'host' &&
      snapshot?.inFlight &&
      snapshot.queueItemId &&
      snapshot.videoId
        ? {
            queueItemId: snapshot.queueItemId as QueueItemId,
            videoId: snapshot.videoId,
            subIndex: getState('youtube.currentSubIndex') ?? null,
            peerId,
            token: ++replacementFallbackToken,
          }
        : null;
    handleYouTubeZeroStartPeerConnectionReplaced(peerId);
    if (target) {
      pendingReplacementFallback = target;
      setManagedTimer(
        'yt-zero-start-replacement-fallback',
        () => runPendingReplacementFallback(target),
        1_500,
      );
    }
  });
  bus.on('network:peer-disconnected', (peerId) => {
    handleYouTubeZeroStartPeerDisconnected(peerId);
    const hostConn = getState('network.hostConn');
    if (getYouTubeZeroStartRole() === 'guest' && hostConn?.peer === peerId) {
      clearZeroStartExternalFallback();
      cancelYouTubeZeroStart('authority-changed', false);
    }
  });

  // Bus event handlers from other modules
  bus.on('youtube:stop-mode', (opts) => stopYouTubeMode(opts));

  bus.on('youtube:restore-room-playback', (payload) => {
    const hostConn = getState('network.hostConn');
    if (hostConn) return;

    const playlistId = payload.playlistId ?? null;
    const subIndex = Math.max(0, payload.subIndex ?? 0);
    const subMap = getState('youtube.subItemsMap') || {};
    const hostIds = playlistId ? subMap[playlistId]?.ids : undefined;
    const titles = playlistId ? subMap[playlistId]?.titles || [] : [];
    const videoId = (hostIds && hostIds[subIndex]) || payload.videoId || null;

    if (!videoId && !playlistId) {
      log.warn('[YouTube] restore-room-playback skipped: no videoId or playlistId');
      return;
    }

    const queueItemId = payload.queueItemId as QueueItemId;
    const playlistItem = getQueueItemById(queueItemId);
    if (!playlistItem || playlistItem.type !== 'youtube') return;
    if (!selectQueueItemById(queueItemId)) return;
    setPlaybackTrackMeta(playlistItem);

    const autoplay = payload.autoplay ?? true;
    const positionSeconds =
      typeof payload.positionSeconds === 'number' &&
      Number.isFinite(payload.positionSeconds) &&
      payload.positionSeconds >= 0
        ? payload.positionSeconds
        : 0;
    broadcast({
      type: MSG.YOUTUBE_PLAY,
      videoId,
      playlistId,
      name: payload.name || playlistItem?.name || playlistItem?.title,
      queueItemId,
      // Restore always cues first. The shared-clock action below seeks to the
      // persisted position and applies the final playing/paused state once the
      // iframe is ready, avoiding an audible flash from time zero.
      autoplay: false,
      subIndex,
    });

    if (playlistId && hostIds && hostIds.length > 0) {
      broadcast({
        type: MSG.YOUTUBE_PLAYLIST_INFO,
        playlistId,
        ids: hostIds,
        titles,
      });
    }

    if (getState('player.isFirstTrackLoad')) setState('player.isFirstTrackLoad', false);
    bus.emit(
      'youtube:load',
      videoId || payload.videoId || null,
      playlistId,
      queueItemId,
      false,
      subIndex,
    );
    setPendingAutoSyncOnReady(true, {
      isTrackTransition: false,
      targetTime: positionSeconds,
      subIndex,
      videoId: videoId || payload.videoId || undefined,
      skipSeek: positionSeconds === 0,
      state: autoplay ? 1 : 2,
    });
    schedulePreload();
  });

  bus.on('youtube:load', (videoId, playlistId, queueItemId, autoplay, subIndex) => {
    if (queueItemId !== getCurrentQueueItemId()) return;
    // Deferred-playlist navigation: when a playlist row was added to the
    // queue while the iframe was busy with another track, its sub-items
    // were never indexed. Navigating into it now needs the proper indexing
    // flow with polling — going through plain loadYouTubeVideo would land
    // on the createYouTubePlayer scrape path whose CUED handler reads
    // getPlaylist() once and gives up with an empty list, leaving the
    // iframe stranded in CUED with the loader still up.
    //
    // Treat <= 1 cached IDs as "not yet indexed". _addYouTubeToPlaylist
    // pre-populates the map with the entry-point videoId alone (single-item
    // placeholder so the row's expansion UI isn't empty), which a strict
    // empty-check would mistake for a fully indexed list. Real indexed
    // playlists land at length >= 2 (any genuinely-1-item playlist will
    // simply re-index on each navigation — wasteful but harmless).
    const subMap = getState('youtube.subItemsMap') || {};
    const playlistIdStr = playlistId as string | null;
    const cachedIds = playlistIdStr ? subMap[playlistIdStr]?.ids || [] : [];
    const needsIndex = !!playlistIdStr && cachedIds.length <= 1;

    if (needsIndex) {
      log.info(`[YouTube] Deferred playlist navigation — indexing ${playlistIdStr} before play`);
      const indexingCallback = (ids: string[]): void => {
        if (queueItemId !== getCurrentQueueItemId() || !getQueueItemById(queueItemId)) return;
        showLoader(false);
        if (!ids || ids.length === 0) {
          log.warn(
            `[YouTube] Deferred indexing returned no IDs for ${playlistIdStr} — falling back to entry-point video`,
          );
          showToast(t('youtube.fetch_failed'));
          // Fallback: load the entry-point videoId in single-video mode so
          // the user can at least play that one track. The playlist row
          // stays in the queue but its sub-items list will remain empty
          // until a subsequent successful index attempt.
          loadYouTubeVideo(videoId as string, null, autoplay as boolean, 0);
          return;
        }
        log.info(`[YouTube] Deferred indexing complete: ${ids.length} items for ${playlistIdStr}`);
        updateSubItemIds(playlistIdStr!, ids);

        // Broadcast the freshly indexed IDs to every guest. Without this,
        // the guests are stuck on the single-item placeholder that
        // playlist.ts's initial YOUTUBE_PLAYLIST_INFO broadcast carried
        // (sent before the host had indexed): host saw the full sub-item
        // list after navigating, every guest in the room saw just one row.
        // Titles fill in lazily via per-item YOUTUBE_SUB_TITLE_UPDATE as
        // the host plays through the videos. _triggerPlaylistSnapshot has
        // its own broadcast for the heartbeat-driven snapshot path, but
        // its `subMap empty` guard skips after our updateSubItemIds above.
        const hostConn = getState('network.hostConn');
        if (!hostConn) {
          const subMap = getState('youtube.subItemsMap') || {};
          const titles = subMap[playlistIdStr!]?.titles || [];
          broadcast({
            type: MSG.YOUTUBE_PLAYLIST_INFO,
            playlistId: playlistIdStr,
            ids,
            titles,
          });
        }

        // Expand the row (the deferred-add path left it collapsed because the
        // pre-populated single-item placeholder wasn't a real index) and kick
        // the title fetcher + sub-list UI populate. updateSubItemIds alone
        // gives us the IDs but every row in the expansion UI shows "loading…"
        // until oEmbed titles land — the IDLE indexing callback expands and
        // populates the same way after its 250ms delay.
        const currentPlaylist = getState('playlist.items') || [];
        const actualIdx = findQueueItemIndex(queueItemId, currentPlaylist);
        if (actualIdx !== -1) {
          const updatedPlaylist = [...currentPlaylist];
          updatedPlaylist[actualIdx] = { ...updatedPlaylist[actualIdx], isExpanded: true };
          setState('playlist.items', updatedPlaylist);
          bus.emit('youtube:populate-sub-items', playlistIdStr!, queueItemId);
        }

        const targetSubIdx = (subIndex as number) ?? 0;
        const targetVideoId = ids[targetSubIdx] ?? ids[0];
        // Re-enter loadYouTubeVideo with playlistId=null — the cued playlist
        // is replaced with a single-video load. Sub-item navigation works
        // from here on because subItemsMap is populated.
        loadYouTubeVideo(targetVideoId, null, autoplay as boolean, targetSubIdx);
      };
      // Trigger the iframe to cue the playlist. loadYouTubeVideo arms the
      // indexing session (and shows its loader) itself, AFTER the transient
      // stop, so the session stays scoped to this load. createYouTubePlayer's
      // (needsScrape || indexing) branch fires cuePlaylist, then onPlayerStateChange's
      // CUED handler routes to _pollIndexingPlaylist which fires the callback above.
      loadYouTubeVideo(videoId as string, playlistIdStr, false, 0, { indexingCallback });
      return;
    }

    loadYouTubeVideo(videoId as string, playlistIdStr, autoplay as boolean, subIndex ?? 0);
  });

  bus.on('youtube:toggle-play', () => {
    if (isYtLoadInProgress()) {
      log.debug('[YouTube] Load already in progress, ignoring toggle');
      return;
    }

    const hostConn = getState('network.hostConn');
    const isOperator = getState('network.isOperator');

    if (hostConn && isOperator) {
      // OP sends toggle request — let host decide based on ITS player state
      // (Guest's local player may be desynchronized from host due to ads/buffering)
      const queueItemId = getCurrentQueueItemId();
      if (queueItemId) safeSend(hostConn, { type: MSG.REQUEST_YOUTUBE_TOGGLE, queueItemId });
      return;
    }

    // Non-OP guest: no toggle permission
    if (hostConn) return;

    // Host direct
    const player = getYouTubePlayer();
    if (!player) return;
    try {
      const state = player.getPlayerState();
      const currentTime = readCanonicalYouTubeTime(player);
      const settlingCoordinatorStillPlaying =
        isProCoordinatorYouTubeEndpoint() &&
        !!getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER) &&
        isPlaybackPlayingYouTube();
      if (state === YT.PlayerState.PLAYING || settlingCoordinatorStillPlaying) {
        // PAUSE: immediate, no delay
        cancelYtAutoSync();
        markYtStateBroadcast();
        const queueItemId = getCurrentQueueItemId();
        if (queueItemId) {
          broadcast({
            type: MSG.YOUTUBE_STATE,
            queueItemId,
            state: 2, // PAUSED
            time: currentTime,
            subIndex: getState('youtube.currentSubIndex') ?? -1,
            videoId: player.getVideoData?.()?.video_id || '',
            hostClock: getHostNow(),
          });
        }
        player.pauseVideo();
        rebaseProCoordinatorYouTubeNudgeAnchor(currentTime, getYouTubeDuration(player), false);
        markYtStateBroadcast();
      } else {
        // The first deliberate 0-second play can use the same bounded barrier
        // as a track transition. Resume/seek remains on the mature legacy
        // rendezvous path.
        const videoId = player.getVideoData?.()?.video_id || '';
        if (
          currentTime <= 0.12 &&
          tryBeginYouTubeZeroStart(videoId, getState('youtube.currentSubIndex') ?? null)
        ) {
          return;
        }
        scheduleYtAutoSync(currentTime);
      }
    } catch (e) {
      log.error('[YouTube] Toggle play error:', e);
    }
  });

  bus.on('youtube:local-toggle-play', () => {
    if (isYtLoadInProgress()) {
      log.debug('[YouTube] Load already in progress, ignoring local toggle');
      return;
    }

    const player = getYouTubePlayer();
    if (!player) return;
    try {
      if (player.getPlayerState() === YT.PlayerState.PLAYING) {
        setLocalYouTubePaused(true);
        player.pauseVideo();
      } else {
        setLocalYouTubePaused(false);
        const result = guestRendezvousSync({ silent: true, suppressProgressToast: true });
        if (result.status === 'started' || result.status === 'completed') return;
        // Authorize this play past the onYouTubePlayerStateChange pause-back
        // guard. Without it, a PLAYING transition while autoplay intent is
        // still false gets immediately paused back and the local resume
        // silently fails — every other deliberate play site sets this first.
        setYtAutoplayIntent(true);
        player.playVideo();
      }
    } catch (e) {
      log.error('[YouTube] Local toggle play error:', e);
    }
  });

  bus.on('youtube:auto-play', (intent?: boolean | PendingAutoSyncOptions) => {
    const player = getYouTubePlayer();
    if (!player?.playVideo) return;

    const options: PendingAutoSyncOptions =
      typeof intent === 'object' && intent !== null
        ? intent
        : { isTrackTransition: intent === true };
    const isTrackTransition = options.isTrackTransition === true;
    const zeroStartTarget = options.targetTime ?? 0;
    const zeroStartVideoId = options.videoId || player.getVideoData?.()?.video_id || '';

    if (
      options.zeroStart === true &&
      (options.state ?? 1) === 1 &&
      zeroStartTarget >= 0 &&
      zeroStartTarget <= 0.12 &&
      tryBeginYouTubeZeroStart(
        zeroStartVideoId,
        options.subIndex ?? getState('youtube.currentSubIndex') ?? null,
      )
    ) {
      return;
    }

    if (isTrackTransition) {
      // Block-to-block YT-to-YT track switch (system-playlist navigation
      // between distinct YouTube entries). autoplay=true bypassed the
      // pause-back guard in iframe.ts onStateChange, so without this branch
      // _pendingAutoSyncOnReady would never be consumed and the rendezvous
      // would be skipped entirely — guests would drift relative to the
      // host. Pause + 4s TRACK_TRANSITION mirrors youtube:sub-video-advanced
      // so cross-block transitions match the rendezvous UX users already
      // expect from sub-video transitions inside a single playlist.
      const currentTime = options.targetTime ?? readCanonicalYouTubeTime(player);
      try {
        player.pauseVideo?.();
      } catch {
        /* noop */
      }
      setYtAutoplayIntent(true);
      scheduleYtAutoSync(currentTime, {
        subIndex: options.subIndex,
        videoId: options.videoId,
        skipSeek: options.skipSeek ?? true,
        rendezvousDelayMs: options.rendezvousDelayMs ?? TRACK_TRANSITION_RENDEZVOUS_MS,
      });
      return;
    }

    // First-time URL-input load or pause-back path: the player is ready when
    // this handler runs, so use the standard Stage 2 allowance.
    // Flip intent BEFORE scheduleYtAutoSync so its final playVideo()
    // doesn't get caught by onStateChange's pause-back guard (the guard
    // was armed by loadYouTubeVideo's autoplay=false default).
    const targetState = options.state ?? 1;
    if (targetState === 1) setYtAutoplayIntent(true);
    // Use scheduleYtAutoSync instead of raw playVideo so this path
    // (auto-play after track load or end-of-video auto-advance) goes
    // through the same 2-stage rendezvous broadcast as every other
    // host-initiated YouTube play, keeping guests aligned instead of
    // forcing drift correction to clean up afterwards.
    //
    // skipSeek:true — the freshly loaded video is already at position 0,
    // so seekTo(0) would be a wasted round-trip (and may trigger an
    // unwanted BUFFERING transition on CUED players).
    scheduleYtAutoSync(options.targetTime ?? 0, {
      subIndex: options.subIndex,
      videoId: options.videoId,
      skipSeek: options.skipSeek ?? true,
      rendezvousDelayMs: options.rendezvousDelayMs ?? STAGE2_RENDEZVOUS_BROADCAST_MS,
      state: targetState,
    });
  });

  // YouTube sub-video auto-advance inside a playlist: iframe.ts's
  // updateYouTubeUI detects the sub-index transition and emits this event
  // (ENDED does not fire for intra-playlist boundaries, so the normal
  // playlist:next-track path is bypassed). Re-apply the transition rendezvous
  // here so guests stay aligned across the sub-video boundary.
  bus.on('youtube:sub-video-advanced', () => {
    const player = getYouTubePlayer();
    if (!player?.playVideo) return;

    // Native auto-advance has already entered a different video's timeline.
    // The previous video's settling anchor/applied boundary cannot describe
    // this new video; start from the raw new-video position and re-resolve the
    // participant's requested local offset below.
    if (isProCoordinatorYouTubeEndpoint()) {
      clearProCoordinatorYouTubeNudgeAnchor();
      setState('sync.youtubeCoordinatorAppliedOffset', 0);
    }

    // Force-pause the host regardless of current state. At the moment of
    // detection the player may be in BUFFERING or PLAYING; we want it
    // paused so the transition rendezvous has a deterministic starting point.
    // pauseVideo on a non-playing player is a safe no-op per YT IFrame API.
    try {
      player.pauseVideo?.();
    } catch {
      /* noop */
    }

    // Capture the position the new sub-video has reached so guests seek
    // to the same spot instead of jumping back to 0. getCurrentTime on a
    // just-advanced sub-video is usually a very small value but not always
    // exactly 0 (YouTube may have buffered a few frames ahead).
    const currentTime = (() => {
      try {
        const rawTime = player.getCurrentTime?.() || 0;
        return Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : 0;
      } catch {
        return 0;
      }
    })();

    // Explicitly extract the new videoId from the playlist array instead of
    // relying on player.getVideoData() inside scheduleYtAutoSync. The IFrame API
    // updates getPlaylistIndex() slightly before getVideoData(), causing the host
    // to accidentally broadcast the OLD video's ID with the NEW subIndex. Guests
    // receiving the old ID interpret it as a mismatch, explicitly load the OLD
    // video via loadVideoById(), and wait through a rendezvous on the wrong track.
    let nextIdx = -1;
    let nextVideoId: string | undefined;
    try {
      nextIdx = player.getPlaylistIndex?.() ?? -1;
      const pList = player.getPlaylist?.() || [];
      if (nextIdx >= 0 && nextIdx < pList.length) {
        nextVideoId = pList[nextIdx];
      }
    } catch {
      /* noop */
    }

    // Fallback: the native IFrame API occasionally returns an empty list
    // from getPlaylist() when idle. Pull the cached IDs from our scraped map.
    if (!nextVideoId && nextIdx > 0) {
      const currentTrack = getQueueItemById(getCurrentQueueItemId());
      const pid = currentTrack?.playlistId;
      if (pid) {
        const subMap = getState('youtube.subItemsMap') || {};
        nextVideoId = subMap[pid]?.ids?.[nextIdx];
        log.debug(`[YouTube] Auto-advance cache fallback for index ${nextIdx} -> ${nextVideoId}`);
      }
    }

    // Hijack native auto-advance into single-video mode, send Stage 1
    // immediately, then follow with the usual precision rendezvous.
    if (nextVideoId && nextIdx > 0) {
      log.debug('[YouTube] Hijacking native auto-advance');
      setYouTubeSubIndex(nextIdx); // update highlight immediately
      if (tryBeginYouTubeZeroStart(nextVideoId, nextIdx)) return;
      player.loadVideoById?.(nextVideoId);

      // Reapply the requested coordinator-local nudge against this new
      // video's boundaries; Stage 1 still broadcasts without a delay.
      scheduleYtAutoSync(currentTime, {
        subIndex: nextIdx,
        videoId: nextVideoId,
        rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
      });
      return;
    }

    setYtAutoplayIntent(true); // avoid pause-back guard firing post-sync
    // skipSeek:true — host is already at currentTime after the force-pause,
    // re-seeking would only introduce an extra BUFFERING round-trip.
    // Track transitions use the longer rendezvous allowance so guests can load
    // the new video via loadVideoById before precision synchronization.
    scheduleYtAutoSync(currentTime, {
      subIndex: nextIdx !== -1 ? nextIdx : undefined,
      videoId: nextVideoId,
      skipSeek: true,
      rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
    });
  });

  // URL-input path: once the player initializes, a pending playlist add starts
  // the standard two-stage rendezvous so guests align on first load.
  bus.on('youtube:player-ready', () => {
    const pending = consumePendingAutoSyncOnReady();
    if (!pending) return;
    // Route through youtube:auto-play so we share the same code path as
    // the post-autoPlayTimer flow in playTrack (scheduleYtAutoSync with
    // skipSeek + autoplayIntent flip).
    bus.emit('youtube:auto-play', pending);
  });

  bus.on('youtube:get-position', (callback) => {
    if (typeof callback === 'function') {
      try {
        const player = getYouTubePlayer();
        const pos = player ? readCanonicalYouTubeTime(player) : 0;
        callback(Number.isFinite(pos) && pos >= 0 ? pos : 0);
      } catch {
        callback(0);
      }
    }
  });

  bus.on('youtube:stop-playback', () => {
    const player = getYouTubePlayer();
    if (player?.pauseVideo) {
      const time = readCanonicalYouTubeTime(player);
      scheduleYtAutoSync(time, { state: 2 });
    }
  });

  bus.on('youtube:skip-time', (seconds) => {
    const player = getYouTubePlayer();
    if (!player) return;
    try {
      const duration = player.getDuration();
      const current = toCanonicalYouTubeTime(player.getCurrentTime(), duration);
      let target = current + seconds;
      if (target < 0) target = 0;
      if (target > duration) target = duration;

      const hostConn = getState('network.hostConn');
      if (!hostConn) {
        const state = player.getPlayerState?.() ?? -1;
        // See youtube:seek-to for why we need the midSync check — a pending
        // yt-auto-sync stage-2 delay keeps the player PAUSED while logically
        // we are still in a play session, so a bare seek during that window
        // would skip re-syncing and let the stale target's playVideo fire.
        const midSync = isYouTubeZeroStartProtocolActive() || !!getManagedTimer('yt-auto-sync');
        if (state === 1 || midSync) {
          // Playing (or mid-rendezvous) → (re)schedule auto-sync
          scheduleYtAutoSync(target);
        } else {
          // Actually paused by user → seek immediately, no delay
          markYtStateBroadcast();
          const queueItemId = getCurrentQueueItemId();
          if (queueItemId) {
            broadcast({
              type: MSG.YOUTUBE_STATE,
              queueItemId,
              state: 2,
              time: target,
              subIndex: getState('youtube.currentSubIndex') ?? -1,
              videoId: player.getVideoData?.()?.video_id || '',
              hostClock: getHostNow(),
            });
          }
          player.seekTo(resolveCoordinatorLocalTarget(player, target).localTime, true);
          markYtStateBroadcast();
        }
      } else {
        player.seekTo(target, true);
      }
    } catch (e) {
      log.error('[YouTube] Skip time error:', e);
    }
  });

  // YouTube seek from seek bar
  bus.on('youtube:seek-to', (seconds) => {
    const player = getYouTubePlayer();
    if (!player?.seekTo || !Number.isFinite(seconds)) return;
    try {
      const hostConn = getState('network.hostConn');
      if (!hostConn) {
        const state = player.getPlayerState?.() ?? -1;
        // Mid-sync detection: yt-auto-sync is the stage-2 rendezvous delay
        // before playVideo(). A seek landing in that window (re)schedules a
        // fresh sync instead of slipping through as a bare seek+state=2
        // while the player's reported state is still lying about being PAUSED.
        const midSync = isYouTubeZeroStartProtocolActive() || !!getManagedTimer('yt-auto-sync');
        if (state === 1 || midSync) {
          // Playing (or mid-sync) → (re)schedule auto-sync. scheduleYtAutoSync
          // clears any pending yt-auto-sync up-front, so the old one is
          // naturally superseded.
          scheduleYtAutoSync(seconds);
        } else {
          // Actually paused by user → seek immediately, no delay
          markYtStateBroadcast();
          const queueItemId = getCurrentQueueItemId();
          if (queueItemId) {
            broadcast({
              type: MSG.YOUTUBE_STATE,
              queueItemId,
              state: 2,
              time: seconds,
              subIndex: getState('youtube.currentSubIndex') ?? -1,
              videoId: player.getVideoData?.()?.video_id || '',
              hostClock: getHostNow(),
            });
          }
          player.seekTo(resolveCoordinatorLocalTarget(player, seconds).localTime, true);
          markYtStateBroadcast();
        }
      } else {
        player.seekTo(seconds, true);
      }
    } catch (e) {
      log.error('[YouTube] Seek error:', e);
    }
  });

  bus.on('youtube:try-next-internal', (callback) => {
    if (typeof callback !== 'function') return;
    navigateSubVideo(1, callback);
  });

  bus.on('youtube:try-prev-internal', (callback) => {
    if (typeof callback !== 'function') return;
    const player = getYouTubePlayer();
    if (!player) {
      callback(false);
      return;
    }

    // Special "restart" case: if we've played past the threshold, prev
    // restarts the current track instead of jumping to the previous sub-video.
    try {
      if (readCanonicalYouTubeTime(player) > PREV_TRACK_RESTART_THRESHOLD_SEC) {
        scheduleYtAutoSync(0);
        callback(true);
        return;
      }
    } catch (e) {
      log.debug('[YouTube] try-prev time read error:', e);
    }

    navigateSubVideo(-1, callback);
  });

  // Broadcast throttle: prevents spam if the event is ever emitted rapidly.
  // The heartbeat loop already self-throttles at HEARTBEAT_INTERVAL_MS (3s),
  // but this floor defends against manual/programmatic emits.
  let _lastBroadcastSyncAt = 0;
  bus.on('youtube:broadcast-sync', () => {
    const now = Date.now();
    if (now - _lastBroadcastSyncAt < BROADCAST_SYNC_MIN_INTERVAL_MS) {
      log.debug('[YouTube] broadcast-sync throttled');
      return;
    }
    _lastBroadcastSyncAt = now;
    broadcastYouTubeSync(false);
  });

  // YouTube preview (from URL input)
  bus.on('youtube:preview', (url) => {
    fetchYouTubePreview(url || '');
  });

  function _refreshYouTubeTitle(
    queueItemId: QueueItemId,
    url: string,
    expectedVideoId: string | null,
    expectedPlaylistId: string | null,
  ): void {
    fetchOEmbedTitle(url)
      .then((fetchedTitle) => {
        if (!fetchedTitle) return;

        // A PRO add and this background lookup are serialized by their stable
        // queue occurrence ID, even if the projected row has not arrived yet.
        if (
          handleProRoomTrackMetadata(queueItemId, {
            name: fetchedTitle,
            title: fetchedTitle,
          })
        ) {
          return;
        }

        const currentPlaylist = getState('playlist.items') || [];
        const currentIndex = findQueueItemIndex(queueItemId, currentPlaylist);
        const item = currentIndex >= 0 ? currentPlaylist[currentIndex] : undefined;
        if (item && item.videoId === expectedVideoId && item.playlistId === expectedPlaylistId) {
          const updated = [...currentPlaylist];
          updated[currentIndex] = { ...item, name: fetchedTitle, title: fetchedTitle };
          const titleSnapshot = commitPlaylistItems(updated);
          if (getCurrentQueueItemId() === queueItemId) {
            setPlaybackTrackMeta(updated[currentIndex]);
          }

          // Broadcast updated title to peers (Host only)
          if (!getState('network.hostConn')) {
            broadcast({ type: MSG.PLAYLIST_UPDATE, ...titleSnapshot });
          }
        }
      })
      .catch((e) => log.warn('[YouTube] Title fetch handler error:', e));
  }

  /**
   * Shared helper: add a YouTube entry to the playlist, broadcast, load, and fetch title.
   * Used by both `youtube:load-from-input` and `youtube:load-from-chat`.
   */
  function _addYouTubeToPlaylist(
    videoId: string | null,
    playlistId: string | null,
    title: string,
    url: string,
    actorName = localQueueActorName(),
  ): QueueItemId {
    const playlist = getState('playlist.items') || [];

    // Safety: If this is a playlist load but we have a videoId (resolved from indexing),
    // force single-video mode so the iframe's native playlist engine never runs.
    const finalVideoId = videoId;
    let finalPlaylistId = playlistId;
    if (finalVideoId && finalPlaylistId) {
      finalPlaylistId = null;
      log.debug(
        `[YouTube Index-Add] Forcing single-video mode for playlist ${playlistId} starting with ${videoId}`,
      );
    }

    // Only auto-expand the row when sub-items are actually indexed (length > 1).
    // The deferred-add path pre-populates subMap with a single-item placeholder
    // [entryVideoId]; before this guard, those rows auto-expanded into a
    // sub-list of 1 row with no title, which renders as "불러오는 중..." via
    // playlist-view's video_fallback string. Guests don't auto-expand at all
    // (PLAYLIST_UPDATE doesn't carry isExpanded), so the result was a visible
    // host/guest mismatch where the host showed a "loading…" sub-item and the
    // guest showed just the playlist row title. Holding the row collapsed
    // until indexing actually populates the full list keeps both sides in sync.
    const subMapForExpand = getState('youtube.subItemsMap') || {};
    const hasIndexedSubItems = !!playlistId && (subMapForExpand[playlistId]?.ids?.length || 0) > 1;
    const playlistWasEmpty = playlist.length === 0;
    const isIdle = (isCompatIdle() && playlistWasEmpty) || isYtIndexing();
    const queueItemId = createQueueItemId();
    const newTrack: PlaylistItem = {
      queueItemId,
      type: 'youtube',
      name: title,
      title: title,
      videoId: finalVideoId || null,
      // Preserve original playlistId in state so the playlist UI can still
      // show the sub-item list even when single-video mode is enforced for
      // iframe load. finalPlaylistId (null) is used only for broadcast/load.
      playlistId: playlistId || null,
      isExpanded: hasIndexedSubItems,
    };

    if (playlistId) {
      const subMap = getState('youtube.subItemsMap') || {};
      const existingIds = subMap[playlistId]?.ids || [];
      // Preserve already-indexed source data while an async PRO mutation
      // publishes the projected playlist row.
      if (videoId && existingIds.length <= 1) {
        updateSubItemIds(playlistId, [videoId]);
      }
    }

    if (getState('room.context').kind === 'pro' && hasRoomCapability('queue.mutate')) {
      if (handleProRoomYouTube(newTrack, url)) {
        _refreshYouTubeTitle(queueItemId, url, videoId, playlistId);
        return queueItemId;
      }

      // A playlist-only link added while another track is active may not yet
      // have a concrete entry video. Never leak that row into the ephemeral
      // legacy queue: it would disappear on refresh and diverge from peers.
      showToast(t('youtube.fetch_failed'));
      return queueItemId;
    }

    const updatedPlaylist = [...playlist, newTrack];
    const playlistSnapshot = commitPlaylistItems(updatedPlaylist, {
      currentQueueItemId: isIdle ? queueItemId : getCurrentQueueItemId(),
    });
    bus.emit('playlist:items-added', [queueItemId]);

    // Reveal the track list. Initialize sub-index only in the idle block so
    // already-playing media keeps its managed sub-index.
    if (playlistId) {
      bus.emit('youtube:populate-sub-items', playlistId, queueItemId);
    }

    // Auto-play only when this YouTube entry really IS the first track —
    // i.e. the playlist was empty before this add. The previous idle-only
    // condition misfired when the user had already loaded local tracks but
    // hadn't pressed play yet, so
    // adding a YouTube link jumped playback to it instead of queuing.
    // isYtIndexing keeps its original behavior (mid-index re-add path).
    if (isIdle) {
      setState('player.isFirstTrackLoad', false);
      setPlaybackTrackMeta(newTrack);
      setYouTubeSubIndex(0); // Initialize only a newly active track.

      // Load YouTube with autoplay=FALSE for sync coordination.
      loadYouTubeVideo(finalVideoId, finalPlaylistId, false);
      // Adding a YT entry while IDLE = fresh other-to-yt scenario: host and
      // guests both go through iframe init + first BUFFERING/CUED together,
      // so STAGE2 (2s) is enough. Mark explicitly so we don't fall into the
      // iframe.ts onStateChange `?? true` conservative-fallback path.
      setPendingAutoSyncOnReady(true, {
        isTrackTransition: false,
        zeroStart: true,
        targetTime: 0,
        subIndex: 0,
        videoId: finalVideoId || undefined,
        skipSeek: true,
      });
      selectQueueItemById(queueItemId);
    } else {
      showToast(t('youtube.added_to_playlist'));
    }

    // Broadcast playlist update + YouTube command to peers (Host only)
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      broadcast({ type: MSG.PLAYLIST_UPDATE, ...playlistSnapshot });
      broadcastTracksAdded(actorName, 1);

      if (isIdle) {
        broadcast({
          type: MSG.YOUTUBE_PLAY,
          // Use the single-video-mode-forced IDs so guests receive the same
          // playlist intent host is operating under. handlers.ts reapplies
          // the safeguard, but broadcasting the authoritative pair keeps
          // the payload self-consistent for debugging and future fanout paths.
          videoId: finalVideoId,
          playlistId: finalPlaylistId,
          queueItemId,
          // autoplay=false: guest also loads without iframe auto-start and
          // waits for host's hostPlayAt broadcast from scheduleYtAutoSync.
          autoplay: false,
          subIndex: 0,
        });
      }
    }

    // Fetch title in background and update — capture the expected videoId/playlistId
    // to guard against stale playlist index if the playlist changes before fetch resolves
    _refreshYouTubeTitle(queueItemId, url, videoId, playlistId);

    return queueItemId;
  }

  function _resolveAndAddProPlaylist(
    playlistId: string,
    title: string,
    sourceUrl: string,
  ): boolean {
    const context = getState('room.context');
    if (context.kind !== 'pro' || !hasRoomCapability('queue.mutate')) return false;

    const requestKey = `${context.roomId}:${playlistId}`;
    if (resolvingProPlaylists.has(requestKey)) return true;
    resolvingProPlaylists.add(requestKey);

    const loaderId = `youtube-playlist-entry:${requestKey}`;
    showLoader(true, t('youtube.fetching_info'), loaderId);
    void resolveYouTubePlaylistEntry(playlistId)
      .then((entry) => {
        const currentContext = getState('room.context');
        if (
          currentContext.kind !== 'pro' ||
          currentContext.roomId !== context.roomId ||
          !hasRoomCapability('queue.mutate')
        ) {
          return;
        }

        const existingIds = getState('youtube.subItemsMap')[playlistId]?.ids || [];
        if (existingIds.length === 0) updateSubItemIds(playlistId, [entry.videoId]);
        const resolvedTitle = title && title !== sourceUrl ? title : entry.title;
        _addYouTubeToPlaylist(entry.videoId, playlistId, resolvedTitle, sourceUrl);
      })
      .catch((error) => {
        const currentContext = getState('room.context');
        if (currentContext.kind !== 'pro' || currentContext.roomId !== context.roomId) return;
        log.warn('[YouTube] PRO playlist entry resolution failed:', error);
        showToast(t('youtube.fetch_failed'));
      })
      .finally(() => {
        resolvingProPlaylists.delete(requestKey);
        showLoader(false, undefined, loaderId);
      });
    return true;
  }

  function _closeYouTubeInputOverlay(input?: HTMLElement | null): void {
    const overlay = document.getElementById('youtube-url-overlay');
    if (overlay) overlay.classList.remove('active');
    if (input) input.textContent = '';
    clearYouTubeInputState();
  }

  // YouTube load from input field
  bus.on('youtube:load-from-input', () => {
    if (getState('network.hostConn') && !hasRoomCapability('queue.mutate')) {
      showToast(t('toast.host_only_youtube'));
      return;
    }
    const input = document.getElementById('youtube-url-input') as HTMLElement | null;
    if (!input) return;
    const rawInput = (input.textContent || '').trim();
    if (!rawInput) {
      showToast(t('youtube.enter_source_toast'));
      return;
    }

    const intent = getYouTubeInputIntent(rawInput);
    let videoId = intent.videoId;
    let playlistId = intent.playlistId;
    let sourceUrl = rawInput;
    let titleText = rawInput;

    if (intent.kind === 'search-query') {
      const selected = getSelectedYouTubeSearchResult(rawInput);
      if (!selected) {
        void searchYouTubeFromInput(rawInput);
        return;
      }
      videoId = selected.videoId;
      playlistId = null;
      sourceUrl = selected.url;
      titleText = selected.title || rawInput;
    } else if (intent.kind === 'invalid-url' || intent.kind === 'empty') {
      showToast(t('youtube.invalid_link'));
      return;
    } else {
      const previewTitle = document.getElementById('youtube-preview-title');
      titleText = previewTitle?.textContent?.trim() || rawInput;
    }

    // Filter out Mix playlists (RD...) if a video ID is present to avoid
    // unintentional addition of auto-generated lists (Single-track intent)
    if (videoId && playlistId && playlistId.startsWith('RD')) {
      playlistId = null;
    }

    if (!videoId && !playlistId) {
      showToast(t('youtube.invalid_link'));
      return;
    }

    if (isYouTubeLiveUrl(sourceUrl)) {
      showLiveStreamSyncWarning();
    }

    _closeYouTubeInputOverlay(input);

    if (requestStandardOperatorYouTubeAdd(sourceUrl, titleText)) return;

    // A persistent PRO playlist needs one concrete entry video. Resolve it
    // without borrowing the hidden iframe indexer, which stops active media.
    if (!videoId && playlistId && _resolveAndAddProPlaylist(playlistId, titleText, sourceUrl)) {
      return;
    }

    // Index-before-Add flow for new playlists — only when IDLE. Indexing
    // takes over the iframe (loadYouTubeVideo fires player:stop-all-media
    // unconditionally), which would kill local-audio playback and break
    // the "Add to Queue" contract the button label promises. When
    // something's already playing, defer: add the playlist with just the
    // entry-point videoId, and let playTrack() in playlist.ts handle the
    // real indexing when the user actually plays it. Users pasting a
    // YouTube URL with an auto-attached `&list=PL...` parameter (very
    // common from YouTube share links) hit this path — previously the
    // playlist silently overrode the currently playing local file.
    const subMap = getState('youtube.subItemsMap') || {};
    const playbackIsIdle = isCompatIdle();
    if (playlistId && !subMap[playlistId]?.ids?.length && playbackIsIdle) {
      log.info(
        `[YouTube Index] New playlist detected: ${playlistId}. Starting sequential indexing...`,
      );

      const indexingCallback = (ids: string[]): void => {
        showLoader(false);
        if (!ids || ids.length === 0) {
          showToast(t('youtube.fetch_failed'));
          return;
        }
        log.info(
          `[YouTube Index] Indexing complete! Captured ${ids.length} items. Adding to queue.`,
        );
        updateSubItemIds(playlistId!, ids);

        const addedQueueItemId = _addYouTubeToPlaylist(ids[0], playlistId, titleText, sourceUrl);

        // Force highlight and expansion of the first track with a small delay
        // to ensure the UI has finished adding the item to the DOM.
        setManagedTimer(
          'yt-playlist-indexed-highlight',
          () => {
            const currentPlaylist = getState('playlist.items');
            const actualIdx = findQueueItemIndex(addedQueueItemId, currentPlaylist);
            if (actualIdx !== -1) {
              const updated = [...currentPlaylist];
              updated[actualIdx] = { ...updated[actualIdx], isExpanded: true };
              // Expansion is local UI state and is intentionally excluded
              // from wire snapshots, so it must not consume an authoritative
              // playlist revision.
              setState('playlist.items', updated);
              setYouTubeSubIndex(0);
              bus.emit('youtube:populate-sub-items', playlistId!, addedQueueItemId);
            }
          },
          250,
        );
      };

      // Trigger the player to index (via cuePlaylist in iframe.ts).
      // loadYouTubeVideo arms the indexing session + loader itself
      // (clear-then-arm), keeping the session scoped to this load.
      loadYouTubeVideo(videoId, playlistId, false, 0, { indexingCallback });
    } else {
      _addYouTubeToPlaylist(videoId, playlistId, titleText, sourceUrl);
    }
  });

  // YouTube refresh display (from tab switch)
  bus.on('youtube:refresh-display', () => {
    refreshYouTubeDisplay();
  });

  // YouTube set volume (from audio engine)
  bus.on('youtube:set-volume', (volumePercent) => {
    const player = getYouTubePlayer();
    if (player?.setVolume && Number.isFinite(volumePercent)) {
      const clampedVolume = Math.max(0, Math.min(100, Math.round(volumePercent)));
      const shouldMute = clampedVolume === 0;
      updateYouTubeZeroStartDesiredAudioState({
        muted: shouldMute,
        volume: clampedVolume,
      });
      player.setVolume(clampedVolume);

      // iOS ignores the iframe's software volume in many playback states, but
      // the IFrame API's binary mute state remains effective after audio has
      // been unlocked. Keep the ordinary MUSIXQUARE mute toggle in lockstep
      // with that hard mute. While zero-start is warming the next track, only
      // an unmute must be deferred; its controller restores the latest desired
      // state before arming. Once audio restoration begins, direct changes are
      // safe again and are included in the controller's verification poll.
      const zeroStartPhase = getYouTubeZeroStartSnapshot()?.phase;
      const zeroStartOwnsHardMute =
        zeroStartPhase === 'muting' ||
        zeroStartPhase === 'warming' ||
        zeroStartPhase === 'settling';
      if (shouldMute) player.mute?.();
      else if (!zeroStartOwnsHardMute) player.unMute?.();
    }
  });

  // YouTube sub-item seek (from playlist-view sub-item click)
  bus.on('youtube:sub-seek', (queueItemId, subIdx, _isCurrent) => {
    const player = getYouTubePlayer();
    if (!player?.loadVideoById) return;

    const isCurrentNow = queueItemId === getCurrentQueueItemId();
    if (isCurrentNow) {
      // Same playlist — single-video mode: resolve the videoId from our
      // host-snapshotted subItemsMap and loadVideoById directly. We don't
      // call playVideoAt because that hands control to the iframe's native
      // playlist engine, which we deliberately keep dormant.
      const currentTrack = getQueueItemById(queueItemId);
      if (!currentTrack) return;
      const subMap = getState('youtube.subItemsMap') || {};
      const ids = subMap[currentTrack.playlistId as string]?.ids || [];
      const targetVideoId = ids[subIdx];
      if (!targetVideoId) {
        log.warn(`[YouTube] sub-seek: no videoId at subIdx=${subIdx} in subItemsMap`);
        return;
      }
      setYouTubeSubIndex(subIdx);

      // Pre-emptive title update for instant UI feedback
      const cachedTitle = subMap[currentTrack.playlistId as string]?.titles?.[subIdx];
      if (cachedTitle) {
        updatePlaybackTrackTitle(cachedTitle);
      }

      // Prioritize fetching title for the newly selected index (if missing)
      if (currentTrack.playlistId && ids.length > 0) {
        fetchPlaylistSubTitles(currentTrack.playlistId as string, ids);
      }
      if (tryBeginYouTubeZeroStart(targetVideoId, subIdx)) return;
      player.loadVideoById(targetVideoId);
      scheduleYtAutoSync(0, {
        subIndex: subIdx,
        videoId: targetVideoId,
        skipSeek: true,
        rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
      });
    } else {
      // Different playlist item — load it with the target sub-index
      bus.emit('playlist:play-track', queueItemId, subIdx);
    }
  });

  // Populate sub-items when expanding a YouTube playlist entry
  bus.on('youtube:populate-sub-items', (playlistId, queueItemId) => {
    if (!playlistId) return;

    let ids: string[] = [];
    const player = getYouTubePlayer();

    // 1. Try to get IDs from current player if it matches the requested playlist
    const currentItem = getQueueItemById(queueItemId);

    if (
      player?.getPlaylist &&
      queueItemId === getCurrentQueueItemId() &&
      currentItem?.playlistId === playlistId
    ) {
      try {
        ids = player.getPlaylist() || [];
      } catch (e) {
        log.debug('[YouTube] getPlaylist() not ready:', e);
      }
    }

    // 2. Initial map setup
    if (ids.length > 0) {
      const subMap = getState('youtube.subItemsMap') || {};
      if (!subMap[playlistId]?.ids?.length) {
        updateSubItemIds(playlistId, ids);
      }
    }

    // 3. Trigger background title fetcher (All roles)
    // Full fetch when user explicitly expands the sub-playlist UI
    const currentSubMap = getState('youtube.subItemsMap') || {};
    if (currentSubMap[playlistId]?.ids?.length > 0) {
      fetchPlaylistSubTitles(playlistId, currentSubMap[playlistId].ids, { fullFetch: true });
    }

    // 4. Guest: Request info from Host if sub-item data is missing
    const hostConn = getState('network.hostConn');
    if (hostConn) {
      if (
        !currentSubMap[playlistId] ||
        !currentSubMap[playlistId].ids ||
        currentSubMap[playlistId].ids.length === 0
      ) {
        sendToHost({ type: MSG.REQUEST_YOUTUBE_PLAYLIST_INFO, playlistId });
      }
    }
  });

  // YouTube load from chat message link
  bus.on('youtube:load-from-chat', (url) => {
    if (!url) return;

    // Standard guests cannot mutate the queue. Authenticated PRO members can.
    const hostConn = getState('network.hostConn');
    if (hostConn && !hasRoomCapability('queue.mutate')) {
      showToast(t('toast.host_only_youtube'));
      return;
    }

    const videoId = extractYouTubeVideoId(url);
    let playlistId = extractYouTubePlaylistId(url);

    // Filter out Mix playlists (RD...) if a video ID is present
    if (videoId && playlistId && playlistId.startsWith('RD')) {
      playlistId = null;
    }

    if (!videoId && !playlistId) {
      showToast(t('youtube.invalid_link'));
      return;
    }

    if (isYouTubeLiveUrl(url)) {
      showLiveStreamSyncWarning();
    }

    // Close chat drawer if open
    bus.emit('ui:close-chat-drawer');

    if (requestStandardOperatorYouTubeAdd(url, url)) return;

    if (!videoId && playlistId && _resolveAndAddProPlaylist(playlistId, url, url)) return;

    _addYouTubeToPlaylist(videoId, playlistId, url, url);
  });

  // Host: Send YouTube state to newly connected peer (late-join bootstrap)
  const bootstrapYouTubePeer = (conn: DataConnection): void => {
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState('network.hostConn');
    if (hostConn) return;

    // The iframe can report transient PLAYING while zero-start is warming it
    // under a hard mute. A late joiner is outside the frozen cohort, so defer
    // its ordinary canonical bootstrap until the short protocol/calibration
    // window ends instead of exposing that transient state.
    if (isYouTubeZeroStartProtocolActive()) {
      const peerId = conn.peer || 'unknown';
      setManagedTimer(
        `yt-zero-start-deferred-bootstrap-${peerId}`,
        () => {
          if (conn.open && getState('network.activeHostConnByPeerId').get(peerId) === conn) {
            bootstrapYouTubePeer(conn);
          }
        },
        100,
      );
      return;
    }

    if (!isPlaybackModeYouTube()) return;

    // seekTo may take a moment to become observable through getCurrentTime().
    // A participant arriving inside that window must not receive a snapshot
    // calculated from the old local position and the new applied offset.
    if (getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER)) {
      const peerId = conn.peer || 'unknown';
      setManagedTimer(
        `yt-late-join-pro-nudge-${peerId}`,
        () => bootstrapYouTubePeer(conn),
        IMMEDIATE_ACTION_COOLDOWN_MS,
      );
      return;
    }

    const queueItemId = getCurrentQueueItemId();
    const item = getQueueItemById(queueItemId);

    if (!item || item.type !== 'youtube') return;

    const player = getYouTubePlayer();

    try {
      let ytTime = 0;
      let ytState = 2; // paused

      try {
        if (player?.getCurrentTime) ytTime = readCanonicalYouTubeTime(player);
        if (player?.getPlayerState) ytState = player.getPlayerState();
      } catch (e) {
        log.debug('[YouTube] late-join state read:', e);
      }

      const autoplay = ytState === 1;
      const currentSubIndex = getState('youtube.currentSubIndex') ?? -1;
      const subIdx = currentSubIndex >= 0 ? currentSubIndex : 0;

      // Single-video bootstrap: resolve the videoId the host is currently
      // playing and send THAT as the videoId. Never send the full ID array
      // as playlistId — the guest must load by videoId only so its native
      // playlist engine stays dormant. The original playlistId (string) is
      // still sent for UI context (so the guest knows this video belongs to
      // a playlist), and the host follows up with YOUTUBE_PLAYLIST_INFO to
      // populate the guest's subItemsMap for navigation.
      const subMap = getState('youtube.subItemsMap') || {};
      const hostIds = subMap[item.playlistId as string]?.ids;
      const resolvedVideoId =
        (hostIds && hostIds[subIdx]) || player?.getVideoData?.()?.video_id || item.videoId || null;
      const currentVideoId = resolvedVideoId || '';

      safeSend(conn, {
        type: MSG.YOUTUBE_PLAY,
        videoId: resolvedVideoId,
        // Pass the playlistId string (PL/RD) for UI context only — the guest
        // does NOT load by it. handleYouTubePlay treats videoId as primary
        // when both are present (single-video mode).
        playlistId: item.playlistId || null,
        name: item.name || item.title,
        queueItemId: item.queueItemId,
        autoplay,
        subIndex: subIdx,
      });

      // Also send YOUTUBE_PLAYLIST_INFO so the guest has the sub-items map
      // for navigation (next/prev/sub-seek) and title display.
      if (hostIds && hostIds.length > 0) {
        const titles = subMap[item.playlistId as string]?.titles || [];
        safeSend(conn, {
          type: MSG.YOUTUBE_PLAYLIST_INFO,
          playlistId: item.playlistId as string,
          ids: hostIds,
          titles,
        });
      }

      // Send sync frame immediately. Single-video mode means the guest does
      // a quick loadVideoById (no async playlist engine load), so there's no
      // need to delay. Use YOUTUBE_STATE (with hostPlayAt) whenever host is
      // playing — even at ytTime === 0 — so the guest's auto-sync path
      // handles pause → seek → timed play correctly for a rendezvous-aligned
      // start. YOUTUBE_SYNC suffices only when host is paused.
      // NOTE: only the late-joining conn receives this — existing guests are
      // NOT disturbed (no broadcast, no host pause).
      if (autoplay) {
        safeSend(conn, {
          type: MSG.YOUTUBE_STATE,
          queueItemId: item.queueItemId,
          state: 1,
          time: ytTime,
          subIndex: subIdx,
          videoId: currentVideoId,
          hostPlayAt: getHostNow() + YT_AUTO_SYNC_MS,
          hostClock: getHostNow(),
        });
        scheduleLateJoinRendezvousSync(conn, item.queueItemId, subIdx, currentVideoId);
      } else {
        // Host paused — simple sync frame is fine
        safeSend(conn, {
          type: MSG.YOUTUBE_SYNC,
          queueItemId: item.queueItemId,
          time: ytTime,
          state: ytState,
          subIndex: subIdx,
          videoId: currentVideoId,
          hostClock: getHostNow(),
        });
      }

      log.debug('[YouTube] Bootstrap: sent YouTube state to new peer');
    } catch (e) {
      log.warn('[YouTube] Bootstrap send failed:', e);
    }
  };
  bus.on('network:peer-connected', bootstrapYouTubePeer);
  bus.on('network:peer-connected', (conn) => {
    const hostConn = getState('network.hostConn');
    if (getYouTubeZeroStartRole() === 'guest' && hostConn === conn && conn.open) {
      advertiseYouTubeZeroStartCapability();
    }
  });
  bus.on('network:peer-connected', (conn) => {
    const pending = pendingReplacementFallback;
    if (!pending || conn.peer !== pending.peerId) return;
    setManagedTimer(
      'yt-zero-start-replacement-fallback',
      () => runPendingReplacementFallback(pending),
      0,
    );
  });
  reconcileZeroStartAuthority();

  log.info('[YouTube] Player initialized');
}
