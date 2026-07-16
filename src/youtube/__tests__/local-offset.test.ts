import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { resolveProCoordinatorYouTubeTarget, toCanonicalYouTubeTime } from '../local-offset.ts';

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

describe('PRO coordinator YouTube local offset', () => {
  beforeEach(() => resetState());

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
