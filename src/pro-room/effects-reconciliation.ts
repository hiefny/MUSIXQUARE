import type { RoomEffectsState } from '../core/room-effects.ts';

function cloneRoomEffects(effects: RoomEffectsState): RoomEffectsState {
  return {
    reverb: { ...effects.reverb },
    equalizer: {
      bandsDb: [...effects.equalizer.bandsDb] as RoomEffectsState['equalizer']['bandsDb'],
    },
    virtualBass: { ...effects.virtualBass },
    virtualSurround: { ...effects.virtualSurround },
    virtualTreble: { ...effects.virtualTreble },
  };
}

/**
 * Reapply only the fields changed relative to `base` onto a newer canonical
 * snapshot. Two participants can therefore adjust unrelated controls without
 * a stale full-form write erasing either change.
 */
function rebaseRoomEffectsIntent(
  base: RoomEffectsState,
  desired: RoomEffectsState,
  canonical: RoomEffectsState,
): RoomEffectsState {
  const rebased = cloneRoomEffects(canonical);
  for (const key of Object.keys(base.reverb) as (keyof RoomEffectsState['reverb'])[]) {
    if (desired.reverb[key] !== base.reverb[key]) rebased.reverb[key] = desired.reverb[key];
  }
  for (let index = 0; index < desired.equalizer.bandsDb.length; index += 1) {
    if (desired.equalizer.bandsDb[index] !== base.equalizer.bandsDb[index]) {
      rebased.equalizer.bandsDb[index] = desired.equalizer.bandsDb[index];
    }
  }
  if (desired.virtualBass.strengthPercent !== base.virtualBass.strengthPercent) {
    rebased.virtualBass.strengthPercent = desired.virtualBass.strengthPercent;
  }
  if (desired.virtualSurround.widthPercent !== base.virtualSurround.widthPercent) {
    rebased.virtualSurround.widthPercent = desired.virtualSurround.widthPercent;
  }
  if (desired.virtualTreble.enabled !== base.virtualTreble.enabled) {
    rebased.virtualTreble.enabled = desired.virtualTreble.enabled;
  }
  return rebased;
}

/**
 * Reapply a scalar local intent over a newer canonical value. Volume shares
 * the effects resource revision, so an EQ-only stale writer must not also
 * restore its old volume.
 */
function rebaseRoomScalarIntent(base: number, desired: number, canonical: number): number {
  return desired === base ? canonical : desired;
}

interface RoomSettingsIntent {
  masterVolume: number;
  effects: RoomEffectsState;
}

/** Reconcile the atomic volume + DSP resource, including explicit takeover. */
export function rebaseRoomSettingsIntent(
  base: RoomSettingsIntent | null,
  desired: RoomSettingsIntent,
  canonical: RoomSettingsIntent,
  forceFull = false,
): RoomSettingsIntent {
  if (forceFull) {
    return { masterVolume: desired.masterVolume, effects: cloneRoomEffects(desired.effects) };
  }
  // With no accepted base, local values are merely device defaults, not an
  // attributable edit. Initial PRO hydration must adopt server canonical;
  // only an explicit OFF-to-ON takeover may replace the whole resource.
  if (!base) {
    return {
      masterVolume: canonical.masterVolume,
      effects: cloneRoomEffects(canonical.effects),
    };
  }
  return {
    masterVolume: rebaseRoomScalarIntent(
      base.masterVolume,
      desired.masterVolume,
      canonical.masterVolume,
    ),
    effects: rebaseRoomEffectsIntent(base.effects, desired.effects, canonical.effects),
  };
}

/** @internal Focused reconciliation tests only. */
export {
  rebaseRoomEffectsIntent as rebaseRoomEffectsIntentForTests,
  rebaseRoomScalarIntent as rebaseRoomScalarIntentForTests,
};
