import {
  PCM_STREAM_PROTOCOL_VERSION,
  isPcmStreamGeneration,
  type PcmStreamGeneration,
  type PcmSupplyMessage,
} from '../streaming/pcm-stream-protocol.ts';
import { expectedLanczosOutputFrames } from '../streaming/resampler-plan.ts';
import { validateM4aAacLcManifest, type M4aAacLcManifest } from './metadata.ts';
import { M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT } from './timeline.ts';

/** Worker-control version; PCM supply keeps its independent common version. */
export const M4A_AAC_DECODER_PROTOCOL_VERSION = 1 as const;
export const M4A_AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ = 1_000_000;
export const M4A_AAC_DECODER_MAX_ERROR_CODE_LENGTH = 256;
export const M4A_AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH = 1_024;
export const M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS = 1 as const;

export type M4aAacSourceLifetimeGeneration = number;
/** One fresh Worker realm and one decoder incarnation. */
export type M4aAacDecoderGeneration = PcmStreamGeneration;
export type M4aAacDecoderBackendId = 'webcodecs' | 'symphonia-wasm';

/** Structured-clone generation target, expressed only in logical AAC coordinates. */
export interface M4aAacDecoderStartPlan {
  readonly mediaFrame: number;
  /** Raw decoder coordinate after applying the admitted manifest leading trim. */
  readonly rawTargetCoreFrame: number;
  readonly targetAccessUnitOrdinal: number;
  readonly coreFrameWithinTargetAccessUnit: number;
  readonly decodeStartAccessUnitOrdinal: number;
  /** May be zero only when the target is already in access unit zero. */
  readonly actualPrerollAccessUnits: 0 | 1;
  /** Raw decoder frames to discard before publishing the selected media frame. */
  readonly discardCoreFrames: number;
}

/**
 * Complete same-app Worker handoff. The manifest is structurally canonical but
 * its table evidence is rebound to the encoded source later by the Worker runtime.
 */
export interface M4aAacDecoderDescriptor {
  readonly format: 'm4a-aac-lc';
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly manifest: Readonly<M4aAacLcManifest>;
  readonly outputSampleRateHz: number;
  readonly transformPrerollPolicyAccessUnits: 1;
  readonly startPlan: Readonly<M4aAacDecoderStartPlan>;
}

export const M4A_AAC_DECODER_START_PLAN_KEYS = Object.freeze([
  'mediaFrame',
  'rawTargetCoreFrame',
  'targetAccessUnitOrdinal',
  'coreFrameWithinTargetAccessUnit',
  'decodeStartAccessUnitOrdinal',
  'actualPrerollAccessUnits',
  'discardCoreFrames',
] as const satisfies readonly (keyof M4aAacDecoderStartPlan)[]);

export const M4A_AAC_DECODER_DESCRIPTOR_KEYS = Object.freeze([
  'format',
  'sourceSize',
  'sourceIdentity',
  'manifest',
  'outputSampleRateHz',
  'transformPrerollPolicyAccessUnits',
  'startPlan',
] as const satisfies readonly (keyof M4aAacDecoderDescriptor)[]);

export interface M4aAacDecoderOpenCommand {
  readonly protocolVersion: typeof M4A_AAC_DECODER_PROTOCOL_VERSION;
  readonly type: 'open-decoder';
  readonly sourceLifetimeGeneration: M4aAacSourceLifetimeGeneration;
  readonly decoderGeneration: M4aAacDecoderGeneration;
  /** Exact cohort choice; the Worker must fail instead of silently substituting. */
  readonly backendId: M4aAacDecoderBackendId;
  readonly descriptor: Readonly<M4aAacDecoderDescriptor>;
  readonly sourcePort: MessagePort;
  readonly pcmPort: MessagePort;
}

export interface M4aAacDecoderStopCommand {
  readonly protocolVersion: typeof M4A_AAC_DECODER_PROTOCOL_VERSION;
  readonly type: 'stop-decoder';
  readonly sourceLifetimeGeneration: M4aAacSourceLifetimeGeneration;
  readonly decoderGeneration: M4aAacDecoderGeneration;
}

export type M4aAacDecoderCommand = M4aAacDecoderOpenCommand | M4aAacDecoderStopCommand;

interface M4aAacDecoderEventIdentity {
  readonly protocolVersion: typeof M4A_AAC_DECODER_PROTOCOL_VERSION;
  readonly sourceLifetimeGeneration: M4aAacSourceLifetimeGeneration;
  readonly decoderGeneration: M4aAacDecoderGeneration;
}

/** Absolute logical cursors; physical file/chunk offsets never cross this boundary. */
export interface M4aAacDecoderLogicalProgress {
  readonly nextAccessUnitOrdinal: number;
  readonly consumedEncodedBytes: number;
  readonly decodedRawCoreFrames: number;
  readonly acceptedMediaFrames: number;
  readonly producedOutputFrames: number;
}

export const M4A_AAC_DECODER_LOGICAL_PROGRESS_KEYS = Object.freeze([
  'nextAccessUnitOrdinal',
  'consumedEncodedBytes',
  'decodedRawCoreFrames',
  'acceptedMediaFrames',
  'producedOutputFrames',
] as const satisfies readonly (keyof M4aAacDecoderLogicalProgress)[]);

export type M4aAacDecoderEvent =
  | (M4aAacDecoderEventIdentity & {
      readonly type: 'decoder-ready';
      /** Exact echo; the adapter compares it with the command descriptor. */
      readonly descriptor: Readonly<M4aAacDecoderDescriptor>;
      readonly backendId: M4aAacDecoderBackendId;
    })
  | (M4aAacDecoderEventIdentity &
      M4aAacDecoderLogicalProgress & {
        readonly type: 'decode-progress' | 'decoder-eof';
      })
  | (M4aAacDecoderEventIdentity & {
      readonly type: 'decoder-stopped';
    })
  | (M4aAacDecoderEventIdentity & {
      readonly type: 'decoder-error';
      readonly code: string;
      readonly message: string;
    });

export type { PcmSupplyMessage };
export { PCM_STREAM_PROTOCOL_VERSION };

type WorkerRecord = Readonly<Record<string, unknown>>;

/** Snapshot one exact, own-enumerable, data-only structured-clone record. */
function snapshotWorkerRecord(value: unknown): WorkerRecord | null {
  if (typeof value !== 'object' || value === null) return null;

  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Reflect.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== null && prototype !== Object.prototype) return null;

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || Object.hasOwn(snapshot, key)) return null;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function hasExactKeys(record: WorkerRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function requireCanonicalRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): WorkerRecord {
  const record = snapshotWorkerRecord(value);
  if (!record || !hasExactKeys(record, keys)) {
    throw new TypeError(`${label} must be a canonical exact-key record`);
  }
  return record;
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = BigInt(left) + BigInt(right);
  if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(result);
}

function createStartPlanFromManifest(
  manifest: Readonly<M4aAacLcManifest>,
  mediaFrame: number,
): Readonly<M4aAacDecoderStartPlan> {
  requireSafeInteger(mediaFrame, 'M4A AAC target mediaFrame', 0);
  if (mediaFrame === manifest.timeline.totalMediaFrames) {
    throw new RangeError('M4A AAC exclusive media EOF cannot open a decoder Worker');
  }
  if (mediaFrame > manifest.timeline.totalMediaFrames) {
    throw new RangeError('M4A AAC target mediaFrame is outside the admitted timeline');
  }

  const rawTargetCoreFrame = safeAdd(
    manifest.timeline.headTrimCoreFrames,
    mediaFrame,
    'M4A AAC raw target core frame',
  );
  const targetAccessUnitOrdinal = Math.floor(
    rawTargetCoreFrame / M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
  );
  if (targetAccessUnitOrdinal >= manifest.timeline.accessUnitCount) {
    throw new RangeError('M4A AAC target access unit exceeds the admitted timeline');
  }
  const coreFrameWithinTargetAccessUnit = rawTargetCoreFrame % M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT;
  const decodeStartAccessUnitOrdinal = Math.max(
    targetAccessUnitOrdinal - M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
    0,
  );
  const actualPrerollAccessUnits = targetAccessUnitOrdinal - decodeStartAccessUnitOrdinal;
  const discardCoreFrames =
    rawTargetCoreFrame - decodeStartAccessUnitOrdinal * M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT;

  return Object.freeze({
    mediaFrame,
    rawTargetCoreFrame,
    targetAccessUnitOrdinal,
    coreFrameWithinTargetAccessUnit,
    decodeStartAccessUnitOrdinal,
    actualPrerollAccessUnits: actualPrerollAccessUnits as 0 | 1,
    discardCoreFrames,
  });
}

/** Build the fixed one-AU product-preroll plan from a canonicalized manifest. */
export function createM4aAacDecoderStartPlan(
  manifestValue: unknown,
  mediaFrame: number,
): Readonly<M4aAacDecoderStartPlan> {
  const manifest = validateM4aAacLcManifest(manifestValue);
  return createStartPlanFromManifest(manifest, mediaFrame);
}

function requireStartPlan(value: unknown): Readonly<M4aAacDecoderStartPlan> {
  const record = requireCanonicalRecord(
    value,
    M4A_AAC_DECODER_START_PLAN_KEYS,
    'M4A AAC decoder start plan',
  );
  for (const key of M4A_AAC_DECODER_START_PLAN_KEYS) {
    requireSafeInteger(record[key], `M4A AAC startPlan ${key}`, 0);
  }
  if (record.actualPrerollAccessUnits !== 0 && record.actualPrerollAccessUnits !== 1) {
    throw new RangeError('M4A AAC actual transform preroll must be zero or one access unit');
  }
  return Object.freeze({ ...record }) as unknown as Readonly<M4aAacDecoderStartPlan>;
}

function sameStartPlan(
  left: Readonly<M4aAacDecoderStartPlan>,
  right: Readonly<M4aAacDecoderStartPlan>,
): boolean {
  return M4A_AAC_DECODER_START_PLAN_KEYS.every((key) => left[key] === right[key]);
}

function requireDescriptor(value: unknown): Readonly<M4aAacDecoderDescriptor> {
  const record = requireCanonicalRecord(
    value,
    M4A_AAC_DECODER_DESCRIPTOR_KEYS,
    'M4A AAC decoder descriptor',
  );
  if (record.format !== 'm4a-aac-lc') {
    throw new TypeError('M4A AAC decoder descriptor format is invalid');
  }
  const manifest = validateM4aAacLcManifest(record.manifest);
  requireSafeInteger(record.sourceSize, 'M4A AAC descriptor sourceSize', 1);
  if (
    record.sourceSize !== manifest.sourceSize ||
    record.sourceIdentity !== manifest.sourceIdentity
  ) {
    throw new RangeError('M4A AAC descriptor source binding contradicts its manifest');
  }
  requireSafeInteger(
    record.outputSampleRateHz,
    'M4A AAC descriptor outputSampleRateHz',
    1,
    M4A_AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  );
  if (record.transformPrerollPolicyAccessUnits !== M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS) {
    throw new RangeError('M4A AAC decoder transform preroll policy must be exactly one AU');
  }

  const startPlan = requireStartPlan(record.startPlan);
  const recomputedPlan = createStartPlanFromManifest(manifest, startPlan.mediaFrame);
  if (!sameStartPlan(startPlan, recomputedPlan)) {
    throw new RangeError('M4A AAC decoder start plan contradicts its canonical manifest');
  }

  expectedLanczosOutputFrames({
    inputSampleRate: manifest.codec.sampleRateHz,
    outputSampleRate: record.outputSampleRateHz,
    totalSourceFrames: manifest.timeline.totalMediaFrames,
    startSourceFrame: startPlan.mediaFrame,
  });

  return Object.freeze({
    format: 'm4a-aac-lc',
    sourceSize: manifest.sourceSize,
    sourceIdentity: manifest.sourceIdentity,
    manifest,
    outputSampleRateHz: record.outputSampleRateHz,
    transformPrerollPolicyAccessUnits: M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
    startPlan: recomputedPlan,
  });
}

/** Strict Worker-bound validation, including exact nested key sets. */
export function validateM4aAacDecoderDescriptor(
  value: unknown,
): asserts value is M4aAacDecoderDescriptor {
  requireDescriptor(value);
}

/** Snapshot an untrusted descriptor so later mutation cannot cross the boundary. */
export function snapshotM4aAacDecoderDescriptor(
  value: unknown,
): Readonly<M4aAacDecoderDescriptor> | null {
  try {
    return requireDescriptor(value);
  } catch {
    return null;
  }
}

export function isM4aAacSourceLifetimeGeneration(
  value: unknown,
): value is M4aAacSourceLifetimeGeneration {
  return isPcmStreamGeneration(value);
}

export function isM4aAacDecoderGeneration(value: unknown): value is M4aAacDecoderGeneration {
  return isPcmStreamGeneration(value);
}

function isMessagePort(value: unknown): value is MessagePort {
  return typeof MessagePort !== 'undefined' && value instanceof MessagePort;
}

function hasGenerationPair(record: WorkerRecord): record is WorkerRecord & {
  readonly sourceLifetimeGeneration: M4aAacSourceLifetimeGeneration;
  readonly decoderGeneration: M4aAacDecoderGeneration;
} {
  return (
    isM4aAacSourceLifetimeGeneration(record.sourceLifetimeGeneration) &&
    isM4aAacDecoderGeneration(record.decoderGeneration)
  );
}

function isBackendId(value: unknown): value is M4aAacDecoderBackendId {
  return value === 'webcodecs' || value === 'symphonia-wasm';
}

export function parseM4aAacDecoderCommand(value: unknown): Readonly<M4aAacDecoderCommand> | null {
  const record = snapshotWorkerRecord(value);
  if (
    !record ||
    record.protocolVersion !== M4A_AAC_DECODER_PROTOCOL_VERSION ||
    typeof record.type !== 'string' ||
    !hasGenerationPair(record)
  ) {
    return null;
  }
  if (record.type === 'open-decoder') {
    if (
      !hasExactKeys(record, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'decoderGeneration',
        'backendId',
        'descriptor',
        'sourcePort',
        'pcmPort',
      ]) ||
      !isBackendId(record.backendId) ||
      !isMessagePort(record.sourcePort) ||
      !isMessagePort(record.pcmPort) ||
      record.sourcePort === record.pcmPort
    ) {
      return null;
    }
    const descriptor = snapshotM4aAacDecoderDescriptor(record.descriptor);
    if (!descriptor) return null;
    return Object.freeze({
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: 'open-decoder',
      sourceLifetimeGeneration: record.sourceLifetimeGeneration,
      decoderGeneration: record.decoderGeneration,
      backendId: record.backendId,
      descriptor,
      sourcePort: record.sourcePort,
      pcmPort: record.pcmPort,
    });
  }
  if (record.type === 'stop-decoder') {
    if (
      !hasExactKeys(record, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'decoderGeneration',
      ])
    ) {
      return null;
    }
    return Object.freeze({
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: record.sourceLifetimeGeneration,
      decoderGeneration: record.decoderGeneration,
    });
  }
  return null;
}

/** Exact transfer list for the atomic fresh-realm handoff. */
export function m4aAacDecoderCommandTransferables(
  command: Readonly<M4aAacDecoderCommand>,
): Transferable[] {
  return command.type === 'open-decoder' ? [command.sourcePort, command.pcmPort] : [];
}

const EVENT_IDENTITY_KEYS = Object.freeze([
  'protocolVersion',
  'type',
  'sourceLifetimeGeneration',
  'decoderGeneration',
] as const);

function hasEventIdentity(record: WorkerRecord): record is WorkerRecord & {
  readonly sourceLifetimeGeneration: M4aAacSourceLifetimeGeneration;
  readonly decoderGeneration: M4aAacDecoderGeneration;
} {
  return record.protocolVersion === M4A_AAC_DECODER_PROTOCOL_VERSION && hasGenerationPair(record);
}

function validCounter(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0
  );
}

/**
 * Strict structural parser for fresh-Worker control events. The adapter later
 * enforces generation-relative monotonic bounds and exact descriptor EOF.
 */
export function parseM4aAacDecoderEvent(value: unknown): Readonly<M4aAacDecoderEvent> | null {
  const record = snapshotWorkerRecord(value);
  if (!record || typeof record.type !== 'string' || !hasEventIdentity(record)) return null;

  if (record.type === 'decoder-ready') {
    if (
      !hasExactKeys(record, [...EVENT_IDENTITY_KEYS, 'descriptor', 'backendId']) ||
      !isBackendId(record.backendId)
    ) {
      return null;
    }
    const descriptor = snapshotM4aAacDecoderDescriptor(record.descriptor);
    return descriptor
      ? Object.freeze({
          protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
          type: 'decoder-ready',
          sourceLifetimeGeneration: record.sourceLifetimeGeneration,
          decoderGeneration: record.decoderGeneration,
          descriptor,
          backendId: record.backendId,
        })
      : null;
  }
  if (record.type === 'decode-progress' || record.type === 'decoder-eof') {
    if (
      !hasExactKeys(record, [...EVENT_IDENTITY_KEYS, ...M4A_AAC_DECODER_LOGICAL_PROGRESS_KEYS]) ||
      !M4A_AAC_DECODER_LOGICAL_PROGRESS_KEYS.every((key) => validCounter(record[key]))
    ) {
      return null;
    }
    return Object.freeze({
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: record.type,
      sourceLifetimeGeneration: record.sourceLifetimeGeneration,
      decoderGeneration: record.decoderGeneration,
      nextAccessUnitOrdinal: record.nextAccessUnitOrdinal as number,
      consumedEncodedBytes: record.consumedEncodedBytes as number,
      decodedRawCoreFrames: record.decodedRawCoreFrames as number,
      acceptedMediaFrames: record.acceptedMediaFrames as number,
      producedOutputFrames: record.producedOutputFrames as number,
    });
  }
  if (record.type === 'decoder-stopped') {
    return hasExactKeys(record, EVENT_IDENTITY_KEYS)
      ? Object.freeze({
          protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
          type: 'decoder-stopped',
          sourceLifetimeGeneration: record.sourceLifetimeGeneration,
          decoderGeneration: record.decoderGeneration,
        })
      : null;
  }
  if (record.type === 'decoder-error') {
    if (
      !hasExactKeys(record, [...EVENT_IDENTITY_KEYS, 'code', 'message']) ||
      typeof record.code !== 'string' ||
      record.code.length === 0 ||
      record.code.length > M4A_AAC_DECODER_MAX_ERROR_CODE_LENGTH ||
      typeof record.message !== 'string' ||
      record.message.length === 0 ||
      record.message.length > M4A_AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH
    ) {
      return null;
    }
    return Object.freeze({
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: 'decoder-error',
      sourceLifetimeGeneration: record.sourceLifetimeGeneration,
      decoderGeneration: record.decoderGeneration,
      code: record.code,
      message: record.message,
    });
  }
  return null;
}

function sameCanonicalCloneValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (
    leftKeys.length !== rightKeys.length ||
    !leftKeys.every((key, index) => key === rightKeys[index])
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  return leftKeys.every((key) => sameCanonicalCloneValue(leftRecord[key], rightRecord[key]));
}

/** Exact ready-echo equality after independently canonicalizing both descriptors. */
export function sameM4aAacDecoderDescriptor(left: unknown, right: unknown): boolean {
  const first = snapshotM4aAacDecoderDescriptor(left);
  const second = snapshotM4aAacDecoderDescriptor(right);
  return first !== null && second !== null && sameCanonicalCloneValue(first, second);
}
