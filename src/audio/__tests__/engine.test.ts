/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState } from '../../core/state.ts';
import {
  isAudioReady,
  getMasterGain,
  getAnalyser,
  getToneMerge,
  getGainL,
  getGainR,
  getPreamp,
  getWidener,
  getReverb,
  getRvbLowCut,
  getRvbHighCut,
  getRvbCrossFade,
  getEqNodes,
  getGlobalLowPass,
  getVbFilter,
  getVbPostFilter,
  getVbGain,
  getSurroundSplitter,
  getSurroundGain,
} from '../engine.ts';

beforeEach(() => {
  resetState();
});

describe('isAudioReady', () => {
  it('returns false before init', () => {
    expect(isAudioReady()).toBe(false);
  });
});

describe('getMasterGain', () => {
  it('returns null before init', () => {
    expect(getMasterGain()).toBeNull();
  });
});

describe('getWidener', () => {
  it('returns null before init', () => {
    expect(getWidener()).toBeNull();
  });
});

describe('getEqNodes', () => {
  it('returns empty array before init', () => {
    expect(getEqNodes()).toEqual([]);
  });

  it('has length 0 before init', () => {
    expect(getEqNodes()).toHaveLength(0);
  });
});

describe('getReverb', () => {
  it('returns null before init', () => {
    expect(getReverb()).toBeNull();
  });
});

describe('all getter functions return null before initAudio', () => {
  it('getAnalyser returns null', () => {
    expect(getAnalyser()).toBeNull();
  });

  it('getToneMerge returns null', () => {
    expect(getToneMerge()).toBeNull();
  });

  it('getGainL returns null', () => {
    expect(getGainL()).toBeNull();
  });

  it('getGainR returns null', () => {
    expect(getGainR()).toBeNull();
  });

  it('getPreamp returns null', () => {
    expect(getPreamp()).toBeNull();
  });

  it('getRvbLowCut returns null', () => {
    expect(getRvbLowCut()).toBeNull();
  });

  it('getRvbHighCut returns null', () => {
    expect(getRvbHighCut()).toBeNull();
  });

  it('getRvbCrossFade returns null', () => {
    expect(getRvbCrossFade()).toBeNull();
  });

  it('getGlobalLowPass returns null', () => {
    expect(getGlobalLowPass()).toBeNull();
  });

  it('getVbFilter returns null', () => {
    expect(getVbFilter()).toBeNull();
  });

  it('getVbPostFilter returns null', () => {
    expect(getVbPostFilter()).toBeNull();
  });

  it('getVbGain returns null', () => {
    expect(getVbGain()).toBeNull();
  });

  it('getSurroundSplitter returns null', () => {
    expect(getSurroundSplitter()).toBeNull();
  });

  it('getSurroundGain returns null', () => {
    expect(getSurroundGain()).toBeNull();
  });
});

describe('initAudio idempotency', () => {
  it('calling initAudio without Tone.js context does not corrupt module state', async () => {
    // initAudio requires real Tone.js context which is not available in jsdom.
    // Verify that after a failed attempt, getters still return safe defaults.
    const { initAudio } = await import('../engine.ts');
    try {
      await initAudio();
    } catch {
      // Expected: Tone.js not loaded or context not running
    }
    // Module state should remain in pre-init defaults
    expect(isAudioReady()).toBe(false);
    expect(getMasterGain()).toBeNull();
    expect(getEqNodes()).toEqual([]);
  });
});
