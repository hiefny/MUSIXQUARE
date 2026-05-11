/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { APP_STATE, MSG } from '../../core/constants.ts';
import { setPlaybackAppState } from '../../player/ownership.ts';
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
  fetchOEmbedTitle: vi.fn(async () => 'Test Title'),
  fetchYouTubePreview: vi.fn(),
  fetchPlaylistSubTitles: vi.fn(),
  cancelSubTitleFetch: vi.fn(),
}));

vi.mock('../sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
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
  });

  describe('getYouTubePlayer()', () => {
    it('returns null initially', async () => {
      const { getYouTubePlayer } = await import('../player.ts');
      expect(getYouTubePlayer()).toBeNull();
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

      setPlaybackAppState(APP_STATE.PLAYING_YOUTUBE);
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
