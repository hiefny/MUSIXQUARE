/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 the owner's two attempt scopes on one context (Phase 7 7C-5 gives
 * them one attempt type). The play-request restart and the playback-scope
 * recovery each keep one slot and one generation, so retiring one never
 * voids the other; each scope's phase changes reach the `/debug sync` counts
 * once. These rows drive the owners through the tables' one driver and their
 * public entries only, and read nothing the attempt-type merge renames, so
 * they stay byte for byte through it. Also pinned here: a stalled attempt
 * whose tap brought the context running while its clock stays frozen (parked
 * once more for one more tap since App 9.0.42), and the suspend ledger's own
 * cleanup of a late suspend on a context that no binding is seated for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNativeAudioContext } from './__helpers__/fake-audio-context.ts';
import {
  bind,
  foregroundIncident,
  loadOwners,
  ownerView,
  playRequest,
  playbackScope,
  recordBus,
  setupOwnerTest,
  stageFile,
  teardownOwnerTest,
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

/** The two millisecond slots move with the fake clock; rows read them apart. */
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

/** The recovery dialog's side of its tap: its currency and its log of an unhealthy clock. */
function dialog() {
  const side = {
    unhealthy: [] as string[],
    caller: {
      isCurrent: (): boolean => document.visibilityState === 'visible',
      signal: new AbortController().signal,
      unhealthy: (health: { readonly reason: string }): void => {
        side.unhealthy.push(health.reason);
      },
    },
  };
  return side;
}

/**
 * Both scopes live on one context, as the harness's C1-I14 row stages them:
 * an OS interruption whose automatic resume was refused (a playback-scope
 * attempt waiting for its resume), then a PLAY-time restart, parked at once
 * on the interrupted context, whose dialog took it.
 */
async function bothScopes(s: Scene) {
  s.fake.planResume({ outcome: 'reject' });
  s.fake.transition('interrupted');
  await vi.advanceTimersByTimeAsync(1_000);
  const scope = playbackScope.current(s.o);
  expect(scope).toBeTypeOf('object');
  const request = playRequest.arm(s.o, s.fake);
  await expect(request.first).resolves.toBe('prepared');
  expect(ownerView(s.o)).toEqual({ request: 'owned', scope: { attempt: 'file', gesture: true } });
  expect(playbackScope.isCurrent(s.o, scope!)).toBe(true);
  expect(request.isCurrent()).toBe(true);
  return { scope: scope!, request };
}

beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

describe('RO-01 one slot and one generation per scope', () => {
  it('retiring the playback-scope attempt leaves the play-request attempt current', async () => {
    const s = await scene();
    const { scope, request } = await bothScopes(s);
    const ops = s.fake.ops.length;

    expect(playbackScope.retire(s.o, scope)).toBe(true);

    expect(playbackScope.isCurrent(s.o, scope)).toBe(false);
    expect(request.isCurrent()).toBe(true);
    expect(ownerView(s.o)).toEqual({
      request: 'owned',
      scope: { attempt: 'none', gesture: false },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    // The playback scope's retire makes no native call; the restart still
    // waits for its tap on the parked context, and that tap resumes it.
    expect(s.fake.ops.slice(ops)).toEqual([]);
    expect(s.fake.state).toBe('interrupted');
    expect(request.isCurrent()).toBe(true);
    await expect(request.tap()).resolves.toEqual({ running: true });
    expect(request.requirement()).toBe('same');
  });

  it('retiring the play-request attempt leaves the playback-scope attempt current', async () => {
    const s = await scene();
    const { scope, request } = await bothScopes(s);
    const bus = recordBus(s.o);

    expect(request.retire()).toBe(true);

    expect(request.isCurrent()).toBe(false);
    expect(playbackScope.isCurrent(s.o, scope)).toBe(true);
    expect(ownerView(s.o)).toEqual({ request: 'none', scope: { attempt: 'file', gesture: true } });
    expect(foregroundIncident(s.o)).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    // The restart's retire undid its parked state (the retired-suspend
    // cleanup); the playback scope took that running state as its own,
    // proved the clock and committed its one rejoin, and stays the active
    // attempt once completed.
    expect(s.fake.state).toBe('running');
    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(bus.needed).toEqual([]);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'none', gesture: false });
    expect(playbackScope.isCurrent(s.o, scope)).toBe(true);
  });
});

describe("RO-01 a stalled attempt's clock still frozen after its tap", () => {
  it('the second step parks it once more for one more tap; a second frozen tap is rejected, and the attempt waits in clock verification (App 9.0.42, owner decision 2026-11-10)', async () => {
    const s = await scene();
    await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
    const attempt = playbackScope.current(s.o)!;
    const bus = recordBus(s.o);
    s.fake.freezeClock();
    const unhealthy: string[] = [];
    const caller = (running: boolean) => ({
      running,
      isCurrent: () => true,
      unhealthy: (health: { readonly reason: string }) => {
        unhealthy.push(health.reason);
      },
    });

    // The tap's resume brings the parked context running inside its
    // deadline, so the attempt goes on to clock verification for its caller.
    const resumed = await s.o.recovery.beginPlaybackScopeRecoveryFromGesture();
    expect(resumed).toEqual({ running: true, rejoinEmitted: false });
    const finished = s.o.recovery.finishPlaybackScopeRecoveryFromGesture(
      attempt,
      caller(resumed.running),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    // The clock is still frozen: the owner parks the same attempt once more
    // and notifies, so its dialog asks for one more tap.
    await expect(finished).resolves.toEqual({ kind: 'escalated', escalation: 'prepared' });
    expect(unhealthy).toEqual(['clock-stalled']);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
    expect(s.fake.state).toBe('suspended');
    expect(s.fake.calls('suspend')).toBe(2);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'file', gesture: true });
    expect(playbackScope.isCurrent(s.o, attempt)).toBe(true);

    // One more at most: the next tap on a clock still frozen is rejected, as
    // every such tap was before, and nothing is prepared or asked again.
    const again = await s.o.recovery.beginPlaybackScopeRecoveryFromGesture();
    expect(again).toEqual({ running: true, rejoinEmitted: false });
    const second = s.o.recovery.finishPlaybackScopeRecoveryFromGesture(
      attempt,
      caller(again.running),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(second).resolves.toEqual({ kind: 'escalated', escalation: 'rejected' });
    expect(unhealthy).toEqual(['clock-stalled', 'clock-stalled']);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
    expect(s.fake.state).toBe('running');
    expect(s.fake.calls('suspend')).toBe(2);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'file', gesture: false });
    expect(playbackScope.isCurrent(s.o, attempt)).toBe(true);
  });

  it("the dialog's tap on it: the dialog shows the same request once more, and a second frozen tap stops with the counts of the playback scope's tap (App 9.0.42)", async () => {
    const s = await scene();
    await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
    const bus = recordBus(s.o);
    s.fake.freezeClock();
    const side = dialog();
    const before = counts(s);

    const finished = s.o.recovery
      .beginAudioOutputGestureRecovery({ intent: 'restore-playing-output' }, side.caller)!
      .finish();
    await vi.advanceTimersByTimeAsync(2_000);

    // app.ts shows the same request again for 'escalated'.
    await expect(finished).resolves.toEqual({ kind: 'escalated' });
    expect(side.unhealthy).toEqual(['clock-stalled']);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
    expect(s.fake.state).toBe('suspended');
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'file', gesture: true });
    // The tap's resume and its 1 s race, one clock wait that goes back to
    // recovery, and the attempt's second suspend (its lease watchdog and its
    // preparation race).
    expect(countChanges(s, before)).toEqual({
      RESUME_PLAY_GESTURE: 1,
      DEADLINES_WATCHED: 4,
      CLOCK_WAITS: 1,
      CLOCK_RECOVERY_NEEDED: 1,
      SUSPEND_CALLS: 1,
      SECOND_SUSPENDS: 1,
    });

    const second = counts(s);
    const stopped = s.o.recovery
      .beginAudioOutputGestureRecovery({ intent: 'restore-playing-output' }, side.caller)!
      .finish();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(stopped).resolves.toEqual({ kind: 'stopped' });
    expect(side.unhealthy).toEqual(['clock-stalled', 'clock-stalled']);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(bus.rejoins).toEqual([]);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'file', gesture: false });
    expect(countChanges(s, second)).toEqual({
      RESUME_PLAY_GESTURE: 1,
      DEADLINES_WATCHED: 2,
      CLOCK_WAITS: 1,
    });
  });

  it("the dialog's second tap on a clock that runs again commits once with the owner's one rejoin (App 9.0.42)", async () => {
    const s = await scene();
    await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
    const bus = recordBus(s.o);
    s.fake.freezeClock();
    const side = dialog();

    const first = s.o.recovery
      .beginAudioOutputGestureRecovery({ intent: 'restore-playing-output' }, side.caller)!
      .finish();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toEqual({ kind: 'escalated' });

    s.fake.runClock();
    const second = s.o.recovery
      .beginAudioOutputGestureRecovery({ intent: 'restore-playing-output' }, side.caller)!
      .finish();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(second).resolves.toEqual({ kind: 'recovered', rejoinEmitted: true });
    expect(side.unhealthy).toEqual(['clock-stalled']);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(s.fake.state).toBe('running');
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'none', gesture: false });
  });
});

describe("RO-01 each scope's phase changes, as the /debug sync counts read them", () => {
  it('an outside resume while a stalled file attempt waits for its tap: the owner parks it again, one re-suspend after running', async () => {
    const s = await scene();
    await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
    const bus = recordBus(s.o);
    const before = counts(s);

    s.fake.transition('running');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(s.fake.state).toBe('suspended');
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(playbackScope.view(s.o)).toEqual({ attempt: 'file', gesture: true });
    expect(countChanges(s, before)).toEqual({
      RESUSPENDED_AFTER_RUNNING: 1,
      SUSPEND_CALLS: 1,
      SECOND_SUSPENDS: 1,
      DEADLINES_WATCHED: 2,
    });
  });

  it('a playback-scope attempt retired while its clock is verified: one cancelled wait', async () => {
    const s = await scene();
    await expect(playbackScope.armStalled(s.o, s.fake)).resolves.toBe('prepared');
    const attempt = playbackScope.current(s.o)!;
    const before = counts(s);

    await expect(playbackScope.tap(s.o)).resolves.toEqual({ running: true });
    await vi.advanceTimersByTimeAsync(120);
    expect(playbackScope.retire(s.o, attempt)).toBe(true);

    expect(countChanges(s, before)).toEqual({
      RESUME_PLAY_GESTURE: 1,
      DEADLINES_WATCHED: 1,
      CLOCK_WAITS: 1,
      CLOCK_CANCELLED: 1,
    });
    expect(counts(s)[s.c.CLOCK_WAIT_TOTAL_MS]! - before[s.c.CLOCK_WAIT_TOTAL_MS]!).toBe(120);
    expect(playbackScope.isCurrent(s.o, attempt)).toBe(false);
  });
});

describe('RO-01 a late suspend on a context that no binding is seated for', () => {
  it('the suspend ledger undoes it: a restart the dialog prepared for a frozen clock, retired before its suspend took effect', async () => {
    // No binding: the engine seats one on each context right after it
    // creates and resumes it (engine.ts initAudio).
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    fake.freezeClock();
    // The restart's suspend resolves while the context still runs; the state
    // lands 700 ms later.
    fake.planSuspend({ statechange: 'after-settle', stateDelayMs: 700 });
    const side = dialog();

    const finished = o.recovery
      .beginAudioOutputGestureRecovery({ intent: 'restore-playing-output' }, side.caller)!
      .finish();
    await vi.advanceTimersByTimeAsync(900);

    // The ordinary branch's probe found the clock frozen at 360 ms and had a
    // play-request restart ask for a suspend, still not taken effect at its
    // 500 ms limit.
    await expect(finished).resolves.toMatchObject({
      kind: 'clock-stalled',
      preparation: { status: 'preparing' },
    });
    expect(side.unhealthy).toEqual(['clock-stalled']);
    expect(fake.state).toBe('running');
    const incident = foregroundIncident(o);
    expect(incident).not.toBeNull();
    const ops = fake.ops.length;

    // A PLAY's healthy clock check consumes the incident: the restart retires
    // and its suspend may still land inside the late fence.
    expect(o.context.consumeForegroundAudioContextClockHealthCheck(incident!)).toBe(true);
    expect(ownerView(o).request).toBe('none');
    await vi.advanceTimersByTimeAsync(1_000);

    // It lands at 1,060 ms with no attempt to take it and no binding to
    // judge it: the ledger's own retired-suspend cleanup resumes the context.
    expect(fake.ops.slice(ops)).toEqual([
      'statechange:suspended',
      'resume()',
      'statechange:running',
      'resume:resolved',
    ]);
    expect(fake.state).toBe('running');
    expect(foregroundIncident(o)).toBeNull();
  });
});
