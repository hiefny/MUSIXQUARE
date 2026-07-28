import { M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT, type M4aAacTimeline } from './timeline.ts';

/** Product transform policy, independent of optional container roll metadata. */
export const M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS = 1 as const;

/** The exact canonical timeline geometry needed to start one decode generation. */
export type M4aAacStartPlanTimelineGeometry = Readonly<
  Pick<
    M4aAacTimeline,
    'accessUnitCount' | 'coreFramesPerAccessUnit' | 'headTrimCoreFrames' | 'totalMediaFrames'
  >
>;

/** Logical AAC coordinates shared by the source runtime and decoder Worker wire contract. */
export interface M4aAacStartPlan {
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

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value <= 0
  ) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
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
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(result);
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = BigInt(left) * BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(result);
}

/**
 * Build the exact fixed-preroll plan from already-canonical timeline geometry.
 *
 * Callers remain responsible for canonicalizing their own trust boundary. This
 * pure calculation still checks every consumed scalar and all derived arithmetic
 * so an accidental noncanonical call cannot silently round a decoder coordinate.
 */
export function createM4aAacStartPlan(
  timeline: M4aAacStartPlanTimelineGeometry,
  mediaFrameValue: unknown,
): Readonly<M4aAacStartPlan> {
  const accessUnitCount = requirePositiveSafeInteger(
    timeline.accessUnitCount,
    'M4A AAC access-unit count',
  );
  if (timeline.coreFramesPerAccessUnit !== M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT) {
    throw new RangeError('M4A AAC core frames per access unit must be exactly 1,024');
  }
  const headTrimCoreFrames = requireNonNegativeSafeInteger(
    timeline.headTrimCoreFrames,
    'M4A AAC head trim',
  );
  const totalMediaFrames = requirePositiveSafeInteger(
    timeline.totalMediaFrames,
    'M4A AAC total media frames',
  );
  const rawCoreFrameCapacity = safeMultiply(
    accessUnitCount,
    M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    'M4A AAC raw core-frame capacity',
  );
  const audibleEndCoreFrame = safeAdd(
    headTrimCoreFrames,
    totalMediaFrames,
    'M4A AAC audible timeline end',
  );
  if (audibleEndCoreFrame > rawCoreFrameCapacity) {
    throw new RangeError('M4A AAC audible timeline exceeds its access-unit capacity');
  }
  const mediaFrame = requireNonNegativeSafeInteger(mediaFrameValue, 'M4A AAC target mediaFrame');
  if (mediaFrame === totalMediaFrames) {
    throw new RangeError('M4A AAC exclusive media EOF cannot start a decode generation');
  }
  if (mediaFrame > totalMediaFrames) {
    throw new RangeError('M4A AAC target mediaFrame is outside the admitted timeline');
  }

  const rawTargetCoreFrame = safeAdd(
    headTrimCoreFrames,
    mediaFrame,
    'M4A AAC raw target core frame',
  );
  const targetAccessUnitOrdinal = Math.floor(
    rawTargetCoreFrame / M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
  );
  if (targetAccessUnitOrdinal >= accessUnitCount) {
    throw new RangeError('M4A AAC target access unit exceeds the admitted timeline');
  }
  const coreFrameWithinTargetAccessUnit = rawTargetCoreFrame % M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT;
  const decodeStartAccessUnitOrdinal = Math.max(
    targetAccessUnitOrdinal - M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
    0,
  );
  const actualPrerollAccessUnits = targetAccessUnitOrdinal - decodeStartAccessUnitOrdinal;
  const discardCoreFrames = safeAdd(
    coreFrameWithinTargetAccessUnit,
    actualPrerollAccessUnits * M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    'M4A AAC generation discard frames',
  );

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
