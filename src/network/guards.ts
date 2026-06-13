/**
 * MUSIXQUARE — Network Permission Guards
 *
 * Centralized permission checks extracted from scattered inline checks
 * across player, playlist, and UI modules.
 */

import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showToast } from '../ui/toast.ts';

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
  const hostConn = getState('network.hostConn');
  if (!hostConn) return false; // Host — always allowed
  const isOperator = getState('network.isOperator');
  if (isOperator) return false; // Operator — allowed
  showToast(t('toast.host_only_control'));
  return true;
}

/**
 * Labels of every OTHER device currently known to this client, role-aware.
 *
 * The host owns `network.connectedPeers`; on a guest that list is ALWAYS
 * empty (host-only state) and the last DEVICE_LIST_UPDATE broadcast — which
 * includes the host's own entry — is the only truthful source. Rename
 * validation must read this: checking connectedPeers on a guest passes any
 * duplicate locally, and the host's handleRequestRename then rejects the
 * request silently with no NACK (F-2404).
 */
export function getOtherDeviceLabels(): string[] {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    return getState('network.connectedPeers').map((p) => String(p.label || ''));
  }
  const myId = getState('network.myId');
  return (getState('network.lastKnownDeviceList') || [])
    .filter((device) => !!device && device.id !== myId)
    .map((device) => String(device.label || ''));
}
