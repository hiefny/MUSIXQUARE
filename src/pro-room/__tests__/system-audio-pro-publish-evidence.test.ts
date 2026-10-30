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
 * generation N` once: a promotion when it is published, just before its
 * commit, and (since 9.0.28) a first SFU share only after the room committed
 * its released fallback. A promotion also logs `[PRO SystemAudio] Promoted
 * LAN-direct publication to SFU (<reason>)`, with ", reconciled" when the
 * commit response was lost; a LAN-direct publication that stays direct logs
 * neither (the "direct (presumed)" verdict), and no `[ProSysAudioSFU]` line at
 * all, the rule several device criteria use. Since 9.0.28 a share with
 * LAN-direct targets prepares its SFU fallback beside the LAN-direct attempt
 * with the sender holding no track, and logs its own lines under the
 * `[PRO SystemAudio]` prefix: Prepared, Released, Closed unused, Cancelled,
 * Closed released, or failed. None matches the evidence pattern or the
 * `[ProSysAudioSFU]` prefix, so the verdict keeps its meaning.
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

/** The PRO Worker answers an SFU live with its media deadline and a LAN-direct one with null. */
function localLive(publication: ProRoomSystemAudioPublication): ProRoomSystemAudioState {
  return {
    generation: GENERATION,
    status: 'live',
    ownerParticipantId: LOCAL_ID,
    claimExpiresAt: null,
    liveExpiresAt: 'sessionId' in publication ? LIVE_EXPIRES_AT : null,
    publication,
  };
}

const directDescriptor = (options: { publicationId: string }): ProRoomSystemAudioPublication => ({
  publicationId: options.publicationId,
  transport: 'lan-direct',
  protocolVersion: 2,
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** The newest SFU sender: a promotion's own, after a held fallback that never got one. */
const publisherSender = () =>
  PublisherPeerConnection.instances.flatMap((connection) => connection.senders).at(-1);
/** The held SFU fallback's own lines (9.0.28), under the service's prefix. */
const HELD = /^\[PRO SystemAudio\] .*SFU fallback/u;
const PREPARED = new RegExp(
  `^\\[PRO SystemAudio\\] Prepared SFU fallback for generation ${GENERATION} in \\d+ ms$`,
  'u',
);
const RELEASED = new RegExp(
  `^\\[PRO SystemAudio\\] Released SFU fallback for generation ${GENERATION} \\(held \\d+ ms\\)$`,
  'u',
);
const CLOSED_BEFORE_PREPARED = new RegExp(
  `^\\[PRO SystemAudio\\] Closed unused SFU fallback for generation ${GENERATION} \\(before it was prepared, \\d+ ms after the start\\)$`,
  'u',
);
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
 * The sharer starts a share whose LAN-direct attempt settles only after the
 * held SFU fallback is prepared: it fails, or it proves the LAN pair. Returns
 * the share's error, or null when it went live.
 */
async function shareWithLanSettlingAfterPrepared(outcome: 'fails' | 'proves'): Promise<unknown> {
  api.getSystemAudioState.mockResolvedValue(idle(GENERATION - 1));
  await refreshProSystemAudioState();
  await acquireLocalProSystemAudioLease();
  let settle!: () => void;
  attemptDirect.mockImplementation(
    (options) =>
      new Promise((resolve) => {
        settle = () => resolve(outcome === 'fails' ? null : directDescriptor(options));
      }),
  );
  const published = publishLocalProSystemAudio(track).then(
    () => null,
    (error: unknown) => error,
  );
  await advance(PUBLISH_SETTLE_MS);
  expect(committed()).toEqual([]);
  settle();
  await advance(PUBLISH_SETTLE_MS);
  return published;
}

/**
 * The sharer starts a share whose LAN-direct attempt fails only after the held
 * SFU fallback settled and `meanwhile` ran (it may lose the prepared fallback).
 * Returns the share's error, or null when it went live.
 */
async function shareWithLanFailingAfter(meanwhile: () => void): Promise<unknown> {
  api.getSystemAudioState.mockResolvedValue(idle(GENERATION - 1));
  await refreshProSystemAudioState();
  await acquireLocalProSystemAudioLease();
  let fail!: () => void;
  attemptDirect.mockImplementation(
    () =>
      new Promise((resolve) => {
        fail = () => resolve(null);
      }),
  );
  const published = publishLocalProSystemAudio(track).then(
    () => null,
    (error: unknown) => error,
  );
  await advance(PUBLISH_SETTLE_MS);
  meanwhile();
  await advance(PUBLISH_SETTLE_MS);
  expect(committed()).toEqual([]);
  fail();
  await advance(PUBLISH_SETTLE_MS);
  return published;
}

/**
 * The sharer starts a share whose LAN-direct attempt proves while the held
 * SFU fallback's `action` request is still in flight (the field's common
 * case: the proof, about 0.5-1.5 s, beats a 1.7-3 s publish).
 */
async function shareWithLanProvingWhileHeld(action: 'new-session' | 'tracks-new'): Promise<void> {
  api.getSystemAudioState.mockResolvedValue(idle(GENERATION - 1));
  await refreshProSystemAudioState();
  await acquireLocalProSystemAudioLease();
  const letGo = publisherRealtime.holdNext(action);
  let settle!: () => void;
  attemptDirect.mockImplementation(
    (options) =>
      new Promise((resolve) => {
        settle = () => resolve(directDescriptor(options));
      }),
  );
  const published = publishLocalProSystemAudio(track);
  await advance(PUBLISH_SETTLE_MS);
  expect(publisherRealtime.count(action)).toBe(1);
  expect(committed()).toEqual([]);
  settle();
  await advance(PUBLISH_SETTLE_MS);
  await published;
  letGo();
  await advance(PUBLISH_SETTLE_MS);
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

  it('first route SFU: one Realtime session, the held lines, then the published line once, after the commit', async () => {
    let commitAtLine = -1;
    api.commitSystemAudioPublication.mockImplementation(async (request) => {
      commitAtLine = lines.length;
      return localLive(request.publication);
    });

    expect(await shareWithLanSettlingAfterPrepared('fails')).toBeNull();

    expect(evidence()).toEqual([['info', PUBLISHED]]);
    expect(matching(SFU_PREFIX)).toEqual([['info', PUBLISHED]]);
    expect(matching(HELD)).toEqual([
      ['info', expect.stringMatching(PREPARED)],
      ['info', expect.stringMatching(RELEASED)],
    ]);
    // Published names a committed SFU publication: it comes after the commit request.
    expect(commitAtLine).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex(([, first]) => first === PUBLISHED)).toBeGreaterThanOrEqual(
      commitAtLine,
    );
    expect(publisherRealtime.count('new-session')).toBe(1);
    expect(publisherSender()?.replaceTrack.mock.calls).toEqual([[null], [track]]);
    expect(committed()).toEqual([
      {
        publicationId: expect.any(String),
        sessionId: 'publisher_session_1',
        track: expect.any(Object),
      },
    ]);
  });

  it('first route SFU whose commit is refused: released, never published, closed with its own line', async () => {
    const refused = new Error('SYSTEM_AUDIO_INVALID_TRANSITION');
    api.commitSystemAudioPublication.mockRejectedValueOnce(refused);
    api.releaseSystemAudioLease.mockResolvedValue(idle(GENERATION));

    expect(await shareWithLanSettlingAfterPrepared('fails')).toBe(refused);

    expect(evidence()).toEqual([]);
    expect(matching(SFU_PREFIX)).toEqual([]);
    expect(matching(HELD)).toEqual([
      ['info', expect.stringMatching(PREPARED)],
      ['info', expect.stringMatching(RELEASED)],
      [
        'info',
        expect.stringMatching(
          /^\[PRO SystemAudio\] Closed released SFU fallback for generation 2 without a reported commit \(open \d+ ms\)$/u,
        ),
      ],
    ]);
    expect(PublisherPeerConnection.instances[0]?.closed).toBe(true);
  });

  // Release owner decision 2026-10-31, under the owner's delegation: a held
  // fallback already lost when LAN-direct fails leaves the share where 9.0.27
  // was at that moment, so it makes 9.0.27's one ordinary publish, which
  // reports itself just before its commit as it always did. The device
  // reading: the held failed line, then `[ProSysAudioSFU] Published`, and no
  // Released line.
  const heldFailed = (cause: string) =>
    new RegExp(
      `^\\[PRO SystemAudio\\] SFU fallback for generation ${GENERATION} failed after \\d+ ms \\(${cause}\\)$`,
      'u',
    );
  const lineIndex = (pattern: RegExp) =>
    lines.findIndex(([, first]) => typeof first === 'string' && pattern.test(first));

  it("first route SFU after the held fallback's session request failed in the LAN-direct window: its failed line, then 9.0.27's ordinary publish, published before its commit", async () => {
    let commitAtLine = -1;
    api.commitSystemAudioPublication.mockImplementation(async (request) => {
      commitAtLine = lines.length;
      return localLive(request.publication);
    });
    publisherRealtime.failNext('new-session', 502);

    const error = await shareWithLanFailingAfter(() => {
      // Lost before the LAN-direct decision, and nothing else asked for yet.
      expect(matching(HELD)).toEqual([['info', expect.stringMatching(heldFailed('Error'))]]);
      expect(publisherRealtime.requests.map((request) => request.action)).toEqual(['new-session']);
    });

    expect(error).toBeNull();
    expect(publisherRealtime.requests.map((request) => request.action)).toEqual([
      'new-session',
      'new-session',
      'tracks-new',
    ]);
    expect(committed()).toEqual([
      {
        publicationId: expect.any(String),
        sessionId: 'publisher_session_1',
        track: expect.any(Object),
      },
    ]);
    expect(matching(HELD)).toEqual([['info', expect.stringMatching(heldFailed('Error'))]]);
    expect(matching(SFU_PREFIX)).toEqual([['info', PUBLISHED]]);
    expect(evidence()).toEqual([['info', PUBLISHED]]);
    expect(lineIndex(HELD)).toBeLessThan(lineIndex(SFU_PREFIX));
    expect(lineIndex(SFU_PREFIX)).toBeLessThan(commitAtLine);
    // The ordinary sender carried the track from its offer; nothing was released.
    const [held, ordinary] = PublisherPeerConnection.instances;
    expect(held?.closed).toBe(true);
    expect(held?.senders).toEqual([]);
    expect(ordinary?.senders[0]?.track).toBe(track);
    expect(ordinary?.senders[0]?.replaceTrack).not.toHaveBeenCalled();
  });

  it("first route SFU after the held fallback lost its connection in the LAN-direct window: its lines, then 9.0.27's ordinary publish, and no recovery", async () => {
    let commitAtLine = -1;
    api.commitSystemAudioPublication.mockImplementation(async (request) => {
      commitAtLine = lines.length;
      return localLive(request.publication);
    });

    const error = await shareWithLanFailingAfter(() => {
      expect(matching(HELD)).toEqual([['info', expect.stringMatching(PREPARED)]]);
      PublisherPeerConnection.instances[0]!.setConnectionState('failed');
    });

    expect(error).toBeNull();
    expect(publisherRealtime.requests.map((request) => request.action)).toEqual([
      'new-session',
      'tracks-new',
      'tracks-close',
      'new-session',
      'tracks-new',
    ]);
    expect(committed()).toEqual([
      {
        publicationId: expect.any(String),
        sessionId: 'publisher_session_2',
        track: expect.any(Object),
      },
    ]);
    expect(matching(HELD)).toEqual([
      ['info', expect.stringMatching(PREPARED)],
      ['info', expect.stringMatching(heldFailed('connection-failed'))],
    ]);
    expect(matching(SFU_PREFIX)).toEqual([['info', PUBLISHED]]);
    expect(lineIndex(heldFailed('connection-failed'))).toBeLessThan(lineIndex(SFU_PREFIX));
    expect(lineIndex(SFU_PREFIX)).toBeLessThan(commitAtLine);
    const [held, ordinary] = PublisherPeerConnection.instances;
    expect(held?.closed).toBe(true);
    // The held sender never carried the track; the ordinary one did from its offer.
    expect(held?.senders[0]?.replaceTrack.mock.calls).toEqual([[null]]);
    expect(ordinary?.senders[0]?.track).toBe(track);
    await advance(60_000);
    expect(publisherRealtime.count('new-session')).toBe(2);
    expect(api.acquireSystemAudioLease).toHaveBeenCalledTimes(1);
    expect(committed()).toHaveLength(1);
  });

  it("9.0.27's ordinary publish refused too: the share fails with no third attempt and no published line", async () => {
    api.releaseSystemAudioLease.mockResolvedValue(idle(GENERATION));
    publisherRealtime.failNext('new-session', 502);
    publisherRealtime.failNext('new-session', 429);

    const error = await shareWithLanFailingAfter(() => undefined);

    expect(error).toBeInstanceOf(Error);
    expect(committed()).toEqual([]);
    expect(publisherRealtime.requests.map((request) => request.action)).toEqual([
      'new-session',
      'new-session',
    ]);
    expect(matching(HELD)).toEqual([['info', expect.stringMatching(heldFailed('Error'))]]);
    expect(evidence()).toEqual([]);
    expect(api.releaseSystemAudioLease).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(publisherRealtime.count('new-session')).toBe(2);
    expect(api.acquireSystemAudioLease).toHaveBeenCalledTimes(1);
  });

  it('LAN-direct proven after the fallback was prepared: no [ProSysAudioSFU] line, one held session opened and closed with no media', async () => {
    expect(await shareWithLanSettlingAfterPrepared('proves')).toBeNull();

    expect(committed()).toEqual([expect.objectContaining({ transport: 'lan-direct' })]);
    expect(reconcileDirect).toHaveBeenCalled();
    // The owner-accepted cost (2026-10-31): one publisher session that never
    // carries media, and one admission of the per-capability new-session limit.
    expect(publisherRealtime.count('new-session')).toBe(1);
    expect(
      publisherRealtime.requests.filter((request) => request.action === 'tracks-close'),
    ).toEqual([expect.objectContaining({ sessionId: 'publisher_session_1' })]);
    const held = PublisherPeerConnection.instances[0];
    expect(held?.senders[0]?.replaceTrack.mock.calls).toEqual([[null]]);
    expect(held?.closed).toBe(true);
    expect(track.constraintRequests).toEqual([]);
    expect(matching(HELD)).toEqual([
      ['info', expect.stringMatching(PREPARED)],
      [
        'info',
        expect.stringMatching(
          /^\[PRO SystemAudio\] Closed unused SFU fallback for generation 2 \(open \d+ ms\)$/u,
        ),
      ],
    ]);
    await advance(60_000);
    // The device criteria's "no [ProSysAudioSFU] line" rule for a LAN-direct pass holds.
    expect(matching(SFU_PREFIX)).toEqual([]);
    expect(evidence()).toEqual([]);
  });

  it('LAN-direct proven before the fallback requested its session: cancelled, no Realtime session or connection', async () => {
    attemptDirect.mockImplementation(async (options) => directDescriptor(options));
    await share();

    expect(committed()).toEqual([expect.objectContaining({ transport: 'lan-direct' })]);
    expect(reconcileDirect).toHaveBeenCalled();
    expect(publisherRealtime.requests).toEqual([]);
    expect(PublisherPeerConnection.instances).toEqual([]);
    expect(track.constraintRequests).toEqual([]);
    expect(matching(HELD)).toEqual([
      [
        'info',
        expect.stringMatching(
          /^\[PRO SystemAudio\] Cancelled SFU fallback for generation 2 before any Realtime session was requested \(\d+ ms after the start\)$/u,
        ),
      ],
    ]);
    await advance(60_000);
    expect(matching(SFU_PREFIX)).toEqual([]);
    expect(evidence()).toEqual([]);
  });

  it('LAN-direct proven while the fallback session request is in flight: one session requested, no tracks, closed before prepared', async () => {
    await shareWithLanProvingWhileHeld('new-session');

    expect(committed()).toEqual([expect.objectContaining({ transport: 'lan-direct' })]);
    // The session the aborted request asked for is left to Realtime to reap.
    expect(publisherRealtime.requests.map((request) => request.action)).toEqual(['new-session']);
    expect(PublisherPeerConnection.instances[0]?.senders).toEqual([]);
    expect(PublisherPeerConnection.instances[0]?.closed).toBe(true);
    expect(matching(HELD)).toEqual([['info', expect.stringMatching(CLOSED_BEFORE_PREPARED)]]);
    expect(matching(SFU_PREFIX)).toEqual([]);
    expect(evidence()).toEqual([]);
  });

  it('LAN-direct proven while the fallback track request is in flight: the requested mid is force-closed, no media', async () => {
    await shareWithLanProvingWhileHeld('tracks-new');

    expect(committed()).toEqual([expect.objectContaining({ transport: 'lan-direct' })]);
    expect(publisherRealtime.requests.map((request) => request.action)).toEqual([
      'new-session',
      'tracks-new',
      'tracks-close',
    ]);
    expect(publisherRealtime.requests.at(-1)).toMatchObject({
      sessionId: 'publisher_session_1',
      payload: { tracks: [{ mid: '0' }], force: true },
    });
    const held = PublisherPeerConnection.instances[0];
    expect(held?.senders[0]?.replaceTrack.mock.calls).toEqual([[null]]);
    expect(held?.closed).toBe(true);
    expect(track.constraintRequests).toEqual([]);
    expect(matching(HELD)).toEqual([['info', expect.stringMatching(CLOSED_BEFORE_PREPARED)]]);
    expect(matching(SFU_PREFIX)).toEqual([]);
    expect(evidence()).toEqual([]);
  });

  it('promotion: logs the published line, then the promotion line with its reason, both at info', async () => {
    await shareDirectThenListenerFallsBack();

    // The promotion's own session: the newest, after any held fallback's.
    expect(committed()).toEqual([
      expect.objectContaining({ transport: 'lan-direct' }),
      expect.objectContaining({
        sessionId: `publisher_session_${publisherRealtime.count('new-session')}`,
      }),
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

  // The two encoding-list edges C4-1 must carry into system-audio-media.ts:
  // a missing list becomes one 256 kbps encoding, and a sender that lists no
  // encoding is left alone (the LAN-direct publisher still sets those
  // parameters back; src/network/__tests__/pro-system-audio-direct.test.ts).
  it.each([
    {
      name: 'without an encoding list',
      parameters: {} as Partial<RTCRtpSendParameters>,
      set: [{ maxBitrate: 256_000 }],
    },
    {
      name: 'that lists no encoding',
      parameters: { encodings: [] } as Partial<RTCRtpSendParameters>,
      set: null,
    },
  ])('tunes a sender $name as before and still publishes', async ({ parameters, set }) => {
    PublisherPeerConnection.onSender = (sender) =>
      sender.getParameters.mockImplementation(
        () => structuredClone(parameters) as RTCRtpSendParameters,
      );
    await share();

    expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
    const sender = publisherSender();
    if (set === null) {
      expect(sender?.setParameters).not.toHaveBeenCalled();
    } else {
      expect(sender?.setParameters).toHaveBeenCalledTimes(1);
      expect(sender?.setParameters).toHaveBeenCalledWith({ encodings: set });
    }
    expect(evidence()).toEqual([['info', PUBLISHED]]);
    expect(committed()).toHaveLength(1);
  });
});
