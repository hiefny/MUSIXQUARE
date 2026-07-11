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
import { loadAndBroadcastFile, loadPreloadedTrack } from './decode.ts';
import {
  newLoadEpoch,
  isCurrentLoadEpoch,
  getCurrentAudioBuffer,
  setCurrentAudioBuffer,
} from './_state.ts';
import { isMediaVideo } from './video.ts';
import { transition } from './lifecycle.ts';

import { schedulePreload, cancelPreloadTransfer } from '../storage/preload.ts';
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
} from '../storage/transfer.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { setPendingAutoSyncOnReady } from '../youtube/player.ts';
import { isGuestBlocked } from '../network/guards.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { isPlaybackIdleCompat, isYouTubeOwner, setPlaybackTrackMeta } from './ownership.ts';
import type { DataConnection, PlaylistItem } from '../types/index.ts';
import { showToast } from '../ui/toast.ts';
import { showDialog } from '../ui/dialog.ts';
import { hasFileShareWarned, markFileShareWarned } from '../ui/large-room-warnings.ts';
import { shareRemoteFileIfNeeded } from '../share/remote-share.ts';
import { getHostNow } from '../network/shared-clock.ts';

const LOCAL_FILE_PLAY_SCHEDULE_AHEAD_MS = 200;

function getLocalFileHostPlayAt(): number {
  return getHostNow() + LOCAL_FILE_PLAY_SCHEDULE_AHEAD_MS;
}

// ─── Shuffle Order (Fisher-Yates) ──────────────────────────────────
// A persistent permutation of playlist indices so that prev/next in shuffle
// mode traverse a stable order — going back and then forward returns to the
// same track. Regenerated on:
//   - shuffle toggled ON
//   - playlist mutated (added/removed/reordered)
//   - full shuffle exhausted with repeat-all (reshuffle for a fresh pass)

let _shuffleOrder: number[] = [];
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
  const order = Array.from({ length: playlist.length }, (_, i) => i);
  // Fisher-Yates in-place shuffle
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  _shuffleOrder = order;
  // Align the cursor to wherever the current track now lives in the new order
  const currentIdx = getState('playlist.currentTrackIndex');
  const pos = order.indexOf(currentIdx);
  _shufflePosition = pos >= 0 ? pos : 0;
}

function ensureShuffleOrderValid(): void {
  const playlist = getState('playlist.items') || [];
  if (_shuffleOrder.length !== playlist.length) generateShuffleOrder();
}

/**
 * Expose for tests, preload.ts, and decode recovery to query the next slot in
 * the row-level shuffle order without advancing the cursor.
 */
export function getShuffleNextPlayableIndex(
  isCandidate: (index: number) => boolean = () => true,
): number {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  if (playlist.length <= 1) return -1;

  const currentIdx = getState('playlist.currentTrackIndex');
  const anchor = _shuffleOrder.indexOf(currentIdx);
  const startPos = anchor >= 0 ? anchor : _shufflePosition;

  for (let pos = startPos + 1; pos < _shuffleOrder.length; pos++) {
    const idx = _shuffleOrder[pos];
    if (idx !== currentIdx && isCandidate(idx)) return idx;
  }

  if (repeatMode !== 1) return -1;

  for (let pos = 0; pos <= startPos && pos < _shuffleOrder.length; pos++) {
    const idx = _shuffleOrder[pos];
    if (idx !== currentIdx && isCandidate(idx)) return idx;
  }

  return -1;
}

/** Expose for tests & for preload.ts to query the "next in shuffle order". */
export function getShuffleNextIndex(): number {
  return getShuffleNextPlayableIndex();
}

export function advanceToShuffleNextIndex(preferredIndex = -1): number {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  if (playlist.length <= 1) return -1;

  if (
    preferredIndex !== -1 &&
    preferredIndex !== currentTrackIndex &&
    preferredIndex < playlist.length &&
    playlist[preferredIndex] != null
  ) {
    const pos = _shuffleOrder.indexOf(preferredIndex);
    if (pos >= 0) _shufflePosition = pos;
    return preferredIndex;
  }

  const anchor = _shuffleOrder.indexOf(currentTrackIndex);
  if (anchor >= 0) _shufflePosition = anchor;

  const nextPos = _shufflePosition + 1;
  if (nextPos >= _shuffleOrder.length) {
    if (repeatMode !== 1) return -1;

    generateShuffleOrder();
    _shufflePosition = 0;
    let nextIndex =
      _shuffleOrder[0] === currentTrackIndex && _shuffleOrder.length > 1
        ? _shuffleOrder[1]
        : _shuffleOrder[0];
    if (nextIndex === currentTrackIndex && _shuffleOrder.length > 1) {
      nextIndex = _shuffleOrder[1];
      _shufflePosition = 1;
    } else {
      _shufflePosition = _shuffleOrder.indexOf(nextIndex);
    }
    return nextIndex ?? -1;
  }

  _shufflePosition = nextPos;
  return _shuffleOrder[nextPos] ?? -1;
}

export function advanceToShufflePreviousIndex(): number {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  if (playlist.length <= 1) return -1;

  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const anchor = _shuffleOrder.indexOf(currentTrackIndex);
  if (anchor >= 0) _shufflePosition = anchor;

  let prevPos = _shufflePosition - 1;
  if (prevPos < 0) {
    if (repeatMode !== 1) return -1;
    prevPos = _shuffleOrder.length - 1;
  }

  _shufflePosition = prevPos;
  return _shuffleOrder[prevPos] ?? -1;
}

function resetShuffleOrder(): void {
  _shuffleOrder = [];
  _shufflePosition = 0;
}

/**
 * Splice a removed playlist index out of _shuffleOrder so the pseudo-random
 * pass survives track removal — instead of ensureShuffleOrderValid later
 * detecting a length mismatch and regenerating a brand-new permutation
 * (which breaks the prev→next round-trip guarantee).
 */
function adjustShuffleOrderForRemoval(removedIndex: number): void {
  if (_shuffleOrder.length === 0) return;
  const posOfRemoved = _shuffleOrder.indexOf(removedIndex);
  if (posOfRemoved < 0) return;

  _shuffleOrder.splice(posOfRemoved, 1);
  // Playlist indices above the removed slot shifted down by one
  for (let i = 0; i < _shuffleOrder.length; i++) {
    if (_shuffleOrder[i] > removedIndex) _shuffleOrder[i]--;
  }
  // Cursor past the removed position pulls back; clamp when list empties
  if (_shufflePosition > posOfRemoved) _shufflePosition--;
  if (_shufflePosition >= _shuffleOrder.length) {
    _shufflePosition = Math.max(0, _shuffleOrder.length - 1);
  }
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

export function clearPreloadState(): void {
  const nextMeta = getState('preload.meta');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const isNextTrackActive = nextMeta && Number(nextMeta.index) === currentTrackIndex;

  // Cancel any in-flight backgroundTransfer to prevent stale preload data
  // from reaching guests after backward navigation (host-only).
  cancelPreloadTransfer();

  setState('preload.nextTrackIndex', -1);
  if (!isNextTrackActive) {
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
  }
  setState('preload.isPreloading', false);

  // Guests reset preload storage on track change, so invalidate the host's
  // per-peer preload cache as well.
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    const connectedPeers = getState('network.connectedPeers') || [];
    if (connectedPeers.length > 0 && connectedPeers.some((p) => p.preloadedIndexes?.size > 0)) {
      const updatedPeers = connectedPeers.map((p) =>
        p.preloadedIndexes?.size > 0 ? { ...p, preloadedIndexes: new Set<number>() } : p,
      );
      setState('network.connectedPeers', updatedPeers);
    }
  }

  // Guest side
  postCommand({ command: 'STORAGE_RESET', isPreload: true });
}

// ─── Play Track ────────────────────────────────────────────────────

export async function playTrack(index: number, subIndex?: number): Promise<void> {
  const playlist = getState('playlist.items') || [];
  if (index < 0 || index >= playlist.length) {
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
  // leave the previous track resident while currentTrackIndex has advanced.
  // Require the active filename to match before taking the replay fast path.
  const _currentIdx = getState('playlist.currentTrackIndex');
  const _item = playlist[index];
  const _isSameTrack = index === _currentIdx;
  const _isLocalFileTrack = !!_item && _item.type !== 'youtube' && !!_item.file;
  const _activeBufferTrackName =
    (getState('transfer.meta')?.name as string | undefined) ||
    (getState('files.currentFileBlob') as File | null)?.name;
  const _bufferMatchesTrack =
    !!getCurrentAudioBuffer() &&
    !!_activeBufferTrackName &&
    _activeBufferTrackName === _item?.file?.name;

  if (!hostConn && _isSameTrack && _isLocalFileTrack && _bufferMatchesTrack) {
    log.debug('[Host] Same-track re-click — fast replay path (no redecode/rebroadcast)');

    const file = _item.file!;
    const sessionId = getState('transfer.currentSessionId') || nextSessionId();
    const isFirstTrackLoad = getState('player.isFirstTrackLoad');
    const autoPlayDelayMs = isFirstTrackLoad ? 0 : 3000;

    // Tell guests via FILE_PREPARE → their same-file branch emits
    // playback:replay-current(delayMs), which defers play(0) accordingly.
    broadcast({
      type: MSG.FILE_PREPARE,
      name: file.name,
      index,
      sessionId,
      // Size is transport metadata only; receivers never treat name+size as
      // media identity.
      size: file.size,
      mime: file.type,
      autoPlayDelayMs,
    });
    void shareRemoteFileIfNeeded(file, sessionId, undefined, { index });

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
        play(0);
        // Read the index when the timer fires because removing an earlier item
        // during the replay window shifts currentTrackIndex. The file name
        // remains stable across that shift.
        const currentIdx = getState('playlist.currentTrackIndex');
        broadcast({
          type: MSG.PLAY,
          time: 0,
          index: currentIdx,
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
  const nextTrackIndex = getState('preload.nextTrackIndex');
  const nextFileBlob = getState('preload.nextFileBlob');

  if (index === nextTrackIndex && nextFileBlob && !hostConn) {
    log.debug('[Host] Using Preloaded Track:', index);
    setState('playlist.currentTrackIndex', index);
    setPlaybackTrackMeta(playlist[index]);

    // Advance session ID for recovery
    const nextMeta = getState('preload.meta');
    if (nextMeta?.sessionId && Number.isFinite(Number(nextMeta.sessionId))) {
      setState('transfer.currentSessionId', Number(nextMeta.sessionId));
    } else {
      setState('transfer.currentSessionId', nextSessionId());
    }

    stopAllMedia({ silent: true }); // suppress IDLE flash — play() follows immediately

    const item = playlist[index];
    const fileName = item?.file?.name || item?.name || `Track ${index}`;
    broadcast({ type: MSG.PLAY_PRELOADED, index, name: fileName, mime: item?.file?.type });

    // Host must transition to DECODING before decode begins, so that the
    // subsequent DECODE_SUCCESS lands cleanly on READY.
    transition({ type: 'PLAY_PRELOADED', variant: 'blob-ready', index, name: fileName });

    // Play and broadcast only after the current activation succeeds. Failure
    // owns its auto-advance path; supersession transfers playback ownership to
    // the newer playTrack invocation.
    const activated = await loadPreloadedTrack(index, myLoadEpoch);
    if (!activated || !isCurrentLoadEpoch(myLoadEpoch)) {
      log.debug('[Host] Preloaded activation failed or superseded — skipping play/broadcast');
      return;
    }
    // Whole-file remote encryption is admitted against the active PCM buffer.
    // Start it only after this preloaded track has decoded and published its
    // own AudioBuffer, never while the previous track still owns that slot.
    if (item?.file) {
      const remoteShareSessionId = getState('transfer.currentSessionId') || null;
      void shareRemoteFileIfNeeded(item.file, remoteShareSessionId, undefined, { index });
    }
    await play(0);
    broadcast({
      type: MSG.PLAY,
      time: 0,
      index,
      name: fileName,
      hostPlayAt: getLocalFileHostPlayAt(),
    });
    // SharedClock handles sync
    schedulePreload();
    return;
  }

  clearPreloadState();
  setState('playlist.currentTrackIndex', index);

  const item = playlist[index];
  setPlaybackTrackMeta(item);

  // YouTube
  if (item.type === 'youtube') {
    // Force-clear any stale audio preload state to prevent incorrect
    // preloaded file being used when switching back from YouTube to audio
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);

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
        index,
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
    log.warn('[Playlist] No file for track', index);
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
      index,
      sessionId,
      // Name and size are transport metadata, not media identity.
      size: file.size,
      mime: file.type,
      autoPlayDelayMs,
    };
    const didLoad = await loadAndBroadcastFile(file, sessionId, myLoadEpoch, prepareMsg);
    if (!didLoad) return;

    if (isFirstTrackLoad) {
      setState('player.isFirstTrackLoad', false);
      showToast(t('toast.file_ready'));
    } else {
      showToast(t('toast.playing_in_3s'));
      setManagedTimer(
        'autoPlayTimer',
        () => {
          play(0);
          const currentIdx = getState('playlist.currentTrackIndex');
          broadcast({
            type: MSG.PLAY,
            time: 0,
            index: currentIdx,
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
 * Clears track meta, audio buffer, and resets currentTrackIndex to -1 so the
 * UI state ("미디어 없음") is internally consistent with transport state.
 * Broadcasts MSG.PAUSE{endOfPlaylist:true} so guests mirror the reset.
 *
 * Clearing the resident buffer and selecting index -1 ensures a later Play
 * restarts from the top instead of resuming an unselected final track.
 */
function handleEndOfPlaylist(reason: string): void {
  log.debug(`[Host] End of playlist: ${reason}. Resetting to deselected state.`);
  stopAllMedia();
  setCurrentAudioBuffer(null);
  setPlaybackTrackMeta(null);
  setState('playlist.currentTrackIndex', -1);
  setState('player.pausedAt', 0);
  // Host's own lifecycle: mirror the broadcast PAUSE{endOfPlaylist:true} so
  // playback.lifecycle returns to IDLE in lockstep with guests.
  transition({ type: 'PAUSE', time: 0, endOfPlaylist: true });
  broadcast({ type: MSG.PAUSE, time: 0, endOfPlaylist: true, reason: 'end-of-playlist' });
  showToast(t('toast.playlist_ended'));
}

// ─── Play Next Track ───────────────────────────────────────────────

export function playNextTrack(): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_NEXT_TRACK });
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
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const isShuffle = getState('playlist.isShuffle');
  const nextTrackIndex = getState('preload.nextTrackIndex');

  if (playlist.length === 0) return;

  let nextIndex: number;

  if (isShuffle) {
    if (playlist.length === 1) {
      // Single-track + shuffle + repeat OFF → stop (same as sequential behavior)
      if (repeatMode === 0) {
        handleEndOfPlaylist('single-track-shuffle');
        return;
      }
      nextIndex = 0;
    } else {
      nextIndex = advanceToShuffleNextIndex(nextTrackIndex);
      if (nextIndex === -1) {
        handleEndOfPlaylist('shuffle-end');
        return;
      }
    }
  } else {
    nextIndex = currentTrackIndex + 1;
    if (nextIndex >= playlist.length) {
      if (repeatMode === 1) {
        nextIndex = 0;
      } else {
        handleEndOfPlaylist('sequential-end');
        return;
      }
    }
  }

  if (nextIndex !== -1) {
    playTrack(nextIndex);
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
function restartCurrentTrackFromStart(currentTrackIndex: number): void {
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Playlist] Ignoring restart-current while file pipeline is preparing');
    return;
  }
  play(0);
  broadcast({
    type: MSG.PLAY,
    time: 0,
    index: currentTrackIndex,
    hostPlayAt: getLocalFileHostPlayAt(),
  });
  // SharedClock handles sync
}

export function playPrevTrack(): void {
  if (isGuestBlocked()) return;

  const hostConn = getState('network.hostConn');
  const isOperator = getState('network.isOperator');
  if (hostConn && isOperator) {
    sendToHost({ type: MSG.REQUEST_PREV_TRACK });
    return;
  }

  const currentTrackIndex = getState('playlist.currentTrackIndex');

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
      const prevIndex = advanceToShufflePreviousIndex();
      if (prevIndex !== -1) {
        playTrack(prevIndex);
      } else {
        playTrack(Math.max(0, currentTrackIndex));
      }
      return;
    }

    if (currentTrackIndex > 0) {
      playTrack(currentTrackIndex - 1);
    } else {
      if (repeatMode === 1 && playlist.length > 1) {
        playTrack(playlist.length - 1);
      } else {
        playTrack(0);
      }
    }
    return;
  }

  // Local mode: restart if > 3s, else previous track
  const pos = getTrackPosition();
  if (pos > 3) {
    // Restart current track from the beginning
    restartCurrentTrackFromStart(currentTrackIndex);
    return;
  }

  const playlist = getState('playlist.items') || [];
  const repeatMode = getState('playlist.repeatMode') || 0;
  const isShuffle = getState('playlist.isShuffle');

  // Shuffle: walk the Fisher-Yates permutation BACKWARD so prev→next
  // round-trips return to the same track.
  if (isShuffle && playlist.length > 1) {
    const prevIndex = advanceToShufflePreviousIndex();
    if (prevIndex !== -1) {
      playTrack(prevIndex);
      return;
    }

    // At start of shuffle pass, no repeat-all → restart current, same as
    // sequential behaviour at first track.
    if (isQueueIdle()) {
      playTrack(Math.max(0, currentTrackIndex));
    } else {
      restartCurrentTrackFromStart(currentTrackIndex);
    }
    return;
  }

  if (currentTrackIndex > 0) {
    playTrack(currentTrackIndex - 1);
  } else {
    // At first track: wrap to last if repeat-all, otherwise restart
    if (repeatMode === 1 && playlist.length > 1) {
      playTrack(playlist.length - 1);
    } else {
      // In IDLE state (after track ended + stopAllMedia), play(0) silently fails
      // because no media source is available, but broadcast still fires → host-guest desync.
      // Use playTrack to reload the file instead.
      if (isQueueIdle()) {
        // currentTrackIndex can be -1 after handleEndOfPlaylist. Clamp so
        // playTrack doesn't no-op-return on the out-of-range guard.
        playTrack(Math.max(0, currentTrackIndex));
      } else {
        restartCurrentTrackFromStart(currentTrackIndex);
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

  // Accept either protocol field used by playlist snapshots.
  const incoming = Array.isArray(data.list)
    ? data.list
    : Array.isArray(data.playlist)
      ? data.playlist
      : null;
  if (!incoming) {
    setState('playlist.items', []);
    setState('playlist.currentTrackIndex', -1);
    stopAllMedia();
    clearPreloadState();
    return;
  }

  // Validate incoming array: reject oversized or malformed playlists
  if (incoming.length > 1000) {
    log.warn('[Playlist] Rejected oversized playlist update:', incoming.length);
    return;
  }
  // Validate individual items have expected properties
  const valid = incoming.every(
    (item: unknown) =>
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).name === 'string',
  );
  if (!valid) {
    log.warn('[Playlist] Rejected playlist with invalid items');
    return;
  }

  const prevLength = (getState('playlist.items') || []).length;
  setState('playlist.items', incoming);

  // Empty snapshots clear every resident file/buffer identity. Otherwise a new
  // item at the same index could satisfy the same-track check with stale audio.
  if (incoming.length === 0 && prevLength > 0) {
    stopAllMedia();
    clearPreloadState();
    // Abort any in-flight main download — otherwise chunks already in the
    // data channel keep being written to storage to completion.
    cancelIncomingFileTransfer('playlist-emptied');
    bus.emit('storage:clear-previous-track', 'playlist-emptied');
    // Mirror host's empty-playlist reset: clear track meta so the title
    // display reverts to "미디어 없음" instead of lingering on the last
    // played track. clearPreviousTrackState doesn't touch player.currentTrackMeta,
    // so we clear it explicitly here.
    setPlaybackTrackMeta(null);
  }

  // Sync current track index from host (late-join bootstrap)
  let idx = getState('playlist.currentTrackIndex');
  if (typeof data.currentTrackIndex === 'number') {
    idx = data.currentTrackIndex;
  } else if (typeof data.index === 'number') {
    idx = data.index;
  }
  // Clamp to valid range
  if (idx >= incoming.length) idx = incoming.length - 1;
  if (idx < -1) idx = -1;
  if (idx === -1 && incoming.length > 0) idx = 0;
  setState('playlist.currentTrackIndex', idx);
}

function handleTrackChange(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP request
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-track-change from non-OP: ${conn?.peer}`);
    return;
  }

  const index = Number(data.index);
  const playlist = getState('playlist.items') || [];
  if (!Number.isFinite(index) || index < 0 || index >= playlist.length) {
    log.warn(`[Playlist] Invalid track index: ${data.index}`);
    return;
  }
  playTrack(index);
}

function handleRequestNextTrack(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-next-track from non-OP: ${conn?.peer}`);
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

async function handleFilesSelected(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return;

  const hostConn = getState('network.hostConn');
  if (hostConn) {
    showToast(t('toast.host_only_file'));
    return;
  }

  // MUSIXQUARE is music-only — videos are served through the YouTube path.
  // Screens the file picker's accept filter can miss (drag-and-drop isn't wired
  // today, but "All files" override in the dialog still reaches here).
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    if (isMediaVideo(file)) {
      rejected.push(file.name);
    } else {
      accepted.push(file);
    }
  }

  if (rejected.length > 0) {
    showToast(accepted.length === 0 ? t('toast.video_only_rejected') : t('toast.video_excluded'));
  }

  if (accepted.length === 0) return;

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
  let addedCount = 0;

  for (const file of accepted) {
    const newTrack: PlaylistItem = {
      type: 'file',
      file,
      name: file.name,
      title: file.name.replace(/\.[^/.]+$/, ''),
      videoId: null,
      playlistId: null,
    };
    playlist.push(newTrack);
    addedCount++;
  }

  if (addedCount === 0) return;

  setState('playlist.items', playlist);

  const metaList = playlist.map((item) => ({
    type: item.type,
    name: item.name,
    title: item.title || item.name,
    videoId: item.videoId || null,
    playlistId: item.playlistId || null,
  }));
  broadcast({ type: MSG.PLAYLIST_UPDATE, list: metaList });

  showToast(t('toast.added_tracks', { count: addedCount }));

  // Auto-play first added file if nothing is playing AND no track has been
  // selected yet. The `currentIndex < 0` guard prevents a race when multiple
  // files are uploaded sequentially: playTrack(0) sets currentTrackIndex = 0
  // synchronously, but its async audio decode keeps playback idle until
  // decode + play() complete. Without the guard, each subsequent upload also
  // sees idle and calls playTrack(N), overwriting the index to
  // the last uploaded track — so clicking "next" immediately overflows the
  // playlist boundary into handleEndOfPlaylist (currentTrackIndex = -1).
  const currentIndex = getState('playlist.currentTrackIndex');
  if (isQueueIdle() && currentIndex < 0) {
    playTrack(playlist.length - addedCount);
  } else {
    // Already playing — preload next track for guests (covers end-of-playlist + file add case)
    schedulePreload(1000);
  }
}

// ─── Init ──────────────────────────────────────────────────────────

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
          play(0).catch(() => {
            /* noop */
          });
          // Read the index when the timer fires because removing another track
          // during the window can shift playlist indices.
          broadcast({
            type: MSG.PLAY,
            time: 0,
            index: getState('playlist.currentTrackIndex'),
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
  bus.on('playlist:play-track', (index, subIndex) => {
    if (Number.isFinite(index) && index >= 0) playTrack(index, subIndex);
  });

  // Host: Remove track from playlist
  bus.on('playlist:remove-track', (index) => {
    const hostConn = getState('network.hostConn');
    if (hostConn) return; // Only host can remove

    const playlist = [...(getState('playlist.items') || [])];
    if (index < 0 || index >= playlist.length) return;

    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const isCurrentTrack = index === currentTrackIndex;
    // Snapshot type before splice. Track type, rather than current playback
    // activity, determines whether the YouTube module owns an iframe that must
    // be stopped explicitly.
    const removedTrack = playlist[index];
    const wasYoutubeActive = isCurrentTrack && removedTrack?.type === 'youtube';

    // Remove the item
    playlist.splice(index, 1);
    setState('playlist.items', playlist);

    // Keep the Fisher-Yates shuffle pass consistent across the removal so
    // prev/next round-trips don't jump to unexpected tracks.
    adjustShuffleOrderForRemoval(index);

    let needsPlayRestart = false;
    let newIdx = currentTrackIndex;

    if (playlist.length === 0) {
      // Removing the final item cancels in-flight work so a resolving decode
      // cannot republish the deleted track. Other current-track removals are
      // superseded by the replacement playTrack invocation.
      stopAllMedia({ cancelInFlight: true });
      clearPreloadState();
      // Abort any in-flight broadcast/unicast so guests aren't forced to
      // finish downloading a file that's no longer in the playlist.
      cancelOutgoingFileTransfers();
      // Clear the decoded buffer so direct transport calls cannot resume audio
      // after the playlist becomes empty.
      setCurrentAudioBuffer(null);
      setState('playlist.currentTrackIndex', -1);
      setPlaybackTrackMeta(null);
      setState('files.currentFileBlob', null);
      setState('transfer.meta', {});
      // Soft-disable the play button to match the boot state. Click still
      // fires so the toast hint can show.
      bus.emit('ui:play-btn-state', false);
      newIdx = -1;
    } else if (isCurrentTrack) {
      // Was playing the removed track. In sequential mode the natural
      // successor is the same playlist slot (or the new last). In shuffle
      // mode it's the next entry in _shuffleOrder, which adjustShuffleOrder
      // ForRemoval already lined up: posOfRemoved equals the cursor here
      // (since _shuffleOrder[_shufflePosition] === currentTrackIndex ===
      // index), so after the splice the cursor naturally points at what
      // used to be the *next* shuffle entry. Without this branch the
      // sequential newIdx would skip the shuffle order entirely and play
      // a different track than the cursor expects, leaving prev/next
      // misaligned for the rest of the session.
      const isShuffle = getState('playlist.isShuffle');
      if (isShuffle && _shuffleOrder.length > 0) {
        const repeatMode = getState('playlist.repeatMode') || 0;
        if (_shufflePosition < _shuffleOrder.length) {
          // Cursor still in range — splice already placed the next entry here
          newIdx = _shuffleOrder[_shufflePosition];
        } else if (repeatMode === 1) {
          // End of shuffle pass with repeat-all — wrap to first
          newIdx = _shuffleOrder[0];
          _shufflePosition = 0;
        } else {
          // End of shuffle pass without repeat — fall back to index-based
          newIdx = Math.min(index, playlist.length - 1);
          _shufflePosition = _shuffleOrder.indexOf(newIdx);
        }
      } else {
        newIdx = Math.min(index, playlist.length - 1);
      }
      setState('playlist.currentTrackIndex', newIdx);
      needsPlayRestart = true;
    } else if (index < currentTrackIndex) {
      // Removed before current — shift index down
      newIdx = currentTrackIndex - 1;
      setState('playlist.currentTrackIndex', newIdx);
    }

    // Tear down YouTube iframe if the removed track was the active YT one
    // AND we're leaving YouTube mode (empty playlist or next track is local).
    // YT → YT removal leaves the iframe up so loadYouTubeVideo can reuse it.
    if (wasYoutubeActive) {
      const newIsYoutube = newIdx >= 0 && playlist[newIdx]?.type === 'youtube';
      if (!newIsYoutube) bus.emit('youtube:stop-mode');
    }

    // Preload invalidation:
    //   index === preloadIdx     → preloaded track is gone, clear & reschedule.
    //   preloadIdx >= length     → tail-removed past preload target, clear & reschedule.
    //   index < preloadIdx       → the exact Blob/session still owns the same
    //                              track; only its playlist slot shifts down.
    //                              Re-index each peer's preloadedIndexes Set in
    //                              lockstep. Saves a 5–15 MB re-broadcast × N.
    //   index > preloadIdx       → no-op.
    const preloadIdx = getState('preload.nextTrackIndex');
    if (preloadIdx >= 0) {
      if (index === preloadIdx || preloadIdx >= playlist.length) {
        clearPreloadState();
        if (playlist.length > 0) schedulePreload();
      } else if (index < preloadIdx) {
        const newPreloadIdx = preloadIdx - 1;
        setState('preload.nextTrackIndex', newPreloadIdx);
        // Keep preload.meta.index consistent with nextTrackIndex so the host
        // fast path in playTrack still recognises the cached blob.
        const meta = getState('preload.meta');
        if (meta && (meta.index as number) === preloadIdx) {
          setState('preload.meta', { ...meta, index: newPreloadIdx });
        }
        // Re-index host-side peer caches: every peer that had `preloadIdx`
        // marked as cached now has `newPreloadIdx`. Indexes between `index`
        // and `preloadIdx` shift down by 1; indexes < `index` are unaffected;
        // index === `index` was the removed slot.
        const connectedPeers = getState('network.connectedPeers') || [];
        if (connectedPeers.some((p) => p.preloadedIndexes?.has(preloadIdx))) {
          const updatedPeers = connectedPeers.map((p) => {
            if (!p.preloadedIndexes?.has(preloadIdx)) return p;
            const next = new Set<number>();
            for (const i of p.preloadedIndexes) {
              if (i === index) continue; // removed slot
              if (i < index) next.add(i);
              else next.add(i - 1); // i > index → shift down
            }
            return { ...p, preloadedIndexes: next };
          });
          setState('network.connectedPeers', updatedPeers);
        }
      }
      // index > preloadIdx → fall through (no-op).
    }

    // Broadcast the updated playlist BEFORE kicking off any replay. Otherwise
    // playTrack fires FILE_PREPARE/PLAY first and guests momentarily sit on
    // the old playlist with the new currentTrackIndex.
    const metaList = playlist.map((item) => ({
      type: item.type,
      name: item.name,
      title: item.title || item.name,
      videoId: item.videoId || null,
      playlistId: item.playlistId || null,
    }));
    broadcast({
      type: MSG.PLAYLIST_UPDATE,
      list: metaList,
      currentTrackIndex: newIdx,
    });

    if (needsPlayRestart) {
      // The deleted slot's decoded buffer is still resident. Without
      // clearing it, playTrack(newIdx) hits the same-track fast-replay
      // path (currentIdx === newIdx, hasAudioLoaded === true) and the
      // host would play the deleted track's audio for ~3s under the new
      // track's title.
      setCurrentAudioBuffer(null);
      playTrack(newIdx);
    }
  });

  // Host: Send playlist state to newly connected peer (late-join bootstrap)
  bus.on('network:peer-connected', (conn) => {
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState('network.hostConn');
    if (hostConn) return;

    try {
      // Repeat mode
      const repeatMode = getState('playlist.repeatMode') || 0;
      conn.send({ type: MSG.REPEAT_MODE, value: repeatMode, _bootstrap: true });

      // Shuffle mode
      const isShuffle = getState('playlist.isShuffle');
      conn.send({ type: MSG.SHUFFLE_MODE, value: isShuffle, _bootstrap: true });

      // Full playlist metadata
      const playlist = getState('playlist.items') || [];
      const metaList = playlist.map((item) => ({
        type: item.type,
        name: item.name,
        title: item.title || item.name,
        videoId: item.videoId || null,
        playlistId: item.playlistId || null,
      }));
      const currentTrackIndex = getState('playlist.currentTrackIndex');
      conn.send({ type: MSG.PLAYLIST_UPDATE, list: metaList, currentTrackIndex });

      log.debug('[Playlist] Bootstrap: sent playlist state to new peer');
    } catch (e) {
      log.warn('[Playlist] Bootstrap send failed:', e);
    }
  });

  log.info('[Playlist] Initialized');
}
