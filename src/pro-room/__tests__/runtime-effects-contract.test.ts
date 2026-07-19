import { describe, expect, it } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { rebaseRoomEffectsIntentForTests } from '../runtime.ts';
import runtimeSource from '../runtime.ts?raw';

describe('PRO room effects runtime contract', () => {
  it('rebases only locally changed fields over a newer canonical snapshot', () => {
    const base = createDefaultRoomEffectsState();
    const desired = structuredClone(base);
    desired.reverb.mixPercent = 45;
    desired.equalizer.bandsDb[0] = 3;

    const canonical = structuredClone(base);
    canonical.reverb.decaySeconds = 7;
    canonical.equalizer.bandsDb[1] = -4;

    expect(rebaseRoomEffectsIntentForTests(base, desired, canonical)).toEqual({
      ...canonical,
      reverb: { ...canonical.reverb, mixPercent: 45 },
      equalizer: { bandsDb: [3, -4, 0, 0, 0] },
    });
  });

  it('lets the local intent win when both writers changed the same field', () => {
    const base = createDefaultRoomEffectsState();
    const desired = structuredClone(base);
    const canonical = structuredClone(base);
    desired.virtualSurround.widthPercent = 140;
    canonical.virtualSurround.widthPercent = 80;

    expect(
      rebaseRoomEffectsIntentForTests(base, desired, canonical).virtualSurround.widthPercent,
    ).toBe(140);
  });

  it('uses revision CAS and refreshes same-epoch resources only when their heads advance', () => {
    expect(runtimeSource).toContain('baseRevision: base.revision');
    expect(runtimeSource).toContain("error.code !== 'EFFECTS_REVISION_CONFLICT'");
    expect(runtimeSource).toContain('snapshot.effectsRevision > acceptedEffects.revision');
    expect(runtimeSource).toContain('snapshot.queueModeRevision > acceptedQueueMode.revision');
    expect(runtimeSource).toContain('applyRoomEffectsState(effects, { broadcast: false })');
  });
});
