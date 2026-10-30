/**
 * @vitest-environment jsdom
 *
 * Device evidence freeze for the PRO system-audio listener (Phase 5 prep T3).
 * The Phase 5 device criteria read these listener lines from /debug console
 * (`?mxqrLog=info`), so their exact text, argument count and log level must not
 * change while C4-5 and C4-7 move PRO reception onto the receive slot:
 * - PRO SFU: received stereo track (with its mid) and subscribed to generation
 *   (with the publication generation), both [ProSysAudioSFU] info lines.
 * - The decoder primer on both PRO routes: [ProSysAudio] primed (stereo) at
 *   info, primer blocked at warn. A listener on LAN-direct must log no
 *   [ProSysAudioSFU] line (the criteria tell the routes apart by it). Since the
 *   one-round-trip LAN-direct protocol it also logs its own pair proof,
 *   `[ProSysAudioDirect] Receiver LAN pair proven in <ms> ms`, at info.
 * - A direct-to-SFU promotion seen from the listener: the SFU pair plus a
 *   second primed line for the new track.
 *
 * Driven through the real service, controller, PRO SFU subscriber and
 * LAN-direct receiver, with the same native seams as
 * system-audio-receive-slot-pro-transport-contract.test.ts (see its header);
 * the log is spied, not replaced. The sharer's PRO lines are in
 * system-audio-pro-publish-evidence.test.ts. Each test pins main bd94075c,
 * whose system-audio code is the 9.0.7 runtime. Room codes and ids are
 * synthetic.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { registerSystemAudioGuestListeners } from '../../network/system-audio-guest.ts';
import { registerSystemAudioSfuListeners } from '../../network/system-audio-sfu.ts';
import { claimPlaybackOwner, createFileTrackMeta } from '../../player/ownership.ts';
import type { ProRoomApiClient } from '../api.ts';
import type {
  ProRoomSnapshot,
  ProRoomSystemAudioPublication,
  ProRoomSystemAudioState,
} from '../contracts.ts';
import { bindProRoomRealtimeSender } from '../realtime-sender.ts';
import {
  bindProSystemAudioSession,
  configureProSystemAudioService,
  refreshProSystemAudioState,
  registerProSystemAudioServiceListeners,
  resetProSystemAudioService,
} from '../system-audio-service.ts';
import {
  ProTransportPeerConnection,
  proRelay,
  sendLanCandidate,
  sendLanOffer,
  sendLanTrackAttached,
  type LanPublisherRoute,
} from '../../network/__tests__/__helpers__/pro-system-audio-transport-natives.ts';
import {
  installNativeGlobals,
  resetNativeFakes,
  webAudio,
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
const LIVE_EXPIRES_AT = 1_900_007_200_000;
const GENERATION = 3;

const RECEIVED = '[ProSysAudioSFU] Received stereo track (mid=0)';
const SUBSCRIBED = `[ProSysAudioSFU] Subscribed to generation ${GENERATION}`;
const PRIMED = '[ProSysAudio] WebRTC audio decoder primed (stereo)';
const PRIMER_BLOCKED = '[ProSysAudio] WebRTC audio decoder primer blocked:';

const ROUTE_LINE =
  /\[ProSysAudioSFU\] (?:Received stereo track|Subscribed to generation|Published generation)|Promoted LAN-direct publication to SFU/u;
const PRIMER_LINE = /WebRTC audio decoder prime(?:d|r blocked)/u;
const SFU_PREFIX = /\[ProSysAudioSFU\]/u;

type Level = 'debug' | 'info' | 'warn' | 'error';
type Line = [Level, ...unknown[]];

const api = { getSystemAudioState: vi.fn<() => Promise<ProRoomSystemAudioState>>() };
const restorePlayback = vi.fn(async () => true);
let lines: Line[] = [];

function matching(pattern: RegExp): Line[] {
  return lines.filter(([, first]) => typeof first === 'string' && pattern.test(first));
}
/** Every PRO route line the device criteria read, at whatever level it was logged. */
const routeEvidence = () => matching(ROUTE_LINE);
/** Every decoder-primer line, kept apart: its play() settles on its own microtask. */
const primerEvidence = () => matching(PRIMER_LINE);

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

const sfuPublication = (): ProRoomSystemAudioPublication => ({
  publicationId: PUBLICATION_ID,
  sessionId: 'realtime_session_01',
  track: { trackName: 'audio-stereo-realtime_session_01', mid: '0' },
});
const directPublication = (): ProRoomSystemAudioPublication => ({
  publicationId: PUBLICATION_ID,
  transport: 'lan-direct',
  protocolVersion: 2,
});

/** The PRO Worker answers an SFU live with its media deadline and a LAN-direct one with null. */
function live(publication: ProRoomSystemAudioPublication): ProRoomSystemAudioState {
  return {
    generation: GENERATION,
    status: 'live',
    ownerParticipantId: REMOTE_ID,
    claimExpiresAt: null,
    liveExpiresAt: 'sessionId' in publication ? LIVE_EXPIRES_AT : null,
    publication,
  };
}

/** The coordinator's authenticated GET returns `state`. */
async function applyState(state: ProRoomSystemAudioState): Promise<void> {
  api.getSystemAudioState.mockResolvedValue(state);
  await refreshProSystemAudioState();
  await vi.advanceTimersByTimeAsync(0);
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const lanRoute: LanPublisherRoute = {
  roomCode: ROOM_CODE,
  ownerParticipantId: REMOTE_ID,
  targetParticipantId: LOCAL_ID,
  generation: GENERATION,
  publicationId: PUBLICATION_ID,
  negotiationId: 'negotiation_000000000001',
};

/**
 * The remote LAN-direct publisher offers its track in one round trip; the
 * receiver proves its pair on the next 25 ms proof poll after the candidate,
 * and the publisher then says the track carries audio.
 */
async function lanPublisherDelivers(): Promise<void> {
  sendLanOffer(lanRoute, 'direct-audio-1');
  await advance(0);
  sendLanCandidate(lanRoute);
  await advance(25);
  sendLanTrackAttached();
  await advance(0);
}

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
  claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('previous-track.mp3') });
  // The PRO bridge runs the media engine as a local 'host' with no host socket.
  setState('network.appRole', 'host');
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
  document.body.replaceChildren();
});

describe('PRO SFU listener evidence lines', () => {
  it('logs the received track with its mid when it attaches, then subscribed with the publication generation, both at info', async () => {
    await applyState(live(sfuPublication()));
    await advance(PRO_TRACK_AT_MS);
    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(routeEvidence()).toEqual([['info', RECEIVED]]);
    expect(primerEvidence()).toEqual([['info', PRIMED]]);

    await advance(PRO_SUBSCRIBED_AT_MS - PRO_TRACK_AT_MS);
    expect(routeEvidence()).toEqual([
      ['info', RECEIVED],
      ['info', SUBSCRIBED],
    ]);
    expect(primerEvidence()).toEqual([['info', PRIMED]]);
  });

  it('logs a blocked primer at warn with the play() error as its second argument; audio still attaches', async () => {
    const blocked = new DOMException('play() was blocked', 'NotAllowedError');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(blocked);
    await applyState(live(sfuPublication()));
    await advance(PRO_SUBSCRIBED_AT_MS);

    expect(webAudio.connectedTrackIds()).toEqual(['sfu-audio-1']);
    expect(primerEvidence()).toEqual([['warn', PRIMER_BLOCKED, blocked]]);
    expect(routeEvidence()).toEqual([
      ['info', RECEIVED],
      ['info', SUBSCRIBED],
    ]);
  });
});

describe('PRO LAN-direct listener evidence lines', () => {
  it('logs its pair proof and the primed line: no route line and no [ProSysAudioSFU] line at any level', async () => {
    await applyState(live(directPublication()));
    await lanPublisherDelivers();
    expect(webAudio.connectedTrackIds()).toEqual(['direct-audio-1']);

    expect(primerEvidence()).toEqual([['info', PRIMED]]);
    expect(matching(/\[ProSysAudioDirect\]/u)).toEqual([
      [
        'info',
        expect.stringMatching(/^\[ProSysAudioDirect\] Receiver LAN pair proven in \d+ ms$/u),
      ],
    ]);
    expect(routeEvidence()).toEqual([]);
    expect(matching(SFU_PREFIX)).toEqual([]);
  });

  it('logs a blocked primer at warn with the same prefix as on the SFU', async () => {
    const blocked = new DOMException('play() was blocked', 'NotAllowedError');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(blocked);
    await applyState(live(directPublication()));
    await lanPublisherDelivers();

    expect(webAudio.connectedTrackIds()).toEqual(['direct-audio-1']);
    expect(primerEvidence()).toEqual([['warn', PRIMER_BLOCKED, blocked]]);
    expect(matching(SFU_PREFIX)).toEqual([]);
  });

  it('after a direct-to-SFU promotion, logs the SFU pair and a second primed line for the new track', async () => {
    await applyState(live(directPublication()));
    await lanPublisherDelivers();
    expect(primerEvidence()).toEqual([['info', PRIMED]]);

    // The sharer promotes the same generation and publication to the SFU.
    await applyState(live(sfuPublication()));
    await advance(PRO_SUBSCRIBED_AT_MS);
    expect(webAudio.connectedTrackIds()).toEqual(['sfu-audio-1']);
    expect(routeEvidence()).toEqual([
      ['info', RECEIVED],
      ['info', SUBSCRIBED],
    ]);
    expect(primerEvidence()).toEqual([
      ['info', PRIMED],
      ['info', PRIMED],
    ]);
  });
});
