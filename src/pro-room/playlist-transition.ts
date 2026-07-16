import type { PlaylistItem, QueueItemId } from '../types/index.ts';

interface ProRoomRemovalTransition {
  removedCurrent: boolean;
  successorQueueItemId: QueueItemId | null;
}

/** Stable queue identities removed by one accepted PRO playlist projection. */
export function findRemovedProRoomQueueItemIds(
  previousItems: readonly PlaylistItem[],
  nextItems: readonly PlaylistItem[],
): QueueItemId[] {
  const survivingIds = new Set(nextItems.map((item) => item.queueItemId));
  return previousItems
    .map((item) => item.queueItemId)
    .filter((queueItemId) => !survivingIds.has(queueItemId));
}

/**
 * Resolve the sequential successor of a removed current occurrence by stable
 * queue identity. Looking up the old numeric index in the compacted list is
 * incorrect when the same batch also removes rows before the current item.
 */
export function resolveProRoomRemovalTransition(
  previousItems: readonly PlaylistItem[],
  nextItems: readonly PlaylistItem[],
  previousCurrentQueueItemId: QueueItemId | null,
  preferredSuccessorQueueItemId: QueueItemId | null = null,
): ProRoomRemovalTransition {
  if (
    previousCurrentQueueItemId === null ||
    nextItems.some((item) => item.queueItemId === previousCurrentQueueItemId)
  ) {
    return { removedCurrent: false, successorQueueItemId: null };
  }

  const currentIndex = previousItems.findIndex(
    (item) => item.queueItemId === previousCurrentQueueItemId,
  );
  if (currentIndex < 0) return { removedCurrent: false, successorQueueItemId: null };

  const survivingIds = new Set(nextItems.map((item) => item.queueItemId));
  // The coordinator derives this preference from the existing persistent
  // shuffle traversal before applying the compacted projection. Validate the
  // stable identity here so a stale hint can never select a removed row.
  if (preferredSuccessorQueueItemId !== null && survivingIds.has(preferredSuccessorQueueItemId)) {
    return {
      removedCurrent: true,
      successorQueueItemId: preferredSuccessorQueueItemId,
    };
  }
  for (let index = currentIndex + 1; index < previousItems.length; index += 1) {
    const candidate = previousItems[index]?.queueItemId;
    if (candidate && survivingIds.has(candidate)) {
      return { removedCurrent: true, successorQueueItemId: candidate };
    }
  }
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = previousItems[index]?.queueItemId;
    if (candidate && survivingIds.has(candidate)) {
      return { removedCurrent: true, successorQueueItemId: candidate };
    }
  }
  return { removedCurrent: true, successorQueueItemId: null };
}

/**
 * Every participant tears down media it locally owns after its current row is
 * removed. Only the elected coordinator may turn the accepted queue state
 * into the next playback command.
 */
export function dispatchProRoomRemovalTransition(
  transition: ProRoomRemovalTransition,
  coordinator: boolean,
  playSuccessor: (queueItemId: QueueItemId) => void,
  stopLocalMedia: () => void,
): void {
  if (!transition.removedCurrent) return;
  if (coordinator && transition.successorQueueItemId) {
    playSuccessor(transition.successorQueueItemId);
    return;
  }
  stopLocalMedia();
}
