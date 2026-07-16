/**
 * @vitest-environment jsdom
 *
 * `system-audio:force-stop` is transition/teardown semantics: another
 * playback flow is taking ownership, so only explicit stops may restore the
 * pre-share snapshot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { MAX_SYSTEM_AUDIO_DEVICES, SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../../core/constants.ts';
import { t } from '../../i18n/index.ts';
import { setPlaybackTrackMeta, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import { initAudio } from '../engine.ts';
import {
  isSystemAudioActive,
  registerSystemCaptureListeners,
  startSystemAudioCapture,
} from '../system-capture.ts';
import type { ConnectedPeer, DataConnection, TrackMeta } from '../../types/index.ts';

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

function stubDisplayMedia(
  implementation?: (stream: MediaStream) => Promise<MediaStream>,
): ReturnType<typeof vi.fn> {
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
  const getDisplayMedia = vi.fn(() =>
    implementation ? implementation(stream) : Promise.resolve(stream),
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia },
  });
  lastDisplayCapture = {
    track,
    dispatchEnded: () => {
      for (const listener of [...endedListeners]) listener();
    },
  };
  return getDisplayMedia;
}

function setConnectedGuests(count: number, status = 'connected'): ConnectedPeer[] {
  const peers = Array.from({ length: count }, (_, index): ConnectedPeer => {
    const slot = index + 1;
    return {
      id: `peer-${slot}`,
      slot,
      label: `Peer ${slot}`,
      conn: {
        open: true,
        peer: `peer-${slot}`,
        send: vi.fn(),
      } as unknown as DataConnection,
      isOp: false,
      preloadedQueueItemIds: new Set(),
      status,
      isDataTarget: true,
      joinOrder: slot,
      connectionType: 'local',
      lastHeartbeat: Date.now(),
    };
  });
  setState('network.connectedPeers', peers);
  return peers;
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
  setState('network.appRole', 'host');
  registerSystemCaptureListeners();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
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

describe('system audio operating-cost limits', () => {
  it('allows sharing with four total devices, including the host', async () => {
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES - 1);
    const getDisplayMedia = stubDisplayMedia();

    await startSystemAudioCapture();

    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(true);
    bus.emit('system-audio:stop');
  });

  it('blocks sharing before the native picker when five total devices are connected', async () => {
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES);
    const getDisplayMedia = stubDisplayMedia();
    const toastSpy = vi.fn();
    bus.on('ui:show-toast', toastSpy);

    await startSystemAudioCapture();

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith(
      t('system_audio.device_limit', { count: MAX_SYSTEM_AUDIO_DEVICES }),
    );
  });

  it('discards a capture when a fifth device connects while the native picker is open', async () => {
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES - 1);
    let resolvePicker!: (stream: MediaStream) => void;
    const pickerResult = new Promise<MediaStream>((resolve) => {
      resolvePicker = resolve;
    });
    let selectedStream: MediaStream | null = null;
    stubDisplayMedia((stream) => {
      selectedStream = stream;
      return pickerResult;
    });
    const streamsReadySpy = vi.fn();
    bus.on('system-audio:streams-ready', streamsReadySpy);

    const startPromise = startSystemAudioCapture();
    await Promise.resolve();
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES);
    resolvePicker(selectedStream!);
    await startPromise;

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(streamsReadySpy).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(false);
  });

  it('allows only one native capture start attempt at a time', async () => {
    let resolvePicker!: (stream: MediaStream) => void;
    const pickerResult = new Promise<MediaStream>((resolve) => {
      resolvePicker = resolve;
    });
    let selectedStream: MediaStream | null = null;
    const getDisplayMedia = stubDisplayMedia((stream) => {
      selectedStream = stream;
      return pickerResult;
    });

    const firstStart = startSystemAudioCapture();
    await Promise.resolve();
    const duplicateStart = startSystemAudioCapture();

    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    resolvePicker(selectedStream!);
    await Promise.all([firstStart, duplicateStart]);

    expect(isSystemAudioActive()).toBe(true);
    bus.emit('system-audio:stop');
  });

  it('discards a pending capture after PRO coordinator authority is lost', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    let resolvePicker!: (stream: MediaStream) => void;
    const pickerResult = new Promise<MediaStream>((resolve) => {
      resolvePicker = resolve;
    });
    let selectedStream: MediaStream | null = null;
    stubDisplayMedia((stream) => {
      selectedStream = stream;
      return pickerResult;
    });

    const startPromise = startSystemAudioCapture();
    await Promise.resolve();
    setState('room.context', {
      ...getState('room.context'),
      role: 'member',
      coordinatorId: 'peer-1',
      epoch: 2,
    });
    resolvePicker(selectedStream!);
    await startPromise;

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });

  it('force-stops an active share when the PRO coordinator becomes a member', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    stubDisplayMedia();
    await startSystemAudioCapture();
    const forceStopSpy = vi.fn();
    bus.on('system-audio:force-stop', forceStopSpy);

    setState('room.context', {
      ...getState('room.context'),
      role: 'member',
      coordinatorId: 'peer-1',
      epoch: 2,
    });

    expect(forceStopSpy).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });

  it('rechecks capacity after asynchronous audio initialization', async () => {
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES - 1);
    let resolveInit!: () => void;
    vi.mocked(initAudio).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );
    stubDisplayMedia();

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(initAudio).toHaveBeenCalledTimes(1));
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES);
    resolveInit();
    await startPromise;

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });

  it('stops an active share once the fifth device connects', async () => {
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES - 1);
    const restoreSpy = await startShareWithPriorYouTube();
    const toastSpy = vi.fn();
    bus.on('ui:show-toast', toastSpy);
    const peers = setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES);

    bus.emit('network:peer-connected', peers.at(-1)!.conn!);
    bus.emit('network:peer-connected', peers.at(-1)!.conn!);

    expect(isSystemAudioActive()).toBe(false);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      t('system_audio.device_limit_stopped', { count: MAX_SYSTEM_AUDIO_DEVICES }),
    );
  });

  it('ends the whole host share after two hours', async () => {
    vi.useFakeTimers();
    stubDisplayMedia();
    const toastSpy = vi.fn();
    bus.on('ui:show-toast', toastSpy);
    await startSystemAudioCapture();
    toastSpy.mockClear();

    vi.advanceTimersByTime(SYSTEM_AUDIO_SHARE_LIMIT_MS);

    expect(isSystemAudioActive()).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith(t('system_audio.duration_limit_stopped'));
  });

  it('clears the two-hour timer when sharing stops earlier', async () => {
    vi.useFakeTimers();
    stubDisplayMedia();
    await startSystemAudioCapture();
    const toastSpy = vi.fn();
    bus.on('ui:show-toast', toastSpy);

    bus.emit('system-audio:stop');
    toastSpy.mockClear();
    vi.advanceTimersByTime(SYSTEM_AUDIO_SHARE_LIMIT_MS);

    expect(toastSpy).not.toHaveBeenCalled();
  });
});
