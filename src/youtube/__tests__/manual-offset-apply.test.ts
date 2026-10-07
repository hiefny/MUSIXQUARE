/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  incrementSessionId,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  type YouTubePlayerInstance,
} from '../_state.ts';
import {
  initYouTubeSync,
  invalidateGuestYouTubeTimeline,
  isGuestYouTubeTransitionPending,
  resetYouTubeSyncState,
} from '../sync.ts';
import { showToast } from '../../ui/toast.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const QUEUE_ID = '11111111-1111-4111-8111-111111111111';
const RETRY_TIMER = 'yt-manual-offset-apply-retry';
const EPOCH = 1_700_000_000_000;
const handlers: Record<string, (data: Record<string, unknown>, conn: DataConnection) => void> = {};
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn((registered) => Object.assign(handlers, registered)),
}));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn() }));
vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: () => Date.now(),
  isClockCalibrated: () => true,
}));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../../player/transport.ts', () => ({ fmtTime: (time: number) => String(time) }));
vi.mock('../search.ts', () => ({ fetchPlaylistSubTitles: vi.fn() }));
vi.mock('../iframe-runtime-bridge.ts', () => ({
  cancelGuestEndedFallbackFromSync: vi.fn(),
  hideYouTubeTapToPlayGateFromSync: vi.fn(),
  invalidateYtDurationCacheFromSync: vi.fn(),
  expectYouTubeMetadataVideoIdFromSync: vi.fn(),
  prepareYouTubeMediaReplacementFromSync: vi.fn(() => true),
}));

let player: FakeYtPlayer;
let host: DataConnection;

function snapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    queueItemId: QUEUE_ID,
    videoId: 'video-one',
    subIndex: 0,
    time: 10 + (Date.now() - EPOCH) / 1000,
    hostClock: Date.now(),
    state: 1,
    ...extra,
  };
}

function heartbeat(extra: Record<string, unknown> = {}): void {
  handlers[MSG.YOUTUBE_SYNC](snapshot(extra), host);
}

function commitOffset(offset: number): void {
  // network/sync stores the accepted device preference before this event.
  setState('sync.youtubeLocalOffset', offset);
  bus.emit('youtube:apply-manual-sync');
}

beforeEach(() => {
  clearAllManagedTimers();
  resetState();
  resetYouTubeModuleState();
  bus.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
  host = { peer: 'host-one', open: true, send: vi.fn(), close: vi.fn(), on: vi.fn() };
  player = makeFakeYtPlayer({
    __videoId: 'video-one',
    __currentTime: 10,
    __state: 1,
    __duration: 300,
    __advanceClock: true,
  });
  player.__setState(1, false);
  setYouTubePlayer(player as unknown as YouTubePlayerInstance);
  setPlaybackYouTubePlaying();
  setState('network.appRole', 'guest');
  setState('network.hostConn', host);
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ID,
      type: 'youtube',
      name: 'Video',
      videoId: 'video-one',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ID);
  setState('youtube.currentSubIndex', 0);
  initYouTubeSync();
  resetYouTubeSyncState();
});

afterEach(() => {
  resetYouTubeSyncState();
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('accepted guest manual offsets waiting for a host snapshot', () => {
  it.each([-0.25, 0, 0.25])(
    'applies %s after repeat-one zero-start retires the old snapshot',
    (offset) => {
      heartbeat();
      invalidateGuestYouTubeTimeline();
      commitOffset(offset);
      expect(isGuestYouTubeTransitionPending()).toBe(true);
      expect(player.__log).toHaveLength(0);
      vi.advanceTimersByTime(2100);
      heartbeat();
      vi.advanceTimersByTime(4000);
      const canonical = 10 + (Date.now() - EPOCH) / 1000;
      expect(player.getCurrentTime() - canonical).toBeCloseTo(offset, 5);
      expect(player.__log.filter((call) => call.op === 'seekTo')).toHaveLength(1);
      expect(getManagedTimer(RETRY_TIMER)).toBeNull();
      expect(getState('sync.youtubeLocalOffset')).toBe(offset);
      expect(showToast).not.toHaveBeenCalledWith('toast.yt_rendezvous_no_data');
    },
  );

  it('waits for a fresh snapshot when the previous one has expired', () => {
    heartbeat();
    vi.advanceTimersByTime(11000);
    commitOffset(0.25);
    expect(getManagedTimer(RETRY_TIMER)).not.toBeNull();
    vi.advanceTimersByTime(2000);
    heartbeat();
    vi.advanceTimersByTime(4000);
    expect(player.getCurrentTime() - (10 + (Date.now() - EPOCH) / 1000)).toBeCloseTo(0.25, 5);
  });

  it('waits through the maximum host start hold before its ordinary heartbeat resumes', () => {
    commitOffset(0.25);
    vi.advanceTimersByTime(13000);
    expect(getManagedTimer(RETRY_TIMER)).not.toBeNull();
    expect(player.__log).toHaveLength(0);
    heartbeat();
    vi.advanceTimersByTime(4000);
    expect(player.getCurrentTime() - 27).toBeCloseTo(0.25, 5);
    expect(player.__log.filter((call) => call.op === 'seekTo')).toHaveLength(1);
    expect(showToast).not.toHaveBeenCalledWith('toast.yt_rendezvous_no_data');
  });

  it('retains only the newest input while waiting, including Reset', () => {
    commitOffset(0.5);
    vi.advanceTimersByTime(500);
    commitOffset(-0.5);
    vi.advanceTimersByTime(500);
    commitOffset(0);
    heartbeat();
    vi.advanceTimersByTime(4000);
    expect(player.__log.filter((call) => call.op === 'seekTo')).toHaveLength(1);
    expect(player.getCurrentTime()).toBeCloseTo(15, 5);
    expect(getState('sync.youtubeLocalOffset')).toBe(0);
  });

  it('expires without repeated error toasts or reviving on a late heartbeat', () => {
    commitOffset(0.25);
    expect(isGuestYouTubeTransitionPending()).toBe(true);
    vi.advanceTimersByTime(20000);
    expect(getManagedTimer(RETRY_TIMER)).toBeNull();
    expect(isGuestYouTubeTransitionPending()).toBe(false);
    expect(showToast).toHaveBeenCalledExactlyOnceWith('toast.yt_rendezvous_no_data');
    heartbeat();
    vi.advanceTimersByTime(4000);
    expect(player.__log).toHaveLength(0);
  });

  it.each([1, 2, 0])('cancels the pending edit when a newer host state %s arrives', (state) => {
    commitOffset(0.25);
    expect(getManagedTimer(RETRY_TIMER)).not.toBeNull();
    handlers[MSG.YOUTUBE_STATE](snapshot({ state, time: 40, hostPlayAt: 0 }), host);
    expect(getManagedTimer(RETRY_TIMER)).toBeNull();
    vi.advanceTimersByTime(4000);
    // The new room command can seek/play, but cannot inherit a second local
    // rendezvous from the older edit waiting for data.
    expect(player.__log.filter((call) => call.op === 'pauseVideo').length).toBeLessThanOrEqual(
      state === 0 ? 0 : 1,
    );
    expect(isGuestYouTubeTransitionPending()).toBe(false);
  });

  it('retires an older apply while a newer nudge is still being debounced', () => {
    commitOffset(0.25);
    setState('sync.youtubeLocalOffset', -0.5);
    vi.advanceTimersByTime(500);
    expect(getManagedTimer(RETRY_TIMER)).toBeNull();
    heartbeat();
    expect(player.__log).toHaveLength(0);
    bus.emit('youtube:apply-manual-sync');
    vi.advanceTimersByTime(4000);
    expect(player.getCurrentTime() - 14.5).toBeCloseTo(-0.5, 5);
    expect(player.__log.filter((call) => call.op === 'seekTo')).toHaveLength(1);
  });

  it('does not clear a newer edit emitted synchronously by a player callback', () => {
    let replaced = false;
    player.__onStateChange = ({ data }) => {
      if (data === 2 && !replaced) {
        replaced = true;
        commitOffset(-0.25);
      }
    };
    heartbeat();
    commitOffset(0.25);
    expect(getState('sync.youtubeLocalOffset')).toBe(-0.25);
    expect(getManagedTimer(RETRY_TIMER)).not.toBeNull();
    vi.advanceTimersByTime(8000);
    expect(player.getCurrentTime() - 18).toBeCloseTo(-0.25, 5);
    expect(player.__log.filter((call) => call.op === 'seekTo')).toHaveLength(2);
    expect(getManagedTimer(RETRY_TIMER)).toBeNull();
  });

  it.each([
    'host',
    'connection-close',
    'session',
    'queue',
    'sub-index',
    'video',
    'player',
    'mode',
    'local-pause',
    'repeat',
    'leave',
  ] as const)(
    'retires an accepted request when %s changes before the snapshot arrives',
    (change) => {
      commitOffset(0.25);
      expect(getManagedTimer(RETRY_TIMER)).not.toBeNull();
      if (change === 'host') setState('network.hostConn', { ...host });
      if (change === 'connection-close') host.open = false;
      if (change === 'session') incrementSessionId();
      if (change === 'queue') setState('playlist.currentQueueItemId', 'replacement');
      if (change === 'sub-index') setState('youtube.currentSubIndex', 1);
      if (change === 'video') player.__videoId = 'video-two';
      if (change === 'player')
        setYouTubePlayer(makeFakeYtPlayer() as unknown as YouTubePlayerInstance);
      if (change === 'mode') setState('playback.mode', 'file');
      if (change === 'local-pause') setLocalYouTubePaused(true);
      if (change === 'repeat') invalidateGuestYouTubeTimeline();
      if (change === 'leave') resetYouTubeSyncState();
      vi.advanceTimersByTime(10000);
      expect(getManagedTimer(RETRY_TIMER)).toBeNull();
      expect(player.__log).toHaveLength(0);
      expect(showToast).not.toHaveBeenCalledWith('toast.yt_rendezvous_no_data');
    },
  );
});
