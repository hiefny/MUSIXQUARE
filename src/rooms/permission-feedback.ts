import { t, type I18nKey } from '../i18n/index.ts';
import type { RoomCapability } from '../types/index.ts';
import { showToast } from '../ui/toast.ts';
import { roomCapabilityStatus } from './authority.ts';

/**
 * Keep denial feedback aligned with the capability that actually gates the
 * action. Several controls used to reuse legacy "host only" messages even
 * after fine-grained administrator permissions were introduced.
 */
const CAPABILITY_REQUIRED_TOAST = {
  'media.add': 'toast.media_management_required',
  'queue.mutate': 'toast.media_management_required',
  'asset.upload': 'toast.media_management_required',
  'playback.control': 'toast.playback_control_required',
  'members.manage': 'toast.member_management_required',
  'chat.notice': 'toast.chat_notice_required',
  'effects.control': 'toast.settings_sync_admin_required',
  'room.configure': 'toast.room_owner_required',
  'system-audio.publish': 'toast.system_audio_owner_required',
  'coordinator.eligible': 'toast.room_owner_required',
} as const satisfies Record<RoomCapability, I18nKey>;

/**
 * Feedback while this device's answer is still unknown (a standard-room guest
 * whose host has not projected its role on the current link yet). Capabilities
 * that can never be pending have no entry.
 */
const CAPABILITY_CHECKING_TOAST = {
  'media.add': 'toast.media_management_checking',
  'queue.mutate': 'toast.media_management_checking',
  'asset.upload': 'toast.media_management_checking',
  'playback.control': 'toast.playback_control_checking',
  'members.manage': 'toast.member_management_checking',
  'chat.notice': 'toast.chat_notice_checking',
  'effects.control': 'toast.admin_permission_checking',
  'room.configure': 'toast.room_owner_checking',
  'system-audio.publish': null,
  'coordinator.eligible': null,
} as const satisfies Record<RoomCapability, I18nKey | null>;

/**
 * The definitive denial. Persistent labels (titles, aria text) use this: they
 * are not re-rendered when the pending answer arrives.
 */
export function roomCapabilityRequiredMessage(capability: RoomCapability): string {
  return t(CAPABILITY_REQUIRED_TOAST[capability]);
}

/**
 * One-shot feedback for a denied action: "checking" while the answer is still
 * pending, otherwise the definitive denial.
 */
export function roomCapabilityFeedbackMessage(capability: RoomCapability): string {
  const checkingKey = CAPABILITY_CHECKING_TOAST[capability];
  if (checkingKey && roomCapabilityStatus(capability) === 'pending') return t(checkingKey);
  return roomCapabilityRequiredMessage(capability);
}

export function showRoomCapabilityRequired(capability: RoomCapability): void {
  showToast(roomCapabilityFeedbackMessage(capability));
}
