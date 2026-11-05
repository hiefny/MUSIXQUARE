/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 "AudioContext running state": what one UI sound does to the shared
 * context in each recovery phase (the holding truth table).
 *
 * UI sounds ask the recovery owners first (ui-sounds.ts canPlayUiSound; its
 * trusted pointerdown/keydown path asks the same question and cannot be
 * created in jsdom). Since Phase 7 7B-3 (owner answer Q9, with 7B-2 and Q8)
 * an owner holds the context while it parks it for a local file's recovery
 * dialog, waits for that dialog's tap, or resumes from it, for an attempt it
 * still holds with a current identity: the sound is silent and issues no
 * resume. An OS interruption waiting for its automatic resume, a stale
 * attempt, a YouTube attempt (no dialog asks for its tap) and a play-request
 * attempt parked for a dialog that never opened are not held: the sound
 * wakes the context and plays as before. Each row says which; the
 * rows that wake prove the question is really asked, since a sound that
 * failed to ask would be silent in every row.
 *
 * Columns: the native calls issued synchronously by the sound, the ops that
 * follow within 3 s, UI tones started, recovery notices, rejoins, which owner
 * holds the context afterwards, and the final state. Boundary and driver as
 * in audio-output-recovery-boundary.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNativeAudioContext } from './__helpers__/fake-audio-context.ts';
import {
  QUEUE_B,
  bind,
  countUiTones,
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
  /** UI tones started within the 3 s (the touch sound is one). */
  readonly tones: number;
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
/** The tap's own resume, in flight when the sound came, lands. */
const TAP_RESUME_LANDS = ['statechange:running', 'resume:resolved'];
/**
 * How long the tap's own resume takes in the gesture-resuming rows: still in
 * flight when the sound comes 100 ms after the tap, and in within the owners'
 * 750 ms gesture deadline, so the row shows the sound and not the deadline.
 */
const TAP_RESUME_MS = 400;
/**
 * The late variant (H16, H17): the tap's own resume lands 1.2 s after the
 * tap, and the sound comes at 1 s, after the owners' 750 ms gesture deadline
 * has answered the tap's caller while that resume is still pending.
 */
const LATE_TAP_RESUME_MS = 1_200;
const SOUND_AFTER_LATE_TAP_MS = 1_000;

async function parkPlayRequest(o: Owners, fake: FakeNativeAudioContext, dialog = true) {
  const request = playRequest.arm(o, fake, { dialog });
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
    tones: 1,
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
    tones: 1,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: NONE },
  },
  {
    // The dialog is about to open. The state still reads running while the
    // suspend is in flight, so the sound never resumed here; before Phase 7
    // 7B-3 it played. Held since 7B-3 (owner answer Q9): silent.
    phase: 'H3 play-request preparing-suspend (suspend in flight): held',
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
    tones: 0,
    needed: [],
    rejoins: [],
    end: { state: 'suspended', request: 'owned', scope: NONE },
  },
  {
    // Before Phase 7 7B-3 the sound resumed the context the dialog's tap
    // needs, and since 7B-2 (Q8) the owner parked it again at once (C1-I13
    // b). Held since 7B-3 (Q9): silent, and nothing wakes it.
    phase: 'H4 play-request awaiting-gesture: held',
    arrange: async (o, fake) => {
      await parkPlayRequest(o, fake);
    },
    before: { state: 'suspended', request: 'owned', scope: NONE },
    immediate: [],
    after: [],
    tones: 0,
    needed: [],
    rejoins: [],
    end: { state: 'suspended', request: 'owned', scope: NONE },
  },
  {
    // Before Phase 7 7B-3 the sound's resume landed before the tap's own.
    // Held since 7B-3: silent; the tap's own resume lands and the owner
    // promotes it to its clock check.
    phase: 'H5 play-request gesture-resuming (resume in flight): held',
    arrange: async (o, fake) => {
      const request = await parkPlayRequest(o, fake);
      fake.planResume({ latencyMs: TAP_RESUME_MS });
      void request.tap().then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'suspended', request: 'owned', scope: NONE },
    immediate: [],
    after: TAP_RESUME_LANDS,
    tones: 0,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'owned', scope: NONE },
  },
  {
    // Not held: an OS interruption waiting for its automatic resume. The
    // sound's resume completes this recovery, as before 7B-3.
    phase:
      'H6 playback-scope awaiting-resume (OS interruption, automatic resume refused): not held',
    arrange: async (o, fake) => {
      stageFile(o);
      fake.planResume({ outcome: 'reject' });
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(1_000);
    },
    before: { state: 'interrupted', request: 'none', scope: FILE_PARKED },
    immediate: ['resume()'],
    after: RESUMED,
    tones: 1,
    needed: [],
    rejoins: ['audio-context-recovered'],
    end: { state: 'running', request: 'none', scope: NONE },
  },
  {
    // As H3: no resume while the state reads running. Held since Phase 7
    // 7B-3 for this file attempt: silent.
    phase: 'H7 playback-scope preparing-suspend (stalled, suspend in flight): held',
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
    tones: 0,
    needed: [],
    rejoins: [],
    end: { state: 'suspended', request: 'none', scope: FILE_PARKED },
  },
  {
    // The dialog for this file attempt can be open. Before Phase 7 7B-3 the
    // sound woke the context and the owner parked it again, with a second
    // notice for the dialog (C1-I13 b). Held since 7B-3: nothing wakes it.
    phase: 'H8 playback-scope awaiting-gesture (file): held',
    arrange: async (o, fake) => {
      stageFile(o);
      await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
    },
    before: { state: 'suspended', request: 'none', scope: FILE_PARKED },
    immediate: [],
    after: [],
    tones: 0,
    needed: [],
    rejoins: [],
    end: { state: 'suspended', request: 'none', scope: FILE_PARKED },
  },
  {
    // Not held: the attempt is stale; the owner retires it and restores, and
    // the sound plays, as before 7B-3.
    phase: 'H9 playback-scope awaiting-gesture, identity stale (queue changed): not held',
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
    tones: 1,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: NONE },
  },
  {
    // Not held: no dialog serves YouTube (see the boundary file's YouTube
    // stall rows, known gap 6). The sound wakes it and the owner re-suspends,
    // as before 7B-3; the sound then finds it parked and plays nothing.
    phase:
      'H10 playback-scope awaiting-gesture, YouTube (raised by the automatic clock check): not held',
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
    tones: 0,
    needed: ['background-resume:clock-stalled'],
    rejoins: [],
    end: { state: 'suspended', request: 'none', scope: { attempt: 'youtube', gesture: true } },
  },
  {
    // Before Phase 7 7B-3 the sound's resume landed before the tap's own.
    // Held since 7B-3: silent; the tap's own resume lands and the attempt
    // moves to its clock check (no gesture token), which the tap's caller
    // runs.
    phase: 'H11 playback-scope gesture-resuming (resume in flight): held',
    arrange: async (o, fake) => {
      stageFile(o);
      await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
      fake.planResume({ latencyMs: TAP_RESUME_MS });
      void playbackScope.tap(o).then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'suspended', request: 'none', scope: FILE_PREPARING },
    immediate: [],
    after: TAP_RESUME_LANDS,
    tones: 0,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: FILE_PREPARING },
  },
  {
    // Not held (Phase 7 7B-3): once the tap's resume has landed, the owner
    // waits for its clock check, not for a tap. The sound plays.
    phase: 'H12 play-request awaiting-clock-verification (the tap resumed it): not held',
    arrange: async (o, fake) => {
      const request = await parkPlayRequest(o, fake);
      await expect(request.tap()).resolves.toEqual({ running: true });
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'running', request: 'owned', scope: NONE },
    immediate: [],
    after: [],
    tones: 1,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'owned', scope: NONE },
  },
  {
    // As H12, for the playback scope.
    phase: 'H13 playback-scope awaiting-clock-verification (the tap resumed it): not held',
    arrange: async (o, fake) => {
      stageFile(o);
      await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
      await expect(playbackScope.tap(o)).resolves.toEqual({ running: true });
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'running', request: 'none', scope: FILE_PREPARING },
    immediate: [],
    after: [],
    tones: 1,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: FILE_PREPARING },
  },
  {
    // An OS interruption's dialog (its automatic resume refused, H6) was
    // tapped and that resume is in flight. Holding follows the phase, not the
    // cause (Phase 7 7B-3): held, silent; the tap's own resume lands.
    phase: 'H14 playback-scope gesture-resuming after an OS interruption (resume in flight): held',
    arrange: async (o, fake) => {
      stageFile(o);
      fake.planResume({ outcome: 'reject' });
      fake.transition('interrupted');
      await vi.advanceTimersByTimeAsync(1_000);
      fake.planResume({ latencyMs: TAP_RESUME_MS });
      void playbackScope.tap(o).then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(100);
    },
    before: { state: 'interrupted', request: 'none', scope: FILE_PARKED },
    immediate: [],
    after: TAP_RESUME_LANDS,
    tones: 0,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'none', scope: FILE_PARKED },
  },
  {
    // Not held: a play-request attempt parked for a tap that no dialog will
    // ask for, because its one notice never became a dialog (the page was
    // hidden, the PLAY was replaced, a forced update was pending). The sound
    // wakes the context and plays, and the owner does not park it again; the
    // attempt is left to the next PLAY's clock check, as before Phase 7 7B-2.
    // From 7B-2 to this rule it kept the context: silent sounds, and every
    // later PLAY's resume undone.
    phase: 'H15 play-request awaiting-gesture, its notice never became a dialog: not held',
    arrange: async (o, fake) => {
      await parkPlayRequest(o, fake, false);
    },
    before: { state: 'suspended', request: 'owned', scope: NONE },
    immediate: ['resume()'],
    after: RESUMED,
    tones: 1,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'owned', scope: NONE },
  },
  {
    // As H5, the sound after the 750 ms gesture deadline has answered the
    // tap's caller while the tap's own resume is still pending (the attempt
    // waits for its gesture again). Held: silent, nothing resumed. The late
    // own resume then lands and the owner promotes it to its clock check
    // (Phase 7 7B-5), which the dialog runs.
    phase: 'H16 play-request, its own tap resume pending past the deadline: held',
    arrange: async (o, fake) => {
      const request = await parkPlayRequest(o, fake);
      fake.planResume({ latencyMs: LATE_TAP_RESUME_MS });
      void request.tap().then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(SOUND_AFTER_LATE_TAP_MS);
    },
    before: { state: 'suspended', request: 'owned', scope: NONE },
    immediate: [],
    after: TAP_RESUME_LANDS,
    tones: 0,
    needed: [],
    rejoins: [],
    end: { state: 'running', request: 'owned', scope: NONE },
  },
  {
    // As H11, past the deadline. Held: silent, nothing resumed. The late own
    // resume lands, the owner verifies it itself (fix lane G7, Phase 7 7B-5)
    // and rejoins once.
    phase: 'H17 playback-scope, its own tap resume pending past the deadline: held',
    arrange: async (o, fake) => {
      stageFile(o);
      await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
      fake.planResume({ latencyMs: LATE_TAP_RESUME_MS });
      void playbackScope.tap(o).then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(SOUND_AFTER_LATE_TAP_MS);
    },
    before: { state: 'suspended', request: 'none', scope: FILE_PARKED },
    immediate: [],
    after: TAP_RESUME_LANDS,
    tones: 0,
    needed: [],
    rejoins: ['audio-context-recovered'],
    end: { state: 'running', request: 'none', scope: NONE },
  },
];

describe('RO-01 holding: one UI sound per recovery phase', () => {
  it.each(ROWS)('$phase', async (row) => {
    const fake = new FakeNativeAudioContext();
    const o = await loadOwners(fake);
    const bus = recordBus(o);
    bind(o, fake);
    await row.arrange(o, fake);
    expect({ state: fake.state, ...ownerView(o) }).toEqual(row.before);
    const touch = await loadUiTouchSound();
    const tones = countUiTones(fake);
    const neededBefore = bus.needed.length;
    const before = fake.ops.length;

    touch();
    const immediate = nativeCalls(fake.ops.slice(before));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(immediate).toEqual(row.immediate);
    expect(fake.ops.slice(before)).toEqual(row.after);
    expect(tones()).toBe(row.tones);
    expect(bus.needed.slice(neededBefore)).toEqual(row.needed);
    expect(bus.rejoins).toEqual(row.rejoins);
    expect({ state: fake.state, ...ownerView(o) }).toEqual(row.end);
  });
});
