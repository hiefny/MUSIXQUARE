/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { ProRoomApiClient, ProRoomApiError, type ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { joinProRoom } from '../runtime.ts';

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_lease_1';
const PRESENCE_ID = 'presence_lease_1';

function snapshot(): ProRoomSnapshot {
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
          memberId: 'member_lease_0001',
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Minsu',
          role: 'owner',
          capabilities: [...capabilitiesForProRoomRole('owner')],
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
      memberId: 'member_lease_0001',
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: PRESENCE_ID,
      displayName: 'Minsu',
      role: 'owner',
      capabilities: [...capabilitiesForProRoomRole('owner')],
      coordinatorEligible: false,
    },
  };
}

function signalingAccess(): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: Date.now() + 60_000,
    role: 'member',
    coordinatorEpoch: 1,
    presenceIncarnationId: PRESENCE_ID,
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

describe.sequential('PRO runtime account identity lease', () => {
  let visibilityDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
    });
    visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

    const initial = snapshot();
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue(
      signalingAccess(),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'attachCurrentAccount').mockResolvedValue(initial);
    vi.spyOn(ProRoomApiClient.prototype, 'getEffects').mockResolvedValue({
      schemaVersion: 1,
      view: 'effects',
      roomCode: ROOM_CODE,
      revision: 0,
      updatedAtMs: 1,
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
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
  });

  afterEach(async () => {
    requestProRoomLeave();
    await Promise.resolve();
    clearAllManagedTimers();
    setAccountAnonymous();
    if (visibilityDescriptor) {
      Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renews at 40 seconds, refreshes on visibility, and fails account authority closed', async () => {
    const renew = vi
      .spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease')
      .mockResolvedValueOnce({ leaseExpiresAtMs: Date.now() + 120_000 })
      .mockRejectedValueOnce(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401));

    await joinProRoom({ code: ROOM_CODE, pin: '12345678', displayName: 'Minsu' });
    await Promise.resolve();
    expect(ProRoomApiClient.prototype.attachCurrentAccount).toHaveBeenCalledOnce();
    expect(getState('room.context').capabilities).toContain('queue.mutate');

    await vi.advanceTimersByTimeAsync(39_999);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenLastCalledWith(ROOM_CODE);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(getState('room.context').capabilities).toEqual(['playback.control']),
    );
  });

  it('does not gate room entry on optional initial adjunct reads', async () => {
    vi.mocked(ProRoomApiClient.prototype.getEffects).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    vi.mocked(ProRoomApiClient.prototype.getQueueMode).mockReturnValue(
      new Promise<never>(() => undefined),
    );

    await expect(
      joinProRoom({ code: ROOM_CODE, pin: '12345678', displayName: 'Minsu' }),
    ).resolves.toMatchObject({ roomCode: ROOM_CODE });

    expect(ProRoomApiClient.prototype.getEffects).toHaveBeenCalledWith(
      ROOM_CODE,
      expect.any(AbortSignal),
    );
    expect(ProRoomApiClient.prototype.getQueueMode).toHaveBeenCalledWith(
      ROOM_CODE,
      expect.any(AbortSignal),
    );
    expect(getState('network.isConnecting')).toBe(false);
  });
});
