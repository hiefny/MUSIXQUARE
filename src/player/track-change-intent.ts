import { getState, setState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { QueueItemId } from '../types/index.ts';

const PENDING_TRACK_CHANGE_TIMEOUT = 'pro-pending-track-change';
// A PRO asset can legitimately take many minutes to reach the coordinator.
// This is only a final escape hatch for an accepted request whose connection
// never closes and whose authoritative response never arrives.
const PENDING_TRACK_CHANGE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function beginProRoomTrackChangeIntent(queueItemId: QueueItemId): void {
  setState('network.pendingTrackChangeQueueItemId', queueItemId);
  setManagedTimer(
    PENDING_TRACK_CHANGE_TIMEOUT,
    () => {
      if (getState('network.pendingTrackChangeQueueItemId') === queueItemId) {
        setState('network.pendingTrackChangeQueueItemId', null);
      }
    },
    PENDING_TRACK_CHANGE_TIMEOUT_MS,
  );
}

export function clearProRoomTrackChangeIntent(): void {
  clearManagedTimer(PENDING_TRACK_CHANGE_TIMEOUT);
  if (getState('network.pendingTrackChangeQueueItemId') !== null) {
    setState('network.pendingTrackChangeQueueItemId', null);
  }
}

export function isProRoomTrackChangeIntentPending(): boolean {
  return getState('network.pendingTrackChangeQueueItemId') !== null;
}
