import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import {
  isCanonicalYouTubeManualOffsetEndpoint,
  resolveProCoordinatorYouTubeTarget,
  resolveYouTubePlaybackStartTarget,
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
