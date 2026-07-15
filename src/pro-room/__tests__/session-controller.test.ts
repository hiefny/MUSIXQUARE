import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
} from '../contracts.ts';
import {
  ProRoomSessionController,
  type ProRoomSessionApi,
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
  };
}

function fixtures() {
  const initial = snapshot();
  const api = {
    activate: vi.fn(async () => initial),
    createSession: vi.fn(async () => initial),
    getSnapshot: vi.fn(async () => initial),
    heartbeat: vi.fn(async () => initial),
    leavePresence: vi.fn(async () => initial),
    createSignalingTicket: vi.fn(async () => signaling('coordinator')),
    closeSession: vi.fn(async () => undefined),
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
    expect(api.createSignalingTicket).toHaveBeenCalledWith(ROOM_CODE, undefined);
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(observer.authority).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pro', role: 'coordinator', epoch: 1 }),
    );
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

  it('always clears local authority even when closing the cookie session fails', async () => {
    const { api, transport, observer, controller } = fixtures();
    await controller.join({ code: ROOM_CODE, pin: '12345678', displayName: 'Owner' });
    api.closeSession.mockRejectedValue(new Error('offline'));

    await expect(controller.leave()).resolves.toBeUndefined();
    expect(api.leavePresence).toHaveBeenCalled();
    expect(transport.disconnect).toHaveBeenCalled();
    expect(observer.cleared).toHaveBeenCalled();
    expect(controller.snapshot).toBeNull();
  });
});
