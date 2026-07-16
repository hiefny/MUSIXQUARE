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
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 0,
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
      coordinatorParticipantId: PARTICIPANT_ID,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          displayName: 'Owner',
          role: 'owner',
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
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'coordinator.eligible',
        'members.manage',
        'room.configure',
      ],
      coordinatorEligible: true,
    },
    ...overrides,
  };
}

function signaling(role: 'coordinator' | 'member', epoch = 1): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: 10_000,
    role,
    coordinatorEpoch: epoch,
    presenceIncarnationId: 'presence_0000000001',
    ticketSequence: 1,
  };
}

function fixtures() {
  const initial = snapshot();
  const api = {
    activate: vi.fn(async () => initial),
    recoverOwner: vi.fn(async () => initial),
    createSession: vi.fn(async () => initial),
    enterPresence: vi.fn(async () => initial),
    getSnapshot: vi.fn(async () => initial),
    heartbeat: vi.fn(async () => initial),
    leavePresence: vi.fn(async () => initial),
    createSignalingTicket: vi.fn(async () => signaling('coordinator')),
    closeSession: vi.fn(async () => undefined),
    closeSessionFenced: vi.fn(async () => undefined),
  } satisfies ProRoomSessionApi;
  const transport = {
    connect: vi.fn(async () => undefined),
    reconfigure: vi.fn(async () => undefined),
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
  it('authenticates, verifies the signaling role/epoch, and connects once', async () => {
    const { api, transport, observer, controller } = fixtures();
    const result = await controller.join({
      code: ROOM_CODE,
      pin: '12345678',
      displayName: 'Owner',
    });

    expect(result).toEqual(snapshot());
    expect(api.createSignalingTicket).toHaveBeenCalledWith(ROOM_CODE, expect.any(AbortSignal));
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(observer.authority).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pro', role: 'coordinator', epoch: 1 }),
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
      ...signaling('coordinator'),
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

  it('fails locally instead of rotating the cookie incarnation while already active', async () => {
    const { api, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
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
      displayName: 'Owner',
    });
    await vi.waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());

    await expect(controller.resume(ROOM_CODE)).rejects.toThrow('PRO_ROOM_SESSION_ALREADY_ACTIVE');
    expect(api.enterPresence).not.toHaveBeenCalled();

    finishAuthentication(snapshot());
    await expect(joining).resolves.toEqual(snapshot());
  });

  it('adopts owner recovery through the same signaling and transport open lifecycle', async () => {
    const { api, transport, controller } = fixtures();
    const claimToken = `v1.${'r'.repeat(32)}.${'C'.repeat(43)}`;

    await expect(
      controller.recoverOwner({ code: ROOM_CODE, claimToken, displayName: 'Recovered Owner' }),
    ).resolves.toEqual(snapshot());

    expect(api.recoverOwner).toHaveBeenCalledWith(
      { code: ROOM_CODE, claimToken, displayName: 'Recovered Owner' },
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

  it('rejects a ticket from the wrong authority epoch before opening transport', async () => {
    const { api, transport, controller } = fixtures();
    api.createSignalingTicket.mockResolvedValue(signaling('coordinator', 2));

    await expect(
      controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' }),
    ).rejects.toThrow('PRO_ROOM_SIGNALING_TICKET_MISMATCH');
    expect(transport.connect).not.toHaveBeenCalled();
    expect(controller.snapshot).toBeNull();
  });

  it('reconfigures only when a heartbeat changes coordinator authority', async () => {
    const { api, transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

    const changed = snapshot({
      revision: 2,
      presence: {
        ...snapshot().presence,
        revision: 2,
        coordinatorEpoch: 2,
        coordinatorParticipantId: 'participant_00002',
        participants: [
          ...snapshot().presence.participants,
          {
            participantId: 'participant_00002',
            displayName: 'Friend',
            role: 'controller',
            joinedAtMs: 2,
          },
        ],
      },
      playback: { ...snapshot().playback, coordinatorEpoch: 2, revision: 0 },
    });
    api.heartbeat.mockResolvedValue(changed);
    api.createSignalingTicket.mockResolvedValue(signaling('member', 2));

    await controller.heartbeat();
    expect(transport.reconfigure).toHaveBeenCalledWith(changed, signaling('member', 2), undefined);
  });

  it('rebuilds a lost transport on the same authority without clearing the PRO session', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
    transport.reconfigure.mockClear();
    observer.cleared.mockClear();

    controller.invalidateTransportAuthority();
    await controller.heartbeat();

    expect(transport.reconfigure).toHaveBeenCalledOnce();
    expect(transport.reconfigure).toHaveBeenCalledWith(
      snapshot(),
      signaling('coordinator'),
      undefined,
    );
    expect(observer.cleared).not.toHaveBeenCalled();
    expect(controller.snapshot).toEqual(snapshot());

    await controller.heartbeat();
    expect(transport.reconfigure).toHaveBeenCalledOnce();
  });

  it('keeps the authenticated room and retries a transient authority reconfigure with a fresh ticket', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

    const changed = snapshot({
      revision: 2,
      presence: {
        ...snapshot().presence,
        revision: 2,
        coordinatorEpoch: 2,
        coordinatorParticipantId: 'participant_00002',
        participants: [
          ...snapshot().presence.participants,
          {
            participantId: 'participant_00002',
            displayName: 'Friend',
            role: 'controller',
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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
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

  it('rotates a signaling ticket in place while authority is unchanged', async () => {
    const { api, transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
    transport.refreshCredentials.mockClear();

    await controller.refreshSignaling();

    expect(transport.refreshCredentials).toHaveBeenCalledWith(
      snapshot(),
      signaling('coordinator'),
      undefined,
    );
    expect(transport.reconfigure).not.toHaveBeenCalled();
  });

  it('rebuilds transport when an in-place credential refresh is unavailable', async () => {
    const { transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
    transport.refreshCredentials.mockResolvedValue(false);

    await controller.refreshSignaling();

    expect(transport.reconfigure).toHaveBeenCalledWith(
      snapshot(),
      signaling('coordinator'),
      undefined,
    );
  });

  it('does not accept a signaling rebuild that finishes after leave', async () => {
    const { transport, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
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
    await expect(
      controller.join({ code: '000000', pin: '00000000', displayName: 'Friend' }),
    ).resolves.toEqual(replacement);

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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
    transport.disconnect.mockClear();

    let finishCapturedClose!: () => void;
    const capturedClose = new Promise<void>((resolve) => {
      finishCapturedClose = resolve;
    });
    const leaving = controller.leave(undefined, capturedClose);

    expect(controller.snapshot).toBeNull();
    await expect(
      controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Rejoined' }),
    ).resolves.toEqual(snapshot());

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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

    let failCapturedClose!: (reason: unknown) => void;
    const capturedClose = new Promise<void>((_resolve, reject) => {
      failCapturedClose = reject;
    });
    const leaving = controller.leave(undefined, capturedClose);
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Rejoined' });

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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
    transport.disconnect.mockClear();

    let failCapturedClose!: (reason: unknown) => void;
    const capturedClose = new Promise<void>((_resolve, reject) => {
      failCapturedClose = reject;
    });
    const leaving = controller.leave(undefined, capturedClose);
    const replacement = snapshot({ roomCode: '000000', revision: 1 });
    api.createSession.mockResolvedValueOnce(replacement);
    await controller.join({ code: '000000', pin: '00000000', displayName: 'Friend' });

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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

    await controller.terminate();

    expect(api.leavePresence).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(observer.cleared).toHaveBeenCalledOnce();
    expect(controller.snapshot).toBeNull();
  });

  it('closes locally after pagehide without leaving twice or revoking the resumable session', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

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
      displayName: 'Owner',
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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

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
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });

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
    await controller.join({ code: '000000', pin: '00000000', displayName: 'Friend' });
    rejectHeartbeat(new Error('SESSION_REQUIRED'));

    await expect(heartbeat).rejects.toThrow('PRO_ROOM_SESSION_SUPERSEDED');
    expect(controller.snapshot?.roomCode).toBe('000000');
    expect(observer.snapshot).toHaveBeenCalledTimes(2);
  });
});
