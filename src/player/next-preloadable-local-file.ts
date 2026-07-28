import type { PlaylistItem, QueueItemId } from '../types/index.ts';

interface NextPreloadableLocalFileSelectionOptions {
  readonly items: readonly Readonly<PlaylistItem>[];
  readonly currentQueueItemId: QueueItemId | null;
  readonly repeatMode: number;
  readonly isShuffle: boolean;
  /** Non-advancing hint from the authoritative shuffle permutation. */
  readonly shuffleNextQueueItemId?: QueueItemId | null;
}

interface NextPreloadableLocalFileSelection {
  readonly item: Readonly<PlaylistItem>;
  readonly queueItemId: QueueItemId;
  readonly indexHint: number;
}

/**
 * Select the next local-file occurrence that a speculative preload or warm may stage.
 *
 * This function deliberately knows nothing about codecs or file sizes. Shuffle
 * owns its exact next occurrence, while sequential and repeat-all playback may
 * scan past YouTube rows. Repeat-one always keeps the current occurrence.
 */
export function selectNextPreloadableLocalFile(
  options: Readonly<NextPreloadableLocalFileSelectionOptions>,
): Readonly<NextPreloadableLocalFileSelection> | null {
  const { items, currentQueueItemId, repeatMode, isShuffle } = options;
  if (items.length <= 1 || currentQueueItemId === null) return null;

  const currentTrackIndex = items.findIndex((item) => item.queueItemId === currentQueueItemId);
  if (currentTrackIndex < 0) return null;

  let nextIndex: number;
  if (repeatMode === 2) {
    nextIndex = currentTrackIndex;
  } else if (isShuffle) {
    const hintedIndex = items.findIndex(
      (item) => item.queueItemId === options.shuffleNextQueueItemId,
    );
    nextIndex = hintedIndex >= 0 && hintedIndex !== currentTrackIndex ? hintedIndex : -1;
  } else {
    nextIndex = currentTrackIndex + 1;
    if (nextIndex >= items.length) {
      nextIndex = repeatMode === 1 ? 0 : -1;
    }
  }

  if (nextIndex < 0 || nextIndex >= items.length) return null;

  // Only linear traversal may skip non-local rows. A shuffle hint identifies
  // one exact occurrence and repeat-one intentionally targets only itself.
  if (!isShuffle && repeatMode !== 2) {
    let scanCount = 0;
    while (scanCount < items.length && items[nextIndex] && items[nextIndex].type === 'youtube') {
      nextIndex += 1;
      if (nextIndex >= items.length) {
        if (repeatMode === 1) {
          nextIndex = 0;
        } else {
          nextIndex = -1;
          break;
        }
      }
      if (nextIndex === currentTrackIndex) {
        nextIndex = -1;
        break;
      }
      scanCount += 1;
    }
  }

  if (nextIndex < 0 || nextIndex >= items.length) return null;
  const item = items[nextIndex];
  if (!item || item.type === 'youtube') return null;

  return Object.freeze({ item, queueItemId: item.queueItemId, indexHint: nextIndex });
}
