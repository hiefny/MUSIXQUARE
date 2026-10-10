import { t } from '../i18n/index.ts';
import { showDialog } from '../ui/dialog.ts';
import type { ProRoomSessionEndReason } from './api.ts';

/**
 * Tab-scoped acknowledgement that this browsing context already explained a
 * removal from one PRO room. The server notice is deliberately not one-shot,
 * so without this marker every later Start in the same tab would show the
 * same "removed" dialog until the notice expires: a soft ban. After the
 * acknowledgement, a deliberate second open is an ordinary admission.
 */
const REMOVAL_ACKNOWLEDGEMENT_KEY = 'mxqr_pro_removed_ack';

export type ProRoomRemovalReason = Extract<ProRoomSessionEndReason, 'REMOVED' | 'DEVICE_REMOVED'>;
export type ProRoomPinRemovalReason = Extract<
  ProRoomSessionEndReason,
  'PIN_ENABLED' | 'PIN_CHANGED'
>;

export function isProRoomRemovalReason(
  reason: ProRoomSessionEndReason | null | undefined,
): reason is ProRoomRemovalReason {
  return reason === 'REMOVED' || reason === 'DEVICE_REMOVED';
}

export function isProRoomPinRemovalReason(
  reason: ProRoomSessionEndReason | null | undefined,
): reason is ProRoomPinRemovalReason {
  return reason === 'PIN_ENABLED' || reason === 'PIN_CHANGED';
}

export function hasProRoomRemovalAcknowledgement(code: string): boolean {
  try {
    return sessionStorage.getItem(REMOVAL_ACKNOWLEDGEMENT_KEY) === code;
  } catch {
    return false;
  }
}

export function acknowledgeProRoomRemoval(code: string): void {
  try {
    sessionStorage.setItem(REMOVAL_ACKNOWLEDGEMENT_KEY, code);
  } catch {
    // Restricted storage only means the explanation may be shown again.
  }
}

export function clearProRoomRemovalAcknowledgement(code: string): void {
  try {
    if (sessionStorage.getItem(REMOVAL_ACKNOWLEDGEMENT_KEY) === code) {
      sessionStorage.removeItem(REMOVAL_ACKNOWLEDGEMENT_KEY);
    }
  } catch {
    // Best effort: a stale marker only skips one explanation for this room.
  }
}

/** The owner/administrator or a sibling device removed this browser. */
export function showProRoomRemovalNotice(
  reason: ProRoomRemovalReason,
  signal?: AbortSignal,
): ReturnType<typeof showDialog> {
  return showDialog({
    title: () => t(reason === 'DEVICE_REMOVED' ? 'network.disconnected' : 'pro.removed_title'),
    message: () =>
      t(reason === 'DEVICE_REMOVED' ? 'pro.device_removed_message' : 'pro.removed_message'),
    buttonText: () => t('common.ok'),
    dismissible: false,
    ...(signal ? { signal } : {}),
  });
}

/** The room owner enabled or changed the PIN and chose "make everyone rejoin". */
export function showProRoomPinRemovalNotice(
  reason: ProRoomPinRemovalReason,
  signal?: AbortSignal,
): ReturnType<typeof showDialog> {
  return showDialog({
    title: () =>
      t(
        reason === 'PIN_ENABLED'
          ? 'pro.pin_enabled_removed_title'
          : 'pro.pin_changed_removed_title',
      ),
    message: () =>
      t(
        reason === 'PIN_ENABLED'
          ? 'pro.pin_enabled_removed_message'
          : 'pro.pin_changed_removed_message',
      ),
    buttonText: () => t('common.ok'),
    dismissible: false,
    ...(signal ? { signal } : {}),
  });
}

/** The first PIN prompt after a PIN-change removal explains why it appears. */
export function proRoomPinRemovalPromptMessageKey(
  reason: ProRoomPinRemovalReason,
): 'pro.pin_enabled_removed_message' | 'pro.pin_changed_removed_message' {
  return reason === 'PIN_ENABLED'
    ? 'pro.pin_enabled_removed_message'
    : 'pro.pin_changed_removed_message';
}
