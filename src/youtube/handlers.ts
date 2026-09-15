/**
 * MUSIXQUARE — YouTube Protocol Handlers
 *
 * Manages: Network message handlers for YouTube commands
 * (play, pause, toggle, sub-seek, playlist-info).
 */

import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { bus } from '../core/events.ts';
import { MSG } from '../core/constants.ts';
import { clearManagedTimer } from '../core/timers.ts';
import { safeSend } from '../network/peer.ts';
import { verifyOperator } from '../network/protocol.ts';
import { getYouTubePlayer, setLocalYouTubePaused, setYouTubeSubIndex } from './_state.ts';
import { loadYouTubeVideo } from './iframe.ts';
import { toCanonicalYouTubeTime } from './local-offset.ts';
import { TRACK_TRANSITION_RENDEZVOUS_MS } from './constants.ts';
import { isStandardHostManualOffsetTransactionPending } from './standard-host-manual-offset-gate.ts';
import { cancelIncomingFileTransfer } from '../storage/transfer-receive.ts';
import { cancelRemoteShareWait } from '../share/remote-share.ts';
import {
  getPlaybackSelectionTrackMeta,
  isPlaybackModeYouTube,
  setPlaybackTrackMeta,
  updatePlaybackTrackDetails,
} from '../player/ownership.ts';
import {
  getCurrentQueueItemId,
  getQueueItemById,
  selectQueueItemById,
} from '../player/queue-model.ts';
import type { DataConnection, QueueItemId } from '../types/index.ts';

import type { YTNamespace } from './_state.ts';
declare const YT: YTNamespace;

export interface YouTubeAutoSyncOverrides {
  subIndex?: number;
  videoId?: string;
  skipSeek?: boolean;
  rendezvousDelayMs?: number;
  state?: number;
}

interface YouTubeHandlerRuntimeHooks {
  scheduleYtAutoSync(targetTime: number, overrides?: YouTubeAutoSyncOverrides): void;
  tryBeginYouTubeZeroStart(videoId: string, subIndex: number | null): boolean;
}

let runtimeHooks: YouTubeHandlerRuntimeHooks | null = null;

/** Bind player-owned commands without introducing a handlers -> player import cycle. */
export function configureYouTubeHandlerRuntimeHooks(next: YouTubeHandlerRuntimeHooks): void {
  runtimeHooks = next;
}

function requireRuntimeHooks(): YouTubeHandlerRuntimeHooks {
  if (!runtimeHooks) {
    throw new Error('[YouTube] Handler runtime used before player initialization.');
  }
  return runtimeHooks;
}

function scheduleYtAutoSync(targetTime: number, overrides?: YouTubeAutoSyncOverrides): void {
  const hooks = requireRuntimeHooks();
  if (overrides === undefined) hooks.scheduleYtAutoSync(targetTime);
  else hooks.scheduleYtAutoSync(targetTime, overrides);
}

function tryBeginYouTubeZeroStart(videoId: string, subIndex: number | null): boolean {
  return requireRuntimeHooks().tryBeginYouTubeZeroStart(videoId, subIndex);
}

// ─── Network Handlers ──────────────────────────────────────────────

export function handleYouTubePlay(data: Record<string, unknown>, conn?: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const videoId = data.videoId as string | null;
  const playlistId = data.playlistId as string | null;
  const queueItemId = data.queueItemId as QueueItemId;
  const autoplay = data.autoplay as boolean | undefined;
  const subIndex = data.subIndex as number | undefined;

  if (!videoId && !playlistId) {
    log.warn('[YouTube] handleYouTubePlay: no videoId or playlistId');
    return;
  }

  setLocalYouTubePaused(false);
  clearManagedTimer('yt-guest-ended-fallback');
  cancelInFlightTransfer();

  // Capture physical ownership before selecting the incoming logical queue
  // occurrence. Different rows can intentionally resolve to the same video.
  // In that case the resident iframe is already the correct decoder/buffer;
  // cueVideoById(sameId) would race the following ZeroStart PREPARE.
  const previousQueueItemId = getCurrentQueueItemId();
  const residentPlayer = getYouTubePlayer();
  let residentVideoId = '';
  try {
    residentVideoId = residentPlayer?.getVideoData?.()?.video_id || '';
  } catch {
    // An unreadable/rebuilding iframe falls through to the established load path.
  }
  const hadYouTubeOwnership = isPlaybackModeYouTube();

  const playlistItem = getQueueItemById(queueItemId);
  if (!playlistItem || playlistItem.type !== 'youtube') {
    log.warn('[YouTube] Ignored play for an unknown queue item:', queueItemId);
    return;
  }
  if (!selectQueueItemById(queueItemId)) return;
  setPlaybackTrackMeta(getPlaybackSelectionTrackMeta(playlistItem));

  let finalVideoId = videoId;
  let finalPlaylistId = playlistId;

  if (!finalVideoId && finalPlaylistId) {
    const subMap = getState('youtube.subItemsMap') || {};
    const knownIds = subMap[finalPlaylistId]?.ids;
    if (knownIds && knownIds.length > 0) {
      finalVideoId = knownIds[0];
      finalPlaylistId = null;
    }
  }

  const reusesResidentOccurrence = Boolean(
    hadYouTubeOwnership &&
      previousQueueItemId &&
      previousQueueItemId !== queueItemId &&
      finalVideoId &&
      residentPlayer &&
      residentVideoId === finalVideoId,
  );

  if (reusesResidentOccurrence) {
    // Logical occurrence boundary only. Leave the exact iframe untouched so
    // ZeroStart can adopt it as resident-reposition. Legacy YOUTUBE_STATE also
    // carries the new queueItemId and target time, so it can restart the same
    // resident without a redundant same-ID cue.
    setYouTubeSubIndex(subIndex ?? 0);
    log.debug('[YouTube] Guest duplicate-video occurrence: retaining resident iframe');
  } else {
    // A different physical target still follows the established single-video
    // load path; keep YouTube's native playlist engine dormant when resolved.
    loadYouTubeVideo(
      finalVideoId,
      finalVideoId ? null : finalPlaylistId,
      autoplay ?? false,
      subIndex ?? 0,
    );
  }

  if (playlistItem.playlistId) {
    bus.emit('youtube:populate-sub-items', playlistItem.playlistId, queueItemId);
  }
}

function guardHostRequest(
  data: Record<string, unknown>,
  conn: DataConnection,
  requestName: string,
  requireCurrent = true,
): boolean {
  if (getState('network.hostConn')) return false;
  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected ${requestName} from non-OP: ${conn?.peer}`);
    return false;
  }
  if (requireCurrent && data.queueItemId !== getCurrentQueueItemId()) {
    log.warn(`[YouTube] Rejected stale ${requestName} for another queue item`);
    return false;
  }
  return true;
}

export function handleRequestYouTubePlay(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  if (!guardHostRequest(data, conn, 'request-youtube-play')) return;
  const player = getYouTubePlayer();
  if (player?.getCurrentTime) {
    const currentTime = toCanonicalYouTubeTime(
      player.getCurrentTime() || 0,
      player.getDuration?.() || 0,
    );
    const videoId = player.getVideoData?.()?.video_id || '';
    if (
      currentTime <= 0.12 &&
      tryBeginYouTubeZeroStart(videoId, getState('youtube.currentSubIndex') ?? null)
    ) {
      return;
    }
    scheduleYtAutoSync(currentTime);
  }
}

export function handleRequestYouTubePause(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  if (!guardHostRequest(data, conn, 'request-youtube-pause')) return;
  const player = getYouTubePlayer();
  if (player?.pauseVideo) {
    const time = toCanonicalYouTubeTime(
      player.getCurrentTime?.() || 0,
      player.getDuration?.() || 0,
    );
    scheduleYtAutoSync(time, { state: 2 });
  }
}

export function handleRequestYouTubeToggle(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  if (!guardHostRequest(data, conn, 'request-youtube-toggle')) return;
  const player = getYouTubePlayer();
  if (!player) return;
  try {
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      const time = toCanonicalYouTubeTime(
        player.getCurrentTime?.() || 0,
        player.getDuration?.() || 0,
      );
      scheduleYtAutoSync(time, { state: 2 });
    } else {
      const currentTime = toCanonicalYouTubeTime(
        player.getCurrentTime?.() || 0,
        player.getDuration?.() || 0,
      );
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
    log.error('[YouTube] Toggle error:', e);
  }
}

export function handleRequestYouTubeSubSeek(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  if (!guardHostRequest(data, conn, 'request-youtube-sub-seek', false)) return;
  if (isStandardHostManualOffsetTransactionPending()) return;

  const subIdx = data.subIdx as number;
  const queueItemId = data.queueItemId as QueueItemId;
  const currentQueueItemId = getCurrentQueueItemId();

  if (queueItemId !== currentQueueItemId) {
    if (!getQueueItemById(queueItemId)) return;
    bus.emit('playlist:play-track', queueItemId, subIdx);
    return;
  }

  const player = getYouTubePlayer();
  if (player?.loadVideoById && typeof subIdx === 'number') {
    const currentItem = getQueueItemById(currentQueueItemId);
    const subMap = getState('youtube.subItemsMap') || {};
    const ids = subMap[currentItem?.playlistId as string]?.ids || [];
    const targetVideoId = ids[subIdx];
    if (!targetVideoId) {
      log.warn(`[YouTube] request-sub-seek: no videoId at subIdx=${subIdx} in subItemsMap`);
      return;
    }
    setYouTubeSubIndex(subIdx);
    if ((player.getVideoData?.()?.video_id || '') !== targetVideoId) {
      updatePlaybackTrackDetails({ artist: null });
    }

    if (tryBeginYouTubeZeroStart(targetVideoId, subIdx)) return;
    player.loadVideoById(targetVideoId);

    scheduleYtAutoSync(0, {
      subIndex: subIdx,
      videoId: targetVideoId,
      skipSeek: true,
      rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
    });
  }
}

export function handleRequestYouTubePlaylistInfo(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  const isGuest = !!getState('network.hostConn');
  if (isGuest) return;
  const pid = data.playlistId as string;
  if (!pid || !conn) return;
  const subMap = getState('youtube.subItemsMap') || {};
  if (subMap[pid]) {
    safeSend(conn, {
      type: MSG.YOUTUBE_PLAYLIST_INFO,
      playlistId: pid,
      ids: subMap[pid].ids || [],
      titles: subMap[pid].titles || [],
    });
  }
}

function cancelInFlightTransfer(): void {
  cancelRemoteShareWait('youtube-play');
  clearManagedTimer('preloadRecoveryWatchdog');
  clearManagedTimer('preloadUiWatchdog');
  cancelIncomingFileTransfer('youtube-play');
}
