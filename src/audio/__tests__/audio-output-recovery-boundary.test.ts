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
 * - the owner side of app.ts's ordinary dialog branch carrying a non-file
 *   attempt (modelled: app.ts is not loaded).
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
    // Known gap (C1-I11, fence drops the YouTube owner): adoption keeps only a
    // file identity, so no owner holds the interrupted context and nothing
    // retries it until another statechange or an outside resume arrives. The
    // fence lasts 250 ms after a play-request restart retires, and those
    // start only from a local-file PLAY, so YouTube mode inside it needs a
    // switch to YouTube in that window. Outside it the binding holds a
    // YouTube attempt.
    {
      mode: 'youtube',
      inside: { needed: [], scope: NO_ATTEMPT },
      outside: { attempt: 'youtube', gesture: true },
    },
    // Nothing plays: not a gap. Inside and outside the fence the same native
    // calls and no attempt; only which listener issues the resume differs
    // (the fence cleanup inside, the binding's plain automatic resume outside).
    { mode: 'idle', inside: { needed: [], scope: NO_ATTEMPT }, outside: NO_ATTEMPT },
  ];

  it.each(ROWS)(
    '$mode: the binding drops it and the fence cleanup resume runs instead',
    async ({ mode, inside }) => {
      const fake = new FakeNativeAudioContext();
      const o = await loadOwners(fake);
      stage(o, mode);
      const bus = recordBus(o);
      const trace = traceDispatch(fake);
      trace.label('binding');
      bind(o, fake);
      trace.label('play-request');
      await retireIntoFence(o, fake);
      expect(nativeCalls(fake.ops)).toEqual(['suspend()', 'suspend()']);
      // The binding and the fence. Flipped by 7B-4 (one dispatcher per
      // context; Q6, owner decision pending): one listener, and the order
      // inside it binding, lease, fence, resume promotion.
      expect(fake.statechangeListenerCount).toBe(2);

      const before = fake.ops.length;
      fake.planResume({ outcome: 'reject' }); // An interrupted context refuses resume().
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(fake.ops.slice(before)).toEqual(INTERRUPTION_REFUSED);
      // Listener order, flipped by 7B-4 as above: the trace then sees one listener.
      expect(trace.order).toEqual(['binding@interrupted', 'play-request@interrupted>resume()']);
      expect(bus.needed).toEqual(inside.needed);
      expect(bus.rejoins).toEqual([]);
      expect(playbackScope.view(o)).toEqual(inside.scope);
      // The binding alone (also one after 7B-4: the dispatcher).
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

describe('RO-01 two suspend leases from one foreground incident', () => {
  it.each([
    {
      // The playback-scope suspend outlasts transport's two 180 ms PLAY samples.
      latencyMs: 600,
      probe: 'clock-stalled',
      ops: [
        'suspend()',
        'suspend()',
        'statechange:suspended',
        'suspend:resolved',
        'suspend:resolved',
      ],
      needed: ['background-resume:clock-stalled'],
      request: { first: 'prepared', prepared: true },
      inspection: { status: 'stale', reason: 'superseded' },
      listeners: [2, 3, 1],
    },
    {
      latencyMs: 200,
      probe: 'not-running',
      ops: ['suspend()', 'statechange:suspended', 'suspend:resolved'],
      needed: [],
      request: null,
      inspection: { status: 'needs-gesture', reason: 'clock-stalled' },
      listeners: [2, 1, 1],
    },
  ])(
    'playback-scope suspend latency $latencyMs ms, then the PLAY probe',
    async ({ latencyMs, probe, ops, needed, request, inspection, listeners }) => {
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
      // The playback scope notifies synchronously with its settlement; the
      // play-request answer reaches transport through its promise after it.
      expect(bus.needed).toEqual(needed);
      if (needed.length > 0) expect(bus.neededEvents[0]?.isCurrent?.()).toBe(true);
      if (request) {
        // Known gap (C1-I11, two leases): two native suspends and two
        // recovery requests (this bus notice plus transport's
        // play:clock-stalled) for one stall. 7B-4 (one lease; Q6, owner
        // decision pending) would make it one suspend and one request. Which
        // dialog stays, and what its button does, has no row yet: app.ts's
        // part needs a browser row.
        await expect(played.request!.first).resolves.toBe(request.first);
        await expect(played.request!.prepared).resolves.toBe(request.prepared);
        expect(played.request!.isCurrent()).toBe(true);
      } else {
        expect(played.request).toBeNull();
      }
      expect(await inspected).toMatchObject(inspection);
      expect(playbackScope.view(o)).toEqual({ attempt: 'file', gesture: true });
      // Listener counts per owner, flipped by 7B-4 (one dispatcher, Q6): [1, 1, 1].
      expect(counts).toEqual(listeners);
      expect(fake.state).toBe('suspended');
    },
  );
});

/**
 * Today every owner adds its own statechange listener, so the dispatch order
 * is the order the listeners were added and differs per scene. Every order
 * and count row here is flipped by 7B-4 (one dispatcher per context; Q6,
 * owner decision pending): one listener per context, and inside it the
 * order binding, lease, fence, resume promotion, the same in every scene.
 * A row that 7B-4 changes beyond its order and counts says so.
 */
describe('RO-01 statechange dispatch order and owner listeners per context', () => {
  it('binding, then a playback-scope lease, then a play-request lease', async () => {
    const fake = new FakeNativeAudioContext();
    fake.freezeClock();
    const o = await loadOwners(fake);
    stageFile(o);
    const bus = recordBus(o);
    const trace = traceDispatch(fake);
    trace.label('binding');
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

    expect(trace.order).toEqual([
      'binding@suspended',
      'scope-lease@suspended',
      'request-lease@suspended',
    ]);
    expect(counts).toEqual([3, 1]);
    // 7B-4 also makes these one lease: the later request takes it over and
    // the earlier attempt retires, so one native suspend.
    expect(nativeCalls(fake.ops)).toEqual(['suspend()', 'suspend()']);
    expect(bus.needed).toEqual(['background-resume:clock-stalled']);
    await expect(armed).resolves.toBe('preparing');
    await expect(request.prepared).resolves.toBe(true);
  });

  it('a play-request lease before the binding (a start path with no binding yet)', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const bus = recordBus(o);
    const trace = traceDispatch(fake);
    fake.planSuspend({ latencyMs: 100 });
    trace.label('request-lease');
    const request = playRequest.arm(o, fake);
    trace.label('binding');
    bind(o, fake);
    const counts = [fake.statechangeListenerCount];
    await vi.advanceTimersByTimeAsync(1_000);
    counts.push(fake.statechangeListenerCount);

    expect(trace.order).toEqual(['request-lease@suspended', 'binding@suspended']);
    expect(counts).toEqual([2, 1]);
    expect(fake.ops).toEqual(['suspend()', 'statechange:suspended', 'suspend:resolved']);
    await expect(request.first).resolves.toBe('prepared');
    expect(bus.needed).toEqual([]);
    expect(playbackScope.view(o)).toEqual(NO_ATTEMPT);
  });

  it('a play-request gesture resume adds its own listener while it flies', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const trace = traceDispatch(fake);
    trace.label('binding');
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

    expect(trace.order).toEqual([
      'binding@suspended',
      'request-lease@suspended',
      'binding@running',
      'request-resume@running',
    ]);
    expect(counts).toEqual([1, 2, 1]);
    await expect(tap).resolves.toEqual({ running: true });
    expect(request.requirement()).toBe('same');
  });

  it('a playback-scope gesture resume adds no listener', async () => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    stageFile(o);
    const bus = recordBus(o);
    const trace = traceDispatch(fake);
    trace.label('binding');
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

    expect(trace.order).toEqual(['binding@suspended', 'scope-lease@suspended', 'binding@running']);
    expect(counts).toEqual([1, 1, 1]);
    await expect(tap).resolves.toEqual({ running: true });
    expect(playbackScope.requirement(o)).toBe('same');
    expect(bus.needed).toEqual([]);
  });

  it.each([
    // The order the fake attributes to Chromium for suspend(): the promise
    // settles with the state, the statechange task follows.
    {
      order: 'deferred-event',
      plan: { statechange: 'deferred-event', stateDelayMs: 5 } as FakeNativeCallPlan,
      notices: 1,
    },
    { order: 'before-settle', plan: {} as FakeNativeCallPlan, notices: 0 },
    {
      order: 'after-settle',
      plan: { statechange: 'after-settle', stateDelayMs: 5 } as FakeNativeCallPlan,
      notices: 0,
    },
  ])(
    'one background stall, suspend $order: $notices owner notice(s) beside app.ts own request',
    async ({ plan, notices }) => {
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
      // Known gap (C1-I11, one prepared notice): with the deferred event the
      // binding hears suspended after the lease settled through its promise
      // and notifies again, with an isCurrent that app.ts's own request lacks,
      // so the dialog sees two identities for one stall (the Chromium lab row
      // shows the dialog closing and reopening).
      expect(bus.needed).toEqual(Array(notices).fill('background-resume:clock-stalled'));
      expect(bus.neededEvents.map((event) => typeof event.isCurrent)).toEqual(
        Array(notices).fill('function'),
      );
      expect(nativeCalls(fake.ops)).toEqual(['suspend()']);
    },
  );
});

/**
 * The owner side of app.ts's ordinary dialog branch, modelled
 * (ordinaryBranchOwnerSide): app.ts is not loaded, so its choice of branch
 * and its own rejoin are not pinned here; that half is code reading, and its
 * browser row is a later test step. This row pins what the owner answers
 * and does around the branch's gesture resume.
 */
describe('RO-01 the owner side of the ordinary dialog branch with a non-file attempt (modelled)', () => {
  it('the gesture carries a YouTube attempt after the room switched to a file; the owner retires it', async () => {
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

    // Known gap (C1-I6, ordinary branch carries a non-file token), owner
    // half: no file attempt is pending, the attempt that accepts the file
    // dialog's gesture is the YouTube one, and after the resume the owner has
    // retired it (identity check), with no notice and no rejoin of its own.
    // app.ts then reads it as not current and ends the dialog with no rejoin
    // (code reading).
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
