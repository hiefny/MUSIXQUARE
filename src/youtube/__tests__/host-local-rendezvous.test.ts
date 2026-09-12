import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import {
  cancelStandardHostManualOffsetTransaction,
  isStandardHostManualOffsetTransactionPending,
  prepareStandardHostManualOffsetRuntimeForTests,
  repairStandardHostManualOffsetTransaction,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';
import { toCanonicalYouTubeTime } from '../local-offset.ts';

const QUEUE_ID = '11111111-1111-4111-8111-111111111111';
const EPOCH = 1_700_000_000_000;
const PLAY_TIMER = 'yt-standard-host-rendezvous-play';
const VERIFY_TIMER = 'yt-standard-host-offset-verify';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn() }));
vi.mock('../../network/protocol.ts', () => ({ registerHandlers: vi.fn() }));
vi.mock('../search.ts', () => ({ fetchPlaylistSubTitles: vi.fn() }));
vi.mock('../zero-start.ts', () => ({ isYouTubeZeroStartProtocolActive: vi.fn(() => false) }));
vi.mock('../play-latency.ts', () => ({ getEffectiveYouTubePlayLatencyMs: () => 200 }));
vi.mock('../_state.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_state.ts')>()),
  getYouTubePlayer: vi.fn(() => null),
}));

interface Command {
  op: 'pause' | 'seek' | 'play' | 'cue' | 'load';
  at: number;
  position?: number;
}

function makePlayer(
  options: {
    state?: number;
    position?: number;
    pauseNeverReady?: boolean;
    autoPlayFirstSeek?: boolean;
  } = {},
) {
  let state = options.state ?? 1;
  let position = options.position ?? 10;
  let positionAt = Date.now();
  let wantPlaying = state === 1;
  let playPending = false;
  let pauseGeneration = 0;
  let seekGeneration = 0;
  let playGeneration = 0;
  let videoId = 'same-video';
  let playlistIndex = -1;
  let invalidTime: 'nan' | 'throw' | null = null;
  let frozenTime = false;
  const commands: Command[] = [];
  const readPhysicalTime = (): number =>
    frozenTime ? 10 : position + (state === 1 ? (Date.now() - positionAt) / 1000 : 0);
  const update = (nextState: number, nextPosition = readPhysicalTime()): void => {
    position = nextPosition;
    positionAt = Date.now();
    state = nextState;
  };
  const record = (op: Command['op'], target?: number): void => {
    commands.push({ op, at: Date.now() - EPOCH, position: target });
  };
  const player = {
    getCurrentTime: vi.fn(() => {
      if (invalidTime === 'throw') throw new Error('iframe time unavailable');
      return invalidTime === 'nan' ? NaN : readPhysicalTime();
    }),
    getDuration: vi.fn(() => 120),
    getPlayerState: vi.fn(() => state),
    getPlaylistIndex: vi.fn(() => playlistIndex),
    getVideoData: vi.fn(() => ({ video_id: videoId, title: 'Same Video' })),
    pauseVideo: vi.fn(() => {
      record('pause');
      wantPlaying = false;
      playPending = false;
      playGeneration += 1;
      update(3);
      const generation = ++pauseGeneration;
      if (options.pauseNeverReady) return;
      setTimeout(() => {
        if (generation === pauseGeneration && !wantPlaying) update(2);
      }, 100);
    }),
    seekTo: vi.fn((target: number) => {
      record('seek', target);
      update(3);
      const generation = ++seekGeneration;
      setTimeout(() => {
        if (generation !== seekGeneration) return;
        update(wantPlaying && !playPending ? 1 : 2, target);
        if (options.autoPlayFirstSeek && generation === 1) {
          // CUED playback can first report a ready paused seek, then start
          // playing autonomously. Its physical position advances until paused.
          setTimeout(() => {
            if (generation === seekGeneration) update(1);
          }, 130);
        }
      }, 120);
    }),
    playVideo: vi.fn(() => {
      record('play');
      wantPlaying = true;
      playPending = true;
      update(3);
      const generation = ++playGeneration;
      setTimeout(() => {
        if (generation !== playGeneration) return;
        playPending = false;
        update(1);
      }, 200);
    }),
    cueVideoById: vi.fn((_id: string, target = 0) => {
      record('cue', target);
      wantPlaying = false;
      update(3);
      videoId = '';
      setTimeout(() => {
        videoId = 'same-video';
        playlistIndex = -1;
        update(5, target);
      }, 200);
    }),
    loadVideoById: vi.fn((_id: string, target = 0) => {
      record('load', target);
      wantPlaying = true;
      update(3, target);
      setTimeout(() => update(1), 200);
    }),
  } as unknown as YouTubePlayerInstance;
  return {
    player,
    commands,
    setPlaylist: () => {
      playlistIndex = 0;
    },
    setInvalidTime: (value: typeof invalidTime) => {
      invalidTime = value;
    },
    freezeTime: () => {
      frozenTime = true;
    },
  };
}

type Fixture = ReturnType<typeof makePlayer>;

async function installPlayer(fixture: Fixture): Promise<void> {
  const state = await import('../_state.ts');
  vi.mocked(state.getYouTubePlayer).mockReturnValue(fixture.player);
}

function selectPlaylist(fixture: Fixture): void {
  fixture.setPlaylist();
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ID,
      type: 'youtube',
      name: 'Playlist',
      videoId: 'same-video',
      playlistId: 'PL-safe',
    },
  ]);
  setState('youtube.subItemsMap', { 'PL-safe': { ids: ['same-video'], titles: ['Same Video'] } });
  setState('youtube.currentSubIndex', 0);
}

beforeEach(async () => {
  await prepareStandardHostManualOffsetRuntimeForTests();
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  vi.clearAllMocks();
  resetState();
  bus.clear();
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
  setPlaybackYouTubePlaying();
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ID,
      type: 'youtube',
      name: 'Same Video',
      videoId: 'same-video',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ID);
  const { initYouTubeSync } = await import('../sync.ts');
  initYouTubeSync();
});

afterEach(() => {
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Standard-host local scheduled rendezvous', () => {
  it.each([1, 3])(
    'rejoins the future canonical target while preserving playing intent from state %i',
    async (state) => {
      const fixture = makePlayer({ state });
      await installPlayer(fixture);
      const loading = vi.fn();
      bus.on('youtube:sync-loading', loading);
      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');

      bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
      expect(fixture.player.pauseVideo).toHaveBeenCalledOnce();
      expect(fixture.player.seekTo).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(11.85, true);
      vi.advanceTimersByTime(700);
      expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(10.8, 5);
      expect(getState('playback.activity')).toBe('playing');
      broadcastYouTubeSync(true);
      expect(broadcast).not.toHaveBeenCalled();
      vi.advanceTimersByTime(599);
      expect(fixture.player.playVideo).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fixture.commands.filter((command) => command.op === 'play')).toEqual([
        { op: 'play', at: 1400, position: undefined },
      ]);
      vi.advanceTimersByTime(1_000);
      expect(fixture.player.getPlayerState()).toBe(1);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25, 5);
      expect(getManagedTimer(PLAY_TIMER)).toBeNull();
      expect(getManagedTimer(VERIFY_TIMER)).toBeNull();
      expect(loading.mock.calls.at(-1)).toEqual([false, 'rendezvous']);
      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_SYNC,
          state: 1,
          time: expect.closeTo(12.4, 5),
        }),
      );
    },
  );

  it('keeps paused-origin input paused and performs no scheduled resume', async () => {
    const fixture = makePlayer({ state: 2 });
    await installPlayer(fixture);
    setPlaybackYouTubePaused();
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(10.25, true);
    vi.advanceTimersByTime(1_000);
    expect(fixture.player.pauseVideo).not.toHaveBeenCalled();
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25, 5);
  });

  it('detaches a playlist once before preparing the future subitem target', async () => {
    const fixture = makePlayer();
    await installPlayer(fixture);
    selectPlaylist(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    expect(fixture.player.cueVideoById).toHaveBeenCalledExactlyOnceWith('same-video', 10);
    vi.advanceTimersByTime(300);
    expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(12.05, true);
    vi.advanceTimersByTime(2_300);
    expect(fixture.player.cueVideoById).toHaveBeenCalledOnce();
    expect(fixture.player.loadVideoById).not.toHaveBeenCalled();
    expect(getState('youtube.currentSubIndex')).toBe(0);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25, 5);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
  });

  it('replans the future target after a prepared CUED seek unexpectedly starts playing', async () => {
    const fixture = makePlayer({ autoPlayFirstSeek: true });
    await installPlayer(fixture);
    selectPlaylist(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(500);
    expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(12.05, true);
    expect(getManagedTimer(PLAY_TIMER)).not.toBeNull();
    vi.advanceTimersByTime(100);
    expect(fixture.player.pauseVideo).toHaveBeenCalledTimes(2);
    expect(getManagedTimer(PLAY_TIMER)).toBeNull();
    vi.advanceTimersByTime(100);
    expect(fixture.player.seekTo).toHaveBeenCalledTimes(2);
    expect(fixture.player.seekTo).toHaveBeenLastCalledWith(12.45, true);
    vi.advanceTimersByTime(900);
    // The first plan's 1600 ms resume must not fire after the replacement.
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fixture.commands.filter((command) => command.op === 'play')).toEqual([
      { op: 'play', at: 2000, position: undefined },
    ]);
    vi.advanceTimersByTime(1_000);
    expect(fixture.player.seekTo).toHaveBeenCalledTimes(2);
    expect(fixture.player.playVideo).toHaveBeenCalledOnce();
    expect(fixture.player.cueVideoById).toHaveBeenCalledOnce();
    expect(fixture.player.loadVideoById).not.toHaveBeenCalled();
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25, 5);
    expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(13, 5);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    expect(getManagedTimer(PLAY_TIMER)).toBeNull();
  });

  it.each(['queue', 'player', 'session', 'cancel'] as const)(
    'retires the scheduled resume after %s replacement/cancellation',
    async (change) => {
      const fixture = makePlayer();
      await installPlayer(fixture);
      bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
      vi.advanceTimersByTime(500);
      expect(getManagedTimer(PLAY_TIMER)).not.toBeNull();
      if (change === 'queue') setState('playlist.currentQueueItemId', 'replacement-queue');
      if (change === 'player') await installPlayer(makePlayer());
      if (change === 'session') setState('network.sessionCode', '654321');
      if (change === 'cancel') cancelStandardHostManualOffsetTransaction();
      vi.advanceTimersByTime(3_000);
      expect(fixture.player.playVideo).not.toHaveBeenCalled();
      expect(getManagedTimer(PLAY_TIMER)).toBeNull();
      expect(getManagedTimer(VERIFY_TIMER)).toBeNull();
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    },
  );

  it('abandons a late timer target and seeks the current canonical position before rollback resumes', async () => {
    const fixture = makePlayer();
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(500);
    vi.setSystemTime(EPOCH + 2_500);
    vi.advanceTimersByTime(100);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    const lastCommands = fixture.commands.slice(-2);
    expect(lastCommands[0]).toEqual({ op: 'seek', at: 2600, position: 12.6 });
    expect(lastCommands[1]).toEqual({ op: 'play', at: 2600, position: undefined });
    vi.advanceTimersByTime(4_000);
    const commandCount = fixture.commands.length;
    vi.advanceTimersByTime(10_000);
    expect(fixture.commands).toHaveLength(commandCount);
    expect(getManagedTimer(PLAY_TIMER)).toBeNull();
  });

  it('resumes promptly when an internal zero replaces a prepared scheduled round', async () => {
    const fixture = makePlayer();
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(500);
    expect(fixture.player.getPlayerState()).toBe(2);
    expect(getManagedTimer(PLAY_TIMER)).not.toBeNull();

    // The end-boundary guard uses the internal immediate path. It inherits
    // the obligation to resume the host that the retired round paused.
    bus.emit('youtube:set-coordinator-manual-offset', 0);
    expect(fixture.commands.slice(-2)).toEqual([
      { op: 'seek', at: 500, position: 10.5 },
      { op: 'play', at: 500, position: undefined },
    ]);
    expect(getManagedTimer(PLAY_TIMER)).toBeNull();
    vi.advanceTimersByTime(2_500);
    expect(fixture.player.playVideo).toHaveBeenCalledOnce();
    expect(fixture.player.loadVideoById).not.toHaveBeenCalled();
    expect(fixture.player.getPlayerState()).toBe(1);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(13, 5);
  });

  it('rejects a future target entering the end guard and restores the current canonical position', async () => {
    const fixture = makePlayer({ position: 116.8 });
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(100);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(expect.closeTo(116.9, 5), true);
    expect(fixture.player.playVideo).toHaveBeenCalledOnce();
    expect(getManagedTimer(PLAY_TIMER)).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(fixture.player.loadVideoById).not.toHaveBeenCalled();
    expect(fixture.player.playVideo).toHaveBeenCalledOnce();
    // Asynchronous rollback playback leaves a small residual. The existing
    // post-timeout verification must keep that boundary gated at this point.
    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
  });

  it('repairs cleared managed timers without losing the original future deadline', async () => {
    const fixture = makePlayer();
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(500);
    clearAllManagedTimers();
    repairStandardHostManualOffsetTransaction();
    vi.advanceTimersByTime(899);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fixture.commands.find((command) => command.op === 'play')?.at).toBe(1400);
    vi.advanceTimersByTime(1_000);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25, 5);
  });

  it.each(['nan', 'throw'] as const)(
    'does not command an iframe whose initial time read is %s',
    async (failure) => {
      const fixture = makePlayer();
      fixture.setInvalidTime(failure);
      await installPlayer(fixture);
      bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
      vi.advanceTimersByTime(4_000);
      expect(fixture.commands).toEqual([]);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      expect(getManagedTimer(PLAY_TIMER)).toBeNull();
    },
  );

  it('bounds preparation failure and never resumes the obsolete prepared target', async () => {
    const fixture = makePlayer({ pauseNeverReady: true });
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(1_999);
    expect(fixture.player.seekTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    expect(fixture.player.seekTo).toHaveBeenCalledWith(12, true);
    vi.advanceTimersByTime(5_000);
    const commandCount = fixture.commands.length;
    expect(commandCount).toBeLessThanOrEqual(10);
    vi.advanceTimersByTime(10_000);
    expect(fixture.commands).toHaveLength(commandCount);
  });

  it('keeps frozen observations gated while bounding recovery commands', async () => {
    const fixture = makePlayer();
    fixture.freezeTime();
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(8_000);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    const commandCount = fixture.commands.length;
    vi.advanceTimersByTime(10_000);
    expect(fixture.commands).toHaveLength(commandCount);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
    expect(getManagedTimer(PLAY_TIMER)).toBeNull();
  });
});
