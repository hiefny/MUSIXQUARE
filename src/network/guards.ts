/**
 * MUSIXQUARE 3.0 — Network Permission Guards
 *
 * Centralized permission checks extracted from scattered inline checks
 * across player, playlist, and UI modules.
 */

import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';

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
  bus.emit('ui:show-toast', t('toast.host_only_control'));
  return true;
}

/**
 * Returns true if the current user is a guest (regardless of operator status).
 * No toast — use when you just need to check, not block.
 */
export function isGuest(): boolean {
  return !!getState('network.hostConn');
}
