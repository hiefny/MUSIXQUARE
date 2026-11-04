/**
 * @vitest-environment jsdom
 */
/**
 * RO-01 "AudioContext running state": the prepared state both recovery
 * owners read (structural plan C1, I1). A parked context, suspended or
 * WebKit's interrupted, is one a trusted gesture may resume and one a suspend
 * preparation need not suspend again; running and closed are neither.
 *
 * The play-request restart (context.ts) and the playback-scope attempt
 * (context-recovery.ts) each kept their own copy of that predicate until
 * Phase 7 7A-2 gave them one. These rows drive suspended, interrupted,
 * running and closed through both owners' public entries and pin the same
 * answer for both, so the move to one predicate changes no cell. Harness and
 * driver as in audio-output-recovery-parity.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeNativeAudioContext, type FakeNativeState } from './__helpers__/fake-audio-context.ts';
import {
  bind,
  loadOwners,
  nativeCalls,
  playRequest,
  playbackScope,
  setupOwnerTest,
  stageFile,
  teardownOwnerTest,
  warmMediaSessionGraph,
  type Owners,
} from './__helpers__/audio-output-owners.ts';

beforeAll(warmMediaSessionGraph, 30_000);
beforeEach(setupOwnerTest);
afterEach(teardownOwnerTest);

async function newFileOwners(
  state: FakeNativeState = 'running',
): Promise<{ fake: FakeNativeAudioContext; o: Owners }> {
  const fake = new FakeNativeAudioContext({ state });
  const o = await loadOwners(fake);
  stageFile(o);
  bind(o, fake);
  return { fake, o };
}

/**
 * A parked attempt whose context then moves to `state` with no statechange,
 * so only the owner's own state read decides: whether the playback scope
 * still offers its attempt to a gesture, and what each owner's tap does.
 */
const GESTURE_ROWS: ReadonlyArray<{
  readonly state: FakeNativeState;
  readonly scopeOffersGesture: boolean;
  readonly tap: { readonly ops: readonly string[]; readonly running: boolean };
}> = [
  { state: 'suspended', scopeOffersGesture: true, tap: { ops: ['resume()'], running: true } },
  { state: 'interrupted', scopeOffersGesture: true, tap: { ops: ['resume()'], running: true } },
  { state: 'running', scopeOffersGesture: false, tap: { ops: [], running: false } },
  { state: 'closed', scopeOffersGesture: false, tap: { ops: [], running: false } },
];

/**
 * A preparation that starts on a context already in `state`: a parked one is
 * ready at once with no native suspend, a running one is suspended once. A
 * closed context arms no play-request incident, so it has no row here; the
 * gesture rows cover it.
 */
const PREPARE_ROWS: ReadonlyArray<{
  readonly state: FakeNativeState;
  readonly first: 'prepared' | 'preparing' | 'stale';
  readonly ops: readonly string[];
}> = [
  { state: 'suspended', first: 'prepared', ops: [] },
  { state: 'interrupted', first: 'prepared', ops: [] },
  { state: 'running', first: 'prepared', ops: ['suspend()'] },
];

describe('RO-01 prepared state: a parked attempt and its gesture', () => {
  it.each(GESTURE_ROWS)('play-request restart, context then $state', async (row) => {
    const { fake, o } = await newFileOwners();
    const restart = playRequest.arm(o, fake);
    await expect(restart.first).resolves.toBe('prepared');
    fake.transition(row.state, { statechange: false });
    const before = fake.ops.length;

    const result = await restart.tap();

    expect({ ops: nativeCalls(fake.ops.slice(before)), running: result.running }).toEqual(row.tap);
  });

  it.each(GESTURE_ROWS)('playback-scope attempt, context then $state', async (row) => {
    const { fake, o } = await newFileOwners();
    await expect(playbackScope.armStalled(o, fake)).resolves.toBe('prepared');
    fake.transition(row.state, { statechange: false });
    const offers = playbackScope.view(o).gesture;
    const before = fake.ops.length;

    const result = await playbackScope.tap(o);

    expect(offers).toBe(row.scopeOffersGesture);
    expect({ ops: nativeCalls(fake.ops.slice(before)), running: result.running }).toEqual(row.tap);
  });
});

describe('RO-01 prepared state: a preparation that starts on that state', () => {
  it.each(PREPARE_ROWS)('play-request restart on a $state context', async (row) => {
    const { fake, o } = await newFileOwners(row.state);
    const before = fake.ops.length;

    const restart = playRequest.arm(o, fake);

    await expect(restart.first).resolves.toBe(row.first);
    expect(nativeCalls(fake.ops.slice(before))).toEqual(row.ops);
  });

  it.each(PREPARE_ROWS)('playback-scope attempt on a $state context', async (row) => {
    const { fake, o } = await newFileOwners(row.state);
    const before = fake.ops.length;

    await expect(playbackScope.armStalled(o, fake)).resolves.toBe(row.first);
    expect(nativeCalls(fake.ops.slice(before))).toEqual(row.ops);
  });
});
