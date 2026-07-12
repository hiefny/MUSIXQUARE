import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  allocatePlaybackRevision,
  applyPlaybackTimelineIntent,
  createStoppedPlaybackTimeline,
  derivePlaybackPosition,
  isPlaybackTimelineSnapshot,
  samePlaybackRun,
  type PlaybackRunIdentity,
} from '../playback-timeline.ts';

const QID_A = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const QID_B = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const RUN_A: PlaybackRunIdentity = { queueItemId: QID_A, runId: 'run-a' };
const RUN_B: PlaybackRunIdentity = { queueItemId: QID_B, runId: 'run-b' };

describe('playback timeline v2', () => {
  it('creates an immutable, JSON-safe stopped timeline', () => {
    const snapshot = createStoppedPlaybackTimeline(100, 4);

    expect(snapshot).toEqual({
      schemaVersion: 1,
      revision: 4,
      phase: 'stopped',
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: 100,
      rate: 1,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(isPlaybackTimelineSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
  });

  it('allocates strictly increasing safe revisions', () => {
    expect(allocatePlaybackRevision(0)).toBe(1);
    expect(allocatePlaybackRevision(41)).toBe(42);
    expect(() => allocatePlaybackRevision(-1)).toThrow(RangeError);
    expect(() => allocatePlaybackRevision(1.5)).toThrow(RangeError);
    expect(() => allocatePlaybackRevision(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });

  it('derives a playing position from the monotonic anchor and rate', () => {
    const started = applyPlaybackTimelineIntent(
      createStoppedPlaybackTimeline(1_000),
      { type: 'play', revision: 1, run: RUN_A, positionSeconds: 12, rate: 1.25 },
      1_000,
    );
    expect(started.applied).toBe(true);

    expect(derivePlaybackPosition(started.snapshot, 3_000)).toBeCloseTo(14.5, 8);
    expect(Object.isFrozen(started.snapshot)).toBe(true);
    expect(Object.isFrozen(started.snapshot.run)).toBe(true);
  });

  it('pauses at the derived position, seeks without changing phase, and resumes', () => {
    const initial = createStoppedPlaybackTimeline(0);
    const played = applyPlaybackTimelineIntent(
      initial,
      { type: 'play', revision: 1, run: RUN_A, positionSeconds: 5, rate: 1 },
      0,
    ).snapshot;
    const paused = applyPlaybackTimelineIntent(
      played,
      { type: 'pause', revision: 2, run: RUN_A },
      2_500,
    ).snapshot;
    expect(paused.phase).toBe('paused');
    expect(paused.positionSeconds).toBe(7.5);
    expect(derivePlaybackPosition(paused, 9_000)).toBe(7.5);

    const sought = applyPlaybackTimelineIntent(
      paused,
      { type: 'seek', revision: 3, run: RUN_A, positionSeconds: 48.25 },
      9_000,
    ).snapshot;
    expect(sought.phase).toBe('paused');
    expect(sought.positionSeconds).toBe(48.25);

    const resumed = applyPlaybackTimelineIntent(
      sought,
      { type: 'play', revision: 4, run: RUN_A, positionSeconds: 48.25, rate: 1 },
      10_000,
    ).snapshot;
    expect(resumed.phase).toBe('playing');
    expect(derivePlaybackPosition(resumed, 10_500)).toBe(48.75);
  });

  it('stops only the current run and clears its position', () => {
    const playing = applyPlaybackTimelineIntent(
      createStoppedPlaybackTimeline(),
      { type: 'play', revision: 1, run: RUN_A, positionSeconds: 2, rate: 1 },
      0,
    ).snapshot;
    const stopped = applyPlaybackTimelineIntent(
      playing,
      { type: 'stop', revision: 2, run: RUN_A },
      100,
    );

    expect(stopped).toMatchObject({ applied: true });
    expect(stopped.snapshot).toMatchObject({
      revision: 2,
      phase: 'stopped',
      run: null,
      positionSeconds: 0,
      rate: 1,
    });
  });

  it('allows a newer play to replace the previous run identity', () => {
    const first = applyPlaybackTimelineIntent(
      createStoppedPlaybackTimeline(),
      { type: 'play', revision: 1, run: RUN_A, positionSeconds: 0, rate: 1 },
      0,
    ).snapshot;
    const second = applyPlaybackTimelineIntent(
      first,
      { type: 'play', revision: 2, run: RUN_B, positionSeconds: 3, rate: 1 },
      10,
    );

    expect(second.applied).toBe(true);
    expect(second.snapshot.run).toEqual(RUN_B);
    expect(samePlaybackRun(second.snapshot.run, RUN_A)).toBe(false);
  });

  it('ignores stale revisions without allocating a replacement object', () => {
    const playing = applyPlaybackTimelineIntent(
      createStoppedPlaybackTimeline(0, 5),
      { type: 'play', revision: 6, run: RUN_A, positionSeconds: 0, rate: 1 },
      0,
    ).snapshot;

    const stale = applyPlaybackTimelineIntent(
      playing,
      { type: 'seek', revision: 6, run: RUN_A, positionSeconds: 99 },
      Number.NaN,
    );
    expect(stale).toEqual({ applied: false, reason: 'stale-revision', snapshot: playing });
    expect(stale.snapshot).toBe(playing);
  });

  it('ignores a newer command for a superseded run', () => {
    const playing = applyPlaybackTimelineIntent(
      createStoppedPlaybackTimeline(),
      { type: 'play', revision: 1, run: RUN_A, positionSeconds: 0, rate: 1 },
      0,
    ).snapshot;

    const mismatched = applyPlaybackTimelineIntent(
      playing,
      { type: 'pause', revision: 2, run: RUN_B },
      100,
    );
    expect(mismatched).toEqual({ applied: false, reason: 'run-mismatch', snapshot: playing });
  });

  it('rejects non-finite positions, non-positive rates, and a backwards clock', () => {
    const stopped = createStoppedPlaybackTimeline(100);
    expect(() =>
      applyPlaybackTimelineIntent(
        stopped,
        { type: 'play', revision: 1, run: RUN_A, positionSeconds: Number.NaN, rate: 1 },
        100,
      ),
    ).toThrow(RangeError);
    expect(() =>
      applyPlaybackTimelineIntent(
        stopped,
        { type: 'play', revision: 1, run: RUN_A, positionSeconds: 0, rate: 0 },
        100,
      ),
    ).toThrow(RangeError);
    expect(() => derivePlaybackPosition(stopped, 99)).toThrow(RangeError);
  });

  it('rejects structurally inconsistent serialized snapshots', () => {
    expect(
      isPlaybackTimelineSnapshot({
        ...createStoppedPlaybackTimeline(),
        phase: 'playing',
        run: null,
      }),
    ).toBe(false);
    expect(
      isPlaybackTimelineSnapshot({
        ...createStoppedPlaybackTimeline(),
        positionSeconds: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
    expect(
      isPlaybackTimelineSnapshot({
        ...createStoppedPlaybackTimeline(),
        audioNode: { connect: () => undefined },
      }),
    ).toBe(false);
  });
});
