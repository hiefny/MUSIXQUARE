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
import { proSnapshot } from './__helpers__/pro-snapshot.ts';

const LOCAL_ID = 'participant_local1';
const COORDINATOR_ID = 'participant_coord1';
const REMOTE_ID = 'participant_remote1';
const LEASE_ID = 'L'.repeat(43);

function sessionSnapshot(): ProRoomSnapshot {
  return proSnapshot({
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
        'members.manage',
      ],
    },
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
  });
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
    track: { trackName: 'audio-stereo', mid: '0' },
  };
}

function live(
  ownerParticipantId = LOCAL_ID,
  generation = 1,
): Extract<ProRoomSystemAudioState, { status: 'live' }> {
  return {
    generation,
    status: 'live',
    ownerParticipantId,
    claimExpiresAt: null,
    liveExpiresAt: 1_900_007_200_000,
    publication: publication(),
  };
}

function lanDirectPublication(): ProRoomSystemAudioPublication {
  return { publicationId: 'publication_00001', transport: 'lan-direct', protocolVersion: 2 };
}

/** A live LAN-direct state as a PRO Worker sends it, with the given liveExpiresAt. */
function directLiveWire(
  ownerParticipantId: string,
  generation: number,
  liveExpiresAt: number | null,
): unknown {
  return {
    ...live(ownerParticipantId, generation),
    liveExpiresAt,
    publication: lanDirectPublication(),
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
  const authorityConfirmations: true[] = [];
  const observer: ProRoomSystemAudioControllerObserverForTests = {
    state: (state) => views.push(state),
    localLeaseLost: (reason) => lost.push(reason),
    localLeaseAuthorityConfirmed: () => authorityConfirmations.push(true),
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
  controller.acceptHeartbeatProSystemAudioState(idle());
  return { api, controller, views, lost, authorityConfirmations };
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

  it('accepts the authenticated one-way LAN-direct to SFU promotion at the same generation', async () => {
    const { api, controller } = harness();
    const directPublication = {
      publicationId: 'publication_00001',
      transport: 'lan-direct',
      protocolVersion: 2,
    } as const satisfies ProRoomSystemAudioPublication;
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.commitSystemAudioPublication
      .mockResolvedValueOnce({ ...live(), publication: directPublication })
      .mockResolvedValueOnce(live());

    await controller.acquireProSystemAudioLease();
    await expect(controller.commitProSystemAudioPublication(directPublication)).resolves.toEqual({
      ...live(),
      liveExpiresAt: null,
      publication: directPublication,
    });
    await expect(controller.commitProSystemAudioPublication(publication())).resolves.toEqual(
      live(),
    );
    expect(controller.getCurrentState()).toEqual(live());
  });

  // A live LAN-direct has no media deadline: PRO snapshot schemaVersion 2
  // sends liveExpiresAt null, earlier Workers a numeric compatibility value,
  // and both read as null (PLE-01). A Worker that changes it mid-share, or a
  // rollback that brings the number back, is the same state, not a conflict.
  it.each([
    { from: 1_900_007_200_000, to: null },
    { from: null, to: 1_900_007_200_000 },
  ])(
    'reads a live LAN-direct whose liveExpiresAt changes from $from to $to as one state',
    ({ from, to }) => {
      const { controller, lost } = harness();
      const read = directLiveWire(REMOTE_ID, 4, null);

      expect(
        controller.acceptHeartbeatProSystemAudioState(directLiveWire(REMOTE_ID, 4, from)),
      ).toEqual(read);
      expect(
        controller.acceptHeartbeatProSystemAudioState(directLiveWire(REMOTE_ID, 4, to)),
      ).toEqual(read);
      expect(controller.getCurrentState()).toEqual(read);
      expect(controller.getViewState()).toMatchObject({ phase: 'live', liveExpiresAt: null });
      expect(lost).toEqual([]);
    },
  );

  it.each([
    { from: 1_900_007_200_000, to: null },
    { from: null, to: 1_900_007_200_000 },
  ])(
    'keeps the local LAN-direct lease when its liveExpiresAt changes from $from to $to',
    async ({ from, to }) => {
      const { api, controller, lost } = harness();
      api.acquireSystemAudioLease.mockResolvedValue({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      });
      api.commitSystemAudioPublication.mockResolvedValue(
        directLiveWire(LOCAL_ID, 1, from) as ProRoomSystemAudioState,
      );
      api.heartbeatSystemAudioLease.mockResolvedValue(
        directLiveWire(LOCAL_ID, 1, to) as ProRoomSystemAudioState,
      );
      const read = directLiveWire(LOCAL_ID, 1, null);

      await controller.acquireProSystemAudioLease();
      await expect(
        controller.commitProSystemAudioPublication(lanDirectPublication()),
      ).resolves.toEqual(read);
      await expect(controller.heartbeatProSystemAudioLease()).resolves.toEqual(read);
      expect(lost).toEqual([]);
      expect(controller.getCurrentLease()).toMatchObject({ generation: 1, hasCredential: true });
    },
  );

  it('accepts the promotion of a LAN-direct live without a deadline to a numeric SFU live', async () => {
    const { api, controller } = harness();
    controller.acceptHeartbeatProSystemAudioState(directLiveWire(REMOTE_ID, 4, null));
    api.getSystemAudioState.mockResolvedValue(live(REMOTE_ID, 4));

    await expect(controller.refreshProSystemAudioState()).resolves.toEqual(live(REMOTE_ID, 4));
    expect(controller.getCurrentState()).toEqual(live(REMOTE_ID, 4));
    expect(controller.getViewState()).toMatchObject({ liveExpiresAt: 1_900_007_200_000 });
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
    api.getSystemAudioState.mockResolvedValue(live(REMOTE_ID, 2));

    await controller.acquireProSystemAudioLease();
    await controller.commitProSystemAudioPublication(publication());

    await expect(controller.heartbeatProSystemAudioLease()).resolves.toEqual(live(REMOTE_ID, 2));
    expect(lost).toEqual(['authoritative-revocation']);
    expect(controller.getCurrentLease()).toBeNull();
  });

  it('preserves a heartbeat failure for retry while the authenticated state is unchanged', async () => {
    const { api, controller, lost, authorityConfirmations } = harness();
    const heartbeatError = new Error('heartbeat response lost');
    api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
    api.commitSystemAudioPublication.mockResolvedValue(live());
    api.heartbeatSystemAudioLease.mockRejectedValue(heartbeatError);
    api.getSystemAudioState.mockResolvedValue(live());

    await controller.acquireProSystemAudioLease();
    await controller.commitProSystemAudioPublication(publication());

    await expect(controller.heartbeatProSystemAudioLease()).rejects.toBe(heartbeatError);
    expect(lost).toEqual([]);
    expect(authorityConfirmations).toEqual([true]);
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

    const afterHandoff = sessionSnapshot();
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

    expect(controller.acceptHeartbeatProSystemAudioState(idle(1))).toEqual(idle(1));
    expect(lost).toEqual(['authoritative-revocation']);
    expect(controller.acceptHeartbeatProSystemAudioState(live())).toEqual(idle(1));
    expect(controller.getViewState()).toMatchObject({ phase: 'idle', canStart: true });
  });

  it('blocks a remote owner but lets a newer generation replace local state', () => {
    const { controller, lost } = harness();
    controller.acceptHeartbeatProSystemAudioState(preparing(REMOTE_ID, 2));
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

  // Every state this controller accepts comes from the authenticated state
  // resource: its GET (refreshProSystemAudioState) or a presence heartbeat that
  // carries the same read (acceptHeartbeatProSystemAudioState). PRO rooms have
  // no peer fan-out of this state since 7.0.0.
  it('accepts a remote direct-to-SFU promotion at the same generation from the authenticated state resource', async () => {
    const { api, controller } = harness();
    const directState: ProRoomSystemAudioState = {
      ...live(REMOTE_ID, 4),
      publication: {
        publicationId: 'publication_00001',
        transport: 'lan-direct',
        protocolVersion: 2,
      },
    };
    const promotedState: ProRoomSystemAudioState = {
      ...live(REMOTE_ID, 4),
      publication: publication(),
    };
    controller.acceptHeartbeatProSystemAudioState(directState);

    api.getSystemAudioState.mockResolvedValue(promotedState);
    await expect(controller.refreshProSystemAudioState()).resolves.toEqual(promotedState);
    expect(controller.getCurrentState()).toEqual(promotedState);
  });

  // The direct-to-SFU promotion of the same publication is the only
  // equal-rank change the authenticated resource may make; any other change
  // at the same generation and status is a conflict that keeps the state.
  it.each([
    {
      change: 'another publication at the same generation',
      incoming: (): ProRoomSystemAudioState => ({
        ...live(REMOTE_ID, 4),
        publication: { ...publication(), publicationId: 'publication_00002' },
      }),
    },
    {
      change: 'another SFU session for the same publication',
      incoming: (): ProRoomSystemAudioState => ({
        ...live(REMOTE_ID, 4),
        publication: { ...publication(), sessionId: 'realtime_session_02' },
      }),
    },
    {
      change: 'another owner at the same generation',
      incoming: (): ProRoomSystemAudioState => live(LOCAL_ID, 4),
    },
  ])('rejects $change from the authenticated state resource as a conflict', ({ incoming }) => {
    const { controller } = harness();
    controller.acceptHeartbeatProSystemAudioState(live(REMOTE_ID, 4));

    expect(() => controller.acceptHeartbeatProSystemAudioState(incoming())).toThrow(
      'PRO_ROOM_SYSTEM_AUDIO_STATE_CONFLICT',
    );
    expect(controller.getCurrentState()).toEqual(live(REMOTE_ID, 4));
  });

  it('never resurrects direct media from a delayed authenticated read after SFU promotion', async () => {
    const { api, controller } = harness();
    const directState: ProRoomSystemAudioState = {
      ...live(REMOTE_ID, 4),
      publication: {
        publicationId: 'publication_00001',
        transport: 'lan-direct',
        protocolVersion: 2,
      },
    };
    const promotedState: ProRoomSystemAudioState = {
      ...live(REMOTE_ID, 4),
      publication: publication(),
    };
    const staleDirectRead = deferred<ProRoomSystemAudioState>();
    controller.acceptHeartbeatProSystemAudioState(directState);
    api.getSystemAudioState
      .mockReturnValueOnce(staleDirectRead.promise)
      .mockResolvedValueOnce(promotedState);

    const staleRefresh = controller.refreshProSystemAudioState();
    await expect(controller.refreshProSystemAudioState()).resolves.toEqual(promotedState);
    staleDirectRead.resolve(directState);

    await expect(staleRefresh).resolves.toEqual(promotedState);
    expect(controller.getCurrentState()).toEqual(promotedState);
  });
});
