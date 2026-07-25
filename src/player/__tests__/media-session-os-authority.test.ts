/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  togglePlay: vi.fn(),
  routeProPlaybackCommand: vi.fn(() => true),
  pendingInterruption: vi.fn(() => false),
  resumeInterruption: vi.fn(async () => ({ running: true, rejoinEmitted: false })),
}));

vi.mock('../transport.ts', () => ({
  togglePlay: mocks.togglePlay,
  stopPlayback: vi.fn(),
  skipTime: vi.fn(),
  pause: vi.fn(),
}));

vi.mock('../../pro-room/playback-authority-hooks.ts', () => ({
  routeProPlaybackCommand: mocks.routeProPlaybackCommand,
}));

vi.mock('../../audio/context-recovery.ts', () => ({
  hasPendingAudioContextInterruption: mocks.pendingInterruption,
  resumePendingAudioContextInterruptionFromGesture: mocks.resumeInterruption,
}));

const handlers: Record<string, (details?: Record<string, unknown>) => void> = {};
Object.defineProperty(navigator, 'mediaSession', {
  value: {
    metadata: null,
    playbackState: 'none',
    setActionHandler: vi.fn(
      (action: string, handler: ((details?: Record<string, unknown>) => void) | null) => {
        if (handler) handlers[action] = handler;
        else delete handlers[action];
      },
    ),
  },
  configurable: true,
  writable: true,
});

globalThis.MediaMetadata = class MediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: MediaImage[];

  constructor(
    init: {
      title?: string;
      artist?: string;
      album?: string;
      artwork?: MediaImage[];
    } = {},
  ) {
    this.title = init.title ?? '';
    this.artist = init.artist ?? '';
    this.album = init.album ?? '';
    this.artwork = init.artwork ?? [];
  }
} as unknown as typeof MediaMetadata;

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { initMediaSession } from '../media-session.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const POSITION_SECONDS = 42.25;

function setYouTubeActivity(activity: 'paused' | 'playing'): void {
  setState('playback.mode', 'youtube');
  setState('playback.activity', activity);
}

function setStandardHost(): void {
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
}

function setProController(): void {
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 7,
    snapshotRevision: 11,
    capabilities: ['playback.control'],
  });
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  for (const action of Object.keys(handlers)) delete handlers[action];

  initMediaSession();
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  bus.on('youtube:get-position', (callback) => callback(POSITION_SECONDS));
});

describe('native YouTube OS media authority', () => {
  it('promotes a standard-host pre-applied PLAY into rendezvous sync', () => {
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);
    setStandardHost();
    setYouTubeActivity('paused');

    // iOS/YouTube applied the AirPods PLAY to the iframe before our callback.
    setState('playback.activity', 'playing');
    handlers.play?.();

    expect(autoPlay).toHaveBeenCalledWith({
      targetTime: POSITION_SECONDS,
      skipSeek: false,
      zeroStart: false,
      state: 1,
    });
    expect(mocks.togglePlay).not.toHaveBeenCalled();
  });

  it('promotes a standard-host pre-applied PAUSE into room pause authority', () => {
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);
    setStandardHost();
    setYouTubeActivity('playing');

    setState('playback.activity', 'paused');
    handlers.pause?.();

    expect(autoPlay).toHaveBeenCalledWith({
      targetTime: POSITION_SECONDS,
      skipSeek: false,
      zeroStart: false,
      state: 2,
    });
    expect(mocks.togglePlay).not.toHaveBeenCalled();
  });

  it('routes a PRO controller pre-applied PAUSE through server authority', () => {
    setProController();
    setYouTubeActivity('playing');

    setState('playback.activity', 'paused');
    handlers.pause?.();

    expect(mocks.routeProPlaybackCommand).toHaveBeenCalledWith(
      {
        kind: 'pause',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: POSITION_SECONDS,
      },
      { wasPlaying: true },
    );
    expect(mocks.togglePlay).not.toHaveBeenCalled();
  });

  it('routes a PRO controller pre-applied PLAY through server authority', () => {
    setProController();
    setYouTubeActivity('paused');

    setState('playback.activity', 'playing');
    handlers.play?.();

    expect(mocks.routeProPlaybackCommand).toHaveBeenCalledWith(
      {
        kind: 'play',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: POSITION_SECONDS,
      },
      { wasPlaying: false },
    );
    expect(mocks.togglePlay).not.toHaveBeenCalled();
  });

  it('relays a standard-room administrator pre-applied PLAY explicitly', () => {
    const send = vi.fn();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, send } as never);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);
    setYouTubeActivity('paused');

    setState('playback.activity', 'playing');
    handlers.play?.();

    expect(send).toHaveBeenCalledWith({
      type: MSG.REQUEST_YOUTUBE_PLAY,
      queueItemId: QUEUE_ITEM_ID,
    });
    expect(mocks.togglePlay).not.toHaveBeenCalled();
  });

  it('consumes one pre-applied transition only once when a wrapper repeats PLAY', () => {
    const autoPlay = vi.fn();
    bus.on('youtube:auto-play', autoPlay);
    setStandardHost();
    setYouTubeActivity('paused');

    setState('playback.activity', 'playing');
    handlers.play?.();
    handlers.play?.();

    expect(autoPlay).toHaveBeenCalledOnce();
  });

  it('keeps ordinary paused PLAY on the established control path', () => {
    setStandardHost();
    setYouTubeActivity('paused');

    handlers.play?.();

    expect(mocks.togglePlay).toHaveBeenCalledOnce();
    expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
  });

  it('keeps ordinary playing PAUSE on the established control path', () => {
    setStandardHost();
    setYouTubeActivity('playing');

    handlers.pause?.();

    expect(mocks.togglePlay).toHaveBeenCalledOnce();
    expect(mocks.routeProPlaybackCommand).not.toHaveBeenCalled();
  });
});
