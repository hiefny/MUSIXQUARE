/**
 * @vitest-environment jsdom
 *
 * C4-0 owner-boundary contract for the device-wide system-audio receive slot,
 * Standard rooms (P2P direct call and Standard SFU guest). The PRO coordinator
 * paths are in src/pro-room/__tests__/system-audio-receive-slot-pro-contract.test.ts.
 *
 * Registry records (docs/design/resource-ownership-registry.md):
 * - RO-04 System-audio receive slot: systemAudio.isReceiving, the 'system-audio'
 *   receive claim and placeholder meta, the restore meta, the source on
 *   widener.input, the decoder primer and the receive deadline.
 * - RO-16 Data-PC SDP lane: Standard P2P media calls share it; not modeled here.
 *
 * Real: network/system-audio-guest.ts (trusted reception, 30 s watchdog, P2P
 * attach, cleanup), network/system-audio-sfu.ts (guest subscription, attach,
 * two-hour limit), network/system-audio-delivery.ts (share route freeze),
 * network/protocol.ts (host frames), player/ownership.ts, core/state, bus and
 * managed timers, and the decoder primer. Listeners register once, in the
 * production order (guest, then SFU); system-audio-host.ts (sender side) and
 * the PRO service are not registered in this file.
 *
 * Replaced, all native seams (see __helpers__/system-audio-receive-harness.ts
 * for what each fake models and leaves out): Web Audio (source ledger on
 * widener.input, initAudio's running gate), the P2P media call, the Cloudflare
 * Realtime API behind fetchWithCapability, RTCPeerConnection, MediaStream,
 * media teardown (stopAllMedia spy), the Standard TURN loader (no TURN) and the
 * local capture module (sender side, inactive). i18n returns keys.
 *
 * Assertions read state, toasts, bus emissions and the native ledgers only,
 * never timer names. Each test pins today's behaviour on main d84f53f5 (9.0.3;
 * the fix lanes since c08b6c39 changed only PRO reception); a comment names
 * every known gap and the increment planned for it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { claimPlaybackOwner, createFileTrackMeta } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleData } from '../protocol.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';
import { getGuestSystemAudioShareRoute } from '../system-audio-delivery.ts';
import { registerSystemAudioGuestListeners } from '../system-audio-guest.ts';
import { registerSystemAudioSfuListeners } from '../system-audio-sfu.ts';
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
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
// new-session and tracks-new each take the fake's 100 ms before the subscriber
// offer exposes the remote track; renegotiate completes 100 ms later.
const SFU_TRACK_AT_MS = 200;

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

async function hostFrame(frame: Record<string, unknown>): Promise<void> {
  await handleData(frame, hostConn);
  await vi.advanceTimersByTimeAsync(0);
}

const start = (surface?: string) =>
  hostFrame({ type: MSG.SYSTEM_AUDIO_START, ...(surface ? { surface } : {}) });
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

function directCall(): FakeMediaCall {
  const call = makeMediaCall(HOST_PEER);
  bus.emit('system-audio:incoming-call', call.mediaConn, 'STEREO');
  return call;
}

function streamOf(trackId: string): MediaStream {
  return new FakeMediaStream([makeAudioTrack(trackId)]) as unknown as MediaStream;
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

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
  previousTitle = getState('player.currentTrackMeta')?.title;
  seen = observeReceiveBoundary();
});

afterEach(() => {
  // Retire the guest and SFU module slots through their own teardown event.
  bus.emit('system-audio:force-stop');
  seen.dispose();
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('Standard P2P receive: begin, attach, cleanup', () => {
  it('S1: START opens a pending placeholder, a direct stream attaches one source, STOP restores the previous title', async () => {
    await start('window');
    expect(slot()).toEqual({
      receiving: false,
      mode: 'system-audio',
      activity: 'pending',
      title: 'Receiving System Audio',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(getState('player.currentTrackMeta')?.systemAudioSurface).toBe('window');
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(seen.counts.hostStarted).toBe(1);

    const call = directCall();
    call.stream(streamOf('p2p-audio-1'));
    await advance(0);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      placeholder: true,
      sources: ['p2p-audio-1'],
      primers: 1,
    });
    expect(call.receivers.map((receiver) => receiver.playoutDelayHint)).toEqual([0.5]);
    expect(seen.counts.visualizerStarts).toBe(1);

    await stop();
    expect(slot()).toEqual({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
      sources: [],
      primers: 0,
    });
    expect(call.closeCount()).toBe(1);
    expect(seen.toasts).toEqual([]);
    expect(webAudio.maxConnected).toBe(1);
  });

  it('S2: a START without a stream ends at the 30 s slot deadline with one receive_failed', async () => {
    await start();
    await advance(29_999);
    expect(slot().placeholder).toBe(true);
    expect(seen.toasts).toEqual([]);

    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(seen.counts.receiveTimeouts).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
    });
  });

  it('trusted boundary: a stream that arrives before START is primed but attaches only once START commits', async () => {
    const call = directCall();
    call.stream(streamOf('p2p-early'));
    await advance(1_000);
    // The P2P adapter primes the decoder before the trust gate; the SFU and
    // PRO adapters prime only after it (a receive parity gap the C4 slot
    // design keeps on purpose; unifying it is an owner decision).
    expect(slot()).toMatchObject({ receiving: false, sources: [], primers: 1 });
    expect(media.stopAllMedia).not.toHaveBeenCalled();

    await start();
    expect(slot()).toMatchObject({ receiving: true, sources: ['p2p-early'], primers: 1 });
  });

  it('trusted boundary: a stream whose START never comes is closed after 30 s without touching playback', async () => {
    const call = directCall();
    call.stream(streamOf('p2p-untrusted'));
    await advance(29_999);
    expect(call.closeCount()).toBe(0);

    await advance(1);
    expect(call.closeCount()).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: 'file',
      activity: 'playing',
      title: previousTitle,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual([]);
  });

  it('a same-channel replacement keeps the old source until its stream attaches; a silent one ends at 30 s', async () => {
    await start();
    const first = directCall();
    first.stream(streamOf('p2p-a'));
    await advance(0);

    const second = directCall();
    expect(first.closeCount()).toBe(1);
    expect(slot().sources).toEqual(['p2p-a']);
    second.stream(streamOf('p2p-b'));
    await advance(0);
    expect(slot()).toMatchObject({ receiving: true, sources: ['p2p-b'], primers: 1 });

    const third = directCall();
    await advance(29_999);
    expect(slot().sources).toEqual(['p2p-b']);
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(seen.counts.receiveTimeouts).toBe(1);
    expect(third.closeCount()).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'idle',
      title: previousTitle,
      sources: [],
      primers: 0,
    });
    expect(webAudio.maxConnected).toBe(1);
  });

  it('a suspended context that does not resume ends Standard reception with receive_failed (iOS)', async () => {
    await start();
    webAudio.suspend();
    const call = directCall();
    call.stream(streamOf('p2p-a'));
    await advance(499);
    expect(seen.toasts).toEqual([]);

    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(call.closeCount()).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'idle',
      title: previousTitle,
      sources: [],
      primers: 0,
    });
  });

  it('S8b: STOP while initAudio waits after the boundary resolved never connects', async () => {
    await start();
    webAudio.suspend();
    directCall().stream(streamOf('p2p-a'));
    await advance(100);
    await stop();

    webAudio.finishResume();
    await advance(1_000);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
    expect(seen.toasts).toEqual([]);
  });
});

describe('Standard P2P receive: successor owners and force-stop', () => {
  it('S9: a successor owner during pending is never overwritten by the deadline or STOP', async () => {
    await start();
    claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') });

    await advance(30_000);
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
    await stop();
    expect(slot()).toMatchObject({ mode: 'file', activity: 'playing', title: 'successor' });

    // A stream that arrives after the successor waits for a START that never
    // comes and is closed; it never reaches the graph.
    const late = directCall();
    late.stream(streamOf('p2p-late'));
    await advance(30_000);
    expect(late.closeCount()).toBe(1);
    expect(webAudio.sources).toHaveLength(0);
  });

  it('a fresh START after a successor replaced the pending placeholder begins again from the successor', async () => {
    await start('window');
    await advance(10_000);
    claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') });
    await advance(5_000);

    // No cleanup ran between the two STARTs: the first restore point was
    // never consumed. The slot must still accept the new reception (a begin
    // gated on a stored 'pending' phase or a held restore point would refuse
    // it), and its restore point is the successor, not the first title.
    await start();
    expect(slot()).toMatchObject({
      receiving: false,
      mode: 'system-audio',
      activity: 'pending',
      placeholder: true,
    });
    expect(getState('player.currentTrackMeta')?.systemAudioSurface).toBe('display');
    expect(media.stopAllMedia).toHaveBeenCalledTimes(2);
    expect(seen.counts.hostStarted).toBe(2);

    // The deadline counts from the fresh START (15 s), not from the first one.
    await advance(29_999);
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(seen.counts.receiveTimeouts).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: 'successor',
      placeholder: false,
    });
  });

  it('S9 gap: a successor that claims playback while initAudio waits is overwritten by the attach', async () => {
    await start();
    webAudio.suspend();
    directCall().stream(streamOf('p2p-a'));
    await advance(100);
    claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') });

    webAudio.finishResume();
    await advance(0);
    // Known gap (C4 critique, S9): none of the three attach copies re-checks
    // the placeholder or owner after `await initAudio()`, so system audio
    // takes playback back under the successor's title. Planned: the slot's
    // attach fence (C4-3), an intended change needing owner sign-off.
    expect(slot()).toMatchObject({
      receiving: true,
      mode: 'system-audio',
      activity: 'playing',
      title: 'successor',
      sources: ['p2p-a'],
    });
  });

  it('force-stop ends reception as a transition: no toast, no second media stop, nothing resumed', async () => {
    await start();
    const call = directCall();
    call.stream(streamOf('p2p-a'));
    await advance(0);

    bus.emit('system-audio:force-stop');
    // Like STOP, a receiver restores only the previous title; neither resumes
    // the previous media (resuming the room's media is the host's decision).
    expect(slot()).toEqual({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
      sources: [],
      primers: 0,
    });
    expect(call.closeCount()).toBe(1);
    expect(getGuestSystemAudioShareRoute()).toBe('unselected');
    await advance(60_000);
    expect(seen.toasts).toEqual([]);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(1);
  });
});

describe('Standard SFU guest receive', () => {
  it('S3: a READY subscribes, the remote track attaches once, and STOP closes the subscription', async () => {
    await start();
    await ready('rt_host_session_1');
    await advance(1_000);
    expect(slot()).toMatchObject({
      receiving: true,
      activity: 'playing',
      sources: ['sfu-remote-audio-1'],
      primers: 1,
    });
    expect(FakeRTCPeerConnection.instances[0].receiver.playoutDelayHint).toBe(0.5);
    expect(getGuestSystemAudioShareRoute()).toBe('sfu-remote');
    expect(seen.counts.visualizerStarts).toBe(1);

    await stop();
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'idle',
      title: previousTitle,
      sources: [],
      primers: 0,
    });
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(getGuestSystemAudioShareRoute()).toBe('unselected');
    expect(seen.toasts).toEqual([]);
  });

  it('S3: a failed subscribe with a pending READY hands off, keeping the placeholder with receiving false', async () => {
    await start();
    realtime.injectFault('renegotiate', 'fail');
    await ready('rt_host_session_a');
    await advance(50);
    await ready('rt_host_session_b');
    await advance(SFU_TRACK_AT_MS);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-1'] });

    // Renegotiate fails at 300 ms: the attached source leaves, while the
    // placeholder and restore point stay.
    await advance(100);
    expect(seen.counts.deliveryHandoffs).toBe(1);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'pending',
      placeholder: true,
      sources: [],
    });

    await advance(1_000);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-2'] });
    expect(webAudio.maxConnected).toBe(1);
    await advance(60_000);
    expect(seen.toasts).toEqual([]);
    await stop();
    expect(slot().title).toBe(previousTitle);
  });

  it('S3: a handoff re-arms the 30 s slot deadline from the handoff, not from START', async () => {
    await start();
    realtime.injectFault('renegotiate', 'fail');
    await ready('rt_host_session_a');
    await advance(50);
    realtime.injectFault('new-session', 'hang');
    await ready('rt_host_session_b');

    // The first track attached at 200 ms (clearing START's deadline) and the
    // handoff at 300 ms armed a new one. The pending READY's session hangs
    // until its 15 s request deadline fails it at 15.3 s; that failure finds
    // no receiving state to end (the handoff cleared it), so only the re-armed
    // slot deadline ends reception.
    await advance(15_249);
    expect(seen.counts.deliveryHandoffs).toBe(1);
    expect(FakeRTCPeerConnection.instances[1].closed).toBe(false);
    await advance(1);
    expect(FakeRTCPeerConnection.instances[1].closed).toBe(true);
    expect(seen.toasts).toEqual([]);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', placeholder: true });
    await advance(14_999);
    expect(seen.toasts).toEqual([]);
    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(seen.counts.receiveTimeouts).toBe(1);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
  });

  it('a suspended context fails a Standard SFU attach with receive_failed and releases the subscription', async () => {
    await start();
    webAudio.suspend();
    await ready('rt_host_session_1');
    await advance(SFU_TRACK_AT_MS + 499);
    expect(seen.toasts).toEqual([]);

    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'idle',
      title: previousTitle,
      sources: [],
    });
    // Like the slot deadline, an attach failure ends reception but leaves the
    // frozen share route alone until the next START resets it.
    await advance(60_000);
    expect(getGuestSystemAudioShareRoute()).toBe('sfu-remote');
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    await start();
    expect(getGuestSystemAudioShareRoute()).toBe('unselected');
  });

  it('trusted boundary: a READY after the slot deadline subscribes, but its track never attaches and the subscription closes 30 s later', async () => {
    await start();
    await advance(30_000);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    await advance(1_000);

    await ready('rt_host_session_1');
    await advance(SFU_TRACK_AT_MS);
    // The subscriber offer exposed the remote track, which now waits at the
    // trusted boundary: no placeholder holds a reception for it.
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      sources: [],
      primers: 0,
    });
    await advance(29_999);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(false);
    expect(realtime.count('tracks-close')).toBe(0);

    // The boundary gives up 30 s after the track and the adapter closes the
    // subscriber PC and its Realtime tracks, without a second notice.
    await advance(1);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    await advance(60_000);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(seen.counts.receiveTimeouts).toBe(1);
  });

  it('trusted boundary: a READY after a successor replaced the placeholder never attaches; the subscription closes and the successor plays on', async () => {
    await start();
    await advance(5_000);
    claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') });
    await ready('rt_host_session_1');
    await advance(SFU_TRACK_AT_MS);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: 'file',
      activity: 'playing',
      title: 'successor',
      sources: [],
      primers: 0,
    });

    // The START's watchdog (at 30 s) finds no placeholder and stays silent, so
    // only the boundary's own 30 s wait releases the subscription.
    await advance(29_999);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(false);
    await advance(1);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({ mode: 'file', activity: 'playing', title: 'successor' });
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
  });

  it('a live subscriber connection failure ends reception idle with no notice and leaves the route frozen', async () => {
    await start();
    await ready('rt_host_session_1');
    await advance(1_000);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-1'] });

    FakeRTCPeerConnection.instances[0].setConnectionState('failed');
    // An end, not a retire: the adapter's full cleanup restores the previous
    // title and closes the subscription. C4-4 registers the SFU retire as
    // cleanupGuestSfu(false) plus a route reset; this path must keep ending
    // reception (a retire here would leave a silent 'playing' placeholder).
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

    // Nothing is left to time out: no deadline and no notice afterwards. The
    // silent end differs from the deadline's receive_failed and from PRO's
    // connection_unstable, a notice parity the C4 design leaves to the owner.
    await advance(60_000);
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
    expect(getGuestSystemAudioShareRoute()).toBe('sfu-remote');
  });

  it('S9 gap (SFU): a successor that claims playback while the SFU attach waits in initAudio is overwritten', async () => {
    await start();
    webAudio.suspend();
    await ready('rt_host_session_1');
    await advance(SFU_TRACK_AT_MS + 100);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });
    claimPlaybackOwner('file', { currentTrackMeta: createFileTrackMeta('successor.mp3') });

    webAudio.finishResume();
    await advance(0);
    // Known gap (C4 critique S9, same as the P2P row): connectGuestTrack
    // re-checks only its subscriber PC after `await initAudio()`, so system
    // audio takes playback back under the successor's title. Planned: the
    // slot's attach fence (C4-3), which C4-4 inherits for this route; an
    // intended change needing owner sign-off.
    expect(slot()).toMatchObject({
      receiving: true,
      mode: 'system-audio',
      activity: 'playing',
      title: 'successor',
      sources: ['sfu-remote-audio-1'],
    });
  });

  it('S8b (SFU): STOP while the SFU attach waits in initAudio after the boundary resolved never connects', async () => {
    await start();
    webAudio.suspend();
    await ready('rt_host_session_1');
    await advance(SFU_TRACK_AT_MS + 100);
    expect(slot()).toMatchObject({ receiving: false, activity: 'pending', sources: [] });
    await stop();

    webAudio.finishResume();
    await advance(1_000);
    // The Standard SFU half of S8b (the P2P half is in the P2P block): today
    // only connectGuestTrack's post-initAudio subscriber-PC check keeps the
    // retired attach out. C4-4 replaces this section with slot.attach and
    // must keep the outcome.
    expect(webAudio.sources).toHaveLength(0);
    expect(slot()).toMatchObject({
      receiving: false,
      mode: null,
      activity: 'idle',
      title: previousTitle,
      placeholder: false,
      sources: [],
    });
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(realtime.count('tracks-close')).toBe(1);
    expect(seen.toasts).toEqual([]);
  });

  it('S3: a direct call that arrives mid-SFU disconnects the SFU source before the P2P source connects', async () => {
    await start();
    await ready('rt_host_session_1');
    await advance(1_000);

    const call = directCall();
    expect(seen.counts.deliveryHandoffs).toBe(1);
    expect(slot()).toMatchObject({ receiving: false, placeholder: true, sources: [] });
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);

    call.stream(streamOf('p2p-a'));
    await advance(0);
    expect(slot()).toMatchObject({ receiving: true, sources: ['p2p-a'] });
    expect(getGuestSystemAudioShareRoute()).toBe('direct');
    expect(webAudio.maxConnected).toBe(1);
    expect(seen.toasts).toEqual([]);
  });

  it('S4: a READY handed off from a failed direct route re-begins with the same surface', async () => {
    await start('window');
    const call = directCall();
    call.stream(streamOf('p2p-a'));
    await advance(0);

    await ready('rt_host_session_1', { audience: 'all', handoffFromDirect: true });
    // The handoff ends the direct reception and runs the reception start
    // again (media stop and host-started included), passing through idle
    // within the same turn; the restore point is the title it just restored.
    expect(call.closeCount()).toBe(1);
    expect(media.stopAllMedia).toHaveBeenCalledTimes(2);
    expect(seen.counts.hostStarted).toBe(2);
    expect(seen.activities).toEqual(['pending', 'playing', 'pending', 'idle', 'pending']);
    expect(getState('player.currentTrackMeta')?.systemAudioSurface).toBe('window');
    expect(getGuestSystemAudioShareRoute()).toBe('sfu-all');

    await advance(1_000);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-1'] });
    expect(webAudio.maxConnected).toBe(1);
    await stop();
    expect(slot().title).toBe(previousTitle);
  });

  it('the two-hour remote receive limit runs per subscription and re-arms when the host re-publishes', async () => {
    await start();
    await ready('rt_host_session_a');
    await advance(1_000);
    expect(slot().sources).toEqual(['sfu-remote-audio-1']);

    await advance(60 * 60 * 1_000);
    const republishedAt = Date.now();
    await ready('rt_host_session_b');
    // A re-publication tears the old subscription down without a handoff:
    // receiving stays true while no source is connected until the new track
    // (unbounded if that subscription fails; see the re-publication gap test).
    expect(slot()).toMatchObject({ receiving: true, sources: [] });
    await advance(SFU_TRACK_AT_MS);
    expect(slot().sources).toEqual(['sfu-remote-audio-2']);

    // The first subscription's limit (armed at its attach) no longer fires.
    await advance(republishedAt + TWO_HOURS_MS - 1 - Date.now() + SFU_TRACK_AT_MS);
    expect(seen.toasts).toEqual([]);
    expect(slot().sources).toEqual(['sfu-remote-audio-2']);

    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.remote_receive_limit']);
    expect(slot()).toMatchObject({
      receiving: false,
      activity: 'idle',
      title: previousTitle,
      sources: [],
    });
    expect(FakeRTCPeerConnection.instances[1].closed).toBe(true);

    // Until the guest rejoins, READY frames from the same host connection are ignored.
    const sessionsBefore = realtime.count('new-session');
    await start();
    await ready('rt_host_session_c');
    await advance(1_000);
    expect(realtime.count('new-session')).toBe(sessionsBefore);
  });

  it('re-publication gap: a failed re-subscription while receiving leaves a silent playing state with no deadline', async () => {
    await start();
    await ready('rt_host_session_a');
    await advance(1_000);
    expect(slot()).toMatchObject({ receiving: true, sources: ['sfu-remote-audio-1'] });

    realtime.injectFault('new-session', 'fail');
    await ready('rt_host_session_b');
    await advance(5 * 60 * 1_000);
    // Known gap (observed on d84f53f5, not device-verified; fix-lane
    // candidate, or an explicit C4-4 decision): the re-publication tears the
    // old subscription down with cleanupGuestSfu(false), which clears the
    // adapter's receiving flag, so the failed re-subscription's cleanup skips
    // the shared receive cleanup. With no pending READY there is no handoff,
    // the slot deadline was cleared by the first attach and the two-hour
    // limit by the teardown: the guest stays 'playing' with no source and no
    // notice until the host's next READY or STOP. C4-4 rewrites exactly this
    // predicate (slot.isAttachedBy('standard-sfu')), so any change here must
    // be labelled.
    expect(slot()).toMatchObject({
      receiving: true,
      mode: 'system-audio',
      activity: 'playing',
      placeholder: true,
      sources: [],
      primers: 0,
    });
    expect(seen.toasts).toEqual([]);
    expect(seen.counts.receiveTimeouts).toBe(0);
    expect(FakeRTCPeerConnection.instances.map((pc) => pc.closed)).toEqual([true, true]);

    // The restore point is still held: STOP ends it normally.
    await stop();
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
    expect(seen.toasts).toEqual([]);
  });

  it('a Standard slot deadline tears down an in-flight SFU subscription and keeps the share route frozen', async () => {
    await start();
    await advance(20_000);
    // A READY 10 s before the deadline whose tracks-new is still in flight
    // when it fires (new-session answers at 26 s, tracks-new at 32 s), well
    // inside each request's own 15 s deadline. Only the SFU adapter's
    // 'system-audio:receive-timeout' reaction can close it at 30 s; C4-6 moves
    // that reaction into the slot's deadline fan-out.
    realtime.latencyMs = 6_000;
    await ready('rt_host_session_1');
    await advance(9_999);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(false);
    expect(seen.toasts).toEqual([]);

    await advance(1);
    expect(seen.toasts).toEqual(['system_audio.receive_failed']);
    expect(seen.counts.receiveTimeouts).toBe(1);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', title: previousTitle });
    await advance(60_000);
    expect(slot()).toMatchObject({ receiving: false, activity: 'idle', sources: [] });
    expect(webAudio.sources).toHaveLength(0);
    // Unlike force-stop and STOP, the deadline leaves the route frozen until
    // the next START resets it.
    expect(getGuestSystemAudioShareRoute()).toBe('sfu-remote');
    await start();
    expect(getGuestSystemAudioShareRoute()).toBe('unselected');
  });
});
