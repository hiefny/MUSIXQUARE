import { describe, expect, it } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import {
  rebaseRoomEffectsIntentForTests,
  rebaseRoomSettingsIntent,
  rebaseRoomScalarIntentForTests,
} from '../effects-reconciliation.ts';
import runtimeSource from '../runtime.ts?raw';

describe('PRO room effects runtime contract', () => {
  it('rebases only locally changed fields over a newer canonical snapshot', () => {
    const base = createDefaultRoomEffectsState();
    const desired = structuredClone(base);
    desired.reverb.mixPercent = 45;
    desired.equalizer.bandsDb[0] = 3;
    desired.virtualTreble.enabled = true;

    const canonical = structuredClone(base);
    canonical.reverb.decaySeconds = 7;
    canonical.equalizer.bandsDb[1] = -4;

    expect(rebaseRoomEffectsIntentForTests(base, desired, canonical)).toEqual({
      ...canonical,
      reverb: { ...canonical.reverb, mixPercent: 45 },
      equalizer: { bandsDb: [3, -4, 0, 0, 0] },
      virtualTreble: { enabled: true },
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

  it('rebases volume without letting an effects-only stale writer restore it', () => {
    expect(rebaseRoomScalarIntentForTests(0.5, 0.5, 0.8)).toBe(0.8);
    expect(rebaseRoomScalarIntentForTests(0.5, 0.65, 0.8)).toBe(0.65);
  });

  it('preserves pending intent and makes OFF-to-ON takeover fully authoritative', () => {
    const base = { masterVolume: 0.5, effects: createDefaultRoomEffectsState() };
    const local = structuredClone(base);
    local.effects.equalizer.bandsDb[0] = 3;
    const canonical = structuredClone(base);
    canonical.masterVolume = 0.8;
    canonical.effects.reverb.mixPercent = 45;

    expect(rebaseRoomSettingsIntent(base, local, canonical)).toMatchObject({
      masterVolume: 0.8,
      effects: {
        reverb: { mixPercent: 45 },
        equalizer: { bandsDb: [3, 0, 0, 0, 0] },
      },
    });
    expect(rebaseRoomSettingsIntent(base, local, canonical, true)).toEqual(local);
  });

  it('adopts canonical on initial hydration unless takeover was explicit', () => {
    const localDefaults = {
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    };
    const canonical = structuredClone(localDefaults);
    canonical.masterVolume = 0.24;
    canonical.effects.reverb.mixPercent = 55;

    expect(rebaseRoomSettingsIntent(null, localDefaults, canonical)).toEqual(canonical);
    expect(rebaseRoomSettingsIntent(null, localDefaults, canonical, true)).toEqual(localDefaults);

    const editedDuringRead = structuredClone(localDefaults);
    editedDuringRead.effects.equalizer.bandsDb[2] = 4;
    expect(rebaseRoomSettingsIntent(localDefaults, editedDuringRead, canonical)).toMatchObject({
      masterVolume: 0.24,
      effects: {
        reverb: { mixPercent: 55 },
        equalizer: { bandsDb: [0, 0, 4, 0, 0] },
      },
    });
  });

  it('rebases an edit made after failed initial hydration from the session baseline', () => {
    const baseline = { masterVolume: 1, effects: createDefaultRoomEffectsState() };
    const edited = structuredClone(baseline);
    edited.effects.equalizer.bandsDb[1] = -5;
    const canonical = structuredClone(baseline);
    canonical.masterVolume = 0.4;
    canonical.effects.reverb.mixPercent = 35;

    expect(rebaseRoomSettingsIntent(baseline, edited, canonical)).toMatchObject({
      masterVolume: 0.4,
      effects: {
        reverb: { mixPercent: 35 },
        equalizer: { bandsDb: [0, -5, 0, 0, 0] },
      },
    });
  });

  it('uses revision CAS and refreshes same-epoch resources only when their heads advance', () => {
    expect(runtimeSource).toContain('baseRevision: base.revision');
    expect(runtimeSource).toContain("error.code === 'SETTINGS_SYNC_REVISION_CONFLICT'");
    expect(runtimeSource).toContain('snapshot.effectsRevision > acceptedEffects.revision');
    expect(runtimeSource).toContain('snapshot.queueModeRevision > acceptedQueueMode.revision');
    expect(runtimeSource).toContain('acceptCanonicalRoomSettings(effects, masterVolume)');
    expect(runtimeSource).toContain("'state:audio.exciter'");
    expect(runtimeSource).toContain('let desired = captureRoomEffectsState()');
    expect(runtimeSource).toContain('hasEffectsCheckpointAuthority');
    expect(runtimeSource).toContain('localVolumeBeforeRead');
    expect(runtimeSource).toContain('effectsSessionBaseline');
    expect(runtimeSource).toContain('scheduleEffectsCheckpointRetry');
  });
});
