import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
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
  beginReception: vi.fn(),
  cleanupReception: vi.fn(),
  stopPublisher: vi.fn(),
  stopSubscriber: vi.fn(),
  updatePublisherExpiry: vi.fn(),
  cleanupLegacySubscriber: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../audio/context.ts', () => ({ getAudioContext: vi.fn() }));
vi.mock('../../audio/engine.ts', () => ({ initAudio: vi.fn(), getWidener: vi.fn() }));
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
  onProSystemAudioSfuEvent: vi.fn(),
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
  beginTrustedSystemAudioReception: mocks.beginReception,
  cleanupGuestSystemAudio: mocks.cleanupReception,
}));
vi.mock('../../network/webrtc-audio-decoder-primer.ts', () => ({
  cleanupWebRtcAudioDecoderPrimer: vi.fn(),
  getAudioTrackStreamKey: vi.fn(),
  primeWebRtcAudioDecoder: vi.fn(),
}));
vi.mock('../../player/ownership.ts', () => ({
  claimPlaybackOwner: vi.fn(),
  setSystemAudioReceiving: vi.fn(),
}));
vi.mock('../../core/state.ts', () => ({
  getState: (path: string) => {
    if (path === 'room.context') {
      return {
        kind: 'pro',
        roomCode: '000001',
        participantId: 'participant_local1',
        capabilities: ['queue.mutate'],
      };
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
import { canPublishProSystemAudioWithCurrentCoordinator } from '../system-audio-bridge.ts';

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

function snapshot(incarnation = 'presence_local_01'): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: '000001',
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
      updatedAtMs: 0,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: LOCAL_ID,
          displayName: 'Local member',
          role: 'member',
          joinedAtMs: 1,
        },
        {
          participantId: REMOTE_ID,
          displayName: 'Remote member',
          role: 'member',
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

function live(generation = 1): ProRoomSystemAudioState {
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(() => {
  configureProSystemAudioService(api as unknown as ProRoomApiClient);
  registerProSystemAudioServiceListeners();
});

beforeEach(() => {
  vi.clearAllMocks();
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
