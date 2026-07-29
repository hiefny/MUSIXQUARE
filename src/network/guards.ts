/**
 * MUSIXQUARE — Network Permission Guards
 *
 * Centralized permission checks shared by player, playlist, and UI modules.
 */

import { getState } from '../core/state.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { showRoomCapabilityRequired } from '../rooms/permission-feedback.ts';

/**
 * Returns true when the current participant lacks playback-control authority.
 * Shows the exact delegated-permission requirement before returning.
 *
 * Usage:
 * ```ts
 * if (isGuestBlocked()) return;
 * ```
 */
export function isGuestBlocked(): boolean {
  if (getRoomContext().kind === 'pro') {
    if (hasRoomCapability('playback.control')) return false;
    showRoomCapabilityRequired('playback.control');
    return true;
  }

  // A delegated standard-room administrator is not an all-powerful legacy
  // operator. Playback is allowed only when the host granted this capability.
  if (!hasRoomCapability('playback.control')) {
    showRoomCapabilityRequired('playback.control');
    return true;
  }

  const hostConn = getState('network.hostConn');
  if (!hostConn) return false; // Host — always allowed
  if (hasRoomCapability('playback.control')) return false;
  showRoomCapabilityRequired('playback.control');
  return true;
}
