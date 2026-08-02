/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAccountSession, setAccountAnonymous } from '../../account/state.ts';
import { bus } from '../../core/events.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState, setState } from '../../core/state.ts';
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

function snapshot(presenceIncarnationId = PRESENCE_ID): ProRoomSnapshot {
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
          devicePlatform: 'other',
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
      presenceIncarnationId,
      displayName: 'Minsu',
      role: 'owner',
      capabilities: [...capabilitiesForProRoomRole('owner')],
      coordinatorEligible: false,
    },
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_lease_0001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Minsu',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
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

function detachedSnapshot(): ProRoomSnapshot {
  const initial = snapshot();
  const participant = initial.presence.participants[0]!;
  return {
    ...initial,
    revision: 2,
    presence: {
      ...initial.presence,
      revision: 2,
      participants: [
        {
          ...participant,
          memberId: 'member_anonymous_lease_1',
          memberDisplayNumber: 1,
          isAuthenticated: false,
          displayName: 'Peer 1',
          role: 'member',
          capabilities: [],
        },
      ],
    },
    viewer: {
      ...initial.viewer!,
      memberId: 'member_anonymous_lease_1',
      memberDisplayNumber: 1,
      isAuthenticated: false,
      displayName: 'Peer 1',
      role: 'member',
      capabilities: [],
    },
    administrators: initial.administrators.map((administrator) => ({
      ...administrator,
      onlineDeviceCount: 0,
    })),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
      statsScope: 's'.repeat(43),
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
      schemaVersion: 2,
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
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'reconfigure').mockResolvedValue(undefined);
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

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
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
    await vi.waitFor(() => expect(getState('room.context').capabilities).toEqual([]));
  });

  it('does not gate room entry on optional initial adjunct reads', async () => {
    vi.mocked(ProRoomApiClient.prototype.getEffects).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    vi.mocked(ProRoomApiClient.prototype.getQueueMode).mockReturnValue(
      new Promise<never>(() => undefined),
    );

    await expect(joinProRoom({ code: ROOM_CODE, pin: '12345678' })).resolves.toMatchObject({
      roomCode: ROOM_CODE,
    });

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

  it('publishes unchanged heartbeat directories zero times and real changes once', async () => {
    const permissions = {
      'media.add': true,
      'playback.control': true,
      'members.kick': true,
      'chat.notice': true,
    } as const;
    const initial: ProRoomSnapshot = {
      ...snapshot(),
      authorityVersion: 1,
      administrators: [
        {
          memberId: 'member_lease_0001',
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Minsu',
          role: 'owner',
          permissions,
          inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
          onlineDeviceCount: 1,
        },
      ],
    };
    const changed: ProRoomSnapshot = {
      ...initial,
      revision: 2,
      administrators: [
        ...initial.administrators!,
        {
          memberId: 'member_lease_0002',
          memberDisplayNumber: 1,
          isAuthenticated: true,
          displayName: 'Jisu',
          role: 'controller',
          permissions: { ...permissions, 'chat.notice': false },
          inheritedPermissions: [],
          onlineDeviceCount: 0,
        },
      ],
    };
    vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValueOnce(initial);
    vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount).mockResolvedValue(initial);
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(initial);
    const administratorEvents: ProRoomSnapshot['administrators'][] = [];
    let deviceEventCount = 0;
    const unsubscribeAdministrators = bus.on('pro-room:administrators-updated', (administrators) =>
      administratorEvents.push(administrators),
    );
    const unsubscribeDevices = bus.on('network:device-list-update', () => {
      deviceEventCount += 1;
    });

    try {
      await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
      await vi.waitFor(() => expect(administratorEvents).toHaveLength(1));
      expect(deviceEventCount).toBe(1);

      vi.mocked(ProRoomApiClient.prototype.heartbeat).mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(ProRoomApiClient.prototype.heartbeat).toHaveBeenCalledOnce());
      expect(administratorEvents).toHaveLength(1);
      expect(deviceEventCount).toBe(1);

      vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(changed);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(ProRoomApiClient.prototype.heartbeat).toHaveBeenCalledTimes(2));
      expect(administratorEvents).toHaveLength(2);
      expect(administratorEvents[1]).toEqual(changed.administrators);
      expect(deviceEventCount).toBe(2);
    } finally {
      unsubscribeAdministrators();
      unsubscribeDevices();
    }
  });

  it('keeps a one-shot anonymous administrator grant after redundant account reconciliation', async () => {
    setAccountAnonymous(true);
    const initial = snapshot();
    const permissions = {
      'media.add': true,
      'playback.control': true,
      'members.kick': true,
      'chat.notice': true,
    } as const;
    const memberId = 'member_anonymous_0002';
    const capabilities = [
      'queue.mutate',
      'playback.control',
      'asset.upload',
      'members.manage',
    ] as const;
    const delegated: ProRoomSnapshot = {
      ...initial,
      memberIdentityVersion: 1,
      authorityVersion: 1,
      administrators: [
        {
          memberId: initial.viewer!.memberId,
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Owner',
          role: 'owner',
          permissions,
          inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
          onlineDeviceCount: 0,
        },
        {
          memberId,
          memberDisplayNumber: 2,
          isAuthenticated: false,
          displayName: 'Peer 2',
          role: 'controller',
          permissions,
          inheritedPermissions: [],
          onlineDeviceCount: 1,
        },
      ],
      presence: {
        ...initial.presence,
        participants: [
          {
            ...initial.presence.participants[0]!,
            memberId,
            memberDisplayNumber: 2,
            isAuthenticated: false,
            displayName: 'Peer 2',
            role: 'controller',
            capabilities: [...capabilities],
          },
        ],
      },
      viewer: {
        ...initial.viewer!,
        memberId,
        memberDisplayNumber: 2,
        isAuthenticated: false,
        displayName: 'Peer 2',
        role: 'controller',
        capabilities: [...capabilities],
      },
    };
    vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValueOnce(delegated);
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(delegated);
    const detach = vi
      .spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount')
      .mockResolvedValue({ ok: true, detached: true, snapshot: delegated });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await Promise.resolve();

    expect(detach).not.toHaveBeenCalled();
    expect(getState('room.context').capabilities).toEqual(
      expect.arrayContaining(['media.add', 'playback.control', 'asset.upload', 'members.manage']),
    );
  });

  it('projects a detached Peer identity before signaling reconfiguration can echo the old nickname', async () => {
    const detached = detachedSnapshot();
    vi.spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount').mockResolvedValue({
      ok: true,
      detached: true,
      snapshot: detached,
    });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.attachCurrentAccount).toHaveBeenCalledOnce(),
    );
    setState('network.myDeviceLabel', 'Minsu');
    vi.mocked(ServerProRoomNetworkBridge.prototype.reconfigure).mockImplementationOnce(async () => {
      // SessionController commits the authoritative snapshot before it awaits
      // the replacement signaling channel. The local heartbeat label must
      // already match that snapshot inside this former race window.
      expect(getState('network.myDeviceLabel')).toBe('Peer 1');
    });

    setAccountAnonymous(true);

    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.detachCurrentAccount).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(getState('network.myDeviceLabel')).toBe('Peer 1'));
    expect(getState('network.myMemberAuthenticated')).toBe(false);
    expect(getState('network.myMemberId')).toBe('member_anonymous_lease_1');
    expect(getState('network.lastKnownDeviceList')).toEqual([
      expect.objectContaining({
        id: PARTICIPANT_ID,
        label: 'Peer 1',
        memberId: 'member_anonymous_lease_1',
      }),
    ]);
  });

  it('fails closed and re-enters anonymously without takeover after an expired-presence detach', async () => {
    const detached = detachedSnapshot();
    const recovered: ProRoomSnapshot = {
      ...detached,
      revision: 3,
      presence: {
        ...detached.presence,
        revision: 3,
        participants: [
          {
            ...detached.presence.participants[0]!,
            participantId: 'participant_lease_2',
          },
        ],
      },
      viewer: {
        ...detached.viewer!,
        participantId: 'participant_lease_2',
        presenceIncarnationId: 'presence_lease_2',
      },
    };
    vi.spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount').mockResolvedValue({
      ok: true,
      detached: true,
      snapshot: null,
    });
    let finishEnter!: (snapshot: ProRoomSnapshot) => void;
    const enter = vi.spyOn(ProRoomApiClient.prototype, 'enterPresence').mockImplementationOnce(
      () =>
        new Promise<ProRoomSnapshot>((resolve) => {
          finishEnter = resolve;
        }),
    );

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.attachCurrentAccount).toHaveBeenCalledOnce(),
    );
    vi.mocked(ProRoomApiClient.prototype.createSignalingTicket).mockResolvedValueOnce({
      ...signalingAccess(),
      presenceIncarnationId: 'presence_lease_2',
      ticketSequence: 2,
    });

    setAccountAnonymous(true);
    await vi.waitFor(() => expect(enter).toHaveBeenCalledOnce());
    expect(getState('room.context').capabilities).toEqual([]);
    expect(enter.mock.calls[0]?.[1]).not.toHaveProperty('takeover');

    finishEnter(recovered);
    await vi.waitFor(() => expect(getState('network.myDeviceLabel')).toBe('Peer 1'));
    await vi.waitFor(() => expect(getState('room.context').capabilities).toEqual([]));
    expect(getState('network.myMemberAuthenticated')).toBe(false);
  });

  it('continues an account switch after the committed detach channel rebuild fails', async () => {
    const detached = detachedSnapshot();
    const switched: ProRoomSnapshot = {
      ...snapshot(),
      revision: 3,
      presence: {
        ...snapshot().presence,
        revision: 3,
        participants: [
          {
            ...snapshot().presence.participants[0]!,
            memberId: 'member_lease_0002',
          },
        ],
      },
      viewer: {
        ...snapshot().viewer!,
        memberId: 'member_lease_0002',
      },
      administrators: snapshot().administrators.map((administrator) => ({
        ...administrator,
        memberId: 'member_lease_0002',
      })),
    };
    vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount)
      .mockRejectedValueOnce(new ProRoomApiError('SESSION_ACCOUNT_CONFLICT', 409))
      .mockResolvedValueOnce(switched);
    vi.spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount').mockResolvedValue({
      ok: true,
      detached: true,
      snapshot: detached,
    });
    vi.mocked(ServerProRoomNetworkBridge.prototype.reconfigure)
      .mockRejectedValueOnce(new Error('old account channel unavailable'))
      .mockResolvedValueOnce(undefined);

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });

    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.attachCurrentAccount).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(getState('network.myMemberAuthenticated')).toBe(true));
    expect(ProRoomApiClient.prototype.detachCurrentAccount).toHaveBeenCalledOnce();
    expect(ServerProRoomNetworkBridge.prototype.reconfigure).toHaveBeenCalledTimes(2);
    expect(getState('network.myMemberId')).toBe(switched.viewer!.memberId);
  });

  it('ignores a previous account lease failure after logout has committed', async () => {
    let rejectRenewal: ((error: unknown) => void) | undefined;
    const renewal = new Promise<never>((_resolve, reject) => {
      rejectRenewal = reject;
    });
    const renew = vi
      .spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease')
      .mockReturnValue(renewal);
    const detached = detachedSnapshot();
    vi.spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount').mockResolvedValue({
      ok: true,
      detached: true,
      snapshot: detached,
    });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.attachCurrentAccount).toHaveBeenCalledOnce(),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect(renew).toHaveBeenCalledOnce();

    setAccountAnonymous(true);
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.detachCurrentAccount).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(getState('room.context').capabilities).toEqual([]));

    rejectRenewal?.(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401));
    await Promise.resolve();
    await Promise.resolve();

    expect(getState('room.context').capabilities).toEqual([]);
  });

  it('does not let an old renewal finally release a new incarnation flight', async () => {
    const oldRenewal = deferred<{ leaseExpiresAtMs: number }>();
    const newRenewal = deferred<{ leaseExpiresAtMs: number }>();
    const renew = vi
      .spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease')
      .mockReturnValueOnce(oldRenewal.promise)
      .mockReturnValueOnce(newRenewal.promise)
      .mockResolvedValue({ leaseExpiresAtMs: Date.now() + 120_000 });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(renew).toHaveBeenCalledTimes(1);

    requestProRoomLeave();
    const nextPresence = 'presence_lease_2';
    const nextSnapshot = snapshot(nextPresence);
    vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValueOnce(nextSnapshot);
    vi.mocked(ProRoomApiClient.prototype.createSignalingTicket).mockResolvedValue(
      signalingAccess(nextPresence),
    );
    vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount).mockResolvedValueOnce(nextSnapshot);
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(nextSnapshot);
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(renew).toHaveBeenCalledTimes(2);

    oldRenewal.resolve({ leaseExpiresAtMs: Date.now() + 120_000 });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(40_000);

    // The second incarnation still owns the unresolved single flight. The old
    // finally must neither clear it nor schedule a third competing renewal.
    expect(renew).toHaveBeenCalledTimes(2);

    newRenewal.resolve({ leaseExpiresAtMs: Date.now() + 120_000 });
    await Promise.resolve();
  });
});
