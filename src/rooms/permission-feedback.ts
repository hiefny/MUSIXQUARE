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
 * Feedback while the host projection or PRO account reconciliation is still
 * pending. Capabilities that can never be pending have no entry.
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
  'system-audio.publish': 'toast.room_owner_checking',
  'coordinator.eligible': null,
} as const satisfies Record<RoomCapability, I18nKey | null>;

/**
 * The reason a locked control shows as its hint and accessible description: a
 * short state phrase, not the toast's sentence (docs/i18n-translation-guide.md
 * §2 rule 9). Only capabilities that lock a visible control have
 * one; the tap still explains the denial with the toast above.
 */
const ROOM_CAPABILITY_TIP_KEYS = {
  'media.add': 'player.media_management_required_tip',
  'queue.mutate': 'player.media_management_required_tip',
  'asset.upload': 'player.media_management_required_tip',
  'playback.control': 'player.playback_control_required_tip',
  'effects.control': 'player.volume_locked_tip',
} as const satisfies Partial<Record<RoomCapability, I18nKey>>;

type RoomCapabilityWithTip = keyof typeof ROOM_CAPABILITY_TIP_KEYS;

/**
 * The same hint while the answer is pending: it names the check in one
 * phrase. The tap's toast keeps asking to retry in a moment.
 */
const ROOM_CAPABILITY_CHECKING_TIP_KEYS = {
  'media.add': 'player.media_management_checking_tip',
  'queue.mutate': 'player.media_management_checking_tip',
  'asset.upload': 'player.media_management_checking_tip',
  'playback.control': 'player.playback_control_checking_tip',
  'effects.control': 'player.admin_permission_checking_tip',
} as const satisfies Record<RoomCapabilityWithTip, I18nKey>;

/**
 * The definitive denial for a capability whose answer is already known: the
 * toast's sentence.
 */
function roomCapabilityRequiredMessage(capability: RoomCapability): string {
  return t(CAPABILITY_REQUIRED_TOAST[capability]);
}

/**
 * The persistent hint on a locked control: the check while the answer is
 * pending, otherwise the definitive denial. Its controls re-render when the
 * pending answer arrives.
 */
export function roomCapabilityFeedbackTip(capability: RoomCapabilityWithTip): string {
  if (roomCapabilityStatus(capability) === 'pending') {
    return t(ROOM_CAPABILITY_CHECKING_TIP_KEYS[capability]);
  }
  return t(ROOM_CAPABILITY_TIP_KEYS[capability]);
}

/**
 * Feedback for a blocked action, as a toast or a chat command's reply:
 * "checking" while the answer is still pending, otherwise the definitive
 * denial. Hints on the control itself use roomCapabilityFeedbackTip instead.
 */
export function roomCapabilityFeedbackMessage(capability: RoomCapability): string {
  const checkingKey = CAPABILITY_CHECKING_TOAST[capability];
  if (checkingKey && roomCapabilityStatus(capability) === 'pending') return t(checkingKey);
  return roomCapabilityRequiredMessage(capability);
}

export function showRoomCapabilityRequired(capability: RoomCapability): void {
  showToast(roomCapabilityFeedbackMessage(capability));
}
