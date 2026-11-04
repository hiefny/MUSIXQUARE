/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 owner scenes for the `/debug sync` audio recovery counts (Phase 7
 * 7A-1): every path counts exactly once, on the real owners (context.ts,
 * context-recovery.ts, ui-sounds.ts) over one FakeNativeAudioContext with no
 * module mocks, on the fake clock.
 *
 * The invariant behind the resume rows: each native resume() that reaches
 * the platform from these owners is one count, under exactly one source.
 * app.ts (the dialog's own resume, its 1 s and 5 s waits, the dialog
 * requests) has no unit seam; its counts are read in the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeNativeAudioContext,
  type FakeNativeCallPlan,
} from './__helpers__/fake-audio-context.ts';
import {
  bind,
  loadOwners,
  loadUiTouchSound,
  setVisibility,
  setupOwnerTest,
  stageFile,
  stageIdle,
  stageYouTube,
  teardownOwnerTest,
  type Owners,
} from './__helpers__/audio-output-owners.ts';

type Counters = typeof import('../output-recovery-counters.ts');

interface Scene {
  readonly o: Owners;
  readonly fake: FakeNativeAudioContext;
  readonly c: Counters;
  /** The slots now. */
  read(): readonly number[];
}

/** Fresh owners and the counts module of the same module graph. */
async function scene(fake = new FakeNativeAudioContext()): Promise<Scene> {
  const o = await loadOwners(fake);
  const c = await import('../output-recovery-counters.ts');
  return { o, fake, c, read: () => c.readAudioRecoveryCounts()[0] };
}

/** Slot deltas from `before` to now, as `name:delta` for every nonzero slot named. */
function delta(s: Scene, before: readonly number[], names: readonly (keyof Counters)[]): string[] {
  const now = s.read();
  return names
    .map((name) => {
      const slot = s.c[name] as number;
      return `${String(name)}:${now[slot]! - before[slot]!}`;
    })
    .filter((entry) => !entry.endsWith(':0'));
}

const RESUME_NAMES = [
  'RESUME_PLAY_REQUEST',
  'RESUME_PLAY_GESTURE',
  'RESUME_DIALOG',
  'RESUME_AUTO',
  'RESUME_ENSURE_RUNNING',
  'RESUME_PROBE',
  'RESUME_RETIRE',
  'RESUME_UI_SOUND',
] as const satisfies readonly (keyof Counters)[];

const DEADLINE_NAMES = [
  'DEADLINE_PLAY_REQUEST_PREPARE',
  'DEADLINE_PLAY_REQUEST_RESUME',
  'DEADLINE_PLAY_REQUEST_WATCHDOG',
  'DEADLINE_LATE_SUSPEND_FENCE',
  'DEADLINE_RETIRE_CLEANUP',
  'DEADLINE_ENSURE_RUNNING',
  'DEADLINE_PROBE',
  'DEADLINE_SCOPE_PREPARE',
  'DEADLINE_SCOPE_WATCHDOG',
  'DEADLINE_AUTO_RESUME',
  'DEADLINE_GESTURE_RESUME',
  'DEADLINE_GESTURE_FLOW',
  'DEADLINE_CLOCK_REQUIREMENT',
] as const satisfies readonly (keyof Counters)[];

/** A play-request restart prepared and parked, as transport leaves it for the dialog. */
async function parkPlayRequest(s: Scene): Promise<object> {
  const check = s.o.context.armForegroundAudioContextClockHealthCheck(s.fake.native);
  const preparation = await s.o.context.prepareForegroundAudioContextRestart(check!);
  expect(preparation).toMatchObject({ status: 'prepared' });
  return preparation!.attemptToken;
}

/** A playback-scope stalled attempt prepared and parked for its gesture. */
async function parkStalledFile(s: Scene): Promise<void> {
  stageFile(s.o);
  bind(s.o, s.fake);
  const token = await s.o.recovery.armPendingAudioContextRecoveryFromBackground(s.fake.native);
  expect(token).toBeTypeOf('object');
  expect(s.fake.state).toBe('suspended');
}

beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

describe('each native resume counts once, under its source', () => {
  it.each<[string, (keyof Counters)[], (s: Scene) => Promise<() => unknown>]>([
    [
      "the play-request restart's gesture",
      ['RESUME_PLAY_REQUEST'],
      async (s) => {
        const attempt = await parkPlayRequest(s);
        return () => s.o.context.resumePreparedForegroundAudioContextRestartFromGesture(attempt);
      },
    ],
    [
      "the playback scope's gesture",
      ['RESUME_PLAY_GESTURE'],
      async (s) => {
        await parkStalledFile(s);
        return () => s.o.recovery.resumePendingAudioContextInterruptionFromGesture();
      },
    ],
    [
      'an automatic resume of a playing file',
      ['RESUME_AUTO'],
      async (s) => {
        stageFile(s.o);
        bind(s.o, s.fake);
        return () => s.fake.transition('suspended');
      },
    ],
    [
      'an automatic resume with nothing playing',
      ['RESUME_AUTO'],
      async (s) => {
        stageIdle(s.o);
        bind(s.o, s.fake);
        return () => s.fake.transition('suspended');
      },
    ],
    [
      'ensureRunning',
      ['RESUME_ENSURE_RUNNING'],
      async (s) => {
        s.fake.transition('suspended');
        return () => s.o.context.ensureRunning();
      },
    ],
    [
      'a probe that may resume',
      ['RESUME_PROBE'],
      async (s) => {
        s.fake.transition('suspended');
        return () => s.o.context.probeAudioContextHealth({ attemptResume: true });
      },
    ],
    [
      'undoing a retired suspend',
      ['RESUME_RETIRE'],
      async (s) => {
        s.fake.transition('suspended');
        return () => s.o.context.requestRetiredAudioContextSuspendCleanup(s.fake.native);
      },
    ],
    [
      'a UI sound',
      ['RESUME_UI_SOUND'],
      async (s) => {
        const touch = await loadUiTouchSound();
        s.fake.transition('suspended');
        return touch;
      },
    ],
  ])('%s', async (_label, expected, arrange) => {
    const s = await scene();
    const act = await arrange(s);
    const before = s.read();
    const resumesBefore = s.fake.calls('resume');

    void Promise.resolve(act()).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(s.fake.calls('resume') - resumesBefore).toBe(1);
    expect(delta(s, before, RESUME_NAMES)).toEqual(expected.map((name) => `${String(name)}:1`));
  });

  it('a probe that may not resume, and a running context, count nothing', async () => {
    const s = await scene();
    const before = s.read();
    await s.o.context.ensureRunning();
    s.fake.transition('suspended');
    await s.o.context.probeAudioContextHealth({ attemptResume: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.fake.calls('resume')).toBe(0);
    expect(delta(s, before, [...RESUME_NAMES, 'DEADLINES_WATCHED'])).toEqual([]);
  });
});

describe('a deadline counts only when it fires', () => {
  type Arrange = (s: Scene) => Promise<() => unknown>;
  const ensureRunning: Arrange = async (s) => {
    s.fake.transition('suspended');
    return () => s.o.context.ensureRunning();
  };
  const probe: Arrange = async (s) => {
    s.fake.transition('suspended');
    return () => s.o.context.probeAudioContextHealth({ attemptResume: true });
  };
  const retire: Arrange = async (s) => {
    s.fake.transition('suspended');
    return () => s.o.context.requestRetiredAudioContextSuspendCleanup(s.fake.native);
  };
  const playRequestTap: Arrange = async (s) => {
    const attempt = await parkPlayRequest(s);
    return () => s.o.context.resumePreparedForegroundAudioContextRestartFromGesture(attempt);
  };
  const scopeTap: Arrange = async (s) => {
    await parkStalledFile(s);
    return () => s.o.recovery.resumePendingAudioContextInterruptionFromGesture();
  };
  const automatic: Arrange = async (s) => {
    stageFile(s.o);
    bind(s.o, s.fake);
    return () => s.fake.transition('interrupted');
  };

  it.each<[string, keyof Counters, Arrange, FakeNativeCallPlan, number]>([
    ['ensureRunning, resume settles at once', 'DEADLINE_ENSURE_RUNNING', ensureRunning, {}, 0],
    [
      'ensureRunning, resume settles at 499 ms',
      'DEADLINE_ENSURE_RUNNING',
      ensureRunning,
      { latencyMs: 499 },
      0,
    ],
    [
      'ensureRunning, resume settles at 501 ms',
      'DEADLINE_ENSURE_RUNNING',
      ensureRunning,
      { latencyMs: 501 },
      1,
    ],
    [
      'ensureRunning, resume never settles',
      'DEADLINE_ENSURE_RUNNING',
      ensureRunning,
      { outcome: 'never' },
      1,
    ],
    ['probe, resume rejects at once', 'DEADLINE_PROBE', probe, { outcome: 'reject' }, 0],
    ['probe, resume never settles', 'DEADLINE_PROBE', probe, { outcome: 'never' }, 1],
    ['retired suspend cleanup, settles', 'DEADLINE_RETIRE_CLEANUP', retire, {}, 0],
    [
      'retired suspend cleanup, never settles',
      'DEADLINE_RETIRE_CLEANUP',
      retire,
      { outcome: 'never' },
      1,
    ],
    ['play-request tap, settles', 'DEADLINE_PLAY_REQUEST_RESUME', playRequestTap, {}, 0],
    [
      'play-request tap, settles at 751 ms',
      'DEADLINE_PLAY_REQUEST_RESUME',
      playRequestTap,
      { latencyMs: 751 },
      1,
    ],
    ['playback-scope tap, settles', 'DEADLINE_GESTURE_RESUME', scopeTap, {}, 0],
    [
      'playback-scope tap, never settles',
      'DEADLINE_GESTURE_RESUME',
      scopeTap,
      { outcome: 'never' },
      1,
    ],
    ['automatic resume, settles', 'DEADLINE_AUTO_RESUME', automatic, {}, 0],
    ['automatic resume, never settles', 'DEADLINE_AUTO_RESUME', automatic, { outcome: 'never' }, 1],
  ])('%s', async (_label, slot, arrange, resumePlan, fires) => {
    const s = await scene();
    const act = await arrange(s);
    s.fake.planResume(resumePlan);
    const before = s.read();

    void Promise.resolve(act()).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(delta(s, before, DEADLINE_NAMES)).toEqual(fires ? [`${String(slot)}:1`] : []);
    expect(s.read()[s.c.DEADLINES_WATCHED]! - before[s.c.DEADLINES_WATCHED]!).toBe(1);
  });

  const prepareScope = (s: Scene): Promise<unknown> => {
    stageFile(s.o);
    bind(s.o, s.fake);
    return s.o.recovery.armPendingAudioContextRecoveryFromBackground(s.fake.native);
  };
  const preparePlayRequest = (s: Scene): Promise<unknown> => {
    const check = s.o.context.armForegroundAudioContextClockHealthCheck(s.fake.native);
    return s.o.context.prepareForegroundAudioContextRestart(check!);
  };

  it.each<[string, keyof Counters, (s: Scene) => Promise<unknown>, number, number]>([
    ['playback scope, suspend at 499 ms', 'DEADLINE_SCOPE_PREPARE', prepareScope, 499, 0],
    ['playback scope, suspend at 600 ms', 'DEADLINE_SCOPE_PREPARE', prepareScope, 600, 1],
    [
      'play request, suspend at 499 ms',
      'DEADLINE_PLAY_REQUEST_PREPARE',
      preparePlayRequest,
      499,
      0,
    ],
    [
      'play request, suspend at 600 ms',
      'DEADLINE_PLAY_REQUEST_PREPARE',
      preparePlayRequest,
      600,
      1,
    ],
  ])('preparation window, %s', async (_label, slot, prepare, latencyMs, fires) => {
    const s = await scene();
    s.fake.planSuspend({ latencyMs });
    const before = s.read();
    const flight = prepare(s);
    await vi.advanceTimersByTimeAsync(2_000);
    await flight;
    expect(delta(s, before, DEADLINE_NAMES)).toEqual(fires ? [`${String(slot)}:1`] : []);
  });

  it('a suspend that never settles fires the watchdog and starts a second suspend', async () => {
    const s = await scene();
    s.fake.planSuspend({ outcome: 'never' }, { outcome: 'never' });
    stageFile(s.o);
    bind(s.o, s.fake);
    const before = s.read();

    void s.o.recovery
      .armPendingAudioContextRecoveryFromBackground(s.fake.native)
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(800);

    expect(s.fake.calls('suspend')).toBe(2);
    expect(
      delta(s, before, ['DEADLINE_SCOPE_WATCHDOG', 'SUSPEND_CALLS', 'SECOND_SUSPENDS']),
    ).toEqual(['DEADLINE_SCOPE_WATCHDOG:1', 'SUSPEND_CALLS:2', 'SECOND_SUSPENDS:1']);
  });

  it('the play-request watchdog hands its second suspend through the late fence', async () => {
    const s = await scene();
    // WebKit: suspend() resolves while the state still says running.
    s.fake.planSuspend({ toState: 'unchanged' }, {});
    const before = s.read();
    const check = s.o.context.armForegroundAudioContextClockHealthCheck(s.fake.native);
    void s.o.context.prepareForegroundAudioContextRestart(check!).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(s.fake.calls('suspend')).toBe(2);
    expect(
      delta(s, before, [
        'DEADLINE_PLAY_REQUEST_WATCHDOG',
        'DEADLINE_LATE_SUSPEND_FENCE',
        'SUSPEND_CALLS',
        'SECOND_SUSPENDS',
      ]),
    ).toEqual([
      'DEADLINE_PLAY_REQUEST_WATCHDOG:1',
      'DEADLINE_LATE_SUSPEND_FENCE:1',
      'SUSPEND_CALLS:2',
      'SECOND_SUSPENDS:1',
    ]);
  });
});

describe('clock verification waits', () => {
  it('a play-request restart confirmed 300 ms after its tap: one wait of 300 ms', async () => {
    const s = await scene();
    const attempt = await parkPlayRequest(s);
    const before = s.read();
    await s.o.context.resumePreparedForegroundAudioContextRestartFromGesture(attempt);
    await vi.advanceTimersByTimeAsync(300);
    expect(s.o.context.confirmForegroundAudioContextRestartHealth(attempt)).toBe(true);

    expect(
      delta(s, before, [
        'CLOCK_WAITS',
        'CLOCK_CONFIRMED',
        'CLOCK_WAIT_TOTAL_MS',
        'CLOCK_WAIT_MAX_MS',
      ]),
    ).toEqual([
      'CLOCK_WAITS:1',
      'CLOCK_CONFIRMED:1',
      'CLOCK_WAIT_TOTAL_MS:300',
      'CLOCK_WAIT_MAX_MS:300',
    ]);
  });

  it('a play-request restart retired while waiting: one cancelled wait', async () => {
    const s = await scene();
    const attempt = await parkPlayRequest(s);
    const before = s.read();
    await s.o.context.resumePreparedForegroundAudioContextRestartFromGesture(attempt);
    await vi.advanceTimersByTimeAsync(120);
    expect(s.o.context.retireForegroundAudioContextRestart(attempt)).toBe(true);
    expect(delta(s, before, ['CLOCK_WAITS', 'CLOCK_CANCELLED', 'CLOCK_WAIT_TOTAL_MS'])).toEqual([
      'CLOCK_WAITS:1',
      'CLOCK_CANCELLED:1',
      'CLOCK_WAIT_TOTAL_MS:120',
    ]);
  });

  it('an automatic recovery verified by its probe: one confirmed wait and one rejoin', async () => {
    const s = await scene();
    stageFile(s.o);
    bind(s.o, s.fake);
    const before = s.read();
    s.fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      delta(s, before, [
        'CLOCK_WAITS',
        'CLOCK_CONFIRMED',
        'CLOCK_RECOVERY_NEEDED',
        'CONTEXT_RECOVERED_REJOINS',
      ]),
    ).toEqual(['CLOCK_WAITS:1', 'CLOCK_CONFIRMED:1', 'CONTEXT_RECOVERED_REJOINS:1']);
  });

  it('an automatic recovery whose probe finds the clock frozen: one wait that needs recovery', async () => {
    const s = await scene();
    s.fake.freezeClock();
    stageFile(s.o);
    bind(s.o, s.fake);
    const before = s.read();
    s.fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      delta(s, before, [
        'CLOCK_WAITS',
        'CLOCK_CONFIRMED',
        'CLOCK_RECOVERY_NEEDED',
        'CONTEXT_RECOVERED_REJOINS',
        'CLOCK_WAIT_TOTAL_MS',
      ]),
    ).toEqual(['CLOCK_WAITS:1', 'CLOCK_RECOVERY_NEEDED:1', 'CLOCK_WAIT_TOTAL_MS:360']);
  });
});

describe('suspends, refused taps and overlaps', () => {
  it('both owners suspending one context at once: two leases live', async () => {
    const s = await scene();
    s.fake.planSuspend({ latencyMs: 300 }, { latencyMs: 300 });
    stageFile(s.o);
    bind(s.o, s.fake);
    const before = s.read();
    void s.o.recovery
      .armPendingAudioContextRecoveryFromBackground(s.fake.native)
      .catch(() => undefined);
    const check = s.o.context.armForegroundAudioContextClockHealthCheck(s.fake.native);
    void s.o.context.prepareForegroundAudioContextRestart(check!).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.fake.calls('suspend')).toBe(2);
    expect(s.read()[s.c.LEASES_AT_ONCE_MAX]).toBe(2);
    expect(delta(s, before, ['SUSPEND_CALLS', 'SECOND_SUSPENDS'])).toEqual(['SUSPEND_CALLS:2']);
  });

  it('one owner alone: one lease', async () => {
    const s = await scene();
    await parkPlayRequest(s);
    expect(s.read()[s.c.LEASES_AT_ONCE_MAX]).toBe(1);
    expect(s.read()[s.c.SUSPEND_CALLS]).toBe(1);
  });

  it('taps refused by either owner count once each, and resume nothing', async () => {
    const s = await scene();
    s.fake.planSuspend({ outcome: 'never' });
    stageFile(s.o);
    bind(s.o, s.fake);
    void s.o.recovery
      .armPendingAudioContextRecoveryFromBackground(s.fake.native)
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const before = s.read();

    // The playback scope is still preparing its suspend; a stale restart token.
    await s.o.recovery.resumePendingAudioContextInterruptionFromGesture();
    await s.o.context.resumePreparedForegroundAudioContextRestartFromGesture({});

    expect(s.fake.calls('resume')).toBe(0);
    expect(delta(s, before, ['TAPS_REFUSED', ...RESUME_NAMES])).toEqual(['TAPS_REFUSED:2']);
  });

  // Phase 7 7B-3 (owner answer Q9): a UI sound asks the owners first and does
  // not wake a context one holds for its tap, so "UI sound resumes while
  // waiting for tap" stays 0. Before 7B-3 each of these two rows counted one
  // UI sound resume while waiting, and the file attempt one re-suspend.
  it('a UI sound while a file attempt waits for its tap: no resume, nothing to re-suspend', async () => {
    const s = await scene();
    const touch = await loadUiTouchSound();
    await parkStalledFile(s);
    const before = s.read();
    touch();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.fake.state).toBe('suspended');
    expect(
      delta(s, before, [
        'RESUME_UI_SOUND',
        'UI_SOUND_RESUMES_WHILE_WAITING',
        'RESUSPENDED_AFTER_RUNNING',
        'SUSPEND_CALLS',
      ]),
    ).toEqual([]);
  });

  it('a UI sound while a play-request restart waits for its tap: no resume, nothing counted', async () => {
    const s = await scene();
    const touch = await loadUiTouchSound();
    await parkPlayRequest(s);
    const before = s.read();
    touch();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.fake.state).toBe('suspended');
    expect(delta(s, before, ['RESUME_UI_SOUND', 'UI_SOUND_RESUMES_WHILE_WAITING'])).toEqual([]);
  });

  it('an outside resume while a play-request restart waits for its tap: the owner parks it again', async () => {
    const s = await scene();
    bind(s.o, s.fake);
    await parkPlayRequest(s);
    const before = s.read();
    s.fake.transition('running');
    await vi.advanceTimersByTimeAsync(2_000);
    // Phase 7 7B-2: the re-park is the attempt's next suspend, counted as a
    // re-suspend after running and a second suspend, with no resume of its own.
    expect(s.fake.state).toBe('suspended');
    expect(
      delta(s, before, [
        'RESUSPENDED_AFTER_RUNNING',
        'SUSPEND_CALLS',
        'SECOND_SUSPENDS',
        'TAPS_REFUSED',
        ...RESUME_NAMES,
      ]),
    ).toEqual(['RESUSPENDED_AFTER_RUNNING:1', 'SUSPEND_CALLS:1', 'SECOND_SUSPENDS:1']);
  });

  it('a UI sound with no attempt, or with a YouTube attempt parked, is not counted as waiting', async () => {
    const s = await scene();
    s.fake.freezeClock();
    const touch = await loadUiTouchSound();
    stageYouTube(s.o);
    bind(s.o, s.fake);
    // An OS interruption: automatic resume, then the probe finds the clock
    // frozen and parks the YouTube attempt (no dialog in YouTube mode).
    s.fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.fake.state).toBe('suspended');
    expect(s.o.recovery.hasPendingAudioContextInterruption('youtube')).toBe(true);
    const before = s.read();
    touch();
    await vi.advanceTimersByTimeAsync(0);
    expect(delta(s, before, ['RESUME_UI_SOUND', 'UI_SOUND_RESUMES_WHILE_WAITING'])).toEqual([
      'RESUME_UI_SOUND:1',
    ]);
  });

  it('a hidden page counts nothing for a context it does not touch', async () => {
    const s = await scene();
    stageIdle(s.o);
    bind(s.o, s.fake);
    setVisibility('hidden');
    const before = s.read();
    s.fake.transition('suspended');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.fake.calls('resume')).toBe(0);
    expect(delta(s, before, [...RESUME_NAMES, 'DEADLINES_WATCHED', 'SUSPEND_CALLS'])).toEqual([]);
  });
});
