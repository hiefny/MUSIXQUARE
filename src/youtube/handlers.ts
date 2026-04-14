/**
 * MUSIXQUARE 3.0 — YouTube Protocol Handlers
 *
 * Manages: Network message handlers for YouTube commands
 * (play, pause, toggle, sub-seek, playlist-info).
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { bus } from '../core/events.ts';
import { MSG, TRANSFER_STATE } from '../core/constants.ts';
import { clearManagedTimer } from '../core/timers.ts';
import { safeSend } from '../network/peer.ts';
import { verifyOperator } from '../network/protocol.ts';
import { getYouTubePlayer, setYouTubeSubIndex } from './_state.ts';
import { loadYouTubeVideo } from './iframe.ts';
import { scheduleYtAutoSync } from './player.ts';
import { showLoader } from '../ui/toast.ts';
import type { DataConnection } from '../types/index.ts';

import type { YTNamespace } from './_state.ts';
declare const YT: YTNamespace;

// ─── Network Handlers ──────────────────────────────────────────────

export function handleYouTubePlay(data: Record<string, unknown>): void {
  const videoId = data.videoId as string | null;
  const playlistId = data.playlistId as string | null;
  const index = data.index as number | undefined;
  const autoplay = data.autoplay as boolean | undefined;
  const subIndex = data.subIndex as number | undefined;

  if (!videoId && !playlistId) {
    log.warn('[YouTube] handleYouTubePlay: no videoId or playlistId');
    return;
  }

  // Cancel any in-flight file transfer before switching to YouTube mode.
  cancelInFlightTransfer();

  if (index !== undefined) {
    setState('playlist.currentTrackIndex', index);
  }

  // Single-video mode: when the host sent a videoId, load JUST that video.
  // The playlistId in the payload is for UI context (lookup into the local
  // playlist.items[index].playlistId) — not something to feed to the
  // iframe's playlist engine. Only when no videoId is present (legacy
  // single-track-with-playlist-only payloads) do we fall back to playlistId.
  loadYouTubeVideo(videoId, videoId ? null : playlistId, autoplay ?? false, subIndex ?? 0);
}

/**
 * Common guard for host-side request handlers: the host must be acting as host
 * (not a guest), and the incoming request must be from the designated operator.
 * Returns `true` if the handler should proceed, `false` otherwise (caller must
 * early-return). Rejection is logged with the request name for context.
 */
function guardHostRequest(
  data: Record<string, unknown>,
  conn: DataConnection,
  requestName: string,
): boolean {
  if (getState('network.hostConn')) return false; // Guest — not our job
  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected ${requestName} from non-OP: ${conn?.peer}`);
    return false;
  }
  return true;
}

export function handleRequestYouTubePlay(data: Record<string, unknown>, conn: DataConnection): void {
  if (!guardHostRequest(data, conn, 'request-youtube-play')) return;

  const player = getYouTubePlayer();
  if (player?.getCurrentTime) {
    scheduleYtAutoSync(player.getCurrentTime() || 0);
  }
}

export function handleRequestYouTubePause(data: Record<string, unknown>, conn: DataConnection): void {
  if (!guardHostRequest(data, conn, 'request-youtube-pause')) return;

  const player = getYouTubePlayer();
  if (player?.pauseVideo) {
    const time = player.getCurrentTime?.() || 0;
    scheduleYtAutoSync(time, { state: 2 });
  }
}

export function handleRequestYouTubeToggle(data: Record<string, unknown>, conn: DataConnection): void {
  if (!guardHostRequest(data, conn, 'request-youtube-toggle')) return;

  const player = getYouTubePlayer();
  if (!player) return;
  try {
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      const time = player.getCurrentTime?.() || 0;
      scheduleYtAutoSync(time, { state: 2 });
    } else {
      // Play
      scheduleYtAutoSync(player.getCurrentTime?.() || 0);
    }
  } catch (e) {
    log.error('[YouTube] Toggle error:', e);
  }
}

export function handleRequestYouTubeSubSeek(data: Record<string, unknown>, conn: DataConnection): void {
  if (!guardHostRequest(data, conn, 'request-youtube-sub-seek')) return;

  const subIdx = data.subIdx as number;
  const playlistIdx = data.playlistIdx as number | undefined;
  const currentTrackIndex = getState('playlist.currentTrackIndex');

  // If the request targets a different playlist item, switch to it first
  // (mirrors the local path in youtube/player.ts 'youtube:sub-seek' handler)
  if (playlistIdx !== undefined && playlistIdx !== currentTrackIndex) {
    bus.emit('playlist:play-track', playlistIdx, subIdx);
    return;
  }

  const player = getYouTubePlayer();
  if (player?.loadVideoById && typeof subIdx === 'number') {
    // Single-video mode: resolve videoId from subItemsMap and loadVideoById.
    // No playVideoAt — keeps the iframe on one video at a time, avoiding
    // the OOM crashes that the playlist engine causes on 200+ item lists.
    const playlist = getState('playlist.items') || [];
    const currentItem = playlist[currentTrackIndex];
    const subMap = getState('youtube.subItemsMap') || {};
    const ids = subMap[currentItem?.playlistId as string]?.ids || [];
    const targetVideoId = ids[subIdx];
    if (!targetVideoId) {
      log.warn(`[YouTube] request-sub-seek: no videoId at subIdx=${subIdx} in subItemsMap`);
      return;
    }
    player.loadVideoById(targetVideoId);
    setYouTubeSubIndex(subIdx);

    scheduleYtAutoSync(0, {
      subIndex: subIdx,
      videoId: targetVideoId,
      skipSeek: true,
    });
  }
}

/**
 * Host responds to Guest's request for YouTube playlist sub-item data.
 * Sends cached IDs and titles from subItemsMap.
 */
export function handleRequestYouTubePlaylistInfo(data: Record<string, unknown>, conn: DataConnection): void {
  const isGuest = !!getState('network.hostConn');
  if (isGuest) return; // Only Host handles peer requests

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

/**
 * Encapsulates the cancellation of file transfers to prevent 
 * leaky abstractions across module domains.
 */
function cancelInFlightTransfer(): void {
  const transferState = getState('transfer.state');
  if (transferState === TRANSFER_STATE.RECEIVING || transferState === TRANSFER_STATE.PROCESSING) {
    log.debug('[YouTube] Cancelling in-flight file transfer for YouTube switch');
    setState('transfer.skipIncomingFile', true);
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('preloadWatchdog');
    // Clear receive-side reorder buffer / early-chunk queue (best-effort dynamic import)
    import('../storage/transfer-receive.ts').then(mod => mod.clearReceiveState()).catch(e => { log.debug('[YouTube] clearReceiveState failed:', e); });
    showLoader(false);
  }
}
