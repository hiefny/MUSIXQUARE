/**
 * @vitest-environment jsdom
 *
 * C4-0 owner-boundary contract for the device-wide system-audio receive slot,
 * Standard lifecycle rows that the first C4-0 suites leave out. The core
 * Standard rows are in system-audio-receive-slot-contract.test.ts and the PRO
 * rows in src/pro-room/__tests__/system-audio-receive-slot-pro-contract.test.ts
 * and system-audio-receive-slot-pro-transport-contract.test.ts.
 *
 * Covered here, all at the slot's observable boundary:
 * - Standard P2P: duplicate START (supersession without a second begin), the
 *   host closing the direct call, a call error, and the muted-stream unmute
 *   wait the P2P adapter keeps (guest :309-358 in the C4 design).
 * - S8b on both Standard routes: the 30 s slot deadline firing while an attach
 *   waits in initAudio (the STOP half is in the core suite).
 * - Attach fences: a replacement call, a handoff to a pending READY, or a
 *   direct call that supersedes an attach waiting in initAudio, with the
 *   placeholder unchanged; the stale attach's resume and its rejection.
 * - Attach failures: a stream with no audio track, and a first SFU
 *   subscription that fails with no pending READY (silent until the slot
 *   deadline; an unchanged READY then subscribes again).
 * - Standard SFU: the two-hour remote receive limit stays per subscription (an
 *   unchanged READY keeps the first deadline, a handoff re-arms it from the new
 *   attach, a local-overflow subscription is limited too, and a rejoin lifts
 *   the block), and a lost host connection. These replace, at the boundary,
 *   the timer-name pins in system-audio-sfu.test.ts that C4-4 and C4-6 retire.
 * - The /debug guest and SFU sections, which C4-4 must keep per route.
 *
 * Real and replaced modules are the same as in the core Standard suite (see
 * its header and __helpers__/system-audio-receive-harness.ts). Assertions read
 * state, toasts, bus emissions, the receive deadline's warn lines, native
 * ledgers and the /debug snapshots only, never timer names. Each test pins main
 * be82ce09 (9.0.7) and is named "expected today" where a C4 increment may be
 * tempted to change it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG, SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { claimPlaybackOwner, createFileTrackMeta } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleData } from '../protocol.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';
import { getGuestSystemAudioShareRoute } from '../system-audio-delivery.ts';
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
  FakeRTCPeerConnection,
  installNativeGlobals,
  makeAudioTrack,
  makeMediaCall,
  media,
  observeReceiveBoundary,
  primerElements,
  realtime,
  resetNativeFakes,
  webAudio,
  type FakeMediaCall,
  type ReceiveObservations,
} from './__helpers__/system-audio-receive-harness.ts';

vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../audio/context.ts', async () => {
  const { webAudio: fake } = await import('./__helpers__/system-audio-receive-harness.ts');
  return { getAudioContext: () => fake.context };
});
vi.mock('../../audio/engine.ts', async () => {
  const { webAudio: fake } = await import('./__helpers__/system-audio-receive-harness.ts');
  return { initAudio: fake.initAudio, getWidener: fake.getWidener };
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
}));

const HOST_PEER = 'host-peer-0001';
// The Standard SFU subscriber's track is exposed once new-session and
// tracks-new have each taken the Realtime fake's latency (100 ms).
const SFU_TRACK_AT_MS = 200;
// The P2P adapter's bounded unmute wait and its settle window (guest module).
const UNMUTE_WAIT_MS = 2_000;
const UNMUTE_SETTLE_MS = 80;

let hostConn: DataConnection;
let previousTitle: string | undefined;
let seen: ReceiveObservations;

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

function newHostConn(peer = HOST_PEER): DataConnection {
  return { open: true, peer, send: vi.fn() } as unknown as DataConnection;
}

async function hostFrame(frame: Record<string, unknown>): Promise<void> {
  await handleData(frame, hostConn);
  await vi.advanceTimersByTimeAsync(0);
}

const start = (surface = 'display') => hostFrame({ type: MSG.SYSTEM_AUDIO_START, surface });
const stop = () => hostFrame({ type: MSG.SYSTEM_AUDIO_STOP });
const ready = (sessionId: string, extra: Record<string, unknown> = {}) =>
  hostFrame({
    type: MSG.SYSTEM_AUDIO_SFU_READY,
    version: 2,
    audience: 'remote',
    sessionId,
    track: { trackName: `stereo-${sessionId}`, mid: '0' },
    ...extra,
  });

/** A direct call whose transport-side 'error' the test can raise. */
function directCall(): FakeMediaCall & { fail(error: unknown): void } {
  const call = makeMediaCall(HOST_PEER);
  const conn = call.mediaConn as unknown as {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  const register = conn.on;
  let onError: ((error: unknown) => void) | null = null;
  conn.on = (event, handler) => {
    if (event === 'error') onError = handler;
    register(event, handler);
  };
  bus.emit('system-audio:incoming-call', call.mediaConn);
  return { ...call, fail: (error) => onError?.(error) };
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

/**
 * The slot's receive deadline as /debug sa reports it (the guest snapshot's
 * watchdog keys). A delivery handoff keeps the placeholder and re-arms this
 * deadline from the handoff.
 */
function receiveDeadline() {
  const { watchdogActive, watchdogArmedAt } = getSystemAudioGuestDebugSnapshot();
  return { armed: watchdogActive, armedAt: watchdogArmedAt };
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
  hostConn = newHostConn();
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
  setState('network.connectionType', 'remote');
  markQueueAuthorityReady(hostConn);
  // The guest was playing a local file before the share started.
  claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('previous-track.mp3') });
  previousTitle = getState('player.currentTrackMeta')?.title;
  seen = observeReceiveBoundary();
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

describe('Standard P2P: duplicate START, call close and error', () => {
  it('expected today: a duplicate START while pending is ignored, so the deadline and the surface stay with the first START', async () => {
    await start('window');
    await advance(10_000);
    await start('display');
    // The guest ignores a START while its placeholder stands: no second
    // reception start, no new surface and no fresh deadline. A slot whose
    // begin() re-runs on a held phase would change all three.
    expect(getState('player.currentTrackMeta')?.systemAudioSurface).toBe('window');
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);
    expect(seen.activities).toEqual(['pending']);

    await advance(19_999);
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(seen.counts.receiveTimeouts).toBe(1);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
  });

  it('expected today: a duplicate START while receiving leaves the source, the primer and the restore point alone', async () => {
    await start();
    const call = directCall();
    call.stream(streamOf(makeAudioTrack('p2p-a')));
    await advance(0);
    const [source] = webAudio.connected();
    const [primer] = primerElements();
    const activitiesBefore = seen.activities.length;

    await start();
    expect(webAudio.connected()).toEqual([source]);
    expect(primerElements()).toEqual([primer]);
    expect(slot()).toMatchObject({ receiving: true, activity: 'playing', placeholder: true });
    expect(seen.activities.slice(activitiesBefore)).toEqual([]);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(call.closeCount()).toBe(0);

    await stop();
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
  });

  it('expected today: the transport closing the direct call while receiving ends reception idle with no notice and leaves the route frozen on direct', async () => {
    await start();
    const call = directCall();
    call.stream(streamOf(makeAudioTrack('p2p-a')));
    await advance(0);
    expect(slot().receiving).toBe(true);

    call.mediaConn.close();
    expect(slot()).toEqual({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
      sources: [],
      primers: 0,
    });
    await advance(60_000);
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
    // Ending reception does not reset the share route: a remote-audience
    // READY is ignored until the next START resets it.
    expect(getGuestSystemAudioShareRoute()).toBe('direct');
    await ready('rt_host_session_1');
    await advance(1_000);
    expect(realtime.count('new-session')).toBe(0);
    await start();
    expect(getGuestSystemAudioShareRoute()).toBe('unselected');
  });

  it('expected today: a call error closes the call, and during pending that ends reception silently instead of with receive_failed', async () => {
    await start();
    await advance(5_000);
    const call = directCall();
    call.fail(new Error('negotiation failed'));
    // The error closes the exact call, and its close ends the placeholder: a
    // silent end, unlike the slot deadline's receive_failed (a notice parity
    // the C4 design leaves open).
    expect(call.closeCount()).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
    });
    await advance(60_000);
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
  });
});

describe('Standard P2P: the muted-stream unmute wait', () => {
  it('a muted stream is primed at once and attaches 80 ms after it unmutes', async () => {
    await start();
    const muted = mutedTrack('p2p-muted');
    directCall().stream(streamOf(muted.track));
    await advance(0);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      sources: [],
      primers: 1,
    });

    await advance(500);
    muted.unmute();
    await advance(UNMUTE_SETTLE_MS - 1);
    expect(slot()).toMatchObject({ receiving: false, sources: [] });
    await advance(1);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      sources: ['p2p-muted'],
      primers: 1,
    });
  });

  it('a stream that never unmutes attaches anyway when the 2 s unmute wait ends', async () => {
    await start();
    directCall().stream(streamOf(mutedTrack('p2p-silent').track));
    await advance(UNMUTE_WAIT_MS - 1);
    expect(slot()).toMatchObject({ receiving: false, sources: [] });
    await advance(1);
    expect(slot()).toMatchObject({ receiving: true, sources: ['p2p-silent'] });
    expect(seen.toasts).toEqual([]);
  });

  it('S8 (unmute wait): STOP during the unmute wait never connects, and a late unmute changes nothing', async () => {
    await start();
    const muted = mutedTrack('p2p-muted');
    const call = directCall();
    call.stream(streamOf(muted.track));
    await advance(500);
    await stop();
    expect(call.closeCount()).toBe(1);

    muted.unmute();
    await advance(UNMUTE_WAIT_MS * 2);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toEqual({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual([]);
  });
});

describe('S8b: the slot deadline while a Standard attach waits in initAudio', () => {
  it.each([
    {
      route: 'P2P',
      deliverAt: 29_800,
      deliver: async () => {
        directCall().stream(streamOf(makeAudioTrack('p2p-a')));
        await advance(0);
      },
    },
    {
      route: 'SFU',
      deliverAt: 29_500,
      deliver: async () => {
        await ready('rt_host_session_1');
        await advance(SFU_TRACK_AT_MS);
      },
    },
  ])(
    'S8b ($route): the 30 s deadline that fires while the attach waits in initAudio ends reception once, and the late attach never connects',
    async ({ deliverAt, deliver }) => {
      const startedAt = Date.now();
      await start();
      await advance(deliverAt);
      webAudio.suspend();
      await deliver();
      expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });
      expect(seen.toasts).toEqual([]);

      await advance(startedAt + 30_000 - Date.now());
      expect(seen.toasts).toEqual(['system_audio.receive_failed']);
      expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });

      await advance(100);
      webAudio.finishResume();
      await advance(1_000);
      // The route's own identity check after `await initAudio()` keeps the
      // late attach out (the P2P call and the SFU subscriber PC were both
      // retired by the deadline). C4-3/C4-4 replace it with slot.attach and
      // must keep this outcome.
      expect(webAudio.sources).toHaveLength(0);
      expect(slot()).toEqual({
        receiving: false,
        mode: null,
        activity: 'idle',
        title: previousTitle,
        placeholder: false,
        sources: [],
        primers: 0,
      });
      expect(seen.toasts).toEqual(['system_audio.receive_failed']);
      expect(seen.counts.receiveTimeouts).toBe(1);
    },
  );
});

describe('attach fences: a superseded Standard attach waiting in initAudio (C4-3, C4-4)', () => {
  // The placeholder and the restore point stay put in every row, so only each
  // adapter's own identity check after `await initAudio()` (the current P2P
  // call, the current subscriber PC) and its rejection gate keep the stale
  // attach out. slot.attach must keep these outcomes when C4-3 and C4-4 move
  // the attach.

  it('expected today (P2P): a replacement call while the first stream waits in initAudio keeps the first out by call identity alone; only the replacement connects', async () => {
    await start();
    webAudio.suspend();
    const first = directCall();
    first.stream(streamOf(makeAudioTrack('p2p-a')));
    await advance(100);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
      primers: 1,
    });

    const second = directCall();
    expect(first.closeCount()).toBe(1);
    second.stream(streamOf(makeAudioTrack('p2p-b')));
    await advance(100);
    webAudio.finishResume();
    await advance(0);
    expect(webAudio.sources.map((source) => source.trackIds)).toEqual([['p2p-b']]);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['p2p-b'],
      primers: 1,
    });
    expect(seen.toasts).toEqual([]);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);

    await stop();
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
  });

  it('expected today (P2P): when the superseded attach fails in initAudio, its rejection neither ends reception nor shows receive_failed', async () => {
    await start();
    webAudio.suspend();
    directCall().stream(streamOf(makeAudioTrack('p2p-a')));
    await advance(100);
    const second = directCall();
    await advance(200);
    second.stream(streamOf(makeAudioTrack('p2p-b')));

    // The first attach's initAudio gives up at 500 ms; the second waits on.
    await advance(300);
    expect(seen.toasts).toEqual([]);
    expect(second.closeCount()).toBe(0);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    webAudio.finishResume();
    await advance(0);
    expect(slot()).toMatchObject({ receiving: true, activity: 'playing', sources: ['p2p-b'] });
    expect(webAudio.sources).toHaveLength(1);
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
  });

  it('expected today (SFU): a handoff to a pending READY while the first track waits in initAudio keeps it out by subscriber-PC identity alone; only the handoff track connects', async () => {
    await start();
    webAudio.suspend();
    realtime.injectFault('renegotiate', 'fail');
    const readyAt = Date.now();
    await ready('rt_host_session_a');
    await advance(50);
    await ready('rt_host_session_b');
    // The first track waits in initAudio from 200 ms; renegotiate fails at
    // 300 ms and hands off to the pending READY.
    await advance(SFU_TRACK_AT_MS + 50);
    expect(receiveDeadline()).toEqual({ armed: true, armedAt: readyAt + 300 });
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    webAudio.finishResume();
    await advance(0);
    expect(webAudio.sources).toHaveLength(0);

    await advance(SFU_TRACK_AT_MS);
    expect(webAudio.sources.map((source) => source.trackIds)).toEqual([['sfu-remote-audio-2']]);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['sfu-remote-audio-2'],
      primers: 1,
    });
    expect(seen.toasts).toEqual([]);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
  });

  it('expected today (SFU): when the first track then fails in initAudio after the handoff, its rejection neither releases the successor subscription nor shows receive_failed', async () => {
    await start();
    webAudio.suspend();
    realtime.injectFault('renegotiate', 'fail');
    const readyAt = Date.now();
    await ready('rt_host_session_a');
    await advance(50);
    await ready('rt_host_session_b');

    // The first attach's initAudio gives up at 700 ms; the handoff track has
    // waited since 500 ms.
    await advance(700);
    expect(receiveDeadline()).toEqual({ armed: true, armedAt: readyAt + 300 });
    expect(seen.toasts).toEqual([]);
    expect(FakeRTCPeerConnection.instances[1].closed).toBe(false);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    webAudio.finishResume();
    await advance(0);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-2'] });
    expect(webAudio.sources).toHaveLength(1);
    expect(seen.toasts).toEqual([]);
  });

  it('expected today (SFU to P2P): a direct call while the SFU track waits in initAudio retires the subscription; only the P2P stream connects', async () => {
    await start();
    webAudio.suspend();
    await ready('rt_host_session_1');
    await advance(SFU_TRACK_AT_MS + 100);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });

    const call = directCall();
    expect(receiveDeadline()).toEqual({ armed: true, armedAt: Date.now() });
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    call.stream(streamOf(makeAudioTrack('p2p-a')));
    webAudio.finishResume();
    await advance(0);
    expect(webAudio.sources.map((source) => source.trackIds)).toEqual([['p2p-a']]);
    expect(slot()).toMatchObject({ receiving: true, activity: 'playing', sources: ['p2p-a'] });
    expect(getGuestSystemAudioShareRoute()).toBe('direct');
    expect(seen.toasts).toEqual([]);
  });
});

describe('Standard attach failures and a silent first subscription failure', () => {
  it('expected today: a direct stream with no audio track ends reception with receive_failed before any primer', async () => {
    await start();
    const call = directCall();
    call.stream(streamOf());
    await advance(0);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(call.closeCount()).toBe(1);
    expect(slot()).toEqual({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
      sources: [],
      primers: 0,
    });
    expect(seen.counts.receiveTimeouts).toBe(0);
  });

  it('expected today: a failed first SFU subscription with no pending READY is silent, and the placeholder waits for the slot deadline', async () => {
    const startedAt = Date.now();
    await start();
    realtime.injectFault('new-session', 'fail');
    await ready('rt_host_session_1');
    await advance(1_000);
    // The adapter releases only its transport: nothing was attached, so the
    // shared receive cleanup is skipped and no notice is shown (C4-4's
    // failure policy per route, notice parity open in the C4 design).
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(seen.toasts).toEqual([]);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });

    await advance(startedAt + 30_000 - 1 - Date.now());
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(seen.counts.receiveTimeouts).toBe(1);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
    expect(getGuestSystemAudioShareRoute()).toBe('sfu-remote');
  });

  it('expected today: an unchanged READY after a failed subscription subscribes again (a live one is kept), and its track attaches under the first deadline', async () => {
    const startedAt = Date.now();
    await start();
    realtime.injectFault('new-session', 'fail');
    await ready('rt_host_session_1');
    await advance(10_000);
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);

    await ready('rt_host_session_1');
    await advance(SFU_TRACK_AT_MS);
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(realtime.count('new-session')).toBe(2);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      sources: ['sfu-remote-audio-2'],
    });
    // The attach cleared the START deadline: nothing ends reception at 30 s.
    await advance(startedAt + 60_000 - Date.now());
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-2'] });
  });
});

describe('Standard SFU: the two-hour limit stays per subscription', () => {
  it('expected today: an unchanged READY while receiving keeps the subscription, the source and the first limit deadline', async () => {
    await start();
    const readyAt = Date.now();
    await ready('rt_host_session_a');
    await advance(1_000);
    const [source] = webAudio.connected();
    expect(source?.trackIds).toEqual(['sfu-remote-audio-1']);

    // The host re-announces its unchanged publication (peer re-evaluation).
    await advance(30 * 60 * 1_000);
    await ready('rt_host_session_a');
    await advance(1_000);
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(false);
    expect(realtime.count('new-session')).toBe(1);
    expect(webAudio.connected()).toEqual([source]);

    // The limit still counts from the first attach, not from the re-announce.
    await advance(readyAt + SFU_TRACK_AT_MS + SYSTEM_AUDIO_SHARE_LIMIT_MS - 1 - Date.now());
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.remote_receive_limit']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
  });

  it('expected today: a handoff to a pending READY re-arms the limit from the new attach', async () => {
    await start();
    realtime.injectFault('renegotiate', 'fail');
    const readyAt = Date.now();
    await ready('rt_host_session_a');
    await advance(50);
    await ready('rt_host_session_b');
    // The first track attached at 200 ms and armed the limit; renegotiate
    // failed at 300 ms and handed off to the pending READY, whose track
    // attached at 500 ms.
    await advance(1_000);
    // The handoff re-armed the slot deadline; the handoff track's attach met it.
    expect(receiveDeadline()).toEqual({ armed: false, armedAt: readyAt + 300 });
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-2'] });

    await advance(readyAt + SFU_TRACK_AT_MS + SYSTEM_AUDIO_SHARE_LIMIT_MS - Date.now());
    expect(seen.toasts).toEqual([]);
    const secondAttachAt = readyAt + 300 + SFU_TRACK_AT_MS;
    await advance(secondAttachAt + SYSTEM_AUDIO_SHARE_LIMIT_MS - 1 - Date.now());
    expect(seen.toasts).toEqual([]);
    expect(slot().sources).toEqual(['sfu-remote-audio-2']);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.remote_receive_limit']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
  });

  it('expected today: a local-overflow subscription is limited too; the block holds for the same host connection and a rejoin lifts it for a subscription with its own limit', async () => {
    setState('network.connectionType', 'local');
    await start();
    const firstReadyAt = Date.now();
    await ready('rt_host_session_a', { audience: 'all' });
    await advance(1_000);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-1'] });
    expect(getGuestSystemAudioShareRoute()).toBe('sfu-all');

    await advance(firstReadyAt + SFU_TRACK_AT_MS + SYSTEM_AUDIO_SHARE_LIMIT_MS - Date.now());
    expect(seen.toasts).toEqual(['system_audio.remote_receive_limit']);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
    expect(getSystemAudioSfuDebugSnapshot().guest.limitBlocked).toBe(true);

    // The same host connection's next READY is ignored.
    await start();
    await ready('rt_host_session_b', { audience: 'all' });
    await advance(1_000);
    expect(realtime.count('new-session')).toBe(1);
    await stop();

    // The guest loses the host and rejoins with a new connection.
    setState('network.hostConn', null);
    bus.emit('network:peer-disconnected', HOST_PEER);
    expect(getSystemAudioSfuDebugSnapshot().guest.limitBlocked).toBe(false);
    hostConn = newHostConn();
    setState('network.hostConn', hostConn);
    markQueueAuthorityReady(hostConn);
    await start();
    const rejoinedReadyAt = Date.now();
    await ready('rt_host_session_c', { audience: 'all' });
    await advance(1_000);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-2'] });

    await advance(rejoinedReadyAt + SFU_TRACK_AT_MS + SYSTEM_AUDIO_SHARE_LIMIT_MS - 1 - Date.now());
    expect(seen.toasts).toEqual(['system_audio.remote_receive_limit']);
    await advance(1);
    expect(seen.toasts).toEqual([
      'system_audio.remote_receive_limit',
      'system_audio.remote_receive_limit',
    ]);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
  });

  it('expected today: losing the host connection while receiving over the SFU ends reception idle with no notice and leaves the route frozen', async () => {
    await start();
    await ready('rt_host_session_1');
    await advance(1_000);
    expect(slot().receiving).toBe(true);

    setState('network.hostConn', null);
    bus.emit('network:peer-disconnected', HOST_PEER);
    expect(slot()).toEqual({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
      sources: [],
      primers: 0,
    });
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    await advance(0);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(getGuestSystemAudioShareRoute()).toBe('sfu-remote');
    await advance(SYSTEM_AUDIO_SHARE_LIMIT_MS);
    expect(seen.toasts).toEqual([]);
  });
});

describe('/debug sections per route', () => {
  function debugView() {
    const guest = getSystemAudioGuestDebugSnapshot();
    const sfu = getSystemAudioSfuDebugSnapshot().guest;
    return {
      guest: {
        systemReceiving: guest.systemReceiving,
        placeholder: guest.placeholder,
        sourceStereo: guest.sourceStereo,
        decoderPrimer: guest.decoderPrimer,
        watchdogActive: guest.watchdogActive,
      },
      sfu: {
        receiving: sfu.receiving,
        sourceStereo: sfu.sourceStereo,
        decoderPrimerCount: sfu.decoderPrimerCount,
        limitTimerActive: sfu.limitTimerActive,
        shareRoute: sfu.shareRoute,
      },
    };
  }

  it('the guest section reports the P2P source and the slot deadline; the SFU section stays empty', async () => {
    await start();
    expect(debugView()).toEqual({
      guest: {
        systemReceiving: false,
        placeholder: true,
        sourceStereo: false,
        decoderPrimer: false,
        watchdogActive: true,
      },
      sfu: {
        receiving: false,
        sourceStereo: false,
        decoderPrimerCount: 0,
        limitTimerActive: false,
        shareRoute: 'unselected',
      },
    });

    directCall().stream(streamOf(makeAudioTrack('p2p-a')));
    await advance(0);
    expect(debugView()).toEqual({
      guest: {
        systemReceiving: true,
        placeholder: true,
        sourceStereo: true,
        decoderPrimer: true,
        watchdogActive: false,
      },
      sfu: {
        receiving: false,
        sourceStereo: false,
        decoderPrimerCount: 0,
        limitTimerActive: false,
        shareRoute: 'direct',
      },
    });
  });

  it('the SFU section reports its own source, primer and limit; the guest section shows only the shared flags', async () => {
    await start();
    await ready('rt_host_session_1');
    await advance(1_000);
    // C4-4 must keep these keys meaning "attached by the Standard SFU", not
    // "the slot has a source" (C4 critique, /debug semantics).
    expect(debugView()).toEqual({
      guest: {
        systemReceiving: true,
        placeholder: true,
        sourceStereo: false,
        decoderPrimer: false,
        watchdogActive: false,
      },
      sfu: {
        receiving: true,
        sourceStereo: true,
        decoderPrimerCount: 1,
        limitTimerActive: true,
        shareRoute: 'sfu-remote',
      },
    });
  });
});
