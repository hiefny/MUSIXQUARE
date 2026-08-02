import { REVERB_DEFAULT_DECAY, REVERB_DEFAULT_PREDELAY } from './constants.ts';

const ROOM_EFFECTS_SCHEMA_VERSION = 2 as const;

interface RoomReverbState {
  mixPercent: number;
  decaySeconds: number;
  preDelaySeconds: number;
  lowCutPercent: number;
  highCutPercent: number;
}

export interface RoomEffectsState {
  reverb: RoomReverbState;
  equalizer: {
    bandsDb: [number, number, number, number, number];
  };
  virtualBass: {
    strengthPercent: number;
  };
  virtualSurround: {
    widthPercent: number;
  };
  virtualTreble: {
    enabled: boolean;
  };
}

export interface RoomEffectsPatch {
  reverb?: Partial<RoomReverbState>;
  equalizer?: RoomEffectsState['equalizer'];
  virtualBass?: RoomEffectsState['virtualBass'];
  virtualSurround?: RoomEffectsState['virtualSurround'];
  virtualTreble?: RoomEffectsState['virtualTreble'];
}

export interface ProRoomEffectsSnapshot {
  schemaVersion: typeof ROOM_EFFECTS_SCHEMA_VERSION;
  view: 'effects';
  roomCode: string;
  revision: number;
  updatedAtMs: number;
  effects: RoomEffectsState;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function parseReverbState(value: unknown): RoomReverbState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'mixPercent',
      'decaySeconds',
      'preDelaySeconds',
      'lowCutPercent',
      'highCutPercent',
    ]) ||
    !boundedNumber(value.mixPercent, 0, 100) ||
    !boundedNumber(value.decaySeconds, 0.1, 30) ||
    !boundedNumber(value.preDelaySeconds, 0, 1) ||
    !boundedNumber(value.lowCutPercent, 0, 100) ||
    !boundedNumber(value.highCutPercent, 0, 100)
  ) {
    return null;
  }
  return {
    mixPercent: value.mixPercent,
    decaySeconds: value.decaySeconds,
    preDelaySeconds: value.preDelaySeconds,
    lowCutPercent: value.lowCutPercent,
    highCutPercent: value.highCutPercent,
  };
}

function parseEqualizerState(value: unknown): RoomEffectsState['equalizer'] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['bandsDb']) || !Array.isArray(value.bandsDb)) {
    return null;
  }
  if (value.bandsDb.length !== 5 || value.bandsDb.some((band) => !boundedNumber(band, -12, 12))) {
    return null;
  }
  return {
    bandsDb: [...value.bandsDb] as RoomEffectsState['equalizer']['bandsDb'],
  };
}

function parseVirtualBassState(value: unknown): RoomEffectsState['virtualBass'] | null {
  return isRecord(value) &&
    hasExactKeys(value, ['strengthPercent']) &&
    boundedNumber(value.strengthPercent, 0, 100)
    ? { strengthPercent: value.strengthPercent }
    : null;
}

function parseVirtualSurroundState(value: unknown): RoomEffectsState['virtualSurround'] | null {
  return isRecord(value) &&
    hasExactKeys(value, ['widthPercent']) &&
    boundedNumber(value.widthPercent, 0, 200)
    ? { widthPercent: value.widthPercent }
    : null;
}

function parseVirtualTrebleState(value: unknown): RoomEffectsState['virtualTreble'] | null {
  return isRecord(value) && hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
    ? { enabled: value.enabled }
    : null;
}

export function createDefaultRoomEffectsState(): RoomEffectsState {
  return {
    reverb: {
      mixPercent: 0,
      decaySeconds: REVERB_DEFAULT_DECAY,
      preDelaySeconds: REVERB_DEFAULT_PREDELAY,
      lowCutPercent: 0,
      highCutPercent: 0,
    },
    equalizer: { bandsDb: [0, 0, 0, 0, 0] },
    virtualBass: { strengthPercent: 0 },
    virtualSurround: { widthPercent: 100 },
    virtualTreble: { enabled: false },
  };
}

export function parseRoomEffectsState(value: unknown): RoomEffectsState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'])
  ) {
    return null;
  }
  const reverb = parseReverbState(value.reverb);
  const equalizer = parseEqualizerState(value.equalizer);
  const virtualBass = parseVirtualBassState(value.virtualBass);
  const virtualSurround = parseVirtualSurroundState(value.virtualSurround);
  const virtualTreble = parseVirtualTrebleState(value.virtualTreble);
  return reverb && equalizer && virtualBass && virtualSurround && virtualTreble
    ? { reverb, equalizer, virtualBass, virtualSurround, virtualTreble }
    : null;
}

export function parseRoomEffectsPatch(value: unknown): RoomEffectsPatch | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !hasExactKeys(
      value,
      [],
      ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'],
    )
  ) {
    return null;
  }
  const patch: RoomEffectsPatch = {};
  if (value.reverb !== undefined) {
    if (
      !isRecord(value.reverb) ||
      Object.keys(value.reverb).length === 0 ||
      !hasExactKeys(
        value.reverb,
        [],
        ['mixPercent', 'decaySeconds', 'preDelaySeconds', 'lowCutPercent', 'highCutPercent'],
      )
    ) {
      return null;
    }
    const ranges: Record<keyof RoomReverbState, readonly [number, number]> = {
      mixPercent: [0, 100],
      decaySeconds: [0.1, 30],
      preDelaySeconds: [0, 1],
      lowCutPercent: [0, 100],
      highCutPercent: [0, 100],
    };
    const reverb: Partial<RoomReverbState> = {};
    for (const key of Object.keys(value.reverb) as (keyof RoomReverbState)[]) {
      const [min, max] = ranges[key];
      const candidate = value.reverb[key];
      if (!boundedNumber(candidate, min, max)) return null;
      reverb[key] = candidate;
    }
    patch.reverb = reverb;
  }
  if (value.equalizer !== undefined) {
    const equalizer = parseEqualizerState(value.equalizer);
    if (!equalizer) return null;
    patch.equalizer = equalizer;
  }
  if (value.virtualBass !== undefined) {
    const virtualBass = parseVirtualBassState(value.virtualBass);
    if (!virtualBass) return null;
    patch.virtualBass = virtualBass;
  }
  if (value.virtualSurround !== undefined) {
    const virtualSurround = parseVirtualSurroundState(value.virtualSurround);
    if (!virtualSurround) return null;
    patch.virtualSurround = virtualSurround;
  }
  if (value.virtualTreble !== undefined) {
    const virtualTreble = parseVirtualTrebleState(value.virtualTreble);
    if (!virtualTreble) return null;
    patch.virtualTreble = virtualTreble;
  }
  return patch;
}

export function mergeRoomEffectsForTests(
  current: RoomEffectsState,
  patch: RoomEffectsPatch,
): RoomEffectsState {
  return {
    reverb: { ...current.reverb, ...(patch.reverb ?? {}) },
    equalizer: patch.equalizer
      ? { bandsDb: [...patch.equalizer.bandsDb] }
      : { bandsDb: [...current.equalizer.bandsDb] },
    virtualBass: { ...(patch.virtualBass ?? current.virtualBass) },
    virtualSurround: { ...(patch.virtualSurround ?? current.virtualSurround) },
    virtualTreble: { ...(patch.virtualTreble ?? current.virtualTreble) },
  };
}

export function roomEffectsEqual(left: RoomEffectsState, right: RoomEffectsState): boolean {
  return (
    left.reverb.mixPercent === right.reverb.mixPercent &&
    left.reverb.decaySeconds === right.reverb.decaySeconds &&
    left.reverb.preDelaySeconds === right.reverb.preDelaySeconds &&
    left.reverb.lowCutPercent === right.reverb.lowCutPercent &&
    left.reverb.highCutPercent === right.reverb.highCutPercent &&
    left.equalizer.bandsDb.every((band, index) => band === right.equalizer.bandsDb[index]) &&
    left.virtualBass.strengthPercent === right.virtualBass.strengthPercent &&
    left.virtualSurround.widthPercent === right.virtualSurround.widthPercent &&
    left.virtualTreble.enabled === right.virtualTreble.enabled
  );
}

export function parseProRoomEffectsSnapshot(
  value: unknown,
  expectedRoomCode?: string,
): ProRoomEffectsSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'view',
      'roomCode',
      'revision',
      'updatedAtMs',
      'effects',
    ]) ||
    value.schemaVersion !== ROOM_EFFECTS_SCHEMA_VERSION ||
    value.view !== 'effects' ||
    typeof value.roomCode !== 'string' ||
    !/^0\d{5}$/.test(value.roomCode) ||
    (expectedRoomCode !== undefined && value.roomCode !== expectedRoomCode) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    (value.updatedAtMs as number) < 0
  ) {
    return null;
  }
  const effects = parseRoomEffectsState(value.effects);
  return effects
    ? {
        schemaVersion: value.schemaVersion,
        view: 'effects',
        roomCode: value.roomCode,
        revision: value.revision as number,
        updatedAtMs: value.updatedAtMs as number,
        effects,
      }
    : null;
}
