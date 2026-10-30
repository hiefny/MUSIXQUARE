/**
 * RO-20 PRO system-audio publication teardown, one test per entry point
 * (Phase 5 C4-12, registry exception RO-40).
 *
 * pro-room/system-audio-service.ts tears this device's publication down from
 * five places (the explicit stop, the controller's lease loss, a new presence
 * incarnation, the service reset and a terminated publisher recovery) and two
 * partial ones (a failed publish and leaving the PRO room context). Each test
 * pins, on today's code, what one entry point leaves behind: which of the four
 * publication timers (lease heartbeat, lease release retry, publisher retry,
 * direct promotion retry) are still armed, how often the singleton SFU
 * publisher stops, every LAN-direct reset with its {notifyPeers, reason}, and
 * the lease-lost reasons capture receives. The four timers are armed by name
 * just before the teardown, so a test sees exactly which names it clears.
 *
 * The controller re-enters the lease-loss handler from a release, a new
 * session and a reset (its localLeaseLost callback). Those rows therefore list
 * that second teardown's stop and reset too; during the service's own release
 * the handler tears down without telling capture.
 *
 * The order of the SFU stop relative to the LAN-direct reset is not pinned:
 * the two transports share no state and neither calls back into the service.
 *
 * Since 9.0.28 a share with LAN-direct targets starts its SFU publish beside
 * the LAN-direct attempt with the sender holding no track (the held
 * fallback). The second describe tears a share down inside that window, three
 * times (the LAN-direct attempt still pending; already failed with the held
 * publish still pending; and already failed after the held publish was lost,
 * with 9.0.27's one ordinary publish pending), and pins the same lists as the
 * first, plus that the stale flight never releases the hold or commits. As in
 * the real transport, the held fallback reads as lost after any publisher
 * stop, so in the first window only the flight's ownership check after the
 * LAN-direct attempt keeps it from the ordinary publish (the real-transport
 * rows are in system-audio-pro-publish-evidence.test.ts).
 *
 * Real: the service, its controller and bridge, the receive slot (its start,
 * trust boundary and end are spies), the bus and the managed timers. Replaced:
 * the PRO SFU and LAN-direct transports, Web Audio, the room API and the chat
 * notice. The service's bus listeners register once and stay registered (no
 * bus.clear()), so the room-context row reaches them. Room codes and ids are
 * synthetic.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers, getManagedTimer, setManagedTimer } from '../../core/timers.ts';
import type { ProRoomApiClient } from '../api.ts';
import type { ProRoomSnapshot, ProRoomSystemAudioState } from '../contracts.ts';
import { proSnapshot, type ProSnapshotFields } from './__helpers__/pro-snapshot.ts';

const mocks = vi.hoisted(() => ({
  broadcastSystemMessage: vi.fn(),
  awaitTrustedReceptionBoundary: vi.fn(async () => true),
  beginReception: vi.fn(),
  endReception: vi.fn(),
  stopPublisher: vi.fn(),
  stopSubscriber: vi.fn(),
  publish: vi.fn(),
  releaseHold: vi.fn<(descriptor: unknown) => Promise<void>>(async () => undefined),
  holdReady: vi.fn<(descriptor: unknown) => boolean>(() => true),
  reportCommitted: vi.fn<(descriptor: unknown) => void>(),
  attemptDirect: vi.fn<() => Promise<unknown>>(),
  resetDirect:
    vi.fn<
      (options?: { notifyPeers?: boolean; reason?: 'stopped' | 'fallback' | 'superseded' }) => void
    >(),
  sfuListener: null as ((event: Record<string, unknown>) => void) | null,
  roomContextKind: 'pro' as 'pro' | 'standard',
}));

vi.mock('../../audio/context.ts', () => ({ getAudioContext: () => null }));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: async () => undefined,
  getWidener: () => null,
}));
vi.mock('../../chat/protocol.ts', () => ({
  broadcastSystemMessage: mocks.broadcastSystemMessage,
}));
vi.mock('../../network/peer-state.ts', () => ({
  broadcast: vi.fn(),
  broadcastExcept: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
vi.mock('../../network/pro-system-audio-sfu.ts', () => ({
  beginProSystemAudioSfuPublisherPreflight: vi.fn(() => ({
    kind: 'pro-system-audio-sfu-publisher-preflight' as const,
  })),
  cancelProSystemAudioSfuPublisherPreflight: vi.fn(),
  onProSystemAudioSfuEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
    mocks.sfuListener = listener;
  }),
  publishProSystemAudioSfu: mocks.publish,
  isProSystemAudioSfuPublisherHoldReady: mocks.holdReady,
  releaseProSystemAudioSfuPublisherHold: mocks.releaseHold,
  reportProSystemAudioSfuPublisherCommitted: mocks.reportCommitted,
  stopProSystemAudioSfuPublisher: mocks.stopPublisher,
  stopProSystemAudioSfuSubscriber: mocks.stopSubscriber,
  updateProSystemAudioSfuPublisherExpiry: vi.fn(),
  subscribeProSystemAudioSfu: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../network/pro-system-audio-direct.ts', () => ({
  configureProSystemAudioDirectTransport: vi.fn(),
  // Unavailable unless a row says otherwise (beforeEach), so every share that
  // completes in this file is an SFU publication.
  attemptProSystemAudioDirectPublication: mocks.attemptDirect,
  activateProSystemAudioDirectPublication: vi.fn(async () => true),
  reconcileProSystemAudioDirectTargets: vi.fn(async () => true),
  resetProSystemAudioDirectTransport: mocks.resetDirect,
}));
vi.mock('../../network/system-audio-receive-slot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/system-audio-receive-slot.ts')>()),
  awaitTrustedSystemAudioReceptionBoundary: mocks.awaitTrustedReceptionBoundary,
  beginTrustedSystemAudioReception: mocks.beginReception,
  endTrustedSystemAudioReception: mocks.endReception,
}));
vi.mock('../../network/webrtc-audio-decoder-primer.ts', () => ({
  cleanupWebRtcAudioDecoderPrimer: vi.fn(),
  getAudioTrackStreamKey: vi.fn(),
  primeWebRtcAudioDecoder: vi.fn(),
}));
vi.mock('../../player/ownership.ts', () => ({
  claimPlaybackOwner: vi.fn(),
  isSystemAudioPlaceholderMeta: (meta: { systemAudioPlaceholder?: boolean } | null) =>
    meta?.systemAudioPlaceholder === true,
  setSystemAudioReceiving: vi.fn(),
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
    return null;
  },
}));

import {
  acquireLocalProSystemAudioLease,
  bindProSystemAudioSession,
  configureProSystemAudioService,
  publishLocalProSystemAudio,
  refreshProSystemAudioState,
  releaseLocalProSystemAudioLease,
  registerProSystemAudioServiceListeners,
  resetProSystemAudioService,
} from '../system-audio-service.ts';

const LOCAL_ID = 'participant_local1';
const REMOTE_ID = 'participant_remote1';
const LEASE_ID = 'L'.repeat(43);

const PUBLICATION_TIMERS = [
  'pro-system-audio-lease-heartbeat',
  'pro-system-audio-lease-release-retry',
  'pro-system-audio-publisher-retry',
  'pro-system-audio-direct-promotion-retry',
] as const;

const api = {
  getSystemAudioState: vi.fn(),
  acquireSystemAudioLease: vi.fn(),
  commitSystemAudioPublication: vi.fn(),
  heartbeatSystemAudioLease: vi.fn(),
  releaseSystemAudioLease: vi.fn(),
};

const PLAYBACK_CONTROL = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
] as const;

function participant(participantId: string, memberNumber: number, capabilities: string[]) {
  return {
    participantId,
    memberId: `member_${participantId.slice('participant_'.length)}_0001`,
    memberDisplayNumber: memberNumber,
    isAuthenticated: memberNumber === 1,
    displayName: `Member ${memberNumber}`,
    devicePlatform: 'other' as const,
    role: 'member' as const,
    capabilities,
    joinedAtMs: memberNumber,
  };
}

function snapshot(incarnation = 'presence_local_01'): ProRoomSnapshot {
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
        participant(LOCAL_ID, 1, [...PLAYBACK_CONTROL]),
        participant(REMOTE_ID, 2, []),
      ],
    },
    quota: { limitBytes: 1, perAssetLimitBytes: 1, usedBytes: 0, reservedBytes: 0 },
    viewer: {
      memberId: 'member_local1_0001',
      memberDisplayNumber: 1,
      isAuthenticated: true,
      participantId: LOCAL_ID,
      presenceIncarnationId: incarnation,
      displayName: 'Member 1',
      role: 'member',
      capabilities: [...PLAYBACK_CONTROL],
    },
    administrators: [],
  } as unknown as ProSnapshotFields);
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

function live(generation = 1, ownerParticipantId = LOCAL_ID): ProRoomSystemAudioState {
  return {
    generation,
    status: 'live',
    ownerParticipantId,
    claimExpiresAt: null,
    liveExpiresAt: 1_900_007_200_000,
    publication: {
      publicationId: 'publication_00001',
      sessionId: 'realtime_session_01',
      track: { trackName: 'audio-stereo', mid: '0' },
    },
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

/** Starts a local SFU share at generation 1 (the LAN-direct probe is unavailable). */
async function startLocalShare(): Promise<void> {
  api.getSystemAudioState.mockResolvedValueOnce(idle());
  api.acquireSystemAudioLease.mockResolvedValueOnce({
    systemAudio: preparing(),
    leaseId: LEASE_ID,
  });
  api.commitSystemAudioPublication.mockResolvedValueOnce(live());
  await refreshProSystemAudioState();
  await acquireLocalProSystemAudioLease();
  await publishLocalProSystemAudio({} as MediaStreamTrack);
}

/** Arms the four publication timers by name with inert callbacks. */
function armPublicationTimers(): void {
  for (const name of PUBLICATION_TIMERS) setManagedTimer(name, () => undefined, 3_600_000);
}

function armedPublicationTimers(): string[] {
  return PUBLICATION_TIMERS.filter((name) => getManagedTimer(name) !== null);
}

let leaseLossReasons: string[] = [];
let stopListening: (() => void) | null = null;

/** Clears every spy after the share started, so a row sees only its teardown. */
function observeTeardown(): void {
  mocks.stopPublisher.mockClear();
  mocks.resetDirect.mockClear();
  leaseLossReasons = [];
}

beforeAll(() => {
  configureProSystemAudioService(api as unknown as ProRoomApiClient);
  registerProSystemAudioServiceListeners();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  for (const request of Object.values(api)) request.mockReset();
  mocks.roomContextKind = 'pro';
  // vi.clearAllMocks keeps queued one-time answers; every row starts from none.
  mocks.publish.mockReset().mockResolvedValue({
    sessionId: 'realtime_session_01',
    track: { trackName: 'audio-stereo', mid: '0' },
  });
  mocks.releaseHold.mockReset().mockResolvedValue(undefined);
  // As the real transport: the newest held publish is ready only until the
  // next publisher stop, which every teardown entry point but leaving the PRO
  // room context makes. A stale flight therefore finds its held fallback lost,
  // so only its ownership check after the LAN-direct attempt keeps it from
  // 9.0.27's ordinary publish.
  mocks.holdReady.mockReset().mockImplementation(() => {
    const lastStop = Math.max(-1, ...mocks.stopPublisher.mock.invocationCallOrder);
    const held = mocks.publish.mock.calls.map((call, index) =>
      (call[0] as { holdMedia?: boolean } | undefined)?.holdMedia
        ? mocks.publish.mock.invocationCallOrder[index]!
        : -1,
    );
    return Math.max(-1, ...held) > lastStop;
  });
  mocks.attemptDirect.mockReset().mockImplementation(() => {
    throw new Error('DIRECT_UNAVAILABLE');
  });
  resetProSystemAudioService();
  bindProSystemAudioSession(snapshot());
  leaseLossReasons = [];
  stopListening = bus.on('pro-system-audio:lease-lost', (reason) => {
    leaseLossReasons.push(reason);
  });
});

afterEach(() => {
  stopListening?.();
  stopListening = null;
  mocks.roomContextKind = 'pro';
  resetProSystemAudioService();
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('PRO publication teardown entry points (RO-20, Phase 5 C4-12)', () => {
  it('explicit stop: clears the four timers, closes LAN-direct as stopped and tells capture nothing', async () => {
    await startLocalShare();
    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));
    armPublicationTimers();
    observeTeardown();

    await releaseLocalProSystemAudioLease();

    expect(armedPublicationTimers()).toEqual([]);
    // The release, then the controller's lease loss during it (expected, so
    // it reaches no capture listener), then the idle state's reconcile (the
    // controller's state report and the release's own mutation notice), which
    // resets LAN-direct silently on any non-live state.
    expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
    expect(mocks.resetDirect.mock.calls).toEqual([
      [{ notifyPeers: true, reason: 'stopped' }],
      [{ notifyPeers: true, reason: 'superseded' }],
      [{ notifyPeers: false }],
      [{ notifyPeers: false }],
    ]);
    expect(leaseLossReasons).toEqual([]);
  });

  it('lease loss: an authoritative revocation clears the four timers and tells capture once', async () => {
    await startLocalShare();
    api.getSystemAudioState.mockResolvedValueOnce(idle(2));
    armPublicationTimers();
    observeTeardown();

    await refreshProSystemAudioState();

    expect(armedPublicationTimers()).toEqual([]);
    expect(mocks.stopPublisher).toHaveBeenCalledTimes(1);
    // The lease loss, then the idle state's reconcile.
    expect(mocks.resetDirect.mock.calls).toEqual([
      [{ notifyPeers: true, reason: 'superseded' }],
      [{ notifyPeers: false }],
    ]);
    expect(leaseLossReasons).toEqual(['authoritative-revocation']);
  });

  it('new presence incarnation: resets LAN-direct silently, then the controller reports the session change', async () => {
    await startLocalShare();
    armPublicationTimers();
    observeTeardown();

    bindProSystemAudioSession(snapshot('presence_local_02'));

    expect(armedPublicationTimers()).toEqual([]);
    expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
    expect(mocks.resetDirect.mock.calls).toEqual([
      [{ notifyPeers: false }],
      [{ notifyPeers: true, reason: 'superseded' }],
    ]);
    expect(leaseLossReasons).toEqual(['session-changed']);
  });

  it('service reset: resets LAN-direct silently, then the controller reports the reset', async () => {
    await startLocalShare();
    armPublicationTimers();
    observeTeardown();

    resetProSystemAudioService();

    expect(armedPublicationTimers()).toEqual([]);
    expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
    expect(mocks.resetDirect.mock.calls).toEqual([
      [{ notifyPeers: false }],
      [{ notifyPeers: true, reason: 'superseded' }],
    ]);
    expect(leaseLossReasons).toEqual(['reset']);
  });

  it('terminated publisher recovery: clears no timer, closes LAN-direct as fallback and tells capture once', async () => {
    const replacementPublish = deferred<{
      sessionId: string;
      track: { trackName: string; mid: string };
    }>();
    await startLocalShare();
    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(2),
      leaseId: 'N'.repeat(43),
    });
    mocks.publish.mockReturnValueOnce(replacementPublish.promise);
    // The SFU publisher fails; the retry starts the publisher recovery, whose
    // replacement publish is still pending.
    mocks.sfuListener?.({ type: 'publisher-state', state: 'failed' });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    // Another member's share takes the lease while the replacement publishes:
    // the controller's lease loss runs inside the recovery's expected
    // transition, so it tears down without telling capture.
    api.getSystemAudioState.mockResolvedValueOnce(live(3, REMOTE_ID));
    await refreshProSystemAudioState();
    expect(leaseLossReasons).toEqual([]);
    armPublicationTimers();
    observeTeardown();

    replacementPublish.reject(new Error('replacement superseded'));
    await vi.advanceTimersByTimeAsync(0);

    expect(armedPublicationTimers()).toEqual([...PUBLICATION_TIMERS]);
    expect(mocks.stopPublisher).toHaveBeenCalledTimes(1);
    expect(mocks.resetDirect.mock.calls).toEqual([[{ notifyPeers: true, reason: 'fallback' }]]);
    expect(leaseLossReasons).toEqual(['authoritative-revocation']);
  });

  it('failed publish: closes LAN-direct as fallback, then releases the current lease like an explicit stop', async () => {
    api.getSystemAudioState.mockResolvedValueOnce(idle());
    api.acquireSystemAudioLease.mockResolvedValueOnce({
      systemAudio: preparing(),
      leaseId: LEASE_ID,
    });
    api.commitSystemAudioPublication.mockRejectedValueOnce(new Error('commit failed'));
    api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));
    await refreshProSystemAudioState();
    await acquireLocalProSystemAudioLease();
    armPublicationTimers();
    observeTeardown();

    await expect(publishLocalProSystemAudio({} as MediaStreamTrack)).rejects.toThrow();

    expect(armedPublicationTimers()).toEqual([]);
    // The publish's own teardown, the release it makes, the controller's lease
    // loss during that release, then the idle state's reconcile.
    expect(mocks.stopPublisher).toHaveBeenCalledTimes(3);
    expect(mocks.resetDirect.mock.calls).toEqual([
      [{ notifyPeers: true, reason: 'fallback' }],
      [{ notifyPeers: true, reason: 'stopped' }],
      [{ notifyPeers: true, reason: 'superseded' }],
      [{ notifyPeers: false }],
      [{ notifyPeers: false }],
    ]);
    expect(leaseLossReasons).toEqual([]);
  });

  it('leaving the PRO room context: resets LAN-direct silently and keeps the SFU publisher and the timers', async () => {
    await startLocalShare();
    armPublicationTimers();
    observeTeardown();

    mocks.roomContextKind = 'standard';
    bus.emit('state:room.context', { kind: 'standard' } as never, { kind: 'pro' } as never);

    expect(armedPublicationTimers()).toEqual([...PUBLICATION_TIMERS]);
    expect(mocks.stopPublisher).not.toHaveBeenCalled();
    expect(mocks.resetDirect.mock.calls).toEqual([[{ notifyPeers: false }]]);
    expect(leaseLossReasons).toEqual([]);
  });
});

// 9.0.28: a share with LAN-direct targets starts its one SFU attempt beside
// the LAN-direct attempt, with the sender holding no track. Each entry point
// below tears the share down inside that window and must leave the same
// timers, SFU publisher stops, LAN-direct resets and lease-lost reasons as its
// post-share row above; the held publisher is the singleton those stops reach.
// Three windows: the LAN-direct attempt still pending (the held publish already
// prepared); the LAN-direct attempt already failed with the held publish still
// pending (the flight parked on it; with `no-lan-candidate` and a slow publish
// this is the longer one); and the LAN-direct attempt already failed after the
// held publish was lost, with 9.0.27's one ordinary publish pending (release
// owner decision 2026-10-31). Each time the stale flight then neither releases
// the hold nor commits.
describe.each([
  { window: 'LAN-direct attempt still pending', pending: 'lan' },
  { window: 'LAN-direct already failed, held publish still pending', pending: 'held' },
  {
    window:
      "LAN-direct already failed after the held publish was lost, 9.0.27's ordinary publish pending",
    pending: 'ordinary',
  },
] as const)(
  'PRO publication teardown inside the LAN-direct window (RO-20, 9.0.28 held SFU fallback): $window',
  ({ pending }) => {
    const HELD_DESCRIPTOR = {
      sessionId: 'realtime_session_01',
      track: { trackName: 'audio-stereo', mid: '0' },
    };
    const ORDINARY_DESCRIPTOR = {
      sessionId: 'realtime_session_02',
      track: { trackName: 'audio-stereo-2', mid: '0' },
    };

    /** Starts a share inside the window, with its held SFU publish started. */
    async function startShareInLanWindow() {
      const lan = deferred<null>();
      const held = deferred<typeof HELD_DESCRIPTOR>();
      const ordinary = deferred<typeof ORDINARY_DESCRIPTOR>();
      mocks.attemptDirect.mockReturnValueOnce(lan.promise);
      mocks.publish.mockReturnValueOnce(held.promise).mockReturnValueOnce(ordinary.promise);
      api.getSystemAudioState.mockResolvedValueOnce(idle());
      api.acquireSystemAudioLease.mockResolvedValueOnce({
        systemAudio: preparing(),
        leaseId: LEASE_ID,
      });
      api.commitSystemAudioPublication.mockResolvedValueOnce(live());
      await refreshProSystemAudioState();
      await acquireLocalProSystemAudioLease();
      const settled = publishLocalProSystemAudio({} as MediaStreamTrack).then(
        () => 'published',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.publish).toHaveBeenCalledTimes(1);
      expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ holdMedia: true });
      if (pending === 'lan') held.resolve(HELD_DESCRIPTOR);
      if (pending === 'ordinary') {
        held.reject(new Error('HTTP 502'));
        await vi.advanceTimersByTimeAsync(0);
      }
      if (pending !== 'lan') lan.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.publish).toHaveBeenCalledTimes(pending === 'ordinary' ? 2 : 1);
      if (pending === 'ordinary') {
        expect(mocks.publish.mock.calls[1]?.[0]).not.toHaveProperty('holdMedia');
      }
      expect(mocks.releaseHold).not.toHaveBeenCalled();
      expect(api.commitSystemAudioPublication).not.toHaveBeenCalled();
      return { lan, held, ordinary, settled };
    }

    /**
     * The window's other half settles after the teardown: the held or ordinary
     * publish the stop aborted rejects, or the LAN-direct attempt fails. The
     * stale flight commits nothing and reports the supersession, not the
     * transport's abort.
     */
    async function expectStaleFlightCommitsNothing(window: {
      lan: ReturnType<typeof deferred<null>>;
      held: ReturnType<typeof deferred<typeof HELD_DESCRIPTOR>>;
      ordinary: ReturnType<typeof deferred<typeof ORDINARY_DESCRIPTOR>>;
      settled: Promise<unknown>;
    }): Promise<void> {
      const aborted = new DOMException('The operation was aborted.', 'AbortError');
      if (pending === 'held') window.held.reject(aborted);
      else if (pending === 'ordinary') window.ordinary.reject(aborted);
      else window.lan.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      // Checked before the flight settles: a stale flight that went on to an
      // ordinary publish would wait on it and never settle.
      expect(mocks.publish).toHaveBeenCalledTimes(pending === 'ordinary' ? 2 : 1);
      expect(await window.settled).toMatchObject({ code: 'OPERATION_SUPERSEDED' });
      expect(mocks.releaseHold).not.toHaveBeenCalled();
      expect(mocks.reportCommitted).not.toHaveBeenCalled();
      expect(api.commitSystemAudioPublication).not.toHaveBeenCalled();
      expect(mocks.publish).toHaveBeenCalledTimes(pending === 'ordinary' ? 2 : 1);
    }

    it('explicit stop: the same teardown as after the share, and the held fallback is never released', async () => {
      const window = await startShareInLanWindow();
      api.releaseSystemAudioLease.mockResolvedValueOnce(idle(1));
      armPublicationTimers();
      observeTeardown();

      await releaseLocalProSystemAudioLease();

      expect(armedPublicationTimers()).toEqual([]);
      expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
      expect(mocks.resetDirect.mock.calls).toEqual([
        [{ notifyPeers: true, reason: 'stopped' }],
        [{ notifyPeers: true, reason: 'superseded' }],
        [{ notifyPeers: false }],
        [{ notifyPeers: false }],
      ]);
      expect(leaseLossReasons).toEqual([]);
      await expectStaleFlightCommitsNothing(window);
      expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
      expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    });

    it('lease loss: the same teardown as after the share, and the held fallback is never released', async () => {
      const window = await startShareInLanWindow();
      api.getSystemAudioState.mockResolvedValueOnce(idle(2));
      armPublicationTimers();
      observeTeardown();

      await refreshProSystemAudioState();

      expect(armedPublicationTimers()).toEqual([]);
      expect(mocks.stopPublisher).toHaveBeenCalledTimes(1);
      expect(mocks.resetDirect.mock.calls).toEqual([
        [{ notifyPeers: true, reason: 'superseded' }],
        [{ notifyPeers: false }],
      ]);
      expect(leaseLossReasons).toEqual(['authoritative-revocation']);
      await expectStaleFlightCommitsNothing(window);
      expect(mocks.stopPublisher).toHaveBeenCalledTimes(1);
      expect(leaseLossReasons).toEqual(['authoritative-revocation']);
    });

    it('new presence incarnation: the same teardown as after the share, and the held fallback is never released', async () => {
      const window = await startShareInLanWindow();
      armPublicationTimers();
      observeTeardown();

      bindProSystemAudioSession(snapshot('presence_local_02'));

      expect(armedPublicationTimers()).toEqual([]);
      expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
      expect(mocks.resetDirect.mock.calls).toEqual([
        [{ notifyPeers: false }],
        [{ notifyPeers: true, reason: 'superseded' }],
      ]);
      expect(leaseLossReasons).toEqual(['session-changed']);
      await expectStaleFlightCommitsNothing(window);
      expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
      expect(leaseLossReasons).toEqual(['session-changed']);
    });

    it('service reset: the same teardown as after the share, and the held fallback is never released', async () => {
      const window = await startShareInLanWindow();
      armPublicationTimers();
      observeTeardown();

      resetProSystemAudioService();

      expect(armedPublicationTimers()).toEqual([]);
      expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
      expect(mocks.resetDirect.mock.calls).toEqual([
        [{ notifyPeers: false }],
        [{ notifyPeers: true, reason: 'superseded' }],
      ]);
      expect(leaseLossReasons).toEqual(['reset']);
      await expectStaleFlightCommitsNothing(window);
      expect(mocks.stopPublisher).toHaveBeenCalledTimes(2);
      expect(leaseLossReasons).toEqual(['reset']);
    });

    it('leaving the PRO room context: keeps the SFU publisher, then commits its publication as the sequential publish would', async () => {
      const window = await startShareInLanWindow();
      armPublicationTimers();
      observeTeardown();

      mocks.roomContextKind = 'standard';
      bus.emit('state:room.context', { kind: 'standard' } as never, { kind: 'pro' } as never);

      expect(armedPublicationTimers()).toEqual([...PUBLICATION_TIMERS]);
      expect(mocks.stopPublisher).not.toHaveBeenCalled();
      expect(mocks.resetDirect.mock.calls).toEqual([[{ notifyPeers: false }]]);
      expect(leaseLossReasons).toEqual([]);

      // The window's other half settles: the reset LAN-direct transport fails
      // the attempt, or the kept held or ordinary publish is prepared.
      if (pending === 'held') window.held.resolve(HELD_DESCRIPTOR);
      else if (pending === 'ordinary') window.ordinary.resolve(ORDINARY_DESCRIPTOR);
      else window.lan.resolve(null);
      expect(await window.settled).toBe('published');
      expect(api.commitSystemAudioPublication).toHaveBeenCalledTimes(1);
      if (pending === 'ordinary') {
        // 9.0.27's ordinary publish reported itself; there is no hold to release.
        expect(mocks.releaseHold).not.toHaveBeenCalled();
        expect(mocks.reportCommitted).not.toHaveBeenCalled();
        expect(api.commitSystemAudioPublication.mock.calls[0]?.[0]).toMatchObject({
          publication: { sessionId: 'realtime_session_02' },
        });
      } else {
        expect(mocks.releaseHold).toHaveBeenCalledTimes(1);
        expect(mocks.reportCommitted.mock.calls).toEqual([[HELD_DESCRIPTOR]]);
      }
      expect(mocks.stopPublisher).not.toHaveBeenCalled();
      expect(mocks.publish).toHaveBeenCalledTimes(pending === 'ordinary' ? 2 : 1);
    });
  },
);
