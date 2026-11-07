/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 owner rows for a local-file PLAY's foreground clock check
 * (checkForegroundClockBeforeFileStart in context-recovery.ts, Phase 7 7C-3),
 * over the real owners and one FakeNativeAudioContext with no module mocks:
 * its answer for each probe reason, the currency it reads and when, and the
 * incident it consumes or keeps. A foreground incident is armed the way the
 * page arms one: the engine's binding and a hidden -> visible return.
 * Transport's side (the notice, the retry, the `/debug sync` counts) is
 * pinned over the real transport in src/player/__tests__/
 * (output-recovery-transport-boundary, output-recovery-play-counts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_CLOCK_SAMPLE_MS, AUDIO_SUSPEND_PREPARE_DEADLINE_MS } from '../context-protocol.ts';
import { FakeNativeAudioContext } from './__helpers__/fake-audio-context.ts';
import {
  bind,
  loadOwners,
  setVisibility,
  setupOwnerTest,
  teardownOwnerTest,
  type Owners,
} from './__helpers__/audio-output-owners.ts';

beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

/** The native calls a frozen clock's restart makes to park the context. */
const ONE_SUSPEND = ['suspend()', 'statechange:suspended', 'suspend:resolved'];
const TWO_SAMPLES_MS = 2 * AUDIO_CLOCK_SAMPLE_MS;

interface Returned {
  readonly o: Owners;
  readonly fake: FakeNativeAudioContext;
}

/** Fresh owners bound to `fake`, back from the background with one foreground incident pending. */
async function returned(fake = new FakeNativeAudioContext()): Promise<Returned> {
  const o = await loadOwners(fake);
  bind(o, fake);
  setVisibility('hidden');
  await vi.advanceTimersByTimeAsync(1_000);
  setVisibility('visible');
  await vi.advanceTimersByTimeAsync(0);
  return { o, fake };
}

/** A PLAY whose currency reads are counted; `current` answers each read by its number. */
function playCaller(current: (read: number) => boolean = () => true): {
  readonly isCurrent: () => boolean;
  reads(): number;
} {
  let reads = 0;
  return {
    isCurrent: () => {
      reads += 1;
      return current(reads);
    },
    reads: () => reads,
  };
}

function track<T>(promise: Promise<T> | null): {
  readonly promise: Promise<T>;
  settled(): boolean;
} {
  if (!promise) throw new Error('no clock check started');
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { promise, settled: () => settled };
}

describe("a local-file PLAY's foreground clock check (owner rows, real owners)", () => {
  it('answers null at once, reading nothing, when no foreground incident is pending', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    bind(o, fake);
    const play = playCaller();

    expect(o.recovery.checkForegroundClockBeforeFileStart(play)).toBeNull();
    expect(play.reads()).toBe(0);
    expect(fake.ops).toEqual([]);
  });

  it('proceeds on a healthy clock after one sample and consumes the incident', async () => {
    const { o, fake } = await returned();
    const before = fake.ops.length;
    const play = playCaller();

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(play));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS - 1);
    expect(answer.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer.promise).resolves.toEqual({ kind: 'proceed' });
    // The probe's three reads (its start, the sample's start and end), then one after it.
    expect(play.reads()).toBe(4);
    // Consumed: the next check answers null at once.
    expect(o.recovery.checkForegroundClockBeforeFileStart(playCaller())).toBeNull();
    expect(fake.ops.slice(before)).toEqual([]);
  });

  it('answers clock-stalled with the restart parked inside its window for a frozen clock', async () => {
    const { o, fake } = await returned();
    fake.freezeClock();
    const before = fake.ops.length;
    const play = playCaller();

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(play));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS - 1);
    expect(answer.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const verdict = await answer.promise;
    expect(verdict).toEqual({
      kind: 'clock-stalled',
      preparation: {
        status: 'prepared',
        attemptToken: expect.any(Object),
        whenPrepared: expect.any(Promise),
        isCurrent: expect.any(Function),
      },
    });
    if (verdict.kind !== 'clock-stalled') throw new Error('no preparation');
    expect(verdict.preparation.isCurrent()).toBe(true);
    await expect(verdict.preparation.whenPrepared).resolves.toBe(true);
    expect(fake.ops.slice(before)).toEqual(ONE_SUSPEND);
  });

  it('answers clock-stalled with the restart still preparing when its window ends first', async () => {
    const { o, fake } = await returned();
    fake.freezeClock();
    fake.planSuspend({ latencyMs: AUDIO_SUSPEND_PREPARE_DEADLINE_MS + 100 });
    const before = fake.ops.length;

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(playCaller()));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS + AUDIO_SUSPEND_PREPARE_DEADLINE_MS - 1);
    expect(answer.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const verdict = await answer.promise;
    expect(verdict).toMatchObject({ kind: 'clock-stalled', preparation: { status: 'preparing' } });
    if (verdict.kind !== 'clock-stalled') throw new Error('no preparation');
    const parked = track(verdict.preparation.whenPrepared);
    await vi.advanceTimersByTimeAsync(99);
    expect(parked.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(parked.promise).resolves.toBe(true);
    expect(fake.ops.slice(before)).toEqual(ONE_SUSPEND);
  });

  it('stops with no restart when the restart answers with no preparation', async () => {
    const { o, fake } = await returned();
    fake.freezeClock();
    fake.planSuspend({ latencyMs: 300 });

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(playCaller()));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS + 100);
    expect(answer.settled()).toBe(false);
    // The context closes inside the restart's window: no attempt is left.
    await fake.close();
    await vi.advanceTimersByTimeAsync(AUDIO_SUSPEND_PREPARE_DEADLINE_MS);
    await expect(answer.promise).resolves.toEqual({ kind: 'abort' });
  });

  it('answers context-not-running when the context stops during the sample', async () => {
    const { o, fake } = await returned();
    const before = fake.ops.length;

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(playCaller()));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    fake.transition('suspended', { statechange: false });
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    await expect(answer.promise).resolves.toEqual({ kind: 'context-not-running' });
    expect(fake.ops.slice(before)).toEqual(['os:suspended', 'state:suspended']);
  });

  it('proceeds on an inconclusive sample and keeps the incident for a later check', async () => {
    const { o, fake } = await returned();
    const before = fake.ops.length;

    // An early timer: the sample's timeout fires while the wall clock has not
    // moved, which proves nothing about the native clock.
    const wall = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    const first = track(o.recovery.checkForegroundClockBeforeFileStart(playCaller()));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS);
    await expect(first.promise).resolves.toEqual({ kind: 'proceed' });
    wall.mockRestore();

    // Kept: the next check samples the same incident, then consumes it.
    const second = track(o.recovery.checkForegroundClockBeforeFileStart(playCaller()));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS);
    await expect(second.promise).resolves.toEqual({ kind: 'proceed' });
    expect(o.recovery.checkForegroundClockBeforeFileStart(playCaller())).toBeNull();
    expect(fake.ops.slice(before)).toEqual([]);
  });

  it('stops at once when the page is hidden as the check starts', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    bind(o, fake);
    // The hidden edge arms the incident; the check runs while the page stays hidden.
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(1_000);

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(playCaller()));
    await vi.advanceTimersByTimeAsync(0);
    expect(answer.settled()).toBe(true);
    await expect(answer.promise).resolves.toEqual({ kind: 'abort' });
    expect(fake.ops).toEqual([]);
  });

  it('stops when a newer incident replaces the one it samples', async () => {
    const { o, fake } = await returned();
    const before = fake.ops.length;

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(playCaller()));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS);
    await expect(answer.promise).resolves.toEqual({ kind: 'abort' });
    expect(fake.ops.slice(before)).toEqual([]);
  });
});

describe("the currency a local-file PLAY's clock check reads (owner rows, real owners)", () => {
  it("reads the incident's currency before the caller's: none of the caller's once the incident is replaced", async () => {
    const { o } = await returned();
    const play = playCaller();

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(play));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS / 2);
    // The probe's first two reads, while the incident is current.
    expect(play.reads()).toBe(2);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS);
    await expect(answer.promise).resolves.toEqual({ kind: 'abort' });
    expect(play.reads()).toBe(2);
  });

  it("reads the caller's currency once more after the probe, and stops with the incident kept when it went stale", async () => {
    const { o } = await returned();
    // Current through the probe's three reads, stale from the next one.
    const play = playCaller((read) => read <= 3);

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(play));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS);
    await expect(answer.promise).resolves.toEqual({ kind: 'abort' });
    expect(play.reads()).toBe(4);
    // Not consumed: the next check samples the incident again.
    const next = track(o.recovery.checkForegroundClockBeforeFileStart(playCaller()));
    await vi.advanceTimersByTimeAsync(AUDIO_CLOCK_SAMPLE_MS);
    await expect(next.promise).resolves.toEqual({ kind: 'proceed' });
  });

  it('reads nothing once the restart is prepared: its preparation is the answer', async () => {
    const { o, fake } = await returned();
    fake.freezeClock();
    fake.planSuspend({ latencyMs: 100 });
    const play = playCaller();

    const answer = track(o.recovery.checkForegroundClockBeforeFileStart(play));
    await vi.advanceTimersByTimeAsync(TWO_SAMPLES_MS);
    // The probe's five reads (its start, each sample's start and end), then one after it.
    expect(play.reads()).toBe(6);
    expect(answer.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await expect(answer.promise).resolves.toMatchObject({
      kind: 'clock-stalled',
      preparation: { status: 'prepared' },
    });
    expect(play.reads()).toBe(6);
  });
});
