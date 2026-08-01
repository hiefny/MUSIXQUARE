import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.js';

export function initialEffectsState() {
  return {
    revision: 0,
    updatedAtMs: 0,
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

const EFFECT_REVERB_FIELDS = Object.freeze({
  mixPercent: [0, 100],
  decaySeconds: [0.1, 30],
  preDelaySeconds: [0, 1],
  lowCutPercent: [0, 100],
  highCutPercent: [0, 100],
});

function boundedEffectNumber(value, minimum, maximum) {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function parseEffectsReverb(value, complete = true) {
  const fields = Object.keys(EFFECT_REVERB_FIELDS);
  if (!hasExactKeys(value, complete ? fields : [], complete ? [] : fields)) return null;
  if (!complete && Object.keys(value).length === 0) return null;
  const result = {};
  for (const key of Object.keys(value)) {
    const [minimum, maximum] = EFFECT_REVERB_FIELDS[key];
    if (!boundedEffectNumber(value[key], minimum, maximum)) return null;
    result[key] = value[key];
  }
  return result;
}

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

function parseEffectsVirtualBass(value) {
  return hasExactKeys(value, ['strengthPercent']) &&
    boundedEffectNumber(value.strengthPercent, 0, 100)
    ? { strengthPercent: value.strengthPercent }
    : null;
}

function parseEffectsVirtualSurround(value) {
  return hasExactKeys(value, ['widthPercent']) && boundedEffectNumber(value.widthPercent, 0, 200)
    ? { widthPercent: value.widthPercent }
    : null;
}

function parseEffectsVirtualTreble(value) {
  return hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
    ? { enabled: value.enabled }
    : null;
}

export function parseRoomEffects(value) {
  if (
    !hasExactKeys(value, ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'])
  ) {
    return null;
  }
  const reverb = parseEffectsReverb(value.reverb);
  const equalizer = parseEffectsEqualizer(value.equalizer);
  const virtualBass = parseEffectsVirtualBass(value.virtualBass);
  const virtualSurround = parseEffectsVirtualSurround(value.virtualSurround);
  const virtualTreble = parseEffectsVirtualTreble(value.virtualTreble);
  return reverb && equalizer && virtualBass && virtualSurround && virtualTreble
    ? { reverb, equalizer, virtualBass, virtualSurround, virtualTreble }
    : null;
}

export function parseRoomEffectsPatch(value) {
  const allowed = ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'];
  if (!hasExactKeys(value, [], allowed) || Object.keys(value).length === 0) return null;
  const result = {};
  for (const key of Object.keys(value)) {
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
    result[key] = parsed;
  }
  return result;
}

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

export function normalizeStoredEffects(value) {
  if (
    !hasExactKeys(value, ['revision', 'updatedAtMs', 'effects']) ||
    !isSafeNonNegativeInteger(value.revision) ||
    !isSafeNonNegativeInteger(value.updatedAtMs)
  ) {
    return null;
  }
  const effects = parseRoomEffects(value.effects);
  return effects
    ? {
        state: { revision: value.revision, updatedAtMs: value.updatedAtMs, effects },
        migrated: false,
      }
    : null;
}

export function effectsContractVersion(request) {
  const version = request.headers.get('x-mxqr-pro-effects-version');
  return version === '2' ? 2 : null;
}

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
