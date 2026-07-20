/**
 * MUSIXQUARE — Network Permission Guards
 *
 * Centralized permission checks shared by player, playlist, and UI modules.
 */

import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showToast } from '../ui/toast.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';

/**
 * Returns true if the current user is a guest without operator privileges.
 * Shows a toast and returns true if blocked (caller should `return`).
 *
 * Usage:
 * ```ts
 * if (isGuestBlocked()) return;
 * ```
 */
export function isGuestBlocked(): boolean {
  if (getRoomContext().kind === 'pro') {
    if (hasRoomCapability('playback.control')) return false;
    showToast(t('toast.host_only_control'));
    return true;
  }

  // A delegated standard-room administrator is not an all-powerful legacy
  // operator. Playback is allowed only when the host granted this capability.
  if (!hasRoomCapability('playback.control')) {
    showToast(t('toast.host_only_control'));
    return true;
  }

  const hostConn = getState('network.hostConn');
  if (!hostConn) return false; // Host — always allowed
  if (hasRoomCapability('playback.control')) return false;
  showToast(t('toast.host_only_control'));
  return true;
}
