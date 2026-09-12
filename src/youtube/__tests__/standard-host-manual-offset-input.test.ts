import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import {
  incrementSessionId,
  resetYouTubeModuleState,
  setYouTubePlayer,
  type YouTubePlayerInstance,
} from '../_state.ts';
import {
  afterStandardHostManualOffsetTransaction,
  cancelStandardHostManualOffsetTransaction,
  isStandardHostManualOffsetTransactionPending,
  prepareStandardHostManualOffsetRuntimeForTests,
  requestStandardHostManualOffsetTransaction,
  requestUserStandardHostManualOffsetTransaction,
  resetStandardHostManualOffsetTransaction,
  type StandardHostManualOffsetLease,
} from '../standard-host-manual-offset-gate.ts';

const runtime = vi.hoisted(() => ({ begin: vi.fn() }));
vi.mock('../standard-host-manual-offset-runtime.ts', () => ({
  beginStandardHostManualOffsetTransaction: runtime.begin,
}));

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';
let player: YouTubePlayerInstance;

function lastLease(): StandardHostManualOffsetLease {
  return runtime.begin.mock.calls.at(-1)?.[0] as StandardHostManualOffsetLease;
}

function finish(
  lease: StandardHostManualOffsetLease,
  requested: number,
  applied = requested,
): void {
  expect(
    lease.commit(() => {
      setState('sync.youtubeLocalOffset', requested);
      setState('sync.youtubeCoordinatorAppliedOffset', applied);
    }),
  ).toBe(true);
}

beforeEach(async () => {
  await prepareStandardHostManualOffsetRuntimeForTests();
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  resetState();
  resetYouTubeModuleState();
  bus.clear();
  runtime.begin.mockClear();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  player = {} as YouTubePlayerInstance;
  setYouTubePlayer(player);
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Video',
      videoId: 'same-video',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setPlaybackYouTubePlaying();
});

afterEach(() => {
  resetStandardHostManualOffsetTransaction();
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('Standard-host manual-offset user input', () => {
  it('coalesces a click burst without reserving playback during the trailing delay', () => {
    setState('sync.youtubeLocalOffset', 0.3);
    setState('sync.youtubeCoordinatorAppliedOffset', 0.28);
    requestUserStandardHostManualOffsetTransaction(player, 0.31, 'debounced');
    vi.advanceTimersByTime(400);
    requestUserStandardHostManualOffsetTransaction(player, 0.32, 'debounced');
    vi.advanceTimersByTime(400);
    requestUserStandardHostManualOffsetTransaction(player, 0.33, 'debounced');
    vi.advanceTimersByTime(999);

    expect(getState('sync.youtubeLocalOffset')).toBe(0.33);
    expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.28);
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    expect(afterStandardHostManualOffsetTransaction(vi.fn())).toBe(false);
    expect(runtime.begin).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(runtime.begin).toHaveBeenCalledOnce();
    expect(lastLease()).toMatchObject({
      scheduled: true,
      requestedOffsetSeconds: 0.33,
      priorRequestedOffset: 0.3,
      priorAppliedOffset: 0.28,
    });
  });

  it.each([1, 0])('a numeric commit or Reset to %s cancels the trailing draft', (value) => {
    requestUserStandardHostManualOffsetTransaction(player, 0.5, 'debounced');
    vi.advanceTimersByTime(100);
    requestUserStandardHostManualOffsetTransaction(player, value, 'committed');
    expect(runtime.begin).toHaveBeenCalledOnce();
    expect(lastLease()).toMatchObject({ scheduled: true, requestedOffsetSeconds: value });
    vi.advanceTimersByTime(2_000);
    expect(runtime.begin).toHaveBeenCalledOnce();
  });

  it('serializes only the latest queued input and preserves its display through rollback and commit', async () => {
    requestUserStandardHostManualOffsetTransaction(player, 0.1, 'committed');
    const first = lastLease();
    requestUserStandardHostManualOffsetTransaction(player, 0.2, 'debounced');
    requestUserStandardHostManualOffsetTransaction(player, 0.3, 'committed');
    vi.advanceTimersByTime(1_200);
    expect(runtime.begin).toHaveBeenCalledOnce();
    expect(first.isCurrent()).toBe(true);
    first.publishRequestedOffset(0);
    expect(getState('sync.youtubeLocalOffset')).toBe(0.3);

    finish(first, 0, -0.05);
    expect(getState('sync.youtubeLocalOffset')).toBe(0.3);
    expect(runtime.begin).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(runtime.begin).toHaveBeenCalledTimes(2);
    expect(lastLease()).toMatchObject({
      scheduled: true,
      requestedOffsetSeconds: 0.3,
      priorRequestedOffset: 0,
      priorAppliedOffset: -0.05,
    });
    expect(first.isCurrent()).toBe(false);
    finish(lastLease(), 0.3, 0.27);
    vi.advanceTimersByTime(2_000);
    expect(runtime.begin).toHaveBeenCalledTimes(2);
  });

  it('dispatches a queued click burst once its active predecessor settles', async () => {
    requestUserStandardHostManualOffsetTransaction(player, 0.1, 'committed');
    const first = lastLease();
    requestUserStandardHostManualOffsetTransaction(player, 0.2, 'debounced');
    vi.advanceTimersByTime(1_200);
    expect(runtime.begin).toHaveBeenCalledOnce();
    finish(first, 0.1, 0.09);
    await Promise.resolve();
    expect(runtime.begin).toHaveBeenCalledTimes(2);
    expect(lastLease()).toMatchObject({ requestedOffsetSeconds: 0.2, priorRequestedOffset: 0.1 });
  });

  it('does not delay settlement listeners for a draft whose debounce is still pending', async () => {
    requestUserStandardHostManualOffsetTransaction(player, 0.1, 'committed');
    const first = lastLease();
    const settled = vi.fn();
    expect(afterStandardHostManualOffsetTransaction(settled)).toBe(true);
    requestUserStandardHostManualOffsetTransaction(player, 0.2, 'debounced');
    vi.advanceTimersByTime(200);
    finish(first, 0.1);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce();
    expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    vi.advanceTimersByTime(800);
    expect(runtime.begin).toHaveBeenCalledTimes(2);
  });

  it('keeps settlement listeners behind a ready queued command', async () => {
    requestUserStandardHostManualOffsetTransaction(player, 0.1, 'committed');
    const first = lastLease();
    const settled = vi.fn();
    afterStandardHostManualOffsetTransaction(settled);
    requestUserStandardHostManualOffsetTransaction(player, 0.2, 'committed');
    finish(first, 0.1);
    await Promise.resolve();
    expect(runtime.begin).toHaveBeenCalledTimes(2);
    expect(settled).not.toHaveBeenCalled();
    finish(lastLease(), 0.2);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('an internal end guard cancels user input and retains the verified baseline', () => {
    setState('sync.youtubeLocalOffset', 0.3);
    setState('sync.youtubeCoordinatorAppliedOffset', 0.28);
    requestUserStandardHostManualOffsetTransaction(player, 0.5, 'debounced');
    requestStandardHostManualOffsetTransaction(player, 0);
    expect(lastLease()).toMatchObject({
      scheduled: false,
      requestedOffsetSeconds: 0,
      priorRequestedOffset: 0.3,
      priorAppliedOffset: 0.28,
    });
    vi.advanceTimersByTime(2_000);
    expect(runtime.begin).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'reset'] as const)(
    'clears debounce-only work on %s without starting a lease',
    (action) => {
      requestUserStandardHostManualOffsetTransaction(player, 0.5, 'debounced');
      if (action === 'cancel') expect(cancelStandardHostManualOffsetTransaction()).toBe(true);
      else resetStandardHostManualOffsetTransaction();
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
      expect(getManagedTimer('yt-pro-coordinator-local-nudge')).toBeNull();
      vi.advanceTimersByTime(2_000);
      expect(runtime.begin).not.toHaveBeenCalled();
    },
  );

  it.each(['player', 'session', 'room', 'queue', 'subindex', 'mode'] as const)(
    'drops delayed input after the %s identity changes',
    (part) => {
      requestUserStandardHostManualOffsetTransaction(player, 0.5, 'debounced');
      if (part === 'player') setYouTubePlayer({} as YouTubePlayerInstance);
      if (part === 'session') incrementSessionId();
      if (part === 'room') setState('network.sessionCode', '654321');
      if (part === 'queue') setState('playlist.currentQueueItemId', null);
      if (part === 'subindex') setState('youtube.currentSubIndex', 1);
      if (part === 'mode') setState('playback.mode', 'file');
      setState('sync.youtubeLocalOffset', 0.7);
      vi.advanceTimersByTime(2_000);
      expect(runtime.begin).not.toHaveBeenCalled();
      expect(getState('sync.youtubeLocalOffset')).toBe(0.7);
      expect(isStandardHostManualOffsetTransactionPending()).toBe(false);
    },
  );

  it('a hard transition cancels an already queued post-commit microtask', async () => {
    requestUserStandardHostManualOffsetTransaction(player, 0.1, 'committed');
    const first = lastLease();
    const settled = vi.fn();
    afterStandardHostManualOffsetTransaction(settled);
    requestUserStandardHostManualOffsetTransaction(player, 0.2, 'committed');
    finish(first, 0.1);
    cancelStandardHostManualOffsetTransaction();
    await Promise.resolve();
    expect(runtime.begin).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
  });
});
