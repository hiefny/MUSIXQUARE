/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 "AudioContext running state": what one UI sound does to the shared
 * context in each recovery phase today (the holding baseline).
 *
 * A UI sound resumes the shared context from outside both recovery owners
 * (ui-sounds.ts readyOutput; its trusted pointerdown/keydown path issues the
 * same unowned resume() and cannot be created in jsdom). The C1 increment
 * that lets an owner hold the context (structural plan 7B-3) turns the rows
 * where the owner itself parked the context for a file dialog into 'no
 * resume' and keeps the others; each row says which.
 *
 * Columns: the native calls issued synchronously by the sound, the ops that
 * follow within 3 s, recovery notices, rejoins, which owner holds the context
 * afterwards, and the final state. Boundary and driver as in
 * audio-output-recovery-boundary.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNativeAudioContext } from './__helpers__/fake-audio-context.ts';
import {
  QUEUE_B,
  bind,
  loadOwners,
  nativeCalls,
  ownerView,
  playRequest,
  loadUiTouchSound,
  playbackScope,
  recordBus,
  setupOwnerTest,
  stageFile,
  stageIdle,
  stageYouTube,
  teardownOwnerTest,
  type Owners,
  type ScopeView,
} from './__helpers__/audio-output-owners.ts';

beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

type Arrange = (o: Owners, fake: FakeNativeAudioContext) => Promise<void>;

interface Row {
  readonly phase: string;
  readonly arrange: Arrange;
  readonly before: { state: string; request: 'owned' | 'none'; scope: ScopeView };
  readonly immediate: string[];
  readonly after: string[];
  readonly needed: string[];
  readonly rejoins: string[];
  readonly end: { state: string; request: 'owned' | 'none'; scope: ScopeView };
}

const NONE: ScopeView = { attempt: 'none', gesture: false };
const FILE_PARKED: ScopeView = { attempt: 'file', gesture: true };
const FILE_PREPARING: ScopeView = { attempt: 'file', gesture: false };
const RESUMED = ['resume()', 'statechange:running', 'resume:resolved'];
const RESUMED_THEN_RE_SUSPENDED = [
  'resume()',
  'statechange:running',
  'suspend()',
  'resume:resolved',
  'statechange:suspended',
  'suspend:resolved',
];

async function parkPlayRequest(o: Owners, fake: FakeNativeAudioContext) {
  const request = playRequest.arm(o, fake);
  await expect(request.first).resolves.toBe('prepared');
  return request;
}

const ROWS: Row[] = [
  {
    phase: 'H1 no recovery, running',
    arrange: async () => undefined,
    before: { state: 'running', request: 'none', scope: NONE },
    immediate: [],
    after: [],
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: NONE },
  },
  {
    phase: 'H2 no recovery, suspended by the OS while nothing plays',
    arrange: async (o, fake) => {
      stageIdle(o);
      fake.planResume({ outcome: 'reject' });
      fake.transition('suspended');
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'suspended', request: 'none', scope: NONE },
    immediate: ['resume()'],
    after: RESUMED,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: NONE },
  },
  {
    // Kept by 7B-3 only in its file rows: the dialog is about to open.
    phase: 'H3 play-request preparing-suspend (suspend in flight)',
    arrange: async (o, fake) => {
      fake.planSuspend({ latencyMs: 300 });
      const request = playRequest.arm(o, fake);
      void request.first.then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'running', request: 'owned', scope: NONE },
    immediate: [],
    after: ['statechange:suspended', 'suspend:resolved'],
    needed: [],
    rejoins: [],
    end: { state: 'suspended', request: 'owned', scope: NONE },
  },
  {
    // Flipped by 7B-3: the sound resumes the context the dialog's tap needs.
    phase: 'H4 play-request awaiting-gesture',
    arrange: async (o, fake) => {
      await parkPlayRequest(o, fake);
    },
    before: { state: 'suspended', request: 'owned', scope: NONE },
    immediate: ['resume()'],
    after: RESUMED,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'owned', scope: NONE },
  },
  {
    phase: 'H5 play-request gesture-resuming (resume in flight)',
    arrange: async (o, fake) => {
      const request = await parkPlayRequest(o, fake);
      fake.planResume({ latencyMs: 1_200 });
      void request.tap().then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'suspended', request: 'owned', scope: NONE },
    immediate: ['resume()'],
    // The sound's resume lands first; the owner's resume listener promotes.
    after: ['resume()', 'statechange:running', 'resume:resolved', 'resume:resolved'],
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'owned', scope: NONE },
  },
  {
    // Kept by 7B-3: the sound's resume completes this recovery.
    phase: 'H6 playback-scope awaiting-resume (OS interruption, automatic resume refused)',
    arrange: async (o, fake) => {
      stageFile(o);
      fake.planResume({ outcome: 'reject' });
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(1_000);
    },
    before: { state: 'interrupted', request: 'none', scope: FILE_PARKED },
    immediate: ['resume()'],
    after: RESUMED,
    needed: [],
    rejoins: ['audio-context-recovered'],
    end: { state: 'running', request: 'none', scope: NONE },
  },
  {
    phase: 'H7 playback-scope preparing-suspend (stalled, suspend in flight)',
    arrange: async (o, fake) => {
      stageFile(o);
      fake.planSuspend({ latencyMs: 300 });
      void playbackScope.armStalled(o, fake).then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'running', request: 'none', scope: FILE_PREPARING },
    immediate: [],
    after: ['statechange:suspended', 'suspend:resolved'],
    needed: [],
    rejoins: [],
    end: { state: 'suspended', request: 'none', scope: FILE_PARKED },
  },
  {
    // Flipped by 7B-3: the dialog for this file attempt can be open.
    phase: 'H8 playback-scope awaiting-gesture (file)',
    arrange: async (o, fake) => {
      stageFile(o);
      await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
    },
    before: { state: 'suspended', request: 'none', scope: FILE_PARKED },
    immediate: ['resume()'],
    after: RESUMED_THEN_RE_SUSPENDED,
    needed: ['background-resume:clock-stalled'],
    rejoins: [],
    end: { state: 'suspended', request: 'none', scope: FILE_PARKED },
  },
  {
    // Kept by 7B-3: the attempt is stale; the owner retires it and restores.
    phase: 'H9 playback-scope awaiting-gesture, identity stale (queue changed)',
    arrange: async (o, fake) => {
      stageFile(o);
      await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
      stageFile(o, QUEUE_B);
      await vi.advanceTimersByTimeAsync(10);
    },
    before: { state: 'suspended', request: 'none', scope: FILE_PARKED },
    immediate: ['resume()'],
    after: [
      'resume()',
      'statechange:running',
      'suspend()',
      'resume:resolved',
      'statechange:suspended',
      'resume()',
      'suspend:resolved',
      'statechange:running',
      'resume:resolved',
    ],
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: NONE },
  },
  {
    // Kept by 7B-3 (no dialog serves YouTube): see the boundary file's
    // YouTube stall rows.
    phase: 'H10 playback-scope awaiting-gesture, YouTube (raised by the automatic clock check)',
    arrange: async (o, fake) => {
      stageYouTube(o);
      fake.freezeClock();
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(2_000);
      fake.runClock();
    },
    before: { state: 'suspended', request: 'none', scope: { attempt: 'youtube', gesture: true } },
    immediate: ['resume()'],
    after: RESUMED_THEN_RE_SUSPENDED,
    needed: ['background-resume:clock-stalled'],
    rejoins: [],
    end: { state: 'suspended', request: 'none', scope: { attempt: 'youtube', gesture: true } },
  },
  {
    // Flipped by 7B-3.
    phase: 'H11 playback-scope gesture-resuming (resume in flight)',
    arrange: async (o, fake) => {
      stageFile(o);
      await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
      fake.planResume({ latencyMs: 1_200 });
      void playbackScope.tap(o).then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'suspended', request: 'none', scope: FILE_PREPARING },
    immediate: ['resume()'],
    // The sound's resume lands first: the attempt moves to clock
    // verification, with no gesture token, before its own resume settles.
    after: ['resume()', 'statechange:running', 'resume:resolved', 'resume:resolved'],
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: FILE_PREPARING },
  },
];

describe('RO-01 holding baseline: one UI sound per recovery phase', () => {
  it.each(ROWS)('$phase', async (row) => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    const bus = recordBus(o);
    bind(o, fake);
    await row.arrange(o, fake);
    expect({ state: fake.state, ...ownerView(o) }).toEqual(row.before);
    const touch = await loadUiTouchSound();
    const neededBefore = bus.needed.length;
    const before = fake.ops.length;

    touch();
    const immediate = nativeCalls(fake.ops.slice(before));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(immediate).toEqual(row.immediate);
    expect(fake.ops.slice(before)).toEqual(row.after);
    expect(bus.needed.slice(neededBefore)).toEqual(row.needed);
    expect(bus.rejoins).toEqual(row.rejoins);
    expect({ state: fake.state, ...ownerView(o) }).toEqual(row.end);
  });
});
