/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import {
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  setPlaybackYouTubePlaying,
} from '../ownership.ts';

// Mock transport.ts to avoid browser Web Audio setup.
vi.mock('../transport.ts', () => ({
  togglePlay: vi.fn(),
  stopPlayback: vi.fn(),
  skipTime: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
}));

// Mock video.ts
vi.mock('../video.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../video.ts')>();
  return {
    ...actual,
  };
});

// Polyfill navigator.mediaSession for jsdom
const _handlers: Record<string, (details?: Record<string, unknown>) => void> = {};
Object.defineProperty(navigator, 'mediaSession', {
  value: {
    metadata: null,
    playbackState: 'none',
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
import { setLocalFilePaused } from '../_state.ts';
import { setLocalYouTubePaused } from '../../youtube/_state.ts';
import { togglePlay, stopPlayback, skipTime, pause } from '../transport.ts';
import { bindAudioContextInterruptionRecovery } from '../../audio/context-recovery.ts';

const CURRENT_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002';

class FakeInterruptedAudioContext {
  state = 'running';
  readonly resume = vi.fn(async () => undefined);
  private readonly listeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.listeners.delete(listener);
  }

  dispatchState(state: string): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  setLocalFilePaused(false);
  setLocalYouTubePaused(false);
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = 'none';
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
    setPlaybackFilePaused();
    setState('playlist.currentQueueItemId', CURRENT_QUEUE_ITEM_ID);
    _handlers['play']();
    expect(togglePlay).toHaveBeenCalled();
  });

  it('play handler does not turn a duplicate YouTube PLAY action into a pause', () => {
    setPlaybackYouTubePlaying();
    _handlers['play']();
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('play handler emits playlist:play-track when idle with valid track', () => {
    const fn = vi.fn();
    bus.on('playlist:play-track', fn);
    setPlaybackIdle();
    setState('playlist.currentQueueItemId', CURRENT_QUEUE_ITEM_ID);
    _handlers['play']();
    expect(fn).toHaveBeenCalledWith(CURRENT_QUEUE_ITEM_ID);
  });

  // Non-OP guests must still be able to pause/resume their OWN local pause —
  // lock screen and hardware media buttons should always work (see
  // media-session.ts isPlaybackBlocked comment). Resume queries the room's
  // authoritative timeline and never manufactures a room-wide PLAY.
  it('play handler rejoins a LOCALLY-paused file at the authoritative position', () => {
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    setState('network.hostConn', { fake: true } as never);
    setState('network.isOperator', false);
    setPlaybackFilePaused();
    setLocalFilePaused(true); // pause came from this guest's lock screen
    setState('playlist.currentQueueItemId', CURRENT_QUEUE_ITEM_ID);
    setState('player.pausedAt', 12);
    _handlers['play']();
    expect(rejoin).toHaveBeenCalledWith({ reason: 'media-session-play', mode: 'file' });
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('queries file authority when a non-operator lost its local pause bit', () => {
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    setState('network.hostConn', { fake: true } as never);
    setState('network.isOperator', false);
    setPlaybackFilePaused();
    setLocalFilePaused(false); // host paused the room → flag cleared by handlePauseMsg
    setState('playlist.currentQueueItemId', CURRENT_QUEUE_ITEM_ID);
    setState('player.pausedAt', 12);
    _handlers['play']();
    expect(rejoin).toHaveBeenCalledWith({ reason: 'media-session-play', mode: 'file' });
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('play handler rejoins a locally-paused YouTube guest without toggling room playback', () => {
    const localState = vi.fn();
    bus.on('youtube:set-local-paused', localState);
    setState('network.hostConn', { fake: true } as never);
    setState('network.isOperator', false);
    setPlaybackYouTubePlaying();
    setLocalYouTubePaused(true);

    _handlers['play']();

    expect(localState).toHaveBeenCalledWith(false, 'media-session-play');
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('ignores a duplicate YouTube play action while a non-operator is already live', () => {
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    setState('network.hostConn', { fake: true } as never);
    setState('network.isOperator', false);
    setPlaybackYouTubePlaying();

    _handlers['play']();

    expect(rejoin).not.toHaveBeenCalled();
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('queries standard YouTube authority from semantic PAUSED even when the local bit was lost', () => {
    const localState = vi.fn();
    bus.on('youtube:set-local-paused', localState);
    setState('network.hostConn', { open: true } as never);
    setState('network.isOperator', false);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'paused');

    _handlers['play']();

    expect(localState).toHaveBeenCalledWith(false, 'media-session-play');
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('queries PRO authority from semantic PAUSED for a member without playback control', () => {
    const localState = vi.fn();
    bus.on('youtube:set-local-paused', localState);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'paused');

    _handlers['play']();

    expect(localState).toHaveBeenCalledWith(false, 'media-session-play');
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('emits exactly one rejoin after a trusted gesture resumes an interrupted context', async () => {
    const rejoin = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    setState('setup.sessionStarted', true);
    setState('network.hostConn', { open: true } as never);
    setState('network.isOperator', false);
    setPlaybackFilePlaying();
    setState('playlist.currentQueueItemId', CURRENT_QUEUE_ITEM_ID);
    const context = new FakeInterruptedAudioContext();
    context.resume
      .mockRejectedValueOnce(new Error('autoplay blocked'))
      .mockImplementationOnce(async () => {
        context.state = 'running';
      });
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());
    _handlers['play']();

    await vi.waitFor(() => expect(rejoin).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(rejoin).toHaveBeenCalledWith({ reason: 'audio-context-recovered', mode: 'file' });
    dispose();
  });

  it('resumes a shared interrupted context and queries the current mode after identity changes', async () => {
    const rejoin = vi.fn();
    const localYouTubeState = vi.fn();
    bus.on('playback:local-output-rejoin', rejoin);
    bus.on('youtube:set-local-paused', localYouTubeState);
    setState('setup.sessionStarted', true);
    setState('network.hostConn', { open: true } as never);
    setState('network.isOperator', false);
    setPlaybackFilePlaying();
    setState('playlist.currentQueueItemId', CURRENT_QUEUE_ITEM_ID);
    const context = new FakeInterruptedAudioContext();
    context.resume
      .mockRejectedValueOnce(new Error('autoplay blocked'))
      .mockImplementationOnce(async () => {
        context.state = 'running';
      });
    const dispose = bindAudioContextInterruptionRecovery(context as unknown as AudioContext);

    context.dispatchState('suspended');
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());
    setPlaybackYouTubePlaying();
    setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
    _handlers['play']();

    await vi.waitFor(() =>
      expect(localYouTubeState).toHaveBeenCalledWith(false, 'media-session-play'),
    );
    expect(rejoin).not.toHaveBeenCalled();
    expect(context.resume).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('pause handler calls togglePlay when playing', () => {
    setPlaybackFilePlaying();
    _handlers['pause']();
    expect(togglePlay).toHaveBeenCalled();
  });

  it('pause handler pauses local file playback for non-operator guests', () => {
    setState('network.hostConn', { fake: true } as never);
    setState('network.isOperator', false);
    setPlaybackFilePlaying();
    _handlers['pause']();
    expect(pause).toHaveBeenCalledWith(undefined, { showToast: false });
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('pause handler delegates to YouTube mode', () => {
    setPlaybackYouTubePlaying();
    _handlers['pause']();
    expect(togglePlay).toHaveBeenCalled();
  });

  it('YouTube handler toggles only the local player for non-operator guests', () => {
    const fn = vi.fn();
    bus.on('youtube:set-local-paused', fn);
    setState('network.hostConn', { fake: true } as never);
    setState('network.isOperator', false);
    setPlaybackYouTubePlaying();
    _handlers['pause']();
    expect(fn).toHaveBeenCalledWith(true);
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('keeps a non-operator YouTube PAUSE intent while rendezvous preparation is semantically paused', () => {
    const localState = vi.fn();
    bus.on('youtube:set-local-paused', localState);
    setState('network.hostConn', { open: true } as never);
    setState('network.isOperator', false);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'paused');

    _handlers['pause']();

    expect(localState).toHaveBeenCalledWith(true);
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it('keeps coordinator-free PRO member media keys local and blocks room controls', () => {
    const localYouTubeToggle = vi.fn();
    const nextTrack = vi.fn();
    bus.on('youtube:set-local-paused', localYouTubeToggle);
    bus.on('playlist:next-track', nextTrack);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    setPlaybackYouTubePlaying();

    _handlers['pause']();
    _handlers['nexttrack']();
    _handlers['seekforward']({ seekOffset: 30 });
    _handlers['stop']();

    expect(localYouTubeToggle).toHaveBeenCalledOnce();
    expect(localYouTubeToggle).toHaveBeenCalledWith(true);
    expect(togglePlay).not.toHaveBeenCalled();
    expect(nextTrack).not.toHaveBeenCalled();
    expect(skipTime).not.toHaveBeenCalled();
    expect(stopPlayback).not.toHaveBeenCalled();
  });

  it('allows a PRO controller with explicit playback authority to use room media keys', () => {
    const nextTrack = vi.fn();
    bus.on('playlist:next-track', nextTrack);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setPlaybackYouTubePlaying();

    _handlers['pause']();
    _handlers['nexttrack']();

    expect(togglePlay).toHaveBeenCalledOnce();
    expect(nextTrack).toHaveBeenCalledOnce();
  });

  it('keeps explicit PRO controller PLAY as a room-wide action', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'paused');

    _handlers['play']();

    expect(togglePlay).toHaveBeenCalledOnce();
  });

  it('pause handler does nothing when already paused', () => {
    setPlaybackFilePaused();
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

  it('syncs OS playback state from playback activity', () => {
    setPlaybackFilePlaying();
    expect(navigator.mediaSession.playbackState).toBe('playing');

    setPlaybackFilePaused();
    expect(navigator.mediaSession.playbackState).toBe('paused');

    setPlaybackIdle();
    expect(navigator.mediaSession.playbackState).toBe('none');
  });

  it("maps pending activity to 'paused' to keep iOS AudioContext alive", () => {
    // 'pending' covers transient windows (file preload/decode, system-audio
    // placeholder receive) where the guest expects playback to resume.
    // Mapping pending to 'none' would let iOS suspend AudioContext while the
    // screen is locked mid-preload, killing audio when playback actually
    // starts. The hint must stay 'paused' (not 'none') for that window.
    setState('playback.mode', 'file');
    setState('playback.activity', 'pending');
    expect(navigator.mediaSession.playbackState).toBe('paused');
  });

  // External sink contract: mode × activity matrix.
  //
  // Each row pins the expected OS playback hint for one (mode, activity)
  // combination. The mapping is deliberate per row: an automated migration
  // that introduces a new value or changes a row's output must update the
  // table here, not silently drift through a default branch. The mediaSession
  // In particular, pending work must retain the paused OS hint so iOS can keep
  // the AudioContext available through preload.
  describe('mediaSession.playbackState (mode × activity matrix)', () => {
    type Row = {
      mode: 'file' | 'youtube' | 'system-audio' | null;
      activity: 'idle' | 'paused' | 'playing' | 'pending';
      expected: 'none' | 'paused' | 'playing';
    };

    const MATRIX: Row[] = [
      // mode = null
      { mode: null, activity: 'idle', expected: 'none' },
      { mode: null, activity: 'paused', expected: 'paused' },
      { mode: null, activity: 'playing', expected: 'playing' },
      { mode: null, activity: 'pending', expected: 'paused' },
      // mode = 'file'
      { mode: 'file', activity: 'idle', expected: 'none' },
      { mode: 'file', activity: 'paused', expected: 'paused' },
      { mode: 'file', activity: 'playing', expected: 'playing' },
      { mode: 'file', activity: 'pending', expected: 'paused' },
      // mode = 'youtube' (pending coerced away by deriveModeActivity in
      // production, but the sink itself must still produce a sensible value)
      { mode: 'youtube', activity: 'idle', expected: 'none' },
      { mode: 'youtube', activity: 'paused', expected: 'paused' },
      { mode: 'youtube', activity: 'playing', expected: 'playing' },
      { mode: 'youtube', activity: 'pending', expected: 'paused' },
      // mode = 'system-audio'
      { mode: 'system-audio', activity: 'idle', expected: 'none' },
      { mode: 'system-audio', activity: 'paused', expected: 'paused' },
      { mode: 'system-audio', activity: 'playing', expected: 'playing' },
      { mode: 'system-audio', activity: 'pending', expected: 'paused' },
    ];

    for (const { mode, activity, expected } of MATRIX) {
      it(`(${mode ?? 'null'}, ${activity}) -> '${expected}'`, () => {
        setState('playback.mode', mode);
        setState('playback.activity', activity);
        expect(navigator.mediaSession.playbackState).toBe(expected);
      });
    }
  });
});
