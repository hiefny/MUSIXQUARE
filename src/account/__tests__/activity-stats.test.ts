import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountStats } from '../api.ts';
import { __resetAccountStateForTests, type AccountSnapshot } from '../state.ts';
import {
  __accountActivityStatsForTests,
  createAccountActivityStatsTracker,
  disposeAccountActivityStats,
  flushAccountActivityStatsForRead,
  initAccountActivityStats,
} from '../activity-stats.ts';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';

type AccountActivityStatsTracker = ReturnType<typeof createAccountActivityStatsTracker>;
type AccountActivityStatsDependencies = Parameters<typeof createAccountActivityStatsTracker>[0];
type AccountActivityRuntimeSnapshot = ReturnType<AccountActivityStatsDependencies['readRuntime']>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const EMPTY_STATS: AccountStats = {
  sessionCount: 0,
  listeningSeconds: 0,
  trackCount: 0,
};

const FIRST_UPDATED_STATS: AccountStats = {
  sessionCount: 4,
  listeningSeconds: 120,
  trackCount: 8,
};

const SECOND_UPDATED_STATS: AccountStats = {
  sessionCount: 4,
  listeningSeconds: 122,
  trackCount: 8,
};

const STATS_SCOPE_A = 'A'.repeat(43);
const STATS_SCOPE_B = 'B'.repeat(43);

const AUTHENTICATED: AccountSnapshot = {
  status: 'authenticated',
  configured: true,
  account: { nickname: 'Minsu', profileComplete: true },
};

const ANONYMOUS: AccountSnapshot = {
  status: 'anonymous',
  configured: true,
  account: null,
};

const BASE_RUNTIME: AccountActivityRuntimeSnapshot = {
  sessionStarted: false,
  playbackMode: null,
  playbackActivity: 'idle',
  currentQueueItemId: null,
  trackDurationSeconds: null,
  youtubeSubIndex: -1,
  myDeviceId: 'device-own',
  myMemberId: 'member-own',
  myMemberAuthenticated: true,
  myJoinOrder: 1,
  connectedDevices: [],
};

interface Harness {
  tracker: AccountActivityStatsTracker;
  addStats: ReturnType<typeof vi.fn>;
  storage: Map<string, string>;
  patchRuntime(patch: Partial<AccountActivityRuntimeSnapshot>): void;
  setAuthenticated(authenticated: boolean): void;
  setStatsScope(statsScope: string): void;
  settleLeadership(): void;
  advance(seconds: number): void;
  jump(milliseconds: number): void;
  sample(): void;
  setVisible(visible: boolean): void;
  pageHide(): void;
  dispose(): Promise<void>;
}

const activeHarnesses = new Set<Harness>();

function createHarness(
  options: {
    authenticated?: boolean;
    runtime?: Partial<AccountActivityRuntimeSnapshot>;
    reconnecting?: boolean;
    storedSessionCounted?: boolean;
    statsScope?: string | null;
    addStats?: (
      input: {
        sessionCountDelta: number;
        listeningSecondsDelta: number;
        trackCountDelta: number;
      },
      statsScope: string,
    ) => Promise<AccountStats>;
  } = {},
): Harness {
  let now = 0;
  let runtime = { ...BASE_RUNTIME, ...options.runtime };
  let account = options.authenticated === false ? ANONYMOUS : AUTHENTICATED;
  let statsScope =
    'statsScope' in options
      ? (options.statsScope ?? null)
      : options.authenticated === false
        ? null
        : STATS_SCOPE_A;
  let visible = true;

  const accountListeners = new Set<(snapshot: Readonly<AccountSnapshot>) => void>();
  const runtimeListeners = new Set<() => void>();
  const visibilityListeners = new Set<() => void>();
  const pageHideListeners = new Set<() => void>();
  const scheduled = new Map<string, () => void>();
  let sampleCallback: (() => void) | null = null;

  const storage = new Map<string, string>();
  if (options.storedSessionCounted) {
    storage.set(__accountActivityStatsForTests.SESSION_COUNTED_STORAGE_KEY, '1');
  }
  if (options.reconnecting) {
    storage.set(__accountActivityStatsForTests.RECONNECT_TARGET_STORAGE_KEY, 'pending');
  }

  const addStats = vi.fn(
    options.addStats ??
      (async (): Promise<AccountStats> => {
        return EMPTY_STATS;
      }),
  );

  const tracker = createAccountActivityStatsTracker({
    now: () => now,
    readRuntime: () => runtime,
    readAccount: () => account,
    readStatsScope: () => statsScope,
    subscribeAccount: (listener) => {
      accountListeners.add(listener);
      return () => accountListeners.delete(listener);
    },
    subscribeRuntime: (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    subscribeVisibility: (listener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    subscribePageHide: (listener) => {
      pageHideListeners.add(listener);
      return () => pageHideListeners.delete(listener);
    },
    isVisible: () => visible,
    addStats,
    scheduler: {
      startSampling(callback) {
        sampleCallback = callback;
        return () => {
          if (sampleCallback === callback) sampleCallback = null;
        };
      },
      schedule(name, callback) {
        scheduled.set(name, callback);
        return () => {
          if (scheduled.get(name) === callback) scheduled.delete(name);
        };
      },
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => {
        storage.delete(key);
      },
    },
    hasReconnectMarker: () => options.reconnecting === true,
  });

  const harness: Harness = {
    tracker,
    addStats,
    storage,
    patchRuntime(patch) {
      runtime = { ...runtime, ...patch };
      for (const listener of [...runtimeListeners]) listener();
    },
    setAuthenticated(authenticated) {
      account = authenticated ? AUTHENTICATED : ANONYMOUS;
      statsScope = authenticated ? (statsScope ?? STATS_SCOPE_A) : null;
      for (const listener of [...accountListeners]) listener(account);
    },
    setStatsScope(nextStatsScope) {
      statsScope = nextStatsScope;
      for (const listener of [...accountListeners]) listener(account);
    },
    settleLeadership() {
      now += __accountActivityStatsForTests.LEADERSHIP_SETTLE_MS;
      const callback = scheduled.get('leadership');
      scheduled.delete('leadership');
      callback?.();
    },
    advance(seconds) {
      for (let index = 0; index < seconds; index += 1) {
        now += __accountActivityStatsForTests.SAMPLE_INTERVAL_MS;
        (sampleCallback ?? (() => tracker.sample()))();
      }
    },
    jump(milliseconds) {
      now += milliseconds;
    },
    sample() {
      tracker.sample();
    },
    setVisible(nextVisible) {
      visible = nextVisible;
      for (const listener of [...visibilityListeners]) listener();
    },
    pageHide() {
      for (const listener of [...pageHideListeners]) listener();
    },
    async dispose() {
      await tracker.dispose(false);
      activeHarnesses.delete(harness);
    },
  };
  activeHarnesses.add(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all([...activeHarnesses].map((harness) => harness.dispose()));
  await disposeAccountActivityStats(false);
  vi.restoreAllMocks();
});

describe('account activity session counting', () => {
  it('counts each false-to-true participation once and resets after leave', async () => {
    const harness = createHarness();

    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();

    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 1,
        listeningSecondsDelta: 0,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );

    harness.patchRuntime({ sessionStarted: true });
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenCalledTimes(1);

    harness.patchRuntime({ sessionStarted: false });
    expect(harness.storage.has(__accountActivityStatsForTests.SESSION_COUNTED_STORAGE_KEY)).toBe(
      false,
    );
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenCalledTimes(2);
  });

  it('counts an active participation when account login arrives late', async () => {
    const harness = createHarness({
      authenticated: false,
      runtime: { sessionStarted: true },
    });

    harness.settleLeadership();
    await harness.tracker.flush();
    expect(harness.addStats).not.toHaveBeenCalled();

    harness.setAuthenticated(true);
    harness.settleLeadership();
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 1,
        listeningSecondsDelta: 0,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );
  });

  it('reuses only a boolean reconnect marker without persisting room or media identity', async () => {
    const harness = createHarness({
      reconnecting: true,
      storedSessionCounted: true,
    });

    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();

    expect(harness.addStats).not.toHaveBeenCalled();
    expect([...harness.storage.keys()]).toEqual(
      expect.arrayContaining([
        __accountActivityStatsForTests.SESSION_COUNTED_STORAGE_KEY,
        __accountActivityStatsForTests.RECONNECT_TARGET_STORAGE_KEY,
      ]),
    );
    expect(harness.storage.get(__accountActivityStatsForTests.SESSION_COUNTED_STORAGE_KEY)).toBe(
      '1',
    );
  });

  it('suppresses all counters on a later same-member physical device', async () => {
    const harness = createHarness({
      runtime: {
        myDeviceId: 'device-later',
        // Guest state starts at 0, but its authoritative directory row says
        // it joined after the other device.
        myJoinOrder: 0,
        connectedDevices: [
          {
            id: 'device-later',
            memberId: 'member-own',
            joinOrder: 2,
            status: 'connected',
            isAuthenticated: true,
          },
          {
            id: 'device-first',
            memberId: 'member-own',
            joinOrder: 1,
            status: 'connected',
            isAuthenticated: true,
          },
        ],
      },
    });

    harness.patchRuntime({
      sessionStarted: true,
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.settleLeadership();
    harness.advance(12);
    await harness.tracker.flush();

    expect(harness.addStats).not.toHaveBeenCalled();
  });

  it('waits for a physical device id before freezing leadership', async () => {
    const harness = createHarness({
      runtime: { myDeviceId: null },
    });
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    expect(harness.addStats).not.toHaveBeenCalled();

    harness.patchRuntime({ myDeviceId: 'device-own' });
    harness.settleLeadership();
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 1,
        listeningSecondsDelta: 0,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );
  });

  it('starts fresh when another account signs in during the active room', async () => {
    const harness = createHarness();
    harness.patchRuntime({
      sessionStarted: true,
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.settleLeadership();
    harness.advance(10);
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 1,
        listeningSecondsDelta: 10,
        trackCountDelta: 1,
      },
      STATS_SCOPE_A,
    );

    harness.addStats.mockClear();
    harness.setAuthenticated(false);
    expect(harness.storage.has(__accountActivityStatsForTests.SESSION_COUNTED_STORAGE_KEY)).toBe(
      false,
    );
    harness.setAuthenticated(true);
    harness.settleLeadership();
    harness.advance(10);
    await harness.tracker.flush();

    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 1,
        listeningSecondsDelta: 10,
        trackCountDelta: 1,
      },
      STATS_SCOPE_A,
    );
  });

  it('drops unsent activity when the authenticated account scope changes directly', async () => {
    const harness = createHarness();
    harness.patchRuntime({
      sessionStarted: true,
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.settleLeadership();
    harness.advance(10);

    harness.setStatsScope(STATS_SCOPE_B);
    expect(harness.storage.has(__accountActivityStatsForTests.SESSION_COUNTED_STORAGE_KEY)).toBe(
      false,
    );
    harness.settleLeadership();
    harness.advance(10);
    await harness.tracker.flush();

    expect(harness.addStats).toHaveBeenCalledOnce();
    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 1,
        listeningSecondsDelta: 10,
        trackCountDelta: 1,
      },
      STATS_SCOPE_B,
    );
  });
});

describe('account activity playback counters', () => {
  it('uses half the duration for short files and YouTube videos', async () => {
    const harness = createHarness();
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    harness.addStats.mockClear();

    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-short-file',
      trackDurationSeconds: 6,
    });
    harness.advance(2);
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 2,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );

    harness.addStats.mockClear();
    harness.advance(1);
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 1,
        trackCountDelta: 1,
      },
      STATS_SCOPE_A,
    );

    harness.addStats.mockClear();
    harness.patchRuntime({
      playbackMode: 'youtube',
      currentQueueItemId: 'queue-short-youtube',
      trackDurationSeconds: 15,
      youtubeSubIndex: 0,
    });
    harness.advance(7);
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 7,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );

    harness.addStats.mockClear();
    harness.jump(499);
    harness.sample();
    await harness.tracker.flush();
    expect(harness.addStats).not.toHaveBeenCalled();

    harness.jump(1);
    harness.sample();
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 0,
        trackCountDelta: 1,
      },
      STATS_SCOPE_A,
    );
  });

  it('keeps the ten-second threshold for long or unknown-duration tracks', async () => {
    expect(__accountActivityStatsForTests.trackCountThresholdMs(6)).toBe(3_000);
    expect(__accountActivityStatsForTests.trackCountThresholdMs(15)).toBe(7_500);
    expect(__accountActivityStatsForTests.trackCountThresholdMs(20)).toBe(10_000);
    expect(__accountActivityStatsForTests.trackCountThresholdMs(180)).toBe(10_000);
    expect(__accountActivityStatsForTests.trackCountThresholdMs(null)).toBe(10_000);
    expect(__accountActivityStatsForTests.trackCountThresholdMs(0)).toBe(10_000);
    expect(__accountActivityStatsForTests.trackCountThresholdMs(-1)).toBe(10_000);
    expect(__accountActivityStatsForTests.trackCountThresholdMs(Number.NaN)).toBe(10_000);
    expect(__accountActivityStatsForTests.trackCountThresholdMs(Number.POSITIVE_INFINITY)).toBe(
      10_000,
    );
  });

  it('re-evaluates existing progress when a duration becomes known or is corrected', async () => {
    const harness = createHarness();
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    harness.addStats.mockClear();

    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-late-duration',
      trackDurationSeconds: null,
    });
    harness.advance(4);
    harness.patchRuntime({ trackDurationSeconds: 6 });
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 4,
        trackCountDelta: 1,
      },
      STATS_SCOPE_A,
    );

    harness.addStats.mockClear();
    harness.patchRuntime({
      currentQueueItemId: 'queue-corrected-longer',
      trackDurationSeconds: 8,
    });
    harness.advance(3);
    harness.patchRuntime({ trackDurationSeconds: 30 });
    harness.advance(6);
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 9,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );

    harness.addStats.mockClear();
    harness.advance(1);
    await harness.tracker.flush();
    expect(harness.addStats).toHaveBeenLastCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 1,
        trackCountDelta: 1,
      },
      STATS_SCOPE_A,
    );
  });

  it('counts only observed playing time and rejects a stale monotonic gap', async () => {
    const harness = createHarness();
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    harness.addStats.mockClear();

    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-file',
    });
    harness.advance(3);
    harness.patchRuntime({ playbackActivity: 'paused' });
    harness.advance(2);
    harness.patchRuntime({
      playbackMode: 'system-audio',
      playbackActivity: 'playing',
      currentQueueItemId: null,
    });
    harness.advance(2);
    harness.jump(__accountActivityStatsForTests.MAX_OBSERVED_SAMPLE_GAP_MS + 1);
    harness.sample();
    await harness.tracker.flush();

    expect(harness.addStats).toHaveBeenCalledOnce();
    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 5,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );
  });

  it('retains progress across pause but resets an unfinished track on queue change', async () => {
    const harness = createHarness();
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    harness.addStats.mockClear();

    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.advance(6);
    harness.patchRuntime({ playbackActivity: 'paused' });
    harness.advance(3);
    harness.patchRuntime({ playbackActivity: 'playing' });
    harness.advance(4);

    harness.patchRuntime({ currentQueueItemId: 'queue-2' });
    harness.advance(5);
    harness.patchRuntime({ currentQueueItemId: 'queue-3' });
    harness.advance(5);
    harness.patchRuntime({ currentQueueItemId: 'queue-1' });
    harness.advance(10);
    await harness.tracker.flush();

    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 30,
        trackCountDelta: 1,
      },
      STATS_SCOPE_A,
    );
  });

  it('uses YouTube sub-index identity and treats system audio as time-only', async () => {
    const harness = createHarness();
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    harness.addStats.mockClear();

    harness.patchRuntime({
      playbackMode: 'youtube',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-youtube',
      youtubeSubIndex: -1,
    });
    harness.advance(10);
    harness.patchRuntime({ youtubeSubIndex: 1 });
    harness.advance(10);
    harness.patchRuntime({
      playbackMode: 'system-audio',
      currentQueueItemId: null,
    });
    harness.advance(12);
    await harness.tracker.flush();

    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 32,
        trackCountDelta: 2,
      },
      STATS_SCOPE_A,
    );
  });

  it('does not count time while hidden and flushes the last visible fraction on pagehide', async () => {
    const harness = createHarness();
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    harness.addStats.mockClear();
    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });

    harness.advance(1);
    harness.setVisible(false);
    harness.advance(10);
    harness.setVisible(true);
    harness.jump(500);
    harness.pageHide();
    await vi.waitFor(() => expect(harness.addStats).toHaveBeenCalledOnce());

    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 1,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );
  });
});

describe('account activity delta delivery', () => {
  it('uses a venue-safe 30 second automatic batch window', () => {
    expect(__accountActivityStatsForTests.AUTO_FLUSH_DELAY_MS).toBe(30_000);
  });

  it('returns the aggregate from one foreground batch when activity is pending', async () => {
    const harness = createHarness({
      addStats: async () => FIRST_UPDATED_STATS,
    });
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();

    await expect(harness.tracker.flushForRead()).resolves.toEqual({
      status: 'updated',
      stats: FIRST_UPDATED_STATS,
    });
    expect(harness.addStats).toHaveBeenCalledOnce();
    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 1,
        listeningSecondsDelta: 0,
        trackCountDelta: 0,
      },
      STATS_SCOPE_A,
    );
  });

  it('returns idle without a request when no activity is pending', async () => {
    const harness = createHarness();

    await expect(harness.tracker.flushForRead()).resolves.toEqual({ status: 'idle' });
    expect(harness.addStats).not.toHaveBeenCalled();
  });

  it('captures the last eligible interval before a foreground read', async () => {
    const harness = createHarness({
      addStats: async () => FIRST_UPDATED_STATS,
    });
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    await harness.tracker.flush();
    harness.addStats.mockClear();

    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.advance(9);
    harness.jump(1_000);

    await expect(harness.tracker.flushForRead()).resolves.toEqual({
      status: 'updated',
      stats: FIRST_UPDATED_STATS,
    });
    expect(harness.addStats).toHaveBeenCalledWith(
      {
        sessionCountDelta: 0,
        listeningSecondsDelta: 10,
        trackCountDelta: 1,
      },
      STATS_SCOPE_A,
    );
  });

  it('returns uncertain after one failed foreground batch without retrying it', async () => {
    const harness = createHarness({
      addStats: async () => {
        throw new Error('response lost');
      },
    });
    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();

    await expect(harness.tracker.flushForRead()).resolves.toEqual({ status: 'uncertain' });
    expect(harness.addStats).toHaveBeenCalledOnce();
  });

  it('shares a foreground flush and sends only one call-boundary follow-up batch', async () => {
    const first = deferred<AccountStats>();
    const second = deferred<AccountStats>();
    const addStats = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue(EMPTY_STATS);
    const harness = createHarness({ addStats });

    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    const backgroundFlush = harness.tracker.flush();

    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.advance(2);
    const foregroundFlush = harness.tracker.flushForRead();
    const concurrentForegroundFlush = harness.tracker.flushForRead();
    expect(concurrentForegroundFlush).toBe(foregroundFlush);

    first.resolve(FIRST_UPDATED_STATS);
    await vi.waitFor(() => expect(addStats).toHaveBeenCalledTimes(2));
    await backgroundFlush;

    // This activity began after the foreground call's boundary. It remains
    // pending instead of extending the foreground wait with a third request.
    harness.advance(2);
    second.resolve(SECOND_UPDATED_STATS);

    await expect(foregroundFlush).resolves.toEqual({
      status: 'updated',
      stats: SECOND_UPDATED_STATS,
    });
    await expect(concurrentForegroundFlush).resolves.toEqual({
      status: 'updated',
      stats: SECOND_UPDATED_STATS,
    });
    expect(addStats).toHaveBeenCalledTimes(2);
    expect(addStats.mock.calls[1]?.[0]).toEqual({
      sessionCountDelta: 0,
      listeningSecondsDelta: 2,
      trackCountDelta: 0,
    });

    await harness.tracker.flush();
    expect(addStats).toHaveBeenCalledTimes(3);
    expect(addStats.mock.calls[2]?.[0]).toEqual({
      sessionCountDelta: 0,
      listeningSecondsDelta: 2,
      trackCountDelta: 0,
    });
  });

  it('does not chase activity created after a foreground call with no pending delta', async () => {
    const first = deferred<AccountStats>();
    const addStats = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(EMPTY_STATS);
    const harness = createHarness({ addStats });

    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    const backgroundFlush = harness.tracker.flush();
    const foregroundFlush = harness.tracker.flushForRead();

    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.advance(2);
    first.resolve(FIRST_UPDATED_STATS);

    await backgroundFlush;
    await expect(foregroundFlush).resolves.toEqual({
      status: 'updated',
      stats: FIRST_UPDATED_STATS,
    });
    expect(addStats).toHaveBeenCalledOnce();

    await harness.tracker.flush();
    expect(addStats).toHaveBeenCalledTimes(2);
    expect(addStats.mock.calls[1]?.[0]).toEqual({
      sessionCountDelta: 0,
      listeningSecondsDelta: 2,
      trackCountDelta: 0,
    });
  });

  it('keeps a relevant uncertain first batch uncertain after a successful follow-up', async () => {
    const first = deferred<AccountStats>();
    const second = deferred<AccountStats>();
    const addStats = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const harness = createHarness({ addStats });

    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    const backgroundFlush = harness.tracker.flush();
    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.advance(2);
    const foregroundFlush = harness.tracker.flushForRead();

    first.reject(new Error('response lost'));
    await vi.waitFor(() => expect(addStats).toHaveBeenCalledTimes(2));
    second.resolve(SECOND_UPDATED_STATS);

    await backgroundFlush;
    await expect(foregroundFlush).resolves.toEqual({ status: 'uncertain' });
    expect(addStats).toHaveBeenCalledTimes(2);
  });

  it('binds each in-flight request to the account scope captured at send time', async () => {
    const first = deferred<AccountStats>();
    const addStats = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(EMPTY_STATS);
    const harness = createHarness({ addStats });

    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    const firstFlush = harness.tracker.flush();
    expect(addStats.mock.calls[0]?.[1]).toBe(STATS_SCOPE_A);

    harness.setStatsScope(STATS_SCOPE_B);
    harness.settleLeadership();
    first.resolve(FIRST_UPDATED_STATS);
    await firstFlush;
    await harness.tracker.flush();

    expect(addStats).toHaveBeenCalledTimes(2);
    expect(addStats.mock.calls[1]?.[0]).toEqual({
      sessionCountDelta: 1,
      listeningSecondsDelta: 0,
      trackCountDelta: 0,
    });
    expect(addStats.mock.calls[1]?.[1]).toBe(STATS_SCOPE_B);
  });

  it('keeps one request in flight and never retries or merges an uncertain batch', async () => {
    const first = deferred<AccountStats>();
    const addStats = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(EMPTY_STATS);
    const harness = createHarness({ addStats });

    harness.patchRuntime({ sessionStarted: true });
    harness.settleLeadership();
    const firstFlush = harness.tracker.flush();
    expect(addStats).toHaveBeenCalledOnce();

    harness.patchRuntime({
      playbackMode: 'file',
      playbackActivity: 'playing',
      currentQueueItemId: 'queue-1',
    });
    harness.advance(2);
    const overlappingFlush = harness.tracker.flush();
    expect(addStats).toHaveBeenCalledTimes(1);

    first.reject(new Error('response lost'));
    await Promise.all([firstFlush, overlappingFlush]);
    await harness.tracker.flush();

    expect(addStats).toHaveBeenCalledTimes(2);
    expect(addStats.mock.calls[0]?.[0]).toEqual({
      sessionCountDelta: 1,
      listeningSecondsDelta: 0,
      trackCountDelta: 0,
    });
    expect(addStats.mock.calls[1]?.[0]).toEqual({
      sessionCountDelta: 0,
      listeningSecondsDelta: 2,
      trackCountDelta: 0,
    });
  });

  it('splits accumulated time at the server request cap', async () => {
    const harness = createHarness();
    harness.patchRuntime({
      sessionStarted: true,
      playbackMode: 'system-audio',
      playbackActivity: 'playing',
    });
    harness.settleLeadership();
    await harness.tracker.flush();
    harness.addStats.mockClear();

    harness.advance(3_601);
    await harness.tracker.flush();
    await harness.tracker.flush();

    expect(harness.addStats).toHaveBeenCalledTimes(2);
    expect(harness.addStats.mock.calls[0]?.[0]).toMatchObject({
      listeningSecondsDelta: 3_600,
    });
    expect(harness.addStats.mock.calls[1]?.[0]).toMatchObject({
      listeningSecondsDelta: 1,
    });
  });
});

describe('account activity lifecycle', () => {
  it('returns idle when a foreground read happens before tracker initialization', async () => {
    await disposeAccountActivityStats(false);

    await expect(flushAccountActivityStatsForRead()).resolves.toEqual({ status: 'idle' });
  });

  it('removes join-boundary listeners before dispose and reinitialization', async () => {
    bus.clear();
    resetState();
    __resetAccountStateForTests();

    initAccountActivityStats();
    expect(bus.debug()['setup:guest-join-failure']).toBe(1);
    expect(bus.debug()['setup:guest-join-cancelled']).toBe(1);

    await disposeAccountActivityStats(false);
    expect(bus.debug()['setup:guest-join-failure']).toBeUndefined();
    expect(bus.debug()['setup:guest-join-cancelled']).toBeUndefined();

    initAccountActivityStats();
    expect(bus.debug()['setup:guest-join-failure']).toBe(1);
    expect(bus.debug()['setup:guest-join-cancelled']).toBe(1);
  });
});
