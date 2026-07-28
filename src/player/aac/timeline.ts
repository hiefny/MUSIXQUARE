/** Initial ADTS admission exposes exactly one AAC-LC core block per access unit. */
export const ADTS_CORE_FRAMES_PER_ACCESS_UNIT = 1_024 as const;

/**
 * Exact untrimmed relationship between verified ADTS access units and the
 * initial AAC-LC media timeline. ADTS supplies no trusted priming or gapless
 * metadata, so this checkpoint deliberately adds no decoder-delay estimate.
 */
export interface AdtsCoreTimeline {
  /** Number of scanner-verified ADTS access units. */
  readonly frameCount: number;
  readonly coreFramesPerAccessUnit: typeof ADTS_CORE_FRAMES_PER_ACCESS_UNIT;
  /** Media frames at the admitted AAC-LC core rate, including no inferred SBR expansion. */
  readonly totalMediaFrames: number;
}

export interface AdtsMediaFrameLocation {
  readonly mediaFrame: number;
  /** Core AAC-LC PCM coordinate. It is 1:1 with mediaFrame under this timeline policy. */
  readonly coreFrame: number;
  /** The exclusive EOF uses the terminal one-past access-unit ordinal. */
  readonly accessUnitOrdinal: number;
  readonly coreFrameWithinAccessUnit: number;
}

export interface AdtsDecodeGenerationPlan extends AdtsMediaFrameLocation {
  readonly prerollAccessUnitOrdinal: number;
  readonly prerollCoreFrame: number;
  readonly discardCoreFrames: number;
}

interface CanonicalAdtsCoreTimeline {
  readonly frameCount: number;
  readonly coreFramesPerAccessUnit: typeof ADTS_CORE_FRAMES_PER_ACCESS_UNIT;
  readonly totalMediaFrames: number;
}

const TIMELINE_KEYS = Object.freeze([
  'frameCount',
  'coreFramesPerAccessUnit',
  'totalMediaFrames',
] as const);

function requireNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function requirePositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

/**
 * Snapshot a structural timeline once. Only exact data properties are read so
 * accessors cannot change geometry between validation and coordinate mapping.
 */
function snapshotAdtsCoreTimeline(value: AdtsCoreTimeline): CanonicalAdtsCoreTimeline {
  if (!value || typeof value !== 'object') {
    throw new TypeError('ADTS core timeline must be an exact data-only object');
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new TypeError('ADTS core timeline could not be inspected safely', { cause: error });
  }

  // Derive the key set from the same descriptor snapshot. Consulting the
  // caller again through Reflect.ownKeys(value) would give a Proxy a second
  // reentrant trap in which to contradict the geometry already captured.
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== TIMELINE_KEYS.length || !TIMELINE_KEYS.every((key) => keys.includes(key))) {
    throw new TypeError('ADTS core timeline must contain only exact timeline fields');
  }

  const values: Partial<Record<(typeof TIMELINE_KEYS)[number], unknown>> = {};
  for (const key of TIMELINE_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`ADTS core timeline ${key} must be a data property`);
    }
    values[key] = descriptor.value;
  }

  const frameCount = values.frameCount;
  const coreFramesPerAccessUnit = values.coreFramesPerAccessUnit;
  const totalMediaFrames = values.totalMediaFrames;
  requirePositiveSafeInteger(frameCount, 'timeline frameCount');
  if (coreFramesPerAccessUnit !== ADTS_CORE_FRAMES_PER_ACCESS_UNIT) {
    throw new RangeError('timeline coreFramesPerAccessUnit must be exactly 1,024');
  }
  requirePositiveSafeInteger(totalMediaFrames, 'timeline totalMediaFrames');

  const expectedTotal = safeMultiply(
    frameCount,
    ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
    'ADTS core timeline',
  );
  if (totalMediaFrames !== expectedTotal) {
    throw new RangeError('ADTS core timeline geometry is inconsistent');
  }

  return { frameCount, coreFramesPerAccessUnit, totalMediaFrames };
}

function locateCanonicalMediaFrame(
  timeline: CanonicalAdtsCoreTimeline,
  mediaFrame: number,
): AdtsMediaFrameLocation {
  requireNonNegativeSafeInteger(mediaFrame, 'mediaFrame');
  if (mediaFrame > timeline.totalMediaFrames) {
    throw new RangeError('mediaFrame is outside the ADTS media timeline');
  }

  // There is no trusted trim in raw ADTS, so the admitted media coordinate is
  // exactly the AAC-LC core PCM coordinate. Do not apply an output-rate factor.
  const coreFrame = mediaFrame;
  const accessUnitOrdinal = Math.floor(coreFrame / timeline.coreFramesPerAccessUnit);
  const coreFrameWithinAccessUnit = coreFrame % timeline.coreFramesPerAccessUnit;

  return Object.freeze({
    mediaFrame,
    coreFrame,
    accessUnitOrdinal,
    coreFrameWithinAccessUnit,
  });
}

/**
 * Build an exact untrimmed AAC-LC core timeline from a verified ADTS frame
 * count. Payload admission and the selected decoder must reject SBR/PS before
 * calling this function; an HE-AAC stream must never be projected onto this
 * deliberately 1:1 core/media geometry.
 */
export function createAdtsCoreTimeline(frameCount: number): AdtsCoreTimeline {
  requirePositiveSafeInteger(frameCount, 'frameCount');
  const totalMediaFrames = safeMultiply(
    frameCount,
    ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
    'ADTS totalMediaFrames',
  );

  return Object.freeze({
    frameCount,
    coreFramesPerAccessUnit: ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
    totalMediaFrames,
  });
}

/**
 * Map any admitted media frame, including exclusive EOF, to its exact AAC core
 * access-unit coordinate. EOF is a terminal cursor, not an access unit.
 */
export function locateAdtsMediaFrame(
  timeline: AdtsCoreTimeline,
  mediaFrame: number,
): AdtsMediaFrameLocation {
  return locateCanonicalMediaFrame(snapshotAdtsCoreTimeline(timeline), mediaFrame);
}

/**
 * Plan the exact AAC core prefix to discard from a caller-selected bounded
 * preroll access unit. Decoder-specific minimum preroll is established by a
 * separate measured capability; this function only validates exact geometry.
 */
export function planAdtsDecodeGeneration(
  timeline: AdtsCoreTimeline,
  mediaFrame: number,
  prerollAccessUnitOrdinal: number,
): AdtsDecodeGenerationPlan {
  const canonical = snapshotAdtsCoreTimeline(timeline);
  const target = locateCanonicalMediaFrame(canonical, mediaFrame);
  if (mediaFrame === canonical.totalMediaFrames) {
    throw new RangeError('ADTS exclusive EOF cannot start a decode generation');
  }

  requireNonNegativeSafeInteger(prerollAccessUnitOrdinal, 'prerollAccessUnitOrdinal');
  if (prerollAccessUnitOrdinal > target.accessUnitOrdinal) {
    throw new RangeError('ADTS decode preroll cannot begin after its target access unit');
  }

  const prerollCoreFrame = safeMultiply(
    prerollAccessUnitOrdinal,
    canonical.coreFramesPerAccessUnit,
    'ADTS preroll core frame',
  );
  const discardCoreFrames = target.coreFrame - prerollCoreFrame;
  if (!Number.isSafeInteger(discardCoreFrames) || discardCoreFrames < 0) {
    throw new RangeError('ADTS generation discard is outside the safe-integer range');
  }

  return Object.freeze({
    ...target,
    prerollAccessUnitOrdinal,
    prerollCoreFrame,
    discardCoreFrames,
  });
}
