/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 a restore's tap of the recovery dialog while a YouTube attempt waits
 * after the room switched to a local file (Phase 7 7C-K8, the owner's decision
 * of 2026-11-07; it was Known gap C1-I6). The owner's ordinary branch carries
 * no attempt, so the tap retires none: the owner retires the YouTube attempt
 * on its identity check once the binding sees the context running, with no
 * notice or rejoin of its own. These rows pin which attempt is pending right
 * after the tap call and 7 s later, and the tap's `/debug sync` count changes
 * over those 7 s, in three orders of the tap resume's statechange that the fake
 * models: before the promise settles (its default), 1.5 s after it settles
 * with the state already running, and none. The recovery dialog test pins the
 * answer in the first order (audio-output-recovery-dialog.test.ts); the rows
 * here pin it in the other two. On the real owners over one
 * FakeNativeAudioContext with no module mocks, on the fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeNativeAudioContext,
  type FakeNativeCallPlan,
} from './__helpers__/fake-audio-context.ts';
import {
  QUEUE_B,
  bind,
  dialogSelector,
  loadOwners,
  playbackScope,
  recordBus,
  setupOwnerTest,
  stageFile,
  stageYouTube,
  teardownOwnerTest,
  type BusRecord,
  type Owners,
} from './__helpers__/audio-output-owners.ts';

type Counters = typeof import('../output-recovery-counters.ts');

interface Scene {
  readonly o: Owners;
  readonly fake: FakeNativeAudioContext;
  readonly c: Counters;
  readonly bus: BusRecord;
  /** The YouTube attempt that waits for a tap when the room switches. */
  readonly youtubeAttempt: object;
}

/**
 * A YouTube track's output is interrupted and its automatic resume refused,
 * so its attempt waits for a tap; then the room switches to a local file, and
 * the file's recovery dialog, with no file attempt pending, is the one shown.
 */
async function youtubeAttemptWaitsThenFile(): Promise<Scene> {
  const fake = new FakeNativeAudioContext();
  const o = await loadOwners(fake);
  const c = await import('../output-recovery-counters.ts');
  stageYouTube(o);
  const bus = recordBus(o);
  bind(o, fake);
  fake.planResume({ outcome: 'reject' });
  fake.transition('interrupted');
  await vi.advanceTimersByTimeAsync(1_000);
  const youtubeAttempt = playbackScope.current(o);
  expect(youtubeAttempt).not.toBeNull();
  stageFile(o, QUEUE_B);
  await vi.advanceTimersByTimeAsync(100);
  expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });
  return { o, fake, c, bus, youtubeAttempt: youtubeAttempt! };
}

/** The two millisecond slots move with the fake clock; these rows leave them out. */
const MILLISECOND_SLOTS = new Set(['CLOCK_WAIT_TOTAL_MS', 'CLOCK_WAIT_MAX_MS']);

function counts(s: Scene): readonly number[] {
  return s.c.readAudioRecoveryCounts()[0];
}

/** Every count slot that moved since `before`, by its name (the lab's countChanges). */
function countChanges(s: Scene, before: readonly number[]): Record<string, number> {
  const now = counts(s);
  const changes: Record<string, number> = {};
  for (const [name, slot] of Object.entries(s.c)) {
    if (typeof slot !== 'number' || !/^[A-Z_]+$/u.test(name)) continue;
    if (name.startsWith('AUDIO_RECOVERY_') || MILLISECOND_SLOTS.has(name)) continue;
    const delta = now[slot]! - before[slot]!;
    if (delta !== 0) changes[name] = delta;
  }
  return changes;
}

/** The dialog's side of its tap: its currency and its log of an unhealthy clock. */
function dialog() {
  const abort = new AbortController();
  const side = {
    abort,
    unhealthy: [] as string[],
    caller: {
      isCurrent: (): boolean => !abort.signal.aborted && document.visibilityState === 'visible',
      signal: abort.signal,
      unhealthy: (health: { readonly reason: string }): void => {
        side.unhealthy.push(health.reason);
      },
    },
  };
  return side;
}

/** The file's recovery dialog tapped once: a restore, through the owner's entry. */
function tapRestore(s: Scene, side: ReturnType<typeof dialog>) {
  return s.o.recovery.beginAudioOutputGestureRecovery(
    dialogSelector('restore-playing-output'),
    side.caller,
  )!;
}

/** A promise's value once it settles; 'waiting' until then. */
function settled<T>(promise: Promise<T>): { value: T | 'waiting' | 'rejected' } {
  const box: { value: T | 'waiting' | 'rejected' } = { value: 'waiting' };
  promise.then(
    (value) => {
      box.value = value;
    },
    () => {
      box.value = 'rejected';
    },
  );
  return box;
}

beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

describe("RO-01 a restore's tap while a YouTube attempt waits after the room switched to a file (Phase 7 7C-K8)", () => {
  it("the tap retires no attempt: right after it the YouTube attempt is still the pending one, the owner's identity check retires it once the context runs, and the tap counts its resume, its 1 s race and that check's one cancelled clock wait", async () => {
    const s = await youtubeAttemptWaitsThenFile();
    const side = dialog();
    const before = counts(s);
    const ops = s.fake.ops.length;

    const gesture = tapRestore(s, side);
    expect(s.fake.ops.slice(ops)).toEqual(['resume()']);
    expect(playbackScope.current(s.o)).toBe(s.youtubeAttempt);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'youtube', gesture: true });
    const finished = gesture.finish();
    await vi.advanceTimersByTimeAsync(7_000);
    await finished;

    expect(playbackScope.isCurrent(s.o, s.youtubeAttempt)).toBe(false);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'none', gesture: false });
    expect(side.unhealthy).toEqual([]);
    expect(s.bus.needed).toEqual([]);
    expect(s.bus.rejoins).toEqual([]);
    expect(countChanges(s, before)).toEqual({
      RESUME_DIALOG: 1,
      DEADLINES_WATCHED: 1,
      CLOCK_WAITS: 1,
      CLOCK_CANCELLED: 1,
    });
  });

  it.each<[string, FakeNativeCallPlan, boolean, Record<string, number>]>([
    [
      "its statechange 1.5 s after the resume settled: the answer comes first, and the owner's identity check retires the attempt once the event lands",
      { statechange: 'deferred-event', stateDelayMs: 1_500 },
      false,
      { RESUME_DIALOG: 1, DEADLINES_WATCHED: 1, CLOCK_WAITS: 1, CLOCK_CANCELLED: 1 },
    ],
    [
      'no statechange: the binding never sees the context running, so the attempt stays pending and no clock wait is counted',
      { statechange: 'silent' },
      true,
      { RESUME_DIALOG: 1, DEADLINES_WATCHED: 1 },
    ],
  ])(
    'the tap with %s; on a healthy clock it answers recovered',
    async (_label, plan, stillPending, expected) => {
      const s = await youtubeAttemptWaitsThenFile();
      s.fake.planResume(plan);
      const side = dialog();
      const before = counts(s);
      const ops = s.fake.ops.length;

      const gesture = tapRestore(s, side);
      expect(s.fake.ops.slice(ops)).toEqual(['resume()']);
      expect(playbackScope.current(s.o)).toBe(s.youtubeAttempt);
      const finished = settled(gesture.finish());
      await vi.advanceTimersByTimeAsync(1_000);

      expect(finished.value).toEqual({ kind: 'recovered', rejoinEmitted: false });
      expect(playbackScope.isCurrent(s.o, s.youtubeAttempt)).toBe(true);
      await vi.advanceTimersByTimeAsync(6_000);

      expect(playbackScope.isCurrent(s.o, s.youtubeAttempt)).toBe(stillPending);
      expect(playbackScope.view(s.o)).toEqual(
        stillPending ? { attempt: 'youtube', gesture: true } : { attempt: 'none', gesture: false },
      );
      expect(side.unhealthy).toEqual([]);
      expect(s.bus.needed).toEqual([]);
      expect(s.bus.rejoins).toEqual([]);
      expect(countChanges(s, before)).toEqual(expected);
    },
  );
});
