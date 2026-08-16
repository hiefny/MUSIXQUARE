import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.js';

/** @typedef {{ mixPercent: number, decaySeconds: number, preDelaySeconds: number, lowCutPercent: number, highCutPercent: number }} RoomEffectsReverb */
/** @typedef {{ bandsDb: number[] }} RoomEffectsEqualizer */
/** @typedef {{ strengthPercent: number }} RoomEffectsVirtualBass */
/** @typedef {{ widthPercent: number }} RoomEffectsVirtualSurround */
/** @typedef {{ enabled: boolean }} RoomEffectsVirtualTreble */
/** @typedef {{ reverb: RoomEffectsReverb, equalizer: RoomEffectsEqualizer, virtualBass: RoomEffectsVirtualBass, virtualSurround: RoomEffectsVirtualSurround, virtualTreble: RoomEffectsVirtualTreble }} RoomEffects */
/** @typedef {{ reverb?: Partial<RoomEffectsReverb>, equalizer?: RoomEffectsEqualizer, virtualBass?: RoomEffectsVirtualBass, virtualSurround?: RoomEffectsVirtualSurround, virtualTreble?: RoomEffectsVirtualTreble }} RoomEffectsPatch */
/** @typedef {{ revision: number, updatedAtMs: number, masterVolume: number, effects: RoomEffects }} RoomEffectsState */
/** @typedef {{ roomCode: string, effects: RoomEffectsState }} RoomWithEffects */

/** @returns {RoomEffectsState} */
export function initialEffectsState() {
  return {
    revision: 0,
    updatedAtMs: 0,
    masterVolume: 1,
    effects: {
      reverb: {
        mixPercent: 0,
        decaySeconds: 5,
        preDelaySeconds: 0.1,
        lowCutPercent: 0,
        highCutPercent: 0,
      },
      equalizer: { bandsDb: [0, 0, 0, 0, 0] },
      virtualBass: { strengthPercent: 0 },
      virtualSurround: { widthPercent: 100 },
      virtualTreble: { enabled: false },
    },
  };
}

/** @type {Readonly<Record<keyof RoomEffectsReverb, readonly [number, number]>>} */
const EFFECT_REVERB_FIELDS = Object.freeze({
  mixPercent: [0, 100],
  decaySeconds: [0.1, 30],
  preDelaySeconds: [0, 1],
  lowCutPercent: [0, 100],
  highCutPercent: [0, 100],
});

/**
 * @param {unknown} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {value is number}
 */
function boundedEffectNumber(value, minimum, maximum) {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

/**
 * @param {unknown} value
 * @param {boolean} [complete]
 * @returns {RoomEffectsReverb | Partial<RoomEffectsReverb> | null}
 */
function parseEffectsReverb(value, complete = true) {
  const fields = /** @type {(keyof RoomEffectsReverb)[]} */ (Object.keys(EFFECT_REVERB_FIELDS));
  if (!hasExactKeys(value, complete ? fields : [], complete ? [] : fields)) return null;
  if (!complete && Object.keys(value).length === 0) return null;
  /** @type {Partial<RoomEffectsReverb>} */
  const result = {};
  for (const key of /** @type {(keyof RoomEffectsReverb)[]} */ (Object.keys(value))) {
    const [minimum, maximum] = EFFECT_REVERB_FIELDS[key];
    if (!boundedEffectNumber(value[key], minimum, maximum)) return null;
    result[key] = value[key];
  }
  return result;
}

/**
 * @param {unknown} value
 * @returns {RoomEffectsEqualizer | null}
 */
function parseEffectsEqualizer(value) {
  if (
    !hasExactKeys(value, ['bandsDb']) ||
    !Array.isArray(value.bandsDb) ||
    value.bandsDb.length !== 5 ||
    value.bandsDb.some((band) => !boundedEffectNumber(band, -12, 12))
  ) {
    return null;
  }
  return { bandsDb: [...value.bandsDb] };
}

/**
 * @param {unknown} value
 * @returns {RoomEffectsVirtualBass | null}
 */
function parseEffectsVirtualBass(value) {
  return hasExactKeys(value, ['strengthPercent']) &&
    boundedEffectNumber(value.strengthPercent, 0, 100)
    ? { strengthPercent: value.strengthPercent }
    : null;
}

/**
 * @param {unknown} value
 * @returns {RoomEffectsVirtualSurround | null}
 */
function parseEffectsVirtualSurround(value) {
  return hasExactKeys(value, ['widthPercent']) && boundedEffectNumber(value.widthPercent, 0, 200)
    ? { widthPercent: value.widthPercent }
    : null;
}

/**
 * @param {unknown} value
 * @returns {RoomEffectsVirtualTreble | null}
 */
function parseEffectsVirtualTreble(value) {
  return hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
    ? { enabled: value.enabled }
    : null;
}

/**
 * @param {unknown} value
 * @returns {RoomEffects | null}
 */
export function parseRoomEffects(value) {
  if (
    !hasExactKeys(value, ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'])
  ) {
    return null;
  }
  const reverb = /** @type {RoomEffectsReverb | null} */ (parseEffectsReverb(value.reverb));
  const equalizer = parseEffectsEqualizer(value.equalizer);
  const virtualBass = parseEffectsVirtualBass(value.virtualBass);
  const virtualSurround = parseEffectsVirtualSurround(value.virtualSurround);
  const virtualTreble = parseEffectsVirtualTreble(value.virtualTreble);
  return reverb && equalizer && virtualBass && virtualSurround && virtualTreble
    ? { reverb, equalizer, virtualBass, virtualSurround, virtualTreble }
    : null;
}

/**
 * @param {unknown} value
 * @returns {RoomEffectsPatch | null}
 */
export function parseRoomEffectsPatch(value) {
  const allowed = ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'];
  if (!hasExactKeys(value, [], allowed) || Object.keys(value).length === 0) return null;
  /** @type {RoomEffectsPatch} */
  const result = {};
  for (const key of /** @type {(keyof RoomEffectsPatch)[]} */ (Object.keys(value))) {
    const parsed =
      key === 'reverb'
        ? parseEffectsReverb(value.reverb, false)
        : key === 'equalizer'
          ? parseEffectsEqualizer(value.equalizer)
          : key === 'virtualBass'
            ? parseEffectsVirtualBass(value.virtualBass)
            : key === 'virtualSurround'
              ? parseEffectsVirtualSurround(value.virtualSurround)
              : parseEffectsVirtualTreble(value.virtualTreble);
    if (!parsed) return null;
    /** @type {Record<string, unknown>} */ (result)[key] = parsed;
  }
  return result;
}

/**
 * @param {RoomEffects} current
 * @param {RoomEffectsPatch} patch
 * @returns {RoomEffects}
 */
export function mergeRoomEffectsPatch(current, patch) {
  return {
    reverb: { ...current.reverb, ...(patch.reverb || {}) },
    equalizer: patch.equalizer
      ? { bandsDb: [...patch.equalizer.bandsDb] }
      : { bandsDb: [...current.equalizer.bandsDb] },
    virtualBass: { ...(patch.virtualBass || current.virtualBass) },
    virtualSurround: { ...(patch.virtualSurround || current.virtualSurround) },
    virtualTreble: { ...(patch.virtualTreble || current.virtualTreble) },
  };
}

/**
 * @param {unknown} value
 * @returns {{ state: RoomEffectsState, migrated: boolean } | null}
 */
export function normalizeStoredEffects(value) {
  if (
    !hasExactKeys(value, ['revision', 'updatedAtMs', 'effects'], ['masterVolume']) ||
    !isSafeNonNegativeInteger(value.revision) ||
    !isSafeNonNegativeInteger(value.updatedAtMs) ||
    (value.masterVolume !== undefined && !boundedEffectNumber(value.masterVolume, 0, 1))
  ) {
    return null;
  }
  const effects = parseRoomEffects(value.effects);
  return effects
    ? {
        state: {
          revision: value.revision,
          updatedAtMs: value.updatedAtMs,
          masterVolume: value.masterVolume ?? 1,
          effects,
        },
        migrated: value.masterVolume === undefined,
      }
    : null;
}

/**
 * @param {Request} request
 * @returns {2 | null}
 */
export function effectsContractVersion(request) {
  const version = request.headers.get('x-mxqr-pro-effects-version');
  return version === '2' ? 2 : null;
}

/**
 * @param {RoomWithEffects} room
 * @returns {{ schemaVersion: 2, view: 'effects', roomCode: string, revision: number, updatedAtMs: number, effects: RoomEffects }}
 */
export function publicEffects(room) {
  return {
    schemaVersion: 2,
    view: 'effects',
    roomCode: room.roomCode,
    revision: room.effects.revision,
    updatedAtMs: room.effects.updatedAtMs,
    effects: structuredClone(room.effects.effects),
  };
}

/**
 * @param {RoomWithEffects} room
 * @returns {{ schemaVersion: 1, view: 'settings-sync', roomCode: string, revision: number, updatedAtMs: number, masterVolume: number, effects: RoomEffects }}
 */
export function publicSettingsSync(room) {
  return {
    schemaVersion: 1,
    view: 'settings-sync',
    roomCode: room.roomCode,
    revision: room.effects.revision,
    updatedAtMs: room.effects.updatedAtMs,
    masterVolume: room.effects.masterVolume ?? 1,
    effects: structuredClone(room.effects.effects),
  };
}
