import { describe, expect, it } from 'vitest';
import {
  createDefaultRoomEffectsState,
  parseRoomEffectsState,
  roomEffectsEqual,
} from '../room-effects.ts';

describe('room-wide effects contract', () => {
  it('accepts one strict full state', () => {
    const effects = {
      reverb: {
        mixPercent: 40,
        decaySeconds: 1,
        preDelaySeconds: 0.02,
        lowCutPercent: 0,
        highCutPercent: 0,
      },
      equalizer: { bandsDb: [0, -2, 0, 4, 6] },
      virtualBass: { strengthPercent: 60 },
      virtualSurround: { widthPercent: 120 },
      virtualTreble: { enabled: true },
    };

    expect(parseRoomEffectsState(effects)).toEqual(effects);
  });

  it('compares two full states value by value', () => {
    const effects = createDefaultRoomEffectsState();
    expect(roomEffectsEqual(effects, structuredClone(effects))).toBe(true);
    const changed = structuredClone(effects);
    changed.equalizer.bandsDb[3] = 4;
    expect(roomEffectsEqual(effects, changed)).toBe(false);
  });

  it.each([0.1, 10])('accepts the %s-second decay boundary in states', (decay) => {
    const effects = createDefaultRoomEffectsState();
    effects.reverb.decaySeconds = decay;
    expect(parseRoomEffectsState(effects)).toEqual(effects);
  });

  it.each([0.09, 10.1, 20, 30, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects out-of-range decay %s in full states',
    (decay) => {
      const effects = createDefaultRoomEffectsState();
      effects.reverb.decaySeconds = decay;
      expect(parseRoomEffectsState(effects)).toBeNull();
    },
  );

  it('keeps the full state exact-key contract', () => {
    const effects = createDefaultRoomEffectsState();
    expect(parseRoomEffectsState({ ...effects, localVolume: 0.5 })).toBeNull();
  });

  it('rejects the retired effects v1 state without virtual treble', () => {
    const effects = createDefaultRoomEffectsState();
    const { virtualTreble: _virtualTreble, ...legacyEffects } = effects;

    expect(parseRoomEffectsState(legacyEffects)).toBeNull();
  });
});
