import { describe, expect, it, vi } from 'vitest';
import { PersistedResourceLane } from '../persisted-resource-lane.ts';
import runtimeSource from '../runtime.ts?raw';

interface TestSnapshot {
  readonly roomCode: string;
  readonly id: string;
  readonly head: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function snapshot(id: string, head: number, roomCode = 'ROOM-A'): TestSnapshot {
  return { roomCode, id, head };
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function newerByHead(current: TestSnapshot, candidate: TestSnapshot): TestSnapshot {
  if (candidate.roomCode !== current.roomCode) return candidate;
  return candidate.head > current.head ? candidate : current;
}

function createLane(
  options: {
    refreshStillRequired?: (snapshot: TestSnapshot) => boolean;
    newerRefreshSnapshot?: (current: TestSnapshot, candidate: TestSnapshot) => TestSnapshot;
  } = {},
) {
  let generation = 0;
  const refreshStillRequired = vi.fn(options.refreshStillRequired ?? (() => true));
  const newerRefreshSnapshot = vi.fn(options.newerRefreshSnapshot ?? newerByHead);
  const lane = new PersistedResourceLane<TestSnapshot>({
    runtimeGeneration: () => generation,
    refreshStillRequired,
    newerRefreshSnapshot,
  });
  return {
    lane,
    refreshStillRequired,
    newerRefreshSnapshot,
    /** Advances the runtime generation without detaching the lane. */
    bumpGeneration: () => {
      generation += 1;
    },
    /** Mirrors resetPlaylistRuntime: a new generation plus a detached lane. */
    resetRuntime: () => {
      generation += 1;
      lane.reset();
    },
  };
}

/** A runUnlocked stand-in whose passes settle only when the test says so. */
function controlledRefresh(log: string[], tag: string) {
  const passes: Deferred<boolean>[] = [];
  const run = vi.fn((target: TestSnapshot) => {
    log.push(`${tag}:${target.id}`);
    const pass = deferred<boolean>();
    passes.push(pass);
    return pass.promise;
  });
  return { run, passes };
}

describe('PersistedResourceLane serial lock', () => {
  it('runs lock operations one at a time in call order', async () => {
    const { lane } = createLane();
    const log: string[] = [];
    const first = deferred<string>();
    const a = lane.enqueue(() => {
      log.push('a');
      return first.promise;
    });
    const b = lane.enqueue(async () => {
      log.push('b');
      return 'b';
    });
    const c = lane.enqueue(async () => {
      log.push('c');
      return 'c';
    });

    await flushMicrotasks();
    expect(log).toEqual(['a']);
    first.resolve('a');
    await expect(Promise.all([a, b, c])).resolves.toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('propagates a rejection to its caller and still runs the next operation', async () => {
    const { lane } = createLane();
    const failure = new Error('lock holder failed');
    const failed = lane.enqueue(() => Promise.reject(failure));
    const next = lane.enqueue(async () => 'next');

    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBe('next');
  });

  it('detaches from a tail that never settles after reset()', async () => {
    const { lane } = createLane();
    const stuck = lane.enqueue(() => new Promise<void>(() => undefined));
    const blocked = vi.fn(async () => 'blocked');
    const blockedResult = lane.enqueue(blocked);

    lane.reset();
    await expect(lane.enqueue(async () => 'fresh')).resolves.toBe('fresh');
    expect(blocked).not.toHaveBeenCalled();
    // The detached operations stay queued behind the old holder.
    const detached = Promise.all([stuck, blockedResult]).then(() => 'settled');
    await expect(Promise.race([detached, flushMicrotasks().then(() => 'pending')])).resolves.toBe(
      'pending',
    );
  });
});

describe('PersistedResourceLane refresh flight', () => {
  it('hands joiners the identical flight promise and runs only the creator closure', async () => {
    const fixture = createLane();
    const log: string[] = [];
    const creator = controlledRefresh(log, 'creator');
    const joiner = controlledRefresh(log, 'joiner');
    const first = snapshot('s1', 1);
    const newest = snapshot('s3', 3);
    const older = snapshot('s2', 2);

    const flight = fixture.lane.refresh(first, creator.run);
    expect(fixture.lane.refresh(newest, joiner.run)).toBe(flight);
    // The first pending snapshot is stored as-is; later ones fold through
    // newerRefreshSnapshot(pending, candidate).
    expect(fixture.newerRefreshSnapshot).not.toHaveBeenCalled();
    expect(fixture.lane.refresh(older, joiner.run)).toBe(flight);
    expect(fixture.newerRefreshSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.newerRefreshSnapshot).toHaveBeenLastCalledWith(newest, older);

    await flushMicrotasks();
    expect(log).toEqual(['creator:s1']);
    creator.passes[0]!.resolve(false);
    await flushMicrotasks();

    // The coalesced pass targets newer(previous target, folded pending).
    expect(fixture.refreshStillRequired).toHaveBeenCalledWith(newest);
    expect(fixture.newerRefreshSnapshot).toHaveBeenLastCalledWith(first, newest);
    expect(log).toEqual(['creator:s1', 'creator:s3']);
    creator.passes[1]!.resolve(true);
    await expect(flight).resolves.toBe(true);
    expect(joiner.run).not.toHaveBeenCalled();
  });

  it('skips the coalesced pass when the pending snapshot no longer requires a refresh', async () => {
    let required = true;
    const fixture = createLane({ refreshStillRequired: () => required });
    const log: string[] = [];
    const creator = controlledRefresh(log, 'creator');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);

    await flushMicrotasks();
    required = false;
    creator.passes[0]!.resolve(true);
    await expect(flight).resolves.toBe(true);
    expect(log).toEqual(['creator:s1']);
    // The settled flight released its slot.
    expect(fixture.lane.refresh(snapshot('s3', 3), creator.run)).not.toBe(flight);
  });

  it('never starts a pass for a folded snapshot from another room', async () => {
    const foreign = snapshot('foreign', 9, 'ROOM-B');
    const fixture = createLane({ newerRefreshSnapshot: () => foreign });
    const log: string[] = [];
    const creator = controlledRefresh(log, 'creator');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);
    expect(fixture.lane.refresh(snapshot('s3', 3), creator.run)).toBe(flight);

    await flushMicrotasks();
    creator.passes[0]!.resolve(false);
    await expect(flight).resolves.toBe(false);
    expect(log).toEqual(['creator:s1']);
    expect(fixture.refreshStillRequired).not.toHaveBeenCalled();
  });

  it('runs a second pass after a failure when a required snapshot is pending', async () => {
    const fixture = createLane();
    const log: string[] = [];
    const creator = controlledRefresh(log, 'creator');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);

    await flushMicrotasks();
    creator.passes[0]!.reject(new Error('transient read failure'));
    await flushMicrotasks();
    expect(log).toEqual(['creator:s1', 'creator:s2']);
    creator.passes[1]!.resolve(false);
    await expect(flight).resolves.toBe(false);
  });

  it('rejects with the failure when nothing is pending', async () => {
    const fixture = createLane();
    const creator = controlledRefresh([], 'creator');
    const failure = new Error('read failed');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);

    await flushMicrotasks();
    creator.passes[0]!.reject(failure);
    await expect(flight).rejects.toBe(failure);
    expect(fixture.refreshStillRequired).not.toHaveBeenCalled();
  });

  it('rejects with the failure when the pending snapshot is no longer required', async () => {
    const fixture = createLane({ refreshStillRequired: () => false });
    const creator = controlledRefresh([], 'creator');
    const failure = new Error('read failed');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);

    await flushMicrotasks();
    creator.passes[0]!.reject(failure);
    await expect(flight).rejects.toBe(failure);
    expect(creator.run).toHaveBeenCalledTimes(1);
  });

  it('rejects with the last pass failure when the coalesced pass also fails', async () => {
    const fixture = createLane();
    const creator = controlledRefresh([], 'creator');
    const lastFailure = new Error('second read failed');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);

    await flushMicrotasks();
    creator.passes[0]!.reject(new Error('first read failed'));
    await flushMicrotasks();
    creator.passes[1]!.reject(lastFailure);
    await expect(flight).rejects.toBe(lastFailure);
  });

  it.each([
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ])(
    'accumulates applied results across passes (%s then %s resolves %s)',
    async (firstApplied, secondApplied, expected) => {
      const fixture = createLane();
      const creator = controlledRefresh([], 'creator');
      const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
      expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);

      await flushMicrotasks();
      creator.passes[0]!.resolve(firstApplied);
      await flushMicrotasks();
      creator.passes[1]!.resolve(secondApplied);
      await expect(flight).resolves.toBe(expected);
    },
  );

  it('does not rerun after a generation change mid-pass and keeps the pass result', async () => {
    const fixture = createLane();
    const creator = controlledRefresh([], 'creator');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);

    await flushMicrotasks();
    fixture.bumpGeneration();
    creator.passes[0]!.resolve(true);
    await expect(flight).resolves.toBe(true);
    expect(creator.run).toHaveBeenCalledTimes(1);
    expect(fixture.refreshStillRequired).not.toHaveBeenCalled();
  });

  it('does not rerun after a generation change mid-pass and keeps the pass failure', async () => {
    const fixture = createLane();
    const creator = controlledRefresh([], 'creator');
    const failure = new Error('stale read failed');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);

    await flushMicrotasks();
    fixture.bumpGeneration();
    creator.passes[0]!.reject(failure);
    await expect(flight).rejects.toBe(failure);
    expect(creator.run).toHaveBeenCalledTimes(1);
  });

  it('skips runUnlocked and resolves false when the generation changes before the lock is acquired', async () => {
    const fixture = createLane();
    const holder = deferred<void>();
    const held = fixture.lane.enqueue(() => holder.promise);
    const creator = controlledRefresh([], 'creator');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);

    fixture.bumpGeneration();
    holder.resolve();
    await held;
    await expect(flight).resolves.toBe(false);
    expect(creator.run).not.toHaveBeenCalled();
  });

  it('starts a new flight for another room and keeps it when the old flight settles', async () => {
    const fixture = createLane();
    const log: string[] = [];
    const roomA = controlledRefresh(log, 'a');
    const roomB = controlledRefresh(log, 'b');
    const joiner = controlledRefresh(log, 'joiner');
    const flightA = fixture.lane.refresh(snapshot('a1', 1, 'ROOM-A'), roomA.run);
    const flightB = fixture.lane.refresh(snapshot('b1', 1, 'ROOM-B'), roomB.run);
    expect(flightB).not.toBe(flightA);

    await flushMicrotasks();
    roomA.passes[0]!.resolve(true);
    await expect(flightA).resolves.toBe(true);
    // Flight A's finally must not clear flight B's slot.
    expect(fixture.lane.refresh(snapshot('b2', 2, 'ROOM-B'), joiner.run)).toBe(flightB);

    await flushMicrotasks();
    roomB.passes[0]!.resolve(false);
    await flushMicrotasks();
    roomB.passes[1]!.resolve(true);
    await expect(flightB).resolves.toBe(true);
    expect(log).toEqual(['a:a1', 'b:b1', 'b:b2']);
  });

  it('starts a new flight for a new generation and keeps it when the old flight settles', async () => {
    const fixture = createLane();
    const log: string[] = [];
    const stale = controlledRefresh(log, 'stale');
    const current = controlledRefresh(log, 'current');
    const joiner = controlledRefresh(log, 'joiner');
    const staleFlight = fixture.lane.refresh(snapshot('s1', 1), stale.run);
    fixture.bumpGeneration();
    const currentFlight = fixture.lane.refresh(snapshot('s2', 2), current.run);
    expect(currentFlight).not.toBe(staleFlight);

    // The stale pass reaches the lock first and is skipped.
    await expect(staleFlight).resolves.toBe(false);
    expect(fixture.lane.refresh(snapshot('s3', 3), joiner.run)).toBe(currentFlight);

    await flushMicrotasks();
    current.passes[0]!.resolve(false);
    await flushMicrotasks();
    current.passes[1]!.resolve(false);
    await expect(currentFlight).resolves.toBe(false);
    expect(log).toEqual(['current:s2', 'current:s3']);
  });

  it('starts a fresh flight after reset() without waiting for the detached pass', async () => {
    const fixture = createLane();
    const log: string[] = [];
    const detached = controlledRefresh(log, 'detached');
    const fresh = controlledRefresh(log, 'fresh');
    const detachedFlight = fixture.lane.refresh(snapshot('s1', 1), detached.run);
    await flushMicrotasks();
    expect(fixture.lane.refresh(snapshot('s2', 2), detached.run)).toBe(detachedFlight);

    fixture.resetRuntime();
    const freshFlight = fixture.lane.refresh(snapshot('s3', 3), fresh.run);
    expect(freshFlight).not.toBe(detachedFlight);
    await flushMicrotasks();
    expect(log).toEqual(['detached:s1', 'fresh:s3']);

    fresh.passes[0]!.resolve(true);
    await expect(freshFlight).resolves.toBe(true);
    // The detached flight settles with its own pass and starts no successor.
    detached.passes[0]!.resolve(true);
    await expect(detachedFlight).resolves.toBe(true);
    expect(log).toEqual(['detached:s1', 'fresh:s3']);
  });
});

describe('PersistedResourceLane shared lock ordering', () => {
  it('takes the lock for the first pass synchronously, ahead of a later lock user', async () => {
    const fixture = createLane();
    const log: string[] = [];
    const creator = controlledRefresh(log, 'refresh');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    const persist = fixture.lane.enqueue(async () => {
      log.push('persist');
    });

    // Exactly one microtask: the pass was queued on the lock inside refresh().
    await Promise.resolve();
    expect(log).toEqual(['refresh:s1']);
    creator.passes[0]!.resolve(true);
    await persist;
    expect(log).toEqual(['refresh:s1', 'persist']);
    await expect(flight).resolves.toBe(true);
  });

  it('queues a coalesced pass behind lock users that arrived during the previous pass', async () => {
    const fixture = createLane();
    const log: string[] = [];
    const creator = controlledRefresh(log, 'refresh');
    const flight = fixture.lane.refresh(snapshot('s1', 1), creator.run);
    await flushMicrotasks();
    const persist = fixture.lane.enqueue(async () => {
      log.push('persist');
    });
    expect(fixture.lane.refresh(snapshot('s2', 2), creator.run)).toBe(flight);

    creator.passes[0]!.resolve(false);
    await persist;
    await flushMicrotasks();
    expect(log).toEqual(['refresh:s1', 'persist', 'refresh:s2']);
    creator.passes[1]!.resolve(true);
    await expect(flight).resolves.toBe(true);
  });
});

function xorshift32(seed: number): (bound: number) => number {
  let state = seed >>> 0 || 1;
  return (bound) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % bound;
  };
}

interface PropertyStats {
  joins: number;
  coalescedPasses: number;
  lockOperations: number;
}

/**
 * One random interleaving of refresh, lock users, settlements, predicate
 * toggles, generation bumps and runtime resets, stepped by 0-4 microtasks.
 */
async function runInterleaving(random: (bound: number) => number, stats: PropertyStats) {
  let generation = 0;
  let required = true;
  let lockEpoch = 0;
  let nextId = 0;
  const running = new Map<number, number>();
  const unsettledPasses: Deferred<boolean>[] = [];
  const returned = new Set<Promise<unknown>>();
  const settled = new Set<Promise<unknown>>();
  const flights = new Set<Promise<boolean>>();
  const joinerTags = new Set<string>();
  const passesByTag = new Map<string, number>();
  const violations: string[] = [];
  const lane = new PersistedResourceLane<TestSnapshot>({
    runtimeGeneration: () => generation,
    refreshStillRequired: () => required,
    newerRefreshSnapshot: newerByHead,
  });

  const track = (promise: Promise<unknown>) => {
    returned.add(promise);
    promise.then(
      () => settled.add(promise),
      () => settled.add(promise),
    );
  };
  // Holds the lock until the interleaving settles it. Lock users are counted
  // per lane epoch: reset() deliberately detaches from the previous tail.
  const hold = (epoch: number, label: string): Promise<boolean> => {
    const count = (running.get(epoch) ?? 0) + 1;
    if (count > 1) violations.push(`${label} overlapped another lock user in epoch ${epoch}`);
    running.set(epoch, count);
    const pass = deferred<boolean>();
    unsettledPasses.push(pass);
    return pass.promise.finally(() => {
      running.set(epoch, (running.get(epoch) ?? 1) - 1);
    });
  };

  for (let step = 0; step < 24; step += 1) {
    const action = random(10);
    if (action <= 3) {
      nextId += 1;
      const tag = `r${nextId}`;
      const target = snapshot(tag, random(4), random(4) === 0 ? 'ROOM-B' : 'ROOM-A');
      const callGeneration = generation;
      const run = (passTarget: TestSnapshot) => {
        if (joinerTags.has(tag)) violations.push(`joiner ${tag} closure ran`);
        if (generation !== callGeneration) violations.push(`${tag} ran after its generation`);
        if (passTarget.roomCode !== target.roomCode) violations.push(`${tag} crossed rooms`);
        const passes = (passesByTag.get(tag) ?? 0) + 1;
        passesByTag.set(tag, passes);
        if (passes > 1) stats.coalescedPasses += 1;
        return hold(lockEpoch, `refresh ${tag}`);
      };
      const promise = lane.refresh(target, run);
      if (flights.has(promise)) {
        joinerTags.add(tag);
        stats.joins += 1;
      } else {
        flights.add(promise);
      }
      track(promise);
    } else if (action <= 5) {
      const epoch = lockEpoch;
      stats.lockOperations += 1;
      track(lane.enqueue(() => hold(epoch, `lock user ${step}`)));
    } else if (action <= 7) {
      const pass = unsettledPasses.splice(random(Math.max(1, unsettledPasses.length)), 1)[0];
      const outcome = random(3);
      if (outcome === 0) pass?.resolve(true);
      else if (outcome === 1) pass?.resolve(false);
      else pass?.reject(new Error(`pass failure ${step}`));
    } else if (action === 8) {
      required = !required;
    } else if (random(2) === 0) {
      generation += 1;
    } else {
      generation += 1;
      lockEpoch += 1;
      lane.reset();
    }
    await flushMicrotasks(random(5));
  }

  // Drain: settle every lock holder (including coalesced passes it unblocks)
  // until the lane stays idle for several rounds.
  let idleRounds = 0;
  for (let round = 0; round < 500 && idleRounds < 3; round += 1) {
    const pass = unsettledPasses.shift();
    if (pass) {
      idleRounds = 0;
      pass.resolve(round % 2 === 0);
    } else {
      idleRounds += 1;
    }
    await flushMicrotasks(20);
  }

  const unsettled = [...returned].filter((promise) => !settled.has(promise)).length;
  return { violations, unsettled };
}

describe('PersistedResourceLane seeded interleavings', () => {
  it('keeps the lock exclusive, settles every caller, and runs only current creator closures', async () => {
    const stats: PropertyStats = { joins: 0, coalescedPasses: 0, lockOperations: 0 };
    for (const seed of [0x9e3779b9, 0x2545f491, 0x5bd1e995]) {
      const random = xorshift32(seed);
      for (let scenario = 0; scenario < 150; scenario += 1) {
        const result = await runInterleaving(random, stats);
        expect(result.violations, `seed ${seed} scenario ${scenario}`).toEqual([]);
        expect(result.unsettled, `seed ${seed} scenario ${scenario}`).toBe(0);
      }
    }
    // Guard against a vacuous property: the interleavings must reach joins,
    // coalesced passes and lock users sharing the refresh lock.
    expect(stats.joins).toBeGreaterThan(0);
    expect(stats.coalescedPasses).toBeGreaterThan(0);
    expect(stats.lockOperations).toBeGreaterThan(0);
  });
});

describe('PRO runtime persisted-resource lane wiring', () => {
  it('keeps both refresh wrappers async, captures the effects notification generation at call time, and wires each lane to its own predicates', () => {
    // The async wrappers adopt the flight promise, which fixes when each
    // caller observes settlement relative to other lock users.
    expect(runtimeSource).toContain(
      'async function refreshPersistedEffects(snapshot: ProRoomSnapshot): Promise<boolean> {',
    );
    expect(runtimeSource).toContain('async function refreshPersistedQueueMode(');
    // The effects wrapper captures the notification generation when it is
    // called; every pass of the flight it creates uses that value. A read at
    // pass time would let a refresh started before a control-channel recovery
    // or a settings-sync toggle toast (see runtime-server-playback.test.ts,
    // "keeps a coalesced pass ... on its creator notification generation").
    expect(runtimeSource).toMatch(
      /async function refreshPersistedEffects\(snapshot: ProRoomSnapshot\): Promise<boolean> \{[^}]*?const notificationGeneration = effectsNotificationGeneration;\s*return effectsLane\.refresh\(snapshot, \(target\) =>\s*refreshPersistedEffectsUnlocked\(target, notificationGeneration\),\s*\);\s*\}/,
    );
    expect(runtimeSource).toMatch(
      /const effectsLane = new PersistedResourceLane<ProRoomSnapshot>\(\{\s*runtimeGeneration: \(\) => playlistRuntimeGeneration,\s*refreshStillRequired: effectsRefreshStillRequired,\s*newerRefreshSnapshot: newerEffectsRefreshSnapshot,\s*\}\);/,
    );
    expect(runtimeSource).toMatch(
      /const queueModeLane = new PersistedResourceLane<ProRoomSnapshot>\(\{\s*runtimeGeneration: \(\) => playlistRuntimeGeneration,\s*refreshStillRequired: queueModeRefreshStillRequired,\s*newerRefreshSnapshot: newerQueueModeRefreshSnapshot,\s*\}\);/,
    );
  });
});
