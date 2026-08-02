import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProRoomApiError, type ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
} from '../contracts.ts';
import {
  ProRoomSessionController,
  type ProRoomSessionApiForTests as ProRoomSessionApi,
  type ProRoomSessionObserver,
  type ProRoomTransportBridge,
} from '../session-controller.ts';

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_00001';

function snapshot(overrides: Partial<ProRoomSnapshot> = {}): ProRoomSnapshot {
  const value: ProRoomSnapshot = {
    schemaVersion: 1,
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
          memberId: 'member_0000000001',
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Owner',
          devicePlatform: 'other',
          role: 'owner',
          capabilities: [
            'queue.mutate',
            'playback.control',
            'effects.control',
            'asset.upload',
            'members.manage',
            'room.configure',
          ],
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
      memberId: 'member_0000000001',
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
        'room.configure',
      ],
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_0000000001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
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
    ...overrides,
  };

  if (!Object.prototype.hasOwnProperty.call(overrides, 'administrators')) {
    const authorityParticipants = new Map(
      value.presence.participants
        .filter((participant) => participant.role !== 'member')
        .map((participant) => [participant.memberId, participant]),
    );
    value.administrators = [...authorityParticipants.values()].map((participant) => {
      const permissions =
        participant.role === 'owner'
          ? {
              'media.add': true,
              'playback.control': true,
              'members.kick': true,
              'chat.notice': true,
            }
          : {
              'media.add': participant.capabilities.includes('queue.mutate'),
              'playback.control': participant.capabilities.includes('playback.control'),
              'members.kick': participant.capabilities.includes('members.manage'),
              'chat.notice': false,
            };
      return {
        memberId: participant.memberId,
        memberDisplayNumber: participant.memberDisplayNumber,
        isAuthenticated: participant.isAuthenticated,
        displayName: participant.displayName,
        role: participant.role === 'owner' ? ('owner' as const) : ('controller' as const),
        permissions,
        inheritedPermissions:
          participant.role === 'owner'
            ? (['media.add', 'playback.control', 'members.kick', 'chat.notice'] as const)
            : ([] as const),
        onlineDeviceCount: value.presence.participants.filter(
          (candidate) => candidate.memberId === participant.memberId,
        ).length,
      };
    });
    if (!value.administrators.some((administrator) => administrator.role === 'owner')) {
      value.administrators.unshift({
        memberId: 'member_0000000001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 0,
      });
    }
  }

  return value;
}

function signaling(
  role: 'member' = 'member',
  epoch = 1,
  pendingPlaybackTransition: ProRoomSignalingAccess['pendingPlaybackTransition'] = null,
): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: 10_000,
    role,
    coordinatorEpoch: epoch,
    presenceIncarnationId: 'presence_0000000001',
    ticketSequence: 1,
    pendingPlaybackTransition,
  };
}

function fixtures() {
  const initial = snapshot();
  const api = {
    activate: vi.fn(async () => initial),
    recoverOwner: vi.fn(async () => initial),
    transferOwner: vi.fn(async () => initial),
    createSession: vi.fn<ProRoomSessionApi['createSession']>(async () => initial),
    enterPresence: vi.fn<ProRoomSessionApi['enterPresence']>(async () => initial),
    attachCurrentAccount: vi.fn(async () => initial),
    detachCurrentAccount: vi.fn<ProRoomSessionApi['detachCurrentAccount']>(async () => ({
      ok: true as const,
      detached: true as const,
      snapshot: initial,
    })),
    getSnapshot: vi.fn(async () => initial),
    heartbeat: vi.fn(async () => initial),
    leavePresence: vi.fn(async () => initial),
    createSignalingTicket: vi.fn(async () => signaling()),
    closeSession: vi.fn(async () => undefined),
    closeSessionFenced: vi.fn<ProRoomSessionApi['closeSessionFenced']>(async () => undefined),
  } satisfies ProRoomSessionApi;
  const transport = {
    connect: vi.fn(async () => undefined),
    reconfigure: vi.fn<ProRoomTransportBridge['reconfigure']>(async () => undefined),
    refreshCredentials: vi.fn(async () => true),
    disconnect: vi.fn(async () => undefined),
  } satisfies ProRoomTransportBridge;
  const observer = {
    snapshot: vi.fn(),
    authority: vi.fn(),
    cleared: vi.fn(),
  } satisfies ProRoomSessionObserver;
  return {
    api,
    transport,
    observer,
    controller: new ProRoomSessionController(api, transport, observer),
  };
}

beforeEach(() => vi.restoreAllMocks());

describe('PRO room session controller', () => {
  it('authenticates, verifies the member ticket/epoch, and connects once', async () => {
    const { api, transport, observer, controller } = fixtures();
    const result = await controller.join({
      code: ROOM_CODE,
      pin: '12345678',
    });

    expect(result).toEqual(snapshot());
    expect(api.createSignalingTicket).toHaveBeenCalledWith(ROOM_CODE, expect.any(AbortSignal));
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(observer.authority).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pro',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
      }),
    );
    expect(observer.authority.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
      observer.snapshot.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('resumes an HttpOnly-cookie session without asking for the PIN again', async () => {
    const { api, transport, controller } = fixtures();
    const resumed = snapshot({
      revision: 2,
      viewer: {
        ...snapshot().viewer!,
        presenceIncarnationId: 'presence_0000000002',
      },
    });
    api.enterPresence.mockResolvedValueOnce(resumed);
    api.createSignalingTicket.mockResolvedValueOnce({
      ...signaling(),
      presenceIncarnationId: 'presence_0000000002',
    });

    await expect(controller.resume(ROOM_CODE)).resolves.toEqual(resumed);

    expect(api.enterPresence).toHaveBeenCalledWith(ROOM_CODE, {
      signal: expect.any(AbortSignal),
    });
    expect(api.getSnapshot).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(transport.connect).toHaveBeenCalledOnce();
  });

  it('can retry a protected same-cookie resume as an explicit tab takeover', async () => {
    const { api, controller } = fixtures();
    api.enterPresence.mockRejectedValueOnce(new ProRoomApiError('PRESENCE_ACTIVE_ELSEWHERE', 409));

    await expect(controller.resume(ROOM_CODE)).rejects.toMatchObject({
      code: 'PRESENCE_ACTIVE_ELSEWHERE',
      status: 409,
    });

    await controller.resume(ROOM_CODE, { takeover: true });

    expect(api.enterPresence.mock.calls).toEqual([
      [ROOM_CODE, { signal: expect.any(AbortSignal) }],
      [ROOM_CODE, { signal: expect.any(AbortSignal), takeover: true }],
    ]);
  });

  it('accepts a linked account snapshot and rebuilds the display-name-bound control channel', async () => {
    const { api, transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.reconfigure.mockClear();
    const linked = snapshot({
      revision: 2,
      memberIdentityVersion: 1,
      viewer: {
        ...snapshot().viewer!,
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Minsu',
      },
      presence: {
        ...snapshot().presence,
        revision: 2,
        participants: [
          {
            ...snapshot().presence.participants[0]!,
            memberId: snapshot().viewer!.memberId,
            memberDisplayNumber: 0,
            isAuthenticated: true,
            displayName: 'Minsu',
          },
        ],
      },
    });
    api.attachCurrentAccount.mockResolvedValueOnce(linked);

    await expect(controller.attachCurrentAccount()).resolves.toEqual(linked);

    expect(api.attachCurrentAccount).toHaveBeenCalledWith(ROOM_CODE, undefined);
    expect(transport.reconfigure).toHaveBeenCalledOnce();
  });

  it('publishes an attached account commit before a recoverable channel rebuild failure', async () => {
    const { api, transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    const linked = snapshot({
      revision: 2,
      memberIdentityVersion: 1,
      viewer: {
        ...snapshot().viewer!,
        memberId: 'member_authenticated_2',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Minsu',
      },
      presence: {
        ...snapshot().presence,
        revision: 2,
        participants: [
          {
            ...snapshot().presence.participants[0]!,
            memberId: 'member_authenticated_2',
            memberDisplayNumber: 0,
            isAuthenticated: true,
            displayName: 'Minsu',
          },
        ],
      },
    });
    api.attachCurrentAccount.mockResolvedValueOnce(linked);
    transport.reconfigure.mockRejectedValueOnce(new Error('channel temporarily unavailable'));
    const committed = vi.fn();

    await expect(controller.attachCurrentAccount(undefined, committed)).rejects.toThrow(
      'channel temporarily unavailable',
    );

    expect(committed).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledWith(linked);
    expect(controller.snapshot).toEqual(linked);
  });

  it('rebuilds the control channel when account attachment changes only the member id', async () => {
    const { api, transport, controller } = fixtures();
    const initial = await controller.join({ code: ROOM_CODE, pin: '12345678' });
    const linked = snapshot({
      revision: 2,
      memberIdentityVersion: 1,
      viewer: {
        ...initial.viewer!,
        memberId: 'member_authenticated_2',
        memberDisplayNumber: 0,
        isAuthenticated: true,
      },
      presence: {
        ...initial.presence,
        revision: 2,
        participants: [
          {
            ...initial.presence.participants[0]!,
            memberId: 'member_authenticated_2',
            memberDisplayNumber: 0,
            isAuthenticated: true,
          },
        ],
      },
    });
    api.attachCurrentAccount.mockResolvedValueOnce(linked);

    await controller.attachCurrentAccount();

    expect(transport.reconfigure).toHaveBeenCalledOnce();
  });

  it('accepts a detached anonymous snapshot and rebuilds the display-name-bound control channel', async () => {
    const { api, transport, controller } = fixtures();
    const linked = snapshot({
      memberIdentityVersion: 1,
      viewer: {
        ...snapshot().viewer!,
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Minsu',
      },
      presence: {
        ...snapshot().presence,
        participants: [
          {
            ...snapshot().presence.participants[0]!,
            memberId: snapshot().viewer!.memberId,
            memberDisplayNumber: 0,
            isAuthenticated: true,
            displayName: 'Minsu',
          },
        ],
      },
    });
    api.createSession.mockResolvedValueOnce(linked);
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.reconfigure.mockClear();
    const detached = snapshot({
      revision: 2,
      memberIdentityVersion: 1,
      authorityVersion: 1,
      administrators: [
        {
          memberId: 'member_0000000001',
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
          onlineDeviceCount: 0,
        },
      ],
      viewer: {
        ...snapshot().viewer!,
        memberId: 'member_anonymous000000001',
        memberDisplayNumber: 2,
        isAuthenticated: false,
        displayName: 'Peer 2',
        role: 'member',
        capabilities: [],
      },
      presence: {
        ...snapshot().presence,
        revision: 2,
        participants: [
          {
            ...snapshot().presence.participants[0]!,
            memberId: 'member_anonymous000000001',
            memberDisplayNumber: 2,
            isAuthenticated: false,
            displayName: 'Peer 2',
            role: 'member',
            capabilities: [],
          },
        ],
      },
    });
    api.detachCurrentAccount.mockResolvedValueOnce({
      ok: true,
      detached: true,
      snapshot: detached,
    });

    await expect(controller.detachCurrentAccount()).resolves.toEqual({
      ok: true,
      detached: true,
      snapshot: detached,
    });

    expect(api.detachCurrentAccount).toHaveBeenCalledWith(ROOM_CODE, undefined);
    expect(transport.reconfigure).toHaveBeenCalledOnce();
  });

  it('re-enters without takeover when a committed detach has no surviving presence snapshot', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    api.detachCurrentAccount.mockResolvedValueOnce({
      ok: true,
      detached: true,
      snapshot: null,
    });

    await expect(controller.detachCurrentAccount()).resolves.toEqual({
      ok: true,
      detached: true,
      snapshot: null,
    });
    // Null is a committed server boundary, not permission to forge an
    // anonymous projection from the previously authenticated local snapshot.
    expect(controller.snapshot?.viewer?.isAuthenticated).not.toBe(false);

    const recovered = snapshot({
      revision: 2,
      viewer: {
        ...snapshot().viewer!,
        memberId: 'member_anonymous000000002',
        memberDisplayNumber: 2,
        isAuthenticated: false,
        participantId: 'participant_00002',
        presenceIncarnationId: 'presence_0000000002',
        displayName: 'Peer 1',
        role: 'member',
        capabilities: [],
      },
      presence: {
        ...snapshot().presence,
        revision: 2,
        participants: [
          {
            ...snapshot().presence.participants[0]!,
            participantId: 'participant_00002',
            memberId: 'member_anonymous000000002',
            memberDisplayNumber: 2,
            isAuthenticated: false,
            displayName: 'Peer 1',
            role: 'member',
            capabilities: [],
          },
        ],
      },
    });
    api.enterPresence.mockResolvedValueOnce(recovered);
    api.createSignalingTicket.mockResolvedValueOnce({
      ...signaling(),
      presenceIncarnationId: 'presence_0000000002',
      ticketSequence: 2,
    });

    await expect(controller.reenterAfterDetachedPresence()).resolves.toEqual(recovered);

    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(api.enterPresence).toHaveBeenCalledWith(
      ROOM_CODE,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(api.enterPresence.mock.calls[0]?.[1]).not.toHaveProperty('takeover');
    expect(observer.cleared).not.toHaveBeenCalled();
    expect(controller.snapshot?.viewer?.displayName).toBe('Peer 1');
  });

  it('fails locally instead of rotating the cookie incarnation while already active', async () => {
    const { api, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    api.enterPresence.mockClear();

    await expect(controller.resume(ROOM_CODE)).rejects.toThrow('PRO_ROOM_SESSION_ALREADY_ACTIVE');
    expect(api.enterPresence).not.toHaveBeenCalled();
    expect(controller.snapshot?.viewer?.presenceIncarnationId).toBe('presence_0000000001');
  });

  it('rejects a second open while authentication is still pending', async () => {
    const { api, controller } = fixtures();
    let finishAuthentication!: (value: ProRoomSnapshot) => void;
    api.createSession.mockImplementationOnce(
      () =>
        new Promise<ProRoomSnapshot>((resolve) => {
          finishAuthentication = resolve;
        }),
    );

    const joining = controller.join({
      code: ROOM_CODE,
      pin: '12345678',
    });
    await vi.waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());

    await expect(controller.resume(ROOM_CODE)).rejects.toThrow('PRO_ROOM_SESSION_ALREADY_ACTIVE');
    expect(api.enterPresence).not.toHaveBeenCalled();

    finishAuthentication(snapshot());
    await expect(joining).resolves.toEqual(snapshot());
  });

  it('adopts owner recovery through the same server-control-channel open lifecycle', async () => {
    const { api, transport, controller } = fixtures();
    const claimToken = `v1.${'r'.repeat(32)}.${'C'.repeat(43)}`;

    await expect(controller.recoverOwner({ code: ROOM_CODE, claimToken })).resolves.toEqual(
      snapshot(),
    );

    expect(api.recoverOwner).toHaveBeenCalledWith(
      { code: ROOM_CODE, claimToken },
      expect.any(AbortSignal),
    );
    expect(api.createSignalingTicket).toHaveBeenCalledOnce();
    expect(transport.connect).toHaveBeenCalledOnce();
  });

  it('adopts an owner transfer through the same server-control-channel open lifecycle', async () => {
    const { api, transport, controller } = fixtures();
    const claimToken = `v1.${'t'.repeat(32)}.${'D'.repeat(43)}`;

    await expect(
      controller.transferOwner({
        code: ROOM_CODE,
        claimToken,
        newPin: '87654321',
        requestId: '018f977e-5df5-7c8f-bb80-55d847ddec0f',
      }),
    ).resolves.toEqual(snapshot());

    expect(api.transferOwner).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        claimToken,
        newPin: '87654321',
        requestId: '018f977e-5df5-7c8f-bb80-55d847ddec0f',
      },
      expect.any(AbortSignal),
    );
    expect(api.createSignalingTicket).toHaveBeenCalledOnce();
    expect(transport.connect).toHaveBeenCalledOnce();
  });

  it('does not race a later PIN join with cleanup when cookie resume is unauthenticated', async () => {
    const { api, observer, controller } = fixtures();
    api.enterPresence.mockRejectedValue(new Error('SESSION_REQUIRED'));

    await expect(controller.resume(ROOM_CODE)).rejects.toThrow('SESSION_REQUIRED');

    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(observer.cleared).not.toHaveBeenCalled();
  });

  it('rejects a ticket from the wrong room incarnation before opening the channel', async () => {
    const { api, transport, controller } = fixtures();
    api.createSignalingTicket.mockResolvedValue(signaling('member', 2));

    await expect(controller.join({ code: ROOM_CODE, pin: '12345678' })).rejects.toThrow(
      'PRO_ROOM_SIGNALING_TICKET_MISMATCH',
    );
    expect(transport.connect).not.toHaveBeenCalled();
    expect(controller.snapshot).toBeNull();
  });

  it('rejects a legacy coordinator ticket even when its room-incarnation fence matches', async () => {
    const { api, transport, controller } = fixtures();
    const legacyAccess = { ...signaling(), role: 'coordinator' as const };
    api.createSignalingTicket.mockResolvedValue(legacyAccess as unknown as ProRoomSignalingAccess);

    await expect(controller.join({ code: ROOM_CODE, pin: '12345678' })).rejects.toThrow(
      'PRO_ROOM_SIGNALING_TICKET_MISMATCH',
    );
    expect(transport.connect).not.toHaveBeenCalled();
    expect(controller.snapshot).toBeNull();
  });

  it('preserves a pending server playback transition on the member access grant', async () => {
    const { api, transport, controller } = fixtures();
    const pendingPlaybackTransition: NonNullable<
      ProRoomSignalingAccess['pendingPlaybackTransition']
    > = {
      type: 'pro-playback-prepare',
      transitionId: 'transition_1234567890123456789012',
      serverTimeMs: 1_000,
      deadlineAtMs: 4_000,
      basePlaybackRevision: 0,
      target: {
        coordinatorEpoch: 1,
        revision: 1,
        state: 'playing',
        queueItemId: '12345678-1234-4123-8123-123456789abc',
        positionSeconds: 0,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
        updatedAtMs: 1_000,
      },
    };
    const access = signaling('member', 1, pendingPlaybackTransition);
    api.createSignalingTicket.mockResolvedValue(access);

    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    expect(transport.connect).toHaveBeenCalledWith(snapshot(), access, expect.any(AbortSignal));
  });

  it('reconfigures only when a heartbeat changes the room-incarnation fence', async () => {
    const { api, transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    const changed = snapshot({
      revision: 2,
      presence: {
        ...snapshot().presence,
        revision: 2,
        coordinatorEpoch: 2,
        coordinatorParticipantId: null,
        participants: [
          ...snapshot().presence.participants,
          {
            participantId: 'participant_00002',
            memberId: 'member_0000000002',
            memberDisplayNumber: 1,
            isAuthenticated: true,
            displayName: 'Friend',
            devicePlatform: 'other',
            role: 'controller',
            capabilities: ['playback.control'],
            joinedAtMs: 2,
          },
        ],
      },
      playback: { ...snapshot().playback, coordinatorEpoch: 2, revision: 0 },
    });
    api.heartbeat.mockResolvedValue(changed);
    api.createSignalingTicket.mockResolvedValue(signaling('member', 2));

    await controller.heartbeat();
    expect(api.heartbeat).toHaveBeenCalledWith(ROOM_CODE, undefined, snapshot());
    expect(transport.reconfigure).toHaveBeenCalledWith(changed, signaling('member', 2), undefined);
  });

  it('re-authenticates the current socket when heartbeat projects a changed account identity', async () => {
    const { api, transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.reconfigure.mockClear();
    api.createSignalingTicket.mockClear();

    const projected = snapshot({
      revision: 2,
      presence: {
        ...snapshot().presence,
        revision: 2,
        participants: snapshot().presence.participants.map((participant) => ({
          ...participant,
          displayName: 'Account Owner',
        })),
      },
      viewer: {
        ...snapshot().viewer!,
        displayName: 'Account Owner',
      },
    });
    const replacementAccess = { ...signaling(), ticketSequence: 2 };
    api.heartbeat.mockResolvedValue(projected);
    api.createSignalingTicket.mockResolvedValue(replacementAccess);

    await expect(controller.heartbeat()).resolves.toEqual(projected);

    expect(api.heartbeat).toHaveBeenCalledWith(ROOM_CODE, undefined, snapshot());
    expect(api.createSignalingTicket).toHaveBeenCalledOnce();
    expect(transport.reconfigure).toHaveBeenCalledWith(projected, replacementAccess, undefined);
    expect(transport.disconnect).not.toHaveBeenCalled();

    await controller.heartbeat();
    expect(api.createSignalingTicket).toHaveBeenCalledOnce();
    expect(transport.reconfigure).toHaveBeenCalledOnce();
  });

  it('retries an account-identity socket replacement after a transient failure', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.reconfigure.mockClear();
    api.createSignalingTicket.mockClear();
    observer.cleared.mockClear();

    const projected = snapshot({
      revision: 2,
      presence: {
        ...snapshot().presence,
        revision: 2,
        participants: snapshot().presence.participants.map((participant) => ({
          ...participant,
          displayName: 'Account Owner',
        })),
      },
      viewer: {
        ...snapshot().viewer!,
        displayName: 'Account Owner',
      },
    });
    api.heartbeat.mockResolvedValue(projected);
    api.createSignalingTicket
      .mockResolvedValueOnce({ ...signaling(), ticketSequence: 2 })
      .mockResolvedValueOnce({ ...signaling(), ticketSequence: 3 });
    transport.reconfigure
      .mockRejectedValueOnce(new Error('SOCKET_OPEN_FAILED'))
      .mockResolvedValueOnce(undefined);

    await expect(controller.heartbeat()).rejects.toThrow('SOCKET_OPEN_FAILED');
    expect(controller.snapshot).toEqual(projected);
    expect(observer.cleared).not.toHaveBeenCalled();

    await expect(controller.heartbeat()).resolves.toEqual(projected);
    expect(api.createSignalingTicket).toHaveBeenCalledTimes(2);
    expect(transport.reconfigure).toHaveBeenCalledTimes(2);
  });

  it('does not republish authority or snapshot state for an unchanged heartbeat', async () => {
    const { transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    const installed = controller.snapshot;
    transport.reconfigure.mockClear();
    observer.authority.mockClear();
    observer.snapshot.mockClear();

    await expect(controller.heartbeat()).resolves.toBe(installed);

    expect(observer.authority).not.toHaveBeenCalled();
    expect(observer.snapshot).not.toHaveBeenCalled();
    expect(transport.reconfigure).not.toHaveBeenCalled();
  });

  it('rebuilds a lost server channel on the same room incarnation without clearing the session', async () => {
    const { transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.reconfigure.mockClear();
    observer.cleared.mockClear();
    observer.authority.mockClear();
    observer.snapshot.mockClear();

    controller.invalidateControlChannel();
    await controller.heartbeat();

    expect(transport.reconfigure).toHaveBeenCalledOnce();
    expect(transport.reconfigure).toHaveBeenCalledWith(snapshot(), signaling(), undefined);
    expect(observer.cleared).not.toHaveBeenCalled();
    expect(observer.authority).not.toHaveBeenCalled();
    expect(observer.snapshot).not.toHaveBeenCalled();
    expect(controller.snapshot).toEqual(snapshot());

    await controller.heartbeat();
    expect(transport.reconfigure).toHaveBeenCalledOnce();
  });

  it('keeps the authenticated room and retries a transient server-channel reconfigure', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    const changed = snapshot({
      revision: 2,
      presence: {
        ...snapshot().presence,
        revision: 2,
        coordinatorEpoch: 2,
        coordinatorParticipantId: null,
        participants: [
          ...snapshot().presence.participants,
          {
            participantId: 'participant_00002',
            memberId: 'member_0000000002',
            memberDisplayNumber: 1,
            isAuthenticated: true,
            displayName: 'Friend',
            devicePlatform: 'other',
            role: 'controller',
            capabilities: ['playback.control'],
            joinedAtMs: 2,
          },
        ],
      },
      playback: { ...snapshot().playback, coordinatorEpoch: 2, revision: 0 },
    });
    api.heartbeat.mockResolvedValue(changed);
    api.createSignalingTicket.mockResolvedValue(signaling('member', 2));
    transport.reconfigure
      .mockRejectedValueOnce(new Error('HOST_NOT_AVAILABLE'))
      .mockResolvedValueOnce(undefined);

    await expect(controller.heartbeat()).rejects.toThrow('HOST_NOT_AVAILABLE');

    expect(controller.snapshot).toEqual(changed);
    expect(controller.context).toMatchObject({ role: 'member', epoch: 2 });
    expect(transport.disconnect).not.toHaveBeenCalled();
    expect(observer.cleared).not.toHaveBeenCalled();

    await expect(controller.heartbeat()).resolves.toEqual(changed);

    expect(api.createSignalingTicket).toHaveBeenCalledTimes(3);
    expect(transport.reconfigure).toHaveBeenCalledTimes(2);
    expect(transport.reconfigure).toHaveBeenLastCalledWith(
      changed,
      signaling('member', 2),
      undefined,
    );
  });

  it('rejects a replacement tab incarnation before publishing or adopting its snapshot', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    const replacement = snapshot({
      revision: 2,
      viewer: {
        ...snapshot().viewer!,
        presenceIncarnationId: 'presence_0000000002',
      },
    });
    api.heartbeat.mockResolvedValueOnce(replacement);

    const error = await controller.heartbeat().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProRoomApiError);
    expect(error).toMatchObject({ code: 'PRESENCE_SUPERSEDED', status: 409 });
    expect(controller.snapshot?.viewer?.presenceIncarnationId).toBe('presence_0000000001');
    expect(observer.snapshot).toHaveBeenCalledTimes(1);
    expect(transport.reconfigure).not.toHaveBeenCalled();
  });

  it('rotates a control-channel ticket in place while the room incarnation is unchanged', async () => {
    const { transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.refreshCredentials.mockClear();

    await controller.refreshSignaling();

    expect(transport.refreshCredentials).toHaveBeenCalledWith(snapshot(), signaling(), undefined);
    expect(transport.reconfigure).not.toHaveBeenCalled();
  });

  it('rebuilds the control channel when an in-place credential refresh is unavailable', async () => {
    const { transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.refreshCredentials.mockResolvedValue(false);

    await controller.refreshSignaling();

    expect(transport.reconfigure).toHaveBeenCalledWith(snapshot(), signaling(), undefined);
  });

  it('does not accept a control-channel rebuild that finishes after leave', async () => {
    const { transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.refreshCredentials.mockResolvedValue(false);
    let finishReconfigure!: () => void;
    transport.reconfigure.mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          finishReconfigure = resolve;
        }),
    );

    const refreshing = controller.refreshSignaling();
    await vi.waitFor(() => expect(transport.reconfigure).toHaveBeenCalledOnce());
    await controller.leave();
    finishReconfigure();

    await expect(refreshing).rejects.toThrow('PRO_ROOM_SESSION_SUPERSEDED');
    expect(controller.snapshot).toBeNull();
  });

  it('always clears local authority even when revoking the server session fails', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    api.closeSessionFenced.mockRejectedValue(new Error('offline'));

    await expect(controller.leave()).resolves.toBeUndefined();
    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSessionFenced).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        expectedParticipantId: PARTICIPANT_ID,
        expectedPresenceIncarnationId: snapshot().viewer!.presenceIncarnationId,
      },
      undefined,
    );
    expect(transport.disconnect).toHaveBeenCalled();
    expect(observer.cleared).toHaveBeenCalled();
    expect(controller.snapshot).toBeNull();
  });

  it('invalidates locally before a slow old-room leave and never disconnects a replacement room', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.disconnect.mockClear();
    observer.cleared.mockClear();

    let finishOldClose!: () => void;
    api.closeSessionFenced.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          finishOldClose = resolve;
        }),
    );

    const leaving = controller.leave();

    // These assertions intentionally run before awaiting even one microtask.
    expect(controller.snapshot).toBeNull();
    expect(controller.context).toBeNull();
    expect(observer.cleared).toHaveBeenCalledOnce();
    expect(transport.disconnect).toHaveBeenCalledOnce();

    const replacement = snapshot({ roomCode: '000000', revision: 1 });
    api.createSession.mockResolvedValueOnce(replacement);
    await expect(controller.join({ code: '000000', pin: '00000000' })).resolves.toEqual(
      replacement,
    );

    finishOldClose();
    await expect(leaving).resolves.toBeUndefined();

    expect(controller.snapshot?.roomCode).toBe('000000');
    expect(observer.cleared).toHaveBeenCalledOnce();
    // The old completion only awaits the disconnect that was invoked before
    // the replacement connect. It must never invoke the shared bridge again.
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(api.closeSessionFenced).toHaveBeenCalledWith(
      expect.objectContaining({ code: ROOM_CODE }),
      undefined,
    );
  });

  it('does not revoke a newly-created same-room session when old atomic cleanup finishes late', async () => {
    const { api, transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.disconnect.mockClear();

    let finishCapturedClose!: () => void;
    const capturedClose = new Promise<void>((resolve) => {
      finishCapturedClose = resolve;
    });
    const leaving = controller.leave(undefined, capturedClose);

    expect(controller.snapshot).toBeNull();
    await expect(controller.join({ code: ROOM_CODE, pin: '12345678' })).resolves.toEqual(
      snapshot(),
    );

    finishCapturedClose();
    await expect(leaving).resolves.toBeUndefined();

    expect(controller.snapshot?.roomCode).toBe(ROOM_CODE);
    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(api.closeSessionFenced).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        expectedParticipantId: PARTICIPANT_ID,
        expectedPresenceIncarnationId: snapshot().viewer!.presenceIncarnationId,
      },
      undefined,
    );
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  it('revokes the server session after an atomic explicit leave when no replacement exists', async () => {
    const { api, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    await controller.leave(undefined, Promise.resolve());

    // The captured atomic request already released presence; explicit leave
    // still differs from pagehide by revoking the resumable server session.
    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSessionFenced).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        expectedParticipantId: PARTICIPANT_ID,
        expectedPresenceIncarnationId: snapshot().viewer!.presenceIncarnationId,
      },
      undefined,
    );
    expect(controller.snapshot).toBeNull();
  });

  it('skips stale-cookie fallback after failed cleanup when the same room has re-opened', async () => {
    const { api, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    let failCapturedClose!: (reason: unknown) => void;
    const capturedClose = new Promise<void>((_resolve, reject) => {
      failCapturedClose = reject;
    });
    const leaving = controller.leave(undefined, capturedClose);
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    failCapturedClose(new Error('offline'));
    await expect(leaving).resolves.toBeUndefined();

    expect(controller.snapshot?.roomCode).toBe(ROOM_CODE);
    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(api.closeSessionFenced).toHaveBeenCalledWith(
      expect.objectContaining({ code: ROOM_CODE }),
      undefined,
    );
  });

  it('finishes failed captured cleanup against the old cookie path after another room opens', async () => {
    const { api, transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });
    transport.disconnect.mockClear();

    let failCapturedClose!: (reason: unknown) => void;
    const capturedClose = new Promise<void>((_resolve, reject) => {
      failCapturedClose = reject;
    });
    const leaving = controller.leave(undefined, capturedClose);
    const replacement = snapshot({ roomCode: '000000', revision: 1 });
    api.createSession.mockResolvedValueOnce(replacement);
    await controller.join({ code: '000000', pin: '00000000' });

    failCapturedClose(new Error('offline'));
    await expect(leaving).resolves.toBeUndefined();

    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(api.closeSessionFenced).toHaveBeenCalledWith(
      expect.objectContaining({ code: ROOM_CODE }),
      undefined,
    );
    expect(controller.snapshot?.roomCode).toBe('000000');
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  it('terminates a server-rejected session locally without retrying authenticated APIs', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    await controller.terminate();

    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(observer.cleared).toHaveBeenCalledOnce();
    expect(controller.snapshot).toBeNull();
  });

  it('closes locally after pagehide without leaving twice or revoking the resumable session', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    await controller.closeForUnload();

    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(observer.cleared).toHaveBeenCalledOnce();
    expect(controller.snapshot).toBeNull();
  });

  it('cancels an in-flight authentication without risking another tab cookie on leave', async () => {
    const { api, transport, controller } = fixtures();
    let authenticationAborted = false;
    api.createSession.mockImplementation(
      async (_input, signal) =>
        new Promise<ProRoomSnapshot>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              authenticationAborted = true;
              reject(new Error('ABORTED'));
            },
            { once: true },
          );
        }),
    );

    const joining = controller.join({
      code: ROOM_CODE,
      pin: '12345678',
    });
    await vi.waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());

    await controller.leave();

    await expect(joining).rejects.toThrow('ABORTED');
    expect(authenticationAborted).toBe(true);
    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(api.closeSessionFenced).not.toHaveBeenCalled();
    expect(transport.connect).not.toHaveBeenCalled();
    expect(controller.snapshot).toBeNull();
  });

  it('does not resurrect a room when a heartbeat resolves after leave', async () => {
    const { api, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    let resolveHeartbeat!: (value: ProRoomSnapshot) => void;
    api.heartbeat.mockImplementation(
      async () =>
        new Promise<ProRoomSnapshot>((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );
    const heartbeat = controller.heartbeat();
    await vi.waitFor(() => expect(api.heartbeat).toHaveBeenCalledOnce());

    await controller.leave();
    resolveHeartbeat(snapshot({ revision: 2 }));

    await expect(heartbeat).rejects.toThrow('PRO_ROOM_SESSION_SUPERSEDED');
    expect(controller.snapshot).toBeNull();
    expect(observer.snapshot).toHaveBeenCalledTimes(1);
  });

  it('turns an old rejected heartbeat into superseded after another room opens', async () => {
    const { api, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678' });

    let rejectHeartbeat!: (reason: unknown) => void;
    api.heartbeat.mockImplementationOnce(
      async () =>
        new Promise<ProRoomSnapshot>((_resolve, reject) => {
          rejectHeartbeat = reject;
        }),
    );
    const heartbeat = controller.heartbeat();
    await vi.waitFor(() => expect(api.heartbeat).toHaveBeenCalledOnce());

    await controller.leave(undefined, Promise.resolve());
    const replacement = snapshot({ roomCode: '000000', revision: 1 });
    api.createSession.mockResolvedValueOnce(replacement);
    await controller.join({ code: '000000', pin: '00000000' });
    rejectHeartbeat(new Error('SESSION_REQUIRED'));

    await expect(heartbeat).rejects.toThrow('PRO_ROOM_SESSION_SUPERSEDED');
    expect(controller.snapshot?.roomCode).toBe('000000');
    expect(observer.snapshot).toHaveBeenCalledTimes(2);
  });
});
