import type { QueueItemId } from '../types/index.ts';

/**
 * Playback navigation commits the playlist's Undo-pending deletion first.
 *
 * During the Undo window the deleted rows still exist in the canonical queue,
 * so Next, Previous, a natural end or a track choice could otherwise land on
 * one of them. The playlist view registers how to send the deletion now; every
 * navigation entry point calls in here before it computes its target. The
 * Standard host applies the removal synchronously, and a Standard guest's
 * removal request precedes its navigation request on the same ordered control
 * channel. A PRO removal is a separate server mutation; the PRO playback
 * controller holds navigation commands until the Worker has applied it.
 */
let commitPendingRemoval: () => readonly QueueItemId[] = () => [];

export function setQueueRemovalCommit(commit: () => readonly QueueItemId[]): void {
  commitPendingRemoval = commit;
}

/** Send the pending deletion now. Returns the rows it removed, if any. */
export function commitQueueRemovalBeforeNavigation(): readonly QueueItemId[] {
  return commitPendingRemoval();
}

/**
 * Commit, and report whether the deletion took the playing row. That removal
 * already applies the room's own rule for a removed current track, so Next,
 * Previous and a natural end must not move playback a second time.
 */
export function navigationRemovedCurrent(currentQueueItemId: QueueItemId | null): boolean {
  return commitQueueRemovalBeforeNavigation().includes(currentQueueItemId as QueueItemId);
}
