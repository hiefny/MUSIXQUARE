import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';

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
  clearAllManagedTimers();
  resetState();
  bus.clear();
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Same Video',
      videoId: 'same-video',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
});

afterEach(() => {
  clearAllManagedTimers();
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

    it('keeps a PRO coordinator manual offset out of the canonical room time', async () => {
      const playerMod = await import('../_state.ts');
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue({
        getCurrentTime: () => 42.5,
        getDuration: () => 120,
        getPlayerState: () => 1,
      } as YouTubePlayerInstance);
      setState('network.hostConn', null);
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

      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');

      broadcastYouTubeSync();

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ time: 42.25, state: 1 }));
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
      return (data, conn = hostConn) => handler?.({ queueItemId: QUEUE_ITEM_ID, ...data }, conn);
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

    it('seeds a promoted PRO coordinator from its existing member offset', async () => {
      const playerMod = await import('../_state.ts');
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(null);
      setState('sync.youtubeLocalOffset', 0.25);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();

      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-1',
        epoch: 2,
        snapshotRevision: 2,
        capabilities: ['playback.control'],
      });

      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.25);
    });

    it('preserves the actually-applied boundary offset when a PRO member is promoted', async () => {
      const playerMod = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn(),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('sync.youtubeLocalOffset', -3);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const hostConn = { open: true, peer: 'participant-0' } as DataConnection;
      setState('network.hostConn', hostConn);

      const { initYouTubeSync } = await import('../sync.ts');
      const { registerHandlers } = await import('../../network/protocol.ts');
      initYouTubeSync();
      const handlers = vi.mocked(registerHandlers).mock.calls.at(-1)?.[0] as Record<
        string,
        SyncHandler
      >;
      handlers[MSG.YOUTUBE_SYNC]?.(
        {
          queueItemId: QUEUE_ITEM_ID,
          time: 1,
          state: 2,
          videoId: 'same-video',
        },
        hostConn,
      );

      setState('network.hostConn', null);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-1',
        epoch: 2,
        snapshotRevision: 2,
        capabilities: ['playback.control'],
      });

      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(-1);
    });

    it('seeks only the PRO coordinator player for a local manual nudge', async () => {
      const playerMod = await import('../_state.ts');
      let currentTime = 42.5;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const { initYouTubeSync } = await import('../sync.ts');
      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();

      bus.emit('youtube:set-coordinator-manual-offset', 0.125);

      expect(player.seekTo).toHaveBeenCalledWith(42.625, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.125);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.125);

      vi.mocked(broadcast).mockClear();
      broadcastYouTubeSync();
      expect(broadcast).not.toHaveBeenCalled();

      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ time: 42.5 }));
    });

    it('keeps one canonical anchor across rapid coordinator nudges while seekTo is stale', async () => {
      const playerMod = await import('../_state.ts');
      const player = {
        // Real iframes can keep returning the pre-seek value for a short time.
        getCurrentTime: vi.fn(() => 10),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const { initYouTubeSync, broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();

      bus.emit('youtube:set-coordinator-manual-offset', 0.01);
      bus.emit('youtube:set-coordinator-manual-offset', 0.02);

      expect(player.seekTo).toHaveBeenNthCalledWith(1, 10.01, true);
      expect(player.seekTo).toHaveBeenNthCalledWith(2, 10.02, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.02);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.02, 8);

      vi.mocked(broadcast).mockClear();
      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ time: 10 }));

      bus.emit('youtube:set-coordinator-manual-offset', 0);
      expect(player.seekTo).toHaveBeenLastCalledWith(10, true);
    });

    it('stores the applied boundary offset and resets to the exact canonical position', async () => {
      const playerMod = await import('../_state.ts');
      let currentTime = 1;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();

      bus.emit('youtube:set-coordinator-manual-offset', -3);

      expect(player.seekTo).toHaveBeenLastCalledWith(0, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(-3);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(-1);

      bus.emit('youtube:set-coordinator-manual-offset', 0);

      expect(player.seekTo).toHaveBeenLastCalledWith(1, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);

      const { clearManagedTimer } = await import('../../core/timers.ts');
      clearManagedTimer('yt-pro-coordinator-local-nudge');
      currentTime = 119;
      bus.emit('youtube:set-coordinator-manual-offset', 3);

      expect(player.seekTo).toHaveBeenLastCalledWith(120, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(3);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(1);

      bus.emit('youtube:set-coordinator-manual-offset', 0);

      expect(player.seekTo).toHaveBeenLastCalledWith(119, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
    });
  });
});
