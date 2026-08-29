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
import {
  setPlaybackFilePlaying,
  setPlaybackIdle,
  setPlaybackTrackMeta,
  setPlaybackYouTubePaused,
  setPlaybackYouTubePlaying,
} from '../../player/ownership.ts';
import { getWidener, initAudio } from '../engine.ts';
import {
  isSystemAudioActive,
  registerSystemCaptureListeners,
  startSystemAudioCapture,
} from '../system-capture.ts';
import type { ProRoomSystemAudioPublication } from '../../pro-room/contracts.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem, TrackMeta } from '../../types/index.ts';

const YOUTUBE_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  let destinationIndex = 0;
  return {
    resetDestinations: () => {
      destinationIndex = 0;
    },
    ctx: {
      createMediaStreamSource: () => node(),
      createChannelSplitter: () => node(),
      createMediaStreamDestination: () => {
        destinationIndex += 1;
        const track = {
          id: `dest-track-${destinationIndex}`,
          kind: 'audio',
          readyState: 'live',
          muted: false,
          stop: vi.fn(),
        } as unknown as MediaStreamTrack;
        return {
          channelCount: 0,
          channelCountMode: '',
          stream: {
            id: `dest-stream-${destinationIndex}`,
            active: true,
            getAudioTracks: () => [track],
            getTracks: () => [track],
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      },
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

const proAudio = vi.hoisted(() => ({
  view: {
    roomCode: '000001',
    initialized: true,
    phase: 'idle' as 'idle' | 'preparing' | 'live',
    generation: 0 as number | null,
    ownerParticipantId: null as string | null,
    isLocalOwner: false,
    localRequestPending: false,
    canStart: true,
    canStop: false,
    claimExpiresAt: null as number | null,
    liveExpiresAt: null as number | null,
    publication: null as ProRoomSystemAudioPublication | null,
  },
  ownerName: null as string | null,
  acquire: vi.fn(),
  publish: vi.fn(),
  release: vi.fn(),
  attemptToken: null as symbol | null,
  coordinatorCompatible: true,
}));

const transport = vi.hoisted(() => ({
  stopAllMediaAsync: vi.fn(async () => true),
  getTrackPosition: vi.fn(() => 0),
}));

vi.mock('../../player/transport.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../player/transport.ts')>()),
  stopAllMediaAsync: transport.stopAllMediaAsync,
  getTrackPosition: transport.getTrackPosition,
}));

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

vi.mock('../../pro-room/system-audio-bridge.ts', () => ({
  beginLocalProSystemAudioLeaseAttempt: vi.fn(() => {
    const token = Symbol('test-pro-lease-attempt');
    proAudio.attemptToken = token;
    const result = proAudio.acquire();
    let releaseFlight: Promise<unknown> | null = null;
    return {
      result,
      releaseIfCurrent: vi.fn(() => {
        if (releaseFlight) return releaseFlight;
        releaseFlight = result.then(
          () => {
            if (proAudio.attemptToken !== token) return null;
            proAudio.attemptToken = null;
            return proAudio.release();
          },
          () => null,
        );
        return releaseFlight;
      }),
    };
  }),
  canPublishProSystemAudioWithCurrentCoordinator: vi.fn(() => proAudio.coordinatorCompatible),
  getProSystemAudioOwnerDisplayName: vi.fn(() => proAudio.ownerName),
  getProSystemAudioViewState: vi.fn(() => ({ ...proAudio.view })),
  publishLocalProSystemAudio: proAudio.publish,
  releaseLocalProSystemAudioLease: vi.fn(() => {
    proAudio.attemptToken = null;
    return proAudio.release();
  }),
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

function setProRoom(epoch = 1): void {
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: 'host-1',
    epoch,
    snapshotRevision: epoch,
    capabilities: ['playback.control'],
  });
}

let lastDisplayCapture: {
  track: MediaStreamTrack;
  videoTrack: MediaStreamTrack | null;
  videoGetSettings: ReturnType<typeof vi.fn> | null;
  videoStop: ReturnType<typeof vi.fn> | null;
  videoLabelRead: ReturnType<typeof vi.fn> | null;
  dispatchEnded: () => void;
} | null = null;

function stubDisplayMedia(
  implementation?: (stream: MediaStream) => Promise<MediaStream>,
  videoOptions?: { displaySurface?: unknown; settingsError?: Error; label?: string },
): ReturnType<typeof vi.fn> {
  const endedListeners = new Set<() => void>();
  let readyState: MediaStreamTrackState = 'live';
  const track = {
    id: 'cap-track-1',
    kind: 'audio',
    get readyState() {
      return readyState;
    },
    muted: false,
    stop: vi.fn(() => {
      // MediaStreamTrack.stop() transitions the state but intentionally does
      // not dispatch `ended`; native source termination does both.
      readyState = 'ended';
    }),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'ended') endedListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'ended') endedListeners.delete(listener);
    }),
  } as unknown as MediaStreamTrack;
  const videoGetSettings = videoOptions
    ? vi.fn(() => {
        if (videoOptions.settingsError) throw videoOptions.settingsError;
        return { displaySurface: videoOptions.displaySurface } as MediaTrackSettings;
      })
    : null;
  const videoStop = videoOptions ? vi.fn() : null;
  const videoLabelRead = videoOptions ? vi.fn(() => videoOptions.label ?? 'private surface') : null;
  const videoTrack = videoOptions
    ? ({
        id: 'discarded-video-track',
        kind: 'video',
        readyState: 'live',
        get label() {
          return videoLabelRead!();
        },
        getSettings: videoGetSettings,
        stop: videoStop,
      } as unknown as MediaStreamTrack)
    : null;
  const stream = {
    get active() {
      return readyState === 'live';
    },
    getVideoTracks: () => (videoTrack ? [videoTrack] : []),
    getAudioTracks: () => [track],
    getTracks: () => (videoTrack ? [track, videoTrack] : [track]),
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
    videoTrack,
    videoGetSettings,
    videoStop,
    videoLabelRead,
    dispatchEnded: () => {
      readyState = 'ended';
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

function preparePriorYouTubePlayback(): ReturnType<typeof vi.fn> {
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
  return restoreSpy;
}

async function startShareWithPriorYouTube(): Promise<ReturnType<typeof vi.fn>> {
  const restoreSpy = preparePriorYouTubePlayback();
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
  h.resetDestinations();
  lastDisplayCapture = null;
  Object.assign(proAudio.view, {
    roomCode: '000001',
    initialized: true,
    phase: 'idle',
    generation: 0,
    ownerParticipantId: null,
    isLocalOwner: false,
    localRequestPending: false,
    canStart: true,
    canStop: false,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  });
  proAudio.ownerName = null;
  proAudio.coordinatorCompatible = true;
  proAudio.attemptToken = null;
  proAudio.acquire.mockResolvedValue({
    generation: 1,
    status: 'preparing',
    ownerParticipantId: 'member-1',
    claimExpiresAt: Date.now() + 45_000,
    liveExpiresAt: null,
    publication: null,
  });
  proAudio.publish.mockResolvedValue({
    generation: 1,
    status: 'live',
    ownerParticipantId: 'member-1',
    claimExpiresAt: null,
    liveExpiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
    publication: {
      publicationId: 'publication-1',
      sessionId: 'session-1',
      tracks: [],
    },
  });
  proAudio.release.mockResolvedValue(null);
  transport.stopAllMediaAsync.mockResolvedValue(true);
  transport.getTrackPosition.mockReturnValue(0);
  setState('network.appRole', 'host');
  registerSystemCaptureListeners();
});

afterEach(() => {
  bus.emit('system-audio:force-stop');
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('stopSystemAudioCapture restore semantics (SA-02)', () => {
  it('publishes the allowlisted surface after reading settings before video teardown', async () => {
    const peers = setConnectedGuests(1);
    stubDisplayMedia(undefined, {
      displaySurface: 'browser',
      label: 'Hearts2Hearts YouTube tab',
    });

    await startSystemAudioCapture();

    expect(lastDisplayCapture?.videoGetSettings).toHaveBeenCalledOnce();
    expect(lastDisplayCapture?.videoStop).toHaveBeenCalled();
    expect(lastDisplayCapture?.videoGetSettings?.mock.invocationCallOrder[0]).toBeLessThan(
      lastDisplayCapture?.videoStop?.mock.invocationCallOrder[0] ?? 0,
    );
    expect(lastDisplayCapture?.videoLabelRead).not.toHaveBeenCalled();
    expect(getState('player.currentTrackMeta')).toMatchObject({
      systemAudioMode: 'sharing',
      systemAudioSurface: 'browser',
    });
    expect(peers[0]?.conn?.send).toHaveBeenCalledWith({
      type: 'system-audio-start',
      surface: 'browser',
    });
  });

  it('still stops discarded video and uses DISPLAY when getSettings throws', async () => {
    const peers = setConnectedGuests(1);
    stubDisplayMedia(undefined, { settingsError: new Error('legacy getter failed') });

    await startSystemAudioCapture();

    expect(lastDisplayCapture?.videoStop).toHaveBeenCalled();
    expect(getState('player.currentTrackMeta')?.systemAudioSurface).toBe('display');
    expect(peers[0]?.conn?.send).toHaveBeenCalledWith({
      type: 'system-audio-start',
      surface: 'display',
    });
  });

  it('keeps the visual and announced role selection aligned during sharing and restore', async () => {
    document.body.innerHTML = `
      <div id="grid-standard">
        <button class="ch-opt" data-ch="0" aria-pressed="false"></button>
        <button class="ch-opt active" data-ch="-1" aria-pressed="true"></button>
      </div>
    `;
    setState('audio.channelMode', -1);
    stubDisplayMedia();

    await startSystemAudioCapture();

    const center = document.querySelector<HTMLElement>('.ch-opt[data-ch="0"]');
    const left = document.querySelector<HTMLElement>('.ch-opt[data-ch="-1"]');
    expect(center?.classList.contains('active')).toBe(true);
    expect(center?.getAttribute('aria-pressed')).toBe('true');
    expect(left?.classList.contains('active')).toBe(false);
    expect(left?.getAttribute('aria-pressed')).toBe('false');

    bus.emit('system-audio:stop');

    expect(center?.classList.contains('active')).toBe(false);
    expect(center?.getAttribute('aria-pressed')).toBe('false');
    expect(left?.classList.contains('active')).toBe(true);
    expect(left?.getAttribute('aria-pressed')).toBe('true');
  });

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

  it('restores a legacy file live checkpoint room-wide after a successful share', async () => {
    const queueItemId = '10000000-0000-4000-8000-000000000002';
    const meta = {
      queueItemId,
      type: 'file',
      name: 'resident.mp3',
      title: 'Resident',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePlaying();
    setState('player.pausedAt', 5);
    transport.getTrackPosition.mockReturnValue(71.5);
    const peers = setConnectedGuests(1);
    stubDisplayMedia();

    await startSystemAudioCapture();
    bus.emit('system-audio:stop');

    expect(getState('player.pausedAt')).toBe(71.5);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(peers[0]?.conn?.send).toHaveBeenCalledWith({
      type: 'pause',
      time: 71.5,
      queueItemId,
      reason: 'seek',
    });
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

  it('discards a track that ended before the picker promise could expose it', async () => {
    const restoreSpy = preparePriorYouTubePlayback();
    let resolvePicker!: (stream: MediaStream) => void;
    const pickerResult = new Promise<MediaStream>((resolve) => {
      resolvePicker = resolve;
    });
    let selectedStream: MediaStream | null = null;
    stubDisplayMedia((stream) => {
      selectedStream = stream;
      return pickerResult;
    });
    const capture = lastDisplayCapture!;
    const streamsReadySpy = vi.fn();
    bus.on('system-audio:streams-ready', streamsReadySpy);

    const startPromise = startSystemAudioCapture();
    capture.dispatchEnded();
    resolvePicker(selectedStream!);
    await startPromise;

    expect(capture.track.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(capture.track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(initAudio).not.toHaveBeenCalled();
    expect(transport.stopAllMediaAsync).not.toHaveBeenCalled();
    expect(streamsReadySpy).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('playback.activity')).toBe('playing');
    expect(capture.track.stop).toHaveBeenCalledOnce();
    expect(isSystemAudioActive()).toBe(false);
  });

  it('cancels quietly when the native track ends during audio initialization', async () => {
    preparePriorYouTubePlayback();
    let resolveInit!: () => void;
    vi.mocked(initAudio).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );
    stubDisplayMedia();
    const capture = lastDisplayCapture!;
    const commonStopSpy = vi.fn();
    const streamsReadySpy = vi.fn();
    bus.on('system-audio:stop', commonStopSpy);
    bus.on('system-audio:streams-ready', streamsReadySpy);

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(initAudio).toHaveBeenCalledOnce());
    expect(capture.track.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    capture.dispatchEnded();
    resolveInit();
    await startPromise;

    expect(commonStopSpy).not.toHaveBeenCalled();
    expect(transport.stopAllMediaAsync).not.toHaveBeenCalled();
    expect(streamsReadySpy).not.toHaveBeenCalled();
    expect(capture.track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('playback.activity')).toBe('playing');
    expect(isSystemAudioActive()).toBe(false);
  });

  it('restores a stopped standard-room owner and isolates a later start from stale ended events', async () => {
    const restoreSpy = preparePriorYouTubePlayback();
    let settleStop!: (stopped: boolean) => void;
    transport.stopAllMediaAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleStop = resolve;
        }),
    );
    stubDisplayMedia();
    const firstCapture = lastDisplayCapture!;
    const commonStopSpy = vi.fn();
    const streamsReadySpy = vi.fn();
    bus.on('system-audio:stop', commonStopSpy);
    bus.on('system-audio:streams-ready', streamsReadySpy);

    const firstStart = startSystemAudioCapture();
    await vi.waitFor(() => expect(transport.stopAllMediaAsync).toHaveBeenCalledOnce());
    setPlaybackIdle();
    firstCapture.dispatchEnded();
    settleStop(true);
    await firstStart;

    expect(commonStopSpy).not.toHaveBeenCalled();
    expect(streamsReadySpy).not.toHaveBeenCalled();
    expect(restoreSpy).toHaveBeenCalledOnce();
    expect(firstCapture.track.removeEventListener).toHaveBeenCalledWith(
      'ended',
      expect.any(Function),
    );
    expect(isSystemAudioActive()).toBe(false);

    stubDisplayMedia();
    await startSystemAudioCapture();
    expect(isSystemAudioActive()).toBe(true);

    // The first track is already detached. A duplicate/stale native event
    // must not tear down the successor capture.
    firstCapture.dispatchEnded();
    expect(commonStopSpy).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(true);
    bus.emit('system-audio:force-stop');
  });

  it('never publishes a PRO track that ends while its lease is pending', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    let resolveLease!: (state: unknown) => void;
    proAudio.acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLease = resolve;
        }),
    );
    stubDisplayMedia();
    const capture = lastDisplayCapture!;

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() =>
      expect(capture.track.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function)),
    );
    capture.dispatchEnded();
    resolveLease({
      generation: 1,
      status: 'preparing',
      ownerParticipantId: 'member-1',
      claimExpiresAt: Date.now() + 45_000,
      liveExpiresAt: null,
      publication: null,
    });
    await startPromise;

    expect(proAudio.publish).not.toHaveBeenCalled();
    expect(proAudio.release).toHaveBeenCalledOnce();
    expect(transport.stopAllMediaAsync).not.toHaveBeenCalled();
    expect(capture.track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(isSystemAudioActive()).toBe(false);
  });

  it('rejects a PRO live commit when the native track ends during publication', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    let resolvePublication!: (state: unknown) => void;
    proAudio.publish.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePublication = resolve;
        }),
    );
    stubDisplayMedia();
    const capture = lastDisplayCapture!;
    const commonStopSpy = vi.fn();
    bus.on('system-audio:stop', commonStopSpy);

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(proAudio.publish).toHaveBeenCalledOnce());
    capture.dispatchEnded();
    resolvePublication({
      generation: 1,
      status: 'live',
      ownerParticipantId: 'member-1',
      claimExpiresAt: null,
      liveExpiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
      publication: {
        publicationId: 'publication-1',
        sessionId: 'session-1',
        tracks: [],
      },
    });
    await startPromise;

    expect(commonStopSpy).not.toHaveBeenCalled();
    expect(proAudio.release).toHaveBeenCalledOnce();
    expect(capture.track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(isSystemAudioActive()).toBe(false);
  });

  it('does not clear an authoritative replacement meta when PRO publication fails late', async () => {
    setProRoom();
    let rejectPublication!: (error: Error) => void;
    proAudio.publish.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPublication = reject;
        }),
    );
    stubDisplayMedia();

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(proAudio.publish).toHaveBeenCalledOnce());
    const authoritativeReplacement: TrackMeta = {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioMode: 'receiving',
      systemAudioPlaceholder: true,
      systemAudioSurface: 'window',
    };
    setPlaybackTrackMeta(authoritativeReplacement);
    rejectPublication(new Error('publication failed'));
    await startPromise;

    expect(getState('player.currentTrackMeta')).toBe(authoritativeReplacement);
    expect(getState('playback.mode')).toBe('system-audio');
  });

  it.each(['resolve', 'reject'] as const)(
    'does not let an old-room picker %s release a live successor lease',
    async (outcome) => {
      setProRoom(1);
      let resolvePicker!: (stream: MediaStream) => void;
      let rejectPicker!: (error: Error) => void;
      let firstStream: MediaStream | null = null;
      stubDisplayMedia((stream) => {
        firstStream = stream;
        return new Promise<MediaStream>((resolve, reject) => {
          resolvePicker = resolve;
          rejectPicker = reject;
        });
      });

      const staleStart = startSystemAudioCapture();
      await Promise.resolve();
      bus.emit('system-audio:force-stop');

      setProRoom(2);
      stubDisplayMedia();
      await startSystemAudioCapture();
      expect(isSystemAudioActive()).toBe(true);
      expect(proAudio.release).not.toHaveBeenCalled();

      if (outcome === 'resolve') resolvePicker(firstStream!);
      else rejectPicker(new Error('old picker failed'));
      await staleStart;
      await Promise.resolve();

      expect(isSystemAudioActive()).toBe(true);
      expect(proAudio.release).not.toHaveBeenCalled();
      bus.emit('system-audio:force-stop');
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'does not let a stale PRO publish %s release or tear down its live successor',
    async (outcome) => {
      setProRoom();
      let resolvePublish!: (state: unknown) => void;
      let rejectPublish!: (error: Error) => void;
      proAudio.publish.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolvePublish = resolve;
            rejectPublish = reject;
          }),
      );
      stubDisplayMedia();

      const staleStart = startSystemAudioCapture();
      await vi.waitFor(() => expect(proAudio.publish).toHaveBeenCalledTimes(1));
      bus.emit('system-audio:force-stop');
      expect(proAudio.release).toHaveBeenCalledTimes(1);

      stubDisplayMedia();
      await startSystemAudioCapture();
      expect(proAudio.publish).toHaveBeenCalledTimes(2);
      expect(isSystemAudioActive()).toBe(true);

      if (outcome === 'resolve') {
        resolvePublish({
          generation: 1,
          status: 'live',
          ownerParticipantId: 'member-1',
          claimExpiresAt: null,
          liveExpiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
          publication: {
            publicationId: 'stale-publication',
            sessionId: 'stale-session',
            tracks: [],
          },
        });
      } else {
        rejectPublish(new Error('stale publish failed'));
      }
      await staleStart;
      await Promise.resolve();

      expect(isSystemAudioActive()).toBe(true);
      expect(proAudio.release).toHaveBeenCalledTimes(1);
      bus.emit('system-audio:force-stop');
    },
  );
});

describe('system audio start failure rollback', () => {
  it('leaves prior playback untouched when audio initialization fails', async () => {
    const restoreSpy = preparePriorYouTubePlayback();
    const error = new Error('audio graph unavailable');
    vi.mocked(initAudio).mockRejectedValueOnce(error);
    stubDisplayMedia();

    await expect(startSystemAudioCapture()).rejects.toBe(error);

    expect(getState('playback.mode')).toBe('youtube');
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('player.currentTrackMeta')).toEqual(youtubeMeta());
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });

  it('restores the prior snapshot when the prepared graph has no widener', async () => {
    const restoreSpy = preparePriorYouTubePlayback();
    vi.mocked(getWidener).mockReturnValueOnce(null);
    stubDisplayMedia();

    await startSystemAudioCapture();

    expect(restoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: 'video-1',
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        autoplay: true,
      }),
    );
    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });

  it('keeps a PRO room fail-closed when setup fails after prior media STOP', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    const restoreSpy = preparePriorYouTubePlayback();
    vi.mocked(getWidener).mockReturnValueOnce(null);
    stubDisplayMedia();

    await startSystemAudioCapture();

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(proAudio.publish).not.toHaveBeenCalled();
    expect(proAudio.release).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });

  it('keeps a PRO room fail-closed when publication fails after prior media STOP', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    const restoreSpy = preparePriorYouTubePlayback();
    proAudio.publish.mockRejectedValueOnce(new Error('publish unavailable'));
    stubDisplayMedia();

    await startSystemAudioCapture();

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(proAudio.publish).toHaveBeenCalledTimes(1);
    expect(proAudio.release).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });
});

describe('system audio operating-cost limits', () => {
  it('keeps standard-room capture coordinator-only', async () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', {
      peer: 'host-1',
      open: true,
    } as DataConnection);
    const getDisplayMedia = stubDisplayMedia();

    await startSystemAudioCapture();

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(false);
  });

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

  it('starts PRO lease acquisition and the native picker in the same activation turn', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    let resolveLease!: (state: unknown) => void;
    const leaseResult = new Promise((resolve) => {
      resolveLease = resolve;
    });
    proAudio.acquire.mockImplementationOnce(() => leaseResult);
    const getDisplayMedia = stubDisplayMedia();
    const streamsReadySpy = vi.fn();
    bus.on('system-audio:streams-ready', streamsReadySpy);

    const startPromise = startSystemAudioCapture();
    // Neither request may wait for the other: getDisplayMedia must execute
    // before the still-pending server lease settles, preserving user activation.
    expect(proAudio.acquire).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(proAudio.publish).not.toHaveBeenCalled();

    resolveLease({
      generation: 1,
      status: 'preparing',
      ownerParticipantId: 'member-1',
      claimExpiresAt: Date.now() + 45_000,
      liveExpiresAt: null,
      publication: null,
    });
    await startPromise;

    expect(proAudio.publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cap-track-1', contentHint: 'music' }),
    );
    expect(streamsReadySpy).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(true);
    bus.emit('system-audio:stop');
  });

  it('blocks a PRO member before lease acquisition and the native picker when its coordinator is old', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    proAudio.coordinatorCompatible = false;
    const getDisplayMedia = stubDisplayMedia();
    const toastSpy = vi.fn();
    bus.on('ui:show-toast', toastSpy);

    await startSystemAudioCapture();

    expect(proAudio.acquire).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(t('system_audio.coordinator_update_required'));
  });

  it('keeps a PRO publisher alive when coordinator responsibility moves away', async () => {
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

    expect(forceStopSpy).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(true);
    bus.emit('system-audio:stop');
  });

  it('force-stops a PRO publisher silently when its room session resets', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    stubDisplayMedia();
    await startSystemAudioCapture();
    const forceStopSpy = vi.fn();
    bus.on('system-audio:force-stop', forceStopSpy);

    bus.emit('pro-system-audio:lease-lost', 'reset');

    expect(forceStopSpy).toHaveBeenCalledTimes(1);
    expect(proAudio.release).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
  });

  it('restores playback when a live PRO lease is authoritatively revoked', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    stubDisplayMedia();
    await startSystemAudioCapture();
    const stopSpy = vi.fn();
    const forceStopSpy = vi.fn();
    bus.on('system-audio:stop', stopSpy);
    bus.on('system-audio:force-stop', forceStopSpy);

    bus.emit('pro-system-audio:lease-lost', 'authoritative-revocation');

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(forceStopSpy).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(false);
  });

  it('blocks the native picker when another PRO participant already owns the share', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    Object.assign(proAudio.view, {
      initialized: true,
      phase: 'live',
      generation: 7,
      ownerParticipantId: 'member-2',
      canStart: false,
    });
    proAudio.ownerName = 'Peer 2';
    const getDisplayMedia = stubDisplayMedia();
    const toastSpy = vi.fn();
    bus.on('ui:show-toast', toastSpy);

    await startSystemAudioCapture();

    expect(proAudio.acquire).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(t('system_audio.owner_active', { name: 'Peer 2' }));
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

  it('does not resurrect a capture cancelled while previous media teardown is pending', async () => {
    let settleStop!: (stopped: boolean) => void;
    transport.stopAllMediaAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleStop = resolve;
        }),
    );
    stubDisplayMedia();
    const streamsReadySpy = vi.fn();
    bus.on('system-audio:streams-ready', streamsReadySpy);

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(transport.stopAllMediaAsync).toHaveBeenCalledTimes(1));
    bus.emit('system-audio:force-stop');
    settleStop(true);
    await startPromise;

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(streamsReadySpy).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(false);
  });

  it('rechecks standard coordinator authority after previous media teardown', async () => {
    const restoreSpy = preparePriorYouTubePlayback();
    let settleStop!: (stopped: boolean) => void;
    transport.stopAllMediaAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleStop = resolve;
        }),
    );
    stubDisplayMedia();
    const streamsReadySpy = vi.fn();
    bus.on('system-audio:streams-ready', streamsReadySpy);

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(transport.stopAllMediaAsync).toHaveBeenCalledTimes(1));
    setState('network.appRole', 'guest');
    setState('network.hostConn', {
      peer: 'host-1',
      open: true,
    } as DataConnection);
    setPlaybackIdle();
    settleStop(true);
    await startPromise;

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(streamsReadySpy).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(isSystemAudioActive()).toBe(false);
  });

  it('does not restore old media after PRO publication authority is lost during teardown', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    const restoreSpy = preparePriorYouTubePlayback();
    let settleStop!: (stopped: boolean) => void;
    transport.stopAllMediaAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleStop = resolve;
        }),
    );
    stubDisplayMedia();

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(transport.stopAllMediaAsync).toHaveBeenCalledTimes(1));
    proAudio.coordinatorCompatible = false;
    setPlaybackIdle();
    settleStop(true);
    await startPromise;

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(proAudio.publish).not.toHaveBeenCalled();
    expect(proAudio.release).toHaveBeenCalledTimes(1);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(isSystemAudioActive()).toBe(false);
  });

  it('restores a same-room paused YouTube checkpoint when capacity rejects after media STOP', async () => {
    const restoreSpy = preparePriorYouTubePlayback();
    setPlaybackYouTubePaused();
    setState('player.pausedAt', 5);
    transport.getTrackPosition.mockReturnValue(44.5);
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES - 1);
    let settleStop!: (stopped: boolean) => void;
    transport.stopAllMediaAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleStop = resolve;
        }),
    );
    stubDisplayMedia();

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(transport.stopAllMediaAsync).toHaveBeenCalledTimes(1));
    const peers = setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES);
    setPlaybackIdle();
    settleStop(true);
    await startPromise;

    expect(isSystemAudioActive()).toBe(false);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queueItemId: YOUTUBE_QUEUE_ITEM_ID,
        videoId: 'video-1',
        autoplay: false,
        positionSeconds: 44.5,
      }),
    );
    // YouTube restoration owns its dedicated room-wide command path; the
    // system-audio compensation must not manufacture a file PAUSE.
    for (const peer of peers) {
      expect(peer.conn?.send).not.toHaveBeenCalled();
    }
  });

  it('restores a same-room legacy file checkpoint to host and guests after rejection', async () => {
    const queueItemId = '70000000-0000-4000-8000-000000000002';
    const meta = {
      queueItemId,
      type: 'file',
      name: 'resident-race.mp3',
      title: 'Resident race',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePlaying();
    setState('player.pausedAt', 5);
    transport.getTrackPosition.mockReturnValue(28.25);
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES - 1);
    let settleStop!: (stopped: boolean) => void;
    transport.stopAllMediaAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleStop = resolve;
        }),
    );
    stubDisplayMedia();

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(transport.stopAllMediaAsync).toHaveBeenCalledTimes(1));
    const peers = setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES);
    setState('player.pausedAt', 0);
    setPlaybackIdle();
    settleStop(true);
    await startPromise;

    expect(isSystemAudioActive()).toBe(false);
    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('player.currentTrackMeta')).toBe(meta);
    expect(getState('player.pausedAt')).toBe(28.25);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    for (const peer of peers) {
      expect(peer.conn?.send).toHaveBeenCalledWith({
        type: 'pause',
        time: 28.25,
        queueItemId,
        reason: 'seek',
      });
    }
  });

  it('does not restore a rejected start after switching between standard rooms', async () => {
    setState('network.sessionCode', '111111');
    setState('network.myId', 'host-room-a');
    const restoreSpy = preparePriorYouTubePlayback();
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES - 1);
    let settleStop!: (stopped: boolean) => void;
    transport.stopAllMediaAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleStop = resolve;
        }),
    );
    stubDisplayMedia();

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(transport.stopAllMediaAsync).toHaveBeenCalledTimes(1));
    setState('network.sessionCode', '222222');
    setState('network.myId', 'host-room-b');
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES);
    setPlaybackIdle();
    settleStop(true);
    await startPromise;

    expect(isSystemAudioActive()).toBe(false);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('releases a PRO lease when previous media teardown cannot commit', async () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    transport.stopAllMediaAsync.mockResolvedValueOnce(false);
    stubDisplayMedia();

    await startSystemAudioCapture();

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(proAudio.release).toHaveBeenCalledTimes(1);
    expect(proAudio.publish).not.toHaveBeenCalled();
    expect(isSystemAudioActive()).toBe(false);
  });

  it('does not resurrect a capture whose native picker resolves after stop', async () => {
    let resolvePicker!: (stream: MediaStream) => void;
    stubDisplayMedia(
      (stream) =>
        new Promise<MediaStream>((resolve) => {
          resolvePicker = () => resolve(stream);
        }),
    );

    const startPromise = startSystemAudioCapture();
    await Promise.resolve();
    bus.emit('system-audio:force-stop');
    resolvePicker(null as unknown as MediaStream);
    await startPromise;

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(initAudio).not.toHaveBeenCalled();
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

  it('keeps a PRO LAN-direct share active past its compatibility timestamp', async () => {
    vi.useFakeTimers();
    setProRoom();
    proAudio.publish.mockResolvedValueOnce({
      generation: 1,
      status: 'live',
      ownerParticipantId: 'member-1',
      claimExpiresAt: null,
      liveExpiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
      publication: {
        publicationId: 'publication-direct-1',
        transport: 'lan-direct',
        protocolVersion: 2,
      },
    });
    stubDisplayMedia();

    await startSystemAudioCapture();
    vi.advanceTimersByTime(SYSTEM_AUDIO_SHARE_LIMIT_MS + 60_000);

    expect(isSystemAudioActive()).toBe(true);
    expect(proAudio.release).not.toHaveBeenCalled();
  });

  it('starts the PRO two-hour host timer from authoritative SFU promotion state', async () => {
    vi.useFakeTimers();
    setProRoom();
    proAudio.publish.mockResolvedValueOnce({
      generation: 1,
      status: 'live',
      ownerParticipantId: 'member-1',
      claimExpiresAt: null,
      liveExpiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
      publication: {
        publicationId: 'publication-promoted-1',
        transport: 'lan-direct',
        protocolVersion: 2,
      },
    });
    stubDisplayMedia();
    await startSystemAudioCapture();
    vi.advanceTimersByTime(30 * 60_000);

    const promotedExpiresAt = Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS;
    Object.assign(proAudio.view, {
      phase: 'live',
      generation: 1,
      ownerParticipantId: 'member-1',
      isLocalOwner: true,
      canStart: false,
      canStop: true,
      liveExpiresAt: promotedExpiresAt,
      publication: {
        publicationId: 'publication-promoted-1',
        sessionId: 'session-promoted-1',
        tracks: [],
      },
    });
    bus.emit(
      'pro-system-audio:state-changed',
      {
        roomCode: '000001',
        initialized: true,
        phase: 'live',
        generation: 1,
        ownerParticipantId: 'member-1',
        isLocalOwner: true,
        localRequestPending: false,
        canStart: false,
        canStop: true,
        claimExpiresAt: null,
        liveExpiresAt: promotedExpiresAt,
      },
      null,
    );

    vi.advanceTimersByTime(SYSTEM_AUDIO_SHARE_LIMIT_MS - 1);
    expect(isSystemAudioActive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isSystemAudioActive()).toBe(false);
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
