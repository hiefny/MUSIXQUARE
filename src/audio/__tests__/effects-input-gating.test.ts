/**
 * @vitest-environment jsdom
 *
 * Chromium renders every node a connected destination pulls, even behind a
 * zero gain, so the reverb, virtual bass and exciter inputs are connected
 * only while their target gain is audible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeAudioContext,
  type FakeAudioContext,
  type FakeNode,
  type FakeParam,
} from './__helpers__/fake-audio-context.ts';

const h = vi.hoisted(() => ({
  ctx: null as unknown as FakeAudioContext,
  generateReverbIR: vi.fn((decay: number) => ({ decay })),
}));

vi.mock('../context.ts', () => ({ getAudioContext: () => h.ctx, ensureRunning: async () => {} }));
vi.mock('../context-recovery.ts', () => ({ bindAudioContextInterruptionRecovery: () => () => {} }));
vi.mock('../helpers.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helpers.ts')>()),
  generateReverbIR: h.generateReverbIR,
}));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn() }));
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
  verifyOperator: () => true,
}));

let engine: typeof import('../engine.ts');
let effects: typeof import('../effects.ts');
let setState: (typeof import('../../core/state.ts'))['setState'];

function eqOut(): FakeNode {
  const nodes = engine.getEqNodes();
  return nodes[nodes.length - 1] as unknown as FakeNode;
}

const dryInput = () => engine.getRvbCrossFade()!.a as unknown as FakeNode;
const wetGain = () => (engine.getRvbCrossFade()!.b as unknown as FakeNode).gain;
const vbGain = () => (engine.getVbGain() as unknown as FakeNode).gain;
const exciterGain = () => (engine.getExciterGain() as unknown as FakeNode).gain;

/** Effect inputs fed by the post-EQ bus, besides the always-connected dry path. */
function openInputs(): string[] {
  expect(eqOut().outputs.has(dryInput())).toBe(true);
  return [...eqOut().outputs]
    .filter((node) => node !== dryInput())
    .map((node) =>
      node.kind === 'Delay' ? 'reverb' : node.type === 'lowpass' ? 'virtual-bass' : 'exciter',
    )
    .sort();
}

function automation(param: FakeParam, op: 'set' | 'ramp') {
  return h.ctx.trace.filter((entry) => entry.op === op && entry.param === param) as {
    value: number;
    time: number;
  }[];
}

describe('effect input gating', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    h.ctx = createFakeAudioContext();
    h.generateReverbIR.mockClear();
    engine = await import('../engine.ts');
    effects = await import('../effects.ts');
    ({ setState } = await import('../../core/state.ts'));
    await engine.initAudio();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('starts with every effect input disconnected and keeps the defaults that way', () => {
    expect(openInputs()).toEqual([]);
    vi.runAllTimers();
    expect(openInputs()).toEqual([]);
    expect(h.generateReverbIR).not.toHaveBeenCalled();
  });

  it('disconnects only the reverb input once the real wet gain is silent', () => {
    effects.setReverbParam('mix', 40);
    expect(openInputs()).toEqual(['reverb']);

    h.ctx.currentTime = 1;
    effects.setReverbParam('mix', 0);
    // A frozen context leaves the ramp mid-way, so the gate keeps checking.
    vi.advanceTimersByTime(1_000);
    expect(wetGain().value).toBeGreaterThan(0.5);
    expect(openInputs()).toEqual(['reverb']);

    h.ctx.currentTime = 1.2;
    vi.advanceTimersByTime(150);
    expect(openInputs()).toEqual([]);
    const preDelay = engine.getRvbPreDelay() as unknown as FakeNode;
    expect(
      h.ctx.trace.some(
        (entry) => entry.op === 'disconnect' && entry.from === eqOut() && entry.to === preDelay,
      ),
    ).toBe(true);
    // The convolver output stays connected so its tail flushes with silence.
    const convolver = [...preDelay.outputs][0]!;
    expect(convolver.kind).toBe('Convolver');
    expect(convolver.outputs.has(engine.getRvbLowCut() as unknown as FakeNode)).toBe(true);
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an input that becomes audible again before its ramp finished', () => {
    effects.setReverbParam('mix', 40);
    h.ctx.currentTime = 1;
    effects.setReverbParam('mix', 0);
    h.ctx.currentTime = 1.05;
    h.ctx.trace.length = 0;
    effects.setReverbParam('mix', 30);
    vi.runAllTimers();
    expect(openInputs()).toEqual(['reverb']);
    expect(h.ctx.trace.some((entry) => entry.op === 'connect' || entry.op === 'disconnect')).toBe(
      false,
    );
  });

  it('reconnects virtual bass while silent and starts its ramp after an onset delay', () => {
    h.ctx.currentTime = 2;
    h.ctx.trace.length = 0;
    effects.setVirtualBass(50);

    expect(openInputs()).toEqual(['virtual-bass', 'virtual-bass']);
    const connected = h.ctx.trace.findIndex(
      (entry) => entry.op === 'connect' && entry.from === eqOut(),
    );
    const firstAutomation = h.ctx.trace.findIndex(
      (entry) => (entry.op === 'set' || entry.op === 'ramp') && entry.param === vbGain(),
    );
    expect(connected).toBeLessThan(firstAutomation);
    const [hold] = automation(vbGain(), 'set');
    const [ramp] = automation(vbGain(), 'ramp');
    expect(hold).toMatchObject({ value: 0 });
    expect(hold!.time).toBeGreaterThan(2);
    expect(ramp!.time).toBeCloseTo(hold!.time + 0.1);
    expect(ramp!.value).toBe(0.5);

    // The woofer role silences virtual bass, then both band inputs leave.
    h.ctx.currentTime = 3;
    setState('audio.channelMode', 2);
    effects.applySettingsAsync();
    expect(openInputs()).toEqual(['virtual-bass', 'virtual-bass']);
    h.ctx.currentTime = 3.2;
    vi.advanceTimersByTime(150);
    expect(openInputs()).toEqual([]);
    expect(vbGain().value).toBe(0);
  });

  it('gates the exciter on its toggle and on the woofer role', () => {
    effects.setExciter(true);
    expect(openInputs()).toEqual(['exciter']);
    h.ctx.currentTime = 1;
    expect(exciterGain().value).toBeGreaterThan(0);

    effects.setExciter(false);
    h.ctx.currentTime = 1.2;
    vi.advanceTimersByTime(150);
    expect(openInputs()).toEqual([]);

    setState('audio.channelMode', 2);
    effects.setExciter(true);
    vi.runAllTimers();
    expect(openInputs()).toEqual([]);

    setState('audio.channelMode', 0);
    effects.applySettingsAsync();
    expect(openInputs()).toEqual(['exciter']);
  });
});
