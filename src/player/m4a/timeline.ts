import { adtsCoreSampleRateHzForIndex } from '../aac/adts-header.ts';

/** One direct AAC-LC access unit produces exactly 1,024 core PCM frames. */
export const M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT = 1_024 as const;

/** Policy ceilings keep hostile `stts` tables bounded before any decoder opens. */
export const M4A_AAC_MAX_STTS_ENTRIES = 65_536;
export const M4A_AAC_MAX_ACCESS_UNITS = 16_777_216;

export interface M4aAacSttsEvidence {
  readonly accessUnitCount: number;
  readonly presentationEndCoreFrames: number;
  readonly finalAccessUnitDelta: number;
  readonly entryCount: number;
}

/** The initial edit-list subset is exactly one non-empty, rate-1 media edit. */
export interface M4aAacEditEvidence {
  readonly mediaTimeCoreFrames: number;
  readonly mediaRateInteger: 1;
  readonly mediaRateFraction: 0;
  readonly segmentDurationMovieTicks: number;
}

/** Exact decimal iTunSMPB fields after the metadata parser has authenticated them. */
export interface M4aAacITunEvidence {
  readonly primingCoreFrames: number;
  readonly remainderCoreFrames: number;
  readonly audibleCoreFrames: number;
}

export interface M4aAacTimelineNormalizationInput {
  readonly stts: Readonly<M4aAacSttsEvidence>;
  readonly sampleRateHz: number;
  readonly mdhdTimescale: number;
  readonly mdhdDurationCoreFrames: number;
  readonly movieTimescale: number;
  readonly edit: Readonly<M4aAacEditEvidence> | null;
  readonly iTun: Readonly<M4aAacITunEvidence> | null;
}

/**
 * Exact decoder and audible coordinates for the admitted AAC-LC track.
 * `rawCoreFrames` is decoder output; `totalMediaFrames` is what may be published.
 */
export interface M4aAacTimeline {
  readonly accessUnitCount: number;
  readonly sttsEntryCount: number;
  readonly finalAccessUnitDelta: number;
  readonly coreFramesPerAccessUnit: typeof M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT;
  readonly rawCoreFrames: number;
  readonly presentationEndCoreFrames: number;
  readonly headTrimCoreFrames: number;
  readonly tailTrimCoreFrames: number;
  readonly totalMediaFrames: number;
  readonly sampleRateHz: number;
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const issuedSttsEvidence = new WeakSet<object>();

const NORMALIZATION_KEYS = Object.freeze([
  'stts',
  'sampleRateHz',
  'mdhdTimescale',
  'mdhdDurationCoreFrames',
  'movieTimescale',
  'edit',
  'iTun',
] as const satisfies readonly (keyof M4aAacTimelineNormalizationInput)[]);

const STTS_EVIDENCE_KEYS = Object.freeze([
  'accessUnitCount',
  'presentationEndCoreFrames',
  'finalAccessUnitDelta',
  'entryCount',
] as const satisfies readonly (keyof M4aAacSttsEvidence)[]);

const EDIT_EVIDENCE_KEYS = Object.freeze([
  'mediaTimeCoreFrames',
  'mediaRateInteger',
  'mediaRateFraction',
  'segmentDurationMovieTicks',
] as const satisfies readonly (keyof M4aAacEditEvidence)[]);

const ITUN_EVIDENCE_KEYS = Object.freeze([
  'primingCoreFrames',
  'remainderCoreFrames',
  'audibleCoreFrames',
] as const satisfies readonly (keyof M4aAacITunEvidence)[]);

type DataRecord = Readonly<Record<string, unknown>>;

function requirePositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value <= 0
  ) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function safeBigIntToNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) {
    throw new RangeError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(value);
}

function safeAdd(left: number, right: number, label: string): number {
  return safeBigIntToNumber(BigInt(left) + BigInt(right), label);
}

function safeMultiply(left: number, right: number, label: string): number {
  return safeBigIntToNumber(BigInt(left) * BigInt(right), label);
}

function isIndexedAacSampleRateHz(value: number): boolean {
  for (let index = 0; index <= 12; index += 1) {
    if (adtsCoreSampleRateHzForIndex(index) === value) return true;
  }
  return false;
}

/**
 * Read an exact data-only record once. Accessors, symbols, class instances,
 * missing fields, and extra fields cannot become timing evidence.
 */
function snapshotExactDataRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): DataRecord {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${label} must be an exact plain data record`);
  }

  let isArray: boolean;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Reflect.getPrototypeOf(value);
  } catch (cause) {
    throw new TypeError(`${label} could not be inspected safely`, { cause });
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError(`${label} must be an exact plain data record`);
  }

  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must use enumerable data fields`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/**
 * Streaming `stts` accumulator. It retains four scalar counters, never the
 * table or one value per access unit, so a page parser can feed it directly.
 */
export class M4aAacSttsAccumulator {
  #accessUnitCount = 0;
  #presentationEndCoreFrames = 0;
  #entryCount = 0;
  #lastDelta: number | null = null;
  #finished = false;

  addRun(sampleCount: number, sampleDelta: number): void {
    if (this.#finished) {
      throw new Error('M4A AAC stts accumulator is already finished');
    }
    requirePositiveSafeInteger(sampleCount, 'stts sampleCount');
    requirePositiveSafeInteger(sampleDelta, 'stts sampleDelta');
    if (sampleDelta > M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT) {
      throw new RangeError('stts sampleDelta must not exceed 1,024 AAC core frames');
    }
    if (sampleCount > 1 && sampleDelta !== M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT) {
      throw new RangeError('Only the final logical AAC access unit may be shorter than 1,024');
    }
    if (this.#lastDelta !== null && this.#lastDelta !== M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT) {
      throw new RangeError('A shortened AAC access unit must be the final logical access unit');
    }

    const nextEntryCount = this.#entryCount + 1;
    if (nextEntryCount > M4A_AAC_MAX_STTS_ENTRIES) {
      throw new RangeError(`stts entry count exceeds ${M4A_AAC_MAX_STTS_ENTRIES}`);
    }

    const nextAccessUnitCount = safeAdd(
      this.#accessUnitCount,
      sampleCount,
      'M4A AAC access-unit count',
    );
    if (nextAccessUnitCount > M4A_AAC_MAX_ACCESS_UNITS) {
      throw new RangeError(`AAC access-unit count exceeds ${M4A_AAC_MAX_ACCESS_UNITS}`);
    }
    const contribution = safeMultiply(sampleCount, sampleDelta, 'stts run duration');
    const nextPresentationEnd = safeAdd(
      this.#presentationEndCoreFrames,
      contribution,
      'stts presentation duration',
    );

    this.#entryCount = nextEntryCount;
    this.#accessUnitCount = nextAccessUnitCount;
    this.#presentationEndCoreFrames = nextPresentationEnd;
    this.#lastDelta = sampleDelta;
  }

  finish(): Readonly<M4aAacSttsEvidence> {
    if (this.#finished) {
      throw new Error('M4A AAC stts accumulator is already finished');
    }
    if (this.#entryCount === 0 || this.#lastDelta === null) {
      throw new RangeError('M4A AAC stts must contain at least one non-empty entry');
    }
    this.#finished = true;
    const evidence = Object.freeze({
      accessUnitCount: this.#accessUnitCount,
      presentationEndCoreFrames: this.#presentationEndCoreFrames,
      finalAccessUnitDelta: this.#lastDelta,
      entryCount: this.#entryCount,
    });
    issuedSttsEvidence.add(evidence);
    return evidence;
  }
}

function snapshotSttsEvidence(value: unknown): M4aAacSttsEvidence {
  if (value === null || typeof value !== 'object' || !issuedSttsEvidence.has(value)) {
    throw new TypeError('M4A AAC stts evidence must be issued by this bounded accumulator realm');
  }
  const record = snapshotExactDataRecord(value, STTS_EVIDENCE_KEYS, 'M4A AAC stts evidence');
  const accessUnitCount = record.accessUnitCount;
  const presentationEndCoreFrames = record.presentationEndCoreFrames;
  const finalAccessUnitDelta = record.finalAccessUnitDelta;
  const entryCount = record.entryCount;

  requirePositiveSafeInteger(accessUnitCount, 'stts accessUnitCount');
  requirePositiveSafeInteger(presentationEndCoreFrames, 'stts presentationEndCoreFrames');
  requirePositiveSafeInteger(finalAccessUnitDelta, 'stts finalAccessUnitDelta');
  requirePositiveSafeInteger(entryCount, 'stts entryCount');
  if (accessUnitCount > M4A_AAC_MAX_ACCESS_UNITS) {
    throw new RangeError(`AAC access-unit count exceeds ${M4A_AAC_MAX_ACCESS_UNITS}`);
  }
  if (entryCount > M4A_AAC_MAX_STTS_ENTRIES || entryCount > accessUnitCount) {
    throw new RangeError('stts entry count is outside the bounded access-unit geometry');
  }
  if (finalAccessUnitDelta > M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT) {
    throw new RangeError('stts finalAccessUnitDelta must be from 1 through 1,024');
  }

  const fullPrefixDuration = safeMultiply(
    accessUnitCount - 1,
    M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    'M4A AAC full access-unit prefix',
  );
  const expectedPresentationEnd = safeAdd(
    fullPrefixDuration,
    finalAccessUnitDelta,
    'M4A AAC presentation duration',
  );
  if (presentationEndCoreFrames !== expectedPresentationEnd) {
    throw new RangeError('M4A AAC stts evidence has inconsistent presentation geometry');
  }

  return { accessUnitCount, presentationEndCoreFrames, finalAccessUnitDelta, entryCount };
}

function snapshotEditEvidence(value: unknown): M4aAacEditEvidence {
  const record = snapshotExactDataRecord(value, EDIT_EVIDENCE_KEYS, 'M4A AAC edit evidence');
  const mediaTimeCoreFrames = record.mediaTimeCoreFrames;
  const mediaRateInteger = record.mediaRateInteger;
  const mediaRateFraction = record.mediaRateFraction;
  const segmentDurationMovieTicks = record.segmentDurationMovieTicks;

  requireNonNegativeSafeInteger(mediaTimeCoreFrames, 'edit mediaTimeCoreFrames');
  if (mediaRateInteger !== 1) {
    throw new RangeError('M4A AAC edit mediaRateInteger must be exactly 1');
  }
  if (mediaRateFraction !== 0 || Object.is(mediaRateFraction, -0)) {
    throw new RangeError('M4A AAC edit mediaRateFraction must be exactly 0');
  }
  requirePositiveSafeInteger(segmentDurationMovieTicks, 'edit segmentDurationMovieTicks');

  return {
    mediaTimeCoreFrames,
    mediaRateInteger,
    mediaRateFraction,
    segmentDurationMovieTicks,
  };
}

function snapshotITunEvidence(value: unknown): M4aAacITunEvidence {
  const record = snapshotExactDataRecord(value, ITUN_EVIDENCE_KEYS, 'M4A AAC iTun evidence');
  const primingCoreFrames = record.primingCoreFrames;
  const remainderCoreFrames = record.remainderCoreFrames;
  const audibleCoreFrames = record.audibleCoreFrames;
  requireNonNegativeSafeInteger(primingCoreFrames, 'iTun primingCoreFrames');
  requireNonNegativeSafeInteger(remainderCoreFrames, 'iTun remainderCoreFrames');
  requireNonNegativeSafeInteger(audibleCoreFrames, 'iTun audibleCoreFrames');
  return { primingCoreFrames, remainderCoreFrames, audibleCoreFrames };
}

/**
 * Prove one exact AAC-LC timeline from `stts`, `mdhd`, optional edit-list,
 * and optional iTunSMPB evidence. No priming value is inferred when metadata
 * is absent: the canonical head trim is exactly zero in that case.
 */
export function normalizeM4aAacTimeline(input: unknown): Readonly<M4aAacTimeline> {
  const record = snapshotExactDataRecord(
    input,
    NORMALIZATION_KEYS,
    'M4A AAC timeline normalization input',
  );
  const stts = snapshotSttsEvidence(record.stts);
  const sampleRateHz = record.sampleRateHz;
  const mdhdTimescale = record.mdhdTimescale;
  const mdhdDurationCoreFrames = record.mdhdDurationCoreFrames;
  const movieTimescale = record.movieTimescale;

  requirePositiveSafeInteger(sampleRateHz, 'AAC sampleRateHz');
  requirePositiveSafeInteger(mdhdTimescale, 'mdhd timescale');
  requirePositiveSafeInteger(mdhdDurationCoreFrames, 'mdhd duration');
  requirePositiveSafeInteger(movieTimescale, 'movie timescale');
  if (!isIndexedAacSampleRateHz(sampleRateHz)) {
    throw new RangeError('M4A AAC sampleRateHz must be one of the 13 indexed AAC core rates');
  }
  if (mdhdTimescale !== sampleRateHz) {
    throw new RangeError('M4A AAC mdhd timescale must equal the AAC core sample rate');
  }
  if (mdhdDurationCoreFrames !== stts.presentationEndCoreFrames) {
    throw new RangeError('M4A AAC mdhd duration must equal the stts presentation duration');
  }

  const rawCoreFrames = safeMultiply(
    stts.accessUnitCount,
    M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    'M4A AAC raw core duration',
  );
  const tailTrimCoreFrames = rawCoreFrames - stts.presentationEndCoreFrames;
  if (!Number.isSafeInteger(tailTrimCoreFrames) || tailTrimCoreFrames < 0) {
    throw new RangeError('M4A AAC stts duration exceeds raw decoder output');
  }

  const edit = record.edit === null ? null : snapshotEditEvidence(record.edit);
  const iTun = record.iTun === null ? null : snapshotITunEvidence(record.iTun);

  let headTrimCoreFrames = 0;
  if (edit !== null) headTrimCoreFrames = edit.mediaTimeCoreFrames;
  if (iTun !== null) {
    const iTunTotal = safeBigIntToNumber(
      BigInt(iTun.primingCoreFrames) +
        BigInt(iTun.audibleCoreFrames) +
        BigInt(iTun.remainderCoreFrames),
      'iTun gapless duration',
    );
    if (iTunTotal !== rawCoreFrames) {
      throw new RangeError('M4A AAC iTun gapless fields do not sum to raw decoder output');
    }
    if (edit !== null && edit.mediaTimeCoreFrames !== iTun.primingCoreFrames) {
      throw new RangeError('M4A AAC edit and iTun priming evidence conflict');
    }
    headTrimCoreFrames = iTun.primingCoreFrames;
  }

  const totalMediaFrames = stts.presentationEndCoreFrames - headTrimCoreFrames;
  if (!Number.isSafeInteger(totalMediaFrames) || totalMediaFrames <= 0) {
    throw new RangeError('M4A AAC timing evidence leaves no non-empty media timeline');
  }

  if (iTun !== null) {
    if (iTun.remainderCoreFrames !== tailTrimCoreFrames) {
      throw new RangeError('M4A AAC iTun remainder conflicts with the stts terminal padding');
    }
    if (iTun.audibleCoreFrames !== totalMediaFrames) {
      throw new RangeError('M4A AAC iTun audible duration conflicts with the media timeline');
    }
  }

  if (edit !== null) {
    // Compare exact rational movie time with BigInt cross-products. Accepted
    // rounding is strictly less than one movie tick, never equal to one.
    const representedCoreTicks = BigInt(edit.segmentDurationMovieTicks) * BigInt(sampleRateHz);
    const exactCoreTicks = BigInt(totalMediaFrames) * BigInt(movieTimescale);
    const difference =
      representedCoreTicks >= exactCoreTicks
        ? representedCoreTicks - exactCoreTicks
        : exactCoreTicks - representedCoreTicks;
    if (difference >= BigInt(sampleRateHz)) {
      throw new RangeError('M4A AAC edit duration differs from media duration by one tick or more');
    }
  }

  return Object.freeze({
    accessUnitCount: stts.accessUnitCount,
    sttsEntryCount: stts.entryCount,
    finalAccessUnitDelta: stts.finalAccessUnitDelta,
    coreFramesPerAccessUnit: M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    rawCoreFrames,
    presentationEndCoreFrames: stts.presentationEndCoreFrames,
    headTrimCoreFrames,
    tailTrimCoreFrames,
    totalMediaFrames,
    sampleRateHz,
  });
}
