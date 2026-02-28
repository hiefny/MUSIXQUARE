/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, getState } from '../../core/state.ts';
import { setPreamp, setStereoWidth, resetStereoWidth, setVirtualBass, resetVirtualBass } from '../effects.ts';

beforeEach(() => {
  resetState();
});

describe('setPreamp', () => {
  it('0 dB → gain 1.0', () => {
    setPreamp(0);
    expect(getState('audio.userPreampGain')).toBeCloseTo(1.0);
  });

  it('6 dB → gain ≈ 1.995', () => {
    setPreamp(6);
    expect(getState('audio.userPreampGain')).toBeCloseTo(1.9953, 3);
  });

  it('-6 dB → gain ≈ 0.501', () => {
    setPreamp(-6);
    expect(getState('audio.userPreampGain')).toBeCloseTo(0.5012, 3);
  });

  it('20 dB → clamped to 12 dB → gain ≈ 3.98', () => {
    setPreamp(20);
    // Clamped to max +12 dB: Math.pow(10, 12/20) ≈ 3.981
    expect(getState('audio.userPreampGain')).toBeCloseTo(3.981, 2);
  });
});

describe('setStereoWidth', () => {
  it('100 → stereoWidth 1.0', () => {
    setStereoWidth(100);
    expect(getState('audio.stereoWidth')).toBeCloseTo(1.0);
  });

  it('0 → stereoWidth 0.0', () => {
    setStereoWidth(0);
    expect(getState('audio.stereoWidth')).toBeCloseTo(0.0);
  });

  it('200 → stereoWidth 2.0', () => {
    setStereoWidth(200);
    expect(getState('audio.stereoWidth')).toBeCloseTo(2.0);
  });
});

describe('resetStereoWidth', () => {
  it('resets to 1.0', () => {
    setStereoWidth(50);
    resetStereoWidth();
    expect(getState('audio.stereoWidth')).toBeCloseTo(1.0);
  });
});

describe('setVirtualBass', () => {
  it('50 → virtualBass 0.5', () => {
    setVirtualBass(50);
    expect(getState('audio.virtualBass')).toBeCloseTo(0.5);
  });

  it('0 → virtualBass 0.0', () => {
    setVirtualBass(0);
    expect(getState('audio.virtualBass')).toBeCloseTo(0.0);
  });

  it('100 → virtualBass 1.0', () => {
    setVirtualBass(100);
    expect(getState('audio.virtualBass')).toBeCloseTo(1.0);
  });
});

describe('resetVirtualBass', () => {
  it('resets to 0.0', () => {
    setVirtualBass(75);
    resetVirtualBass();
    expect(getState('audio.virtualBass')).toBeCloseTo(0.0);
  });
});
