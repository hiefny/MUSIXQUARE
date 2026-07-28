import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { sameRun, type PlaybackRunIdentity } from '../playback-identity.ts';
import {
  adoptPlaybackTimelineBaseline,
  applyPlaybackTimelineIntent,
  createStoppedPlaybackTimeline,
  derivePlaybackPosition,
  isPlaybackTimelineSnapshot,
  PLAYBACK_TIMELINE_TRAJECTORY_TOLERANCE_SECONDS,
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
    expect(sameRun(second.snapshot.run, RUN_A)).toBe(false);
  });

  it('ignores stale revisions after detaching a canonical snapshot', () => {
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
    expect(stale.snapshot).toEqual(playing);
  });

  it('rejects a revision gap without mutating the canonical timeline', () => {
    const playing = applyPlaybackTimelineIntent(
      createStoppedPlaybackTimeline(),
      { type: 'play', revision: 1, run: RUN_A, positionSeconds: 4, rate: 1 },
      0,
    ).snapshot;

    const jumped = applyPlaybackTimelineIntent(
      playing,
      { type: 'seek', revision: 3, run: RUN_A, positionSeconds: 99 },
      100,
    );

    expect(jumped).toEqual({ applied: false, reason: 'revision-gap', snapshot: playing });
    expect(Object.isFrozen(jumped.snapshot)).toBe(true);
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
    ).toThrow(TypeError);
    expect(() =>
      applyPlaybackTimelineIntent(
        stopped,
        { type: 'play', revision: 1, run: RUN_A, positionSeconds: 0, rate: 0 },
        100,
      ),
    ).toThrow(TypeError);
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
    expect(
      isPlaybackTimelineSnapshot({
        ...createStoppedPlaybackTimeline(),
        positionSeconds: 1,
      }),
    ).toBe(false);
    expect(
      isPlaybackTimelineSnapshot({
        ...createStoppedPlaybackTimeline(),
        rate: 2,
      }),
    ).toBe(false);
  });

  it('rejects hostile snapshot descriptors, symbols, and prototypes without [[Get]]', () => {
    let getterCalls = 0;
    const accessor = { ...createStoppedPlaybackTimeline() };
    Object.defineProperty(accessor, 'phase', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'stopped';
      },
    });
    expect(isPlaybackTimelineSnapshot(accessor)).toBe(false);
    expect(getterCalls).toBe(0);

    expect(
      isPlaybackTimelineSnapshot({ ...createStoppedPlaybackTimeline(), [Symbol('extra')]: true }),
    ).toBe(false);
    const nonEnumerable = { ...createStoppedPlaybackTimeline() };
    Object.defineProperty(nonEnumerable, 'rate', { value: 1, enumerable: false });
    expect(isPlaybackTimelineSnapshot(nonEnumerable)).toBe(false);
    expect(
      isPlaybackTimelineSnapshot(
        Object.assign(Object.create({ inherited: true }), createStoppedPlaybackTimeline()),
      ),
    ).toBe(false);

    const proxied = new Proxy(createStoppedPlaybackTimeline(), {
      get() {
        getterCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    expect(isPlaybackTimelineSnapshot(proxied)).toBe(true);
    expect(derivePlaybackPosition(proxied, 0)).toBe(0);
    expect(getterCalls).toBe(0);
  });

  it('applies only a detached canonical intent under hostile proxy re-entry', () => {
    let getCalls = 0;
    let nestedApplied = false;
    let reentered = false;
    const intent = new Proxy(
      { type: 'play', revision: 1, run: RUN_A, positionSeconds: 0, rate: 1 } as const,
      {
        get() {
          getCalls += 1;
          throw new Error('dynamic [[Get]] must not run');
        },
        getOwnPropertyDescriptor(target, property) {
          if (!reentered) {
            reentered = true;
            nestedApplied = applyPlaybackTimelineIntent(
              createStoppedPlaybackTimeline(),
              { type: 'play', revision: 1, run: RUN_B, positionSeconds: 0, rate: 1 },
              0,
            ).applied;
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    const result = applyPlaybackTimelineIntent(createStoppedPlaybackTimeline(), intent, 0);
    expect(result.applied).toBe(true);
    expect(result.snapshot.run).toEqual(RUN_A);
    expect(nestedApplied).toBe(true);
    expect(getCalls).toBe(0);

    const accessorIntent = {
      type: 'play',
      revision: 2,
      run: RUN_A,
      get positionSeconds() {
        getCalls += 1;
        return 0;
      },
      rate: 1,
    } as const;
    expect(() => applyPlaybackTimelineIntent(result.snapshot, accessorIntent, 1)).toThrow(
      TypeError,
    );
    expect(getCalls).toBe(0);
  });

  it('snapshots a nested run exactly once under Proxy TOCTOU', () => {
    let snapshotRunOwnKeys = 0;
    const snapshotRun = new Proxy(RUN_A, {
      ownKeys(target) {
        snapshotRunOwnKeys += 1;
        if (snapshotRunOwnKeys > 1) throw new Error('nested run was inspected twice');
        return Reflect.ownKeys(target);
      },
      get() {
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    const serialized = {
      schemaVersion: 1,
      revision: 1,
      phase: 'playing',
      run: snapshotRun,
      positionSeconds: 0,
      anchorMonotonicMs: 0,
      rate: 1,
    } as const;
    let snapshotAccepted = false;
    expect(() => {
      snapshotAccepted = isPlaybackTimelineSnapshot(serialized);
    }).not.toThrow();
    expect(snapshotAccepted).toBe(true);
    expect(snapshotRunOwnKeys).toBe(1);

    let intentRunOwnKeys = 0;
    const intentRun = new Proxy(RUN_A, {
      ownKeys(target) {
        intentRunOwnKeys += 1;
        if (intentRunOwnKeys > 1) throw new Error('nested run was inspected twice');
        return Reflect.ownKeys(target);
      },
      get() {
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    const applied = applyPlaybackTimelineIntent(
      createStoppedPlaybackTimeline(),
      { type: 'play', revision: 1, run: intentRun, positionSeconds: 0, rate: 1 },
      0,
    );
    expect(applied.applied).toBe(true);
    expect(applied.snapshot.run).toEqual(RUN_A);
    expect(intentRunOwnKeys).toBe(1);
  });

  describe('product baseline adoption', () => {
    function playing(
      revision: number,
      positionSeconds: number,
      anchorMonotonicMs: number,
      rate = 1,
      run: PlaybackRunIdentity = RUN_A,
    ) {
      return {
        schemaVersion: 1,
        revision,
        phase: 'playing',
        run,
        positionSeconds,
        anchorMonotonicMs,
        rate,
      } as const;
    }

    function paused(
      revision: number,
      positionSeconds: number,
      anchorMonotonicMs: number,
      rate = 1,
      run: PlaybackRunIdentity = RUN_A,
    ) {
      return {
        schemaVersion: 1,
        revision,
        phase: 'paused',
        run,
        positionSeconds,
        anchorMonotonicMs,
        rate,
      } as const;
    }

    it('adopts an arbitrary newer canonical snapshot without requiring contiguous revisions', () => {
      const current = createStoppedPlaybackTimeline(10, 0);
      const baseline = playing(73, 18.5, 25_000, 1.25);

      const result = adoptPlaybackTimelineBaseline(current, baseline);

      expect(result).toEqual({
        accepted: true,
        status: 'adopted',
        reason: null,
        snapshot: baseline,
      });
      expect(result.snapshot).not.toBe(baseline);
      expect(result.snapshot.run).not.toBe(baseline.run);
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.getPrototypeOf(result.snapshot)).toBeNull();
      expect(Object.getPrototypeOf(result.snapshot.run)).toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.snapshot)).toBe(true);
      expect(Object.isFrozen(result.snapshot.run)).toBe(true);
      expect(JSON.parse(JSON.stringify(result.snapshot))).toEqual(baseline);
    });

    it('adopts a newer stopped high watermark without inventing a run', () => {
      const result = adoptPlaybackTimelineBaseline(
        playing(4, 1, 0),
        createStoppedPlaybackTimeline(99_000, 500),
      );

      expect(result).toMatchObject({ accepted: true, status: 'adopted', reason: null });
      expect(result.snapshot).toEqual({
        schemaVersion: 1,
        revision: 500,
        phase: 'stopped',
        run: null,
        positionSeconds: 0,
        anchorMonotonicMs: 99_000,
        rate: 1,
      });
    });

    it('adopts an arbitrary newer paused snapshot in the supplied room-clock domain', () => {
      const baseline = paused(41, 123.75, 88_000, 0.75, RUN_B);
      const result = adoptPlaybackTimelineBaseline(createStoppedPlaybackTimeline(), baseline);

      expect(result).toMatchObject({ accepted: true, status: 'adopted', reason: null });
      expect(result.snapshot).toEqual(baseline);
      expect(result.snapshot).not.toBe(baseline);
      expect(result.snapshot.run).not.toBe(baseline.run);
    });

    it('rejects stale baselines, including a fresh room baseline against a prior-room watermark', () => {
      const priorRoom = createStoppedPlaybackTimeline(50_000, 900);
      const freshRoomBaseline = playing(1, 0, 60_000);

      const result = adoptPlaybackTimelineBaseline(priorRoom, freshRoomBaseline);

      expect(result).toEqual({
        accepted: false,
        status: 'rejected',
        reason: 'stale-revision',
        snapshot: priorRoom,
      });
      expect(result.snapshot).not.toBe(priorRoom);
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('accepts exact stopped and paused semantic replays while preserving local canonical state', () => {
      const stopped = createStoppedPlaybackTimeline(100, 12);
      const stoppedReplay = adoptPlaybackTimelineBaseline(
        stopped,
        createStoppedPlaybackTimeline(999, 12),
      );
      expect(stoppedReplay).toMatchObject({ accepted: true, status: 'replayed', reason: null });
      expect(stoppedReplay.snapshot).toEqual(stopped);
      expect(stoppedReplay.snapshot).not.toBe(stopped);

      const currentPaused = paused(8, 42.25, 1_000, 1.5);
      const pausedReplay = adoptPlaybackTimelineBaseline(
        currentPaused,
        paused(8, 42.25, 9_000, 1.5),
      );
      expect(pausedReplay).toMatchObject({ accepted: true, status: 'replayed', reason: null });
      expect(pausedReplay.snapshot).toEqual(currentPaused);
    });

    it('rejects equal-revision phase, run, rate, and paused-position conflicts', () => {
      const current = paused(8, 42.25, 1_000, 1.5);
      const conflicts = [
        playing(8, 42.25, 1_000, 1.5),
        paused(8, 42.25, 1_000, 1.5, RUN_B),
        paused(8, 42.25, 1_000, 1),
        paused(8, 42.250_001, 1_000, 1.5),
      ];

      for (const baseline of conflicts) {
        expect(adoptPlaybackTimelineBaseline(current, baseline)).toEqual({
          accepted: false,
          status: 'rejected',
          reason: 'equal-revision-conflict',
          snapshot: current,
        });
      }
    });

    it('accepts equal playing trajectories at either anchor direction within a microsecond', () => {
      const current = playing(9, 10, 1_000, 1.25);
      const later = playing(
        9,
        12.5 + PLAYBACK_TIMELINE_TRAJECTORY_TOLERANCE_SECONDS / 2,
        3_000,
        1.25,
      );
      const earlier = playing(9, 9.375, 500, 1.25);

      expect(adoptPlaybackTimelineBaseline(current, later)).toMatchObject({
        accepted: true,
        status: 'replayed',
        reason: null,
      });
      expect(adoptPlaybackTimelineBaseline(current, earlier)).toMatchObject({
        accepted: true,
        status: 'replayed',
        reason: null,
      });
    });

    it('rejects same-revision playing rewind, fast-forward, and non-finite projection', () => {
      const current = playing(9, 10, 1_000, 1.25);
      for (const baseline of [
        playing(9, 12.499_998, 3_000, 1.25),
        playing(9, 12.51, 3_000, 1.25),
      ]) {
        expect(adoptPlaybackTimelineBaseline(current, baseline)).toMatchObject({
          accepted: false,
          status: 'rejected',
          reason: 'equal-revision-conflict',
        });
      }

      expect(
        adoptPlaybackTimelineBaseline(
          playing(9, Number.MAX_VALUE, 0, Number.MAX_VALUE),
          playing(9, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE),
        ),
      ).toMatchObject({
        accepted: false,
        status: 'rejected',
        reason: 'equal-revision-conflict',
      });
    });

    it('detaches hostile descriptors and remains re-entry safe without dynamic [[Get]]', () => {
      let getCalls = 0;
      let reentered = false;
      let nestedStatus: string | null = null;
      const baselineTarget = playing(5, 4, 100);
      const hostile = new Proxy(baselineTarget, {
        get() {
          getCalls += 1;
          throw new Error('dynamic [[Get]] must not run');
        },
        getOwnPropertyDescriptor(target, property) {
          if (!reentered) {
            reentered = true;
            nestedStatus = adoptPlaybackTimelineBaseline(
              createStoppedPlaybackTimeline(),
              playing(2, 0, 0, 1, RUN_B),
            ).status;
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });

      const result = adoptPlaybackTimelineBaseline(createStoppedPlaybackTimeline(), hostile);
      expect(result).toMatchObject({ accepted: true, status: 'adopted' });
      expect(result.snapshot.run).toEqual(RUN_A);
      expect(nestedStatus).toBe('adopted');
      expect(getCalls).toBe(0);

      let accessorCalls = 0;
      const accessor = { ...playing(6, 0, 0) };
      Object.defineProperty(accessor, 'positionSeconds', {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return 0;
        },
      });
      expect(() => adoptPlaybackTimelineBaseline(result.snapshot, accessor)).toThrow(TypeError);
      expect(accessorCalls).toBe(0);
    });
  });
});
