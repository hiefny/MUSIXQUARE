/**
 * @vitest-environment jsdom
 *
 * C4-0 owner-boundary contract for the device-wide system-audio receive slot on
 * the PRO routes, driven through the real PRO transports. The first PRO suite
 * (system-audio-receive-slot-pro-contract.test.ts) replaces both transports
 * with calibrated fakes; this one runs network/pro-system-audio-sfu.ts and
 * network/pro-system-audio-direct.ts for real, so the rows below pin what only
 * the transports decide: when a subscriber exposes its track, the playout hint
 * per route, the subscriber's own live-budget expiry (the PRO two-hour budget
 * and its re-publication case), real ICE state handling, the LAN locality
 * proof, the transport's 5 s track-ready deadline next to the coordinator's
 * 30 s one, route supersession by generation, the signals a listener sends its
 * publisher, S8b on both routes, LAN-direct begin re-entrancy, iOS initAudio
 * rejection, the transports' own attach fences for a same-publication route
 * retirement (the SFU subscriber epoch and the LAN receiver route, C4-9 and
 * P5-D8), adopt idempotence (also while an attach waits), the retire paths and
 * the /debug sections.
 *
 * Registry records (docs/design/resource-ownership-registry.md):
 * - RO-04 System-audio receive slot (placeholder, receiving flag, restore meta,
 *   source on widener.input, decoder primer, receive deadline per route).
 * - RO-20 PRO system-audio lease and publication, only as the publication a
 *   listener receives (and one local sharing claim for re-entrancy).
 * - RO-21 PRO checkpoint re-apply: only whether the post-share restore is asked
 *   for (the restore callback the runtime passes in).
 *
 * Real: pro-room/system-audio-service.ts with its controller, the PRO SFU and
 * LAN-direct transports, network/system-audio-guest.ts (placeholder, trusted
 * boundary, cleanup), network/system-audio-sfu.ts (the Standard route the PRO
 * service retires), player/ownership, core/state, bus, managed timers, the
 * decoder primer and pro-room/realtime-sender.ts (bound to a capture port).
 *
 * Replaced, all native seams: RTCPeerConnection and the PRO room socket's
 * inbound relay (__helpers__/pro-system-audio-transport-natives.ts); Web Audio,
 * media teardown, MediaStream and the Cloudflare Realtime and TURN API behind
 * fetchWithCapability (__helpers__/system-audio-receive-harness.ts); the room
 * API's GET /system-audio; the Standard TURN loader; the local capture module
 * (inactive) and the chat notice (publisher side only).
 *
 * Assertions read state, toasts, bus emissions, the Web Audio ledger, peer
 * connections, Realtime requests and sent signals, never timer names. Each test
 * pins main be82ce09 (9.0.7). Rows named "expected today" pin behaviour a C4
 * increment might be tempted to change; their comments say which.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  getSystemAudioGuestDebugSnapshot,
  registerSystemAudioGuestListeners,
} from '../../network/system-audio-guest.ts';
import {
  getSystemAudioSfuDebugSnapshot,
  registerSystemAudioSfuListeners,
} from '../../network/system-audio-sfu.ts';
import {
  claimPlaybackOwner,
  createFileTrackMeta,
  createSystemAudioTrackMeta,
} from '../../player/ownership.ts';
import type { ProRoomApiClient } from '../api.ts';
import type {
  ProRoomSnapshot,
  ProRoomSystemAudioPublication,
  ProRoomSystemAudioState,
} from '../contracts.ts';
import { bindProRoomRealtimeSender } from '../realtime-sender.ts';
import {
  acceptProSystemAudioHeartbeatState,
  bindProSystemAudioSession,
  configureProSystemAudioService,
  refreshProSystemAudioState,
  registerProSystemAudioServiceListeners,
  resetProSystemAudioService,
  resetProSystemAudioSubscriberRetry,
} from '../system-audio-service.ts';
import {
  ProTransportPeerConnection,
  proRelay,
  sendLanCandidate,
  sendLanClose,
  sendLanMediaOffer,
  sendLanProbeOffer,
  type LanPublisherRoute,
} from '../../network/__tests__/__helpers__/pro-system-audio-transport-natives.ts';
import {
  installNativeGlobals,
  media,
  observeReceiveBoundary,
  primerElements,
  realtime,
  resetNativeFakes,
  webAudio,
  type ReceiveObservations,
} from '../../network/__tests__/__helpers__/system-audio-receive-harness.ts';

vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../audio/context.ts', async () => {
  const { webAudio: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts');
  return { getAudioContext: () => fake.context };
});
vi.mock('../../audio/engine.ts', async () => {
  const { webAudio: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts');
  return { initAudio: fake.initAudio, getWidener: fake.getWidener };
});
vi.mock('../../player/transport.ts', async () => {
  const { media: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts');
  return { stopAllMedia: fake.stopAllMedia };
});
vi.mock('../../core/capability.ts', async () => {
  const { realtime: fake } =
    await import('../../network/__tests__/__helpers__/system-audio-receive-harness.ts');
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
  '../network-bridge.ts',
  async () =>
    (await import('../../network/__tests__/__helpers__/pro-system-audio-transport-natives.ts'))
      .proRelay.module,
);

const ROOM_CODE = '000001';
const LOCAL_ID = 'participant_00001';
const REMOTE_ID = 'participant_00002';
const PUBLICATION_ID = 'publication_00001';
// The real PRO subscriber reads TURN, then new-session and tracks-new, each at
// the Realtime fake's 100 ms: the subscriber offer exposes the track at
// 300 ms, and renegotiate completes the subscription at 400 ms.
const PRO_TRACK_AT_MS = 300;
const PRO_SUBSCRIBED_AT_MS = 400;
// The coordinator's first SFU re-subscribe delay (service RECOVERY_DELAY_MS).
const RETRY_MS = 2_500;
// A fixed live budget well past the fake clock.
const LIVE_EXPIRES_AT = 1_900_007_200_000;
// The server's live budget equals the client share limit (two hours).
const LIVE_TTL_MS = SYSTEM_AUDIO_SHARE_LIMIT_MS;

const api = { getSystemAudioState: vi.fn<() => Promise<ProRoomSystemAudioState>>() };
const restorePlayback = vi.fn(async () => true);

let previousTitle: string | undefined;
let seen: ReceiveObservations;

function snapshot(): ProRoomSnapshot {
  return {
    roomCode: ROOM_CODE,
    status: 'active',
    viewer: { participantId: LOCAL_ID, presenceIncarnationId: 'presence_0000000001' },
    presence: {
      coordinatorEpoch: 1,
      participants: [
        { participantId: LOCAL_ID, displayName: 'Listener' },
        { participantId: REMOTE_ID, displayName: 'Sharer' },
      ],
    },
  } as ProRoomSnapshot;
}

const sfuPublication = (
  publicationId = PUBLICATION_ID,
  sessionId = 'realtime_session_01',
): ProRoomSystemAudioPublication => ({
  publicationId,
  sessionId,
  track: { trackName: `audio-stereo-${sessionId}`, mid: '0' },
});
const directPublication = (publicationId = PUBLICATION_ID): ProRoomSystemAudioPublication => ({
  publicationId,
  transport: 'lan-direct',
  protocolVersion: 2,
});

function live(
  publication: ProRoomSystemAudioPublication,
  generation = 1,
  ownerParticipantId = REMOTE_ID,
  liveExpiresAt = LIVE_EXPIRES_AT,
): ProRoomSystemAudioState {
  return {
    generation,
    status: 'live',
    ownerParticipantId,
    claimExpiresAt: null,
    liveExpiresAt,
    publication,
  };
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

function proContext() {
  return {
    kind: 'pro' as const,
    roomId: ROOM_CODE,
    epoch: 1,
    role: 'member' as const,
    coordinatorId: null,
    snapshotRevision: 1,
    capabilities: [],
  };
}

/** The coordinator's authenticated GET returns `state`. */
async function applyState(state: ProRoomSystemAudioState): Promise<void> {
  api.getSystemAudioState.mockResolvedValue(state);
  await refreshProSystemAudioState();
  await vi.advanceTimersByTimeAsync(0);
}

function slot() {
  const meta = getState('player.currentTrackMeta');
  return {
    receiving: getState('systemAudio.isReceiving'),
    mode: getState('playback.mode'),
    activity: getState('playback.activity'),
    title: meta?.title,
    placeholder: meta?.systemAudioMode === 'receiving',
    sources: webAudio.connectedTrackIds(),
    primers: primerElements().length,
  };
}

function idleWithPreviousTitle() {
  return {
    receiving: false,
    mode: null,
    activity: 'idle',
    title: previousTitle,
    placeholder: false,
    sources: [],
    primers: 0,
  };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const sfuConnections = () => ProTransportPeerConnection.of('sfu');
const lanConnections = () => ProTransportPeerConnection.of('lan');

function lanRoute(overrides: Partial<LanPublisherRoute> = {}): LanPublisherRoute {
  return {
    roomCode: ROOM_CODE,
    ownerParticipantId: REMOTE_ID,
    targetParticipantId: LOCAL_ID,
    generation: 1,
    publicationId: PUBLICATION_ID,
    negotiationId: 'negotiation_000000000001',
    ...overrides,
  };
}

/** The remote LAN-direct publisher negotiates its route and offers its track. */
async function lanPublisherDelivers(
  route = lanRoute(),
  trackId = 'direct-audio-1',
  options: { withTrack?: boolean } = {},
): Promise<void> {
  sendLanProbeOffer(route);
  await advance(0);
  sendLanCandidate(route);
  await advance(0);
  sendLanMediaOffer(route, trackId, options);
  await advance(0);
}

const routes = [
  {
    route: 'SFU',
    state: () => live(sfuPublication()),
    deliver: async () => {
      await applyState(live(sfuPublication()));
      await advance(PRO_SUBSCRIBED_AT_MS);
    },
    connections: sfuConnections,
    tracksClosed: 1,
  },
  {
    route: 'LAN-direct',
    state: () => live(directPublication()),
    deliver: async () => {
      await applyState(live(directPublication()));
      await lanPublisherDelivers();
    },
    connections: lanConnections,
    tracksClosed: 0,
  },
];

beforeAll(() => {
  registerSystemAudioGuestListeners();
  registerSystemAudioSfuListeners();
  configureProSystemAudioService(api as unknown as ProRoomApiClient, restorePlayback);
  registerProSystemAudioServiceListeners();
});

beforeEach(() => {
  vi.useFakeTimers();
  installNativeGlobals();
  vi.stubGlobal('RTCPeerConnection', ProTransportPeerConnection);
  resetNativeFakes();
  ProTransportPeerConnection.reset();
  proRelay.reset();
  bindProRoomRealtimeSender(proRelay.send);
  resetState();
  restorePlayback.mockClear();
  // The listener was playing a local file before the share started.
  claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('previous-track.mp3') });
  previousTitle = getState('player.currentTrackMeta')?.title;
  // The PRO bridge runs the media engine as a local 'host' with no host socket.
  setState('network.appRole', 'host');
  setState('room.context', proContext());
  resetProSystemAudioService();
  bindProSystemAudioSession(snapshot());
  seen = observeReceiveBoundary();
});

afterEach(() => {
  resetProSystemAudioService();
  bus.emit('system-audio:force-stop');
  seen.dispose();
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('PRO SFU reception through the real subscriber', () => {
  it('S5: the track attaches as soon as the subscriber offer exposes it, with the 0.5 s playout hint; the share end closes the session and its tracks', async () => {
    await applyState(live(sfuPublication()));
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });
    await advance(PRO_TRACK_AT_MS - 1);
    expect(slot().receiving).toBe(false);

    await advance(1);
    // Receiving starts before renegotiate answers and before 'subscribed'.
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['sfu-audio-1'],
      primers: 1,
    });
    expect(sfuConnections()[0].receivers.map((receiver) => receiver.playoutDelayHint)).toEqual([
      0.5,
    ]);
    expect(seen.counts.visualizerStarts).toBe(1);
    await advance(PRO_SUBSCRIBED_AT_MS - PRO_TRACK_AT_MS);
    // One TURN read (no action), then the three subscription calls.
    expect(realtime.requests.map((request) => request.action)).toEqual([
      undefined,
      'new-session',
      'tracks-new',
      'renegotiate',
    ]);
    expect(slot()).toMatchObject({ receiving: true, activity: 'playing' });

    await applyState(idle(2));
    expect(slot()).toEqual(idleWithPreviousTitle());
    expect(sfuConnections()[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(restorePlayback).toHaveBeenCalledTimes(1);
    expect(seen.toasts).toEqual([]);
  });

  it('S5 (real ICE): a disconnect drops receiving after 2.5 s but keeps the source; reconnecting restores receiving on the same session', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_SUBSCRIBED_AT_MS);
    const [pc] = sfuConnections();

    pc.setConnectionState('disconnected');
    await advance(RETRY_MS - 1);
    expect(slot().receiving).toBe(true);
    await advance(1);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: ['sfu-audio-1'],
      primers: 1,
    });

    pc.setConnectionState('connected');
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      sources: ['sfu-audio-1'],
    });
    expect(realtime.count('new-session')).toBe(1);
    expect(webAudio.maxConnected).toBe(1);
    expect(seen.toasts).toEqual([]);
  });

  it('a live ICE failure closes the session and its tracks, drops the source with one notice, keeps the placeholder and re-subscribes on a new session after 2.5 s', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_SUBSCRIBED_AT_MS);

    sfuConnections()[0].setConnectionState('failed');
    await advance(0);
    expect(sfuConnections()[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);

    await advance(RETRY_MS - 1);
    expect(realtime.count('new-session')).toBe(1);
    await advance(1 + PRO_TRACK_AT_MS);
    expect(realtime.count('new-session')).toBe(2);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['sfu-audio-2'],
      primers: 1,
    });
    expect(webAudio.maxConnected).toBe(1);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
  });

  it('expected today, two-hour budget re-publication case: after a direct-to-SFU promotion the subscriber expires at the promotion budget; the expiry reaches the slot only at the next heartbeat, as one notice and a no-network retry loop', async () => {
    const committedAt = Date.now();
    await applyState(live(directPublication(), 1, REMOTE_ID, committedAt + LIVE_TTL_MS));
    await advance(20_000);
    // The promotion installs a fresh live budget (pro-room-worker.ts).
    const promotedAt = Date.now();
    await applyState(live(sfuPublication(), 1, REMOTE_ID, promotedAt + LIVE_TTL_MS));
    await advance(PRO_SUBSCRIBED_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-audio-1'] });

    // The direct commit's budget passes without effect.
    await advance(committedAt + LIVE_TTL_MS - Date.now());
    expect(sfuConnections()[0].closed).toBe(false);
    expect(realtime.count('tracks-close')).toBe(0);

    await advance(promotedAt + LIVE_TTL_MS - 1 - Date.now());
    expect(sfuConnections()[0].closed).toBe(false);
    await advance(1);
    // The subscriber stops itself at the promotion's budget and emits only a
    // 'stopped' event, which the coordinator does not handle: the slot keeps
    // playing a source whose transport is gone. C4-5 must decide whether the
    // slot hears this (an interrupt or end), and label it.
    expect(sfuConnections()[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['sfu-audio-1'],
      primers: 1,
    });
    expect(seen.toasts).toEqual([]);

    // A presence heartbeat reconciles the unchanged, now expired publication.
    // The subscribe is refused before any request, which the coordinator
    // treats as a failed attempt: one notice, the source detached, the
    // placeholder kept, and a backed-off retry that fails the same way
    // without network until the share ends.
    bindProSystemAudioSession(snapshot());
    await advance(0);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    const requestsBefore = realtime.requests.length;
    await advance(120_000);
    expect(realtime.requests.length).toBe(requestsBefore);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(slot()).toMatchObject({ activity: 'pending', placeholder: true });

    await applyState(idle(2));
    expect(slot()).toEqual(idleWithPreviousTitle());
    expect(restorePlayback).toHaveBeenCalledTimes(1);
  });

  it('deadlines: the re-subscribe backoff doubles from 2.5 s to 30 s under one notice and one placeholder, and a control-channel reconnect restarts it at 2.5 s', async () => {
    // Six attempts fail at new-session (100 ms after their TURN read).
    for (let attempt = 0; attempt < 6; attempt += 1) realtime.injectFault('new-session', 'fail');
    const t0 = Date.now();
    const sessionsAt = async (offset: number) => {
      await advance(t0 + offset - Date.now());
      return realtime.count('new-session');
    };
    await applyState(live(sfuPublication()));

    // Each failure (200 ms into its attempt) schedules the next attempt
    // 2.5, 5, 10, 20 and then 30 s later; the PRO coordinator keeps this
    // backoff in the C4 design.
    const schedule: Array<[number, number]> = [];
    for (const offset of [
      99, 100, 2_799, 2_800, 7_999, 8_000, 18_199, 18_200, 38_399, 38_400, 68_599, 68_600,
    ]) {
      schedule.push([offset, await sessionsAt(offset)]);
    }
    expect(schedule).toEqual([
      [99, 0],
      [100, 1],
      [2_799, 1],
      [2_800, 2],
      [7_999, 2],
      [8_000, 3],
      [18_199, 3],
      [18_200, 4],
      [38_399, 4],
      [38_400, 5],
      [68_599, 5],
      [68_600, 6],
    ]);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.receiveTimeouts).toBe(0);

    // The seventh attempt waits until 98.7 s. The room's control channel
    // reconnects at 80 s (runtime: resetProSystemAudioSubscriberRetry), which
    // restarts the backoff, so it runs 2.5 s later and attaches.
    await advance(t0 + 80_000 - Date.now());
    resetProSystemAudioSubscriberRetry();
    expect(await sessionsAt(82_599)).toBe(6);
    expect(await sessionsAt(82_600)).toBe(7);
    await advance(t0 + 82_500 + PRO_TRACK_AT_MS - Date.now());
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['sfu-audio-7'],
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
  });

  it('expected today: a new publication after a successor replaced the pending placeholder begins again over the successor, whose title becomes the restore point', async () => {
    await applyState(live(sfuPublication()));
    claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') });
    await advance(PRO_SUBSCRIBED_AT_MS);
    // The first track waits at the trusted boundary (no placeholder) while
    // its subscription stays open.
    expect(slot()).toMatchObject({ mode: 'file', title: 'successor', sources: [] });
    expect(sfuConnections()[0].closed).toBe(false);

    // A new publication is a new reception start: the coordinator end leaves
    // the successor alone (it is not a system-audio owner), and the begin
    // stops its media, takes its title as the restore point and claims the
    // placeholder. A slot that held a 'pending' phase from the first begin
    // would refuse this begin (C4 critique, stored phases).
    await applyState(live(sfuPublication('publication_00002', 'realtime_session_02'), 2));
    expect(sfuConnections()[0].closed).toBe(true);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(2);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: 'system-audio',
      activity: 'pending',
      placeholder: true,
    });
    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-audio-2'] });
    expect(webAudio.sources).toHaveLength(1);

    await applyState(idle(3));
    expect(slot()).toMatchObject({ receiving: false, mode: null, title: 'successor' });
    expect(seen.toasts).toEqual([]);
  });

  it('S8 (generations): a new SFU publication while the old track waits in initAudio retires the old session; the stale track never connects and the new one attaches once', async () => {
    webAudio.suspend();
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS + 100);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });

    await applyState(live(sfuPublication('publication_00002', 'realtime_session_02'), 2));
    expect(sfuConnections()[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    webAudio.finishResume();
    await advance(PRO_SUBSCRIBED_AT_MS);
    expect(webAudio.sources.map((source) => source.trackIds)).toEqual([['sfu-audio-2']]);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['sfu-audio-2'],
    });
    // A new publication is a new reception start.
    expect(media.stopAllMedia).toHaveBeenCalledTimes(2);
    expect(seen.toasts).toEqual([]);
    await applyState(idle(3));
    expect(slot().title).toBe(previousTitle);
  });
});

describe('PRO LAN-direct reception through the real transport', () => {
  it('S6: the track attaches once the probe and media offers prove a same-LAN pair, with no playout hint; the share end closes the route without a signal', async () => {
    await applyState(live(directPublication()));
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    sendLanProbeOffer(lanRoute());
    await advance(0);
    expect(proRelay.signals('answer').map((signal) => signal.phase)).toEqual(['probe']);
    sendLanCandidate(lanRoute());
    await advance(0);
    expect(slot().receiving).toBe(false);
    sendLanMediaOffer(lanRoute(), 'direct-audio-1');
    await advance(0);
    expect(proRelay.signals('answer').map((signal) => signal.phase)).toEqual(['probe', 'media']);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['direct-audio-1'],
      primers: 1,
    });
    // The other three receivers set a 0.5 s playout hint; LAN-direct sets none
    // (C4-1 parity pin, an owner decision if it changes).
    expect(lanConnections()[0].receivers.map((receiver) => receiver.playoutDelayHint)).toEqual([
      undefined,
    ]);
    // LAN-direct uses no TURN and no Realtime session.
    expect(realtime.requests).toEqual([]);
    expect(seen.toasts).toEqual([]);

    await applyState(idle(2));
    expect(slot()).toEqual(idleWithPreviousTitle());
    expect(lanConnections()[0].closed).toBe(true);
    expect(proRelay.signals('close')).toEqual([]);
    expect(restorePlayback).toHaveBeenCalledTimes(1);
  });

  it('a LAN ICE disconnect fails the route at once (no 2.5 s grace as on the SFU): a fallback close to the publisher, one notice, the source gone and the placeholder kept until the promotion attaches', async () => {
    await applyState(live(directPublication(), 1, REMOTE_ID, Date.now() + LIVE_TTL_MS));
    await lanPublisherDelivers();
    expect(slot().receiving).toBe(true);

    lanConnections()[0].setConnectionState('disconnected');
    expect(lanConnections()[0].closed).toBe(true);
    expect(proRelay.signals('close')).toEqual([
      expect.objectContaining({
        direction: 'subscriber',
        targetParticipantId: REMOTE_ID,
        reason: 'fallback',
      }),
    ]);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    await advance(60_000);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({ activity: 'pending', placeholder: true });

    await applyState(live(sfuPublication(), 1, REMOTE_ID, Date.now() + LIVE_TTL_MS));
    await advance(PRO_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-audio-1'] });
    expect(webAudio.maxConnected).toBe(1);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(2);
  });

  it("deadlines: a media answer whose track never arrives falls back after the transport's 5 s, which also clears the coordinator's 30 s deadline: one notice in a minute", async () => {
    await applyState(live(directPublication()));
    await lanPublisherDelivers(lanRoute(), 'direct-audio-1', { withTrack: false });
    expect(proRelay.signals('answer').map((signal) => signal.phase)).toEqual(['probe', 'media']);

    await advance(4_999);
    expect(seen.toasts).toEqual([]);
    expect(lanConnections()[0].closed).toBe(false);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(lanConnections()[0].closed).toBe(true);
    expect(proRelay.signals('close').map((signal) => signal.reason)).toEqual(['fallback']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    await advance(60_000);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
  });

  it.each([
    {
      cause: 'a force-stop',
      end: () => bus.emit('system-audio:force-stop'),
      after: () => ({ mode: null, activity: 'idle', title: previousTitle }),
    },
    {
      cause: 'a successor owner',
      end: () =>
        claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') }),
      after: () => ({ mode: 'file', activity: 'playing', title: 'successor' }),
    },
  ])(
    'expected today: a direct track delivered after $cause is dropped at the trusted boundary and never offered again for that publication; the route stays open until the share ends',
    async ({ end, after }) => {
      await applyState(live(directPublication()));
      await advance(1_000);
      end();
      await lanPublisherDelivers();
      await advance(60_000);
      expect(webAudio.sources).toHaveLength(0);
      expect(slot()).toMatchObject({ receiving: false, sources: [], primers: 0, ...after() });
      expect(seen.toasts).toEqual([]);

      // The transport handed its track over once. Heartbeats re-activate the
      // same publication without offering it again, and nothing begins a new
      // reception for an unchanged publication (C4-5/C4-10 territory).
      bindProSystemAudioSession(snapshot());
      await advance(15_000);
      bindProSystemAudioSession(snapshot());
      await advance(15_000);
      expect(webAudio.sources).toHaveLength(0);
      expect(lanConnections()).toHaveLength(1);
      expect(lanConnections()[0].closed).toBe(false);
      expect(proRelay.signals('answer')).toHaveLength(2);
      expect(slot()).toMatchObject(after());

      // Only the share end closes the route; it still asks for the post-share
      // restore, because this listener observed the live share.
      await applyState(idle(2));
      expect(lanConnections()[0].closed).toBe(true);
      expect(slot()).toMatchObject(after());
      expect(restorePlayback).toHaveBeenCalledTimes(1);
      expect(seen.toasts).toEqual([]);
    },
  );

  it('S8 (generations): a new direct publication while the old track waits in initAudio supersedes the old route; the stale track never connects and the new one attaches', async () => {
    await applyState(live(directPublication()));
    webAudio.suspend();
    await lanPublisherDelivers();
    await advance(100);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });

    await applyState(live(directPublication('publication_00002'), 2));
    expect(lanConnections()[0].closed).toBe(true);
    expect(proRelay.signals('close')).toEqual([
      expect.objectContaining({ generation: 1, reason: 'superseded' }),
    ]);
    webAudio.finishResume();
    await advance(0);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    await lanPublisherDelivers(
      lanRoute({
        generation: 2,
        publicationId: 'publication_00002',
        negotiationId: 'negotiation_000000000002',
      }),
      'direct-audio-2',
    );
    expect(webAudio.sources.map((source) => source.trackIds)).toEqual([['direct-audio-2']]);
    expect(slot()).toMatchObject({ receiving: true, sources: ['direct-audio-2'] });
    expect(media.stopAllMedia).toHaveBeenCalledTimes(2);
    expect(seen.toasts).toEqual([]);
    await applyState(idle(3));
    expect(slot().title).toBe(previousTitle);
  });

  it("expected today: a publisher close 'stopped' closes the LAN route without telling the slot; receiving and the source stay until the share end", async () => {
    await applyState(live(directPublication()));
    await lanPublisherDelivers();

    sendLanClose(lanRoute(), 'stopped');
    expect(lanConnections()[0].closed).toBe(true);
    // The transport reports only fallbacks to the coordinator. Until the
    // server's idle state arrives the slot shows a playing share on a closed
    // route (C4-5 decides whether a route close detaches).
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      sources: ['direct-audio-1'],
      primers: 1,
    });
    await advance(60_000);
    expect(seen.toasts).toEqual([]);
    expect(proRelay.signals('close')).toEqual([]);

    await applyState(idle(2));
    expect(slot()).toEqual(idleWithPreviousTitle());
  });

  it("a publisher close 'fallback' on the live route answers with a fallback close and drops the source with one notice, keeping the placeholder", async () => {
    await applyState(live(directPublication()));
    await lanPublisherDelivers();

    sendLanClose(lanRoute(), 'fallback');
    expect(lanConnections()[0].closed).toBe(true);
    expect(proRelay.signals('close').map((signal) => signal.reason)).toEqual(['fallback']);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
  });

  it('begin re-entrancy (LAN-direct): a remote direct share that begins through a nested force-stop still arms the 30 s direct deadline after it', async () => {
    claimPlaybackOwner('system-audio', { currentTrackMeta: createSystemAudioTrackMeta('sharing') });
    media.captureActive = true;
    await applyState(
      live(
        {
          publicationId: 'publication_00002',
          sessionId: 'realtime_session_02',
          track: { trackName: 'audio-stereo-local', mid: '0' },
        },
        1,
        LOCAL_ID,
      ),
    );
    expect(slot()).toMatchObject({ mode: 'system-audio', title: 'System Audio Sharing' });

    // The lease moved to a remote LAN-direct publication before local capture
    // stopped: the reception start's stopAllMedia emits force-stop inside the
    // begin. The coordinator arms its deadline after the begin returns, so
    // the nested force-stop (which clears that deadline) cannot cancel it.
    await applyState(live(directPublication(), 2));
    expect(seen.counts.forceStops).toBe(1);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: 'system-audio',
      activity: 'pending',
      placeholder: true,
    });
    await advance(29_999);
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);

    await lanPublisherDelivers(lanRoute({ generation: 2 }));
    expect(slot()).toMatchObject({ receiving: true, sources: ['direct-audio-1'] });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
  });
});

describe('iOS-style initAudio rejection through the real PRO transports', () => {
  it('PRO SFU: the failed attach retires the session and its tracks into a backed-off retry that keeps the placeholder', async () => {
    webAudio.suspend();
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS + 499);
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(sfuConnections()[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });

    webAudio.finishResume();
    await advance(RETRY_MS + PRO_TRACK_AT_MS);
    expect(realtime.count('new-session')).toBe(2);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-audio-2'] });
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.receiveTimeouts).toBe(0);
  });

  it('PRO LAN-direct: the failed attach fails the route into a receiver fallback with a fallback close to the publisher; the placeholder waits', async () => {
    await applyState(live(directPublication()));
    webAudio.suspend();
    await lanPublisherDelivers();
    await advance(499);
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(lanConnections()[0].closed).toBe(true);
    expect(proRelay.signals('close').map((signal) => signal.reason)).toEqual(['fallback']);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });
    await advance(60_000);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
  });
});

describe('S8b: a slot end while the attach waits in initAudio (real PRO transports)', () => {
  const waitingRoutes = [
    {
      route: 'SFU',
      trackId: 'sfu-audio-1',
      waitInInitAudio: async () => {
        webAudio.suspend();
        await applyState(live(sfuPublication()));
        await advance(PRO_TRACK_AT_MS + 100);
      },
      connections: sfuConnections,
    },
    {
      route: 'LAN-direct',
      trackId: 'direct-audio-1',
      waitInInitAudio: async () => {
        await applyState(live(directPublication()));
        webAudio.suspend();
        await lanPublisherDelivers();
        await advance(100);
      },
      connections: lanConnections,
    },
  ];

  it.each(waitingRoutes)(
    'S8b ($route): the share end while the attach waits in initAudio retires the route, so the track never connects',
    async ({ waitInInitAudio, connections }) => {
      await waitInInitAudio();
      expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });

      await applyState(idle(2));
      expect(connections()[0].closed).toBe(true);
      webAudio.finishResume();
      await advance(1_000);
      expect(webAudio.sources).toHaveLength(0);
      expect(slot()).toEqual(idleWithPreviousTitle());
      expect(seen.toasts).toEqual([]);
    },
  );

  it.each(waitingRoutes)(
    'S8b gap ($route): a force-stop while the attach waits in initAudio still connects the track under the restored title',
    async ({ waitInInitAudio, trackId, connections }) => {
      await waitInInitAudio();
      bus.emit('system-audio:force-stop');
      expect(slot()).toEqual(idleWithPreviousTitle());

      webAudio.finishResume();
      await advance(0);
      // Known gap (C4 critique S8b; observed on be82ce09 with the real
      // transports, not device-verified): force-stop reaches only the guest
      // placeholder, the route stays current, and the coordinator attach
      // re-checks only the route, the publication and the owner after
      // `await initAudio()`. Audio then plays with no placeholder under the
      // restored title. Planned: the slot attach fence (C4-3, inherited by
      // C4-5) and a slot end() that covers every route (5B; the neutral C4-5
      // and C4-7 kept the route-scoped ends); both need owner sign-off.
      expect(connections()[0].closed).toBe(false);
      expect(slot()).toMatchObject({
        receiving: true,
        mode: 'system-audio',
        activity: 'playing',
        placeholder: false,
        title: previousTitle,
        sources: [trackId],
      });
      expect(seen.toasts).toEqual([]);
    },
  );
});

describe('attach fences: the same publication retires its route while the attach waits in initAudio (C4-9, P5-D8)', () => {
  // The publication, its owner and the placeholder all stay current here, so
  // the coordinator's own identity checks in attachCoordinatorTrack pass. Only
  // the transport's isCurrent() (the SFU subscriber epoch, the LAN receiver
  // route) and the transports' rejection gates keep the stale attach out. C4-5
  // routes both through the slot and must keep these outcomes.

  it('expected today (SFU): a live ICE failure while the attach waits in initAudio keeps the stale track out by the subscriber epoch alone; the same-publication retry attaches once', async () => {
    webAudio.suspend();
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS + 100);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });

    sfuConnections()[0].setConnectionState('failed');
    await advance(0);
    expect(sfuConnections()[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);

    webAudio.finishResume();
    await advance(0);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });

    // The retry keeps the publication key (G6): no second reception start,
    // which is also why the coordinator's identity check alone would have let
    // the stale track through.
    await advance(RETRY_MS + PRO_TRACK_AT_MS);
    expect(webAudio.sources.map((source) => source.trackIds)).toEqual([['sfu-audio-2']]);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['sfu-audio-2'],
      primers: 1,
    });
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
  });

  it('expected today (SFU): when the stale attach then fails in initAudio, its rejection neither notifies again nor restarts the re-subscribe backoff', async () => {
    webAudio.suspend();
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS + 100);
    sfuConnections()[0].setConnectionState('failed');
    await advance(0);
    const failedAt = Date.now();

    // The stale attach's initAudio gives up 500 ms after the track (at 800 ms).
    await advance(500);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });
    webAudio.finishResume();

    // The retry still runs 2.5 s after the ICE failure. A rejection that
    // retried again would restart the backoff at its second step (5 s).
    // The retry reads TURN first, so its new-session goes out 100 ms later.
    await advance(failedAt + RETRY_MS + 99 - Date.now());
    expect(realtime.count('new-session')).toBe(1);
    await advance(1);
    expect(realtime.count('new-session')).toBe(2);
    await advance(PRO_TRACK_AT_MS - 100);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-audio-2'] });
    expect(webAudio.sources).toHaveLength(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
  });

  it('expected today (LAN-direct): a receiver route failure while the attach waits in initAudio keeps the stale track out by the route alone; the promotion attaches', async () => {
    await applyState(live(directPublication()));
    webAudio.suspend();
    await lanPublisherDelivers();
    await advance(100);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });

    lanConnections()[0].setConnectionState('disconnected');
    expect(lanConnections()[0].closed).toBe(true);
    expect(proRelay.signals('close').map((signal) => signal.reason)).toEqual(['fallback']);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);

    webAudio.finishResume();
    await advance(0);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 0,
    });

    // The publisher promotes the listener it lost to the SFU.
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    expect(webAudio.sources.map((source) => source.trackIds)).toEqual([['sfu-audio-1']]);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-audio-1'] });
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
  });

  it('expected today (LAN-direct): when the stale attach then fails in initAudio, the dead route sends no second fallback close and the slot hears nothing more', async () => {
    await applyState(live(directPublication()));
    webAudio.suspend();
    await lanPublisherDelivers();
    await advance(100);
    lanConnections()[0].setConnectionState('disconnected');

    // The stale attach's initAudio gives up 500 ms after the track.
    await advance(500);
    expect(proRelay.signals('close')).toHaveLength(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });
    await advance(60_000);
    expect(proRelay.signals('close')).toHaveLength(1);
    expect(seen.toasts).toEqual(['system_audio.connection_unstable']);
    expect(seen.counts.receiveTimeouts).toBe(0);
  });

  it.each([
    {
      route: 'SFU',
      state: () => live(sfuPublication()),
      trackId: 'sfu-audio-1',
      waitInInitAudio: async () => {
        webAudio.suspend();
        await applyState(live(sfuPublication()));
        await advance(PRO_TRACK_AT_MS + 100);
      },
      connections: sfuConnections,
    },
    {
      route: 'LAN-direct',
      state: () => live(directPublication()),
      trackId: 'direct-audio-1',
      waitInInitAudio: async () => {
        await applyState(live(directPublication()));
        webAudio.suspend();
        await lanPublisherDelivers();
        await advance(100);
      },
      connections: lanConnections,
    },
  ])(
    'expected today ($route): heartbeats and a room-context re-emission while the attach waits in initAudio neither offer the track again nor begin again; the waiting attach connects once',
    async ({ state, trackId, waitInInitAudio, connections }) => {
      await waitInInitAudio();
      const requestsBefore = realtime.requests.length;
      const signalsBefore = proRelay.sent.length;

      bindProSystemAudioSession(snapshot());
      acceptProSystemAudioHeartbeatState(state(), snapshot());
      setState('room.context', proContext());
      await advance(100);
      expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });

      webAudio.finishResume();
      await advance(0);
      expect(webAudio.sources.map((source) => source.trackIds)).toEqual([[trackId]]);
      expect(slot()).toMatchObject({
        receiving: true,
        activity: 'playing',
        placeholder: true,
        sources: [trackId],
        primers: 1,
      });
      expect(connections()).toHaveLength(1);
      expect(connections()[0].closed).toBe(false);
      expect(realtime.requests.length).toBe(requestsBefore);
      expect(proRelay.sent.length).toBe(signalsBefore);
      expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
      expect(seen.counts.visualizerStarts).toBe(1);
      expect(seen.toasts).toEqual([]);
    },
  );
});

describe('adopt idempotence, retire paths and /debug on the real PRO routes', () => {
  it.each(routes)(
    'expected today ($route): heartbeats and a room-context re-emission while receiving reuse the live route: same source, primer and connection, no new negotiation',
    async ({ state, deliver, connections }) => {
      await deliver();
      expect(slot()).toMatchObject({ receiving: true, activity: 'playing' });
      const [source] = webAudio.connected();
      const [primer] = primerElements();
      const requestsBefore = realtime.requests.length;
      const signalsBefore = proRelay.sent.length;
      const activitiesBefore = seen.activities.length;

      // The presence snapshot, the heartbeat's system-audio state and the
      // runtime's authority update each reconcile (the room-context handler
      // also retires the Standard SFU route first: the PRO "adopt").
      bindProSystemAudioSession(snapshot());
      acceptProSystemAudioHeartbeatState(state(), snapshot());
      setState('room.context', proContext());
      await advance(15_000);

      expect(webAudio.connected()).toEqual([source]);
      expect(primerElements()).toEqual([primer]);
      expect(connections()).toHaveLength(1);
      expect(connections()[0].closed).toBe(false);
      expect(realtime.requests.length).toBe(requestsBefore);
      expect(proRelay.sent.length).toBe(signalsBefore);
      expect(seen.activities.slice(activitiesBefore)).toEqual([]);
      expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
      expect(slot()).toMatchObject({ receiving: true, activity: 'playing' });
    },
  );

  it.each(
    routes.flatMap((row) => [
      {
        ...row,
        trigger: 'a PRO-to-Standard context switch',
        retire: () =>
          setState('room.context', {
            ...proContext(),
            kind: 'standard',
            roomId: null,
            role: 'idle',
          }),
      },
      { ...row, trigger: 'a room leave', retire: () => resetProSystemAudioService() },
    ]),
  )(
    '$trigger while receiving over $route ends reception idle, retires the route without a signal and asks for no post-share restore',
    async ({ deliver, connections, tracksClosed, retire }) => {
      await deliver();
      retire();
      expect(slot()).toEqual(idleWithPreviousTitle());
      expect(connections()[0].closed).toBe(true);
      await advance(0);
      expect(realtime.count('tracks-close')).toBe(tracksClosed);
      expect(proRelay.signals('close')).toEqual([]);

      // A later heartbeat changes nothing.
      bindProSystemAudioSession(snapshot());
      await advance(15_000);
      expect(slot()).toEqual(idleWithPreviousTitle());
      expect(restorePlayback).not.toHaveBeenCalled();
      expect(seen.toasts).toEqual([]);
    },
  );

  it('/debug: PRO reception sets the shared receiving flag, but neither the guest nor the SFU section reports the coordinator source or primer', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_SUBSCRIBED_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-audio-1'], primers: 1 });
    // Observed (be82ce09): /debug has no PRO coordinator section, so a field
    // capture of a playing PRO listener shows sourceStereo false and no
    // primer. The C4 critique asks C4-4 to add a slot section.
    expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
      systemReceiving: true,
      placeholder: true,
      sourceStereo: false,
      decoderPrimer: false,
      watchdogActive: false,
    });
    expect(getSystemAudioSfuDebugSnapshot().guest).toMatchObject({
      pcState: null,
      receiving: false,
      sourceStereo: false,
      decoderPrimerCount: 0,
    });
  });
});
