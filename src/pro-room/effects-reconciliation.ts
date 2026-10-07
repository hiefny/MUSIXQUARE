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
 * Reapply only fields still owned by a pending gesture. Retained device values
 * need not match canonical after cancellation, but are no longer room intent.
 */
function rebaseRoomEffectsIntent(
  desired: RoomEffectsState,
  canonical: RoomEffectsState,
  fields: ReadonlyMap<string, number>,
): RoomEffectsState {
  const rebased = cloneRoomEffects(canonical);
  for (const key of Object.keys(desired.reverb) as (keyof RoomEffectsState['reverb'])[]) {
    if (fields.has(`reverb.${key}`)) rebased.reverb[key] = desired.reverb[key];
  }
  for (let index = 0; index < desired.equalizer.bandsDb.length; index += 1) {
    if (fields.has(`equalizer.${index}`)) {
      rebased.equalizer.bandsDb[index] = desired.equalizer.bandsDb[index];
    }
  }
  if (fields.has('virtualBass')) {
    rebased.virtualBass.strengthPercent = desired.virtualBass.strengthPercent;
  }
  if (fields.has('virtualSurround')) {
    rebased.virtualSurround.widthPercent = desired.virtualSurround.widthPercent;
  }
  if (fields.has('virtualTreble')) {
    rebased.virtualTreble.enabled = desired.virtualTreble.enabled;
  }
  return rebased;
}

interface RoomSettingsIntent {
  masterVolume: number;
  effects: RoomEffectsState;
}

function settingsFieldValues(settings: RoomSettingsIntent): Map<string, number | boolean> {
  return new Map<string, number | boolean>([
    ['masterVolume', settings.masterVolume],
    ...Object.entries(settings.effects.reverb).map(
      ([key, value]) => [`reverb.${key}`, value] as const,
    ),
    ...settings.effects.equalizer.bandsDb.map(
      (value, index) => [`equalizer.${index}`, value] as const,
    ),
    ['virtualBass', settings.effects.virtualBass.strengthPercent],
    ['virtualSurround', settings.effects.virtualSurround.widthPercent],
    ['virtualTreble', settings.effects.virtualTreble.enabled],
  ]);
}

/** Keep retained device settings separate from gestures that may still publish. */
export class RoomSettingsIntentTracker {
  #observed = new Map<string, number | boolean>();
  #revisions = new Map<string, number>();

  observe(settings: RoomSettingsIntent): void {
    this.#observed = settingsFieldValues(settings);
  }

  reset(settings: RoomSettingsIntent): void {
    this.#revisions.clear();
    this.observe(settings);
  }

  markChanged(settings: RoomSettingsIntent, revision: number): void {
    const current = settingsFieldValues(settings);
    for (const [field, value] of current) {
      if (value !== this.#observed.get(field)) this.#revisions.set(field, revision);
    }
    this.#observed = current;
  }

  settle(revision: number): void {
    for (const [field, owner] of this.#revisions) {
      if (owner <= revision) this.#revisions.delete(field);
    }
  }

  reconcile(
    local: RoomSettingsIntent,
    canonical: RoomSettingsIntent,
    forceFull = false,
  ): RoomSettingsIntent {
    if (forceFull) {
      return { masterVolume: local.masterVolume, effects: cloneRoomEffects(local.effects) };
    }
    return {
      masterVolume: this.#revisions.has('masterVolume')
        ? local.masterVolume
        : canonical.masterVolume,
      effects: rebaseRoomEffectsIntent(local.effects, canonical.effects, this.#revisions),
    };
  }
}
