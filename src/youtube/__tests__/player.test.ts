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
import {
  registerProRoomLegacyMediaHooks,
  type ProRoomLegacyMediaHooks,
} from '../../pro-room/legacy-media-hooks.ts';

const QUEUE_ITEM_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_QUEUE_ITEM_ID = '55555555-5555-4555-8555-555555555555';

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
  getSelectedYouTubeSearchResult: vi.fn(() => null),
  searchYouTubeFromInput: vi.fn(),
  resolveYouTubePlaylistEntry: vi.fn(async (playlistId: string) => ({
    playlistId,
    videoId: 'RESOLVED001',
    title: 'Resolved first video',
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
  animateTransition: vi.fn((fn: Function) => fn()),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  bus.clear();
  vi.useFakeTimers();
  registerProRoomLegacyMediaHooks(null);

  const container = document.createElement('div');
  container.id = 'youtube-container';
  document.body.appendChild(container);

  const playerDiv = document.createElement('div');
  playerDiv.id = 'youtube-player';
  container.appendChild(playerDiv);
});

afterEach(() => {
  registerProRoomLegacyMediaHooks(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

function proMediaHooks(overrides: Partial<ProRoomLegacyMediaHooks> = {}): ProRoomLegacyMediaHooks {
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

  describe('local media-session toggle', () => {
    it('marks local pause and clears it through rendezvous resume', async () => {
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
      const syncMod = await import('../sync.ts');
      const { initYouTube } = await import('../player.ts');
      const guestRendezvousSync = vi.mocked(syncMod.guestRendezvousSync);
      guestRendezvousSync.mockReturnValue({ status: 'started' });

      stateMod.setYouTubePlayer(player as unknown as YouTubePlayerInstance);
      stateMod.setLocalYouTubePaused(false);
      initYouTube();

      bus.emit('youtube:local-toggle-play');

      expect(stateMod.isLocalYouTubePaused()).toBe(true);
      expect(player.pauseVideo).toHaveBeenCalledTimes(1);

      player.getPlayerState.mockReturnValue(2);
      bus.emit('youtube:local-toggle-play');

      expect(stateMod.isLocalYouTubePaused()).toBe(false);
      expect(guestRendezvousSync).toHaveBeenCalledWith({
        silent: true,
        suppressProgressToast: true,
      });
      expect(player.playVideo).not.toHaveBeenCalled();
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

  describe('PRO coordinator canonical controls', () => {
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
        role: 'coordinator',
        coordinatorId: 'participant-0',
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

    it('honors Pause and freezes the anchor while a coordinator nudge is buffering', async () => {
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
        role: 'coordinator',
        coordinatorId: 'participant-0',
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
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.YOUTUBE_STATE, state: 2, time: 11 }),
      );

      vi.advanceTimersByTime(1000);
      expect(toCanonicalYouTubeTime(10.25, 120)).toBe(11);
      vi.mocked(getManagedTimer).mockReturnValue(null);
    });

    it('rebases a native playlist advance onto the new video before broadcasting', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const { broadcast } = await import('../../network/peer.ts');
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
        role: 'coordinator',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      initYouTube();

      bus.emit('youtube:sub-video-advanced');

      expect(player.loadVideoById).toHaveBeenCalledWith('video-2');
      expect(player.seekTo).toHaveBeenCalledWith(0, true);
      expect(player.playVideo).toHaveBeenCalled();
      expect(getState('sync.youtubeLocalOffset')).toBe(-3);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(-0.2, 8);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: 0.2,
          subIndex: 1,
          videoId: 'video-2',
        }),
      );
    });
  });

  describe('stopYouTubeMode()', () => {
    it('does not throw when no player exists', async () => {
      const { stopYouTubeMode } = await import('../player.ts');
      expect(() => stopYouTubeMode()).not.toThrow();
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

      const conn = { open: true, peer: 'guest-1', send: vi.fn() } as DataConnection;
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
      const proConn = { open: true, peer: 'pro-guest', send: vi.fn() } as DataConnection;
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
      const settlingConn = {
        open: true,
        peer: 'settling-guest',
        send: vi.fn(),
      } as DataConnection;
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

      const midNudgeConn = {
        open: true,
        peer: 'mid-nudge-guest',
        send: vi.fn(),
      } as DataConnection;
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

      let onStateChange: ((event: { data: number }) => void) | undefined;
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
      onStateChange?.({ data: 0 });

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
      const addYouTube = vi.fn(() => true);
      const updateTrackMetadata = vi.fn(() => true);
      registerProRoomLegacyMediaHooks(proMediaHooks({ addYouTube, updateTrackMetadata }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['queue.mutate'],
      });
      setState('network.hostConn', { peer: 'coordinator-1' } as DataConnection);
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

    it('resolves a playlist-only PRO add without interrupting current playback', async () => {
      const addYouTube = vi.fn(() => true);
      registerProRoomLegacyMediaHooks(proMediaHooks({ addYouTube }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['queue.mutate'],
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
      vi.mocked(search.resolveYouTubePlaylistEntry).mockResolvedValue({
        playlistId: 'PL_PERSISTENT',
        videoId: 'RESOLVED001',
        title: 'Resolved first video',
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
        );
      });
      expect(getState('playlist.items')).toEqual([existing]);
      expect(getState('playlist.currentQueueItemId')).toBe(existing.queueItemId);
      expect(stopMedia).not.toHaveBeenCalled();
    });

    it('reports a playlist-only PRO resolution failure without mutating the queue', async () => {
      const addYouTube = vi.fn(() => true);
      registerProRoomLegacyMediaHooks(proMediaHooks({ addYouTube }));
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'coordinator-1',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['queue.mutate'],
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
      vi.mocked(search.resolveYouTubePlaylistEntry).mockRejectedValue(new Error('unavailable'));
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
