/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type I18nKey } from '../../i18n/index.ts';
import type { RoomCapability } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import {
  roomCapabilityRequiredMessage,
  showRoomCapabilityRequired,
} from '../permission-feedback.ts';

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
}));

const CASES = [
  ['media.add', 'toast.media_management_required'],
  ['queue.mutate', 'toast.media_management_required'],
  ['asset.upload', 'toast.media_management_required'],
  ['playback.control', 'toast.playback_control_required'],
  ['members.manage', 'toast.member_management_required'],
  ['chat.notice', 'toast.chat_notice_required'],
  ['effects.control', 'toast.room_owner_required'],
  ['room.configure', 'toast.room_owner_required'],
  ['system-audio.publish', 'toast.system_audio_owner_required'],
  ['coordinator.eligible', 'toast.room_owner_required'],
] as const satisfies readonly (readonly [RoomCapability, I18nKey])[];

beforeEach(() => {
  vi.mocked(showToast).mockClear();
});

describe('room permission feedback', () => {
  it.each(CASES)('maps %s to its exact user-facing requirement', (capability, key) => {
    expect(roomCapabilityRequiredMessage(capability)).toBe(t(key));
  });

  it('shows the mapped requirement instead of a legacy role-only message', () => {
    showRoomCapabilityRequired('playback.control');

    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(t('toast.playback_control_required'));
  });
});
