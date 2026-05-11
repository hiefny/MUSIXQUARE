/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { analyzeFullBuffer } from 'realtime-bpm-analyzer';
import {
  clearBeatDetector,
  getDetectedBPM,
  initBeatDetector,
  setPartyMode,
} from '../beat-detector.ts';

const mockGetCurrentAudioBuffer = vi.fn();

vi.mock('realtime-bpm-analyzer', () => ({
  analyzeFullBuffer: vi.fn(async () => [{ tempo: 120, count: 10 }]),
}));

vi.mock('../context.ts', () => ({
  getCurrentTime: vi.fn(() => 0),
}));

vi.mock('../../player/_state.ts', () => ({
  getCurrentAudioBuffer: () => mockGetCurrentAudioBuffer(),
}));

function createBuffer(): AudioBuffer {
  const data = new Float32Array(44_100);
  for (let i = 0; i < data.length; i += 2205) {
    data[i] = 1;
  }

  return {
    sampleRate: 44_100,
    getChannelData: () => data,
  } as AudioBuffer;
}

async function flushAnalysis(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  mockGetCurrentAudioBuffer.mockReturnValue(createBuffer());
  clearBeatDetector();
  setPartyMode(false);
});

describe('beat detector playback contract', () => {
  it('starts analysis from playback mode/activity instead of legacy appState events', async () => {
    initBeatDetector();
    setPartyMode(true);

    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');

    await flushAnalysis();

    expect(analyzeFullBuffer).toHaveBeenCalledTimes(1);
    expect(getDetectedBPM()).toBe(120);
  });

  it('clears BPM when file playback leaves the playing activity', async () => {
    initBeatDetector();
    setPartyMode(true);

    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    await flushAnalysis();

    setState('playback.activity', 'paused');

    expect(getDetectedBPM()).toBe(0);
  });
});
