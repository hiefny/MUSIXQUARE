/** Terminal decoder rejection is device-local for guests and PRO participants. */
import { announceSystemMessageLocally, broadcastSystemMessage } from '../chat/protocol.ts';
import { MSG } from '../core/constants.ts';
import { log } from '../core/log.ts';
import { setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { showToast } from '../ui/toast.ts';
import { transition } from './lifecycle.ts';
import { setPlaybackIdle, setPlaybackTrackMeta } from './ownership.ts';
import { loadPlaylistModule } from './playlist-loader.ts';
import { getState, setState } from '../core/state.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  getTrackKeyFromItem,
  getCurrentLoadEpoch,
  isCurrentLoadEpoch,
  clearFailedTracks,
  setCurrentAudioBuffer,
  isTrackFailed,
  markTrackFailed,
  setPendingPlayTime,
  setPendingRecoveryTarget,
} from './_state.ts';
import {
  getQueueItemById,
  getCurrentQueueItemId,
  findQueueItemIndex,
  selectQueueItemById,
} from './queue-model.ts';

export function markDeviceTrackUnavailable(queueItemId: QueueItemId): void {
  // A terminal device-local rejection owns neither the failed occurrence's
  // pending position nor its recovery target. Keeping either would let a
  // PREPARE-lost successor inherit stale playback intent.
  setPendingPlayTime(undefined);
  setPendingRecoveryTarget(null);
  const key = getTrackKeyFromItem(getQueueItemById(queueItemId));
  if (isTrackFailed(key)) return;
  markTrackFailed(key);
  announceSystemMessageLocally('chat.device_track_unavailable_system_message');
  if (getState('room.context').kind !== 'pro') {
    sendToHost({ type: MSG.GUEST_DECODE_FAILED, queueItemId });
  }
}

/** Keep the established local-authority next-track policy shared across decoders. */
export function markFailedAndAdvance(
  failedQueueItemId: QueueItemId,
  stopAllMedia: () => void,
): void {
  const failedItem = getQueueItemById(failedQueueItemId);
  if (!failedItem || getCurrentQueueItemId() !== failedQueueItemId) return;

  broadcastSystemMessage('chat.decode_skip_system_message');
  markTrackFailed(getTrackKeyFromItem(failedItem));

  const playlist = getState('playlist.items') || [];
  const playableCount = playlist.reduce(
    (count, item) => count + (isTrackFailed(getTrackKeyFromItem(item)) ? 0 : 1),
    0,
  );
  if (playableCount === 0) {
    showToast(t('error.all_tracks_failed'));
    clearFailedTracks();
    stopAllMedia();
    setCurrentAudioBuffer(null);
    setPlaybackTrackMeta(null);
    selectQueueItemById(null);
    setState('files.current', null);
    setState('player.pausedAt', 0);
    setPlaybackIdle();
    transition({ type: 'PAUSE', time: 0, queueItemId: null, endOfPlaylist: true });
    broadcast({
      type: MSG.PAUSE,
      time: 0,
      queueItemId: null,
      endOfPlaylist: true,
      reason: 'end-of-playlist',
    });
    return;
  }

  const advanceEpoch = getCurrentLoadEpoch();
  setManagedTimer(
    'decode-fail-advance',
    () => {
      if (
        !isCurrentLoadEpoch(advanceEpoch) ||
        getCurrentQueueItemId() !== failedQueueItemId ||
        !getQueueItemById(failedQueueItemId)
      ) {
        log.debug('[Decode] Skipping auto-advance because queue ownership changed');
        return;
      }

      void loadPlaylistModule()
        .then(({ getShuffleNextPlayableQueueItemId, playNextTrack, playTrack }) => {
          const livePlaylist = getState('playlist.items') || [];
          const failedIndex = findQueueItemIndex(failedQueueItemId, livePlaylist);
          if (failedIndex < 0 || getCurrentQueueItemId() !== failedQueueItemId) return;

          const isGoodCandidate = (queueItemId: QueueItemId): boolean => {
            const item = getQueueItemById(queueItemId, livePlaylist);
            return (
              !!item &&
              queueItemId !== failedQueueItemId &&
              !isTrackFailed(getTrackKeyFromItem(item))
            );
          };

          let targetQueueItemId: QueueItemId | null = null;
          const preloadedQueueItemId = getState('preload.nextQueueItemId');
          if (preloadedQueueItemId && isGoodCandidate(preloadedQueueItemId)) {
            targetQueueItemId = preloadedQueueItemId;
          }

          if (!targetQueueItemId && getState('playlist.isShuffle')) {
            targetQueueItemId = getShuffleNextPlayableQueueItemId((queueItemId) =>
              isGoodCandidate(queueItemId),
            );
          }

          if (!targetQueueItemId && !getState('playlist.isShuffle')) {
            const repeatMode = getState('playlist.repeatMode');
            const maxProbe =
              repeatMode === 1 ? livePlaylist.length : livePlaylist.length - 1 - failedIndex;
            for (let probe = 1; probe <= maxProbe; probe++) {
              const candidate = livePlaylist[(failedIndex + probe) % livePlaylist.length];
              if (candidate && isGoodCandidate(candidate.queueItemId)) {
                targetQueueItemId = candidate.queueItemId;
                break;
              }
            }
          }

          if (targetQueueItemId) {
            return playTrack(targetQueueItemId);
          } else {
            playNextTrack();
          }
        })
        .catch((error) => {
          log.warn('[Decode] Failed to load the playlist for decode-failure recovery:', error);
          showToast(t('error.network_generic'));
        });
    },
    600,
  );
}
