/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection, PlaylistItem, TrackMeta } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import { registerProRoomMediaHooks, type ProRoomMediaHooks } from '../../pro-room/media-hooks.ts';
import {
  createProPlaybackAuthorityToken,
  getProPlaybackAuthorityKey,
  registerProPlaybackCommandHandler,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';

const QUEUE_ITEM_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_QUEUE_ITEM_ID = '55555555-5555-4555-8555-555555555555';

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
  resolveYouTubePlaylistEntry: vi.fn(async (playlistId: string) => ({
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

vi.mock('../sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
  cancelGuestRendezvous: vi.fn(),
  guestRendezvousSync: vi.fn(() => ({ status: 'not-ready' })),
  resetAdDetection: vi.fn(),
  initYouTubeSync: vi.fn(),
  resetYouTubeSyncState: vi.fn(),
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

function proMediaHooks(overrides: Partial<ProRoomMediaHooks> = {}): ProRoomMediaHooks {
  return {
    addFiles: () => false,
    addYouTube: () => false,
    updateTrackMetadata: () => false,
    removeTracks: () => false,
    reorderTrack: () => false,
    resolveFile: () => null,
    ...overrides,
  };
}

describe('YouTube Player', () => {
  describe('getYouTubePlayer()', () => {
    it('returns null initially', async () => {
      const { getYouTubePlayer } = await import('../player.ts');
      expect(getYouTubePlayer()).toBeNull();
    });
  });

  describe('player runtime bridge', () => {
    it('wires iframe-facing rendezvous hooks to the public player ownership API', async () => {
      const bridge = await import('../player-runtime-bridge.ts');
      const playerRuntime = await import('../player.ts');
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      playerRuntime.setPendingAutoSyncOnReady(false);

      bridge.setPendingAutoSyncOnReadyFromIframe(true, {
        isTrackTransition: true,
        targetTime: 12,
      });
      expect(playerRuntime.consumePendingAutoSyncOnReady()).toMatchObject({
        isTrackTransition: true,
        targetTime: 12,
      });

      playerRuntime.setPendingAutoSyncOnReady(true, { targetTime: 34 });
      expect(bridge.consumePendingAutoSyncOnReadyFromIframe()).toMatchObject({ targetTime: 34 });
      expect(bridge.isYouTubeZeroStartExternalFallbackActiveFromIframe()).toBe(
        playerRuntime.isYouTubeZeroStartExternalFallbackActive(),
      );
      playerRuntime.setPendingAutoSyncOnReady(false);
    });
  });

  describe('zero-start runtime capability', () => {
    it('upgrades the first guest advertisement only after player and clock readiness converge', async () => {
      const stateMod = await import('../_state.ts');
      const { initYouTube } = await import('../player.ts');
      const { safeSend } = await import('../../network/peer.ts');
      const { registerPing, processSyncPong, resetClockState } =
        await import('../../network/shared-clock.ts');
      const safeSendMock = vi.mocked(safeSend);
      safeSendMock.mockReturnValue(true);
      resetClockState();
      initYouTube();
      setState('network.appRole', 'guest');
      setState('network.myId', 'guest-runtime-ready');
      setState('network.isConnecting', true);
      const hostConnection = {
        peer: 'host-runtime-ready',
        open: true,
      } as DataConnection;
      setState('network.hostConn', hostConnection);

      bus.emit('youtube:player-ready');
      bus.emit('youtube:zero-start-readiness-changed');
      bus.emit('sync:latency-update', 0);
      expect(safeSendMock).not.toHaveBeenCalled();

      setState('network.isConnecting', false);
      bus.emit('network:peer-connected', hostConnection);
      expect(safeSendMock).toHaveBeenCalledOnce();
      expect(safeSendMock).toHaveBeenCalledWith(
        hostConnection,
        expect.objectContaining({
          type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
          version: 2,
          ready: false,
        }),
      );
      safeSendMock.mockClear();

      let muted = false;
      let volume = 100;
      const player = {
        loadVideoById: vi.fn(),
        loadPlaylist: vi.fn(),
        cuePlaylist: vi.fn(),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        stopVideo: vi.fn(),
        destroy: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getPlaylistIndex: vi.fn(() => 0),
        getVideoData: vi.fn(() => ({ video_id: 'M7lc1UVf-VE' })),
        getPlaylist: vi.fn(() => []),
        setVolume: vi.fn((next: number) => {
          volume = next;
        }),
        getVolume: vi.fn(() => volume),
        mute: vi.fn(() => {
          muted = true;
        }),
        unMute: vi.fn(() => {
          muted = false;
        }),
        isMuted: vi.fn(() => muted),
        getVideoLoadedFraction: vi.fn(() => 1),
      };
      stateMod.setYouTubePlayer(player);
      // The facade exists synchronously, but the iframe runtime is not usable
      // until its exact instance has delivered onReady.
      bus.emit('youtube:player-ready');
      expect(safeSendMock).not.toHaveBeenCalled();
      expect(stateMod.markYtPlayerReady(player)).toBe(true);
      bus.emit('youtube:player-ready');
      expect(safeSendMock).not.toHaveBeenCalled();

      registerPing(1);
      expect(processSyncPong(1, Date.now())).not.toBeNull();
      bus.emit('sync:latency-update', 0);

      expect(safeSendMock).toHaveBeenCalledOnce();
      expect(safeSendMock).toHaveBeenCalledWith(
        hostConnection,
        expect.objectContaining({
          type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
          version: 2,
          platform: 'other',
          ready: true,
        }),
      );
      resetClockState();
    });
  });

  describe('local media-session desired state', () => {
    it('pauses idempotently and resumes only through the common rejoin seam', async () => {
      const yt = {
        PlayerState: {
          PLAYING: 1,
          PAUSED: 2,
        },
      };
      (window as unknown as { YT: unknown }).YT = yt;
      (globalThis as unknown as { YT: unknown }).YT = yt;

      const player = {
        getPlayerState: vi.fn(() => 1),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
      };
      const stateMod = await import('../_state.ts');
      const { initYouTube } = await import('../player.ts');
      const rejoin = vi.fn();
      bus.on('playback:local-output-rejoin', rejoin);

      stateMod.setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      stateMod.setLocalYouTubePaused(false);
      initYouTube();

      bus.emit('youtube:set-local-paused', true);

      expect(stateMod.isLocalYouTubePaused()).toBe(true);
      expect(player.pauseVideo).toHaveBeenCalledTimes(1);

      bus.emit('youtube:set-local-paused', false, 'media-session-play');

      expect(rejoin).toHaveBeenCalledWith({
        reason: 'media-session-play',
        mode: 'youtube',
      });
      expect(player.playVideo).not.toHaveBeenCalled();
    });

    it('records PAUSE and cancels rendezvous even while the iframe is loading', async () => {
      const yt = { PlayerState: { PLAYING: 1, PAUSED: 2 } };
      (window as unknown as { YT: unknown }).YT = yt;
      (globalThis as unknown as { YT: unknown }).YT = yt;
      const player = {
        getPlayerState: vi.fn(() => 1),
        pauseVideo: vi.fn(),
      };
      const stateMod = await import('../_state.ts');
      const syncMod = await import('../sync.ts');
      const { getPendingAutoSyncOnReadyForTests, initYouTube, setPendingAutoSyncOnReady } =
        await import('../player.ts');
      stateMod.setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      stateMod.setYtLoadInProgress(true);
      initYouTube();
      setPendingAutoSyncOnReady(true, { isTrackTransition: true });

      bus.emit('youtube:set-local-paused', true);

      expect(stateMod.isLocalYouTubePaused()).toBe(true);
      expect(getPendingAutoSyncOnReadyForTests()).toBe(false);
      expect(vi.mocked(syncMod.cancelGuestRendezvous)).toHaveBeenCalledOnce();
      expect(player.pauseVideo).toHaveBeenCalledOnce();
      stateMod.setYtLoadInProgress(false);
    });
  });

  describe('YouTube volume bridge', () => {
    it('maps zero volume to iframe hard mute and restores it for non-zero volume', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const player = {
        setVolume: vi.fn(),
        mute: vi.fn(),
        unMute: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(player);
      initYouTube();

      bus.emit('youtube:set-volume', 0);

      expect(player.setVolume).toHaveBeenLastCalledWith(0);
      expect(player.mute).toHaveBeenCalledOnce();
      expect(player.unMute).not.toHaveBeenCalled();

      bus.emit('youtube:set-volume', 63.4);

      expect(player.setVolume).toHaveBeenLastCalledWith(63);
      expect(player.unMute).toHaveBeenCalledOnce();
    });

    it('keeps PRO authority warm-up muted while adopting an in-flight volume change', async () => {
      const { initYouTube } = await import('../player.ts');
      const { markYtPlayerReady, setYouTubePlayer, setYouTubeSubIndex, setYtLoadInProgress } =
        await import('../_state.ts');
      const { cancelYouTubeAuthorityPreparation, prepareYouTubeAuthorityOccurrence } =
        await import('../iframe.ts');
      let muted = false;
      let volume = 31;
      let playerState = 2;
      let currentTime = 3;
      const player = {
        loadVideoById: vi.fn(),
        playVideo: vi.fn(() => {
          playerState = 1;
        }),
        pauseVideo: vi.fn(() => {
          playerState = 2;
        }),
        seekTo: vi.fn((seconds: number) => {
          currentTime = seconds;
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
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => playerState),
        getVideoData: vi.fn(() => ({ video_id: 'video-1', title: 'Video' })),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(player);
      markYtPlayerReady(player);
      setYouTubeSubIndex(0);
      setYtLoadInProgress(false);
      setPlaybackYouTubePlaying();
      setState('audio.masterVolume', 0.31);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'video-1',
          playlistId: null,
          name: 'Video',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      initYouTube();

      const preparing = prepareYouTubeAuthorityOccurrence({
        authorityKey: 'transition-volume-change',
        queueItemId: QUEUE_ITEM_ID,
        videoId: 'video-1',
        subIndex: 0,
        positionSeconds: 3,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(muted).toBe(true);

      bus.emit('youtube:set-volume', 73);

      expect(player.setVolume).toHaveBeenLastCalledWith(73);
      expect(player.unMute).not.toHaveBeenCalled();
      expect(muted).toBe(true);

      await vi.runAllTimersAsync();
      await expect(preparing).resolves.toMatchObject({ ready: true });
      expect(player.unMute).toHaveBeenCalledOnce();
      expect(muted).toBe(false);
      expect(volume).toBe(73);
      cancelYouTubeAuthorityPreparation();
    });

    it('keeps a participant-local PRO pause gate closed across volume changes', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const player = {
        setVolume: vi.fn(),
        mute: vi.fn(),
        unMute: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(player);
      setState('audio.masterVolume', 0.8);
      initYouTube();

      bus.emit('pro-playback:ui-control-pending', {
        token: 91,
        kind: 'pause',
        queueItemId: QUEUE_ITEM_ID,
        targetSeconds: 12,
        wasPlaying: true,
      });
      bus.emit('youtube:set-volume', 80);

      expect(player.mute).toHaveBeenCalledTimes(2);
      expect(player.unMute).not.toHaveBeenCalled();

      bus.emit('pro-playback:ui-control-settled', {
        token: 90,
        kind: 'pause',
        queueItemId: QUEUE_ITEM_ID,
        status: 'superseded',
      });
      expect(player.unMute).not.toHaveBeenCalled();

      bus.emit('pro-playback:ui-control-settled', {
        token: 91,
        kind: 'pause',
        queueItemId: QUEUE_ITEM_ID,
        status: 'applied',
        positionSeconds: 12.7,
      });
      expect(player.setVolume).toHaveBeenLastCalledWith(80);
      expect(player.unMute).toHaveBeenCalledOnce();
    });
  });

  describe('synchronized pause ownership', () => {
    it('cancels an older delayed PLAY rendezvous before broadcasting PAUSE', async () => {
      const stateMod = await import('../_state.ts');
      const timers = await import('../../core/timers.ts');
      const { scheduleYtAutoSync } = await import('../player.ts');
      const player = {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        getDuration: vi.fn(() => 300),
        getVideoData: vi.fn(() => ({ video_id: 'VIDEO_ID_01', title: 'Video' })),
      };
      stateMod.setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

      scheduleYtAutoSync(12, { state: 1 });
      vi.mocked(timers.clearManagedTimer).mockClear();
      scheduleYtAutoSync(12, { state: 2 });

      expect(timers.clearManagedTimer).toHaveBeenCalledWith('yt-auto-sync');
      expect(player.pauseVideo).toHaveBeenCalledOnce();
    });
  });

  describe('PRO participant canonical controls', () => {
    it('learns a stable local start residual for the next PRO zero-start only', async () => {
      const stateMod = await import('../_state.ts');
      const { applyProPlaybackYouTubeCommit } = await import('../player.ts');
      const { cancelYouTubeAuthorityPreparation, prepareYouTubeAuthorityOccurrence } =
        await import('../iframe.ts');
      let muted = false;
      let volume = 60;
      let playerState = 2;
      let baseTime = 0;
      let playAtMs = 0;
      const playCallsMs: number[] = [];
      const currentTime = () =>
        playerState === 1
          ? baseTime + Math.max(0, performance.now() - playAtMs - 100) / 1_000
          : baseTime;
      const player = {
        loadVideoById: vi.fn(),
        playVideo: vi.fn(() => {
          playAtMs = performance.now();
          playCallsMs.push(playAtMs);
          playerState = 1;
        }),
        pauseVideo: vi.fn(() => {
          baseTime = currentTime();
          playerState = 2;
        }),
        seekTo: vi.fn((seconds: number) => {
          baseTime = seconds;
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
        getCurrentTime: vi.fn(() => currentTime()),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => playerState),
        getVideoData: vi.fn(() => ({ video_id: 'video-1', title: 'Video' })),
      } as unknown as YouTubePlayerInstance;

      stateMod.setYouTubePlayer(player);
      stateMod.markYtPlayerReady(player);
      stateMod.setYouTubeSubIndex(0);
      stateMod.setYtLoadInProgress(false);
      setState('audio.masterVolume', 0.6);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'video-1',
          playlistId: null,
          name: 'Video',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 7,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      setPlaybackYouTubePlaying();

      const run = async (basePlaybackRevision: number) => {
        const authority = createProPlaybackAuthorityToken({
          roomId: '000001',
          roomEpoch: 7,
          basePlaybackRevision,
          transitionId: `transition-${basePlaybackRevision}`,
        });
        const preparing = prepareYouTubeAuthorityOccurrence({
          authorityKey: getProPlaybackAuthorityKey(authority),
          queueItemId: QUEUE_ITEM_ID,
          videoId: 'video-1',
          subIndex: 0,
          positionSeconds: 0,
        });
        await vi.runAllTimersAsync();
        await expect(preparing).resolves.toMatchObject({ ready: true });

        const startedAtMs = performance.now();
        const applying = applyProPlaybackYouTubeCommit({
          authority,
          committedPlaybackRevision: basePlaybackRevision + 1,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
          positionSeconds: 0,
          scheduleDelayMs: 700,
          timingMode: 'zero-start',
          youtubeSubIndex: 0,
          youtubeVideoId: 'video-1',
          isCurrent: () => true,
        });
        return { applying, startedAtMs };
      };

      const first = await run(1);
      await vi.advanceTimersByTimeAsync(700);
      await expect(first.applying).resolves.toBe(true);
      expect(playCallsMs.at(-1)! - first.startedAtMs).toBe(700);

      // The first endpoint is stably 100ms late at both checkpoints. A 0.25
      // learning rate therefore advances only the next release by 25ms.
      await vi.advanceTimersByTimeAsync(2_000);

      const second = await run(3);
      const callsBeforeRelease = playCallsMs.length;
      await vi.advanceTimersByTimeAsync(674);
      expect(playCallsMs).toHaveLength(callsBeforeRelease);
      await vi.advanceTimersByTimeAsync(1);
      await expect(second.applying).resolves.toBe(true);
      expect(playCallsMs.at(-1)! - second.startedAtMs).toBe(675);
      cancelYouTubeAuthorityPreparation();
    });

    it('keeps displayed position and paused seek messages on room time', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const { broadcast } = await import('../../network/peer.ts');
      const player = {
        getCurrentTime: vi.fn(() => 10.25),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'video-1', title: 'Video' })),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(player);
      setPlaybackYouTubePlaying();
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'video-1',
          playlistId: null,
          name: 'Video',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('sync.youtubeLocalOffset', 0.25);
      setState('sync.youtubeCoordinatorAppliedOffset', 0.25);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      initYouTube();

      let position = -1;
      bus.emit('youtube:get-position', (value) => {
        position = value;
      });
      expect(position).toBe(10);

      bus.emit('youtube:seek-to', 20);

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.YOUTUBE_STATE, state: 2, time: 20 }),
      );
      expect(player.seekTo).toHaveBeenCalledWith(20.25, true);
    });

    it('freezes the local anchor but never falls back to a peer broadcast while PRO is wiring', async () => {
      const yt = { PlayerState: { PLAYING: 1, PAUSED: 2 } };
      (window as unknown as { YT: unknown }).YT = yt;
      (globalThis as unknown as { YT: unknown }).YT = yt;
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const { broadcast } = await import('../../network/peer.ts');
      const { getManagedTimer } = await import('../../core/timers.ts');
      const { beginProCoordinatorYouTubeNudge, toCanonicalYouTubeTime } =
        await import('../local-offset.ts');
      let playerState = 3;
      const player = {
        getCurrentTime: vi.fn(() => 10.25),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => playerState),
        getVideoData: vi.fn(() => ({ video_id: 'video-1', title: 'Video' })),
        pauseVideo: vi.fn(() => {
          playerState = 2;
        }),
        playVideo: vi.fn(),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(player);
      setPlaybackYouTubePlaying();
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'video-1',
          playlistId: null,
          name: 'Video',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('sync.youtubeLocalOffset', 0.25);
      setState('sync.youtubeCoordinatorAppliedOffset', 0.25);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      beginProCoordinatorYouTubeNudge(10.25, 120, true);
      vi.mocked(getManagedTimer).mockImplementation((name) =>
        name === 'yt-pro-coordinator-local-nudge'
          ? ({} as ReturnType<typeof getManagedTimer>)
          : null,
      );
      initYouTube();

      vi.advanceTimersByTime(1000);
      bus.emit('youtube:toggle-play');
      expect(broadcast).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(toCanonicalYouTubeTime(10.25, 120)).toBe(12);
      vi.mocked(getManagedTimer).mockReturnValue(null);
    });

    it('routes a native playlist advance to the PRO server without local traversal', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const { broadcast } = await import('../../network/peer.ts');
      const commandHandler = vi.fn();
      registerProPlaybackCommandHandler(commandHandler);
      const player = {
        getCurrentTime: vi.fn(() => 0.2),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 3),
        getPlaylistIndex: vi.fn(() => 1),
        getPlaylist: vi.fn(() => ['video-1', 'video-2']),
        getVideoData: vi.fn(() => ({ video_id: 'video-2', title: 'Video 2' })),
        loadVideoById: vi.fn(),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(player);
      setPlaybackYouTubePlaying();
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'video-1',
          playlistId: 'playlist-1',
          name: 'Playlist',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('sync.youtubeLocalOffset', -3);
      setState('sync.youtubeCoordinatorAppliedOffset', -3);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      initYouTube();

      bus.emit('youtube:sub-video-advanced');
      await Promise.resolve();

      expect(commandHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'advance-sub-video',
          roomId: '000001',
          roomEpoch: 1,
          queueItemId: QUEUE_ITEM_ID,
        }),
      );
      expect(player.loadVideoById).not.toHaveBeenCalled();
      expect(player.seekTo).not.toHaveBeenCalled();
      expect(player.playVideo).not.toHaveBeenCalled();
      expect(getState('sync.youtubeLocalOffset')).toBe(-3);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(-3);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('routes the 0.8s playlist pre-empt event to the same PRO server command', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const commandHandler = vi.fn();
      registerProPlaybackCommandHandler(commandHandler);
      const player = {
        getCurrentTime: vi.fn(() => 119.4),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        getPlaylistIndex: vi.fn(() => 0),
        getPlaylist: vi.fn(() => ['video-1', 'video-2']),
        getVideoData: vi.fn(() => ({ video_id: 'video-1', title: 'Video 1' })),
        loadVideoById: vi.fn(),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(player);
      setPlaybackYouTubePlaying();
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'video-1',
          playlistId: 'playlist-1',
          name: 'Playlist',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      initYouTube();
      const callback = vi.fn();

      bus.emit('youtube:try-next-internal', callback);
      await Promise.resolve();

      expect(callback).toHaveBeenCalledWith(true);
      expect(commandHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'advance-sub-video',
          roomId: '000001',
          roomEpoch: 1,
          queueItemId: QUEUE_ITEM_ID,
        }),
      );
      expect(player.loadVideoById).not.toHaveBeenCalled();
    });

    it('keeps ordinary-room internal playlist traversal local', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer, setYouTubeSubIndex } = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 119.4),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        getPlaylistIndex: vi.fn(() => 0),
        getPlaylist: vi.fn(() => ['video-1', 'video-2']),
        getVideoData: vi.fn(() => ({ video_id: 'video-1', title: 'Video 1' })),
        loadVideoById: vi.fn(),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(player);
      setYouTubeSubIndex(0);
      setPlaybackYouTubePlaying();
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'video-1',
          playlistId: 'playlist-1',
          name: 'Playlist',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('room.context', {
        kind: 'standard',
        roomId: '123456',
        role: 'coordinator',
        coordinatorId: null,
        epoch: 0,
        snapshotRevision: 0,
        capabilities: [],
      });
      initYouTube();
      const callback = vi.fn();

      bus.emit('youtube:try-next-internal', callback);

      expect(callback).toHaveBeenCalledWith(true);
      expect(player.loadVideoById).toHaveBeenCalledWith('video-2');
    });
  });

  describe('stopYouTubeMode()', () => {
    it('does not throw when no player exists', async () => {
      const { stopYouTubeMode } = await import('../player.ts');
      expect(() => stopYouTubeMode()).not.toThrow();
    });

    it('transfers an active guest fallback without running its stale unmute cleanup', async () => {
      const stateMod = await import('../_state.ts');
      const { initYouTube, isYouTubeZeroStartExternalFallbackActive, stopYouTubeMode } =
        await import('../player.ts');
      const {
        getYouTubeZeroStartSnapshot,
        handleYouTubeZeroStartCommit,
        handleYouTubeZeroStartPlayerState,
        handleYouTubeZeroStartPrepare,
      } = await import('../zero-start.ts');
      const { makeFakeYtPlayer } = await import('./__helpers__/fake-yt-player.ts');
      const { setManagedTimer } = await import('../../core/timers.ts');
      const { safeSend } = await import('../../network/peer.ts');
      const { processSyncPong, registerPing, resetClockState } =
        await import('../../network/shared-clock.ts');

      const hostPeerId = 'host-external-fallback';
      const guestPeerId = 'guest-external-fallback';
      const videoId = 'M7lc1UVf-VE';
      const hostConnection = dataConnection(hostPeerId);
      const player = makeFakeYtPlayer({
        __videoId: videoId,
        __state: 2,
        __autoPlayOnLoad: true,
        __muted: false,
        __volume: 63,
      });

      vi.mocked(safeSend).mockReturnValue(true);
      setState('network.appRole', 'guest');
      setState('network.myId', guestPeerId);
      setState('network.hostConn', hostConnection);
      setState('network.isConnecting', false);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId,
          name: 'External fallback target',
        } as PlaylistItem,
      ]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setPlaybackYouTubePlaying();
      stateMod.setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      expect(stateMod.markYtPlayerReady(player as unknown as YouTubePlayerInstance)).toBe(true);
      stateMod.setYtPrimed(true);

      resetClockState();
      registerPing(41);
      expect(processSyncPong(41, Date.now())).not.toBeNull();
      initYouTube();
      player.__onStateChange = ({ data }) => {
        handleYouTubeZeroStartPlayerState(data);
      };

      const prepareAtHost = Date.now();
      expect(
        handleYouTubeZeroStartPrepare(hostPeerId, {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'production-fallback-stop',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId,
          subIndex: null,
          prepareAtHost,
          decisionAtHost: prepareAtHost + 2_300,
          startDeadlineAtHost: prepareAtHost + 3_000,
          hostPlatform: 'other',
        }),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(620);
      expect(getYouTubeZeroStartSnapshot()?.phase).toBe('armed');

      // Lose calibration after the target is armed so the real controller
      // transfers this exact hard-muted player to the production external
      // fallback owner instead of taking its in-controller late-start path.
      resetClockState();

      expect(
        handleYouTubeZeroStartCommit(hostPeerId, {
          type: MSG.YOUTUBE_ZERO_START_COMMIT,
          version: 1,
          runId: 'production-fallback-stop',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId,
          startAtHost: prepareAtHost + 3_000,
          reason: 'all-ready',
          cohort: [hostPeerId, guestPeerId],
        }),
      ).toBe(true);

      const fallbackCallbacks = () =>
        vi
          .mocked(setManagedTimer)
          .mock.calls.filter(([name]) => name === 'yt-zero-start-external-fallback')
          .map(([, callback]) => callback as () => void);
      const callbacksBeforeFirstAttempt = fallbackCallbacks();
      const firstFallback = callbacksBeforeFirstAttempt.at(-1);
      expect(firstFallback).toBeTypeOf('function');
      expect(isYouTubeZeroStartExternalFallbackActive()).toBe(true);

      const unmuteCountBeforeVolume = player.__log.filter(({ op }) => op === 'unMute').length;
      const mutedBeforeVolume = player.isMuted();
      bus.emit('youtube:set-volume', 81);
      expect(player.__log.filter(({ op }) => op === 'setVolume').at(-1)).toMatchObject({
        args: [81],
      });
      expect(player.__log.filter(({ op }) => op === 'unMute')).toHaveLength(
        unmuteCountBeforeVolume,
      );
      expect(player.isMuted()).toBe(mutedBeforeVolume);

      firstFallback?.();

      const callbacksAfterFirstAttempt = fallbackCallbacks();
      expect(callbacksAfterFirstAttempt.length).toBeGreaterThan(callbacksBeforeFirstAttempt.length);
      const staleFallback = callbacksAfterFirstAttempt.at(-1);
      expect(staleFallback).toBeTypeOf('function');
      const unmuteCountBeforeStop = player.__log.filter(({ op }) => op === 'unMute').length;

      stopYouTubeMode();

      expect(isYouTubeZeroStartExternalFallbackActive()).toBe(false);
      expect(player.__log.filter(({ op }) => op === 'unMute')).toHaveLength(unmuteCountBeforeStop);

      // Managed timers are mocked in this suite, so invoke the callback that
      // had already escaped before teardown. Its generation fence must also
      // prevent the transferred fallback cleanup from restoring audible state.
      staleFallback?.();
      expect(player.__log.filter(({ op }) => op === 'unMute')).toHaveLength(unmuteCountBeforeStop);

      stateMod.setYouTubePlayer(null);
      stateMod.setYtPrimed(false);
      resetClockState();
    });
  });

  describe('Late-join YouTube bootstrap', () => {
    it('schedules a precision rendezvous sync for the newly connected guest only', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const { safeSend } = await import('../../network/peer.ts');
      const { getManagedTimer, setManagedTimer } = await import('../../core/timers.ts');
      const { STAGE2_RENDEZVOUS_BROADCAST_MS } = await import('../constants.ts');

      setPlaybackYouTubePlaying();
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'initialVideo',
          playlistId: null,
          name: 'Late Join Video',
          title: 'Late Join Video',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('player.currentTrackMeta', {
        queueItemId: QUEUE_ITEM_ID,
        title: 'Late Join Video',
      } satisfies TrackMeta);
      setState('youtube.currentSubIndex', 0);

      const player: YouTubePlayerInstance = {
        loadVideoById: vi.fn(),
        loadPlaylist: vi.fn(),
        cuePlaylist: vi.fn(),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        stopVideo: vi.fn(),
        destroy: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 42),
        getDuration: vi.fn(() => 0),
        getPlayerState: vi.fn(() => 1),
        getPlaylistIndex: vi.fn(() => 0),
        getVideoData: vi.fn(() => ({ video_id: 'liveVideo123', title: 'Late Join Video' })),
        getPlaylist: vi.fn(() => []),
        setVolume: vi.fn(),
      };
      setYouTubePlayer(player);

      initYouTube();

      const conn = dataConnection('guest-1');
      bus.emit('network:peer-connected', conn);

      expect(safeSend).toHaveBeenCalledWith(
        conn,
        expect.objectContaining({
          type: MSG.YOUTUBE_PLAY,
          queueItemId: QUEUE_ITEM_ID,
          videoId: 'liveVideo123',
          autoplay: true,
        }),
      );
      expect(safeSend).toHaveBeenCalledWith(
        conn,
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          queueItemId: QUEUE_ITEM_ID,
          state: 1,
          time: 42,
          videoId: 'liveVideo123',
        }),
      );

      const timerCall = vi
        .mocked(setManagedTimer)
        .mock.calls.find(([name]) => name === 'yt-late-join-rendezvous-guest-1');
      expect(timerCall?.[2]).toBe(STAGE2_RENDEZVOUS_BROADCAST_MS);

      const fireRendezvous = timerCall?.[1] as (() => void) | undefined;
      fireRendezvous?.();

      expect(safeSend).toHaveBeenCalledWith(
        conn,
        expect.objectContaining({
          type: MSG.YOUTUBE_SYNC,
          queueItemId: QUEUE_ITEM_ID,
          isManual: true,
          state: 1,
          time: 42,
          videoId: 'liveVideo123',
          title: 'Late Join Video',
        }),
      );

      setState('sync.youtubeLocalOffset', 0.25);
      setState('sync.youtubeCoordinatorAppliedOffset', 0.25);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const proConn = dataConnection('pro-guest');
      bus.emit('network:peer-connected', proConn);

      expect(safeSend).toHaveBeenCalledWith(
        proConn,
        expect.objectContaining({ type: MSG.YOUTUBE_STATE, time: 41.75 }),
      );

      const proTimerCall = vi
        .mocked(setManagedTimer)
        .mock.calls.find(([name]) => name === 'yt-late-join-rendezvous-pro-guest');
      (proTimerCall?.[1] as (() => void) | undefined)?.();
      expect(safeSend).toHaveBeenCalledWith(
        proConn,
        expect.objectContaining({ type: MSG.YOUTUBE_SYNC, time: 41.75, isManual: true }),
      );

      vi.mocked(getManagedTimer).mockImplementation((name) =>
        name === 'yt-pro-coordinator-local-nudge'
          ? ({} as ReturnType<typeof getManagedTimer>)
          : null,
      );
      const settlingConn = dataConnection('settling-guest');
      bus.emit('network:peer-connected', settlingConn);
      expect(vi.mocked(safeSend).mock.calls.some(([target]) => target === settlingConn)).toBe(
        false,
      );

      const settlingTimer = vi
        .mocked(setManagedTimer)
        .mock.calls.find(([name]) => name === 'yt-late-join-pro-nudge-settling-guest');
      expect(settlingTimer).toBeDefined();
      vi.mocked(getManagedTimer).mockReturnValue(null);
      (settlingTimer?.[1] as (() => void) | undefined)?.();
      expect(safeSend).toHaveBeenCalledWith(
        settlingConn,
        expect.objectContaining({ type: MSG.YOUTUBE_STATE, time: 41.75 }),
      );

      const midNudgeConn = dataConnection('mid-nudge-guest');
      bus.emit('network:peer-connected', midNudgeConn);
      const midNudgeTimer = vi
        .mocked(setManagedTimer)
        .mock.calls.find(([name]) => name === 'yt-late-join-rendezvous-mid-nudge-guest');
      expect(midNudgeTimer).toBeDefined();

      vi.mocked(getManagedTimer).mockImplementation((name) =>
        name === 'yt-pro-coordinator-local-nudge'
          ? ({} as ReturnType<typeof getManagedTimer>)
          : null,
      );
      const sendsBeforeDeferredRendezvous = vi.mocked(safeSend).mock.calls.length;
      (midNudgeTimer?.[1] as (() => void) | undefined)?.();
      expect(vi.mocked(safeSend).mock.calls.length).toBe(sendsBeforeDeferredRendezvous);

      const deferredMidNudgeTimer = vi
        .mocked(setManagedTimer)
        .mock.calls.filter(([name]) => name === 'yt-late-join-rendezvous-mid-nudge-guest')
        .at(-1);
      expect(deferredMidNudgeTimer).not.toBe(midNudgeTimer);
      vi.mocked(getManagedTimer).mockReturnValue(null);
      (deferredMidNudgeTimer?.[1] as (() => void) | undefined)?.();
      expect(safeSend).toHaveBeenCalledWith(
        midNudgeConn,
        expect.objectContaining({ type: MSG.YOUTUBE_SYNC, time: 41.75, isManual: true }),
      );
    });
  });

  describe('Playlist scrape reuse path', () => {
    it('resets the requested sub-index when the same playlist is loaded as a new queue item', async () => {
      const { loadYouTubeVideo } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');

      const wrapper = document.createElement('div');
      wrapper.className = 'video-wrapper';
      const container = document.createElement('div');
      container.id = 'youtube-player-container';
      const playerDiv = document.createElement('div');
      playerDiv.id = 'youtube-player';
      container.appendChild(playerDiv);
      wrapper.appendChild(container);
      document.body.appendChild(wrapper);

      setPlaybackYouTubePlaying();
      setState('youtube.currentSubIndex', 2);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'firstEntry',
          playlistId: 'playlist-repeat',
          name: 'Playlist A',
        },
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'secondEntry',
          playlistId: 'playlist-repeat',
          name: 'Playlist A again',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
      (window as unknown as { YT: unknown }).YT = {
        Player: vi.fn(),
        PlayerState: {
          UNSTARTED: -1,
          ENDED: 0,
          PLAYING: 1,
          PAUSED: 2,
          BUFFERING: 3,
          CUED: 5,
        },
      };

      const player: YouTubePlayerInstance = {
        loadVideoById: vi.fn(),
        loadPlaylist: vi.fn(),
        cuePlaylist: vi.fn(),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        stopVideo: vi.fn(),
        destroy: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 0),
        getPlayerState: vi.fn(() => 2),
        getPlaylistIndex: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'previousLastVideo' })),
        getPlaylist: vi.fn(() => ['firstVideo', 'secondVideo', 'previousLastVideo']),
        setVolume: vi.fn(),
      };
      setYouTubePlayer(player);

      loadYouTubeVideo('secondEntry', 'playlist-repeat', true, 0);

      expect(player.cuePlaylist).toHaveBeenCalledWith(
        expect.objectContaining({
          list: 'playlist-repeat',
          listType: 'playlist',
          index: 0,
          startSeconds: 0,
        }),
      );
      expect(getState('youtube.currentSubIndex')).toBe(0);
    });
  });

  describe('Repeat-one ended handling', () => {
    it('routes host YouTube repeat-one through the synchronized auto-play path', async () => {
      const { loadYouTubeVideo } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      setYouTubePlayer(null);

      const wrapper = document.createElement('div');
      wrapper.className = 'video-wrapper';
      document.body.appendChild(wrapper);

      let onStateChange:
        | ((event: { data: number; target: YouTubePlayerInstance }) => void)
        | undefined;
      const player: YouTubePlayerInstance = {
        loadVideoById: vi.fn(),
        loadPlaylist: vi.fn(),
        cuePlaylist: vi.fn(),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        stopVideo: vi.fn(),
        destroy: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 120),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 0),
        getPlaylistIndex: vi.fn(() => -1),
        getVideoData: vi.fn(() => ({ video_id: 'repeatVideo', title: 'Repeat Video' })),
        getPlaylist: vi.fn(() => []),
        setVolume: vi.fn(),
      };

      (window as unknown as { YT: unknown }).YT = {
        Player: vi.fn(function (
          _target: string,
          options: { events: { onStateChange: typeof onStateChange } },
        ) {
          onStateChange = options.events.onStateChange;
          return player;
        }),
        PlayerState: {
          UNSTARTED: -1,
          ENDED: 0,
          PLAYING: 1,
          PAUSED: 2,
          BUFFERING: 3,
          CUED: 5,
        },
      };

      const autoPlaySpy = vi.fn();
      const seekSpy = vi.fn();
      bus.on('youtube:auto-play', autoPlaySpy);
      bus.on('youtube:seek-to', seekSpy);

      setPlaybackYouTubePlaying();
      setState('playlist.repeatMode', 2);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'repeatVideo',
          playlistId: null,
          name: 'Repeat Video',
        },
      ]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

      loadYouTubeVideo('repeatVideo', null, true, 0);
      onStateChange?.({ data: 0, target: player });

      expect(autoPlaySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          targetTime: 0,
          skipSeek: false,
          isTrackTransition: false,
        }),
      );
      expect(seekSpy).not.toHaveBeenCalled();
    });
  });

  describe('Chat add auto-rendezvous', () => {
    it('marks first idle YouTube adds as fresh loads after load cleanup', async () => {
      const { initYouTube, consumePendingAutoSyncOnReady, setPendingAutoSyncOnReady } =
        await import('../player.ts');

      initYouTube();
      bus.on('player:stop-all-media', () => setPendingAutoSyncOnReady(false));

      bus.emit('youtube:load-from-chat', 'https://www.youtube.com/watch?v=VIDEO_ID_01');

      expect(getState('playlist.currentQueueItemId')).toBe(
        getState('playlist.items')[0]?.queueItemId,
      );
      expect(consumePendingAutoSyncOnReady()).toMatchObject({
        isTrackTransition: false,
        targetTime: 0,
        subIndex: 0,
        videoId: 'VIDEO_ID_01',
        skipSeek: true,
      });
    });

    it('delegates a stable queue occurrence and title patch for a PRO member', async () => {
      const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      const updateTrackMetadata = vi.fn(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube, updateTrackMetadata }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      setState('network.hostConn', null);
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      const sourceUrl = 'https://www.youtube.com/watch?v=VIDEO_ID_01';
      bus.emit('youtube:load-from-chat', sourceUrl);

      expect(addYouTube).toHaveBeenCalledTimes(1);
      const [addedItem, addedUrl] = addYouTube.mock.calls[0]!;
      expect(addedUrl).toBe(sourceUrl);
      expect(addedItem).toMatchObject({
        type: 'youtube',
        videoId: 'VIDEO_ID_01',
        playlistId: null,
      });
      expect(addedItem.queueItemId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(getState('playlist.items')).toEqual([]);

      await vi.waitFor(() => {
        expect(updateTrackMetadata).toHaveBeenCalledWith(addedItem.queueItemId, {
          name: 'Test Title',
          title: 'Test Title',
        });
      });
    });

    it('does not transfer a stale PRO title lookup to a replacement hook session', async () => {
      const addA = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      const updateA = vi.fn<ProRoomMediaHooks['updateTrackMetadata']>(() => true);
      const addB = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      const updateB = vi.fn<ProRoomMediaHooks['updateTrackMetadata']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube: addA, updateTrackMetadata: updateA }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      const oembed = await import('../oembed.ts');
      let resolveTitle!: (title: string | null) => void;
      const titleResult = new Promise<string | null>((resolve) => {
        resolveTitle = resolve;
      });
      vi.mocked(oembed.fetchOEmbedTitle).mockReturnValueOnce(titleResult);
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      const sourceUrl = 'https://www.youtube.com/watch?v=VIDEO_ID_01';
      bus.emit('youtube:load-from-chat', sourceUrl);
      expect(addA).toHaveBeenCalledOnce();
      const addedQueueItemId = addA.mock.calls[0]?.[0].queueItemId;

      registerProRoomMediaHooks(proMediaHooks({ addYouTube: addB, updateTrackMetadata: updateB }));
      resolveTitle('Stale A title');
      await titleResult;
      await Promise.resolve();

      expect(addedQueueItemId).toBeDefined();
      expect(updateA).not.toHaveBeenCalled();
      expect(updateB).not.toHaveBeenCalled();
      expect(addB).not.toHaveBeenCalled();
    });

    it('never applies a failed PRO title patch through the legacy local queue path', async () => {
      const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>((item) => {
        setState('playlist.items', [
          {
            ...item,
            name: 'Projected title',
            title: 'Projected title',
          },
        ]);
        return true;
      });
      const updateTrackMetadata = vi.fn(() => false);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube, updateTrackMetadata }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      setState('network.hostConn', null);
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:load-from-chat', 'https://www.youtube.com/watch?v=VIDEO_ID_01');

      await vi.waitFor(() => expect(updateTrackMetadata).toHaveBeenCalledTimes(1));
      expect(getState('playlist.items')).toEqual([
        expect.objectContaining({
          name: 'Projected title',
          title: 'Projected title',
        }),
      ]);
    });

    it('fails closed for PRO media adds without media-management authority', async () => {
      const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: [],
      });
      setState('network.hostConn', null);
      const { showToast } = await import('../../ui/toast.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:load-from-chat', 'https://www.youtube.com/watch?v=VIDEO_ID_01');
      bus.emit('youtube:load-from-input');

      expect(showToast).toHaveBeenCalledTimes(2);
      expect(showToast).toHaveBeenNthCalledWith(1, 'toast.media_management_required');
      expect(showToast).toHaveBeenNthCalledWith(2, 'toast.media_management_required');
      expect(addYouTube).not.toHaveBeenCalled();
      expect(getState('playlist.items')).toEqual([]);
    });

    it('consumes a prefetched playlist manifest synchronously on the submit gesture', async () => {
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = 'https://www.youtube.com/playlist?list=PL_GESTURE_READY';
      document.body.appendChild(input);
      const title = document.createElement('div');
      title.id = 'youtube-preview-title';
      title.textContent = 'Gesture-ready playlist';
      document.body.appendChild(title);

      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValueOnce({
        kind: 'playlist-url',
        raw: input.textContent,
        videoId: null,
        playlistId: 'PL_GESTURE_READY',
        query: null,
      });
      vi.mocked(search.getPrefetchedYouTubePlaylistManifest).mockReturnValueOnce({
        playlistId: 'PL_GESTURE_READY',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB'],
        title: 'Gesture-ready playlist',
      });

      const { initYouTube } = await import('../player.ts');
      initYouTube();
      bus.emit('youtube:load-from-input');

      expect(search.resolveYouTubePlaylistManifest).not.toHaveBeenCalled();
      expect(getState('youtube.subItemsMap').PL_GESTURE_READY?.ids).toEqual([
        'AAAAAAAAAAA',
        'BBBBBBBBBBB',
      ]);
      expect(getState('youtube.subItemsMap').PL_GESTURE_READY?.manifestComplete).toBe(true);
      expect(getState('playlist.items')).toHaveLength(1);
      expect(getState('playlist.items')[0]).toMatchObject({
        type: 'youtube',
        videoId: 'AAAAAAAAAAA',
        playlistId: 'PL_GESTURE_READY',
        name: 'Gesture-ready playlist',
      });
    });

    it('uses the requested video from a prefetched playlist without changing manifest order', async () => {
      const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      const sourceUrl = 'https://www.youtube.com/watch?v=BBBBBBBBBBB&list=PL_GESTURE_SELECTED';
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = sourceUrl;
      document.body.appendChild(input);

      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValueOnce({
        kind: 'video-url',
        raw: sourceUrl,
        videoId: 'BBBBBBBBBBB',
        playlistId: 'PL_GESTURE_SELECTED',
        query: null,
      });
      vi.mocked(search.getPrefetchedYouTubePlaylistManifest).mockReturnValueOnce({
        playlistId: 'PL_GESTURE_SELECTED',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'],
        title: 'Gesture-selected playlist',
      });

      const { initYouTube } = await import('../player.ts');
      initYouTube();
      bus.emit('youtube:load-from-input');

      expect(addYouTube).toHaveBeenCalledWith(
        expect.objectContaining({
          videoId: 'BBBBBBBBBBB',
          playlistId: 'PL_GESTURE_SELECTED',
        }),
        sourceUrl,
        ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'],
      );
      expect(search.resolveYouTubePlaylistManifest).not.toHaveBeenCalled();
      expect(getState('youtube.subItemsMap').PL_GESTURE_SELECTED?.ids).toEqual([
        'AAAAAAAAAAA',
        'BBBBBBBBBBB',
        'CCCCCCCCCCC',
      ]);
    });

    it('keeps the selected manifest index aligned across local state and guest broadcasts', async () => {
      const sourceUrl = 'https://www.youtube.com/watch?v=BBBBBBBBBBB&list=PL_GESTURE_STANDARD';
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = sourceUrl;
      document.body.appendChild(input);

      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValueOnce({
        kind: 'video-url',
        raw: sourceUrl,
        videoId: 'BBBBBBBBBBB',
        playlistId: 'PL_GESTURE_STANDARD',
        query: null,
      });
      vi.mocked(search.getPrefetchedYouTubePlaylistManifest).mockReturnValueOnce({
        playlistId: 'PL_GESTURE_STANDARD',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'],
        title: 'Selected standard playlist',
      });
      const { broadcast } = await import('../../network/peer.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:load-from-input');

      expect(getState('youtube.currentSubIndex')).toBe(1);
      expect(broadcast).toHaveBeenCalledWith({
        type: MSG.YOUTUBE_PLAYLIST_INFO,
        playlistId: 'PL_GESTURE_STANDARD',
        ids: ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'],
        titles: [],
      });
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_PLAY,
          videoId: 'BBBBBBBBBBB',
          playlistId: null,
          subIndex: 1,
        }),
      );
    });

    it('resolves a playlist-only PRO add without interrupting current playback', async () => {
      const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      setState('network.hostConn', { peer: 'coordinator-1' } as DataConnection);
      setPlaybackYouTubePlaying();
      const existing = {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Existing',
        videoId: 'EXISTING_01',
        playlistId: null,
      } satisfies PlaylistItem;
      setState('playlist.items', [existing]);
      setState('playlist.currentQueueItemId', existing.queueItemId);

      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = 'https://www.youtube.com/playlist?list=PL_PERSISTENT';
      document.body.appendChild(input);
      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValue({
        kind: 'playlist-url',
        raw: input.textContent,
        videoId: null,
        playlistId: 'PL_PERSISTENT',
        query: null,
      });
      vi.mocked(search.resolveYouTubePlaylistManifest).mockResolvedValue({
        playlistId: 'PL_PERSISTENT',
        videoId: 'RESOLVED001',
        title: 'Resolved first video',
        videoIds: ['RESOLVED001', 'RESOLVED002'],
      });
      const stopMedia = vi.fn();
      bus.on('player:stop-all-media', stopMedia);
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:load-from-input');

      await vi.waitFor(() => {
        expect(addYouTube).toHaveBeenCalledWith(
          expect.objectContaining({
            videoId: 'RESOLVED001',
            playlistId: 'PL_PERSISTENT',
          }),
          'https://www.youtube.com/playlist?list=PL_PERSISTENT',
          ['RESOLVED001', 'RESOLVED002'],
        );
      });
      expect(getState('playlist.items')).toEqual([existing]);
      expect(getState('playlist.currentQueueItemId')).toBe(existing.queueItemId);
      expect(stopMedia).not.toHaveBeenCalled();
    });

    it('keeps a PRO video-plus-playlist entry while preserving canonical manifest order', async () => {
      const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      const sourceUrl = 'https://www.youtube.com/watch?v=SELECTED001&list=PL_PERSISTENT_SELECTED';
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = sourceUrl;
      document.body.appendChild(input);
      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValue({
        kind: 'video-url',
        raw: sourceUrl,
        videoId: 'SELECTED001',
        playlistId: 'PL_PERSISTENT_SELECTED',
        query: null,
      });
      vi.mocked(search.resolveYouTubePlaylistManifest).mockResolvedValue({
        playlistId: 'PL_PERSISTENT_SELECTED',
        videoId: 'FIRSTVID001',
        title: 'First video',
        videoIds: ['FIRSTVID001', 'SELECTED001', 'THIRDVIDEO1'],
      });
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:load-from-input');

      await vi.waitFor(() => {
        expect(addYouTube).toHaveBeenCalledWith(
          expect.objectContaining({
            videoId: 'SELECTED001',
            playlistId: 'PL_PERSISTENT_SELECTED',
          }),
          sourceUrl,
          ['FIRSTVID001', 'SELECTED001', 'THIRDVIDEO1'],
        );
      });
      expect(search.resolveYouTubePlaylistEntry).not.toHaveBeenCalled();
      expect(getState('youtube.subItemsMap')['PL_PERSISTENT_SELECTED']?.ids).toEqual([
        'FIRSTVID001',
        'SELECTED001',
        'THIRDVIDEO1',
      ]);
    });

    it('drops a resolved PRO manifest after the room lease changes', async () => {
      const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      const sourceUrl = 'https://www.youtube.com/playlist?list=PL_STALE_PRO';
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = sourceUrl;
      document.body.appendChild(input);
      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValue({
        kind: 'playlist-url',
        raw: sourceUrl,
        videoId: null,
        playlistId: 'PL_STALE_PRO',
        query: null,
      });
      let resolveManifest!: (value: {
        playlistId: string;
        videoId: string;
        title: string;
        videoIds: string[];
      }) => void;
      vi.mocked(search.resolveYouTubePlaylistManifest).mockReturnValue(
        new Promise((resolve) => {
          resolveManifest = resolve;
        }),
      );
      const { initYouTube } = await import('../player.ts');
      initYouTube();
      bus.emit('youtube:load-from-input');

      setState('room.context', {
        kind: 'pro',
        roomId: '000002',
        role: 'member',
        coordinatorId: null,
        epoch: 2,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      resolveManifest({
        playlistId: 'PL_STALE_PRO',
        videoId: 'RESOLVED001',
        title: 'Resolved',
        videoIds: ['RESOLVED001'],
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(addYouTube).not.toHaveBeenCalled();
      expect(getState('youtube.subItemsMap')['PL_STALE_PRO']).toBeUndefined();
    });

    it('lets a same-room successor resolve the same playlist without inheriting the stale hook generation or loader', async () => {
      type Manifest = {
        playlistId: string;
        videoId: string;
        title: string;
        videoIds: string[];
      };
      const addA = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      const addB = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube: addA }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });

      const sourceUrl = 'https://www.youtube.com/playlist?list=PL_SAME_SUCCESSOR';
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = sourceUrl;
      document.body.appendChild(input);
      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValue({
        kind: 'playlist-url',
        raw: sourceUrl,
        videoId: null,
        playlistId: 'PL_SAME_SUCCESSOR',
        query: null,
      });
      const requests: Array<{
        resolve: (manifest: Manifest) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
      }> = [];
      vi.mocked(search.resolveYouTubePlaylistManifest).mockImplementation(
        (_playlistId, signal) =>
          new Promise<Manifest>((resolve, reject) => {
            requests.push({ resolve, reject, signal });
          }),
      );
      const { showLoader } = await import('../../ui/toast.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:load-from-input');
      expect(requests).toHaveLength(1);
      const loaderA = vi.mocked(showLoader).mock.calls.find(([show]) => show)?.[2];
      expect(loaderA).toMatch(/^youtube-playlist-entry:/);

      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 2,
        snapshotRevision: 2,
        capabilities: ['media.add'],
      });
      registerProRoomMediaHooks(proMediaHooks({ addYouTube: addB }));
      input.textContent = sourceUrl;
      bus.emit('youtube:load-from-input');

      expect(requests).toHaveLength(2);
      expect(requests[0]?.signal?.aborted).toBe(true);
      expect(requests[1]?.signal?.aborted).toBe(false);
      const openedLoaders = vi
        .mocked(showLoader)
        .mock.calls.filter(([show]) => show)
        .map(([, , id]) => id);
      expect(openedLoaders).toHaveLength(2);
      const loaderB = openedLoaders[1];
      expect(loaderB).not.toBe(loaderA);

      requests[0]!.resolve({
        playlistId: 'PL_SAME_SUCCESSOR',
        videoId: 'AAAAAAAAAAA',
        title: 'Stale A',
        videoIds: ['AAAAAAAAAAA'],
      });
      await vi.waitFor(() => expect(showLoader).toHaveBeenCalledWith(false, undefined, loaderA));
      expect(addA).not.toHaveBeenCalled();
      expect(addB).not.toHaveBeenCalled();
      expect(showLoader).not.toHaveBeenCalledWith(false, undefined, loaderB);
      expect(getState('youtube.subItemsMap')['PL_SAME_SUCCESSOR']).toBeUndefined();

      requests[1]!.resolve({
        playlistId: 'PL_SAME_SUCCESSOR',
        videoId: 'BBBBBBBBBBB',
        title: 'Current B',
        videoIds: ['BBBBBBBBBBB', 'CCCCCCCCCCC'],
      });
      await vi.waitFor(() => expect(addB).toHaveBeenCalledOnce());
      expect(addA).not.toHaveBeenCalled();
      expect(addB).toHaveBeenCalledWith(
        expect.objectContaining({
          videoId: 'BBBBBBBBBBB',
          playlistId: 'PL_SAME_SUCCESSOR',
        }),
        sourceUrl,
        ['BBBBBBBBBBB', 'CCCCCCCCCCC'],
      );
      expect(showLoader).toHaveBeenCalledWith(false, undefined, loaderB);
    });

    it('silences a rejected same-room predecessor without hiding or starving its replacement loader', async () => {
      type Manifest = {
        playlistId: string;
        videoId: string;
        title: string;
        videoIds: string[];
      };
      const addA = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      const addB = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube: addA }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
        epoch: 7,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });

      const sourceUrl = 'https://www.youtube.com/playlist?list=PL_REJECT_SUCCESSOR';
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = sourceUrl;
      document.body.appendChild(input);
      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValue({
        kind: 'playlist-url',
        raw: sourceUrl,
        videoId: null,
        playlistId: 'PL_REJECT_SUCCESSOR',
        query: null,
      });
      const requests: Array<{
        resolve: (manifest: Manifest) => void;
        reject: (error: unknown) => void;
      }> = [];
      vi.mocked(search.resolveYouTubePlaylistManifest).mockImplementation(
        () =>
          new Promise<Manifest>((resolve, reject) => {
            requests.push({ resolve, reject });
          }),
      );
      const { showLoader, showToast } = await import('../../ui/toast.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:load-from-input');
      expect(requests).toHaveLength(1);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube: addB }));
      input.textContent = sourceUrl;
      bus.emit('youtube:load-from-input');
      expect(requests).toHaveLength(2);
      const openedLoaders = vi
        .mocked(showLoader)
        .mock.calls.filter(([show]) => show)
        .map(([, , id]) => id);
      const [loaderA, loaderB] = openedLoaders;
      expect(loaderA).not.toBe(loaderB);

      requests[0]!.reject(new Error('stale account session'));
      await vi.waitFor(() => expect(showLoader).toHaveBeenCalledWith(false, undefined, loaderA));
      expect(showToast).not.toHaveBeenCalledWith('youtube.fetch_failed');
      expect(showLoader).not.toHaveBeenCalledWith(false, undefined, loaderB);
      expect(addA).not.toHaveBeenCalled();
      expect(addB).not.toHaveBeenCalled();

      requests[1]!.resolve({
        playlistId: 'PL_REJECT_SUCCESSOR',
        videoId: 'DDDDDDDDDDD',
        title: 'Replacement',
        videoIds: ['DDDDDDDDDDD'],
      });
      await vi.waitFor(() => expect(addB).toHaveBeenCalledOnce());
      expect(addA).not.toHaveBeenCalled();
      expect(showLoader).toHaveBeenCalledWith(false, undefined, loaderB);
    });

    it('reports a playlist-only PRO resolution failure without mutating the queue', async () => {
      const addYouTube = vi.fn<ProRoomMediaHooks['addYouTube']>(() => true);
      registerProRoomMediaHooks(proMediaHooks({ addYouTube }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['media.add'],
      });
      setState('network.hostConn', { peer: 'coordinator-1' } as DataConnection);
      const existing = {
        queueItemId: QUEUE_ITEM_ID,
        type: 'youtube',
        name: 'Existing',
        videoId: 'EXISTING_01',
        playlistId: null,
      } satisfies PlaylistItem;
      setState('playlist.items', [existing]);
      setState('playlist.currentQueueItemId', existing.queueItemId);

      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = 'https://www.youtube.com/playlist?list=PL_UNAVAILABLE';
      document.body.appendChild(input);
      const search = await import('../search.ts');
      vi.mocked(search.getYouTubeInputIntent).mockReturnValue({
        kind: 'playlist-url',
        raw: input.textContent,
        videoId: null,
        playlistId: 'PL_UNAVAILABLE',
        query: null,
      });
      vi.mocked(search.resolveYouTubePlaylistManifest).mockRejectedValue(new Error('unavailable'));
      const { showToast } = await import('../../ui/toast.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:load-from-input');

      await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('youtube.fetch_failed'));
      expect(addYouTube).not.toHaveBeenCalled();
      expect(getState('playlist.items')).toEqual([existing]);
      expect(getState('playlist.currentQueueItemId')).toBe(existing.queueItemId);
    });

    it('routes a standard operator add to the host without a guest-local commit', async () => {
      const send = vi.fn();
      const hostConn = { peer: 'host', open: true, send } as unknown as DataConnection;
      setState('network.appRole', 'guest');
      setState('network.hostConn', hostConn);
      setState('network.isOperator', true);
      setState('playlist.revision', 8);
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      const sourceUrl = 'https://www.youtube.com/watch?v=VIDEO_ID_01';
      bus.emit('youtube:load-from-chat', sourceUrl);

      expect(getState('playlist.items')).toEqual([]);
      expect(getState('playlist.revision')).toBe(8);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          baseRevision: 8,
          sourceUrl,
        }),
      );
    });

    it('lets the exact live standard operator append over a stale revision', async () => {
      const send = vi.fn();
      const conn = { peer: 'operator-1', open: true, send } as unknown as DataConnection;
      setState('network.appRole', 'host');
      setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
      setState('network.connectedPeers', [
        {
          id: conn.peer,
          slot: 1,
          label: 'Operator',
          conn,
          isOp: true,
          preloadedQueueItemIds: new Set(),
          status: 'connected',
          isDataTarget: true,
          joinOrder: 1,
          connectionType: 'local',
          lastHeartbeat: Date.now(),
        },
      ]);
      setState('playlist.revision', 5);
      const protocol = await import('../../network/protocol.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();
      const registrations = vi.mocked(protocol.registerHandlers).mock.calls;
      const handlers = registrations.at(-1)?.[0] as Record<
        string,
        ((data: Record<string, unknown>, conn: DataConnection) => void) | undefined
      >;
      const handler = handlers[MSG.REQUEST_PLAYLIST_ADD_YOUTUBE]!;

      handler(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '66666666-6666-4666-8666-666666666666',
          baseRevision: 2,
          sourceUrl: 'https://www.youtube.com/watch?v=VIDEO_ID_01',
          title: 'Operator video',
        },
        conn,
      );

      await vi.waitFor(() => {
        expect(getState('playlist.items')).toEqual([
          expect.objectContaining({
            type: 'youtube',
            videoId: 'VIDEO_ID_01',
          }),
        ]);
      });
      // The authoritative add is revision 6; the mocked immediate oEmbed
      // title refresh is a second legitimate queue metadata commit.
      expect(getState('playlist.revision')).toBe(7);

      handler(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '66666666-6666-4666-8666-666666666666',
          baseRevision: 2,
          sourceUrl: 'https://www.youtube.com/watch?v=VIDEO_ID_01',
          title: 'Operator video',
        },
        conn,
      );
      expect(getState('playlist.items')).toHaveLength(1);
    });

    it('resolves a concrete entry before publishing a playlist-only operator add', async () => {
      const send = vi.fn();
      const conn = { peer: 'operator-2', open: true, send } as unknown as DataConnection;
      setState('network.appRole', 'host');
      setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
      setState('network.connectedPeers', [
        {
          id: conn.peer,
          slot: 1,
          label: 'Operator',
          conn,
          isOp: true,
          preloadedQueueItemIds: new Set(),
          status: 'connected',
          isDataTarget: true,
          joinOrder: 1,
          connectionType: 'local',
          lastHeartbeat: Date.now(),
        },
      ]);
      const search = await import('../search.ts');
      vi.mocked(search.extractYouTubePlaylistId).mockReturnValue('PL_OPERATOR');
      vi.mocked(search.resolveYouTubePlaylistEntry).mockResolvedValue({
        playlistId: 'PL_OPERATOR',
        videoId: 'RESOLVED001',
        title: 'Resolved first video',
      });
      const protocol = await import('../../network/protocol.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();
      const handlers = vi.mocked(protocol.registerHandlers).mock.calls.at(-1)?.[0] as Record<
        string,
        ((data: Record<string, unknown>, conn: DataConnection) => void) | undefined
      >;

      handlers[MSG.REQUEST_PLAYLIST_ADD_YOUTUBE]?.(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '77777777-7777-4777-8777-777777777777',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/playlist?list=PL_OPERATOR',
          title: 'https://www.youtube.com/playlist?list=PL_OPERATOR',
        },
        conn,
      );

      await vi.waitFor(() => {
        expect(getState('playlist.items')).toEqual([
          expect.objectContaining({
            type: 'youtube',
            videoId: 'RESOLVED001',
            playlistId: 'PL_OPERATOR',
          }),
        ]);
      });
    });

    it('serializes operator YouTube additions in request-arrival order', async () => {
      const conn = {
        peer: 'operator-serial',
        open: true,
        send: vi.fn(),
      } as unknown as DataConnection;
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
      setState('network.connectedPeers', [
        {
          id: conn.peer,
          slot: 1,
          label: 'Operator',
          conn,
          isOp: true,
          preloadedQueueItemIds: new Set(),
          status: 'connected',
          isDataTarget: true,
          joinOrder: 1,
          connectionType: 'local',
          lastHeartbeat: Date.now(),
        },
      ]);
      const search = await import('../search.ts');
      vi.mocked(search.extractYouTubePlaylistId).mockImplementation((url: string) =>
        url.includes('list=PL_SERIAL') ? 'PL_SERIAL' : null,
      );
      let resolveFirst!: (entry: { playlistId: string; videoId: string; title: string }) => void;
      vi.mocked(search.resolveYouTubePlaylistEntry).mockReturnValue(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      );
      const protocol = await import('../../network/protocol.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();
      const handlers = vi.mocked(protocol.registerHandlers).mock.calls.at(-1)?.[0] as Record<
        string,
        ((data: Record<string, unknown>, conn: DataConnection) => void) | undefined
      >;
      const handler = handlers[MSG.REQUEST_PLAYLIST_ADD_YOUTUBE]!;

      handler(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '88888888-8888-4888-8888-888888888881',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/playlist?list=PL_SERIAL',
          title: 'First',
        },
        conn,
      );
      handler(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '88888888-8888-4888-8888-888888888882',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/watch?v=VIDEO_ID_02',
          title: 'Second',
        },
        conn,
      );
      await Promise.resolve();
      expect(getState('playlist.items')).toEqual([]);

      resolveFirst({
        playlistId: 'PL_SERIAL',
        videoId: 'RESOLVED001',
        title: 'Resolved first video',
      });

      await vi.waitFor(() => {
        expect(getState('playlist.items').map((item) => item.videoId)).toEqual([
          'RESOLVED001',
          'VIDEO_ID_02',
        ]);
      });
    });

    it('does not send async failure data to a replaced operator connection', async () => {
      const conn = {
        peer: 'operator-stale',
        open: true,
        send: vi.fn(),
      } as unknown as DataConnection;
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
      setState('network.connectedPeers', [
        {
          id: conn.peer,
          slot: 1,
          label: 'Operator',
          conn,
          isOp: true,
          preloadedQueueItemIds: new Set(),
          status: 'connected',
          isDataTarget: true,
          joinOrder: 1,
          connectionType: 'local',
          lastHeartbeat: Date.now(),
        },
      ]);
      const search = await import('../search.ts');
      vi.mocked(search.extractYouTubePlaylistId).mockReturnValue('PL_STALE');
      let rejectResolution!: (error: Error) => void;
      vi.mocked(search.resolveYouTubePlaylistEntry).mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectResolution = reject;
        }),
      );
      const peer = await import('../../network/peer.ts');
      const protocol = await import('../../network/protocol.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();
      const handlers = vi.mocked(protocol.registerHandlers).mock.calls.at(-1)?.[0] as Record<
        string,
        ((data: Record<string, unknown>, conn: DataConnection) => void) | undefined
      >;

      handlers[MSG.REQUEST_PLAYLIST_ADD_YOUTUBE]?.(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '99999999-9999-4999-8999-999999999999',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/playlist?list=PL_STALE',
          title: 'Stale',
        },
        conn,
      );
      await Promise.resolve();
      const replacement = { ...conn, send: vi.fn() } as unknown as DataConnection;
      setState('network.activeHostConnByPeerId', new Map([[conn.peer, replacement]]));
      setState('network.connectedPeers', []);
      vi.mocked(peer.safeSend).mockClear();

      rejectResolution(new Error('network failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(peer.safeSend).not.toHaveBeenCalled();
    });
  });

  describe('PRO iframe title persistence', () => {
    it('persists a coordinator placeholder with bounded retries', async () => {
      const updateTrackMetadata = vi.fn(() => true);
      registerProRoomMediaHooks(proMediaHooks({ updateTrackMetadata }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['queue.mutate'],
      });
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'VIDEO_ID_01',
          videoId: 'VIDEO_ID_01',
          playlistId: null,
        },
      ]);
      const { persistResolvedProYouTubeTitleForTests } = await import('../iframe.ts');

      expect(
        persistResolvedProYouTubeTitleForTests(QUEUE_ITEM_ID, 'VIDEO_ID_01', 'Resolved title'),
      ).toBe(true);
      expect(
        persistResolvedProYouTubeTitleForTests(QUEUE_ITEM_ID, 'VIDEO_ID_01', 'Resolved title'),
      ).toBe(false);
      expect(updateTrackMetadata).toHaveBeenCalledTimes(1);
      expect(updateTrackMetadata).toHaveBeenCalledWith(QUEUE_ITEM_ID, {
        name: 'Resolved title',
        title: 'Resolved title',
      });

      // A transient metadata mutation failure must not suppress retries for
      // the rest of the tab lifetime. The authoritative snapshot normally
      // replaces the placeholder before this bounded retry window expires.
      vi.advanceTimersByTime(5_001);
      expect(
        persistResolvedProYouTubeTitleForTests(QUEUE_ITEM_ID, 'VIDEO_ID_01', 'Resolved title'),
      ).toBe(true);
      expect(updateTrackMetadata).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(5_001);
      expect(
        persistResolvedProYouTubeTitleForTests(QUEUE_ITEM_ID, 'VIDEO_ID_01', 'Resolved title'),
      ).toBe(true);
      vi.advanceTimersByTime(5_001);
      expect(
        persistResolvedProYouTubeTitleForTests(QUEUE_ITEM_ID, 'VIDEO_ID_01', 'Resolved title'),
      ).toBe(false);
      expect(updateTrackMetadata).toHaveBeenCalledTimes(3);

      setState('room.context', {
        ...getState('room.context'),
        coordinatorId: 'coordinator-2',
        epoch: 2,
      });
      expect(
        persistResolvedProYouTubeTitleForTests(QUEUE_ITEM_ID, 'VIDEO_ID_01', 'Resolved title'),
      ).toBe(true);
      expect(updateTrackMetadata).toHaveBeenCalledTimes(4);

      setState('playlist.items', []);
      expect(
        persistResolvedProYouTubeTitleForTests(QUEUE_ITEM_ID, 'VIDEO_ID_01', 'Resolved title'),
      ).toBe(false);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'VIDEO_ID_01',
          videoId: 'VIDEO_ID_01',
          playlistId: null,
        },
      ]);
      expect(
        persistResolvedProYouTubeTitleForTests(QUEUE_ITEM_ID, 'VIDEO_ID_01', 'Resolved title'),
      ).toBe(true);
      expect(updateTrackMetadata).toHaveBeenCalledTimes(5);
    });

    it('protects explicit titles and mismatched sources while allowing capable PRO members', async () => {
      const updateTrackMetadata = vi.fn(() => true);
      registerProRoomMediaHooks(proMediaHooks({ updateTrackMetadata }));
      const { persistResolvedProYouTubeTitleForTests } = await import('../iframe.ts');
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['queue.mutate'],
      });
      setState('playlist.items', [
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'VIDEO_ID_02',
          title: 'API supplied title',
          videoId: 'VIDEO_ID_02',
          playlistId: null,
        },
      ]);

      expect(
        persistResolvedProYouTubeTitleForTests(SECOND_QUEUE_ITEM_ID, 'VIDEO_ID_02', 'Iframe title'),
      ).toBe(false);
      expect(
        persistResolvedProYouTubeTitleForTests(SECOND_QUEUE_ITEM_ID, 'WRONG_VIDEO', 'Iframe title'),
      ).toBe(false);
      setState('playlist.items', [
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'VIDEO_ID_02',
          videoId: 'VIDEO_ID_02',
          playlistId: null,
        },
      ]);
      setState('room.context', {
        ...getState('room.context'),
        role: 'member',
      });
      expect(
        persistResolvedProYouTubeTitleForTests(SECOND_QUEUE_ITEM_ID, 'VIDEO_ID_02', 'Iframe title'),
      ).toBe(true);
      expect(updateTrackMetadata).toHaveBeenCalledWith(SECOND_QUEUE_ITEM_ID, {
        name: 'Iframe title',
        title: 'Iframe title',
      });

      setState('room.context', {
        ...getState('room.context'),
        capabilities: [],
      });
      expect(
        persistResolvedProYouTubeTitleForTests(SECOND_QUEUE_ITEM_ID, 'VIDEO_ID_02', 'New title'),
      ).toBe(false);
      expect(updateTrackMetadata).toHaveBeenCalledTimes(1);
    });
  });

  describe('System audio restore bootstrap', () => {
    it('rebroadcasts YouTube playback when restoring the room after system audio', async () => {
      const { consumePendingAutoSyncOnReady, initYouTube } = await import('../player.ts');
      const { broadcast } = await import('../../network/peer.ts');

      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'entryVideo',
          playlistId: 'playlist-1',
          name: 'Playlist Track',
          title: 'Playlist Track',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('youtube.subItemsMap', {
        'playlist-1': {
          ids: ['firstVideo', 'secondVideo'],
          titles: ['First', 'Second'],
        },
      });

      const loadSpy = vi.fn();
      initYouTube();
      bus.on('youtube:load', loadSpy);

      bus.emit('youtube:restore-room-playback', {
        videoId: 'entryVideo',
        playlistId: 'playlist-1',
        name: 'Playlist Track',
        queueItemId: QUEUE_ITEM_ID,
        autoplay: true,
        subIndex: 1,
        positionSeconds: 37.5,
      });

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_PLAY,
          videoId: 'secondVideo',
          playlistId: 'playlist-1',
          queueItemId: QUEUE_ITEM_ID,
          autoplay: false,
          subIndex: 1,
        }),
      );
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_PLAYLIST_INFO,
          playlistId: 'playlist-1',
          ids: ['firstVideo', 'secondVideo'],
          titles: ['First', 'Second'],
        }),
      );
      expect(loadSpy).toHaveBeenCalledWith('secondVideo', 'playlist-1', QUEUE_ITEM_ID, false, 1);
      expect(consumePendingAutoSyncOnReady()).toEqual(
        expect.objectContaining({ targetTime: 37.5, skipSeek: false, state: 1 }),
      );
    });
  });
});
