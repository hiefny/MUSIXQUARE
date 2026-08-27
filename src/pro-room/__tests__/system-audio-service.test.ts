import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getManagedTimer } from '../../core/timers.ts';
import type {
  ProSystemAudioDirectTarget,
  ProSystemAudioDirectTracksReadyEvent,
  activateProSystemAudioDirectPublication,
  attemptProSystemAudioDirectPublication,
  configureProSystemAudioDirectTransport,
} from '../../network/pro-system-audio-direct.ts';
import type { ProRoomApiClient } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
  type ProRoomSystemAudioPublication,
  type ProRoomSystemAudioState,
} from '../contracts.ts';

type ProSystemAudioDirectActivation = Parameters<typeof activateProSystemAudioDirectPublication>[0];
type ProSystemAudioDirectAttemptOptions = Parameters<
  typeof attemptProSystemAudioDirectPublication
>[0];
type ProSystemAudioDirectPublicationDescriptor = NonNullable<
  Awaited<ReturnType<typeof attemptProSystemAudioDirectPublication>>
>;
type ProSystemAudioDirectTransportCallbacks = Parameters<
  typeof configureProSystemAudioDirectTransport
>[0];

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
  directCallbacks: null as ProSystemAudioDirectTransportCallbacks | null,
  configureDirect: vi.fn<(callbacks: ProSystemAudioDirectTransportCallbacks) => void>(),
  attemptDirect: vi.fn<
    (
      options: ProSystemAudioDirectAttemptOptions,
    ) => Promise<ProSystemAudioDirectPublicationDescriptor | null>
  >(() => {
    throw new Error('DIRECT_UNAVAILABLE');
  }),
  activateDirect: vi.fn<(publication: ProSystemAudioDirectActivation) => Promise<boolean>>(
    async () => true,
  ),
  reconcileDirect: vi
    .fn<(targets: readonly ProSystemAudioDirectTarget[], timeoutMs?: number) => Promise<boolean>>()
    .mockResolvedValue(true),
  resetDirect:
    vi.fn<
      (options?: { notifyPeers?: boolean; reason?: 'stopped' | 'fallback' | 'superseded' }) => void
    >(),
  publish: vi.fn(),
  subscribe: vi.fn().mockResolvedValue(undefined),
  initAudio: vi.fn().mockResolvedValue(undefined),
  getAudioContext: vi.fn(),
  getWidener: vi.fn(),
  setSystemAudioReceiving: vi.fn(),
  claimPlaybackOwner: vi.fn(),
  roomContextKind: 'pro' as 'pro' | 'standard',
  playbackMode: 'none' as 'none' | 'system-audio',
  sfuListener: null as ((event: Record<string, unknown>) => void) | null,
}));

vi.mock('../../audio/context.ts', () => ({ getAudioContext: mocks.getAudioContext }));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: mocks.initAudio,
  getWidener: mocks.getWidener,
}));
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
vi.mock('../../network/pro-system-audio-direct.ts', () => ({
  configureProSystemAudioDirectTransport: vi.fn(
    (callbacks: ProSystemAudioDirectTransportCallbacks) => {
      mocks.directCallbacks = callbacks;
      mocks.configureDirect(callbacks);
    },
  ),
  attemptProSystemAudioDirectPublication: mocks.attemptDirect,
  activateProSystemAudioDirectPublication: mocks.activateDirect,
  reconcileProSystemAudioDirectTargets: mocks.reconcileDirect,
  resetProSystemAudioDirectTransport: mocks.resetDirect,
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
    if (path === 'playback.mode') return mocks.playbackMode;
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

function directLive(
  ownerParticipantId = REMOTE_ID,
  generation = 1,
  publicationId = 'publication_00001',
): Extract<ProRoomSystemAudioState, { status: 'live' }> {
  return {
    generation,
    status: 'live',
    ownerParticipantId,
    claimExpiresAt: null,
    liveExpiresAt: 1_900_007_200_000,
    publication: {
      publicationId,
      transport: 'lan-direct',
      protocolVersion: 1,
    },
  };
}

function localLiveWithPublication(
  publication: ProRoomSystemAudioPublication,
  generation = 1,
): Extract<ProRoomSystemAudioState, { status: 'live' }> {
  return {
    generation,
    status: 'live',
    ownerParticipantId: LOCAL_ID,
    claimExpiresAt: null,
    liveExpiresAt: 1_900_007_200_000,
    publication,
  };
}

function directDescriptor(
  options: ProSystemAudioDirectAttemptOptions,
): ProSystemAudioDirectPublicationDescriptor {
  return {
    publicationId: options.publicationId,
    transport: 'lan-direct',
    protocolVersion: 1,
  };
}

function sfuEventDescriptor(sessionId = 'realtime_session_01', generation = 1) {
  return {
    version: 1,
    sessionId,
    tracks: [
      { trackName: 'audio-L', channel: 'L', mid: '0' },
      { trackName: 'audio-R', channel: 'R', mid: '1' },
    ],
    generation,
    expiresAt: 1_900_007_200_000,
  };
}

function snapshotWithLateParticipant(): ProRoomSnapshot {
  const next = snapshot();
  next.presence.participants.push({
    participantId: 'participant_late_0001',
    memberId: 'member_late_0001',
    memberDisplayNumber: 3,
    isAuthenticated: false,
    displayName: 'Late member',
    devicePlatform: 'other',
    role: 'member',
    capabilities: [],
    joinedAtMs: 3,
  });
  return next;
}

function snapshotWithoutRemoteParticipant(): ProRoomSnapshot {
  const next = snapshot();
  next.presence.participants = next.presence.participants.filter(
    (participant) => participant.participantId === LOCAL_ID,
  );
  return next;
}

function snapshotWithRemoteTakeover(joinedAtMs: number): ProRoomSnapshot {
  const next = snapshot();
  const remote = next.presence.participants.find(
    (participant) => participant.participantId === REMOTE_ID,
  );
  if (remote) remote.joinedAtMs = joinedAtMs;
  return next;
}

function snapshotWithOversizedPresence(): ProRoomSnapshot {
  const next = snapshot();
  for (let index = 3; index <= 5; index += 1) {
    next.presence.participants.push({
      participantId: `participant_extra_000${index}`,
      memberId: `member_extra_000${index}`,
      memberDisplayNumber: index,
      isAuthenticated: false,
      displayName: `Extra member ${index}`,
      devicePlatform: 'other',
      role: 'member',
      capabilities: [],
      joinedAtMs: index,
    });
  }
  return next;
}

function installAudioGraphHarness() {
  const sources: Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const merger = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  mocks.getAudioContext.mockReturnValue({
    createChannelMerger: vi.fn(() => merger),
    createMediaStreamSource: vi.fn(() => {
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      sources.push(source);
      return source;
    }),
  });
  mocks.getWidener.mockReturnValue({ input: {} });
  vi.stubGlobal(
    'MediaStream',
    class MockMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    },
  );
  return { sources, merger };
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
  mocks.playbackMode = 'none';
  mocks.awaitTrustedReceptionBoundary.mockResolvedValue(true);
  mocks.initAudio.mockResolvedValue(undefined);
  mocks.getAudioContext.mockReset();
  mocks.getWidener.mockReset();
  mocks.publish.mockResolvedValue({
    sessionId: 'realtime_session_01',
    tracks: [
      { trackName: 'audio-L', channel: 'L', mid: '0' },
      { trackName: 'audio-R', channel: 'R', mid: '1' },
    ],
  });
  mocks.attemptDirect.mockReset().mockImplementation(() => {
    throw new Error('DIRECT_UNAVAILABLE');
  });
  mocks.activateDirect.mockReset().mockResolvedValue(true);
  mocks.reconcileDirect.mockReset().mockResolvedValue(true);
  mocks.resetDirect.mockClear();
  resetProSystemAudioService();
  bindProSystemAudioSession(snapshot());
});

afterEach(() => {
  vi.useRealTimers();
  resetProSystemAudioService();
  bus.clear();
  vi.unstubAllGlobals();
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

  it('commits and activates an all-local direct publication without starting the SFU', async () => {
    const leftTrack = { id: 'capture-left' } as MediaStreamTrack;
    const rightTrack = { id: 'capture-right' } as MediaStreamTrack;
    mocks.attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    const state = await publishLocalProSystemAudio(leftTrack, rightTrack);

    expect(mocks.attemptDirect).toHaveBeenCalledWith({
      leftTrack,
      rightTrack,
      generation: 1,
      publicationId: expect.any(String),
      targets: [{ participantId: REMOTE_ID, routeToken: 'joined-at:2' }],
    });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(api.commitSystemAudioPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 1,
        publication: {
          publicationId: state.publication?.publicationId,
          transport: 'lan-direct',
          protocolVersion: 1,
        },
      }),
      undefined,
    );
    expect(mocks.activateDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerParticipantId: LOCAL_ID,
        generation: 1,
        publicationId: state.publication?.publicationId,
        targets: [{ participantId: REMOTE_ID, routeToken: 'joined-at:2' }],
      }),
    );
  });

  it('fences an authoritative local-direct activation to the latest known presence snapshot', async () => {
    const authority = deferred<ProRoomSystemAudioState>();
    api.getSystemAudioState.mockReturnValueOnce(authority.promise);

    const refresh = refreshProSystemAudioState();
    bindProSystemAudioSession(snapshotWithLateParticipant());
    authority.resolve(directLive(LOCAL_ID));
    await refresh;

    await vi.waitFor(() => expect(mocks.activateDirect).toHaveBeenCalled());
    expect(mocks.activateDirect).toHaveBeenCalledWith({
      ownerParticipantId: LOCAL_ID,
      generation: 1,
      publicationId: 'publication_00001',
      targets: [
        { participantId: REMOTE_ID, routeToken: 'joined-at:2' },
        { participantId: 'participant_late_0001', routeToken: 'joined-at:3' },
      ],
    });
  });

  it('falls back when presence changes between direct probing and post-commit activation', async () => {
    const commit = deferred<ProRoomSystemAudioState>();
    mocks.attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    mocks.activateDirect.mockImplementation(async (activation) => activation.targets?.length === 1);
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication
      .mockReturnValueOnce(commit.promise)
      .mockImplementationOnce(async (request) => localLiveWithPublication(request.publication));
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();

    const publish = publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );
    await vi.waitFor(() => expect(api.commitSystemAudioPublication).toHaveBeenCalledTimes(1));
    const probedPublication = api.commitSystemAudioPublication.mock.calls[0]?.[0].publication;
    bindProSystemAudioSession(snapshotWithLateParticipant());
    commit.resolve(localLiveWithPublication(probedPublication!));
    await publish;

    const latestTargets = [
      { participantId: REMOTE_ID, routeToken: 'joined-at:2' },
      { participantId: 'participant_late_0001', routeToken: 'joined-at:3' },
    ];
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
    expect(mocks.activateDirect.mock.calls.length).toBeGreaterThan(0);
    expect(
      mocks.activateDirect.mock.calls.every(
        ([activation]) => JSON.stringify(activation.targets) === JSON.stringify(latestTargets),
      ),
    ).toBe(true);
    expect(mocks.reconcileDirect).not.toHaveBeenCalled();
  });

  it('falls back to the established SFU publisher when the direct probe returns null', async () => {
    mocks.attemptDirect.mockResolvedValueOnce(null);
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );

    expect(mocks.attemptDirect).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(api.commitSystemAudioPublication.mock.calls[0]?.[0]).toMatchObject({
      publication: {
        sessionId: 'realtime_session_01',
        tracks: [{ channel: 'L' }, { channel: 'R' }],
      },
    });
    expect(mocks.activateDirect).not.toHaveBeenCalled();
  });

  it('also falls back to the SFU when the direct probe rejects', async () => {
    mocks.attemptDirect.mockRejectedValueOnce(new Error('direct negotiation failed'));
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );

    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(api.commitSystemAudioPublication.mock.calls[0]?.[0].publication).toMatchObject({
      sessionId: 'realtime_session_01',
      tracks: [{ channel: 'L' }, { channel: 'R' }],
    });
  });

  it('preserves publisher recovery when the initial SFU fails while commit is pending', async () => {
    const commit = deferred<ProRoomSystemAudioState>();
    const release = deferred<ProRoomSystemAudioState>();
    mocks.attemptDirect.mockResolvedValueOnce(null);
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockReturnValueOnce(commit.promise);
    api.releaseSystemAudioLease.mockReturnValueOnce(release.promise);
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();

    const publish = publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );
    await vi.waitFor(() => expect(api.commitSystemAudioPublication).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    mocks.sfuListener?.({
      type: 'publisher-state',
      state: 'failed',
      descriptor: sfuEventDescriptor(),
    });
    expect(getManagedTimer('pro-system-audio-publisher-retry')).not.toBeNull();
    const committedPublication = api.commitSystemAudioPublication.mock.calls[0]?.[0].publication;
    commit.resolve(localLiveWithPublication(committedPublication!));
    await expect(publish).resolves.toMatchObject({
      status: 'live',
      publication: { sessionId: 'realtime_session_01' },
    });

    expect(getManagedTimer('pro-system-audio-publisher-retry')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
  });

  it('retains the health fence when the initial publisher fails after canonical settle', async () => {
    mocks.attemptDirect.mockResolvedValueOnce(null);
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    vi.useFakeTimers();
    mocks.broadcastSystemMessage.mockImplementationOnce(() => {
      mocks.sfuListener?.({
        type: 'publisher-state',
        state: 'failed',
        descriptor: sfuEventDescriptor(),
      });
    });

    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );

    expect(getManagedTimer('pro-system-audio-publisher-retry')).not.toBeNull();
  });

  it('keeps a zero-target direct publication entirely off the SFU APIs', async () => {
    bindProSystemAudioSession(snapshotWithoutRemoteParticipant());
    mocks.attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );

    expect(mocks.attemptDirect.mock.calls[0]?.[0].targets).toEqual([]);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(api.commitSystemAudioPublication.mock.calls[0]?.[0].publication).toMatchObject({
      transport: 'lan-direct',
      protocolVersion: 1,
    });
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).not.toBeNull();
  });

  it('promotes one live direct publication to the SFU when a late join cannot reconcile', async () => {
    let publicationId = '';
    mocks.attemptDirect.mockImplementation(async (options) => {
      publicationId = options.publicationId;
      return directDescriptor(options);
    });
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementation(async (request) =>
      localLiveWithPublication(request.publication),
    );

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );
    await vi.waitFor(() => expect(mocks.reconcileDirect).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    mocks.publish.mockClear();
    mocks.resetDirect.mockClear();
    api.commitSystemAudioPublication.mockClear();
    mocks.reconcileDirect.mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    const promotionStartedAt = Date.now();
    bindProSystemAudioSession(snapshotWithLateParticipant());

    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(api.commitSystemAudioPublication).toHaveBeenCalledTimes(1));
    expect(mocks.reconcileDirect).toHaveBeenCalledWith([
      { participantId: REMOTE_ID, routeToken: 'joined-at:2' },
      { participantId: 'participant_late_0001', routeToken: 'joined-at:3' },
    ]);
    expect(mocks.publish.mock.calls[0]?.[0].expiresAt).toBeGreaterThanOrEqual(
      promotionStartedAt + SYSTEM_AUDIO_SHARE_LIMIT_MS,
    );
    expect(mocks.publish.mock.calls[0]?.[0].expiresAt).toBeLessThanOrEqual(
      Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
    );
    expect(api.commitSystemAudioPublication.mock.calls[0]?.[0]).toMatchObject({
      generation: 1,
      publication: {
        publicationId,
        sessionId: 'realtime_session_01',
        tracks: [{ channel: 'L' }, { channel: 'R' }],
      },
    });
    expect(mocks.resetDirect).toHaveBeenCalledWith({ notifyPeers: false });
    expect(mocks.updatePublisherExpiry).toHaveBeenCalledTimes(1);
  });

  it('keeps the canonical SFU publisher when the direct promotion response is lost', async () => {
    let publicationId = '';
    mocks.attemptDirect.mockImplementation(async (options) => {
      publicationId = options.publicationId;
      return directDescriptor(options);
    });
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication
      .mockImplementationOnce(async (request) => localLiveWithPublication(request.publication))
      .mockRejectedValueOnce(new Error('promotion response lost'));

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );
    const canonicalPublication: ProRoomSystemAudioPublication = {
      publicationId,
      sessionId: 'realtime_session_01',
      tracks: [
        { trackName: 'audio-L', channel: 'L', mid: '0' },
        { trackName: 'audio-R', channel: 'R', mid: '1' },
      ],
    };
    api.getSystemAudioState.mockResolvedValueOnce(localLiveWithPublication(canonicalPublication));
    api.getSystemAudioState.mockClear();
    api.commitSystemAudioPublication.mockClear();
    mocks.stopPublisher.mockClear();
    mocks.resetDirect.mockClear();
    mocks.updatePublisherExpiry.mockClear();

    mocks.directCallbacks?.onLiveRouteFallback({
      role: 'publisher',
      reason: 'route-disconnected',
      participantId: REMOTE_ID,
      generation: 1,
      publicationId,
    });

    await vi.waitFor(() => expect(api.commitSystemAudioPublication).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(api.getSystemAudioState).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(getProSystemAudioViewState().publication).toEqual(canonicalPublication),
    );

    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.stopPublisher).not.toHaveBeenCalled();
    expect(mocks.updatePublisherExpiry).toHaveBeenCalledWith(1_900_007_200_000);
    expect(mocks.resetDirect).toHaveBeenCalledWith({ notifyPeers: false });
    expect(getManagedTimer('pro-system-audio-direct-promotion-retry')).toBeNull();
  });

  it('hands a failed in-flight direct promotion to canonical SFU publisher recovery', async () => {
    let publicationId = '';
    const promotionCommit = deferred<ProRoomSystemAudioState>();
    mocks.attemptDirect.mockImplementation(async (options) => {
      publicationId = options.publicationId;
      return directDescriptor(options);
    });
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );
    api.commitSystemAudioPublication.mockReturnValueOnce(promotionCommit.promise);
    api.commitSystemAudioPublication.mockClear();
    mocks.publish.mockClear();

    mocks.directCallbacks?.onLiveRouteFallback({
      role: 'publisher',
      reason: 'route-disconnected',
      participantId: REMOTE_ID,
      generation: 1,
      publicationId,
    });
    await vi.waitFor(() => expect(api.commitSystemAudioPublication).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    mocks.sfuListener?.({
      type: 'publisher-state',
      state: 'failed',
      descriptor: sfuEventDescriptor(),
    });
    expect(getManagedTimer('pro-system-audio-publisher-retry')).not.toBeNull();
    const promotedPublication = api.commitSystemAudioPublication.mock.calls[0]?.[0].publication;
    promotionCommit.resolve(localLiveWithPublication(promotedPublication!));
    await vi.advanceTimersByTimeAsync(0);

    expect(getProSystemAudioViewState().publication).toEqual(promotedPublication);
    expect(getManagedTimer('pro-system-audio-publisher-retry')).not.toBeNull();
    expect(getManagedTimer('pro-system-audio-direct-promotion-retry')).toBeNull();
  });

  it('retains the health fence when a promoted publisher fails just after settle', async () => {
    let publicationId = '';
    mocks.attemptDirect.mockImplementation(async (options) => {
      publicationId = options.publicationId;
      return directDescriptor(options);
    });
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementation(async (request) =>
      localLiveWithPublication(request.publication),
    );
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );
    mocks.resetDirect
      .mockReset()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        mocks.sfuListener?.({
          type: 'publisher-state',
          state: 'failed',
          descriptor: sfuEventDescriptor(),
        });
      });
    vi.useFakeTimers();

    mocks.directCallbacks?.onLiveRouteFallback({
      role: 'publisher',
      reason: 'route-disconnected',
      participantId: REMOTE_ID,
      generation: 1,
      publicationId,
    });
    await vi.waitFor(() =>
      expect(getProSystemAudioViewState().publication).toMatchObject({
        publicationId,
        sessionId: 'realtime_session_01',
      }),
    );

    expect(mocks.resetDirect.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getManagedTimer('pro-system-audio-publisher-retry')).not.toBeNull();
  });

  it('keeps direct media through successful late join, leave, and same-ID tab takeover', async () => {
    mocks.attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementation(async (request) =>
      localLiveWithPublication(request.publication),
    );
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );

    mocks.publish.mockClear();
    mocks.activateDirect.mockClear();
    mocks.reconcileDirect.mockClear();
    bindProSystemAudioSession(snapshotWithLateParticipant());
    await vi.waitFor(() =>
      expect(mocks.reconcileDirect).toHaveBeenCalledWith([
        { participantId: REMOTE_ID, routeToken: 'joined-at:2' },
        { participantId: 'participant_late_0001', routeToken: 'joined-at:3' },
      ]),
    );
    expect(mocks.activateDirect).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();

    mocks.reconcileDirect.mockClear();
    bindProSystemAudioSession(snapshotWithoutRemoteParticipant());
    await vi.waitFor(() => expect(mocks.reconcileDirect).toHaveBeenCalledWith([]));
    expect(mocks.publish).not.toHaveBeenCalled();

    mocks.reconcileDirect.mockClear();
    bindProSystemAudioSession(snapshotWithRemoteTakeover(99));
    await vi.waitFor(() =>
      expect(mocks.reconcileDirect).toHaveBeenCalledWith([
        { participantId: REMOTE_ID, routeToken: 'joined-at:99' },
      ]),
    );
    expect(mocks.activateDirect).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('resets direct and forces authority refresh before a fifth presence can open more routes', async () => {
    mocks.attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );
    api.getSystemAudioState.mockResolvedValueOnce(idle(1));
    mocks.resetDirect.mockClear();
    mocks.reconcileDirect.mockClear();
    mocks.publish.mockClear();
    api.getSystemAudioState.mockClear();

    bindProSystemAudioSession(snapshotWithOversizedPresence());
    await vi.waitFor(() => expect(api.getSystemAudioState).toHaveBeenCalledTimes(1));

    expect(mocks.resetDirect).toHaveBeenCalledWith({ notifyPeers: true, reason: 'fallback' });
    expect(mocks.reconcileDirect).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('activates a remote direct route as pending and starts receiving only after both tracks attach', async () => {
    const graph = installAudioGraphHarness();
    const rightTrackBoundary = deferred<boolean>();
    mocks.awaitTrustedReceptionBoundary
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(rightTrackBoundary.promise);
    api.getSystemAudioState.mockResolvedValueOnce(directLive());
    mocks.beginReception.mockClear();
    mocks.subscribe.mockClear();
    mocks.setSystemAudioReceiving.mockClear();
    mocks.claimPlaybackOwner.mockClear();

    await refreshProSystemAudioState();
    await vi.waitFor(() => expect(mocks.beginReception).toHaveBeenCalledTimes(1));

    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.activateDirect).toHaveBeenCalledWith({
      ownerParticipantId: REMOTE_ID,
      generation: 1,
      publicationId: 'publication_00001',
    });
    expect(mocks.setSystemAudioReceiving).not.toHaveBeenCalled();

    const event: ProSystemAudioDirectTracksReadyEvent = {
      ownerParticipantId: REMOTE_ID,
      generation: 1,
      publicationId: 'publication_00001',
      negotiationId: 'negotiation_000000000001',
      leftTrack: { id: 'direct-left' } as MediaStreamTrack,
      rightTrack: { id: 'direct-right' } as MediaStreamTrack,
      isCurrent: () => true,
    };
    const trackHandoff = Promise.resolve(mocks.directCallbacks?.onReceiverTracksReady(event));

    await vi.waitFor(() => expect(graph.sources).toHaveLength(1));
    expect(mocks.setSystemAudioReceiving).not.toHaveBeenCalled();
    rightTrackBoundary.resolve(true);
    await trackHandoff;

    expect(mocks.awaitTrustedReceptionBoundary.mock.calls).toEqual([['pro-sfu-L'], ['pro-sfu-R']]);
    expect(graph.sources).toHaveLength(2);
    expect(graph.sources[0]?.connect).toHaveBeenCalledWith(graph.merger, 0, 0);
    expect(graph.sources[1]?.connect).toHaveBeenCalledWith(graph.merger, 0, 1);
    expect(mocks.setSystemAudioReceiving).toHaveBeenCalledWith(true);
    expect(mocks.setSystemAudioReceiving).toHaveBeenCalledTimes(1);
    expect(mocks.claimPlaybackOwner).toHaveBeenCalledWith('system-audio');
  });

  it('does not attach stale direct tracks after the trusted boundary resolves', async () => {
    const graph = installAudioGraphHarness();
    const trustedBoundary = deferred<boolean>();
    mocks.awaitTrustedReceptionBoundary.mockReturnValueOnce(trustedBoundary.promise);
    api.getSystemAudioState.mockResolvedValueOnce(directLive());
    await refreshProSystemAudioState();
    await vi.waitFor(() => expect(mocks.beginReception).toHaveBeenCalled());
    mocks.setSystemAudioReceiving.mockClear();
    let current = true;
    const event: ProSystemAudioDirectTracksReadyEvent = {
      ownerParticipantId: REMOTE_ID,
      generation: 1,
      publicationId: 'publication_00001',
      negotiationId: 'negotiation_000000000099',
      leftTrack: { id: 'stale-left' } as MediaStreamTrack,
      rightTrack: { id: 'stale-right' } as MediaStreamTrack,
      isCurrent: () => current,
    };
    const handoff = Promise.resolve(mocks.directCallbacks?.onReceiverTracksReady(event));
    await vi.waitFor(() => expect(mocks.awaitTrustedReceptionBoundary).toHaveBeenCalledTimes(1));
    current = false;
    trustedBoundary.resolve(true);
    await handoff;

    expect(graph.sources).toHaveLength(0);
    expect(mocks.initAudio).not.toHaveBeenCalled();
    expect(mocks.setSystemAudioReceiving).not.toHaveBeenCalledWith(true);
  });

  it('cleans a remote direct graph when an authenticated refresh returns idle', async () => {
    const graph = installAudioGraphHarness();
    api.getSystemAudioState.mockResolvedValueOnce(directLive()).mockResolvedValueOnce(idle(1));
    await refreshProSystemAudioState();
    const event: ProSystemAudioDirectTracksReadyEvent = {
      ownerParticipantId: REMOTE_ID,
      generation: 1,
      publicationId: 'publication_00001',
      negotiationId: 'negotiation_000000000077',
      leftTrack: { id: 'direct-left' } as MediaStreamTrack,
      rightTrack: { id: 'direct-right' } as MediaStreamTrack,
      isCurrent: () => true,
    };
    await mocks.directCallbacks?.onReceiverTracksReady(event);
    expect(graph.sources).toHaveLength(2);
    mocks.playbackMode = 'system-audio';
    mocks.resetDirect.mockClear();
    mocks.cleanupReception.mockClear();

    await refreshProSystemAudioState();
    await vi.waitFor(() => expect(mocks.resetDirect).toHaveBeenCalledWith({ notifyPeers: false }));

    expect(graph.sources[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(graph.sources[1]?.disconnect).toHaveBeenCalledTimes(1);
    expect(graph.merger.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupReception).toHaveBeenCalledTimes(1);
  });

  it('notifies direct peers when an authenticated idle response revokes the local owner', async () => {
    mocks.attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    api.getSystemAudioState.mockResolvedValueOnce(idle()).mockResolvedValueOnce(idle(1));
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio(
      { id: 'capture-left' } as MediaStreamTrack,
      { id: 'capture-right' } as MediaStreamTrack,
    );
    mocks.resetDirect.mockClear();

    await refreshProSystemAudioState();
    await vi.waitFor(() =>
      expect(mocks.resetDirect).toHaveBeenCalledWith({
        notifyPeers: true,
        reason: 'superseded',
      }),
    );
  });

  it('tears down direct audio before subscribing when authority promotes it to the SFU', async () => {
    const graph = installAudioGraphHarness();
    api.getSystemAudioState.mockResolvedValueOnce(directLive()).mockResolvedValueOnce(live());

    await refreshProSystemAudioState();
    await vi.waitFor(() => expect(mocks.beginReception).toHaveBeenCalled());
    const event: ProSystemAudioDirectTracksReadyEvent = {
      ownerParticipantId: REMOTE_ID,
      generation: 1,
      publicationId: 'publication_00001',
      negotiationId: 'negotiation_000000000001',
      leftTrack: { id: 'direct-left' } as MediaStreamTrack,
      rightTrack: { id: 'direct-right' } as MediaStreamTrack,
      isCurrent: () => true,
    };
    await mocks.directCallbacks?.onReceiverTracksReady(event);
    expect(graph.sources).toHaveLength(2);

    mocks.playbackMode = 'system-audio';
    mocks.resetDirect.mockClear();
    mocks.subscribe.mockClear();
    mocks.cleanupReception.mockClear();
    mocks.claimPlaybackOwner.mockClear();
    await refreshProSystemAudioState();
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));

    expect(mocks.resetDirect).toHaveBeenCalledWith({ notifyPeers: false });
    expect(graph.sources[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(graph.sources[1]?.disconnect).toHaveBeenCalledTimes(1);
    expect(graph.merger.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupReception).toHaveBeenCalledTimes(1);
    expect(mocks.claimPlaybackOwner).not.toHaveBeenCalled();
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
  });

  it('returns a failed playing SFU subscription to pending until both retry tracks attach', async () => {
    const graph = installAudioGraphHarness();
    const descriptor = {
      version: 1,
      sessionId: 'realtime_session_01',
      generation: 1,
      expiresAt: 1_900_007_200_000,
      tracks: [
        { trackName: 'audio-L', channel: 'L', mid: '0' },
        { trackName: 'audio-R', channel: 'R', mid: '1' },
      ],
    } as const;
    api.getSystemAudioState.mockResolvedValueOnce(live());
    await refreshProSystemAudioState();
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor,
      channel: 'L',
      track: { id: 'first-left' } as MediaStreamTrack,
    });
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor,
      channel: 'R',
      track: { id: 'first-right' } as MediaStreamTrack,
    });
    await vi.waitFor(() => expect(graph.sources).toHaveLength(2));
    expect(mocks.setSystemAudioReceiving).toHaveBeenCalledWith(true);

    mocks.playbackMode = 'system-audio';
    vi.useFakeTimers();
    mocks.setSystemAudioReceiving.mockClear();
    mocks.stopSubscriber.mockClear();
    mocks.cleanupLegacySubscriber.mockClear();
    mocks.cleanupReception.mockClear();
    mocks.sfuListener?.({ type: 'subscriber-state', state: 'failed', descriptor });

    expect(graph.sources[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(graph.sources[1]?.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.stopSubscriber).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupLegacySubscriber).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupReception).not.toHaveBeenCalled();
    expect(mocks.setSystemAudioReceiving).toHaveBeenCalledWith(false);

    await vi.advanceTimersByTimeAsync(2_500);
    vi.useRealTimers();
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor,
      channel: 'L',
      track: { id: 'retry-left' } as MediaStreamTrack,
    });
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor,
      channel: 'R',
      track: { id: 'retry-right' } as MediaStreamTrack,
    });
    await vi.waitFor(() => expect(graph.sources).toHaveLength(4));
    expect(mocks.setSystemAudioReceiving.mock.calls).toEqual([[false], [true]]);
  });

  it('debounces SFU disconnects and restores playing without removing the pending placeholder', async () => {
    const graph = installAudioGraphHarness();
    const descriptor = {
      version: 1,
      sessionId: 'realtime_session_01',
      generation: 1,
      expiresAt: 1_900_007_200_000,
      tracks: [
        { trackName: 'audio-L', channel: 'L', mid: '0' },
        { trackName: 'audio-R', channel: 'R', mid: '1' },
      ],
    } as const;
    api.getSystemAudioState.mockResolvedValueOnce(live());
    await refreshProSystemAudioState();
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor,
      channel: 'L',
      track: { id: 'left' } as MediaStreamTrack,
    });
    mocks.sfuListener?.({
      type: 'subscriber-track',
      descriptor,
      channel: 'R',
      track: { id: 'right' } as MediaStreamTrack,
    });
    await vi.waitFor(() => expect(graph.sources).toHaveLength(2));

    mocks.playbackMode = 'system-audio';
    vi.useFakeTimers();
    mocks.setSystemAudioReceiving.mockClear();
    mocks.cleanupReception.mockClear();
    mocks.sfuListener?.({ type: 'subscriber-state', state: 'disconnected', descriptor });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(mocks.setSystemAudioReceiving).not.toHaveBeenCalled();
    mocks.sfuListener?.({ type: 'subscriber-state', state: 'subscribed', descriptor });
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.setSystemAudioReceiving).toHaveBeenCalledTimes(1);
    expect(mocks.setSystemAudioReceiving).toHaveBeenLastCalledWith(true);

    mocks.setSystemAudioReceiving.mockClear();
    mocks.sfuListener?.({ type: 'subscriber-state', state: 'disconnected', descriptor });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mocks.setSystemAudioReceiving).toHaveBeenCalledWith(false);
    expect(graph.sources[0]?.disconnect).not.toHaveBeenCalled();
    expect(graph.sources[1]?.disconnect).not.toHaveBeenCalled();
    expect(mocks.cleanupReception).not.toHaveBeenCalled();
    mocks.sfuListener?.({ type: 'subscriber-state', state: 'subscribed', descriptor });
    expect(mocks.setSystemAudioReceiving.mock.calls).toEqual([[false], [true]]);
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
    if (!first.publication || !('tracks' in first.publication)) {
      throw new Error('Expected an SFU publication');
    }
    first.publication.tracks[0].trackName = 'tampered-track';

    const second = getProSystemAudioViewState();
    expect(
      second.publication && 'tracks' in second.publication
        ? second.publication.tracks[0].trackName
        : null,
    ).toBe('audio-L');
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

  it('queues one authenticated refresh after an in-flight GET for duplicate invalidations', async () => {
    const staleRequest = deferred<ProRoomSystemAudioState>();
    api.getSystemAudioState
      .mockReturnValueOnce(staleRequest.promise)
      .mockResolvedValueOnce(idle(1));
    const staleRefresh = refreshProSystemAudioState();
    const forcedRefresh = refreshProSystemAudioState(undefined, true);
    const duplicateForcedRefresh = refreshProSystemAudioState(undefined, true);
    expect(duplicateForcedRefresh).toBe(forcedRefresh);
    expect(api.getSystemAudioState).toHaveBeenCalledTimes(1);
    mocks.resetDirect.mockClear();

    staleRequest.resolve(directLive());
    await expect(staleRefresh).resolves.toEqual(directLive());
    await expect(forcedRefresh).resolves.toEqual(idle(1));

    expect(api.getSystemAudioState).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(mocks.resetDirect).toHaveBeenCalledWith({ notifyPeers: false }));
    expect(getProSystemAudioViewState().phase).toBe('idle');
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

  it('preserves a recovery grant adopted by a successor capture after stop', async () => {
    vi.useFakeTimers();
    const reacquire = deferred<{
      systemAudio: ProRoomSystemAudioState;
      leaseId: string;
    }>();
    const recoveredLeaseId = 'N'.repeat(43);
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease
      .mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      })
      .mockReturnValueOnce(reacquire.promise);
    api.commitSystemAudioPublication
      .mockResolvedValueOnce(localLive())
      .mockResolvedValueOnce(localLive(2));
    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    mocks.sfuListener?.({ type: 'publisher-state', state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(api.acquireSystemAudioLease).toHaveBeenCalledTimes(2);
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);

    await releaseLocalProSystemAudioLease();
    const successor = beginLocalProSystemAudioLeaseAttempt();
    reacquire.resolve({
      systemAudio: preparing(2),
      leaseId: recoveredLeaseId,
    });
    await expect(successor.result).resolves.toEqual(preparing(2));
    await Promise.resolve();

    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'preparing',
      generation: 2,
      canStop: true,
    });

    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);

    expect(getProSystemAudioViewState()).toMatchObject({
      phase: 'live',
      generation: 2,
      isLocalOwner: true,
    });
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).not.toBeNull();

    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(2));
    await releaseLocalProSystemAudioLease();
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(2);
    expect(api.releaseSystemAudioLease.mock.calls[1]?.[0]).toEqual({
      code: '000001',
      generation: 2,
      leaseId: recoveredLeaseId,
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

  it('bounds an unmetered direct publisher when Cloudflare authority heartbeats stay unreachable', async () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    bus.on('pro-system-audio:lease-lost', (reason) => reasons.push(reason));
    mocks.attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    const heartbeatFailure = new Error('authority plane unreachable');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      api.heartbeatSystemAudioLease.mockRejectedValueOnce(heartbeatFailure);
      api.getSystemAudioState.mockRejectedValueOnce(heartbeatFailure);
    }
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockImplementationOnce(async (request) =>
      localLiveWithPublication(request.publication),
    );

    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    await publishLocalProSystemAudio({} as MediaStreamTrack, {} as MediaStreamTrack);
    mocks.resetDirect.mockClear();

    // The first normal heartbeat fails at 15 s. Brief recovery remains
    // allowed, but four additional normal heartbeat intervals without an
    // authoritative response must close the otherwise-unbounded direct route.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reasons).toEqual(['authoritative-revocation']);
    expect(mocks.resetDirect).toHaveBeenCalledWith({
      notifyPeers: true,
      reason: 'superseded',
    });
    expect(getManagedTimer('pro-system-audio-lease-heartbeat')).toBeNull();
  });
});
