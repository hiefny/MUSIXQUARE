/**
 * MUSIXQUARE — YouTube IFrame API
 *
 * Manages: IFrame API script loading, player creation/destruction,
 * player event callbacks, UI update loop, iOS sync overlay,
 * display refresh workaround.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { clearManagedTimer, delay, setManagedTimer, getManagedTimer } from '../core/timers.ts';
import { broadcast } from '../network/peer.ts';
import { broadcastSystemMessage } from '../chat/protocol.ts';
import { IS_ANDROID, IS_IOS } from '../core/platform.ts';
import { fmtTime } from '../player/transport.ts';
import { setEngineMode } from '../player/video.ts';
import { getCurrentQueueItemId, getQueueItemById } from '../player/queue-model.ts';
import { hasRoomCapability } from '../rooms/authority.ts';
import { handleProRoomTrackMetadata } from '../pro-room/legacy-media-hooks.ts';
import { routeProPlaybackCommand } from '../pro-room/playback-authority-hooks.ts';
import {
  isPlaybackModeYouTube,
  setPlaybackIdle,
  setPlaybackYouTubePaused,
  setPlaybackYouTubePlaying,
  updatePlaybackTrackTitle,
} from '../player/ownership.ts';
import {
  getYouTubePlayer,
  setYouTubePlayer,
  markYtPlayerReady,
  isYtPlayerReady,
  getCurrentSessionId,
  incrementSessionId,
  isYtScriptLoading,
  setYtScriptLoading,
  getYtIOSWatchdog,
  setYtIOSWatchdog,
  replaceYtScope,
  getYtScope,
  isYtLoadInProgress,
  setYtLoadInProgress,
  isYtIndexing,
  getYtIndexingSession,
  beginYtIndexingSession,
  clearYtIndexingSession,
  isYtPrimed,
  setYtPrimed,
  isYtPriming,
  setYtPriming,
  isYtPrimeReady,
  setYtPrimeReady,
  isYtPrimeBouncePending,
  setYtPrimeBouncePending,
  getYtAutoplayIntent,
  setYtAutoplayIntent,
  getCachedYtDuration,
  setCachedYtDuration,
  getCachedYtPlaylistIdx,
  setCachedYtPlaylistIdx,
  setYouTubeSubIndex,
  updateSubItemIds,
  setSubItemsData,
} from './_state.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { fetchPlaylistSubTitles } from './search.ts';
import { resetYouTubeSyncState, suppressDriftUntil, guestRendezvousSync } from './sync.ts';
import {
  PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER,
  resolveProCoordinatorYouTubeTarget,
  toCanonicalYouTubeTime,
} from './local-offset.ts';
import {
  YouTubeAuthorityArmController,
  type YouTubeAuthorityArmCommitResult,
  type YouTubeAuthorityArmPlayer,
  type YouTubeAuthorityTimingMode,
} from './authority-arm.ts';
import {
  consumePendingAutoSyncOnReady,
  isYouTubeZeroStartExternalFallbackActive,
  setPendingAutoSyncOnReady,
} from './player.ts';
import {
  handleYouTubeZeroStartPlayerState,
  isYouTubeZeroStartInFlight,
  isYouTubeZeroStartProtocolActive,
} from './zero-start.ts';
import { getHostNow } from '../network/shared-clock.ts';
import {
  UI_LOOP_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  STATE_BROADCAST_DEDUP_MS,
  LOAD_DRIFT_SUPPRESS_MS,
  IOS_WATCHDOG_MS,
  UNAVAILABLE_STUCK_THRESHOLD_MS,
  CRASH_FAIL_THRESHOLD,
  SCRIPT_LOAD_TIMEOUT_MS,
  REFRESH_DISPLAY_DELAY_MS,
  GUEST_ENDED_FALLBACK_MS,
  YOUTUBE_PRIME_VIDEO_ID,
  YOUTUBE_PRIME_MODE,
  YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS,
  PLAYLIST_SNAPSHOT_DELAY_MS,
  FIRST_TRACK_FISHER_INTERVAL_MS,
  FIRST_TRACK_FISHER_MAX_POLLS,
  VIDEO_DATA_POLL_EVERY_NTH_TICK,
  DURATION_CACHE_EPSILON,
} from './constants.ts';

import type { QueueItemId } from '../types/index.ts';
import type {
  YouTubePlayerInstance,
  YTNamespace,
  YTPlayerConfig,
  YtIndexingSession,
} from './_state.ts';
declare const YT: YTNamespace;
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
    isYouTubeAPIReady?: boolean;
  }
}

const PRO_TITLE_PERSIST_RETRY_MS = 5_000;
const PRO_TITLE_PERSIST_MAX_ATTEMPTS = 3;
const SAME_VIDEO_OCCURRENCE_HANDOFF_TIMER = 'yt-same-video-occurrence-handoff';
const SAME_VIDEO_OCCURRENCE_PAUSE_POLL_MS = 20;
const SAME_VIDEO_OCCURRENCE_PAUSE_TIMEOUT_MS = 500;

/**
 * A persistent iframe cannot distinguish two queue occurrences that point to
 * the same YouTube video: cueVideoById(sameId) may be coalesced and any late
 * CUED event is indistinguishable from the outgoing occurrence. Keep the
 * exact load generation here so playlist.ts can hand the freshly armed
 * zero-start intent directly to the rendezvous owner without waiting for an
 * iframe event that may never arrive.
 */
let pendingSameVideoOccurrenceRestart: {
  sessionId: number;
  queueItemId: QueueItemId | null;
  videoId: string;
  handoffRequested: boolean;
  handoffDeadlineAt: number;
} | null = null;
let preparedSameVideoOccurrenceRestart: {
  player: YouTubePlayerInstance;
  queueItemId: QueueItemId;
  videoId: string;
} | null = null;

function routeCurrentProYouTubeObservation(kind: 'ended' | 'unavailable'): boolean {
  const queueItemId = getCurrentQueueItemId();
  if (!queueItemId) return false;
  const player = getYouTubePlayer();
  const youtubeSubIndex = getState('youtube.currentSubIndex') ?? 0;
  let positionSeconds = 0;
  let durationSeconds: number | null = null;
  let youtubeVideoId: string | null = null;
  try {
    positionSeconds = Math.max(0, player?.getCurrentTime?.() || 0);
    const observedDuration = player?.getDuration?.();
    durationSeconds =
      typeof observedDuration === 'number' &&
      Number.isFinite(observedDuration) &&
      observedDuration > 0
        ? observedDuration
        : null;
    youtubeVideoId = player?.getVideoData?.()?.video_id || null;
  } catch {
    /* fall through to the canonical queue occurrence identity below */
  }
  if (!youtubeVideoId) {
    const item = getQueueItemById(queueItemId);
    if (item?.type === 'youtube') {
      youtubeVideoId = item.playlistId
        ? (getState('youtube.subItemsMap') || {})[item.playlistId]?.ids?.[youtubeSubIndex] || null
        : item.videoId;
    }
  }
  return routeProPlaybackCommand({
    kind,
    queueItemId,
    positionSeconds,
    observedPositionSeconds: positionSeconds,
    durationSeconds,
    mediaKind: 'youtube',
    youtubeSubIndex,
    youtubeVideoId,
  });
}

function clearSameVideoOccurrenceRestart(): void {
  pendingSameVideoOccurrenceRestart = null;
  clearManagedTimer(SAME_VIDEO_OCCURRENCE_HANDOFF_TIMER);
}

function releaseSameVideoOccurrenceRestart(
  restart: NonNullable<typeof pendingSameVideoOccurrenceRestart>,
): void {
  if (pendingSameVideoOccurrenceRestart !== restart) return;
  pendingSameVideoOccurrenceRestart = null;
  clearManagedTimer(SAME_VIDEO_OCCURRENCE_HANDOFF_TIMER);
  if (restart.sessionId === getCurrentSessionId()) setYtLoadInProgress(false);
}

function isCurrentSameVideoOccurrenceRestart(
  restart: NonNullable<typeof pendingSameVideoOccurrenceRestart>,
): boolean {
  return (
    pendingSameVideoOccurrenceRestart === restart &&
    restart.sessionId === getCurrentSessionId() &&
    restart.queueItemId === getCurrentQueueItemId()
  );
}

function completeSameVideoOccurrenceHandoff(
  restart: NonNullable<typeof pendingSameVideoOccurrenceRestart>,
): boolean {
  if (!isCurrentSameVideoOccurrenceRestart(restart)) return false;
  const pending = consumePendingAutoSyncOnReady();
  if (!pending || (pending.videoId && pending.videoId !== restart.videoId)) {
    releaseSameVideoOccurrenceRestart(restart);
    return false;
  }

  clearSameVideoOccurrenceRestart();
  setYtLoadInProgress(false);
  bus.emit('youtube:auto-play', pending);
  return true;
}

function continueSameVideoOccurrenceHandoff(
  restart: NonNullable<typeof pendingSameVideoOccurrenceRestart>,
): void {
  if (!isCurrentSameVideoOccurrenceRestart(restart) || !restart.handoffRequested) {
    releaseSameVideoOccurrenceRestart(restart);
    return;
  }

  const player = getYouTubePlayer();
  if (!player) {
    releaseSameVideoOccurrenceRestart(restart);
    return;
  }
  let state = -1;
  try {
    state = player.getPlayerState?.() ?? -1;
  } catch {
    // The bounded retry below owns recovery from a transient unreadable state.
  }

  if (state === 2 || state === 5 || Date.now() >= restart.handoffDeadlineAt) {
    completeSameVideoOccurrenceHandoff(restart);
    return;
  }

  try {
    player.pauseVideo?.();
  } catch {
    // The timeout still hands control to zero-start, whose hard-mute/load path
    // has its own bounded failure recovery.
  }
  setManagedTimer(
    SAME_VIDEO_OCCURRENCE_HANDOFF_TIMER,
    () => continueSameVideoOccurrenceHandoff(restart),
    SAME_VIDEO_OCCURRENCE_PAUSE_POLL_MS,
  );
}
const persistedResolvedTitleByQueueItem = new Map<
  QueueItemId,
  {
    authorityIdentity: string;
    writeIdentity: string;
    attemptedAtMs: number;
    attempts: number;
  }
>();
const PERSISTED_TITLE_ATTEMPT_MAX_ITEMS = 256;

function rememberPersistedTitleAttempt(
  queueItemId: QueueItemId,
  attempt: {
    authorityIdentity: string;
    writeIdentity: string;
    attemptedAtMs: number;
    attempts: number;
  },
): void {
  // Map insertion order gives us a tiny LRU without another long-lived index.
  // Refreshing an existing item moves it to the back; deleted/old queue items
  // can therefore never accumulate for the lifetime of a persistent iframe.
  persistedResolvedTitleByQueueItem.delete(queueItemId);
  persistedResolvedTitleByQueueItem.set(queueItemId, attempt);
  while (persistedResolvedTitleByQueueItem.size > PERSISTED_TITLE_ATTEMPT_MAX_ITEMS) {
    const oldest = persistedResolvedTitleByQueueItem.keys().next().value as QueueItemId | undefined;
    if (oldest === undefined) break;
    persistedResolvedTitleByQueueItem.delete(oldest);
  }
}

function persistResolvedProYouTubeTitle(
  queueItemId: QueueItemId | null,
  videoId: string,
  resolvedTitle: string,
): boolean {
  if (!queueItemId) return false;

  const roomContext = getState('room.context');
  if (roomContext.kind !== 'pro' || !hasRoomCapability('queue.mutate')) return false;

  const item = getQueueItemById(queueItemId);
  if (!item || item.type !== 'youtube' || item.videoId !== videoId) {
    persistedResolvedTitleByQueueItem.delete(queueItemId);
    return false;
  }

  const name = item.name.trim();
  const title = item.title?.trim();
  if (name !== videoId || (title !== undefined && title !== videoId)) {
    persistedResolvedTitleByQueueItem.delete(queueItemId);
    return false;
  }

  const nextTitle = resolvedTitle.trim();
  if (!nextTitle || nextTitle === videoId) return false;
  const authorityIdentity = `${roomContext.roomId ?? ''}\n${roomContext.epoch}\n${roomContext.coordinatorId ?? ''}`;
  const writeIdentity = `${videoId}\n${nextTitle}`;
  const nowMs = Date.now();
  const previousAttempt = persistedResolvedTitleByQueueItem.get(queueItemId);
  const isSameAttemptSeries =
    previousAttempt?.authorityIdentity === authorityIdentity &&
    previousAttempt.writeIdentity === writeIdentity;
  if (isSameAttemptSeries) {
    if (previousAttempt.attempts >= PRO_TITLE_PERSIST_MAX_ATTEMPTS) return false;
    if (
      nowMs >= previousAttempt.attemptedAtMs &&
      nowMs - previousAttempt.attemptedAtMs < PRO_TITLE_PERSIST_RETRY_MS
    ) {
      return false;
    }
  }

  const accepted = handleProRoomTrackMetadata(queueItemId, {
    name: nextTitle,
    title: nextTitle,
  });
  if (accepted) {
    rememberPersistedTitleAttempt(queueItemId, {
      authorityIdentity,
      writeIdentity,
      attemptedAtMs: nowMs,
      attempts: isSameAttemptSeries ? previousAttempt.attempts + 1 : 1,
    });
  }
  return accepted;
}

export const persistResolvedProYouTubeTitleForTests = persistResolvedProYouTubeTitle;

function resetYouTubePlayerHost(container: HTMLElement): void {
  const playerHost = document.createElement('div');
  playerHost.id = 'youtube-player';
  container.replaceChildren(playerHost);
}

type YouTubeApiReadyTask = {
  onReady: () => void;
  onError?: () => void;
};

const _ytApiReadyTasks: YouTubeApiReadyTask[] = [];

function flushYouTubeApiReadyTasks(): void {
  window.isYouTubeAPIReady = true;
  setYtScriptLoading(false);
  const tasks = _ytApiReadyTasks.splice(0);
  for (const task of tasks) task.onReady();
}

function failYouTubeApiReadyTasks(): void {
  const tasks = _ytApiReadyTasks.splice(0);
  for (const task of tasks) task.onError?.();
}

function runWhenYouTubeApiReady(onReady: () => void, onError?: () => void): void {
  if (window.YT?.Player) {
    onReady();
    return;
  }

  _ytApiReadyTasks.push({ onReady, onError });
  window.onYouTubeIframeAPIReady = flushYouTubeApiReadyTasks;

  if (isYtScriptLoading() || document.querySelector('script[src*="youtube.com/iframe_api"]')) {
    return;
  }

  setYtScriptLoading(true);
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onload = () => {
    setYtScriptLoading(false);
    log.debug('[YouTube] API script loaded');
  };
  tag.onerror = () => {
    log.error('[YouTube] Failed to load API script');
    setYtScriptLoading(false);
    failYouTubeApiReadyTasks();
    tag.remove();
  };
  document.head.appendChild(tag);
}

function ensureYouTubePlayerContainer(): HTMLElement | null {
  const wrapper = document.querySelector('.video-wrapper');
  if (!wrapper) {
    log.warn('[YouTube] .video-wrapper not found');
    return null;
  }

  let container = document.getElementById('youtube-player-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'youtube-player-container';
    container.style.cssText = 'width:100%; height:100%; position:relative;';
    wrapper.appendChild(container);
  }

  if (!container.querySelector('#youtube-player')) {
    resetYouTubePlayerHost(container);
  }

  return container;
}

function hideYouTubeContainerResident(container: HTMLElement): void {
  const wrapper = container.closest('.video-wrapper') as HTMLElement | null;
  if (wrapper) {
    wrapper.style.display = 'flex';
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '0';
    wrapper.style.width = '1px';
    wrapper.style.height = '1px';
    wrapper.style.maxWidth = 'none';
    wrapper.style.margin = '0';
    wrapper.style.opacity = '0';
    wrapper.style.visibility = 'visible';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.overflow = 'hidden';
  }

  container.style.display = 'block';
  container.style.opacity = '0';
  container.style.pointerEvents = 'none';
  container.style.position = 'relative';
  container.style.left = '';
  container.style.top = '';
  container.style.width = '1px';
  container.style.height = '1px';
  container.style.overflow = 'hidden';
}

/**
 * Keep the timers and side effects required by an ACTIVE YouTube player in
 * one place. A freshly-created iframe reaches this through onPlayerReady,
 * while the persistent iOS iframe reaches it immediately after a successful
 * loadVideoById/loadPlaylist call (onPlayerReady does not fire again when an
 * existing YT.Player instance is reused).
 *
 * stopYouTubeMode is the matching deactivation owner: it clears both loops.
 * This symmetry is important for persistent players because the player
 * instance can outlive several playback modes and even room sessions.
 */
function startYouTubeHostHeartbeat(): void {
  if (getState('room.context').kind === 'pro') {
    clearManagedTimer('youtubeSyncLoop');
    return;
  }
  setManagedTimer(
    'youtubeSyncLoop',
    () => {
      bus.emit('youtube:broadcast-sync');
    },
    HEARTBEAT_INTERVAL_MS,
    { interval: true },
  );
}

function ensureYouTubePlaybackRuntime(): void {
  if (!isPlaybackModeYouTube()) return;

  if (!getManagedTimer('youtubeUILoop')) {
    setManagedTimer('youtubeUILoop', updateYouTubeUI, UI_LOOP_INTERVAL_MS, { interval: true });
  }

  const hostConn = getState('network.hostConn');
  if (getState('room.context').kind === 'pro') {
    // PRO playback converges through the server authority runtime. Every PRO
    // endpoint intentionally has hostConn=null, so treating it as a legacy
    // host would create a periodic broadcast with no authoritative consumer.
    clearManagedTimer('youtubeSyncLoop');
  } else if (!hostConn) {
    if (!getManagedTimer('youtubeSyncLoop')) startYouTubeHostHeartbeat();
  } else {
    // A retained iframe can cross a leave/rejoin role change. Never let a
    // former host's broadcaster survive after the same page becomes a guest.
    clearManagedTimer('youtubeSyncLoop');
  }

  bus.emit('audio:apply-youtube-volume');
}

/** Re-arm a missing host heartbeat from the independently-owned UI loop. */
function healYouTubeHostHeartbeat(): void {
  if (getState('room.context').kind === 'pro') {
    clearManagedTimer('youtubeSyncLoop');
    return;
  }
  if (getState('network.hostConn') || getManagedTimer('youtubeSyncLoop')) return;
  startYouTubeHostHeartbeat();
  log.warn('[YouTube] Host heartbeat was missing; restarted from the UI runtime');
}

const LIVE_DURATION_GROWTH_MIN_SEC = 0.2;
const LIVE_DURATION_GROWTH_FRAMES = 3;

// ─── Iframe Runtime State ─────────────────────────────────────────
// All mutable iframe-layer module state in one place. Previously scattered
// as individual `let` bindings; grouping them exposes the full set of
// stateful fields the UI loop and onStateChange handlers touch.

interface IframeRuntime {
  /** Tracks the last known YouTube video title to detect changes. */
  lastVideoTitle: string;
  /**
   * The videoId the duration cache is currently valid for. Needed because
   * player.getDuration() can return the OLD video's duration briefly after
   * loadVideoById — the "lock on first valid read" pattern would otherwise
   * cache the stale value and never update for subsequent videos. Cleared
   * on loadYouTubeVideo / stopYouTubeMode so the next poll refreshes.
   */
  lastDurationVideoId: string;
  /** Rolling counter 0..VIDEO_DATA_POLL_EVERY_NTH_TICK-1; getVideoData()
   *  only fires when this wraps to 0. */
  videoDataPollCount: number;
  /** Cooldown timestamp: prevents duplicate broadcasts from UI + onStateChange. */
  lastStateBroadcast: number;
  /** Last broadcast player state (for state-aware dedup). */
  lastBroadcastState: number;
  /** Consecutive getCurrentTime() failures — trips the crash-recovery rebuild. */
  crashFailCount: number;
  /** Last playlist index that was preempted for auto-advance. Prevents infinite looping within 0.8s */
  lastPreemptIdx: number;
  /** True if we are intercepting a native playlist load via cuePlaylist purely to scrape IDs. */
  isScrapingPlaylist: boolean;
  /** Requested starting index for the active scrape/load session. */
  scrapeStartSubIndex: number | null;
  /** Monotonic load-supersession token for the scrape poll chain. Bumped by
   *  every createYouTubePlayer entry; a poll step whose captured token no
   *  longer matches must die (mirror of YtIndexingSession identity). The
   *  YT→YT reuse path skips stopYouTubeMode (the timer-clear owner), so
   *  without this a stale chain would _finishScrape against the new track. */
  scrapeSession: number;
  /** Timestamp when the player first entered a "stuck" (non-playing) state.
   *  Null while the player is PLAYING/PAUSED, or when one of the legitimate-
   *  stall guards applies (iOS gate, tab hidden, scraping). See the
   *  unavailable-video heuristic in updateYouTubeUI. */
  unavailableStuckSince: number | null;
  /** Last duration sample used for live-stream detection. */
  liveDurationSample: number;
  /** Consecutive frames whose duration kept increasing while playing. */
  liveDurationGrowthFrames: number;
  /** Toast guard so each loaded video warns only once. */
  liveStreamToastShown: boolean;
  /** Last successfully-read playback position, used if the iframe crashes. */
  lastRecoverableTime: number;
  /** Guest-only: run a quiet rendezvous after rebuilding a dead iframe. */
  guestRendezvousAfterReady: boolean;
}

const _ifr: IframeRuntime = {
  lastVideoTitle: '',
  lastDurationVideoId: '',
  videoDataPollCount: 0,
  lastStateBroadcast: 0,
  lastBroadcastState: -1,
  crashFailCount: 0,
  lastPreemptIdx: -1,
  isScrapingPlaylist: false,
  scrapeStartSubIndex: null,
  scrapeSession: 0,
  unavailableStuckSince: null,
  liveDurationSample: 0,
  liveDurationGrowthFrames: 0,
  liveStreamToastShown: false,
  lastRecoverableTime: 0,
  guestRendezvousAfterReady: false,
};

function resetLiveStreamDetection(): void {
  _ifr.liveDurationSample = 0;
  _ifr.liveDurationGrowthFrames = 0;
  _ifr.liveStreamToastShown = false;
}

function updateLiveStreamDetection(rawDuration: number, state: number): void {
  if (_ifr.liveStreamToastShown) return;
  if (state !== 1 || rawDuration <= 0) {
    _ifr.liveDurationSample = rawDuration > 0 ? rawDuration : 0;
    _ifr.liveDurationGrowthFrames = 0;
    return;
  }

  const previous = _ifr.liveDurationSample;
  _ifr.liveDurationSample = rawDuration;

  if (previous <= 0) {
    _ifr.liveDurationGrowthFrames = 0;
    return;
  }

  if (rawDuration - previous >= LIVE_DURATION_GROWTH_MIN_SEC) {
    _ifr.liveDurationGrowthFrames++;
  } else {
    _ifr.liveDurationGrowthFrames = 0;
  }

  if (_ifr.liveDurationGrowthFrames >= LIVE_DURATION_GROWTH_FRAMES) {
    showLiveStreamSyncWarning();
  }
}

export function showLiveStreamSyncWarning(): void {
  if (_ifr.liveStreamToastShown) return;
  _ifr.liveStreamToastShown = true;
  showToast(t('youtube.live_sync_warning'));
}

export function markYtStateBroadcast(): void {
  _ifr.lastStateBroadcast = Date.now();
}

/**
 * Invalidate the duration cache — call after any external `loadVideoById`
 * so the next poll reads the new video's real duration instead of the
 * previous one's stale value.
 */
export function invalidateYtDurationCache(): void {
  setCachedYtDuration(0);
  _ifr.lastDurationVideoId = '';
  resetLiveStreamDetection();
}

// ─── Load YouTube Video ────────────────────────────────────────────

/**
 * Phase 1 — eager pre-create (async, NOT gesture-bound).
 *
 * Builds the hidden iOS prime player with the silent video CUED and lets
 * onYouTubePlayerReady fire, so a READY player exists before the user reaches
 * the join/start tap. Call this early in the setup flow (startHostFlow /
 * startGuestFlow). The actual unlock happens in primeYouTubePlayer() (Phase 2),
 * which MUST run synchronously inside the gesture — that is exactly why the
 * async work (API script + iframe load + onReady) is split out to here. Doing
 * the playVideo() in onReady (async) failed: iOS does not count it as
 * user-initiated, so it never unlocked.
 */
export function precreateYouTubePlayer(): void {
  if (!IS_IOS) return;
  // B-mode only. C (no silent video) cannot durably unlock audible playback,
  // so there is nothing worth pre-creating for it.
  if (YOUTUBE_PRIME_MODE !== 'B' || !YOUTUBE_PRIME_VIDEO_ID) return;
  if (isYtPrimed() || isYtPriming() || isYtPrimeReady()) return;

  const residentPlayer = getYouTubePlayer();
  if (residentPlayer) {
    // An unprimed resident can be left behind when a previous gesture bounce
    // or real playback never reached PLAYING. Reusing that arbitrary stopped
    // video as the next room's "silent" gesture bounce can produce an audible
    // flash and still does not prove that WebKit unlocked it. Rebuild only
    // this failed/unproven case; a genuinely primed resident returned above.
    try {
      residentPlayer.stopVideo?.();
      residentPlayer.destroy?.();
    } catch (e) {
      log.debug('[YouTube Prime] Failed to discard unprimed resident player:', e);
    }
    clearManagedTimer('youtubeUILoop');
    clearManagedTimer('youtubeSyncLoop');
    resetYouTubeSyncState();
    setYouTubePlayer(null);
    bus.emit('youtube:zero-start-readiness-changed');
  }

  const container = ensureYouTubePlayerContainer();
  if (!container) return;

  resetYouTubePlayerHost(container);
  hideYouTubeContainerResident(container);
  setYtPriming(true);
  setYtAutoplayIntent(false);

  runWhenYouTubeApiReady(
    () => {
      if (!isYtPriming() || getYouTubePlayer()) return;
      // Cue (autoplay:0) the silent video; the gesture bounce plays it later.
      createYouTubePlayer(YOUTUBE_PRIME_VIDEO_ID, null, false, 0, { prime: true });
    },
    () => {
      setYtPriming(false);
      log.warn('[YouTube Prime] API load failed; tap-to-play fallback remains available');
    },
  );
}

/**
 * Phase 2 — gesture-bound bounce (synchronous).
 *
 * MUST be called inside a user gesture (join/start tap). If Phase 1 produced a
 * ready player, do an unmuted playVideo() of the cued silent video right here
 * in the gesture call stack so iOS registers a user-initiated audible play and
 * unlocks the iframe; onYouTubePlayerStateChange(PLAYING) then pauses it back
 * and marks the player primed. If the player is not ready yet (user tapped
 * before onReady), do nothing. The ready callback leaves the bounce armed so
 * a later direct media gesture can call this function again synchronously.
 * A rejected/timed-out bounce is retryable for the same reason; no retry ever
 * starts from a timer or another asynchronous callback.
 */
let primeBounceAttempt = 0;

export function primeYouTubePlayer(options: { retryPending?: boolean } = {}): boolean {
  if (!IS_IOS || isYtPrimed()) return false;
  const alreadyPending = isYtPrimeBouncePending();
  if (alreadyPending && !options.retryPending) return true;
  if (!alreadyPending && !isYtPrimeReady()) return false;
  const player = getYouTubePlayer();
  if (!player?.playVideo) return false;

  const attempt = ++primeBounceAttempt;
  clearManagedTimer('yt-prime-bounce-timeout');
  setYtPrimeReady(false);
  setYtPrimeBouncePending(true);
  setYtAutoplayIntent(false);
  try {
    player.unMute?.();
    player.playVideo();
    setManagedTimer(
      'yt-prime-bounce-timeout',
      () => {
        if (attempt !== primeBounceAttempt) return;
        if (!isYtPrimeBouncePending()) return;
        setYtPrimeBouncePending(false);
        // WebKit can accept playVideo() without emitting PLAYING inside our
        // short proof window. Do not spend the only ready gesture opportunity:
        // merely re-arm it for the NEXT explicit gesture. This callback must
        // never call playVideo() itself because it is outside a user gesture.
        if (getYouTubePlayer() === player && isYtPlayerReady() && !isYtPrimed()) {
          setYtPrimeReady(true);
        }
      },
      YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS,
    );
    return true;
  } catch (e) {
    setYtPrimeBouncePending(false);
    // A synchronous player exception does not prove the resident iframe is
    // unusable. Preserve readiness so another direct gesture can retry.
    if (getYouTubePlayer() === player && isYtPlayerReady() && !isYtPrimed()) {
      setYtPrimeReady(true);
    }
    log.warn('[YouTube Prime] gesture bounce failed; tap-to-play fallback remains available', e);
    return false;
  }
}

/**
 * Give an in-gesture iOS prime bounce a short chance to prove PLAYING before
 * a real PRO-room video replaces the silent prime occurrence. Replacing it
 * while the bounce callback is still pending clears the only observable proof
 * that WebKit accepted the gesture and makes the late-join preparation retry
 * as an audio-locked endpoint.
 *
 * Non-iOS clients never arm this state, so the helper is an immediate no-op.
 */
export async function waitForPendingYouTubePrimeBounce(timeoutMs = 600): Promise<boolean> {
  if (!isYtPrimeBouncePending()) return isYtPrimed();
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS));
  while (isYtPrimeBouncePending() && !isYtPrimed() && Date.now() < deadline) {
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  return isYtPrimed();
}

type LoadYouTubeVideoOptions = {
  /**
   * Arm a playlist-indexing session for this load: the callback fires once
   * with the stabilized getPlaylist() IDs (CUED → _pollIndexingPlaylist).
   * Armed INSIDE the load — after the transient stop and scope replacement —
   * so the session can never predate, and thus never survive, the teardown
   * of the load it belongs to (see YtIndexingSession in _state.ts).
   */
  indexingCallback?: (ids: string[]) => void;
};

/**
 * Mark a queue-occurrence transition before youtube:load enters the persistent
 * iframe. This lets an already-resolved playlist row use the same safe
 * single-video restart as a plain watch URL instead of waking YouTube's native
 * playlist engine merely because playlistId is present.
 */
export function prepareSameVideoOccurrenceRestart(
  queueItemId: QueueItemId,
  videoId: string,
): boolean {
  preparedSameVideoOccurrenceRestart = null;
  const player = getYouTubePlayer();
  if (!player || !isPlaybackModeYouTube() || getCurrentQueueItemId() !== queueItemId) return false;
  try {
    if (player.getVideoData?.()?.video_id !== videoId) return false;
  } catch {
    return false;
  }
  preparedSameVideoOccurrenceRestart = { player, queueItemId, videoId };
  return true;
}

/**
 * Complete a same-video/different-occurrence transition after playlist.ts has
 * armed the new occurrence's pending zero-start intent.
 *
 * This is deliberately synchronous. The load call and pending-intent arm run
 * in the same JavaScript task, so a delayed CUED/PLAYING callback from the
 * outgoing occurrence cannot steal the new intent first. Session, queue, and
 * resident-video checks make a superseded handoff a harmless no-op.
 */
export function handoffSameVideoOccurrenceRestart(
  queueItemId: QueueItemId,
  videoId: string,
): boolean {
  const restart = pendingSameVideoOccurrenceRestart;
  if (
    !restart ||
    restart.sessionId !== getCurrentSessionId() ||
    restart.queueItemId !== queueItemId ||
    restart.queueItemId !== getCurrentQueueItemId() ||
    restart.videoId !== videoId
  ) {
    // A stale caller must not tear down a newer occurrence's restart. Release
    // only the record that caller could actually own.
    if (restart?.queueItemId === queueItemId && restart.videoId === videoId) {
      releaseSameVideoOccurrenceRestart(restart);
    }
    return false;
  }

  const player = getYouTubePlayer();
  if (!player) {
    releaseSameVideoOccurrenceRestart(restart);
    return false;
  }
  try {
    const residentVideoId = player.getVideoData?.()?.video_id || '';
    if (residentVideoId && residentVideoId !== videoId) {
      releaseSameVideoOccurrenceRestart(restart);
      return false;
    }
  } catch {
    releaseSameVideoOccurrenceRestart(restart);
    return false;
  }

  restart.handoffRequested = true;
  restart.handoffDeadlineAt = Date.now() + SAME_VIDEO_OCCURRENCE_PAUSE_TIMEOUT_MS;
  clearManagedTimer(SAME_VIDEO_OCCURRENCE_HANDOFF_TIMER);
  continueSameVideoOccurrenceHandoff(restart);
  return true;
}

export function loadYouTubeVideo(
  videoId: string | null,
  playlistId: string | null = null,
  autoplay = true,
  subIndex = 0,
  opts: LoadYouTubeVideoOptions = {},
): void {
  const preparedSameVideoRestart = preparedSameVideoOccurrenceRestart;
  preparedSameVideoOccurrenceRestart = null;
  // A newer load always supersedes an unclaimed same-video handoff.
  clearSameVideoOccurrenceRestart();
  setYtPriming(false);
  setYtPrimeReady(false);
  setYtPrimeBouncePending(false);
  clearManagedTimer('yt-prime-bounce-timeout');
  // A gesture block belongs to one concrete load. A track switch must not
  // inherit either its visible tap gate or the watchdog's elapsed time.
  showYouTubeSyncOverlay(false);
  setYtIOSWatchdog(null);
  _ifr.unavailableStuckSince = null;

  // Reset pre-empt guard on every new load. The guard compares against
  // the iframe's current playlistIdx; if the value is stale from a prior
  // playlist (e.g. lastPreemptIdx=9 then switching to a new playlist
  // that happens to land on index 9), pre-empt would incorrectly block.
  _ifr.lastPreemptIdx = -1;

  const player = getYouTubePlayer();

  // YouTube-to-YouTube transition: reuse the existing player instance
  // instead of destroying and recreating the iframe. On iOS, recreating
  // the iframe resets the user gesture — requiring a tap to play again.
  // loadVideoById/loadPlaylist on the same player preserves the gesture.
  const isYouTubeToYouTube = player?.loadVideoById && isPlaybackModeYouTube();
  let isSameVideoReuse = false;
  if (isYouTubeToYouTube && videoId) {
    try {
      const preparedRestartMatches =
        !opts.indexingCallback &&
        preparedSameVideoRestart?.player === player &&
        preparedSameVideoRestart.queueItemId === getCurrentQueueItemId() &&
        preparedSameVideoRestart.videoId === videoId;
      // Guests always receive a resolved videoId from the coordinator and
      // force playlistId away below; the host can do the same only when
      // playlist.ts explicitly proved this is a new occurrence of the
      // already-resident resolved video. Deferred indexing keeps its native
      // playlist load until the IDs have actually been discovered.
      const resolvedSingleVideoLoad =
        !playlistId || preparedRestartMatches || Boolean(getState('network.hostConn'));
      isSameVideoReuse = resolvedSingleVideoLoad && player.getVideoData?.()?.video_id === videoId;
      if (isSameVideoReuse && playlistId && !opts.indexingCallback) playlistId = null;
    } catch {
      isSameVideoReuse = false;
    }
  }

  if (isYouTubeToYouTube) {
    log.debug('[YouTube] YouTube-to-YouTube transition — reusing player, skipping stop-all-media');
    try {
      // A retained iframe has more media work immediately ahead. stopVideo()
      // can emit ENDED and WebKit may discard reusable playback state; pause
      // the outgoing occurrence instead. The concrete load below replaces it
      // synchronously for both same- and different-video transitions.
      player!.pauseVideo?.();
    } catch {
      /* noop */
    }
    // Light cleanup: reset sync state without destroying the player.
    // yt-seek-play must be cleared too: the full-teardown path
    // (stopYouTubeMode) cancels it, but this skip-teardown reuse branch did not,
    // so a delayed seek-then-play scheduled for the OUTGOING video could fire
    // against the incoming one. loadYouTubeVideo is the single funnel for every
    // YT→YT transition, so clearing here covers all of them; the reuse branch
    // never arms yt-seek-play itself, so no legit in-flight timer is lost.
    clearManagedTimer('yt-clock-action');
    clearManagedTimer('yt-seek-play');
    clearManagedTimer('yt-auto-sync');
    resetYouTubeSyncState();
  } else {
    // Guard: destroy previous player to prevent concurrent player instances
    if (isYtLoadInProgress() && player) {
      try {
        player.stopVideo?.();
        if (typeof player.destroy === 'function') player.destroy();
      } catch {
        /* best-effort cleanup */
      }
      setYouTubePlayer(null);
      bus.emit('youtube:zero-start-readiness-changed');
      const container = document.getElementById('youtube-player-container');
      if (container) resetYouTubePlayerHost(container);
    }
    // Stop existing media BEFORE creating new scope/session — otherwise
    // stopYouTubeMode() (triggered by player:stop-all-media) disposes the
    // new scope immediately, causing the first-ever IFrame API load to abort.
    bus.emit('player:stop-all-media');
  }
  setEngineMode('youtube');

  setCachedYtDuration(0); // Reset duration cache for new video
  _ifr.lastDurationVideoId = ''; // Force duration re-read on next updateYouTubeUI tick
  resetLiveStreamDetection();
  _ifr.lastRecoverableTime = 0;
  _ifr.guestRendezvousAfterReady = false;
  _ifr.lastStateBroadcast = 0; // Allow immediate first broadcast for new session
  _ifr.lastBroadcastState = -1; // Reset so first state is never treated as duplicate
  const sessionId = incrementSessionId();
  if (isSameVideoReuse && videoId) {
    pendingSameVideoOccurrenceRestart = {
      sessionId,
      queueItemId: getCurrentQueueItemId(),
      videoId,
      handoffRequested: false,
      handoffDeadlineAt: 0,
    };
  }
  const scope = replaceYtScope();
  setYtLoadInProgress(true);

  showToast(t('youtube.effects_disabled'));

  const container = ensureYouTubePlayerContainer();
  if (!container) {
    setYtLoadInProgress(false);
    return;
  }

  // Clear-then-arm: any indexing session still armed here belongs to a
  // previous load. On the fresh-create path stopYouTubeMode (reached via the
  // player:stop-all-media emit above) already cleared it, but the YT-to-YT
  // reuse branch never reaches stopYouTubeMode — without this clear, a
  // concurrent non-indexing add mid-index would carry the stale session
  // into createYouTubePlayer, bypassing the single-video-mode enforcement
  // and mis-routing the new load into cuePlaylist.
  const staleIndexing = getYtIndexingSession();
  if (staleIndexing) {
    clearYtIndexingSession();
    // Hide the stale session's loader — unless this same call arms a
    // replacement below, whose own showLoader(true) must not be stomped.
    if (!opts.indexingCallback) showLoader(false);
  }
  if (opts.indexingCallback) {
    beginYtIndexingSession({ playlistId, sessionId, onComplete: opts.indexingCallback });
    showLoader(true, t('youtube.indexing_playlist'));
  }

  if (!window.YT?.Player) {
    runWhenYouTubeApiReady(
      () => {
        // Guard: skip if a timeout already cancelled this load session
        if (getCurrentSessionId() !== sessionId || scope.aborted) {
          log.debug('[YouTube] onYouTubeIframeAPIReady skipped - session changed');
          setYtLoadInProgress(false);
          return;
        }
        createYouTubePlayer(videoId, playlistId, autoplay, subIndex);
      },
      () => {
        setYtLoadInProgress(false);
        clearManagedTimer('yt-load-timeout');
        showToast(t('youtube.load_fail'));
        bus.emit('youtube:stop-mode');
      },
    );
  }

  if (window.YT?.Player) {
    createYouTubePlayer(videoId, playlistId, autoplay, subIndex);
  }

  // Safety timeout
  setManagedTimer(
    'yt-load-timeout',
    () => {
      if (getCurrentSessionId() === sessionId && !scope.aborted && !getYouTubePlayer()) {
        log.warn('[YouTube] Load timeout triggered.');
        setYtLoadInProgress(false);
        showLoader(false);
        showToast(t('youtube.load_timeout'));
        // Don't strand the user in YouTube mode with no player. Drop back to
        // IDLE and let stop-mode tear down the iframe scaffolding so a retry
        // (or any other action) starts from a clean slate.
        bus.emit('youtube:stop-mode');
      }
    },
    SCRIPT_LOAD_TIMEOUT_MS,
  );

  // This event reports media readiness. player-controls projects the current
  // PRO playback capability separately so an in-place grant/revoke can update
  // the affordance without reloading the iframe.
  bus.emit('ui:play-btn-state', true);

  // Keep the fullscreen button visible: .video-wrapper contains the YouTube
  // iframe container targeted by the Fullscreen API.

  setManagedTimer('yt-refresh-display', () => refreshYouTubeDisplay(), REFRESH_DISPLAY_DELAY_MS);
  log.debug('[YouTube] Loaded:', videoId || playlistId, 'autoplay:', autoplay);
}

export interface YouTubeAuthorityPreparationRequest {
  authorityKey: string;
  queueItemId: QueueItemId;
  videoId: string;
  subIndex: number;
  positionSeconds: number;
  timeoutMs?: number;
}

export type YouTubeAuthorityPreparationResult =
  | { ready: true; durationSeconds: number | null; videoId: string; subIndex: number }
  | {
      ready: false;
      reason:
        | 'superseded'
        | 'player-unavailable'
        | 'identity-mismatch'
        | 'audio-locked'
        | 'timeout';
    };

let proAuthorityPreparationGeneration = 0;

/** Participant-local fence for detached post-COMMIT timing observations. */
export function getProYouTubeAuthorityPreparationGeneration(): number {
  return proAuthorityPreparationGeneration;
}

function getYouTubeAuthorityArmPlayer(): YouTubeAuthorityArmPlayer | null {
  const player = getYouTubePlayer();
  if (
    !isYtPlayerReady() ||
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
    !player.getVideoData
  ) {
    return null;
  }
  return player as YouTubeAuthorityArmPlayer;
}

const proAuthorityArm = new YouTubeAuthorityArmController({
  getPlayer: getYouTubeAuthorityArmPlayer,
  getPlatform: () => (IS_IOS ? 'ios' : IS_ANDROID ? 'android' : 'other'),
  isIdentityCurrent: ({ queueItemId, subIndex }) =>
    getState('room.context').kind === 'pro' &&
    getCurrentQueueItemId() === queueItemId &&
    isPlaybackModeYouTube() &&
    (subIndex === null || (getState('youtube.currentSubIndex') ?? 0) === subIndex),
});

/** Whether coordinator-free PRO preparation currently owns iframe hard mute. */
export function proYouTubeAuthorityOwnsHardMute(): boolean {
  return proAuthorityArm.ownsHardMute();
}

/** Keep an in-flight PRO preparation aligned with the latest app volume. */
export function updateProYouTubeAuthorityDesiredAudioState(update: {
  muted?: boolean;
  volume?: number;
}): void {
  proAuthorityArm.updateDesiredAudioState(update);
}

/** Invalidate only coordinator-free PRO iframe preparation work. */
export function cancelYouTubeAuthorityPreparation(): void {
  proAuthorityPreparationGeneration += 1;
  proAuthorityArm.cancelAll();
}

/** Consume iframe states owned by coordinator-free PRO warm-up/release. */
function handleYouTubeAuthorityPlayerState(state: number): boolean {
  return proAuthorityArm.handlePlayerStateChange(state);
}

interface YouTubeAuthorityCommitRequest {
  authorityKey: string;
  queueItemId: QueueItemId;
  videoId: string;
  subIndex: number | null;
  targetSeconds: number;
  executeDelayMs: number;
  timingMode: YouTubeAuthorityTimingMode;
  timelineLeadMs?: number;
}

export function commitYouTubeAuthorityOccurrence(
  request: Readonly<YouTubeAuthorityCommitRequest>,
): Promise<YouTubeAuthorityArmCommitResult> {
  return proAuthorityArm.commit({
    authorityKey: request.authorityKey,
    queueItemId: request.queueItemId,
    videoId: request.videoId,
    subIndex: request.subIndex,
    targetSeconds: request.targetSeconds,
    executeDelayMs: request.executeDelayMs,
    timingMode: request.timingMode,
    timelineLeadMs: request.timelineLeadMs,
  });
}

/**
 * Wait until one exact queue occurrence is locally cueable, then leave it
 * paused at the canonical position. This participant-side PREPARE seam never
 * joins the legacy host/guest zero-start cohort and never starts audible
 * playback.
 */
export async function prepareYouTubeAuthorityOccurrence(
  request: Readonly<YouTubeAuthorityPreparationRequest>,
): Promise<YouTubeAuthorityPreparationResult> {
  proAuthorityArm.cancel();
  const generation = ++proAuthorityPreparationGeneration;
  const timeoutMs = Math.max(500, Math.min(2_300, request.timeoutMs ?? 2_300));
  const startedAt = Date.now();
  let sawDifferentIdentity = false;

  while (Date.now() - startedAt <= timeoutMs) {
    if (generation !== proAuthorityPreparationGeneration) {
      return { ready: false, reason: 'superseded' };
    }
    if (getCurrentQueueItemId() !== request.queueItemId || !isPlaybackModeYouTube()) {
      return { ready: false, reason: 'superseded' };
    }

    const player = getYouTubePlayer();
    if (player) {
      try {
        const liveVideoId = player.getVideoData?.()?.video_id || '';
        if (liveVideoId && liveVideoId !== request.videoId) {
          sawDifferentIdentity = true;
        } else if (liveVideoId === request.videoId && !isYtLoadInProgress()) {
          if (IS_IOS && !isYtPrimed()) {
            return { ready: false, reason: 'audio-locked' };
          }

          const duration = player.getDuration?.() || 0;
          const canonicalPosition = Number.isFinite(request.positionSeconds)
            ? Math.max(
                0,
                duration > 0
                  ? Math.min(request.positionSeconds, Math.max(0, duration - 0.001))
                  : request.positionSeconds,
              )
            : 0;
          const target = resolveProCoordinatorYouTubeTarget(
            canonicalPosition,
            getState('sync.youtubeLocalOffset') || 0,
            duration,
          );
          setState('sync.youtubeCoordinatorAppliedOffset', target.effectiveOffset);
          setYtAutoplayIntent(false);
          setYouTubeSubIndex(request.subIndex);
          const elapsedMs = Date.now() - startedAt;
          const remainingMs = timeoutMs - elapsedMs;
          if (remainingMs < 500) return { ready: false, reason: 'timeout' };
          const armed = await proAuthorityArm.prepare({
            authorityKey: request.authorityKey,
            queueItemId: request.queueItemId,
            videoId: request.videoId,
            subIndex: request.subIndex,
            targetSeconds: target.localTime,
            strategy: 'resident',
            timeoutMs: remainingMs,
            // The app volume is the user intent. During initial iOS entry the
            // persistent iframe can still report the silent-prime hard mute;
            // capturing that transient player bit would make it permanent.
            desiredMuted: (getState('audio.masterVolume') ?? 1) <= 0,
            desiredVolume: Math.max(
              0,
              Math.min(100, Math.round((getState('audio.masterVolume') ?? 1) * 100)),
            ),
          });
          if (generation !== proAuthorityPreparationGeneration) {
            return { ready: false, reason: 'superseded' };
          }
          if (armed.status !== 'ready') {
            if (armed.reason === 'superseded') return { ready: false, reason: 'superseded' };
            if (armed.reason === 'player-unavailable') {
              return { ready: false, reason: 'player-unavailable' };
            }
            if (armed.reason === 'identity-mismatch') {
              return { ready: false, reason: 'identity-mismatch' };
            }
            return { ready: false, reason: 'timeout' };
          }
          setPlaybackYouTubePaused();
          bus.emit('ui:update-play-state', false);
          return {
            ready: true,
            durationSeconds: duration > 0 && Number.isFinite(duration) ? duration : null,
            videoId: liveVideoId,
            subIndex: request.subIndex,
          };
        }
      } catch {
        // The IFrame API can throw while replacing its internal player. Poll
        // until the bounded deadline rather than treating it as permanent.
      }
    }

    await delay(40);
  }

  if (!getYouTubePlayer()) return { ready: false, reason: 'player-unavailable' };
  return { ready: false, reason: sawDifferentIdentity ? 'identity-mismatch' : 'timeout' };
}

// ─── Create YouTube Player (IFrame) ────────────────────────────────

type CreateYouTubePlayerOptions = {
  prime?: boolean;
};

function createYouTubePlayer(
  videoId: string | null,
  playlistId: string | null = null,
  autoplay = true,
  subIndex = 0,
  options: CreateYouTubePlayerOptions = {},
): void {
  const indexing = isYtIndexing();
  const prime = options.prime === true;
  if (!isPlaybackModeYouTube() && !indexing && !prime) {
    // No stale-indexing cleanup needed here: `indexing` is false by the gate
    // above, and indexing-session teardown ownership lives in stopYouTubeMode
    // plus loadYouTubeVideo's clear-then-arm step.
    log.warn('[YouTube] createYouTubePlayer aborted - not in YouTube playback mode');
    setYtLoadInProgress(false);
    return;
  }

  // Supersede the PREVIOUS load's scrape/snapshot machinery. The YT→YT reuse
  // path deliberately skips stopYouTubeMode (the usual owner of these clears,
  // player.ts), so without this a stale scrape poll would _finishScrape
  // against the new track (force-(re)load from 0:00 / spurious fetch_failed),
  // and a stale playlist snapshot / first-track fisher would write the NEW
  // player's list under the OLD pid and broadcast it (cross-device
  // subItemsMap poisoning). Session bump kills the poll chain even if a step
  // is already queued; the timer clears are the cheap belt.
  _ifr.scrapeSession += 1;
  clearManagedTimer('yt-scrape-poll');
  clearManagedTimer('yt-scrape-safety');
  clearManagedTimer('yt-playlist-snapshot');
  clearManagedTimer('yt-first-track-fisher');
  clearSnapshotRetries();

  // Set autoplay intent BEFORE any player API call — onStateChange
  // checks this flag to pause-back if autoplay was not requested.
  // Fixes: loadPlaylist() is async, so pauseVideo() on UNSTARTED is a no-op.
  setYtAutoplayIntent(prime ? false : autoplay);

  // Reset sub-index cache so the sub-video auto-advance detector (in
  // updateYouTubeUI) doesn't mistake the initial index of a freshly loaded
  // track for a mid-playlist transition. The cache is populated on the
  // first updateYouTubeUI tick after the player becomes ready.
  setCachedYtPlaylistIdx(-1);
  _ifr.lastPreemptIdx = -1;

  const hostConn = getState('network.hostConn');
  const needsScrape = !hostConn && playlistId !== null;

  // Defense-in-depth against large-playlist memory exhaustion. Single-video
  // mode is enforced at network ingress (handlers.ts) and the add-to-playlist
  // path, but internal re-entry points still pass both IDs from saved meta:
  // crash recovery reads currentTrackMeta, and the youtube:load bus
  // listener in player.ts is fed raw item.videoId+item.playlistId from
  // playlist.ts. Re-asserting here forces loadVideoById on the reuse path
  // and consistently drops `list` from the fresh-create playerVars, so the
  // YT playlist engine cannot wake up unless we're explicitly scraping or
  // indexing (the only legitimate users of cuePlaylist).
  if (videoId && playlistId && !needsScrape && !indexing) {
    playlistId = null;
  }

  if (needsScrape) {
    _ifr.isScrapingPlaylist = true;
    // Bind the requested start position to this scrape session. Repeated uses
    // of the same playlistId must not inherit the previous queue item's last
    // observed sub-index while getPlaylist() is still being scraped.
    _ifr.scrapeStartSubIndex = subIndex;
    setYouTubeSubIndex(subIndex);
    setYtLoadInProgress(true);
    showToast(t('youtube.loading_large_playlist'));
  } else {
    _ifr.isScrapingPlaylist = false;
    _ifr.scrapeStartSubIndex = null;
  }

  const existingPlayer = getYouTubePlayer();
  if (existingPlayer?.loadVideoById) {
    if (prime) {
      setYtPriming(false);
      setYtPrimed(true);
      bus.emit('youtube:zero-start-readiness-changed');
      setYtLoadInProgress(false);
      return;
    }

    log.debug('[YouTube] Re-using existing player instance');
    try {
      const sameVideoRestart = pendingSameVideoOccurrenceRestart;
      if ((needsScrape || indexing) && playlistId) {
        existingPlayer.cuePlaylist({
          list: playlistId,
          listType: 'playlist',
          index: subIndex,
          startSeconds: 0,
        });
      } else if (playlistId) {
        const playlistArgs = {
          list: playlistId,
          listType: 'playlist',
          index: subIndex,
          startSeconds: 0,
        };
        // loadPlaylist() is a load-and-play command. On iOS an async playlist
        // resolution commonly outlives the initiating tap, so using it while
        // autoplay is disabled needlessly trips the browser's autoplay policy.
        // CUED is already a supported pending-sync handoff below; cue first and
        // let the synchronized play owner issue the eventual playVideo().
        if (!autoplay && existingPlayer.cuePlaylist) existingPlayer.cuePlaylist(playlistArgs);
        else existingPlayer.loadPlaylist(playlistArgs);
      } else if (videoId) {
        // A synchronized track transition must not let the persistent iframe
        // emit a few audible frames before the rendezvous barrier is armed.
        // Cue first when autoplay is disabled; the zero-start coordinator
        // performs the hard-muted load/warm cycle once every participant has
        // received the same transition intent. Older clients still recover
        // through the existing state/sync messages if the room falls back to
        // the legacy path.
        if (
          sameVideoRestart?.sessionId === getCurrentSessionId() &&
          sameVideoRestart.videoId === videoId
        ) {
          // Do not wait for cueVideoById(sameId): WebKit is allowed to coalesce
          // it and emit no fresh CUED event. playlist.ts gets the remainder of
          // this JavaScript task to arm and directly hand off zero-start. Calls
          // outside playlist playback fall back to the former cue behavior on
          // the next task, so a repeated URL load cannot be stranded.
          setManagedTimer(
            SAME_VIDEO_OCCURRENCE_HANDOFF_TIMER,
            () => {
              const restart = pendingSameVideoOccurrenceRestart;
              if (!restart) return;
              if (
                restart.sessionId !== getCurrentSessionId() ||
                restart.videoId !== videoId ||
                restart.queueItemId !== getCurrentQueueItemId()
              ) {
                releaseSameVideoOccurrenceRestart(restart);
                return;
              }
              releaseSameVideoOccurrenceRestart(restart);
              try {
                if (existingPlayer.cueVideoById) existingPlayer.cueVideoById(videoId, 0);
                else existingPlayer.loadVideoById(videoId, 0);
              } catch (error) {
                log.warn('[YouTube] Same-video cue fallback failed', error);
              }
            },
            0,
          );
        } else if (!autoplay && existingPlayer.cueVideoById) {
          existingPlayer.cueVideoById(videoId, 0);
        } else {
          existingPlayer.loadVideoById(videoId);
        }
      }
      // onStateChange handles pausing through the _ytAutoplayIntent flag.
      // loadPlaylist() is async; pauseVideo() on UNSTARTED player is a no-op.
      if (!needsScrape) {
        setYouTubeSubIndex(subIndex);
        // Keep the ordinary readiness poll closed until the new queue
        // occurrence has observed PAUSED (or its short bounded timeout).
        // Otherwise player.ts can consume the pending intent from the old
        // occurrence's PLAYING state before our identity-aware handoff.
        if (!sameVideoRestart) setYtLoadInProgress(false);
      } else {
        // Safety net: the reuse-path scrape relies on onStateChange(CUED) →
        // _pollScrapePlaylist → _finishScrape to clear isScrapingPlaylist +
        // ytLoadInProgress. If CUED never fires (cued-listener race, iframe
        // resumed playback directly without re-entering CUED, etc.) the
        // flags would stay pinned and the next youtube:toggle-play would
        // be silently dropped by isYtLoadInProgress() guards. Force-clear
        // after the maximum scrape window (15 polls × 300ms ≈ 4.5s, plus
        // generous slack). _finishScrape clears this timer on the happy
        // path so we don't double-clear.
        setManagedTimer(
          'yt-scrape-safety',
          () => {
            if (_ifr.isScrapingPlaylist) {
              log.warn(
                '[YouTube] Scrape safety timer fired — forcing isScrapingPlaylist + ytLoadInProgress cleanup',
              );
              _ifr.isScrapingPlaylist = false;
              _ifr.scrapeStartSubIndex = null;
              setYtLoadInProgress(false);
              showLoader(false);
            }
          },
          7000,
        );
      }

      // Suppress heartbeat state-sync for 5s after loading a new video.
      // Without this, the host's heartbeat (state:1 from the PREVIOUS video)
      // arrives before YOUTUBE_STATE and wakes the guest via state-sync
      // (hostState=1, ytState≠1 → playVideo), causing the guest to play
      // from position 0 while the host is still loading.
      if (!autoplay) {
        suppressDriftUntil(LOAD_DRIFT_SUPPRESS_MS);
      }
      // Persistent players do not emit onReady again. Activate the same
      // runtime that a fresh iframe gets in onYouTubePlayerReady; omitting
      // the host heartbeat here made the first manual sync work (one fresh
      // snapshot) and every later sync fail after the 10s snapshot TTL.
      ensureYouTubePlaybackRuntime();
      return;
    } catch (e) {
      log.warn('[YouTube] Failed to reuse player, recreating...', e);
      try {
        existingPlayer.destroy();
      } catch {
        /* best-effort */
      }
      setYouTubePlayer(null);
      bus.emit('youtube:zero-start-readiness-changed');
      const container = document.getElementById('youtube-player-container');
      if (container) resetYouTubePlayerHost(container);
    }
  }

  const playerVars: Record<string, string | number> = {
    autoplay: autoplay ? 1 : 0,
    controls: 0,
    rel: 0,
    modestbranding: 1,
    playsinline: 1,
    origin: window.location.origin,
  };

  if (playlistId) {
    playerVars.listType = 'playlist';
    playerVars.list = playlistId;
    playerVars.index = subIndex;
    if (needsScrape || indexing) playerVars.autoplay = 0;
  }

  const playerOptions: YTPlayerConfig = {
    width: '100%',
    height: '100%',
    playerVars,
    events: {
      onReady: onYouTubePlayerReady,
      onStateChange: onYouTubePlayerStateChange,
      onError: onYouTubePlayerError,
      onAutoplayBlocked: onYouTubeAutoplayBlocked,
    },
  };

  if (videoId) playerOptions.videoId = videoId;

  setYouTubePlayer(new YT.Player('youtube-player', playerOptions));
  setYouTubeSubIndex(subIndex);

  // A11y: add title to iframe once YouTube API creates it
  requestAnimationFrame(() => {
    const iframe = document.querySelector(
      '#youtube-player-container iframe',
    ) as HTMLIFrameElement | null;
    if (iframe) iframe.title = 'YouTube video player';
  });
}

// ─── Player Events ─────────────────────────────────────────────────

function onYouTubePlayerReady(event: { target: YouTubePlayerInstance }): void {
  if (!markYtPlayerReady(event.target)) {
    log.debug('[YouTube] Ignoring stale player ready event');
    return;
  }
  bus.emit('youtube:zero-start-readiness-changed');
  setYtLoadInProgress(false);
  log.debug('[YouTube] Player ready');

  const indexing = isYtIndexing();
  if (isYtPriming() && !isPlaybackModeYouTube() && !indexing) {
    // Phase 1 complete: the silent video is cued and the player is ready. Mark
    // it ready for the gesture-bound bounce (primeYouTubePlayer) — do NOT play
    // here. This onReady is async (outside any user gesture), so a playVideo()
    // now would not register as user-initiated on iOS and would fail to unlock.
    // Keep it muted while cued for safety.
    const player = getYouTubePlayer();
    setYtPriming(false);
    setYtPrimeReady(true);
    setYtAutoplayIntent(false);
    try {
      player?.mute?.();
    } catch {
      /* noop */
    }
    return;
  }

  if (!isPlaybackModeYouTube() && !indexing) {
    log.debug('[YouTube] onPlayerReady skipped - mode changed');
    return;
  }

  const player = getYouTubePlayer();
  const indexingSession = getYtIndexingSession();
  if (indexingSession?.playlistId && player?.cuePlaylist) {
    const subIndex = getState('youtube.currentSubIndex') ?? 0;
    player.cuePlaylist({
      list: indexingSession.playlistId,
      listType: 'playlist',
      index: subIndex,
      startSeconds: 0,
    });
    // Don't start loops or sync yet
    return;
  }

  const currentTrack = getState('player.currentTrackMeta');
  const pid = currentTrack?.playlistId as string;

  // ── Playlist Snapshot & Sync (Host Only) ──
  const hostConn = getState('network.hostConn');
  if (!hostConn && pid) {
    if (_ifr.isScrapingPlaylist && player?.cuePlaylist) {
      log.debug('[YouTube] Cueing playlist for backend scrape...', pid);
      const subIndex = getState('youtube.currentSubIndex') ?? 0;
      player.cuePlaylist({ list: pid, listType: 'playlist', index: subIndex, startSeconds: 0 });
    }

    if (player?.getPlaylist) {
      log.debug('[YouTube] Scheduling host-side playlist snapshot:', pid);
      setManagedTimer(
        'yt-playlist-snapshot',
        () => _triggerPlaylistSnapshot(pid),
        PLAYLIST_SNAPSHOT_DELAY_MS,
      );

      // Aggressive First-Track Fisher: Poll fast to catch the first video ID.
      // Makes the 1st track highlight appear almost instantly even without a v= parameter.
      let fisherCount = 0;
      setManagedTimer(
        'yt-first-track-fisher',
        () => {
          // Same fire-time identity check as _triggerPlaylistSnapshot: the
          // fisher may outlive its arming track — never write another
          // track's video id under the captured pid.
          if ((getState('player.currentTrackMeta')?.playlistId as string | undefined) !== pid) {
            clearManagedTimer('yt-first-track-fisher');
            return;
          }
          try {
            const p = getYouTubePlayer();
            const vid = p?.getVideoData?.()?.video_id;
            if (vid) {
              const subMap = getState('youtube.subItemsMap') || {};
              const existing = subMap[pid]?.ids || [];
              // Only update if we don't have IDs yet, or if it's currently a single-track list
              if (existing.length <= 1) {
                updateSubItemIds(pid, [vid]);
              }
              clearManagedTimer('yt-first-track-fisher');
            }
          } catch {
            /* ignore */
          }
          if (++fisherCount > FIRST_TRACK_FISHER_MAX_POLLS)
            clearManagedTimer('yt-first-track-fisher');
        },
        FIRST_TRACK_FISHER_INTERVAL_MS,
        { interval: true },
      );
    }
  }

  ensureYouTubePlaybackRuntime();

  // Notify anyone waiting for the player to become usable, including the URL
  // input path that starts rendezvous sync after a new instance is ready.
  bus.emit('youtube:player-ready');

  if (_ifr.guestRendezvousAfterReady) {
    _ifr.guestRendezvousAfterReady = false;
    if (getState('network.hostConn')) {
      const result = guestRendezvousSync({ silent: true, suppressProgressToast: true });
      if (result.status !== 'started' && result.status !== 'completed') {
        log.debug(`[YouTube] Guest crash recovery rendezvous deferred: ${result.status}`);
      }
    }
  }
}

/**
 * Poll player.getPlaylist() until the returned ID count stabilizes, then
 * fire the indexing callback with the final list. Used instead of reading
 * getPlaylist() exactly once at CUED, because YouTube populates the list
 * lazily on large playlists.
 */
const INDEXING_POLL_INTERVAL_MS = 300;
const INDEXING_POLL_MAX_ATTEMPTS = 15; // ~4.5s ceiling

function _pollIndexingPlaylist(
  session: YtIndexingSession,
  prevCount: number,
  attempts: number,
): void {
  // Identity guard covers the WHOLE poll body: if the session was cleared or
  // replaced since this step was scheduled (mode exit, concurrent load's
  // clear-then-arm), a stale closure must not touch the player, fire its
  // callback, or clear someone else's session.
  if (getYtIndexingSession() !== session) return;
  const player = getYouTubePlayer();
  if (!player?.getPlaylist) {
    // Player gone — abandon indexing without invoking the callback
    clearYtIndexingSession();
    showLoader(false);
    return;
  }
  const ids = player.getPlaylist() || [];
  const stabilized = ids.length > 0 && ids.length === prevCount;
  const giveUp = attempts >= INDEXING_POLL_MAX_ATTEMPTS;
  if (stabilized || giveUp) {
    log.debug(`[YouTube] Indexing settled at ${ids.length} items after ${attempts} polls`);
    // Clear AFTER the callback runs: _addYouTubeToPlaylist's isIdle check
    // (player.ts `|| isYtIndexing()`) is evaluated synchronously inside the
    // callback and implements the index-then-autoplay contract — clearing
    // first would silently queue the indexed playlist instead of playing it.
    // The callback's own loadYouTubeVideo clears (and may re-arm) the session
    // via clear-then-arm, hence the identity check before the final clear so
    // we never clobber a session armed during the callback.
    session.onComplete(ids);
    if (getYtIndexingSession() === session) clearYtIndexingSession();
    return;
  }
  // Reschedule through the live scope so scope disposal also kills the chain.
  // Safe because indexing-session identity implies ytScope identity (see
  // YtIndexingSession in _state.ts) — a null scope here means the session
  // was already cleared and the top-of-body identity guard ends the chain.
  getYtScope()?.timer(
    'yt-indexing-poll',
    () => _pollIndexingPlaylist(session, ids.length, attempts + 1),
    INDEXING_POLL_INTERVAL_MS,
  );
}

// ─── Scrape polling (mirrors the indexing poll above) ────────────────
// Same lazy-population problem as indexing: the iframe's cuePlaylist call
// returns CUED before YouTube has finished filling getPlaylist(), and seeking
// from a single-video-mode reuse path leaves stale single-item state for a
// few hundred ms. Reading once at CUED captures empty/stale data; polling
// waits for the count to stabilize.
const SCRAPE_POLL_INTERVAL_MS = 300;
const SCRAPE_POLL_MAX_ATTEMPTS = 15; // ~4.5s ceiling

function _pollScrapePlaylist(session: number, prevCount: number, attempts: number): void {
  // Identity guard (mirror of _pollIndexingPlaylist): if the load this chain
  // belongs to was superseded since this step was scheduled (any new
  // createYouTubePlayer bumps scrapeSession — including the YT→YT reuse path
  // that skips stopYouTubeMode's timer clears), a stale closure must not read
  // the new player or run _finishScrape against the new track.
  if (session !== _ifr.scrapeSession) return;
  const player = getYouTubePlayer();
  if (!player?.getPlaylist) {
    _finishScrape(null);
    return;
  }
  const ids = player.getPlaylist() || [];
  const stabilized = ids.length > 0 && ids.length === prevCount;
  if (stabilized) {
    log.debug(`[YouTube] Scrape settled at ${ids.length} items after ${attempts} polls`);
    _finishScrape(ids);
    return;
  }
  if (attempts >= SCRAPE_POLL_MAX_ATTEMPTS) {
    log.warn(`[YouTube] Scrape gave up after ${attempts} polls (last count: ${ids.length})`);
    _finishScrape(ids.length > 0 ? ids : null);
    return;
  }
  setManagedTimer(
    'yt-scrape-poll',
    () => _pollScrapePlaylist(session, ids.length, attempts + 1),
    SCRAPE_POLL_INTERVAL_MS,
  );
}

/**
 * Apply scrape results: update subItemsMap, switch the iframe to single-video
 * mode, dismiss the loader/toast that was shown when scraping started.
 *
 * On null/empty results we fall back to the entry-point videoId rather than
 * leaving the iframe stranded in CUED — the previous one-shot path silently
 * returned to native playback, but with autoplay=false it would just sit
 * there forever, which is exactly the "infinite loading" symptom on the
 * deferred-playlist navigation flow.
 */
function _finishScrape(ids: string[] | null): void {
  // Happy-path completion — cancel the safety net armed in createYouTubePlayer's
  // reuse-needsScrape branch. No-op when scrape was started fresh (no timer).
  clearManagedTimer('yt-scrape-safety');
  _ifr.isScrapingPlaylist = false;
  setYtLoadInProgress(false);
  showLoader(false);

  const requestedSubIdxRaw = _ifr.scrapeStartSubIndex ?? getState('youtube.currentSubIndex') ?? 0;
  const requestedSubIdx = Number.isFinite(requestedSubIdxRaw) ? requestedSubIdxRaw : 0;
  _ifr.scrapeStartSubIndex = null;

  const player = getYouTubePlayer();
  if (!player) return;

  const currentTrack = getQueueItemById(getState('playlist.currentQueueItemId'));
  const pid = currentTrack?.playlistId as string | undefined;

  if (ids && ids.length > 0) {
    const subIdx = Math.max(0, Math.min(requestedSubIdx, ids.length - 1));
    if (pid) updateSubItemIds(pid, ids);
    log.debug('[YouTube] Scrape captured IDs — switching to single-video mode');
    setYouTubeSubIndex(subIdx);
    const targetVideoId = ids[subIdx] || ids[0];
    if (!getYtAutoplayIntent() && player.cueVideoById) {
      player.cueVideoById(targetVideoId, 0);
    } else {
      player.loadVideoById?.(targetVideoId, 0);
      if (getYtAutoplayIntent() && player.playVideo) player.playVideo();
    }
    return;
  }

  log.warn('[YouTube] Scrape returned no IDs — falling back to entry-point video');
  showToast(t('youtube.fetch_failed'));
  const entryVideoId = currentTrack?.videoId as string | undefined;
  if (entryVideoId) {
    setYouTubeSubIndex(0);
    if (!getYtAutoplayIntent() && player.cueVideoById) {
      player.cueVideoById(entryVideoId, 0);
    } else {
      player.loadVideoById?.(entryVideoId, 0);
      if (getYtAutoplayIntent() && player.playVideo) player.playVideo();
    }
  }
}

function onYouTubePlayerError(event: { data: number }): void {
  const code = event.data;

  // Prime-time error (e.g. silent prime video unavailable): abandon the prime
  // silently and keep the tap-to-play fallback. Must bail before the toast /
  // next-track advance below — priming is a background op with no active
  // YouTube session, so user-facing recovery would be wrong here.
  if (isYtPriming() || isYtPrimeBouncePending()) {
    const failedBounce = isYtPrimeBouncePending();
    const primePlayer = getYouTubePlayer();
    log.warn('[YouTube Prime] player error during prime; tap-to-play fallback remains', code);
    setYtPriming(false);
    setYtPrimeBouncePending(false);
    setYtPrimed(false);
    // Treat a bounce error as retryable while the exact resident player is
    // still ready. The retry itself is deliberately deferred until another
    // explicit gesture calls primeYouTubePlayer().
    setYtPrimeReady(failedBounce && primePlayer !== null && isYtPlayerReady());
    bus.emit('youtube:zero-start-readiness-changed');
    clearManagedTimer('yt-prime-bounce-timeout');
    setYtLoadInProgress(false);
    return;
  }

  log.error('[YouTube] Player error:', code);
  setYtLoadInProgress(false);
  showLoader(false);

  // Indexing in progress when the player errors out (e.g. invalid playlistId,
  // error 150): drop the session so a subsequent Add-playlist attempt for a
  // different ID doesn't fire the stale callback and corrupt the cached
  // sub-items. The loader is already hidden unconditionally above.
  const wasIndexing = isYtIndexing();
  if (wasIndexing) {
    clearYtIndexingSession();
  }

  // Mode gate — mirror of onYouTubePlayerStateChange below. stopYouTubeMode
  // RETAINS the player on iOS (gesture preservation), so a late embed-check
  // error from an abandoned video can arrive AFTER the room left YouTube
  // mode; toasting or advancing the file/system-audio world here would skip
  // the track the user just chose, room-wide. Indexing errors still pass —
  // the add-playlist flow needs its failure feedback below (but never the
  // playlist advance; see the wasIndexing return in the unavailable branch).
  if (!isPlaybackModeYouTube() && !wasIndexing) return;

  // Unavailable video (100 = removed/private, 101 & 150 = embed disabled):
  // there is no recovery path on this track — advance past it so the user
  // isn't stranded. Host runs the advance logic; guests just show the
  // toast and wait for the host's next-track broadcast (mirroring the
  // ENDED handler's ownership model).
  const UNAVAILABLE_CODES = new Set([100, 101, 150]);
  if (UNAVAILABLE_CODES.has(code)) {
    // Ignore stale/spurious unavailable-code errors that must NOT advance the
    // room playlist:
    //   (a) the silent prime video — it can fire a late 100/101/150 during the
    //       prime→real transition (stopVideo + loadVideoById on the reused iOS
    //       iframe) and is never a real room track;
    //   (b) any such error while the player is actually PLAYING — a genuinely
    //       unavailable video can't be in the PLAYING state, so it's a
    //       transition artifact, not a real failure.
    const errPlayer = getYouTubePlayer();
    let erroredVid = '';
    let errState: number | undefined;
    try {
      erroredVid = errPlayer?.getVideoData?.()?.video_id || '';
      errState = errPlayer?.getPlayerState?.();
    } catch {
      /* player in a bad state — fall through to the normal advance */
    }
    if (
      (erroredVid && erroredVid === YOUTUBE_PRIME_VIDEO_ID) ||
      errState === YT.PlayerState.PLAYING
    ) {
      log.debug(
        `[YouTube] Ignoring spurious unavailable error ${code} (vid=${erroredVid}, state=${errState})`,
      );
      return;
    }
    // Identity guard — generalizes the prime special-case above: when we can
    // read BOTH which video errored and which video the room currently
    // intends, a mismatch means the error belongs to a superseded load (the
    // YT→YT reuse path keeps the player instance, so the old video's late
    // embed-check error lands on the new track's watch). Advancing here
    // would skip the just-selected track. Empirically late errors deliver
    // before getVideoData() flips to the new load (the prime guard relies on
    // the same ordering), so a provable mismatch is safe to drop; when
    // either side is unreadable, preserve the fallback behavior below.
    const intendedTrack = getQueueItemById(getState('playlist.currentQueueItemId'));
    const intendedPid = intendedTrack?.playlistId as string | undefined;
    const intendedSubIdx = getState('youtube.currentSubIndex') ?? 0;
    const intendedSubIds = intendedPid
      ? (getState('youtube.subItemsMap') || {})[intendedPid]?.ids || []
      : [];
    const intendedVid =
      (intendedSubIds[intendedSubIdx] as string | undefined) ||
      (intendedTrack?.videoId as string | undefined) ||
      '';
    if (!wasIndexing && erroredVid && intendedVid && erroredVid !== intendedVid) {
      log.debug(
        `[YouTube] Ignoring stale unavailable error ${code} (vid=${erroredVid}, intended=${intendedVid})`,
      );
      return;
    }
    showToast(t('youtube.video_unavailable'));
    // Add-flow failure (indexing an invalid/unavailable playlist): the error
    // belongs to the ADD attempt, not the room's current track — feedback
    // only, never advance the playing queue.
    if (wasIndexing) return;
    if (routeCurrentProYouTubeObservation('unavailable')) return;
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      broadcastSystemMessage('youtube.video_unavailable');
      let advanced = false;
      bus.emit('youtube:try-next-internal', (ok: boolean) => {
        advanced = ok;
      });
      if (!advanced) bus.emit('playlist:next-track');
    }
    return;
  }

  // Generic fallback (e.g. code 2 invalid param, code 5 HTML5 engine)
  showToast(t('youtube.load_fail'));
  routeCurrentProYouTubeObservation('unavailable');
}

/**
 * Browser autoplay policy is not a media failure. Playlist indexing is
 * asynchronous, so iOS can legitimately lose the user-gesture window before
 * the resolved first video reaches playVideo(). Keep the selected occurrence
 * in place and ask for one explicit tap instead of letting the unavailable
 * watchdog advance to the second item.
 */
function onYouTubeAutoplayBlocked(event: { target: YouTubePlayerInstance }): void {
  if (event.target !== getYouTubePlayer()) return;
  if (!isPlaybackModeYouTube() || isYtIndexing() || isYtPriming()) return;
  if (!getCurrentQueueItemId() || !getYtAutoplayIntent()) return;

  log.info('[YouTube] Scripted playback was blocked; waiting for an explicit user tap');
  _ifr.unavailableStuckSince = null;
  showLoader(false);
  showYouTubeSyncOverlay(true);
}

function onYouTubePlayerStateChange(event: { data: number }): void {
  const indexing = isYtIndexing();
  const player = getYouTubePlayer();
  if (!player) return; // Player destroyed during async state transition
  const state = event.data;

  const sameVideoRestart = pendingSameVideoOccurrenceRestart;
  if (sameVideoRestart && isCurrentSameVideoOccurrenceRestart(sameVideoRestart)) {
    // Quarantine callbacks from the outgoing occurrence until pause has
    // established an ordering boundary. In particular, neither a late CUED
    // nor a late PLAYING may consume the new queue occurrence's pending start.
    if (sameVideoRestart.handoffRequested && state === YT.PlayerState.PAUSED) {
      completeSameVideoOccurrenceHandoff(sameVideoRestart);
    }
    return;
  }

  if (
    state === YT.PlayerState.PLAYING &&
    (isYtPrimeBouncePending() || (isYtPrimeReady() && !isPlaybackModeYouTube() && !indexing))
  ) {
    setYtPrimeBouncePending(false);
    setYtPrimeReady(false);
    setYtPrimed(true);
    bus.emit('youtube:zero-start-readiness-changed');
    clearManagedTimer('yt-prime-bounce-timeout');
    setYtAutoplayIntent(false);
    try {
      player.pauseVideo?.();
    } catch (e) {
      log.debug('[YouTube Prime] pause after bounce failed:', e);
    }
    return;
  }

  // The persistent iframe can deliver the silent prime video's final
  // PLAYING/PAUSED transition after loadYouTubeVideo has already cleared the
  // bounce flag and claimed YouTube mode for a real track. Never project that
  // stale transition into room playback state or broadcast the prime video to
  // guests. A PLAYING straggler is paused defensively to avoid an audio flash.
  let stateVideoId = '';
  try {
    stateVideoId = player.getVideoData?.()?.video_id || '';
  } catch {
    /* unreadable transition identity; use the normal guarded path below */
  }
  const intendedTrack = getQueueItemById(getState('playlist.currentQueueItemId'));
  const intendedVideoId =
    (intendedTrack?.videoId as string | undefined) ||
    (getState('player.currentTrackMeta')?.videoId as string | undefined) ||
    '';
  if (
    isPlaybackModeYouTube() &&
    YOUTUBE_PRIME_VIDEO_ID &&
    stateVideoId === YOUTUBE_PRIME_VIDEO_ID &&
    intendedVideoId !== YOUTUBE_PRIME_VIDEO_ID
  ) {
    if (state === YT.PlayerState.PLAYING) player.pauseVideo?.();
    log.debug(`[YouTube Prime] Ignoring stale state ${state} after real-video takeover`);
    return;
  }

  // The zero-start controller owns every transient player state produced by
  // its hard-muted warm-up. Consume those events before they can mutate the
  // ordinary playback projection, UI, queue progression, or room broadcast.
  // On the real release PLAYING the controller first closes its in-flight
  // phase and returns false, so that one event continues through the normal
  // path below exactly once.
  if (handleYouTubeAuthorityPlayerState(state)) return;
  if (handleYouTubeZeroStartPlayerState(state)) return;
  if (isYouTubeZeroStartExternalFallbackActive()) return;

  if (!isPlaybackModeYouTube() && !indexing) return;

  if (state === YT.PlayerState.PLAYING) {
    // A successful PLAYING transition proves that this persistent iOS iframe
    // has crossed WebKit's user-gesture gate. Record it for future mode and
    // room transitions instead of relying on stopYouTubeMode to guess.
    if (IS_IOS && !isYtPrimed()) {
      setYtPrimed(true);
      bus.emit('youtube:zero-start-readiness-changed');
    }

    // Host: If playlist sub-item data is still missing, attempt immediate snapshot.
    // This allows immediate Next/Prev navigation and highlights as soon as playback starts.
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      const currentTrack = getQueueItemById(getState('playlist.currentQueueItemId'));
      const pid = currentTrack?.playlistId;
      const subMap = getState('youtube.subItemsMap') || {};
      if (pid && (!subMap[pid] || !subMap[pid].ids.length)) {
        log.debug('[YouTube] Playback started — triggering immediate playlist snapshot');
        _triggerPlaylistSnapshot(pid);
      }
    }

    // Pause-back if autoplay was not intended (e.g. loadPlaylist async path).
    if (!getYtAutoplayIntent()) {
      player?.pauseVideo?.();
      showLoader(false);
      // Existing-player async load completed — if a caller (URL-input or
      // playTrack) armed the rendezvous flag, consume it now so autoplay
      // kicks in without waiting for another 'youtube:player-ready' (which
      // only fires on brand-new player instances).
      const pendingAutoSync = consumePendingAutoSyncOnReady();
      if (pendingAutoSync) {
        bus.emit('youtube:auto-play', pendingAutoSync);
      } else {
        setPlaybackYouTubePaused();
      }
      return; // Don't broadcast or update UI yet
    }

    // Block-to-block YT-to-YT track transition: playTrack armed
    // _pendingAutoSyncOnReady but issued the load with autoplay=true,
    // so we passed straight through the pause-back guard above. Without
    // consuming the flag here the rendezvous would never fire (only
    // sub-video transitions had a path) and guests would drift after
    // every block switch. Pass isTrackTransition=true so the handler
    // pauses + uses the longer TRACK_TRANSITION_RENDEZVOUS_MS instead
    // of the URL-input STAGE2 delay.
    //
    // `?? true` is a conservative fallback when a caller omits
    // isTrackTransition: use the longer 4s rendezvous so a YT-to-YT switch
    // cannot drift. Current call sites set the flag explicitly.
    const pendingAutoSync = consumePendingAutoSyncOnReady();
    if (pendingAutoSync) {
      bus.emit('youtube:auto-play', {
        ...pendingAutoSync,
        isTrackTransition: pendingAutoSync.isTrackTransition ?? true,
      });
    }

    showYouTubeSyncOverlay(false);
    showLoader(false);
    setPlaybackYouTubePlaying();
    bus.emit('ui:update-play-state', true);
  } else if (state === YT.PlayerState.PAUSED) {
    showLoader(false);
    setPlaybackYouTubePaused();
    bus.emit('ui:update-play-state', false);
  } else if (state === YT.PlayerState.CUED) {
    // Read the live session (not the `indexing` boolean captured at handler
    // entry) so the poll chain is keyed to the exact session this CUED
    // belongs to. The handler is synchronous, so no session can change
    // between entry and here — this is about passing identity, not freshness.
    const indexingSession = getYtIndexingSession();
    if (indexingSession) {
      log.debug('[YouTube] CUED during indexing — polling for full list');
      // YouTube populates getPlaylist() lazily for large playlists — a
      // 100-track list commonly returns ~10 items on the first read after
      // CUED. Firing the callback immediately would cache a truncated list
      // and the playlist would "end" at sub-video 10. Poll until the count
      // stabilizes (same count twice in a row) or a safety ceiling.
      _pollIndexingPlaylist(indexingSession, -1, 0);
      return;
    }

    const hostConn = getState('network.hostConn');
    if (!hostConn && _ifr.isScrapingPlaylist) {
      log.debug('[YouTube] CUED during scrape — polling getPlaylist() for stable list');
      // _ifr.isScrapingPlaylist stays true until _finishScrape runs so a
      // second CUED transition during the poll doesn't double-trigger.
      _pollScrapePlaylist(_ifr.scrapeSession, -1, 0);
      return;
    }

    // Persistent-player transitions now cue the incoming video before any
    // shared start. A reused iframe does not emit onReady again, so CUED is
    // the deterministic hand-off point for the pending zero-start/legacy
    // rendezvous intent armed by playlist.ts.
    const pendingAutoSync = consumePendingAutoSyncOnReady();
    if (pendingAutoSync) {
      bus.emit('youtube:auto-play', pendingAutoSync);
    }
    return;
  } else if (state === YT.PlayerState.ENDED) {
    if (routeCurrentProYouTubeObservation('ended')) return;
    // Host: advance through sub-videos or fall through to next queue track.
    // Guest: keep youtubeUILoop alive — the iframe may auto-advance to the
    // next sub-video in a playlist, and updateYouTubeUI's guest auto-advance
    // suppression (pause + wait for host) needs the loop running to detect
    // the sub-index change.
    //
    // Do not touch youtubeSyncLoop here. The active
    // playback runtime starts/reconciles it, while stopYouTubeMode stops it.
    // ENDED is a transient state during
    // sub-video advance — clearing here would have to be paired with a
    // restart in every recovery branch. In particular, the `advanced` branch
    // needs the existing loop to retain host playback data. Queue-ended cases go through
    // playlist:next-track → stopYouTubeMode, which still clears it.

    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      // Host: skip IDLE state transition to prevent UI flash — next-track
      // will call stopAllMedia({ silent: true }) which handles state internally.
      //
      // Repeat-one (natural end only): restart the current video in place.
      // We intentionally handle this HERE rather than inside playNextTrack,
      // because playNextTrack is also called from manual Next buttons and
      // media-session skip — those should advance normally regardless of
      // repeat-one, matching Spotify / Apple Music behaviour.
      const repeatMode = getState('playlist.repeatMode') || 0;
      if (repeatMode === 2) {
        log.debug('[YouTube] Ended with repeat-one, restarting current video...');
        bus.emit('youtube:auto-play', {
          targetTime: 0,
          skipSeek: false,
          isTrackTransition: false,
          zeroStart: true,
        });
        return;
      }

      // Single-video mode: try to advance to the next sub-video within the
      // current YouTube playlist first (via loadVideoById, using snapshotted
      // subItemsMap). Only fall back to the MUSIXQUARE queue's next track
      // when we've reached the end of the sub-items list.
      let advanced = false;
      bus.emit('youtube:try-next-internal', (ok: boolean) => {
        advanced = ok;
      });
      if (advanced) {
        log.debug('[YouTube] Ended, advancing to next sub-video...');
        // youtubeSyncLoop stays alive (see ENDED-branch comment above) —
        // the player is being reused for the next sub-video, so the
        // existing heartbeat keeps broadcasting fresh snapshots to guests.
        return;
      }
      clearManagedTimer('youtubeUILoop');
      log.debug('[YouTube] Ended, playing next track...');
      bus.emit('playlist:next-track');
    } else {
      // Guest: DON'T go IDLE immediately — host is about to send YOUTUBE_STATE
      // with the next video. If we set IDLE now, handleYouTubeState() would
      // drop the message (not in YouTube mode guard). Wait up to 5s
      // for the host's next-track command; fall back to IDLE if nothing arrives.
      log.debug('[YouTube] Guest: video ended — waiting for host next-track');
      setManagedTimer(
        'yt-guest-ended-fallback',
        () => {
          // Host never sent next track (e.g. playlist truly ended) — clean up
          clearManagedTimer('youtubeUILoop');
          if (isPlaybackModeYouTube()) {
            log.debug('[YouTube] Guest: no next-track from host — going IDLE');
            setPlaybackIdle();
            bus.emit('youtube:stop-mode');
          }
        },
        GUEST_ENDED_FALLBACK_MS,
      );
    }
    return; // Don't broadcast ENDED — guest handles locally, prevents race with next-track
  }

  // Host broadcasts state to guests (skip if UI already broadcast within 300ms)
  const hostConn = getState('network.hostConn');
  const now = Date.now();
  // CRITICAL: skip while a scheduled rendezvous (yt-auto-sync) is active.
  // During that window the player transitions PAUSED → BUFFERING → PLAYING
  // (pause, seek, wait, play) and onStateChange fires for each transition.
  // If the 300ms UI-dedupe cooldown elapses during this ~1s+ window,
  // onStateChange will broadcast an auxiliary YOUTUBE_STATE{state:2, no
  // hostPlayAt} for the transient PAUSED state — which the guest interprets
  // as "host paused" and cancels its pending yt-clock-action, leaving guest
  // paused while host resumes at the end of the rendezvous.
  // scheduleYtAutoSync already broadcasts the authoritative state+hostPlayAt
  // at the start of its sequence, so suppressing these in-flight auxiliary
  // broadcasts is safe.
  const syncInFlight = isYouTubeZeroStartProtocolActive() || !!getManagedTimer('yt-auto-sync');
  const coordinatorNudgeInFlight = !!getManagedTimer(PRO_COORDINATOR_YOUTUBE_NUDGE_TIMER);
  // State-aware cooldown: only suppress if same state was broadcast within 300ms.
  // Deduplicate by state as well as time. A time-only cooldown would swallow a
  // rapid pause→play transition and leave guests stale until the next heartbeat.
  const isDuplicateState =
    state === _ifr.lastBroadcastState && now - _ifr.lastStateBroadcast < STATE_BROADCAST_DEDUP_MS;
  if (
    !hostConn &&
    getState('room.context').kind !== 'pro' &&
    player?.getCurrentTime &&
    !syncInFlight &&
    !coordinatorNudgeInFlight &&
    !isDuplicateState
  ) {
    _ifr.lastStateBroadcast = now;
    _ifr.lastBroadcastState = state;
    const queueItemId = getCurrentQueueItemId();
    if (queueItemId) {
      broadcast({
        type: MSG.YOUTUBE_STATE,
        queueItemId,
        state,
        time: toCanonicalYouTubeTime(player.getCurrentTime(), player.getDuration?.() || 0),
        subIndex: getState('youtube.currentSubIndex') ?? -1,
        videoId: player.getVideoData?.()?.video_id || '',
        title: player.getVideoData?.()?.title || '',
        hostClock: getHostNow(),
      });
    }
  }
}

// ─── YouTube UI Update Loop ────────────────────────────────────────

function updateYouTubeUI(): void {
  const player = getYouTubePlayer();
  if (!player || !isPlaybackModeYouTube() || !player.getCurrentTime) return;

  // While zero-start is preparing/armed/scheduled/starting, the controller
  // is the sole owner of the iframe timeline. The legacy UI loop must not
  // heal a heartbeat, project the warm-up position, or mistake a transient
  // CUED/BUFFERING state for unavailable/native auto-advance. The real
  // release PLAYING closes `inFlight` synchronously in the state handler,
  // after which the ordinary loop resumes without a second code path.
  if (isYouTubeZeroStartInFlight()) return;

  // The UI loop and heartbeat have separate timer keys. If any unrelated
  // cleanup accidentally clears only the heartbeat, keep an active host from
  // silently running until every guest snapshot expires.
  healYouTubeHostHeartbeat();

  // Crash detection: if getCurrentTime() throws repeatedly, the iframe
  // process has died (sad face icon). YouTube API events stop firing
  // entirely, so onError never triggers. Detect via polling and recover.
  let currentTime: number;
  try {
    currentTime = player.getCurrentTime();
    if (Number.isFinite(currentTime) && currentTime >= 0) {
      _ifr.lastRecoverableTime = toCanonicalYouTubeTime(currentTime, player.getDuration?.() || 0);
    }
    _ifr.crashFailCount = 0; // Reset on success
  } catch {
    _ifr.crashFailCount++;
    if (_ifr.crashFailCount >= CRASH_FAIL_THRESHOLD) {
      log.error(
        `[YouTube] iframe unresponsive (${_ifr.crashFailCount} failures) — rebuilding player`,
      );
      _ifr.crashFailCount = 0;

      // Reset guestPlayLatency — the last calibration before the crash may
      // have been measured against a dying iframe (stale getCurrentTime),
      // producing a corrupted EMA value that persists across reloads and
      // permanently biases all future rendezvous sync.
      setState('youtube.guestPlayLatency', 0);
      try {
        localStorage.removeItem('musixquare-yt-play-latency');
      } catch {
        /* noop */
      }

      // Capture current state for recovery. currentTrackMeta.videoId is only
      // set to the entry-point video on track add; it never advances across
      // sub-video transitions. For sub-index > 0, prefer the cached videoId
      // in subItemsMap (kept in sync by broadcastYouTubeSync) so a crash
      // mid-playlist reloads the SAME sub-video instead of jumping back to
      // the first one.
      const playlistId = (getState('player.currentTrackMeta')?.playlistId as string) || '';
      const subIndex = getState('youtube.currentSubIndex') ?? 0;
      let videoId = (getState('player.currentTrackMeta')?.videoId as string) || '';
      if (playlistId && subIndex > 0) {
        const subMap = getState('youtube.subItemsMap') || {};
        const cachedId = subMap[playlistId]?.ids?.[subIndex];
        if (cachedId) {
          videoId = cachedId;
          log.debug(
            `[YouTube] Crash recovery resolved videoId for sub-index ${subIndex}: ${cachedId}`,
          );
        }
      }
      const recoveryTime = _ifr.lastRecoverableTime;
      const hostConn = getState('network.hostConn');

      // Destroy dead player and rebuild
      try {
        player.destroy?.();
      } catch {
        /* already dead */
      }
      setYouTubePlayer(null);
      bus.emit('youtube:zero-start-readiness-changed');
      const container = document.getElementById('youtube-player-container');
      if (container) resetYouTubePlayerHost(container);
      showToast(t('youtube.load_fail'));
      // Reload the same video. Host rebuilds through the normal pending
      // rendezvous path so guests get a fresh room-wide sync instead of
      // watching the host iframe autoplay by itself. Guests rebuild paused
      // and immediately attempt a quiet one-device rendezvous once ready.
      if (videoId || playlistId) {
        if (!hostConn) {
          // Crash recovery rebuilds the iframe from scratch, so both host and
          // guests re-enter the fresh other-to-yt setup phase together. STAGE2
          // (2s) is the right delay — `isTrackTransition: false` keeps this off
          // the onStateChange `?? true` conservative-fallback path.
          loadYouTubeVideo(videoId || null, playlistId || null, false, subIndex);
          setPendingAutoSyncOnReady(true, {
            isTrackTransition: false,
            targetTime: recoveryTime,
            subIndex,
            videoId: videoId || undefined,
            skipSeek: false,
          });
        } else {
          loadYouTubeVideo(videoId || null, playlistId || null, false, subIndex);
          _ifr.guestRendezvousAfterReady = true;
        }
      }
    }
    return;
  }

  try {
    const rawDuration = player.getDuration?.() || 0;
    const playlistIdx = player.getPlaylistIndex?.() ?? -1;
    const state = player.getPlayerState?.() ?? -1;

    // iOS fallback for older/quirky iframe builds that do not deliver
    // onAutoplayBlocked. CUED is normally healthy, but if a synchronized play
    // is explicitly intended and it remains CUED, WebKit is waiting for a tap.
    const iosGestureBlockedCandidate =
      IS_IOS && (state === -1 || (state === 5 && getYtAutoplayIntent()));
    if (iosGestureBlockedCandidate) {
      if (!getYtIOSWatchdog()) setYtIOSWatchdog(Date.now());
      if (Date.now() - getYtIOSWatchdog()! > IOS_WATCHDOG_MS) {
        showYouTubeSyncOverlay(true);
      }
    } else if (state === 1 || state === 2) {
      // Only clear watchdog on definitively successful states (PLAYING/PAUSED).
      // Clearing on BUFFERING(3) would reset the timer if a stuck player
      // briefly flickers through BUFFERING during initialization.
      setYtIOSWatchdog(null);
    }

    if (!_ifr.isScrapingPlaylist) {
      updateLiveStreamDetection(rawDuration, state);
    }

    // ── Host-side title sync (mirrors guest's handleYouTubeState path) ──
    // currentTrackMeta is initialized from the playlist row, which carries
    // the playlist's name (or the "loading…" oEmbed placeholder if the
    // URL preview hadn't resolved yet) — not the actual sub-video title.
    // Guests update from data.title in YOUTUBE_STATE/SYNC broadcasts; the
    // host had no equivalent self-update, so its now-playing display stayed
    // stuck on the playlist name even after the iframe knew the real title.
    // Pull it from getVideoData(), which is the same source used in the
    // outgoing broadcast just below in broadcastYouTubeSync. The setState
    // call is a no-op when nothing changed (same-ref check inside).
    if (!getState('network.hostConn')) {
      const videoData = player.getVideoData?.();
      const vTitle = videoData?.title;
      if (vTitle) {
        updatePlaybackTrackTitle(vTitle);
        persistResolvedProYouTubeTitle(getCurrentQueueItemId(), videoData?.video_id || '', vTitle);
      }
    }

    // ── Unavailable-video heuristic (host-only) ────────────────────
    // Some "unavailable" states (region lock, age-gate, certain private
    // videos) render an error UI inside the iframe without firing
    // onError through the API. Detect by measuring how long the player
    // sits in a non-playing state, and auto-advance past the broken
    // track. Host-only: a stuck guest is usually a local network issue,
    // and skipping locally would diverge from host state.
    //
    // Excluded cases (each is a legitimate stall, not "unavailable"):
    //   - iOS gate overlay visible — user hasn't tapped yet
    //   - document.hidden — browser may throttle the iframe
    //   - isScrapingPlaylist — CUED is intentional while indexing IDs
    //   - PLAYING/PAUSED — video is fine (ads live here too)
    const isHost = !getState('network.hostConn');
    // CUED is only a failure candidate after an actual play intent. A track
    // deliberately prepared for manual start may remain CUED indefinitely and
    // must never auto-skip merely because the listener has not pressed Play.
    const stuckStateEligible =
      state === -1 || state === 3 || (state === 5 && getYtAutoplayIntent());
    const iosOverlayVisible =
      document.getElementById('youtube-ios-sync-overlay')?.style.display === 'flex';
    const stuckEligible =
      isHost &&
      stuckStateEligible &&
      !iosOverlayVisible &&
      !document.hidden &&
      !_ifr.isScrapingPlaylist;
    if (stuckEligible) {
      if (!_ifr.unavailableStuckSince) _ifr.unavailableStuckSince = Date.now();
      if (Date.now() - _ifr.unavailableStuckSince > UNAVAILABLE_STUCK_THRESHOLD_MS) {
        log.error(`[YouTube] Player stuck in state ${state} — treating as unavailable, skipping`);
        _ifr.unavailableStuckSince = null;
        showToast(t('youtube.video_unavailable'));
        if (routeCurrentProYouTubeObservation('unavailable')) return;
        broadcastSystemMessage('youtube.video_unavailable');
        let advanced = false;
        bus.emit('youtube:try-next-internal', (ok: boolean) => {
          advanced = ok;
        });
        if (!advanced) bus.emit('playlist:next-track');
        return;
      }
    } else {
      _ifr.unavailableStuckSince = null;
    }

    // Pre-empt slow native auto-advance. When the iframe's native playlist
    // engine is active (playlistIdx !== -1), its automatic transition to
    // the next video can stall for several seconds on large playlists.
    // Intercepting 0.5~0.8s before the track ends lets us swap to
    // single-video mode ourselves and keep guests in sync.
    const hostConn = getState('network.hostConn');
    if (!hostConn && playlistIdx !== -1 && state === 1 && _ifr.lastPreemptIdx !== playlistIdx) {
      const timeRemaining = rawDuration - currentTime;
      if (rawDuration > 0 && timeRemaining <= 0.8 && timeRemaining > 0) {
        log.debug(
          `[YouTube] Pre-empting native auto-advance (remaining: ${timeRemaining.toFixed(2)}s)`,
        );
        _ifr.lastPreemptIdx = playlistIdx;
        // Route a PRO playlist boundary through the authority seam rather than
        // exposing a public `next` command. An authorized controller reports
        // the current video's near-end observation; an ordinary listener is
        // consumed locally without mutating the room. Standard rooms retain
        // the legacy internal-navigation fallback below.
        if (routeCurrentProYouTubeObservation('ended')) return;
        bus.emit('youtube:try-next-internal', () => {});
        return;
      }
    }

    // Reset cache when playlist sub-index changes (= different video)
    let subIndexJustChanged = false;
    if (playlistIdx !== getCachedYtPlaylistIdx()) {
      subIndexJustChanged = true;
      const prevIdx = getCachedYtPlaylistIdx();
      setCachedYtPlaylistIdx(playlistIdx);
      setCachedYtDuration(0);
      resetLiveStreamDetection();
      _ifr.lastVideoTitle = '';
      _ifr.lastDurationVideoId = ''; // Force videoId re-read on next getVideoData poll

      // Arm the counter so (N+1) % N === 0 on the NEXT tick → getVideoData
      // fires immediately after a sub-index change instead of waiting for
      // the usual ~5s cadence. `- 1` keeps this correct if N ever changes.
      _ifr.videoDataPollCount = VIDEO_DATA_POLL_EVERY_NTH_TICK - 1;

      const hostConn = getState('network.hostConn');

      // ── Guest-side: suppress independent auto-advance ──────────────
      // YouTube iframe auto-advances to the next video in a playlist
      // independently on each device. In a Mix (RD...) playlist, the order
      // is personalized per device, so the guest's "next" video is likely
      // DIFFERENT from the host's. If we let the guest play freely,
      // videoId mismatch detection (handleYouTubeSync, 3s heartbeat)
      // eventually corrects it via loadVideoById, but this causes 3-6s
      // of the guest playing the wrong video from position 0.
      //
      // Immediately pause the guest and let the host's YOUTUBE_STATE
      // (which arrives with the correct videoId and hostPlayAt within ~1s)
      // drive the transition. This eliminates the wrong-video window.
      if (hostConn && prevIdx !== -1 && playlistIdx >= 0) {
        log.info(
          `[YouTube] Guest: suppressing auto-advance ${prevIdx} → ${playlistIdx} — pausing, waiting for host command`,
        );
        try {
          player.pauseVideo?.();
        } catch {
          /* noop */
        }
        // Do NOT return here — fall through so title, duration, and seekbar
        // UI updates still run. The pause is enough to suppress playback;
        // returning early would freeze the UI on the previous track's metadata.
      }

      // ── Host-side: sub-video auto-advance detection ────────────────
      // YouTube IFrame auto-advances between sub-videos in a playlist
      // WITHOUT firing an ENDED event, so our ENDED → playlist:next-track
      // path never runs and guests diverge until drift correction catches up.
      // Detect the transition here and start the track-transition rendezvous.
      if (!hostConn && prevIdx !== -1 && playlistIdx >= 0 && !getManagedTimer('yt-auto-sync')) {
        log.debug(
          `[YouTube] Sub-video auto-advance detected: ${prevIdx} → ${playlistIdx} (state=${state}), applying 1-sec sync`,
        );
        bus.emit('youtube:sub-video-advanced');
      }

      // Pre-emptive title update from subItemsMap (if available) for instant feedback
      const currentTrack = getQueueItemById(getState('playlist.currentQueueItemId'));
      if (currentTrack?.playlistId && playlistIdx >= 0) {
        const subMap = getState('youtube.subItemsMap') || {};
        const cachedTitle = subMap[currentTrack.playlistId]?.titles?.[playlistIdx];
        if (cachedTitle) {
          updatePlaybackTrackTitle(cachedTitle, currentTrack);
          _ifr.lastVideoTitle = cachedTitle;
        }
      }
    }

    // Update track title and videoId cache.
    // getVideoData() is an expensive cross-iframe call. Only call it when
    // the sub-index changed (detected above) or every Nth tick as a fallback
    // for single videos. Calling it on every UI tick (twice per second) caused
    // iframe memory pressure in long sessions.
    _ifr.videoDataPollCount = (_ifr.videoDataPollCount + 1) % VIDEO_DATA_POLL_EVERY_NTH_TICK;
    const shouldPollVideoData = subIndexJustChanged
      ? false // sub-index branch above already ran; title was set from subItemsMap
      : _ifr.videoDataPollCount === 0; // every Nth tick for title/videoId sync

    let currentVideoId = _ifr.lastDurationVideoId; // reuse cached value by default
    if (shouldPollVideoData && player.getVideoData) {
      const vData = player.getVideoData();
      if (vData?.title && vData.title !== _ifr.lastVideoTitle) {
        _ifr.lastVideoTitle = vData.title;
        updatePlaybackTrackTitle(vData.title);
        persistResolvedProYouTubeTitle(getCurrentQueueItemId(), vData.video_id || '', vData.title);
      }
      currentVideoId = vData?.video_id || '';

      // Invalidate duration cache when videoId changes
      if (currentVideoId && currentVideoId !== _ifr.lastDurationVideoId) {
        if (_ifr.lastDurationVideoId !== '') {
          setCachedYtDuration(0);
          resetLiveStreamDetection();
        }
        _ifr.lastDurationVideoId = currentVideoId;
      }
    }

    // Commit the latest rawDuration whenever it diverges meaningfully from
    // the cache. Do not lock on the first valid read: a transitional poll can
    // land on (new videoId, stale rawDuration) or
    // (stale videoId, stale rawDuration) and permanently pin the cache to
    // the previous video's duration. Re-reading every poll is cheap, and
    // a small threshold keeps the emit quiet when rawDuration is stable.
    if (rawDuration > 0 && Math.abs(rawDuration - getCachedYtDuration()) > DURATION_CACHE_EPSILON) {
      setCachedYtDuration(rawDuration);
    }

    const cachedDuration = getCachedYtDuration();
    // Always emit time-update even when duration is 0 (new video loading).
    // Without this, the seekbar freezes on the previous track's position
    // until getDuration() returns a valid value for the new video.
    // The seekbar handler (ui:time-update) guards on `duration > 0` for
    // slider.max, so a 0 duration just means the thumb won't move but
    // the current time text still updates.
    {
      const displayDuration = cachedDuration > 0 ? cachedDuration : rawDuration;
      const displayTime = toCanonicalYouTubeTime(currentTime, displayDuration);
      bus.emit(
        'ui:time-update',
        fmtTime(displayTime),
        fmtTime(displayDuration),
        displayTime,
        displayDuration,
      );
    }
  } catch {
    // Player not ready
  }
}

// ─── iOS Play-Gate Overlay ─────────────────────────────────────────
// iOS WebKit blocks iframe-embedded YouTube from autoplaying without a
// direct tap inside the iframe region. This overlay detects when the
// player has been stuck at UNSTARTED(-1) for >3s (see updateYouTubeUI)
// and prompts the user to tap — the tap satisfies iOS gesture, unlocks
// the video element, and (for guests) immediately triggers a one-shot
// rendezvous sync so playback starts aligned with the host instead of
// starting from position 0 and relying on coarse drift correction.

function showYouTubeSyncOverlay(show: boolean): void {
  const overlayId = 'youtube-ios-sync-overlay';
  let overlay = document.getElementById(overlayId);

  if (show) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.style.cssText = `
        position:absolute;top:0;left:0;width:100%;height:100%;
        background:rgba(0,0,0,0.6);display:flex;align-items:center;
        justify-content:center;z-index:100;cursor:pointer;
        animation:fadeIn 0.3s ease-out;
      `;
      overlay.onclick = () => {
        const player = getYouTubePlayer();
        if (!player?.playVideo) return;

        // CRITICAL: flip autoplay intent to `true` BEFORE any player API
        // call. Reason:
        //
        //   loadYouTubeVideo() earlier set _ytAutoplayIntent=false (because
        //   host broadcasts YOUTUBE_PLAY with autoplay:false). The pause-back
        //   guard in onYouTubePlayerStateChange relies on this flag to revert
        //   any accidental PLAYING transition back to PAUSED.
        //
        //   Without flipping it here, the rendezvous's legitimate
        //   scheduled playVideo() (fired ~1.5s later) causes a PLAYING
        //   event that the guard interprets as "not intended" and pauses
        //   back — leaving the user staring at a paused player until the
        //   autoSync cooldown expires and drift correction force-plays.
        //
        //   User explicitly tapping the overlay IS the play intent, so
        //   flipping the flag here is semantically correct.
        setYtAutoplayIntent(true);

        // Step 1 — satisfy iOS user-gesture requirement SYNCHRONOUSLY.
        // Once the <video> element has received a user-initiated play() inside
        // this gesture window, subsequent programmatic play/pause/seek calls
        // (including those inside setManagedTimer) work without re-gesturing.
        try {
          player.playVideo();
          // Immediately pause to prevent an audible blip from position 0
          // before rendezvous takes over. Pause does not revoke the unlock.
          player.pauseVideo?.();
        } catch (e) {
          // Prime failed — gesture was NOT captured. Keep the overlay up so the
          // user can tap again; dismissing it here would leave the player
          // permanently paused because downstream rendezvous playVideo() calls
          // fire outside a gesture and iOS will silently reject them. Roll
          // back the intent flag too so the pause-back guard stays armed.
          log.warn('[YouTube iOS gate] prime play/pause threw — keeping overlay:', e);
          setYtAutoplayIntent(false);
          return;
        }

        showYouTubeSyncOverlay(false);

        // Step 2 — decide fallback path. Guest → rendezvous (aligned start).
        // Host/standalone → plain playVideo (no external reference to follow).
        // A PRO tap unlocks only this endpoint. Room playback remains owned by
        // the server, so rejoin its canonical timeline instead of manufacturing
        // a direct local play command.
        if (getState('room.context').kind === 'pro') {
          bus.emit('playback:local-output-rejoin', {
            reason: 'media-session-play',
            mode: 'youtube',
          });
          return;
        }

        const hostConn = getState('network.hostConn');
        if (hostConn) {
          try {
            guestRendezvousSync();
          } catch (err) {
            log.warn('[YouTube iOS gate] rendezvous failed, falling back to plain play:', err);
            try {
              player.playVideo();
            } catch {
              /* noop */
            }
          }
        } else {
          try {
            player.playVideo();
          } catch {
            /* noop */
          }
        }
      };
      const chip = document.createElement('div');
      chip.style.cssText =
        'background:var(--primary);color:white;padding:12px 24px;border-radius:100px;font-weight:bold;font-size:14px;box-shadow:0 4px 15px rgba(0,0,0,0.3);display:flex;align-items:center;gap:8px;';

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '20');
      icon.setAttribute('height', '20');
      icon.setAttribute('fill', 'white');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M8 5v14l11-7z');
      icon.appendChild(path);

      chip.append(icon, document.createTextNode(t('youtube.tap_to_play')));
      overlay.replaceChildren(chip);
      const wrapper = document.querySelector('.video-wrapper');
      if (wrapper) wrapper.appendChild(overlay);
    }
    overlay.style.display = 'flex';
  } else if (overlay) {
    overlay.remove();
    setYtIOSWatchdog(null);
  }
}

// ─── Refresh Display Workaround ────────────────────────────────────

export function refreshYouTubeDisplay(): void {
  const container = document.getElementById('youtube-player-container');
  if (!container || !isPlaybackModeYouTube()) return;

  log.debug('[YouTube] Refreshing display to prevent black screen...');
  const iframe = container.querySelector('iframe');

  container.style.visibility = 'hidden';
  void container.offsetHeight; // Force reflow
  container.style.visibility = 'visible';

  if (iframe) {
    iframe.style.visibility = 'hidden';
    void iframe.offsetHeight;
    iframe.style.visibility = 'visible';
  }

  window.dispatchEvent(new Event('resize'));
}

/**
 * Snapshot the resolved videoId list from the YouTube player's internal queue.
 * This is the ONLY way to get the correct list for RD (Mixes), and lets us
 * drive navigation via loadVideoById so the iframe's native playlist engine
 * stays dormant for PL-type lists.
 *
 * Retry counts are tracked per-playlistId so concurrent snapshots of
 * different playlists don't share/clobber each other's attempt state.
 */
const SNAPSHOT_MAX_RETRIES = 20;
const _snapshotRetryCounts = new Map<string, number>();

/**
 * Clear any pending playlist-snapshot retry timers + counter map. Called by
 * `stopYouTubeMode()` — without this, the 20-retry cap keeps firing against
 * a destroyed player (the early-return at `getYouTubePlayer()` makes each
 * call a no-op, but the timers pollute the registry and the Map leaks pids
 * across sessions).
 */
export function clearSnapshotRetries(): void {
  for (const pid of _snapshotRetryCounts.keys()) {
    clearManagedTimer(`yt-snapshot-retry-${pid}`);
  }
  _snapshotRetryCounts.clear();
}

function _triggerPlaylistSnapshot(pid: string, isRetry = false): void {
  // Fire-time identity check: this timer (and its 1s retry chain) can outlive
  // the track that armed it — the YT→YT reuse path keeps the player and skips
  // stopYouTubeMode's clears. A pid mismatch means getPlaylist() now describes
  // a DIFFERENT track's list; writing it under the captured pid would poison
  // subItemsMap on every device via the broadcast below.
  const livePid = getState('player.currentTrackMeta')?.playlistId as string | undefined;
  if (livePid !== pid) {
    _snapshotRetryCounts.delete(pid);
    return;
  }

  if (!isRetry) _snapshotRetryCounts.set(pid, 0);

  try {
    const player = getYouTubePlayer();
    if (!player?.getPlaylist) return;

    const subMap = getState('youtube.subItemsMap') || {};
    const existingIds = subMap[pid]?.ids || [];

    const ids = player.getPlaylist() || [];

    // YouTube's player sometimes returns a placeholder single-item list
    // before the real playlist has fully resolved. If we don't already
    // have a full list cached, retry until we get 2+ items (or give up).
    if (!Array.isArray(ids) || ids.length === 0 || (ids.length === 1 && existingIds.length <= 1)) {
      const attempts = _snapshotRetryCounts.get(pid) ?? 0;
      if (attempts < SNAPSHOT_MAX_RETRIES) {
        _snapshotRetryCounts.set(pid, attempts + 1);
        log.debug(
          `[YouTube Snapshot] Empty/single list for ${pid}, retrying (${attempts + 1}/${SNAPSHOT_MAX_RETRIES})`,
        );
        setManagedTimer(
          `yt-snapshot-retry-${pid}`,
          () => _triggerPlaylistSnapshot(pid, true),
          1000,
        );
      } else {
        log.warn(`[YouTube Snapshot] Gave up on ${pid} after ${SNAPSHOT_MAX_RETRIES} retries`);
        _snapshotRetryCounts.delete(pid);
      }
      return;
    }

    // CRITICAL: If the player is in single-video mode (loadVideoById), getPlaylist()
    // often returns an array of length 1. Do not overwrite our full list with this.
    if (existingIds.length > 1 && ids.length <= 1) {
      log.debug('[YouTube Snapshot] Ignoring skewed snapshot (single-video mode):', pid);
      _snapshotRetryCounts.delete(pid);
      return;
    }

    _snapshotRetryCounts.delete(pid);
    log.info(`[YouTube Snapshot] Captured ${ids.length} items:`, pid);

    // Preserve any titles already fetched or cached
    const existingTitles = subMap[pid]?.titles || [];
    const titles = ids.map((_, idx) => existingTitles[idx] || '');

    setSubItemsData(pid, ids, titles);

    // Broadcast to guests so they use this static list for sub-navigation
    broadcast({
      type: MSG.YOUTUBE_PLAYLIST_INFO,
      playlistId: pid,
      ids,
      titles,
    });

    // Start fetching titles in the background
    fetchPlaylistSubTitles(pid, ids);

    // Clear any pending snapshot timers as we just finished it
    clearManagedTimer('yt-playlist-snapshot');
  } catch (e) {
    log.warn('[YouTube Snapshot] Error:', e);
  }
}
