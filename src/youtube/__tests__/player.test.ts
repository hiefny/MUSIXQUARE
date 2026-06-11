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

// ─── Mocks ───────────────────────────────────────────────────────────────

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
  resetState();
  bus.clear();
  vi.useFakeTimers();

  // Create required DOM elements
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

// ─── Tests ───────────────────────────────────────────────────────────────

describe('YouTube Player', () => {
  describe('Module Exports', () => {
    it('exports getYouTubePlayer', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.getYouTubePlayer).toBe('function');
    });

    it('exports loadYouTubeVideo', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.loadYouTubeVideo).toBe('function');
    });

    it('exports stopYouTubeMode', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.stopYouTubeMode).toBe('function');
    });

    it('exports initYouTube', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.initYouTube).toBe('function');
    });

    it('exports primeYouTubePlayer', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.primeYouTubePlayer).toBe('function');
    });
  });

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

  describe('stopYouTubeMode()', () => {
    it('does not throw when no player exists', async () => {
      const { stopYouTubeMode } = await import('../player.ts');
      expect(() => stopYouTubeMode()).not.toThrow();
    });
  });

  describe('Duration Caching Logic', () => {
    // Test the duration cache stickiness behavior
    let cachedDuration = 0;
    let cachedSubIndex = -1;

    function getDuration(playerDuration: number, currentSubIndex: number): number {
      // Reset cache on sub-index change
      if (currentSubIndex !== cachedSubIndex) {
        cachedDuration = 0;
        cachedSubIndex = currentSubIndex;
      }

      // Lock on first valid read
      if (cachedDuration <= 0 && playerDuration > 0) {
        cachedDuration = playerDuration;
      }
      return cachedDuration;
    }

    beforeEach(() => {
      cachedDuration = 0;
      cachedSubIndex = -1;
    });

    it('caches first valid duration', () => {
      expect(getDuration(120, 0)).toBe(120);
      // Subsequent different values should be ignored
      expect(getDuration(130, 0)).toBe(120);
    });

    it('returns 0 when player reports 0', () => {
      expect(getDuration(0, 0)).toBe(0);
    });

    it('resets on sub-index change', () => {
      getDuration(120, 0);
      expect(getDuration(200, 1)).toBe(200); // new sub-index → reset → cache new
    });

    it('prevents flickering duration', () => {
      getDuration(120, 0);
      // Even if player briefly reports 0, cache persists
      expect(getDuration(0, 0)).toBe(120);
    });
  });

  describe('YouTube URL Extraction', () => {
    it('extractYouTubeVideoId from watch URL', async () => {
      const { extractYouTubeVideoId } = await import('../search.ts');
      expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
        'dQw4w9WgXcQ',
      );
    });

    it('returns null for non-YouTube URL', async () => {
      const { extractYouTubeVideoId } = await import('../search.ts');
      expect(extractYouTubeVideoId('https://example.com')).toBeNull();
    });
  });

  describe('Late-join YouTube bootstrap', () => {
    it('schedules a precision rendezvous sync for the newly connected guest only', async () => {
      const { initYouTube } = await import('../player.ts');
      const { setYouTubePlayer } = await import('../_state.ts');
      const { safeSend } = await import('../../network/peer.ts');
      const { setManagedTimer } = await import('../../core/timers.ts');
      const { STAGE2_RENDEZVOUS_BROADCAST_MS } = await import('../constants.ts');

      setPlaybackYouTubePlaying();
      setState('playlist.currentTrackIndex', 0);
      setState('playlist.items', [
        {
          type: 'youtube',
          videoId: 'initialVideo',
          playlistId: null,
          name: 'Late Join Video',
          title: 'Late Join Video',
        },
      ] satisfies PlaylistItem[]);
      setState('player.currentTrackMeta', { title: 'Late Join Video' } satisfies TrackMeta);
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
          videoId: 'liveVideo123',
          autoplay: true,
        }),
      );
      expect(safeSend).toHaveBeenCalledWith(
        conn,
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
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
          isManual: true,
          state: 1,
          time: 42,
          videoId: 'liveVideo123',
          title: 'Late Join Video',
        }),
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
      setState('playlist.currentTrackIndex', 1);
      setState('playlist.items', [
        {
          type: 'youtube',
          videoId: 'firstEntry',
          playlistId: 'playlist-repeat',
          name: 'Playlist A',
        },
        {
          type: 'youtube',
          videoId: 'secondEntry',
          playlistId: 'playlist-repeat',
          name: 'Playlist A again',
        },
      ] satisfies PlaylistItem[]);
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

      expect(getState('playlist.currentTrackIndex')).toBe(0);
      expect(consumePendingAutoSyncOnReady()).toMatchObject({
        isTrackTransition: false,
        targetTime: 0,
        subIndex: 0,
        videoId: 'VIDEO_ID_01',
        skipSeek: true,
      });
    });
  });

  describe('System audio restore bootstrap', () => {
    it('rebroadcasts YouTube playback when restoring the room after system audio', async () => {
      const { initYouTube } = await import('../player.ts');
      const { broadcast } = await import('../../network/peer.ts');

      setState('playlist.currentTrackIndex', 0);
      setState('playlist.items', [
        {
          type: 'youtube',
          videoId: 'entryVideo',
          playlistId: 'playlist-1',
          name: 'Playlist Track',
          title: 'Playlist Track',
        },
      ] satisfies PlaylistItem[]);
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
        index: 0,
        autoplay: true,
        subIndex: 1,
      });

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_PLAY,
          videoId: 'secondVideo',
          playlistId: 'playlist-1',
          index: 0,
          autoplay: true,
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
      expect(loadSpy).toHaveBeenCalledWith('secondVideo', 'playlist-1', true, 1);
    });
  });
});
