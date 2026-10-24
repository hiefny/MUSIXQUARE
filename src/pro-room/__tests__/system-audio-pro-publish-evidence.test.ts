/**
 * @vitest-environment jsdom
 *
 * PRO sharer side of the system-audio device evidence, Phase 5 prep T2 and T3.
 * Driven through the real service, controller and PRO SFU publisher; not
 * matched in source text.
 *
 * T3: the sharer lines the Phase 5 device criteria use to tell a PRO attempt's
 * first route from the sharer's /debug console file alone (`?mxqrLog=info`),
 * with their exact text, argument count and log level. Every SFU publication,
 * a first SFU publish and a promotion alike, logs `[ProSysAudioSFU] Published
 * generation N` from publishProSystemAudioSfu; a promotion also logs
 * `[PRO SystemAudio] Promoted LAN-direct publication to SFU (<reason>)`, with
 * ", reconciled" when the commit response was lost; a LAN-direct publication
 * that stays direct logs neither (the "direct (presumed)" verdict).
 *
 * T2: the PRO SFU publisher's music sender tuning, which C4-1 moves into
 * system-audio-media.ts: the capture track is asked once for exactly
 * {echoCancellation, noiseSuppression, autoGainControl: false}, the sender
 * carries one 256 kbps encoding, and neither step can fail the publication.
 * The PRO LAN-direct publisher's (bitrate only, no constraints) is pinned in
 * src/network/__tests__/pro-system-audio-direct.test.ts.
 *
 * Replaced, all native or transport seams: RTCPeerConnection and the Cloudflare
 * Realtime and TURN API behind fetchWithCapability
 * (__helpers__/system-audio-publisher-natives.ts); the room API's system-audio
 * endpoints (lease, commit, state, heartbeat); the PRO LAN-direct transport
 * (the receive harness's calibrated fake, whose publish attempt each test sets
 * and whose publisher route fallback a test raises); the chat notice. The log
 * is spied, not replaced. Each test pins main bd94075c, whose system-audio code
 * is the 9.0.7 runtime. Room codes and ids are synthetic.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { ProRoomApiClient } from '../api.ts';
import type {
  ProRoomSnapshot,
  ProRoomSystemAudioPublication,
  ProRoomSystemAudioState,
} from '../contracts.ts';
import {
  acquireLocalProSystemAudioLease,
  bindProSystemAudioSession,
  configureProSystemAudioService,
  publishLocalProSystemAudio,
  refreshProSystemAudioState,
  registerProSystemAudioServiceListeners,
  resetProSystemAudioService,
} from '../system-audio-service.ts';
import {
  PublisherPeerConnection,
  makeCaptureTrack,
  publisherRealtime,
  type CaptureTrack,
} from '../../network/__tests__/__helpers__/system-audio-publisher-natives.ts';
import {
  FakeMediaStream,
  proDirect,
} from '../../network/__tests__/__helpers__/system-audio-receive-harness.ts';

vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../audio/context.ts', () => ({ getAudioContext: () => null }));
vi.mock('../../audio/engine.ts', () => ({ initAudio: async () => {}, getWidener: () => null }));
vi.mock('../../player/transport.ts', () => ({ stopAllMedia: () => {} }));
vi.mock('../../core/capability.ts', async () => {
  const { publisherRealtime: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-publisher-natives.ts');
  return {
    fetchWithCapability: fake.fetchWithCapability,
    isCapabilityChallengeCancelled: () => false,
  };
});
vi.mock('../../network/standard-room-prerequisites.ts', () => ({
  getStandardRoomTurnCredentials: async () => null,
}));
vi.mock('../../audio/system-capture.ts', () => ({
  getCapturedAudioStream: () => null,
  isSystemAudioActive: () => false,
}));
vi.mock('../../chat/protocol.ts', () => ({ broadcastSystemMessage: vi.fn() }));
vi.mock(
  '../../network/pro-system-audio-direct.ts',
  async () =>
    (await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts')).proDirect
      .module,
);

const ROOM_CODE = '000001';
const LOCAL_ID = 'participant_00001';
const REMOTE_ID = 'participant_00002';
const LEASE_ID = 'L'.repeat(43);
const GENERATION = 2;
const LIVE_EXPIRES_AT = 1_900_007_200_000;
// The publisher's TURN read and its two Realtime calls each answer on the next
// macrotask; the commit and the direct-transport fakes answer in microtasks.
const PUBLISH_SETTLE_MS = 10;

const PUBLISHED = `[ProSysAudioSFU] Published generation ${GENERATION}`;
const promoted = (detail: string) =>
  `[PRO SystemAudio] Promoted LAN-direct publication to SFU (${detail})`;
const MUSIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const SHARER_LINE = /\[ProSysAudioSFU\] Published generation|Promoted LAN-direct publication/u;
const SFU_PREFIX = /\[ProSysAudioSFU\]/u;

type Level = 'debug' | 'info' | 'warn' | 'error';
type Line = [Level, ...unknown[]];
type DirectAttempt = Mock<
  (options: { publicationId: string }) => Promise<ProRoomSystemAudioPublication | null>
>;

const api = {
  getSystemAudioState: vi.fn<() => Promise<ProRoomSystemAudioState>>(),
  acquireSystemAudioLease:
    vi.fn<() => Promise<{ systemAudio: ProRoomSystemAudioState; leaseId: string }>>(),
  commitSystemAudioPublication:
    vi.fn<
      (request: { publication: ProRoomSystemAudioPublication }) => Promise<ProRoomSystemAudioState>
    >(),
  heartbeatSystemAudioLease: vi.fn<() => Promise<ProRoomSystemAudioState>>(),
  releaseSystemAudioLease: vi.fn<() => Promise<ProRoomSystemAudioState>>(),
};
const attemptDirect = proDirect.module
  .attemptProSystemAudioDirectPublication as unknown as DirectAttempt;
const reconcileDirect = proDirect.module.reconcileProSystemAudioDirectTargets as unknown as Mock<
  () => Promise<boolean>
>;

let lines: Line[] = [];
let track: CaptureTrack;

function matching(pattern: RegExp): Line[] {
  return lines.filter(([, first]) => typeof first === 'string' && pattern.test(first));
}
/** Every sharer line the device criteria read, at whatever level it was logged. */
const evidence = () => matching(SHARER_LINE);

function snapshot(): ProRoomSnapshot {
  return {
    roomCode: ROOM_CODE,
    status: 'active',
    viewer: {
      participantId: LOCAL_ID,
      presenceIncarnationId: 'presence_0000000001',
      capabilities: ['playback.control'],
    },
    presence: {
      coordinatorEpoch: 1,
      participants: [
        { participantId: LOCAL_ID, displayName: 'Sharer', joinedAtMs: 1 },
        { participantId: REMOTE_ID, displayName: 'Listener', joinedAtMs: 2 },
      ],
    },
  } as unknown as ProRoomSnapshot;
}

function idle(generation: number): ProRoomSystemAudioState {
  return {
    generation,
    status: 'idle',
    ownerParticipantId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

function preparing(): ProRoomSystemAudioState {
  return {
    generation: GENERATION,
    status: 'preparing',
    ownerParticipantId: LOCAL_ID,
    claimExpiresAt: LIVE_EXPIRES_AT,
    liveExpiresAt: null,
    publication: null,
  };
}

function localLive(publication: ProRoomSystemAudioPublication): ProRoomSystemAudioState {
  return {
    generation: GENERATION,
    status: 'live',
    ownerParticipantId: LOCAL_ID,
    claimExpiresAt: null,
    liveExpiresAt: LIVE_EXPIRES_AT,
    publication,
  };
}

const directDescriptor = (options: { publicationId: string }): ProRoomSystemAudioPublication => ({
  publicationId: options.publicationId,
  transport: 'lan-direct',
  protocolVersion: 2,
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const publisherSender = () => PublisherPeerConnection.instances[0]?.senders[0];
const committed = () =>
  api.commitSystemAudioPublication.mock.calls.map(([request]) => request.publication);

/** The sharer takes the lease and publishes its capture track. */
async function share(): Promise<void> {
  api.getSystemAudioState.mockResolvedValue(idle(GENERATION - 1));
  await refreshProSystemAudioState();
  await acquireLocalProSystemAudioLease();
  const published = publishLocalProSystemAudio(track);
  await advance(PUBLISH_SETTLE_MS);
  await published;
}

/**
 * The sharer publishes on LAN-direct, then the listener's route fails and its
 * fallback close reaches the publisher transport, which hands the publication
 * to the SFU (pro-system-audio-direct.ts notifyPublisherFallback).
 */
async function shareDirectThenListenerFallsBack(): Promise<void> {
  attemptDirect.mockImplementation(async (options) => directDescriptor(options));
  await share();
  expect(evidence()).toEqual([]);
  const [direct] = committed();
  proDirect.callbacks?.onLiveRouteFallback({
    role: 'publisher',
    reason: 'receiver-requested-fallback',
    participantId: REMOTE_ID,
    generation: GENERATION,
    publicationId: direct!.publicationId,
  });
  await advance(PUBLISH_SETTLE_MS);
}

beforeAll(() => {
  configureProSystemAudioService(api as unknown as ProRoomApiClient, async () => true);
  registerProSystemAudioServiceListeners();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', PublisherPeerConnection);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  PublisherPeerConnection.reset();
  publisherRealtime.reset();
  proDirect.reset();
  attemptDirect.mockReset().mockResolvedValue(null);
  reconcileDirect.mockReset().mockResolvedValue(true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.acquireSystemAudioLease.mockResolvedValue({ systemAudio: preparing(), leaseId: LEASE_ID });
  api.commitSystemAudioPublication.mockImplementation(async (request) =>
    localLive(request.publication),
  );
  // The lease heartbeat (every 15 s) sees the last publication the sharer sent.
  api.heartbeatSystemAudioLease.mockImplementation(async () => {
    const last = committed().at(-1);
    return last ? localLive(last) : preparing();
  });
  resetState();
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    epoch: 1,
    role: 'member',
    coordinatorId: null,
    snapshotRevision: 1,
    capabilities: [],
  });
  resetProSystemAudioService();
  bindProSystemAudioSession(snapshot());
  track = makeCaptureTrack();
  lines = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      lines.push([level, ...args]);
    });
  }
});

afterEach(() => {
  resetProSystemAudioService();
  bus.emit('system-audio:force-stop');
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PRO sharer device evidence lines', () => {
  it('first route SFU: logs only the published line, at info, with the lease generation', async () => {
    await share();
    expect(committed()).toEqual([
      {
        publicationId: expect.any(String),
        sessionId: 'publisher_session_1',
        track: expect.any(Object),
      },
    ]);
    expect(evidence()).toEqual([['info', PUBLISHED]]);
  });

  it('first route LAN-direct that stays direct: logs no [ProSysAudioSFU] line and no promotion line', async () => {
    attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    await share();
    expect(committed()).toEqual([expect.objectContaining({ transport: 'lan-direct' })]);
    expect(reconcileDirect).toHaveBeenCalled();
    await advance(60_000);
    expect(evidence()).toEqual([]);
    expect(matching(SFU_PREFIX)).toEqual([]);
    expect(publisherRealtime.count('new-session')).toBe(0);
  });

  it('promotion: logs the published line, then the promotion line with its reason, both at info', async () => {
    await shareDirectThenListenerFallsBack();

    expect(committed()).toEqual([
      expect.objectContaining({ transport: 'lan-direct' }),
      expect.objectContaining({ sessionId: 'publisher_session_1' }),
    ]);
    expect(evidence()).toEqual([
      ['info', PUBLISHED],
      ['info', promoted('receiver-requested-fallback')],
    ]);
  });

  it('promotion whose commit response is lost: the promotion line ends in ", reconciled"', async () => {
    api.commitSystemAudioPublication
      .mockImplementationOnce(async (request) => localLive(request.publication))
      .mockImplementationOnce(async (request) => {
        // The server committed the promotion; only its response is lost.
        api.getSystemAudioState.mockResolvedValue(localLive(request.publication));
        throw new TypeError('Failed to fetch');
      });
    await shareDirectThenListenerFallsBack();

    expect(committed()).toHaveLength(2);
    expect(evidence()).toEqual([
      ['info', PUBLISHED],
      ['info', promoted('receiver-requested-fallback, reconciled')],
    ]);
  });
});

describe('PRO SFU publisher music sender tuning (T2)', () => {
  it('asks the capture track once for the music constraints and sends one 256 kbps encoding', async () => {
    await share();

    expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
    const sender = publisherSender();
    expect(sender?.track).toBe(track);
    expect(sender?.setParameters).toHaveBeenCalledTimes(1);
    expect(sender?.setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 256_000 }] });
    expect(sender?.applied).toEqual({ encodings: [{ maxBitrate: 256_000 }] });
  });

  it('a promotion tunes its new SFU sender the same way', async () => {
    await shareDirectThenListenerFallsBack();

    expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
    expect(publisherSender()?.applied).toEqual({ encodings: [{ maxBitrate: 256_000 }] });
  });

  // A rejection the publisher left unhandled would fail the run as an
  // unhandled error even though the assertions below pass.
  it.each(['reject', 'throw'] as const)(
    'still publishes and still sets the bitrate when applyConstraints would %s',
    async (how) => {
      track.refuseConstraints(how);
      await share();

      expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
      expect(publisherSender()?.applied).toEqual({ encodings: [{ maxBitrate: 256_000 }] });
      expect(evidence()).toEqual([['info', PUBLISHED]]);
      expect(committed()).toHaveLength(1);
    },
  );

  it('still publishes with the music constraints when the sender parameters cannot be read', async () => {
    PublisherPeerConnection.onSender = (sender) =>
      sender.getParameters.mockImplementation(() => {
        throw new TypeError('getParameters is not supported');
      });
    await share();

    expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
    expect(publisherSender()?.setParameters).not.toHaveBeenCalled();
    expect(evidence()).toEqual([['info', PUBLISHED]]);
    expect(committed()).toHaveLength(1);
  });
});
