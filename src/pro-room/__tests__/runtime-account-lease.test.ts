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
  type ProRoomSystemAudioState,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import {
  captureProRoomMediaHookSession,
  handleProRoomFiles,
  isProRoomMediaHookSessionCurrent,
} from '../media-hooks.ts';
import { ProRoomMediaTransfer, type ProRoomMediaUploadResult } from '../media-transfer.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';

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

function switchedAccountSnapshot(
  displayName = 'Jisu',
  memberId = 'member_lease_0002',
  revision = 3,
): ProRoomSnapshot {
  const initial = snapshot();
  return {
    ...initial,
    revision,
    presence: {
      ...initial.presence,
      revision,
      participants: initial.presence.participants.map((participant) => ({
        ...participant,
        memberId,
        displayName,
      })),
    },
    viewer: {
      ...initial.viewer!,
      memberId,
      displayName,
    },
    administrators: initial.administrators.map((administrator) => ({
      ...administrator,
      memberId,
      displayName,
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
  });

  afterEach(async () => {
    const closeSession = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced);
    const closeCallsBeforeLeave = closeSession.mock.calls.length;
    const hadActiveSession = getState('room.context').kind === 'pro';
    requestProRoomLeave();
    if (hadActiveSession) {
      await vi.waitFor(() =>
        expect(closeSession.mock.calls.length).toBeGreaterThan(closeCallsBeforeLeave),
      );
    }
    clearAllManagedTimers();
    setAccountAnonymous();
    if (visibilityDescriptor) {
      Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renews at 60 seconds, refreshes on visibility, and fails account authority closed', async () => {
    const renew = vi
      .spyOn(ProRoomApiClient.prototype, 'renewCurrentAccountLease')
      .mockResolvedValueOnce({ leaseExpiresAtMs: Date.now() + 120_000 })
      .mockRejectedValueOnce(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401));
    const lifecycleStartedAtMs = Date.now();
    const advanceTo = async (elapsedMs: number) => {
      const remainingMs = elapsedMs - (Date.now() - lifecycleStartedAtMs);
      expect(remainingMs).toBeGreaterThanOrEqual(0);
      await vi.advanceTimersByTimeAsync(remainingMs);
    };

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await Promise.resolve();
    expect(ProRoomApiClient.prototype.attachCurrentAccount).toHaveBeenCalledOnce();
    // The App cookie can already identify a successor while this room still
    // projects its predecessor. Keep account-derived authority closed until
    // the exact signed attach has completed its channel/playlist acceptance.
    expect(getState('room.context').capabilities).toEqual([]);
    await vi.waitFor(() => expect(getState('room.context').capabilities).toContain('queue.mutate'));

    await advanceTo(59_999);
    expect(renew).not.toHaveBeenCalled();
    await advanceTo(60_000);
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

  it('does not let unchanged account-session focus publications starve renewal', async () => {
    const renew = vi.mocked(ProRoomApiClient.prototype.renewCurrentAccountLease);
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    const lifecycleStartedAtMs = Date.now();
    const advanceTo = async (elapsedMs: number) => {
      const remainingMs = elapsedMs - (Date.now() - lifecycleStartedAtMs);
      expect(remainingMs).toBeGreaterThanOrEqual(0);
      await vi.advanceTimersByTimeAsync(remainingMs);
    };
    const republishUnchangedSession = () =>
      applyAccountSession({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope: 's'.repeat(43),
      });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    renew.mockClear();

    await advanceTo(30_000);
    republishUnchangedSession();
    await advanceTo(50_000);
    republishUnchangedSession();
    await advanceTo(59_999);

    expect(renew).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledOnce();

    await advanceTo(60_000);
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    expect(attach).toHaveBeenCalledOnce();
  });

  it('keeps an in-flight renewal across identical publications but reacts to a new session fence', async () => {
    const pendingRenewal = deferred<{ leaseExpiresAtMs: number }>();
    const renew = vi.mocked(ProRoomApiClient.prototype.renewCurrentAccountLease);
    renew.mockReturnValueOnce(pendingRenewal.promise);
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    const lifecycleStartedAtMs = Date.now();
    const advanceTo = async (elapsedMs: number) => {
      const remainingMs = elapsedMs - (Date.now() - lifecycleStartedAtMs);
      expect(remainingMs).toBeGreaterThanOrEqual(0);
      await vi.advanceTimersByTimeAsync(remainingMs);
    };
    const publishSession = (statsScope: string) =>
      applyAccountSession({
        configured: true,
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
        statsScope,
      });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    await advanceTo(60_000);
    expect(renew).toHaveBeenCalledOnce();

    publishSession('s'.repeat(43));
    pendingRenewal.resolve({ leaseExpiresAtMs: Date.now() + 90_000 });
    await Promise.resolve();
    await Promise.resolve();

    // The accepted server expiry schedules the next pass 30 seconds later. If
    // the unchanged publish had invalidated the flight, it would slip to 60s.
    await advanceTo(89_999);
    expect(renew).toHaveBeenCalledOnce();
    await advanceTo(90_000);
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2));

    publishSession('t'.repeat(43));
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
  });

  it('does not gate room entry on optional initial adjunct reads', async () => {
    vi.mocked(ProRoomApiClient.prototype.getSettingsSync).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    vi.mocked(ProRoomApiClient.prototype.getQueueMode).mockReturnValue(
      new Promise<never>(() => undefined),
    );

    await expect(joinProRoom({ code: ROOM_CODE, pin: '12345678' })).resolves.toMatchObject({
      roomCode: ROOM_CODE,
    });

    expect(ProRoomApiClient.prototype.getSettingsSync).toHaveBeenCalledWith(
      ROOM_CODE,
      expect.any(AbortSignal),
    );
    expect(ProRoomApiClient.prototype.getQueueMode).toHaveBeenCalledWith(
      ROOM_CODE,
      expect.any(AbortSignal),
    );
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('uses realtime invalidation plus a one-minute system-audio safety read', async () => {
    const refresh = vi.mocked(ProRoomApiClient.prototype.getSystemAudioState);

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    // Presence still heartbeats every 15 seconds, but a healthy system-audio
    // resource is no longer fetched alongside every heartbeat.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(refresh).toHaveBeenCalledOnce();

    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM_CODE,
      coordinatorEpoch: 1,
      // Rolling compatibility: pre-fix PRO Workers carried the generation on
      // the generic room invalidation rather than the dedicated event.
      event: { type: 'pro-room-invalidated', systemAudioGeneration: 1 },
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
  });

  it('queues a fresh authenticated read when invalidation races the initial system-audio read', async () => {
    const staleRead = deferred<ProRoomSystemAudioState>();
    const refresh = vi.mocked(ProRoomApiClient.prototype.getSystemAudioState);
    refresh.mockReturnValueOnce(staleRead.promise).mockResolvedValueOnce({
      generation: 1,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM_CODE,
      coordinatorEpoch: 1,
      event: { type: 'system-audio-invalidated', generation: 1 },
    });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();

    staleRead.resolve({
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it('rechecks system-audio promptly after a known preparing lease expires', async () => {
    const refresh = vi.mocked(ProRoomApiClient.prototype.getSystemAudioState);
    refresh
      .mockResolvedValueOnce({
        generation: 1,
        status: 'preparing',
        ownerParticipantId: 'participant_remote_audio',
        claimExpiresAt: Date.now() + 20_000,
        liveExpiresAt: null,
        publication: null,
      })
      .mockResolvedValue({
        generation: 2,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
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
      'effects.control',
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

  it('keeps media hooks revoked across a same-room account switch until the final channel settles', async () => {
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionA = captureProRoomMediaHookSession()!;

    const detached = detachedSnapshot();
    const switched = switchedAccountSnapshot();
    const finishAttach = deferred<ProRoomSnapshot>();
    const finishFinalReconfigure = deferred<void>();
    attach.mockClear();
    attach
      .mockImplementationOnce(async () => {
        // The old hook generation must be revoked before the account mutation
        // can synchronously dispatch its fetch under the successor App cookie.
        expect(sessionA.signal.aborted).toBe(true);
        expect(captureProRoomMediaHookSession()).toBeNull();
        throw new ProRoomApiError('SESSION_ACCOUNT_CONFLICT', 409);
      })
      .mockImplementationOnce(() => {
        expect(sessionA.signal.aborted).toBe(true);
        expect(captureProRoomMediaHookSession()).toBeNull();
        return finishAttach.promise;
      });
    const detach = vi
      .spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount')
      .mockImplementation(async () => {
        expect(sessionA.signal.aborted).toBe(true);
        expect(captureProRoomMediaHookSession()).toBeNull();
        return {
          ok: true,
          detached: true,
          snapshot: detached,
        };
      });
    const reconfigure = vi.mocked(ServerProRoomNetworkBridge.prototype.reconfigure);
    reconfigure.mockClear();
    reconfigure
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => finishFinalReconfigure.promise);

    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Jisu', profileComplete: true },
      statsScope: 't'.repeat(43),
    });

    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    expect(detach).toHaveBeenCalledOnce();
    expect(sessionA.signal.aborted).toBe(true);
    expect(isProRoomMediaHookSessionCurrent(sessionA)).toBe(false);
    // The conflict's anonymous detach is only an intermediate fence. It must
    // not reopen account-bound media while the final B attachment is pending.
    expect(captureProRoomMediaHookSession()).toBeNull();

    finishAttach.resolve(switched);
    await vi.waitFor(() => expect(reconfigure).toHaveBeenCalledTimes(2));
    // SessionController has published B's signed snapshot, but its awaited
    // signaling replacement can still be superseded by another account event.
    expect(captureProRoomMediaHookSession()).toBeNull();

    finishFinalReconfigure.resolve();
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionB = captureProRoomMediaHookSession()!;
    expect(sessionB).not.toBe(sessionA);
    expect(isProRoomMediaHookSessionCurrent(sessionB)).toBe(true);
    expect(getState('network.myDeviceLabel')).toBe('Jisu');
  });

  it('keeps logout fail-closed when a newer authenticated heartbeat supersedes its detach commit', async () => {
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionA = captureProRoomMediaHookSession()!;

    const anonymousCommit = detachedSnapshot();
    const newerAuthenticated = snapshot();
    newerAuthenticated.revision = 3;
    newerAuthenticated.presence = { ...newerAuthenticated.presence, revision: 3 };
    const finishDetachReconfigure = deferred<void>();
    const holdRecoveryHeartbeat = deferred<ProRoomSnapshot>();
    const detach = vi
      .spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount')
      .mockImplementationOnce(async () => {
        // Lock the normal detach path as well as the conflict path above: no
        // account API may begin while session A is still callable.
        expect(sessionA.signal.aborted).toBe(true);
        expect(captureProRoomMediaHookSession()).toBeNull();
        return { ok: true, detached: true, snapshot: anonymousCommit };
      });
    const reconfigure = vi.mocked(ServerProRoomNetworkBridge.prototype.reconfigure);
    reconfigure.mockClear();
    reconfigure.mockImplementationOnce(() => finishDetachReconfigure.promise);
    heartbeat.mockClear();
    heartbeat
      .mockResolvedValueOnce(newerAuthenticated)
      .mockImplementationOnce(() => holdRecoveryHeartbeat.promise);

    setAccountAnonymous(true);
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reconfigure).toHaveBeenCalledOnce());
    expect(sessionA.signal.aborted).toBe(true);
    expect(captureProRoomMediaHookSession()).toBeNull();

    // The detach snapshot is committed locally, but its signaling replacement
    // is still pending. An ordinary lifecycle heartbeat can therefore publish
    // a newer authenticated server snapshot before the adapter settles.
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getState('network.myMemberAuthenticated')).toBe(true));
    expect(getState('room.context').capabilities).toEqual([]);
    expect(captureProRoomMediaHookSession()).toBeNull();

    finishDetachReconfigure.resolve();

    // A superseded final detach is uncertainty, not success. Its failure path
    // must keep authority closed and immediately retain a canonical recovery
    // flight; resolving the adapter as success would call acceptAnonymous(),
    // reopen the authenticated snapshot above, and never issue this heartbeat.
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));
    expect(getState('room.context').capabilities).toEqual([]);
    expect(captureProRoomMediaHookSession()).toBeNull();
  });

  it('does not renew an attached hook commit superseded by a newer ordinary heartbeat', async () => {
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionA = captureProRoomMediaHookSession()!;

    const committedB = switchedAccountSnapshot();
    const canonicalAnonymous = detachedSnapshot();
    canonicalAnonymous.revision = 4;
    canonicalAnonymous.presence = { ...canonicalAnonymous.presence, revision: 4 };
    const finishBReconfigure = deferred<void>();
    const finishCAttach = deferred<ProRoomSnapshot>();
    attach.mockClear();
    attach.mockResolvedValueOnce(committedB).mockImplementationOnce(() => finishCAttach.promise);
    heartbeat.mockClear();
    heartbeat.mockResolvedValue(canonicalAnonymous);
    const reconfigure = vi.mocked(ServerProRoomNetworkBridge.prototype.reconfigure);
    reconfigure.mockClear();
    reconfigure
      .mockImplementationOnce(() => finishBReconfigure.promise)
      .mockResolvedValue(undefined);

    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Jisu', profileComplete: true },
      statsScope: 't'.repeat(43),
    });

    await vi.waitFor(() => expect(reconfigure).toHaveBeenCalledOnce());
    expect(sessionA.signal.aborted).toBe(true);
    expect(captureProRoomMediaHookSession()).toBeNull();

    // The ordinary lifecycle heartbeat owns no account transition handle, but
    // it can install a newer signed viewer while B is still awaiting channel
    // reconfiguration. That newer viewer must supersede B's final hook proof.
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(getState('network.myMemberAuthenticated')).toBe(false));

    finishBReconfigure.resolve();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Hana', profileComplete: true },
      statsScope: 'u'.repeat(43),
    });
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    expect(captureProRoomMediaHookSession()).toBeNull();
    expect(getState('network.myMemberId')).toBe(canonicalAnonymous.viewer!.memberId);

    finishCAttach.resolve(switchedAccountSnapshot('Hana', 'member_lease_0003', 5));
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    expect(getState('network.myDeviceLabel')).toBe('Hana');
  });

  it('does not treat a same-nickname heartbeat as proof of an uncertain account switch', async () => {
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionA = captureProRoomMediaHookSession()!;

    const finishRecoveryHeartbeat = deferred<ProRoomSnapshot>();
    const retryB = switchedAccountSnapshot('Minsu');
    attach.mockClear();
    attach
      .mockRejectedValueOnce(new Error('attachment response lost after commit'))
      .mockResolvedValueOnce(retryB);
    heartbeat.mockClear();
    heartbeat.mockImplementationOnce(() => finishRecoveryHeartbeat.promise);

    applyAccountSession({
      configured: true,
      authenticated: true,
      // Public room snapshots omit accountId, so this can be a different App
      // account even though its nickname is byte-for-byte identical to A.
      account: { nickname: 'Minsu', profileComplete: true },
      statsScope: 't'.repeat(43),
    });

    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    expect(sessionA.signal.aborted).toBe(true);
    expect(captureProRoomMediaHookSession()).toBeNull();

    // The canonical heartbeat can still be the old A attachment. Give the
    // accepted projection an observable, account-agnostic marker so the final
    // assertion runs after the whole heartbeat continuation has completed.
    const canonicalOldA = snapshot();
    canonicalOldA.revision = 2;
    canonicalOldA.presence = {
      ...canonicalOldA.presence,
      revision: 2,
      participants: canonicalOldA.presence.participants.map((participant) => ({
        ...participant,
        devicePlatform: 'windows',
      })),
    };
    finishRecoveryHeartbeat.resolve(canonicalOldA);
    await vi.waitFor(() =>
      expect(getState('network.lastKnownDeviceList')?.[0]?.devicePlatform).toBe('windows'),
    );
    // Accepting old A room state must not renew B's invalidated media hooks.
    expect(isProRoomMediaHookSessionCurrent(sessionA)).toBe(false);
    expect(captureProRoomMediaHookSession()).toBeNull();

    heartbeat.mockResolvedValue(retryB);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionB = captureProRoomMediaHookSession()!;
    expect(sessionB).not.toBe(sessionA);
    expect(isProRoomMediaHookSessionCurrent(sessionB)).toBe(true);
    expect(getState('network.myMemberId')).toBe('member_lease_0002');
  });

  it('renews an exact invalidated hook after a signed anonymous detach recovery', async () => {
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionA = captureProRoomMediaHookSession()!;

    const finishRecoveryHeartbeat = deferred<ProRoomSnapshot>();
    vi.spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount').mockRejectedValueOnce(
      new Error('detach response lost after commit'),
    );
    heartbeat.mockClear();
    heartbeat.mockImplementationOnce(() => finishRecoveryHeartbeat.promise);

    setAccountAnonymous(true);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    expect(sessionA.signal.aborted).toBe(true);
    expect(captureProRoomMediaHookSession()).toBeNull();

    const anonymous = detachedSnapshot();
    const delegatedCapabilities = [
      'effects.control',
      'queue.mutate',
      'playback.control',
      'asset.upload',
      'members.manage',
    ] as const;
    const delegated: ProRoomSnapshot = {
      ...anonymous,
      presence: {
        ...anonymous.presence,
        participants: anonymous.presence.participants.map((participant) => ({
          ...participant,
          role: 'controller' as const,
          capabilities: [...delegatedCapabilities],
        })),
      },
      viewer: {
        ...anonymous.viewer!,
        role: 'controller',
        capabilities: [...delegatedCapabilities],
      },
      administrators: [
        ...anonymous.administrators,
        {
          memberId: anonymous.viewer!.memberId,
          memberDisplayNumber: anonymous.viewer!.memberDisplayNumber,
          isAuthenticated: false,
          displayName: anonymous.viewer!.displayName,
          role: 'controller',
          permissions: {
            'media.add': true,
            'playback.control': true,
            'members.kick': true,
            'chat.notice': true,
          },
          inheritedPermissions: [],
          onlineDeviceCount: 1,
        },
      ],
    };
    finishRecoveryHeartbeat.resolve(delegated);
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionB = captureProRoomMediaHookSession()!;
    expect(sessionB).not.toBe(sessionA);
    expect(isProRoomMediaHookSessionCurrent(sessionA)).toBe(false);
    expect(isProRoomMediaHookSessionCurrent(sessionB)).toBe(true);
    expect(getState('network.myMemberAuthenticated')).toBe(false);
    expect(getState('room.context').capabilities).toEqual(
      expect.arrayContaining([...delegatedCapabilities]),
    );
  });

  it('recovers anonymous hooks after an incomplete successor account sheds old account A', async () => {
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    const attach = vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount);
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const sessionA = captureProRoomMediaHookSession()!;

    const finishRecoveryHeartbeat = deferred<ProRoomSnapshot>();
    const detach = vi
      .spyOn(ProRoomApiClient.prototype, 'detachCurrentAccount')
      .mockRejectedValueOnce(new Error('incomplete-account detach response lost'));
    heartbeat.mockClear();
    heartbeat.mockImplementationOnce(() => finishRecoveryHeartbeat.promise);

    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: '', profileComplete: false },
      statsScope: 't'.repeat(43),
    });

    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    expect(sessionA.signal.aborted).toBe(true);
    expect(captureProRoomMediaHookSession()).toBeNull();

    finishRecoveryHeartbeat.resolve(detachedSnapshot());
    await vi.waitFor(() => expect(captureProRoomMediaHookSession()).not.toBeNull());
    const anonymousSession = captureProRoomMediaHookSession()!;
    expect(anonymousSession).not.toBe(sessionA);
    expect(isProRoomMediaHookSessionCurrent(anonymousSession)).toBe(true);
    expect(getState('network.myMemberAuthenticated')).toBe(false);
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
    await vi.advanceTimersByTimeAsync(60_000);
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
    await vi.advanceTimersByTimeAsync(60_000);
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
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(2);

    oldRenewal.resolve({ leaseExpiresAtMs: Date.now() + 120_000 });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    // The second incarnation still owns the unresolved single flight. The old
    // finally must neither clear it nor schedule a third competing renewal.
    expect(renew).toHaveBeenCalledTimes(2);

    newRenewal.resolve({ leaseExpiresAtMs: Date.now() + 120_000 });
    await Promise.resolve();
  });

  it('keeps presence heartbeats running while a progressing upload owns the playlist mutation queue', async () => {
    let reportProgress: ((fraction: number) => void) | undefined;
    const transfer = vi
      .spyOn(ProRoomMediaTransfer.prototype, 'upload')
      .mockImplementation((input) => {
        reportProgress = input.onProgress;
        return new Promise<ProRoomMediaUploadResult>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      });
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.advanceTimersByTimeAsync(0);
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();

    expect(handleProRoomFiles([new File(['audio'], 'slow.flac', { type: 'audio/flac' })])).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(transfer).toHaveBeenCalledTimes(1);
    for (let interval = 1; interval <= 5; interval += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      reportProgress?.(interval / 10);
    }

    // A healthy direct R2 PUT can take minutes while continuing to make byte
    // progress. The room's 45-second presence lease still needs its normal
    // 15-second heartbeat cadence throughout that independent transfer.
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('does not append a late upload completion into a rejoined room incarnation', async () => {
    const upload = deferred<ProRoomMediaUploadResult>();
    const transfer = vi
      .spyOn(ProRoomMediaTransfer.prototype, 'upload')
      .mockReturnValue(upload.promise);
    const update = vi.spyOn(ProRoomApiClient.prototype, 'updateCompactSnapshot');
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.advanceTimersByTimeAsync(0);
    handleProRoomFiles([new File(['audio'], 'departing.flac', { type: 'audio/flac' })]);
    await vi.advanceTimersByTimeAsync(0);
    const oldSignal = transfer.mock.calls[0]?.[0].signal;
    expect(oldSignal?.aborted).toBe(false);
    requestProRoomLeave();
    await vi.advanceTimersByTimeAsync(0);
    expect(oldSignal?.aborted).toBe(true);
    const successor = snapshot('presence_successor_1');
    vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValue(successor);
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(successor);
    vi.mocked(ProRoomApiClient.prototype.attachCurrentAccount).mockResolvedValue(successor);
    vi.mocked(ProRoomApiClient.prototype.createSignalingTicket).mockResolvedValue(
      signalingAccess('presence_successor_1'),
    );
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    upload.resolve({
      asset: {
        kind: 'pro-r2',
        assetId: 'asset_late_upload_1',
        version: 1,
        byteLength: 5,
        mime: 'audio/flac',
      },
      quota: successor.quota,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(update).not.toHaveBeenCalled();
    expect(getState('playlist.items')).toEqual([]);
    expect(getState('room.context').kind).toBe('pro');
  });
});
