/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { APP_STATE } from '../../core/constants.ts';

// Mock transport.ts to avoid Tone.js
vi.mock('../transport.ts', () => ({
  togglePlay: vi.fn(),
  stopPlayback: vi.fn(),
  skipTime: vi.fn(),
}));

// Mock video.ts
vi.mock('../video.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../video.ts')>();
  return {
    ...actual,
  };
});

// Mock blob-manager.ts (transitive dep from video.ts)
vi.mock('../../core/blob-manager.ts', () => ({
  setVideoElement: vi.fn(),
}));

// Polyfill navigator.mediaSession for jsdom
const _handlers: Record<string, (details?: Record<string, unknown>) => void> = {};
Object.defineProperty(navigator, 'mediaSession', {
  value: {
    metadata: null,
    setActionHandler: vi.fn((action: string, handler: () => void) => {
      _handlers[action] = handler;
    }),
  },
  configurable: true,
  writable: true,
});

// Polyfill MediaMetadata
globalThis.MediaMetadata = class MediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: MediaImage[];
  constructor(init: { title?: string; artist?: string; album?: string; artwork?: MediaImage[] }) {
    this.title = init.title || '';
    this.artist = init.artist || '';
    this.album = init.album || '';
    this.artwork = init.artwork || [];
  }
} as unknown as typeof MediaMetadata;

import { updateMediaSessionMetadata, initMediaSession } from '../media-session.ts';
import { togglePlay, stopPlayback, skipTime } from '../transport.ts';

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  navigator.mediaSession.metadata = null;
});

describe('updateMediaSessionMetadata', () => {
  it('sets metadata for audio track', () => {
    updateMediaSessionMetadata({ name: 'My Song', type: 'audio' } as never);
    expect(navigator.mediaSession.metadata).not.toBeNull();
    expect(navigator.mediaSession.metadata!.title).toBe('My Song');
    expect(navigator.mediaSession.metadata!.artist).toBe('MUSIXQUARE');
  });

  it('sets metadata for YouTube track', () => {
    updateMediaSessionMetadata({
      name: 'YT Video',
      title: 'YT Video',
      type: 'youtube',
      thumbnail: 'https://example.com/thumb.jpg',
    } as never);
    expect(navigator.mediaSession.metadata!.artist).toBe('YouTube');
    expect(navigator.mediaSession.metadata!.artwork[0].src).toBe('https://example.com/thumb.jpg');
  });

  it('does nothing for null item', () => {
    updateMediaSessionMetadata(null);
    expect(navigator.mediaSession.metadata).toBeNull();
  });

  it('uses "Unknown Track" for item without name', () => {
    updateMediaSessionMetadata({ type: 'audio' } as never);
    expect(navigator.mediaSession.metadata!.title).toBe('Unknown Track');
  });

  it('uses favicon for non-YouTube artwork', () => {
    updateMediaSessionMetadata({ name: 'Song', type: 'audio' } as never);
    expect(navigator.mediaSession.metadata!.artwork[0].src).toBe('favicon.svg');
  });
});

describe('initMediaSession', () => {
  beforeEach(() => {
    initMediaSession();
  });

  it('registers all 7 action handlers', () => {
    expect(navigator.mediaSession.setActionHandler).toHaveBeenCalledTimes(7);
    const actions = (
      navigator.mediaSession.setActionHandler as ReturnType<typeof vi.fn>
    ).mock.calls.map((c: unknown[]) => c[0]);
    expect(actions).toContain('play');
    expect(actions).toContain('pause');
    expect(actions).toContain('previoustrack');
    expect(actions).toContain('nexttrack');
    expect(actions).toContain('seekbackward');
    expect(actions).toContain('seekforward');
    expect(actions).toContain('stop');
  });

  it('play handler calls togglePlay when paused with valid track', () => {
    setState('appState', APP_STATE.PAUSED);
    setState('playlist.currentTrackIndex', 0);
    _handlers['play']();
    expect(togglePlay).toHaveBeenCalled();
  });

  it('play handler emits playlist:play-track when idle with valid track', () => {
    const fn = vi.fn();
    bus.on('playlist:play-track', fn);
    setState('appState', APP_STATE.IDLE);
    setState('playlist.currentTrackIndex', 2);
    _handlers['play']();
    expect(fn).toHaveBeenCalledWith(2);
  });

  // Non-OP guests must still be able to play/pause — lock screen and
  // hardware media buttons should always work (see media-session.ts
  // isPlaybackBlocked comment). Only track changes and seek are blocked.
  it('play handler still works for non-operator guests', () => {
    setState('network.hostConn', { fake: true } as never);
    setState('network.isOperator', false);
    setState('appState', APP_STATE.PAUSED);
    setState('playlist.currentTrackIndex', 0);
    _handlers['play']();
    expect(togglePlay).toHaveBeenCalled();
  });

  it('pause handler calls togglePlay when playing', () => {
    setState('appState', APP_STATE.PLAYING_AUDIO);
    _handlers['pause']();
    expect(togglePlay).toHaveBeenCalled();
  });

  it('pause handler does nothing when already paused', () => {
    setState('appState', APP_STATE.PAUSED);
    _handlers['pause']();
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('previoustrack emits playlist:prev-track', () => {
    const fn = vi.fn();
    bus.on('playlist:prev-track', fn);
    _handlers['previoustrack']();
    expect(fn).toHaveBeenCalled();
  });

  it('nexttrack emits playlist:next-track', () => {
    const fn = vi.fn();
    bus.on('playlist:next-track', fn);
    _handlers['nexttrack']();
    expect(fn).toHaveBeenCalled();
  });

  it('seekbackward calls skipTime with negative offset', () => {
    _handlers['seekbackward']({ seekOffset: 15 });
    expect(skipTime).toHaveBeenCalledWith(-15);
  });

  it('seekforward calls skipTime with positive offset', () => {
    _handlers['seekforward']({ seekOffset: 30 });
    expect(skipTime).toHaveBeenCalledWith(30);
  });

  it('seekbackward defaults to -10 when no seekOffset', () => {
    _handlers['seekbackward']({});
    expect(skipTime).toHaveBeenCalledWith(-10);
  });

  it('seekforward defaults to 10 when no seekOffset', () => {
    _handlers['seekforward']({});
    expect(skipTime).toHaveBeenCalledWith(10);
  });

  it('stop handler calls stopPlayback', () => {
    _handlers['stop']();
    expect(stopPlayback).toHaveBeenCalled();
  });

  it('responds to state:player.currentTrackMeta change', () => {
    const item = { name: 'Bus Track', type: 'file' as const };
    setState('player.currentTrackMeta', item);
    expect(navigator.mediaSession.metadata).not.toBeNull();
    expect(navigator.mediaSession.metadata!.title).toBe('Bus Track');
  });
});
