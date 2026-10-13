/** Complete playlist acquisition for Standard-room queue operations.
 * The iframe's getPlaylist() is only a window, never proof of completeness.
 */
import { getState } from '../core/state.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { SessionScope } from '../core/session-scope.ts';
import { raceWithAbortSignal } from '../core/request-lifetime.ts';
import { subscribeRoomAuthorityLifecycle } from '../rooms/authority.ts';
import { getCurrentLoadEpoch } from '../player/_state.ts';
import { getQueueItemById } from '../player/queue-model.ts';
import type { QueueItemId } from '../types/index.ts';
import { showLoader, showToast } from '../ui/toast.ts';
import { updateSubItemIds } from './_state.ts';
import {
  getPrefetchedYouTubePlaylistManifest,
  resolveYouTubePlaylistManifest,
  type YouTubePlaylistManifest,
} from './search.ts';

/** Acquire only; callers publish after checking their queue/operation identity. */
export function resolveCompleteStandardPlaylist(
  playlistId: string,
  signal: AbortSignal,
): Promise<YouTubePlaylistManifest> {
  signal.throwIfAborted();
  const prefetched = getPrefetchedYouTubePlaylistManifest(playlistId);
  const cached = getState('youtube.subItemsMap')[playlistId];
  const complete =
    prefetched ??
    (cached?.manifestComplete && cached.ids.length
      ? {
          playlistId,
          videoId: cached.ids[0],
          videoIds: [...cached.ids],
          title: playlistId,
        }
      : null);
  return raceWithAbortSignal(
    complete ? Promise.resolve(complete) : resolveYouTubePlaylistManifest(playlistId, signal),
    signal,
  );
}

/** Room identity and authority are leases, not properties of a late response. */
export function createStandardPlaylistScope(): SessionScope {
  const scope = new SessionScope();
  const context = getState('room.context');
  const code = getState('network.sessionCode');
  const current = (): boolean => {
    const next = getState('room.context');
    return (
      next.kind === 'standard' &&
      next.roomId === context.roomId &&
      next.epoch === context.epoch &&
      next.role === context.role &&
      getState('network.sessionCode') === code &&
      !getState('network.hostConn')
    );
  };
  scope.own(
    subscribeRoomAuthorityLifecycle(() => {
      if (!current()) scope.dispose();
    }),
  );
  if (!current()) scope.dispose();
  return scope;
}

let pendingSelection: SessionScope | null = null;
let selectionSequence = 0;

export function cancelStandardPlaylistSelection(): void {
  pendingSelection?.dispose();
  pendingSelection = null;
}

/** Repair old/unproven caches before touching the current playback or selection. */
export async function prepareStandardPlaylistSelection(
  queueItemId: QueueItemId,
  onReady?: () => void | Promise<void>,
): Promise<boolean> {
  cancelStandardPlaylistSelection();
  const item = getQueueItemById(queueItemId);
  if (!item?.playlistId) return false;
  const playlistId = item.playlistId;
  const scope = createStandardPlaylistScope();
  if (scope.aborted) return false;
  pendingSelection = scope;
  const loadEpoch = getCurrentLoadEpoch();
  const previousSelection = getState('playlist.currentQueueItemId');
  const previousActivity = getState('playback.activity');
  const current = (): boolean =>
    !scope.aborted &&
    pendingSelection === scope &&
    getCurrentLoadEpoch() === loadEpoch &&
    getState('playlist.currentQueueItemId') === previousSelection &&
    getState('playback.activity') === previousActivity &&
    getQueueItemById(queueItemId)?.playlistId === playlistId;
  const cancelIfStale = (): void => {
    if (!current()) scope.dispose();
  };
  scope.own(bus.on('state:playlist.items', cancelIfStale));
  scope.own(bus.on('state:playlist.currentQueueItemId', cancelIfStale));
  scope.own(bus.on('state:playback.activity', cancelIfStale));
  scope.own(bus.on('player:stop-all-media', () => scope.dispose()));
  scope.own(bus.on('youtube:stop-mode', () => scope.dispose()));
  scope.own(
    bus.on('youtube:set-local-paused', (paused) => {
      if (paused) scope.dispose();
    }),
  );
  const loaderId = `youtube-playlist-selection:${++selectionSequence}`;
  showLoader(true, t('youtube.fetching_info'), loaderId);
  scope.own(() => showLoader(false, undefined, loaderId));
  let applyingSelection = false;
  try {
    const manifest = await resolveCompleteStandardPlaylist(playlistId, scope.signal);
    if (!current()) return false;
    updateSubItemIds(playlistId, manifest.videoIds, { manifestComplete: true });
    if (!current()) return false;
    // Apply in the same turn as the final lease check. Returning a bare ready
    // flag and applying in the caller's next microtask could revive a choice
    // superseded between those two continuations.
    scope.dispose();
    if (pendingSelection === scope) pendingSelection = null;
    applyingSelection = true;
    await onReady?.();
    return true;
  } catch (error) {
    if (applyingSelection) throw error;
    if (current()) {
      log.warn('[YouTube] Could not resolve complete playlist before selection:', error);
      showToast(t('youtube.fetch_failed'));
    }
    return false;
  } finally {
    scope.dispose();
    if (pendingSelection === scope) pendingSelection = null;
  }
}
