/**
 * MUSIXQUARE 3.0 — YouTube Protocol Handlers
 *
 * Manages: Network message handlers for YouTube commands
 * (play, pause, toggle, sub-seek, playlist-info).
 */

import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { broadcast, safeSend } from '../network/peer.ts';
import { verifyOperator } from '../network/protocol.ts';
import { getYouTubePlayer } from './_state.ts';
import { loadYouTubeVideo } from './iframe.ts';
import type { DataConnection } from '../types/index.ts';

declare const YT: any;

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

  if (index !== undefined) {
    setState('playlist.currentTrackIndex', index);
  }

  loadYouTubeVideo(videoId, playlistId, autoplay ?? false, subIndex ?? 0);
}

export function handleRequestYouTubePlay(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only Host

  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected request-youtube-play from non-OP: ${conn?.peer}`);
    return;
  }

  const player = getYouTubePlayer();
  if (player?.playVideo) {
    player.playVideo();
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state: 1,
      time: player.getCurrentTime?.() || 0,
    });
  }
}

export function handleRequestYouTubePause(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected request-youtube-pause from non-OP: ${conn?.peer}`);
    return;
  }

  const player = getYouTubePlayer();
  if (player?.pauseVideo) {
    player.pauseVideo();
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state: 2,
      time: player.getCurrentTime?.() || 0,
    });
  }
}

export function handleRequestYouTubeToggle(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected request-youtube-toggle from non-OP: ${conn?.peer}`);
    return;
  }

  const player = getYouTubePlayer();
  if (!player) return;
  try {
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      // Inline pause — verifyOperator already checked above
      if (player.pauseVideo) {
        player.pauseVideo();
        broadcast({ type: MSG.YOUTUBE_STATE, state: 2, time: player.getCurrentTime?.() || 0 });
      }
    } else {
      // Inline play — verifyOperator already checked above
      if (player.playVideo) {
        player.playVideo();
        broadcast({ type: MSG.YOUTUBE_STATE, state: 1, time: player.getCurrentTime?.() || 0 });
      }
    }
  } catch (e) {
    log.error('[YouTube] Toggle error:', e);
  }
}

export function handleRequestYouTubeSubSeek(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[YouTube] Rejected request-youtube-sub-seek from non-OP: ${conn?.peer}`);
    return;
  }

  const subIdx = data.subIdx as number;
  const player = getYouTubePlayer();
  if (player?.playVideoAt && typeof subIdx === 'number') {
    player.playVideoAt(subIdx);
    setState('youtube.currentSubIndex', subIdx);
    broadcast({
      type: MSG.YOUTUBE_STATE,
      state: 1,
      time: 0,
      subIndex: subIdx,
    });
  }
}

/**
 * Host responds to Guest's request for YouTube playlist sub-item data.
 * Sends cached IDs and titles from subItemsMap.
 */
export function handleRequestYouTubePlaylistInfo(data: Record<string, unknown>, conn?: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only Host handles this

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
