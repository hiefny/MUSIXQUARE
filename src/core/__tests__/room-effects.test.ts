import { describe, expect, it } from 'vitest';
import {
  createDefaultRoomEffectsState,
  mergeRoomEffectsForTests,
  parseProRoomEffectsSnapshot,
  parseRoomEffectsPatch,
  parseRoomEffectsState,
  roomEffectsEqual,
} from '../room-effects.ts';

describe('room-wide effects contract', () => {
  it('accepts one strict full state and round-trips a dedicated PRO projection', () => {
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
    };

    expect(parseRoomEffectsState(effects)).toEqual(effects);
    expect(
      parseProRoomEffectsSnapshot(
        {
          schemaVersion: 1,
          view: 'effects',
          roomCode: '000001',
          revision: 7,
          updatedAtMs: 1_800_000_000_000,
          effects,
        },
        '000001',
      ),
    ).toEqual(expect.objectContaining({ effects, revision: 7 }));
  });

  it('accepts non-empty partial updates and merges omitted values atomically', () => {
    const current = createDefaultRoomEffectsState();
    const patch = parseRoomEffectsPatch({
      reverb: { mixPercent: 33 },
      equalizer: { bandsDb: [5, 3, 0, -2, -3] },
    });
    expect(patch).not.toBeNull();
    const merged = mergeRoomEffectsForTests(current, patch!);
    expect(merged.reverb).toEqual({ ...current.reverb, mixPercent: 33 });
    expect(merged.equalizer.bandsDb).toEqual([5, 3, 0, -2, -3]);
    expect(merged.virtualBass).toEqual(current.virtualBass);
    expect(roomEffectsEqual(merged, structuredClone(merged))).toBe(true);
  });

  it.each([
    {},
    { reverb: {} },
    { reverb: { mixPercent: 101 } },
    { equalizer: { bandsDb: [0, 0, 0, 0] } },
    { virtualBass: { strengthPercent: -1 } },
    { virtualSurround: { widthPercent: 201 } },
    { virtualBass: { strengthPercent: 20, privatePreset: true } },
  ])('rejects an invalid or ambiguous patch %#', (value) => {
    expect(parseRoomEffectsPatch(value)).toBeNull();
  });

  it('keeps the full state and projection exact-key contracts', () => {
    const effects = createDefaultRoomEffectsState();
    expect(parseRoomEffectsState({ ...effects, localVolume: 0.5 })).toBeNull();
    expect(
      parseProRoomEffectsSnapshot({
        schemaVersion: 1,
        view: 'effects',
        roomCode: '000001',
        revision: 0,
        updatedAtMs: 0,
        effects,
        coordinatorId: 'private',
      }),
    ).toBeNull();
  });
});
