/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import * as navigation from '../../core/navigation.ts';
import * as sessionReset from '../../core/session-reset.ts';
import { t } from '../../i18n/index.ts';
import { showDialog, type DialogResult } from '../../ui/dialog.ts';
import {
  ProRoomApiClient,
  ProRoomApiError,
  type ProRoomSessionEndReason,
  type ProRoomSignalingAccess,
} from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomRole,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { changeActiveProRoomPin, joinProRoom } from '../runtime.ts';
import { proHeartbeat } from './__helpers__/pro-heartbeat.ts';

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_ended_1';
const PRESENCE_ID = 'presence_ended_1';
const ACK_KEY = 'mxqr_pro_removed_ack';

vi.mock('../../ui/dialog.ts', () => ({ showDialog: vi.fn() }));

const handoff = vi.hoisted(() => ({ listener: null as ((roomCode: string) => void) | null }));
vi.mock('../tab-handoff.ts', () => ({
  onProRoomTabTakeover: (listener: (roomCode: string) => void) => {
    handoff.listener = listener;
    return () => undefined;
  },
}));

const mockedShowDialog = vi.mocked(showDialog);

function snapshot(role: ProRoomRole, presenceIncarnationId = PRESENCE_ID): ProRoomSnapshot {
  const capabilities = [...capabilitiesForProRoomRole(role)];
  return {
    schemaVersion: 1,
    memberIdentityVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 0,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 1,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: 'member_ended_0001',
          memberDisplayNumber: role === 'owner' ? 0 : 1,
          isAuthenticated: true,
          displayName: 'Minsu',
          devicePlatform: 'other',
          role,
          capabilities,
          joinedAtMs: 1,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_ended_0001',
      memberDisplayNumber: role === 'owner' ? 0 : 1,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId,
      displayName: 'Minsu',
      role,
      capabilities,
      coordinatorEligible: false,
    },
    authorityVersion: 1,
    // Exactly one owner record; the viewer is that owner or an ordinary member.
    administrators: [
      {
        memberId: role === 'owner' ? 'member_ended_0001' : 'member_owner_0001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: role === 'owner' ? 'Minsu' : 'Owner',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: role === 'owner' ? 1 : 0,
      },
    ],
  };
}

function signalingAccess(presenceIncarnationId = PRESENCE_ID): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: Date.now() + 60_000,
    role: 'member',
    coordinatorEpoch: 1,
    presenceIncarnationId,
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function join(role: ProRoomRole, presenceIncarnationId = PRESENCE_ID): Promise<void> {
  const next = snapshot(role, presenceIncarnationId);
  vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValue(next);
  vi.mocked(ProRoomApiClient.prototype.createSignalingTicket).mockResolvedValue(
    signalingAccess(presenceIncarnationId),
  );
  vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(proHeartbeat(next));
  vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount).mockResolvedValue(next);
  vi.mocked(ProRoomApiClient.prototype.enterPresence).mockResolvedValue(next);
  await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
  await vi.advanceTimersByTimeAsync(0);
}

/** The next authoritative heartbeat finds this tab's session ended. */
async function endSession(error: ProRoomApiError): Promise<void> {
  vi.mocked(ProRoomApiClient.prototype.heartbeat).mockRejectedValueOnce(error);
  expect(handoff.listener).not.toBeNull();
  handoff.listener!(ROOM_CODE);
  await vi.advanceTimersByTimeAsync(0);
}

function sessionEnded(reason: ProRoomSessionEndReason | null): ProRoomApiError {
  return new ProRoomApiError('SESSION_REQUIRED', 401, null, reason);
}

function renderedText(text: unknown): unknown {
  return typeof text === 'function' ? (text as () => string)() : text;
}

function lastDialog() {
  const options = mockedShowDialog.mock.calls.at(-1)?.[0];
  if (!options || typeof options === 'string') throw new Error('expected dialog options');
  return options;
}

describe('PRO runtime session-end reasons', { concurrent: false }, () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
    sessionStorage.clear();
    window.history.replaceState(null, '', `/${ROOM_CODE}`);
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
      statsScope: 's'.repeat(43),
    });
    mockedShowDialog.mockReset().mockResolvedValue({ action: 'ok' });
    const initial = snapshot('member');
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue(
      signalingAccess(),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(proHeartbeat(initial));
    vi.spyOn(ProRoomApiClient.prototype, 'attachCurrentAccount').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease').mockImplementation(
      async () => ({ leaseExpiresAtMs: Date.now() + 120_000 }),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockResolvedValue({
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM_CODE,
      revision: 0,
      updatedAtMs: 1,
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM_CODE,
      revision: 0,
      playlistRevision: 0,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined);
    vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'reconfigure').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    vi.spyOn(ProRoomApiClient.prototype, 'enterPresence').mockResolvedValue(initial);
    vi.spyOn(sessionReset, 'scheduleSessionReset').mockReturnValue(null);
    vi.spyOn(sessionReset, 'scheduleDocumentReload').mockImplementation(() => {});
    vi.spyOn(navigation, 'navigateToAppHome').mockImplementation(() => {});
  });

  afterEach(async () => {
    requestProRoomLeave();
    await vi.advanceTimersByTimeAsync(0);
    clearAllManagedTimers();
    setAccountAnonymous();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['REMOVED', 'pro.removed_title', 'pro.removed_message'],
    ['DEVICE_REMOVED', 'network.disconnected', 'pro.device_removed_message'],
  ] as const)(
    'explains a %s removal, acknowledges it for this tab, and goes home without reloading the room',
    async (reason, titleKey, messageKey) => {
      await join('member');
      const replaceState = vi.spyOn(window.history, 'replaceState');
      await endSession(sessionEnded(reason));
      expect(getState('room.context').kind).toBe('standard');
      expect(replaceState).toHaveBeenCalledWith(null, '', '/');
      expect(window.location.pathname).toBe('/');
      expect(mockedShowDialog).toHaveBeenCalledOnce();
      const options = lastDialog();
      expect(renderedText(options.title)).toBe(t(titleKey));
      expect(renderedText(options.message)).toBe(t(messageKey));
      expect(renderedText(options.buttonText)).toBe(t('common.ok'));
      expect(options.dismissible).toBe(false);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(sessionStorage.getItem(ACK_KEY)).toBe(ROOM_CODE);
      expect(sessionReset.scheduleSessionReset).toHaveBeenCalledOnce();
      const [message, navigate] = vi.mocked(sessionReset.scheduleSessionReset).mock.calls[0]!;
      expect(message).toBe(t('dialog.leaving_session'));
      navigate();
      expect(navigation.navigateToAppHome).toHaveBeenCalledOnce();
      expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
    },
  );

  it('explains a device disconnect to an owner device too', async () => {
    await join('owner');
    await endSession(sessionEnded('DEVICE_REMOVED'));
    expect(renderedText(lastDialog().message)).toBe(t('pro.device_removed_message'));
    expect(sessionReset.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
  });

  it.each([
    ['PIN_ENABLED', 'pro.pin_enabled_removed_title', 'pro.pin_enabled_removed_message'],
    ['PIN_CHANGED', 'pro.pin_changed_removed_title', 'pro.pin_changed_removed_message'],
  ] as const)(
    'explains a %s removal to a member before the ordinary refresh',
    async (reason, titleKey, messageKey) => {
      await join('member');
      const answer = deferred<DialogResult>();
      mockedShowDialog.mockReturnValueOnce(answer.promise);
      await endSession(sessionEnded(reason));
      const options = lastDialog();
      expect(renderedText(options.title)).toBe(t(titleKey));
      expect(renderedText(options.message)).toBe(t(messageKey));
      expect(options.dismissible).toBe(false);
      expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
      answer.resolve({ action: 'ok' });
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionReset.scheduleDocumentReload).toHaveBeenCalledExactlyOnceWith(
        t('dialog.refreshing_session'),
      );
      expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(ACK_KEY)).toBeNull();
      expect(window.location.pathname).toBe(`/${ROOM_CODE}`);
    },
  );

  it.each([
    ['an owner after a PIN change', 'owner', 'PIN_CHANGED'],
    ['any viewer without a reason', 'member', null],
  ] as const)('keeps the plain refresh for %s', async (_label, role, reason) => {
    await join(role);
    await endSession(sessionEnded(reason));
    expect(mockedShowDialog).not.toHaveBeenCalled();
    expect(sessionReset.scheduleDocumentReload).toHaveBeenCalledExactlyOnceWith(
      t('dialog.refreshing_session'),
    );
    expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(`/${ROOM_CODE}`);
  });

  it('lets a successor open abort a pending removal explanation', async () => {
    await join('member');
    const answer = deferred<DialogResult>();
    mockedShowDialog.mockReturnValueOnce(answer.promise);
    await endSession(sessionEnded('REMOVED'));
    const signal = lastDialog().signal!;
    expect(signal.aborted).toBe(false);
    await join('member', 'presence_successor');
    expect(signal.aborted).toBe(true);
    answer.resolve({ action: 'superseded' });
    await vi.advanceTimersByTimeAsync(0);
    expect(getState('room.context').kind).toBe('pro');
    expect(sessionReset.scheduleSessionReset).not.toHaveBeenCalled();
    expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(ACK_KEY)).toBeNull();
  });

  it('keeps the server reason when expired-presence recovery finds the session gone', async () => {
    await join('member');
    vi.mocked(ProRoomApiClient.prototype.enterPresence).mockRejectedValueOnce(
      sessionEnded('REMOVED'),
    );
    await endSession(new ProRoomApiError('PRESENCE_EXPIRED', 409));
    expect(ProRoomApiClient.prototype.enterPresence).toHaveBeenCalled();
    expect(renderedText(lastDialog().title)).toBe(t('pro.removed_title'));
    expect(sessionReset.scheduleSessionReset).toHaveBeenCalledOnce();
    expect(sessionReset.scheduleDocumentReload).not.toHaveBeenCalled();
  });

  it('maps a Worker that refuses the keep choice to a sentinel and never falls back', async () => {
    await join('owner');
    const changePin = vi
      .spyOn(ProRoomApiClient.prototype, 'changePin')
      .mockRejectedValueOnce(new ProRoomApiError('INVALID_REQUEST', 400))
      .mockRejectedValueOnce(new ProRoomApiError('INVALID_REQUEST', 400))
      .mockResolvedValueOnce(undefined);
    await expect(changeActiveProRoomPin('11223344', undefined, 'keep_present')).rejects.toThrow(
      'PRO_ROOM_PIN_KEEP_UNSUPPORTED',
    );
    expect(changePin).toHaveBeenCalledOnce();
    expect(changePin).toHaveBeenLastCalledWith(ROOM_CODE, '11223344', undefined, 'keep_present');
    // The legacy request keeps its own error unchanged.
    await expect(changeActiveProRoomPin('11223344')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    });
    expect(changePin).toHaveBeenLastCalledWith(ROOM_CODE, '11223344', undefined, undefined);
    await expect(
      changeActiveProRoomPin('11223344', undefined, 'keep_present'),
    ).resolves.toBeUndefined();
    expect(changePin).toHaveBeenCalledTimes(3);
    expect(getState('room.context').kind).toBe('pro');
  });
});
