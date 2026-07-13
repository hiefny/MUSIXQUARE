import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import { EncodedSourceIntegrityError, throwIfAborted } from '../sources/encoded-audio-source.ts';
import { rehydrateM4aChunkIndex, type M4aChunkIndex } from './chunk-index.ts';
import { validateM4aAacLcManifest, type M4aAacLcManifest } from './metadata.ts';
import {
  rehydrateM4aSampleSizeIndex,
  type M4aIndexSourceBinding,
  type M4aSampleSizeIndex,
} from './sample-size-index.ts';
import { M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT, type M4aAacTimeline } from './timeline.ts';

export const M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS = 1 as const;

export interface M4aAacRuntimeInfo {
  readonly format: 'm4a-aac-lc';
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly codec: 'mp4a.40.2';
  readonly sampleRateHz: number;
  readonly channelCount: 1 | 2;
  readonly audioSpecificConfig: readonly number[];
  readonly accessUnitCount: number;
  readonly totalEncodedBytes: number;
  readonly timeline: Readonly<M4aAacTimeline>;
  /** Source metadata evidence only; it never weakens the product decoder policy. */
  readonly sourceRequiredPrerollAccessUnits: 1 | null;
  /** Product transform policy, independently fixed even when source evidence is absent. */
  readonly transformPrerollPolicyAccessUnits: 1;
}

export interface M4aAacGenerationStartPlan {
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

export interface M4aAacRuntime {
  readonly info: Readonly<M4aAacRuntimeInfo>;
  createGenerationStartPlan(mediaFrame: number): Readonly<M4aAacGenerationStartPlan>;
  /** Accept only an unchanged plan issued by this exact live runtime. */
  requireGenerationStartPlan(value: unknown): Readonly<M4aAacGenerationStartPlan>;
  /** Release runtime authority without closing the caller-owned encoded source. */
  close(): void;
}

interface RuntimeAuthority {
  readonly reader: IsoBmffBoxReader;
  readonly sampleSizes: Readonly<M4aSampleSizeIndex>;
  readonly chunks: Readonly<M4aChunkIndex>;
  readonly manifest: Readonly<M4aAacLcManifest>;
  readonly info: Readonly<M4aAacRuntimeInfo>;
  closed: boolean;
}

interface StartPlanAuthority {
  readonly runtime: M4aAacRuntime;
  readonly plan: Readonly<M4aAacGenerationStartPlan>;
}

const runtimeAuthorities = new WeakMap<object, RuntimeAuthority>();
const startPlanAuthorities = new WeakMap<object, StartPlanAuthority>();

export class M4aAacRuntimeError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aAacRuntimeError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

export class M4aAacRuntimeClosedError extends Error {
  constructor() {
    super('M4A AAC runtime is closed');
    this.name = 'M4aAacRuntimeClosedError';
  }
}

function runtimeError(message: string, cause?: unknown): M4aAacRuntimeError {
  return new M4aAacRuntimeError(message, cause);
}

function requireRuntimeAuthority(value: unknown, allowClosed = false): RuntimeAuthority {
  const authority =
    value !== null && (typeof value === 'object' || typeof value === 'function')
      ? runtimeAuthorities.get(value)
      : undefined;
  if (authority === undefined) {
    throw new TypeError('M4A AAC runtime lacks module provenance');
  }
  if (authority.closed && !allowClosed) throw new M4aAacRuntimeClosedError();
  return authority;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw runtimeError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function createRuntimeInfo(manifest: Readonly<M4aAacLcManifest>): Readonly<M4aAacRuntimeInfo> {
  return Object.freeze({
    format: 'm4a-aac-lc',
    sourceSize: manifest.sourceSize,
    sourceIdentity: manifest.sourceIdentity,
    codec: 'mp4a.40.2',
    sampleRateHz: manifest.codec.sampleRateHz,
    channelCount: manifest.codec.channelCount,
    audioSpecificConfig: Object.freeze([...manifest.codec.audioSpecificConfig]),
    accessUnitCount: manifest.timeline.accessUnitCount,
    totalEncodedBytes: manifest.sampleSizes.totalEncodedBytes,
    timeline: manifest.timeline,
    sourceRequiredPrerollAccessUnits: manifest.rollRecovery?.requiredPrerollAccessUnits ?? null,
    transformPrerollPolicyAccessUnits: M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
  });
}

function assertFinalRuntimeGeometry(
  manifest: Readonly<M4aAacLcManifest>,
  sampleSizes: Readonly<M4aSampleSizeIndex>,
  chunks: Readonly<M4aChunkIndex>,
): void {
  if (
    sampleSizes.sampleCount !== manifest.timeline.accessUnitCount ||
    chunks.sampleCount !== manifest.timeline.accessUnitCount ||
    sampleSizes.sampleCount !== chunks.sampleCount
  ) {
    throw runtimeError('M4A runtime indexes contradict the manifest access-unit count');
  }
  if (sampleSizes.totalEncodedBytes !== manifest.sampleSizes.totalEncodedBytes) {
    throw runtimeError('M4A runtime sample bytes contradict the admitted manifest');
  }
  if (
    manifest.timeline.coreFramesPerAccessUnit !== M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT ||
    manifest.timeline.sampleRateHz !== manifest.codec.sampleRateHz
  ) {
    throw runtimeError('M4A runtime codec and timeline geometry are inconsistent');
  }
}

/**
 * Atomically reopen one transferable M4A manifest against its exact reader.
 *
 * The reader and its encoded source remain caller-owned. Runtime authority is
 * issued only after both table indexes and their source evidence have reopened.
 * This is deliberately a same-app manifest boundary: codec, timeline,
 * container diagnostics, and declared `mdat` ranges are strictly canonicalized
 * but are not reparsed here. `stsz`, `stsc`, and chunk-table evidence are rebound
 * to the source now; their remaining authenticated pages are consumed lazily by
 * the future cursor. An external/untrusted manifest needs separate authentication.
 */
export async function openM4aAacRuntime(
  reader: IsoBmffBoxReader,
  manifestValue: unknown,
  signal: AbortSignal,
): Promise<M4aAacRuntime> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A AAC runtime requires an AbortSignal');
  }
  throwIfAborted(signal);
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A AAC runtime requires an IsoBmffBoxReader');
  }

  const manifest = validateM4aAacLcManifest(manifestValue);
  const expectedSource: Readonly<M4aIndexSourceBinding> = Object.freeze({
    sourceSize: manifest.sourceSize,
    sourceIdentity: manifest.sourceIdentity,
  });
  if (
    reader.sourceSize !== expectedSource.sourceSize ||
    reader.sourceIdentity !== expectedSource.sourceIdentity
  ) {
    throw runtimeError('M4A AAC manifest source binding does not match its runtime reader');
  }
  reader.assertReadable(signal);

  const sampleSizes = await rehydrateM4aSampleSizeIndex(
    reader,
    manifest.sampleSizes,
    expectedSource,
    signal,
  );
  const chunks = await rehydrateM4aChunkIndex(
    reader,
    manifest.chunks,
    sampleSizes,
    expectedSource,
    signal,
  );
  assertFinalRuntimeGeometry(manifest, sampleSizes, chunks);
  reader.assertReadable(signal);

  const info = createRuntimeInfo(manifest);
  const runtime: M4aAacRuntime = Object.freeze({
    info,
    createGenerationStartPlan(this: M4aAacRuntime, mediaFrame: number) {
      return createM4aAacGenerationStartPlan(this, mediaFrame);
    },
    requireGenerationStartPlan(this: M4aAacRuntime, value: unknown) {
      return requireM4aAacGenerationStartPlan(this, value);
    },
    close(this: M4aAacRuntime) {
      closeM4aAacRuntime(this);
    },
  });
  runtimeAuthorities.set(runtime, {
    reader,
    sampleSizes,
    chunks,
    manifest,
    info,
    closed: false,
  });
  return runtime;
}

/** Build the exact one-AU product-preroll plan for a live issued runtime. */
export function createM4aAacGenerationStartPlan(
  runtimeValue: unknown,
  mediaFrameValue: unknown,
): Readonly<M4aAacGenerationStartPlan> {
  const authority = requireRuntimeAuthority(runtimeValue);
  const mediaFrame = requireNonNegativeSafeInteger(mediaFrameValue, 'M4A mediaFrame');
  const timeline = authority.info.timeline;
  if (mediaFrame === timeline.totalMediaFrames) {
    throw new RangeError('M4A exclusive media EOF cannot start a decode generation');
  }
  if (mediaFrame > timeline.totalMediaFrames) {
    throw new RangeError('M4A mediaFrame is outside the audible timeline');
  }

  const rawTargetCoreFrame = safeAdd(
    timeline.headTrimCoreFrames,
    mediaFrame,
    'M4A raw target core frame',
  );
  const targetAccessUnitOrdinal = Math.floor(
    rawTargetCoreFrame / M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
  );
  if (targetAccessUnitOrdinal >= authority.info.accessUnitCount) {
    throw runtimeError('M4A target access unit exceeds the authenticated timeline');
  }
  const coreFrameWithinTargetAccessUnit = rawTargetCoreFrame % M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT;
  const decodeStartAccessUnitOrdinal = Math.max(
    targetAccessUnitOrdinal - authority.info.transformPrerollPolicyAccessUnits,
    0,
  );
  const actualPrerollAccessUnits = targetAccessUnitOrdinal - decodeStartAccessUnitOrdinal;
  const discardCoreFrames =
    rawTargetCoreFrame - decodeStartAccessUnitOrdinal * M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT;
  const plan: Readonly<M4aAacGenerationStartPlan> = Object.freeze({
    mediaFrame,
    rawTargetCoreFrame,
    targetAccessUnitOrdinal,
    coreFrameWithinTargetAccessUnit,
    decodeStartAccessUnitOrdinal,
    actualPrerollAccessUnits: actualPrerollAccessUnits as 0 | 1,
    discardCoreFrames,
  });
  startPlanAuthorities.set(plan, {
    runtime: runtimeValue as M4aAacRuntime,
    plan,
  });
  return plan;
}

/** Reject clones, forged records, foreign-runtime plans, and plans from closed runtimes. */
export function requireM4aAacGenerationStartPlan(
  runtimeValue: unknown,
  planValue: unknown,
): Readonly<M4aAacGenerationStartPlan> {
  requireRuntimeAuthority(runtimeValue);
  const authority =
    planValue !== null && (typeof planValue === 'object' || typeof planValue === 'function')
      ? startPlanAuthorities.get(planValue)
      : undefined;
  if (authority === undefined) {
    throw new TypeError('M4A AAC generation start plan was not issued by this module');
  }
  if (authority.runtime !== runtimeValue) {
    throw new TypeError('M4A AAC generation start plan belongs to a different runtime');
  }
  return authority.plan;
}

/** Idempotently revoke one issued runtime without touching its borrowed source. */
export function closeM4aAacRuntime(runtimeValue: unknown): void {
  const authority = requireRuntimeAuthority(runtimeValue, true);
  if (authority.closed) return;
  authority.closed = true;
}
