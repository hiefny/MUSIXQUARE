import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import {
  prepareStandardHostManualOffsetRuntimeForTests,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const zeroStartFacade = vi.hoisted(() => ({ active: false }));

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

// sync.ts must remain below the iframe runtime boundary. iframe.ts already
// imports sync.ts, so importing it back here recreates an evaluation cycle
// that can leave Vitest/browser ESM bindings in the temporal dead zone.
vi.mock('../iframe.ts', () => {
  throw new Error('sync.ts must not import iframe.ts');
});

vi.mock('../_state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_state.ts')>();
  return { ...actual, getYouTubePlayer: vi.fn(() => null) };
});

vi.mock('../zero-start.ts', () => ({
  isYouTubeZeroStartProtocolActive: vi.fn(() => zeroStartFacade.active),
}));

beforeEach(async () => {
  await prepareStandardHostManualOffsetRuntimeForTests();
  resetStandardHostManualOffsetTransaction();
  vi.clearAllMocks();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  zeroStartFacade.active = false;
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
  vi.useRealTimers();
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

    it('never emits a legacy host heartbeat from a server-authoritative PRO endpoint', async () => {
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

      expect(broadcast).not.toHaveBeenCalled();
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
        loadVideoById: vi.fn(),
        loadPlaylist: vi.fn(),
        cuePlaylist: vi.fn(),
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        getPlaylistIndex: vi.fn(() => 0),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        getPlaylist: vi.fn(() => []),
        pauseVideo: vi.fn(),
        playVideo: vi.fn(),
        stopVideo: vi.fn(),
        destroy: vi.fn(),
        seekTo: vi.fn(),
        setVolume: vi.fn(),
      };
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

    it('does not create a new offset boundary when an equal PRO endpoint role label changes', async () => {
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
      setState('network.hostConn', null);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      // The role label is no longer an authority boundary. Seed the offset
      // that the participant-local COMMIT path actually applied, then prove a
      // legacy member→coordinator label change cannot rebase it.
      setState('sync.youtubeCoordinatorAppliedOffset', -1);

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

    it('seeks only the local PRO player for a manual nudge without legacy broadcasting', async () => {
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
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.125, 2);

      vi.mocked(broadcast).mockClear();
      broadcastYouTubeSync();
      expect(broadcast).not.toHaveBeenCalled();

      broadcastYouTubeSync(true);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('seeks only an active standard host iframe and keeps wire time canonical', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 42.5;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();

      bus.emit('youtube:set-coordinator-manual-offset', 0.125);
      vi.advanceTimersByTime(600);

      expect(player.seekTo).toHaveBeenCalledWith(42.625, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.125);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.125, 2);

      vi.mocked(broadcast).mockClear();
      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_SYNC,
          state: 2,
        }),
      );
      const frame = vi.mocked(broadcast).mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(frame.time).toBeTypeOf('number');
      expect(frame.time as number).toBeCloseTo(42.5, 2);
      expect(frame).not.toHaveProperty('manualOffset');
    });

    it('keeps even a manual heartbeat gated until a delayed local seek is observed', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 42.5;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn((time: number) => {
          setTimeout(() => {
            currentTime = time;
          }, 1_200);
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.5);

      expect(getState('sync.youtubeLocalOffset')).toBe(0.5);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0, 2);
      broadcastYouTubeSync(true);
      expect(broadcast).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_800);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.5, 5);
      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ time: 42.5 }));
    });

    it('keeps the gate while live video metadata is transient after the exact seek', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 20;
      let liveVideoId = 'same-video';
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: liveVideoId, title: 'Same Video' })),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
          liveVideoId = '';
          setTimeout(() => {
            liveVideoId = 'same-video';
          }, 300);
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.5);
      vi.advanceTimersByTime(600);

      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      broadcastYouTubeSync(true);
      expect(broadcast).not.toHaveBeenCalled();
      vi.advanceTimersByTime(800);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.5, 5);
    });

    it('preserves a verified boundary when metadata is missing before a new command', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 10;
      let liveVideoId = 'same-video';
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: liveVideoId, title: 'Same Video' })),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 1);
      vi.advanceTimersByTime(600);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(1, 5);

      liveVideoId = '';
      bus.emit('youtube:set-coordinator-manual-offset', 0.5);
      expect(getState('sync.youtubeLocalOffset')).toBe(1);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(1, 5);
      vi.mocked(broadcast).mockClear();
      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ time: 10 }));
    });

    it('terminates rollback in BUFFERING without ever committing the request', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 42.5),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 3),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn(),
        loadVideoById: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, isStandardHostManualOffsetTransactionPending } =
        await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 1);
      vi.advanceTimersByTime(3_600);

      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
    });

    it('treats an unknown native playlist index as unverified, never detached', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 30;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getPlaylistIndex: vi.fn(() => undefined),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        cueVideoById: vi.fn((_videoId: string, time?: number) => {
          currentTime = time ?? 0;
        }),
        loadVideoById: vi.fn(),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'Playlist',
          videoId: 'same-video',
          playlistId: 'PL-safe',
        },
      ]);
      setState('youtube.subItemsMap', {
        'PL-safe': { ids: ['same-video'], titles: ['Same Video'] },
      });
      setState('youtube.currentSubIndex', 0);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.5);
      vi.advanceTimersByTime(3_600);

      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
    });

    it('fails a no-op seek closed and never commits the requested value to the wire', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 42.5),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn(),
        loadVideoById: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 1);

      expect(getState('sync.youtubeLocalOffset')).toBe(1);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      broadcastYouTubeSync(true);
      expect(broadcast).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3_600);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      expect(player.seekTo).toHaveBeenCalledWith(42.5, true);
      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ time: 42.5 }));
    });

    it('generation-fences rapid superseding inputs and commits only the latest observed target', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 10;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.125);
      bus.emit('youtube:set-coordinator-manual-offset', 0.25);

      expect(getState('sync.youtubeLocalOffset')).toBe(0.25);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      currentTime = 10.25;
      vi.advanceTimersByTime(600);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.25);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25, 5);
    });

    it('preserves the prior pending generation when an initial getter throws', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 10;
      let throwDuration = false;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => {
          if (throwDuration) throw new Error('transient duration read');
          return 120;
        }),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, isStandardHostManualOffsetTransactionPending } =
        await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.5);
      throwDuration = true;
      bus.emit('youtube:set-coordinator-manual-offset', 1);

      expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.5);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      throwDuration = false;
      currentTime = 10.5;
      vi.advanceTimersByTime(600);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.5, 5);
    });

    it('drops a stale pending generation when the queue/video identity changes', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 10;
      let liveVideoId = 'same-video';
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: liveVideoId, title: liveVideoId })),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 1);

      const replacementId = '22222222-2222-4222-8222-222222222222';
      liveVideoId = 'replacement-video';
      currentTime = 0;
      setState('playlist.items', [
        {
          queueItemId: replacementId,
          type: 'youtube',
          name: 'Replacement',
          videoId: liveVideoId,
          playlistId: null,
        },
      ]);
      setState('playlist.currentQueueItemId', replacementId);
      vi.advanceTimersByTime(100);

      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      expect(player.seekTo).toHaveBeenCalledTimes(1);
    });

    it('keeps rollback gated long enough to supersede a late observable seek', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 42.5;
      let commandCount = 0;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn((time: number) => {
          commandCount += 1;
          if (commandCount === 1) {
            setTimeout(() => {
              currentTime = time;
            }, 3_200);
          } else if (commandCount >= 7) {
            currentTime = time;
          }
        }),
        loadVideoById: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 1);
      vi.advanceTimersByTime(3_300);

      broadcastYouTubeSync(true);
      expect(broadcast).not.toHaveBeenCalled();
      vi.advanceTimersByTime(800);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      expect(currentTime).toBe(42.5);
      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ time: 42.5 }));
    });

    it('requires a post-timeout stable residual before releasing rollback', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 42.5;
      let commandCount = 0;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn(() => {
          commandCount += 1;
          if (commandCount === 1) {
            setTimeout(() => {
              currentTime = 43.5;
            }, 3_100);
            setTimeout(() => {
              currentTime = 44.5;
            }, 6_200);
          }
        }),
        loadVideoById: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, isStandardHostManualOffsetTransactionPending } =
        await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 1);
      vi.advanceTimersByTime(6_600);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(true);

      vi.advanceTimersByTime(200);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(2, 5);
    });

    it('neutralizes a standard-host offset requested inside the canonical end guard', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 115;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 9.999);
      vi.advanceTimersByTime(600);

      expect(player.seekTo).toHaveBeenCalledWith(115, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
    });

    it('uses the host heartbeat as a secondary end-boundary neutralizer', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 119.5;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync, broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');
      initYouTubeSync();
      setState('sync.youtubeLocalOffset', 0.5);
      setState('sync.youtubeCoordinatorAppliedOffset', 0.5);

      broadcastYouTubeSync(true);
      vi.advanceTimersByTime(600);

      expect(player.seekTo).toHaveBeenCalledWith(119, true);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0, 2);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('detaches a standard host from native playlist auto-advance before applying an offset', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 42.5;
      let playlistIndex = 3;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getPlaylistIndex: vi.fn(() => playlistIndex),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        loadVideoById: vi.fn((_videoId: string, startSeconds?: number) => {
          currentTime = startSeconds ?? 0;
          playlistIndex = -1;
        }),
        pauseVideo: vi.fn(),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);
      setState('youtube.currentSubIndex', 3);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.125);
      vi.advanceTimersByTime(600);

      expect(player.loadVideoById).toHaveBeenCalledWith('same-video', 42.625);
      expect(player.seekTo).not.toHaveBeenCalled();
      expect(getState('youtube.currentSubIndex')).toBe(3);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.125);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.125);

      bus.emit('youtube:set-coordinator-manual-offset', 0.2);
      vi.advanceTimersByTime(600);
      expect(player.loadVideoById).toHaveBeenCalledTimes(1);
      expect(player.seekTo).toHaveBeenLastCalledWith(42.7, true);

      const repeatedQueueItemId = '22222222-2222-4222-8222-222222222222';
      setState('playlist.items', [
        ...getState('playlist.items'),
        {
          queueItemId: repeatedQueueItemId,
          type: 'youtube',
          name: 'Repeated Video',
          videoId: 'same-video',
          playlistId: null,
        },
      ]);
      setState('playlist.currentQueueItemId', repeatedQueueItemId);
      setState('youtube.currentSubIndex', 4);
      playlistIndex = 4;
      bus.emit('youtube:set-coordinator-manual-offset', 0.25);
      vi.advanceTimersByTime(600);

      expect(player.loadVideoById).toHaveBeenCalledTimes(2);
      const repeatedDetach = vi.mocked(player.loadVideoById).mock.calls.at(-1);
      expect(repeatedDetach?.[0]).toBe('same-video');
      expect(repeatedDetach?.[1]).toBeCloseTo(42.75, 2);
    });

    it('does not commit when native playlist detach is a silent no-op', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 42.5),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getPlaylistIndex: vi.fn(() => 3),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        cueVideoById: vi.fn(),
        loadVideoById: vi.fn(),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);
      setState('youtube.currentSubIndex', 3);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.125);

      expect(getState('sync.youtubeLocalOffset')).toBe(0.125);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      vi.advanceTimersByTime(3_600);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      expect(player.getPlaylistIndex()).toBe(3);
    });

    it('fails closed when a native playlist has no stable video identity to detach', async () => {
      const playerMod = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 42.5),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        getPlaylistIndex: vi.fn(() => 3),
        getVideoData: vi.fn(() => ({ video_id: '', title: '' })),
        loadVideoById: vi.fn(),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.125);

      expect(player.loadVideoById).not.toHaveBeenCalled();
      expect(player.seekTo).not.toHaveBeenCalled();
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
    });

    it('fails closed when native playlist metadata belongs to the outgoing video', async () => {
      const playerMod = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 42.5),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        getPlaylistIndex: vi.fn(() => 3),
        getVideoData: vi.fn(() => ({ video_id: 'outgoing-video', title: 'Outgoing' })),
        loadVideoById: vi.fn(),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.125);

      expect(player.loadVideoById).not.toHaveBeenCalled();
      expect(player.seekTo).not.toHaveBeenCalled();
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
    });

    it('retries a native-playlist detach after the player API throws', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 42.5;
      let playlistIndex = 3;
      const loadVideoById = vi
        .fn<(videoId: string, startSeconds?: number) => void>()
        .mockImplementationOnce(() => {
          throw new Error('transient iframe failure');
        })
        .mockImplementation((_videoId, startSeconds) => {
          currentTime = startSeconds ?? 0;
          playlistIndex = -1;
        });
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getPlaylistIndex: vi.fn(() => playlistIndex),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        loadVideoById,
        pauseVideo: vi.fn(),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.125);
      vi.advanceTimersByTime(600);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);

      bus.emit('youtube:set-coordinator-manual-offset', 0.125);
      vi.advanceTimersByTime(600);

      expect(loadVideoById).toHaveBeenCalledTimes(2);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.125);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.125);
    });

    it('rejects the coordinator-local setter on a standard guest', async () => {
      const playerMod = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 42.5),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 1),
        seekTo: vi.fn(),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'guest');
      setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.125);

      expect(player.seekTo).not.toHaveBeenCalled();
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
    });

    it('preserves a standard-host offset across room metadata updates and clears it on exit', async () => {
      vi.useFakeTimers();
      const playerMod = await import('../_state.ts');
      let currentTime = 42.5;
      const player = {
        getCurrentTime: vi.fn(() => currentTime),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
        getVideoData: vi.fn(() => ({ video_id: 'same-video', title: 'Same Video' })),
        seekTo: vi.fn((time: number) => {
          currentTime = time;
        }),
      } as unknown as YouTubePlayerInstance;
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(player);
      setPlaybackYouTubePlaying();
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);

      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      bus.emit('youtube:set-coordinator-manual-offset', 0.125);
      vi.advanceTimersByTime(600);

      expect(getState('sync.youtubeLocalOffset')).toBe(0.125);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.125);
      expect(getManagedTimer('yt-pro-coordinator-local-nudge')).toBeNull();

      setState('room.context', {
        ...getState('room.context'),
        snapshotRevision: 2,
      });
      expect(getState('sync.youtubeLocalOffset')).toBe(0.125);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.125);

      setState('network.sessionCode', '654321');
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      expect(getManagedTimer('yt-pro-coordinator-local-nudge')).toBeNull();

      bus.emit('youtube:set-coordinator-manual-offset', -0.125);
      vi.advanceTimersByTime(600);
      expect(getState('sync.youtubeLocalOffset')).toBe(-0.125);

      setState('network.hostConn', { open: true, peer: 'replacement-host' } as DataConnection);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      expect(getManagedTimer('yt-pro-coordinator-local-nudge')).toBeNull();

      setState('network.hostConn', null);
      bus.emit('youtube:set-coordinator-manual-offset', 0.05);
      vi.advanceTimersByTime(600);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.05);

      setState('setup.sessionStarted', false);
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      expect(getManagedTimer('yt-pro-coordinator-local-nudge')).toBeNull();
    });

    it('does not seek the local PRO player while zero-start owns the iframe', async () => {
      const playerMod = await import('../_state.ts');
      const player = {
        getCurrentTime: vi.fn(() => 42.5),
        getDuration: vi.fn(() => 120),
        getPlayerState: vi.fn(() => 2),
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
      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();
      zeroStartFacade.active = true;

      bus.emit('youtube:set-coordinator-manual-offset', 0.125);

      expect(player.seekTo).not.toHaveBeenCalled();
      expect(getState('sync.youtubeLocalOffset')).toBe(0);
    });

    it('keeps one canonical anchor across rapid local PRO nudges while seekTo is stale', async () => {
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
      expect(broadcast).not.toHaveBeenCalled();

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
