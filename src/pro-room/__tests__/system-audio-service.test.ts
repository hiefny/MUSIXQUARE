import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getManagedTimer } from '../../core/timers.ts';
import type { ProRoomApiClient } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
  type ProRoomSystemAudioState,
} from '../contracts.ts';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastExcept: vi.fn(),
  broadcastSystemMessage: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
  awaitTrustedReceptionBoundary: vi.fn(async () => true),
  beginReception: vi.fn(),
  cleanupReception: vi.fn(),
  stopPublisher: vi.fn(),
  stopSubscriber: vi.fn(),
  updatePublisherExpiry: vi.fn(),
  cleanupLegacySubscriber: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn().mockResolvedValue(undefined),
  initAudio: vi.fn().mockResolvedValue(undefined),
  getAudioContext: vi.fn(),
  setSystemAudioReceiving: vi.fn(),
  claimPlaybackOwner: vi.fn(),
  roomContextKind: 'pro' as 'pro' | 'standard',
  sfuListener: null as ((event: Record<string, unknown>) => void) | null,
}));

vi.mock('../../audio/context.ts', () => ({ getAudioContext: mocks.getAudioContext }));
vi.mock('../../audio/engine.ts', () => ({ initAudio: mocks.initAudio, getWidener: vi.fn() }));
vi.mock('../../chat/protocol.ts', () => ({
  broadcastSystemMessage: mocks.broadcastSystemMessage,
}));
vi.mock('../../network/peer-state.ts', () => ({
  broadcast: mocks.broadcast,
  broadcastExcept: mocks.broadcastExcept,
  safeSend: mocks.safeSend,
  sendToHost: mocks.sendToHost,
}));
vi.mock('../../network/pro-system-audio-sfu.ts', () => ({
  onProSystemAudioSfuEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
    mocks.sfuListener = listener;
  }),
  publishProSystemAudioSfu: mocks.publish,
  stopProSystemAudioSfuPublisher: mocks.stopPublisher,
  stopProSystemAudioSfuSubscriber: mocks.stopSubscriber,
  updateProSystemAudioSfuPublisherExpiry: mocks.updatePublisherExpiry,
  subscribeProSystemAudioSfu: mocks.subscribe,
}));
vi.mock('../../network/system-audio-sfu.ts', () => ({
  cleanupSystemAudioSfuGuestRoute: mocks.cleanupLegacySubscriber,
}));
vi.mock('../../network/system-audio-guest.ts', () => ({
  awaitTrustedSystemAudioReceptionBoundary: mocks.awaitTrustedReceptionBoundary,
  beginTrustedSystemAudioReception: mocks.beginReception,
  cleanupGuestSystemAudio: mocks.cleanupReception,
}));
vi.mock('../../network/webrtc-audio-decoder-primer.ts', () => ({
  cleanupWebRtcAudioDecoderPrimer: vi.fn(),
  getAudioTrackStreamKey: vi.fn(),
  primeWebRtcAudioDecoder: vi.fn(),
}));
vi.mock('../../player/ownership.ts', () => ({
  claimPlaybackOwner: mocks.claimPlaybackOwner,
  setSystemAudioReceiving: mocks.setSystemAudioReceiving,
}));
vi.mock('../../core/state.ts', () => ({
  getState: (path: string) => {
    if (path === 'room.context') {
      return mocks.roomContextKind === 'pro'
        ? {
            kind: 'pro',
            roomCode: '000001',
            participantId: 'participant_local1',
            capabilities: ['queue.mutate'],
          }
        : { kind: 'standard' };
    }
    if (path === 'playback.mode') return 'none';
    if (path === 'network.hostConn') return null;
    return null;
  },
}));

import {
  acquireLocalProSystemAudioLease,
  bindProSystemAudioSession,
  configureProSystemAudioService,
  getProSystemAudioViewState,
  publishLocalProSystemAudio,
  refreshProSystemAudioState,
  releaseLocalProSystemAudioLease,
  registerProSystemAudioServiceListeners,
  resetProSystemAudioService,
} from '../system-audio-service.ts';
import {
  beginLocalProSystemAudioLeaseAttempt,
  canPublishProSystemAudioWithCurrentCoordinator,
} from '../system-audio-bridge.ts';

const LOCAL_ID = 'participant_local1';
const REMOTE_ID = 'participant_remote1';
const LEASE_ID = 'L'.repeat(43);

const api = {
  getSystemAudioState: vi.fn(),
  acquireSystemAudioLease: vi.fn(),
  commitSystemAudioPublication: vi.fn(),
  heartbeatSystemAudioLease: vi.fn(),
  releaseSystemAudioLease: vi.fn(),
};

function snapshot(incarnation = 'presence_local_01', roomCode = '000001'): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode,
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
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: LOCAL_ID,
          memberId: 'member_local_0001',
          memberDisplayNumber: 1,
          isAuthenticated: true,
          displayName: 'Local member',
          devicePlatform: 'other',
          role: 'member',
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
          participantId: REMOTE_ID,
          memberId: 'member_remote_0001',
          memberDisplayNumber: 2,
          isAuthenticated: false,
          displayName: 'Remote member',
          devicePlatform: 'other',
          role: 'member',
          capabilities: [],
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
      memberDisplayNumber: 1,
      isAuthenticated: true,
      participantId: LOCAL_ID,
      presenceIncarnationId: incarnation,
      displayName: 'Local member',
      role: 'member',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
      ],
      coordinatorEligible: false,
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

function preparing(generation = 1): ProRoomSystemAudioState {
  return {
    generation,
    status: 'preparing',
    ownerParticipantId: LOCAL_ID,
    claimExpiresAt: 1_900_000_045_000,
    liveExpiresAt: null,
    publication: null,
  };
}

function live(generation = 1): Extract<ProRoomSystemAudioState, { status: 'live' }> {
  return {
    generation,
    status: 'live',
    ownerParticipantId: REMOTE_ID,
    claimExpiresAt: null,
    liveExpiresAt: 1_900_007_200_000,
    publication: {
      publicationId: 'publication_00001',
      sessionId: 'realtime_session_01',
      tracks: [
        { trackName: 'audio-L', channel: 'L', mid: '0' },
        { trackName: 'audio-R', channel: 'R', mid: '1' },
      ],
    },
  };
}

function localLive(generation = 1): ProRoomSystemAudioState {
  return {
    ...live(generation),
    ownerParticipantId: LOCAL_ID,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeAll(() => {
  configureProSystemAudioService(api as unknown as ProRoomApiClient);
  registerProSystemAudioServiceListeners();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roomContextKind = 'pro';
  mocks.awaitTrustedReceptionBoundary.mockResolvedValue(true);
  mocks.initAudio.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue({
    sessionId: 'realtime_session_01',
    tracks: [
      { trackName: 'audio-L', channel: 'L', mid: '0' },
      { trackName: 'audio-R', channel: 'R', mid: '1' },
    ],
  });
  resetProSystemAudioService();
  bindProSystemAudioSession(snapshot());
});

afterEach(() => {
  vi.useRealTimers();
  resetProSystemAudioService();
  bus.clear();
});

describe('PRO system-audio service orchestration', () => {
  it('allows every playback-capable member without browser-coordinator proof', async () => {
    expect(canPublishProSystemAudioWithCurrentCoordinator()).toBe(true);
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });

    await refreshProSystemAudioState();
    await expect(acquireLocalProSystemAudioLease()).resolves.toEqual(preparing());
  });

  it('derives publish eligibility from the current member capability snapshot', () => {
    const restricted = snapshot();
    restricted.viewer!.capabilities = restricted.viewer!.capabilities.filter(
      (capability) => capability !== 'playback.control',
    );
    bindProSystemAudioSession(restricted);
    expect(canPublishProSystemAudioWithCurrentCoordinator()).toBe(false);

    bindProSystemAudioSession(snapshot('presence_local_02'));
    expect(canPublishProSystemAudioWithCurrentCoordinator()).toBe(true);
  });

  it('announces a local authoritative publish and release exactly once', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockResolvedValueOnce(localLive());
    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    await releaseLocalProSystemAudioLease();

    expect(mocks.broadcastSystemMessage.mock.calls).toEqual([
      ['chat.system_audio_started_system_message'],
      ['chat.system_audio_stopped_system_message'],
    ]);
  });

  it('keeps a successor publish flight and heartbeat intact when a shared-grant predecessor releases', async () => {
    const acquireGrant = deferred<{
      systemAudio: ProRoomSystemAudioState;
      leaseId: string;
    }>();
    const sfuPublish = deferred<{
      sessionId: string;
      tracks: [
        { trackName: string; channel: 'L'; mid: string },
        { trackName: string; channel: 'R'; mid: string },
      ];
    }>();
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockReturnValueOnce(acquireGrant.promise);
    api.commitSystemAudioPublication.mockResolvedValueOnce(localLive());
    mocks.publish.mockReturnValueOnce(sfuPublish.promise);
    await refreshProSystemAudioState();

    const predecessor = beginLocalProSystemAudioLeaseAttempt();
    const successor = beginLocalProSystemAudioLeaseAttempt();
    acquireGrant.resolve({ systemAudio: preparing(), leaseId: LEASE_ID });
    await Promise.all([predecessor.result, successor.result]);

    const publish = publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
    mocks.stopPublisher.mockClear();

    await expect(predecessor.releaseIfCurrent()).resolves.toEqual(preparing());
    expect(api.releaseSystemAudioLease).not.toHaveBeenCalled();
    expect(mocks.stopPublisher).not.toHaveBeenCalled();

    sfuPublish.resolve({
      sessionId: 'realtime_session_01',
      tracks: [
        { trackName: 'audio-L', channel: 'L', mid: '0' },
        { trackName: 'audio-R', channel: 'R', mid: '1' },
      ],
    });
    await publish;

    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).not.toBeNull();
    await predecessor.releaseIfCurrent();
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).not.toBeNull();
    expect(api.releaseSystemAudioLease).not.toHaveBeenCalled();
    expect(mocks.stopPublisher).not.toHaveBeenCalled();

    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));
    await releaseLocalProSystemAudioLease();
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).toBeNull();
  });

  it('makes an old-session attempt release side-effect-free after a new session is live', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(idle(1));
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({ systemAudio: preparing(), leaseId: LEASE_ID })
      .mockResolvedValueOnce({ systemAudio: preparing(2), leaseId: 'N'.repeat(43) });
    api.commitSystemAudioPublication.mockResolvedValueOnce(localLive(2));
    await refreshProSystemAudioState();
    const predecessor = beginLocalProSystemAudioLeaseAttempt();
    await predecessor.result;

    bindProSystemAudioSession(snapshot('presence_local_02', '000002'));
    await refreshProSystemAudioState();
    const successor = beginLocalProSystemAudioLeaseAttempt();
    await successor.result;
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).not.toBeNull();
    api.releaseSystemAudioLease.mockClear();
    mocks.stopPublisher.mockClear();

    await expect(predecessor.releaseIfCurrent()).resolves.toEqual(localLive(2));

    expect(api.releaseSystemAudioLease).not.toHaveBeenCalled();
    expect(mocks.stopPublisher).not.toHaveBeenCalled();
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).not.toBeNull();

    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(2));
    await releaseLocalProSystemAudioLease();
  });

  it('retries a transient current scoped release without duplicating handle teardown', async () => {
    vi.useFakeTimers();
    const releaseFailure = new Error('transient release failure');
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(preparing());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.releaseSystemAudioLease
      .mockRejectedValueOnce(releaseFailure)
      .mockResolvedValueOnce(idle(1));

    await refreshProSystemAudioState();
    const attempt = beginLocalProSystemAudioLeaseAttempt();
    await attempt.result;

    const firstRelease = attempt.releaseIfCurrent();
    const duplicateRelease = attempt.releaseIfCurrent();
    expect(duplicateRelease).toBe(firstRelease);
    await expect(firstRelease).rejects.toBe(releaseFailure);

    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(getManagedTimer('pro-system-audio-lease-release-retry')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2_500);

    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(2);
    expect(api.releaseSystemAudioLease.mock.calls[1]?.[0]).toEqual({
      code: '000001',
      generation: 1,
      leaseId: LEASE_ID,
    });
    expect(getManagedTimer('pro-system-audio-lease-release-retry')).toBeNull();
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'idle',
      generation: 1,
    });
  });

  it('does not announce a remote live share discovered during refresh', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(live());

    await refreshProSystemAudioState();
    await refreshProSystemAudioState();
    await Promise.resolve();

    expect(mocks.broadcastSystemMessage).not.toHaveBeenCalled();
    expect(mocks.subscribe).toHaveBeenCalledWith({
      version: 1,
      sessionId: 'realtime_session_01',
      generation: 1,
      expiresAt: 1_900_007_200_000,
      tracks: [
        { trackName: 'audio-L', channel: 'L', mid: '0' },
        { trackName: 'audio-R', channel: 'R', mid: '1' },
      ],
    });
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('does not subscribe the active publisher back to its own SFU feed', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(localLive());

    await refreshProSystemAudioState();
    await Promise.resolve();

    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it('acquires through the room server without peer fanout', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    await refreshProSystemAudioState();
    mocks.broadcast.mockClear();

    await acquireLocalProSystemAudioLease();

    expect(api.acquireSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('does not announce a live share discovered during initial recovery', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(live(4));

    await refreshProSystemAudioState();

    expect(mocks.broadcastSystemMessage).not.toHaveBeenCalled();
  });

  it('returns a defensive copy of nested public track metadata', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(live());
    await refreshProSystemAudioState();

    const first = getProSystemAudioViewState();
    first.publication!.tracks[0].trackName = 'tampered-track';

    expect(getProSystemAudioViewState().publication!.tracks[0].trackName).toBe('audio-L');
  });

  it('does not let an old incarnation refresh suppress the new session refresh', async () => {
    const oldRequest = deferred<ProRoomSystemAudioState>();
    api.getSystemAudioState.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(idle(2));
    const oldRefresh = refreshProSystemAudioState();

    bindProSystemAudioSession(snapshot('presence_local_02'));
    await expect(refreshProSystemAudioState()).resolves.toEqual(idle(2));
    expect(api.getSystemAudioState).toHaveBeenCalledTimes(2);

    oldRequest.resolve(idle());
    await expect(oldRefresh).rejects.toMatchObject({ code: 'OPERATION_SUPERSEDED' });
  });

  it('retries a failed authoritative release instead of stranding the lease', async () => {
    vi.useFakeTimers();
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.releaseSystemAudioLease
      .mockRejectedValueOnce(new Error('transient network failure'))
      .mockResolvedValueOnce(idle(1));

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await expect(releaseLocalProSystemAudioLease()).rejects.toThrow('transient network failure');

    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(2);
    expect(getProSystemAudioViewState()).toMatchObject({ phase: 'idle', canStart: true });
  });

  it('does not retry an old-incarnation release against a newly acquired lease', async () => {
    vi.useFakeTimers();
    const oldRelease = deferred<ProRoomSystemAudioState>();
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(idle(1));
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockResolvedValueOnce({
        systemAudio: preparing(2),
        leaseId: 'N'.repeat(43),
      });
    api.releaseSystemAudioLease.mockReturnValueOnce(oldRelease.promise);

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    const staleCompletion = releaseLocalProSystemAudioLease();

    bindProSystemAudioSession(snapshot('presence_local_02'));
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'preparing',
      generation: 2,
      canStop: true,
    });

    oldRelease.resolve(idle(1));
    await expect(staleCompletion).resolves.toMatchObject({
      status: 'preparing',
      generation: 2,
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'preparing',
      generation: 2,
      canStop: true,
    });
  });

  it('does not let a stale publisher recovery close the new incarnation publisher', async () => {
    vi.useFakeTimers();
    const oldRelease = deferred<ProRoomSystemAudioState>();
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(idle(1));
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockResolvedValueOnce({
        systemAudio: preparing(2),
        leaseId: 'N'.repeat(43),
      });
    api.commitSystemAudioPublication
      .mockResolvedValueOnce(localLive())
      .mockResolvedValueOnce(localLive(2));
    api.releaseSystemAudioLease.mockReturnValueOnce(oldRelease.promise);

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    mocks.sfuListener?.({ type: 'publisher-state', state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);

    bindProSystemAudioSession(snapshot('presence_local_02'));
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    mocks.stopPublisher.mockClear();

    oldRelease.resolve(idle(1));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(mocks.stopPublisher).not.toHaveBeenCalled();
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'live',
      generation: 2,
      canStop: true,
    });
  });

  it('does not commit or clean up a stale publish flight against a new incarnation', async () => {
    const oldDescriptor = deferred<{
      sessionId: string;
      tracks: [
        { trackName: string; channel: 'L'; mid: string },
        { trackName: string; channel: 'R'; mid: string },
      ];
    }>();
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(idle(1));
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockResolvedValueOnce({
        systemAudio: preparing(2),
        leaseId: 'N'.repeat(43),
      });
    mocks.publish.mockReturnValueOnce(oldDescriptor.promise).mockResolvedValueOnce({
      sessionId: 'realtime_session_02',
      tracks: [
        { trackName: 'new-audio-L', channel: 'L', mid: '0' },
        { trackName: 'new-audio-R', channel: 'R', mid: '1' },
      ],
    });
    api.commitSystemAudioPublication.mockResolvedValueOnce({
      ...localLive(2),
      publication: {
        publicationId: 'publication_00002',
        sessionId: 'realtime_session_02',
        tracks: [
          { trackName: 'new-audio-L', channel: 'L', mid: '0' },
          { trackName: 'new-audio-R', channel: 'R', mid: '1' },
        ],
      },
    });

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    const stalePublish = publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);

    bindProSystemAudioSession(snapshot('presence_local_02'));
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    mocks.stopPublisher.mockClear();

    oldDescriptor.resolve({
      sessionId: 'realtime_session_01',
      tracks: [
        { trackName: 'old-audio-L', channel: 'L', mid: '0' },
        { trackName: 'old-audio-R', channel: 'R', mid: '1' },
      ],
    });
    await expect(stalePublish).rejects.toMatchObject({ code: 'OPERATION_SUPERSEDED' });

    expect(api.commitSystemAudioPublication).toHaveBeenCalledTimes(1);
    expect(api.commitSystemAudioPublication.mock.calls[0]?.[0]).toMatchObject({
      generation: 2,
      publication: {
        sessionId: 'realtime_session_02',
        tracks: [{ trackName: 'new-audio-L' }, { trackName: 'new-audio-R' }],
      },
    });
    expect(api.releaseSystemAudioLease).not.toHaveBeenCalled();
    expect(mocks.stopPublisher).not.toHaveBeenCalled();
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'live',
      generation: 2,
      canStop: true,
    });
  });

  it('releases exactly once when explicit stop aborts a pending publish', async () => {
    const pendingDescriptor = deferred<{
      sessionId: string;
      tracks: [
        { trackName: string; channel: 'L'; mid: string },
        { trackName: string; channel: 'R'; mid: string },
      ];
    }>();
    const pendingRelease = deferred<ProRoomSystemAudioState>();
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    mocks.publish.mockReturnValueOnce(pendingDescriptor.promise);
    api.releaseSystemAudioLease.mockReturnValueOnce(pendingRelease.promise);

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    const publish = publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    const release = releaseLocalProSystemAudioLease();
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    mocks.stopPublisher.mockClear();

    pendingDescriptor.reject(new Error('publisher aborted'));
    await expect(publish).rejects.toThrow('publisher aborted');

    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(mocks.stopPublisher).not.toHaveBeenCalled();

    pendingRelease.resolve(idle(1));
    await expect(release).resolves.toEqual(idle(1));
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(getProSystemAudioViewState()).toMatchObject({ phase: 'idle', canStart: true });
  });

  it('does not attach an old subscriber track after a new room binds at the same generation', async () => {
    const pendingAudio = deferred<void>();
    mocks.initAudio.mockReturnValueOnce(pendingAudio.promise);
    api.getSystemAudioState.mockResolvedValueOnce(live()).mockResolvedValueOnce(live());

    await refreshProSystemAudioState();
    const oldTrack = {} as MediaStreamTrack;
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor: {
        version: 1,
        sessionId: 'realtime_session_01',
        generation: 1,
        expiresAt: 1_900_007_200_000,
        tracks: [
          { trackName: 'audio-L', channel: 'L', mid: '0' },
          { trackName: 'audio-R', channel: 'R', mid: '1' },
        ],
      },
      channel: 'L',
      track: oldTrack,
    });

    bindProSystemAudioSession(snapshot('presence_local_02', '000002'));
    await refreshProSystemAudioState();
    mocks.getAudioContext.mockClear();
    mocks.setSystemAudioReceiving.mockClear();
    mocks.claimPlaybackOwner.mockClear();

    pendingAudio.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.getAudioContext).not.toHaveBeenCalled();
    expect(mocks.setSystemAudioReceiving).not.toHaveBeenCalled();
    expect(mocks.claimPlaybackOwner).not.toHaveBeenCalled();
  });

  it('does not attach a PRO SFU track before the trusted owner-switch boundary settles', async () => {
    const trustedBoundary = deferred<boolean>();
    mocks.awaitTrustedReceptionBoundary.mockReturnValueOnce(trustedBoundary.promise);
    api.getSystemAudioState.mockResolvedValueOnce(live());

    await refreshProSystemAudioState();
    mocks.initAudio.mockClear();
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor: {
        version: 1,
        sessionId: 'realtime_session_01',
        generation: 1,
        expiresAt: 1_900_007_200_000,
        tracks: [
          { trackName: 'audio-L', channel: 'L', mid: '0' },
          { trackName: 'audio-R', channel: 'R', mid: '1' },
        ],
      },
      channel: 'L',
      track: {} as MediaStreamTrack,
    });

    await Promise.resolve();
    expect(mocks.awaitTrustedReceptionBoundary).toHaveBeenCalledWith('pro-sfu-L');
    expect(mocks.initAudio).not.toHaveBeenCalled();

    trustedBoundary.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.initAudio).toHaveBeenCalledTimes(1);
  });

  it('does not attach a pending PRO track after the room context becomes standard', async () => {
    const pendingAudio = deferred<void>();
    mocks.initAudio.mockReturnValueOnce(pendingAudio.promise);
    api.getSystemAudioState.mockResolvedValueOnce(live());

    await refreshProSystemAudioState();
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor: {
        version: 1,
        sessionId: 'realtime_session_01',
        generation: 1,
        expiresAt: 1_900_007_200_000,
        tracks: [
          { trackName: 'audio-L', channel: 'L', mid: '0' },
          { trackName: 'audio-R', channel: 'R', mid: '1' },
        ],
      },
      channel: 'L',
      track: {} as MediaStreamTrack,
    });
    mocks.roomContextKind = 'standard';
    mocks.getAudioContext.mockClear();

    pendingAudio.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.getAudioContext).not.toHaveBeenCalled();
    expect(mocks.setSystemAudioReceiving).not.toHaveBeenCalled();
  });

  it('keeps one subscription flight across consecutive identical live reconciles', async () => {
    const subscription = deferred<void>();
    const toasts: unknown[] = [];
    bus.on('ui:show-toast', (...args) => toasts.push(args));
    mocks.subscribe.mockReturnValueOnce(subscription.promise);
    api.getSystemAudioState.mockResolvedValueOnce(live());

    await refreshProSystemAudioState();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    mocks.stopSubscriber.mockClear();
    mocks.beginReception.mockClear();

    bindProSystemAudioSession(snapshot());

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.stopSubscriber).not.toHaveBeenCalled();
    expect(mocks.beginReception).not.toHaveBeenCalled();

    subscription.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(toasts).toEqual([]);
  });

  it('tears down a remote graph when an active snapshot becomes suspended', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(live());
    await refreshProSystemAudioState();
    mocks.stopSubscriber.mockClear();

    const suspended = snapshot();
    suspended.status = 'suspended';
    bindProSystemAudioSession(suspended);

    expect(mocks.stopSubscriber).toHaveBeenCalledTimes(1);
    expect(getProSystemAudioViewState()).toMatchObject({
      initialized: false,
      phase: 'idle',
    });
  });

  it('ignores an old subscription failure after a new room binds at the same generation', async () => {
    vi.useFakeTimers();
    const oldSubscription = deferred<void>();
    const toasts: unknown[] = [];
    bus.on('ui:show-toast', (...args) => toasts.push(args));
    mocks.subscribe.mockReturnValueOnce(oldSubscription.promise).mockResolvedValueOnce(undefined);
    api.getSystemAudioState.mockResolvedValueOnce(live()).mockResolvedValueOnce(live());

    await refreshProSystemAudioState();
    bindProSystemAudioSession(snapshot('presence_local_02', '000002'));
    await refreshProSystemAudioState();
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    toasts.length = 0;

    oldSubscription.reject(new Error('old subscriber failed'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(toasts).toEqual([]);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it('explicitly stops the recovered generation after the original attempt handle becomes stale', async () => {
    vi.useFakeTimers();
    const recoveredLeaseId = 'N'.repeat(43);
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockResolvedValueOnce({
        systemAudio: preparing(2),
        leaseId: recoveredLeaseId,
      });
    api.commitSystemAudioPublication
      .mockResolvedValueOnce(localLive())
      .mockResolvedValueOnce(localLive(2));
    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1)).mockResolvedValueOnce(idle(2));

    await refreshProSystemAudioState();
    const originalAttempt = beginLocalProSystemAudioLeaseAttempt();
    await originalAttempt.result;
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);

    mocks.sfuListener?.({ type: 'publisher-state', state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.waitFor(() => expect(api.commitSystemAudioPublication).toHaveBeenCalledTimes(2));

    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'live',
      generation: 2,
      isLocalOwner: true,
    });
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).not.toBeNull();
    mocks.stopPublisher.mockClear();

    await expect(originalAttempt.releaseIfCurrent()).resolves.toEqual(localLive(2));
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(mocks.stopPublisher).not.toHaveBeenCalled();
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).not.toBeNull();

    await releaseLocalProSystemAudioLease();

    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(2);
    expect(api.releaseSystemAudioLease.mock.calls[1]?.[0]).toEqual({
      code: '000001',
      generation: 2,
      leaseId: recoveredLeaseId,
    });
    expect(mocks.stopPublisher).toHaveBeenCalled();
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).toBeNull();
    await releaseLocalProSystemAudioLease();
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(2);
  });

  it('fences a recovery acquire exactly once when the user stops while it is pending', async () => {
    vi.useFakeTimers();
    const reacquire = deferred<{
      systemAudio: ProRoomSystemAudioState;
      leaseId: string;
    }>();
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(preparing(2));
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockReturnValueOnce(reacquire.promise);
    api.commitSystemAudioPublication.mockResolvedValueOnce(localLive());
    api.releaseSystemAudioLease
      .mockResolvedValueOnce(idle(1))
      .mockRejectedValueOnce(new Error('transient fence failure'))
      .mockResolvedValueOnce(idle(2));

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    mocks.sfuListener?.({ type: 'publisher-state', state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.acquireSystemAudioLease).toHaveBeenCalledTimes(2);
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);

    await releaseLocalProSystemAudioLease();
    reacquire.resolve({
      systemAudio: preparing(2),
      leaseId: 'N'.repeat(43),
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'preparing',
      generation: 2,
      canStop: true,
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(3);
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'idle',
      generation: 2,
      canStart: true,
    });
  });

  it('emits one reset loss while recovery is between release and reacquire', async () => {
    vi.useFakeTimers();
    const reacquire = deferred<{
      systemAudio: ProRoomSystemAudioState;
      leaseId: string;
    }>();
    const reasons: string[] = [];
    bus.on('pro-system-audio:lease-lost', (reason) => reasons.push(reason));
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockReturnValueOnce(reacquire.promise);
    api.commitSystemAudioPublication.mockResolvedValueOnce(localLive());
    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    mocks.sfuListener?.({ type: 'publisher-state', state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_500);
    reasons.length = 0;

    resetProSystemAudioService();
    reacquire.resolve({
      systemAudio: preparing(2),
      leaseId: 'N'.repeat(43),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(reasons).toEqual(['reset']);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it('cleans local recovery state when release observes a remote owner', async () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    bus.on('pro-system-audio:lease-lost', (reason) => reasons.push(reason));
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockResolvedValueOnce(localLive());
    api.releaseSystemAudioLease.mockResolvedValueOnce(live(2));

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    reasons.length = 0;
    mocks.sfuListener?.({ type: 'publisher-state', state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(reasons).toEqual(['authoritative-revocation']);
    expect(api.acquireSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'live',
      generation: 2,
      isLocalOwner: false,
    });
  });

  it('cleans recovered tracks when authority changes during the replacement publish', async () => {
    vi.useFakeTimers();
    const replacementPublish = deferred<{
      sessionId: string;
      tracks: [
        { trackName: string; channel: 'L'; mid: string },
        { trackName: string; channel: 'R'; mid: string },
      ];
    }>();
    const reasons: string[] = [];
    bus.on('pro-system-audio:lease-lost', (reason) => reasons.push(reason));
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(live(3));
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockResolvedValueOnce({
        systemAudio: preparing(2),
        leaseId: 'N'.repeat(43),
      });
    api.commitSystemAudioPublication.mockResolvedValueOnce(localLive());
    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));
    mocks.publish
      .mockResolvedValueOnce({
        sessionId: 'realtime_session_01',
        tracks: [
          { trackName: 'audio-L', channel: 'L', mid: '0' },
          { trackName: 'audio-R', channel: 'R', mid: '1' },
        ],
      })
      .mockReturnValueOnce(replacementPublish.promise);

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    reasons.length = 0;
    mocks.sfuListener?.({ type: 'publisher-state', state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mocks.publish).toHaveBeenCalledTimes(2);

    await refreshProSystemAudioState();
    replacementPublish.reject(new Error('replacement superseded'));
    await vi.advanceTimersByTimeAsync(0);

    expect(reasons).toEqual(['authoritative-revocation']);
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'live',
      generation: 3,
      isLocalOwner: false,
    });
  });

  it('does not let an old heartbeat failure overwrite the new incarnation timer', async () => {
    vi.useFakeTimers();
    const oldHeartbeat = deferred<ProRoomSystemAudioState>();
    const toasts: unknown[] = [];
    bus.on('ui:show-toast', (...args) => toasts.push(args));
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: 'N'.repeat(43),
      });
    api.commitSystemAudioPublication
      .mockResolvedValueOnce(localLive())
      .mockResolvedValueOnce(localLive());
    api.heartbeatSystemAudioLease
      .mockReturnValueOnce(oldHeartbeat.promise)
      .mockResolvedValueOnce(localLive());

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(api.heartbeatSystemAudioLease).toHaveBeenCalledTimes(1);

    bindProSystemAudioSession(snapshot('presence_local_02', '000002'));
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    toasts.length = 0;

    oldHeartbeat.reject(new Error('old heartbeat failed'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.heartbeatSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);

    await vi.advanceTimersByTimeAsync(12_500);
    expect(api.heartbeatSystemAudioLease).toHaveBeenCalledTimes(2);
    expect(toasts).toEqual([]);
  });

  it('forwards the authoritative lease-loss reason to capture orchestration', async () => {
    const reasons: string[] = [];
    bus.on('pro-system-audio:lease-lost', (reason) => reasons.push(reason));
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(idle(1));
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await refreshProSystemAudioState();

    expect(reasons).toEqual(['authoritative-revocation']);
  });

  it('stops an equal participant publisher after server revocation', async () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    bus.on('pro-system-audio:lease-lost', (reason) => reasons.push(reason));
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(idle(2));
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockResolvedValueOnce(localLive());
    api.heartbeatSystemAudioLease.mockRejectedValueOnce(new Error('generation mismatch'));

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    const left = {} as MediaStreamTrack;
    const right = {} as MediaStreamTrack;
    await publishLocalProSystemAudio(left, right);
    mocks.stopPublisher.mockClear();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(api.heartbeatSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(api.getSystemAudioState).toHaveBeenCalledTimes(2);
    expect(mocks.stopPublisher).toHaveBeenCalledTimes(1);
    expect(reasons).toEqual(['authoritative-revocation']);
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'idle',
      isLocalOwner: false,
      canStart: true,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.heartbeatSystemAudioLease).toHaveBeenCalledTimes(1);
  });
});
