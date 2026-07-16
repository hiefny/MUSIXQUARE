import { t } from '../i18n/index.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { showToast } from '../ui/toast.ts';
import { requestProRoomSignalingEpochAdvance } from './lifecycle-hook.ts';

let recoveryRequested = false;

/**
 * Convert a legacy host-connection loss into a persistent-room topology
 * recovery. Returning true means the caller must suppress ordinary-room
 * disconnect UI and preserve the active session surface.
 */
export function requestProRoomTransportRecovery(): boolean {
  if (getRoomContext().kind !== 'pro') return false;
  if (recoveryRequested) return true;

  recoveryRequested = true;
  showToast(t('pro.reconnecting'));
  requestProRoomSignalingEpochAdvance();
  return true;
}

/** Re-arm the one-shot after a replacement coordinator topology is live. */
export function markProRoomTransportRecovered(): void {
  recoveryRequested = false;
}

/** Clear room-scoped recovery ownership after leave/terminal teardown. */
export function resetProRoomTransportRecovery(): void {
  recoveryRequested = false;
}
