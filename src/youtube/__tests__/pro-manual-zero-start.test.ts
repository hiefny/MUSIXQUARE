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
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';

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
import { initYouTubeSync } from '../sync.ts';
import {
  prepareStandardHostManualOffsetRuntimeForTests,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';
import { toCanonicalYouTubeTime } from '../local-offset.ts';

let unregisterTimeline: (() => void) | null = null;
let nextRoomEpoch = 100;
afterEach(async () => {
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

describe('PRO manual offset across YouTube zero-start', () => {
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
