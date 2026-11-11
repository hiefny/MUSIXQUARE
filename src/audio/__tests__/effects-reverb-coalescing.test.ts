/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeAudioContext,
  type FakeAudioContext,
  type FakeNode,
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
let bus: (typeof import('../../core/events.ts'))['bus'];
let setState: (typeof import('../../core/state.ts'))['setState'];

const preview = (param: string, value: number) =>
  bus.emit('audio:update-effect', 'reverb', param, value, true);
const commit = (param: string, value: number) =>
  bus.emit('audio:update-effect', 'reverb', param, value, false);
const preDelayTime = () => (engine.getRvbPreDelay() as unknown as FakeNode).delayTime.value;

describe('reverb impulse', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    h.ctx = createFakeAudioContext();
    h.generateReverbIR.mockClear();
    engine = await import('../engine.ts');
    effects = await import('../effects.ts');
    ({ bus } = await import('../../core/events.ts'));
    ({ setState } = await import('../../core/state.ts'));
    await engine.initAudio();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('builds nothing at mix 0, then the current decay before the input and the ramp', () => {
    preview('decay', 2);
    commit('decay', 3);
    commit('predelay', 0.3);
    vi.runAllTimers();
    expect(h.generateReverbIR).not.toHaveBeenCalled();
    expect(preDelayTime()).toBeCloseTo(0.3);

    h.ctx.trace.length = 0;
    commit('mix', 40);

    expect(h.generateReverbIR).toHaveBeenCalledTimes(1);
    expect(h.generateReverbIR).toHaveBeenLastCalledWith(3);
    const eqNodes = engine.getEqNodes();
    const eqOut = eqNodes[eqNodes.length - 1] as unknown as FakeNode;
    const preDelay = engine.getRvbPreDelay() as unknown as FakeNode;
    const wetGain = (engine.getRvbCrossFade()!.b as unknown as FakeNode).gain;
    const trace = h.ctx.trace;
    const built = trace.findIndex((entry) => entry.op === 'buffer');
    const connected = trace.findIndex(
      (entry) => entry.op === 'connect' && entry.from === eqOut && entry.to === preDelay,
    );
    const ramped = trace.findIndex((entry) => entry.op === 'ramp' && entry.param === wetGain);
    expect(built).toBeGreaterThanOrEqual(0);
    expect(built).toBeLessThan(connected);
    expect(connected).toBeLessThan(ramped);
  });

  it('coalesces audible decay previews and never rebuilds for pre-delay', () => {
    commit('mix', 40);
    expect(h.generateReverbIR).toHaveBeenLastCalledWith(5);
    h.generateReverbIR.mockClear();

    preview('decay', 4);
    preview('decay', 5);
    preview('decay', 6);
    expect(h.generateReverbIR).not.toHaveBeenCalled();
    vi.advanceTimersByTime(140);
    expect(h.generateReverbIR).toHaveBeenCalledTimes(1);
    expect(h.generateReverbIR).toHaveBeenLastCalledWith(6);

    preview('predelay', 0.2);
    expect(preDelayTime()).toBeCloseTo(0.2);
    commit('predelay', 0.25);
    expect(preDelayTime()).toBeCloseTo(0.25);
    vi.runAllTimers();
    expect(h.generateReverbIR).toHaveBeenCalledTimes(1);

    preview('decay', 7);
    commit('decay', 7.5);
    expect(h.generateReverbIR).toHaveBeenCalledTimes(2);
    expect(h.generateReverbIR).toHaveBeenLastCalledWith(7.5);
    vi.runAllTimers();
    expect(h.generateReverbIR).toHaveBeenCalledTimes(2);
  });

  it('keeps Off and the demo toggle from rebuilding at mix 0', () => {
    bus.emit('audio:reverb-type-change', 'off');
    vi.runAllTimers();
    expect(h.generateReverbIR).not.toHaveBeenCalled();

    bus.emit('audio:reverb-type-change', 'arena');
    expect(h.generateReverbIR).toHaveBeenCalledTimes(1);
    expect(h.generateReverbIR).toHaveBeenLastCalledWith(5);
    expect(preDelayTime()).toBeCloseTo(0.12);

    bus.emit('audio:reverb-type-change', 'off');
    bus.emit('audio:reverb-type-change', 'arena');
    bus.emit('audio:reverb-type-change', 'off');
    vi.runAllTimers();
    expect(h.generateReverbIR).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed impulse disconnected without blocking the other settings', async () => {
    h.generateReverbIR.mockImplementationOnce(() => {
      throw new RangeError('impulse allocation failed');
    });
    setState('audio.virtualBass', 0.5);
    setState('audio.reverbMix', 0.4);
    const eqNodes = engine.getEqNodes();
    const eqOut = eqNodes[eqNodes.length - 1] as unknown as FakeNode;
    const preDelay = engine.getRvbPreDelay() as unknown as FakeNode;

    await expect(effects.applySettings()).rejects.toThrow('impulse allocation failed');
    expect([...eqOut.outputs].some((node) => node.type === 'lowpass')).toBe(true);
    expect(eqOut.outputs.has(preDelay)).toBe(false);

    await effects.applySettings();
    expect(h.generateReverbIR).toHaveBeenCalledTimes(2);
    expect(eqOut.outputs.has(preDelay)).toBe(true);
  });
});
