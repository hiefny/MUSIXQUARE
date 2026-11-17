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
  armNewIncident,
  bind,
  dialogSelector,
  dialogTakesPlayRequest,
  foregroundIncident,
  loadOwners,
  ownerView,
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

/** The 7C-K8 scene: a YouTube attempt waits, then the room switches to a file. */
async function youtubeAttemptThenFile(): Promise<Scene> {
  const fake = new FakeNativeAudioContext();
  const o = await loadOwners(fake);
  const c = await import('../output-recovery-counters.ts');
  stageYouTube(o);
  bind(o, fake);
  fake.planResume({ outcome: 'reject' });
  fake.transition('interrupted');
  await vi.advanceTimersByTimeAsync(1_000);
  stageFile(o, QUEUE_B);
  await vi.advanceTimersByTimeAsync(100);
  expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });
  return { o, fake, c };
}

/** A local file's OS interruption whose automatic resume was refused: its attempt waits. */
async function fileAttemptWaits(): Promise<Scene> {
  const s = await scene();
  s.fake.planResume({ outcome: 'reject' });
  s.fake.transition('interrupted');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(playbackScope.view(s.o)).toEqual({ attempt: 'file', gesture: true });
  return s;
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

  it('a restore that carries its play-request restart while a file attempt of the playback scope waits too: the tap resumes the restart it serves', async () => {
    // Both scopes live on one context (C1-I14): an OS interruption whose
    // automatic resume was refused, then a restart parked at once on the
    // interrupted context, which its dialog took. The entry tests the
    // restart the dialog serves before the playback scope's attempt. The
    // pairing is staged to make that order observable: in app.ts a restore
    // carries a restart only after its own ordinary branch prepared one for
    // a frozen clock, and a PLAY's restart is shown as a failed PLAY's
    // retry, for which the second test is false in either order.
    const s = await fileAttemptWaits();
    const restart = playRequest.arm(s.o, s.fake);
    await expect(restart.first).resolves.toBe('prepared');
    expect(ownerView(s.o)).toEqual({ request: 'owned', scope: { attempt: 'file', gesture: true } });
    const before = counts(s);
    const ops = s.fake.ops.length;

    const gesture = tap(s, dialogSelector('restore-playing-output', restart));

    expect(gesture).not.toBeNull();
    expect(s.fake.ops.slice(ops)).toEqual(['resume()']);
    expect(countChanges(s, before)).toEqual({ RESUME_PLAY_REQUEST: 1, DEADLINES_WATCHED: 1 });
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
        expect(attemptToken).toBe(selector.playRequestAttemptToken);
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

  it("a dialog that stops acting during the clock probe: the probe answers superseded, so nothing commits; the dialog's log first, then the attempt retires and the next PLAY's clock check is armed", async () => {
    const s = await scene();
    const restart = playRequest.arm(s.o, s.fake);
    await expect(restart.first).resolves.toBe('prepared');
    const side = dialog();
    const confirm = vi.fn((): boolean => true);
    const loggedWhileCurrent: boolean[] = [];
    const before = counts(s);

    const outcome = settled(
      s.o.recovery
        .beginAudioOutputGestureRecovery(dialogSelector('retry-failed-play', restart), {
          ...side.caller,
          confirm,
          unhealthy: (health) => {
            side.caller.unhealthy(health);
            loggedWhileCurrent.push(restart.isCurrent());
          },
        })!
        .finish(),
    );
    // The tap's resume lands at once and promotes the attempt; the probe's
    // first sample ends at 180 ms. The probe is the only place the dialog's
    // currency is read between the requirement wait and the commit.
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.value).toBe('waiting');
    side.current = false;
    await vi.advanceTimersByTimeAsync(2_000);

    // A withdrawn dialog's failed PLAY is not retried: no confirm, no commit.
    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(confirm).not.toHaveBeenCalled();
    expect(side.unhealthy).toEqual(['superseded']);
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

  it("the attempt superseded by a newer foreground incident during the clock probe: the caller's confirm is not asked, the dialog logs the probe's answer, and that incident stays", async () => {
    const s = await scene();
    const restart = playRequest.arm(s.o, s.fake);
    await expect(restart.first).resolves.toBe('prepared');
    const side = dialog();
    const confirm = vi.fn((): boolean => true);

    const outcome = settled(
      s.o.recovery
        .beginAudioOutputGestureRecovery(dialogSelector('retry-failed-play', restart), {
          ...side.caller,
          confirm,
        })!
        .finish(),
    );
    // The probe's first sample ends at 180 ms.
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.value).toBe('waiting');
    const newer = armNewIncident(s.o, s.fake);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(confirm).not.toHaveBeenCalled();
    expect(side.unhealthy).toEqual(['superseded']);
    expect(restart.isCurrent()).toBe(false);
    // The dialog retired nothing itself, so it armed nothing in that incident's place.
    expect(foregroundIncident(s.o)).toBe(newer);
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

  it("a dialog that stops acting during the requirement wait, with no abort and no visibility change: the owner reads that when the tap's late resume promotes the attempt, and retires it with no clock check and no log", async () => {
    const s = await scene();
    const restart = playRequest.arm(s.o, s.fake);
    await expect(restart.first).resolves.toBe('prepared');
    s.fake.planResume({ latencyMs: 1_200 });
    const side = dialog();
    const before = counts(s);

    const outcome = settled(tap(s, dialogSelector('retry-failed-play', restart), side)!.finish());
    // The owner's resume deadline answers at 750 ms, so the requirement wait
    // runs from there; the resume lands, and promotes the attempt, at 1.2 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome.value).toBe('waiting');
    side.current = false;
    await vi.advanceTimersByTimeAsync(150);
    expect(outcome.value).toBe('waiting');
    await vi.advanceTimersByTimeAsync(100);

    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(s.fake.state).toBe('running');
    expect(side.unhealthy).toEqual([]);
    expect(restart.isCurrent()).toBe(false);
    const incident = foregroundIncident(s.o);
    expect(incident).not.toBeNull();
    expect(incident).not.toBe(restart.incident);
    expect(countChanges(s, before)).toEqual({
      RESUME_PLAY_REQUEST: 1,
      DEADLINE_PLAY_REQUEST_RESUME: 1,
      DEADLINES_WATCHED: 3,
      CLOCK_WAITS: 1,
      CLOCK_CANCELLED: 1,
    });
  });

  it("a newer restart takes the attempt's place during the requirement wait: the dialog stops and leaves that restart and its incident alone", async () => {
    const s = await scene();
    const restart = playRequest.arm(s.o, s.fake);
    await expect(restart.first).resolves.toBe('prepared');
    s.fake.planResume({ outcome: 'never' });

    const outcome = settled(tap(s, dialogSelector('retry-failed-play', restart))!.finish());
    await vi.advanceTimersByTimeAsync(1_500);
    expect(outcome.value).toBe('waiting');
    // A newer foreground incident, and the restart a PLAY prepares for it,
    // parked at once on the context the tap's resume has not woken.
    const newer = playRequest.arm(s.o, s.fake);
    await expect(newer.first).resolves.toBe('prepared');
    await vi.advanceTimersByTimeAsync(0);

    // The dialog's attempt was superseded, not retired by the dialog: it arms
    // no clock check of its own, which would retire the newer restart.
    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(restart.isCurrent()).toBe(false);
    expect(newer.isCurrent()).toBe(true);
    expect(foregroundIncident(s.o)).toBe(newer.incident);
  });
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

  it("the playback scope's attempt whose tap's resume is refused, the interruption ending by itself before the dialog closed: the dialog lets it go with no clock check of its own and no log; the owner verifies that running state with its one rejoin", async () => {
    const s = await fileAttemptWaits();
    s.fake.planResume({ outcome: 'reject' });
    const bus = recordBus(s.o);
    const side = dialog();
    const before = counts(s);

    const gesture = tap(s, dialogSelector('restore-playing-output'), side)!;
    await vi.advanceTimersByTimeAsync(50);
    // The OS ends the interruption: the owner hears an outside resume and
    // verifies it itself (fix lane G7). The flight still answered not
    // running, and the second step is told so.
    s.fake.transition('running');
    const outcome = settled(gesture.finish());
    await vi.advanceTimersByTimeAsync(2_000);

    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(side.unhealthy).toEqual([]);
    expect(bus.needed).toEqual([]);
    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'none', gesture: false });
    expect(countChanges(s, before)).toEqual({
      RESUME_PLAY_GESTURE: 1,
      DEADLINES_WATCHED: 2,
      CLOCK_WAITS: 1,
      CLOCK_CONFIRMED: 1,
      CONTEXT_RECOVERED_REJOINS: 1,
    });
  });

  it("the playback scope's attempt on a clock still frozen whose dialog stops acting while the owner parks it again: stopped, not the same request again", async () => {
    const s = await scene();
    await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
    const bus = recordBus(s.o);
    s.fake.freezeClock();
    // The attempt's second suspend takes effect 300 ms after the clock check.
    s.fake.planSuspend({ latencyMs: 300 });
    const side = dialog();

    const outcome = settled(tap(s, dialogSelector('restore-playing-output'), side)!.finish());
    // Two frozen samples end at 360 ms; the suspend lands at 660 ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(side.unhealthy).toEqual(['clock-stalled']);
    expect(outcome.value).toBe('waiting');
    side.current = false;
    await vi.advanceTimersByTimeAsync(2_000);

    // 'escalated' asks app.ts for the same request again; a dialog that no
    // longer acts gets 'stopped'. The owner still parked the attempt once
    // more and sent its one notice.
    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
    expect(s.fake.state).toBe('suspended');
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'file', gesture: true });
  });

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

  it("the ordinary branch whose own resume is refused: it stops although the context runs on a healthy clock, and the dialog logs the probe's answer", async () => {
    // A context that runs on a healthy clock although the tap's own resume
    // was refused. Here the fake's reject plan leaves a running context
    // running. By code reading (no row stages it, and no device or browser
    // run has shown it), the same state follows on this branch when a
    // refused tap's interruption ends by itself before the dialog closes: a
    // restore after the room switched to a file, or a failed PLAY's retry
    // with no restart. The other row that refuses the tap's own resume
    // (audio-output-recovery-file-start.test.ts) does it on a context that
    // does not run, where the probe answers not-running whatever the flight
    // said.
    const s = await scene();
    s.fake.planResume({ outcome: 'reject' });
    const bus = recordBus(s.o);
    const side = dialog();
    const before = counts(s);
    const ops = s.fake.ops.length;

    const finished = tap(s, dialogSelector('restore-playing-output'), side)!.finish();
    await vi.advanceTimersByTimeAsync(2_000);

    // Today's answer, carried over from app.ts (before 7C-2:
    // !health.healthy || !gestureReachedRunning): a refused resume does not
    // answer recovered, so app.ts publishes no rejoin and retries no failed
    // PLAY for it (code reading). The branch retired any pending attempt in
    // its tap and carries none, so nothing else realigns either. The App
    // 9.0.42 report decides a refused resume only for a context that does
    // not run; this row records the answer for one that runs and does not
    // settle it.
    await expect(finished).resolves.toEqual({ kind: 'stopped' });
    expect(s.fake.ops.slice(ops)).toEqual(['resume()', 'resume:rejected']);
    expect(side.unhealthy).toEqual(['healthy']);
    expect(bus.rejoins).toEqual([]);
    expect(countChanges(s, before)).toEqual({ RESUME_DIALOG: 1, DEADLINES_WATCHED: 1 });
  });

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
      playRequestAttemptToken: attemptToken,
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

  it('the ordinary branch on a frozen clock whose dialog stops acting on a visible page while the restart prepares: it answers stopped, not a restart to queue, and leaves the restart to the PLAY or the dialog that follows', async () => {
    const s = await scene();
    s.fake.freezeClock();
    // The restart's suspend takes effect 300 ms after the clock check asked for it.
    s.fake.planSuspend({ latencyMs: 300 });
    const side = dialog();

    const outcome = settled(tap(s, dialogSelector('restore-playing-output'), side)!.finish());
    // Two frozen samples end at 360 ms; the suspend lands at 660 ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(side.unhealthy).toEqual(['clock-stalled']);
    expect(outcome.value).toBe('waiting');
    side.current = false;
    await vi.advanceTimersByTimeAsync(2_000);

    // No 'clock-stalled' answer for a dialog that no longer acts: app.ts
    // queues no request for it. On a visible page (a pause, another track, a
    // newer PLAY or request ended the dialog) the restart stays, parked and
    // holding nothing, for the PLAY or the newer request's dialog that
    // follows: that PLAY's clock check takes it (F-2501), and giving it up
    // here would clear the incident a newer PLAY may be sampling.
    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(side.unhealthy).toEqual(['clock-stalled']);
    expect(ownerView(s.o).request).toBe('owned');
    expect(s.fake.state).toBe('suspended');
    expect(s.o.recovery.isAudioOutputRecoveryHolding()).toBe(false);
  });

  it.each([
    [
      'still frozen at the return: the inspection parks the output and asks for a gesture',
      { suspendMs: 300, runsAgain: false },
      { status: 'needs-gesture', reason: 'clock-stalled' },
      { attempt: 'file', gesture: true },
      'suspended',
    ],
    [
      'running again at the return: the inspection answers healthy with a rejoin to make',
      { suspendMs: 300, runsAgain: true },
      { status: 'healthy', rejoinRequired: true },
      { attempt: 'none', gesture: false },
      'running',
    ],
    [
      'still frozen at the return, the restart still preparing when the branch gave it up',
      { suspendMs: 700, runsAgain: false },
      { status: 'needs-gesture', reason: 'clock-stalled' },
      { attempt: 'file', gesture: true },
      'suspended',
    ],
  ] as const)(
    "the ordinary branch on a frozen clock whose page is hidden while the restart prepares: it gives the restart up, so the return's inspection is not deferred (F-2502); the clock %s",
    async (_label, { suspendMs, runsAgain }, inspected, scope, state) => {
      const s = await scene();
      const health = await import('../output-health.ts');
      s.fake.freezeClock();
      // Two frozen samples end at 360 ms; the restart's suspend lands
      // `suspendMs` later, inside its 500 ms window or after it.
      s.fake.planSuspend({ latencyMs: suspendMs });
      const bus = recordBus(s.o);
      const side = dialog();

      const outcome = settled(tap(s, dialogSelector('restore-playing-output'), side)!.finish());
      await vi.advanceTimersByTimeAsync(500);
      expect(side.unhealthy).toEqual(['clock-stalled']);
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(2_000);

      // No dialog can show the restart's request for a hidden page, so the
      // branch gives it up as the play-request branch gives its attempt up:
      // nothing owns the context, and a hidden page arms no clock check and
      // undoes no suspend. Before F-2502 the restart stayed parked with no
      // dialog, the return's inspection deferred to it, and a file that
      // played stayed silent while the screen showed it playing.
      expect(outcome.value).toEqual({ kind: 'stopped' });
      expect(ownerView(s.o)).toEqual({
        request: 'none',
        scope: { attempt: 'none', gesture: false },
      });
      expect(foregroundIncident(s.o)).toBeNull();
      expect(s.fake.state).toBe('suspended');
      expect(bus.needed).toEqual([]);

      // The return: the binding arms the next clock check, and the app's
      // inspection of a playing file runs as with no restart.
      await vi.advanceTimersByTimeAsync(30_000);
      if (runsAgain) s.fake.runClock();
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
      expect(foregroundIncident(s.o)).not.toBeNull();
      const inspection = health.inspectBackgroundFileOutput();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(inspection).resolves.toMatchObject(inspected);
      expect(playbackScope.view(s.o)).toEqual(scope);
      expect(s.fake.state).toBe(state);
    },
  );

  it("a failed PLAY's retry with no restart cancels a pending playback-scope attempt inside its tap, before its resume, and carries none", async () => {
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

  it('a restore while a YouTube attempt waits after the room switched to a file: the ordinary branch carries no attempt, and its clock check answers recovered (Phase 7 7C-K8)', async () => {
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

    // Phase 7 7C-K8, the owner's decision of 2026-11-07 (it was Known gap
    // C1-I6): a restore's ordinary branch carries no attempt. Since App 9.0.42
    // (the owner's decision of 2026-11-10) the tap retires the YouTube attempt
    // itself before its resume, with no notice or rejoin of its own; the
    // branch's clock check then answers recovered, and app.ts publishes its
    // own 'audio-recovery-gesture' rejoin (code reading).
    await expect(finished).resolves.toEqual({ kind: 'recovered', rejoinEmitted: false });
    expect(fake.ops.slice(ops)).toEqual(['resume()', 'statechange:running', 'resume:resolved']);
    expect(side.unhealthy).toEqual([]);
    expect(bus.needed).toEqual([]);
    expect(bus.rejoins).toEqual([]);
    expect(playbackScope.view(o)).toEqual({ attempt: 'none', gesture: false });
  });
});

/**
 * The ordinary branch's own resume landing after the dialog's 1 s wait
 * (App 9.0.42, the owner's decision of 2026-11-11). No device or browser run
 * has shown it: the rows guard the case on the fake context. With no owner
 * attempt to verify a late running state (the playback scope's 7B-5 rule,
 * kept by the owner's decision of 2026-11-05), the branch waits for that
 * resume up to the dialog's 5 s limit, then checks the clock: a healthy one
 * answers recovered, so app.ts realigns once (its rejoin, or a failed PLAY's
 * retry), with no new dialog. Past the limit it stops as before.
 */
describe("RO-01 the ordinary branch's resume after the dialog's 1 s wait (App 9.0.42)", () => {
  it.each([
    [
      'a restore after the room switched to a file',
      youtubeAttemptThenFile,
      'restore-playing-output',
    ],
    ["a failed PLAY's retry", fileAttemptWaits, 'retry-failed-play'],
  ] as const)(
    '%s, its resume landing 1.5 s after the tap: the branch waits for it and answers recovered, with no new notice',
    async (_label, stage, intent) => {
      const s = await stage();
      s.fake.planResume({ latencyMs: 1_500 });
      const bus = recordBus(s.o);
      const side = dialog();
      const before = counts(s);

      const outcome = settled(tap(s, dialogSelector(intent), side)!.finish());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcome.value).toBe('waiting');
      await vi.advanceTimersByTimeAsync(2_000);

      // app.ts then realigns once: its own rejoin for a restore, the failed
      // PLAY's retry for a retry (code reading).
      expect(outcome.value).toEqual({ kind: 'recovered', rejoinEmitted: false });
      expect(side.unhealthy).toEqual([]);
      expect(s.fake.state).toBe('running');
      expect(bus.needed).toEqual([]);
      expect(bus.rejoins).toEqual([]);
      expect(playbackScope.view(s.o)).toEqual({ attempt: 'none', gesture: false });
      expect(countChanges(s, before)).toEqual({
        RESUME_DIALOG: 1,
        DEADLINE_GESTURE_FLOW: 1,
        DEADLINES_WATCHED: 2,
      });
    },
  );

  it.each([
    ['lands 7 s after the tap', { latencyMs: 7_000 }],
    ['never settles', { outcome: 'never' as const }],
  ])(
    'a restore whose resume %s: the branch stops at its 5 s limit, as before',
    async (_label, plan) => {
      const s = await youtubeAttemptThenFile();
      s.fake.planResume(plan);
      const bus = recordBus(s.o);
      const side = dialog();
      const before = counts(s);

      const outcome = settled(tap(s, dialogSelector('restore-playing-output'), side)!.finish());
      await vi.advanceTimersByTimeAsync(5_900);
      expect(outcome.value).toBe('waiting');
      await vi.advanceTimersByTimeAsync(600);

      expect(outcome.value).toEqual({ kind: 'stopped' });
      expect(side.unhealthy).toEqual(['not-running']);
      expect(bus.needed).toEqual([]);
      expect(bus.rejoins).toEqual([]);
      expect(countChanges(s, before)).toEqual({
        RESUME_DIALOG: 1,
        DEADLINE_GESTURE_FLOW: 1,
        DEADLINE_CLOCK_REQUIREMENT: 1,
        DEADLINES_WATCHED: 2,
      });
    },
  );

  it('a dialog that stops acting during the second wait: the branch reads that once the wait ends and stops, with no clock check and no log', async () => {
    const s = await youtubeAttemptThenFile();
    s.fake.planResume({ latencyMs: 3_000 });
    const bus = recordBus(s.o);
    const side = dialog();
    const before = counts(s);

    const outcome = settled(tap(s, dialogSelector('restore-playing-output'), side)!.finish());
    // The 1 s wait ends on a context that does not run yet; the resume lands at 3 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome.value).toBe('waiting');
    side.current = false;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(outcome.value).toEqual({ kind: 'stopped' });
    expect(s.fake.state).toBe('running');
    expect(side.unhealthy).toEqual([]);
    expect(bus.needed).toEqual([]);
    expect(bus.rejoins).toEqual([]);
    expect(countChanges(s, before)).toEqual({
      RESUME_DIALOG: 1,
      DEADLINE_GESTURE_FLOW: 1,
      DEADLINES_WATCHED: 2,
    });
  });
});
