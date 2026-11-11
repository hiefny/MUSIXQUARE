/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 "AudioContext running state" (docs/design/resource-ownership-registry.md):
 * owner-boundary characterization, structural plan step C1-I4 (Phase 0c).
 *
 * One owner drives one native AudioContext: src/audio/context-recovery.ts,
 * whose recovery attempts are one type with two scopes since Phase 7 7C-5
 * (the play-request foreground restart and the playback-scope interruption
 * recovery). These tests pin what both do on unchanged code so consolidation
 * (Phase 0d, Phase 7) and fix lane G7 can show exactly which behaviour moved.
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
 *   the moment app.ts reads it (its 1 s flight race, and since Phase 7 7B-5
 *   its wait of at most 5 s on the owner's answer for the requirement).
 *   Browser evidence for the dialog stays in e2e/background-resume.test.ts,
 *   e2e/demo-output-recovery.test.ts and the local lab in e2e/audio-lab/.
 * - The trusted pointerdown/keydown path in ui-sounds.ts: jsdom cannot
 *   create a trusted event. Its readyOutput path asks the owners the same
 *   question first (Phase 7 7B-3) and issues the same resume() when no owner
 *   holds the context, and is used instead.
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
/** Awaiting clock verification: a background-clock-stalled attempt exposes no gesture token. */
const VERIFYING = { pending: true, current: true, gestureToken: 'none' };
/** Awaiting clock verification: a state-interruption attempt still accepts a gesture. */
const VERIFYING_ACCEPTING_GESTURE = { pending: true, current: true, gestureToken: 'same' };
const NO_ATTEMPT = { pending: false, current: false, gestureToken: 'none' };
/** A committed attempt stays the active one until a newer attempt or a rebind. */
const COMPLETED = { pending: false, current: true, gestureToken: 'none' };
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
  // `context` keeps the play-request restart's names these rows read since
  // Phase 7 7C-4 moved it into context-recovery.ts: context.ts's own exports,
  // the owner's exported ones and its sub-steps (its one test seam).
  const {
    claimPlayRequestAttemptForDialog,
    confirmPlayRequestAttemptHealth,
    consumeForegroundAudioContextClockHealthCheck,
    getPendingForegroundAudioContextClockHealthCheck,
    isPlayRequestRestartOwned,
    retireAudioContextRecoveryAttempt,
    whenPlayRequestAttemptReprepared,
    ownerSubStepsForTests,
  } = recovery;
  return {
    bus: events.bus,
    setState: state.setState,
    PLAYBACK_STATE: constants.PLAYBACK_STATE,
    context: {
      ...context,
      claimPlayRequestAttemptForDialog,
      confirmPlayRequestAttemptHealth,
      consumeForegroundAudioContextClockHealthCheck,
      getPendingForegroundAudioContextClockHealthCheck,
      isPlayRequestRestartOwned,
      retireAudioContextRecoveryAttempt,
      whenPlayRequestAttemptReprepared,
      ...ownerSubStepsForTests,
    },
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
  const token = await o.recovery.armPlaybackScopeAttemptFromBackground(fake.native);
  expect(token).toBeTypeOf('object');
  expect(fake.state).toBe('suspended');
  expect(o.recovery.getPendingPlaybackScopeAttemptForGesture()).toBe(token);
  return token!;
}

/**
 * An OS interruption whose automatic resume was refused (visible, or hidden
 * while a file plays): a state-interruption attempt in awaiting-resume.
 */
async function parkInterruptedPlayback(o: Owners, fake: FakeNativeAudioContext): Promise<object> {
  fake.planResume({ outcome: 'reject' });
  fake.transition('interrupted');
  await vi.advanceTimersByTimeAsync(1_000);
  const token = o.recovery.getPendingPlaybackScopeAttemptForGesture();
  expect(token).toBeTypeOf('object');
  expect(fake.state).toBe('interrupted');
  expect(fake.calls('resume')).toBe(1);
  return token!;
}

/** Install media-session.ts on a stub navigator.mediaSession; returns its PLAY handler. */
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

/**
 * app.ts's recovery dialog takes a play-request attempt when it shows that
 * attempt's request. Only such an attempt is parked again after an outside
 * resume and holds the context for its tap (Phase 7 7B-2 and 7B-3).
 */
function dialogTakes(o: Owners, attemptToken: object): void {
  o.context.claimPlayRequestAttemptForDialog(attemptToken);
}

/**
 * Prepare a play-request restart the way transport does on a foreground
 * clock stall; the dialog its notice opens takes it, unless `dialog` is
 * false (the notice never became a dialog).
 */
async function parkPlayRequestRestart(
  o: Owners,
  fake: FakeNativeAudioContext,
  { dialog = true }: { dialog?: boolean } = {},
) {
  const check = o.context.armForegroundAudioContextClockHealthCheck(fake.native);
  const preparation = await o.context.preparePlayRequestRestart(check!);
  expect(preparation).toMatchObject({ status: 'prepared' });
  expect(fake.state).toBe('suspended');
  if (dialog) dialogTakes(o, preparation!.attemptToken);
  return { check: check!, preparation: preparation! };
}

/** Public view of the playback-scope owner, from its exported queries only. */
function playbackScope(o: Owners, token: object) {
  const gesture = o.recovery.getPendingPlaybackScopeAttemptForGesture();
  return {
    pending: o.recovery.hasPendingPlaybackScopeAttempt('file'),
    current: o.recovery.isPlaybackScopeAttemptCurrent(token),
    gestureToken: gesture === null ? 'none' : gesture === token ? 'same' : 'other',
  };
}

/**
 * The clock requirement a gesture's recovery checks next, read from the
 * owner's exported queries (since Phase 7 7C-1 the owner reads it itself;
 * nothing here promotes an attempt): the pending attempt while the context
 * runs and no owner holds it for a tap, current while that attempt is the
 * live one. The rows that read it read attempts their resume already
 * promoted, or none.
 */
function clockRequirement(o: Owners): { attemptToken: object; isCurrent(): boolean } | null {
  const attemptToken = o.recovery.getPendingPlaybackScopeAttemptForHealth();
  if (
    !attemptToken ||
    String(o.context.getExistingAudioContext()?.state) !== 'running' ||
    o.recovery.isAudioOutputRecoveryHolding()
  ) {
    return null;
  }
  return {
    attemptToken,
    isCurrent: () => o.recovery.isPlaybackScopeAttemptCurrent(attemptToken),
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
          o.context.resumePreparedPlayRequestRestartFromGesture(preparation.attemptToken);
      },
    ],
    [
      'playback-scope stalled recovery (context-recovery.ts)',
      async (o: Owners, fake: FakeNativeAudioContext) => {
        stageFilePlayback(o);
        bind(o, fake);
        await parkStalledPlayback(o, fake);
        return () => o.recovery.beginPlaybackScopeRecoveryFromGesture();
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
      expect(o.recovery.hasPendingPlaybackScopeAttempt('file')).toBe(clock === 'frozen');
      expect(o.recovery.getPendingPlaybackScopeAttemptForGesture() !== null).toBe(
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
    const preparation = await o.context.preparePlayRequestRestart(check!.token);
    expect(preparation).toMatchObject({ status: 'prepared' });

    // The dialog gesture: a real restart brings the clock back.
    fake.runClock();
    await expect(
      o.context.resumePreparedPlayRequestRestartFromGesture(preparation!.attemptToken),
    ).resolves.toEqual({ running: true, requiresClockVerification: true });
    const requirement = o.context.getPlayRequestClockRequirement();
    expect(requirement?.attemptToken).toBe(preparation!.attemptToken);
    const health = o.context.probeAudioContextHealth({
      attemptResume: false,
      context: requirement!.context,
      isCurrent: requirement!.isCurrent,
    });
    await vi.advanceTimersByTimeAsync(180);
    await expect(health).resolves.toMatchObject({ healthy: true });
    expect(o.context.confirmPlayRequestAttemptHealth(preparation!.attemptToken)).toBe(true);

    expect(o.context.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
    expect(fake.ops.filter((op) => op.endsWith('()'))).toEqual(['suspend()', 'resume()']);
    // This owner publishes nothing on the bus; transport's retry owns the restart.
    expect(bus).toEqual(QUIET_BUS);
    expect(fake.statechangeListenerCount).toBe(1);
  });
});

describe('RO-01 gesture resume slower than the 750 ms deadline (fix lane G7)', () => {
  /** The owner verifies its own late resume and rejoins once, with no further native call. */
  const RECOVERED = {
    state: 'running',
    scope: COMPLETED,
    requirement: 'none',
    rejoins: ['audio-context-recovered'],
    needed: [] as string[],
    suspends: 1,
    resumes: 1,
  };
  it.each([
    {
      label: 'state flips silently at settlement',
      resume: { statechange: 'silent' } as FakeNativeCallPlan,
      reSuspend: {} as FakeNativeCallPlan,
      end: RECOVERED,
    },
    {
      label: 'state flips at settlement, statechange 100 ms later',
      resume: { statechange: 'deferred-event', stateDelayMs: 100 } as FakeNativeCallPlan,
      reSuspend: {} as FakeNativeCallPlan,
      end: RECOVERED,
    },
    {
      // The fake's zero-latency default for the re-suspend that no longer
      // comes. Before Phase 7 7B-5 (Known gap C1-I11/I12) the owner suspended
      // again and asked for a second gesture: state suspended, PARKED, a
      // clock-stalled notice, 2 suspends.
      label: 'statechange before settlement, re-suspend on a microtask',
      resume: { statechange: 'before-settle' } as FakeNativeCallPlan,
      reSuspend: {} as FakeNativeCallPlan,
      end: RECOVERED,
    },
    {
      // Before 7B-5 (Known gap C1-I11/I12) the settlement's promotion
      // stranded the re-suspend's lease, the attempt retired and the cleanup
      // resumed it with no clock proof or rejoin: running, NO_ATTEMPT,
      // 2 suspends, 2 resumes.
      label: 'statechange before settlement, re-suspend after 50 ms',
      resume: { statechange: 'before-settle' } as FakeNativeCallPlan,
      reSuspend: { latencyMs: 50 } as FakeNativeCallPlan,
      end: RECOVERED,
    },
    {
      // Before 7B-5 (Known gap C1-I11/I12) as the microtask row: a second
      // gesture asked for.
      label: 'statechange 100 ms after settlement',
      resume: { statechange: 'after-settle', stateDelayMs: 100 } as FakeNativeCallPlan,
      reSuspend: {} as FakeNativeCallPlan,
      end: RECOVERED,
    },
  ])('stalled cause: resume settles at 1200 ms, $label', async ({ resume, reSuspend, end }) => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const token = await parkStalledPlayback(o, fake);
    fake.planResume({ latencyMs: 1_200, ...resume }).planSuspend(reSuspend);

    const gesture = o.recovery.beginPlaybackScopeRecoveryFromGesture();
    await vi.advanceTimersByTimeAsync(GESTURE_DEADLINE_MS);

    // What the dialog's flight (settled before the 1 s wait, the owner's since
    // 7C-2) and media-session.ts read: not running, nothing to verify, both give up.
    await expect(gesture).resolves.toEqual({
      running: false,
      rejoinEmitted: false,
    });
    expect(playbackScope(o, token)).toEqual(PARKED);
    expect(clockRequirement(o)).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);

    // Fix lane G7: the gesture caller gave up at the deadline, so the owner
    // runs its own exact clock probe on its late running state and commits
    // one rejoin with no further native call. Before G7 the silent and
    // deferred-event rows stayed in awaiting-clock-verification with no
    // prober and no gesture token until a reload.
    // C1-I11/I12 (Phase 7 7B-5, owner answer Q7; they were Known gaps): the
    // owner hears its own late resume as its own whichever way the running
    // state arrives, through the one recovery resume's promotion (the
    // dispatcher's last part, or the native promise). Before, when the
    // running event came first or alone, the binding took it for an outside
    // resume and prepared the attempt again (the three rows' notes say what
    // followed). An outside resume while this resume is still pending looks
    // the same to the owner and is verified the same way.
    const requirement = clockRequirement(o);
    expect(fake.state).toBe(end.state);
    expect(playbackScope(o, token)).toEqual(end.scope);
    expect(
      requirement === null ? 'none' : requirement.attemptToken === token ? 'same' : 'other',
    ).toBe(end.requirement);
    if (requirement) expect(requirement.isCurrent()).toBe(true);
    expect(bus.rejoins).toEqual(end.rejoins);
    expect(bus.needed).toEqual(end.needed);
    expect(fake.calls('suspend')).toBe(end.suspends);
    expect(fake.calls('resume')).toBe(end.resumes);
  });

  it.each(
    (['background-clock-stalled', 'state-interruption'] as const).flatMap((cause) =>
      (['silent', 'deferred-event'] as Orders[]).map((order) => ({ cause, order })),
    ),
  )(
    '$cause cause: a late resume ($order) that settles while hidden is verified on the visible edge',
    async ({ cause, order }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      const { inspectBackgroundFileOutput } = await import('../output-health.ts');
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const token =
        cause === 'background-clock-stalled'
          ? await parkStalledPlayback(o, fake)
          : await parkInterruptedPlayback(o, fake);
      const resumesBefore = fake.calls('resume');
      fake.planResume({ latencyMs: 1_200, statechange: order, stateDelayMs: 100 });

      // The user taps Restore and locks the screen before the route settles.
      const gesture = o.recovery.beginPlaybackScopeRecoveryFromGesture();
      await vi.advanceTimersByTimeAsync(300);
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(gesture).resolves.toMatchObject({ running: false });

      // Hidden: no clock proof is possible, so the attempt waits, running.
      expect(fake.state).toBe('running');
      expect(playbackScope(o, token)).toEqual(
        cause === 'background-clock-stalled' ? VERIFYING : VERIFYING_ACCEPTING_GESTURE,
      );
      expect(clockRequirement(o)?.attemptToken).toBe(token);
      expect(bus.rejoins).toEqual([]);
      // While it waits, the background inspector defers to this attempt.
      await expect(inspectBackgroundFileOutput()).resolves.toMatchObject({
        status: 'stale',
        reason: 'superseded',
      });

      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(2_000);

      // Fix lane G7: the visible edge proves the clock for either cause
      // (continueRecoveryInForeground). Before G7 it ignored the
      // background-clock-stalled cause, which then stayed in
      // awaiting-clock-verification with no prober and no gesture token.
      expect(bus.rejoins).toEqual(['audio-context-recovered']);
      expect(playbackScope(o, token)).toEqual(COMPLETED);
      expect(o.context.getPendingForegroundAudioContextClockHealthCheck()).toBeNull();
      expect(bus.needed).toEqual([]);
      // Proof only: the gesture's resume is the last native call.
      expect(fake.calls('resume')).toBe(resumesBefore + 1);
      expect(fake.calls('suspend')).toBe(cause === 'background-clock-stalled' ? 1 : 0);
    },
  );

  // The C1 critique's G7 scenario (a slow Bluetooth or route-change resume)
  // is this cause: the deadline falls back to awaiting-resume, not
  // awaiting-gesture, so the gesture token stays exposed throughout.
  it.each(
    (['before-settle', 'after-settle', 'deferred-event', 'silent'] as Orders[]).flatMap((order) =>
      (['dialog', 'Media Session PLAY'] as const).map((via) => ({ order, via })),
    ),
  )(
    'state-interruption cause: $via resume settles at 1200 ms ($order) and recovers',
    async ({ order, via }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const play = await loadMediaSession();
      const token = await parkInterruptedPlayback(o, fake);
      expect(playbackScope(o, token)).toEqual(PARKED);
      fake.planResume({ latencyMs: 1_200, statechange: order, stateDelayMs: 100 });

      const before = fake.ops.length;
      let gesture: Promise<unknown> | null = null;
      if (via === 'dialog') gesture = o.recovery.beginPlaybackScopeRecoveryFromGesture();
      else play();
      expect(fake.ops.slice(before)).toEqual(['resume()']);
      await vi.advanceTimersByTimeAsync(GESTURE_DEADLINE_MS);

      // At the deadline both callers give up (media-session.ts returns on
      // running:false); the attempt is back in awaiting-resume.
      if (gesture) {
        await expect(gesture).resolves.toEqual({
          running: false,
          rejoinEmitted: false,
        });
      }
      expect(fake.state).toBe('interrupted');
      expect(playbackScope(o, token)).toEqual(PARKED);
      // Safe to read: no promotion while the state is not running.
      expect(clockRequirement(o)).toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(fake.state).toBe('running');
      // Already completed, so this read promotes nothing.
      const requirement = clockRequirement(o);
      // Fix lane G7: the gesture caller gave up at the deadline, so the late
      // promotion starts the owner's automatic probe
      // (scheduleAutomaticClockVerification). Since Phase 7 7B-5 the gesture's
      // own recovery resume promotes it whichever way the running state
      // arrives; before, a running statechange reached the binding, which
      // found awaiting-resume and started the same probe. Before G7 the
      // deferred-event and silent rows stayed in awaiting-clock-verification
      // until a visibility bounce or one more PLAY.
      expect(playbackScope(o, token)).toEqual(COMPLETED);
      expect(requirement).toBeNull();
      expect(bus.rejoins).toEqual(['audio-context-recovered']);
      expect(bus.needed).toEqual([]);
      expect(fake.calls('resume')).toBe(2);
      expect(fake.calls('suspend')).toBe(0);
    },
  );

  it.each(['background-clock-stalled', 'state-interruption'] as const)(
    '%s cause: a resume inside the deadline leaves the clock proof to the gesture caller',
    async (cause) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const token =
        cause === 'background-clock-stalled'
          ? await parkStalledPlayback(o, fake)
          : await parkInterruptedPlayback(o, fake);
      fake.planResume({ latencyMs: 400, statechange: 'silent' });

      // The dialog's flight, with no caller-side probe after it.
      const gesture = o.recovery.beginPlaybackScopeRecoveryFromGesture();
      await vi.advanceTimersByTimeAsync(10_000);

      // The G7 handover applies only after the deadline returned the caller:
      // inside it the owner stays out of the caller's probe (the second step
      // the dialog and media-session.ts call reads this requirement and probes).
      await expect(gesture).resolves.toEqual({
        running: true,
        rejoinEmitted: false,
      });
      const requirement = clockRequirement(o);
      expect(requirement?.attemptToken).toBe(token);
      expect(requirement?.isCurrent()).toBe(true);
      expect(bus.rejoins).toEqual([]);
      expect(bus.needed).toEqual([]);
    },
  );

  it.each(['background-clock-stalled', 'state-interruption'] as const)(
    '%s cause: a user pause before a late resume settles retires the attempt',
    async (cause) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const token =
        cause === 'background-clock-stalled'
          ? await parkStalledPlayback(o, fake)
          : await parkInterruptedPlayback(o, fake);
      const resumesBefore = fake.calls('resume');
      fake.planResume({ latencyMs: 1_200, statechange: 'silent' });

      const gesture = o.recovery.beginPlaybackScopeRecoveryFromGesture();
      await vi.advanceTimersByTimeAsync(GESTURE_DEADLINE_MS);
      await expect(gesture).resolves.toMatchObject({ running: false });
      o.setState('playback.activity', 'paused');
      await vi.advanceTimersByTimeAsync(10_000);

      // RO-01 principle 3: the owner's late probe sees the identity gone and
      // retires the attempt instead of committing a rejoin. Before G7 the
      // attempt stayed pending in awaiting-clock-verification.
      expect(fake.state).toBe('running');
      expect(playbackScope(o, token)).toEqual(NO_ATTEMPT);
      expect(clockRequirement(o)).toBeNull();
      expect(bus).toEqual(QUIET_BUS);
      expect(fake.calls('resume')).toBe(resumesBefore + 1);
    },
  );

  it.each(['background-clock-stalled', 'state-interruption'] as const)(
    '%s cause: a late resume whose clock is still frozen is prepared and prompted again',
    async (cause) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const token =
        cause === 'background-clock-stalled'
          ? await parkStalledPlayback(o, fake)
          : await parkInterruptedPlayback(o, fake);
      const suspendsBefore = fake.calls('suspend');
      fake.freezeClock();
      fake.planResume({ latencyMs: 1_200, statechange: 'silent' });

      const gesture = o.recovery.beginPlaybackScopeRecoveryFromGesture();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(gesture).resolves.toMatchObject({ running: false });

      // The owner's late probe is the clock proof: a still-frozen clock is
      // never committed. It re-prepares the same token and asks for one more
      // gesture. Before G7 nothing probed and nothing was asked.
      expect(fake.state).toBe('suspended');
      expect(playbackScope(o, token)).toEqual(PARKED);
      expect(bus.needed).toEqual(['background-resume:clock-stalled']);
      expect(bus.neededEvents[0]?.isCurrent?.()).toBe(true);
      expect(bus.rejoins).toEqual([]);
      expect(fake.calls('suspend')).toBe(suspendsBefore + 1);
    },
  );

  it.each(['background-clock-stalled', 'state-interruption'] as const)(
    'hidden Media Session PLAY (%s cause): the probe sees hidden, then the page returns',
    async (cause) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      const { inspectBackgroundFileOutput } = await import('../output-health.ts');
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const play = await loadMediaSession();
      let token: object;
      if (cause === 'background-clock-stalled') {
        // Parked while visible, then the screen locks.
        token = await parkStalledPlayback(o, fake);
        setVisibility('hidden');
      } else {
        // Interrupted while locked; the hidden automatic resume is refused.
        setVisibility('hidden');
        token = await parkInterruptedPlayback(o, fake);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(playbackScope(o, token)).toEqual(PARKED);

      // Lock-screen PLAY: a prompt resume (default plan), then the owner's second
      // step probes the exposed requirement while hidden and keeps the token.
      const before = fake.ops.length;
      play();
      expect(fake.ops.slice(before)).toEqual(['resume()']);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fake.state).toBe('running');
      expect(clockRequirement(o)?.attemptToken).toBe(token);
      expect(playbackScope(o, token)).toEqual(
        cause === 'background-clock-stalled' ? VERIFYING : VERIFYING_ACCEPTING_GESTURE,
      );
      expect(bus.rejoins).toEqual([]);

      // While hidden, the background inspector defers to this attempt.
      await expect(inspectBackgroundFileOutput()).resolves.toMatchObject({
        status: 'stale',
        reason: 'superseded',
      });

      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(5_000);

      // The visible edge probes the waiting attempt (continueRecoveryInForeground).
      // Fix lane G7: for the background-clock-stalled cause too. Before G7 that
      // cause kept the same no-prober phase as the slow gesture rows, reached
      // here without any slow resume, and a visible PLAY found no token.
      expect(bus.rejoins).toEqual(['audio-context-recovered']);
      expect(playbackScope(o, token)).toEqual(COMPLETED);
      expect(fake.ops.slice(before).filter((op) => op.endsWith('()'))).toEqual(['resume()']);
      expect(bus.needed).toEqual([]);
      expect(fake.state).toBe('running');
    },
  );

  it.each([
    { order: 'before-settle', promotedAtMs: 1_200 },
    { order: 'deferred-event', promotedAtMs: 1_200 },
    { order: 'after-settle', promotedAtMs: 1_300 },
    { order: 'silent', promotedAtMs: 1_200 },
  ] as Array<{ order: Orders; promotedAtMs: number }>)(
    "play-request scope: resume settles at 1200 ms ($order); the dialog's wait settles at the promotion",
    async ({ order, promotedAtMs }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const { preparation } = await parkPlayRequestRestart(o, fake);
      fake.planResume({ latencyMs: 1_200, statechange: order, stateDelayMs: 100 });

      const tapAt = Date.now();
      const gesture = o.context.resumePreparedPlayRequestRestartFromGesture(
        preparation.attemptToken,
      );
      await vi.advanceTimersByTimeAsync(GESTURE_DEADLINE_MS);
      await expect(gesture).resolves.toEqual({ running: false, requiresClockVerification: false });
      expect(o.context.getPlayRequestClockRequirement()).toBeNull();
      expect(preparation.isCurrent()).toBe(true);
      // app.ts's 1 s race has the tap's answer: its wait on the owner starts.
      const answers: string[] = [];
      void o.context.whenPlayRequestClockRequirement(preparation.attemptToken).then(
        (outcome) => answers.push(`${outcome}@${Date.now() - tapAt}`),
        () => undefined,
      );

      await vi.advanceTimersByTimeAsync(10_000);

      // The promotion stays armed past the deadline, so every ordering
      // reaches awaiting-clock-verification, and the dialog's wait settles in
      // that task (C1-I12, Phase 7 7B-5, owner answer Q7: it was app.ts's next
      // 50 ms poll). The owner has no deadline of its own, so the requirement
      // stays exposed until someone retires it.
      expect(answers).toEqual([`promoted@${promotedAtMs}`]);
      const requirement = o.context.getPlayRequestClockRequirement();
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
  // Each with what it does to a context an owner holds for its tap: whether
  // it wakes it, and the native resume() calls it makes.
  const outsideResumers: Array<
    [
      string,
      (o: Owners, fake: FakeNativeAudioContext) => Promise<void>,
      /** On a context an owner holds for its tap. */
      { wakes: boolean; resumes: number },
      /** Native resume() calls on a context no owner holds (each wakes it). */
      number,
    ]
  > = [
    [
      'an OS or user-agent resume',
      async (_o, fake) => {
        fake.transition('running');
      },
      { wakes: true, resumes: 0 },
      0,
    ],
    [
      'ensureRunning (transport, decode, engine)',
      async (o) => {
        await o.context.ensureRunning().catch(() => undefined);
      },
      { wakes: true, resumes: 1 },
      1,
    ],
    [
      // C1-I13 b (Phase 7 7B-3, owner answer Q9; it was a Known gap): a UI
      // sound asks the owners first and, while one holds the context for its
      // tap, makes no sound and no resume, so there is nothing to undo.
      'a UI sound (ui-sounds.ts readyOutput)',
      async () => {
        const ui = await import('../ui-sounds.ts');
        ui.setUiSoundsEnabled(true);
        ui.playUiTouchSound();
      },
      { wakes: false, resumes: 0 },
      1,
    ],
  ];

  it.each(outsideResumers)(
    'play-request restart parked for its gesture is parked when its gesture comes, after %s, and the gesture resumes it',
    async (_label, resumeOutside, { wakes, resumes }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      bind(o, fake);
      const { preparation } = await parkPlayRequestRestart(o, fake);

      await resumeOutside(o, fake);
      await vi.advanceTimersByTimeAsync(0);

      // C1-I13 a (Phase 7 7B-2, owner answer Q8; it was a Known gap): the
      // binding hands the running edge to the play-request owner, which parks
      // the same attempt again at once, as the playback scope re-suspends its
      // own (the next row). The Restore gesture then resumes it with one
      // native call and exposes the clock requirement app.ts waits for.
      // Since 7B-3 a UI sound wakes nothing, so nothing is parked again.
      expect(fake.calls('resume')).toBe(resumes);
      expect(fake.state).toBe('suspended');
      expect(fake.calls('suspend')).toBe(wakes ? 2 : 1);
      expect(preparation.isCurrent()).toBe(true);
      const before = fake.ops.length;
      await expect(
        o.context.resumePreparedPlayRequestRestartFromGesture(preparation.attemptToken),
      ).resolves.toEqual({ running: true, requiresClockVerification: true });
      expect(fake.ops.slice(before).filter((op) => op.endsWith('()'))).toEqual(['resume()']);
      expect(o.context.getPlayRequestClockRequirement()?.attemptToken).toBe(
        preparation.attemptToken,
      );
    },
  );

  it.each(outsideResumers)(
    'play-request restart parked with no dialog (its notice never became one) holds nothing, and %s is not undone',
    async (_label, resumeOutside, _held, resumes) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      const bus = recordBus(o);
      bind(o, fake);
      const { check, preparation } = await parkPlayRequestRestart(o, fake, { dialog: false });
      // The re-park (Phase 7 7B-2) and the holding (7B-3) serve a dialog
      // that waits for its tap. This attempt's notice was declined or
      // dropped (the page hidden, the PLAY replaced, a forced update), so no
      // tap can come for it and nothing holds the context for it.
      const heldWhileParked = o.recovery.isAudioOutputRecoveryHolding();

      await resumeOutside(o, fake);
      await vi.advanceTimersByTimeAsync(0);

      // The resume stands, as before 7B-2: a UI sound wakes the context as
      // with no attempt, and a PLAY's ensureRunning keeps the context it woke.
      // From 7B-2 to this rule the owner parked it again at once.
      expect(fake.state).toBe('running');
      expect(fake.calls('resume')).toBe(resumes);
      expect(fake.calls('suspend')).toBe(1);
      expect(heldWhileParked).toBe(false);
      expect(o.recovery.isAudioOutputRecoveryHolding()).toBe(false);
      expect(o.context.whenPlayRequestAttemptReprepared(preparation.attemptToken)).toBe(null);
      // That PLAY's clock check finds the clock running and retires it.
      const health = o.context.probeAudioContextHealth({
        attemptResume: false,
        context: fake.native,
      });
      await vi.advanceTimersByTimeAsync(180);
      await expect(health).resolves.toMatchObject({ healthy: true });
      expect(o.context.consumeForegroundAudioContextClockHealthCheck(check)).toBe(true);
      expect(preparation.isCurrent()).toBe(false);
      expect(o.context.isPlayRequestRestartOwned(fake.native)).toBe(false);
      expect(fake.calls('suspend')).toBe(1);
      expect(fake.state).toBe('running');
      expect(bus).toEqual(QUIET_BUS);
    },
  );

  it.each(outsideResumers)(
    'playback-scope stalled recovery is parked with the same token after %s',
    async (_label, resumeOutside, { wakes, resumes }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const token = await parkStalledPlayback(o, fake);

      await resumeOutside(o, fake);
      await vi.advanceTimersByTimeAsync(0);

      // A wake is undone by a re-suspend with a prepared notice for the
      // dialog. Since Phase 7 7B-3 (C1-I13 b, owner answer Q9; it was a Known
      // gap) a UI sound wakes nothing: no re-suspend, no second notice.
      expect(fake.calls('resume')).toBe(resumes);
      expect(fake.state).toBe('suspended');
      expect(fake.calls('suspend')).toBe(wakes ? 2 : 1);
      expect(playbackScope(o, token)).toEqual(PARKED);
      expect(bus.needed).toEqual(wakes ? ['background-resume:clock-stalled'] : []);
      if (wakes) expect(bus.neededEvents[0]?.isCurrent?.()).toBe(true);
    },
  );

  it.each([
    // The fake's zero-latency default. No browser applies suspend() inside the
    // same microtask checkpoint; kept to show the outcome hinges on that timing.
    { reSuspend: 'on a microtask (fake only)', latencyMs: 0, outcome: 'rejected:suspended' },
    { reSuspend: 'a task later (browsers)', latencyMs: 1, outcome: 'resolved:running' },
  ])(
    'ensureRunning while a playback-scope attempt holds the context, re-suspend $reSuspend',
    async ({ latencyMs, outcome }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const token = await parkStalledPlayback(o, fake);
      fake.planSuspend({ latencyMs });

      // The binding's running statechange re-prepares the attempt and calls
      // suspend() before ensureRunning reads the state.
      const seen = await o.context.ensureRunning().then(
        () => `resolved:${fake.state}`,
        (error: { name: string; state: string }) => {
          expect(error.name).toBe('AudioContextNotRunningError');
          return `rejected:${error.state}`;
        },
      );
      expect(seen).toBe(outcome);
      await vi.advanceTimersByTimeAsync(1_000);

      // Known gap (C1-I4 e; C1-I13 decides it): with a real suspend latency
      // the PLAY that called ensureRunning is told the context is running and
      // goes on to start its source, then the re-prepare suspends the context
      // under it and the prepared clock-stalled prompt follows.
      expect(fake.state).toBe('suspended');
      expect(fake.ops.filter((op) => op.endsWith('()'))).toEqual([
        'suspend()',
        'resume()',
        'suspend()',
      ]);
      expect(playbackScope(o, token)).toEqual(PARKED);
      expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    },
  );

  it('a gesture during the re-suspend is refused, and the prepared event arrives after it', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    const bus = recordBus(o);
    bind(o, fake);
    const token = await parkStalledPlayback(o, fake);
    fake.planSuspend({ latencyMs: 50 });

    // Something outside the owner resumes it (before Phase 7 7B-3 also a UI
    // sound's pointerdown), and the click activation follows a task later.
    fake.transition('running');
    await vi.advanceTimersByTimeAsync(0);
    const before = fake.ops.length;
    await expect(o.recovery.beginPlaybackScopeRecoveryFromGesture()).resolves.toEqual({
      running: false,
      rejoinEmitted: false,
    });
    expect(fake.ops.slice(before)).toEqual([]);
    expect(bus.needed).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(playbackScope(o, token).gestureToken).toBe('same');
  });
});

/**
 * The play-request attempt parked again (C1-I13 a, Phase 7 7B-2, owner answer
 * Q8), owner half. While the owner parks the same attempt again its
 * preparation reads not current, so the recovery dialog's tap fails its
 * currency gate in app.ts before it reaches the owner; the dialog then asks
 * the owner whether it is preparing that same attempt again. A promise means
 * the owner keeps the attempt: the dialog's close does not retire it, and the
 * same request shows again once the promise settles true. app.ts's half (the
 * close without retirement, the same request shown once more, one retry) is
 * pinned by the local Chromium lab, rows (a) and (b).
 */
describe('RO-01 the play-request attempt parked again (C1-I13 a)', () => {
  it('a tap during the re-park finds the same attempt being prepared again, kept until it is parked', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    const bus = recordBus(o);
    bind(o, fake);
    const { preparation } = await parkPlayRequestRestart(o, fake);
    const token = preparation.attemptToken;
    // Parked for its gesture: nothing is being prepared again.
    expect(o.context.whenPlayRequestAttemptReprepared(token)).toBeNull();
    fake.planSuspend({ latencyMs: 50 });

    fake.transition('running');
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.ops.slice(-2)).toEqual(['statechange:running', 'suspend()']);
    expect(preparation.isCurrent()).toBe(false);
    expect(o.context.isPlayRequestRestartOwned(fake.native)).toBe(true);
    const reprepared = o.context.whenPlayRequestAttemptReprepared(token);
    expect(reprepared).toBeInstanceOf(Promise);
    expect(o.context.whenPlayRequestAttemptReprepared(token)).toBe(reprepared);
    expect(o.context.whenPlayRequestAttemptReprepared({})).toBeNull();
    const settled: boolean[] = [];
    void reprepared!.then(
      (parked) => settled.push(parked),
      () => undefined,
    );
    // A gesture that does reach the owner now is refused with no native call,
    // as the playback scope refuses one during its re-suspend (row above).
    const before = fake.ops.length;
    await expect(o.context.resumePreparedPlayRequestRestartFromGesture(token)).resolves.toEqual({
      running: false,
      requiresClockVerification: false,
    });
    expect(fake.ops.slice(before)).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);

    expect(settled).toEqual([true]);
    expect(fake.state).toBe('suspended');
    expect(preparation.isCurrent()).toBe(true);
    expect(o.context.whenPlayRequestAttemptReprepared(token)).toBeNull();

    // The same request's next tap: one native resume, and the exact token
    // commits once (transport's confirm closure asks this owner with it).
    const tap = fake.ops.length;
    await expect(o.context.resumePreparedPlayRequestRestartFromGesture(token)).resolves.toEqual({
      running: true,
      requiresClockVerification: true,
    });
    expect(fake.ops.slice(tap).filter((op) => op.endsWith('()'))).toEqual(['resume()']);
    expect(o.context.confirmPlayRequestAttemptHealth({})).toBe(false);
    expect(o.context.confirmPlayRequestAttemptHealth(token)).toBe(true);
    expect(o.context.confirmPlayRequestAttemptHealth(token)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toEqual([true]);
    expect(fake.calls('suspend')).toBe(2);
    expect(bus).toEqual(QUIET_BUS);
  });

  it('a re-park whose suspend never lands retires the attempt at its watchdog; the promise settles false', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    bind(o, fake);
    const { preparation } = await parkPlayRequestRestart(o, fake);
    fake.planSuspend({ outcome: 'never' });

    fake.transition('running');
    await vi.advanceTimersByTimeAsync(0);
    const reprepared = o.context.whenPlayRequestAttemptReprepared(preparation.attemptToken);
    const settled: boolean[] = [];
    void reprepared!.then(
      (parked) => settled.push(parked),
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(900);

    // The re-park's suspend is the attempt's second: it shares the two-suspend
    // budget of its first preparation, as the playback scope's re-suspend
    // does, so a re-park that cannot land retires at the lease watchdog
    // instead of trying again.
    expect(settled).toEqual([false]);
    expect(preparation.isCurrent()).toBe(false);
    expect(o.context.isPlayRequestRestartOwned(fake.native)).toBe(false);
    expect(o.context.whenPlayRequestAttemptReprepared(preparation.attemptToken)).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.calls('suspend')).toBe(2);
    expect(fake.calls('resume')).toBe(0);
    expect(fake.state).toBe('running');
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
    const semantic = o.recovery.getPendingPlaybackScopeAttemptForHealth();
    expect(semantic).toBeTypeOf('object');

    // transport.ts PLAY with a foreground incident and a stalled sample.
    const check = o.context.armForegroundAudioContextClockHealthCheck(fake.native);
    const preparation = await o.context.preparePlayRequestRestart(check!);
    expect(preparation).toMatchObject({ status: 'prepared' });
    // One listener, the context's dispatcher (Phase 7 7B-4), for the
    // binding: the play-request lease has settled.
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
    const token = await o.recovery.armPlaybackScopeAttemptFromBackground(
      fake.native,
      'state-interruption',
    );
    expect(token).toBeTypeOf('object');

    // C1-I5, query purity (Phase 7 7C-1; this row pinned it as a Known gap of
    // the requirement query): no query moves awaiting-resume to
    // awaiting-clock-verification any more. The owner's gesture recovery
    // observes the running context itself, where its callers read that
    // query, then checks this exact attempt's clock and escalates a frozen
    // one: nothing escalates before that observation, and a foreign token
    // reaches nothing.
    const caller = { running: true, isCurrent: () => true };
    await expect(o.recovery.finishPlaybackScopeRecoveryFromGesture({}, caller)).resolves.toEqual({
      kind: 'superseded',
    });

    fake.freezeClock();
    fake.planSuspend({ latencyMs: 600 });
    const escalation = o.recovery.finishPlaybackScopeRecoveryFromGesture(token!, caller);
    // Its two frozen clock samples, then the 500 ms suspend preparation.
    await vi.advanceTimersByTimeAsync(360 + 500);
    await expect(escalation).resolves.toEqual({ kind: 'escalated', escalation: 'preparing' });
    expect(bus.needed).toEqual([]);
    expect(playbackScope(o, token!).gestureToken).toBe('none');

    await vi.advanceTimersByTimeAsync(100);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(playbackScope(o, token!).gestureToken).toBe('same');
  });

  it('cancelling a playback attempt leaves the context suspended; retiring a restart resumes it', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFilePlayback(o);
    bind(o, fake);
    const token = await parkStalledPlayback(o, fake);

    expect(o.recovery.retireAudioContextRecoveryAttempt({})).toBe(false);
    expect(o.recovery.retireAudioContextRecoveryAttempt(token)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(playbackScope(o, token)).toEqual(NO_ATTEMPT);
    expect(fake.state).toBe('suspended');
    expect(fake.calls('resume')).toBe(0);

    fake.transition('running');
    const { preparation } = await parkPlayRequestRestart(o, fake);
    expect(o.context.retireAudioContextRecoveryAttempt({})).toBe(false);
    expect(o.context.retireAudioContextRecoveryAttempt(preparation.attemptToken)).toBe(true);
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
    const preparation = await o.context.preparePlayRequestRestart(second!);

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

    const gesture = o.recovery.beginPlaybackScopeRecoveryFromGesture();
    await vi.advanceTimersByTimeAsync(300);
    dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    setVisibility('hidden');
    setVisibility('visible');

    // The deadline settles first; the retired attempt reports not running.
    await expect(gesture).resolves.toEqual({
      running: false,
      rejoinEmitted: false,
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

  it.each([
    // The fake's zero-latency default (no browser orders it this way): the
    // whole round trip lands before ensureRunning reads the state.
    {
      reSuspend: 'on a microtask (fake only)',
      latencyMs: 0,
      atResolve: ['resume()', 'suspend()', 'resume()'],
    },
    // Browsers: ensureRunning reads running before the stale suspend lands.
    { reSuspend: 'a task later (browsers)', latencyMs: 1, atResolve: ['resume()', 'suspend()'] },
  ])(
    'a new track after a queue change pays one stale re-suspend, re-suspend $reSuspend',
    async ({ latencyMs, atResolve }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stageFilePlayback(o);
      const bus = recordBus(o);
      bind(o, fake);
      const token = await parkStalledPlayback(o, fake);
      fake.planSuspend({ latencyMs });

      stageFilePlayback(o, QUEUE_B);
      const before = fake.ops.length;
      const callsSoFar = () => fake.ops.slice(before).filter((op) => op.endsWith('()'));
      const seenAtResolve = await o.context.ensureRunning().then(callsSoFar);
      expect(seenAtResolve).toEqual(atResolve);
      await vi.advanceTimersByTimeAsync(1_000);

      // The binding re-prepares the parked attempt without checking its
      // identity, retires it when that suspend lands, and the retired-suspend
      // cleanup resumes the context again.
      expect(callsSoFar()).toEqual(['resume()', 'suspend()', 'resume()']);
      expect(fake.state).toBe('running');
      expect(playbackScope(o, token)).toEqual(NO_ATTEMPT);
      expect(bus).toEqual(QUIET_BUS);
    },
  );
});

describe('RO-01 Media Session PLAY gesture path', () => {
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
    expect(o.recovery.hasPendingPlaybackScopeAttempt('file')).toBe(true);

    const before = fake.ops.length;
    play();
    expect(fake.ops.slice(before)).toEqual(['resume()']);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(o.recovery.hasPendingPlaybackScopeAttempt()).toBe(false);
  });

  it('G7: a slow hardware PLAY resume is verified by the owner; a later PLAY is a no-op', async () => {
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

    // media-session.ts gave up at the deadline (running:false); the owner's
    // late probe commits the attempt. Before G7 hasPending stayed true with no
    // gesture token, so this and every later PLAY returned before any rejoin.
    expect(playbackScope(o, token)).toEqual(COMPLETED);
    expect(bus.rejoins).toEqual(['audio-context-recovered']);

    const before = fake.ops.length;
    play();
    await vi.advanceTimersByTimeAsync(2_000);

    // No pending attempt: a host that is already playing ignores a repeated
    // PLAY (media-session.ts), with no native call and no second rejoin.
    expect(fake.ops.slice(before)).toEqual([]);
    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(bus.needed).toEqual([]);
  });
});
