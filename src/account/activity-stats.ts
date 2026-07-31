/**
 * Privacy-bounded account activity counters.
 *
 * This module deliberately records only three aggregate deltas. Room codes,
 * queue metadata, media ids, titles, and timestamps never leave this module
 * and are never persisted. A queue item id is used only as an in-memory
 * occurrence boundary while the current page is alive.
 *
 * Delivery is intentionally at-most-once from the browser's point of view:
 * pending counters are removed before a request starts and an uncertain
 * failure is discarded. Retrying such a request could count a request that
 * reached D1 but whose response was lost.
 */

import { addAccountStats, type AccountStats, type AccountStatsDelta } from './api.ts';
import {
  getAccountSnapshot,
  getAccountStatsScope,
  subscribeAccount,
  type AccountSnapshot,
} from './state.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';

type PlaybackMode = 'file' | 'youtube' | 'system-audio' | null;
type PlaybackActivity = 'idle' | 'paused' | 'playing' | 'pending';
type TimerName = 'leadership' | 'flush';

interface AccountActivityDevice {
  id: string;
  memberId?: string;
  joinOrder?: number;
  status?: string;
  isAuthenticated?: boolean;
}

interface AccountActivityRuntimeSnapshot {
  sessionStarted: boolean;
  playbackMode: PlaybackMode;
  playbackActivity: PlaybackActivity;
  currentQueueItemId: string | null;
  trackDurationSeconds: number | null;
  youtubeSubIndex: number;
  myDeviceId: string | null;
  myMemberId: string | null;
  myMemberAuthenticated: boolean;
  myJoinOrder: number;
  connectedDevices: readonly AccountActivityDevice[];
}

interface AccountActivityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface AccountActivityScheduler {
  startSampling(callback: () => void, intervalMs: number): () => void;
  schedule(name: TimerName, callback: () => void, delayMs: number): () => void;
}

interface AccountActivityStatsDependencies {
  now: () => number;
  readRuntime: () => AccountActivityRuntimeSnapshot;
  readAccount: () => Readonly<AccountSnapshot>;
  readStatsScope: () => string | null;
  subscribeAccount: (listener: (snapshot: Readonly<AccountSnapshot>) => void) => () => void;
  subscribeRuntime: (listener: () => void) => () => void;
  subscribeVisibility: (listener: () => void) => () => void;
  subscribePageHide: (listener: () => void) => () => void;
  isVisible: () => boolean;
  addStats: (input: AccountStatsDelta, statsScope: string) => Promise<AccountStats>;
  scheduler: AccountActivityScheduler;
  storage: AccountActivityStorage | null;
  hasReconnectMarker: () => boolean;
}

type AccountActivityStatsFlushResult =
  | { status: 'updated'; stats: AccountStats }
  | { status: 'idle' }
  | { status: 'uncertain' };

interface AccountActivityStatsTracker {
  /** Reconcile state immediately; useful for injected runtimes and tests. */
  sync(): void;
  /** Take one monotonic playback-time sample. */
  sample(): void;
  /** Send the current aggregate batch, if any. Errors are contained. */
  flush(): Promise<void>;
  /**
   * Flush only the delta visible at the call boundary and return an
   * authoritative PATCH response when possible. At most one follow-up batch
   * is sent when this call joins an older in-flight request.
   */
  flushForRead(): Promise<AccountActivityStatsFlushResult>;
  /** Stop observing. `flushPending` defaults to true. */
  dispose(flushPending?: boolean): Promise<void>;
  /** Clear a reconnect-only count marker after an abandoned join. */
  abortPendingJoin(): void;
}

type InternalBatchResult =
  | { status: 'updated'; stats: AccountStats; statsScope: string }
  | { status: 'uncertain'; statsScope: string };

interface ForegroundFlush {
  statsScope: string;
  promise: Promise<AccountActivityStatsFlushResult>;
}

const SAMPLE_INTERVAL_MS = 1_000;
const MAX_OBSERVED_SAMPLE_GAP_MS = 2_500;
const TRACK_COUNT_MAX_THRESHOLD_MS = 10_000;
const TRACK_COUNT_DURATION_FRACTION = 0.5;
const LEADERSHIP_SETTLE_MS = 1_000;
const AUTO_FLUSH_DELAY_MS = 30_000;

const SESSION_COUNTED_STORAGE_KEY = 'mxqr-account-activity-session-counted-v1';
const RECONNECT_TARGET_STORAGE_KEY = 'mxqr_reconnect_target';

const MAX_BATCH: AccountStatsDelta = {
  sessionCountDelta: 100,
  listeningSecondsDelta: 3_600,
  trackCountDelta: 1_000,
};

const EMPTY_DELTA = (): AccountStatsDelta => ({
  sessionCountDelta: 0,
  listeningSecondsDelta: 0,
  trackCountDelta: 0,
});

function hasDelta(delta: Readonly<AccountStatsDelta>): boolean {
  return (
    delta.sessionCountDelta > 0 || delta.listeningSecondsDelta > 0 || delta.trackCountDelta > 0
  );
}

function isAuthenticated(snapshot: Readonly<AccountSnapshot>): boolean {
  return snapshot.status === 'authenticated' && snapshot.account !== null;
}

function trackCountThresholdMs(durationSeconds: number | null): number {
  if (!Number.isFinite(durationSeconds) || (durationSeconds ?? 0) <= 0) {
    return TRACK_COUNT_MAX_THRESHOLD_MS;
  }
  return Math.min(
    TRACK_COUNT_MAX_THRESHOLD_MS,
    (durationSeconds as number) * 1_000 * TRACK_COUNT_DURATION_FRACTION,
  );
}

function isConnectedStatus(status: string | undefined): boolean {
  if (!status) return true;
  return !/(?:offline|disconnected|closed|left|failed|kicked)/i.test(status);
}

function normalizedJoinOrder(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : Number.MAX_SAFE_INTEGER;
}

/**
 * Pick one physical device for an authenticated member. The choice is frozen
 * for the participation, so a temporary directory update cannot make two
 * devices count the same interval. Earlier join order wins; device id is the
 * deterministic tie breaker used by PRO projections that group member rows.
 */
function electCurrentDeviceLeader(
  runtime: Readonly<AccountActivityRuntimeSnapshot>,
): boolean | null {
  const { myDeviceId, myMemberId } = runtime;
  // A device id is the minimum safe physical-device fence. Keep waiting
  // instead of freezing a leader decision while room identity projects.
  if (!myDeviceId) return null;
  if (!runtime.myMemberAuthenticated || !myMemberId) return true;

  const candidates = new Map<string, number>();
  candidates.set(myDeviceId, normalizedJoinOrder(runtime.myJoinOrder));

  for (const device of runtime.connectedDevices) {
    if (
      !device.id ||
      device.memberId !== myMemberId ||
      device.isAuthenticated === false ||
      !isConnectedStatus(device.status)
    ) {
      continue;
    }
    const order = normalizedJoinOrder(device.joinOrder);
    const previous = candidates.get(device.id);
    if (
      device.id === myDeviceId &&
      Number.isSafeInteger(device.joinOrder) &&
      (device.joinOrder as number) >= 0
    ) {
      // myJoinOrder starts at 0 before a guest's authoritative device row
      // arrives. Once that row exists, its projected order must replace the
      // optimistic local default even when the real number is higher.
      candidates.set(device.id, order);
    } else if (previous === undefined || order < previous) {
      candidates.set(device.id, order);
    }
  }

  const ordered = [...candidates.entries()].sort(
    ([leftId, leftOrder], [rightId, rightOrder]) =>
      leftOrder - rightOrder || leftId.localeCompare(rightId),
  );
  return ordered[0]?.[0] === myDeviceId;
}

function currentTrackKey(runtime: Readonly<AccountActivityRuntimeSnapshot>): string | null {
  const queueItemId = runtime.currentQueueItemId;
  if (!queueItemId) return null;
  if (runtime.playbackMode === 'file') return `file:${queueItemId}`;
  if (runtime.playbackMode !== 'youtube') return null;

  // The first/single YouTube item is represented as either -1 or 0 during
  // player setup. Treat those as one occurrence so initialization cannot
  // reset a nearly-qualified track.
  const subIndex = normalizedYouTubeSubIndex(runtime.youtubeSubIndex);
  return `youtube:${queueItemId}:${subIndex}`;
}

function normalizedYouTubeSubIndex(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function safeStorageRead(storage: AccountActivityStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeStorageWrite(
  storage: AccountActivityStorage | null,
  key: string,
  value: string,
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* Account statistics remain optional when storage is unavailable. */
  }
}

function safeStorageRemove(storage: AccountActivityStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* Account statistics remain optional when storage is unavailable. */
  }
}

class ActivityStatsTracker implements AccountActivityStatsTracker {
  readonly #deps: AccountActivityStatsDependencies;

  #runtime: AccountActivityRuntimeSnapshot;
  #authenticated: boolean;
  #statsScope: string | null;
  #visible: boolean;
  #sessionActive: boolean;
  #sessionCounted = false;
  #resumeSessionCounted = false;
  #participationLeader: boolean | null = null;

  #lastSampleAt: number;
  #eligible = false;
  #trackKey: string | null = null;
  #trackDurationSeconds: number | null = null;
  #trackProgressMs = 0;
  #countedTrackKeys = new Set<string>();
  #listeningRemainderMs = 0;

  #pending = EMPTY_DELTA();
  #inFlight: Promise<InternalBatchResult> | null = null;
  #foregroundFlush: ForegroundFlush | null = null;
  #disposed = false;

  #stopSampling: (() => void) | null = null;
  #stopLeadershipTimer: (() => void) | null = null;
  #stopFlushTimer: (() => void) | null = null;
  #unsubscribers: Array<() => void> = [];

  constructor(deps: AccountActivityStatsDependencies) {
    this.#deps = deps;
    this.#runtime = deps.readRuntime();
    this.#authenticated = isAuthenticated(deps.readAccount());
    this.#statsScope = deps.readStatsScope();
    this.#visible = deps.isVisible();
    this.#sessionActive = this.#runtime.sessionStarted;
    this.#lastSampleAt = deps.now();

    const canResume =
      this.#sessionActive ||
      deps.hasReconnectMarker() ||
      safeStorageRead(deps.storage, RECONNECT_TARGET_STORAGE_KEY) !== null;
    this.#resumeSessionCounted =
      canResume && safeStorageRead(deps.storage, SESSION_COUNTED_STORAGE_KEY) === '1';
    if (!canResume) {
      safeStorageRemove(deps.storage, SESSION_COUNTED_STORAGE_KEY);
    }

    if (this.#sessionActive) this.#beginParticipation();
    else {
      this.#trackKey = currentTrackKey(this.#runtime);
      this.#trackDurationSeconds = this.#runtime.trackDurationSeconds;
    }
    this.#refreshEligibility();

    this.#unsubscribers = [
      deps.subscribeAccount(() => this.sync()),
      deps.subscribeRuntime(() => this.sync()),
      deps.subscribeVisibility(() => this.sync()),
      deps.subscribePageHide(() => this.#handlePageHide()),
    ];
    this.#restartSampling();
    if (this.#sessionActive && this.#authenticated && this.#statsScope !== null) {
      this.#rescheduleLeadershipDecision();
    }
  }

  sync(): void {
    if (this.#disposed) return;

    const now = this.#deps.now();
    this.#advance(now);

    const previousStatsScope = this.#statsScope;
    const wasSessionActive = this.#sessionActive;
    const nextRuntime = this.#deps.readRuntime();

    this.#runtime = nextRuntime;
    this.#authenticated = isAuthenticated(this.#deps.readAccount());
    this.#statsScope = this.#deps.readStatsScope();
    this.#visible = this.#deps.isVisible();
    this.#sessionActive = nextRuntime.sessionStarted;

    const accountBoundaryChanged =
      previousStatsScope !== null && previousStatsScope !== this.#statsScope;
    if (accountBoundaryChanged) {
      // The opaque scope, not a nickname or object reference, is the account
      // ownership fence. Never carry unsent activity across A -> B or A ->
      // anonymous, even when both visible snapshots say "authenticated".
      this.#resetAccountBoundary();
    }

    if (!wasSessionActive && this.#sessionActive) {
      this.#beginParticipation();
    } else if (wasSessionActive && !this.#sessionActive) {
      this.#endParticipation();
    } else if (this.#sessionActive) {
      this.#reconcileTrackKey();
    } else {
      this.#trackKey = currentTrackKey(this.#runtime);
      this.#trackProgressMs = 0;
      this.#trackDurationSeconds = this.#runtime.trackDurationSeconds;
    }

    if (
      this.#sessionActive &&
      this.#authenticated &&
      this.#statsScope !== null &&
      this.#participationLeader === null
    ) {
      this.#rescheduleLeadershipDecision();
    } else if (this.#sessionActive && this.#participationLeader === true && this.#authenticated) {
      this.#countSessionOnce();
    }

    this.#refreshEligibility();
    this.#lastSampleAt = now;

    // leaveSession() clears every managed timer before publishing its reset
    // batch. Re-arm both tracker timers from any relevant state edge.
    this.#restartSampling();
    if (hasDelta(this.#pending)) {
      if (wasSessionActive && !this.#sessionActive) this.#rescheduleFlush();
      else this.#scheduleFlush();
    }
  }

  sample(): void {
    if (this.#disposed) return;
    this.#refreshTrackDuration();
    this.#advance(this.#deps.now());
  }

  async flush(): Promise<void> {
    await this.#sendOneBatch();
  }

  flushForRead(): Promise<AccountActivityStatsFlushResult> {
    // Capture the final visible interval immediately before the account UI
    // reads its aggregates. The regular sampler may still be up to one tick
    // behind when the user opens the panel.
    if (!this.#disposed) {
      this.#refreshTrackDuration();
      this.#advance(this.#deps.now());
    }

    const statsScope = this.#statsScope;
    if (!this.#authenticated || !statsScope) {
      return Promise.resolve({ status: 'idle' });
    }
    if (this.#foregroundFlush?.statsScope === statsScope) {
      return this.#foregroundFlush.promise;
    }

    const foreground: ForegroundFlush = {
      statsScope,
      promise: Promise.resolve({ status: 'idle' }),
    };
    foreground.promise = this.#runForegroundFlush(statsScope).finally(() => {
      if (this.#foregroundFlush === foreground) this.#foregroundFlush = null;
    });
    this.#foregroundFlush = foreground;
    return foreground.promise;
  }

  async #runForegroundFlush(statsScope: string): Promise<AccountActivityStatsFlushResult> {
    try {
      const existing = this.#inFlight;
      const hadPendingAtCall = hasDelta(this.#pending);

      if (!existing) {
        if (!hadPendingAtCall) return { status: 'idle' };
        const result = await this.#sendOneBatch();
        if (!result || result.statsScope !== statsScope || this.#statsScope !== statsScope) {
          return { status: 'uncertain' };
        }
        return result.status === 'updated'
          ? { status: 'updated', stats: result.stats }
          : { status: 'uncertain' };
      }

      const first = await existing;
      if (this.#statsScope !== statsScope || !this.#authenticated) {
        return { status: 'uncertain' };
      }
      const relevantFirst = first.statsScope === statsScope;

      // The foreground contract is bounded at its call boundary. If no delta
      // was waiting then, do not chase activity produced while the older
      // request was settling.
      if (!hadPendingAtCall) {
        if (!relevantFirst) return { status: 'idle' };
        return first.status === 'updated'
          ? { status: 'updated', stats: first.stats }
          : { status: 'uncertain' };
      }

      const followUp = await this.#sendOneBatch();
      if (
        !followUp ||
        followUp.statsScope !== statsScope ||
        this.#statsScope !== statsScope ||
        (relevantFirst && first.status === 'uncertain') ||
        followUp.status === 'uncertain'
      ) {
        return { status: 'uncertain' };
      }
      return { status: 'updated', stats: followUp.stats };
    } catch {
      return { status: 'uncertain' };
    }
  }

  #sendOneBatch(): Promise<InternalBatchResult> | null {
    if (this.#inFlight) return this.#inFlight;
    this.#cancelFlushTimer();

    const statsScope = this.#statsScope;
    if (!this.#authenticated || !statsScope) {
      this.#pending = EMPTY_DELTA();
      return null;
    }

    const batch = this.#takeBatch();
    if (!hasDelta(batch)) return null;

    const operation = (async (): Promise<InternalBatchResult> => {
      try {
        const stats = await this.#deps.addStats(batch, statsScope);
        return { status: 'updated', stats, statsScope };
      } catch {
        // Deliberately do not put `batch` back. The server may have committed
        // it before the response was lost.
        return { status: 'uncertain', statsScope };
      } finally {
        this.#inFlight = null;
        if (
          !this.#disposed &&
          this.#authenticated &&
          this.#statsScope !== null &&
          hasDelta(this.#pending)
        ) {
          this.#scheduleFlush();
        }
      }
    })();
    this.#inFlight = operation;
    return operation;
  }

  async dispose(flushPending = true): Promise<void> {
    if (this.#disposed) {
      await this.#inFlight;
      return;
    }

    this.#refreshTrackDuration();
    this.#advance(this.#deps.now());
    const finalFlush = flushPending ? this.flush() : Promise.resolve();
    if (!flushPending) this.#discardPending();

    this.#disposed = true;
    this.#stopSampling?.();
    this.#stopSampling = null;
    this.#cancelLeadershipTimer();
    this.#cancelFlushTimer();
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    await finalFlush;
  }

  abortPendingJoin(): void {
    if (this.#sessionActive) return;
    this.#resumeSessionCounted = false;
    safeStorageRemove(this.#deps.storage, SESSION_COUNTED_STORAGE_KEY);
  }

  #advance(now: number): void {
    const elapsed = now - this.#lastSampleAt;
    this.#lastSampleAt = now;
    if (
      !this.#eligible ||
      !Number.isFinite(elapsed) ||
      elapsed <= 0 ||
      elapsed > MAX_OBSERVED_SAMPLE_GAP_MS
    ) {
      return;
    }

    this.#listeningRemainderMs += elapsed;
    const completeSeconds = Math.floor(this.#listeningRemainderMs / 1_000);
    if (completeSeconds > 0) {
      this.#listeningRemainderMs -= completeSeconds * 1_000;
      this.#queueDelta({ listeningSecondsDelta: completeSeconds });
    }

    if (!this.#trackKey || this.#countedTrackKeys.has(this.#trackKey)) return;
    this.#trackProgressMs += elapsed;
    this.#countTrackIfQualified();
  }

  #beginParticipation(): void {
    this.#sessionCounted = this.#resumeSessionCounted;
    if (this.#sessionCounted) this.#resumeSessionCounted = false;
    this.#participationLeader = null;
    this.#countedTrackKeys = new Set();
    this.#trackProgressMs = 0;
    this.#listeningRemainderMs = 0;
    this.#trackKey = currentTrackKey(this.#runtime);
    this.#trackDurationSeconds = this.#runtime.trackDurationSeconds;
  }

  #endParticipation(): void {
    this.#cancelLeadershipTimer();
    this.#participationLeader = null;
    this.#sessionCounted = false;
    this.#resumeSessionCounted = false;
    this.#countedTrackKeys.clear();
    this.#trackProgressMs = 0;
    this.#trackDurationSeconds = null;
    this.#listeningRemainderMs = 0;
    this.#trackKey = null;
    safeStorageRemove(this.#deps.storage, SESSION_COUNTED_STORAGE_KEY);
  }

  #resetAccountBoundary(): void {
    this.#discardPending();
    this.#cancelLeadershipTimer();
    this.#listeningRemainderMs = 0;
    this.#sessionCounted = false;
    this.#participationLeader = null;
    this.#countedTrackKeys.clear();
    this.#trackProgressMs = 0;
    this.#trackDurationSeconds = null;

    this.#resumeSessionCounted = false;
    safeStorageRemove(this.#deps.storage, SESSION_COUNTED_STORAGE_KEY);
  }

  #reconcileTrackKey(): void {
    const nextTrackKey = currentTrackKey(this.#runtime);
    if (nextTrackKey === this.#trackKey) {
      this.#trackDurationSeconds = this.#runtime.trackDurationSeconds;
      this.#countTrackIfQualified();
      return;
    }
    this.#trackKey = nextTrackKey;
    this.#trackProgressMs = 0;
    // The media player can briefly expose the previous duration while a new
    // file or YouTube sub-item is taking ownership. Require a later same-key
    // observation before applying a shortened threshold.
    this.#trackDurationSeconds = null;
  }

  #refreshTrackDuration(): void {
    const latestRuntime = this.#deps.readRuntime();
    if (currentTrackKey(latestRuntime) !== this.#trackKey) return;
    this.#trackDurationSeconds = latestRuntime.trackDurationSeconds;
    this.#countTrackIfQualified();
  }

  #countTrackIfQualified(): void {
    if (
      !this.#trackKey ||
      this.#countedTrackKeys.has(this.#trackKey) ||
      this.#trackProgressMs < trackCountThresholdMs(this.#trackDurationSeconds)
    ) {
      return;
    }
    this.#countedTrackKeys.add(this.#trackKey);
    this.#queueDelta({ trackCountDelta: 1 });
  }

  #refreshEligibility(): void {
    this.#eligible =
      this.#authenticated &&
      this.#statsScope !== null &&
      this.#visible &&
      this.#sessionActive &&
      this.#participationLeader === true &&
      this.#runtime.playbackMode !== null &&
      this.#runtime.playbackActivity === 'playing';
  }

  #countSessionOnce(): void {
    if (
      this.#sessionCounted ||
      !this.#sessionActive ||
      !this.#authenticated ||
      !this.#statsScope ||
      this.#participationLeader !== true
    ) {
      return;
    }

    // Persist before attempting delivery. A response can be lost after the
    // server commits, so a hard reconnect must never manufacture a retry.
    this.#sessionCounted = true;
    safeStorageWrite(this.#deps.storage, SESSION_COUNTED_STORAGE_KEY, '1');
    this.#queueDelta({ sessionCountDelta: 1 });
  }

  #rescheduleLeadershipDecision(): void {
    this.#cancelLeadershipTimer();
    this.#stopLeadershipTimer = this.#deps.scheduler.schedule(
      'leadership',
      () => {
        this.#stopLeadershipTimer = null;
        if (
          this.#disposed ||
          !this.#authenticated ||
          this.#statsScope === null ||
          !this.#sessionActive ||
          this.#participationLeader !== null
        ) {
          return;
        }

        const now = this.#deps.now();
        this.#advance(now);
        this.#runtime = this.#deps.readRuntime();
        const leader = electCurrentDeviceLeader(this.#runtime);
        if (leader === null) {
          this.#rescheduleLeadershipDecision();
          return;
        }
        this.#participationLeader = leader;
        this.#reconcileTrackKey();
        if (this.#participationLeader) this.#countSessionOnce();
        this.#refreshEligibility();
        this.#lastSampleAt = now;
      },
      LEADERSHIP_SETTLE_MS,
    );
  }

  #queueDelta(delta: Partial<AccountStatsDelta>): void {
    this.#pending.sessionCountDelta += delta.sessionCountDelta ?? 0;
    this.#pending.listeningSecondsDelta += delta.listeningSecondsDelta ?? 0;
    this.#pending.trackCountDelta += delta.trackCountDelta ?? 0;
    this.#scheduleFlush();
  }

  #takeBatch(): AccountStatsDelta {
    const batch = {
      sessionCountDelta: Math.min(this.#pending.sessionCountDelta, MAX_BATCH.sessionCountDelta),
      listeningSecondsDelta: Math.min(
        this.#pending.listeningSecondsDelta,
        MAX_BATCH.listeningSecondsDelta,
      ),
      trackCountDelta: Math.min(this.#pending.trackCountDelta, MAX_BATCH.trackCountDelta),
    };
    this.#pending.sessionCountDelta -= batch.sessionCountDelta;
    this.#pending.listeningSecondsDelta -= batch.listeningSecondsDelta;
    this.#pending.trackCountDelta -= batch.trackCountDelta;
    return batch;
  }

  #discardPending(): void {
    this.#pending = EMPTY_DELTA();
    this.#cancelFlushTimer();
  }

  #restartSampling(): void {
    this.#stopSampling?.();
    this.#stopSampling = this.#deps.scheduler.startSampling(
      () => this.sample(),
      SAMPLE_INTERVAL_MS,
    );
  }

  #scheduleFlush(): void {
    if (this.#stopFlushTimer || this.#inFlight || !this.#statsScope || !hasDelta(this.#pending)) {
      return;
    }
    this.#stopFlushTimer = this.#deps.scheduler.schedule(
      'flush',
      () => {
        this.#stopFlushTimer = null;
        void this.flush();
      },
      AUTO_FLUSH_DELAY_MS,
    );
  }

  #rescheduleFlush(): void {
    if (this.#inFlight || !this.#statsScope || !hasDelta(this.#pending)) return;
    this.#cancelFlushTimer();
    this.#scheduleFlush();
  }

  #cancelLeadershipTimer(): void {
    this.#stopLeadershipTimer?.();
    this.#stopLeadershipTimer = null;
  }

  #cancelFlushTimer(): void {
    this.#stopFlushTimer?.();
    this.#stopFlushTimer = null;
  }

  #handlePageHide(): void {
    if (this.#disposed) return;
    this.#refreshTrackDuration();
    this.#advance(this.#deps.now());
    void this.flush();
  }
}

export function createAccountActivityStatsTracker(
  deps: AccountActivityStatsDependencies,
): AccountActivityStatsTracker {
  return new ActivityStatsTracker(deps);
}

const SAMPLE_TIMER_NAME = 'account-activity-stats-sample';
const LEADERSHIP_TIMER_NAME = 'account-activity-stats-leadership';
const FLUSH_TIMER_NAME = 'account-activity-stats-flush';

function readConnectedDevices(): AccountActivityDevice[] {
  const devices = new Map<string, AccountActivityDevice>();
  const add = (device: AccountActivityDevice): void => {
    if (!device.id) return;
    const previous = devices.get(device.id);
    devices.set(
      device.id,
      previous
        ? {
            id: device.id,
            memberId: device.memberId ?? previous.memberId,
            joinOrder: device.joinOrder ?? previous.joinOrder,
            status: device.status ?? previous.status,
            isAuthenticated: device.isAuthenticated ?? previous.isAuthenticated,
          }
        : device,
    );
  };

  for (const peer of getState('network.connectedPeers')) {
    add({
      id: peer.id,
      memberId: peer.memberId,
      joinOrder: peer.joinOrder,
      status: peer.status,
      isAuthenticated: peer.isAuthenticated,
    });
  }
  for (const device of getState('network.lastKnownDeviceList') ?? []) {
    add({
      id: device.id,
      memberId: device.memberId,
      joinOrder: device.joinOrder,
      status: device.status,
      isAuthenticated: device.isAuthenticated,
    });
  }
  return [...devices.values()];
}

function readRuntimeSnapshot(
  trackDurationSeconds: number | null = null,
): AccountActivityRuntimeSnapshot {
  const playbackMode = getState('playback.mode');
  const currentQueueItemId = getState('playlist.currentQueueItemId');
  const youtubeSubIndex = getState('youtube.currentSubIndex');

  return {
    sessionStarted: getState('setup.sessionStarted'),
    playbackMode,
    playbackActivity: getState('playback.activity'),
    currentQueueItemId,
    trackDurationSeconds,
    youtubeSubIndex,
    myDeviceId: getState('network.myId'),
    myMemberId: getState('network.myMemberId'),
    myMemberAuthenticated: getState('network.myMemberAuthenticated'),
    myJoinOrder: getState('network.myJoinOrder'),
    connectedDevices: readConnectedDevices(),
  };
}

function normalizedTrackDurationSeconds(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function createProductionRuntimeAccess(): {
  read: () => AccountActivityRuntimeSnapshot;
  subscribe: (listener: () => void) => () => void;
} {
  let durationObservation: { trackKey: string; durationSeconds: number | null } | null = null;

  const read = (): AccountActivityRuntimeSnapshot => {
    const runtime = readRuntimeSnapshot();
    const trackKey = currentTrackKey(runtime);
    return {
      ...runtime,
      trackDurationSeconds:
        trackKey !== null && durationObservation?.trackKey === trackKey
          ? durationObservation.durationSeconds
          : null,
    };
  };

  const subscribe = (listener: () => void): (() => void) => {
    const notifyStateChange = (): void => {
      const nextTrackKey = currentTrackKey(readRuntimeSnapshot());
      if (durationObservation?.trackKey !== nextTrackKey) durationObservation = null;
      listener();
    };
    const observeDuration = (
      expectedMode: Extract<PlaybackMode, 'file' | 'youtube'>,
      durationSeconds: number,
    ): void => {
      const runtime = readRuntimeSnapshot();
      if (runtime.playbackMode !== expectedMode) return;
      const trackKey = currentTrackKey(runtime);
      if (!trackKey) return;
      const normalizedDuration = normalizedTrackDurationSeconds(durationSeconds);
      if (
        durationObservation?.trackKey === trackKey &&
        durationObservation.durationSeconds === normalizedDuration
      ) {
        return;
      }
      durationObservation = {
        trackKey,
        durationSeconds: normalizedDuration,
      };
      listener();
    };
    const unsubscribers = [
      bus.on('state:setup.sessionStarted', notifyStateChange),
      bus.on('state:playback.mode', notifyStateChange),
      bus.on('state:playback.activity', notifyStateChange),
      bus.on('state:playlist.currentQueueItemId', notifyStateChange),
      bus.on('state:youtube.currentSubIndex', notifyStateChange),
      bus.on('state:network.myId', notifyStateChange),
      bus.on('state:network.myMemberId', notifyStateChange),
      bus.on('state:network.myMemberAuthenticated', notifyStateChange),
      bus.on('state:network.myJoinOrder', notifyStateChange),
      bus.on('state:network.connectedPeers', notifyStateChange),
      bus.on('state:network.lastKnownDeviceList', notifyStateChange),
      bus.on('ui:duration-update', (duration) => observeDuration('file', duration)),
      bus.on('ui:time-update', (_current, _total, _currentTime, duration) =>
        observeDuration('youtube', duration),
      ),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  };

  return { read, subscribe };
}

function createManagedScheduler(): AccountActivityScheduler {
  const timerName = (name: TimerName): string =>
    name === 'leadership' ? LEADERSHIP_TIMER_NAME : FLUSH_TIMER_NAME;

  return {
    startSampling(callback, intervalMs) {
      setManagedTimer(SAMPLE_TIMER_NAME, callback, intervalMs, { interval: true });
      return () => clearManagedTimer(SAMPLE_TIMER_NAME);
    },
    schedule(name, callback, delayMs) {
      const managedName = timerName(name);
      setManagedTimer(managedName, callback, delayMs);
      return () => clearManagedTimer(managedName);
    },
  };
}

function subscribeVisibility(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

function subscribePageHide(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('pagehide', listener);
  return () => window.removeEventListener('pagehide', listener);
}

function getSessionStorage(): AccountActivityStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function createProductionDependencies(): AccountActivityStatsDependencies {
  const storage = getSessionStorage();
  const runtimeAccess = createProductionRuntimeAccess();
  return {
    now: () =>
      typeof performance === 'undefined' || typeof performance.now !== 'function'
        ? Date.now()
        : performance.now(),
    readRuntime: runtimeAccess.read,
    readAccount: getAccountSnapshot,
    readStatsScope: getAccountStatsScope,
    subscribeAccount,
    subscribeRuntime: runtimeAccess.subscribe,
    subscribeVisibility,
    subscribePageHide,
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    addStats: addAccountStats,
    scheduler: createManagedScheduler(),
    storage,
    hasReconnectMarker: () => safeStorageRead(storage, RECONNECT_TARGET_STORAGE_KEY) !== null,
  };
}

let _tracker: AccountActivityStatsTracker | null = null;
let _initUnsubscribers: Array<() => void> = [];

export function initAccountActivityStats(): void {
  if (_tracker) return;
  _tracker = createAccountActivityStatsTracker(createProductionDependencies());

  // A reconnect target is removed before sessionStarted becomes true, while a
  // failed/cancelled join never opens a participation. Clear only our boolean
  // marker at those explicit failure boundaries.
  _initUnsubscribers = [
    bus.on('setup:guest-join-failure', () => _tracker?.abortPendingJoin()),
    bus.on('setup:guest-join-cancelled', () => _tracker?.abortPendingJoin()),
  ];
}

export function flushAccountActivityStatsForRead(): Promise<AccountActivityStatsFlushResult> {
  return _tracker?.flushForRead() ?? Promise.resolve({ status: 'idle' });
}

export async function disposeAccountActivityStats(flushPending = true): Promise<void> {
  const tracker = _tracker;
  _tracker = null;
  for (const unsubscribe of _initUnsubscribers.splice(0)) unsubscribe();
  await tracker?.dispose(flushPending);
}

export const __accountActivityStatsForTests = {
  SAMPLE_INTERVAL_MS,
  MAX_OBSERVED_SAMPLE_GAP_MS,
  TRACK_COUNT_MAX_THRESHOLD_MS,
  TRACK_COUNT_DURATION_FRACTION,
  LEADERSHIP_SETTLE_MS,
  AUTO_FLUSH_DELAY_MS,
  SESSION_COUNTED_STORAGE_KEY,
  RECONNECT_TARGET_STORAGE_KEY,
  trackCountThresholdMs,
  electCurrentDeviceLeader,
};
