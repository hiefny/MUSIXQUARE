import { expectedLanczosOutputFrames } from '../streaming/resampler-plan.ts';
import {
  M4A_AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  snapshotM4aAacDecoderDescriptor,
  type M4aAacDecoderDescriptor,
  type M4aAacDecoderLogicalProgress,
} from './decoder-protocol.ts';
import { validateM4aAacLcManifest, type M4aAacLcManifest } from './metadata.ts';
import {
  M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
  createM4aAacStartPlan,
} from './start-plan.ts';

const CREATE_DESCRIPTOR_KEYS = Object.freeze([
  'manifest',
  'outputSampleRateHz',
  'mediaFrame',
] as const);

type DataRecord = Readonly<Record<string, unknown>>;

export interface CreateM4aAacDecoderDescriptorOptions {
  readonly manifest: Readonly<M4aAacLcManifest>;
  readonly outputSampleRateHz: number;
  /** Exact audible media coordinate. Exclusive EOF cannot open a generation. */
  readonly mediaFrame: number;
}

function snapshotRecord(value: unknown): DataRecord | null {
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

function snapshotOptions(value: unknown): Readonly<{
  manifest: unknown;
  outputSampleRateHz: number;
  mediaFrame: number;
}> {
  const record = snapshotRecord(value);
  if (
    !record ||
    Object.keys(record).length !== CREATE_DESCRIPTOR_KEYS.length ||
    !CREATE_DESCRIPTOR_KEYS.every((key) => Object.hasOwn(record, key))
  ) {
    throw new TypeError('M4A AAC decoder options must be a canonical exact-key record');
  }
  requireSafeInteger(
    record.outputSampleRateHz,
    'M4A AAC outputSampleRateHz',
    1,
    M4A_AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  );
  requireSafeInteger(record.mediaFrame, 'M4A AAC target mediaFrame', 0);
  return Object.freeze({
    manifest: record.manifest,
    outputSampleRateHz: record.outputSampleRateHz,
    mediaFrame: record.mediaFrame,
  });
}

/** Create one detached, deeply canonical descriptor for a fresh decoder Worker. */
export function createM4aAacDecoderDescriptor(
  optionsValue: CreateM4aAacDecoderDescriptorOptions,
): Readonly<M4aAacDecoderDescriptor> {
  const options = snapshotOptions(optionsValue);
  const manifest = validateM4aAacLcManifest(options.manifest);
  const startPlan = createM4aAacStartPlan(manifest.timeline, options.mediaFrame);
  expectedLanczosOutputFrames({
    inputSampleRate: manifest.codec.sampleRateHz,
    outputSampleRate: options.outputSampleRateHz,
    totalSourceFrames: manifest.timeline.totalMediaFrames,
    startSourceFrame: startPlan.mediaFrame,
  });
  return Object.freeze({
    format: 'm4a-aac-lc',
    sourceSize: manifest.sourceSize,
    sourceIdentity: manifest.sourceIdentity,
    manifest,
    outputSampleRateHz: options.outputSampleRateHz,
    transformPrerollPolicyAccessUnits: M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
    startPlan,
  });
}

function requireDescriptor(value: unknown): Readonly<M4aAacDecoderDescriptor> {
  const descriptor = snapshotM4aAacDecoderDescriptor(value);
  if (!descriptor) throw new TypeError('A valid M4A AAC decoder descriptor is required');
  return descriptor;
}

/** Exact audible core-rate frames accepted after the generation seek target. */
export function remainingM4aAacMediaFrames(descriptorValue: M4aAacDecoderDescriptor): number {
  const descriptor = requireDescriptor(descriptorValue);
  return descriptor.manifest.timeline.totalMediaFrames - descriptor.startPlan.mediaFrame;
}

/** Exact pinned-Lanczos output length after leading discard and audible clipping. */
export function expectedM4aAacOutputFrames(descriptorValue: M4aAacDecoderDescriptor): number {
  const descriptor = requireDescriptor(descriptorValue);
  if (descriptor.manifest.codec.sampleRateHz === descriptor.outputSampleRateHz) {
    return descriptor.manifest.timeline.totalMediaFrames - descriptor.startPlan.mediaFrame;
  }
  return expectedLanczosOutputFrames({
    inputSampleRate: descriptor.manifest.codec.sampleRateHz,
    outputSampleRate: descriptor.outputSampleRateHz,
    totalSourceFrames: descriptor.manifest.timeline.totalMediaFrames,
    startSourceFrame: descriptor.startPlan.mediaFrame,
  });
}

/**
 * Exact logical EOF contract for one generation. AU/byte/raw cursors are
 * absolute admitted-source coordinates; media/output counters are generation-local.
 */
export function expectedM4aAacDecoderEofProgress(
  descriptorValue: M4aAacDecoderDescriptor,
): Readonly<M4aAacDecoderLogicalProgress> {
  const descriptor = requireDescriptor(descriptorValue);
  return Object.freeze({
    nextAccessUnitOrdinal: descriptor.manifest.timeline.accessUnitCount,
    consumedEncodedBytes: descriptor.manifest.sampleSizes.totalEncodedBytes,
    decodedRawCoreFrames: descriptor.manifest.timeline.rawCoreFrames,
    acceptedMediaFrames:
      descriptor.manifest.timeline.totalMediaFrames - descriptor.startPlan.mediaFrame,
    producedOutputFrames: expectedM4aAacOutputFrames(descriptor),
  });
}
