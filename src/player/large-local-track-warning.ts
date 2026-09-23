/** Device-local compatibility messaging for large encoded local files. */

import { announceSystemMessageLocally } from '../chat/protocol.ts';
import { LOCAL_LARGE_TRACK_WARNING_BYTES } from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { getRoomContext } from '../rooms/authority.ts';
import type { QueueItemId } from '../types/index.ts';

const warnedQueueItems = new Set<QueueItemId>();
const largePlaybackQueueItems = new Set<QueueItemId>();
let largePlaybackBlobs = new WeakSet<Blob>();

/** Announce only after the bounded engine has successfully prepared this track. */
export function announceLargeTrackPlayback(identity: QueueItemId | Blob): void {
  if (typeof identity === 'string') {
    if (largePlaybackQueueItems.has(identity)) return;
    largePlaybackQueueItems.add(identity);
  } else {
    if (largePlaybackBlobs.has(identity)) return;
    largePlaybackBlobs.add(identity);
  }
  announceSystemMessageLocally('chat.large_track_playback_system_message');
}

export function maybeAnnounceLargeLocalTrackWarning(
  queueItemId: QueueItemId,
  encodedBytes: unknown,
): boolean {
  if (
    getRoomContext().kind !== 'standard' ||
    !Number.isSafeInteger(encodedBytes) ||
    (encodedBytes as number) <= LOCAL_LARGE_TRACK_WARNING_BYTES
  ) {
    return false;
  }

  if (warnedQueueItems.has(queueItemId)) return false;
  warnedQueueItems.add(queueItemId);
  announceSystemMessageLocally('chat.large_local_track_system_message');
  return true;
}

function resetLargeLocalTrackWarnings(): void {
  warnedQueueItems.clear();
  largePlaybackQueueItems.clear();
  largePlaybackBlobs = new WeakSet<Blob>();
}

// A queue occurrence is warned at most once per room session. Starting and
// leaving are separate transitions, so either boundary resets the local set.
bus.on('state:network.sessionCode', (code: unknown) => {
  if (!code) resetLargeLocalTrackWarnings();
});

bus.on('state:setup.sessionStarted', (started: unknown) => {
  if (started) resetLargeLocalTrackWarnings();
});

/** @internal Test-only reset for the module-local per-session set. */
export function resetLargeLocalTrackWarningsForTests(): void {
  resetLargeLocalTrackWarnings();
}
