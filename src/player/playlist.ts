/**
 * MUSIXQUARE — Playlist Management
 *
 * Manages: playlist array, repeat/shuffle modes, playTrack,
 * playNextTrack, playPrevTrack, clearPreloadState.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { DEFAULT_MAX_GUEST_SLOTS, MSG, WARN_WHEN_MAX_SLOTS_AT_LEAST } from '../core/constants.ts';
import { nextSessionId } from '../core/session.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import {
  play,
  pause,
  stopAllMedia,
  getTrackPosition,
  isFilePipelineBusyForPlay,
} from './transport.ts';
import { clearPreviousTrackState, loadAndBroadcastFile, loadPreloadedTrack } from './decode.ts';
import {
  newLoadEpoch,
  isCurrentLoadEpoch,
  getCurrentAudioBuffer,
  setCurrentAudioBuffer,
} from './_state.ts';
import { partitionAudioFileCandidates } from '../media/audio-file.ts';
import { transition } from './lifecycle.ts';

import {
  schedulePreload,
  cancelPreloadTransfer,
  resetPreloadReceiveAuthority,
} from '../storage/preload.ts';
import {
  setEQ,
  setExciter,
  setPreamp,
  setStereoWidth,
  setVirtualBass,
  setReverbParam,
} from '../audio/effects.ts';
import { postCommand } from '../storage/storage.ts';
import {
  cancelIncomingFileTransfer,
  cancelOutgoingFileTransfers,
  cancelPendingBroadcast,
  resetIncomingTransferAuthority,
} from '../storage/transfer.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { setPendingAutoSyncOnReady } from '../youtube/player.ts';
import { isGuestBlocked } from '../network/guards.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { isPlaybackIdleCompat, isYouTubeOwner, setPlaybackTrackMeta } from './ownership.ts';
import type { DataConnection, PlaylistItem, QueueItemId } from '../types/index.ts';
import { showToast } from '../ui/toast.ts';
import { showDialog } from '../ui/dialog.ts';
import { hasFileShareWarned, markFileShareWarned } from '../ui/large-room-warnings.ts';
import { cancelRemoteShareWait, shareRemoteFileIfNeeded } from '../share/remote-share.ts';
import { getHostNow } from '../network/shared-clock.ts';
import { hasQueueAuthority, markQueueAuthorityReady } from '../network/queue-authority.ts';
import { resetRecoveryAuthority } from '../storage/recovery.ts';
import {
  applyPlaylistSnapshot,
  commitPlaylistItems,
  createPlaylistSnapshot,
  createQueueItemId,
  findQueueItemIndex,
  getCurrentQueueItemId,
  getCurrentQueueItemIndex,
  getQueueItemById,
  moveQueueItemBefore,
  selectQueueItemById,
} from './queue-model.ts';

const LOCAL_FILE_PLAY_SCHEDULE_AHEAD_MS = 200;

function getLocalFileHostPlayAt(): number {
  return getHostNow() + LOCAL_FILE_PLAY_SCHEDULE_AHEAD_MS;
}

// ─── Shuffle Order (Fisher-Yates) ──────────────────────────────────
// A persistent permutation of queue occurrence IDs so that prev/next in shuffle
// mode traverse a stable order — going back and then forward returns to the
// same track. Regenerated on:
//   - shuffle toggled ON
//   - new occurrences are added (removal/reorder preserve surviving ID order)
//   - full shuffle exhausted with repeat-all (reshuffle for a fresh pass)

let _shuffleOrder: QueueItemId[] = [];
let _shufflePosition = 0;
const DEMO_ALLOWED_SETTING_TYPES = new Set<string>([
  'eq',
  MSG.VBASS,
  MSG.EXCITER,
  MSG.STEREO_WIDTH,
  MSG.REVERB_TYPE,
]);

function isQueueIdle(): boolean {
  return isPlaybackIdleCompat();
}

function generateShuffleOrder(): void {
  const playlist = getState('playlist.items') || [];
  if (playlist.length === 0) {
    _shuffleOrder = [];
    _shufflePosition = 0;
    return;
  }
  const order = playlist.map((item) => item.queueItemId);
  // Fisher-Yates in-place shuffle
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  _shuffleOrder = order;
  // Align the cursor to wherever the current track now lives in the new order
  const currentQueueItemId = getCurrentQueueItemId();
  const pos = currentQueueItemId ? order.indexOf(currentQueueItemId) : -1;
  _shufflePosition = pos >= 0 ? pos : 0;
}

function ensureShuffleOrderValid(): void {
  const playlist = getState('playlist.items') || [];
  const liveIds = new Set(playlist.map((item) => item.queueItemId));
  if (
    _shuffleOrder.length !== playlist.length ||
    _shuffleOrder.some((queueItemId) => !liveIds.has(queueItemId))
  ) {
    generateShuffleOrder();
  }
}

/**
 * Expose for tests, preload.ts, and decode recovery to query the next slot in
 * the row-level shuffle order without advancing the cursor.
 */
export function getShuffleNextPlayableQueueItemId(
  isCandidate: (queueItemId: QueueItemId, item: Readonly<PlaylistItem>) => boolean = () => true,
): QueueItemId | null {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  if (playlist.length <= 1) return null;

  const currentQueueItemId = getCurrentQueueItemId();
  const anchor = currentQueueItemId ? _shuffleOrder.indexOf(currentQueueItemId) : -1;
  const startPos = anchor >= 0 ? anchor : currentQueueItemId ? _shufflePosition : -1;

  for (let pos = startPos + 1; pos < _shuffleOrder.length; pos++) {
    const queueItemId = _shuffleOrder[pos];
    const item = queueItemId ? getQueueItemById(queueItemId, playlist) : null;
    if (
      queueItemId &&
      item &&
      queueItemId !== currentQueueItemId &&
      isCandidate(queueItemId, item)
    ) {
      return queueItemId;
    }
  }

  if (repeatMode !== 1) return null;

  for (let pos = 0; pos <= startPos && pos < _shuffleOrder.length; pos++) {
    const queueItemId = _shuffleOrder[pos];
    const item = queueItemId ? getQueueItemById(queueItemId, playlist) : null;
    if (
      queueItemId &&
      item &&
      queueItemId !== currentQueueItemId &&
      isCandidate(queueItemId, item)
    ) {
      return queueItemId;
    }
  }

  return null;
}

/** Expose for tests & for preload.ts to query the "next in shuffle order". */
export function getShuffleNextQueueItemId(): QueueItemId | null {
  return getShuffleNextPlayableQueueItemId();
}

export function advanceToShuffleNextQueueItemId(
  preferredQueueItemId: QueueItemId | null = null,
): QueueItemId | null {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  const currentQueueItemId = getCurrentQueueItemId();
  if (playlist.length <= 1) return null;

  if (
    preferredQueueItemId !== null &&
    preferredQueueItemId !== currentQueueItemId &&
    getQueueItemById(preferredQueueItemId, playlist)
  ) {
    const pos = _shuffleOrder.indexOf(preferredQueueItemId);
    if (pos >= 0) _shufflePosition = pos;
    return preferredQueueItemId;
  }

  const anchor = currentQueueItemId ? _shuffleOrder.indexOf(currentQueueItemId) : -1;
  if (anchor >= 0) _shufflePosition = anchor;
  if (!currentQueueItemId) {
    _shufflePosition = 0;
    return _shuffleOrder[0] ?? null;
  }

  const nextPos = _shufflePosition + 1;
  if (nextPos >= _shuffleOrder.length) {
    if (repeatMode !== 1) return null;

    generateShuffleOrder();
    _shufflePosition = 0;
    let nextQueueItemId =
      _shuffleOrder[0] === currentQueueItemId && _shuffleOrder.length > 1
        ? _shuffleOrder[1]
        : _shuffleOrder[0];
    if (nextQueueItemId === currentQueueItemId && _shuffleOrder.length > 1) {
      nextQueueItemId = _shuffleOrder[1];
      _shufflePosition = 1;
    } else {
      _shufflePosition = nextQueueItemId ? _shuffleOrder.indexOf(nextQueueItemId) : 0;
    }
    return nextQueueItemId ?? null;
  }

  _shufflePosition = nextPos;
  return _shuffleOrder[nextPos] ?? null;
}

export function advanceToShufflePreviousQueueItemId(): QueueItemId | null {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  if (playlist.length <= 1) return null;

  const currentQueueItemId = getCurrentQueueItemId();
  const anchor = currentQueueItemId ? _shuffleOrder.indexOf(currentQueueItemId) : -1;
  if (anchor >= 0) _shufflePosition = anchor;

  let prevPos = _shufflePosition - 1;
  if (prevPos < 0) {
    if (repeatMode !== 1) return null;
    prevPos = _shuffleOrder.length - 1;
  }

  _shufflePosition = prevPos;
  return _shuffleOrder[prevPos] ?? null;
}

function resetShuffleOrder(): void {
  _shuffleOrder = [];
  _shufflePosition = 0;
}

// ─── Repeat / Shuffle ──────────────────────────────────────────────

export function toggleRepeat(): void {
  if (isGuestBlocked()) return;
  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  const repeatMode = getState('playlist.repeatMode') || 0;
  const nextMode = (repeatMode + 1) % 3;
  setRepeatMode(nextMode);

  if (!hostConn) {
    broadcast({ type: MSG.REPEAT_MODE, value: nextMode });
  } else if (isOperator) {
    sendToHost({ type: MSG.REQUEST_SETTING, settingType: 'repeat-mode', value: nextMode });
  }
}

export function setRepeatMode(mode: number, notify = true): void {
  const prevMode = getState('playlist.repeatMode') || 0;
  setState('playlist.repeatMode', mode);
  const btn = document.getElementById('btn-repeat');
  if (btn) {
    btn.classList.remove('active', 'active-one');
    if (mode === 1) btn.classList.add('active');
    else if (mode === 2) btn.classList.add('active-one');
  }

  if (notify) {
    if (mode === 1) showToast(t('playlist.repeat_all'));
    else if (mode === 2) showToast(t('playlist.repeat_one'));
    else showToast(t('playlist.repeat_off'));
  }

  // The "next track" that preload staged was chosen under the previous mode.
  // When repeat-one toggles in/out of 2, the intended next changes (repeat-one
  // means "replay current" which doesn't preload a different track). Also
  // sequential→repeat-all at last track flips from end-of-playlist to wrap-0.
  // Regenerate preload on host only.
  if (mode !== prevMode) {
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      clearPreloadState();
      schedulePreload();
    }
  }
}

export function toggleShuffle(): void {
  if (isGuestBlocked()) return;
  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  const isShuffle = getState('playlist.isShuffle');
  const nextShuffle = !isShuffle;
  setShuffle(nextShuffle);

  if (!hostConn) {
    broadcast({ type: MSG.SHUFFLE_MODE, value: nextShuffle });
  } else if (isOperator) {
    sendToHost({ type: MSG.REQUEST_SETTING, settingType: 'shuffle-mode', value: nextShuffle });
  }
}

export function setShuffle(enabled: boolean, notify = true): void {
  const prevEnabled = getState('playlist.isShuffle');
  setState('playlist.isShuffle', enabled);
  const btn = document.getElementById('btn-shuffle');
  if (btn) btn.classList.toggle('active', enabled);
  if (notify) showToast(enabled ? t('playlist.shuffle_on') : t('playlist.shuffle_off'));

  // Re-seed the Fisher-Yates permutation whenever shuffle turns ON so that
  // prev/next traverse a fresh random order. On OFF, drop the stale order.
  if (enabled) generateShuffleOrder();
  else resetShuffleOrder();

  // Preload was chosen under the opposite mode — the stale hint may point to
  // a track that is no longer the "next" under the new mode (sequential vs
  // shuffled). Regenerate on host only.
  if (enabled !== prevEnabled) {
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      clearPreloadState();
      schedulePreload();
    }
  }
}

// ─── Clear Preload State ───────────────────────────────────────────

export function clearPreloadState(force = false): void {
  const activeTarget = getState('preload.activeTarget');
  const ready = getState('preload.ready');
  const currentQueueItemId = getCurrentQueueItemId();
  const preloadOwner = ready?.queueItemId ?? activeTarget?.queueItemId ?? null;
  const isPreloadOwnerActive =
    !force && preloadOwner !== null && preloadOwner === currentQueueItemId;

  // Cancel any in-flight backgroundTransfer to prevent stale preload data
  // from reaching guests after backward navigation (host-only).
  cancelPreloadTransfer();
  if (force) resetPreloadReceiveAuthority();

  setState('preload.nextQueueItemId', null);
  if (!isPreloadOwnerActive) {
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
  }
  setState('preload.isPreloading', false);

  // Guests reset preload storage on track change, so invalidate the host's
  // per-peer preload cache as well.
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    const connectedPeers = getState('network.connectedPeers') || [];
    if (
      connectedPeers.length > 0 &&
      connectedPeers.some((p) => p.preloadedQueueItemIds?.size > 0)
    ) {
      const updatedPeers = connectedPeers.map((p) =>
        p.preloadedQueueItemIds?.size > 0
          ? { ...p, preloadedQueueItemIds: new Set<QueueItemId>() }
          : p,
      );
      setState('network.connectedPeers', updatedPeers);
    }
  }

  // Guest side
  postCommand({ command: 'STORAGE_RESET', isPreload: true });
}

// ─── Play Track ────────────────────────────────────────────────────

export async function playTrack(queueItemId: QueueItemId, subIndex?: number): Promise<void> {
  const playlist = getState('playlist.items') || [];
  const indexHint = findQueueItemIndex(queueItemId, playlist);
  const item = indexHint >= 0 ? playlist[indexHint] : null;
  if (!item) {
    if (playlist.length === 0) showToast(t('toast.no_tracks'));
    return;
  }

  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  // A direct track choice supersedes any scheduled decode-failure advance.
  // The timer also validates its load epoch when it fires.
  clearManagedTimer('decode-fail-advance');

  const hostConn = getState('network.hostConn');

  // ─── Fast Path: Host re-clicks currently-playing local file ─────────
  // Skip full reload/rebroadcast/preload-reset. Just reset position to 0
  // and restart after the standard 3s delay. Guests get a FILE_PREPARE
  // with autoPlayDelayMs which routes through their same-file replay
  // branch — no re-download.
  //
  // Buffer existence alone does not establish ownership: superseded loads may
  // leave the previous track resident while selection has advanced. The
  // resident's queueItemId, not its name or former array slot, proves ownership.
  const _isSameTrack = queueItemId === getCurrentQueueItemId();
  const _isLocalFileTrack = item.type !== 'youtube' && !!item.file;
  const _resident = getState('files.current');
  const _bufferMatchesTrack = !!getCurrentAudioBuffer() && _resident?.queueItemId === queueItemId;

  if (!hostConn && _isSameTrack && _isLocalFileTrack && _bufferMatchesTrack) {
    log.debug('[Host] Same-track re-click — fast replay path (no redecode/rebroadcast)');

    const file = item.file!;
    const sessionId =
      _resident?.sessionId || getState('transfer.currentSessionId') || nextSessionId();
    const isFirstTrackLoad = getState('player.isFirstTrackLoad');
    const autoPlayDelayMs = isFirstTrackLoad ? 0 : 3000;

    // Tell guests via FILE_PREPARE → their same-file branch emits
    // playback:replay-current(delayMs), which defers play(0) accordingly.
    broadcast({
      type: MSG.FILE_PREPARE,
      name: file.name,
      queueItemId,
      sessionId,
      // Size is transport metadata only; receivers never treat name+size as
      // media identity.
      size: file.size,
      mime: file.type,
      autoPlayDelayMs,
    });
    void shareRemoteFileIfNeeded(file, sessionId, undefined, { queueItemId });

    // Reset host position to 0 and wait, mirroring the normal branch's UX
    pause(0, { holdVisualizer: false });
    setState('player.pausedAt', 0);

    if (isFirstTrackLoad) {
      setState('player.isFirstTrackLoad', false);
    } else {
      showToast(t('toast.playing_in_3s'));
    }

    setManagedTimer(
      'autoPlayTimer',
      () => {
        if (getCurrentQueueItemId() !== queueItemId || !getQueueItemById(queueItemId)) return;
        play(0);
        broadcast({
          type: MSG.PLAY,
          time: 0,
          queueItemId,
          name: file.name,
          hostPlayAt: getLocalFileHostPlayAt(),
        });
      },
      autoPlayDelayMs,
    );

    return;
  }

  // Cancel in-flight preload (only for non-fast-path — fast path preserves
  // the preload cache since the next track is unchanged)
  setState('preload.isPreloading', false);

  // Auto-switch to Play tab (Host only)
  if (!hostConn) bus.emit('ui:switch-tab', 'play');

  const myLoadEpoch = newLoadEpoch();

  // Check if preloaded
  const nextQueueItemId = getState('preload.nextQueueItemId');
  const readyPreload = getState('preload.ready');

  if (queueItemId === nextQueueItemId && readyPreload?.queueItemId === queueItemId && !hostConn) {
    log.debug('[Host] Using preloaded queue item:', queueItemId);
    selectQueueItemById(queueItemId);
    setPlaybackTrackMeta(item);

    // Advance session ID for recovery
    if (Number.isSafeInteger(readyPreload.sessionId) && readyPreload.sessionId > 0) {
      setState('transfer.currentSessionId', readyPreload.sessionId);
    } else {
      setState('transfer.currentSessionId', nextSessionId());
    }

    stopAllMedia({ silent: true }); // suppress IDLE flash — play() follows immediately

    const fileName = item.file?.name || item.name;
    broadcast({
      type: MSG.PLAY_PRELOADED,
      queueItemId,
      name: fileName,
      mime: item.file?.type,
    });

    // Host must transition to DECODING before decode begins, so that the
    // subsequent DECODE_SUCCESS lands cleanly on READY.
    transition({ type: 'PLAY_PRELOADED', variant: 'blob-ready', queueItemId, name: fileName });

    // Play and broadcast only after the current activation succeeds. Failure
    // owns its auto-advance path; supersession transfers playback ownership to
    // the newer playTrack invocation.
    const activated = await loadPreloadedTrack(queueItemId, myLoadEpoch);
    if (!activated || !isCurrentLoadEpoch(myLoadEpoch) || getCurrentQueueItemId() !== queueItemId) {
      log.debug('[Host] Preloaded activation failed or superseded — skipping play/broadcast');
      return;
    }
    // Whole-file remote encryption is admitted against the active PCM buffer.
    // Start it only after this preloaded track has decoded and published its
    // own AudioBuffer, never while the previous track still owns that slot.
    if (item.file) {
      const remoteShareSessionId = getState('transfer.currentSessionId') || null;
      void shareRemoteFileIfNeeded(item.file, remoteShareSessionId, undefined, { queueItemId });
    }
    await play(0);
    broadcast({
      type: MSG.PLAY,
      time: 0,
      queueItemId,
      name: fileName,
      hostPlayAt: getLocalFileHostPlayAt(),
    });
    // SharedClock handles sync
    schedulePreload();
    return;
  }

  clearPreloadState();
  selectQueueItemById(queueItemId);
  setPlaybackTrackMeta(item);

  // YouTube
  if (item.type === 'youtube') {
    // Force-clear any stale audio preload state to prevent incorrect
    // preloaded file being used when switching back from YouTube to audio
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
    setState('preload.nextQueueItemId', null);

    // Cancel a debounced local-file broadcast before entering YouTube. An
    // already in-flight transfer may finish because its bytes remain reusable
    // if the room returns to that file.
    cancelPendingBroadcast();

    if (!hostConn) {
      // Skip stopAllMedia for YouTube→YouTube transitions — loadYouTubeVideo
      // reuses the existing player instance, preserving the iOS user gesture.
      // Destroying the iframe forces a "tap to play" on mobile.
      const isYtToYt = isYouTubeOwner();
      if (!isYtToYt) stopAllMedia({ silent: true }); // suppress IDLE flash — youtube:load follows

      // Broadcast one resolved videoId; playlistId is UI/navigation context,
      // not an instruction to start YouTube's native playlist engine. Prefer
      // the host's sub-item snapshot when available.
      const subMap = getState('youtube.subItemsMap') || {};
      const hostIds = subMap[item.playlistId as string]?.ids;
      const broadcastVideoId = (hostIds && hostIds[subIndex ?? 0]) || (item.videoId ?? null);

      // Compute autoplay once so the host iframe and guest broadcast agree.
      // Only the first YouTube entry in a fresh session waits for a user tap.
      const isFirstTrackLoad = getState('player.isFirstTrackLoad');
      const isAlreadyYt = isYouTubeOwner();
      const shouldAutoplay = !(isFirstTrackLoad && !isAlreadyYt);

      broadcast({
        type: MSG.YOUTUBE_PLAY,
        videoId: broadcastVideoId,
        playlistId: item.playlistId ?? null,
        name: item.name || item.title,
        queueItemId,
        autoplay: shouldAutoplay,
        subIndex: subIndex ?? 0,
      });

      // Also send YOUTUBE_PLAYLIST_INFO so guests have the sub-items map
      // for navigation (next/prev/sub-seek) and title display.
      if (hostIds && hostIds.length > 0) {
        const titles = subMap[item.playlistId as string]?.titles || [];
        broadcast({
          type: MSG.YOUTUBE_PLAYLIST_INFO,
          playlistId: item.playlistId as string,
          ids: hostIds,
          titles,
        });
      }

      // shouldAutoplay computed above mirrors this branch decision: the
      // first-load + first-time-YT path waits for the user, every other
      // path autoplays. The host's own iframe load uses the same flag
      // so it stays in lockstep with the broadcast.
      if (isFirstTrackLoad && !isAlreadyYt) {
        setState('player.isFirstTrackLoad', false);
        bus.emit(
          'youtube:load',
          item.videoId ?? null,
          item.playlistId ?? null,
          queueItemId,
          shouldAutoplay,
          subIndex ?? 0,
        );
        showToast(t('youtube.ready'));
      } else {
        if (isFirstTrackLoad) setState('player.isFirstTrackLoad', false);
        bus.emit(
          'youtube:load',
          item.videoId ?? null,
          item.playlistId ?? null,
          queueItemId,
          shouldAutoplay,
          subIndex ?? 0,
        );
        // Arm after youtube:load: fresh non-YT -> YT loads synchronously
        // stop existing media, which clears stale pending sync first.
        setPendingAutoSyncOnReady(true, {
          isTrackTransition: isAlreadyYt,
          targetTime: 0,
          subIndex: subIndex ?? 0,
          videoId: broadcastVideoId ?? undefined,
          skipSeek: true,
        });
      }

      // Keep hybrid playlists warm; preload scanning skips YouTube entries and
      // selects the next preloadable local file.
      schedulePreload();
    }
    return;
  }

  // Local file playback
  stopAllMedia({ silent: true }); // suppress IDLE flash — play() follows

  const file = item.file;
  if (!file) {
    log.warn('[Playlist] No file for queue item', queueItemId);
    return;
  }

  if (!hostConn) {
    const sessionId = nextSessionId();
    setState('transfer.currentSessionId', sessionId);

    const isFirstTrackLoad = getState('player.isFirstTrackLoad');
    // Tell guests how long the host will wait before actually calling play(0).
    // Guests on the "same-file replay" path use this to defer their own
    // play(0), otherwise they ghost-play for 3s while the host is still
    // waiting on its autoPlayTimer.
    const autoPlayDelayMs = isFirstTrackLoad ? 0 : 3000;

    // FILE_PREPARE is coalesced into the same debounce as broadcastFile.
    // Sending it eagerly here would flood guests with metadata updates for
    // every track the user clicked through, racing against PLAY messages
    // and surfacing as "Name mismatch on PLAY" with the guest stuck waiting
    // on a FILE_PREPARE that already arrived as a stale earlier one.
    const prepareMsg = {
      type: MSG.FILE_PREPARE,
      name: file.name,
      queueItemId,
      sessionId,
      // Name and size are transport metadata, not media identity.
      size: file.size,
      mime: file.type,
      autoPlayDelayMs,
    };
    const didLoad = await loadAndBroadcastFile(
      file,
      queueItemId,
      sessionId,
      myLoadEpoch,
      prepareMsg,
    );
    if (!didLoad) return;

    if (isFirstTrackLoad) {
      setState('player.isFirstTrackLoad', false);
      showToast(t('toast.file_ready'));
    } else {
      showToast(t('toast.playing_in_3s'));
      setManagedTimer(
        'autoPlayTimer',
        () => {
          if (getCurrentQueueItemId() !== queueItemId || !getQueueItemById(queueItemId)) return;
          play(0);
          broadcast({
            type: MSG.PLAY,
            time: 0,
            queueItemId,
            name: file.name,
            hostPlayAt: getLocalFileHostPlayAt(),
          });
          // SharedClock handles sync
        },
        autoPlayDelayMs,
      );
    }
  }
}

// ─── End Of Playlist Handler ───────────────────────────────────────

/**
 * Uniform cleanup path for "playlist finished, nothing should be selected".
 *
 * Clears track meta, audio buffer, and deselects currentQueueItemId so the
 * UI state ("미디어 없음") is internally consistent with transport state.
 * Broadcasts MSG.PAUSE{endOfPlaylist:true} so guests mirror the reset.
 *
 * Clearing the resident buffer and selecting no queue item ensures a later Play
 * restarts from the top instead of resuming an unselected final track.
 */
function handleEndOfPlaylist(reason: string): void {
  log.debug(`[Host] End of playlist: ${reason}. Resetting to deselected state.`);
  stopAllMedia();
  setCurrentAudioBuffer(null);
  setPlaybackTrackMeta(null);
  selectQueueItemById(null);
  setState('files.current', null);
  setState('player.pausedAt', 0);
  // Host's own lifecycle: mirror the broadcast PAUSE{endOfPlaylist:true} so
  // playback.lifecycle returns to IDLE in lockstep with guests.
  transition({ type: 'PAUSE', time: 0, queueItemId: null, endOfPlaylist: true });
  broadcast({
    type: MSG.PAUSE,
    time: 0,
    queueItemId: null,
    endOfPlaylist: true,
    reason: 'end-of-playlist',
  });
  showToast(t('toast.playlist_ended'));
}

// ─── Play Next Track ───────────────────────────────────────────────

export function playNextTrack(): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_NEXT_TRACK, queueItemId: getCurrentQueueItemId() });
    return;
  }

  // Host: YouTube internal navigation
  const repeatMode = getState('playlist.repeatMode') || 0;

  // Repeat-one intentionally does not short-circuit to "replay
  // current track" here. Natural track-end handles its own repeat-one
  // replay — for local files, the `player:ended` listener at the bottom
  // of this module; for YouTube, the iframe ENDED handler in
  // youtube/iframe.ts. Reaching this function therefore means either
  //   (a) a manual Next button / media-session skip, or
  //   (b) a YouTube error-recovery bus emit on an unavailable video.
  // In both cases the command must advance rather than replay the same track.

  if (isYouTubeOwner()) {
    let handled = false;
    bus.emit('youtube:try-next-internal', (success: boolean) => {
      handled = success;
    });
    if (handled) return;
  }

  const playlist = getState('playlist.items') || [];
  const currentIndex = getCurrentQueueItemIndex();
  const isShuffle = getState('playlist.isShuffle');
  const preloadedQueueItemId = getState('preload.nextQueueItemId');

  if (playlist.length === 0) return;

  let nextQueueItemId: QueueItemId | null;

  if (isShuffle) {
    if (playlist.length === 1) {
      // Single-track + shuffle + repeat OFF → stop (same as sequential behavior)
      if (repeatMode === 0) {
        handleEndOfPlaylist('single-track-shuffle');
        return;
      }
      nextQueueItemId = playlist[0]?.queueItemId ?? null;
    } else {
      nextQueueItemId = advanceToShuffleNextQueueItemId(preloadedQueueItemId);
      if (!nextQueueItemId) {
        handleEndOfPlaylist('shuffle-end');
        return;
      }
    }
  } else {
    let nextIndex = currentIndex + 1;
    if (nextIndex >= playlist.length) {
      if (repeatMode === 1) {
        nextIndex = 0;
      } else {
        handleEndOfPlaylist('sequential-end');
        return;
      }
    }
    nextQueueItemId = playlist[nextIndex]?.queueItemId ?? null;
  }

  if (nextQueueItemId) {
    playTrack(nextQueueItemId);
  }
}

// ─── Play Previous Track ───────────────────────────────────────────

/**
 * Restart the resident buffer from 0:00 and broadcast (Prev-button
 * "restart current track" semantics).
 *
 * During file preparation the resident AudioBuffer belongs to the prior track.
 * Ignore restart in that window and let decode completion own the new start.
 */
function restartCurrentTrackFromStart(queueItemId: QueueItemId): void {
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Playlist] Ignoring restart-current while file pipeline is preparing');
    return;
  }
  play(0);
  broadcast({
    type: MSG.PLAY,
    time: 0,
    queueItemId,
    hostPlayAt: getLocalFileHostPlayAt(),
  });
  // SharedClock handles sync
}

export function playPrevTrack(): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_PREV_TRACK, queueItemId: getCurrentQueueItemId() });
    return;
  }

  const currentQueueItemId = getCurrentQueueItemId();
  const currentIndex = getCurrentQueueItemIndex();

  // YouTube mode
  if (isYouTubeOwner()) {
    let handled = false;
    bus.emit('youtube:try-prev-internal', (success: boolean) => {
      handled = success;
    });
    if (handled) return;

    const playlist = getState('playlist.items') || [];
    const repeatMode = getState('playlist.repeatMode') || 0;
    const isShuffle = getState('playlist.isShuffle');

    if (isShuffle && playlist.length > 1) {
      const previousQueueItemId = advanceToShufflePreviousQueueItemId();
      if (previousQueueItemId) {
        playTrack(previousQueueItemId);
      } else if (currentQueueItemId) {
        playTrack(currentQueueItemId);
      }
      return;
    }

    if (currentIndex > 0) {
      const previousQueueItemId = playlist[currentIndex - 1]?.queueItemId;
      if (previousQueueItemId) playTrack(previousQueueItemId);
    } else {
      if (repeatMode === 1 && playlist.length > 1) {
        const lastQueueItemId = playlist.at(-1)?.queueItemId;
        if (lastQueueItemId) playTrack(lastQueueItemId);
      } else if (playlist[0]) {
        playTrack(playlist[0].queueItemId);
      }
    }
    return;
  }

  // Local mode: restart if > 3s, else previous track
  const pos = getTrackPosition();
  if (pos > 3) {
    // Restart current track from the beginning
    if (currentQueueItemId) restartCurrentTrackFromStart(currentQueueItemId);
    return;
  }

  const playlist = getState('playlist.items') || [];
  const repeatMode = getState('playlist.repeatMode') || 0;
  const isShuffle = getState('playlist.isShuffle');

  // Shuffle: walk the Fisher-Yates permutation BACKWARD so prev→next
  // round-trips return to the same track.
  if (isShuffle && playlist.length > 1) {
    const previousQueueItemId = advanceToShufflePreviousQueueItemId();
    if (previousQueueItemId) {
      playTrack(previousQueueItemId);
      return;
    }

    // At start of shuffle pass, no repeat-all → restart current, same as
    // sequential behaviour at first track.
    if (isQueueIdle()) {
      const fallbackQueueItemId = currentQueueItemId ?? playlist[0]?.queueItemId;
      if (fallbackQueueItemId) playTrack(fallbackQueueItemId);
    } else if (currentQueueItemId) {
      restartCurrentTrackFromStart(currentQueueItemId);
    }
    return;
  }

  if (currentIndex > 0) {
    const previousQueueItemId = playlist[currentIndex - 1]?.queueItemId;
    if (previousQueueItemId) playTrack(previousQueueItemId);
  } else {
    // At first track: wrap to last if repeat-all, otherwise restart
    if (repeatMode === 1 && playlist.length > 1) {
      const lastQueueItemId = playlist.at(-1)?.queueItemId;
      if (lastQueueItemId) playTrack(lastQueueItemId);
    } else {
      // In IDLE state (after track ended + stopAllMedia), play(0) silently fails
      // because no media source is available, but broadcast still fires → host-guest desync.
      // Use playTrack to reload the file instead.
      if (isQueueIdle()) {
        const fallbackQueueItemId = currentQueueItemId ?? playlist[0]?.queueItemId;
        if (fallbackQueueItemId) playTrack(fallbackQueueItemId);
      } else if (currentQueueItemId) {
        restartCurrentTrackFromStart(currentQueueItemId);
      }
    }
  }
}

// ─── Network Handlers ──────────────────────────────────────────────

function handleRepeatMode(data: Record<string, unknown>, conn?: DataConnection): void {
  // REPEAT_MODE is an authoritative host→guest broadcast. Host-local changes
  // bypass this handler, and peer frames must not change another client.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const v = Number(data.value) || 0;
  // _bootstrap frames are a re-baseline (join bootstrap / OPERATOR_REVOKE
  // resync), not a user-visible mode change — skip the toggle toast.
  setRepeatMode(Math.max(0, Math.min(2, v)), !data._bootstrap);
}

function handleShuffleMode(data: Record<string, unknown>, conn?: DataConnection): void {
  // SHUFFLE_MODE is an authoritative host→guest broadcast.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Same _bootstrap semantics as handleRepeatMode above.
  setShuffle(!!data.value, !data._bootstrap);
}

function handlePlaylistUpdate(data: Record<string, unknown>, conn?: DataConnection): void {
  // PLAYLIST_UPDATE is an authoritative host→guest snapshot. Peer frames must
  // not replace another participant's queue or trigger its empty-list cleanup.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const prevLength = (getState('playlist.items') || []).length;
  const previousCurrentQueueItemId = getCurrentQueueItemId();
  const authorityEstablished = hasQueueAuthority(conn);
  if (!authorityEstablished && data.bootstrap !== true) {
    log.warn('[Playlist] Ignored playlist update before authority bootstrap');
    return;
  }
  if (authorityEstablished && data.bootstrap === true) {
    log.debug('[Playlist] Ignored repeated authority bootstrap on established connection');
    return;
  }
  const outcome = applyPlaylistSnapshot(data, authorityEstablished ? 'monotonic' : 'rebase');

  if (outcome === 'invalid') {
    log.warn('[Playlist] Rejected malformed playlist snapshot');
    return;
  }
  if (outcome === 'conflict') {
    log.warn('[Playlist] Rejected conflicting playlist snapshot at equal revision');
    return;
  }
  if (outcome === 'stale') {
    log.debug('[Playlist] Ignored stale playlist snapshot');
    return;
  }
  if (outcome === 'duplicate') {
    return;
  }

  const incoming = getState('playlist.items');
  ensureShuffleOrderValid();

  // A changed connection baseline belongs to a new authority even when queue
  // IDs or positions happen to resemble the previous room. Clear all media
  // owners so no resident/preloaded/partial bytes survive that boundary.
  // An incremental snapshot that removes the currently-owned occurrence must
  // also stop that old media immediately, even when a successor remains in
  // the queue and its authoritative media frame has not arrived yet.
  const authorityChanged = outcome === 'rebased';
  const playlistEmptied = outcome === 'applied' && incoming.length === 0 && prevLength > 0;
  const removedCurrentOwner =
    outcome === 'applied' &&
    previousCurrentQueueItemId !== null &&
    previousCurrentQueueItemId !== getCurrentQueueItemId() &&
    !incoming.some((item) => item.queueItemId === previousCurrentQueueItemId);
  const removedCurrentOwnsPreload =
    removedCurrentOwner &&
    (getState('preload.ready')?.queueItemId === previousCurrentQueueItemId ||
      getState('preload.activeTarget')?.queueItemId === previousCurrentQueueItemId);
  if (authorityChanged || playlistEmptied || removedCurrentOwner) {
    const reason = authorityChanged
      ? 'playlist-authority-rebased'
      : playlistEmptied
        ? 'playlist-emptied'
        : 'playlist-current-removed';
    if (authorityChanged) bus.emit('demo:authority-reset');
    stopAllMedia({ cancelInFlight: true, clearBuffer: true });
    // A successor can already be arriving through the independent preload
    // channel. Keep that live session intact while dropping the deleted
    // current media; a full reset here would strand PLAY_PRELOADED after the
    // snapshot. Only reset preload storage when its bytes belong to the
    // removed occurrence (or when the whole authority/queue is reset).
    if (authorityChanged || playlistEmptied || removedCurrentOwnsPreload) {
      clearPreloadState(authorityChanged);
    } else if (getState('preload.nextQueueItemId') === previousCurrentQueueItemId) {
      setState('preload.nextQueueItemId', null);
    }
    // Abort any in-flight main download — otherwise chunks already in the
    // data channel keep being written to storage to completion.
    cancelIncomingFileTransfer(reason);
    cancelRemoteShareWait(reason);
    if (authorityChanged) {
      resetIncomingTransferAuthority();
      resetRecoveryAuthority();
    }
    clearPreviousTrackState(reason);
    // clearPreviousTrackState doesn't touch player.currentTrackMeta.
    setPlaybackTrackMeta(null);
  }

  if (outcome === 'rebased') markQueueAuthorityReady(conn);
}

function handleTrackChange(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP request
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-track-change from non-OP: ${conn?.peer}`);
    return;
  }

  const queueItemId = data.queueItemId;
  if (typeof queueItemId !== 'string' || !getQueueItemById(queueItemId)) {
    log.warn(`[Playlist] Invalid queue item ID: ${String(queueItemId)}`);
    return;
  }
  playTrack(queueItemId);
}

function handleRequestNextTrack(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-next-track from non-OP: ${conn?.peer}`);
    return;
  }
  if (data.queueItemId !== getCurrentQueueItemId()) {
    log.debug('[Playlist] Ignoring stale next-track request');
    return;
  }
  playNextTrack();
}

function handleRequestPrevTrack(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-prev-track from non-OP: ${conn?.peer}`);
    return;
  }
  if (data.queueItemId !== getCurrentQueueItemId()) {
    log.debug('[Playlist] Ignoring stale previous-track request');
    return;
  }
  playPrevTrack();
}

function handleRequestSetting(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const st = data.settingType as string;
  const isOp = verifyOperator(conn, data);
  const isDemoAllowed = getState('demo.active') && DEMO_ALLOWED_SETTING_TYPES.has(st);
  if (!isOp && !isDemoAllowed) {
    log.warn(`[Playlist] Rejected request-setting from non-OP: ${conn?.peer}`);
    return;
  }

  const val = data.value;
  switch (st) {
    case 'repeat-mode': {
      const mode = Number(val) || 0;
      setRepeatMode(mode);
      broadcast({ type: MSG.REPEAT_MODE, value: mode });
      break;
    }
    case 'shuffle-mode': {
      const enabled = !!val;
      setShuffle(enabled);
      broadcast({ type: MSG.SHUFFLE_MODE, value: enabled });
      break;
    }
    // ─── Audio Effect Settings (OP → Host apply + broadcast) ──
    case 'eq': {
      const band = parseInt(String(data.band), 10);
      const v = parseFloat(String(val));
      if (!Number.isFinite(band) || !Number.isFinite(v)) break;
      setEQ(band, v);
      broadcast({ type: MSG.EQ_UPDATE, band, value: v });
      break;
    }
    case MSG.PREAMP: {
      const v = parseFloat(String(val));
      if (!Number.isFinite(v)) break;
      setPreamp(v);
      broadcast({ type: MSG.PREAMP, value: v });
      break;
    }
    // The ui:sync-* emits below mirror the guest-side network handlers in
    // audio/effects.ts: setters alone don't update the settings UI, so the
    // HOST's own chips/sliders would go stale when an OP's request applies.
    // (eq and REVERB_TYPE are excluded — their setters already emit.)
    case MSG.STEREO_WIDTH: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setStereoWidth(v);
      bus.emit('ui:sync-surround', v > 100);
      broadcast({ type: MSG.STEREO_WIDTH, value: v });
      break;
    }
    case MSG.VBASS: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setVirtualBass(v);
      bus.emit('ui:sync-vbass', v > 0);
      broadcast({ type: MSG.VBASS, value: v });
      break;
    }
    case MSG.EXCITER: {
      // Wire shape is 0 | 1 to share the REQUEST_SETTING number contract;
      // setExciter takes the boolean form locally.
      const v = Number(val);
      if (v !== 0 && v !== 1) break;
      setExciter(v === 1);
      bus.emit('ui:sync-exciter', v === 1);
      broadcast({ type: MSG.EXCITER, value: v });
      break;
    }
    case MSG.REVERB: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('mix', v);
      bus.emit('ui:sync-reverb-param', 'mix', v);
      broadcast({ type: MSG.REVERB, value: v });
      break;
    }
    case MSG.REVERB_TYPE: {
      // val is a string preset ('studio'/'arena'/'off') — apply locally on host + broadcast
      bus.emit('audio:reverb-type-change', String(val));
      break;
    }
    case MSG.REVERB_DECAY: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('decay', v);
      bus.emit('ui:sync-reverb-param', 'decay', v);
      broadcast({ type: MSG.REVERB_DECAY, value: v });
      break;
    }
    case MSG.REVERB_PREDELAY: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('predelay', v);
      bus.emit('ui:sync-reverb-param', 'predelay', v);
      broadcast({ type: MSG.REVERB_PREDELAY, value: v });
      break;
    }
    case MSG.REVERB_LOWCUT: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('lowcut', v);
      bus.emit('ui:sync-reverb-param', 'lowcut', v);
      broadcast({ type: MSG.REVERB_LOWCUT, value: v });
      break;
    }
    case MSG.REVERB_HIGHCUT: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('highcut', v);
      bus.emit('ui:sync-reverb-param', 'highcut', v);
      broadcast({ type: MSG.REVERB_HIGHCUT, value: v });
      break;
    }
  }
}

// ─── Load Demo Media ──────────────────────────────────────────────

// ─── Handle Files Selected ────────────────────────────────────────

function broadcastPlaylistSnapshot(): void {
  broadcast({ type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot() });
}

async function handleFilesSelected(files: FileList | readonly File[] | null): Promise<void> {
  if (!files || files.length === 0) return;

  const hostConn = getState('network.hostConn');
  if (hostConn) {
    showToast(t('toast.host_only_file'));
    return;
  }

  // MUSIXQUARE is music-only — videos are served through the YouTube path.
  // The picker `accept` attribute is only a hint. This shared consumer is the
  // authoritative guard for picker overrides, drops, and future entry points.
  // Native decode still decides whether a candidate is actually playable.
  const { accepted, rejected } = partitionAudioFileCandidates(files);

  if (accepted.length === 0) {
    if (rejected.length > 0) showToast(t('toast.no_supported_audio_files'));
    return;
  }

  // Large-room soft warning: only when the host has explicitly bumped the
  // slot cap into "big party" territory, and only once per session.
  const maxSlots = getState('network.maxGuestSlots') ?? DEFAULT_MAX_GUEST_SLOTS;
  if (maxSlots >= WARN_WHEN_MAX_SLOTS_AT_LEAST && !hasFileShareWarned()) {
    const res = await showDialog({
      title: t('dialog.large_room_file.title'),
      message: t('dialog.large_room_file.message'),
      buttonText: t('dialog.continue'),
      secondaryText: t('common.cancel'),
    });
    if (res.action !== 'ok') return;
    markFileShareWarned();
  }

  const playlist = [...(getState('playlist.items') || [])];
  const addedQueueItemIds: QueueItemId[] = [];

  for (const file of accepted) {
    const queueItemId = createQueueItemId();
    const newTrack: PlaylistItem = {
      queueItemId,
      type: 'file',
      file,
      name: file.name,
      title: file.name.replace(/\.[^/.]+$/, ''),
      videoId: null,
      playlistId: null,
    };
    playlist.push(newTrack);
    addedQueueItemIds.push(queueItemId);
  }

  if (addedQueueItemIds.length === 0) return;

  const firstAddedQueueItemId = addedQueueItemIds[0] ?? null;
  const previousCurrentQueueItemId = getCurrentQueueItemId();
  const shouldAutoPlay =
    firstAddedQueueItemId !== null && isQueueIdle() && previousCurrentQueueItemId === null;

  // Publish the initial selection in the same revision as the newly added
  // rows. A late joiner must never observe a snapshot where the queue exists
  // but its already-owned first occurrence is still reported as unselected.
  commitPlaylistItems(playlist, {
    currentQueueItemId: shouldAutoPlay ? firstAddedQueueItemId : previousCurrentQueueItemId,
  });
  if (getState('playlist.isShuffle')) generateShuffleOrder();
  broadcastPlaylistSnapshot();
  bus.emit('playlist:items-added', addedQueueItemIds);

  const addedMessage = t('toast.added_tracks', { count: addedQueueItemIds.length });
  showToast(
    rejected.length > 0
      ? `${addedMessage}\n${t('toast.unsupported_files_excluded', { count: rejected.length })}`
      : addedMessage,
  );

  // Auto-play the first added occurrence only when no occurrence is already
  // selected. Selection happens synchronously before async decode, preventing
  // later add batches from stealing ownership while playback still looks idle.
  if (shouldAutoPlay && firstAddedQueueItemId) {
    playTrack(firstAddedQueueItemId);
  } else {
    // Already playing — preload next track for guests (covers end-of-playlist + file add case)
    schedulePreload(1000);
  }
}

// ─── Init ──────────────────────────────────────────────────────────

function findSequentialRemovalSuccessor(
  previousItems: readonly PlaylistItem[],
  currentIndex: number,
  removedQueueItemIds: ReadonlySet<QueueItemId>,
): QueueItemId | null {
  for (let index = currentIndex + 1; index < previousItems.length; index++) {
    const candidate = previousItems[index];
    if (candidate && !removedQueueItemIds.has(candidate.queueItemId)) {
      return candidate.queueItemId;
    }
  }
  for (let index = currentIndex - 1; index >= 0; index--) {
    const candidate = previousItems[index];
    if (candidate && !removedQueueItemIds.has(candidate.queueItemId)) {
      return candidate.queueItemId;
    }
  }
  return null;
}

function findShuffleRemovalSuccessor(
  previousShuffleOrder: readonly QueueItemId[],
  currentQueueItemId: QueueItemId,
  removedQueueItemIds: ReadonlySet<QueueItemId>,
  canWrap: boolean,
): QueueItemId | null {
  const currentPosition = previousShuffleOrder.indexOf(currentQueueItemId);
  if (currentPosition < 0) return null;

  for (let index = currentPosition + 1; index < previousShuffleOrder.length; index++) {
    const candidate = previousShuffleOrder[index];
    if (candidate && !removedQueueItemIds.has(candidate)) return candidate;
  }
  if (!canWrap) return null;
  for (let index = 0; index < currentPosition; index++) {
    const candidate = previousShuffleOrder[index];
    if (candidate && !removedQueueItemIds.has(candidate)) return candidate;
  }
  return null;
}

function removeQueueItems(queueItemIds: readonly QueueItemId[]): void {
  if (getState('network.hostConn')) return;

  const previousItems = getState('playlist.items') || [];
  const requestedIds = new Set(queueItemIds);
  if (requestedIds.size === 0) return;

  const removedQueueItemIds = new Set<QueueItemId>();
  for (const item of previousItems) {
    if (requestedIds.has(item.queueItemId)) removedQueueItemIds.add(item.queueItemId);
  }
  if (removedQueueItemIds.size === 0) return;

  const currentQueueItemId = getCurrentQueueItemId();
  const currentIndex = findQueueItemIndex(currentQueueItemId, previousItems);
  const wasCurrent = !!currentQueueItemId && removedQueueItemIds.has(currentQueueItemId);
  const previousShuffleOrder = [..._shuffleOrder];
  const nextShuffleOrder = previousShuffleOrder.filter(
    (queueItemId) => !removedQueueItemIds.has(queueItemId),
  );
  const nextItems = previousItems.filter((item) => !removedQueueItemIds.has(item.queueItemId));

  let successorQueueItemId = currentQueueItemId;
  if (wasCurrent) {
    const sequentialSuccessor = findSequentialRemovalSuccessor(
      previousItems,
      currentIndex,
      removedQueueItemIds,
    );
    successorQueueItemId =
      getState('playlist.isShuffle') && nextShuffleOrder.length > 0 && currentQueueItemId
        ? (findShuffleRemovalSuccessor(
            previousShuffleOrder,
            currentQueueItemId,
            removedQueueItemIds,
            (getState('playlist.repeatMode') || 0) === 1,
          ) ?? sequentialSuccessor)
        : sequentialSuccessor;
  }

  commitPlaylistItems(nextItems, { currentQueueItemId: successorQueueItemId });
  _shuffleOrder = nextShuffleOrder;
  if (_shuffleOrder.length === 0) {
    _shufflePosition = 0;
  } else {
    const shuffleAnchor = successorQueueItemId ? _shuffleOrder.indexOf(successorQueueItemId) : -1;
    _shufflePosition =
      shuffleAnchor >= 0 ? shuffleAnchor : Math.min(_shufflePosition, _shuffleOrder.length - 1);
  }

  const preloadOwnsRemovedItem =
    removedQueueItemIds.has(getState('preload.nextQueueItemId') ?? '') ||
    removedQueueItemIds.has(getState('preload.ready')?.queueItemId ?? '') ||
    removedQueueItemIds.has(getState('preload.activeTarget')?.queueItemId ?? '');
  if (preloadOwnsRemovedItem) clearPreloadState();

  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  if (recoveryTarget?.queueItemId && removedQueueItemIds.has(recoveryTarget.queueItemId)) {
    setState('playback.pendingRecoveryTarget', null);
    setState('recovery.pending', false);
  }

  const connectedPeers = getState('network.connectedPeers') || [];
  if (
    connectedPeers.some((peer) =>
      [...removedQueueItemIds].some((queueItemId) => peer.preloadedQueueItemIds.has(queueItemId)),
    )
  ) {
    setState(
      'network.connectedPeers',
      connectedPeers.map((peer) => {
        const preloadedQueueItemIds = new Set(peer.preloadedQueueItemIds);
        let changed = false;
        for (const queueItemId of removedQueueItemIds) {
          changed = preloadedQueueItemIds.delete(queueItemId) || changed;
        }
        if (!changed) return peer;
        return { ...peer, preloadedQueueItemIds };
      }),
    );
  }

  if (nextItems.length === 0) {
    stopAllMedia({ cancelInFlight: true });
    clearPreloadState();
    cancelOutgoingFileTransfers();
    setCurrentAudioBuffer(null);
    setPlaybackTrackMeta(null);
    setState('files.current', null);
    setState('transfer.meta', null);
    bus.emit('ui:play-btn-state', false);
  }

  broadcastPlaylistSnapshot();

  if (wasCurrent && successorQueueItemId) {
    setCurrentAudioBuffer(null);
    setState('files.current', null);
    void playTrack(successorQueueItemId);
  } else if (preloadOwnsRemovedItem && nextItems.length > 0) {
    schedulePreload();
  }
}

function reorderQueueItem(
  queueItemId: QueueItemId,
  beforeQueueItemId: QueueItemId | null,
  baseRevision: number,
): void {
  if (getState('network.hostConn')) return;
  if (baseRevision !== getState('playlist.revision')) {
    log.debug('[Playlist] Ignoring reorder from a stale playlist revision');
    return;
  }

  const reordered = moveQueueItemBefore(queueItemId, beforeQueueItemId);
  if (!reordered) return;

  commitPlaylistItems(reordered);
  broadcastPlaylistSnapshot();

  // Sequential order defines the speculative preload target. Re-evaluate it
  // after every reorder; schedulePreload coalesces rapid drags, while
  // preloadNextTrack preserves an already-ready resident when its stable
  // queue occurrence is still the intended target.
  schedulePreload();
}

export function initPlaylist(): void {
  registerHandlers({
    [MSG.REPEAT_MODE]: handleRepeatMode,
    [MSG.SHUFFLE_MODE]: handleShuffleMode,
    [MSG.PLAYLIST_UPDATE]: handlePlaylistUpdate,
    [MSG.REQUEST_TRACK_CHANGE]: handleTrackChange,
    [MSG.REQUEST_NEXT_TRACK]: handleRequestNextTrack,
    [MSG.REQUEST_PREV_TRACK]: handleRequestPrevTrack,
    [MSG.REQUEST_SETTING]: handleRequestSetting,
  });

  // Handle track ended auto-advance (guarded against double-fire from overlapping timers)
  // Mechanism M7b in docs/design/playback-concurrency-invariants.md — a
  // module-local generation counter DELIBERATELY separate from the player
  // load epoch (it guards only the two ended-advance timers below; folding it
  // into the global counter would let unrelated epoch bumps cancel a
  // legitimate ended-advance).
  let _endedAdvanceToken = 0;
  bus.on('player:ended', () => {
    const hostConn = getState('network.hostConn');
    if (hostConn) return; // Only Host handles
    if (getState('demo.active')) return;

    // Lifecycle: host-local TRACK_ENDED. Drives host's
    // parallel-observed lifecycle to IDLE. Guests learn via the subsequent
    // PAUSE broadcast, which drives their own transition.
    transition({ type: 'TRACK_ENDED' });

    const token = ++_endedAdvanceToken;
    const repeatMode = getState('playlist.repeatMode') || 0;

    if (repeatMode === 2) {
      log.debug('Repeat One: Replaying current track...');
      setManagedTimer(
        'ended-advance-retry',
        () => {
          if (token !== _endedAdvanceToken) return;
          // Reuse in-memory audio buffer — skip file re-transfer to guests.
          // Same optimized path as playNextTrack() repeat-one branch.
          newLoadEpoch();
          const queueItemId = getCurrentQueueItemId();
          if (!queueItemId || !getQueueItemById(queueItemId)) return;
          play(0).catch(() => {
            /* noop */
          });
          broadcast({
            type: MSG.PLAY,
            time: 0,
            queueItemId,
            hostPlayAt: getLocalFileHostPlayAt(),
          });
          // SharedClock handles sync
        },
        300,
      );
    } else {
      log.debug('Auto-advancing to next track...');
      setManagedTimer(
        'ended-advance-next',
        () => {
          if (token === _endedAdvanceToken) playNextTrack();
        },
        500,
      );
    }
  });

  // Handle MediaSession navigation requests
  bus.on('playlist:prev-track', () => playPrevTrack());
  bus.on('playlist:next-track', () => playNextTrack());

  // File selection
  bus.on('app:files-selected', (files) => {
    handleFilesSelected(files);
  });

  // Play specific track from playlist view click
  bus.on('playlist:play-track', (queueItemId, subIndex) => {
    if (getQueueItemById(queueItemId)) playTrack(queueItemId, subIndex);
  });

  // Host: Remove track from playlist
  bus.on('playlist:remove-tracks', (queueItemIds) => {
    removeQueueItems(queueItemIds);
  });

  bus.on('playlist:reorder-track', (queueItemId, beforeQueueItemId, baseRevision) => {
    reorderQueueItem(queueItemId, beforeQueueItemId, baseRevision);
  });

  // Host: send queue authority during the ordered pre-playback bootstrap phase.
  bus.on('network:peer-bootstrap', (conn) => {
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState('network.hostConn');
    if (hostConn) return;

    try {
      // Full authoritative queue snapshot must be first after WELCOME. Every
      // qid/media frame on the guest is gated until this exact connection's
      // baseline has been applied.
      conn.send({ type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), bootstrap: true });

      // Repeat mode
      const repeatMode = getState('playlist.repeatMode') || 0;
      conn.send({ type: MSG.REPEAT_MODE, value: repeatMode, _bootstrap: true });

      // Shuffle mode
      const isShuffle = getState('playlist.isShuffle');
      conn.send({ type: MSG.SHUFFLE_MODE, value: isShuffle, _bootstrap: true });

      log.debug('[Playlist] Bootstrap: sent playlist state to new peer');
    } catch (e) {
      log.warn('[Playlist] Bootstrap send failed:', e);
    }
  });

  log.info('[Playlist] Initialized');
}
