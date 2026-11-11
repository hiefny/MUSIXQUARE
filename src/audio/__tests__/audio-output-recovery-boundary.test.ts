/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 "AudioContext running state": owner-boundary rows the C1 output
 * recovery work (structural plan Phase 7) changes or must keep.
 *
 * Boundary and observations as in audio-context-ownership.test.ts: the real
 * owners over FakeNativeAudioContext, observed through its op log, its
 * statechange listeners, bus events and the normalized driver answers in
 * __helpers__/audio-output-owners.ts. The driver is the only file that names
 * today's sub-steps.
 *
 * Rows:
 * - the play-request restart's 250 ms late-suspend fence meeting a real OS
 *   interruption, per playback mode;
 * - YouTube attempts that reach the clock-stalled phase, where app.ts opens
 *   no dialog (its dialog is file-mode only);
 * - the two suspend leases one foreground incident can start;
 * - statechange dispatch order and listener counts per owner;
 * - prepared notices per suspend ordering;
 * - the owner side of the recovery dialog's ordinary branch while a non-file
 *   attempt waits, which the owner retires itself (modelled; Phase 7 7C-K8).
 *
 * "Known gap (C1-...)" marks today's behaviour where it is not the desired
 * one. Where a planned C1 increment would change a row, the row names it;
 * those increments wait for the owner's decision (owner decision pending),
 * and only an approved one flips its rows.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeNativeAudioContext,
  type FakeNativeCallPlan,
} from './__helpers__/fake-audio-context.ts';
import {
  QUEUE_B,
  bind,
  loadMediaSession,
  loadOwners,
  nativeCalls,
  ordinaryBranchOwnerSide,
  playRequest,
  loadUiTouchSound,
  playbackScope,
  recordBus,
  setVisibility,
  setupOwnerTest,
  stageFile,
  stageIdle,
  stageYouTube,
  teardownOwnerTest,
  traceDispatch,
  warmMediaSessionGraph,
  type Owners,
  type PlayRequest,
  type ScopeView,
} from './__helpers__/audio-output-owners.ts';

const NO_ATTEMPT: ScopeView = { attempt: 'none', gesture: false };
const INTERRUPTION_REFUSED = [
  'os:interrupted',
  'statechange:interrupted',
  'resume()',
  'resume:rejected',
];

beforeAll(warmMediaSessionGraph, 30_000);
beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

type Stage = 'file' | 'youtube' | 'idle';

function stage(o: Owners, mode: Stage): void {
  if (mode === 'file') stageFile(o);
  else if (mode === 'youtube') stageYouTube(o);
  else stageIdle(o);
}

/**
 * A play-request restart whose two suspends both resolve while the state
 * still says running: it retires at 1,750 ms and leaves the 250 ms late
 * suspend fence with no successor attempt.
 */
async function retireIntoFence(o: Owners, fake: FakeNativeAudioContext): Promise<PlayRequest> {
  fake.planSuspend({ toState: 'unchanged' }, { toState: 'unchanged' });
  const request = playRequest.arm(o, fake);
  await vi.advanceTimersByTimeAsync(1_760);
  await expect(request.first).resolves.toBe('preparing');
  await expect(request.prepared).resolves.toBe(false);
  return request;
}

describe('RO-01 an OS interruption inside the play-request late-suspend fence (250 ms)', () => {
  const ROWS: Array<{
    mode: Stage;
    inside: { needed: string[]; scope: ScopeView };
    outside: ScopeView;
  }> = [
    // The refused cleanup resume hands the parked context to the binding,
    // which adopts it as a stalled file attempt and notifies (the dialog).
    {
      mode: 'file',
      inside: {
        needed: ['background-resume:clock-stalled'],
        scope: { attempt: 'file', gesture: true },
      },
      outside: { attempt: 'file', gesture: true },
    },
    // Phase 7 7B-4 (owner answer Q6; it was Known gap C1-I11, the fence
    // dropped the YouTube owner): with no attempt waiting behind the fence,
    // the binding takes a YouTube room's interruption as it would outside the
    // fence, an attempt that holds the interrupted context with its automatic
    // resume. Before, the fence's cleanup resume ran and adoption kept only a
    // file identity, so no owner held the context. The fence lasts 250 ms
    // after a play-request restart retires, and those start only from a
    // local-file PLAY, so YouTube mode inside it needs a switch to YouTube in
    // that window.
    {
      mode: 'youtube',
      inside: { needed: [], scope: { attempt: 'youtube', gesture: true } },
      outside: { attempt: 'youtube', gesture: true },
    },
    // Nothing plays: not a gap. Inside and outside the fence the same native
    // calls and no attempt; only which part issues the resume differs (the
    // fence's cleanup inside, the binding's plain automatic resume outside).
    { mode: 'idle', inside: { needed: [], scope: NO_ATTEMPT }, outside: NO_ATTEMPT },
  ];

  it.each(ROWS)(
    '$mode: the binding defers to the fence; with no attempt waiting there it judges the state, a YouTube room as outside the fence',
    async ({ mode, inside }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stage(o, mode);
      const bus = recordBus(o);
      const trace = traceDispatch(fake);
      trace.label('dispatcher');
      bind(o, fake);
      trace.label('play-request');
      await retireIntoFence(o, fake);
      expect(nativeCalls(fake.ops)).toEqual(['suspend()', 'suspend()']);
      // One listener per context (Phase 7 7B-4; it was two, the binding and
      // the fence): the fence is a part of the context's dispatcher.
      expect(fake.statechangeListenerCount).toBe(1);

      const before = fake.ops.length;
      fake.planResume({ outcome: 'reject' }); // An interrupted context refuses resume().
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(fake.ops.slice(before)).toEqual(INTERRUPTION_REFUSED);
      // The one listener made the one resume(): the fence's cleanup for a
      // file or nothing playing, the binding's automatic resume for YouTube
      // (before 7B-4: the binding's listener dropped it and the fence's own
      // listener resumed, ['binding@interrupted', 'play-request@interrupted>resume()']).
      expect(trace.order).toEqual(['dispatcher@interrupted>resume()']);
      expect(bus.needed).toEqual(inside.needed);
      expect(bus.rejoins).toEqual([]);
      expect(playbackScope.view(o)).toEqual(inside.scope);
      expect(fake.statechangeListenerCount).toBe(1);
      expect(fake.state).toBe('interrupted');
    },
  );

  it.each(ROWS)(
    '$mode control: outside any fence the binding owns the interruption',
    async ({ mode, outside }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stage(o, mode);
      const bus = recordBus(o);
      const trace = traceDispatch(fake);
      trace.label('binding');
      bind(o, fake);

      fake.planResume({ outcome: 'reject' });
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(fake.ops).toEqual(INTERRUPTION_REFUSED);
      expect(trace.order).toEqual(['binding@interrupted>resume()']);
      expect(bus.needed).toEqual([]);
      expect(playbackScope.view(o)).toEqual(outside);
      expect(fake.statechangeListenerCount).toBe(1);
    },
  );

  it('with a successor attempt (today) the fence hands the interrupted state to it', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const bus = recordBus(o);
    bind(o, fake);
    // Only the first suspend resolves while running; at 750 ms the same
    // attempt waits behind the fence for its fresh suspend.
    fake.planSuspend({ toState: 'unchanged' });
    const request = playRequest.arm(o, fake);
    await vi.advanceTimersByTimeAsync(760);

    const before = fake.ops.length;
    fake.planResume({ outcome: 'reject' });
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fake.ops.slice(before)).toEqual(['os:interrupted', 'statechange:interrupted']);
    expect(nativeCalls(fake.ops)).toEqual(['suspend()']);
    await expect(request.first).resolves.toBe('preparing');
    await expect(request.prepared).resolves.toBe(true);
    expect(request.isCurrent()).toBe(true);
    expect(bus.needed).toEqual([]);
    expect(playbackScope.view(o)).toEqual(NO_ATTEMPT);
    expect(fake.statechangeListenerCount).toBe(1);
  });
});

/**
 * Phase 7 7B-4 (owner answer Q6): the playback scope's second suspend now
 * waits for the same 250 ms late fence, so a real interruption can land in
 * that new wait. The owner's expected result, by mode: a local file goes on
 * to its recovery dialog as before, and a YouTube room gets the same
 * automatic recovery as outside the wait. With nothing playing there is no
 * playback-scope attempt, so no such fence (the idle rows above keep the
 * binding's no-playback resume).
 *
 * Each attempt reaches its suspend through the automatic clock check: an
 * interruption, the automatic resume, and the probe finds the clock frozen
 * (about 360 ms); the first suspend resolves while the state still says
 * running.
 */
describe('RO-01 an OS interruption inside the playback-scope late-suspend fence (Phase 7 7B-4)', () => {
  async function parkScopeAttemptBehindTheFence(o: Owners, fake: FakeNativeAudioContext) {
    fake.freezeClock();
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(400);
    expect(nativeCalls(fake.ops)).toEqual(['resume()', 'suspend()']);
    expect(playbackScope.view(o)).toMatchObject({ gesture: false });
  }

  it.each(['file', 'youtube'] as const)(
    '%s: the attempt waiting behind the fence takes it, with no second native suspend',
    async (mode) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stage(o, mode);
      const bus = recordBus(o);
      bind(o, fake);
      // The first suspend is lost; a second would never land.
      fake.planSuspend({ toState: 'unchanged' }, { outcome: 'never' });
      await parkScopeAttemptBehindTheFence(o, fake);
      // Past the first suspend's 750 ms watchdog: inside its late fence.
      await vi.advanceTimersByTimeAsync(720);

      const before = fake.ops.length;
      fake.planResume({ outcome: 'reject' });
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(2_000);

      // Before 7B-4 the second suspend had already gone out at 750 ms and the
      // interruption settled that one instead: the same parked attempt, one
      // native suspend more.
      expect(fake.ops.slice(before)).toEqual(['os:interrupted', 'statechange:interrupted']);
      expect(nativeCalls(fake.ops)).toEqual(['resume()', 'suspend()']);
      expect(bus.needed).toEqual(['background-resume:clock-stalled']);
      expect(playbackScope.view(o)).toEqual({ attempt: mode, gesture: true });
      expect(fake.statechangeListenerCount).toBe(1);
    },
  );

  it.each([
    // The refused cleanup resume hands the parked context to the binding,
    // which adopts it for the dialog, as inside the play-request fence. Before
    // 7B-4 no fence followed the scope's last suspend: the binding took the
    // interruption for an OS one (an attempt, its refused automatic resume,
    // no dialog).
    { mode: 'file' as const, needed: ['background-resume:clock-stalled'] },
    // As outside the fence (and as before 7B-4, when no fence followed).
    { mode: 'youtube' as const, needed: [] },
  ])(
    '$mode: after both suspends were lost no attempt waits there; a file goes to its dialog, YouTube as outside the fence',
    async ({ mode, needed }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stage(o, mode);
      const bus = recordBus(o);
      bind(o, fake);
      fake.planSuspend({ toState: 'unchanged' }, { toState: 'unchanged' });
      await parkScopeAttemptBehindTheFence(o, fake);
      // The second suspend at about 1,360 ms gives up at about 2,110 ms (both
      // 250 ms later than before 7B-4); stop inside the fence that follows.
      await vi.advanceTimersByTimeAsync(1_720);
      expect(nativeCalls(fake.ops)).toEqual(['resume()', 'suspend()', 'suspend()']);
      expect(playbackScope.view(o)).toEqual(NO_ATTEMPT);

      const before = fake.ops.length;
      fake.planResume({ outcome: 'reject' });
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(fake.ops.slice(before)).toEqual(INTERRUPTION_REFUSED);
      expect(bus.needed).toEqual(needed);
      expect(bus.rejoins).toEqual([]);
      expect(playbackScope.view(o)).toEqual({ attempt: mode, gesture: true });
      expect(fake.statechangeListenerCount).toBe(1);
    },
  );
});

describe('RO-01 YouTube attempts that reach the clock-stalled phase (no dialog: app.ts is file-only)', () => {
  it('the automatic clock check parks one; a UI sound wakes it and the owner re-suspends', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageYouTube(o);
    const bus = recordBus(o);
    bind(o, fake);
    fake.freezeClock();

    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fake.ops).toEqual([
      'os:interrupted',
      'statechange:interrupted',
      'resume()',
      'statechange:running',
      'resume:resolved',
      'suspend()',
      'statechange:suspended',
      'suspend:resolved',
    ]);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });

    // Known gap (C1-I11/I13, YouTube stall without a dialog): nothing ends
    // this attempt; the context stays parked for a gesture no dialog asks for.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.state).toBe('suspended');
    expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });

    const touch = await loadUiTouchSound();
    const before = fake.ops.length;
    touch();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.ops.slice(before)).toEqual([
      'resume()',
      'statechange:running',
      'suspend()',
      'resume:resolved',
      'statechange:suspended',
      'suspend:resolved',
    ]);
    expect(bus.needed).toEqual([
      'background-resume:clock-stalled',
      'background-resume:clock-stalled',
    ]);
    expect(bus.rejoins).toEqual([]);
    expect(bus.youtubeLocal).toEqual([]);
    expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });
    expect(fake.state).toBe('suspended');
  });

  it('a hardware PLAY escalates one to clock-stalled and nothing resumes YouTube locally', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageYouTube(o);
    const bus = recordBus(o);
    bind(o, fake);
    const mediaSession = await loadMediaSession();
    fake.planResume({ outcome: 'reject' });
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });
    fake.freezeClock();

    const before = fake.ops.length;
    mediaSession.play();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(fake.ops.slice(before)).toEqual([
      'resume()',
      'statechange:running',
      'resume:resolved',
      'suspend()',
      'statechange:suspended',
      'suspend:resolved',
    ]);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    // Known gap (C1-I11/I13, YouTube stall without a dialog).
    expect(bus.youtubeLocal).toEqual([]);
    expect(bus.rejoins).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });
    expect(fake.state).toBe('suspended');
  });
});

describe('RO-01 two suspend requests from one foreground incident', () => {
  it.each([
    {
      // The playback-scope suspend outlasts transport's two 180 ms PLAY samples.
      latencyMs: 600,
      probe: 'clock-stalled',
      ops: ['suspend()', 'statechange:suspended', 'suspend:resolved'],
      needed: [],
      request: { first: 'prepared', prepared: true },
      inspection: { status: 'stale', reason: 'superseded' },
      scope: NO_ATTEMPT,
    },
    {
      latencyMs: 200,
      probe: 'not-running',
      ops: ['suspend()', 'statechange:suspended', 'suspend:resolved'],
      needed: [],
      request: null,
      inspection: { status: 'needs-gesture', reason: 'clock-stalled' },
      scope: { attempt: 'file', gesture: true },
    },
  ])(
    'playback-scope suspend latency $latencyMs ms, then the PLAY probe',
    async ({ latencyMs, probe, ops, needed, request, inspection, scope }) => {
      const fake = new FakeNativeAudioContext();
      fake.freezeClock();
      const o = await loadOwners(fake);
      const { inspectBackgroundFileOutput } = await import('../output-health.ts');
      stageFile(o);
      const bus = recordBus(o);
      bind(o, fake);
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(2_000);
      setVisibility('visible');
      fake.planSuspend({ latencyMs }, { latencyMs });

      const inspected = inspectBackgroundFileOutput();
      await vi.advanceTimersByTimeAsync(370); // Its two 180 ms samples, then its suspend.
      const counts = [fake.statechangeListenerCount];
      const play = playRequest.afterProbe(o); // The same incident's PLAY probe.
      await vi.advanceTimersByTimeAsync(370);
      const played = await play;
      counts.push(fake.statechangeListenerCount);
      await vi.advanceTimersByTimeAsync(3_000);
      counts.push(fake.statechangeListenerCount);

      expect(played.probe).toBe(probe);
      expect(fake.ops).toEqual(ops);
      expect(bus.needed).toEqual(needed);
      if (request) {
        // Phase 7 7B-4 (owner answer Q6; it was Known gap C1-I11, two
        // leases): the PLAY's request takes the scope's lease in flight over,
        // so one native suspend and one recovery request, transport's
        // play:clock-stalled for the later-started PLAY. The return check's
        // attempt retires with no notice (before: a second native suspend
        // and its bus notice too). app.ts's part, that this dialog stays and
        // its button retries the PLAY, is the browser lab's row (iii).
        await expect(played.request!.first).resolves.toBe(request.first);
        await expect(played.request!.prepared).resolves.toBe(request.prepared);
        expect(played.request!.isCurrent()).toBe(true);
      } else {
        expect(played.request).toBeNull();
      }
      expect(await inspected).toMatchObject(inspection);
      expect(playbackScope.view(o)).toEqual(scope);
      // One listener per context while both ask (Phase 7 7B-4; it was one per
      // owner, [2, 3, 1] and [2, 1, 1]).
      expect(counts).toEqual([1, 1, 1]);
      expect(fake.state).toBe('suspended');
    },
  );
});

/**
 * Phase 7 7B-4 (owner answer Q6, E11, E22): one statechange listener per
 * context, the suspend ledger's dispatcher (the owner's since 7C-4), and inside it the
 * fixed order binding, lease, late fence, play-request resume promotion,
 * whichever part arrived first. Before, every owner added its own listener,
 * so the order was the order the listeners were added and differed per
 * scene (each row says what it was). The trace labels the listeners added
 * from each step on: the context's one listener carries the label of the
 * step that added it, and any second listener would show its own label.
 * The loading indicator's reader (src/ui/file-start-loading.ts) stays
 * outside the dispatcher and is not loaded here.
 */
describe('RO-01 statechange dispatch order and owner listeners per context', () => {
  it('a playback-scope lease, then a play-request that takes it over: one listener, one suspend', async () => {
    const fake = new FakeNativeAudioContext();
    fake.freezeClock();
    const o = await loadOwners(fake);
    stageFile(o);
    const bus = recordBus(o);
    const trace = traceDispatch(fake);
    trace.label('dispatcher');
    bind(o, fake);
    fake.planSuspend({ latencyMs: 600 }, { latencyMs: 600 });
    trace.label('scope-lease');
    const armed = playbackScope.armStalled(o, fake);
    await vi.advanceTimersByTimeAsync(100);
    trace.label('request-lease');
    const request = playRequest.arm(o, fake);
    const counts = [fake.statechangeListenerCount];
    await vi.advanceTimersByTimeAsync(2_000);
    counts.push(fake.statechangeListenerCount);

    // Before: ['binding@suspended', 'scope-lease@suspended',
    // 'request-lease@suspended'] and [3, 1].
    expect(trace.order).toEqual(['dispatcher@suspended']);
    expect(counts).toEqual([1, 1]);
    // The later request takes the lease over and the earlier attempt
    // retires: one native suspend, no notice from the playback scope, the
    // play-request parked (before: two suspends and the scope's notice).
    expect(nativeCalls(fake.ops)).toEqual(['suspend()']);
    expect(bus.needed).toEqual([]);
    await expect(armed).resolves.toBe('stale');
    await expect(request.prepared).resolves.toBe(true);
    expect(playbackScope.view(o)).toEqual(NO_ATTEMPT);
  });

  it('a play-request lease before the binding (a start path with no binding yet)', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const bus = recordBus(o);
    const trace = traceDispatch(fake);
    fake.planSuspend({ latencyMs: 100 });
    trace.label('dispatcher');
    const request = playRequest.arm(o, fake);
    trace.label('binding');
    bind(o, fake);
    const counts = [fake.statechangeListenerCount];
    await vi.advanceTimersByTimeAsync(1_000);
    counts.push(fake.statechangeListenerCount);

    // Before: ['request-lease@suspended', 'binding@suspended'] and [2, 1].
    expect(trace.order).toEqual(['dispatcher@suspended']);
    expect(counts).toEqual([1, 1]);
    expect(fake.ops).toEqual(['suspend()', 'statechange:suspended', 'suspend:resolved']);
    await expect(request.first).resolves.toBe('prepared');
    expect(bus.needed).toEqual([]);
    expect(playbackScope.view(o)).toEqual(NO_ATTEMPT);
  });

  it('the order is fixed: a late fence that came before the binding still lets the binding judge first', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const bus = recordBus(o);
    const trace = traceDispatch(fake);
    // A play-request restart with no binding yet retires into its fence
    // (the start path above); the engine binds inside that fence.
    trace.label('fence');
    await retireIntoFence(o, fake);
    trace.label('binding');
    bind(o, fake);
    expect(fake.statechangeListenerCount).toBe(1);

    const before = fake.ops.length;
    fake.planResume({ outcome: 'reject' }, { outcome: 'reject' });
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(2_000);

    // The binding judges first and defers to the fence, whose cleanup resume
    // is the only one; the file is adopted for its dialog, as in the bound
    // fence row. Before (an intended change of 7B-4, E11): the fence's
    // listener came first and resumed, then the binding's own listener took
    // the same interruption for an OS one and resumed again,
    // ['fence@interrupted>resume()', 'binding@interrupted>resume()'].
    expect(fake.ops.slice(before)).toEqual(INTERRUPTION_REFUSED);
    expect(trace.order).toEqual(['fence@interrupted>resume()']);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    expect(playbackScope.view(o)).toEqual({ attempt: 'file', gesture: true });
    expect(fake.statechangeListenerCount).toBe(1);
  });

  it('a play-request gesture resume adds no listener while it flies', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const trace = traceDispatch(fake);
    trace.label('dispatcher');
    bind(o, fake);
    trace.label('request-lease');
    const request = playRequest.arm(o, fake);
    await expect(request.first).resolves.toBe('prepared');
    const counts = [fake.statechangeListenerCount];
    fake.planResume({ latencyMs: 50 });
    trace.label('request-resume');
    const tap = request.tap();
    counts.push(fake.statechangeListenerCount);
    await vi.advanceTimersByTimeAsync(1_000);
    counts.push(fake.statechangeListenerCount);

    // Before: ['binding@suspended', 'request-lease@suspended',
    // 'binding@running', 'request-resume@running'] and [1, 2, 1].
    expect(trace.order).toEqual(['dispatcher@suspended', 'dispatcher@running']);
    expect(counts).toEqual([1, 1, 1]);
    await expect(tap).resolves.toEqual({ running: true });
    expect(request.requirement()).toBe('same');
  });

  it('a playback-scope gesture resume adds no listener', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const bus = recordBus(o);
    const trace = traceDispatch(fake);
    trace.label('dispatcher');
    bind(o, fake);
    trace.label('scope-lease');
    await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
    const counts = [fake.statechangeListenerCount];
    fake.planResume({ latencyMs: 50 });
    trace.label('scope-resume');
    const tap = playbackScope.tap(o);
    counts.push(fake.statechangeListenerCount);
    await vi.advanceTimersByTimeAsync(1_000);
    counts.push(fake.statechangeListenerCount);

    // Before: ['binding@suspended', 'scope-lease@suspended', 'binding@running'].
    expect(trace.order).toEqual(['dispatcher@suspended', 'dispatcher@running']);
    expect(counts).toEqual([1, 1, 1]);
    await expect(tap).resolves.toEqual({ running: true });
    expect(playbackScope.requirement(o)).toBe('same');
    expect(bus.needed).toEqual([]);
  });

  it('one listener per context while a lease, its late fence and a slow gesture resume come and go', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const trace = traceDispatch(fake);
    trace.label('dispatcher');
    bind(o, fake);
    trace.label('other');
    const counts: number[] = [];
    // A play-request restart whose first suspend is lost: its lease, the late
    // fence with the attempt waiting behind it, then a fresh lease that lands.
    fake.planSuspend({ toState: 'unchanged' }, {});
    const request = playRequest.arm(o, fake);
    counts.push(fake.statechangeListenerCount);
    await vi.advanceTimersByTimeAsync(760);
    counts.push(fake.statechangeListenerCount);
    await vi.advanceTimersByTimeAsync(300);
    await expect(request.prepared).resolves.toBe(true);
    counts.push(fake.statechangeListenerCount);
    // Its gesture resume is slower than its 750 ms deadline: the promotion
    // waits past the deadline, then promotes.
    fake.planResume({ latencyMs: 1_200 });
    const tap = request.tap();
    counts.push(fake.statechangeListenerCount);
    await vi.advanceTimersByTimeAsync(800);
    counts.push(fake.statechangeListenerCount);
    await vi.advanceTimersByTimeAsync(1_000);
    counts.push(fake.statechangeListenerCount);

    // Before: [2, 2, 1, 2, 2, 1] (the binding, plus the lease, the fence or
    // the resume listener).
    expect(counts).toEqual([1, 1, 1, 1, 1, 1]);
    expect(trace.order).toEqual(['dispatcher@suspended', 'dispatcher@running']);
    await expect(tap).resolves.toEqual({ running: false });
    expect(request.requirement()).toBe('same');
  });

  it.each([
    // The order the fake attributes to Chromium for suspend(): the promise
    // settles with the state, the statechange task follows.
    {
      order: 'deferred-event',
      plan: { statechange: 'deferred-event', stateDelayMs: 5 } as FakeNativeCallPlan,
    },
    { order: 'before-settle', plan: {} as FakeNativeCallPlan },
    {
      order: 'after-settle',
      plan: { statechange: 'after-settle', stateDelayMs: 5 } as FakeNativeCallPlan,
    },
  ])(
    'one background stall, suspend $order: no owner notice beside app.ts own request (App 9.0.42; it was Known gap C1-I11, one prepared notice)',
    async ({ plan }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      const { inspectBackgroundFileOutput } = await import('../output-health.ts');
      stageFile(o);
      const bus = recordBus(o);
      bind(o, fake);
      setVisibility('hidden');
      fake.freezeClock();
      await vi.advanceTimersByTimeAsync(2_000);
      setVisibility('visible');
      fake.planSuspend(plan);

      const inspected = inspectBackgroundFileOutput();
      await vi.advanceTimersByTimeAsync(3_000);

      // app.ts emits its own background-resume request for needs-gesture.
      expect((await inspected).status).toBe('needs-gesture');
      // App 9.0.42 (it was Known gap C1-I11, one prepared notice): with the
      // deferred event the binding hears suspended after the lease settled
      // through its promise; the attempt is parked already, so it notifies no
      // second time with an isCurrent that app.ts's own request lacks, and
      // the dialog sees one identity for one stall (the Chromium lab row
      // (ii) shows it open once).
      expect(bus.needed).toEqual([]);
      expect(playbackScope.view(o)).toEqual({ attempt: 'file', gesture: true });
      expect(nativeCalls(fake.ops)).toEqual(['suspend()']);
    },
  );
});

/**
 * The owner side of the recovery dialog's ordinary branch, modelled
 * (ordinaryBranchOwnerSide): what the owner answers and does around a context
 * resume while a non-file attempt waits, the reason a restore's ordinary
 * branch carries no attempt since Phase 7 7C-K8. The branch itself is pinned
 * through the owner's entry in audio-output-recovery-dialog.test.ts.
 */
describe('RO-01 the owner side of the ordinary dialog branch with a non-file attempt (modelled)', () => {
  it('a YouTube attempt accepts the gesture after the room switched to a file; no file attempt is pending, and after the resume the owner retires it itself', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageYouTube(o);
    const bus = recordBus(o);
    bind(o, fake);
    fake.planResume({ outcome: 'reject' });
    fake.transition('interrupted');
    await vi.advanceTimersByTimeAsync(1_000);
    const youtubeAttempt = playbackScope.current(o);
    expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });

    // The room moves to a local file while the YouTube attempt waits.
    stageFile(o, QUEUE_B);
    await vi.advanceTimersByTimeAsync(100);
    expect(playbackScope.view(o)).toEqual({ attempt: 'youtube', gesture: true });

    const before = fake.ops.length;
    const owner = await ordinaryBranchOwnerSide(o);
    await vi.advanceTimersByTimeAsync(5_000);

    // Phase 7 7C-K8 (it was Known gap C1-I6), owner half: no file attempt is
    // pending, the attempt that accepts the file dialog's gesture is the
    // YouTube one, and after the resume the owner has retired it (identity
    // check), with no notice and no rejoin of its own. So a restore's ordinary
    // branch carries no attempt: its own clock check answers, and on a healthy
    // clock app.ts publishes its own rejoin (code reading).
    expect(owner).toEqual({
      fileAttemptPending: false,
      gestureAttempt: youtubeAttempt,
      afterResume: 'retired',
    });
    expect(fake.ops.slice(before)).toEqual(['resume()', 'statechange:running', 'resume:resolved']);
    expect(bus.needed).toEqual([]);
    expect(bus.rejoins).toEqual([]);
    expect(playbackScope.view(o)).toEqual(NO_ATTEMPT);
  });
});
