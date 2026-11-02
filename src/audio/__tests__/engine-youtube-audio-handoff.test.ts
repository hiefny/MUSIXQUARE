/**
 * @vitest-environment jsdom
 *
 * Two contracts Phase 6 handed to Phase 7 (structural plan C1), pinned on
 * 2026-11-02 before Phase 7 touches the engine's gesture and recovery paths:
 *
 * (a) The engine sends youtube:set-volume only for a volume event. Phase 6
 *     pinned that audio:set-volume and audio:apply-youtube-volume each send
 *     Math.round(v * 100) exactly once (youtube-iframe-audio-order.test.ts,
 *     'Phase 7 contract (a)'); this file adds the other half: applying the
 *     settings and changing an effect send none.
 * (b) The PRO pause gate is held twice, by design (the owner kept both
 *     tokens): the engine's WebAudio output gate (engine.ts) and the iframe
 *     audio owner's gate (youtube/iframe-audio.ts, wired by initYouTube).
 *     For the same pending and settled events both give the same answer;
 *     the one named difference is stopYouTubeMode, which drops the iframe
 *     gate only.
 *
 * Real: core/events.ts, core/state.ts, audio/context.ts, audio/engine.ts with
 * its graph, audio/effects.ts, and youtube/player.ts's initYouTube wiring
 * over youtube/iframe-audio.ts. A graph double (createFakeAudioContext)
 * stands in for the platform AudioContext; network sends are stubbed.
 * Observations: youtube:set-volume events on the bus, the engine gate as the
 * target of the master gain's latest ramp (0 while gated, the master volume
 * otherwise), and the iframe gate as isYouTubePauseGateHeld(). Each row loads
 * a fresh module graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAudioContext, type FakeAudioContext } from './__helpers__/fake-audio-context.ts';

vi.mock('../../network/peer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/peer.ts')>()),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));

const MASTER_VOLUME = 0.7;

async function loadWorld() {
  const context: FakeAudioContext = createFakeAudioContext();
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context;
      }
    },
  );
  vi.resetModules();
  const [{ bus }, { setState }, engine, effects, player, iframeAudio] = await Promise.all([
    import('../../core/events.ts'),
    import('../../core/state.ts'),
    import('../engine.ts'),
    import('../effects.ts'),
    import('../../youtube/player.ts'),
    import('../../youtube/iframe-audio.ts'),
  ]);
  setState('audio.masterVolume', MASTER_VOLUME);
  player.initYouTube();
  await engine.initAudio();
  await vi.advanceTimersByTimeAsync(100);
  const masterGain = engine.getMasterGain();
  expect(masterGain).not.toBeNull();

  /** The engine's output gate: 'gated' while its latest master ramp aims at 0. */
  const engineGate = (): 'gated' | 'open' => {
    const ramps = context.trace.filter(
      (entry) =>
        entry.op === 'ramp' && entry.param === (masterGain as unknown as { gain: unknown }).gain,
    ) as Array<{ value: number }>;
    const target = ramps.at(-1)?.value ?? MASTER_VOLUME;
    return target === 0 ? 'gated' : 'open';
  };
  const iframeGate = (): 'gated' | 'open' =>
    iframeAudio.isYouTubePauseGateHeld() ? 'gated' : 'open';

  return { bus, context, effects, player, engineGate, iframeGate };
}

type World = Awaited<ReturnType<typeof loadWorld>>;
type GateKind = 'pause' | 'play' | 'seek';
type Step = readonly ['pending' | 'settled', number, GateKind?] | readonly ['stopYouTubeMode'];

function run(world: World, steps: readonly Step[]): void {
  for (const step of steps) {
    if (step[0] === 'stopYouTubeMode') {
      world.player.stopYouTubeMode();
    } else if (step[0] === 'pending') {
      world.bus.emit('pro-playback:ui-control-pending', {
        token: step[1],
        kind: step[2] ?? 'pause',
        queueItemId: null,
        targetSeconds: 0,
        wasPlaying: true,
      });
    } else {
      world.bus.emit('pro-playback:ui-control-settled', {
        token: step[1],
        kind: step[2] ?? 'pause',
        queueItemId: null,
        status: 'applied',
        positionSeconds: 0,
      });
    }
  }
}

let world: World | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  world?.bus.clear();
  world = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Phase 7 contract (a): settings and effect changes send no youtube:set-volume (pinned 2026-11-02)', () => {
  it('applySettings and each effect event reach the graph and send none; a volume event sends one', async () => {
    world = await loadWorld();
    const sent: number[] = [];
    world.bus.on('youtube:set-volume', (volume) => {
      sent.push(volume);
    });

    const traceBefore = world.context.trace.length;
    await world.effects.applySettings();
    world.bus.emit('audio:update-effect', 'reverb', 'mix', 0.3);
    world.bus.emit('audio:update-effect', 'stereo', 'mix', 0.8);
    world.bus.emit('audio:set-eq', 0, 3);
    world.bus.emit('audio:reverb-type-change', 'studio');
    world.bus.emit('audio:reset-eq');
    await vi.advanceTimersByTimeAsync(100);
    const reachedGraph = world.context.trace.length > traceBefore;
    const afterEffects = sent.splice(0);

    world.bus.emit('audio:set-volume', 0.634);

    expect({ reachedGraph, afterEffects, afterVolume: sent }).toEqual({
      reachedGraph: true,
      afterEffects: [],
      afterVolume: [63],
    });
  });
});

describe('Phase 7 contract (b): one PRO pause gate answer from the engine and the iframe audio owner (pinned 2026-11-02)', () => {
  /** [steps, engine gate, iframe gate] after the steps. */
  const ROWS: ReadonlyArray<
    readonly [string, readonly Step[], 'gated' | 'open', 'gated' | 'open']
  > = [
    ['nothing pending', [], 'open', 'open'],
    ['a pending pause', [['pending', 1]], 'gated', 'gated'],
    [
      'its settlement',
      [
        ['pending', 1],
        ['settled', 1],
      ],
      'open',
      'open',
    ],
    [
      'another token settles',
      [
        ['pending', 1],
        ['settled', 2],
      ],
      'gated',
      'gated',
    ],
    [
      'a seek settles the same token',
      [
        ['pending', 1],
        ['settled', 1, 'seek'],
      ],
      'gated',
      'gated',
    ],
    [
      'a play settles the same token',
      [
        ['pending', 1],
        ['settled', 1, 'play'],
      ],
      'gated',
      'gated',
    ],
    [
      'a pending play or seek',
      [
        ['pending', 1, 'play'],
        ['pending', 2, 'seek'],
      ],
      'open',
      'open',
    ],
    [
      'a newer pause holds; the older settles',
      [
        ['pending', 1],
        ['pending', 2],
        ['settled', 1],
      ],
      'gated',
      'gated',
    ],
    [
      'a newer pause holds and settles',
      [
        ['pending', 1],
        ['pending', 2],
        ['settled', 2],
      ],
      'open',
      'open',
    ],
    [
      'a settlement twice',
      [
        ['pending', 1],
        ['settled', 1],
        ['settled', 1],
      ],
      'open',
      'open',
    ],
    ['a settlement with nothing held', [['settled', 9]], 'open', 'open'],
    [
      'a pause after a settled pause',
      [
        ['pending', 1],
        ['settled', 1],
        ['pending', 2],
      ],
      'gated',
      'gated',
    ],
    // Named difference: leaving YouTube mode drops the iframe gate only; the
    // engine keeps its token until the settlement.
    ['stopYouTubeMode while held', [['pending', 1], ['stopYouTubeMode']], 'gated', 'open'],
    [
      'stopYouTubeMode, then the settlement',
      [['pending', 1], ['stopYouTubeMode'], ['settled', 1]],
      'open',
      'open',
    ],
  ];

  it.each(ROWS)('%s', async (_name, steps, engine, iframe) => {
    world = await loadWorld();
    run(world, steps);
    expect({ engine: world.engineGate(), iframe: world.iframeGate() }).toEqual({ engine, iframe });
  });
});
