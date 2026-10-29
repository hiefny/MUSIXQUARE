import { REVERB_DEFAULT_DECAY, REVERB_DEFAULT_PREDELAY } from './constants.ts';

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

/** Atomic PRO room authority used by the per-device settings-sync option. */
export interface ProRoomSettingsSyncSnapshot {
  schemaVersion: 1;
  view: 'settings-sync';
  roomCode: string;
  revision: number;
  updatedAtMs: number;
  masterVolume: number;
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
    !boundedNumber(value.decaySeconds, 0.1, 10) ||
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

export function parseProRoomSettingsSyncSnapshot(
  value: unknown,
  expectedRoomCode?: string,
): ProRoomSettingsSyncSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'view',
      'roomCode',
      'revision',
      'updatedAtMs',
      'masterVolume',
      'effects',
    ]) ||
    value.schemaVersion !== 1 ||
    value.view !== 'settings-sync' ||
    typeof value.roomCode !== 'string' ||
    !/^0\d{5}$/.test(value.roomCode) ||
    (expectedRoomCode !== undefined && value.roomCode !== expectedRoomCode) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    (value.updatedAtMs as number) < 0 ||
    typeof value.masterVolume !== 'number' ||
    !Number.isFinite(value.masterVolume) ||
    value.masterVolume < 0 ||
    value.masterVolume > 1
  ) {
    return null;
  }
  const effects = parseRoomEffectsState(value.effects);
  return effects
    ? {
        schemaVersion: 1,
        view: 'settings-sync',
        roomCode: value.roomCode,
        revision: value.revision as number,
        updatedAtMs: value.updatedAtMs as number,
        masterVolume: value.masterVolume,
        effects,
      }
    : null;
}
