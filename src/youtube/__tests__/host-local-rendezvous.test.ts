import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { broadcast } from '../../network/peer.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import {
  cancelStandardHostManualOffsetTransaction,
  isStandardHostManualOffsetTransactionPending,
  prepareStandardHostManualOffsetRuntimeForTests,
  repairStandardHostManualOffsetTransaction,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';
import {
  isStandardHostYouTubeLocalStartPending,
  setStandardHostYouTubeLocalStartTimelineReader,
  toCanonicalYouTubeTime,
} from '../local-offset.ts';
import { isYouTubeAutoSyncPending } from '../player-runtime-bridge.ts';
import { registerYouTubeStartClaim } from '../start-ownership.ts';
import { registerProRoomLocalPlaybackTimeline } from '../../pro-room/local-playback-timeline.ts';
import type { ProRoomSnapshot } from '../../pro-room/contracts.ts';
import {
  commitProPlaybackAuthority,
  createProPlaybackAuthorityToken,
  prepareCurrentProPlaybackRendezvousAuthority,
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';

const QUEUE_ID = '11111111-1111-4111-8111-111111111111';
const EPOCH = 1_700_000_000_000;
const PLAY_TIMER = 'yt-standard-host-rendezvous-play';
const VERIFY_TIMER = 'yt-standard-host-offset-verify';
let unregisterProTimeline: (() => void) | null = null;

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn() }));
vi.mock('../../network/protocol.ts', () => ({ registerHandlers: vi.fn() }));
vi.mock('../search.ts', () => ({ fetchPlaylistSubTitles: vi.fn() }));
// zero-start.ts stays real: this suite never initializes a controller, so its
// facades answer false (no run) and keep answering whatever owns them next.
const latency = vi.hoisted(() => ({ output: 0 }));
vi.mock('../play-latency.ts', () => ({
  getEffectiveYouTubePlayLatencyMs: () => 200 + latency.output,
  getLocalYouTubeAudibleOutputDelayMs: () => latency.output,
}));
// The real legacy rendezvous takes its output lead from the platform: 250 ms
// on Android, which a row sets where the suite's output is that floor.
const platform = vi.hoisted(() => ({ android: false }));
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  get IS_ANDROID() {
    return platform.android;
  },
}));
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
  latency.output = 0;
  platform.android = false;
  await prepareStandardHostManualOffsetRuntimeForTests();
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  vi.clearAllMocks();
  resetState();
  const { setLocalYouTubePaused } = await import('../_state.ts');
  setLocalYouTubePaused(false);
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
  // A row drives the real Standard host start owner (player.ts's legacy
  // rendezvous and its local start wait). The start ledger and the runtime
  // bridge keep what player.ts registers when it loads, as src/app.ts loads it
  // at startup, so every row starts with them, whichever row loaded it first
  // (the recovery claim aside: see afterEach).
  await import('../player.ts');
  const { initYouTubeSync } = await import('../sync.ts');
  initYouTubeSync();
});

afterEach(() => {
  setStandardHostYouTubeLocalStartTimelineReader(null);
  vi.mocked(broadcast).mockReset();
  // A row stands in for the recovery claim. Its replacement answers false, as
  // player.ts's own does in this suite, where no recovery runs.
  registerYouTubeStartClaim('standard-recovery', [() => false, () => false]);
  unregisterProTimeline?.();
  unregisterProTimeline = null;
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([0, 250])('Standard-host local scheduled rendezvous (output %ims)', (output) => {
  beforeEach(() => {
    latency.output = output;
  });
  it.each([0, -0.4])(
    'hands a negative-start wait to a new manual offset %s without changing room time',
    async (offset) => {
      const fixture = makePlayer({ state: 2, position: 0 });
      await installPlayer(fixture);
      setState('sync.youtubeLocalOffset', -9.999);
      platform.android = output === 250;
      const { scheduleYtAutoSync } = await import('../player.ts');
      // The room frames and loading changes, '+<ms> ...' from the row's start.
      const room: string[] = [];
      vi.mocked(broadcast).mockImplementation((message) => {
        const frame = message as { type: string; state?: number; time?: number };
        room.push(`+${Date.now() - EPOCH} ${frame.type} ${frame.state} at ${frame.time}`);
      });
      bus.on('youtube:sync-loading', (busy, owner) => {
        room.push(`+${Date.now() - EPOCH} loading ${busy} ${owner}`);
      });
      // The host's own negative start: the legacy rendezvous holds this
      // speaker at 0:00 for 9,999 ms less the output lead while the room time
      // runs, then plays it, and sends its Stage 2 2 s after that.
      scheduleYtAutoSync(0);
      expect(isStandardHostYouTubeLocalStartPending()).toBe(true);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(
        -9.999 + output / 1000,
        5,
      );
      expect(isYouTubeAutoSyncPending()).toBe(true);
      const fallbackPending = vi.fn(() => false);
      // The stand-in recovery's claim, over the one player.ts registers.
      registerYouTubeStartClaim('standard-recovery', [() => false, fallbackPending]);
      vi.advanceTimersByTime(1_000);
      expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(1, 5);
      fallbackPending.mockClear();
      bus.emit('youtube:set-coordinator-manual-offset', offset, 'committed');

      // The edit's zero-start owner gate reaches the fallback claim.
      expect(fallbackPending).toHaveBeenCalled();
      // The edit retired the wait and its Stage 2 through the player's port.
      expect(isStandardHostYouTubeLocalStartPending()).toBe(false);
      expect(isYouTubeAutoSyncPending()).toBe(false);
      expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(1, 5);
      vi.advanceTimersByTime(100);
      expect(fixture.player.seekTo).toHaveBeenLastCalledWith(2.6 + offset, true);
      // Past the old release's due time and its Stage 2: neither runs.
      vi.advanceTimersByTime(11_900);
      expect(fixture.commands).toEqual([
        // The wait's own pause and seek to 0:00.
        { op: 'pause', at: 0, position: undefined },
        { op: 'seek', at: 0, position: 0 },
        // The edit's rendezvous from the held room time.
        { op: 'pause', at: 1000, position: undefined },
        { op: 'seek', at: 1100, position: 2.6 + offset },
        { op: 'play', at: 2400 - output, position: undefined },
      ]);
      expect(room).toEqual([
        // The wait's Stage 1; its Stage 2 (2 s after the old release) never goes out.
        `+0 ${MSG.YOUTUBE_STATE} 1 at 0`,
        // The player's retire port, then the edit's own rendezvous.
        '+1000 loading false undefined',
        '+1000 loading true rendezvous',
        `+${2400 - output} loading false rendezvous`,
      ]);
      expect(fixture.player.getPlayerState()).toBe(1);
      expect(getState('sync.youtubeLocalOffset')).toBe(offset);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(
        offset + output / 1000,
        5,
      );
      expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(13, 5);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    },
  );
  it('preserves the maximum negative manual hold while the room clock advances', async () => {
    const fixture = makePlayer({ position: 0 });
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', -9.999, 'committed');
    vi.advanceTimersByTime(7_100);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(7.1, 5);
    vi.advanceTimersByTime(4_500);
    expect(fixture.player.playVideo).toHaveBeenCalledOnce();
    expect(getState('sync.youtubeLocalOffset')).toBe(-9.999);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(-9.999 + output / 1000, 5);
    expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(11.6, 5);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
  });
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
      vi.advanceTimersByTime(599 - output);
      expect(fixture.player.playVideo).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fixture.commands.filter((command) => command.op === 'play')).toEqual([
        { op: 'play', at: 1400 - output, position: undefined },
      ]);
      vi.advanceTimersByTime(1_000);
      expect(fixture.player.getPlayerState()).toBe(1);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25 + output / 1000, 5);
      expect(getManagedTimer(PLAY_TIMER)).toBeNull();
      expect(getManagedTimer(VERIFY_TIMER)).toBeNull();
      expect(loading.mock.calls.at(-1)).toEqual([false, 'rendezvous']);
      broadcastYouTubeSync(true);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_SYNC,
          state: 1,
          time: expect.closeTo(12.4 - output / 1000, 5),
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
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25 + output / 1000, 5);
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
    vi.advanceTimersByTime(399 - output);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fixture.commands.filter((command) => command.op === 'play')).toEqual([
      { op: 'play', at: 2000 - output, position: undefined },
    ]);
    vi.advanceTimersByTime(1_000);
    expect(fixture.player.seekTo).toHaveBeenCalledTimes(2);
    expect(fixture.player.playVideo).toHaveBeenCalledOnce();
    expect(fixture.player.cueVideoById).toHaveBeenCalledOnce();
    expect(fixture.player.loadVideoById).not.toHaveBeenCalled();
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25 + output / 1000, 5);
    expect(toCanonicalYouTubeTime(fixture.player.getCurrentTime(), 120)).toBeCloseTo(
      13 - output / 1000,
      5,
    );
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
    expect(lastCommands[0]).toEqual({ op: 'seek', at: 2600, position: 12.6 + output / 1000 });
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
      { op: 'seek', at: 500, position: 10.5 + output / 1000 },
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
    expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(
      expect.closeTo(116.9 + output / 1000, 5),
      true,
    );
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
    vi.advanceTimersByTime(899 - output);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fixture.commands.find((command) => command.op === 'play')?.at).toBe(1400 - output);
    vi.advanceTimersByTime(1_000);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25 + output / 1000, 5);
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
    expect(fixture.player.seekTo).toHaveBeenCalledWith(12 + output / 1000, true);
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

describe.each([0, 250])('PRO participant local scheduled offset (output %ims)', (output) => {
  beforeEach(() => {
    latency.output = output;
  });
  function enterPro(
    role: 'coordinator' | 'member' = 'member',
    playing = true,
    positionSeconds = 10,
  ): { supersede(): void } {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role,
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 1,
      capabilities: [],
    });
    const snapshot = {
      roomCode: '000001',
      presence: { coordinatorEpoch: 7 },
      playback: {
        coordinatorEpoch: 7,
        revision: 1,
        state: playing ? 'playing' : 'paused',
        queueItemId: QUEUE_ID,
        youtubeVideoId: 'same-video',
        youtubeSubIndex: -1,
        positionSeconds,
        updatedAtMs: EPOCH,
      },
    } as ProRoomSnapshot;
    let current = true;
    unregisterProTimeline = registerProRoomLocalPlaybackTimeline({
      getSnapshot: () => snapshot,
      getServerNow: Date.now,
      isClockCalibrated: () => true,
      captureLiveness: () => () => current,
    });
    return {
      supersede: () => {
        current = false;
      },
    };
  }

  it.each(['coordinator', 'member'] as const)(
    'verifies a playing %s offset instead of immediately claiming the seek target',
    async (role) => {
      enterPro(role);
      const fixture = makePlayer({ position: 7 });
      await installPlayer(fixture);
      bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
      expect(fixture.player.pauseVideo).toHaveBeenCalledOnce();
      expect(fixture.player.seekTo).not.toHaveBeenCalled();
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
      vi.advanceTimersByTime(100);
      expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(11.85, true);
      vi.advanceTimersByTime(2_300);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25 + output / 1000, 5);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
      const { broadcast } = await import('../../network/peer.ts');
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('resets existing drift against the server clock and verifies zero before releasing', async () => {
    enterPro();
    const fixture = makePlayer({ position: 7.25 });
    await installPlayer(fixture);
    setState('sync.youtubeLocalOffset', 0.25);
    setState('sync.youtubeCoordinatorAppliedOffset', 0.25);
    bus.emit('youtube:set-coordinator-manual-offset', 0, 'committed');
    expect(fixture.player.pauseVideo).toHaveBeenCalledOnce();
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.25);
    vi.advanceTimersByTime(100);
    expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(11.6, true);
    vi.advanceTimersByTime(2_300);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(output / 1000, 5);
    expect(fixture.player.getCurrentTime()).toBeCloseTo(12.4 + output / 1000, 5);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
  });

  it('resets a paused participant to the paused server position without resuming', async () => {
    enterPro('member', false);
    const fixture = makePlayer({ state: 2, position: 7.25 });
    await installPlayer(fixture);
    setPlaybackYouTubePaused();
    setState('sync.youtubeLocalOffset', 0.25);
    setState('sync.youtubeCoordinatorAppliedOffset', 0.25);
    bus.emit('youtube:set-coordinator-manual-offset', 0, 'committed');
    expect(fixture.player.seekTo).toHaveBeenCalledExactlyOnceWith(10, true);
    vi.advanceTimersByTime(1_000);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
  });

  it.each([0, 0.25])(
    'keeps a locally paused PRO participant paused when committing offset %s to a playing room',
    async (offset) => {
      enterPro();
      const fixture = makePlayer({ state: 2, position: 7.1 });
      await installPlayer(fixture);
      const { setLocalYouTubePaused, isLocalYouTubePaused } = await import('../_state.ts');
      setLocalYouTubePaused(true);
      setPlaybackYouTubePaused();
      setState('sync.youtubeLocalOffset', 0.1);
      setState('sync.youtubeCoordinatorAppliedOffset', 0.1);

      bus.emit('youtube:set-coordinator-manual-offset', offset, 'committed');
      vi.advanceTimersByTime(2_500);

      expect(fixture.player.playVideo).not.toHaveBeenCalled();
      expect(fixture.player.getPlayerState()).toBe(2);
      expect(isLocalYouTubePaused()).toBe(true);
      expect(getState('sync.youtubeLocalOffset')).toBe(offset);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(offset, 5);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    },
  );

  it.each([50, 500, 1_350])(
    'retires a PRO offset plan when a newer local pause arrives at %i ms',
    async (pauseAt) => {
      enterPro();
      const fixture = makePlayer();
      await installPlayer(fixture);
      setState('sync.youtubeCoordinatorAppliedOffset', 0.1);
      bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
      vi.advanceTimersByTime(Math.max(0, pauseAt - output));
      const { setLocalYouTubePaused } = await import('../_state.ts');
      setLocalYouTubePaused(true);
      fixture.player.pauseVideo();
      vi.advanceTimersByTime(3_000);

      expect(fixture.player.playVideo).not.toHaveBeenCalled();
      expect(fixture.player.getPlayerState()).toBe(2);
      expect(getState('sync.youtubeLocalOffset')).toBe(0.25);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.1);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
      expect(getManagedTimer(PLAY_TIMER)).toBeNull();
      expect(getManagedTimer(VERIFY_TIMER)).toBeNull();
    },
  );

  it.each([false, true])(
    'only a current canonical COMMIT retires the local plan (stale=%s)',
    async (stale) => {
      enterPro();
      const fixture = makePlayer();
      await installPlayer(fixture);
      bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
      vi.advanceTimersByTime(500);
      const endpointCommit = vi.fn(async (request) => {
        expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
        expect(getState('sync.youtubeLocalOffset')).toBe(0.25);
        return { status: 'applied' as const, authority: request.authority };
      });
      registerProPlaybackMediaEndpoint({ prepare: vi.fn(), commit: endpointCommit });
      await commitProPlaybackAuthority({
        authority: createProPlaybackAuthorityToken({
          roomId: stale ? '000002' : '000001',
          roomEpoch: 7,
          basePlaybackRevision: 0,
          transitionId: null,
        }),
        committedPlaybackRevision: 1,
        queueItemId: QUEUE_ID,
        state: 'paused',
        positionSeconds: 40,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
        youtubeVideoId: 'same-video',
        youtubeSubIndex: -1,
      });
      expect(endpointCommit).toHaveBeenCalledTimes(stale ? 0 : 1);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(stale);
      vi.advanceTimersByTime(3_000);
      expect(fixture.player.playVideo).toHaveBeenCalledTimes(stale ? 1 : 0);
    },
  );

  it('retires delayed local play when the same room is reopened in another runtime generation', async () => {
    enterPro();
    const fixture = makePlayer();
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(500);
    unregisterProTimeline?.();
    enterPro();
    vi.advanceTimersByTime(3_000);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
  });

  it('preserves the personal offset when a newer same-media revision is waiting for its endpoint', async () => {
    const timeline = enterPro();
    const fixture = makePlayer();
    await installPlayer(fixture);
    setState('sync.youtubeCoordinatorAppliedOffset', 0.1);
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(500);
    timeline.supersede();
    vi.advanceTimersByTime(3_000);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    expect(getState('sync.youtubeLocalOffset')).toBe(0.25);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.1);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
  });

  it('does not let a stale same-revision local reconciliation cancel a newer offset', async () => {
    enterPro();
    const fixture = makePlayer();
    await installPlayer(fixture);
    const prepare = vi.fn();
    registerProPlaybackMediaEndpoint({
      prepare,
      commit: async (request) => ({ status: 'applied', authority: request.authority }),
    });
    await commitProPlaybackAuthority({
      authority: createProPlaybackAuthorityToken({
        roomId: '000001',
        roomEpoch: 7,
        basePlaybackRevision: 0,
        transitionId: null,
      }),
      committedPlaybackRevision: 1,
      queueItemId: QUEUE_ID,
      state: 'playing',
      positionSeconds: 10,
      scheduleDelayMs: 0,
      timingMode: 'scheduled-control',
      youtubeVideoId: 'same-video',
      youtubeSubIndex: -1,
    });
    bus.emit('youtube:set-coordinator-manual-offset', 0.25, 'committed');
    vi.advanceTimersByTime(500);
    const result = await prepareCurrentProPlaybackRendezvousAuthority({
      authority: createProPlaybackAuthorityToken({
        roomId: '000001',
        roomEpoch: 7,
        basePlaybackRevision: 0,
        transitionId: 'old-local-sync',
      }),
      queueItemId: QUEUE_ID,
      state: 'playing',
      positionSeconds: 10,
      youtubeVideoId: 'same-video',
      youtubeSubIndex: -1,
      isCurrent: () => false,
    });
    expect(result.status).toBe('superseded');
    expect(prepare).not.toHaveBeenCalled();
    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(fixture.player.playVideo).toHaveBeenCalledOnce();
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(0.25 + output / 1000, 5);
  });

  it('preserves the maximum negative manual hold near media zero', async () => {
    enterPro('member', true, 0);
    const fixture = makePlayer({ position: 0 });
    await installPlayer(fixture);
    bus.emit('youtube:set-coordinator-manual-offset', -9.999, 'committed');
    vi.advanceTimersByTime(7_100);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(true);
    expect(fixture.player.playVideo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_500);
    expect(fixture.player.playVideo).toHaveBeenCalledOnce();
    expect(getState('sync.youtubeLocalOffset')).toBe(-9.999);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBeCloseTo(-9.999 + output / 1000, 5);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
  });
});
