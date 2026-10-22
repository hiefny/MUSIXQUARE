/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 "AudioContext running state" (docs/design/resource-ownership-registry.md):
 * owner-boundary characterization, structural plan step C1-I4 (Phase 0c).
 *
 * Two machines drive one native AudioContext today: the play-request
 * foreground restart in src/audio/context.ts and the playback-scope
 * interruption recovery in src/audio/context-recovery.ts. These tests pin
 * what they do on unchanged code so later consolidation (Phase 0d, Phase 7)
 * and fix lane G7 can show exactly which behaviour moved.
 *
 * Boundary: the real context.ts, context-recovery.ts, output-health.ts,
 * ui-sounds.ts and media-session.ts with no module mocks. Inputs are the
 * owners' public functions, native `statechange`, `visibilitychange`, state
 * and the Media Session PLAY action. Observations are the platform op log
 * (FakeNativeAudioContext.ops), bus events, state and public queries.
 * Every test loads a fresh module graph, so no owner state, bus listener or
 * DOM listener survives into the next test.
 *
 * Not covered here:
 * - src/app.ts is import-terminal, so its recovery dialog has no unit seam.
 *   Where a test says what the dialog reads, it pins the owner's answer at
 *   the moment app.ts reads it (its 1 s flight race, its 5 s / 50 ms
 *   requirement poll). Browser evidence for the dialog stays in
 *   e2e/background-resume.test.ts and e2e/demo-output-recovery.test.ts.
 * - The trusted pointerdown/keydown path in ui-sounds.ts: jsdom cannot
 *   create a trusted event. Its readyOutput path issues the same unowned
 *   resume() and is used instead.
 * - Real WebKit timing: the fake's header says what it models.
 *
 * Comments marked "Known gap" pin today's behaviour, not the desired one,
 * and name the increment planned to change it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeNativeAudioContext,
  fakeAudioContextConstructor,
  type FakeNativeCallPlan,
} from './__helpers__/fake-audio-context.ts';

const QUEUE_A = '00000000-0000-4000-8000-0000000000a1';
const QUEUE_B = '00000000-0000-4000-8000-0000000000b2';
const GESTURE_DEADLINE_MS = 750;
const PARKED = { pending: true, current: true, gestureToken: 'same' };
const STUCK = { pending: true, current: true, gestureToken: 'none' };
const NO_ATTEMPT = { pending: false, current: false, gestureToken: 'none' };
const QUIET_BUS = { needed: [], neededEvents: [], rejoins: [] };

type Orders = NonNullable<FakeNativeCallPlan['statechange']>;

async function importOwners() {
  const [events, state, constants, context, recovery, playerState] = await Promise.all([
    import('../../core/events.ts'),
    import('../../core/state.ts'),
    import('../../core/constants.ts'),
    import('../context.ts'),
    import('../context-recovery.ts'),
    import('../../player/_state.ts'),
  ]);
  return {
    bus: events.bus,
    setState: state.setState,
    PLAYBACK_STATE: constants.PLAYBACK_STATE,
    context,
    recovery,
    playerState,
  };
}

type Owners = Awaited<ReturnType<typeof importOwners>>;

interface BusRecord {
  readonly needed: string[];
  readonly neededEvents: Array<{ isCurrent?: () => boolean }>;
  readonly rejoins: string[];
}

let loaded: Owners | null = null;
let disposers: Array<() => void> = [];

function setVisibility(state: 'visible' | 'hidden', dispatch = true): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
}

/** Fresh owners whose singleton is `fake`, as engine initialization leaves it. */
async function loadOwners(fake: FakeNativeAudioContext): Promise<Owners> {
  vi.stubGlobal('AudioContext', fakeAudioContextConstructor(fake));
  vi.resetModules();
  loaded = await importOwners();
  expect(loaded.context.getAudioContext()).toBe(fake);
  return loaded;
}

function stageFilePlayback(o: Owners, queueItemId: string = QUEUE_A): void {
  o.setState('setup.sessionStarted', true);
  o.setState('playback.mode', 'file');
  o.setState('playback.activity', 'playing');
  o.setState('playback.lifecycle', o.PLAYBACK_STATE.PLAYING);
  o.setState('playlist.currentQueueItemId', queueItemId);
  o.setState('files.current', {
    name: 'ro01.mp3',
    indexHint: 0,
    size: 10,
    mime: 'audio/mpeg',
    queueItemId,
    sessionId: 1,
    blob: new File(['audio'], 'ro01.mp3', { type: 'audio/mpeg' }),
  });
  o.playerState.setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
}

function bind(o: Owners, fake: FakeNativeAudioContext): () => void {
  const dispose = o.recovery.bindAudioContextInterruptionRecovery(fake.native);
  disposers.push(dispose);
  return dispose;
}

function recordBus(o: Owners): BusRecord {
  const record: BusRecord = { needed: [], neededEvents: [], rejoins: [] };
  o.bus.on('audio:output-recovery-needed', (event) => {
    record.needed.push(`${event.source}:${event.reason}`);
    record.neededEvents.push(event);
  });
  o.bus.on('playback:local-output-rejoin', (event) => {
    record.rejoins.push(event.reason);
  });
  return record;
}

/** Arm a background clock stall the way output-health does, prepared and parked. */
async function parkStalledPlayback(o: Owners, fake: FakeNativeAudioContext): Promise<object> {
  const token = await o.recovery.armPendingAudioContextRecoveryFromBackground(fake.native);
  expect(token).toBeTypeOf('object');
  expect(fake.state).toBe('suspended');
  expect(o.recovery.getPendingAudioContextInterruptionAttempt()).toBe(token);
  return token!;
}

/** Prepare a play-request restart the way transport does on a foreground clock stall. */
async function parkPlayRequestRestart(o: Owners, fake: FakeNativeAudioContext) {
  const check = o.context.armForegroundAudioContextClockHealthCheck(fake.native);
  const preparation = await o.context.prepareForegroundAudioContextRestart(check!);
  expect(preparation).toMatchObject({ status: 'prepared' });
  expect(fake.state).toBe('suspended');
  return { check: check!, preparation: preparation! };
}

/**
 * Public view of the playback-scope owner. It never reads
 * getPendingAudioContextClockHealthRequirement, which promotes a
 * state-interruption attempt as a side effect; tests read that query only
 * where its side effect is part of the pinned behaviour.
 */
function playbackScope(o: Owners, token: object) {
  const gesture = o.recovery.getPendingAudioContextInterruptionAttempt();
  return {
    pending: o.recovery.hasPendingAudioContextInterruption('file'),
    current: o.recovery.isAudioContextInterruptionAttemptCurrent(token),
    gestureToken: gesture === null ? 'none' : gesture === token ? 'same' : 'other',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  disposers = [];
  loaded = null;
  setVisibility('visible', false);
  vi.spyOn(document, 'addEventListener');
  vi.spyOn(window, 'addEventListener');
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  // Every document/window listener this test's module graph added (bindings,
  // Media Session, native-control authority) goes with that graph.
  for (const target of [document, window] as EventTarget[]) {
    const calls = vi.mocked(target.addEventListener).mock.calls;
    for (const [type, listener, options] of calls) {
      target.removeEventListener(type, listener, options);
    }
  }
  loaded?.bus.clear();
  loaded = null;
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(navigator, 'mediaSession');
  localStorage.clear();
});

describe('FakeNativeAudioContext calibration', () => {
  it.each([
    ['before-settle (default)', {}, ['event:running', 'resolved:running']],
    [
      'after-settle',
      { statechange: 'after-settle', stateDelayMs: 100 },
      ['resolved:suspended', 'event:running'],
    ],
    [
      'deferred-event',
      { statechange: 'deferred-event', stateDelayMs: 100 },
      ['resolved:running', 'event:running'],
    ],
    ['silent', { statechange: 'silent' }, ['resolved:running']],
    ['never', { outcome: 'never' }, []],
    ['reject', { outcome: 'reject' }, ['rejected:suspended']],
  ] as Array<[string, FakeNativeCallPlan, string[]]>)(
    'orders a %s resume against its promise',
    async (_label, plan, expected) => {
      const fake = new FakeNativeAudioContext({ state: 'suspended' }).planResume(plan);
      const seen: string[] = [];
      fake.addEventListener('statechange', () => seen.push(`event:${fake.state}`));
      void fake.resume().then(
        () => seen.push(`resolved:${fake.state}`),
        () => seen.push(`rejected:${fake.state}`),
      );

      await vi.advanceTimersByTimeAsync(10_000);

      expect(seen).toEqual(expected);
    },
  );

  it('rejects native calls on a closed context and fires statechange only on change', async () => {
    const fake = new FakeNativeAudioContext();
    let events = 0;
    fake.addEventListener('statechange', () => {
      events += 1;
    });
    await fake.resume();
    await fake.close();
    await expect(fake.resume()).rejects.toMatchObject({ name: 'InvalidStateError' });
    await expect(fake.suspend()).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(events).toBe(1);
    expect(fake.ops).toEqual([
      'resume()',
      'resume:resolved',
      'close()',
      'statechange:closed',
      'resume()',
      'resume:rejected',
      'suspend()',
      'suspend:rejected',
    ]);
  });

  it('advances currentTime only while running and can freeze it while running', async () => {
    const fake = new FakeNativeAudioContext({ clockSeconds: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.currentTime).toBeCloseTo(1, 6);

    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.currentTime).toBeCloseTo(1, 6);

    fake.transition('running');
    fake.freezeClock();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state).toBe('running');
    expect(fake.currentTime).toBeCloseTo(1, 6);

    fake.runClock();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.currentTime).toBeCloseTo(1.5, 6);
  });
});

describe('RO-01 gesture paths issue the native resume inside the activation (C1-I4 a)', () => {
  it.each([
    [
      'play-request restart (context.ts)',
      async (o: Owners, fake: FakeNativeAudioContext) => {
        const { preparation } = await parkPlayRequestRestart(o, fake);
        return () =>
          o.context.resumePreparedForegroundAudioContextRestartFromGesture(
            preparation.attemptToken,
          );
      },
    ],
    [
      'playback-scope stalled recovery (context-recovery.ts)',
      async (o: Owners, fake: FakeNativeAudioContext) => {
        stageFilePlayback(o);
        bind(o, fake);
        await parkStalledPlayback(o, fake);
        return () => o.recovery.resumePendingAudioContextInterruptionFromGesture();
      },
    ],
    [
      'generic dialog restart (restartAudioContextFromGesture)',
      async (o: Owners, fake: FakeNativeAudioContext) => {
        fake.transition('suspended');
        return () => o.context.restartAudioContextFromGesture();
      },
    ],
  ])('%s', async (_label, arrange) => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    const gesture = await arrange(o, fake);
    const before = fake.ops.length;

    const flight = gesture();

    // Synchronous: nothing awaited between the activation and the native call.
    expect(fake.ops.slice(before)).toEqual(['resume()']);
    await vi.advanceTimersByTimeAsync(0);
    await flight;
    expect(fake.state).toBe('running');
  });
});

describe('RO-01 playback-scope interruption recovery', () => {
  const recovered = ['audio-context-recovered'];
  it.each([
    { order: 'before-settle', clock: 'advancing', ops: 'statechange:running resume:resolved' },
    { order: 'after-settle', clock: 'advancing', ops: 'resume:resolved statechange:running' },
    {
      order: 'deferred-event',
      clock: 'advancing',
      ops: 'state:running resume:resolved statechange:running',
    },
    { order: 'silent', clock: 'advancing', ops: 'state:running resume:resolved' },
    {
      order: 'before-settle',
      clock: 'frozen',
      ops: 'statechange:running resume:resolved suspend() statechange:suspended suspend:resolved',
    },
  ] as Array<{ order: Orders; clock: 'advancing' | 'frozen'; ops: string }>)(
    'visible OS interruption, automatic resume $order, clock $clock',
    async ({ order, clock, ops }) => {
      const rejoins = clock === 'frozen' ? [] : recovered;
      const needed = clock === 'frozen' ? ['background-resume:clock-stalled'] : [];
      const fake = new FakeNativeAudioContext();
      if (clock === 'frozen') fake.freezeClock();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      fake.planResume({ statechange: order, stateDelayMs: 100 });

      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(fake.ops.join(' ')).toBe(`os:interrupted statechange:interrupted resume() ${ops}`);
      expect(bus.rejoins).toEqual(rejoins);
      expect(bus.needed).toEqual(needed);
      // A frozen clock leaves one prepared attempt parked for the gesture.
      expect(o.recovery.hasPendingAudioContextInterruption('file')).toBe(clock === 'frozen');
      expect(o.recovery.getPendingAudioContextInterruptionAttempt() !== null).toBe(
        clock === 'frozen',
      );
    },
  );
});

describe('RO-01 play-request foreground restart', () => {
  it('arms one incident per hidden/visible bounce and commits only after a healthy probe', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);

    setVisibility('hidden');
    fake.freezeClock();
    await vi.advanceTimersByTimeAsync(2_000);
    setVisibility('visible');
    const check = o.context.getPendingForegroundAudioContextClockHealthCheck();
    expect(check?.isCurrent()).toBe(true);
    expect(check?.getHiddenContinuityGapSeconds()).toBeCloseTo(2, 3);

    // transport.ts PLAY: probe the incident, prepare on a stall.
    const probe = o.context.probeAudioContextHealth({
      attemptResume: false,
      context: check!.context,
      isCurrent: check!.isCurrent,
    });
    await vi.advanceTimersByTimeAsync(360);
    await expect(probe).resolves.toMatchObject({ reason: 'clock-stalled', state: 'running' });
    const preparation = await o.context.prepareForegroundAudioContextRestart(check!.token);
    expect(preparation).toMatchObject({ status: 'prepared' });

    // The dialog gesture: a real restart brings the clock back.
    fake.runClock();
    await expect(
      o.context.resumePreparedForegroundAudioContextRestartFromGesture(preparation!.attemptToken),
    ).resolves.toEqual({ running: true, requiresClockVerification: true });
    const requirement = o.context.getPendingForegroundAudioContextRestartClockHealthRequirement();
    expect(requirement?.attemptToken).toBe(preparation!.attemptToken);
    const health = o.context.probeAudioContextHealth({
      attemptResume: false,
      context: requirement!.context,
      isCurrent: requirement!.isCurrent,
    });
    await vi.advanceTimersByTimeAsync(180);
    await expect(health).resolves.toMatchObject({ healthy: true });
    expect(o.context.confirmForegroundAudioContextRestartHealth(preparation!.attemptToken)).toBe(
      true,
    );

    expect(o.context.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
    expect(fake.ops.filter((op) => op.endsWith('()'))).toEqual(['suspend()', 'resume()']);
    // This owner publishes nothing on the bus; transport's retry owns the restart.
    expect(bus).toEqual(QUIET_BUS);
    expect(fake.statechangeListenerCount).toBe(1);
  });
});

describe('RO-01 gesture resume slower than the 750 ms deadline (fix lane G7 input)', () => {
  it.each([
    {
      label: 'state flips silently at settlement',
      resume: { statechange: 'silent' } as FakeNativeCallPlan,
      reSuspend: {} as FakeNativeCallPlan,
      end: {
        state: 'running',
        scope: STUCK,
        requirement: 'same',
        needed: [] as string[],
        suspends: 1,
        resumes: 1,
      },
    },
    {
      label: 'state flips at settlement, statechange 100 ms later',
      resume: { statechange: 'deferred-event', stateDelayMs: 100 } as FakeNativeCallPlan,
      reSuspend: {} as FakeNativeCallPlan,
      end: {
        state: 'running',
        scope: STUCK,
        requirement: 'same',
        needed: [],
        suspends: 1,
        resumes: 1,
      },
    },
    {
      label: 'statechange before settlement, re-suspend on a microtask',
      resume: { statechange: 'before-settle' } as FakeNativeCallPlan,
      reSuspend: {} as FakeNativeCallPlan,
      end: {
        state: 'suspended',
        scope: PARKED,
        requirement: 'none',
        needed: ['background-resume:clock-stalled'],
        suspends: 2,
        resumes: 1,
      },
    },
    {
      label: 'statechange before settlement, re-suspend after 50 ms',
      resume: { statechange: 'before-settle' } as FakeNativeCallPlan,
      reSuspend: { latencyMs: 50 } as FakeNativeCallPlan,
      end: {
        state: 'running',
        scope: NO_ATTEMPT,
        requirement: 'none',
        needed: [],
        suspends: 2,
        resumes: 2,
      },
    },
    {
      label: 'statechange 100 ms after settlement',
      resume: { statechange: 'after-settle', stateDelayMs: 100 } as FakeNativeCallPlan,
      reSuspend: {} as FakeNativeCallPlan,
      end: {
        state: 'suspended',
        scope: PARKED,
        requirement: 'none',
        needed: ['background-resume:clock-stalled'],
        suspends: 2,
        resumes: 1,
      },
    },
  ])('playback scope: resume settles at 1200 ms, $label', async ({ resume, reSuspend, end }) => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const token = await parkStalledPlayback(o, fake);
    fake.planResume({ latencyMs: 1_200, ...resume }).planSuspend(reSuspend);

    const gesture = o.recovery.resumePendingAudioContextInterruptionFromGesture();
    await vi.advanceTimersByTimeAsync(GESTURE_DEADLINE_MS);

    // What app.ts (dialog flight, settles before its 1 s race) and
    // media-session.ts read: not running, nothing to verify, and both give up.
    await expect(gesture).resolves.toEqual({
      running: false,
      rejoinEmitted: false,
      fallbackEligible: false,
    });
    expect(playbackScope(o, token)).toEqual(PARKED);
    expect(o.recovery.getPendingAudioContextClockHealthRequirement()).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);

    // Known gap (fix lane G7): when the state is already running at
    // settlement (no event, or an event after it), the attempt ends in
    // awaiting-clock-verification with an exposed requirement, but a
    // gesture-source promotion schedules no probe (context-recovery.ts
    // handleNativeResumeSettlement) and a later running statechange keeps that
    // phase, so nobody commits or rejoins. The 50 ms row retires the attempt
    // and resumes without any clock proof.
    const requirement = o.recovery.getPendingAudioContextClockHealthRequirement();
    expect(fake.state).toBe(end.state);
    expect(playbackScope(o, token)).toEqual(end.scope);
    expect(
      requirement === null ? 'none' : requirement.attemptToken === token ? 'same' : 'other',
    ).toBe(end.requirement);
    if (requirement) expect(requirement.isCurrent()).toBe(true);
    expect(bus.rejoins).toEqual([]);
    expect(bus.needed).toEqual(end.needed);
    expect(fake.calls('suspend')).toBe(end.suspends);
    expect(fake.calls('resume')).toBe(end.resumes);
  });

  it('playback scope stuck row: a hidden/visible bounce leaves it stuck and the inspector defers to it', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    const { inspectBackgroundFileOutput } = await import('../output-health.ts');
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const token = await parkStalledPlayback(o, fake);
    fake.planResume({ latencyMs: 1_200, statechange: 'silent' });
    const gesture = o.recovery.resumePendingAudioContextInterruptionFromGesture();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(gesture).resolves.toMatchObject({ running: false });

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(5_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(5_000);

    // Known gap (fix lane G7): the foreground bounce only consumes its
    // incident for a background-clock-stalled attempt, and the background
    // inspector reports this attempt as the owner (app.ts then yields).
    expect(o.context.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
    await expect(inspectBackgroundFileOutput()).resolves.toMatchObject({
      status: 'stale',
      reason: 'superseded',
    });
    expect(o.recovery.getPendingAudioContextClockHealthRequirement()?.attemptToken).toBe(token);
    expect(playbackScope(o, token)).toEqual(STUCK);
    expect(bus).toEqual(QUIET_BUS);
    expect(fake.calls('resume')).toBe(1);
  });

  it.each(['before-settle', 'deferred-event', 'after-settle', 'silent'] as Orders[])(
    'play-request scope: resume settles at 1200 ms (%s) and is promoted for the dialog poll',
    async (order) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const { preparation } = await parkPlayRequestRestart(o, fake);
      fake.planResume({ latencyMs: 1_200, statechange: order, stateDelayMs: 100 });

      const gesture = o.context.resumePreparedForegroundAudioContextRestartFromGesture(
        preparation.attemptToken,
      );
      await vi.advanceTimersByTimeAsync(GESTURE_DEADLINE_MS);
      await expect(gesture).resolves.toEqual({ running: false, requiresClockVerification: false });
      expect(o.context.getPendingForegroundAudioContextRestartClockHealthRequirement()).toBeNull();
      expect(preparation.isCurrent()).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);

      // The resume listener stays armed past the deadline, so every ordering
      // reaches awaiting-clock-verification. Only app.ts's 5 s / 50 ms poll
      // (waitForForegroundRestartClockRequirement) reads it; the owner has no
      // deadline of its own, so it stays exposed until someone retires it.
      const requirement = o.context.getPendingForegroundAudioContextRestartClockHealthRequirement();
      expect(requirement?.attemptToken).toBe(preparation.attemptToken);
      expect(requirement?.isCurrent()).toBe(true);
      expect(fake.state).toBe('running');
      expect(fake.calls('resume')).toBe(1);
      expect(fake.statechangeListenerCount).toBe(1);
      expect(bus).toEqual(QUIET_BUS);
    },
  );
});

describe('RO-01 resumes from outside the owners (C1-I4 b, d, e)', () => {
  const outsideResumers: Array<
    [string, (o: Owners, fake: FakeNativeAudioContext) => Promise<void>]
  > = [
    [
      'an OS or user-agent resume',
      async (_o, fake) => {
        fake.transition('running');
      },
    ],
    [
      'ensureRunning (transport, decode, engine)',
      async (o) => {
        await o.context.ensureRunning().catch(() => undefined);
      },
    ],
    [
      'a UI sound (ui-sounds.ts readyOutput)',
      async () => {
        const ui = await import('../ui-sounds.ts');
        ui.setUiSoundsEnabled(true);
        ui.playUiTouchSound();
      },
    ],
  ];

  it.each(outsideResumers)(
    'play-request restart parked for its gesture is defeated by %s',
    async (_label, resumeOutside) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      bind(o, fake);
      const { preparation } = await parkPlayRequestRestart(o, fake);

      await resumeOutside(o, fake);
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.state).toBe('running');

      // Known gap (C1-I13 a/b, owner decision pending): nothing listens in
      // awaiting-gesture, so the attempt still claims the context and the
      // Restore gesture is refused without a native resume. app.ts then
      // polls 5 s for a requirement that never appears and re-arms.
      expect(preparation.isCurrent()).toBe(true);
      const before = fake.ops.length;
      await expect(
        o.context.resumePreparedForegroundAudioContextRestartFromGesture(preparation.attemptToken),
      ).resolves.toEqual({ running: false, requiresClockVerification: false });
      expect(fake.ops.slice(before)).toEqual([]);
      expect(o.context.getPendingForegroundAudioContextRestartClockHealthRequirement()).toBeNull();
    },
  );

  it.each(outsideResumers)(
    'playback-scope stalled recovery re-suspends with the same token after %s',
    async (_label, resumeOutside) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const token = await parkStalledPlayback(o, fake);

      await resumeOutside(o, fake);
      await vi.advanceTimersByTimeAsync(0);

      expect(fake.state).toBe('suspended');
      expect(fake.calls('suspend')).toBe(2);
      expect(playbackScope(o, token)).toEqual(PARKED);
      expect(bus.needed).toEqual(['background-resume:clock-stalled']);
      expect(bus.neededEvents[0]?.isCurrent?.()).toBe(true);
    },
  );

  it('ensureRunning fails while a playback-scope attempt holds the context', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    bind(o, fake);
    await parkStalledPlayback(o, fake);

    // The binding re-suspends inside the same statechange, so the PLAY that
    // called ensureRunning sees a suspended context after its own resume.
    await expect(o.context.ensureRunning()).rejects.toMatchObject({
      name: 'AudioContextNotRunningError',
      state: 'suspended',
    });
  });

  it('a gesture during the re-suspend is refused, and the prepared event arrives after it', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const token = await parkStalledPlayback(o, fake);
    fake.planSuspend({ latencyMs: 50 });

    // Pointerdown resumes (ui-sounds), the click activation follows a task later.
    fake.transition('running');
    await vi.advanceTimersByTimeAsync(0);
    const before = fake.ops.length;
    await expect(o.recovery.resumePendingAudioContextInterruptionFromGesture()).resolves.toEqual({
      running: false,
      rejoinEmitted: false,
      fallbackEligible: false,
    });
    expect(fake.ops.slice(before)).toEqual([]);
    expect(bus.needed).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(playbackScope(o, token).gestureToken).toBe('same');
  });
});

describe('RO-01 both machines on one context (C1-I4 f)', () => {
  it('a PLAY-time restart during state-interruption verification leaves two live tokens', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);

    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(10);
    const semantic = o.recovery.getPendingAudioContextRecoveryAttemptForHealth();
    expect(semantic).toBeTypeOf('object');

    // transport.ts PLAY with a foreground incident and a stalled sample.
    const check = o.context.armForegroundAudioContextClockHealthCheck(fake.native);
    const preparation = await o.context.prepareForegroundAudioContextRestart(check!);
    expect(preparation).toMatchObject({ status: 'prepared' });
    // Only the binding still listens: the play-request lease has settled.
    expect(fake.statechangeListenerCount).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);

    // The binding deferred the suspend to the play-request lease; the
    // automatic probe then saw not-running and published its own prompt.
    // Known gap (C1-I14, owner decision): two attempts, two prompts' worth
    // of tokens on one context.
    expect(bus.needed).toEqual(['background-resume:context-not-running']);
    expect(bus.rejoins).toEqual([]);
    expect(fake.state).toBe('suspended');
    expect(playbackScope(o, semantic!)).toEqual(PARKED);
    expect(preparation!.isCurrent()).toBe(true);
    expect(fake.ops.filter((op) => op.endsWith('()'))).toEqual(['resume()', 'suspend()']);
  });
});

describe('RO-01 retire, cancel and escalate', () => {
  it('escalates only after the side-effecting requirement query promotes the attempt', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const token = await o.recovery.armPendingAudioContextRecoveryFromBackground(
      fake.native,
      'state-interruption',
    );
    expect(token).toBeTypeOf('object');

    await expect(
      o.recovery.escalatePendingAudioContextRecoveryToClockStalled(token!),
    ).resolves.toBe('rejected');
    // Known gap (C1-I5): this query moves awaiting-resume to
    // awaiting-clock-verification while the context is running.
    expect(o.recovery.getPendingAudioContextClockHealthRequirement()?.attemptToken).toBe(token);
    await expect(o.recovery.escalatePendingAudioContextRecoveryToClockStalled({})).resolves.toBe(
      'rejected',
    );

    fake.planSuspend({ latencyMs: 600 });
    const escalation = o.recovery.escalatePendingAudioContextRecoveryToClockStalled(token!);
    await vi.advanceTimersByTimeAsync(500);
    await expect(escalation).resolves.toBe('preparing');
    expect(bus.needed).toEqual([]);
    expect(playbackScope(o, token!).gestureToken).toBe('none');

    await vi.advanceTimersByTimeAsync(100);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(playbackScope(o, token!).gestureToken).toBe('same');
    await expect(
      o.recovery.escalatePendingAudioContextRecoveryToClockStalled(token!),
    ).resolves.toBe('prepared');
  });

  it('cancelling a playback attempt leaves the context suspended; retiring a restart resumes it', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    bind(o, fake);
    const token = await parkStalledPlayback(o, fake);

    expect(o.recovery.cancelPendingAudioContextRecovery({})).toBe(false);
    expect(o.recovery.cancelPendingAudioContextRecovery(token)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(playbackScope(o, token)).toEqual(NO_ATTEMPT);
    expect(fake.state).toBe('suspended');
    expect(fake.calls('resume')).toBe(0);

    fake.transition('running');
    const { preparation } = await parkPlayRequestRestart(o, fake);
    expect(o.context.retireForegroundAudioContextRestart({})).toBe(false);
    expect(o.context.retireForegroundAudioContextRestart(preparation.attemptToken)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(preparation.isCurrent()).toBe(false);
    expect(o.context.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
    // Visible retire restores through the retired-suspend cleanup resume.
    expect(fake.state).toBe('running');
    expect(fake.calls('resume')).toBe(1);
  });
});

describe('RO-01 supersession and teardown', () => {
  it('a newer incident retires a parked restart without restoring and adopts its suspension', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    bind(o, fake);
    const first = await parkPlayRequestRestart(o, fake);

    const second = o.context.armForegroundAudioContextClockHealthCheck(fake.native);
    expect(first.preparation.isCurrent()).toBe(false);
    expect(fake.state).toBe('suspended');
    const preparation = await o.context.prepareForegroundAudioContextRestart(second!);

    expect(preparation).toMatchObject({ status: 'prepared' });
    expect(preparation!.attemptToken).not.toBe(first.preparation.attemptToken);
    expect(fake.ops.filter((op) => op.endsWith('()'))).toEqual(['suspend()']);
  });

  it('disposing the binding during a slow gesture resume leaves no owner or listener', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    const dispose = bind(o, fake);
    const token = await parkStalledPlayback(o, fake);
    fake.planResume({ latencyMs: 1_200 });

    const gesture = o.recovery.resumePendingAudioContextInterruptionFromGesture();
    await vi.advanceTimersByTimeAsync(300);
    dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    setVisibility('hidden');
    setVisibility('visible');

    // The deadline settles first; the retired attempt reports not running.
    await expect(gesture).resolves.toEqual({
      running: false,
      rejoinEmitted: false,
      fallbackEligible: false,
    });
    expect(fake.state).toBe('running');
    expect(playbackScope(o, token)).toEqual(NO_ATTEMPT);
    expect(o.context.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
    expect(fake.statechangeListenerCount).toBe(0);
    expect(bus).toEqual(QUIET_BUS);
  });

  it('rebinding a new context retires the old attempt and leaves the old context suspended', async () => {
    const oldFake = new FakeNativeAudioContext();
    const o = await loadOwners(oldFake);
    stageFilePlayback(o);
    bind(o, oldFake);
    const token = await parkStalledPlayback(o, oldFake);

    const newFake = new FakeNativeAudioContext();
    bind(o, newFake);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(playbackScope(o, token)).toEqual(NO_ATTEMPT);
    expect(oldFake.state).toBe('suspended');
    expect(oldFake.calls('resume')).toBe(0);
    // The old binding's listener stays until its own disposer runs.
    expect(oldFake.statechangeListenerCount).toBe(1);
    expect(newFake.statechangeListenerCount).toBe(1);
  });

  it('a new track after a queue change pays one stale re-suspend before ensureRunning succeeds', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const token = await parkStalledPlayback(o, fake);

    stageFilePlayback(o, QUEUE_B);
    const before = fake.ops.length;
    await expect(o.context.ensureRunning()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);

    // The binding re-prepares the parked attempt without checking its
    // identity, retires it when that suspend lands, and the retired-suspend
    // cleanup resumes again before transport's ensureRunning reads the state.
    const calls = fake.ops.slice(before).filter((op) => op.endsWith('()'));
    expect(calls).toEqual(['resume()', 'suspend()', 'resume()']);
    expect(fake.state).toBe('running');
    expect(playbackScope(o, token)).toEqual(NO_ATTEMPT);
    expect(bus).toEqual(QUIET_BUS);
  });
});

describe('RO-01 Media Session PLAY gesture path', () => {
  async function loadMediaSession(): Promise<() => void> {
    const handlers = new Map<string, MediaSessionActionHandler>();
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: {
        metadata: null,
        playbackState: 'none',
        setActionHandler(action: string, handler: MediaSessionActionHandler | null) {
          if (handler) handlers.set(action, handler);
        },
      },
    });
    const { initMediaSession } = await import('../../player/media-session.ts');
    initMediaSession();
    return () => handlers.get('play')!({ action: 'play' });
  }

  it('resumes a pending interruption inside the action and leaves one recovered rejoin', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const play = await loadMediaSession();
    fake.planResume({ outcome: 'reject' });
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(0);
    expect(o.recovery.hasPendingAudioContextInterruption('file')).toBe(true);

    const before = fake.ops.length;
    play();
    expect(fake.ops.slice(before)).toEqual(['resume()']);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(o.recovery.hasPendingAudioContextInterruption()).toBe(false);
  });

  it('G7 stuck row: a later hardware PLAY is a no-op for the parked attempt', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const play = await loadMediaSession();
    const token = await parkStalledPlayback(o, fake);
    fake.planResume({ latencyMs: 1_200, statechange: 'silent' });

    play();
    await vi.advanceTimersByTimeAsync(2_000);
    const before = fake.ops.length;
    play();
    await vi.advanceTimersByTimeAsync(2_000);

    // Known gap (fix lane G7): hasPending is true but no gesture token is
    // exposed, so media-session.ts returns before any resume or rejoin.
    expect(fake.ops.slice(before)).toEqual([]);
    expect(playbackScope(o, token)).toEqual(STUCK);
    expect(bus).toEqual(QUIET_BUS);
  });
});
