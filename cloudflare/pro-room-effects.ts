import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.ts';

type RoomEffectsReverbField =
  | 'mixPercent'
  | 'decaySeconds'
  | 'preDelaySeconds'
  | 'lowCutPercent'
  | 'highCutPercent';

export type RoomEffectsReverb = Record<RoomEffectsReverbField, number>;

export interface RoomEffectsEqualizer {
  bandsDb: number[];
}

export interface RoomEffectsVirtualBass {
  strengthPercent: number;
}

export interface RoomEffectsVirtualSurround {
  widthPercent: number;
}

export interface RoomEffectsVirtualTreble {
  enabled: boolean;
}

export interface RoomEffects {
  reverb: RoomEffectsReverb;
  equalizer: RoomEffectsEqualizer;
  virtualBass: RoomEffectsVirtualBass;
  virtualSurround: RoomEffectsVirtualSurround;
  virtualTreble: RoomEffectsVirtualTreble;
}

export interface RoomEffectsPatch {
  reverb?: Partial<RoomEffectsReverb>;
  equalizer?: RoomEffectsEqualizer;
  virtualBass?: RoomEffectsVirtualBass;
  virtualSurround?: RoomEffectsVirtualSurround;
  virtualTreble?: RoomEffectsVirtualTreble;
}

export interface RoomEffectsState {
  revision: number;
  updatedAtMs: number;
  masterVolume: number;
  effects: RoomEffects;
}

export interface RoomWithEffects {
  roomCode: string;
  effects: RoomEffectsState;
}

export interface PublicEffects {
  schemaVersion: 2;
  view: 'effects';
  roomCode: string;
  revision: number;
  updatedAtMs: number;
  effects: RoomEffects;
}

export interface PublicSettingsSync {
  schemaVersion: 1;
  view: 'settings-sync';
  roomCode: string;
  revision: number;
  updatedAtMs: number;
  masterVolume: number;
  effects: RoomEffects;
}

export function initialEffectsState(): RoomEffectsState {
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

const EFFECT_REVERB_FIELDS: Readonly<Record<RoomEffectsReverbField, readonly [number, number]>> =
  Object.freeze({
    mixPercent: [0, 100],
    decaySeconds: [0.1, 30],
    preDelaySeconds: [0, 1],
    lowCutPercent: [0, 100],
    highCutPercent: [0, 100],
  });

function boundedEffectNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function isRoomEffectsReverbField(value: string): value is RoomEffectsReverbField {
  return Object.prototype.hasOwnProperty.call(EFFECT_REVERB_FIELDS, value);
}

function parseEffectsReverb(value: unknown, complete?: true): RoomEffectsReverb | null;
function parseEffectsReverb(value: unknown, complete: false): Partial<RoomEffectsReverb> | null;
function parseEffectsReverb(
  value: unknown,
  complete = true,
): RoomEffectsReverb | Partial<RoomEffectsReverb> | null {
  const fields = Object.keys(EFFECT_REVERB_FIELDS);
  if (!hasExactKeys(value, complete ? fields : [], complete ? [] : fields)) return null;
  if (!complete && Object.keys(value).length === 0) return null;
  const result: Partial<RoomEffectsReverb> = {};
  for (const key of Object.keys(value)) {
    if (!isRoomEffectsReverbField(key)) return null;
    const [minimum, maximum] = EFFECT_REVERB_FIELDS[key];
    if (!boundedEffectNumber(value[key], minimum, maximum)) return null;
    result[key] = value[key];
  }
  return result;
}

function isEffectsEqualizerBands(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    value.every((band: unknown) => boundedEffectNumber(band, -12, 12))
  );
}

function parseEffectsEqualizer(value: unknown): RoomEffectsEqualizer | null {
  if (!hasExactKeys(value, ['bandsDb']) || !isEffectsEqualizerBands(value.bandsDb)) {
    return null;
  }
  return { bandsDb: [...value.bandsDb] };
}

function parseEffectsVirtualBass(value: unknown): RoomEffectsVirtualBass | null {
  return hasExactKeys(value, ['strengthPercent']) &&
    boundedEffectNumber(value.strengthPercent, 0, 100)
    ? { strengthPercent: value.strengthPercent }
    : null;
}

function parseEffectsVirtualSurround(value: unknown): RoomEffectsVirtualSurround | null {
  return hasExactKeys(value, ['widthPercent']) && boundedEffectNumber(value.widthPercent, 0, 200)
    ? { widthPercent: value.widthPercent }
    : null;
}

function parseEffectsVirtualTreble(value: unknown): RoomEffectsVirtualTreble | null {
  return hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
    ? { enabled: value.enabled }
    : null;
}

export function parseRoomEffects(value: unknown): RoomEffects | null {
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

export function parseRoomEffectsPatch(value: unknown): RoomEffectsPatch | null {
  const allowed = ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'];
  if (!hasExactKeys(value, [], allowed) || Object.keys(value).length === 0) return null;
  const result: RoomEffectsPatch = {};
  for (const key of Object.keys(value)) {
    switch (key) {
      case 'reverb': {
        const parsed = parseEffectsReverb(value.reverb, false);
        if (!parsed) return null;
        result.reverb = parsed;
        break;
      }
      case 'equalizer': {
        const parsed = parseEffectsEqualizer(value.equalizer);
        if (!parsed) return null;
        result.equalizer = parsed;
        break;
      }
      case 'virtualBass': {
        const parsed = parseEffectsVirtualBass(value.virtualBass);
        if (!parsed) return null;
        result.virtualBass = parsed;
        break;
      }
      case 'virtualSurround': {
        const parsed = parseEffectsVirtualSurround(value.virtualSurround);
        if (!parsed) return null;
        result.virtualSurround = parsed;
        break;
      }
      case 'virtualTreble': {
        const parsed = parseEffectsVirtualTreble(value.virtualTreble);
        if (!parsed) return null;
        result.virtualTreble = parsed;
        break;
      }
      default:
        return null;
    }
  }
  return result;
}

export function mergeRoomEffectsPatch(current: RoomEffects, patch: RoomEffectsPatch): RoomEffects {
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

export function normalizeStoredEffects(
  value: unknown,
): { state: RoomEffectsState; migrated: boolean } | null {
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

export function effectsContractVersion(request: Request): 2 | null {
  const version = request.headers.get('x-mxqr-pro-effects-version');
  return version === '2' ? 2 : null;
}

export function publicEffects(room: RoomWithEffects): PublicEffects {
  return {
    schemaVersion: 2,
    view: 'effects',
    roomCode: room.roomCode,
    revision: room.effects.revision,
    updatedAtMs: room.effects.updatedAtMs,
    effects: structuredClone(room.effects.effects),
  };
}

export function publicSettingsSync(room: RoomWithEffects): PublicSettingsSync {
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
