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
import { broadcast, safeSend } from '../network/peer.ts';
import { verifyOperator } from '../network/protocol.ts';
import { getYouTubePlayer, setYouTubeSubIndex } from './_state.ts';
import { loadYouTubeVideo, markYtStateBroadcast } from './iframe.ts';
import { scheduleYtAutoSync, cancelYtAutoSync } from './player.ts';
import { showLoader } from '../ui/toast.ts';
import type { DataConnection } from '../types/index.ts';

declare const YT: any;

// ─── Network Handlers ──────────────────────────────────────────────

export function handleYouTubePlay(data: Record<string, unknown>): void {
  const videoId = data.videoId as string | null;
  const playlistId = data.playlistId as string | string[] | null;
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

  loadYouTubeVideo(videoId, playlistId, autoplay ?? false, subIndex ?? 0);
}

export function handleRequestYouTubePlay(data: Record<string, unknown>, conn: DataConnection): void {
  const isGuest = !!getState('network.hostConn');
  if (isGuest) return; // Only Host handles peer requests

  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected request-youtube-play from non-OP: ${conn?.peer}`);
    return;
  }

  const player = getYouTubePlayer();
  if (player?.getCurrentTime) {
    scheduleYtAutoSync(player.getCurrentTime() || 0);
  }
}

export function handleRequestYouTubePause(data: Record<string, unknown>, conn: DataConnection): void {
  const isGuest = !!getState('network.hostConn');
  if (isGuest) return; // Only Host handles peer requests

  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected request-youtube-pause from non-OP: ${conn?.peer}`);
    return;
  }

  const player = getYouTubePlayer();
  if (player?.pauseVideo) {
    const time = player.getCurrentTime?.() || 0;
    cancelYtAutoSync();
    markYtStateBroadcast();
    player.pauseVideo();
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state: 2,
      time,
      subIndex: player.getPlaylistIndex?.() ?? -1,
      videoId: player.getVideoData?.()?.video_id || '',
    });
  }
}

export function handleRequestYouTubeToggle(data: Record<string, unknown>, conn: DataConnection): void {
  const isGuest = !!getState('network.hostConn');
  if (isGuest) return; // Only Host handles peer requests

  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected request-youtube-toggle from non-OP: ${conn?.peer}`);
    return;
  }

  const player = getYouTubePlayer();
  if (!player) return;
  try {
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      // Pause: immediate, cancel any pending auto-sync
      cancelYtAutoSync();
      if (player.pauseVideo) {
        const time = player.getCurrentTime?.() || 0;
        markYtStateBroadcast();
        broadcast({ type: MSG.YOUTUBE_STATE, state: 2, time, subIndex: player.getPlaylistIndex?.() ?? -1, videoId: player.getVideoData?.()?.video_id || '' });
        player.pauseVideo();
        markYtStateBroadcast();
      }
    } else {
      // Play: 1s auto-sync delay
      scheduleYtAutoSync(player.getCurrentTime?.() || 0);
    }
  } catch (e) {
    log.error('[YouTube] Toggle error:', e);
  }
}

export function handleRequestYouTubeSubSeek(data: Record<string, unknown>, conn: DataConnection): void {
  const isGuest = !!getState('network.hostConn');
  if (isGuest) return; // Only Host handles peer requests

  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected request-youtube-sub-seek from non-OP: ${conn?.peer}`);
    return;
  }

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
  if (player?.playVideoAt && typeof subIdx === 'number') {
    player.playVideoAt(subIdx);
    setYouTubeSubIndex(subIdx);

    // Resolve videoId from subItemsMap — getVideoData() is stale right after playVideoAt
    const playlist = getState('playlist.items') || [];
    const currentItem = playlist[currentTrackIndex];
    const subMap = getState('youtube.subItemsMap') || {};
    const ids = subMap[currentItem?.playlistId as string]?.ids || [];
    const targetVideoId = ids[subIdx] || player.getVideoData?.()?.video_id || '';

    scheduleYtAutoSync(0, {
      subIndex: subIdx,
      videoId: targetVideoId,
      skipSeek: true,
      countdownMs: 3000,
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
