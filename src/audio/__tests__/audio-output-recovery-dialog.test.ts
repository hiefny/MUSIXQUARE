/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 the recovery dialog's tap through the owner's one entry (Phase 7
 * 7C-2). app.ts calls beginAudioOutputGestureRecovery inside the button's
 * activation: the owner picks the branch and issues its resume there, and
 * `finish` is the rest once the dialog has closed (the 1 s wait for that
 * resume, the play-request clock requirement, the clock check, the commit or
 * a prepared restart). app.ts itself (its slot, its follow-up queue, the
 * failed PLAY's retry and its own rejoin) is not loaded; these rows pin what
 * the owner does and answers for each branch, on the real owners over one
 * FakeNativeAudioContext with no module mocks, on the fake clock. Their
 * `/debug sync` count changes are those the browser lab reads around the
 * same taps (e2e/audio-lab/output-recovery-counts.lab.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNativeAudioContext } from './__helpers__/fake-audio-context.ts';
import {
  QUEUE_B,
  bind,
  dialogSelector,
  dialogTakesPlayRequest,
  foregroundIncident,
  loadOwners,
  playRequest,
  playbackScope,
  recordBus,
  setVisibility,
  setupOwnerTest,
  stageFile,
  stageYouTube,
  teardownOwnerTest,
  type DialogSelector,
  type Owners,
} from './__helpers__/audio-output-owners.ts';

type Counters = typeof import('../output-recovery-counters.ts');

interface Scene {
  readonly o: Owners;
  readonly fake: FakeNativeAudioContext;
  readonly c: Counters;
}

/** Fresh owners over a running context, a local file playing with its binding, and the counts. */
async function scene(): Promise<Scene> {
  const fake = new FakeNativeAudioContext();
  const o = await loadOwners(fake);
  stageFile(o);
  bind(o, fake);
  const c = await import('../output-recovery-counters.ts');
  return { o, fake, c };
}

function counts(s: Scene): readonly number[] {
  return s.c.readAudioRecoveryCounts()[0];
}

/** The two millisecond slots move with the fake clock; rows read only whether they moved. */
const MILLISECOND_SLOTS = new Set(['CLOCK_WAIT_TOTAL_MS', 'CLOCK_WAIT_MAX_MS']);

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

/** The dialog's side of its tap: its currency (an abort or a hidden page ends it) and its log. */
function dialog() {
  const abort = new AbortController();
  const side = {
    abort,
    current: true,
    /** The probe answers the dialog logged as unhealthy. */
    unhealthy: [] as string[],
    caller: {
      isCurrent: (): boolean =>
        side.current && !abort.signal.aborted && document.visibilityState === 'visible',
      signal: abort.signal,
      unhealthy: (health: { readonly reason: string }): void => {
        side.unhealthy.push(health.reason);
      },
    },
  };
  return side;
}

function tap(s: Scene, selector: DialogSelector, side = dialog()) {
  return s.o.recovery.beginAudioOutputGestureRecovery(selector, side.caller);
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

describe("RO-01 the recovery dialog's tap: the owner picks the branch and resumes inside it (Phase 7 7C-2)", () => {
  // An owner's resume starts its 750 ms race in the tap; the dialog's own
  // resume has none, and the dialog's 1 s wait starts only once it closed.
  it.each<[string, Record<string, number>, (s: Scene) => Promise<DialogSelector>]>([
    [
      "a failed PLAY's notice with its play-request restart",
      { RESUME_PLAY_REQUEST: 1, DEADLINES_WATCHED: 1 },
      async (s) => {
        const restart = playRequest.arm(s.o, s.fake);
        await expect(restart.first).resolves.toBe('prepared');
        return dialogSelector('retry-failed-play', restart);
      },
    ],
    [
      'a return notice while a stalled file attempt waits for its tap',
      { RESUME_PLAY_GESTURE: 1, DEADLINES_WATCHED: 1 },
      async (s) => {
        await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
        return dialogSelector('restore-playing-output');
      },
    ],
    [
      'a return notice with no owner attempt',
      { RESUME_DIALOG: 1 },
      async () => dialogSelector('restore-playing-output'),
    ],
    [
      "a failed PLAY's notice with no restart",
      { RESUME_DIALOG: 1 },
      async () => dialogSelector('retry-failed-play'),
    ],
  ])("%s: the op log right after the call is ['resume()']", async (_label, changes, arrange) => {
    const s = await scene();
    const selector = await arrange(s);
    const before = counts(s);
    const ops = s.fake.ops.length;

    const gesture = tap(s, selector);

    expect(s.fake.ops.slice(ops)).toEqual(['resume()']);
    expect(countChanges(s, before)).toEqual(changes);
    expect(gesture).not.toBeNull();
  });

  it.each<[string, Record<string, number>, (s: Scene) => Promise<DialogSelector>]>([
    [
      'the play-request restart: no requirement wait, and the attempt is left to the close',
      { RESUME_PLAY_REQUEST: 1, DEADLINES_WATCHED: 2, CLOCK_WAITS: 1 },
      async (s) => {
        const restart = playRequest.arm(s.o, s.fake);
        await expect(restart.first).resolves.toBe('prepared');
        return dialogSelector('retry-failed-play', restart);
      },
    ],
    [
      "the playback scope's attempt: no second step",
      { RESUME_PLAY_GESTURE: 1, DEADLINES_WATCHED: 2, CLOCK_WAITS: 1 },
      async (s) => {
        await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
        return dialogSelector('restore-playing-output');
      },
    ],
    [
      'the ordinary branch: no clock check',
      { RESUME_DIALOG: 1, DEADLINES_WATCHED: 1 },
      async () => dialogSelector('restore-playing-output'),
    ],
  ])(
    'a dialog that stops acting during its 1 s wait: the owner reads that once the wait ends and stops, %s',
    async (_label, changes, arrange) => {
      const s = await scene();
      const selector = await arrange(s);
      s.fake.planResume({ latencyMs: 300 });
      const incident = foregroundIncident(s.o);
      const bus = recordBus(s.o);
      const side = dialog();
      const before = counts(s);

      const outcome = settled(tap(s, selector, side)!.finish());
      await vi.advanceTimersByTimeAsync(100);
      side.current = false;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(outcome.value).toEqual({ kind: 'stopped' });
      expect(side.unhealthy).toEqual([]);
      expect(bus.rejoins).toEqual([]);
      // Nothing retired the play-request attempt or armed another check.
      expect(foregroundIncident(s.o)).toBe(incident);
      expect(countChanges(s, before)).toEqual(changes);
    },
  );

  it('a return notice while the stalled file attempt still prepares its suspend: no resume, no wait, no count', async () => {
    const s = await scene();
    s.fake.planSuspend({ outcome: 'never' });
    void playbackScope.armStalled(s.o, s.fake).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'file', gesture: false });
    const before = counts(s);
    const ops = s.fake.ops.length;

    expect(tap(s, dialogSelector('restore-playing-output'))).toBeNull();
    expect(s.fake.ops.slice(ops)).toEqual([]);
    expect(countChanges(s, before)).toEqual({});
  });
});

describe('RO-01 the play-request branch after the dialog closed (Phase 7 7C-2)', () => {
  it("a healthy clock: the owner commits once; the counts are the lab's play-request tap", async () => {
    const s = await scene();
    const restart = playRequest.arm(s.o, s.fake);
    await expect(restart.first).resolves.toBe('prepared');
    const side = dialog();
    const before = counts(s);

    const finished = tap(s, dialogSelector('retry-failed-play', restart), side)!.finish();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(finished).resolves.toEqual({ kind: 'recovered', rejoinEmitted: false });
    expect(side.unhealthy).toEqual([]);
    // Committed: the attempt and its foreground incident are gone.
    expect(restart.isCurrent()).toBe(false);
    expect(foregroundIncident(s.o)).toBeNull();
    // The owner's resume and its 750 ms race, the dialog's 1 s race over that
    // flight and its 5 s race for the clock requirement; the probe resumes
    // nothing, and the commit ends the one clock wait.
    expect(countChanges(s, before)).toEqual({
      RESUME_PLAY_REQUEST: 1,
      DEADLINES_WATCHED: 3,
      CLOCK_WAITS: 1,
      CLOCK_CONFIRMED: 1,
    });
    expect(counts(s)[s.c.CLOCK_WAIT_TOTAL_MS]).toBeGreaterThan(before[s.c.CLOCK_WAIT_TOTAL_MS]!);
  });

  it.each([true, false])(
    "a healthy clock with the caller's confirm answering %s: called once for the attempt, and no currency read after it",
    async (answer) => {
      const s = await scene();
      const restart = playRequest.arm(s.o, s.fake);
      await expect(restart.first).resolves.toBe('prepared');
      const selector = dialogSelector('retry-failed-play', restart);
      const reads: string[] = [];
      const side = dialog();
      const isCurrent = side.caller.isCurrent;
      const confirm = vi.fn((attemptToken: object): boolean => {
        reads.push('confirm');
        expect(attemptToken).toBe(selector.foregroundRestartAttemptToken);
        return answer;
      });
      const finished = s.o.recovery
        .beginAudioOutputGestureRecovery(selector, {
          ...side.caller,
          isCurrent: () => {
            reads.push('current');
            return isCurrent();
          },
          confirm,
        })!
        .finish();
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(finished).resolves.toEqual(
        answer ? { kind: 'recovered', rejoinEmitted: false } : { kind: 'stopped' },
      );
      expect(confirm).toHaveBeenCalledOnce();
      expect(reads.at(-1)).toBe('confirm');
      expect(reads).toContain('current');
    },
  );

  it("no clock requirement within 5 s (the tap's resume never lands): the attempt retires at the limit, and the next PLAY's clock check is armed", async () => {
    const s = await scene();
    const restart = playRequest.arm(s.o, s.fake);
    await expect(restart.first).resolves.toBe('prepared');
    s.fake.planResume({ outcome: 'never' });
    const before = counts(s);

    const outcome = settled(tap(s, dialogSelector('retry-failed-play', restart))!.finish());
    // The owner's resume deadline answers at 750 ms; the wait's limit runs 5 s from there.
    await vi.advanceTimersByTimeAsync(5_700);
    expect(outcome.value).toBe('waiting');
    expect(restart.isCurrent()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(restart.isCurrent()).toBe(false);
    const incident = foregroundIncident(s.o);
    expect(incident).not.toBeNull();
    expect(incident).not.toBe(restart.incident);
    const changes = countChanges(s, before);
    expect(changes.DEADLINE_PLAY_REQUEST_RESUME).toBe(1);
    expect(changes.DEADLINE_CLOCK_REQUIREMENT).toBe(1);
    expect(changes.DEADLINE_GESTURE_FLOW).toBeUndefined();
  });

  it("an unhealthy clock: the dialog's log first, then the attempt retires and the next PLAY's clock check is armed", async () => {
    const s = await scene();
    const restart = playRequest.arm(s.o, s.fake);
    await expect(restart.first).resolves.toBe('prepared');
    s.fake.freezeClock();
    const side = dialog();
    const loggedWhileCurrent: boolean[] = [];
    const before = counts(s);

    const finished = s.o.recovery
      .beginAudioOutputGestureRecovery(dialogSelector('retry-failed-play', restart), {
        ...side.caller,
        unhealthy: (health) => {
          side.caller.unhealthy(health);
          loggedWhileCurrent.push(restart.isCurrent());
        },
      })!
      .finish();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(finished).resolves.toEqual({ kind: 'stopped' });
    expect(side.unhealthy).toEqual(['clock-stalled']);
    expect(loggedWhileCurrent).toEqual([true]);
    expect(restart.isCurrent()).toBe(false);
    const incident = foregroundIncident(s.o);
    expect(incident).not.toBeNull();
    expect(incident).not.toBe(restart.incident);
    expect(countChanges(s, before)).toEqual({
      RESUME_PLAY_REQUEST: 1,
      DEADLINES_WATCHED: 3,
      CLOCK_WAITS: 1,
      CLOCK_CANCELLED: 1,
    });
  });

  it.each(['abort', 'hidden'] as const)(
    "the dialog's %s ends the requirement wait at once: the attempt retires before the limit",
    async (ending) => {
      const s = await scene();
      const restart = playRequest.arm(s.o, s.fake);
      await expect(restart.first).resolves.toBe('prepared');
      s.fake.planResume({ outcome: 'never' });
      const side = dialog();
      const before = counts(s);

      const outcome = settled(tap(s, dialogSelector('retry-failed-play', restart), side)!.finish());
      await vi.advanceTimersByTimeAsync(1_500);
      expect(outcome.value).toBe('waiting');
      if (ending === 'abort') side.abort.abort();
      else setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome.value).toEqual({ kind: 'stopped' });
      expect(restart.isCurrent()).toBe(false);
      // A hidden page arms nothing; the binding's visible edge arms the next check.
      expect(foregroundIncident(s.o) === null).toBe(ending === 'hidden');
      expect(countChanges(s, before).DEADLINE_CLOCK_REQUIREMENT).toBeUndefined();
    },
  );
});

describe('RO-01 the playback-scope and ordinary branches after the dialog closed (Phase 7 7C-2)', () => {
  it("the playback scope's attempt: the second step commits once with its one rejoin; the counts are the lab's prepared tap", async () => {
    const s = await scene();
    await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
    const bus = recordBus(s.o);
    const before = counts(s);

    const finished = tap(s, dialogSelector('restore-playing-output'))!.finish();
    await vi.advanceTimersByTimeAsync(2_000);

    // The owner published the rejoin, so the dialog publishes none of its own.
    await expect(finished).resolves.toEqual({ kind: 'recovered', rejoinEmitted: true });
    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'none', gesture: false });
    expect(countChanges(s, before)).toEqual({
      RESUME_PLAY_GESTURE: 1,
      DEADLINES_WATCHED: 2,
      CLOCK_WAITS: 1,
      CLOCK_CONFIRMED: 1,
      CONTEXT_RECOVERED_REJOINS: 1,
    });
    expect(counts(s)[s.c.CLOCK_WAIT_TOTAL_MS]).toBeGreaterThan(before[s.c.CLOCK_WAIT_TOTAL_MS]!);
  });

  it.each([
    ['its running event first', {}],
    ['with no running event', { statechange: 'silent' as const }],
  ])(
    "the playback scope's attempt whose resume lands after the 750 ms deadline (%s): the dialog stops at the deadline and is not shown again; the owner verifies the late resume with its one rejoin",
    async (_label, plan) => {
      const s = await scene();
      await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
      s.fake.planResume({ latencyMs: 1_200, ...plan });
      const bus = recordBus(s.o);
      const side = dialog();
      const before = counts(s);

      const outcome = settled(tap(s, dialogSelector('restore-playing-output'), side)!.finish());
      // The owner's resume deadline answers not running at 750 ms, so the
      // dialog's 1 s wait ends there, before the resume lands at 1.2 s.
      await vi.advanceTimersByTimeAsync(800);
      expect(outcome.value).toEqual({ kind: 'stopped' });
      expect(s.fake.state).toBe('suspended');
      await vi.advanceTimersByTimeAsync(10_000);

      // Phase 7 7B-5, kept by owner decision 2026-11-05: no notice asks for
      // another tap; the owner probes its own late running state (fix lane
      // G7) and publishes the one rejoin, and the dialog logs nothing.
      expect(s.fake.state).toBe('running');
      expect(bus.needed).toEqual([]);
      expect(bus.rejoins).toEqual(['audio-context-recovered']);
      expect(side.unhealthy).toEqual([]);
      expect(playbackScope.view(s.o)).toEqual({ attempt: 'none', gesture: false });
      expect(countChanges(s, before)).toEqual({
        RESUME_PLAY_GESTURE: 1,
        DEADLINE_GESTURE_RESUME: 1,
        DEADLINES_WATCHED: 2,
        CLOCK_WAITS: 1,
        CLOCK_CONFIRMED: 1,
        CONTEXT_RECOVERED_REJOINS: 1,
      });
    },
  );

  it.each([
    ['its flight wins the 1 s wait', {}, { RESUME_DIALOG: 1, DEADLINES_WATCHED: 1 }],
    [
      'its resume held past 1 s: the deadline answers with the running state',
      { outcome: 'never' as const },
      { RESUME_DIALOG: 1, DEADLINE_GESTURE_FLOW: 1, DEADLINES_WATCHED: 1 },
    ],
  ])(
    "the ordinary branch on a healthy clock, %s; the counts are the lab's",
    async (_label, plan, expected) => {
      const s = await scene();
      s.fake.planResume(plan);
      const bus = recordBus(s.o);
      const side = dialog();
      const before = counts(s);

      const finished = tap(s, dialogSelector('restore-playing-output'), side)!.finish();
      await vi.advanceTimersByTimeAsync(2_000);

      // No owner rejoin: the dialog publishes its own ('audio-recovery-gesture').
      await expect(finished).resolves.toEqual({ kind: 'recovered', rejoinEmitted: false });
      expect(bus.rejoins).toEqual([]);
      expect(side.unhealthy).toEqual([]);
      expect(countChanges(s, before)).toEqual(expected);
    },
  );

  it("the ordinary branch on a frozen clock prepares a play-request restart, whose own tap then commits; the counts are the lab's re-queued request", async () => {
    const s = await scene();
    s.fake.freezeClock();
    const bus = recordBus(s.o);
    const side = dialog();
    const first = counts(s);

    const firstTap = tap(s, dialogSelector('restore-playing-output'), side)!.finish();
    await vi.advanceTimersByTimeAsync(2_000);

    const outcome = await firstTap;
    expect(outcome).toMatchObject({ kind: 'clock-stalled', preparation: { status: 'prepared' } });
    expect(side.unhealthy).toEqual(['clock-stalled']);
    expect(s.fake.state).toBe('suspended');
    // The dialog's resume and its 1 s race; the clock check, then the
    // restart's one suspend (its lease watchdog and 500 ms preparation races).
    expect(countChanges(s, first)).toEqual({
      RESUME_DIALOG: 1,
      DEADLINES_WATCHED: 3,
      SUSPEND_CALLS: 1,
      LEASES_AT_ONCE_MAX: 1,
    });

    // app.ts queues the same request with that restart and shows it again.
    const { attemptToken } = (outcome as { preparation: { attemptToken: object } }).preparation;
    dialogTakesPlayRequest(s.o, attemptToken);
    s.fake.runClock();
    const second = counts(s);
    const ops = s.fake.ops.length;
    const secondTap = tap(s, {
      intent: 'restore-playing-output',
      foregroundRestartAttemptToken: attemptToken,
    })!;
    expect(s.fake.ops.slice(ops)).toEqual(['resume()']);
    const finished = secondTap.finish();
    await vi.advanceTimersByTimeAsync(2_000);

    // For a restore the dialog then publishes its one rejoin.
    await expect(finished).resolves.toEqual({ kind: 'recovered', rejoinEmitted: false });
    expect(bus.rejoins).toEqual([]);
    expect(countChanges(s, second)).toEqual({
      RESUME_PLAY_REQUEST: 1,
      DEADLINES_WATCHED: 3,
      CLOCK_WAITS: 1,
      CLOCK_CONFIRMED: 1,
    });
  });

  it("a failed PLAY's retry with no restart cancels a pending playback-scope attempt inside its tap, before its resume, and carries none (RO-37)", async () => {
    const s = await scene();
    await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
    const bus = recordBus(s.o);
    const before = counts(s);
    const ops = s.fake.ops.length;

    const gesture = tap(s, dialogSelector('retry-failed-play'))!;
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'none', gesture: false });
    expect(s.fake.ops.slice(ops)).toEqual(['resume()']);
    const finished = gesture.finish();
    await vi.advanceTimersByTimeAsync(2_000);

    // The exact failed PLAY owns the continuation: no owner commit, no rejoin.
    await expect(finished).resolves.toEqual({ kind: 'recovered', rejoinEmitted: false });
    expect(bus.rejoins).toEqual([]);
    expect(countChanges(s, before)).toEqual({ RESUME_DIALOG: 1, DEADLINES_WATCHED: 1 });
  });

  it('the ordinary branch carrying a YouTube attempt after the room switched to a file: the second step finds it retired, and the dialog stops', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    const c = await import('../output-recovery-counters.ts');
    const s: Scene = { o, fake, c };
    stageYouTube(o);
    const bus = recordBus(o);
    bind(o, fake);
    fake.planResume({ outcome: 'reject' });
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });
    stageFile(o, QUEUE_B);
    await vi.advanceTimersByTimeAsync(100);
    const side = dialog();
    const ops = fake.ops.length;

    const finished = tap(s, dialogSelector('restore-playing-output'), side)!.finish();
    await vi.advanceTimersByTimeAsync(5_000);

    // Known gap (C1-I6, ordinary branch carries a non-file token), the
    // dialog's half through the owner's entry: the tap carries the YouTube
    // attempt, the resume lets the owner retire it (identity check), and its
    // second step ends there, with no probe, notice or rejoin. app.ts then
    // ends the dialog with no rejoin of its own.
    await expect(finished).resolves.toEqual({ kind: 'stopped' });
    expect(fake.ops.slice(ops)).toEqual(['resume()', 'statechange:running', 'resume:resolved']);
    expect(side.unhealthy).toEqual([]);
    expect(bus.needed).toEqual([]);
    expect(bus.rejoins).toEqual([]);
    expect(playbackScope.view(o)).toEqual({ attempt: 'none', gesture: false });
  });
});
