/**
 * @vitest-environment jsdom
 *
 * Device evidence freeze for the Standard system-audio receive routes (Phase 5
 * prep T3). The Phase 5 device criteria read these listener lines from /debug
 * console (`?mxqrLog=info`) and these /debug sa lines from a photo, so their
 * exact text, argument count and log level must not change while C4-2 to C4-8
 * move the receive slot. They are driven through the real guest, Standard SFU
 * and decoder-primer modules, not matched in source text:
 * - Standard direct (P2P): connected to graph, and the muted-stream wait pair
 *   (arrived muted, graph attach after).
 * - Standard SFU: subscribed via Cloudflare SFU, remote system audio connected.
 * - The decoder primer on both routes: primed (info) and primer blocked (warn),
 *   each with its route prefix ([SysAudioGuest], [SysAudioSFU]).
 * - /debug sa: the [Playback] line, the [DirectGuest] block (receiving,
 *   placeholder, gotStereo; graph sourceStereo/primer), the [SFUGuest] line and
 *   the guest and SFU snapshot keys behind them. C4-3 and C4-4 delete the
 *   fields these read, so the values must keep meaning "this route attached".
 *
 * The host lines are in system-audio-standard-publish-evidence.test.ts, the PRO
 * lines in src/pro-room/__tests__/system-audio-pro-receive-evidence-logs.test.ts
 * and system-audio-pro-publish-evidence.test.ts. Real and replaced modules are
 * as in system-audio-receive-slot-lifecycle-contract.test.ts (see
 * __helpers__/system-audio-receive-harness.ts); the log is spied, not replaced.
 * Each test pins main bd94075c, whose system-audio code is the 9.0.7 runtime.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { claimPlaybackOwner, createFileTrackMeta } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleData } from '../protocol.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';
import { collectSystemAudioDebugText } from '../system-audio-debug.ts';
import {
  getSystemAudioGuestDebugSnapshot,
  registerSystemAudioGuestListeners,
} from '../system-audio-guest.ts';
import {
  getSystemAudioSfuDebugSnapshot,
  registerSystemAudioSfuListeners,
} from '../system-audio-sfu.ts';
import {
  FakeMediaStream,
  installNativeGlobals,
  makeAudioTrack,
  makeMediaCall,
  observeReceiveBoundary,
  primerElements,
  resetNativeFakes,
  webAudio,
  type ReceiveObservations,
} from './__helpers__/system-audio-receive-harness.ts';

vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../audio/context.ts', async () => {
  const { webAudio: fake } = await import('./__helpers__/system-audio-receive-harness.ts');
  return { getAudioContext: () => fake.context };
});
vi.mock('../../audio/engine.ts', async () => {
  const { webAudio: fake } = await import('./__helpers__/system-audio-receive-harness.ts');
  return {
    initAudio: fake.initAudio,
    getWidener: fake.getWidener,
    // /debug sa reads the engine only for its [AudioCtx] line.
    isAudioReady: () => false,
    getAudioContext: () => fake.context,
  };
});
vi.mock('../../player/transport.ts', async () => {
  const { media: fake } = await import('./__helpers__/system-audio-receive-harness.ts');
  return { stopAllMedia: fake.stopAllMedia };
});
vi.mock('../../core/capability.ts', async () => {
  const { realtime: fake } = await import('./__helpers__/system-audio-receive-harness.ts');
  return {
    fetchWithCapability: fake.fetchWithCapability,
    isCapabilityChallengeCancelled: () => false,
  };
});
vi.mock('../standard-room-prerequisites.ts', () => ({
  getStandardRoomTurnCredentials: async () => null,
}));
vi.mock('../../audio/system-capture.ts', () => ({
  getCapturedAudioStream: () => null,
  isSystemAudioActive: () => false,
  getSystemAudioCaptureDebugSnapshot: () => ({ active: false, capturedTracks: [] }),
}));

const HOST_PEER = 'host-peer-0001';
// The Standard SFU subscriber's track is exposed once new-session and
// tracks-new have each taken the Realtime fake's latency (100 ms); renegotiate
// completes the subscription 100 ms later.
const SFU_TRACK_AT_MS = 200;
const SFU_SUBSCRIBED_AT_MS = 300;
// The P2P adapter's bounded unmute wait and its settle window (guest module).
const UNMUTE_WAIT_MS = 2_000;
const UNMUTE_SETTLE_MS = 80;

type Level = 'debug' | 'info' | 'warn' | 'error';
type Line = [Level, ...unknown[]];

const P2P_CONNECTED = '[SysAudioGuest] System audio connected to graph (STEREO)';
const P2P_ARRIVED_MUTED =
  '[SysAudioGuest] STEREO stream arrived muted; waiting for unmute before graph attach';
const P2P_PRIMED = '[SysAudioGuest] WebRTC audio decoder primed (STEREO)';
const P2P_PRIMER_BLOCKED = '[SysAudioGuest] WebRTC audio decoder primer blocked:';
// The Realtime session id is the subscriber session the guest holds (the fake
// numbers sessions across the whole file).
const sfuSubscribed = (sessionId: string | null) =>
  `[SysAudioSFU] Subscribed to host system audio via Cloudflare SFU (${sessionId})`;
const SFU_CONNECTED = '[SysAudioSFU] Remote system audio connected through Cloudflare SFU';
const SFU_PRIMED = '[SysAudioSFU] WebRTC audio decoder primed (STEREO)';
const SFU_PRIMER_BLOCKED = '[SysAudioSFU] WebRTC audio decoder primer blocked:';

const ROUTE_LINE =
  /System audio connected to graph|stream arrived muted; waiting for unmute|graph attach after|Subscribed to host system audio via Cloudflare SFU|Remote system audio connected through Cloudflare SFU/u;
const PRIMER_LINE = /WebRTC audio decoder prime(?:d|r blocked)/u;

let hostConn: DataConnection;
let seen: ReceiveObservations;
let lines: Line[] = [];

function matching(pattern: RegExp): Line[] {
  return lines.filter(([, first]) => typeof first === 'string' && pattern.test(first));
}
/** Every route line the device criteria read, at whatever level it was logged. */
const routeEvidence = () => matching(ROUTE_LINE);
/** Every decoder-primer line, kept apart: its play() settles on its own microtask. */
const primerEvidence = () => matching(PRIMER_LINE);

async function hostFrame(frame: Record<string, unknown>): Promise<void> {
  await handleData(frame, hostConn);
  await vi.advanceTimersByTimeAsync(0);
}

const start = () => hostFrame({ type: MSG.SYSTEM_AUDIO_START, surface: 'display' });
const stop = () => hostFrame({ type: MSG.SYSTEM_AUDIO_STOP });
const ready = (sessionId: string) =>
  hostFrame({
    type: MSG.SYSTEM_AUDIO_SFU_READY,
    version: 2,
    audience: 'remote',
    sessionId,
    track: { trackName: `stereo-${sessionId}`, mid: '0' },
  });

function directCall() {
  const call = makeMediaCall(HOST_PEER);
  bus.emit('system-audio:incoming-call', call.mediaConn, 'STEREO');
  return call;
}

function streamOf(...tracks: MediaStreamTrack[]): MediaStream {
  return new FakeMediaStream(tracks) as unknown as MediaStream;
}

/** A remote track that arrives muted, as some Chromium builds deliver it. */
function mutedTrack(id: string): { track: MediaStreamTrack; unmute(): void } {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const track = {
    id,
    kind: 'audio',
    readyState: 'live',
    muted: true,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'unmute') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'unmute') listeners.delete(listener);
    },
  };
  return {
    track: track as unknown as MediaStreamTrack,
    unmute() {
      track.muted = false;
      const event = new Event('unmute');
      for (const listener of [...listeners]) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
  };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** The track ids each decoder-primer element in the DOM plays. */
function primerTrackIds(): string[][] {
  return primerElements().map((element) =>
    (element.srcObject as unknown as FakeMediaStream).tracks.map((track) => track.id),
  );
}

beforeAll(() => {
  registerSystemAudioGuestListeners();
  registerSystemAudioSfuListeners();
});

beforeEach(() => {
  vi.useFakeTimers();
  installNativeGlobals();
  resetNativeFakes();
  resetState();
  hostConn = { open: true, peer: HOST_PEER, send: vi.fn() } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
  setState('network.connectionType', 'remote');
  markQueueAuthorityReady(hostConn);
  // The guest was playing a local file before the share started.
  claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('previous-track.mp3') });
  seen = observeReceiveBoundary();
  lines = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      lines.push([level, ...args]);
    });
  }
});

afterEach(() => {
  bus.emit('system-audio:force-stop');
  seen.dispose();
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('Standard direct (P2P) receive evidence lines', () => {
  it('logs connected to graph once at info, and the primer once with the guest prefix', async () => {
    await start();
    const call = directCall();
    call.stream(streamOf(makeAudioTrack('p2p-track-a')));
    await advance(0);

    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(routeEvidence()).toEqual([['info', P2P_CONNECTED]]);
    expect(primerEvidence()).toEqual([['info', P2P_PRIMED]]);

    // A second stream on the same call reuses the receiving state: no repeat.
    call.stream(streamOf(makeAudioTrack('p2p-track-b')));
    await advance(0);
    expect(routeEvidence()).toEqual([['info', P2P_CONNECTED]]);
  });

  it('logs the muted wait, the attach after unmute with the eight-character track id, then connected', async () => {
    await start();
    const muted = mutedTrack('p2p-muted-track-1');
    directCall().stream(streamOf(muted.track));
    await advance(0);
    expect(routeEvidence()).toEqual([['info', P2P_ARRIVED_MUTED]]);

    muted.unmute();
    await advance(UNMUTE_SETTLE_MS);
    expect(routeEvidence()).toEqual([
      ['info', P2P_ARRIVED_MUTED],
      ['info', '[SysAudioGuest] STEREO graph attach after unmute: p2p-mute:live'],
      ['info', P2P_CONNECTED],
    ]);
    expect(primerEvidence()).toEqual([['info', P2P_PRIMED]]);
  });

  it('logs the attach after the bounded unmute timeout with the track still muted', async () => {
    await start();
    directCall().stream(streamOf(mutedTrack('p2p-muted-track-2').track));
    await advance(UNMUTE_WAIT_MS - 1);
    expect(routeEvidence()).toEqual([['info', P2P_ARRIVED_MUTED]]);

    await advance(1);
    expect(routeEvidence()).toEqual([
      ['info', P2P_ARRIVED_MUTED],
      ['info', '[SysAudioGuest] STEREO graph attach after unmute-timeout: p2p-mute:live:muted'],
      ['info', P2P_CONNECTED],
    ]);
  });

  it('logs a blocked primer at warn with the play() error as its second argument; audio still attaches', async () => {
    const blocked = new DOMException('play() was blocked', 'NotAllowedError');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(blocked);
    await start();
    directCall().stream(streamOf(makeAudioTrack('p2p-track-a')));
    await advance(0);

    expect(primerEvidence()).toEqual([['warn', P2P_PRIMER_BLOCKED, blocked]]);
    expect(routeEvidence()).toEqual([['info', P2P_CONNECTED]]);
  });

  // C4-3 moves the P2P source and primer into the receive slot. The direct
  // call primes each stream when it arrives, before the unmute wait and the
  // trust boundary, and its attach never primes again: a stream that is still
  // waiting in initAudio when the next one arrives must not take the primer
  // back from it.
  it('logs the primer once per stream key, at the stream, never again at the attach', async () => {
    await start();
    webAudio.suspend();
    const call = directCall();
    call.stream(streamOf(makeAudioTrack('p2p-track-a')));
    await advance(100);
    expect(primerEvidence()).toEqual([['info', P2P_PRIMED]]);

    // The same call delivers a second stream while the first waits in
    // initAudio: its key replaces the primer at once.
    call.stream(streamOf(makeAudioTrack('p2p-track-b')));
    await advance(100);
    expect(primerEvidence()).toEqual([
      ['info', P2P_PRIMED],
      ['info', P2P_PRIMED],
    ]);
    expect(primerTrackIds()).toEqual([['p2p-track-b']]);
    expect(webAudio.sources).toHaveLength(0);

    // Both attaches run in arrival order; the later one swaps the source, and
    // neither primes or claims again.
    webAudio.finishResume();
    await advance(0);
    expect(webAudio.sources.map((source) => source.trackIds)).toEqual([
      ['p2p-track-a'],
      ['p2p-track-b'],
    ]);
    expect(webAudio.connectedTrackIds()).toEqual(['p2p-track-b']);
    expect(primerTrackIds()).toEqual([['p2p-track-b']]);
    expect(primerEvidence()).toEqual([
      ['info', P2P_PRIMED],
      ['info', P2P_PRIMED],
    ]);
    expect(routeEvidence()).toEqual([['info', P2P_CONNECTED]]);
    expect(seen.counts.visualizerStarts).toBe(1);

    // A repeat of the attached stream's key reuses its primer.
    call.stream(streamOf(makeAudioTrack('p2p-track-b')));
    await advance(0);
    expect(primerEvidence()).toHaveLength(2);
    expect(primerTrackIds()).toEqual([['p2p-track-b']]);
    expect(webAudio.connectedTrackIds()).toEqual(['p2p-track-b']);
  });
});

describe('Standard SFU receive evidence lines', () => {
  it('logs remote system audio connected when the track attaches, then subscribed with the session id, both at info', async () => {
    await start();
    await ready('rt_host_session_1');
    await advance(SFU_TRACK_AT_MS);
    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(routeEvidence()).toEqual([['info', SFU_CONNECTED]]);
    expect(primerEvidence()).toEqual([['info', SFU_PRIMED]]);

    await advance(SFU_SUBSCRIBED_AT_MS - SFU_TRACK_AT_MS);
    const { sessionId } = getSystemAudioSfuDebugSnapshot().guest;
    expect(sessionId).toMatch(/^rt_guest_session_\d+$/u);
    expect(routeEvidence()).toEqual([
      ['info', SFU_CONNECTED],
      ['info', sfuSubscribed(sessionId)],
    ]);
    expect(primerEvidence()).toEqual([['info', SFU_PRIMED]]);
  });

  it("logs connected and a primer again for a re-publication's track, once per subscription", async () => {
    await start();
    await ready('rt_host_session_a');
    await advance(SFU_SUBSCRIBED_AT_MS);
    const first = getSystemAudioSfuDebugSnapshot().guest.sessionId;

    // The host re-publishes while this guest receives: the teardown keeps the
    // receiving flag, and the new subscription's attach starts the reception
    // again (C4-4 keeps this per subscription, not per slot).
    await ready('rt_host_session_b');
    expect(getState('systemAudio.isReceiving')).toBe(true);
    await advance(SFU_SUBSCRIBED_AT_MS);
    const second = getSystemAudioSfuDebugSnapshot().guest.sessionId;
    expect(second).not.toBe(first);
    expect(webAudio.connectedTrackIds()).toEqual(['sfu-remote-audio-2']);

    expect(routeEvidence()).toEqual([
      ['info', SFU_CONNECTED],
      ['info', sfuSubscribed(first)],
      ['info', SFU_CONNECTED],
      ['info', sfuSubscribed(second)],
    ]);
    expect(primerEvidence()).toEqual([
      ['info', SFU_PRIMED],
      ['info', SFU_PRIMED],
    ]);
    expect(primerTrackIds()).toEqual([['sfu-remote-audio-2']]);
    expect(seen.counts.visualizerStarts).toBe(2);
  });

  it('logs a blocked primer at warn with the SFU prefix; audio still attaches', async () => {
    const blocked = new DOMException('play() was blocked', 'NotAllowedError');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(blocked);
    await start();
    await ready('rt_host_session_1');
    await advance(SFU_SUBSCRIBED_AT_MS);

    expect(primerEvidence()).toEqual([['warn', SFU_PRIMER_BLOCKED, blocked]]);
    expect(routeEvidence()).toEqual([
      ['info', SFU_CONNECTED],
      ['info', sfuSubscribed(getSystemAudioSfuDebugSnapshot().guest.sessionId)],
    ]);
  });
});

describe('/debug sa receive lines and snapshot keys', () => {
  /** The /debug sa lines the device criteria read from a photo. */
  async function debugLines() {
    const text = (await collectSystemAudioDebugText()).split('\n');
    const at = (prefix: string) => text.findIndex((line) => line.startsWith(prefix));
    const directGuest = at('[DirectGuest] ');
    return {
      playback: text[at('[Playback] ')],
      directGuest: text.slice(directGuest, directGuest + 4),
      sfuGuest: text[at('[SFUGuest] ')],
    };
  }

  /** The four [DirectGuest] lines; the ages in the middle two are not device evidence. */
  const directGuestBlock = (flags: string, watchdogActive: 'yes' | 'no', graph: string) => [
    `[DirectGuest] ${flags}`,
    expect.stringMatching(/^ {2}start:.+ ignored:.+ stop:.+ cleanup:.+$/u),
    expect.stringMatching(
      watchdogActive === 'yes'
        ? /^ {2}watchdog active:yes armed:.+ timeout:.+$/u
        : /^ {2}watchdog active:no armed:.+ timeout:.+$/u,
    ),
    `  graph ${graph}`,
  ];

  it('keeps the guest and SFU snapshot keys the /debug lines read', () => {
    expect(Object.keys(getSystemAudioGuestDebugSnapshot())).toEqual([
      'systemReceiving',
      'placeholder',
      'gotStereo',
      'sourceStereo',
      'decoderPrimer',
      'lastStartAt',
      'lastStartIgnoredAt',
      'lastStartIgnoredReason',
      'lastStopAt',
      'lastCleanupAt',
      'watchdogArmedAt',
      'watchdogTimedOutAt',
      'watchdogActive',
      'channels',
      'peerConnections',
    ]);
    expect(Object.keys(getSystemAudioSfuDebugSnapshot().guest)).toEqual([
      'pcState',
      'sessionId',
      'subscriptionKey',
      'subscribedTrackCount',
      'connectInFlight',
      'sourceStereo',
      'receiving',
      'allowsLocalAudience',
      'limitTimerActive',
      'limitBlocked',
      'shareRoute',
      'directRouteFrozen',
      'decoderPrimerCount',
    ]);
  });

  it('reports the placeholder, then the P2P attach in the guest section only, then idle after STOP', async () => {
    expect(await debugLines()).toEqual({
      playback: '[Playback] owner:file mode:file/playing receiving:no placeholder:no',
      directGuest: directGuestBlock(
        'receiving:no placeholder:no gotStereo:no',
        'no',
        'sourceStereo:no primer:no',
      ),
      sfuGuest: '[SFUGuest] session:- receiving:no connecting:no sourceStereo:no pc:none',
    });

    await start();
    expect(await debugLines()).toEqual({
      playback:
        '[Playback] owner:system-audio mode:system-audio/pending receiving:no placeholder:yes',
      directGuest: directGuestBlock(
        'receiving:no placeholder:yes gotStereo:no',
        'yes',
        'sourceStereo:no primer:no',
      ),
      sfuGuest: '[SFUGuest] session:- receiving:no connecting:no sourceStereo:no pc:none',
    });

    directCall().stream(streamOf(makeAudioTrack('p2p-track-a')));
    await advance(0);
    expect(webAudio.connectedTrackIds()).toEqual(['p2p-track-a']);
    expect(primerElements()).toHaveLength(1);
    expect(await debugLines()).toEqual({
      playback:
        '[Playback] owner:system-audio mode:system-audio/playing receiving:yes placeholder:yes',
      directGuest: directGuestBlock(
        'receiving:yes placeholder:yes gotStereo:yes',
        'no',
        'sourceStereo:yes primer:yes',
      ),
      sfuGuest: '[SFUGuest] session:- receiving:no connecting:no sourceStereo:no pc:none',
    });

    await stop();
    expect(await debugLines()).toEqual({
      playback: '[Playback] owner:none mode:none/idle receiving:no placeholder:no',
      directGuest: directGuestBlock(
        'receiving:no placeholder:no gotStereo:no',
        'no',
        'sourceStereo:no primer:no',
      ),
      sfuGuest: '[SFUGuest] session:- receiving:no connecting:no sourceStereo:no pc:none',
    });
  });

  // C4-3 deletes the guest's source, primer and gotStereo fields; the slot
  // keeps the direct call's source and primer apart, and these values must
  // keep meaning "the direct call attached a source" and "the direct call
  // holds a primer".
  it('reports the P2P primer apart from its source, and neither once the current call closes', async () => {
    // A stream before START is primed at the trust boundary, not attached.
    const early = directCall();
    early.stream(streamOf(makeAudioTrack('p2p-early')));
    await advance(0);
    expect((await debugLines()).directGuest).toEqual(
      directGuestBlock(
        'receiving:no placeholder:no gotStereo:no',
        'no',
        'sourceStereo:no primer:yes',
      ),
    );

    await start();
    expect(webAudio.connectedTrackIds()).toEqual(['p2p-early']);
    expect((await debugLines()).directGuest).toEqual(
      directGuestBlock(
        'receiving:yes placeholder:yes gotStereo:yes',
        'no',
        'sourceStereo:yes primer:yes',
      ),
    );

    // A replacement whose stream waits to unmute already holds the primer,
    // while the first stream's source plays on.
    const replacement = directCall();
    replacement.stream(streamOf(mutedTrack('p2p-muted-track').track));
    await advance(0);
    expect(webAudio.connectedTrackIds()).toEqual(['p2p-early']);
    expect(primerTrackIds()).toEqual([['p2p-muted-track']]);
    expect((await debugLines()).directGuest).toEqual(
      directGuestBlock(
        'receiving:yes placeholder:yes gotStereo:yes',
        'no',
        'sourceStereo:yes primer:yes',
      ),
    );

    // The transport closes the current call: reception ends idle.
    replacement.mediaConn.close();
    await advance(0);
    expect(webAudio.connectedTrackIds()).toEqual([]);
    expect(primerElements()).toHaveLength(0);
    expect(await debugLines()).toEqual({
      playback: '[Playback] owner:none mode:none/idle receiving:no placeholder:no',
      directGuest: directGuestBlock(
        'receiving:no placeholder:no gotStereo:no',
        'no',
        'sourceStereo:no primer:no',
      ),
      sfuGuest: '[SFUGuest] session:- receiving:no connecting:no sourceStereo:no pc:none',
    });
  });

  it('reports an SFU attach in the SFU section; the guest section shows only the shared receiving flags', async () => {
    await start();
    await ready('rt_host_session_1');
    await advance(SFU_SUBSCRIBED_AT_MS);
    expect(webAudio.connectedTrackIds()).toEqual(['sfu-remote-audio-1']);
    expect(await debugLines()).toEqual({
      playback:
        '[Playback] owner:system-audio mode:system-audio/playing receiving:yes placeholder:yes',
      directGuest: directGuestBlock(
        'receiving:yes placeholder:yes gotStereo:no',
        'no',
        'sourceStereo:no primer:no',
      ),
      sfuGuest:
        '[SFUGuest] session:rt_guest receiving:yes connecting:no sourceStereo:yes pc:new/new',
    });
  });
});
