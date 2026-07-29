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
  setPlaybackIdle,
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
  requestLegacyBoundedV1OwnerSwitchStop: vi.fn(),
}));

const authorityMocks = vi.hoisted(() => ({
  hasRoomCapability: vi.fn(() => true),
  room: {
    kind: 'standard' as 'standard' | 'pro',
    roomId: null as string | null,
    epoch: 0,
  },
}));

const boundedV1 = vi.hoisted(() => {
  const state: {
    snapshot: {
      active: boolean;
      role: 'idle' | 'host' | 'guest';
      current: {
        queueItemId: string;
        legacySessionId: number;
        state: 'ready';
        phase: 'playing' | 'paused' | 'stopped';
        positionSeconds: number;
        durationSeconds: number;
      } | null;
    };
    positionSeconds: number | null;
  } = {
    snapshot: { active: false, role: 'idle', current: null },
    positionSeconds: null,
  };
  return {
    state,
    product: {
      snapshot: vi.fn(() => state.snapshot),
      positionSeconds: vi.fn(() => state.positionSeconds),
    },
  };
});

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
  requestLegacyBoundedV1OwnerSwitchStop:
    transportMocks.requestLegacyBoundedV1OwnerSwitchStop,
}));

vi.mock('../../player/legacy-bounded-file-v1-product.ts', () => ({
  legacyBoundedFileV1Product: boundedV1.product,
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

async function flushAsyncStreamHandler(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setBoundedGuestPlayback(
  queueItemId: string,
  legacySessionId: number,
  positionSeconds: number,
  durationSeconds: number,
  options: {
    phase?: 'playing' | 'paused' | 'stopped';
    name?: string;
    append?: boolean;
  } = {},
): TrackMeta {
  const name = options.name ?? 'bounded.flac';
  const item = {
    queueItemId,
    type: 'file' as const,
    name,
    title: name,
    videoId: null,
    playlistId: null,
  };
  const items = options.append ? [...getState('playlist.items'), item] : [item];
  setState('playlist.items', items);
  setState('playlist.currentQueueItemId', queueItemId);
  setState('player.currentTrackMeta', item);
  setState('player.pausedAt', positionSeconds);
  setPlaybackFilePlaying();
  boundedV1.state.snapshot = {
    active: true,
    role: 'guest',
    current: {
      queueItemId,
      legacySessionId,
      state: 'ready',
      phase: options.phase ?? 'playing',
      positionSeconds,
      durationSeconds,
    },
  };
  boundedV1.state.positionSeconds = positionSeconds;
  return item;
}

function allowBoundedOwnerStop(): void {
  transportMocks.requestLegacyBoundedV1OwnerSwitchStop.mockReturnValue({
    settled: Promise.resolve(true),
    isCurrent: vi.fn(() => true),
  });
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
    transportMocks.requestLegacyBoundedV1OwnerSwitchStop.mockReturnValue(null);
    authorityMocks.hasRoomCapability.mockReturnValue(true);
    authorityMocks.room = {
      kind: 'standard',
      roomId: null,
      epoch: 0,
    };
    boundedV1.state.snapshot = { active: false, role: 'idle', current: null };
    boundedV1.state.positionSeconds = null;
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
    expect(timerMocks.delays.get(watchdogName)).toBe(30_000);

    timerMocks.timers.get(watchdogName)?.();

    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('projects the exact physical bounded checkpoint until the host publishes PAUSE', async () => {
    const queueItemId = '10000000-0000-4000-8000-000000000067';
    const previousMeta = setBoundedGuestPlayback(queueItemId, 17, 67.25, 181.5);
    allowBoundedOwnerStop();
    const durationUpdate = vi.fn();
    const playButtonUpdate = vi.fn();
    bus.on('ui:duration-update', durationUpdate);
    bus.on('ui:play-btn-state', playButtonUpdate);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();
    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);

    // The physical owner stop resets its renderer checkpoint to zero. Cleanup
    // must remain on that canonical checkpoint until the host publishes its
    // authority-validated PAUSE(N) compensation.
    boundedV1.state.snapshot.current = {
      ...boundedV1.state.snapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    boundedV1.state.positionSeconds = 0;

    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(durationUpdate).toHaveBeenCalledWith(181.5);
    expect(playButtonUpdate).toHaveBeenLastCalledWith(true);
  });

  it('restores bounded playback without enabling controls for an unauthorized guest', async () => {
    const queueItemId = '10000000-0000-4000-8000-000000000068';
    setBoundedGuestPlayback(queueItemId, 18, 31.5, 150);
    allowBoundedOwnerStop();
    authorityMocks.hasRoomCapability.mockReturnValue(false);
    const playButtonUpdate = vi.fn();
    bus.on('ui:play-btn-state', playButtonUpdate);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();
    boundedV1.state.snapshot.current = {
      ...boundedV1.state.snapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    boundedV1.state.positionSeconds = 0;
    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(playButtonUpdate).toHaveBeenLastCalledWith(false);
  });

  it('keeps one bounded snapshot across duplicate START and delivery handoff timeout', async () => {
    const queueItemId = '20000000-0000-4000-8000-000000000067';
    setBoundedGuestPlayback(queueItemId, 27, 73.5, 240);
    allowBoundedOwnerStop();

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();
    bus.emit('system-audio:delivery-handoff');

    boundedV1.state.snapshot.current = {
      ...boundedV1.state.snapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    boundedV1.state.positionSeconds = 0;
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    timerMocks.timers.get(watchdogName)?.();

    expect(transportMocks.requestLegacyBoundedV1OwnerSwitchStop).toHaveBeenCalledTimes(1);
    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');

    // Adapter/room cleanup is idempotent: the consumed snapshot cannot replay
    // over playback selected after the timeout.
    const successorMeta: TrackMeta = {
      queueItemId: '20000000-0000-4000-8000-000000000068',
      type: 'file',
      name: 'after-timeout.flac',
    };
    setState('playlist.currentQueueItemId', successorMeta.queueItemId!);
    setState('player.currentTrackMeta', successorMeta);
    cleanupGuestSystemAudio();
    expect(getState('player.currentTrackMeta')).toBe(successorMeta);
  });

  it('projects a newer live bounded guest incarnation after system audio cleanup', async () => {
    const originalQueueItemId = '30000000-0000-4000-8000-000000000067';
    const successorQueueItemId = '30000000-0000-4000-8000-000000000068';
    setBoundedGuestPlayback(originalQueueItemId, 37, 28, 120);
    allowBoundedOwnerStop();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();

    const successorMeta = setBoundedGuestPlayback(
      successorQueueItemId,
      38,
      44.75,
      300,
      {
        phase: 'paused',
        name: 'successor.flac',
        append: true,
      },
    );
    // The system-audio placeholder remains the visible owner until cleanup;
    // only the canonical bounded product/queue identity has advanced.
    claimPlaybackOwner('system-audio', {
      pending: true,
      currentTrackMeta: {
        type: 'file',
        name: 'system-audio-receiving',
        systemAudioPlaceholder: true,
      },
    });

    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toEqual(successorMeta);
    expect(getState('player.pausedAt')).toBe(44.75);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('uses a stopped successor product checkpoint instead of stale player time', async () => {
    const originalQueueItemId = '30000000-0000-4000-8000-000000000069';
    const successorQueueItemId = '30000000-0000-4000-8000-000000000070';
    setBoundedGuestPlayback(originalQueueItemId, 39, 28, 120);
    allowBoundedOwnerStop();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();

    const successorMeta = setBoundedGuestPlayback(
      successorQueueItemId,
      40,
      0,
      300,
      {
        phase: 'stopped',
        name: 'stopped-successor.flac',
        append: true,
      },
    );
    setState('player.pausedAt', 99);
    claimPlaybackOwner('system-audio', {
      pending: true,
      currentTrackMeta: {
        type: 'file',
        name: 'system-audio-receiving',
        systemAudioPlaceholder: true,
      },
    });

    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toEqual(successorMeta);
    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('fails closed for a stale bounded source without erasing successor selection UI', async () => {
    const originalQueueItemId = '40000000-0000-4000-8000-000000000067';
    const successorQueueItemId = '40000000-0000-4000-8000-000000000068';
    setBoundedGuestPlayback(originalQueueItemId, 47, 16, 90);
    allowBoundedOwnerStop();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();

    const successorMeta = {
      queueItemId: successorQueueItemId,
      type: 'file' as const,
      name: 'preparing-successor.flac',
      title: 'Preparing successor',
      videoId: null,
      playlistId: null,
    };
    setState('playlist.items', [...getState('playlist.items'), successorMeta]);
    setState('playlist.currentQueueItemId', successorQueueItemId);
    boundedV1.state.snapshot = { active: false, role: 'idle', current: null };
    boundedV1.state.positionSeconds = null;

    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toEqual(successorMeta);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('does not restore a retained old bounded source over a selected preparing successor', async () => {
    const originalQueueItemId = '40000000-0000-4000-8000-000000000069';
    const successorQueueItemId = '40000000-0000-4000-8000-000000000070';
    setBoundedGuestPlayback(originalQueueItemId, 49, 22, 120);
    allowBoundedOwnerStop();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();

    const successorMeta = {
      queueItemId: successorQueueItemId,
      type: 'file' as const,
      name: 'preparing-successor.m4a',
      title: 'Preparing successor',
      videoId: null,
      playlistId: null,
    };
    setState('playlist.items', [...getState('playlist.items'), successorMeta]);
    setState('playlist.currentQueueItemId', successorQueueItemId);
    // Keep the system-audio placeholder visible while successor preparation
    // advances queue selection. The old exact A renderer is still retained.
    boundedV1.state.snapshot.current = {
      ...boundedV1.state.snapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    boundedV1.state.positionSeconds = 0;

    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toEqual(successorMeta);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('clears a stale bounded selection when no successor exists', async () => {
    const queueItemId = '50000000-0000-4000-8000-000000000067';
    setBoundedGuestPlayback(queueItemId, 57, 12, 80);
    allowBoundedOwnerStop();
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await flushAsyncStreamHandler();

    boundedV1.state.snapshot = { active: false, role: 'idle', current: null };
    boundedV1.state.positionSeconds = null;
    cleanupGuestSystemAudio();

    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('player.currentTrackMeta')).toBeNull();
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

  it('keeps the incoming stream inaudible until bounded-file STOP really settles', async () => {
    let resolveStop!: (stopped: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      resolveStop = resolve;
    });
    transportMocks.requestLegacyBoundedV1OwnerSwitchStop.mockReturnValue({
      settled,
      isCurrent: vi.fn(() => true),
    });
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    vi.mocked(getAudioContext).mockReturnValue({
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const incoming = createMediaConnection();
    bus.emit('system-audio:incoming-call', incoming.mediaConn, 'STEREO');
    incoming.emit('stream', audioStreamWithTrack());
    await flushAsyncStreamHandler();

    expect(stopAllMedia).not.toHaveBeenCalled();
    expect(initAudio).not.toHaveBeenCalled();
    expect(source.connect).not.toHaveBeenCalled();

    resolveStop(true);
    await flushAsyncStreamHandler();
    await flushAsyncStreamHandler();

    expect(stopAllMedia).toHaveBeenCalledTimes(1);
    expect(initAudio).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledTimes(1);
    expect(getState('systemAudio.isReceiving')).toBe(true);
  });

  it('joins a pending bounded STOP without advancing ahead of the host checkpoint', async () => {
    const queueItemId = '60000000-0000-4000-8000-000000000067';
    setBoundedGuestPlayback(queueItemId, 67, 35, 180);
    let resolveStop!: (stopped: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      resolveStop = resolve;
    });
    transportMocks.requestLegacyBoundedV1OwnerSwitchStop.mockReturnValue({
      settled,
      isCurrent: vi.fn(() => true),
    });
    const hostStarted = vi.fn();
    bus.on('system-audio:host-started', hostStarted);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);
    // Model the exact physical settlement that the transport mock represents.
    // The product commits STOP before resolving its shared promise.
    boundedV1.state.snapshot.current = {
      ...boundedV1.state.snapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    boundedV1.state.positionSeconds = 0;
    resolveStop(true);
    await flushAsyncStreamHandler();
    await flushAsyncStreamHandler();

    expect(hostStarted).not.toHaveBeenCalled();
    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).not.toBe(true);
    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(0);
    expect(transportMocks.requestLegacyBoundedV1OwnerSwitchStop).toHaveBeenCalledTimes(1);
  });

  it('does not let a cancelled pending START restore over a newer bounded successor', async () => {
    const originalQueueItemId = '60000000-0000-4000-8000-000000000068';
    const successorQueueItemId = '60000000-0000-4000-8000-000000000069';
    setBoundedGuestPlayback(originalQueueItemId, 68, 35, 180);
    let resolveStop!: (stopped: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      resolveStop = resolve;
    });
    transportMocks.requestLegacyBoundedV1OwnerSwitchStop.mockReturnValue({
      settled,
      isCurrent: vi.fn(() => true),
    });

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

    const successorMeta = setBoundedGuestPlayback(
      successorQueueItemId,
      69,
      52,
      240,
      {
        phase: 'paused',
        name: 'successor.m4a',
        append: true,
      },
    );
    resolveStop(true);
    await flushAsyncStreamHandler();
    await flushAsyncStreamHandler();

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toEqual(successorMeta);
    expect(getState('player.pausedAt')).toBe(52);
    expect(getState('playback.activity')).toBe('playing');
  });

  it('does not restore a cancelled pending START after switching rooms', async () => {
    const queueItemId = '60000000-0000-4000-8000-000000000070';
    setBoundedGuestPlayback(queueItemId, 70, 35, 180);
    let resolveStop!: (stopped: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      resolveStop = resolve;
    });
    transportMocks.requestLegacyBoundedV1OwnerSwitchStop.mockReturnValue({
      settled,
      isCurrent: vi.fn(() => true),
    });

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    await handleData({ type: MSG.SYSTEM_AUDIO_STOP }, hostConn);

    authorityMocks.room = {
      kind: 'standard',
      roomId: '222222',
      epoch: 1,
    };
    setState('network.sessionCode', '222222');
    setState('network.hostConn', {
      open: true,
      peer: 'new-host',
    } as DataConnection);
    setPlaybackIdle();
    boundedV1.state.snapshot.current = {
      ...boundedV1.state.snapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    boundedV1.state.positionSeconds = 0;
    resolveStop(true);
    await flushAsyncStreamHandler();
    await flushAsyncStreamHandler();

    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).not.toBe(true);
  });

  it('closes a stale direct call after an all-audience SFU route is frozen', () => {
    const mediaConn = { close: vi.fn() };
    freezeGuestSystemAudioSfuRoute('all');

    bus.emit('system-audio:incoming-call', mediaConn, 'L');

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
