/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';

import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import type { ProRoomSnapshot } from '../../pro-room/contracts.ts';
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
  waitForFreshProRoomServerClockCalibration: vi.fn().mockResolvedValue(true),
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
  vi.clearAllMocks();
  resetState();
  bus.clear();
  vi.useFakeTimers();
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
      timingMode: 'zero-start',
      youtubeSubIndex: 0,
      youtubeVideoId: videoId,
      isCurrent: () => true,
    });
  };
  const commitDirect = (positionSeconds: number, playbackState: 'playing' | 'paused' = 'playing') =>
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
      scheduleDelayMs: 0,
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
      await vi.advanceTimersByTimeAsync(5_000);
      expect(toCanonicalYouTubeTime(endpoint.currentTime(), 180)).toBeCloseTo(
        5 + delayMs / 1000,
        3,
      );
      expect(getState('sync.youtubeLocalOffset')).toBeCloseTo(offset, 3);
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
    },
  );

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
