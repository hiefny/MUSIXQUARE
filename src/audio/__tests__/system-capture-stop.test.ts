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
    publication: null,
  },
  ownerName: null as string | null,
  acquire: vi.fn(),
  publish: vi.fn(),
  release: vi.fn(),
  coordinatorCompatible: true,
}));

const transport = vi.hoisted(() => ({
  stopAllMediaAsync: vi.fn(async () => true),
  getTrackPosition: vi.fn(() => 0),
}));

const boundedV1 = vi.hoisted(() => {
  const state: {
    snapshot: {
      active: boolean;
      role: 'host' | 'guest' | 'idle';
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
      applyControl: vi.fn(
        async (control: {
          queueItemId: string;
          legacySessionId: number;
          positionSeconds: number;
          kind: string;
        }) => {
          const current = state.snapshot.current;
          if (
            !current ||
            current.queueItemId !== control.queueItemId ||
            current.legacySessionId !== control.legacySessionId
          ) {
            return { status: 'rejected' as const };
          }
          state.snapshot.current = {
            ...current,
            phase: control.kind === 'stop' ? 'stopped' : 'paused',
            positionSeconds: control.positionSeconds,
          };
          state.positionSeconds = control.positionSeconds;
          return { status: 'applied' as const };
        },
      ),
    },
  };
});

vi.mock('../../player/transport.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../player/transport.ts')>()),
  stopAllMediaAsync: transport.stopAllMediaAsync,
  getTrackPosition: transport.getTrackPosition,
}));

vi.mock('../../player/legacy-bounded-file-v1-product.ts', () => ({
  legacyBoundedFileV1Product: boundedV1.product,
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
  acquireLocalProSystemAudioLease: proAudio.acquire,
  canPublishProSystemAudioWithCurrentCoordinator: vi.fn(() => proAudio.coordinatorCompatible),
  getProSystemAudioOwnerDisplayName: vi.fn(() => proAudio.ownerName),
  getProSystemAudioViewState: vi.fn(() => ({ ...proAudio.view })),
  publishLocalProSystemAudio: proAudio.publish,
  releaseLocalProSystemAudioLease: proAudio.release,
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
  boundedV1.state.snapshot = { active: false, role: 'idle', current: null };
  boundedV1.state.positionSeconds = null;
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

  it('restores the exact bounded duration and position without an AudioBuffer', async () => {
    const queueItemId = '10000000-0000-4000-8000-000000000001';
    const meta: TrackMeta = {
      queueItemId,
      type: 'file',
      name: 'bounded.flac',
      title: 'bounded.flac',
      videoId: null,
      playlistId: null,
    };
    setState('playlist.items', [
      {
        queueItemId,
        type: 'file',
        name: 'bounded.flac',
        title: 'bounded.flac',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setState('player.pausedAt', 0);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePlaying();
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId,
        legacySessionId: 17,
        state: 'ready',
        phase: 'playing',
        positionSeconds: 67.5,
        durationSeconds: 181.25,
      },
    };
    boundedV1.state.positionSeconds = 67.5;
    const peers = setConnectedGuests(1);
    const durationUpdate = vi.fn();
    bus.on('ui:duration-update', durationUpdate);
    stubDisplayMedia();

    await startSystemAudioCapture();
    bus.emit('system-audio:stop');

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(getState('player.pausedAt')).toBe(67.5);
    expect(getState('player.currentTrackMeta')).toBe(meta);
    expect(durationUpdate).toHaveBeenCalledWith(181.25);
    await vi.waitFor(() => {
      expect(boundedV1.state.snapshot.current).toMatchObject({
        queueItemId,
        legacySessionId: 17,
        phase: 'paused',
        positionSeconds: 67.5,
      });
      expect(peers[0]?.conn?.send).toHaveBeenCalledWith({
        type: 'pause',
        time: 67.5,
        queueItemId,
        reason: 'seek',
      });
    });
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

  it('does not let an old bounded restore repaint over a newer system-audio start', async () => {
    const queueItemId = '10000000-0000-4000-8000-000000000003';
    const meta = {
      queueItemId,
      type: 'file',
      name: 'restart-race.m4a',
      title: 'Restart race',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePlaying();
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId,
        legacySessionId: 23,
        state: 'ready',
        phase: 'stopped',
        positionSeconds: 0,
        durationSeconds: 180,
      },
    };
    boundedV1.state.positionSeconds = 0;
    setState('player.pausedAt', 67);
    const peers = setConnectedGuests(1);
    let settleCheckpoint!: () => void;
    boundedV1.product.applyControl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleCheckpoint = () => resolve({ status: 'applied' as const });
        }),
    );
    stubDisplayMedia();

    await startSystemAudioCapture();
    bus.emit('system-audio:stop');
    await vi.waitFor(() =>
      expect(boundedV1.product.applyControl).toHaveBeenCalledTimes(1),
    );

    await startSystemAudioCapture();
    vi.mocked(peers[0]!.conn!.send).mockClear();
    settleCheckpoint();
    await Promise.resolve();
    await Promise.resolve();

    expect(isSystemAudioActive()).toBe(true);
    expect(getState('playback.mode')).toBe('system-audio');
    expect(getState('playback.activity')).toBe('playing');
    expect(peers[0]?.conn?.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pause',
        time: 67,
        queueItemId,
        reason: 'seek',
      }),
    );
    bus.emit('system-audio:force-stop');
  });

  it('projects a newer ready bounded source instead of clearing successor UI', async () => {
    const originalQueueItemId = '10000000-0000-4000-8000-000000000011';
    const successorQueueItemId = '10000000-0000-4000-8000-000000000012';
    const originalMeta = {
      queueItemId: originalQueueItemId,
      type: 'file',
      name: 'original.flac',
      title: 'Original',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    const successorMeta = {
      queueItemId: successorQueueItemId,
      type: 'file',
      name: 'successor.flac',
      title: 'Successor',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    setState('playlist.items', [originalMeta, successorMeta]);
    setState('playlist.currentQueueItemId', originalQueueItemId);
    setPlaybackTrackMeta(originalMeta);
    setPlaybackFilePlaying();
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId: originalQueueItemId,
        legacySessionId: 17,
        state: 'ready',
        phase: 'playing',
        positionSeconds: 18,
        durationSeconds: 180,
      },
    };
    boundedV1.state.positionSeconds = 18;
    stubDisplayMedia();

    await startSystemAudioCapture();

    setState('playlist.currentQueueItemId', successorQueueItemId);
    setPlaybackTrackMeta(successorMeta);
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId: successorQueueItemId,
        legacySessionId: 18,
        state: 'ready',
        phase: 'paused',
        positionSeconds: 52.25,
        durationSeconds: 240,
      },
    };
    boundedV1.state.positionSeconds = 52.25;

    bus.emit('system-audio:stop');

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toMatchObject({
      queueItemId: successorQueueItemId,
      title: 'Successor',
    });
    expect(getState('player.pausedAt')).toBe(52.25);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('uses a stopped successor product checkpoint instead of stale player time', async () => {
    const originalQueueItemId = '10000000-0000-4000-8000-000000000015';
    const successorQueueItemId = '10000000-0000-4000-8000-000000000016';
    const originalMeta = {
      queueItemId: originalQueueItemId,
      type: 'file',
      name: 'original-stopped.flac',
      title: 'Original stopped',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    const successorMeta = {
      queueItemId: successorQueueItemId,
      type: 'file',
      name: 'successor-stopped.flac',
      title: 'Successor stopped',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    setState('playlist.items', [originalMeta, successorMeta]);
    setState('playlist.currentQueueItemId', originalQueueItemId);
    setPlaybackTrackMeta(originalMeta);
    setPlaybackFilePlaying();
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId: originalQueueItemId,
        legacySessionId: 20,
        state: 'ready',
        phase: 'playing',
        positionSeconds: 18,
        durationSeconds: 180,
      },
    };
    boundedV1.state.positionSeconds = 18;
    stubDisplayMedia();

    await startSystemAudioCapture();

    setState('playlist.currentQueueItemId', successorQueueItemId);
    setPlaybackTrackMeta(successorMeta);
    setState('player.pausedAt', 99);
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId: successorQueueItemId,
        legacySessionId: 21,
        state: 'ready',
        phase: 'stopped',
        positionSeconds: 0,
        durationSeconds: 240,
      },
    };
    boundedV1.state.positionSeconds = 0;

    bus.emit('system-audio:stop');

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toMatchObject({
      queueItemId: successorQueueItemId,
      title: 'Successor stopped',
    });
    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('does not restore a retained old bounded source over a selected preparing successor', async () => {
    const originalQueueItemId = '10000000-0000-4000-8000-000000000013';
    const successorQueueItemId = '10000000-0000-4000-8000-000000000014';
    const originalMeta = {
      queueItemId: originalQueueItemId,
      type: 'file',
      name: 'original.m4a',
      title: 'Original',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    const successorMeta = {
      queueItemId: successorQueueItemId,
      type: 'file',
      name: 'preparing-successor.m4a',
      title: 'Preparing successor',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    setState('playlist.items', [originalMeta, successorMeta]);
    setState('playlist.currentQueueItemId', originalQueueItemId);
    setPlaybackTrackMeta(originalMeta);
    setPlaybackFilePlaying();
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId: originalQueueItemId,
        legacySessionId: 19,
        state: 'ready',
        phase: 'playing',
        positionSeconds: 24,
        durationSeconds: 180,
      },
    };
    boundedV1.state.positionSeconds = 24;
    stubDisplayMedia();

    await startSystemAudioCapture();

    // Selection B is visible while the old A renderer remains retained during
    // successor preparation/retirement.
    setState('playlist.currentQueueItemId', successorQueueItemId);
    setPlaybackTrackMeta(successorMeta);
    boundedV1.state.snapshot.current = {
      ...boundedV1.state.snapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    boundedV1.state.positionSeconds = 0;

    bus.emit('system-audio:stop');

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toBe(successorMeta);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
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

  it('does not let a no-widener rollback repaint over a newer capture start', async () => {
    const queueItemId = '60000000-0000-4000-8000-000000000001';
    const meta = {
      queueItemId,
      type: 'file',
      name: 'rollback-race.m4a',
      title: 'Rollback race',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePlaying();
    setState('player.pausedAt', 67);
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId,
        legacySessionId: 31,
        state: 'ready',
        phase: 'stopped',
        positionSeconds: 0,
        durationSeconds: 180,
      },
    };
    boundedV1.state.positionSeconds = 0;
    const peers = setConnectedGuests(1);
    let settleCheckpoint!: () => void;
    boundedV1.product.applyControl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleCheckpoint = () => resolve({ status: 'applied' as const });
        }),
    );
    vi.mocked(getWidener).mockReturnValueOnce(null);
    stubDisplayMedia();

    await startSystemAudioCapture();
    await vi.waitFor(() =>
      expect(boundedV1.product.applyControl).toHaveBeenCalledTimes(1),
    );
    await startSystemAudioCapture();
    vi.mocked(peers[0]!.conn!.send).mockClear();
    settleCheckpoint();
    await Promise.resolve();
    await Promise.resolve();

    expect(isSystemAudioActive()).toBe(true);
    expect(getState('playback.mode')).toBe('system-audio');
    expect(getState('playback.activity')).toBe('playing');
    expect(peers[0]?.conn?.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pause',
        time: 67,
        queueItemId,
        reason: 'seek',
      }),
    );
    bus.emit('system-audio:force-stop');
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
      expect.objectContaining({ id: 'dest-track-1' }),
      expect.objectContaining({ id: 'dest-track-2' }),
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

  it('restores the exact bounded pause when capacity rejects a start after media STOP', async () => {
    const queueItemId = '70000000-0000-4000-8000-000000000001';
    const meta = {
      queueItemId,
      type: 'file',
      name: 'capacity-race.m4a',
      title: 'Capacity race',
      videoId: null,
      playlistId: null,
    } satisfies PlaylistItem;
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePlaying();
    setState('player.pausedAt', 0);
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId,
        legacySessionId: 71,
        state: 'ready',
        phase: 'playing',
        positionSeconds: 36.5,
        durationSeconds: 205,
      },
    };
    boundedV1.state.positionSeconds = 36.5;
    setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES - 1);
    let settleStop!: (stopped: boolean) => void;
    transport.stopAllMediaAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settleStop = resolve;
        }),
    );
    const durationUpdate = vi.fn();
    bus.on('ui:duration-update', durationUpdate);
    stubDisplayMedia();

    const startPromise = startSystemAudioCapture();
    await vi.waitFor(() => expect(transport.stopAllMediaAsync).toHaveBeenCalledTimes(1));
    const peers = setConnectedGuests(MAX_SYSTEM_AUDIO_DEVICES);
    boundedV1.state.snapshot.current = {
      ...boundedV1.state.snapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    boundedV1.state.positionSeconds = 0;
    settleStop(true);
    await startPromise;

    expect(lastDisplayCapture?.track.stop).toHaveBeenCalledTimes(1);
    expect(isSystemAudioActive()).toBe(false);
    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('player.currentTrackMeta')).toBe(meta);
    expect(getState('player.pausedAt')).toBe(36.5);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(durationUpdate).toHaveBeenLastCalledWith(205);
    expect(boundedV1.state.snapshot.current).toMatchObject({
      queueItemId,
      legacySessionId: 71,
      phase: 'paused',
      positionSeconds: 36.5,
    });
    for (const peer of peers) {
      expect(peer.conn?.send).toHaveBeenCalledWith({
        type: 'pause',
        time: 36.5,
        queueItemId,
        reason: 'seek',
      });
    }
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
