/**
 * MUSIXQUARE — YouTube Protocol Handlers
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
import { getYouTubePlayer, setLocalYouTubePaused, setYouTubeSubIndex } from './_state.ts';
import { loadYouTubeVideo } from './iframe.ts';
import { scheduleYtAutoSync } from './player.ts';
import { TRACK_TRANSITION_RENDEZVOUS_MS } from './constants.ts';
import { clearReceiveState } from '../storage/transfer-receive.ts';
import { cancelRemoteShareWait } from '../share/remote-share.ts';
import {
  createYouTubeTrackMeta,
  setPlaybackTrackMeta,
  setPlaybackTransferState,
} from '../player/ownership.ts';
import { showLoader } from '../ui/toast.ts';
import type { DataConnection } from '../types/index.ts';

import type { YTNamespace } from './_state.ts';
declare const YT: YTNamespace;

// ─── Network Handlers ──────────────────────────────────────────────

export function handleYouTubePlay(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop YOUTUBE_PLAY frames not arriving via hostConn. Without this, a
  // malicious peer can send
  // {type:'youtube-play', videoId:'<attacker_id>', autoplay:true} — the
  // handler cancels in-flight file transfer, sets currentTrackMeta, and
  // calls loadYouTubeVideo() which forces the target into YouTube mode
  // playing arbitrary attacker-supplied content regardless of the target's
  // current mode.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const videoId = data.videoId as string | null;
  const playlistId = data.playlistId as string | null;
  const name = data.name as string | null;
  const index = data.index as number | undefined;
  const autoplay = data.autoplay as boolean | undefined;
  const subIndex = data.subIndex as number | undefined;

  if (!videoId && !playlistId) {
    log.warn('[YouTube] handleYouTubePlay: no videoId or playlistId');
    return;
  }

  setLocalYouTubePaused(false);

  // A new host command arrived — cancel any pending guest-ENDED fallback
  // from a prior track's ENDED event. Without this, the 5s fallback can
  // fire AFTER a new YOUTUBE_PLAY has already loaded the next track and
  // drop the guest out of YouTube mode on its own.
  clearManagedTimer('yt-guest-ended-fallback');

  // Cancel any in-flight file transfer before switching to YouTube mode.
  cancelInFlightTransfer();

  if (index !== undefined) {
    setState('playlist.currentTrackIndex', index);
  }

  // Mirror host's playTrack(): set currentTrackMeta so the UI doesn't display
  // "미디어 없음". Prefer the synced playlist entry (has the real title from
  // PLAYLIST_UPDATE); fall back to a synthetic meta built from the broadcast's
  // `name` field when the playlist hasn't landed yet (late-join races).
  const playlist = getState('playlist.items') || [];
  const playlistItem = index !== undefined && index >= 0 ? playlist[index] : undefined;
  if (playlistItem) {
    setPlaybackTrackMeta(playlistItem);
  } else if (name || videoId) {
    setPlaybackTrackMeta(
      createYouTubeTrackMeta({
        name: name || '',
        videoId: videoId || null,
        playlistId: playlistId || null,
      }),
    );
  }

  let finalVideoId = videoId;
  let finalPlaylistId = playlistId;

  // Early-guest fallback: if the host's payload only has a playlistId (no
  // videoId) and we have cached IDs for that playlist, short-circuit to
  // single-video mode. Without cached IDs we must fall through to the
  // native playlist engine to avoid error 150.
  if (!finalVideoId && finalPlaylistId) {
    const subMap = getState('youtube.subItemsMap') || {};
    const knownIds = subMap[finalPlaylistId]?.ids;
    if (knownIds && knownIds.length > 0) {
      finalVideoId = knownIds[0];
      finalPlaylistId = null;
    }
  }

  // When we have a videoId, force playlistId to null so the iframe's native
  // playlist engine stays dormant — single-video mode only.
  loadYouTubeVideo(
    finalVideoId,
    finalVideoId ? null : finalPlaylistId,
    autoplay ?? false,
    subIndex ?? 0,
  );
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

export function handleRequestYouTubePlay(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  if (!guardHostRequest(data, conn, 'request-youtube-play')) return;

  const player = getYouTubePlayer();
  if (player?.getCurrentTime) {
    scheduleYtAutoSync(player.getCurrentTime() || 0);
  }
}

export function handleRequestYouTubePause(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  if (!guardHostRequest(data, conn, 'request-youtube-pause')) return;

  const player = getYouTubePlayer();
  if (player?.pauseVideo) {
    const time = player.getCurrentTime?.() || 0;
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

export function handleRequestYouTubeSubSeek(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
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
    // No playVideoAt — keeps the native playlist engine dormant so the
    // iframe stays on one video at a time.
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
      // F-2409: OP sub-seek loads a DIFFERENT video — use the longer
      // track-transition rendezvous so guests loadVideoById before synced play,
      // matching navigateSubVideo and the loadVideoById siblings in player.ts.
      rendezvousDelayMs: TRACK_TRANSITION_RENDEZVOUS_MS,
    });
  }
}

/**
 * Host responds to Guest's request for YouTube playlist sub-item data.
 * Sends cached IDs and titles from subItemsMap.
 */
export function handleRequestYouTubePlaylistInfo(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
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
  // R2 download first, UNCONDITIONALLY: the remote path never sets
  // transfer.state, so the RECEIVING/PROCESSING gate below is blind to it —
  // without this an in-flight encrypted download keeps streaming over mobile
  // data through the whole YouTube switch, repaints the loader on top of the
  // new mode, and leaves the 5-minute wait timer armed. Idempotent no-op when
  // nothing is in flight. (No cycle: remote-share imports no youtube/*.)
  cancelRemoteShareWait('youtube-play');

  const transferState = getState('transfer.state');
  if (transferState === TRANSFER_STATE.RECEIVING || transferState === TRANSFER_STATE.PROCESSING) {
    log.debug('[YouTube] Cancelling in-flight file transfer for YouTube switch');
    // shouldSkipIncomingFile() returns true via YouTube ownership
    // (set by handleYouTubePlay before this helper runs), so no flag.
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('preloadWatchdog');
    // Clear receive-side reorder buffer / early-chunk queue.
    // No circular dependency: transfer-receive does not import any youtube/* module.
    try {
      clearReceiveState();
    } catch (e) {
      log.debug('[YouTube] clearReceiveState failed:', e);
    }
    showLoader(false);
  }
}
