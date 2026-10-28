/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import en from '../../i18n/en.ts';
import { t, type I18nKey } from '../../i18n/index.ts';
import ko from '../../i18n/ko.ts';
import type { DataConnection, RoomCapability } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import { markStandardRoomAuthorityConfirmed, setRoomContext } from '../authority.ts';
import {
  roomCapabilityFeedbackMessage,
  roomCapabilityFeedbackTip,
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
  ['effects.control', 'toast.settings_sync_admin_required'],
  ['room.configure', 'toast.room_owner_required'],
  ['system-audio.publish', 'toast.system_audio_owner_required'],
  ['coordinator.eligible', 'toast.room_owner_required'],
] as const satisfies readonly (readonly [RoomCapability, I18nKey])[];

// A locked control's hint is one state phrase; the toast keeps its sentences.
const TIP_CASES = [
  ['media.add', 'player.media_management_required_tip'],
  ['queue.mutate', 'player.media_management_required_tip'],
  ['asset.upload', 'player.media_management_required_tip'],
  ['playback.control', 'player.playback_control_required_tip'],
  ['effects.control', 'player.volume_locked_tip'],
] as const satisfies readonly (readonly [RoomCapability, I18nKey])[];

// While the answer is pending the hint names the check, also in one phrase.
const CHECKING_TIP_CASES = [
  ['media.add', 'player.media_management_checking_tip'],
  ['queue.mutate', 'player.media_management_checking_tip'],
  ['asset.upload', 'player.media_management_checking_tip'],
  ['playback.control', 'player.playback_control_checking_tip'],
  ['effects.control', 'player.admin_permission_checking_tip'],
] as const satisfies readonly (readonly [RoomCapability, I18nKey])[];

function definitiveTipKey(capability: RoomCapability): I18nKey {
  return TIP_CASES.find(([candidate]) => candidate === capability)![1];
}

const CHECKING_CASES = [
  ['media.add', 'toast.media_management_checking'],
  ['queue.mutate', 'toast.media_management_checking'],
  ['asset.upload', 'toast.media_management_checking'],
  ['playback.control', 'toast.playback_control_checking'],
  ['members.manage', 'toast.member_management_checking'],
  ['chat.notice', 'toast.chat_notice_checking'],
  ['effects.control', 'toast.admin_permission_checking'],
  ['room.configure', 'toast.room_owner_checking'],
] as const satisfies readonly (readonly [RoomCapability, I18nKey])[];

function joinStandardRoomAsGuest(): DataConnection {
  const hostConn = { peer: 'host', open: true } as DataConnection;
  setState('network.appRole', 'guest');
  setState('setup.sessionStarted', true);
  setState('network.hostConn', hostConn);
  return hostConn;
}

beforeEach(() => {
  resetState();
  vi.mocked(showToast).mockClear();
});

describe('room permission feedback', () => {
  it.each(TIP_CASES)('hints %s on its locked control with a short phrase', (capability, key) => {
    expect(roomCapabilityFeedbackTip(capability)).toBe(t(key));
    // Korean toasts are 해요체 sentences; the hint ends in a noun form.
    expect(ko[key]).toMatch(/(?:필요|가능)$/u);
    for (const dictionary of [en, ko] as const) {
      expect(dictionary[key], key).not.toMatch(/[\n.]/u);
    }
  });

  it.each(CASES)('maps %s to its exact user-facing requirement', (capability, key) => {
    expect(roomCapabilityFeedbackMessage(capability)).toBe(t(key));
  });

  it('shows the mapped requirement instead of a legacy role-only message', () => {
    showRoomCapabilityRequired('playback.control');

    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(t('toast.playback_control_required'));
  });

  it('distinguishes synchronized audio authority from owner-only room configuration', () => {
    expect(roomCapabilityFeedbackMessage('effects.control')).toBe(
      t('toast.settings_sync_admin_required'),
    );
    expect(roomCapabilityFeedbackMessage('room.configure')).toBe(t('toast.room_owner_required'));
    expect(roomCapabilityFeedbackMessage('coordinator.eligible')).toBe(
      t('toast.room_owner_required'),
    );

    showRoomCapabilityRequired('effects.control');
    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(t('toast.settings_sync_admin_required'));
  });
});

describe('room permission feedback while the answer is pending', () => {
  it.each(CHECKING_CASES)(
    'asks the guest to retry %s while its role is still being confirmed',
    (capability, key) => {
      joinStandardRoomAsGuest();

      expect(roomCapabilityFeedbackMessage(capability)).toBe(t(key));
      showRoomCapabilityRequired(capability);
      expect(showToast).toHaveBeenCalledWith(t(key));
    },
  );

  it.each(CASES)(
    'keeps the definitive denial for %s once the role is confirmed',
    (capability, key) => {
      markStandardRoomAuthorityConfirmed(joinStandardRoomAsGuest());

      expect(roomCapabilityFeedbackMessage(capability)).toBe(t(key));
      showRoomCapabilityRequired(capability);
      expect(showToast).toHaveBeenCalledWith(t(key));
    },
  );

  it('replaces checking feedback with definitive wording when the role is confirmed', () => {
    const connection = joinStandardRoomAsGuest();
    expect(roomCapabilityFeedbackMessage('playback.control')).toBe(
      t('toast.playback_control_checking'),
    );

    markStandardRoomAuthorityConfirmed(connection);
    expect(roomCapabilityFeedbackMessage('playback.control')).toBe(
      t('toast.playback_control_required'),
    );
  });

  it.each([...CHECKING_CASES, ['system-audio.publish', 'toast.room_owner_checking'] as const])(
    'uses checking feedback for %s during PRO account reconciliation',
    (capability, key) => {
      const context = {
        kind: 'pro' as const,
        roomId: '000001',
        role: 'member' as const,
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: [],
      };
      setRoomContext(context, 'pending');
      expect(roomCapabilityFeedbackMessage(capability)).toBe(t(key));

      setRoomContext(context);
      expect(roomCapabilityFeedbackMessage(capability)).toBe(
        t(CASES.find(([candidate]) => candidate === capability)![1]),
      );
    },
  );

  it.each(CHECKING_TIP_CASES)(
    'hints %s with a short checking phrase until the guest role is confirmed',
    (capability, key) => {
      const connection = joinStandardRoomAsGuest();

      expect(roomCapabilityFeedbackTip(capability)).toBe(t(key));
      // Not the toast's two sentences: one state phrase, like the denial.
      expect(ko[key]).toMatch(/ 확인 중$/u);
      for (const dictionary of [en, ko] as const) {
        expect(dictionary[key], key).not.toMatch(/[\n.]/u);
      }

      markStandardRoomAuthorityConfirmed(connection);
      expect(roomCapabilityFeedbackTip(capability)).toBe(t(definitiveTipKey(capability)));
    },
  );

  it.each(CHECKING_TIP_CASES)(
    'hints %s with the checking phrase during PRO account reconciliation',
    (capability, key) => {
      const context = {
        kind: 'pro' as const,
        roomId: '000001',
        role: 'member' as const,
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: [],
      };
      setRoomContext(context, 'pending');
      expect(roomCapabilityFeedbackTip(capability)).toBe(t(key));

      setRoomContext(context);
      expect(roomCapabilityFeedbackTip(capability)).toBe(t(definitiveTipKey(capability)));
    },
  );

  it('never asks a guest to wait for a physical host role', () => {
    joinStandardRoomAsGuest();

    showRoomCapabilityRequired('system-audio.publish');
    expect(showToast).toHaveBeenCalledWith(t('toast.system_audio_owner_required'));
  });

  it('keeps the owner-provided Korean wording on two lines', () => {
    expect(ko['toast.media_management_checking']).toBe(
      '미디어 관리 권한을 확인 중이에요\n잠시 후 다시 시도해 주세요',
    );
    expect(ko['toast.room_owner_checking']).toBe(
      '방 소유자 권한을 확인 중이에요\n잠시 후 다시 시도해 주세요',
    );
    expect(en['toast.media_management_checking']).toBe(
      'Checking media management permission\nPlease try again in a moment',
    );
  });
});
