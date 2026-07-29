import { getRoomContext } from '../rooms/authority.ts';
import {
  publishSignalingReconnectAttempt,
  publishSignalingRecovered,
  resetSignalingHealth,
  SIGNALING_RECOVERY_MAX_ATTEMPTS,
} from '../network/signaling-health.ts';
import { requestProRoomSignalingEpochAdvance } from './lifecycle-hook.ts';

let recoveryRequested = false;

/**
 * Convert any PRO control-channel loss into an in-place server-channel
 * recovery. Returning true means the caller must suppress ordinary-room
 * disconnect UI and preserve the active session surface.
 */
export function requestProRoomTransportRecovery(): boolean {
  if (getRoomContext().kind !== 'pro') return false;
  if (recoveryRequested) return true;

  recoveryRequested = true;
  publishSignalingReconnectAttempt(1, SIGNALING_RECOVERY_MAX_ATTEMPTS);
  requestProRoomSignalingEpochAdvance();
  return true;
}

/** Restart the exhausted PRO control-channel budget without leaving the room. */
export function restartProRoomTransportRecovery(): boolean {
  if (getRoomContext().kind !== 'pro') return false;
  recoveryRequested = true;
  publishSignalingReconnectAttempt(1, SIGNALING_RECOVERY_MAX_ATTEMPTS);
  requestProRoomSignalingEpochAdvance();
  return true;
}

/** Re-arm the one-shot after the authenticated server channel is live. */
export function markProRoomTransportRecovered(): void {
  recoveryRequested = false;
  publishSignalingRecovered();
}

/** Clear room-scoped recovery ownership after leave/terminal teardown. */
export function resetProRoomTransportRecovery(): void {
  recoveryRequested = false;
  resetSignalingHealth();
}
