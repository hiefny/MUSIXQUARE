import { describe, expect, it, vi } from 'vitest';
import { PRO_ROOM_MAX_ASSET_BYTES, PRO_ROOM_QUOTA_BYTES } from '../contracts.ts';
import type {
  ProRoomSnapshot,
  ProRoomSystemAudioPublication,
  ProRoomSystemAudioState,
} from '../contracts.ts';
import {
  ProRoomSystemAudioController,
  type ProRoomSystemAudioApiForTests,
  type ProRoomSystemAudioControllerObserverForTests,
  type ProRoomSystemAudioViewState,
} from '../system-audio-controller.ts';

const LOCAL_ID = 'participant_local1';
const COORDINATOR_ID = 'participant_coord1';
const REMOTE_ID = 'participant_remote1';
const LEASE_ID = 'L'.repeat(43);

function sessionSnapshot(coordinatorParticipantId = COORDINATOR_ID): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
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
      updatedAtMs: 0,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
      coordinatorParticipantId,
      participants: [
        {
          participantId: COORDINATOR_ID,
          memberId: 'member_coord_0001',
          memberDisplayNumber: 1,
          isAuthenticated: true,
          displayName: 'Coordinator',
          devicePlatform: 'other',
          role: 'controller',
          capabilities: [
            'queue.mutate',
            'playback.control',
            'effects.control',
            'asset.upload',
            'coordinator.eligible',
            'members.manage',
          ],
          joinedAtMs: 1,
        },
        {
          participantId: LOCAL_ID,
          memberId: 'member_local_0001',
          memberDisplayNumber: 2,
          isAuthenticated: true,
          displayName: 'Local member',
          devicePlatform: 'other',
          role: 'controller',
          capabilities: [
            'queue.mutate',
            'playback.control',
            'effects.control',
            'asset.upload',
            'coordinator.eligible',
            'members.manage',
          ],
          joinedAtMs: 2,
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
      memberId: 'member_local_0001',
      memberDisplayNumber: 2,
      isAuthenticated: true,
      participantId: LOCAL_ID,
      presenceIncarnationId: 'presence_local_01',
      displayName: 'Local member',
      role: 'controller',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'coordinator.eligible',
        'members.manage',
      ],
      coordinatorEligible: true,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_owner_0001',
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
      },
    ],
  };
}

function idle(generation = 0): ProRoomSystemAudioState {
  return {
    generation,
    status: 'idle',
    ownerParticipantId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

function preparing(ownerParticipantId = LOCAL_ID, generation = 1): ProRoomSystemAudioState {
  return {
    generation,
    status: 'preparing',
    ownerParticipantId,
    claimExpiresAt: 1_900_000_045_000,
    liveExpiresAt: null,
    publication: null,
  };
}

function publication(): ProRoomSystemAudioPublication {
  return {
    publicationId: 'publication_00001',
    sessionId: 'realtime_session_01',
    tracks: [
      { trackName: 'audio-L', channel: 'L', mid: '0' },
      { trackName: 'audio-R', channel: 'R', mid: '1' },
    ],
  };
}

function live(ownerParticipantId = LOCAL_ID, generation = 1): ProRoomSystemAudioState {
  return {
    generation,
    status: 'live',
    ownerParticipantId,
    claimExpiresAt: null,
    liveExpiresAt: 1_900_007_200_000,
    publication: publication(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const views: ProRoomSystemAudioViewState[] = [];
  const lost: string[] = [];
  const observer: ProRoomSystemAudioControllerObserverForTests = {
    state: (state) => views.push(state),
    localLeaseLost: (reason) => lost.push(reason),
  };
  const api = {
    getSystemAudioState: vi.fn<ProRoomSystemAudioApiForTests['getSystemAudioState']>(),
    acquireSystemAudioLease: vi.fn<ProRoomSystemAudioApiForTests['acquireSystemAudioLease']>(),
    commitSystemAudioPublication:
      vi.fn<ProRoomSystemAudioApiForTests['commitSystemAudioPublication']>(),
    heartbeatSystemAudioLease: vi.fn<ProRoomSystemAudioApiForTests['heartbeatSystemAudioLease']>(),
    releaseSystemAudioLease: vi.fn<ProRoomSystemAudioApiForTests['releaseSystemAudioLease']>(),
  } satisfies ProRoomSystemAudioApiForTests;
  const controller = new ProRoomSystemAudioController(api, observer);
  controller.bindSession(sessionSnapshot());
  controller.acceptProSystemAudioState(idle());
  return { api, controller, views, lost };
}

describe('ProRoomSystemAudioController', () => {
  it('lets a non-coordinator request ownership and exposes pending UI before the request settles', async () => {
    const { api, controller, views } = harness();
    const pending = deferred<{ systemAudio: ProRoomSystemAudioState; leaseId: string }>();
    api.acquireSystemAudioLease.mockReturnValue(pending.promise);

    const first = controller.acquireProSystemAudioLease();
    const duplicate = controller.acquireProSystemAudioLease();
    expect(api.acquireSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(views.at(-1)).toMatchObject({
      phase: 'preparing',
      localRequestPending: true,
      isLocalOwner: false,
      canStart: false,
    });

    pending.resolve({ systemAudio: preparing(), leaseId: LEASE_ID });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([preparing(), preparing()]);
    expect(controller.getCurrentLease()).toEqual({
      roomCode: '000001',
      generation: 1,
      status: 'preparing',
      hasCredential: true,
    });
    expect(controller.getViewState()).toMatchObject({
      phase: 'preparing',
      localRequestPending: false,
      isLocalOwner: true,
      canStop: true,
    });
  });

  it('keeps the private credential internal across commit, heartbeat, and release', async () => {
    const { api, controller, views } = harness();
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.commitSystemAudioPublication.mockResolvedValue(live());
    api.heartbeatSystemAudioLease.mockResolvedValue(live());
    api.releaseSystemAudioLease.mockResolvedValue(idle(2));

    await controller.acquireProSystemAudioLease();
    await expect(controller.commitProSystemAudioPublication(publication())).resolves.toEqual(
      live(),
    );
    await expect(controller.heartbeatProSystemAudioLease()).resolves.toEqual(live());
    await expect(controller.releaseProSystemAudioLease()).resolves.toEqual(idle(2));

    expect(api.commitSystemAudioPublication).toHaveBeenCalledWith(
      { code: '000001', generation: 1, leaseId: LEASE_ID, publication: publication() },
      undefined,
    );
    expect(api.heartbeatSystemAudioLease).toHaveBeenCalledWith(
      { code: '000001', generation: 1, leaseId: LEASE_ID },
      undefined,
    );
    expect(api.releaseSystemAudioLease).toHaveBeenCalledWith(
      { code: '000001', generation: 1, leaseId: LEASE_ID },
      undefined,
    );
    expect(JSON.stringify(views)).not.toContain(LEASE_ID);
    expect(controller.getCurrentLease()).toBeNull();
  });

  it('reconciles an already-committed release when only the response was lost', async () => {
    const { api, controller } = harness();
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.releaseSystemAudioLease.mockRejectedValue(new Error('release response lost'));
    api.getSystemAudioState.mockResolvedValue(idle(2));

    await controller.acquireProSystemAudioLease();
    await expect(controller.releaseProSystemAudioLease()).resolves.toEqual(idle(2));

    expect(api.getSystemAudioState).toHaveBeenCalledWith('000001', undefined);
    expect(controller.getCurrentLease()).toBeNull();
    expect(controller.getCurrentState()).toEqual(idle(2));
  });

  it('preserves the original release failure while the same lease remains authoritative', async () => {
    const { api, controller } = harness();
    const releaseError = new Error('release rejected');
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.releaseSystemAudioLease.mockRejectedValue(releaseError);
    api.getSystemAudioState.mockResolvedValue(preparing());

    await controller.acquireProSystemAudioLease();
    await expect(controller.releaseProSystemAudioLease()).rejects.toBe(releaseError);

    expect(controller.getCurrentLease()).toMatchObject({ generation: 1, hasCredential: true });
  });

  it('reconciles a rejected heartbeat to the server revocation caused by a fifth device', async () => {
    const { api, controller, lost } = harness();
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.commitSystemAudioPublication.mockResolvedValue(live());
    api.heartbeatSystemAudioLease.mockRejectedValue(new Error('generation mismatch'));
    api.getSystemAudioState.mockResolvedValue(idle(2));

    await controller.acquireProSystemAudioLease();
    await controller.commitProSystemAudioPublication(publication());

    await expect(controller.heartbeatProSystemAudioLease()).resolves.toEqual(idle(2));
    expect(api.getSystemAudioState).toHaveBeenCalledWith('000001', undefined);
    expect(lost).toEqual(['authoritative-revocation']);
    expect(controller.getCurrentLease()).toBeNull();
  });

  it('accepts authenticated owner replacement after a rejected heartbeat', async () => {
    const { api, controller, lost } = harness();
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.commitSystemAudioPublication.mockResolvedValue(live());
    api.heartbeatSystemAudioLease.mockRejectedValue(new Error('not owner'));
    api.getSystemAudioState.mockResolvedValue(live(REMOTE_ID));

    await controller.acquireProSystemAudioLease();
    await controller.commitProSystemAudioPublication(publication());

    await expect(controller.heartbeatProSystemAudioLease()).resolves.toEqual(live(REMOTE_ID));
    expect(lost).toEqual(['authoritative-revocation']);
    expect(controller.getCurrentLease()).toBeNull();
  });

  it('preserves a heartbeat failure for retry while the authenticated state is unchanged', async () => {
    const { api, controller, lost } = harness();
    const heartbeatError = new Error('heartbeat response lost');
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.commitSystemAudioPublication.mockResolvedValue(live());
    api.heartbeatSystemAudioLease.mockRejectedValue(heartbeatError);
    api.getSystemAudioState.mockResolvedValue(live());

    await controller.acquireProSystemAudioLease();
    await controller.commitProSystemAudioPublication(publication());

    await expect(controller.heartbeatProSystemAudioLease()).rejects.toBe(heartbeatError);
    expect(lost).toEqual([]);
    expect(controller.getCurrentLease()).toMatchObject({ generation: 1, hasCredential: true });
  });

  it('preserves a heartbeat failure for retry when reconciliation is unreachable', async () => {
    const { api, controller, lost } = harness();
    const heartbeatError = new Error('heartbeat network failure');
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.commitSystemAudioPublication.mockResolvedValue(live());
    api.heartbeatSystemAudioLease.mockRejectedValue(heartbeatError);
    api.getSystemAudioState.mockRejectedValue(new Error('reconciliation network failure'));

    await controller.acquireProSystemAudioLease();
    await controller.commitProSystemAudioPublication(publication());

    await expect(controller.heartbeatProSystemAudioLease()).rejects.toBe(heartbeatError);
    expect(lost).toEqual([]);
    expect(controller.getCurrentLease()).toMatchObject({ generation: 1, hasCredential: true });
  });

  it('does not tie the publisher lease to coordinator handoff', async () => {
    const { api, controller, lost } = harness();
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    await controller.acquireProSystemAudioLease();

    const afterHandoff = sessionSnapshot(LOCAL_ID);
    afterHandoff.presence.coordinatorEpoch = 2;
    afterHandoff.playback.coordinatorEpoch = 2;
    controller.bindSession(afterHandoff);

    expect(controller.getCurrentLease()).toMatchObject({ generation: 1, hasCredential: true });
    expect(lost).toEqual([]);
  });

  it('revokes local capture on an authoritative terminal state and ignores stale resurrection', async () => {
    const { api, controller, lost } = harness();
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.commitSystemAudioPublication.mockResolvedValue(live());
    await controller.acquireProSystemAudioLease();
    await controller.commitProSystemAudioPublication(publication());

    expect(controller.acceptProSystemAudioState(idle(1))).toEqual(idle(1));
    expect(lost).toEqual(['authoritative-revocation']);
    expect(controller.acceptProSystemAudioState(live())).toEqual(idle(1));
    expect(controller.getViewState()).toMatchObject({ phase: 'idle', canStart: true });
  });

  it('blocks a remote owner but lets a newer generation replace local state', () => {
    const { controller, lost } = harness();
    controller.acceptProSystemAudioState(preparing(REMOTE_ID, 2));
    expect(() => controller.acquireProSystemAudioLease()).toThrow(
      'PRO_ROOM_SYSTEM_AUDIO_OWNED_BY_ANOTHER_PARTICIPANT',
    );
    expect(controller.getViewState()).toMatchObject({
      phase: 'preparing',
      ownerParticipantId: REMOTE_ID,
      isLocalOwner: false,
      canStart: false,
    });
    expect(lost).toEqual([]);
  });

  it('discards a late acquire result after the tab incarnation is reset', async () => {
    const { api, controller } = harness();
    const pending = deferred<{ systemAudio: ProRoomSystemAudioState; leaseId: string }>();
    api.acquireSystemAudioLease.mockReturnValue(pending.promise);
    const acquire = controller.acquireProSystemAudioLease();

    controller.reset();
    pending.resolve({ systemAudio: preparing(), leaseId: LEASE_ID });
    await expect(acquire).rejects.toMatchObject({ code: 'OPERATION_SUPERSEDED' });
    expect(controller.getCurrentState()).toBeNull();
    expect(controller.getCurrentLease()).toBeNull();
  });

  it('refreshes the dedicated state resource without inferring ownership from coordinator data', async () => {
    const { api, controller } = harness();
    api.getSystemAudioState.mockResolvedValue(live(REMOTE_ID, 4));
    await expect(controller.refreshProSystemAudioState()).resolves.toEqual(live(REMOTE_ID, 4));
    expect(api.getSystemAudioState).toHaveBeenCalledWith('000001', undefined);
    expect(controller.getViewState()).toMatchObject({
      phase: 'live',
      ownerParticipantId: REMOTE_ID,
      isLocalOwner: false,
    });
  });
});
