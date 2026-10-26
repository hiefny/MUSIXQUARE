import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { MSG, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import type { DataConnection, MediaConnection, TrackMeta } from '../../types/index.ts';
import { handleData } from '../protocol.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';
import {
  getSystemAudioGuestDebugSnapshot,
  registerSystemAudioGuestListeners,
} from '../system-audio-guest.ts';
import { SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS } from '../system-audio-media.ts';
import {
  claimPlaybackOwner,
  setPlaybackFilePlaying,
  setPlaybackLifecycleState,
  setPlaybackTransferState,
  setSystemAudioReceiving,
} from '../../player/ownership.ts';
import { stopAllMedia } from '../../player/transport.ts';
import { getAudioContext } from '../../audio/context.ts';
import { getWidener, initAudio } from '../../audio/engine.ts';
import {
  freezeGuestSystemAudioSfuRoute,
  resetGuestSystemAudioShareRoute,
} from '../system-audio-delivery.ts';
import {
  awaitTrustedSystemAudioReceptionBoundary,
  beginTrustedSystemAudioReception,
  endTrustedSystemAudioReception,
  handOffTrustedSystemAudioReception,
  registerSystemAudioReceiveRoute,
} from '../system-audio-receive-slot.ts';
import {
  cleanupWebRtcAudioDecoderPrimer,
  primeWebRtcAudioDecoder,
  type WebRtcAudioDecoderPrimer,
} from '../webrtc-audio-decoder-primer.ts';

const timerMocks = vi.hoisted(() => {
  const timers = new Map<string, () => void>();
  const delays = new Map<string, number>();
  return {
    timers,
    delays,
    setManagedTimer: vi.fn((name: string, fn: () => void, delay: number) => {
      timers.set(name, fn);
      delays.set(name, delay);
    }),
    clearManagedTimer: vi.fn((name: string) => {
      timers.delete(name);
      delays.delete(name);
    }),
  };
});

const transportMocks = vi.hoisted(() => ({
  stopAllMedia: vi.fn(),
}));

const authorityMocks = vi.hoisted(() => ({
  hasRoomCapability: vi.fn(() => true),
  room: {
    kind: 'standard' as 'standard' | 'pro',
    roomId: null as string | null,
    epoch: 0,
  },
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: timerMocks.setManagedTimer,
  clearManagedTimer: timerMocks.clearManagedTimer,
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../audio/context.ts', () => ({
  getAudioContext: vi.fn(),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
  getWidener: vi.fn(() => ({ input: { connect: vi.fn() } })),
}));

vi.mock('../../player/transport.ts', () => ({
  stopAllMedia: transportMocks.stopAllMedia,
}));

vi.mock('../../rooms/authority.ts', () => ({
  getRoomContext: vi.fn(() => authorityMocks.room),
  hasRoomCapability: authorityMocks.hasRoomCapability,
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../opus-stereo-sdp.ts', () => ({
  forceStereoSdp: vi.fn((sdp: string) => sdp),
}));

// Keep the real peer module out of this suite, as before the SDP helpers left it.
vi.mock('../peer.ts', () => ({}));

vi.mock('../webrtc-audio-decoder-primer.ts', () => ({
  cleanupWebRtcAudioDecoderPrimer: vi.fn(),
  getAudioTrackStreamKey: vi.fn(() => 'stream-key'),
  primeWebRtcAudioDecoder: vi.fn(() => null),
}));

function createMediaConnection(peer = 'host', peerConnection: RTCPeerConnection | null = null) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mediaConn = {
    peer,
    metadata: { type: 'system-audio' },
    peerConnection,
    answer: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
  } as unknown as MediaConnection;
  return {
    mediaConn,
    emit(event: string, ...args: unknown[]): unknown {
      return handlers.get(event)?.(...args);
    },
  };
}

function emptyAudioStream(): MediaStream {
  return { getAudioTracks: () => [] } as unknown as MediaStream;
}

function audioStreamWithTrack(): MediaStream {
  const track = {
    id: 'audio-track-1',
    kind: 'audio',
    readyState: 'live',
    muted: false,
  } as MediaStreamTrack;
  return { getAudioTracks: () => [track] } as unknown as MediaStream;
}

function mutableMutedAudioStream(initialMuted = true) {
  const unmuteListeners = new Set<EventListenerOrEventListenerObject>();
  let muted = initialMuted;
  const addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject): void => {
      if (type === 'unmute') unmuteListeners.add(listener);
    },
  );
  const removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject): void => {
      if (type === 'unmute') unmuteListeners.delete(listener);
    },
  );
  const track = {
    id: 'muted-audio-track',
    kind: 'audio',
    readyState: 'live',
    get muted() {
      return muted;
    },
    addEventListener,
    removeEventListener,
  } as unknown as MediaStreamTrack;
  return {
    stream: { getAudioTracks: () => [track] } as unknown as MediaStream,
    track,
    addEventListener,
    removeEventListener,
    setMuted(value: boolean) {
      muted = value;
    },
    dispatchUnmute() {
      const event = new Event('unmute');
      for (const listener of [...unmuteListeners]) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
    listenerCount() {
      return unmuteListeners.size;
    },
  };
}

function timerWithPrefix(prefix: string): (() => void) | undefined {
  return [...timerMocks.timers].find(([name]) => name.startsWith(prefix))?.[1];
}

function timerNamesWithPrefix(prefix: string): string[] {
  return [...timerMocks.timers.keys()].filter((name) => name.startsWith(prefix));
}

function stubAudioSource(): {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  vi.mocked(getAudioContext).mockReturnValue({
    createMediaStreamSource: vi.fn(() => source),
  } as unknown as AudioContext);
  return source;
}

async function flushAsyncStreamHandler(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// The Standard SFU's reaction to a receive deadline, as it registers it with
// the receive slot (the SFU module is not loaded in this suite). Each test
// that reads it sets its own reaction.
let sfuDeadlineReaction: () => void = () => undefined;
registerSystemAudioReceiveRoute('standard-sfu', { onDeadline: () => sfuDeadlineReaction() });

describe('system audio guest receive watchdog', () => {
  const hostConn = { open: true, peer: 'host' } as DataConnection;
  const watchdogName = 'sys-audio-guest-receive-watchdog';
  const stereoReplacementWatchdogName = 'sys-audio-guest-replacement-watchdog-STEREO';

  beforeEach(() => {
    sfuDeadlineReaction = () => undefined;
    endTrustedSystemAudioReception();
    resetState();
    bus.clear();
    vi.clearAllMocks();
    timerMocks.timers.clear();
    timerMocks.delays.clear();
    authorityMocks.hasRoomCapability.mockReturnValue(true);
    authorityMocks.room = {
      kind: 'standard',
      roomId: null,
      epoch: 0,
    };
    resetGuestSystemAudioShareRoute();
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    markQueueAuthorityReady(hostConn);
    registerSystemAudioGuestListeners();
  });

  it('passes a one-shot answer transform without patching a reused peer connection', async () => {
    const setLocalDescription = vi.fn(async () => {});
    const setRemoteDescription = vi.fn(async () => {});
    const pc = { setLocalDescription, setRemoteDescription } as unknown as RTCPeerConnection;
    const originalSetLocalDescription = pc.setLocalDescription;
    const originalSetRemoteDescription = pc.setRemoteDescription;
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    const incoming = createMediaConnection('host', pc);
    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');

    expect(incoming.mediaConn.answer).toHaveBeenCalledWith(undefined, {
      sdpTransform: expect.any(Function),
    });
    expect(pc.setLocalDescription).toBe(originalSetLocalDescription);
    expect(pc.setRemoteDescription).toBe(originalSetRemoteDescription);

    incoming.emit('error', new Error('negotiation failed'));
    expect(incoming.mediaConn.close).toHaveBeenCalledTimes(1);
  });

  it('closes the exact incoming call when the transport answer throws synchronously', async () => {
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const incoming = createMediaConnection();
    vi.mocked(incoming.mediaConn.answer).mockImplementation(() => {
      throw new Error('answer setup failed');
    });

    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');

    expect(incoming.mediaConn.close).toHaveBeenCalledTimes(1);
  });

  it('restores previous meta if SYSTEM_AUDIO_START never produces a stream', async () => {
    const previousMeta: TrackMeta = { type: 'youtube', name: 'previous-track' };
    setPlaybackFilePlaying();
    setState('player.currentTrackMeta', previousMeta);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    expect(stopAllMedia).toHaveBeenCalledWith({ silent: true, cancelInFlight: true });
    expect(getState('player.currentTrackMeta')?.name).toBe('system-audio-receiving');
    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);
    expect(getState('player.currentTrackMeta')?.systemAudioSurface).toBe('display');
    expect(timerMocks.delays.get(watchdogName)).toBe(30_000);

    timerMocks.timers.get(watchdogName)?.();

    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('emits one trusted share boundary and ignores duplicate START frames', async () => {
    const hostStarted = vi.fn();
    bus.on('system-audio:host-started', hostStarted);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    expect(hostStarted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['browser', 'browser'],
    ['window', 'window'],
    ['application', 'window'],
    ['monitor', 'display'],
    ['future-surface', 'display'],
  ] as const)('accepts trusted %s surface metadata as %s', async (surface, expected) => {
    await handleData({ type: MSG.SYSTEM_AUDIO_START, surface }, hostConn);

    expect(getState('player.currentTrackMeta')).toMatchObject({
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
      systemAudioSurface: expected,
    });
  });

  it('drops an unbounded surface token before it can replace playback', async () => {
    const previousMeta: TrackMeta = { type: 'file', name: 'previous-track.mp3' };
    setState('player.currentTrackMeta', previousMeta);

    await handleData({ type: MSG.SYSTEM_AUDIO_START, surface: 'x'.repeat(17) }, hostConn);

    expect(stopAllMedia).not.toHaveBeenCalled();
    expect(getState('player.currentTrackMeta')).toBe(previousMeta);
  });

  it('does not connect an early media stream before the trusted START boundary', async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    vi.mocked(getAudioContext).mockReturnValue({
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext);

    const incoming = createMediaConnection();
    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
    incoming.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    expect(initAudio).not.toHaveBeenCalled();
    expect(getState('systemAudio.isReceiving')).toBe(false);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();

    expect(initAudio).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledTimes(1);
    expect(getState('systemAudio.isReceiving')).toBe(true);
  });

  it('settles a muted stream after its normal unmute stabilization window', async () => {
    stubAudioSource();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const incoming = createMediaConnection();
    const muted = mutableMutedAudioStream();
    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
    incoming.emit('stream', muted.stream);
    await flushAsyncStreamHandler();

    expect(primeWebRtcAudioDecoder).toHaveBeenCalledOnce();
    expect(initAudio).not.toHaveBeenCalled();
    expect(muted.listenerCount()).toBe(1);

    muted.setMuted(false);
    muted.dispatchUnmute();
    timerWithPrefix('sys-audio-guest-unmute-settle-')?.();
    await flushAsyncStreamHandler();

    expect(initAudio).toHaveBeenCalledOnce();
    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(muted.listenerCount()).toBe(0);
    expect(timerNamesWithPrefix('sys-audio-guest-unmute-')).toEqual([]);
  });

  it('keeps the existing bounded fallback when a muted track never unmutes', async () => {
    stubAudioSource();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const incoming = createMediaConnection();
    const muted = mutableMutedAudioStream();
    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
    incoming.emit('stream', muted.stream);
    await flushAsyncStreamHandler();

    timerWithPrefix('sys-audio-guest-unmute-timeout-')?.();
    await flushAsyncStreamHandler();

    expect(initAudio).toHaveBeenCalledOnce();
    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(muted.listenerCount()).toBe(0);
    expect(timerNamesWithPrefix('sys-audio-guest-unmute-')).toEqual([]);
  });

  it('cancels a muted-track wait on force-stop and fences its late unmute from a successor', async () => {
    stubAudioSource();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const stale = createMediaConnection();
    const muted = mutableMutedAudioStream();
    bus.emit('system-audio:incoming-call', stale.mediaConn, 'STEREO');
    stale.emit('stream', muted.stream);
    await flushAsyncStreamHandler();
    expect(muted.listenerCount()).toBe(1);

    bus.emit('system-audio:force-stop');
    await flushAsyncStreamHandler();

    expect(muted.listenerCount()).toBe(0);
    expect(timerNamesWithPrefix('sys-audio-guest-unmute-')).toEqual([]);
    expect(stale.mediaConn.close).toHaveBeenCalledOnce();
    expect(initAudio).not.toHaveBeenCalled();

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const successor = createMediaConnection();
    bus.emit('system-audio:incoming-call', successor.mediaConn, 'STEREO');
    successor.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();
    expect(initAudio).toHaveBeenCalledOnce();
    expect(getState('systemAudio.isReceiving')).toBe(true);

    muted.setMuted(false);
    muted.dispatchUnmute();
    await flushAsyncStreamHandler();
    expect(initAudio).toHaveBeenCalledOnce();
    expect(successor.mediaConn.close).not.toHaveBeenCalled();
    expect(getState('systemAudio.isReceiving')).toBe(true);
  });

  it('cancels the prior muted-track wait when the channel connection is replaced', async () => {
    stubAudioSource();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const stale = createMediaConnection();
    const muted = mutableMutedAudioStream();
    bus.emit('system-audio:incoming-call', stale.mediaConn, 'STEREO');
    stale.emit('stream', muted.stream);
    await flushAsyncStreamHandler();

    const successor = createMediaConnection();
    bus.emit('system-audio:incoming-call', successor.mediaConn, 'STEREO');
    successor.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    expect(stale.mediaConn.close).toHaveBeenCalledOnce();
    expect(muted.listenerCount()).toBe(0);
    expect(timerNamesWithPrefix('sys-audio-guest-unmute-')).toEqual([]);
    expect(initAudio).toHaveBeenCalledOnce();
    expect(getState('systemAudio.isReceiving')).toBe(true);

    muted.setMuted(false);
    muted.dispatchUnmute();
    await flushAsyncStreamHandler();
    expect(initAudio).toHaveBeenCalledOnce();
    expect(successor.mediaConn.close).not.toHaveBeenCalled();
  });

  it('cancels a muted-track wait when its current connection closes', async () => {
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const incoming = createMediaConnection();
    const muted = mutableMutedAudioStream();
    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
    incoming.emit('stream', muted.stream);
    await flushAsyncStreamHandler();

    incoming.emit('close');
    await flushAsyncStreamHandler();

    expect(muted.listenerCount()).toBe(0);
    expect(timerNamesWithPrefix('sys-audio-guest-unmute-')).toEqual([]);
    muted.setMuted(false);
    muted.dispatchUnmute();
    await flushAsyncStreamHandler();
    expect(initAudio).not.toHaveBeenCalled();
  });

  it('closes a stale direct call after an all-audience SFU route is frozen', () => {
    const mediaConn = { close: vi.fn() };
    freezeGuestSystemAudioSfuRoute('all');

    bus.emit('system-audio:incoming-call', mediaConn, 'STEREO');

    expect(mediaConn.close).toHaveBeenCalledTimes(1);
  });

  it('clears stale file pipeline sources when placeholder receive falls back', async () => {
    const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
    setState('player.currentTrackMeta', previousMeta);
    setPlaybackLifecycleState(PLAYBACK_STATE.PLAYING);
    setPlaybackTransferState(TRANSFER_STATE.READY);
    setPlaybackFilePlaying();

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    timerMocks.timers.get(watchdogName)?.();

    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('clears the watchdog once a stream is marked as receiving', async () => {
    setState('player.currentTrackMeta', { type: 'file', name: 'previous-track' });

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const watchdog = timerMocks.timers.get(watchdogName);
    expect(watchdog).toBeTypeOf('function');

    setState('systemAudio.isReceiving', true);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);

    watchdog?.();

    expect(getState('player.currentTrackMeta')?.name).toBe('system-audio-receiving');
    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);
    expect(getState('systemAudio.isReceiving')).toBe(true);
  });

  it('leaves the receive deadline to a caller that retries its own subscription', async () => {
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    // Another owner replaced the placeholder without receive cleanup.
    setState('player.currentTrackMeta', { type: 'file', name: 'successor-track' });
    expect(timerMocks.timers.has(watchdogName)).toBe(true);

    expect(beginTrustedSystemAudioReception(undefined, { deadline: 'route' })).toBe(true);

    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);
  });

  it('re-arms the watchdog while preserving the placeholder during adapter handoff', async () => {
    const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
    setState('player.currentTrackMeta', previousMeta);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    setSystemAudioReceiving(true);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);

    // As the Standard SFU calls it when it hands delivery to another route.
    handOffTrustedSystemAudioReception();

    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);
    expect(timerMocks.delays.get(watchdogName)).toBe(30_000);
  });

  it('restores previous meta when an active adapter-level receive cleanup runs', async () => {
    const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
    setPlaybackFilePlaying();
    setState('player.currentTrackMeta', previousMeta);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    setSystemAudioReceiving(true);
    claimPlaybackOwner('system-audio');

    endTrustedSystemAudioReception();

    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('immediately cleans an initAudio rejection and permits a fresh direct-call retry', async () => {
    const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
    const toast = vi.fn();
    bus.on('ui:show-toast', toast);
    setState('player.currentTrackMeta', previousMeta);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    vi.mocked(initAudio).mockRejectedValueOnce(new Error('audio init failed'));
    const failed = createMediaConnection();
    bus.emit('system-audio:incoming-call', failed.mediaConn, 'STEREO');
    expect(failed.emit('stream', audioStreamWithTrack())).toBeUndefined();
    await flushAsyncStreamHandler();

    expect(failed.mediaConn.close).toHaveBeenCalledTimes(1);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);
    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(toast).toHaveBeenCalledWith('system_audio.receive_failed');

    const source = { connect: vi.fn(), disconnect: vi.fn() };
    vi.mocked(getAudioContext).mockReturnValue({
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const retry = createMediaConnection();
    bus.emit('system-audio:incoming-call', retry.mediaConn, 'STEREO');
    retry.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);
    expect(retry.mediaConn.close).not.toHaveBeenCalled();
  });

  it('treats a missing audio graph as an immediate receive failure', async () => {
    const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
    setState('player.currentTrackMeta', previousMeta);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    vi.mocked(getWidener).mockReturnValueOnce(null);

    const failed = createMediaConnection();
    bus.emit('system-audio:incoming-call', failed.mediaConn, 'STEREO');
    failed.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    expect(failed.mediaConn.close).toHaveBeenCalledTimes(1);
    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);
  });

  it('rejects an empty stream before publishing receive state', async () => {
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const failed = createMediaConnection();
    bus.emit('system-audio:incoming-call', failed.mediaConn, 'STEREO');
    failed.emit('stream', emptyAudioStream());
    await flushAsyncStreamHandler();

    expect(failed.mediaConn.close).toHaveBeenCalledTimes(1);
    expect(initAudio).not.toHaveBeenCalled();
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);
  });

  it('does not let a stale async stream failure tear down its replacement connection', async () => {
    let rejectFirstInit!: (error: Error) => void;
    const firstInit = new Promise<void>((_resolve, reject) => {
      rejectFirstInit = reject;
    });
    vi.mocked(initAudio)
      .mockImplementationOnce(() => firstInit)
      .mockResolvedValueOnce(undefined);
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    vi.mocked(getAudioContext).mockReturnValue({
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext);
    const toast = vi.fn();
    bus.on('ui:show-toast', toast);

    setState('player.currentTrackMeta', { type: 'file', name: 'previous-track' });
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const stale = createMediaConnection();
    bus.emit('system-audio:incoming-call', stale.mediaConn, 'STEREO');
    stale.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();
    expect(initAudio).toHaveBeenCalledTimes(1);

    const replacement = createMediaConnection();
    bus.emit('system-audio:incoming-call', replacement.mediaConn, 'STEREO');
    replacement.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();
    expect(getState('systemAudio.isReceiving')).toBe(true);

    rejectFirstInit(new Error('stale init failed'));
    await flushAsyncStreamHandler();

    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(replacement.mediaConn.close).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it.each(['force-stop', 'channel-close'] as const)(
    'ignores an audio-init completion and a late stream after %s',
    async (retirement) => {
      let resolveInit!: () => void;
      vi.mocked(initAudio).mockImplementationOnce(
        () => new Promise<void>((resolve) => (resolveInit = resolve)),
      );
      const source = stubAudioSource();
      const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
      setState('player.currentTrackMeta', previousMeta);
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      const incoming = createMediaConnection();
      bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
      incoming.emit('stream', audioStreamWithTrack());
      await flushAsyncStreamHandler();
      expect(initAudio).toHaveBeenCalledOnce();

      if (retirement === 'force-stop') bus.emit('system-audio:force-stop');
      else incoming.emit('close');
      resolveInit();
      incoming.emit('stream', audioStreamWithTrack());
      await flushAsyncStreamHandler();

      expect(source.connect).not.toHaveBeenCalled();
      expect(initAudio).toHaveBeenCalledOnce();
      expect(getState('systemAudio.isReceiving')).toBe(false);
      expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
      expect(timerMocks.timers.has(watchdogName)).toBe(false);
    },
  );

  it('keeps successor file playback when a force-stopped audio init completes late', async () => {
    let resolveInit!: () => void;
    vi.mocked(initAudio).mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveInit = resolve)),
    );
    const source = stubAudioSource();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const incoming = createMediaConnection();
    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
    incoming.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();
    expect(initAudio).toHaveBeenCalledOnce();

    bus.emit('system-audio:force-stop');
    const successorMeta: TrackMeta = { type: 'file', name: 'successor-file' };
    claimPlaybackOwner('file', { currentTrackMeta: successorMeta });
    setPlaybackFilePlaying();
    resolveInit();
    incoming.emit('close');
    incoming.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    expect(source.connect).not.toHaveBeenCalled();
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(getState('player.currentTrackMeta')).toEqual(successorMeta);
    expect(getState('playback.activity')).toBe('playing');
  });

  it('publishes a replacement identity before a synchronous stale close callback', async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    vi.mocked(getAudioContext).mockReturnValue({
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const stale = createMediaConnection();
    bus.emit('system-audio:incoming-call', stale.mediaConn, 'STEREO');
    vi.mocked(stale.mediaConn.close).mockImplementation(() => {
      stale.emit('close');
    });

    const replacement = createMediaConnection();
    bus.emit('system-audio:incoming-call', replacement.mediaConn, 'STEREO');
    replacement.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    expect(stale.mediaConn.close).toHaveBeenCalledTimes(1);
    expect(replacement.mediaConn.close).not.toHaveBeenCalled();
    expect(getState('systemAudio.isReceiving')).toBe(true);
  });

  it('fails a silent same-channel replacement instead of remaining permanently receiving', async () => {
    const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    vi.mocked(getAudioContext).mockReturnValue({
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext);
    const toast = vi.fn();
    bus.on('ui:show-toast', toast);
    setState('player.currentTrackMeta', previousMeta);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    const active = createMediaConnection();
    bus.emit('system-audio:incoming-call', active.mediaConn, 'STEREO');
    active.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();
    expect(getState('systemAudio.isReceiving')).toBe(true);

    const silentReplacement = createMediaConnection();
    bus.emit('system-audio:incoming-call', silentReplacement.mediaConn, 'STEREO');

    expect(active.mediaConn.close).toHaveBeenCalledTimes(1);
    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(timerMocks.delays.get(stereoReplacementWatchdogName)).toBe(30_000);

    timerMocks.timers.get(stereoReplacementWatchdogName)?.();

    expect(silentReplacement.mediaConn.close).toHaveBeenCalledTimes(1);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(toast).toHaveBeenCalledWith('system_audio.receive_failed');
  });

  it('cancels the exact replacement watchdog only after its graph attaches', async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    vi.mocked(getAudioContext).mockReturnValue({
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    const active = createMediaConnection();
    bus.emit('system-audio:incoming-call', active.mediaConn, 'STEREO');
    active.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    const replacement = createMediaConnection();
    bus.emit('system-audio:incoming-call', replacement.mediaConn, 'STEREO');
    const staleWatchdog = timerMocks.timers.get(stereoReplacementWatchdogName);
    expect(staleWatchdog).toBeTypeOf('function');

    replacement.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();
    expect(timerMocks.timers.has(stereoReplacementWatchdogName)).toBe(false);

    staleWatchdog?.();
    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(replacement.mediaConn.close).not.toHaveBeenCalled();
  });

  // Phase 5 C4-1 moves the playout-delay hint into system-audio-media.ts. The
  // receive-slot contract pins 0.5 on a call with one audio receiver; this
  // pins which receivers of the direct call's connection get it.
  it('sets the 0.5 s playout-delay hint only on the audio receivers of the direct call', async () => {
    stubAudioSource();
    const audio = { track: { kind: 'audio' } } as RTCRtpReceiver & { playoutDelayHint?: number };
    const video = { track: { kind: 'video' } } as RTCRtpReceiver & { playoutDelayHint?: number };
    const trackless = { track: null } as unknown as RTCRtpReceiver & {
      playoutDelayHint?: number;
    };
    const pc = { getReceivers: vi.fn(() => [video, audio, trackless]) };
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    const incoming = createMediaConnection('host', pc as unknown as RTCPeerConnection);
    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
    incoming.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    expect(getState('systemAudio.isReceiving')).toBe(true);
    expect(pc.getReceivers).toHaveBeenCalledTimes(1);
    expect(audio.playoutDelayHint).toBe(0.5);
    expect(video).not.toHaveProperty('playoutDelayHint');
    expect(trackless).not.toHaveProperty('playoutDelayHint');
  });

  // Phase 5 C4-3 moves the direct call's attach (the source on widener.input,
  // the receiving flag, the owner claim) and its primer into the receive
  // slot. These pin what the direct call hands it and what its /debug
  // channel keeps, before the move.
  describe('direct call attach', () => {
    it('connects the remote stream object itself to the widener input and stamps the graph time', async () => {
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      const createMediaStreamSource = vi.fn(() => source);
      vi.mocked(getAudioContext).mockReturnValue({
        createMediaStreamSource,
      } as unknown as AudioContext);
      const widener = { input: { connect: vi.fn() } };
      vi.mocked(getWidener).mockReturnValueOnce(
        widener as unknown as ReturnType<typeof getWidener>,
      );
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

      const incoming = createMediaConnection();
      bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
      const stream = audioStreamWithTrack();
      incoming.emit('stream', stream);
      await flushAsyncStreamHandler();

      expect(createMediaStreamSource).toHaveBeenCalledExactlyOnceWith(stream);
      expect(source.connect).toHaveBeenCalledExactlyOnceWith(widener.input);
      expect(getState('systemAudio.isReceiving')).toBe(true);
      expect(getState('playback.mode')).toBe('system-audio');
      const snapshot = getSystemAudioGuestDebugSnapshot();
      // The primer is mocked to hold nothing here: the source alone is reported.
      expect(snapshot).toMatchObject({ gotStereo: true, sourceStereo: true, decoderPrimer: false });
      expect(snapshot.channels).toEqual([
        expect.objectContaining({
          channel: 'STEREO',
          graphAt: expect.any(Number),
          graphError: undefined,
        }),
      ]);
    });

    it.each([
      {
        failure: 'a missing audio graph',
        arrange: () => vi.mocked(getWidener).mockReturnValueOnce(null),
        message: 'audio-graph-not-ready',
        graphLog: true,
      },
      {
        failure: 'an initAudio rejection',
        arrange: () => vi.mocked(initAudio).mockRejectedValueOnce(new Error('audio init failed')),
        message: 'audio init failed',
        graphLog: false,
      },
    ])(
      'keeps $failure on the call /debug channel and logs it as the stream graph failure',
      async ({ arrange, message, graphLog }) => {
        await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
        arrange();

        const failed = createMediaConnection();
        bus.emit('system-audio:incoming-call', failed.mediaConn, 'STEREO');
        failed.emit('stream', audioStreamWithTrack());
        await flushAsyncStreamHandler();

        expect(failed.mediaConn.close).toHaveBeenCalledTimes(1);
        // The listener registration in beforeEach warns about re-registered
        // protocol handlers; only the receiver's own lines count here.
        const receiverLines = (level: 'warn' | 'error') =>
          vi
            .mocked(log[level])
            .mock.calls.filter(([first]) => String(first).startsWith('[SysAudioGuest]'));
        expect(receiverLines('warn')).toEqual([
          ['[SysAudioGuest] STEREO stream graph failed:', expect.objectContaining({ message })],
        ]);
        expect(receiverLines('error')).toEqual(
          graphLog ? [['[SysAudioGuest] Audio graph not ready']] : [],
        );
        const snapshot = getSystemAudioGuestDebugSnapshot();
        expect(snapshot).toMatchObject({
          systemReceiving: false,
          gotStereo: false,
          sourceStereo: false,
        });
        expect(snapshot.channels).toEqual([
          expect.objectContaining({ channel: 'STEREO', graphAt: undefined, graphError: message }),
        ]);
      },
    );
  });

  // Phase 5 C4-2 moved the trusted reception (its generation, boundary
  // waiters, restore point, receive watchdog, begin and cleanup) out of this
  // module into the receive slot. These pin that machine, written before the
  // move, through the names the Standard SFU and PRO routes call: the slot's
  // own (this module's compatibility aliases of them until C4-8).
  describe('trusted reception: generation, waiters, restore point and watchdog', () => {
    function settledValue(wait: Promise<boolean>): { value: boolean | undefined } {
      const result: { value: boolean | undefined } = { value: undefined };
      wait.then(
        (value) => {
          result.value = value;
        },
        () => undefined,
      );
      return result;
    }

    it('fails a boundary wait no start answers within the receive deadline, under its own timer', async () => {
      expect(SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS).toBe(30_000);
      const wait = settledValue(awaitTrustedSystemAudioReceptionBoundary('sfu-stereo'));
      const gates = timerNamesWithPrefix('sys-audio-guest-trust-gate-sfu-stereo-');
      expect(gates).toHaveLength(1);
      const gate = gates[0] ?? '';
      expect(timerMocks.delays.get(gate)).toBe(SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS);

      timerMocks.timers.get(gate)?.();
      await flushAsyncStreamHandler();
      expect(wait.value).toBe(false);

      // A later start does not answer a wait that already timed out.
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      await flushAsyncStreamHandler();
      expect(wait.value).toBe(false);
    });

    it('answers a wait from before the start with that start, and one during the placeholder at once', async () => {
      const early = settledValue(awaitTrustedSystemAudioReceptionBoundary('STEREO'));
      expect(timerNamesWithPrefix('sys-audio-guest-trust-gate-STEREO-')).toHaveLength(1);

      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      await flushAsyncStreamHandler();
      expect(early.value).toBe(true);
      expect(timerNamesWithPrefix('sys-audio-guest-trust-gate-')).toEqual([]);

      const late = settledValue(awaitTrustedSystemAudioReceptionBoundary('pro-stereo'));
      await flushAsyncStreamHandler();
      expect(late.value).toBe(true);
      expect(timerNamesWithPrefix('sys-audio-guest-trust-gate-')).toEqual([]);
    });

    it('cancels every open boundary wait on receive cleanup', async () => {
      const first = settledValue(awaitTrustedSystemAudioReceptionBoundary('STEREO'));
      const second = settledValue(awaitTrustedSystemAudioReceptionBoundary('sfu-stereo'));

      endTrustedSystemAudioReception();
      await flushAsyncStreamHandler();

      expect(first.value).toBe(false);
      expect(second.value).toBe(false);
      expect(timerNamesWithPrefix('sys-audio-guest-trust-gate-')).toEqual([]);
    });

    it('gives a wait opened while a start commits that start, and refuses a start nested in it', async () => {
      let during!: { value: boolean | undefined };
      let nested: boolean | undefined;
      transportMocks.stopAllMedia.mockImplementationOnce(() => {
        during = settledValue(awaitTrustedSystemAudioReceptionBoundary('sfu-stereo'));
        nested = beginTrustedSystemAudioReception(undefined, { deadline: 'slot' });
      });

      expect(beginTrustedSystemAudioReception(undefined, { deadline: 'slot' })).toBe(true);
      await flushAsyncStreamHandler();

      expect(nested).toBe(false);
      expect(stopAllMedia).toHaveBeenCalledOnce();
      expect(during.value).toBe(true);
      expect(timerNamesWithPrefix('sys-audio-guest-trust-gate-')).toEqual([]);
    });

    // Today's behaviour, the Standard START sibling of PRO gap 7 (a nested
    // force-stop empties the restore point), pinned so the move keeps it.
    it('lets a cleanup nested in the start empty the restore point while the start still commits', async () => {
      const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
      setState('player.currentTrackMeta', previousMeta);
      const early = settledValue(awaitTrustedSystemAudioReceptionBoundary('STEREO'));
      transportMocks.stopAllMedia.mockImplementationOnce(() => {
        bus.emit('system-audio:force-stop');
      });

      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      await flushAsyncStreamHandler();

      expect(early.value).toBe(false);
      expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);
      expect(timerMocks.delays.get(watchdogName)).toBe(30_000);

      await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);
      expect(getState('player.currentTrackMeta')).toBeNull();
      expect(getState('playback.activity')).toBe('idle');
    });

    it('takes a fresh restore point when a start follows a successor that replaced the placeholder', async () => {
      setState('player.currentTrackMeta', { type: 'file', name: 'first-track' });
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      const successorMeta: TrackMeta = { type: 'file', name: 'successor-track' };
      setState('player.currentTrackMeta', successorMeta);

      expect(beginTrustedSystemAudioReception(undefined, { deadline: 'route' })).toBe(true);
      expect(stopAllMedia).toHaveBeenCalledTimes(2);
      await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

      expect(getState('player.currentTrackMeta')).toEqual(successorMeta);
    });

    it("runs the other routes' deadline reactions before the cleanup and shows the notice after it", async () => {
      setState('player.currentTrackMeta', { type: 'file', name: 'previous-track' });
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      const seen: string[] = [];
      sfuDeadlineReaction = () => {
        seen.push(`deadline ${getState('player.currentTrackMeta')?.name}`);
      };
      bus.on('ui:show-toast', (message: unknown) => {
        seen.push(`toast ${String(message)} ${getState('player.currentTrackMeta')?.name}`);
      });

      timerMocks.timers.get(watchdogName)?.();

      expect(seen).toEqual([
        'deadline system-audio-receiving',
        'toast system_audio.receive_failed previous-track',
      ]);
      expect(log.warn).toHaveBeenCalledWith(
        '[SysAudioGuest] Timed out waiting for system audio stream',
      );
    });

    // The bus contained a throwing receive-timeout listener before C4-6; the
    // slot's deadline fan-out keeps that containment for a route's reaction.
    it("contains a route's throwing deadline reaction and still ends the reception and shows the notice", async () => {
      setState('player.currentTrackMeta', { type: 'file', name: 'previous-track' });
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      const failure = new Error('deadline reaction failed');
      sfuDeadlineReaction = () => {
        throw failure;
      };
      const toast = vi.fn();
      bus.on('ui:show-toast', toast);

      expect(() => timerMocks.timers.get(watchdogName)?.()).not.toThrow();

      expect(log.error).toHaveBeenCalledWith(
        '[SysAudioGuest] Receive deadline reaction of standard-sfu failed:',
        failure,
      );
      expect(getState('player.currentTrackMeta')).toEqual({
        type: 'file',
        name: 'previous-track',
      });
      expect(getState('systemAudio.isReceiving')).toBe(false);
      expect(getState('playback.activity')).toBe('idle');
      expect(toast).toHaveBeenCalledExactlyOnceWith('system_audio.receive_failed');
    });

    it("runs the same reactions when the direct call's replacement deadline expires the reception", async () => {
      stubAudioSource();
      setState('player.currentTrackMeta', { type: 'file', name: 'previous-track' });
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      const active = createMediaConnection();
      bus.emit('system-audio:incoming-call', active.mediaConn, 'STEREO');
      active.emit('stream', audioStreamWithTrack());
      await flushAsyncStreamHandler();
      const replacement = createMediaConnection();
      bus.emit('system-audio:incoming-call', replacement.mediaConn, 'STEREO');
      const seen: string[] = [];
      sfuDeadlineReaction = () => {
        seen.push(`deadline ${getState('player.currentTrackMeta')?.name}`);
      };
      bus.on('ui:show-toast', (message: unknown) => {
        seen.push(`toast ${String(message)} ${getState('player.currentTrackMeta')?.name}`);
      });

      timerMocks.timers.get(stereoReplacementWatchdogName)?.();

      expect(seen).toEqual([
        'deadline system-audio-receiving',
        'toast system_audio.receive_failed previous-track',
      ]);
      expect(log.warn).toHaveBeenCalledWith(
        '[SysAudioGuest] Timed out waiting for replacement STEREO stream',
      );
      expect(replacement.mediaConn.close).toHaveBeenCalledOnce();
    });

    it('lets the watchdog stand down once another owner replaced the placeholder', async () => {
      const timeout = vi.fn();
      const toast = vi.fn();
      sfuDeadlineReaction = timeout;
      bus.on('ui:show-toast', toast);
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      const successorMeta: TrackMeta = { type: 'file', name: 'successor-file' };
      claimPlaybackOwner('file', { currentTrackMeta: successorMeta });
      setPlaybackFilePlaying();

      timerMocks.timers.get(watchdogName)?.();

      expect(timeout).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
      expect(getState('player.currentTrackMeta')).toEqual(successorMeta);
      expect(getState('playback.activity')).toBe('playing');
    });

    // The guest-role half moved with the SFU's call in C4-6
    // (system-audio-sfu.test.ts, "guest SFU receive slot inputs").
    it('ignores a delivery handoff once the placeholder is gone', async () => {
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      setSystemAudioReceiving(true);
      expect(timerMocks.timers.has(watchdogName)).toBe(false);

      setState('player.currentTrackMeta', { type: 'file', name: 'successor-track' });
      handOffTrustedSystemAudioReception();
      expect(getState('systemAudio.isReceiving')).toBe(true);
      expect(timerMocks.timers.has(watchdogName)).toBe(false);
    });

    it("closes the direct call, its source, primer and replacement watchdog on another route's cleanup", async () => {
      const source = stubAudioSource();
      const primer = {} as WebRtcAudioDecoderPrimer;
      vi.mocked(primeWebRtcAudioDecoder).mockReturnValueOnce(primer);
      const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
      setState('player.currentTrackMeta', previousMeta);
      await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
      const active = createMediaConnection();
      bus.emit('system-audio:incoming-call', active.mediaConn, 'STEREO');
      active.emit('stream', audioStreamWithTrack());
      await flushAsyncStreamHandler();
      const replacement = createMediaConnection();
      bus.emit('system-audio:incoming-call', replacement.mediaConn, 'STEREO');
      expect(timerMocks.timers.has(stereoReplacementWatchdogName)).toBe(true);
      expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
        gotStereo: true,
        sourceStereo: true,
        decoderPrimer: true,
      });

      // As the Standard SFU and PRO routes call it.
      endTrustedSystemAudioReception();

      expect(replacement.mediaConn.close).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(cleanupWebRtcAudioDecoderPrimer).toHaveBeenCalledWith(primer);
      expect(timerMocks.timers.has(stereoReplacementWatchdogName)).toBe(false);
      expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
        systemReceiving: false,
        placeholder: false,
        gotStereo: false,
        sourceStereo: false,
        decoderPrimer: false,
      });
      expect(getState('player.currentTrackMeta')).toEqual(previousMeta);

      // The closed call's late events belong to a stale connection.
      replacement.emit('close');
      replacement.emit('stream', audioStreamWithTrack());
      await flushAsyncStreamHandler();
      expect(getState('systemAudio.isReceiving')).toBe(false);
      expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    });

    it('keeps the /debug trail of starts, ignored starts, the watchdog, cleanups and stops', async () => {
      const now = vi.spyOn(Date, 'now');
      try {
        now.mockReturnValue(1_000);
        await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
        expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
          placeholder: true,
          lastStartAt: 1_000,
          lastStartIgnoredReason: '',
          watchdogActive: true,
          watchdogArmedAt: 1_000,
        });

        now.mockReturnValue(2_000);
        await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
        expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
          lastStartAt: 1_000,
          lastStartIgnoredAt: 2_000,
          lastStartIgnoredReason: 'duplicate-placeholder',
        });

        now.mockReturnValue(3_000);
        timerMocks.timers.get(watchdogName)?.();
        expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
          placeholder: false,
          lastStartIgnoredReason: 'duplicate-placeholder',
          lastCleanupAt: 3_000,
          watchdogActive: false,
          watchdogArmedAt: 1_000,
          watchdogTimedOutAt: 3_000,
        });

        // The Standard SFU and PRO routes start through the same function,
        // and that start clears the ignored reason too.
        now.mockReturnValue(4_000);
        expect(beginTrustedSystemAudioReception(undefined, { deadline: 'route' })).toBe(true);
        expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
          lastStartAt: 4_000,
          lastStartIgnoredAt: 2_000,
          lastStartIgnoredReason: '',
          watchdogActive: false,
          watchdogArmedAt: 1_000,
        });

        now.mockReturnValue(5_000);
        handOffTrustedSystemAudioReception();
        expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
          watchdogActive: true,
          watchdogArmedAt: 5_000,
        });
        setSystemAudioReceiving(true);
        expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({ watchdogActive: false });

        now.mockReturnValue(6_000);
        await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);
        expect(getSystemAudioGuestDebugSnapshot()).toMatchObject({
          systemReceiving: false,
          placeholder: false,
          lastStartAt: 4_000,
          lastStopAt: 6_000,
          lastCleanupAt: 6_000,
          watchdogTimedOutAt: 3_000,
        });
      } finally {
        now.mockRestore();
      }
    });
  });
});
