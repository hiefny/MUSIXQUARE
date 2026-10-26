import { describe, expect, it } from 'vitest';
import {
  createDefaultRoomEffectsState,
  mergeRoomEffectsForTests,
  parseRoomEffectsPatch,
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

  it('accepts non-empty partial updates and merges omitted values atomically', () => {
    const current = createDefaultRoomEffectsState();
    const patch = parseRoomEffectsPatch({
      reverb: { mixPercent: 33 },
      equalizer: { bandsDb: [5, 3, 0, -2, -3] },
      virtualTreble: { enabled: true },
    });
    expect(patch).not.toBeNull();
    const merged = mergeRoomEffectsForTests(current, patch!);
    expect(merged.reverb).toEqual({ ...current.reverb, mixPercent: 33 });
    expect(merged.equalizer.bandsDb).toEqual([5, 3, 0, -2, -3]);
    expect(merged.virtualBass).toEqual(current.virtualBass);
    expect(merged.virtualTreble).toEqual({ enabled: true });
    expect(roomEffectsEqual(merged, structuredClone(merged))).toBe(true);
  });

  it.each([0.1, 10])('accepts the %s-second decay boundary in states and commands', (decay) => {
    const effects = createDefaultRoomEffectsState();
    effects.reverb.decaySeconds = decay;
    expect(parseRoomEffectsState(effects)).toEqual(effects);
    const patch = { reverb: { decaySeconds: decay } };
    expect(parseRoomEffectsPatch(patch)).toEqual(patch);
  });

  it.each([0.09, 10.1, 20, 30, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects out-of-range decay %s in full states and commands',
    (decay) => {
      const effects = createDefaultRoomEffectsState();
      effects.reverb.decaySeconds = decay;
      expect(parseRoomEffectsState(effects)).toBeNull();
      expect(parseRoomEffectsPatch({ reverb: { decaySeconds: decay } })).toBeNull();
    },
  );

  it.each([
    {},
    { reverb: {} },
    { reverb: { mixPercent: 101 } },
    { equalizer: { bandsDb: [0, 0, 0, 0] } },
    { virtualBass: { strengthPercent: -1 } },
    { virtualSurround: { widthPercent: 201 } },
    { virtualTreble: { enabled: 'yes' } },
    { virtualBass: { strengthPercent: 20, privatePreset: true } },
  ])('rejects an invalid or ambiguous patch %#', (value) => {
    expect(parseRoomEffectsPatch(value)).toBeNull();
  });

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
