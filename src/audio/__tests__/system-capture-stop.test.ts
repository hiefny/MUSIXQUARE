/**
 * @vitest-environment jsdom
 *
 * `system-audio:force-stop` is transition/teardown semantics: another
 * playback flow is taking ownership, so only explicit stops may restore the
 * pre-share snapshot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setPlaybackTrackMeta, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import {
  isSystemAudioActive,
  registerSystemCaptureListeners,
  startSystemAudioCapture,
} from '../system-capture.ts';
import type { TrackMeta } from '../../types/index.ts';

const YOUTUBE_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  return {
    ctx: {
      createMediaStreamSource: () => node(),
      createChannelSplitter: () => node(),
      createMediaStreamDestination: () => ({
        channelCount: 0,
        channelCountMode: '',
        stream: { id: 'dest-stream-1', active: true, getAudioTracks: () => [] },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createGain: () => ({
        channelCount: 0,
        channelCountMode: '',
        channelInterpretation: '',
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
    },
  };
});

vi.mock('../engine.ts', () => ({
  initAudio: vi.fn(async () => {}),
  getWidener: vi.fn(() => ({ input: {} })),
  getMasterGain: vi.fn(() => null),
}));

vi.mock('../context.ts', () => ({
  getAudioContext: vi.fn(() => h.ctx),
  getCurrentTime: vi.fn(() => 0),
  ensureRunning: vi.fn(async () => {}),
}));

function youtubeMeta(): TrackMeta {
  return {
    queueItemId: YOUTUBE_QUEUE_ITEM_ID,
    type: 'youtube',
    name: 'Video',
    title: 'Video',
    videoId: 'video-1',
    playlistId: null,
  };
}

function fileMeta(name: string): TrackMeta {
  return { type: 'file', name, title: name, videoId: null, playlistId: null };
}

let lastDisplayCapture: {
  track: MediaStreamTrack;
  dispatchEnded: () => void;
} | null = null;

function stubDisplayMedia(): void {
  const endedListeners = new Set<() => void>();
  const track = {
    id: 'cap-track-1',
    kind: 'audio',
    readyState: 'live',
    muted: false,
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'ended') endedListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'ended') endedListeners.delete(listener);
    }),
  } as unknown as MediaStreamTrack;
  const stream = {
    active: true,
    getVideoTracks: () => [],
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: vi.fn(async () => stream) },
  });
  lastDisplayCapture = {
    track,
    dispatchEnded: () => {
      for (const listener of [...endedListeners]) listener();
    },
  };
}

async function startShareWithPriorYouTube(): Promise<ReturnType<typeof vi.fn>> {
  const restoreSpy = vi.fn();
  bus.on('youtube:restore-room-playback', restoreSpy);

  // Pre-share state: YouTube playing
  setState('playlist.items', [
    {
      queueItemId: YOUTUBE_QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Video',
      title: 'Video',
      videoId: 'video-1',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', YOUTUBE_QUEUE_ITEM_ID);
  setPlaybackTrackMeta(youtubeMeta());
  setPlaybackYouTubePlaying();

  stubDisplayMedia();
  await startSystemAudioCapture();
  expect(getState('playback.mode')).toBe('system-audio');
  return restoreSpy;
}

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();
  lastDisplayCapture = null;
  registerSystemCaptureListeners();
});

describe('stopSystemAudioCapture restore semantics (SA-02)', () => {
  it('force-stop releases ownership WITHOUT restoring the pre-share snapshot', async () => {
    const restoreSpy = await startShareWithPriorYouTube();

    // A new selection is mid-flight: playTrack already set the new track's
    // meta before its stopAllMedia → force-stop reached us.
    const clicked = fileMeta('clicked.mp3');
    setPlaybackTrackMeta(clicked);

    bus.emit('system-audio:force-stop');

    // No room-wide resurrection of the pre-share YouTube video…
    expect(restoreSpy).not.toHaveBeenCalled();
    // …the in-flight selection's meta survives…
    expect(getState('player.currentTrackMeta')).toBe(clicked);
    // …and system-audio ownership is released so the new flow can claim.
    expect(getState('playback.mode')).toBeNull();
  });

  it('explicit stop (system-audio:stop) still restores the pre-share snapshot', async () => {
    const restoreSpy = await startShareWithPriorYouTube();

    bus.emit('system-audio:stop');

    expect(restoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: 'video-1',
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        autoplay: true,
      }),
    );
  });

  it('a force-stopped share does not leak its snapshot into a later explicit stop', async () => {
    const restoreSpy = await startShareWithPriorYouTube();

    bus.emit('system-audio:force-stop');
    expect(restoreSpy).not.toHaveBeenCalled();

    // Second share session with nothing playing before it
    stubDisplayMedia();
    await startSystemAudioCapture();
    bus.emit('system-audio:stop');

    // Restores the SECOND session's (idle) snapshot — not the first one's YouTube.
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('routes the browser-native sharing stop through the common stop lifecycle exactly once', async () => {
    const restoreSpy = await startShareWithPriorYouTube();
    const capture = lastDisplayCapture;
    expect(capture).not.toBeNull();
    const commonStopSpy = vi.fn();
    bus.on('system-audio:stop', commonStopSpy);

    capture!.dispatchEnded();
    capture!.dispatchEnded();

    expect(commonStopSpy).toHaveBeenCalledTimes(1);
    expect(capture!.track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });
});
