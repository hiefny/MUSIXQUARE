import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { sameRun, type PlaybackRunIdentity } from '../playback-identity.ts';
import {
  applyPlaybackTimelineIntent,
  createStoppedPlaybackTimeline,
  derivePlaybackPosition,
  isPlaybackTimelineSnapshot,
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
});
