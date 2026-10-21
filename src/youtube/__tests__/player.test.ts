/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { setPlaybackFilePlaying, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection, PlaylistItem, TrackMeta } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import { makeFakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import * as searchFixture from '../search.ts';
import {
  getProStartObservations,
  resetProStartObservations,
} from '../../diagnostics/pro-start-observations.ts';
import { registerProRoomMediaHooks, type ProRoomMediaHooks } from '../../pro-room/media-hooks.ts';
import {
  createProPlaybackAuthorityToken,
  getProPlaybackAuthorityKey,
  registerProPlaybackCommandHandler,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';

const QUEUE_ITEM_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_QUEUE_ITEM_ID = '55555555-5555-4555-8555-555555555555';

const playbackPlatform = vi.hoisted(() => ({ android: false }));
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  get IS_ANDROID() {
    return playbackPlatform.android;
  },
}));
beforeEach(() => {
  playbackPlatform.android = false;
});

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
  invalidateGuestYouTubeTimeline: vi.fn(),
  guestRendezvousSync: vi.fn(() => ({ status: 'not-ready' })),
  isGuestYouTubeTransitionPending: vi.fn(() => false),
  resetAdDetection: vi.fn(),
  initYouTubeSync: vi.fn(),
  resetYouTubeSyncState: vi.fn(),
  suppressDriftUntil: vi.fn(),
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
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchFixture.extractYouTubePlaylistId).mockReset().mockReturnValue(null);
  vi.mocked(searchFixture.resolveYouTubePlaylistManifest)
    .mockReset()
    .mockImplementation(async (playlistId) => ({
      playlistId,
      videoId: 'RESOLVED001',
      videoIds: ['RESOLVED001', 'RESOLVED002'],
      title: 'Resolved first video',
    }));
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
      const { setYouTubePlayer, markYtPlayerReady } = await import('../_state.ts');
      const readyPlayer = makeFakeYtPlayer({
        __videoId: 'bridgeVideo',
      }) as unknown as YouTubePlayerInstance;
      setYouTubePlayer(readyPlayer);
      // Consumption is gated, but the current pending intent survives until READY.
      expect(playerRuntime.consumePendingAutoSyncOnReady()).toBeNull();
      expect(markYtPlayerReady(readyPlayer)).toBe(true);
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

    it('leaves protocol listener ownership in initYouTube', async () => {
      const playerRuntime = await import('../player.ts');
      const { registerHandlers } = await import('../../network/protocol.ts');

      expect(registerHandlers).not.toHaveBeenCalled();

      playerRuntime.initYouTube();

      expect(registerHandlers).toHaveBeenCalledOnce();
      expect(vi.mocked(registerHandlers).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          [MSG.YOUTUBE_PLAY]: expect.any(Function),
          [MSG.REQUEST_YOUTUBE_PLAY]: expect.any(Function),
          [MSG.REQUEST_YOUTUBE_PAUSE]: expect.any(Function),
          [MSG.REQUEST_YOUTUBE_TOGGLE]: expect.any(Function),
          [MSG.REQUEST_YOUTUBE_SUB_SEEK]: expect.any(Function),
          [MSG.REQUEST_YOUTUBE_PLAYLIST_INFO]: expect.any(Function),
        }),
      );
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
    it('does not publish the outgoing seek after an iframe callback starts a newer timeline', async () => {
      const { setYouTubePlayer } = await import('../_state.ts');
      const { scheduleYtAutoSync } = await import('../player.ts');
      const { broadcast } = await import('../../network/peer.ts');
      const { setManagedTimer } = await import('../../core/timers.ts');
      const player = makeFakeYtPlayer({ __videoId: 'M7lc1UVf-VE', __state: 1 });
      setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      setPlaybackYouTubePlaying();
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      vi.spyOn(player, 'seekTo').mockImplementationOnce(() => scheduleYtAutoSync(0));

      scheduleYtAutoSync(299);

      const states = vi
        .mocked(broadcast)
        .mock.calls.map(([message]) => message)
        .filter((message) => message.type === MSG.YOUTUBE_STATE);
      expect(states).toEqual([expect.objectContaining({ time: 0 })]);
      expect(
        vi.mocked(setManagedTimer).mock.calls.filter(([name]) => name === 'yt-auto-sync'),
      ).toHaveLength(1);
    });

    it('makes an already queued precision callback inert after a newer seek cancels it', async () => {
      const { setYouTubePlayer } = await import('../_state.ts');
      const { scheduleYtAutoSync } = await import('../player.ts');
      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { setManagedTimer } = await import('../../core/timers.ts');
      const player = makeFakeYtPlayer({ __videoId: 'M7lc1UVf-VE', __state: 1 });
      setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      setPlaybackYouTubePlaying();
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      scheduleYtAutoSync(299);
      const oldCallback = vi
        .mocked(setManagedTimer)
        .mock.calls.find(([name]) => name === 'yt-auto-sync')![1] as () => void;
      scheduleYtAutoSync(0);
      oldCallback();
      expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    });

    it('keeps Standard-host room controls fail-closed while a local edit is unverified', async () => {
      const syncMod = await import('../standard-host-manual-offset-gate.ts');
      const stateMod = await import('../_state.ts');
      const { broadcast } = await import('../../network/peer.ts');
      const { initYouTube, scheduleYtAutoSync } = await import('../player.ts');
      vi.mocked(syncMod.isStandardHostManualOffsetTransactionPending).mockReturnValue(true);
      (window as unknown as { YT: unknown }).YT = { PlayerState: { PLAYING: 1, PAUSED: 2 } };
      (globalThis as unknown as { YT: unknown }).YT = (window as unknown as { YT: unknown }).YT;
      const player = {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        getCurrentTime: vi.fn(() => 12),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        getVideoData: vi.fn(() => ({ video_id: 'VIDEO_ID_01', title: 'Video' })),
      } as unknown as YouTubePlayerInstance;
      stateMod.setYouTubePlayer(player);
      setPlaybackYouTubePlaying();
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'VIDEO_ID_01',
          playlistId: null,
          name: 'Video',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      initYouTube();
      const playTrack = vi.fn();
      bus.on('playlist:play-track', playTrack);

      scheduleYtAutoSync(20);
      bus.emit('youtube:toggle-play');
      bus.emit('youtube:skip-time', 5);
      bus.emit('youtube:seek-to', 30);
      bus.emit('youtube:sub-seek', QUEUE_ITEM_ID, 0, true);

      expect(player.seekTo).not.toHaveBeenCalled();
      expect(player.playVideo).not.toHaveBeenCalled();
      expect(player.pauseVideo).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(playTrack).not.toHaveBeenCalled();
      vi.mocked(syncMod.isStandardHostManualOffsetTransactionPending).mockReturnValue(false);
    });

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

  describe('Standard host own output compensation', () => {
    async function installHost(manual = 0) {
      const stateMod = await import('../_state.ts');
      const localOffset = await import('../local-offset.ts');
      const { cancelYtAutoSync } = await import('../player.ts');
      cancelYtAutoSync();
      localOffset.clearStandardHostYouTubeEndHold();
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('sync.youtubeLocalOffset', manual);
      setState('sync.youtubeCoordinatorAppliedOffset', 0);
      localOffset.recordStandardHostYouTubeAutomaticOffset(0);
      const player = makeFakeYtPlayer({ __videoId: 'VIDEO_ID_01', __state: 1 });
      stateMod.setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      stateMod.setYtLoadInProgress(false);
      return player;
    }

    it.each(
      [false, true].flatMap((android) =>
        [-9.999, -0.4, 0, 0.4, 9.999].map((manual) => ({ android, manual })),
      ),
    )(
      'keeps canonical 20 while the host plays with Android=$android manual=$manual',
      async ({ android, manual }) => {
        playbackPlatform.android = android;
        const player = await installHost(manual);
        const { scheduleYtAutoSync } = await import('../player.ts');
        const { broadcast } = await import('../../network/peer.ts');
        const { toCanonicalYouTubeTime, getStandardHostYouTubeAutomaticOffset } =
          await import('../local-offset.ts');
        const output = android ? 0.25 : 0;
        scheduleYtAutoSync(20, { skipSeek: true });
        const localTarget = 20 + manual + output;
        // A ready 0-offset player may retain skipSeek; all actual local
        // compensation must override it and seek exactly once.
        if (manual + output !== 0) {
          expect(player.__log.filter((call) => call.op === 'seekTo')).toEqual([
            expect.objectContaining({ args: [localTarget, true] }),
          ]);
        } else {
          player.__currentTime = 20;
        }
        expect(getState('sync.youtubeLocalOffset')).toBe(manual);
        expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(manual + output, 8);
        expect(getStandardHostYouTubeAutomaticOffset()).toBeCloseTo(output, 8);
        expect(toCanonicalYouTubeTime(player.getCurrentTime(), 300)).toBeCloseTo(20, 8);
        expect(broadcast).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: MSG.YOUTUBE_STATE, state: 1, time: 20 }),
        );
        // Resume at the already canonical position must not add compensation twice.
        scheduleYtAutoSync(toCanonicalYouTubeTime(player.getCurrentTime(), 300));
        expect(player.getCurrentTime()).toBeCloseTo(localTarget, 8);
        expect(toCanonicalYouTubeTime(player.getCurrentTime(), 300)).toBeCloseTo(20, 8);
      },
    );

    it('holds a negative start while canonical time advances and releases without changing manual input', async () => {
      playbackPlatform.android = true;
      const player = await installHost(-9.999);
      const { scheduleYtAutoSync } = await import('../player.ts');
      const { setManagedTimer } = await import('../../core/timers.ts');
      const { toCanonicalYouTubeTime, isStandardHostYouTubeLocalStartPending } =
        await import('../local-offset.ts');
      scheduleYtAutoSync(0);
      const release = vi
        .mocked(setManagedTimer)
        .mock.calls.find(([name]) => name === 'yt-host-local-start')!;
      expect(release[2]).toBeCloseTo(9749, 6);
      expect(player.getPlayerState()).toBe(2);
      expect(player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
      vi.advanceTimersByTime(2000);
      expect(toCanonicalYouTubeTime(0, 300)).toBeCloseTo(2, 8);
      expect(isStandardHostYouTubeLocalStartPending()).toBe(true);
      vi.advanceTimersByTime(7749);
      (release[1] as () => void)();
      expect(player.getPlayerState()).toBe(1);
      expect(getState('sync.youtubeLocalOffset')).toBe(-9.999);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(-9.749, 8);
      expect(toCanonicalYouTubeTime(0, 300)).toBeCloseTo(9.749, 8);
      expect(isStandardHostYouTubeLocalStartPending()).toBe(false);
    });

    it.each(['pause', 'seek'] as const)(
      'makes an obsolete negative release inert after %s',
      async (action) => {
        playbackPlatform.android = true;
        const player = await installHost(-9.999);
        const { initYouTube, scheduleYtAutoSync } = await import('../player.ts');
        const { setManagedTimer } = await import('../../core/timers.ts');
        const { toCanonicalYouTubeTime, isStandardHostYouTubeLocalStartPending } =
          await import('../local-offset.ts');
        (globalThis as unknown as { YT: unknown }).YT = { PlayerState: { PLAYING: 1, PAUSED: 2 } };
        initYouTube();
        scheduleYtAutoSync(0);
        const release = vi
          .mocked(setManagedTimer)
          .mock.calls.find(([name]) => name === 'yt-host-local-start')![1] as () => void;
        vi.advanceTimersByTime(2000);
        if (action === 'pause') bus.emit('youtube:toggle-play');
        else scheduleYtAutoSync(30);
        const calls = player.__log.length;
        release();
        expect(player.__log).toHaveLength(calls);
        expect(player.getPlayerState()).toBe(action === 'pause' ? 2 : 1);
        expect(toCanonicalYouTubeTime(player.getCurrentTime(), 300)).toBeCloseTo(
          action === 'pause' ? 2 : 30,
          8,
        );
        expect(getState('sync.youtubeLocalOffset')).toBe(-9.999);
        expect(isStandardHostYouTubeLocalStartPending()).toBe(false);
      },
    );

    it.each(
      ['output-tail', 'negative-start'].flatMap((hold) =>
        ['absolute', 'relative'].map((seek) => ({ hold, seek })),
      ),
    )('preserves playing intent when $seek seeking during $hold', async ({ hold, seek }) => {
      playbackPlatform.android = true;
      const player = await installHost(hold === 'negative-start' ? -9.999 : 0);
      const { initYouTube, scheduleYtAutoSync } = await import('../player.ts');
      const timers = await import('../../core/timers.ts');
      const { broadcast } = await import('../../network/peer.ts');
      const offsets = await import('../local-offset.ts');
      (globalThis as unknown as { YT: unknown }).YT = {
        PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 },
      };
      initYouTube();
      let oldLocalRelease: (() => void) | undefined;
      if (hold === 'negative-start') {
        scheduleYtAutoSync(0);
        oldLocalRelease = vi
          .mocked(timers.setManagedTimer)
          .mock.calls.find(([name]) => name === 'yt-host-local-start')![1] as () => void;
        vi.advanceTimersByTime(2_000);
        expect(offsets.isStandardHostYouTubeLocalStartPending()).toBe(true);
      } else {
        player.__currentTime = 300;
        player.__state = 0;
        setState('sync.youtubeCoordinatorAppliedOffset', 0.25);
        offsets.recordStandardHostYouTubeAutomaticOffset(0.25);
        offsets.beginStandardHostYouTubeEndHold(299.75, 300, () => player.__state === 0);
        expect(offsets.isStandardHostYouTubeEndHoldActive()).toBe(true);
      }
      const before = offsets.toCanonicalYouTubeTime(player.getCurrentTime(), 300);
      const relative = hold === 'negative-start' ? 30 : -30;
      const expectedTarget = seek === 'absolute' ? 30 : before + relative;
      vi.mocked(broadcast).mockClear();
      vi.mocked(timers.setManagedTimer).mockClear();
      if (seek === 'absolute') bus.emit('youtube:seek-to', expectedTarget);
      else bus.emit('youtube:skip-time', relative);

      expect(broadcast).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: MSG.YOUTUBE_STATE, state: 1, time: expectedTarget }),
      );
      expect(player.getPlayerState()).toBe(1);
      expect(offsets.toCanonicalYouTubeTime(player.getCurrentTime(), 300)).toBeCloseTo(
        expectedTarget,
        8,
      );
      expect(offsets.isStandardHostYouTubeEndHoldActive()).toBe(false);
      expect(offsets.isStandardHostYouTubeLocalStartPending()).toBe(false);
      expect(timers.clearManagedTimer).toHaveBeenCalledWith(
        offsets.STANDARD_HOST_YOUTUBE_END_HOLD_TIMER,
      );
      const staleRendezvous = vi
        .mocked(timers.setManagedTimer)
        .mock.calls.find(([name]) => name === 'yt-auto-sync')![1] as () => void;
      bus.emit('youtube:toggle-play');
      const physicalCalls = player.__log.length;
      const messages = vi.mocked(broadcast).mock.calls.length;
      oldLocalRelease?.();
      staleRendezvous();
      expect(player.getPlayerState()).toBe(2);
      expect(player.__log).toHaveLength(physicalCalls);
      expect(broadcast).toHaveBeenCalledTimes(messages);
    });

    it('retires real legacy release callbacks when a manual edit takes over a negative start', async () => {
      playbackPlatform.android = true;
      const player = await installHost(-9.999);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'VIDEO_ID_01',
          playlistId: null,
          name: 'Video',
        },
      ]);
      const { scheduleYtAutoSync } = await import('../player.ts');
      const { beginStandardHostManualOffsetTransaction } =
        await import('../standard-host-manual-offset-runtime.ts');
      const offsets = await import('../local-offset.ts');
      const timers = await import('../../core/timers.ts');
      const actualTimers = await vi.importActual<typeof timers>('../../core/timers.ts');
      const { broadcast } = await import('../../network/peer.ts');
      const hooks: import('../standard-host-manual-offset-gate.ts').StandardHostManualOffsetRuntimeHooks[] =
        [];
      let current = true;
      vi.mocked(timers.setManagedTimer).mockImplementation(actualTimers.setManagedTimer);
      vi.mocked(timers.clearManagedTimer).mockImplementation(actualTimers.clearManagedTimer);
      vi.mocked(timers.getManagedTimer).mockImplementation(actualTimers.getManagedTimer);
      try {
        scheduleYtAutoSync(0);
        const oldRelease = vi
          .mocked(timers.setManagedTimer)
          .mock.calls.find(([name]) => name === 'yt-host-local-start')![1];
        const oldBroadcast = vi
          .mocked(timers.setManagedTimer)
          .mock.calls.find(([name]) => name === 'yt-auto-sync')![1];
        vi.advanceTimersByTime(1_000);
        beginStandardHostManualOffsetTransaction({
          generation: 1,
          player: player as unknown as YouTubePlayerInstance,
          requestedOffsetSeconds: 0,
          priorRequestedOffset: -9.999,
          priorAppliedOffset: -9.749,
          scheduled: true,
          isCurrent: () => current,
          publishRequestedOffset: (value) => setState('sync.youtubeLocalOffset', value),
          bindRuntimeHooks: (value) => {
            hooks.push(value);
            return true;
          },
          commit: (action) => {
            action();
            current = false;
            return true;
          },
          restorePrevious: () => false,
        });
        expect(hooks[0].readPlaybackIntent()).toBe(true);
        expect(offsets.isStandardHostYouTubeLocalStartPending()).toBe(false);
        expect(offsets.toCanonicalYouTubeTime(player.getCurrentTime(), 300)).toBeCloseTo(1, 8);
        expect(actualTimers.getManagedTimer('yt-host-local-start')).toBeNull();
        expect(actualTimers.getManagedTimer('yt-auto-sync')).toBeNull();
        const calls = player.__log.length;
        const messages = vi.mocked(broadcast).mock.calls.length;
        oldRelease();
        oldBroadcast();
        expect(player.__log).toHaveLength(calls);
        expect(broadcast).toHaveBeenCalledTimes(messages);
        expect(getState('sync.youtubeLocalOffset')).toBe(0);
      } finally {
        current = false;
        hooks[0]?.reset();
        actualTimers.clearAllManagedTimers();
        vi.mocked(timers.setManagedTimer).mockReset();
        vi.mocked(timers.clearManagedTimer).mockReset();
        vi.mocked(timers.getManagedTimer).mockReset().mockReturnValue(null);
      }
    });
  });

  describe('PRO participant canonical controls', () => {
    const observationCases: Array<{
      scenario: string;
      playbackLatencyMs: number;
      nextReleaseDelayMs: number;
      roomEpoch: number;
      callbackDelayMs?: number;
      timingMode?: 'zero-start' | 'scheduled-control';
      ackDelayMs?: number;
    }> = [
      { scenario: 'stable', playbackLatencyMs: 100, nextReleaseDelayMs: 675, roomEpoch: 7 },
      {
        scenario: 'collapsed callbacks',
        playbackLatencyMs: 100,
        nextReleaseDelayMs: 700,
        roomEpoch: 8,
      },
      {
        scenario: 'NaN media clock',
        playbackLatencyMs: 800,
        nextReleaseDelayMs: 700,
        roomEpoch: 9,
      },
      {
        scenario: 'infinite media clock',
        playbackLatencyMs: 800,
        nextReleaseDelayMs: 700,
        roomEpoch: 10,
      },
      {
        scenario: 'uncorrected callback jitter',
        playbackLatencyMs: 0,
        nextReleaseDelayMs: 700,
        roomEpoch: 11,
        callbackDelayMs: 30,
      },
      {
        scenario: 'uncorrected jitter plus real media latency',
        playbackLatencyMs: 100,
        nextReleaseDelayMs: 675,
        roomEpoch: 12,
        callbackDelayMs: 30,
      },
      {
        scenario: 'caught-up callback delay',
        playbackLatencyMs: 0,
        nextReleaseDelayMs: 700,
        roomEpoch: 13,
        callbackDelayMs: 80,
      },
      {
        scenario: 'caught-up delay plus real media latency',
        playbackLatencyMs: 100,
        nextReleaseDelayMs: 675,
        roomEpoch: 14,
        callbackDelayMs: 80,
      },
      {
        scenario: 'scheduled-control observation only',
        playbackLatencyMs: 100,
        nextReleaseDelayMs: 700,
        roomEpoch: 15,
        timingMode: 'scheduled-control',
      },
      {
        scenario: 'late PLAYING acknowledgement',
        playbackLatencyMs: 100,
        nextReleaseDelayMs: 700,
        roomEpoch: 16,
        ackDelayMs: 1_100,
      },
      {
        scenario: 'changed manual offset',
        playbackLatencyMs: 100,
        nextReleaseDelayMs: 700,
        roomEpoch: 17,
      },
    ];
    it.each(observationCases)(
      'learns only from independent finite PRO observations: $scenario',
      async ({
        scenario,
        playbackLatencyMs,
        nextReleaseDelayMs,
        roomEpoch,
        callbackDelayMs = 0,
        timingMode = 'zero-start',
        ackDelayMs = 0,
      }) => {
        const stateMod = await import('../_state.ts');
        const { applyProPlaybackYouTubeCommit } = await import('../player.ts');
        const iframe = await import('../iframe.ts');
        const { cancelYouTubeAuthorityPreparation, prepareYouTubeAuthorityOccurrence } = iframe;
        let muted = false;
        let volume = 60;
        let playerState = 2;
        let baseTime = 0;
        let playAtMs = 0;
        const playCallsMs: number[] = [];
        const currentTime = () =>
          playerState === 1
            ? baseTime + Math.max(0, performance.now() - playAtMs - playbackLatencyMs) / 1_000
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
          epoch: roomEpoch,
          snapshotRevision: 1,
          capabilities: ['playback.control'],
        });
        setPlaybackYouTubePlaying();

        const run = async (basePlaybackRevision: number) => {
          const authority = createProPlaybackAuthorityToken({
            roomId: '000001',
            roomEpoch,
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
          if (basePlaybackRevision === 1 && callbackDelayMs > 0) {
            const schedule = globalThis.setTimeout;
            let delayed = false;
            vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
              if (!delayed && ms === 700) {
                delayed = true;
                return schedule(callback, ms + callbackDelayMs, ...args);
              }
              return schedule(callback, ms, ...args);
            });
          }
          if (basePlaybackRevision === 1 && ackDelayMs > 0) {
            const commit = iframe.commitYouTubeAuthorityOccurrence;
            vi.spyOn(iframe, 'commitYouTubeAuthorityOccurrence').mockImplementationOnce(
              async (request) => {
                const result = await commit(request);
                await new Promise((resolve) => setTimeout(resolve, ackDelayMs));
                return result.status === 'applied'
                  ? {
                      ...result,
                      playingAtMs: performance.now(),
                      callToPlayingMs: result.callToPlayingMs + ackDelayMs,
                    }
                  : result;
              },
            );
          }
          const applying = applyProPlaybackYouTubeCommit({
            authority,
            committedPlaybackRevision: basePlaybackRevision + 1,
            queueItemId: QUEUE_ITEM_ID,
            state: 'playing',
            positionSeconds: 0,
            scheduleDelayMs: 700,
            timingMode: basePlaybackRevision === 1 ? timingMode : 'zero-start',
            youtubeSubIndex: 0,
            youtubeVideoId: 'video-1',
            isCurrent: () => true,
          });
          return { applying, startedAtMs };
        };

        const first = await run(1);
        await vi.advanceTimersByTimeAsync(700 + callbackDelayMs + ackDelayMs);
        await expect(first.applying).resolves.toBe(true);
        expect(playCallsMs.at(-1)! - first.startedAtMs).toBe(700 + callbackDelayMs);

        vi.mocked(player.getCurrentTime).mockClear();
        if (scenario === 'collapsed callbacks') {
          // Model both due callbacks observing the same instant after a
          // foreground event-loop stall. Their intended labels stay 0.8s/2s.
          const observedAtMs = first.startedAtMs + 700 + 2_000;
          const clock = vi.spyOn(performance, 'now').mockReturnValue(observedAtMs);
          await vi.advanceTimersByTimeAsync(2_000);
          clock.mockRestore();
        } else {
          if (scenario === 'NaN media clock' || scenario === 'infinite media clock') {
            const earlyAtMs = first.startedAtMs + 700 + 800;
            vi.mocked(player.getCurrentTime).mockImplementation(() =>
              performance.now() === earlyAtMs
                ? scenario === 'NaN media clock'
                  ? Number.NaN
                  : Number.POSITIVE_INFINITY
                : currentTime(),
            );
          }
          if (scenario === 'changed manual offset') setState('sync.youtubeLocalOffset', 0.2);
          await vi.advanceTimersByTimeAsync(2_000);
        }
        // Canonical conversion must use the same validated raw observation.
        expect(player.getCurrentTime).toHaveBeenCalledTimes(
          scenario === 'changed manual offset' ? 0 : 2,
        );
        const observations = getProStartObservations();
        const samples = observations.filter((entry) => entry.kind === 'youtube-sample');
        expect(samples).toHaveLength(2);
        const learning = observations.find((entry) => entry.kind === 'youtube-learning');
        if (callbackDelayMs > 0) {
          expect(
            observations.find((entry) => entry.kind === 'youtube-release')?.detail,
          ).toMatchObject({
            rawReleaseLatenessMs: callbackDelayMs,
            appliedReleaseLatenessMs: callbackDelayMs > 40 ? callbackDelayMs : 0,
            uncorrectedCallbackLatenessMs: callbackDelayMs > 40 ? 0 : callbackDelayMs,
            acknowledgementOnly: true,
          });
          expect(samples[0].detail.timelineDriftMs).toBeCloseTo(
            -playbackLatencyMs - (callbackDelayMs > 40 ? 0 : callbackDelayMs),
            6,
          );
          expect(samples[0].detail.learningDriftMs).toBeCloseTo(-playbackLatencyMs, 6);
        }
        if (timingMode === 'scheduled-control') {
          expect(samples[0].detail).toMatchObject({
            learningEnabled: false,
            learningDriftMs: null,
          });
          expect(samples[0].detail.timelineDriftMs).toBeCloseTo(-100, 6);
          expect(learning?.detail.reason).toBe('scheduled-control-observation-only');
        }
        if (ackDelayMs > 0) {
          expect(samples[0].detail.elapsedSinceStartMs).toBeGreaterThanOrEqual(1_100);
          expect(samples[0].detail.checkpointLatenessMs).toBeGreaterThanOrEqual(300);
          expect(samples[1].detail.elapsedSinceStartMs).toBe(2_000);
          expect(learning?.detail.reason).toBe('invalid-sample');
        }
        if (scenario === 'NaN media clock' || scenario === 'infinite media clock') {
          expect(samples[0].detail).toMatchObject({
            rawPositionSeconds: null,
            timelineDriftMs: null,
            reason: 'invalid-position',
            eligible: false,
          });
        }
        if (scenario === 'changed manual offset') {
          expect(samples[0].detail).toMatchObject({
            reason: 'identity-mismatch',
            offsetMatches: false,
            rawPositionSeconds: null,
          });
          setState('sync.youtubeLocalOffset', 0);
        }

        const second = await run(3);
        const callsBeforeRelease = playCallsMs.length;
        await vi.advanceTimersByTimeAsync(nextReleaseDelayMs - 1);
        expect(playCallsMs).toHaveLength(callsBeforeRelease);
        await vi.advanceTimersByTimeAsync(1);
        await expect(second.applying).resolves.toBe(true);
        // Only the valid stable 100ms residual advances the next start by 25ms.
        expect(playCallsMs.at(-1)! - second.startedAtMs).toBe(nextReleaseDelayMs);
        cancelYouTubeAuthorityPreparation();
      },
    );

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
      setState('youtube.subItemsMap', {
        'playlist-1': { ids: ['video-1', 'video-2'], titles: [], manifestComplete: true },
      });
      setState('room.context', {
        kind: 'standard',
        roomId: '123456',
        role: 'coordinator',
        coordinatorId: null,
        epoch: 0,
        snapshotRevision: 0,
        capabilities: [],
      });
      const selectTrack = vi.fn();
      bus.on('playlist:play-track', selectTrack);
      initYouTube();
      const callback = vi.fn();

      bus.emit('youtube:try-next-internal', callback);

      expect(callback).toHaveBeenCalledWith(true);
      expect(selectTrack).toHaveBeenCalledWith(QUEUE_ITEM_ID, 1, {
        navigateToPlay: false,
      });
      expect(player.loadVideoById).not.toHaveBeenCalled();
    });

    it('hands a playlist sub-row to the canonical loader while a local file owns playback', async () => {
      const { initYouTube } = await import('../player.ts');
      const localQueueItemId = '66666666-6666-4666-8666-666666666666';
      setState('playlist.items', [
        {
          queueItemId: localQueueItemId,
          type: 'file',
          name: 'local.mp3',
          title: 'Local',
          videoId: null,
          playlistId: null,
        },
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: 'video-1',
          playlistId: 'playlist-1',
          name: 'Playlist',
        },
      ] satisfies PlaylistItem[]);
      setState('playlist.currentQueueItemId', localQueueItemId);
      setState('youtube.subItemsMap', {
        'playlist-1': { ids: ['video-1', 'video-2'], titles: ['First', 'Second'] },
      });
      const selectTrack = vi.fn();
      bus.on('playlist:play-track', selectTrack);
      initYouTube();

      bus.emit('youtube:sub-seek', SECOND_QUEUE_ITEM_ID, 1, false);

      expect(selectTrack).toHaveBeenCalledWith(SECOND_QUEUE_ITEM_ID, 1, {
        navigateToPlay: true,
      });
    });

    it('hands a current-playlist sub-row to the canonical loader without a raw iframe load', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer, setYouTubeSubIndex } = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 12),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        getVideoData: vi.fn(() => ({ video_id: 'video-1', title: 'First' })),
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
      setState('youtube.subItemsMap', {
        'playlist-1': { ids: ['video-1', 'video-2'], titles: ['First', 'Second'] },
      });
      setState('room.context', {
        kind: 'standard',
        roomId: '123456',
        role: 'coordinator',
        coordinatorId: null,
        epoch: 0,
        snapshotRevision: 0,
        capabilities: [],
      });
      const selectTrack = vi.fn();
      bus.on('playlist:play-track', selectTrack);
      initYouTube();

      bus.emit('youtube:sub-seek', QUEUE_ITEM_ID, 1, true);

      expect(selectTrack).toHaveBeenCalledWith(QUEUE_ITEM_ID, 1, {
        navigateToPlay: false,
      });
      expect(player.loadVideoById).not.toHaveBeenCalled();
      expect(getState('youtube.currentSubIndex')).toBe(0);
    });
  });

  describe('external zero-start fallback after a local delay', () => {
    it.each(
      ['late-timer', 'late-playing-ack', 'late-media-start'].flatMap((delay) =>
        [-9.999, -0.4, 0, 0.4, 9.999].map((manual) => ({ delay, manual })),
      ),
    )(
      'records the actual host zero-start residual for $delay / manual $manual',
      async ({ delay, manual }) => {
        playbackPlatform.android = true;
        const stateMod = await import('../_state.ts');
        const playerMod = await import('../player.ts');
        const controller = await import('../zero-start.ts');
        const timers = await import('../../core/timers.ts');
        const realTimers =
          await vi.importActual<typeof import('../../core/timers.ts')>('../../core/timers.ts');
        const clock = await import('../../network/shared-clock.ts');
        const { safeSend } = await import('../../network/peer.ts');
        const { toCanonicalYouTubeTime, getStandardHostYouTubeAutomaticOffset } =
          await import('../local-offset.ts');
        vi.mocked(timers.setManagedTimer).mockImplementation(realTimers.setManagedTimer);
        vi.mocked(timers.clearManagedTimer).mockImplementation(realTimers.clearManagedTimer);
        vi.mocked(timers.getManagedTimer).mockImplementation(realTimers.getManagedTimer);
        vi.mocked(safeSend).mockReturnValue(true);
        vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
        const videoId = 'M7lc1UVf-VE';
        const guestId = 'ready-output-guest';
        setState('network.appRole', 'host');
        setState('network.myId', 'output-host');
        setState('network.sessionCode', '123456');
        setState('setup.sessionStarted', true);
        setState('network.activeHostConnByPeerId', new Map([[guestId, dataConnection(guestId)]]));
        setState('sync.youtubeLocalOffset', manual);
        setState('playlist.items', [
          {
            queueItemId: QUEUE_ITEM_ID,
            type: 'youtube',
            videoId,
            playlistId: null,
            name: 'Host output',
          },
        ]);
        setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
        setPlaybackYouTubePlaying();
        const player = makeFakeYtPlayer({
          __videoId: videoId,
          __state: 2,
          __advanceClock: true,
          __autoPlayOnLoad: true,
        });
        player.__onStateChange = (event) => {
          if (
            delay === 'late-playing-ack' &&
            event.data === 1 &&
            controller.getYouTubeZeroStartSnapshot()?.phase === 'starting'
          ) {
            setTimeout(() => controller.handleYouTubeZeroStartPlayerState(event.data), 30);
          } else {
            controller.handleYouTubeZeroStartPlayerState(event.data);
          }
        };
        const immediatePlay = player.playVideo;
        player.playVideo = () => {
          if (
            delay === 'late-media-start' &&
            controller.getYouTubeZeroStartSnapshot()?.phase === 'starting'
          ) {
            setTimeout(immediatePlay, 30);
          } else immediatePlay();
        };
        stateMod.setYouTubePlayer(player as unknown as YouTubePlayerInstance);
        stateMod.setYtLoadInProgress(false);
        expect(stateMod.markYtPlayerReady(player as unknown as YouTubePlayerInstance)).toBe(true);
        clock.resetClockState();
        playerMod.initYouTube();
        try {
          expect(
            controller.handleYouTubeZeroStartCapability(guestId, {
              type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
              version: 2,
              ready: true,
              platform: 'other',
            }),
          ).toBe(true);
          expect(
            controller.beginYouTubeZeroStart({
              queueItemId: QUEUE_ITEM_ID,
              videoId,
              subIndex: null,
            }),
          ).toBe(true);
          for (
            let i = 0;
            i < 120 && controller.getYouTubeZeroStartSnapshot()?.phase !== 'scheduled';
            i++
          ) {
            await vi.advanceTimersByTimeAsync(25);
          }
          expect(controller.getYouTubeZeroStartSnapshot()?.phase).toBe('scheduled');
          const commit = vi
            .mocked(safeSend)
            .mock.calls.map(([, frame]) => frame)
            .find((frame) => frame.type === MSG.YOUTUBE_ZERO_START_COMMIT);
          if (!commit || commit.type !== MSG.YOUTUBE_ZERO_START_COMMIT)
            throw new Error('Expected host COMMIT');
          if (delay === 'late-timer') vi.setSystemTime(Date.now() + 30);
          await vi.advanceTimersByTimeAsync(12_000);
          const residual = manual + (delay === 'late-playing-ack' ? 0.25 : 0.22);
          expect(player.getPlayerState()).toBe(1);
          expect(getState('sync.youtubeLocalOffset')).toBe(manual);
          expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(residual, 7);
          expect(getStandardHostYouTubeAutomaticOffset()).toBeCloseTo(residual - manual, 7);
          expect(toCanonicalYouTubeTime(player.getCurrentTime(), player.getDuration())).toBeCloseTo(
            (Date.now() - commit.startAtHost) / 1000,
            7,
          );
        } finally {
          playerMod.stopYouTubeMode();
          controller.resetYouTubeZeroStart();
          realTimers.clearAllManagedTimers();
          vi.mocked(timers.setManagedTimer).mockReset();
          vi.mocked(timers.clearManagedTimer).mockReset();
          vi.mocked(timers.getManagedTimer).mockReset().mockReturnValue(null);
          vi.mocked(safeSend).mockReset();
          stateMod.setYouTubePlayer(null);
          clock.resetClockState();
        }
      },
    );

    async function installDelayedFallback(
      offset: number,
      unmuteDelayMs: number,
      hostPlatform: 'android' | 'other' = 'other',
      readyAfterMs = 0,
    ) {
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
      vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
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
          hostPlatform,
        }),
      ).toBe(true);
      expect(
        controller.handleYouTubeZeroStartCommit(hostPeerId, {
          ...run,
          type: MSG.YOUTUBE_ZERO_START_COMMIT,
          startAtHost: prepareAtHost + 1_000,
          reason: 'guest-timeout',
          cohort: [hostPeerId],
        }),
      ).toBe(true);

      if (readyAfterMs) await vi.advanceTimersByTimeAsync(readyAfterMs);
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
        prepareAtHost,
        releaseAfterMs: 1_000 - offset * 1_000,
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

    it.each([
      { android: true, host: 'other' as const, offset: 0, ready: 0 },
      { android: false, host: 'android' as const, offset: 0, ready: 0 },
      { android: true, host: 'android' as const, offset: 0, ready: 0 },
      { android: true, host: 'other' as const, offset: -1, ready: 0 },
      { android: true, host: 'other' as const, offset: 9.999, ready: 0 },
      { android: false, host: 'android' as const, offset: -9.999, ready: 0 },
      { android: true, host: 'other' as const, offset: 0, ready: 1_700 },
      { android: false, host: 'android' as const, offset: 0, ready: 1_700 },
    ])(
      'keeps audible output aligned after external fallback $android/$host offset $offset ready $ready',
      async ({ android, host, offset, ready }) => {
        playbackPlatform.android = android;
        const test = await installDelayedFallback(offset, 0, host, ready);
        try {
          await vi.advanceTimersByTimeAsync(13_000);
          const plays = test.player.__log.filter(({ op }) => op === 'playVideo');
          expect(plays).toHaveLength(1);
          const guestOutputSeconds = android ? 0.25 : 0;
          const canonical = (Date.now() - test.prepareAtHost - 1_000) / 1000;
          expect(test.player.getCurrentTime() - guestOutputSeconds).toBeCloseTo(
            canonical + offset,
            5,
          );
          expect(getState('sync.youtubeLocalOffset')).toBe(offset);
          expect(test.playerMod.isYouTubeZeroStartExternalFallbackActive()).toBe(false);
        } finally {
          test.cleanup();
        }
      },
    );

    it.each([0, -5, -9.999])(
      'allows asynchronous audio restoration after offset %s waits past preparation',
      async (offset) => {
        const test = await installDelayedFallback(offset, 30);
        try {
          await vi.advanceTimersByTimeAsync(test.releaseAfterMs - 1);
          expect(test.player.__log.filter(({ op }) => op === 'playVideo')).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(301);
          expect(test.player.__log.filter(({ op }) => op === 'playVideo')).toHaveLength(1);
          expect(test.player.getPlayerState()).toBe(1);
          expect(test.player.isMuted()).toBe(false);
          expect(test.playerMod.isYouTubeZeroStartExternalFallbackActive()).toBe(false);
        } finally {
          test.cleanup();
        }
      },
    );

    it('cancels a delayed fallback while its asynchronous audio restore is pending', async () => {
      const test = await installDelayedFallback(-5, 30);
      try {
        await vi.advanceTimersByTimeAsync(test.releaseAfterMs + 1);
        expect(test.player.__log.filter(({ op }) => op === 'playVideo')).toHaveLength(0);
        test.playerMod.stopYouTubeMode();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(test.player.__log.filter(({ op }) => op === 'playVideo')).toHaveLength(0);
        expect(test.playerMod.isYouTubeZeroStartExternalFallbackActive()).toBe(false);
      } finally {
        test.cleanup();
      }
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
    it('retires legacy guest sync before repositioning the same resident video for a new run', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer, markYtPlayerReady, setYtLoadInProgress, setYtPrimed } =
        await import('../_state.ts');
      const { invalidateGuestYouTubeTimeline } = await import('../sync.ts');
      const zeroStart = await import('../zero-start.ts');
      const hostConnection = dataConnection('repeat-host');
      const videoId = 'M7lc1UVf-VE';
      const player = makeFakeYtPlayer({
        __videoId: videoId,
        __state: 2,
        __autoPlayOnLoad: true,
      });
      setState('network.appRole', 'guest');
      setState('network.myId', 'repeat-guest');
      setState('network.hostConn', hostConnection);
      setState('playlist.items', [
        { queueItemId: QUEUE_ITEM_ID, type: 'youtube', videoId, playlistId: null, name: 'Repeat' },
      ]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setPlaybackYouTubePlaying();
      setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      markYtPlayerReady(player as unknown as YouTubePlayerInstance);
      setYtLoadInProgress(false);
      setYtPrimed(true);
      initYouTube();
      player.__onStateChange = ({ data }) => zeroStart.handleYouTubeZeroStartPlayerState(data);
      vi.mocked(invalidateGuestYouTubeTimeline).mockClear();
      const seek = vi.spyOn(player, 'seekTo');
      const now = Date.now();
      try {
        expect(
          zeroStart.handleYouTubeZeroStartPrepare(hostConnection.peer, {
            type: MSG.YOUTUBE_ZERO_START_PREPARE,
            version: 1,
            runId: 'same-video-repeat-boundary',
            sequence: 1,
            queueItemId: QUEUE_ITEM_ID,
            videoId,
            subIndex: null,
            prepareAtHost: now,
            decisionAtHost: now + 2_300,
            startDeadlineAtHost: now + 3_000,
            hostPlatform: 'other',
          }),
        ).toBe(true);
        expect(invalidateGuestYouTubeTimeline).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(620);
        expect(seek).toHaveBeenCalled();
        expect(vi.mocked(invalidateGuestYouTubeTimeline).mock.invocationCallOrder[0]).toBeLessThan(
          seek.mock.invocationCallOrder[0]!,
        );
      } finally {
        zeroStart.cancelYouTubeZeroStart('cancelled', false);
        setYouTubePlayer(null);
      }
    });

    it('routes host YouTube repeat-one through the synchronized auto-play path', async () => {
      const { loadYouTubeVideo } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      setYouTubePlayer(null);

      const wrapper = document.createElement('div');
      wrapper.className = 'video-wrapper';
      document.body.appendChild(wrapper);

      let onStateChange:
        ((event: { data: number; target: YouTubePlayerInstance }) => void) | undefined;
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

    it('defers one ended repeat until a Standard-host manual edit settles', async () => {
      const { loadYouTubeVideo } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const {
        afterStandardHostManualOffsetTransaction,
        isStandardHostManualOffsetTransactionPending,
      } = await import('../standard-host-manual-offset-gate.ts');
      setYouTubePlayer(null);

      const wrapper = document.createElement('div');
      wrapper.className = 'video-wrapper';
      document.body.appendChild(wrapper);

      let onStateChange:
        ((event: { data: number; target: YouTubePlayerInstance }) => void) | undefined;
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
      bus.on('youtube:auto-play', autoPlaySpy);
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
      vi.mocked(isStandardHostManualOffsetTransactionPending).mockReturnValue(true);
      onStateChange?.({ data: 0, target: player });

      expect(autoPlaySpy).not.toHaveBeenCalled();
      const deferredRepeat = vi
        .mocked(afterStandardHostManualOffsetTransaction)
        .mock.calls.at(-1)?.[0];
      expect(deferredRepeat).toBeTypeOf('function');

      vi.mocked(isStandardHostManualOffsetTransactionPending).mockReturnValue(false);
      deferredRepeat?.();
      expect(autoPlaySpy).toHaveBeenCalledTimes(1);
      expect(autoPlaySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          targetTime: 0,
          skipSeek: false,
          isTrackTransition: false,
          zeroStart: true,
        }),
      );

      // A stale duplicate timer callback cannot replay the same ENDED intent.
      deferredRepeat?.();
      expect(autoPlaySpy).toHaveBeenCalledTimes(1);
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
      const { setYouTubePlayer, markYtPlayerReady } = await import('../_state.ts');
      const readyPlayer = makeFakeYtPlayer({
        __videoId: 'VIDEO_ID_01',
      }) as unknown as YouTubePlayerInstance;
      setYouTubePlayer(readyPlayer);
      // Consumption is gated, but the current pending intent survives until READY.
      expect(consumePendingAutoSyncOnReady()).toBeNull();
      expect(markYtPlayerReady(readyPlayer)).toBe(true);
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
      bus.emit('youtube:search-from-input');
      bus.emit('youtube:load-from-input');

      expect(showToast).toHaveBeenCalledTimes(3);
      expect(showToast).toHaveBeenNthCalledWith(1, 'toast.media_management_required');
      expect(showToast).toHaveBeenNthCalledWith(2, 'toast.media_management_required');
      expect(showToast).toHaveBeenNthCalledWith(3, 'toast.media_management_required');
      const search = await import('../search.ts');
      expect(search.searchYouTubeFromInput).not.toHaveBeenCalled();
      expect(addYouTube).not.toHaveBeenCalled();
      expect(getState('playlist.items')).toEqual([]);
    });

    it('keeps the dedicated search action separate from adding a selected result', async () => {
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = 'city pop live';
      document.body.appendChild(input);
      const search = await import('../search.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();

      bus.emit('youtube:search-from-input');

      expect(search.searchYouTubeFromInput).toHaveBeenCalledOnce();
      expect(search.searchYouTubeFromInput).toHaveBeenCalledWith('city pop live');
      expect(search.getSelectedYouTubeSearchResult).not.toHaveBeenCalled();
      expect(getState('playlist.items')).toEqual([]);
    });

    it('resolves the complete 248-item manifest before adding without a preview cache', async () => {
      const search = await import('../search.ts');
      const ids = Array.from(
        { length: 248 },
        (_, index) => `video${String(index).padStart(6, '0')}`,
      );
      const input = document.createElement('div');
      input.id = 'youtube-url-input';
      input.textContent = 'https://www.youtube.com/playlist?list=PL_COMPLETE';
      document.body.appendChild(input);
      vi.mocked(search.getYouTubeInputIntent).mockReturnValueOnce({
        kind: 'playlist-url',
        raw: input.textContent,
        videoId: null,
        playlistId: 'PL_COMPLETE',
        query: null,
      });
      vi.mocked(search.resolveYouTubePlaylistManifest).mockResolvedValueOnce({
        playlistId: 'PL_COMPLETE',
        videoId: ids[0],
        videoIds: ids,
        title: 'Complete playlist',
      });
      const { initYouTube } = await import('../player.ts');
      initYouTube();
      bus.emit('youtube:load-from-input');
      await vi.waitFor(() => expect(getState('playlist.items')).toHaveLength(1));
      expect(getState('youtube.subItemsMap').PL_COMPLETE).toMatchObject({
        ids,
        manifestComplete: true,
      });
      const peer = await import('../../network/peer.ts');
      expect(peer.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_PLAYLIST_INFO,
          ids,
        }),
      );
    });

    it.each(['input', 'chat'] as const)(
      'acquires a watch+list manifest via %s without interrupting existing playback',
      async (path) => {
        const search = await import('../search.ts');
        const ids = Array.from(
          { length: 248 },
          (_, index) => `video${String(index).padStart(6, '0')}`,
        );
        const sourceUrl = `https://www.youtube.com/watch?v=${ids[201]}&list=PL_BACKGROUND`;
        let finish!: (value: import('../search.ts').YouTubePlaylistManifest) => void;
        vi.mocked(search.resolveYouTubePlaylistManifest).mockReturnValueOnce(
          new Promise((resolve) => {
            finish = resolve;
          }),
        );
        vi.mocked(search.extractYouTubePlaylistId).mockReturnValueOnce('PL_BACKGROUND');
        setState('playlist.items', [
          {
            queueItemId: QUEUE_ITEM_ID,
            type: 'file',
            name: 'Playing.mp3',
            videoId: null,
            playlistId: null,
          },
        ]);
        setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
        setPlaybackFilePlaying();
        const stop = vi.fn();
        bus.on('player:stop-all-media', stop);
        const { initYouTube } = await import('../player.ts');
        initYouTube();
        if (path === 'input') {
          const input = document.createElement('div');
          input.id = 'youtube-url-input';
          input.textContent = sourceUrl;
          document.body.appendChild(input);
          vi.mocked(search.getYouTubeInputIntent).mockReturnValueOnce({
            kind: 'video-url',
            raw: sourceUrl,
            videoId: ids[201],
            playlistId: 'PL_BACKGROUND',
            query: null,
          });
          bus.emit('youtube:load-from-input');
        } else bus.emit('youtube:load-from-chat', sourceUrl);
        expect(getState('playlist.items')).toHaveLength(1);
        expect(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
        expect(stop).not.toHaveBeenCalled();
        finish({
          playlistId: 'PL_BACKGROUND',
          videoId: ids[0],
          videoIds: ids,
          title: 'Full playlist',
        });
        await vi.waitFor(() => expect(getState('playlist.items')).toHaveLength(2));
        expect(getState('playlist.items')[1]).toMatchObject({
          videoId: ids[201],
          playlistId: 'PL_BACKGROUND',
        });
        expect(getState('youtube.subItemsMap').PL_BACKGROUND).toMatchObject({
          ids,
          manifestComplete: true,
        });
        expect(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
        expect(getState('playback.activity')).toBe('playing');
        expect(stop).not.toHaveBeenCalled();
      },
    );

    it('does not add a partial row on manifest failure and allows an explicit chat retry', async () => {
      const search = await import('../search.ts');
      vi.mocked(search.extractYouTubePlaylistId).mockReturnValue('PL_RETRY_ADD');
      vi.mocked(search.resolveYouTubePlaylistManifest).mockRejectedValueOnce(
        new Error('unavailable'),
      );
      const { showToast } = await import('../../ui/toast.ts');
      const { initYouTube } = await import('../player.ts');
      initYouTube();
      const source = 'https://www.youtube.com/playlist?list=PL_RETRY_ADD';
      bus.emit('youtube:load-from-chat', source);
      await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('youtube.fetch_failed'));
      expect(getState('playlist.items')).toEqual([]);
      expect(getState('youtube.subItemsMap').PL_RETRY_ADD).toBeUndefined();
      vi.mocked(search.resolveYouTubePlaylistManifest).mockResolvedValueOnce({
        playlistId: 'PL_RETRY_ADD',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA'],
        title: 'Retry',
      });
      bus.emit('youtube:load-from-chat', source);
      await vi.waitFor(() => expect(getState('playlist.items')).toHaveLength(1));
    });

    it('deduplicates pending Standard adds and drops late results when the room changes', async () => {
      const search = await import('../search.ts');
      vi.mocked(search.extractYouTubePlaylistId).mockReturnValue('PL_CANCEL_ADD');
      let finish!: (value: import('../search.ts').YouTubePlaylistManifest) => void;
      vi.mocked(search.resolveYouTubePlaylistManifest).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const { initYouTube } = await import('../player.ts');
      initYouTube();
      const source = 'https://www.youtube.com/playlist?list=PL_CANCEL_ADD';
      bus.emit('youtube:load-from-chat', source);
      bus.emit('youtube:load-from-chat', source);
      expect(search.resolveYouTubePlaylistManifest).toHaveBeenCalledOnce();
      const signal = vi.mocked(search.resolveYouTubePlaylistManifest).mock.calls[0][1]!;
      setState('network.sessionCode', '654321');
      expect(signal.aborted).toBe(true);
      finish({
        playlistId: 'PL_CANCEL_ADD',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA'],
        title: 'Stale',
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(getState('playlist.items')).toEqual([]);
      expect(getState('youtube.subItemsMap').PL_CANCEL_ADD).toBeUndefined();
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
      // Mirror the production stop chain so the first non-YouTube -> YouTube
      // load cancels work that started on the wrong side of that boundary.
      bus.on('player:stop-all-media', () => {
        bus.emit('youtube:stop-mode', { silent: false });
      });
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
        isExpanded: true,
      });
      expect(search.fetchPlaylistSubTitles).toHaveBeenCalledWith('PL_GESTURE_READY', [
        'AAAAAAAAAAA',
        'BBBBBBBBBBB',
      ]);
      expect(vi.mocked(search.cancelSubTitleFetch).mock.invocationCallOrder.at(-1)!).toBeLessThan(
        vi.mocked(search.fetchPlaylistSubTitles).mock.invocationCallOrder.at(-1)!,
      );
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
        titles: ['', '', ''],
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

    it.each([false, true])(
      'resolves all 248 IDs for an operator playlist add, with video=%s',
      async (withVideo) => {
        const ids = [
          'RESOLVED001',
          ...Array.from({ length: 247 }, (_, i) => `video${String(i).padStart(6, '0')}`),
        ];
        const requestedId = withVideo ? ids[201] : ids[0];
        const sourceUrl = withVideo
          ? `https://www.youtube.com/watch?v=${requestedId}&list=PL_OPERATOR`
          : 'https://www.youtube.com/playlist?list=PL_OPERATOR';
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
        vi.mocked(search.resolveYouTubePlaylistManifest).mockResolvedValue({
          playlistId: 'PL_OPERATOR',
          videoId: 'RESOLVED001',
          videoIds: ids,
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
            sourceUrl,
            title: sourceUrl,
          },
          conn,
        );

        await vi.waitFor(() => {
          expect(getState('playlist.items')).toEqual([
            expect.objectContaining({
              type: 'youtube',
              videoId: requestedId,
              playlistId: 'PL_OPERATOR',
            }),
          ]);
        });
        expect(search.resolveYouTubePlaylistManifest).toHaveBeenCalledWith(
          'PL_OPERATOR',
          expect.any(AbortSignal),
        );
        expect(getState('youtube.subItemsMap').PL_OPERATOR).toMatchObject({
          ids,
          manifestComplete: true,
        });
      },
    );

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
      let resolveFirst!: (entry: {
        playlistId: string;
        videoId: string;
        title: string;
        videoIds: string[];
      }) => void;
      vi.mocked(search.resolveYouTubePlaylistManifest).mockReturnValue(
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
        videoIds: ['RESOLVED001', 'RESOLVED002'],
        title: 'Resolved first video',
      });

      await vi.waitFor(() => {
        expect(getState('playlist.items').map((item) => item.videoId)).toEqual([
          'RESOLVED001',
          'VIDEO_ID_02',
        ]);
      });
    });

    it('releases a pending room lane so the next room can commit immediately', async () => {
      const conn = {
        peer: 'operator-room-replacement',
        open: true,
        send: vi.fn(),
      } as unknown as DataConnection;
      setState('network.appRole', 'host');
      setState('network.sessionCode', '111111');
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
        url.includes('list=PL_OLD_ROOM') ? 'PL_OLD_ROOM' : null,
      );
      let oldRoomSignal: AbortSignal | undefined;
      vi.mocked(search.resolveYouTubePlaylistManifest).mockImplementation(
        (_playlistId, signal) =>
          new Promise((_resolve, reject) => {
            oldRoomSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
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
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/playlist?list=PL_OLD_ROOM',
          title: 'Old room',
        },
        conn,
      );
      setState('network.sessionCode', '222222');
      expect(oldRoomSignal?.aborted).toBe(true);
      handler(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/watch?v=VIDEO_ID_03',
          title: 'New room',
        },
        conn,
      );

      await vi.waitFor(() => {
        expect(getState('playlist.items').map((item) => item.videoId)).toEqual(['VIDEO_ID_03']);
      });
    });

    it('cancels a replaced operator prepare so its same-room successor can commit', async () => {
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
      vi.mocked(search.extractYouTubePlaylistId).mockImplementation((url: string) =>
        url.includes('list=PL_STALE') ? 'PL_STALE' : null,
      );
      let staleSignal: AbortSignal | undefined;
      vi.mocked(search.resolveYouTubePlaylistManifest).mockImplementation(
        (_playlistId, signal) =>
          new Promise((_resolve, reject) => {
            staleSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
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
      setState('network.connectedPeers', [
        {
          id: replacement.peer,
          slot: 1,
          label: 'Operator',
          conn: replacement,
          isOp: true,
          preloadedQueueItemIds: new Set(),
          status: 'connected',
          isDataTarget: true,
          joinOrder: 1,
          connectionType: 'local',
          lastHeartbeat: Date.now(),
        },
      ]);
      vi.mocked(peer.safeSend).mockClear();
      bus.emit('network:peer-connection-replaced', conn.peer);
      expect(staleSignal?.aborted).toBe(true);

      handlers[MSG.REQUEST_PLAYLIST_ADD_YOUTUBE]?.(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '99999999-9999-4999-8999-999999999998',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/watch?v=VIDEO_ID_04',
          title: 'Replacement',
        },
        replacement,
      );

      await vi.waitFor(() => {
        expect(getState('playlist.items').map((item) => item.videoId)).toEqual(['VIDEO_ID_04']);
      });

      expect(peer.safeSend).not.toHaveBeenCalled();
    });

    it('cancels a revoked operator prepare so another operator can commit', async () => {
      const revokedSend = vi.fn();
      const revoked = {
        peer: 'operator-revoked',
        open: true,
        send: revokedSend,
      } as unknown as DataConnection;
      const successor = {
        peer: 'operator-successor',
        open: true,
        send: vi.fn(),
      } as unknown as DataConnection;
      const peerState = (conn: DataConnection, isOp: boolean) => ({
        id: conn.peer,
        slot: conn === revoked ? 1 : 2,
        label: conn === revoked ? 'Revoked operator' : 'Successor operator',
        conn,
        isOp,
        preloadedQueueItemIds: new Set<string>(),
        status: 'connected' as const,
        isDataTarget: true,
        joinOrder: conn === revoked ? 1 : 2,
        connectionType: 'local' as const,
        lastHeartbeat: Date.now(),
      });
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState(
        'network.activeHostConnByPeerId',
        new Map([
          [revoked.peer, revoked],
          [successor.peer, successor],
        ]),
      );
      setState('network.connectedPeers', [peerState(revoked, true), peerState(successor, true)]);
      const search = await import('../search.ts');
      vi.mocked(search.extractYouTubePlaylistId).mockImplementation((url: string) =>
        url.includes('list=PL_REVOKED') ? 'PL_REVOKED' : null,
      );
      let revokedSignal: AbortSignal | undefined;
      vi.mocked(search.resolveYouTubePlaylistManifest).mockImplementation(
        (_playlistId, signal) =>
          new Promise((_resolve, reject) => {
            revokedSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
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
      const revokedRequest = {
        type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
        requestId: '99999999-9999-4999-8999-999999999996',
        baseRevision: 0,
        sourceUrl: 'https://www.youtube.com/playlist?list=PL_REVOKED',
        title: 'Revoked',
      };

      handler(revokedRequest, revoked);
      handler(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '99999999-9999-4999-8999-999999999994',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/watch?v=VIDEO_ID_06',
          title: 'Queued before revocation',
        },
        revoked,
      );
      await Promise.resolve();

      setState('network.connectedPeers', [peerState(revoked, false), peerState(successor, true)]);
      expect(revokedSignal?.aborted).toBe(true);
      // Regranting the same exact connection must not revive work that lost
      // ownership when the capability was revoked.
      setState('network.connectedPeers', [peerState(revoked, true), peerState(successor, true)]);

      handler(
        {
          type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
          requestId: '99999999-9999-4999-8999-999999999995',
          baseRevision: 0,
          sourceUrl: 'https://www.youtube.com/watch?v=VIDEO_ID_05',
          title: 'Successor',
        },
        successor,
      );

      await vi.waitFor(() => {
        expect(getState('playlist.items').map((item) => item.videoId)).toEqual(['VIDEO_ID_05']);
      });

      revokedSend.mockClear();
      handler(revokedRequest, revoked);
      expect(revokedSend.mock.calls.map(([message]) => message)).toEqual([
        expect.objectContaining({
          requestId: revokedRequest.requestId,
          phase: 'accepted',
        }),
        expect.objectContaining({
          requestId: revokedRequest.requestId,
          phase: 'settled',
          outcome: 'rejected',
          code: 'unauthorized',
        }),
      ]);
    });

    it('does not send async failure data to a replaced operator connection', async () => {
      const conn = {
        peer: 'operator-non-cooperative-stale',
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
      vi.mocked(search.resolveYouTubePlaylistManifest).mockReturnValue(
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
          requestId: '99999999-9999-4999-8999-999999999997',
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

  describe('Standard room YouTube title ownership', () => {
    beforeEach(() => {
      Object.assign(window, {
        YT: {
          Player: vi.fn(),
          PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
        },
      });
    });

    afterEach(async () => {
      const { setYouTubePlayer } = await import('../_state.ts');
      const { cancelYouTubeZeroStart } = await import('../zero-start.ts');
      cancelYouTubeZeroStart('cancelled', false);
      setYouTubePlayer(null);
    });

    it('rebinds metadata when a pending cue completes after a resident occurrence handoff', async () => {
      const { setYouTubePlayer, markYtPlayerReady } = await import('../_state.ts');
      const { updateYouTubeUIForTests } = await import('../iframe.ts');
      const { initYouTube } = await import('../player.ts');
      const { handleYouTubePlay } = await import('../handlers.ts');
      const zeroStart = await import('../zero-start.ts');
      const videoA = 'M7lc1UVf-VE';
      const videoB = 'dQw4w9WgXcQ';
      const thirdQueueItemId = '66666666-6666-4666-8666-666666666666';
      const conn = dataConnection('host-peer');
      const player = makeFakeYtPlayer({
        __videoId: videoA,
        __playlistIdx: -1,
        __autoPlayOnLoad: true,
      });
      player.getVideoData = () => ({
        video_id: player.__videoId,
        title: `Resolved ${player.__videoId}`,
        author: player.__videoId === videoA ? 'Artist A' : 'Artist B',
      });
      const pendingCue = vi.fn();
      player.cueVideoById = pendingCue;
      document.body.innerHTML =
        '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
      setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      markYtPlayerReady(player as unknown as YouTubePlayerInstance);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'A1',
          videoId: videoA,
          playlistId: null,
        },
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'B',
          videoId: videoB,
          playlistId: null,
        },
        {
          queueItemId: thirdQueueItemId,
          type: 'youtube',
          name: 'A2',
          videoId: videoA,
          playlistId: null,
        },
      ]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('network.appRole', 'guest');
      setState('network.myId', 'guest-peer');
      setState('network.hostConn', conn);
      setPlaybackYouTubePlaying();
      initYouTube();

      handleYouTubePlay(
        { queueItemId: SECOND_QUEUE_ITEM_ID, videoId: videoB, autoplay: false },
        conn,
      );
      expect(pendingCue).toHaveBeenCalledWith(videoB, 0);
      handleYouTubePlay({ queueItemId: thirdQueueItemId, videoId: videoA, autoplay: false }, conn);
      expect(pendingCue).toHaveBeenCalledTimes(1);
      expect(getState('playlist.currentQueueItemId')).toBe(thirdQueueItemId);

      // B's old iframe command lands after selecting A; PREPARE restores A.
      player.__videoId = videoB;
      player.__onStateChange = ({ data }) => {
        zeroStart.handleYouTubeZeroStartPlayerState(data);
      };
      const now = Date.now();
      expect(
        zeroStart.handleYouTubeZeroStartPrepare(conn.peer, {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'resident-metadata-successor',
          sequence: 1,
          queueItemId: thirdQueueItemId,
          videoId: videoA,
          subIndex: 0,
          prepareAtHost: now,
          decisionAtHost: now + 2_300,
          startDeadlineAtHost: now + 3_000,
          hostPlatform: 'other',
        }),
      ).toBe(true);
      vi.advanceTimersByTime(620);
      expect(player.__videoId).toBe(videoA);
      expect(zeroStart.getYouTubeZeroStartSnapshot()?.phase).toBe('armed');
      zeroStart.cancelYouTubeZeroStart('cancelled', false);
      updateYouTubeUIForTests();
      expect(getState('player.currentTrackMeta')?.artist).toBe('Artist A');
    });

    it('prevents guest local iframe from overwriting host track title during multilingual playback', async () => {
      const { setYouTubePlayer } = await import('../_state.ts');
      const { updateYouTubeUIForTests, expectYouTubeMetadataVideoIdForTests } =
        await import('../iframe.ts');

      const fakePlayer = {
        getCurrentTime: vi.fn(() => 25),
        getDuration: vi.fn(() => 180),
        getPlayerState: vi.fn(() => 1),
        getVideoData: vi.fn(() => ({
          video_id: 'vid-multilingual',
          title: 'English Title',
          author: 'Channel Author',
        })),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(fakePlayer);

      setPlaybackYouTubePlaying();
      setState('network.appRole', 'guest');
      setState('network.hostConn', dataConnection('host-peer'));
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          name: '한국어 제목',
          videoId: 'vid-multilingual',
          playlistId: null,
        },
      ]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('player.currentTrackMeta', {
        title: '한국어 제목',
        queueItemId: QUEUE_ITEM_ID,
      });

      expectYouTubeMetadataVideoIdForTests('vid-multilingual');
      updateYouTubeUIForTests();

      expect(getState('player.currentTrackMeta')?.title).toBe('한국어 제목');
      expect(getState('player.currentTrackMeta')?.artist).toBe('Channel Author');
    });

    it('allows host local iframe to resolve track title when no hostConn exists', async () => {
      const { setYouTubePlayer } = await import('../_state.ts');
      const { updateYouTubeUIForTests, expectYouTubeMetadataVideoIdForTests } =
        await import('../iframe.ts');

      const fakePlayer = {
        getCurrentTime: vi.fn(() => 25),
        getDuration: vi.fn(() => 180),
        getPlayerState: vi.fn(() => 1),
        getVideoData: vi.fn(() => ({
          video_id: 'vid-multilingual',
          title: '한국어 제목',
          author: 'Channel Author',
        })),
      } as unknown as YouTubePlayerInstance;
      setYouTubePlayer(fakePlayer);

      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.hostConn', null);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'vid-multilingual',
          videoId: 'vid-multilingual',
          playlistId: null,
        },
      ]);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('player.currentTrackMeta', {
        title: 'vid-multilingual',
        queueItemId: QUEUE_ITEM_ID,
      });

      expectYouTubeMetadataVideoIdForTests('vid-multilingual');
      updateYouTubeUIForTests();

      expect(getState('player.currentTrackMeta')?.title).toBe('한국어 제목');
      expect(getState('player.currentTrackMeta')?.artist).toBe('Channel Author');
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
          manifestComplete: true,
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
      const { setYouTubePlayer, markYtPlayerReady } = await import('../_state.ts');
      const readyPlayer = makeFakeYtPlayer({
        __videoId: 'secondVideo',
      }) as unknown as YouTubePlayerInstance;
      setYouTubePlayer(readyPlayer);
      // Consumption is gated, but the current pending intent survives until READY.
      expect(consumePendingAutoSyncOnReady()).toBeNull();
      expect(markYtPlayerReady(readyPlayer)).toBe(true);
      expect(consumePendingAutoSyncOnReady()).toEqual(
        expect.objectContaining({ targetTime: 37.5, skipSeek: false, state: 1 }),
      );
    });
  });
});
