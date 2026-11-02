/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 "AudioContext running state": parity tables of the two recovery
 * owners on one context (structural plan C1, I11 and I12).
 *
 * I11 runs the same suspend scenes, from the same start (a foreground
 * incident armed, as the return to the foreground arms one), through the
 * play-request restart's suspend lease and the playback-scope attempt's
 * suspend lease. I12 runs the same gesture-resume scenes through both
 * owners' gesture paths. Times are ms on the fake clock from the first
 * native call.
 *
 * Each row holds the play-request owner's cells and, for the playback
 * scope, only the cells that differ today, each with its named known
 * difference (K-I11-a..d; K-I12-a, b and d, and K-I12-c for the
 * play-request wait alone). The playback-scope rows assert every other cell
 * equal to the play-request one. If the owner approves the timing and
 * dispatch change (Q6, owner decision pending), 7B-4 flips only named I11
 * cells; 7B-5 (Q7, owner decision pending) only named I12 cells. Boundary
 * and driver as in audio-output-recovery-boundary.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  warmMediaSessionGraph,
  type Owners,
  type Timeline,
} from './__helpers__/audio-output-owners.ts';

beforeAll(warmMediaSessionGraph, 30_000);
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

/** A row's expectation for the second owner: the first owner's cells, except the named ones. */
type Differences<Cell, Known extends string> = {
  readonly [Key in keyof Cell]?: readonly [Known, Cell[Key]];
};

function withDifferences<Cell extends object, Known extends string>(
  cell: Cell,
  differences: Differences<Cell, Known>,
): Cell {
  const expected = { ...cell };
  for (const [key, entry] of Object.entries(differences) as Array<
    [keyof Cell, readonly [Known, Cell[keyof Cell]]]
  >) {
    // A named difference must really differ; an equal cell keeps no name.
    expect(entry[1]).not.toEqual(cell[key]);
    expected[key] = entry[1];
  }
  return expected;
}

async function newFileOwners(): Promise<{ fake: FakeNativeAudioContext; o: Owners }> {
  const fake = new FakeNativeAudioContext();
  const o = await loadOwners(fake);
  stageFile(o);
  bind(o, fake);
  return { fake, o };
}

function incidentCell(o: Owners, original: object | null): 'original' | 'new' | 'none' {
  const incident = foregroundIncident(o);
  if (!incident) return 'none';
  return incident === original ? 'original' : 'new';
}

// ─── I11: suspend preparation ─────────────────────────────────────

/**
 * K-I11-a: the play-request lease waits out its 250 ms late-suspend fence
 *   before its second native suspend (1,000 ms against 750 ms), so what
 *   follows that suspend is 250 ms later.
 * K-I11-b: after two failed suspends the play-request attempt retires and
 *   keeps the incident it came from; the playback scope gives up and arms a
 *   new incident for the next PLAY.
 * K-I11-c: a first suspend that lands inside the fence goes to the waiting
 *   play-request attempt with no second native call; the playback scope has
 *   already issued its second one.
 * K-I11-d: once prepared, the playback scope notifies on the bus; the
 *   play-request answer reaches transport through its promise.
 */
type KnownI11 = 'K-I11-a' | 'K-I11-b' | 'K-I11-c' | 'K-I11-d';

interface SuspendCell {
  /** Native calls, their settlements and state changes, in order. */
  readonly ops: string[];
  /** When each native suspend() was issued. */
  readonly suspendsAt: number[];
  /** The owner's answer at the end of its 500 ms window (or sooner), `answer@ms`. */
  readonly first: string;
  /** How the attempt ends, `prepared@ms` or `retired@ms`, or 'pending' after 4 s. */
  readonly end: string;
  /** audio:output-recovery-needed as `source:reason`. */
  readonly notices: string[];
  /** The foreground incident a later PLAY probes: the one the scene started with, a new one, or none. */
  readonly incident: 'original' | 'new' | 'none';
  readonly listeners: number;
  readonly state: string;
}

interface SuspendScene {
  readonly scene: string;
  readonly plans: FakeNativeCallPlan[];
  readonly closeAtMs?: number;
  readonly request: SuspendCell;
  readonly scope: Differences<SuspendCell, KnownI11>;
}

const RUNNING = { toState: 'unchanged' } as const;
const NEVER = { outcome: 'never' } as const;
const LANDS_AT = (ms: number): FakeNativeCallPlan => ({
  statechange: 'after-settle',
  stateDelayMs: ms,
});
const NOTICE = 'background-resume:clock-stalled';

const SUSPEND_SCENES: SuspendScene[] = [
  {
    scene: 'P1 both suspends resolve while running',
    plans: [RUNNING, RUNNING],
    request: {
      ops: ['suspend()', 'suspend:resolved', 'suspend()', 'suspend:resolved'],
      suspendsAt: [0, 1000],
      first: 'preparing@500',
      end: 'retired@1750',
      notices: [],
      incident: 'original',
      listeners: 1,
      state: 'running',
    },
    scope: {
      suspendsAt: ['K-I11-a', [0, 750]],
      end: ['K-I11-a', 'retired@1500'],
      incident: ['K-I11-b', 'new'],
    },
  },
  {
    scene: 'P2 neither suspend settles',
    plans: [NEVER, NEVER],
    request: {
      ops: ['suspend()', 'suspend()'],
      suspendsAt: [0, 1000],
      first: 'preparing@500',
      end: 'retired@1750',
      notices: [],
      incident: 'original',
      listeners: 1,
      state: 'running',
    },
    scope: {
      suspendsAt: ['K-I11-a', [0, 750]],
      end: ['K-I11-a', 'retired@1500'],
      incident: ['K-I11-b', 'new'],
    },
  },
  {
    scene: 'P3 first lands at 900 ms, second never',
    plans: [LANDS_AT(900), NEVER],
    request: {
      ops: ['suspend()', 'suspend:resolved', 'statechange:suspended'],
      suspendsAt: [0],
      first: 'preparing@500',
      end: 'prepared@900',
      notices: [],
      incident: 'original',
      listeners: 1,
      state: 'suspended',
    },
    scope: {
      ops: ['K-I11-c', ['suspend()', 'suspend:resolved', 'suspend()', 'statechange:suspended']],
      suspendsAt: ['K-I11-c', [0, 750]],
      notices: ['K-I11-d', [NOTICE]],
    },
  },
  {
    scene: 'P4 first lands at 1,200 ms, second never',
    plans: [LANDS_AT(1_200), NEVER],
    request: {
      ops: ['suspend()', 'suspend:resolved', 'suspend()', 'statechange:suspended'],
      suspendsAt: [0, 1000],
      first: 'preparing@500',
      end: 'prepared@1200',
      notices: [],
      incident: 'original',
      listeners: 1,
      state: 'suspended',
    },
    scope: {
      suspendsAt: ['K-I11-a', [0, 750]],
      notices: ['K-I11-d', [NOTICE]],
    },
  },
  {
    scene: 'P5 closed at 300 ms',
    plans: [NEVER],
    closeAtMs: 300,
    request: {
      ops: ['suspend()', 'close()', 'statechange:closed'],
      suspendsAt: [0],
      first: 'stale@300',
      end: 'retired@300',
      notices: [],
      incident: 'original',
      listeners: 1,
      state: 'closed',
    },
    // The same in both.
    scope: {},
  },
  {
    scene: 'P6 second suspend lands',
    plans: [RUNNING, {}],
    request: {
      ops: [
        'suspend()',
        'suspend:resolved',
        'suspend()',
        'statechange:suspended',
        'suspend:resolved',
      ],
      suspendsAt: [0, 1000],
      first: 'preparing@500',
      end: 'prepared@1000',
      notices: [],
      incident: 'original',
      listeners: 1,
      state: 'suspended',
    },
    scope: {
      suspendsAt: ['K-I11-a', [0, 750]],
      end: ['K-I11-a', 'prepared@750'],
      notices: ['K-I11-d', [NOTICE]],
    },
  },
  {
    // Both owners count 'interrupted' as parked, as they count 'suspended'.
    scene: 'P7 the first suspend lands as interrupted',
    plans: [{ toState: 'interrupted' }],
    request: {
      ops: ['suspend()', 'statechange:interrupted', 'suspend:resolved'],
      suspendsAt: [0],
      first: 'prepared@0',
      end: 'prepared@0',
      notices: [],
      incident: 'original',
      listeners: 1,
      state: 'interrupted',
    },
    scope: {},
  },
];

function opsAndSuspends(entries: readonly string[]): { ops: string[]; suspendsAt: number[] } {
  const ops: string[] = [];
  const suspendsAt: number[] = [];
  for (const entry of entries) {
    const split = entry.indexOf(':');
    const op = entry.slice(split + 1);
    ops.push(op);
    if (op === 'suspend()') suspendsAt.push(Number(entry.slice(0, split)));
  }
  return { ops, suspendsAt };
}

/** Run `onValue` when `promise` settles; a rejection reads as 'rejected'. */
function whenSettled<T>(promise: Promise<T>, onValue: (value: T | 'rejected') => void): void {
  void promise.then(onValue, () => onValue('rejected'));
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
  it.each(SUSPEND_SCENES)('play-request lease: $scene', async (scene) => {
    const { fake, o } = await newFileOwners();
    const bus = recordBus(o);
    fake.planSuspend(...scene.plans);
    const timeline = startTimeline(fake);
    let first = 'pending';
    let end = 'pending';

    const restart = playRequest.arm(o, fake);
    whenSettled(restart.first, (answer) => {
      first = `${answer}@${timeline.now()}`;
    });
    whenSettled(
      restart.prepared.then((prepared) => (prepared ? 'prepared' : 'retired')),
      (answer) => {
        end = `${answer}@${timeline.now()}`;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await drive(4_000, () => undefined, closeAt(fake, scene.closeAtMs));

    expect({
      ...opsAndSuspends(timeline.entries),
      first,
      end,
      notices: bus.needed,
      incident: incidentCell(o, restart.incident),
      listeners: fake.statechangeListenerCount,
      state: fake.state,
    }).toEqual(scene.request);
  });

  it.each(SUSPEND_SCENES)('playback-scope lease: $scene', async (scene) => {
    const { fake, o } = await newFileOwners();
    const bus = recordBus(o);
    fake.planSuspend(...scene.plans);
    const original = armNewIncident(o, fake);
    const timeline = startTimeline(fake);
    let first = 'pending';
    let end = 'pending';

    whenSettled(playbackScope.armStalled(o, fake), (answer) => {
      first = `${answer}@${timeline.now()}`;
    });
    await vi.advanceTimersByTimeAsync(0);
    const readEnd = (): void => {
      if (end !== 'pending') return;
      const view = playbackScope.view(o);
      if (view.gesture) end = `prepared@${timeline.now()}`;
      else if (view.attempt === 'none') end = `retired@${timeline.now()}`;
    };
    await drive(4_000, readEnd, closeAt(fake, scene.closeAtMs));

    expect({
      ...opsAndSuspends(timeline.entries),
      first,
      end,
      notices: bus.needed,
      incident: incidentCell(o, original),
      listeners: fake.statechangeListenerCount,
      state: fake.state,
    }).toEqual(withDifferences(scene.request, scene.scope));
  });
});

// ─── I12: gesture resume ──────────────────────────────────────────

/**
 * K-I12-a: after its 750 ms deadline the play-request owner only promotes
 *   a late running state and leaves the clock check to the dialog; the
 *   playback scope re-suspends a late running event as an automatic resume,
 *   and verifies its own clock when the state turns running with no event
 *   for it (fix lane G7) and rejoins. (The re-prompt is the Known gap of
 *   audio-context-ownership.test.ts's G7 rows.)
 * K-I12-b: the play-request owner's resume listener stays while its native
 *   resume is unsettled; the playback scope adds none.
 * K-I12-c: play-request only, see the table after this one.
 * K-I12-d: retiring a play-request attempt whose context is still parked
 *   resumes the context (its cleanup); dropping a playback-scope attempt
 *   leaves the context as it is.
 */
type KnownI12 = 'K-I12-a' | 'K-I12-b' | 'K-I12-d';

interface ResumeCell {
  readonly timeline: string[];
  readonly listeners: number;
  readonly state: string;
  /** The attempt the tap used is still the live one. */
  readonly current: boolean;
}

interface ResumeScene {
  readonly scene: string;
  readonly plan: FakeNativeCallPlan;
  /** A caller drops the attempt at this time (the dialog giving up on it). */
  readonly retireAtMs?: number;
  readonly request: ResumeCell;
  readonly scope: Differences<ResumeCell, KnownI12>;
}

const RESUME_SCENES: ResumeScene[] = [
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
    scope: {},
  },
  {
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
        'K-I12-a',
        [
          '0:resume()',
          '750:result:not-running',
          '1200:statechange:running',
          '1200:suspend()',
          '1200:resume:resolved',
          '1200:statechange:suspended',
          '1200:needed:background-resume:clock-stalled',
          '1200:suspend:resolved',
        ],
      ],
      state: ['K-I12-a', 'suspended'],
    },
  },
  {
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
        'K-I12-a',
        [
          '0:resume()',
          '750:result:not-running',
          '1200:resume:resolved',
          '1300:statechange:running',
          '1300:suspend()',
          '1300:statechange:suspended',
          '1300:needed:background-resume:clock-stalled',
          '1300:suspend:resolved',
        ],
      ],
      state: ['K-I12-a', 'suspended'],
    },
  },
  {
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
        'K-I12-a',
        [
          '0:resume()',
          '750:result:not-running',
          '1200:state:running',
          '1200:resume:resolved',
          '1200:requirement:same',
          '1300:statechange:running',
          '1380:rejoin:audio-context-recovered',
          '1380:requirement:none',
        ],
      ],
    },
  },
  {
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
        'K-I12-a',
        [
          '0:resume()',
          '750:result:not-running',
          '1200:state:running',
          '1200:resume:resolved',
          '1200:requirement:same',
          '1380:rejoin:audio-context-recovered',
          '1380:requirement:none',
        ],
      ],
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
    scope: {},
  },
  {
    scene: 'never settles',
    plan: { outcome: 'never' },
    request: {
      timeline: ['0:resume()', '750:result:not-running'],
      listeners: 2,
      state: 'suspended',
      current: true,
    },
    scope: { listeners: ['K-I12-b', 1] },
  },
  {
    scene: 'retired at 900 ms, then the resume resolves at 1,200 ms',
    plan: { latencyMs: 1_200 },
    retireAtMs: 900,
    request: {
      timeline: [
        '0:resume()',
        '750:result:not-running',
        // The cleanup resume is issued inside the retire call.
        '900:resume()',
        '900:retire:true',
        '900:statechange:running',
        '900:resume:resolved',
        '1200:resume:resolved',
      ],
      listeners: 1,
      state: 'running',
      current: false,
    },
    scope: {
      timeline: [
        'K-I12-d',
        [
          '0:resume()',
          '750:result:not-running',
          '900:retire:true',
          '1200:statechange:running',
          '1200:resume:resolved',
        ],
      ],
    },
  },
];

function markResult(timeline: Timeline, tap: Promise<{ running: boolean }>): void {
  void tap.then(
    (result) => timeline.mark(`result:${result.running ? 'running' : 'not-running'}`),
    () => timeline.mark('result:rejected'),
  );
}

function retireAt(ms: number | undefined, retire: () => boolean, timeline: Timeline) {
  return new Map(ms === undefined ? [] : [[ms, () => timeline.mark(`retire:${retire()}`)]]);
}

describe('RO-01 I12 parity: gesture resume of a parked attempt', () => {
  it.each(RESUME_SCENES)('play-request gesture: $scene', async (scene) => {
    const { fake, o } = await newFileOwners();
    const restart = playRequest.arm(o, fake);
    await expect(restart.first).resolves.toBe('prepared');
    fake.planResume(scene.plan);
    const timeline = startTimeline(fake);
    markBus(o, timeline);
    const requirement = watch(timeline, 'requirement', () => restart.requirement());

    markResult(timeline, restart.tap());
    await vi.advanceTimersByTimeAsync(0);
    await drive(6_000, requirement, retireAt(scene.retireAtMs, restart.retire, timeline));

    expect({
      timeline: timeline.entries,
      listeners: fake.statechangeListenerCount,
      state: fake.state,
      current: restart.isCurrent(),
    }).toEqual(scene.request);
  });

  it.each(RESUME_SCENES)('playback-scope gesture: $scene', async (scene) => {
    const { fake, o } = await newFileOwners();
    await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
    const attempt = playbackScope.current(o)!;
    fake.planResume(scene.plan);
    const timeline = startTimeline(fake);
    markBus(o, timeline);
    const requirement = watch(timeline, 'requirement', () => playbackScope.requirement(o));

    markResult(timeline, playbackScope.tap(o));
    await vi.advanceTimersByTimeAsync(0);
    await drive(
      6_000,
      requirement,
      retireAt(scene.retireAtMs, () => playbackScope.retire(o, attempt), timeline),
    );

    expect({
      timeline: timeline.entries,
      listeners: fake.statechangeListenerCount,
      state: fake.state,
      current: playbackScope.isCurrent(o, attempt),
    }).toEqual(withDifferences(scene.request, scene.scope));
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
 * The play-request attempt after the dialog's tap, owner side only. K-I12-c:
 * the owner exposes its clock requirement for app.ts to poll and tells it
 * nothing (the 50 ms poll that 7B-5 replaces with a promise, if the owner
 * approves Q7; owner decision pending). app.ts's wait is not loaded here: it
 * polls while its own currency holds, and that currency runs through
 * transport's restart check into this attempt, so the wait ends on its next
 * 50 ms check once the owner retires the attempt (row 3) and at its 5 s limit
 * when the requirement never appears (row 2). The browser lab pins the
 * abort and limit endings ((d-1), (d-3)); the retirement ending has no
 * browser row.
 *
 * Each row pins what the owner shows that wait over 6 s (when the
 * requirement first reads 'same' on a 10 ms step, and the attempt, its
 * requirement, listeners and native ops at the end) and, where the dialog
 * gives up, what retiring its token does: the owner's answer, the native ops
 * that follow and the incident a later PLAY probes.
 */
describe('RO-01 I12 the play-request attempt after the tap: what the dialog wait reads', () => {
  it.each([
    {
      ending: 'the requirement appears at promotion and stays until the dialog acts',
      plan: { latencyMs: 1_230 } as FakeNativeCallPlan,
      newIncidentAtMs: null,
      giveUp: false,
      result: {
        exposedAt: 1230,
        atSixSeconds: {
          requirement: 'same',
          current: true,
          listeners: 1,
          ops: ['resume()', 'statechange:running', 'resume:resolved'],
        },
        giveUp: null,
      },
    },
    {
      // The owner never ends the attempt by itself. Retiring it clears its
      // incident and resumes the parked context; app.ts arms a new incident
      // on this true answer when the page is visible (code reading).
      ending: 'it never appears (the resume never settles); giving up retires and restores',
      plan: { outcome: 'never' } as FakeNativeCallPlan,
      newIncidentAtMs: null,
      giveUp: true,
      result: {
        exposedAt: null,
        atSixSeconds: { requirement: 'none', current: true, listeners: 2, ops: ['resume()'] },
        giveUp: {
          retired: true,
          ops: ['resume()', 'statechange:running', 'resume:resolved'],
          incident: 'none',
          listeners: 1,
          state: 'running',
        },
      },
    },
    {
      // The owner retires the attempt when the new incident arms, and the
      // late resume promotes nothing. Giving up then finds it gone, so app.ts
      // arms nothing; the new incident stays for the next PLAY.
      ending: 'a new foreground incident at 900 ms retires it; giving up finds it gone',
      plan: { latencyMs: 1_200 } as FakeNativeCallPlan,
      newIncidentAtMs: 900,
      giveUp: true,
      result: {
        exposedAt: null,
        atSixSeconds: {
          requirement: 'none',
          current: false,
          listeners: 1,
          ops: ['resume()', 'statechange:running', 'resume:resolved'],
        },
        giveUp: { retired: false, ops: [], incident: 'new', listeners: 1, state: 'running' },
      },
    },
  ])('$ending', async ({ plan, newIncidentAtMs, giveUp, result }) => {
    const { fake, o } = await newFileOwners();
    const restart = playRequest.arm(o, fake);
    await expect(restart.first).resolves.toBe('prepared');
    fake.planResume(plan);
    const tapAt = Date.now();
    const tapOps = fake.ops.length;
    let exposedAt: number | null = null;

    whenSettled(restart.tap(), () => undefined);
    for (let t = STEP_MS; t <= 6_000; t += STEP_MS) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      if (t === newIncidentAtMs) armNewIncident(o, fake);
      if (exposedAt === null && restart.requirement() === 'same') exposedAt = Date.now() - tapAt;
    }
    const atSixSeconds = {
      requirement: restart.requirement(),
      current: restart.isCurrent(),
      listeners: fake.statechangeListenerCount,
      ops: fake.ops.slice(tapOps),
    };

    let gaveUp = null;
    if (giveUp) {
      const before = fake.ops.length;
      const retired = restart.retire();
      await vi.advanceTimersByTimeAsync(1_000);
      gaveUp = {
        retired,
        ops: fake.ops.slice(before),
        incident: incidentCell(o, restart.incident),
        listeners: fake.statechangeListenerCount,
        state: fake.state,
      };
    }

    expect({ exposedAt, atSixSeconds, giveUp: gaveUp }).toEqual(result);
  });
});
