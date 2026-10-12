/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import {
  getProStartObservations,
  resetProStartObservations,
} from '../../diagnostics/pro-start-observations.ts';

import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import type { ProRoomSnapshot } from '../../pro-room/contracts.ts';
import type { ProRoomSignalingAccess } from '../../pro-room/api.ts';
import { registerProRoomMediaHooks } from '../../pro-room/media-hooks.ts';
import {
  createProPlaybackAuthorityToken,
  getProPlaybackAuthorityKey,
  registerProPlaybackCommandHandler,
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackMediaEndpoint,
} from '../../pro-room/playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../../pro-room/playback-controller.ts';

const QUEUE_ITEM_ID = '44444444-4444-4444-8444-444444444444' as QueueItemId;
const SECOND_QUEUE_ITEM_ID = '55555555-5555-4555-8555-555555555555' as QueueItemId;

const platformUnderTest = vi.hoisted(() => ({ android: false }));
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  get IS_ANDROID() {
    return platformUnderTest.android;
  },
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
  verifyOperator: vi.fn(() => true),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(async () => {}),
}));

vi.mock('../../audio/effects.ts', () => ({
  applySettings: vi.fn(async () => {}),
  setEngineMode: vi.fn(),
}));

vi.mock('../../pro-room/network-bridge.ts', () => ({
  getProRoomServerNow: () => Date.now(),
  isProRoomServerClockCalibrated: () => true,
  acquireProRoomServerClock: vi.fn(async () => ({
    generation: 1,
    sampleId: 1,
    offsetMs: 0,
    rttMs: 10,
    sampledAtMs: Date.now(),
    roundId: 1,
    source: 'ready',
  })),
  captureProRoomServerClockSnapshot: () => ({
    generation: 1,
    sampleId: 1,
    offsetMs: 0,
    rttMs: 10,
    sampledAtMs: Date.now(),
    roundId: 1,
    source: 'ready',
  }),
  isProRoomClockSnapshotCurrent: () => true,
}));

vi.mock('../../ui/player-controls.ts', () => ({
  fmtTime: vi.fn(
    (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
  ),
  showPlacementToastForChannel: vi.fn(),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  getRoleLabelByChannelMode: vi.fn(),
}));

vi.mock('../search.ts', () => ({
  extractYouTubeVideoId: vi.fn((url: string) => {
    const m = url.match(/v=([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }),
  extractYouTubePlaylistId: vi.fn(() => null),
  isYouTubeLiveUrl: vi.fn(() => false),
  getYouTubeInputIntent: vi.fn(() => ({ kind: 'invalid-url' })),
  getPrefetchedYouTubePlaylistManifest: vi.fn(() => null),
  getSelectedYouTubeSearchResult: vi.fn(() => null),
  searchYouTubeFromInput: vi.fn(),
  resolveYouTubePlaylistEntry: vi.fn(async (playlistId: string, _signal?: AbortSignal) => ({
    playlistId,
    videoId: 'RESOLVED001',
    title: 'Resolved first video',
  })),
  resolveYouTubePlaylistManifest: vi.fn(async (playlistId: string) => ({
    playlistId,
    videoId: 'RESOLVED001',
    title: 'Resolved first video',
    videoIds: ['RESOLVED001', 'RESOLVED002'],
  })),
  clearYouTubeInputState: vi.fn(),
  fetchYouTubePreview: vi.fn(),
  fetchPlaylistSubTitles: vi.fn(),
  cancelSubTitleFetch: vi.fn(),
}));

// player.ts imports the oEmbed fetcher from the oembed.ts leaf (not search.ts).
vi.mock('../oembed.ts', () => ({
  fetchOEmbedTitle: vi.fn(async () => 'Test Title'),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../../ui/dom.ts', () => ({
  animateTransition: vi.fn((fn: () => unknown) => fn()),
}));

beforeEach(() => {
  platformUnderTest.android = false;
  vi.clearAllMocks();
  resetState();
  bus.clear();
  vi.useFakeTimers();
  resetProStartObservations();
  registerProRoomMediaHooks(null);
  registerProPlaybackCommandHandler(null);
  resetProPlaybackAuthorityHooks();

  const container = document.createElement('div');
  container.id = 'youtube-container';
  document.body.appendChild(container);

  const playerDiv = document.createElement('div');
  playerDiv.id = 'youtube-player';
  container.appendChild(playerDiv);
});

afterEach(() => {
  registerProRoomMediaHooks(null);
  registerProPlaybackCommandHandler(null);
  resetProPlaybackAuthorityHooks();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

import { clearAllManagedTimers } from '../../core/timers.ts';
import { registerProRoomLocalPlaybackTimeline } from '../../pro-room/local-playback-timeline.ts';
import { initYouTubeSync, resetYouTubeSyncState } from '../sync.ts';
import {
  prepareStandardHostManualOffsetRuntimeForTests,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';
import { toCanonicalYouTubeTime } from '../local-offset.ts';

let unregisterTimeline: (() => void) | null = null;
let nextRoomEpoch = 100;
const controllers: ProRoomPlaybackController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stopLifecycle();
  registerProPlaybackMediaEndpoint(null);
  (await import('../iframe.ts')).cancelYouTubeAuthorityPreparation();
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  unregisterTimeline?.();
  unregisterTimeline = null;
});

async function createProEndpoint(participantKind: 'owner' | 'member' = 'member') {
  // The participant's timing learner intentionally survives renderer resets
  // within one room. Each test owns a fresh room rather than inheriting it.
  const roomEpoch = ++nextRoomEpoch;
  await prepareStandardHostManualOffsetRuntimeForTests();
  const state = await import('../_state.ts');
  state.resetYouTubeModuleState();
  resetYouTubeSyncState();
  const { applyProPlaybackYouTubeCommit } = await import('../player.ts');
  const { prepareYouTubeAuthorityOccurrence, cancelYouTubeAuthorityPreparation } =
    await import('../iframe.ts');
  let muted = false;
  let volume = 60;
  let playerState = 1;
  let baseTime = 20;
  let playAtMs = performance.now();
  let videoId = 'VIDEOAAAAAA';
  let queueId = QUEUE_ITEM_ID;
  let revision = 1;
  let canonicalBase = 20;
  let canonicalAt = Date.now();
  let timelineLive = true;
  const currentTime = () =>
    playerState === 1 ? baseTime + (performance.now() - playAtMs) / 1000 : baseTime;
  const player = {
    loadVideoById: vi.fn((id: string, time = 0) => {
      videoId = id;
      baseTime = time;
      playAtMs = performance.now();
      playerState = 1;
    }),
    playVideo: vi.fn(() => {
      baseTime = currentTime();
      playAtMs = performance.now();
      playerState = 1;
    }),
    pauseVideo: vi.fn(() => {
      baseTime = currentTime();
      playerState = 2;
    }),
    seekTo: vi.fn((time: number) => {
      baseTime = time;
      playAtMs = performance.now();
    }),
    mute: vi.fn(() => {
      muted = true;
    }),
    unMute: vi.fn(() => {
      muted = false;
    }),
    isMuted: vi.fn(() => muted),
    setVolume: vi.fn((next: number) => {
      volume = next;
    }),
    getVolume: vi.fn(() => volume),
    getCurrentTime: vi.fn(currentTime),
    getDuration: vi.fn(() => 180),
    getPlayerState: vi.fn(() => playerState),
    getVideoData: vi.fn(() => ({ video_id: videoId, title: videoId })),
    getPlaylistIndex: vi.fn(() => -1),
  } as unknown as YouTubePlayerInstance;
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'A',
      videoId: 'VIDEOAAAAAA',
      playlistId: null,
    },
    {
      queueItemId: SECOND_QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'B',
      videoId: 'VIDEOBBBBBB',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', queueId);
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    // projectProRoomContext keeps even the owner coordinator-free; only
    // capabilities differ between the owner's and an ordinary member's UI.
    role: 'member',
    coordinatorId: null,
    epoch: roomEpoch,
    snapshotRevision: 1,
    capabilities: participantKind === 'owner' ? ['playback.control'] : [],
  });
  setState('audio.masterVolume', 0.6);
  setPlaybackYouTubePlaying();
  state.setYouTubePlayer(player);
  state.markYtPlayerReady(player);
  state.setYouTubeSubIndex(0);
  state.setYtLoadInProgress(false);
  unregisterTimeline = registerProRoomLocalPlaybackTimeline({
    getSnapshot: () =>
      ({
        roomCode: '000001',
        presence: { coordinatorEpoch: roomEpoch },
        playback: {
          coordinatorEpoch: roomEpoch,
          revision,
          state: 'playing',
          queueItemId: queueId,
          youtubeVideoId: videoId,
          youtubeSubIndex: 0,
          positionSeconds: canonicalBase,
          updatedAtMs: canonicalAt,
        },
      }) as ProRoomSnapshot,
    getServerNow: Date.now,
    isClockCalibrated: () => true,
    captureLiveness: () => () => timelineLive,
  });
  initYouTubeSync();
  const applyManual = async (offset: number) => {
    bus.emit('youtube:set-coordinator-manual-offset', offset, 'committed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getState('sync.youtubeLocalOffset')).toBeCloseTo(offset, 3);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(offset, 3);
  };
  const prepareNext = (positionSeconds = 0) => {
    resetStandardHostManualOffsetTransaction();
    queueId = SECOND_QUEUE_ITEM_ID;
    videoId = 'VIDEOBBBBBB';
    revision = 2;
    timelineLive = false;
    setState('playlist.currentQueueItemId', queueId);
    baseTime = 0;
    playerState = 2;
    setPlaybackYouTubePlaying();
    const authority = createProPlaybackAuthorityToken({
      roomId: '000001',
      roomEpoch,
      basePlaybackRevision: 1,
      transitionId: 'next-B',
    });
    const preparing = prepareYouTubeAuthorityOccurrence({
      authorityKey: getProPlaybackAuthorityKey(authority),
      queueItemId: queueId,
      videoId,
      subIndex: 0,
      positionSeconds,
    });
    return { authority, preparing };
  };
  const commit = (
    authority: ReturnType<typeof createProPlaybackAuthorityToken>,
    positionSeconds = 0,
    scheduleDelayMs = 699,
    timingMode: 'zero-start' | 'scheduled-control' = 'zero-start',
  ) => {
    canonicalBase = positionSeconds;
    canonicalAt = Date.now() + scheduleDelayMs;
    return applyProPlaybackYouTubeCommit({
      authority,
      committedPlaybackRevision: 2,
      queueItemId: queueId,
      state: 'playing',
      positionSeconds,
      scheduleDelayMs,
      timingMode,
      youtubeSubIndex: 0,
      youtubeVideoId: videoId,
      isCurrent: () => true,
    });
  };
  const commitDirect = (
    positionSeconds: number,
    playbackState: 'playing' | 'paused' = 'playing',
    scheduleDelayMs = 0,
  ) =>
    applyProPlaybackYouTubeCommit({
      authority: createProPlaybackAuthorityToken({
        roomId: '000001',
        roomEpoch,
        basePlaybackRevision: 1,
        transitionId: null,
      }),
      committedPlaybackRevision: 2,
      queueItemId: queueId,
      state: playbackState,
      positionSeconds,
      scheduleDelayMs,
      timingMode: 'scheduled-control',
      youtubeSubIndex: 0,
      youtubeVideoId: videoId,
      isCurrent: () => true,
    });
  return {
    roomEpoch,
    player,
    currentTime,
    applyManual,
    prepareNext,
    commit,
    commitDirect,
    cancel: cancelYouTubeAuthorityPreparation,
    setTimelineLive: (value: boolean) => {
      timelineLive = value;
    },
  };
}

async function installMediaSessionActions() {
  const { initYouTube } = await import('../player.ts');
  const { initMediaSession } = await import('../../player/media-session.ts');
  const actions = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaSession');
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null,
      playbackState: 'none',
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) =>
        actions.set(action, handler),
    },
  });
  (window as unknown as { YT: unknown }).YT = { PlayerState: { PLAYING: 1, PAUSED: 2 } };
  initYouTube();
  initMediaSession();
  return {
    trigger(action: MediaSessionAction) {
      expect(actions.has(action)).toBe(true);
      actions.get(action)?.({ action });
    },
    restore() {
      if (descriptor) Object.defineProperty(navigator, 'mediaSession', descriptor);
      else Reflect.deleteProperty(navigator, 'mediaSession');
    },
  };
}

function delayOneTimer(targetDelayMs: number, extraMs: number) {
  const original = globalThis.setTimeout;
  let delayed = false;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (!delayed && ms === targetDelayMs) {
      delayed = true;
      return original(callback, ms + extraMs, ...args);
    }
    return original(callback, ms, ...args);
  });
  return () => delayed;
}

describe('PRO manual offset across YouTube zero-start', () => {
  it.each(['zero-start', 'scheduled-control'] as const)(
    'keeps Android audible compensation out of canonical time and manual settings (%s)',
    async (timingMode) => {
      platformUnderTest.android = true;
      const endpoint = await createProEndpoint();
      const { authority, preparing } = endpoint.prepareNext(10);
      await vi.advanceTimersByTimeAsync(1_000);
      await preparing;
      const plays = vi.mocked(endpoint.player.playVideo).mock.calls.length;
      const pending = endpoint.commit(authority, 10, 700, timingMode);
      await vi.advanceTimersByTimeAsync(449);
      expect(endpoint.player.playVideo).toHaveBeenCalledTimes(plays);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25, 6);
      expect(
        getProStartObservations().find((entry) => entry.kind === 'youtube-release')?.detail,
      ).toMatchObject({
        scheduledLeadMs: 250,
        outputPositionAdvanceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(endpoint.currentTime()).toBeCloseTo(10.25, 6);
      expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(10, 6);
      await vi.advanceTimersByTimeAsync(2_000);
      const samples = getProStartObservations().filter((entry) => entry.kind === 'youtube-sample');
      expect(samples).toHaveLength(2);
      expect(samples[0].detail.automaticOffsetSeconds).toBe(0.25);
      expect(samples.every((entry) => Math.abs(Number(entry.detail.timelineDriftMs)) < 0.001)).toBe(
        true,
      );
      if (timingMode === 'zero-start') {
        expect(
          samples.every((entry) => Math.abs(Number(entry.detail.learningDriftMs) - 250) < 0.001),
        ).toBe(true);
        const learning = getProStartObservations().find(
          (entry) => entry.kind === 'youtube-learning',
        );
        expect(learning?.detail.nextTimelineLeadMs).toBe(0);
      } else {
        expect(samples.every((entry) => entry.detail.learningEnabled === false)).toBe(true);
      }
    },
  );

  it.each([0, 700])(
    'compensates Android direct playback once with %i ms scheduling',
    async (delayMs) => {
      platformUnderTest.android = true;
      const endpoint = await createProEndpoint();
      endpoint.setTimelineLive(false);
      setState('sync.youtubeLocalOffset', 0.5);
      const pending = endpoint.commitDirect(10, 'playing', delayMs);
      await vi.advanceTimersByTimeAsync(delayMs);
      await expect(pending).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(10.75, 6);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.75, 6);
      expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(10, 6);
      await expect(endpoint.commitDirect(10)).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(10.75, 6);
      await expect(endpoint.commitDirect(10, 'paused')).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(10.5, 6);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.5, 6);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.5);
    },
  );

  it.each([
    { offset: -0.1, wait: 0, local: 0.15 },
    { offset: -0.5, wait: 250, local: 0 },
    { offset: -9.999, wait: 9749, local: 0 },
  ])(
    'preserves Android direct negative manual offsets at zero ($offset)',
    async ({ offset, wait, local }) => {
      platformUnderTest.android = true;
      const endpoint = await createProEndpoint();
      endpoint.setTimelineLive(false);
      setState('sync.youtubeLocalOffset', offset);
      const pending = endpoint.commitDirect(0);
      if (wait > 0) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(endpoint.player.getPlayerState()).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
      } else await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(local, 6);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(offset + 0.25, 6);
      expect(getState('sync.youtubeLocalOffset')).toBe(offset);
    },
  );

  it('adds Android fixed output outside the positive manual input limit', async () => {
    platformUnderTest.android = true;
    const endpoint = await createProEndpoint();
    endpoint.setTimelineLive(false);
    setState('sync.youtubeLocalOffset', 9.999);
    await expect(endpoint.commitDirect(10)).resolves.toBe(true);
    expect(endpoint.currentTime()).toBeCloseTo(20.249, 6);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(10.249, 6);
    expect(getState('sync.youtubeLocalOffset')).toBe(9.999);
    expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(10, 6);
  });

  it.each([
    { offset: -0.1, wait: 0, local: 0.15 },
    { offset: -0.5, wait: 250, local: 0 },
    { offset: -9.999, wait: 9749, local: 0 },
  ])(
    'preserves Android prepared negative manual offsets at zero ($offset)',
    async ({ offset, wait, local }) => {
      platformUnderTest.android = true;
      const endpoint = await createProEndpoint();
      setState('sync.youtubeLocalOffset', offset);
      const { authority, preparing } = endpoint.prepareNext();
      await vi.advanceTimersByTimeAsync(1_000);
      await preparing;
      const pending = endpoint.commit(authority, 0, 0, 'scheduled-control');
      if (wait > 0) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(endpoint.player.getPlayerState()).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
      } else await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(local, 6);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(offset + 0.25, 6);
      expect(getState('sync.youtubeLocalOffset')).toBe(offset);
    },
  );

  it('does not learn away fixed Android output on successive perfectly aligned zero-starts', async () => {
    platformUnderTest.android = true;
    const endpoint = await createProEndpoint();
    for (let round = 0; round < 2; round += 1) {
      const { authority, preparing } = endpoint.prepareNext(10);
      await vi.advanceTimersByTimeAsync(1_000);
      await preparing;
      const pending = endpoint.commit(authority, 10, 700);
      await vi.advanceTimersByTimeAsync(2_700);
      await expect(pending).resolves.toBe(true);
    }
    const learning = getProStartObservations().filter((entry) => entry.kind === 'youtube-learning');
    expect(learning).toHaveLength(2);
    expect(learning.every((entry) => entry.detail.nextTimelineLeadMs === 0)).toBe(true);
    expect(
      getProStartObservations()
        .filter((entry) => entry.kind === 'youtube-release')
        .map((entry) => entry.detail.platformLeadMs),
    ).toEqual([250, 250]);
  });

  it('preserves fixed Android output through manual offset edits and reset', async () => {
    platformUnderTest.android = true;
    const endpoint = await createProEndpoint();
    for (const offset of [0.5, 9.999, 0]) {
      bus.emit('youtube:set-coordinator-manual-offset', offset, 'committed');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getState('sync.youtubeLocalOffset')).toBe(offset);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(offset + 0.25, 6);
      expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(
        20 + (offset === 0.5 ? 5 : offset === 9.999 ? 10 : 15),
        6,
      );
    }
  });

  it('retains fixed Android output when a failed manual edit rolls back', async () => {
    platformUnderTest.android = true;
    const endpoint = await createProEndpoint();
    vi.mocked(endpoint.player.pauseVideo).mockImplementationOnce(() => {
      throw new Error('pause failed');
    });
    bus.emit('youtube:set-coordinator-manual-offset', 0.5, 'committed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25, 6);
    expect(endpoint.player.getPlayerState()).toBe(1);
  });

  it('bounds Android direct output compensation before ENDED and retains the canonical checkpoint', async () => {
    platformUnderTest.android = true;
    const endpoint = await createProEndpoint();
    endpoint.setTimelineLive(false);
    await expect(endpoint.commitDirect(179.9)).resolves.toBe(true);
    expect(endpoint.currentTime()).toBeCloseTo(179.95, 6);
    expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(179.9, 6);
    await expect(endpoint.commitDirect(180, 'paused')).resolves.toBe(true);
    expect(endpoint.currentTime()).toBe(180);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
  });

  it('finishes a confirmed scheduled YouTube COMMIT after an unexpected socket close', async () => {
    const endpoint = await createProEndpoint();
    endpoint.setTimelineLive(false);
    const bridgeExports = await import('../../pro-room/network-bridge.ts');
    const originalAcquire = vi
      .mocked(bridgeExports.acquireProRoomServerClock)
      .getMockImplementation()!;
    const { ServerProRoomNetworkBridge } = await vi.importActual<
      typeof import('../../pro-room/network-bridge.ts')
    >('../../pro-room/network-bridge.ts');
    const bridge = new ServerProRoomNetworkBridge();
    type SocketEvent = { data?: string; reason?: string };
    let socket!: ClockSocket;
    class ClockSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: ClockSocket[] = [];
      readyState = ClockSocket.CONNECTING;
      readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();
      constructor() {
        ClockSocket.instances.push(this);
      }
      addEventListener(type: string, listener: (event: SocketEvent) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: (event: SocketEvent) => void) {
        this.listeners.get(type)?.delete(listener);
      }
      dispatch(type: string, event: SocketEvent = {}) {
        if (type === 'open') this.readyState = ClockSocket.OPEN;
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      send(raw: string) {
        const frame = JSON.parse(raw);
        if (frame.channel !== 'clock') return;
        setTimeout(
          () =>
            this.dispatch('message', {
              data: JSON.stringify({
                type: 'pro-clock',
                version: 1,
                requestId: frame.payload.requestId,
                clientSentAtMs: frame.payload.clientSentAtMs,
                serverTimeMs: frame.payload.clientSentAtMs + 5,
              }),
            }),
          10,
        );
      }
      close() {
        this.readyState = ClockSocket.CLOSED;
        this.dispatch('close');
      }
    }
    vi.stubGlobal('WebSocket', ClockSocket);
    const transportWindow = window as Window & {
      __MUSIXQUARE_TRANSPORT__?: Record<string, unknown>;
    };
    const previousTransport = transportWindow.__MUSIXQUARE_TRANSPORT__;
    transportWindow.__MUSIXQUARE_TRANSPORT__ = {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
    };
    const checkpoint = {
      coordinatorEpoch: endpoint.roomEpoch,
      revision: 2,
      state: 'playing' as const,
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 20,
      updatedAtMs: Date.now(),
      youtubeVideoId: 'VIDEOAAAAAA',
      youtubeSubIndex: 0,
    };
    const canonical = {
      roomCode: '000001',
      revision: 2,
      playlistRevision: 1,
      playlist: [],
      currentQueueItemId: QUEUE_ITEM_ID,
      playback: checkpoint,
      presence: { coordinatorEpoch: endpoint.roomEpoch },
      viewer: { participantId: 'participant_00001', presenceIncarnationId: 'presence_0000000001' },
    } as unknown as ProRoomSnapshot;
    try {
      const connecting = bridge.connect(canonical, {
        ticket: `${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
        expiresAtMs: Date.now() + 10_000,
        role: 'member',
        coordinatorEpoch: endpoint.roomEpoch,
        presenceIncarnationId: 'presence_0000000001',
        ticketSequence: 1,
        pendingPlaybackTransition: null,
      });
      socket = ClockSocket.instances.at(-1)!;
      socket.dispatch('open');
      await connecting;
      vi.mocked(bridgeExports.acquireProRoomServerClock).mockImplementation((options) =>
        bridge.acquireClock(options),
      );
      vi.spyOn(bridgeExports, 'captureProRoomServerClockSnapshot').mockImplementation(() =>
        bridge.captureClockSnapshot(),
      );
      vi.spyOn(bridgeExports, 'isProRoomClockSnapshotCurrent').mockImplementation((snapshot) =>
        bridge.isClockSnapshotCurrent(snapshot),
      );
      vi.spyOn(bridgeExports, 'getProRoomServerNow').mockImplementation(() => bridge.serverNowMs);
      vi.spyOn(bridgeExports, 'isProRoomServerClockCalibrated').mockImplementation(
        () => bridge.clockCalibrated,
      );
      const iframe = await import('../iframe.ts');
      const { applyProPlaybackYouTubeCommit } = await import('../player.ts');
      const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) => {
        const result = await iframe.prepareYouTubeAuthorityOccurrence({
          authorityKey: getProPlaybackAuthorityKey(request.authority),
          queueItemId: request.queueItemId,
          videoId: request.youtubeVideoId!,
          subIndex: 0,
          positionSeconds: request.positionSeconds,
        });
        return result.ready
          ? {
              status: 'ready',
              authority: request.authority,
              queueItemId: request.queueItemId,
              mediaKind: 'youtube',
              durationSeconds: 180,
              youtubeVideoId: request.youtubeVideoId!,
              youtubeSubIndex: 0,
            }
          : {
              status: 'failed',
              authority: request.authority,
              queueItemId: request.queueItemId,
              reason: 'media-unavailable',
            };
      });
      const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) =>
        (await applyProPlaybackYouTubeCommit(request))
          ? { status: 'applied', authority: request.authority }
          : { status: 'failed', authority: request.authority, reason: 'media-unavailable' },
      );
      const invalidate = vi.fn(() => {
        endpoint.player.pauseVideo?.();
      });
      registerProPlaybackMediaEndpoint({
        prepare,
        commit,
        cancel: () => iframe.cancelYouTubeAuthorityPreparation(),
        invalidateCommitted: invalidate,
      });
      const reportReady = vi.fn().mockResolvedValue('waiting');
      const applied = vi.fn();
      bus.on('sync:diagnostic-pro-checkpoint', applied);
      const controller = new ProRoomPlaybackController({
        isActive: () => true,
        getCanonicalSnapshot: () => canonical,
        getPlaylistSnapshot: () => canonical,
        capturePlaylistLease: () => ({ generation: 1, roomCode: '000001' }),
        isPlaylistLeaseCurrent: () => true,
        getRoomAbortSignal: () => undefined,
        subscribePlaylistProjection: () => () => undefined,
        runHeartbeat: vi.fn().mockResolvedValue(undefined),
        reportPlaybackTransitionReady: reportReady,
        executePlaybackCommand: vi.fn(),
        recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
      });
      controllers.push(controller);
      controller.acceptPrepare({
        type: 'pro-playback-prepare',
        transitionId: 'scheduled-close',
        serverTimeMs: Date.now(),
        deadlineAtMs: Date.now() + 3_000,
        basePlaybackRevision: 1,
        target: checkpoint,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reportReady).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
      const playsBefore = vi.mocked(endpoint.player.playVideo).mock.calls.length;
      controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: 'scheduled-close',
        serverTimeMs: Date.now(),
        executeAtMs: Date.now() + 700,
        playback: checkpoint,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(commit).toHaveBeenCalledOnce();
      socket.close();
      controller.beginControlChannelRecovery();
      expect(bridge.connected).toBe(false);
      expect(bridge.captureClockSnapshot()).toBeNull();
      await vi.advanceTimersByTimeAsync(600);
      // Exercise the actual arm and controller settlement, not just a mocked
      // endpoint accepting a schedule request before the socket disappears.
      expect(endpoint.player.playVideo).toHaveBeenCalledTimes(playsBefore + 1);
      expect.soft(applied).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
      expect.soft(invalidate).not.toHaveBeenCalled();
      expect.soft(endpoint.player.getPlayerState()).toBe(1);
    } finally {
      vi.mocked(bridgeExports.acquireProRoomServerClock).mockImplementation(originalAcquire);
      bridge.disconnect();
      if (previousTransport === undefined) delete transportWindow.__MUSIXQUARE_TRANSPORT__;
      else transportWindow.__MUSIXQUARE_TRANSPORT__ = previousTransport;
      vi.unstubAllGlobals();
    }
  });

  it.each(['prepared', 'direct'] as const)(
    'consumes a pending %s release on an actual member Media Session pause, then allows explicit resume',
    async (path) => {
      const endpoint = await createProEndpoint();
      await endpoint.applyManual(-9.999);
      const actions = await installMediaSessionActions();
      try {
        const { isLocalYouTubePaused, setLocalYouTubePaused } = await import('../_state.ts');
        const { authority, preparing } = endpoint.prepareNext();
        await vi.advanceTimersByTimeAsync(1_000);
        await preparing;
        const pending = path === 'prepared' ? endpoint.commit(authority) : endpoint.commitDirect(0);
        await vi.advanceTimersByTimeAsync(500);
        actions.trigger('pause');
        expect(isLocalYouTubePaused()).toBe(true);
        await expect(pending).resolves.toBe(true);
        const plays = vi.mocked(endpoint.player.playVideo).mock.calls.length;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(endpoint.player.getPlayerState()).toBe(2);
        expect(endpoint.player.playVideo).toHaveBeenCalledTimes(plays);

        // This is the registered Media Session PLAY -> common local-rejoin
        // seam. Its PRO adapter clears the pause before requesting a fresh
        // canonical commit; an old consumed frame must not suppress that one.
        let resumed: Promise<boolean> | null = null;
        const rejoin = vi.fn(() => {
          setLocalYouTubePaused(false);
          resumed = endpoint.commitDirect(20);
        });
        bus.on('playback:local-output-rejoin', rejoin);
        actions.trigger('play');
        expect(rejoin).toHaveBeenCalledOnce();
        await expect(resumed).resolves.toBe(true);
        expect(endpoint.player.getPlayerState()).toBe(1);
        expect(endpoint.currentTime()).toBeCloseTo(10.001, 3);
        expect(getState('sync.youtubeLocalOffset')).toBe(-9.999);
      } finally {
        actions.restore();
      }
    },
  );

  it.each(['canonical-pause', 'queue', 'teardown-reentry'] as const)(
    'does not consume a stale direct frame after local pause followed by %s',
    async (replacement) => {
      const endpoint = await createProEndpoint();
      await endpoint.applyManual(-9.999);
      const actions = await installMediaSessionActions();
      try {
        const { stopYouTubeMode } = await import('../player.ts');
        const state = await import('../_state.ts');
        const { preparing } = endpoint.prepareNext();
        await vi.advanceTimersByTimeAsync(1_000);
        await preparing;
        const pending = endpoint.commitDirect(0);
        await vi.advanceTimersByTimeAsync(500);
        actions.trigger('pause');
        if (replacement === 'canonical-pause') {
          await expect(endpoint.commitDirect(0.5, 'paused')).resolves.toBe(true);
        } else if (replacement === 'queue') {
          setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
        } else {
          stopYouTubeMode();
          state.setYouTubePlayer(endpoint.player);
          state.markYtPlayerReady(endpoint.player);
          setPlaybackYouTubePlaying();
        }
        await expect(pending).resolves.toBe(false);
        const plays = vi.mocked(endpoint.player.playVideo).mock.calls.length;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(endpoint.player.getPlayerState()).toBe(2);
        expect(endpoint.player.playVideo).toHaveBeenCalledTimes(plays);
      } finally {
        actions.restore();
      }
    },
  );

  it.each([-9.999, 0, 9.999])(
    'catches up a 1.5 s late prepared callback at offset %ss without changing the learned lead',
    async (offset) => {
      const endpoint = await createProEndpoint();
      await endpoint.applyManual(offset);
      const { authority, preparing } = endpoint.prepareNext();
      await vi.advanceTimersByTimeAsync(1_000);
      await preparing;
      const delay = 699 + Math.max(0, -offset * 1000);
      const delayed = delayOneTimer(delay, 1_500);
      const release = endpoint.commit(authority);
      await vi.advanceTimersByTimeAsync(delay + 1_500);
      await expect(release).resolves.toBe(true);
      expect(delayed()).toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(Math.max(0, offset) + 1.5, 3);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(offset, 3);
      endpoint.setTimelineLive(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(endpoint.currentTime()).toBeCloseTo(Math.max(0, offset) + 61.5, 3);

      // A second on-time transition must still release at the ordinary
      // deadline. Timer backlog is not a device-start latency observation.
      const next = endpoint.prepareNext();
      await vi.advanceTimersByTimeAsync(1_000);
      await next.preparing;
      const plays = vi.mocked(endpoint.player.playVideo).mock.calls.length;
      const onTime = endpoint.commit(next.authority);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(endpoint.player.playVideo).toHaveBeenCalledTimes(plays);
      await vi.advanceTimersByTimeAsync(1);
      await expect(onTime).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(Math.max(0, offset), 3);
    },
  );

  it('records a locally paused prepared commit as applied in the actual PRO controller without a fallback retry', async () => {
    const endpoint = await createProEndpoint();
    await endpoint.applyManual(-9.999);
    const actions = await installMediaSessionActions();
    try {
      const { preparing } = endpoint.prepareNext();
      await vi.advanceTimersByTimeAsync(1_000);
      await preparing;
      endpoint.cancel();
      const { prepareYouTubeAuthorityOccurrence } = await import('../iframe.ts');
      const { applyProPlaybackYouTubeCommit } = await import('../player.ts');
      const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) => {
        const result = await prepareYouTubeAuthorityOccurrence({
          authorityKey: getProPlaybackAuthorityKey(request.authority),
          queueItemId: request.queueItemId,
          videoId: request.youtubeVideoId!,
          subIndex: request.youtubeSubIndex ?? 0,
          positionSeconds: request.positionSeconds,
        });
        return result.ready
          ? {
              status: 'ready',
              authority: request.authority,
              queueItemId: request.queueItemId,
              mediaKind: 'youtube',
              durationSeconds: 180,
              youtubeVideoId: request.youtubeVideoId!,
              youtubeSubIndex: 0,
            }
          : {
              status: 'failed',
              authority: request.authority,
              queueItemId: request.queueItemId,
              reason: 'media-unavailable',
            };
      });
      const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) =>
        (await applyProPlaybackYouTubeCommit(request))
          ? { status: 'applied', authority: request.authority }
          : { status: 'failed', authority: request.authority, reason: 'media-unavailable' },
      );
      registerProPlaybackMediaEndpoint({ prepare, commit });
      const checkpoint = {
        coordinatorEpoch: endpoint.roomEpoch,
        revision: 2,
        state: 'playing' as const,
        queueItemId: SECOND_QUEUE_ITEM_ID,
        positionSeconds: 0,
        updatedAtMs: Date.now() + 1_699,
        youtubeVideoId: 'VIDEOBBBBBB',
        youtubeSubIndex: 0,
      };
      const canonical = {
        roomCode: '000001',
        revision: 2,
        playlistRevision: 1,
        playlist: [],
        currentQueueItemId: SECOND_QUEUE_ITEM_ID,
        playback: checkpoint,
        presence: { coordinatorEpoch: endpoint.roomEpoch },
      } as unknown as ProRoomSnapshot;
      const applied = vi.fn();
      bus.on('sync:diagnostic-pro-checkpoint', applied);
      const ports = {
        isActive: () => true,
        getCanonicalSnapshot: () => canonical,
        getPlaylistSnapshot: () => canonical,
        capturePlaylistLease: () => ({ generation: 1, roomCode: '000001' }),
        isPlaylistLeaseCurrent: () => true,
        getRoomAbortSignal: () => undefined,
        subscribePlaylistProjection: () => () => undefined,
        runHeartbeat: vi.fn().mockResolvedValue(undefined),
        reportPlaybackTransitionReady: vi.fn().mockResolvedValue('waiting'),
        executePlaybackCommand: vi.fn(),
        recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
      };
      const controller = new ProRoomPlaybackController(ports);
      controllers.push(controller);
      controller.acceptPrepare({
        type: 'pro-playback-prepare',
        transitionId: 'next-B',
        serverTimeMs: Date.now(),
        deadlineAtMs: Date.now() + 3_000,
        basePlaybackRevision: 1,
        target: checkpoint,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ports.reportPlaybackTransitionReady).toHaveBeenCalledOnce();
      controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: 'next-B',
        serverTimeMs: Date.now(),
        executeAtMs: Date.now() + 699,
        playback: checkpoint,
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(commit).toHaveBeenCalledOnce();
      actions.trigger('pause');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(endpoint.player.getPlayerState()).toBe(2);
      expect(prepare).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledOnce();
      expect(applied).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
      expect(ports.runHeartbeat).toHaveBeenCalledOnce();
      await controller.restorePersistedPlayback(canonical);
      expect(commit).toHaveBeenCalledOnce();
      expect(endpoint.player.getPlayerState()).toBe(2);
    } finally {
      actions.restore();
    }
  });

  it.each(['owner', 'member'] as const)(
    'keeps a %s negative offset through the next track without changing the canonical deadline',
    async (role) => {
      const endpoint = await createProEndpoint(role);
      await endpoint.applyManual(-0.25);
      const { authority, preparing } = endpoint.prepareNext();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(preparing).resolves.toMatchObject({ ready: true });
      const playsBefore = vi.mocked(endpoint.player.playVideo).mock.calls.length;
      const committed = endpoint.commit(authority);
      await vi.advanceTimersByTimeAsync(699);
      expect(endpoint.player.playVideo).toHaveBeenCalledTimes(playsBefore);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      await vi.advanceTimersByTimeAsync(250);
      await expect(committed).resolves.toBe(true);
      expect(endpoint.currentTime()).toBe(0);
      expect(getState('sync.youtubeLocalOffset')).toBe(-0.25);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(-0.25);
      endpoint.setTimelineLive(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(endpoint.currentTime()).toBeCloseTo(5, 3);
      expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(5.25, 3);
    },
  );

  it.each([-9.999, -3, -0.01, 0, 0.01, 0.25, 3, 9.999])(
    'keeps offset %ss at the next release and during calibration',
    async (offset) => {
      const endpoint = await createProEndpoint();
      await endpoint.applyManual(offset);
      const { authority, preparing } = endpoint.prepareNext();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(preparing).resolves.toMatchObject({ ready: true });
      const delayMs = Math.max(0, -offset * 1000);
      const committed = endpoint.commit(authority);
      await vi.advanceTimersByTimeAsync(699 + delayMs);
      await expect(committed).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(Math.max(0, offset), 3);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(offset, 3);
      const release = getProStartObservations().find((entry) => entry.kind === 'youtube-release');
      expect(release?.detail).toMatchObject({
        localStartDelayMs: delayMs,
        manualOffsetSeconds: offset,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(
        5 + delayMs / 1000,
        3,
      );
      expect(getState('sync.youtubeLocalOffset')).toBeCloseTo(offset, 3);
      const samples = getProStartObservations().filter((entry) => entry.kind === 'youtube-sample');
      expect(samples).toHaveLength(2);
      expect(samples[0].detail.elapsedSinceStartMs).toBe(800);
      expect(samples[0].detail.timelineDriftMs).toBeCloseTo(0, 6);
    },
  );

  it.each([0.1, 0.25, 0.5])(
    'rebases a late COMMIT at canonical %ss against the remaining negative offset',
    async (canonical) => {
      const endpoint = await createProEndpoint();
      await endpoint.applyManual(-0.25);
      const { authority, preparing } = endpoint.prepareNext();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(preparing).resolves.toMatchObject({ ready: true });
      const committed = endpoint.commit(authority, canonical, 0);
      const delayMs = Math.max(0, (0.25 - canonical) * 1000);
      await vi.advanceTimersByTimeAsync(delayMs);
      await expect(committed).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(Math.max(0, canonical - 0.25), 3);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(-0.25, 3);
      expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(
        Math.max(canonical, 0.25),
        3,
      );
    },
  );

  it('lets newer authority cancel a long negative-offset release without delayed playback', async () => {
    const endpoint = await createProEndpoint();
    await endpoint.applyManual(-9.999);
    const { authority, preparing } = endpoint.prepareNext();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(preparing).resolves.toMatchObject({ ready: true });
    const playsBefore = vi.mocked(endpoint.player.playVideo).mock.calls.length;
    const committed = endpoint.commit(authority);
    await vi.advanceTimersByTimeAsync(1_000);
    endpoint.cancel();
    await expect(committed).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(endpoint.player.playVideo).toHaveBeenCalledTimes(playsBefore);
    expect(endpoint.player.getPlayerState()).toBe(2);
  });

  it.each([0, 0.1, 0.25, 0.5])(
    'preserves a negative offset in a direct snapshot at canonical %ss',
    async (canonical) => {
      const endpoint = await createProEndpoint();
      await endpoint.applyManual(-0.25);
      const { preparing } = endpoint.prepareNext();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(preparing).resolves.toMatchObject({ ready: true });
      const playsBefore = vi.mocked(endpoint.player.playVideo).mock.calls.length;
      const committed = endpoint.commitDirect(canonical);
      const delayMs = Math.max(0, (0.25 - canonical) * 1_000);
      if (delayMs > 0) {
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect(endpoint.player.getPlayerState()).toBe(2);
        expect(endpoint.player.playVideo).toHaveBeenCalledTimes(playsBefore);
        await vi.advanceTimersByTimeAsync(1);
      }
      await expect(committed).resolves.toBe(true);
      expect(endpoint.currentTime()).toBeCloseTo(Math.max(0, canonical - 0.25), 3);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(-0.25, 3);
      expect(
        getProStartObservations().find((entry) => entry.kind === 'youtube-release')?.detail,
      ).toMatchObject({
        path: 'direct',
        timingMode: 'scheduled-control',
        playingAckAtMs: null,
        callToPlayingAckMs: null,
        canonicalStartSeconds: canonical,
        localStartDelayMs: delayMs,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const samples = getProStartObservations().filter((entry) => entry.kind === 'youtube-sample');
      expect(samples).toHaveLength(2);
      expect(samples[0].detail).toMatchObject({
        path: 'direct',
        elapsedSinceStartMs: 800,
        learningEnabled: false,
        learningDriftMs: null,
        eligible: true,
      });
      expect(samples[0].detail.timelineDriftMs).toBeCloseTo(0, 6);
    },
  );

  it('records cancelled observation checkpoints when a direct control supersedes the arm', async () => {
    const endpoint = await createProEndpoint();
    const { authority, preparing } = endpoint.prepareNext();
    await vi.advanceTimersByTimeAsync(1_000);
    await preparing;
    const first = endpoint.commit(authority);
    await vi.advanceTimersByTimeAsync(699);
    await expect(first).resolves.toBe(true);
    await expect(endpoint.commitDirect(10)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    const observations = getProStartObservations();
    expect(
      observations.filter((entry) => entry.detail.reason === 'cancelled-pending'),
    ).toHaveLength(2);
    const samples = observations.filter((entry) => entry.kind === 'youtube-sample');
    expect(samples).toHaveLength(2);
    expect(samples.every((entry) => entry.detail.path === 'direct')).toBe(true);
    expect(observations.filter((entry) => entry.kind === 'youtube-learning')).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ learningEnabled: false, updated: false }),
      }),
    ]);
  });

  it('observes a late direct release against its original future deadline without learning', async () => {
    const endpoint = await createProEndpoint();
    endpoint.setTimelineLive(false);
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce((callback, ms, ...args) =>
      schedule(callback, Number(ms) + 80, ...args),
    );
    const startedAtMs = performance.now();
    const committed = endpoint.commitDirect(10, 'playing', 700);
    await vi.advanceTimersByTimeAsync(780);
    await expect(committed).resolves.toBe(true);
    expect(endpoint.currentTime()).toBeCloseTo(10.08, 6);
    vi.mocked(endpoint.player.getCurrentTime).mockImplementation(
      () => endpoint.currentTime() - 0.1,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const observations = getProStartObservations();
    expect(observations.find((entry) => entry.kind === 'youtube-release')?.detail).toMatchObject({
      canonicalExecuteAtMs: startedAtMs + 700,
      playCallAtMs: startedAtMs + 780,
      playingAckAtMs: null,
      rawReleaseLatenessMs: 80,
      appliedReleaseLatenessMs: 80,
    });
    const samples = observations.filter((entry) => entry.kind === 'youtube-sample');
    expect(samples.map((entry) => entry.detail.elapsedSinceStartMs)).toEqual([800, 2000]);
    expect(samples[0].detail.timelineDriftMs).toBeCloseTo(-100, 6);
    expect(samples[0].detail.learningDriftMs).toBeNull();
    expect(observations.find((entry) => entry.kind === 'youtube-learning')?.detail).toMatchObject({
      learningEnabled: false,
      accepted: false,
      updated: false,
    });
  });

  it.each(['not-playing', 'invalid-position', 'identity-mismatch'] as const)(
    'retains an invalid direct observation: %s',
    async (reason) => {
      const endpoint = await createProEndpoint();
      endpoint.setTimelineLive(false);
      await endpoint.commitDirect(10);
      if (reason === 'not-playing') vi.mocked(endpoint.player.getPlayerState).mockReturnValue(3);
      if (reason === 'invalid-position')
        vi.mocked(endpoint.player.getCurrentTime).mockReturnValue(Number.NaN);
      if (reason === 'identity-mismatch') setState('sync.youtubeLocalOffset', 0.2);
      await vi.advanceTimersByTimeAsync(2_000);
      const samples = getProStartObservations().filter((entry) => entry.kind === 'youtube-sample');
      expect(samples).toHaveLength(2);
      expect(samples[0].detail).toMatchObject({
        path: 'direct',
        eligible: false,
        reason,
        learningEnabled: false,
      });
      if (reason === 'invalid-position') expect(samples[0].detail.rawPositionSeconds).toBeNull();
    },
  );

  it('retains missed direct checkpoints after a long local hold at their actual sample times', async () => {
    const endpoint = await createProEndpoint();
    await endpoint.applyManual(-3);
    endpoint.setTimelineLive(false);
    const committed = endpoint.commitDirect(0);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(committed).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const samples = getProStartObservations().filter((entry) => entry.kind === 'youtube-sample');
    expect(samples).toHaveLength(2);
    expect(samples.every((entry) => Number(entry.detail.elapsedSinceStartMs) >= 3_000)).toBe(true);
    expect(samples.every((entry) => Number(entry.detail.checkpointLatenessMs) > 0)).toBe(true);
    expect(samples[0].detail.timelineDriftMs).toBeCloseTo(0, 6);
  });

  it('cancels direct observation checkpoints when a newer pause arrives', async () => {
    const endpoint = await createProEndpoint();
    endpoint.setTimelineLive(false);
    await endpoint.commitDirect(10);
    await endpoint.commitDirect(10, 'paused');
    await vi.advanceTimersByTimeAsync(3_000);
    const observations = getProStartObservations();
    expect(
      observations.filter((entry) => entry.detail.reason === 'cancelled-pending'),
    ).toHaveLength(2);
    expect(observations.filter((entry) => entry.kind === 'youtube-sample')).toHaveLength(0);
  });

  it('supersedes a delayed direct snapshot with a pause without replaying later', async () => {
    const endpoint = await createProEndpoint();
    await endpoint.applyManual(-3);
    const { preparing } = endpoint.prepareNext();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(preparing).resolves.toMatchObject({ ready: true });
    const playsBefore = vi.mocked(endpoint.player.playVideo).mock.calls.length;
    const delayed = endpoint.commitDirect(0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(endpoint.commitDirect(0.1, 'paused')).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(delayed).resolves.toBe(false);
    expect(endpoint.player.getPlayerState()).toBe(2);
    expect(endpoint.player.playVideo).toHaveBeenCalledTimes(playsBefore);
    expect(getState('sync.youtubeLocalOffset')).toBe(-3);
  });

  it('never resumes a delayed direct snapshot after leaving its room', async () => {
    const endpoint = await createProEndpoint();
    await endpoint.applyManual(-3);
    const { preparing } = endpoint.prepareNext();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(preparing).resolves.toMatchObject({ ready: true });
    const playsBefore = vi.mocked(endpoint.player.playVideo).mock.calls.length;
    const delayed = endpoint.commitDirect(0);
    await vi.advanceTimersByTimeAsync(100);
    setState('room.context', { ...getState('room.context'), kind: 'standard' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(delayed).resolves.toBe(false);
    expect(endpoint.player.playVideo).toHaveBeenCalledTimes(playsBefore);
    expect(endpoint.player.getPlayerState()).toBe(2);
  });
});
