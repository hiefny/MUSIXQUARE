import { t, type I18nKey } from '../i18n/index.ts';
import type { RoomCapability } from '../types/index.ts';
import { showToast } from '../ui/toast.ts';

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

export function roomCapabilityRequiredMessage(capability: RoomCapability): string {
  return t(CAPABILITY_REQUIRED_TOAST[capability]);
}

export function showRoomCapabilityRequired(capability: RoomCapability): void {
  showToast(roomCapabilityRequiredMessage(capability));
}
