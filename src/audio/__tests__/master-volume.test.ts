/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';

const { context } = vi.hoisted(() => {
  const param = () => ({
    value: 1,
    cancelScheduledValues() {},
    setValueAtTime(value: number) {
      this.value = value;
    },
    linearRampToValueAtTime(value: number) {
      this.value = value;
    },
  });
  const node = (): Record<string, unknown> => ({
    context,
    connect() {},
    disconnect() {},
    gain: param(),
    frequency: param(),
    Q: param(),
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
  });
  const context = {
    state: 'running',
    currentTime: 1,
    sampleRate: 8000,
    destination: {},
    addEventListener() {},
    removeEventListener() {},
    createGain: node,
    createChannelSplitter: node,
    createChannelMerger: node,
    createBiquadFilter: node,
    createConvolver: node,
    createDynamicsCompressor: node,
    createWaveShaper: node,
    createAnalyser: node,
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
  };
  return { context };
});
vi.mock('../context.ts', () => ({ getAudioContext: () => context, ensureRunning: async () => {} }));
vi.mock('../context-recovery.ts', () => ({ bindAudioContextInterruptionRecovery: () => () => {} }));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn() }));
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
  verifyOperator: () => true,
}));
import { bus } from '../../core/events.ts';
import { resetState, getState, setState } from '../../core/state.ts';
import { initAudio, getMasterGain } from '../engine.ts';
import { applySettings } from '../effects.ts';

it('preserves the exact PRO pause gate across settings and volume changes, then restores the latest volume', async () => {
  resetState();
  setState('audio.masterVolume', 0.7);
  await initAudio();
  expect(getMasterGain()!.gain.value).toBe(0.7);

  const pending = {
    token: 1,
    kind: 'pause' as const,
    queueItemId: null,
    targetSeconds: 0,
    wasPlaying: true,
  };
  bus.emit('pro-playback:ui-control-pending', pending);
  expect(getMasterGain()!.gain.value).toBe(0);
  await applySettings();
  expect(getMasterGain()!.gain.value).toBe(0);

  bus.emit('audio:set-volume', 0.4);
  await applySettings();
  expect(getState('audio.masterVolume')).toBe(0.4);
  expect(getMasterGain()!.gain.value).toBe(0);

  bus.emit('pro-playback:ui-control-pending', { ...pending, token: 2 });
  bus.emit('pro-playback:ui-control-settled', {
    token: 1,
    kind: 'pause',
    queueItemId: null,
    status: 'superseded',
  });
  await applySettings();
  expect(getMasterGain()!.gain.value).toBe(0);

  bus.emit('pro-playback:ui-control-settled', {
    token: 2,
    kind: 'pause',
    queueItemId: null,
    status: 'applied',
  });
  expect(getMasterGain()!.gain.value).toBe(0.4);
  bus.emit('audio:set-volume', 0.6);
  await applySettings();
  expect(getMasterGain()!.gain.value).toBe(0.6);
});
