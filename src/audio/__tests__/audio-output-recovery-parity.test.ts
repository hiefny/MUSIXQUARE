/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 "AudioContext running state": parity tables of the two recovery
 * owners on one context (structural plan C1, I11 and I12).
 *
 * I11 runs the same suspend scenes through the play-request restart's
 * suspend lease and the playback-scope attempt's suspend lease. I12 runs the
 * same gesture-resume scenes through both owners' gesture paths. Each row is
 * a timeline on the fake clock, in ms from the first native call: the
 * platform ops (FakeNativeAudioContext.ops) merged with the owner's answers
 * and bus events, plus where the context and its listeners end.
 *
 * Cells that differ today carry a named known difference (K-I11-a..d,
 * K-I12-a..c). The C1 increments that merge the two machines (7B-4 for I11,
 * 7B-5 for I12's wait) flip only those cells; every other cell must stay
 * byte-identical. Boundary and driver as in
 * audio-output-recovery-boundary.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeNativeAudioContext,
  type FakeNativeCallPlan,
} from './__helpers__/fake-audio-context.ts';
import {
  armNewIncident,
  bind,
  foregroundIncident,
  loadMediaSession,
  loadOwners,
  playRequest,
  playbackScope,
  recordBus,
  setupOwnerTest,
  stageFile,
  startTimeline,
  teardownOwnerTest,
  type Owners,
  type PlayRequest,
  type Timeline,
} from './__helpers__/audio-output-owners.ts';

beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

const STEP_MS = 10;

/** Mark bus notices and rejoins on the timeline. */
function markBus(o: Owners, timeline: Timeline): void {
  o.bus.on('audio:output-recovery-needed', (event) => {
    timeline.mark(`needed:${event.source}:${event.reason}`);
  });
  o.bus.on('playback:local-output-rejoin', (event) => {
    timeline.mark(`rejoin:${event.reason}`);
  });
}

/** Advance in 10 ms steps, running `acts` at their times and `poll` after every step. */
async function drive(
  totalMs: number,
  poll: () => void,
  acts: ReadonlyMap<number, () => void> = new Map(),
): Promise<void> {
  poll();
  for (let t = STEP_MS; t <= totalMs; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    const act = acts.get(t);
    if (act) {
      act();
      await vi.advanceTimersByTimeAsync(0);
    }
    poll();
  }
}

/** Mark each change of a polled value as `name:value`. */
function watch(timeline: Timeline, name: string, read: () => string): () => void {
  let last = read();
  return () => {
    const next = read();
    if (next !== last) timeline.mark(`${name}:${next}`);
    last = next;
  };
}

function settle<T>(timeline: Timeline, promise: Promise<T>, name: string): void {
  void promise.then(
    (value) => timeline.mark(`${name}:${String(value)}`),
    () => timeline.mark(`${name}:rejected`),
  );
}

// ─── I11: suspend preparation ─────────────────────────────────────

interface SuspendScene {
  readonly scene: string;
  readonly plans: FakeNativeCallPlan[];
  readonly closeAtMs?: number;
}

interface SuspendCell {
  readonly timeline: string[];
  /** The foreground incident a later PLAY probes: the one this attempt came from, a new one, or none. */
  readonly incident: 'original' | 'new' | 'none';
  readonly listeners: number;
  readonly state: string;
}

const RUNNING = { toState: 'unchanged' } as const;
const NEVER = { outcome: 'never' } as const;
const LANDS_AT = (ms: number): FakeNativeCallPlan => ({
  statechange: 'after-settle',
  stateDelayMs: ms,
});

const SUSPEND_SCENES: Array<{
  scene: SuspendScene;
  request: SuspendCell;
  scope: SuspendCell;
}> = [
  {
    // P1. K-I11-a: the second suspend at 1,000 ms against 750 ms (the
    // play-request lease waits out its 250 ms late-suspend fence).
    // K-I11-b: after two failures the play-request attempt retires at
    // 1,750 ms and keeps its original incident; the playback scope gives up
    // at 1,500 ms and arms a new incident for the next PLAY.
    scene: { scene: 'P1 both suspends resolve while running', plans: [RUNNING, RUNNING] },
    request: {
      timeline: [
        '0:suspend()',
        '0:suspend:resolved',
        '500:first:preparing',
        '1000:suspend()',
        '1000:suspend:resolved',
        '1750:prepared:false',
      ],
      incident: 'original',
      listeners: 1,
      state: 'running',
    },
    scope: {
      timeline: [
        '0:suspend()',
        '0:suspend:resolved',
        '500:first:none',
        '750:suspend()',
        '750:suspend:resolved',
        '1500:attempt:none',
      ],
      incident: 'new',
      listeners: 1,
      state: 'running',
    },
  },
  {
    // P2. K-I11-a, K-I11-b as in P1.
    scene: { scene: 'P2 neither suspend settles', plans: [NEVER, NEVER] },
    request: {
      timeline: ['0:suspend()', '500:first:preparing', '1000:suspend()', '1750:prepared:false'],
      incident: 'original',
      listeners: 1,
      state: 'running',
    },
    scope: {
      timeline: ['0:suspend()', '500:first:none', '750:suspend()', '1500:attempt:none'],
      incident: 'new',
      listeners: 1,
      state: 'running',
    },
  },
  {
    // P3. K-I11-c: a first suspend landing inside the fence window is handed
    // to the waiting play-request attempt with no second native call; the
    // playback scope has already issued its second one at 750 ms.
    // K-I11-d: the playback scope notifies on the bus; the play-request
    // answer goes to transport through its promise.
    scene: { scene: 'P3 first lands at 900 ms, second never', plans: [LANDS_AT(900), NEVER] },
    request: {
      timeline: [
        '0:suspend()',
        '0:suspend:resolved',
        '500:first:preparing',
        '900:statechange:suspended',
        '900:prepared:true',
      ],
      incident: 'original',
      listeners: 1,
      state: 'suspended',
    },
    scope: {
      timeline: [
        '0:suspend()',
        '0:suspend:resolved',
        '500:first:none',
        '750:suspend()',
        '900:statechange:suspended',
        '900:needed:background-resume:clock-stalled',
        '900:gesture:true',
      ],
      incident: 'none',
      listeners: 1,
      state: 'suspended',
    },
  },
  {
    // P4. K-I11-a, K-I11-d.
    scene: { scene: 'P4 first lands at 1,200 ms, second never', plans: [LANDS_AT(1_200), NEVER] },
    request: {
      timeline: [
        '0:suspend()',
        '0:suspend:resolved',
        '500:first:preparing',
        '1000:suspend()',
        '1200:statechange:suspended',
        '1200:prepared:true',
      ],
      incident: 'original',
      listeners: 1,
      state: 'suspended',
    },
    scope: {
      timeline: [
        '0:suspend()',
        '0:suspend:resolved',
        '500:first:none',
        '750:suspend()',
        '1200:statechange:suspended',
        '1200:needed:background-resume:clock-stalled',
        '1200:gesture:true',
      ],
      incident: 'none',
      listeners: 1,
      state: 'suspended',
    },
  },
  {
    // P5. The same in both.
    scene: { scene: 'P5 closed at 300 ms', plans: [NEVER], closeAtMs: 300 },
    request: {
      timeline: [
        '0:suspend()',
        '300:close()',
        '300:statechange:closed',
        '300:first:stale',
        '300:prepared:false',
      ],
      incident: 'original',
      listeners: 1,
      state: 'closed',
    },
    scope: {
      timeline: [
        '0:suspend()',
        '300:close()',
        '300:statechange:closed',
        '300:first:none',
        '300:attempt:none',
      ],
      incident: 'none',
      listeners: 1,
      state: 'closed',
    },
  },
  {
    // P6. K-I11-a, K-I11-d.
    scene: { scene: 'P6 second suspend lands', plans: [RUNNING, {}] },
    request: {
      timeline: [
        '0:suspend()',
        '0:suspend:resolved',
        '500:first:preparing',
        '1000:suspend()',
        '1000:statechange:suspended',
        '1000:suspend:resolved',
        '1000:prepared:true',
      ],
      incident: 'original',
      listeners: 1,
      state: 'suspended',
    },
    scope: {
      timeline: [
        '0:suspend()',
        '0:suspend:resolved',
        '500:first:none',
        '750:suspend()',
        '750:statechange:suspended',
        '750:needed:background-resume:clock-stalled',
        '750:suspend:resolved',
        '750:gesture:true',
      ],
      incident: 'none',
      listeners: 1,
      state: 'suspended',
    },
  },
];

function incidentCell(o: Owners, original: object | null): SuspendCell['incident'] {
  const incident = foregroundIncident(o);
  if (!incident) return 'none';
  return incident === original ? 'original' : 'new';
}

async function newFileOwners(): Promise<{ fake: FakeNativeAudioContext; o: Owners }> {
  const fake = new FakeNativeAudioContext();
  const o = await loadOwners(fake);
  stageFile(o);
  bind(o, fake);
  return { fake, o };
}

function closeAt(fake: FakeNativeAudioContext, ms: number | undefined): Map<number, () => void> {
  return new Map(
    ms === undefined
      ? []
      : [
          [
            ms,
            () => {
              void fake.close().then(
                () => undefined,
                () => undefined,
              );
            },
          ],
        ],
  );
}

describe('RO-01 I11 parity: suspend preparation for a gesture', () => {
  it.each(SUSPEND_SCENES)('play-request lease: $scene.scene', async ({ scene, request }) => {
    const { fake, o } = await newFileOwners();
    fake.planSuspend(...scene.plans);
    const timeline = startTimeline(fake);
    markBus(o, timeline);

    const restart = playRequest.arm(o, fake);
    settle(timeline, restart.first, 'first');
    settle(timeline, restart.prepared, 'prepared');
    await drive(4_000, () => undefined, closeAt(fake, scene.closeAtMs));

    expect({
      timeline: timeline.entries,
      incident: incidentCell(o, restart.incident),
      listeners: fake.statechangeListenerCount,
      state: fake.state,
    }).toEqual(request);
  });

  it.each(SUSPEND_SCENES)('playback-scope lease: $scene.scene', async ({ scene, scope }) => {
    const { fake, o } = await newFileOwners();
    fake.planSuspend(...scene.plans);
    const timeline = startTimeline(fake);
    markBus(o, timeline);

    settle(timeline, playbackScope.armStalled(o, fake), 'first');
    const attempt = watch(timeline, 'attempt', () => playbackScope.view(o).attempt);
    const gesture = watch(timeline, 'gesture', () => String(playbackScope.view(o).gesture));
    await drive(
      4_000,
      () => {
        attempt();
        gesture();
      },
      closeAt(fake, scene.closeAtMs),
    );

    expect({
      timeline: timeline.entries,
      incident: incidentCell(o, null),
      listeners: fake.statechangeListenerCount,
      state: fake.state,
    }).toEqual(scope);
  });
});

// ─── I12: gesture resume ──────────────────────────────────────────

interface ResumeCell {
  readonly timeline: string[];
  readonly listeners: number;
  readonly state: string;
  /** The attempt the tap used is still the live one. */
  readonly current: boolean;
}

const RESUME_SCENES: Array<{
  scene: string;
  plan: FakeNativeCallPlan;
  request: ResumeCell;
  scope: ResumeCell;
}> = [
  {
    scene: 'running at once',
    plan: {},
    request: {
      timeline: [
        '0:resume()',
        '0:statechange:running',
        '0:resume:resolved',
        '0:result:running',
        '0:requirement:same',
      ],
      listeners: 1,
      state: 'running',
      current: true,
    },
    scope: {
      timeline: [
        '0:resume()',
        '0:statechange:running',
        '0:resume:resolved',
        '0:result:running',
        '0:requirement:same',
      ],
      listeners: 1,
      state: 'running',
      current: true,
    },
  },
  {
    // K-I12-a: after the 750 ms deadline the play-request owner only
    // promotes and waits for the dialog's poll; the playback scope's binding
    // takes the running event for a late automatic resume and re-suspends.
    // (Its re-prompt is the Known gap of audio-context-ownership.test.ts's G7 rows.)
    scene: 'running at 1,200 ms, event before the promise',
    plan: { latencyMs: 1_200 },
    request: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        '1200:statechange:running',
        '1200:resume:resolved',
        '1200:requirement:same',
      ],
      listeners: 1,
      state: 'running',
      current: true,
    },
    scope: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        '1200:statechange:running',
        '1200:suspend()',
        '1200:resume:resolved',
        '1200:statechange:suspended',
        '1200:needed:background-resume:clock-stalled',
        '1200:suspend:resolved',
      ],
      listeners: 1,
      state: 'suspended',
      current: true,
    },
  },
  {
    // K-I12-a as above, 100 ms later.
    scene: 'running at 1,200 ms, event 100 ms after the promise',
    plan: { latencyMs: 1_200, statechange: 'after-settle', stateDelayMs: 100 },
    request: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        '1200:resume:resolved',
        '1300:statechange:running',
        '1300:requirement:same',
      ],
      listeners: 1,
      state: 'running',
      current: true,
    },
    scope: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        '1200:resume:resolved',
        '1300:statechange:running',
        '1300:suspend()',
        '1300:statechange:suspended',
        '1300:needed:background-resume:clock-stalled',
        '1300:suspend:resolved',
      ],
      listeners: 1,
      state: 'suspended',
      current: true,
    },
  },
  {
    // K-I12-a: the playback scope verifies its own clock (fix lane G7) and
    // rejoins; the play-request owner waits for the dialog.
    scene: 'running at 1,200 ms with the promise, event 100 ms later',
    plan: { latencyMs: 1_200, statechange: 'deferred-event', stateDelayMs: 100 },
    request: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        '1200:state:running',
        '1200:resume:resolved',
        '1200:requirement:same',
        '1300:statechange:running',
      ],
      listeners: 1,
      state: 'running',
      current: true,
    },
    scope: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        '1200:state:running',
        '1200:resume:resolved',
        '1200:requirement:same',
        '1300:statechange:running',
        '1380:rejoin:audio-context-recovered',
        '1380:requirement:none',
      ],
      listeners: 1,
      state: 'running',
      current: true,
    },
  },
  {
    // K-I12-a as in the row above.
    scene: 'running at 1,200 ms with no event',
    plan: { latencyMs: 1_200, statechange: 'silent' },
    request: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        '1200:state:running',
        '1200:resume:resolved',
        '1200:requirement:same',
      ],
      listeners: 1,
      state: 'running',
      current: true,
    },
    scope: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        '1200:state:running',
        '1200:resume:resolved',
        '1200:requirement:same',
        '1380:rejoin:audio-context-recovered',
        '1380:requirement:none',
      ],
      listeners: 1,
      state: 'running',
      current: true,
    },
  },
  {
    scene: 'refused',
    plan: { outcome: 'reject' },
    request: {
      timeline: ['0:resume()', '0:resume:rejected', '0:result:not-running'],
      listeners: 1,
      state: 'suspended',
      current: true,
    },
    scope: {
      timeline: ['0:resume()', '0:resume:rejected', '0:result:not-running'],
      listeners: 1,
      state: 'suspended',
      current: true,
    },
  },
  {
    // K-I12-b: the play-request owner's unsettled resume listener stays until
    // the attempt retires.
    scene: 'never settles',
    plan: { outcome: 'never' },
    request: {
      timeline: ['0:resume()', '750:result:not-running'],
      listeners: 2,
      state: 'suspended',
      current: true,
    },
    scope: {
      timeline: ['0:resume()', '750:result:not-running'],
      listeners: 1,
      state: 'suspended',
      current: true,
    },
  },
];

function markResult(timeline: Timeline, tap: Promise<{ running: boolean }>): void {
  void tap.then(
    (result) => timeline.mark(`result:${result.running ? 'running' : 'not-running'}`),
    () => timeline.mark('result:rejected'),
  );
}

describe('RO-01 I12 parity: gesture resume of a parked attempt', () => {
  it.each(RESUME_SCENES)('play-request gesture: $scene', async ({ plan, request }) => {
    const { fake, o } = await newFileOwners();
    const restart = playRequest.arm(o, fake);
    await expect(restart.first).resolves.toBe('prepared');
    fake.planResume(plan);
    const timeline = startTimeline(fake);
    markBus(o, timeline);
    const requirement = watch(timeline, 'requirement', () => restart.requirement());

    markResult(timeline, restart.tap());
    await vi.advanceTimersByTimeAsync(0);
    await drive(6_000, requirement);

    expect({
      timeline: timeline.entries,
      listeners: fake.statechangeListenerCount,
      state: fake.state,
      current: restart.isCurrent(),
    }).toEqual(request);
  });

  it.each(RESUME_SCENES)('playback-scope gesture: $scene', async ({ plan, scope }) => {
    const { fake, o } = await newFileOwners();
    await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
    const attempt = playbackScope.current(o)!;
    fake.planResume(plan);
    const timeline = startTimeline(fake);
    markBus(o, timeline);
    const requirement = watch(timeline, 'requirement', () => playbackScope.requirement(o));

    markResult(timeline, playbackScope.tap(o));
    await vi.advanceTimersByTimeAsync(0);
    await drive(6_000, requirement);

    expect({
      timeline: timeline.entries,
      listeners: fake.statechangeListenerCount,
      state: fake.state,
      current: playbackScope.isCurrent(o, attempt),
    }).toEqual(scope);
  });

  it('a hardware PLAY is the playback scope gesture with a public entry', async () => {
    const { fake, o } = await newFileOwners();
    const bus = recordBus(o);
    const mediaSession = await loadMediaSession();
    await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
    const before = fake.ops.length;

    mediaSession.play();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fake.ops.slice(before)).toEqual(['resume()', 'statechange:running', 'resume:resolved']);
    expect(bus.rejoins).toEqual(['audio-context-recovered']);
    expect(bus.needed).toEqual([]);
    expect(playbackScope.view(o)).toEqual({ attempt: 'none', gesture: false });
  });
});

/**
 * app.ts's wait after the dialog's tap (K-I12-c, play-request only): read
 * the requirement every 50 ms from the gesture flight's settlement, give up
 * after 5 s. Only the dialog's own currency ends it early; this table keeps
 * that true and pins the owner's side of each ending.
 */
async function dialogWait(restart: PlayRequest, startedAt: number): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (restart.requirement() === 'same') return `ready@${Date.now() - startedAt}`;
    if (Date.now() >= deadline) return `gave-up@${Date.now() - startedAt}`;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

describe('RO-01 I12 the play-request wait after the tap: how it ends', () => {
  it.each([
    {
      ending: 'the requirement appears (exposed at promotion, read on the next 50 ms tick)',
      plan: { latencyMs: 1_230 } as FakeNativeCallPlan,
      rearmAtMs: null,
      result: { exposedAt: 1230, wait: 'ready@1250', current: true, listeners: 1 },
    },
    {
      ending: 'it never appears (the resume never settles)',
      plan: { outcome: 'never' } as FakeNativeCallPlan,
      rearmAtMs: null,
      result: { exposedAt: null, wait: 'gave-up@5750', current: true, listeners: 2 },
    },
    {
      // The owner retires the attempt at once, but nothing tells the wait.
      ending: 'the attempt retires elsewhere (a new foreground incident at 900 ms)',
      plan: { latencyMs: 1_200 } as FakeNativeCallPlan,
      rearmAtMs: 900,
      result: { exposedAt: null, wait: 'gave-up@5750', current: false, listeners: 1 },
    },
  ])('$ending', async ({ plan, rearmAtMs, result }) => {
    const { fake, o } = await newFileOwners();
    const restart = playRequest.arm(o, fake);
    await expect(restart.first).resolves.toBe('prepared');
    fake.planResume(plan);
    const startedAt = Date.now();
    let exposedAt: number | null = null;
    let current = true;

    const waited = restart.tap().then(() => dialogWait(restart, startedAt));
    if (rearmAtMs !== null) {
      await vi.advanceTimersByTimeAsync(rearmAtMs);
      armNewIncident(o, fake);
      current = restart.isCurrent();
    }
    for (let t = rearmAtMs ?? 0; t < 6_000; t += STEP_MS) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      if (exposedAt === null && restart.requirement() === 'same')
        exposedAt = Date.now() - startedAt;
    }

    expect({
      exposedAt,
      wait: await waited,
      current,
      listeners: fake.statechangeListenerCount,
    }).toEqual(result);
  });
});
