import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE, TRANSFER_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import type { DataConnection, MediaConnection, TrackMeta } from '../../types/index.ts';
import { handleData } from '../protocol.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';
import {
  cleanupGuestSystemAudio,
  registerSystemAudioGuestListeners,
} from '../system-audio-guest.ts';
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

vi.mock('../peer.ts', () => ({
  forceStereoSdp: vi.fn((sdp: string) => sdp),
}));

vi.mock('../webrtc-audio-decoder-primer.ts', () => ({
  cleanupWebRtcAudioDecoderPrimer: vi.fn(),
  getAudioTrackStreamKey: vi.fn(() => 'stream-key'),
  primeWebRtcAudioDecoder: vi.fn(() => null),
}));

function createMediaConnection(peer = 'host') {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mediaConn = {
    peer,
    metadata: { type: 'system-audio' },
    peerConnection: null,
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

describe('system audio guest receive watchdog', () => {
  const hostConn = { open: true, peer: 'host' } as DataConnection;
  const watchdogName = 'sys-audio-guest-receive-watchdog';
  const stereoReplacementWatchdogName = 'sys-audio-guest-replacement-watchdog-STEREO';

  beforeEach(() => {
    cleanupGuestSystemAudio();
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

  it('re-arms the watchdog while preserving the placeholder during adapter handoff', async () => {
    const previousMeta: TrackMeta = { type: 'file', name: 'previous-track' };
    setState('player.currentTrackMeta', previousMeta);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    setSystemAudioReceiving(true);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);

    bus.emit('system-audio:delivery-handoff');

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

    cleanupGuestSystemAudio();

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
});
