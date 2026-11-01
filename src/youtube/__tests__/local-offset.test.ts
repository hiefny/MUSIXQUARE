import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import {
  beginStandardHostYouTubeEndHold,
  clearStandardHostYouTubeEndHold,
  isCanonicalYouTubeManualOffsetEndpoint,
  isStandardHostYouTubeLocalStartPending,
  resolveProCoordinatorYouTubeTarget,
  resolveYouTubePlaybackStartTarget,
  resolveYouTubeAudiblePlaybackTarget,
  recordStandardHostYouTubeAutomaticOffset,
  setStandardHostYouTubeLocalStartTimelineReader,
  setYouTubeScheduledStartTimelineReader,
  shouldNeutralizeStandardHostYouTubeOffsetAtEnd,
  toCanonicalYouTubeTime,
} from '../local-offset.ts';

function setProCoordinator(): void {
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'coordinator',
    coordinatorId: 'participant-0',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
}

function setActiveStandardHost(): void {
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
}

describe('PRO coordinator YouTube local offset', () => {
  beforeEach(() => {
    resetState();
    setYouTubeScheduledStartTimelineReader(() => null);
  });

  it.each([
    [0, -0.25, 0, 250, -0.25],
    [0.1, -0.25, 0, 150, -0.25],
    [0.5, -0.25, 0.25, 0, -0.25],
    [0, 0.25, 0.25, 0, 0.25],
    [0, -9.999, 0, 9999, -9.999],
    [0, -100, 0, 9999, -9.999],
  ])(
    'preserves a playing start at %s with offset %s',
    (canonical, offset, local, wait, applied) => {
      const target = resolveYouTubePlaybackStartTarget(canonical, offset, 300);
      expect(target.localTime).toBeCloseTo(local);
      expect(target.localStartDelayMs).toBeCloseTo(wait);
      expect(target.effectiveOffset).toBeCloseTo(applied);
      expect(target.localTime - target.effectiveOffset).toBeCloseTo(canonical + wait / 1000);
    },
  );

  it('uses live scheduled room time only for the Standard host waiting at zero', () => {
    setActiveStandardHost();
    setState('sync.youtubeCoordinatorAppliedOffset', 0);
    let pendingTime: number | null = 0.1;
    setYouTubeScheduledStartTimelineReader(() => pendingTime);
    expect(toCanonicalYouTubeTime(0, 300)).toBe(0.1);
    pendingTime = 0.24;
    expect(toCanonicalYouTubeTime(0, 300)).toBe(0.24);
    pendingTime = null;
    setState('sync.youtubeCoordinatorAppliedOffset', -0.25);
    expect(toCanonicalYouTubeTime(0.1, 300)).toBeCloseTo(0.35);
    pendingTime = 50;
    setProCoordinator();
    expect(toCanonicalYouTubeTime(0.1, 300)).toBeCloseTo(0.35);
  });

  it('is an identity conversion in standard rooms and for PRO members', () => {
    setState('sync.youtubeLocalOffset', 0.25);
    expect(toCanonicalYouTubeTime(42.5, 120)).toBe(42.5);

    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'participant-0',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    expect(toCanonicalYouTubeTime(42.5, 120)).toBe(42.5);
  });

  it('removes only the effective coordinator offset from wire time', () => {
    setProCoordinator();
    setState('sync.youtubeLocalOffset', 0.25);
    setState('sync.youtubeCoordinatorAppliedOffset', 0.25);
    expect(toCanonicalYouTubeTime(42.5, 120)).toBe(42.25);
  });

  it('removes an active standard host offset from its canonical wire time', () => {
    setActiveStandardHost();
    setState('sync.youtubeLocalOffset', 0.25);
    setState('sync.youtubeCoordinatorAppliedOffset', 0.25);

    expect(isCanonicalYouTubeManualOffsetEndpoint()).toBe(true);
    expect(toCanonicalYouTubeTime(42.5, 120)).toBe(42.25);

    setState('network.appRole', 'guest');
    expect(isCanonicalYouTubeManualOffsetEndpoint()).toBe(false);
    expect(toCanonicalYouTubeTime(42.5, 120)).toBe(42.5);
  });

  it('neutralizes only an active standard host offset near either end clock', () => {
    setActiveStandardHost();

    expect(shouldNeutralizeStandardHostYouTubeOffsetAtEnd(100, 90, 120, 10)).toBe(false);
    expect(shouldNeutralizeStandardHostYouTubeOffsetAtEnd(119, 109, 120, 10)).toBe(true);
    expect(shouldNeutralizeStandardHostYouTubeOffsetAtEnd(109, 119, 120, -10)).toBe(true);

    setState('network.appRole', 'guest');
    expect(shouldNeutralizeStandardHostYouTubeOffsetAtEnd(119, 109, 120, 10)).toBe(false);
  });

  it.each([
    [20, 9.999, 30.249, 0, 10.249, 0.25],
    [20, -9.999, 10.251, 0, -9.749, 0.25],
    [0, -9.999, 0, 9749, -9.749, 0.25],
    [0.1, -0.25, 0.1, 0, 0, 0.25],
    [299.9, 0, 299.95, 0, 0.05, 0.05],
  ])(
    'composes bounded manual and actual output at %s + %s',
    (canonical, manual, local, wait, applied, automatic) => {
      const target = resolveYouTubeAudiblePlaybackTarget(canonical, manual, 300, 0.25);
      expect(target.localTime).toBeCloseTo(local, 8);
      expect(target.localStartDelayMs).toBeCloseTo(wait, 8);
      expect(target.effectiveOffset).toBeCloseTo(applied, 8);
      expect(target.automaticOffset).toBeCloseTo(automatic, 8);
      expect(target.requestedOffset).toBe(manual);
    },
  );

  it('keeps the measured automatic component at the end and neutralizes only manual residual', () => {
    setActiveStandardHost();
    recordStandardHostYouTubeAutomaticOffset(0.25);
    expect(shouldNeutralizeStandardHostYouTubeOffsetAtEnd(120, 119.75, 120, 0.25)).toBe(false);
    expect(shouldNeutralizeStandardHostYouTubeOffsetAtEnd(120, 119.5, 120, 0.5)).toBe(true);
    expect(shouldNeutralizeStandardHostYouTubeOffsetAtEnd(119, 119.75, 120, -0.75)).toBe(true);
    recordStandardHostYouTubeAutomaticOffset(0);
  });

  it('stores the achievable lower-bound offset instead of the requested one', () => {
    const target = resolveProCoordinatorYouTubeTarget(1, -3, 120);
    expect(target).toEqual({
      canonicalTime: 1,
      localTime: 0,
      requestedOffset: -3,
      effectiveOffset: -1,
    });
  });

  it('stores the achievable upper-bound offset instead of the requested one', () => {
    const target = resolveProCoordinatorYouTubeTarget(119, 3, 120);
    expect(target).toEqual({
      canonicalTime: 119,
      localTime: 120,
      requestedOffset: 3,
      effectiveOffset: 1,
    });
  });
});

describe("the Standard host's pending start time (pinned 2026-11-01)", () => {
  // Two start owners hold this speaker while the room plays on: the legacy
  // rendezvous's local start (player.ts installs its reader) and the
  // zero-start run's scheduled start (getYouTubeZeroStartPendingCanonicalPosition).
  // The room time reads them after the end hold, the legacy one first; the
  // pending-start predicate reads only the legacy one.
  const reads: string[] = [];

  function installReaders(legacy: number | null, scheduled: number | null): void {
    setStandardHostYouTubeLocalStartTimelineReader(() => {
      reads.push('legacy');
      return legacy;
    });
    setYouTubeScheduledStartTimelineReader(() => {
      reads.push('zero-start');
      return scheduled;
    });
  }

  beforeEach(() => {
    resetState();
    setActiveStandardHost();
    setState('sync.youtubeCoordinatorAppliedOffset', 0);
    reads.splice(0);
  });

  afterEach(() => {
    clearStandardHostYouTubeEndHold();
    setStandardHostYouTubeLocalStartTimelineReader(null);
    setYouTubeScheduledStartTimelineReader(() => null);
  });

  it.each([
    // legacy, zero-start, room time of local 42 s in a 120 s video, readers asked, pending
    [1.5, 0.25, 1.5, ['legacy'], true],
    [null, 0.25, 0.25, ['legacy', 'zero-start'], false],
    [null, 200, 120, ['legacy', 'zero-start'], false],
    [null, null, 42, ['legacy', 'zero-start'], false],
    // A non-finite zero-start answer is no answer: the local time converts.
    [null, Number.NaN, 42, ['legacy', 'zero-start'], false],
    [null, Number.POSITIVE_INFINITY, 42, ['legacy', 'zero-start'], false],
    // Any legacy answer holds, clamped into the video; a non-finite one reads 0.
    [200, 0.25, 120, ['legacy'], true],
    [-1, 0.25, 0, ['legacy'], true],
    [Number.NaN, 0.25, 0, ['legacy'], true],
    [Number.POSITIVE_INFINITY, 0.25, 0, ['legacy'], true],
  ] as const)(
    'legacy %s, zero-start %s: room time %s',
    (legacy, scheduled, roomTime, asked, pending) => {
      installReaders(legacy, scheduled);
      expect(toCanonicalYouTubeTime(42, 120)).toBe(roomTime);
      expect(reads.splice(0)).toEqual(asked);
      expect(isStandardHostYouTubeLocalStartPending()).toBe(pending);
      expect(reads).toEqual(['legacy']);
    },
  );

  it('reads neither owner while the end hold holds the room time', () => {
    installReaders(1.5, 0.25);
    beginStandardHostYouTubeEndHold(100, 120, () => true);
    expect(toCanonicalYouTubeTime(42, 120)).toBeCloseTo(100, 1);
    expect(reads).toEqual([]);
  });

  it('reads neither owner on a Standard guest, whose room time is its local time', () => {
    setState('network.appRole', 'guest');
    installReaders(1.5, 0.25);
    expect(toCanonicalYouTubeTime(42, 120)).toBe(42);
    expect(isStandardHostYouTubeLocalStartPending()).toBe(false);
    expect(reads).toEqual([]);
  });
});
