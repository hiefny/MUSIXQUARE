import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
}));

vi.mock('../search.ts', () => ({
  fetchPlaylistSubTitles: vi.fn(),
}));

vi.mock('../_state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_state.ts')>();
  return { ...actual, getYouTubePlayer: vi.fn(() => null) };
});

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  bus.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type SyncHandler = (data: Record<string, unknown>, conn?: DataConnection) => void;

describe('YouTube Sync', () => {
  describe('broadcastYouTubeSync()', () => {
    it('does nothing if player is null', async () => {
      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');

      broadcastYouTubeSync();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('does nothing if hostConn is set (guest mode)', async () => {
      const playerMod = await import('../_state.ts');
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue({
        getCurrentTime: () => 10,
        getPlayerState: () => 1,
      } as YouTubePlayerInstance);
      setState('network.hostConn', { open: true } as DataConnection);

      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');

      broadcastYouTubeSync();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts sync data when host with player', async () => {
      const playerMod = await import('../_state.ts');
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue({
        getCurrentTime: () => 42.5,
        getPlayerState: () => 1,
      } as YouTubePlayerInstance);
      setState('network.hostConn', null);

      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');

      broadcastYouTubeSync();
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          time: 42.5,
          state: 1,
        }),
      );
    });
  });

  describe('production guest correction', () => {
    async function registerGuestHandler(player: YouTubePlayerInstance): Promise<SyncHandler> {
      const stateMod = await import('../_state.ts');
      vi.mocked(stateMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      const hostConn = { open: true, peer: 'host-1' } as DataConnection;
      setState('network.hostConn', hostConn);

      const { initYouTubeSync } = await import('../sync.ts');
      const { registerHandlers } = await import('../../network/protocol.ts');
      initYouTubeSync();
      const handlers = vi.mocked(registerHandlers).mock.calls.at(-1)?.[0] as
        | Record<string, SyncHandler>
        | undefined;
      const handler = handlers?.[MSG.YOUTUBE_SYNC];
      expect(handler).toBeTypeOf('function');
      return (data, conn = hostConn) => handler?.(data, conn);
    }

    function makePlayer(currentTime = 10): YouTubePlayerInstance {
      return {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        seekTo: vi.fn(),
      } as YouTubePlayerInstance;
    }

    it('pauses after the production stale-frame threshold and resumes on movement', async () => {
      const player = makePlayer();
      const handler = await registerGuestHandler(player);

      for (let i = 0; i < 4; i++) {
        handler({ time: 10, state: 1, videoId: 'same-video' });
      }
      expect(player.pauseVideo).toHaveBeenCalledOnce();

      handler({ time: 12, state: 1, videoId: 'same-video' });
      expect(player.playVideo).toHaveBeenCalledOnce();
    });

    it('resetAdDetection clears an active stale-frame run', async () => {
      const player = makePlayer();
      const handler = await registerGuestHandler(player);
      const { resetAdDetection } = await import('../sync.ts');

      for (let i = 0; i < 4; i++) {
        handler({ time: 10, state: 1, videoId: 'same-video' });
      }
      expect(player.pauseVideo).toHaveBeenCalledOnce();

      resetAdDetection();
      handler({ time: 10, state: 1, videoId: 'same-video' });
      expect(player.pauseVideo).toHaveBeenCalledOnce();
    });

    it('uses the production drift threshold and manual offset', async () => {
      const player = makePlayer(10);
      const handler = await registerGuestHandler(player);
      const { DRIFT_SEEK_THRESHOLD_SEC } = await import('../constants.ts');
      const boundary = 10 + DRIFT_SEEK_THRESHOLD_SEC;

      handler({ time: boundary, state: 1, videoId: 'same-video' });
      expect(player.seekTo).not.toHaveBeenCalled();

      setState('sync.youtubeLocalOffset', 0.01);
      handler({ time: boundary, state: 1, videoId: 'same-video' });
      expect(player.seekTo).toHaveBeenCalledWith(boundary + 0.01, true);
    });
  });

  describe('initYouTubeSync()', () => {
    it('registers protocol handlers', async () => {
      const { registerHandlers } = await import('../../network/protocol.ts');
      const { initYouTubeSync } = await import('../sync.ts');

      initYouTubeSync();
      expect(registerHandlers).toHaveBeenCalled();

      const handlerMap = vi.mocked(registerHandlers).mock.calls[0][0];
      expect(Object.keys(handlerMap).length).toBeGreaterThanOrEqual(4);
    });
  });
});
