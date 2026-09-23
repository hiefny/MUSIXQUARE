/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import {
  claimPlaybackOwner,
  setPlaybackFilePlaying,
  setPlaybackLifecycleState,
} from '../ownership.ts';
import { getPlayerNode, setCurrentAudioBuffer, setPlayerNode } from '../_state.ts';
import type { LargeAudioTrack } from '../file-playback-resource.ts';
import { isLocalFileStartPending, pause, play, stopAllMedia } from '../transport.ts';
import { setEngineMode } from '../video.ts';

const mocks = vi.hoisted(() => ({ currentTime: 20, start: vi.fn(), showToast: vi.fn() }));

vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => mocks.currentTime,
  getAudioContext: () => ({
    state: 'running',
    get currentTime() {
      return mocks.currentTime;
    },
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      disconnect() {},
      start: mocks.start,
      stop() {},
      onended: null,
    }),
  }),
  ensureRunning: vi.fn(),
  getPendingForegroundAudioContextClockHealthCheck: () => null,
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
  getFilePlaybackDestination: () => ({}),
}));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn(), sendToHost: vi.fn() }));
vi.mock('../../ui/toast.ts', () => ({ showLoader: vi.fn(), showToast: mocks.showToast }));

interface PendingPrepare {
  readonly position: number;
  readonly signal?: AbortSignal;
  resolve(): void;
  reject(error: unknown): void;
}

/** This decoder deliberately ignores abort until its async read settles. */
function deferredTrack() {
  const prepares: PendingPrepare[] = [];
  const outputs: Array<Parameters<LargeAudioTrack['createPlayback']>[0]> = [];
  const track: LargeAudioTrack = {
    kind: 'large-audio',
    duration: 600,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 28_800_000,
    bufferedPcmBytes: 8_192,
    prepare: vi.fn(
      (position, signal) =>
        new Promise<void>((resolve, reject) => {
          prepares.push({ position, signal, resolve, reject });
        }),
    ),
    createPlayback: vi.fn((options) => {
      outputs.push(options);
      return { ended: false, stop: vi.fn(), disconnect: vi.fn() };
    }),
    dispose: vi.fn(),
  };
  return { track, prepares, outputs };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  vi.clearAllMocks();
  mocks.currentTime = 20;
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('playlist.currentQueueItemId', 'queue-current');
  setState('files.current', {
    queueItemId: 'queue-current',
    indexHint: 0,
    name: 'large-file',
    sessionId: 1,
    blob: new Blob(['encoded']),
    mime: 'audio/mpeg',
    size: 7,
  });
  setState('playback.mode', 'file');
  setPlaybackLifecycleState(PLAYBACK_STATE.READY);
});

afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  clearAllManagedTimers();
  vi.useRealTimers();
});

const takeoverActions = [
  {
    name: 'pause',
    apply: () => pause(10, { showToast: false }),
  },
  {
    name: 'YouTube engine ownership',
    apply: () => {
      stopAllMedia({ cancelInFlight: true });
      setEngineMode('youtube');
    },
  },
  {
    name: 'system-audio ownership',
    apply: () => {
      stopAllMedia({ cancelInFlight: true });
      claimPlaybackOwner('system-audio');
    },
  },
  {
    name: 'explicit stop',
    apply: () => stopAllMedia({ cancelInFlight: true }),
  },
] as const;

describe('media preparation ordering with non-cooperative decoders', () => {
  it.each(
    takeoverActions.flatMap((action) =>
      ['resolve', 'reject'].map((settlement) => ({ action, settlement })),
    ),
  )(
    'does not start or report stale output when $action.name supersedes a pending read that later $settlement s',
    async ({ action, settlement }) => {
      const { track, prepares, outputs } = deferredTrack();
      setCurrentAudioBuffer(track);
      setPlaybackFilePlaying();
      const oldPlay = play(10);
      await flush();
      expect(prepares).toHaveLength(1);

      action.apply();
      expect(prepares[0]!.signal?.aborted).toBe(true);
      if (settlement === 'resolve') prepares[0]!.resolve();
      else prepares[0]!.reject(new Error('late read failure after supersession'));
      await flush();

      await expect(oldPlay).resolves.toBe(false);
      expect(outputs).toHaveLength(0);
      expect(getPlayerNode()).toBeNull();
      expect(isLocalFileStartPending()).toBe(false);
      expect(mocks.showToast).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      order: 'old resolves before latest',
      settlementOrder: 'old-first',
      old: 'resolve',
      third: false,
    },
    {
      order: 'old rejects before latest',
      settlementOrder: 'old-first',
      old: 'reject',
      third: false,
    },
    {
      order: 'latest resolves before old',
      settlementOrder: 'latest-first',
      old: 'resolve',
      third: false,
    },
    {
      order: 'latest resolves before old rejects',
      settlementOrder: 'latest-first',
      old: 'reject',
      third: false,
    },
    {
      order: 'third request replaces second before stale first resolves',
      settlementOrder: 'old-first',
      old: 'resolve',
      third: true,
    },
    {
      order: 'third request resolves before stale first rejects',
      settlementOrder: 'latest-first',
      old: 'reject',
      third: true,
    },
  ] as const)(
    'publishes only the last requested output when $order',
    async ({ settlementOrder, old, third }) => {
      const { track, prepares, outputs } = deferredTrack();
      setCurrentAudioBuffer(track);
      setPlaybackFilePlaying();
      const oldPlay = play(10);
      await flush();
      stopAllMedia({ cancelInFlight: true });
      const latestPosition = third ? 90 : 50;
      const latestPlay = play(latestPosition);
      await flush();
      let finalPlay = latestPlay;
      if (third) {
        stopAllMedia({ cancelInFlight: true });
        finalPlay = play(120);
        await flush();
      }
      const latestIndex = prepares.length - 1;
      const finalPosition = third ? 120 : latestPosition;
      expect(prepares).toHaveLength(third ? 3 : 2);
      expect(prepares.slice(0, latestIndex).every((entry) => entry.signal?.aborted)).toBe(true);

      const settleOld = () =>
        old === 'reject'
          ? prepares[0]!.reject(new Error('obsolete prepare failed late'))
          : prepares[0]!.resolve();
      const settleLatest = () => prepares[latestIndex]!.resolve();
      if (settlementOrder === 'old-first') settleOld();
      else settleLatest();
      await flush();
      if (settlementOrder === 'old-first') settleLatest();
      else settleOld();
      if (third) prepares[1]!.resolve();
      await flush();

      await expect(oldPlay).resolves.toBe(false);
      if (third) await expect(latestPlay).resolves.toBe(false);
      await expect(finalPlay).resolves.toBe(true);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.offset).toBeCloseTo(finalPosition);
      expect(getPlayerNode()).not.toBeNull();
      expect(isLocalFileStartPending()).toBe(false);
      expect(mocks.showToast).not.toHaveBeenCalled();
    },
  );

  const settlementOrders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ] as const;
  it.each(
    settlementOrders.flatMap((order) => [
      { order, staleFailure: false },
      { order, staleFailure: true },
    ]),
  )(
    'keeps the third load current when decoder completions arrive in order $order (failure pattern $staleFailure)',
    async ({ order, staleFailure }) => {
      const { track, prepares, outputs } = deferredTrack();
      setCurrentAudioBuffer(track);
      setPlaybackFilePlaying();
      const first = play(10);
      await flush();
      stopAllMedia({ cancelInFlight: true });
      const second = play(50);
      await flush();
      stopAllMedia({ cancelInFlight: true });
      const third = play(120);
      await flush();
      expect(prepares.map((entry) => entry.position)).toEqual([10, 50, 120]);
      expect(prepares[0]!.signal?.aborted).toBe(true);
      expect(prepares[1]!.signal?.aborted).toBe(true);

      for (const index of order) {
        if (index === 2 || !staleFailure) prepares[index]!.resolve();
        else prepares[index]!.reject(new Error(`obsolete generation ${index} failed`));
        await flush();
      }

      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
      await expect(third).resolves.toBe(true);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.offset).toBeCloseTo(120);
      expect(getPlayerNode()).not.toBeNull();
      expect(isLocalFileStartPending()).toBe(false);
      expect(mocks.showToast).not.toHaveBeenCalled();
    },
  );

  it('settles a current decoder failure without leaving a pending start', async () => {
    const { track, prepares, outputs } = deferredTrack();
    setCurrentAudioBuffer(track);
    const starting = play(30);
    await flush();
    prepares[0]!.reject(new Error('current decode failure'));
    await flush();

    await expect(starting).resolves.toBe(false);
    expect(outputs).toHaveLength(0);
    expect(getPlayerNode()).toBeNull();
    expect(isLocalFileStartPending()).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledOnce();
  });
});
