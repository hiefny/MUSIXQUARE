/**
 * @vitest-environment jsdom
 *
 * Structural plan C1 (Phase 7), condition (c'), pinned 2026-11-02: whether
 * the start tap's native AudioContext resume() runs in the tap's own call
 * stack (QA025, iOS transient activation). prepareSetupStartFromGesture()
 * emits audio:activate synchronously (Phase 6 contract (c), pinned in
 * setup-start.test.ts); this file follows that event into the real engine
 * and AudioContext owner and reads the platform op log the moment the tap
 * returns, before any microtask runs.
 *
 * Real: setup-start.ts, core/events.ts, audio/engine.ts, audio/context.ts and
 * audio/context-recovery.ts (bound by the engine once its graph exists) over
 * one FakeNativeAudioContext that also builds graph nodes. Edges only: the
 * YouTube prime and its proof wait (no YouTube start in these rows) and the
 * wake lock.
 *
 * The answer depends on the engine's state at the tap, so each branch is its
 * own row:
 * - first tap, context suspended: resume() before the tap returns;
 * - first tap, context running: no resume();
 * - a tap while the first initialization is still in flight: no second
 *   resume() (the engine hands back the pending initialization);
 * - graph built, context suspended: resume() before the tap returns;
 * - graph built, context running: no resume().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeAudioContext,
  FakeNativeAudioContext,
  fakeAudioContextConstructor,
} from '../../audio/__tests__/__helpers__/fake-audio-context.ts';

vi.mock('../../youtube/player.ts', () => ({ primeYouTubePlayer: () => false }));
vi.mock('../../youtube/iframe.ts', () => ({
  waitForPendingYouTubePrimeBounce: () => Promise.resolve(false),
}));
vi.mock('../../core/wake-lock.ts', () => ({ activateNoSleep: () => {} }));

/**
 * A native lifecycle double that can also build the engine's graph: the
 * graph double's node factories, each node reporting this context as its
 * own (the file playback route checks it).
 */
function nativeContext(state: 'running' | 'suspended'): FakeNativeAudioContext {
  const fake = new FakeNativeAudioContext({ state });
  const nodes = createFakeAudioContext(fake.sampleRate);
  const own = <T>(node: T): T => Object.assign(node as object, { context: fake }) as T;
  for (const [name, factory] of Object.entries(nodes)) {
    if (!name.startsWith('create') || typeof factory !== 'function') continue;
    const create = factory as (...args: unknown[]) => unknown;
    const value = name === 'createBuffer' ? create : (...args: unknown[]) => own(create(...args));
    Object.defineProperty(fake, name, { configurable: true, value });
  }
  Object.defineProperty(fake, 'destination', { configurable: true, value: own(nodes.destination) });
  return fake;
}

interface Tap {
  /** Runs the start tap; returns the op log as it stands when the tap returns. */
  tap(): string[];
  /** Lets every queued reaction run (zero-latency native calls settle on a microtask). */
  settle(): Promise<void>;
  isAudioReady(): boolean;
  clearBus(): void;
}

async function loadStart(fake: FakeNativeAudioContext): Promise<Tap> {
  vi.stubGlobal('AudioContext', fakeAudioContextConstructor(fake));
  vi.resetModules();
  const [{ bus }, engine, { prepareSetupStartFromGesture }] = await Promise.all([
    import('../../core/events.ts'),
    import('../../audio/engine.ts'),
    import('../setup-start.ts'),
  ]);
  return {
    tap() {
      expect(prepareSetupStartFromGesture()).toBeNull();
      return [...fake.ops];
    },
    async settle() {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    },
    isAudioReady: engine.isAudioReady,
    clearBus: () => bus.clear(),
  };
}

let loaded: Tap | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  loaded?.clearBus();
  loaded = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe("start tap native resume, condition (c'), as today (pinned 2026-11-02)", () => {
  it('first tap on a suspended context: resume() runs before the tap returns', async () => {
    const fake = nativeContext('suspended');
    loaded = await loadStart(fake);

    const atReturn = loaded.tap();
    await loaded.settle();

    expect({ atReturn, after: fake.ops, ready: loaded.isAudioReady() }).toEqual({
      atReturn: ['resume()'],
      after: ['resume()', 'statechange:running', 'resume:resolved'],
      ready: true,
    });
  });

  it('first tap on a running context: no resume()', async () => {
    const fake = nativeContext('running');
    loaded = await loadStart(fake);

    const atReturn = loaded.tap();
    await loaded.settle();

    expect({ atReturn, after: fake.ops, ready: loaded.isAudioReady() }).toEqual({
      atReturn: [],
      after: [],
      ready: true,
    });
  });

  it('a tap while the first initialization is in flight: no second resume()', async () => {
    const fake = nativeContext('suspended').planResume({ latencyMs: 40 });
    loaded = await loadStart(fake);

    const first = loaded.tap();
    const second = loaded.tap();
    await vi.advanceTimersByTimeAsync(40);
    await loaded.settle();

    expect({ first, second, after: fake.ops, ready: loaded.isAudioReady() }).toEqual({
      first: ['resume()'],
      second: ['resume()'],
      after: ['resume()', 'statechange:running', 'resume:resolved'],
      ready: true,
    });
  });

  it('graph built, context suspended at the tap: resume() runs before the tap returns', async () => {
    const fake = nativeContext('running');
    loaded = await loadStart(fake);
    loaded.tap();
    await loaded.settle();
    expect(loaded.isAudioReady()).toBe(true);
    // Suspended without an event, so no owner reacts before the tap.
    fake.transition('suspended', { statechange: false });

    const atReturn = loaded.tap();
    await loaded.settle();

    expect({ atReturn, after: fake.ops }).toEqual({
      atReturn: ['os:suspended', 'state:suspended', 'resume()'],
      after: [
        'os:suspended',
        'state:suspended',
        'resume()',
        'statechange:running',
        'resume:resolved',
      ],
    });
  });

  it('graph built, context running at the tap: no resume()', async () => {
    const fake = nativeContext('running');
    loaded = await loadStart(fake);
    loaded.tap();
    await loaded.settle();

    const atReturn = loaded.tap();
    await loaded.settle();

    expect({ atReturn, after: fake.ops }).toEqual({ atReturn: [], after: [] });
  });
});
