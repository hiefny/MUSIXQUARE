export const AAC_CAPABILITY_PROBE_PROTOCOL_VERSION = 1 as const;
export const AAC_CAPABILITY_PROBE_GENERATION = 1 as const;
export const AAC_CAPABILITY_PROBE_MAX_ERROR_MESSAGE_LENGTH = 1_024;
/** One-frame admission is intentionally generous for cold mobile WebCodecs startup, but bounded. */
export const AAC_CAPABILITY_PROBE_TIMEOUT_MS = 30_000;

const ADTS_MIN_FRAME_BYTES = 8;
const ADTS_MAX_FRAME_BYTES = 8_191;

export type AacCapabilityProbeErrorCode = 'unavailable' | 'integrity' | 'internal';

export interface AacCapabilityProbeCommand {
  readonly protocolVersion: typeof AAC_CAPABILITY_PROBE_PROTOCOL_VERSION;
  readonly type: 'probe-adts-webcodecs';
  readonly probeGeneration: typeof AAC_CAPABILITY_PROBE_GENERATION;
  readonly frame: Uint8Array;
}

interface AacCapabilityProbeEventIdentity {
  readonly protocolVersion: typeof AAC_CAPABILITY_PROBE_PROTOCOL_VERSION;
  readonly probeGeneration: typeof AAC_CAPABILITY_PROBE_GENERATION;
}

export type AacCapabilityProbeEvent =
  | (AacCapabilityProbeEventIdentity & {
      readonly type: 'probe-ready';
    })
  | (AacCapabilityProbeEventIdentity & {
      readonly type: 'probe-error';
      readonly code: AacCapabilityProbeErrorCode;
      readonly message: string;
    });

type StrictRecord = Readonly<Record<string, unknown>>;

const Uint8ArrayIntrinsic = Uint8Array;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const typedArrayTagGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
  : undefined;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;

function snapshotRecord(value: unknown): StrictRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || Object.hasOwn(snapshot, key)) return null;
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function hasExactKeys(record: StrictRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function snapshotFrame(value: unknown): Uint8Array | null {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    return null;
  }
  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') return null;
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // A SharedArrayBuffer-backed frame cannot be snapshotted coherently.
    arrayBufferByteLengthGetter.call(buffer);
  } catch {
    return null;
  }
  if (byteLength < ADTS_MIN_FRAME_BYTES || byteLength > ADTS_MAX_FRAME_BYTES) return null;
  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    Reflect.apply(uint8ArraySet, owned, [value, 0]);
  } catch {
    return null;
  }
  return owned;
}

export function parseAacCapabilityProbeCommand(
  value: unknown,
): Readonly<AacCapabilityProbeCommand> | null {
  const record = snapshotRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ['protocolVersion', 'type', 'probeGeneration', 'frame']) ||
    record.protocolVersion !== AAC_CAPABILITY_PROBE_PROTOCOL_VERSION ||
    record.type !== 'probe-adts-webcodecs' ||
    record.probeGeneration !== AAC_CAPABILITY_PROBE_GENERATION
  ) {
    return null;
  }
  const frame = snapshotFrame(record.frame);
  return frame
    ? Object.freeze({
        protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
        type: 'probe-adts-webcodecs' as const,
        probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
        frame,
      })
    : null;
}

function isErrorCode(value: unknown): value is AacCapabilityProbeErrorCode {
  return value === 'unavailable' || value === 'integrity' || value === 'internal';
}

export function parseAacCapabilityProbeEvent(
  value: unknown,
): Readonly<AacCapabilityProbeEvent> | null {
  const record = snapshotRecord(value);
  if (
    !record ||
    record.protocolVersion !== AAC_CAPABILITY_PROBE_PROTOCOL_VERSION ||
    record.probeGeneration !== AAC_CAPABILITY_PROBE_GENERATION
  ) {
    return null;
  }
  if (
    record.type === 'probe-ready' &&
    hasExactKeys(record, ['protocolVersion', 'type', 'probeGeneration'])
  ) {
    return Object.freeze({
      protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
      type: 'probe-ready' as const,
      probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
    });
  }
  if (
    record.type === 'probe-error' &&
    hasExactKeys(record, ['protocolVersion', 'type', 'probeGeneration', 'code', 'message']) &&
    isErrorCode(record.code) &&
    typeof record.message === 'string' &&
    record.message.length > 0 &&
    record.message.length <= AAC_CAPABILITY_PROBE_MAX_ERROR_MESSAGE_LENGTH
  ) {
    return Object.freeze({
      protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
      type: 'probe-error' as const,
      probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
      code: record.code,
      message: record.message,
    });
  }
  return null;
}
