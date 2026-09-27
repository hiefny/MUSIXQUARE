/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import { makeFakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const QUEUE_ITEM_ID = '44444444-4444-4444-8444-444444444444';

function dataConnection(peer: string, send = vi.fn()): DataConnection {
  return {
    open: true,
    peer,
    send,
    close: vi.fn(),
    on: () => undefined,
  };
}

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
  getManagedTimer: vi.fn(() => null),
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

vi.mock('../standard-host-manual-offset-gate.ts', () => ({
  afterStandardHostManualOffsetTransaction: vi.fn(() => true),
  cancelStandardHostManualOffsetTransaction: vi.fn(() => false),
  isStandardHostManualOffsetTransactionPending: vi.fn(() => false),
  resetStandardHostManualOffsetTransaction: vi.fn(),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../../ui/dom.ts', () => ({
  animateTransition: vi.fn((fn: () => unknown) => fn()),
  syncOverlayState: vi.fn(),
  normalizeEmptyContentEditable: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  bus.clear();
  vi.useFakeTimers();

  const container = document.createElement('div');
  container.id = 'youtube-container';
  document.body.appendChild(container);

  const playerDiv = document.createElement('div');
  playerDiv.id = 'youtube-player';
  container.appendChild(playerDiv);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

vi.mock('../../network/room-control.ts', () => ({
  initRoomControl: vi.fn(),
  resolveRoomControlKickTarget: vi.fn(),
}));
vi.mock('../../network/heartbeat-monitor.ts', () => ({
  initHeartbeatMonitor: vi.fn(),
  recordPeerHeartbeat: vi.fn(),
}));

describe('external zero-start recovery owns ordinary synchronization', () => {
  async function installDelayedFallback(offset: number, unmuteDelayMs: number) {
    const stateMod = await import('../_state.ts');
    const playerMod = await import('../player.ts');
    const controller = await import('../zero-start.ts');
    const timers = await import('../../core/timers.ts');
    const realTimers =
      await vi.importActual<typeof import('../../core/timers.ts')>('../../core/timers.ts');
    const clock = await import('../../network/shared-clock.ts');
    vi.mocked(timers.setManagedTimer).mockImplementation(realTimers.setManagedTimer);
    vi.mocked(timers.clearManagedTimer).mockImplementation(realTimers.clearManagedTimer);
    vi.mocked(timers.getManagedTimer).mockImplementation(realTimers.getManagedTimer);
    vi.setSystemTime(new Date('2026-09-26T23:59:57.700Z'));
    (window as unknown as { YT: unknown }).YT = {
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    };

    const hostPeerId = 'delayed-fallback-host';
    const guestPeerId = 'delayed-fallback-guest';
    const videoId = 'M7lc1UVf-VE';
    setState('network.appRole', 'guest');
    setState('network.myId', guestPeerId);
    setState('network.hostConn', dataConnection(hostPeerId));
    setState('sync.youtubeLocalOffset', offset);
    setState('youtube.guestPlayLatency', 0);
    setState('audio.masterVolume', 1);
    setState('playlist.items', [
      {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        videoId,
        playlistId: null,
        name: 'Delayed fallback',
      },
    ]);
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setPlaybackYouTubePlaying();
    stateMod.setYouTubePlayer(null);
    stateMod.setYtPrimed(true);
    clock.resetClockState();
    clock.registerPing(82);
    expect(clock.processSyncPong(82, Date.now())).not.toBeNull();
    playerMod.initYouTube();

    const prepareAtHost = Date.now();
    const run = {
      version: 1 as const,
      runId: 'delayed-external-audio-restore',
      sequence: 1,
      queueItemId: QUEUE_ITEM_ID,
      videoId,
    };
    expect(
      controller.handleYouTubeZeroStartPrepare(hostPeerId, {
        ...run,
        type: MSG.YOUTUBE_ZERO_START_PREPARE,
        subIndex: null,
        prepareAtHost,
        decisionAtHost: prepareAtHost + 2_300,
        startDeadlineAtHost: prepareAtHost + 3_000,
        hostPlatform: 'other',
      }),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(2300);
    expect(
      controller.handleYouTubeZeroStartCommit(hostPeerId, {
        ...run,
        type: MSG.YOUTUBE_ZERO_START_COMMIT,
        startAtHost: prepareAtHost + 3_000,
        reason: 'guest-timeout',
        cohort: [hostPeerId],
      }),
    ).toBe(true);

    const player = makeFakeYtPlayer({
      __videoId: videoId,
      __state: 2,
      __currentTime: 0,
      __muted: true,
      __advanceClock: true,
    });
    const immediateUnmute = player.unMute;
    let unmutePending = false;
    player.unMute = () => {
      if (unmuteDelayMs === 0) {
        immediateUnmute();
        return;
      }
      if (unmutePending || !player.isMuted()) return;
      unmutePending = true;
      setTimeout(() => {
        unmutePending = false;
        immediateUnmute();
      }, unmuteDelayMs);
    };
    stateMod.setYouTubePlayer(player as unknown as YouTubePlayerInstance);
    expect(stateMod.markYtPlayerReady(player as unknown as YouTubePlayerInstance)).toBe(true);

    return {
      player,
      playerMod,
      releaseAfterMs: 700 - offset * 1_000,
      cleanup: () => {
        playerMod.stopYouTubeMode();
        controller.resetYouTubeZeroStart();
        realTimers.clearAllManagedTimers();
        vi.mocked(timers.setManagedTimer).mockReset();
        vi.mocked(timers.clearManagedTimer).mockReset();
        vi.mocked(timers.getManagedTimer).mockReset().mockReturnValue(null);
        stateMod.setYouTubePlayer(null);
        stateMod.setYtPrimed(false);
        clock.resetClockState();
      },
    };
  }

  async function realHandlers() {
    const sync = await import('../sync.ts');
    const network = await import('../../network/sync.ts');
    const { registerHandlers } = await import('../../network/protocol.ts');
    sync.initYouTubeSync();
    network.initSync();
    const handlers = Object.assign(
      {},
      ...vi.mocked(registerHandlers).mock.calls.map(([map]) => map),
    ) as Record<string, (data: Record<string, unknown>, conn: DataConnection) => void>;
    return { sync, handlers };
  }
  function heartbeat(handlers: Awaited<ReturnType<typeof realHandlers>>['handlers'], time: number) {
    handlers[MSG.YOUTUBE_SYNC]!(
      { queueItemId: QUEUE_ITEM_ID, videoId: 'M7lc1UVf-VE', time, hostClock: Date.now(), state: 1 },
      getState('network.hostConn')!,
    );
  }
  function delayPlayingAcknowledgement(player: ReturnType<typeof makeFakeYtPlayer>) {
    const play = player.playVideo;
    const pause = player.pauseVideo;
    let generation = 0;
    const requestPlay = vi.fn(() => {
      const requestedGeneration = ++generation;
      setTimeout(() => {
        if (generation === requestedGeneration) play();
      }, 100);
    });
    player.playVideo = requestPlay;
    player.pauseVideo = () => {
      generation += 1;
      pause();
    };
    return requestPlay;
  }
  it.each([-0.25, -1, -9.999])(
    'keeps offset %s and the original release when manual actions arrive during recovery',
    async (offset) => {
      const test = await installDelayedFallback(offset, 0);
      const { sync, handlers } = await realHandlers();
      const { isYouTubeZeroStartSyncOwned } = await import('../zero-start-ownership.ts');
      try {
        const now = Math.max(750, test.releaseAfterMs - 999);
        await vi.advanceTimersByTimeAsync(now);
        heartbeat(handlers, (now - 700) / 1000);
        expect(isYouTubeZeroStartSyncOwned()).toBe(true);
        expect(sync.isGuestYouTubeTransitionPending()).toBe(true);
        const before = test.player.__log.length;
        expect(sync.guestRendezvousSync({ silent: true }).status).toBe('not-ready');
        bus.emit('sync:nudge', 10);
        bus.emit('sync:set-manual-offset', 1234);
        bus.emit('sync:auto-sync');
        // A stale/debounced apply callback cannot bypass the input boundary either.
        bus.emit('youtube:apply-manual-sync');
        expect(getState('sync.youtubeLocalOffset')).toBe(offset);
        expect(test.player.__log).toHaveLength(before);
        await vi.advanceTimersByTimeAsync(test.releaseAfterMs - now + 100);
        expect(test.player.getPlayerState()).toBe(1);
        expect(test.player.isMuted()).toBe(false);
        expect(test.player.getCurrentTime()).toBeCloseTo(0.1, 3);
        expect(isYouTubeZeroStartSyncOwned()).toBe(false);
        expect(getState('youtube.guestPlayLatency')).toBe(0);
        heartbeat(handlers, 20);
        expect(sync.guestRendezvousSync({ silent: true }).status).toBe('started');
      } finally {
        sync.resetYouTubeSyncState();
        test.cleanup();
      }
    },
  );
  it('keeps synchronization fenced until the released iframe acknowledges PLAYING', async () => {
    const ownership = await import('../zero-start-ownership.ts');
    const pendingChanges: boolean[] = [];
    bus.on('youtube:zero-start-readiness-changed', () =>
      pendingChanges.push(ownership.isYouTubeZeroStartSyncOwned()),
    );
    const test = await installDelayedFallback(-9.999, 0);
    const { sync, handlers } = await realHandlers();
    const requestPlay = delayPlayingAcknowledgement(test.player);
    try {
      await vi.advanceTimersByTimeAsync(test.releaseAfterMs + 1);
      const before = test.player.__log.length;
      expect(requestPlay).toHaveBeenCalledTimes(1);
      heartbeat(handlers, 10);
      expect(test.playerMod.isYouTubeZeroStartExternalFallbackActive()).toBe(false);
      expect(ownership.isYouTubeZeroStartSyncOwned()).toBe(true);
      expect(sync.guestRendezvousSync({ silent: true }).status).toBe('not-ready');
      bus.emit('sync:nudge', 10);
      bus.emit('sync:set-manual-offset', 1234);
      bus.emit('sync:auto-sync');
      bus.emit('youtube:apply-manual-sync');
      expect(getState('sync.youtubeLocalOffset')).toBe(-9.999);
      expect(test.player.__log).toHaveLength(before);
      expect(requestPlay).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(test.player.getPlayerState()).toBe(1);
      expect(ownership.isYouTubeZeroStartSyncOwned()).toBe(false);
      expect(pendingChanges.at(-1)).toBe(false);
      expect(pendingChanges).toContain(true);
    } finally {
      sync.resetYouTubeSyncState();
      test.cleanup();
    }
  });
  it.each([
    { state: 1, phase: 'held' },
    { state: 2, phase: 'held' },
    { state: 1, phase: 'awaiting-ack' },
    { state: 2, phase: 'awaiting-ack' },
  ])(
    'lets authoritative state $state supersede recovery while $phase',
    async ({ state, phase }) => {
      const test = await installDelayedFallback(-9.999, 0);
      const { sync, handlers } = await realHandlers();
      const { isYouTubeZeroStartSyncOwned } = await import('../zero-start-ownership.ts');
      delayPlayingAcknowledgement(test.player);
      try {
        await vi.advanceTimersByTimeAsync(phase === 'held' ? 6000 : test.releaseAfterMs + 1);
        expect(isYouTubeZeroStartSyncOwned()).toBe(true);
        handlers[MSG.YOUTUBE_STATE]!(
          {
            queueItemId: QUEUE_ITEM_ID,
            videoId: 'M7lc1UVf-VE',
            time: 30,
            hostClock: Date.now(),
            state,
            ...(state === 1 ? { hostPlayAt: 0 } : {}),
          },
          getState('network.hostConn')!,
        );
        expect(isYouTubeZeroStartSyncOwned()).toBe(false);
        await vi.advanceTimersByTimeAsync(500);
        expect(test.player.getPlayerState()).toBe(state);
        const before = test.player.__log.length;
        await vi.advanceTimersByTimeAsync(6000);
        expect(test.player.__log).toHaveLength(before);
      } finally {
        sync.resetYouTubeSyncState();
        test.cleanup();
      }
    },
  );
  it('retires the previous integration before publishing readiness and reinitializing', async () => {
    const test = await installDelayedFallback(-9.999, 0);
    const ownership = await import('../zero-start-ownership.ts');
    delayPlayingAcknowledgement(test.player);
    try {
      await vi.advanceTimersByTimeAsync(test.releaseAfterMs + 1);
      expect(ownership.isYouTubeZeroStartSyncOwned()).toBe(true);
      const cleanupObservations: {
        owned: boolean;
        state: number;
        time: number;
        muted: boolean;
      }[] = [];
      const off = bus.on('youtube:zero-start-readiness-changed', () => {
        cleanupObservations.push({
          owned: ownership.isYouTubeZeroStartSyncOwned(),
          state: test.player.getPlayerState(),
          time: test.player.getCurrentTime(),
          muted: test.player.isMuted(),
        });
      });
      test.playerMod.initYouTube();
      expect(ownership.isYouTubeZeroStartSyncOwned()).toBe(false);
      await Promise.resolve();
      const released = cleanupObservations.filter(({ owned }) => !owned);
      expect(released.length).toBeGreaterThan(0);
      for (const observation of released) {
        expect(observation).toEqual({ owned: false, state: 2, time: 0, muted: false });
      }
      const before = test.player.__log.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(test.player.__log).toHaveLength(before);
      expect(test.player.getPlayerState()).toBe(2);
      off();
    } finally {
      test.cleanup();
    }
  });
});
