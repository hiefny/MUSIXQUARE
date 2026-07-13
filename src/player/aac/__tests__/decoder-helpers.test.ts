import { describe, expect, it } from 'vitest';

import { expectedLanczosOutputFrames } from '../../streaming/resampler-plan.ts';
import {
  AAC_DECODER_DEFAULT_TRANSFORM_PREROLL_ACCESS_UNITS,
  AacDecoderHelperError,
  createAacDecoderDescriptor,
  expectedAacOutputFrames,
  rebuildAacDecoderPlanningState,
  remainingAacCoreFrames,
} from '../decoder-helpers.ts';
import {
  AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS,
  sameAacDecoderDescriptor,
} from '../decoder-protocol.ts';
import type { AdtsFrameScanResult } from '../frame-scanner.ts';
import type { AdtsCoreConfiguration } from '../incremental-frame-reader.ts';
import { AdtsSeekIndex, type AdtsSeekIndexPoint } from '../seek-index.ts';

const SOURCE_IDENTITY = 'aac-helper:0123456789abcdef';
const FRAME_BYTES = 100;
const FRAME_COUNT = 12;

const CORE_CONFIGURATION: Readonly<AdtsCoreConfiguration> = Object.freeze({
  mpegId: 0,
  profile: 1,
  coreAudioObjectType: 2,
  sampleRateIndex: 4,
  channelConfiguration: 2,
  protectionAbsent: true,
  rawDataBlocks: 1,
});

interface ScanFixtureOptions {
  readonly frameCount?: number;
  readonly frameBytes?: number;
  readonly seekOrdinals?: readonly number[];
  readonly seekPoints?: readonly AdtsSeekIndexPoint[];
  readonly coreConfiguration?: Readonly<AdtsCoreConfiguration>;
  readonly coreSampleRateHz?: number;
  readonly coreChannelCount?: 1 | 2;
  readonly patch?: Readonly<Record<string, unknown>>;
}

function scanFixture(options: ScanFixtureOptions = {}): AdtsFrameScanResult {
  const frameCount = options.frameCount ?? FRAME_COUNT;
  const frameBytes = options.frameBytes ?? FRAME_BYTES;
  const sourceSize = frameCount * frameBytes;
  const seekPoints =
    options.seekPoints ??
    (options.seekOrdinals ?? [0, 4, 7, 9, frameCount - 1]).map((frameOrdinal) => ({
      frameOrdinal,
      byteOffset: frameOrdinal * frameBytes,
    }));
  return {
    sourceIdentity: SOURCE_IDENTITY,
    sourceSize,
    coreConfiguration: options.coreConfiguration ?? { ...CORE_CONFIGURATION },
    coreSampleRateHz: options.coreSampleRateHz ?? 44_100,
    coreChannelCount: options.coreChannelCount ?? 2,
    samplesPerFrame: 1_024,
    frameCount,
    totalCoreSamples: frameCount * 1_024,
    audioEndByteOffset: sourceSize,
    seekPoints,
    fullyVerifiedFrameSpan: true,
    ...options.patch,
  } as AdtsFrameScanResult;
}

function patchScan(
  scan: Readonly<AdtsFrameScanResult>,
  patch: Readonly<Record<string, unknown>>,
): AdtsFrameScanResult {
  return { ...scan, ...patch } as AdtsFrameScanResult;
}

function descriptorOptions(
  scan: Readonly<AdtsFrameScanResult>,
  mediaFrame: number,
  outputSampleRateHz = scan.coreSampleRateHz,
) {
  return {
    scan,
    outputSampleRateHz,
    mediaFrame,
  };
}

describe('AAC decoder planning-state boundary', () => {
  it('rebuilds detached, deeply frozen scanner evidence without encoded bodies', () => {
    const source = scanFixture();
    const planning = rebuildAacDecoderPlanningState(source);

    expect(planning.scan).toEqual(source);
    expect(planning.scan).not.toBe(source);
    expect(planning.scan.coreConfiguration).not.toBe(source.coreConfiguration);
    expect(planning.seekPoints).not.toBe(source.seekPoints);
    expect(planning.timeline).toEqual({
      frameCount: FRAME_COUNT,
      coreFramesPerAccessUnit: 1_024,
      totalMediaFrames: FRAME_COUNT * 1_024,
    });
    expect(Object.isFrozen(planning)).toBe(true);
    expect(Object.isFrozen(planning.scan)).toBe(true);
    expect(Object.isFrozen(planning.scan.coreConfiguration)).toBe(true);
    expect(Object.isFrozen(planning.seekPoints)).toBe(true);
    expect(planning.seekPoints.every(Object.isFrozen)).toBe(true);
    expect('bytes' in planning.scan).toBe(false);
    expect(planning.seekPoints.some((point) => 'bytes' in point)).toBe(false);

    Reflect.set(source, 'sourceIdentity', 'mutated-after-snapshot');
    Reflect.set(source.coreConfiguration, 'sampleRateIndex', 3);
    Reflect.set(source.seekPoints[1]!, 'byteOffset', 401);
    expect(planning.scan.sourceIdentity).toBe(SOURCE_IDENTITY);
    expect(planning.scan.coreConfiguration.sampleRateIndex).toBe(4);
    expect(planning.seekPoints[1]).toEqual({ frameOrdinal: 4, byteOffset: 400 });
  });

  it('rejects accessors, exotic prototypes, and extra array properties without invoking getters', () => {
    let coreGetterReads = 0;
    const configuration = { ...CORE_CONFIGURATION };
    Object.defineProperty(configuration, 'sampleRateIndex', {
      enumerable: true,
      get() {
        coreGetterReads += 1;
        return 4;
      },
    });
    expect(() =>
      rebuildAacDecoderPlanningState(
        scanFixture({
          coreConfiguration: configuration as unknown as AdtsCoreConfiguration,
        }),
      ),
    ).toThrow(/canonical exact-key record/i);
    expect(coreGetterReads).toBe(0);

    const exotic = scanFixture();
    Object.setPrototypeOf(exotic, { forged: true });
    expect(() => rebuildAacDecoderPlanningState(exotic)).toThrow(/canonical exact-key record/i);

    const points = [...scanFixture().seekPoints];
    Object.defineProperty(points, 'forged', { enumerable: true, value: true });
    expect(() =>
      rebuildAacDecoderPlanningState(patchScan(scanFixture(), { seekPoints: points })),
    ).toThrow(/dense array/i);
  });

  it('contains re-entrant Proxy mutation to the one detached descriptor snapshot', () => {
    const scanTarget = scanFixture();
    let outerMutationRan = false;
    const scan = new Proxy(scanTarget, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === 'sourceIdentity' && !outerMutationRan) {
          outerMutationRan = true;
          Reflect.set(target, 'sourceIdentity', 'mutated-during-reflection');
        }
        return descriptor;
      },
    });
    const planning = rebuildAacDecoderPlanningState(scan);
    expect(outerMutationRan).toBe(true);
    expect(scanTarget.sourceIdentity).toBe('mutated-during-reflection');
    expect(planning.scan.sourceIdentity).toBe(SOURCE_IDENTITY);

    const pointTarget = { frameOrdinal: 4, byteOffset: 400 };
    let pointMutationRan = false;
    const point = new Proxy(pointTarget, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === 'frameOrdinal' && !pointMutationRan) {
          pointMutationRan = true;
          Reflect.set(target, 'frameOrdinal', 5);
        }
        return descriptor;
      },
    });
    const pointPlanning = rebuildAacDecoderPlanningState(
      patchScan(scanFixture(), {
        seekPoints: [
          { frameOrdinal: 0, byteOffset: 0 },
          point,
          { frameOrdinal: 7, byteOffset: 700 },
          { frameOrdinal: 9, byteOffset: 900 },
          { frameOrdinal: 11, byteOffset: 1_100 },
        ],
      }),
    );
    expect(pointMutationRan).toBe(true);
    expect(pointTarget.frameOrdinal).toBe(5);
    expect(pointPlanning.seekPoints[1]).toEqual({ frameOrdinal: 4, byteOffset: 400 });
  });

  it.each([
    [
      'complete-span evidence',
      (scan: AdtsFrameScanResult) => patchScan(scan, { fullyVerifiedFrameSpan: false }),
    ],
    ['source identity', (scan: AdtsFrameScanResult) => patchScan(scan, { sourceIdentity: '' })],
    [
      'physical EOF',
      (scan: AdtsFrameScanResult) =>
        patchScan(scan, { audioEndByteOffset: scan.audioEndByteOffset - 1 }),
    ],
    [
      '1024-frame geometry',
      (scan: AdtsFrameScanResult) => patchScan(scan, { samplesPerFrame: 960 }),
    ],
    [
      'core total',
      (scan: AdtsFrameScanResult) =>
        patchScan(scan, { totalCoreSamples: scan.totalCoreSamples - 1 }),
    ],
    [
      'core profile',
      (scan: AdtsFrameScanResult) =>
        patchScan(scan, { coreConfiguration: { ...scan.coreConfiguration, mpegId: 1 } }),
    ],
    ['core rate', (scan: AdtsFrameScanResult) => patchScan(scan, { coreSampleRateHz: 48_000 })],
    [
      'seek origin',
      (scan: AdtsFrameScanResult) => patchScan(scan, { seekPoints: scan.seekPoints.slice(1) }),
    ],
    [
      'seek terminal',
      (scan: AdtsFrameScanResult) => patchScan(scan, { seekPoints: scan.seekPoints.slice(0, -1) }),
    ],
    [
      'monotonic seek points',
      (scan: AdtsFrameScanResult) =>
        patchScan(scan, {
          seekPoints: [scan.seekPoints[0]!, scan.seekPoints[1]!, scan.seekPoints[1]!],
        }),
    ],
    [
      'forged byte coordinate',
      (scan: AdtsFrameScanResult) =>
        patchScan(scan, {
          seekPoints: scan.seekPoints.map((point) =>
            point.frameOrdinal === 4 ? { ...point, byteOffset: 1 } : point,
          ),
        }),
    ],
    [
      'extra point field',
      (scan: AdtsFrameScanResult) =>
        patchScan(scan, {
          seekPoints: scan.seekPoints.map((point, index) =>
            index === 1 ? { ...point, forged: true } : point,
          ),
        }),
    ],
  ])('rejects forged %s scanner metadata', (_label, forge) => {
    expect(() => rebuildAacDecoderPlanningState(forge(scanFixture()))).toThrow();
  });

  it('fails before retaining totals whose 1024-frame product exceeds safe integers', () => {
    const frameCount = Math.floor(Number.MAX_SAFE_INTEGER / 1_024) + 1;
    const sourceSize = frameCount * 8;
    const scan = scanFixture({
      frameCount,
      frameBytes: 8,
      seekPoints: [
        { frameOrdinal: 0, byteOffset: 0 },
        { frameOrdinal: frameCount - 1, byteOffset: sourceSize - 8 },
      ],
      patch: {
        sourceSize,
        audioEndByteOffset: sourceSize,
        totalCoreSamples: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(() => rebuildAacDecoderPlanningState(scan)).toThrow(/safe-integer range/i);
  });
});

describe('AAC decoder descriptor construction', () => {
  it('creates an origin descriptor and clamps the default one-AU preroll at zero', () => {
    const result = createAacDecoderDescriptor(descriptorOptions(scanFixture(), 0));
    expect(AAC_DECODER_DEFAULT_TRANSFORM_PREROLL_ACCESS_UNITS).toBe(1);
    expect(result.startPlan).toEqual({
      mediaFrame: 0,
      coreFrame: 0,
      accessUnitOrdinal: 0,
      coreFrameWithinAccessUnit: 0,
      scanAnchorByteOffset: 0,
      scanAnchorAccessUnitOrdinal: 0,
      decodeStartAccessUnitOrdinal: 0,
      discardCoreFrames: 0,
    });
  });

  it('selects the floor anchor for decode-start rather than a later target anchor', () => {
    const mediaFrame = 9 * 1_024 + 37;
    const result = createAacDecoderDescriptor(descriptorOptions(scanFixture(), mediaFrame));
    expect(result.startPlan).toEqual({
      mediaFrame,
      coreFrame: mediaFrame,
      accessUnitOrdinal: 9,
      coreFrameWithinAccessUnit: 37,
      scanAnchorByteOffset: 7 * FRAME_BYTES,
      scanAnchorAccessUnitOrdinal: 7,
      decodeStartAccessUnitOrdinal: 8,
      discardCoreFrames: 1_024 + 37,
    });
  });

  it('uses deterministic floor anchors from an actually compacted bounded index', () => {
    const frameCount = 32;
    const index = new AdtsSeekIndex({ frameOrdinal: 0, byteOffset: 0 }, { maxPoints: 3 });
    for (let ordinal = 1; ordinal < frameCount; ordinal += 1) {
      expect(
        index.appendVerified({ frameOrdinal: ordinal, byteOffset: ordinal * FRAME_BYTES }),
      ).toBe(true);
    }
    const seekPoints = index.snapshot();
    expect(seekPoints.length).toBeLessThanOrEqual(3);
    const mediaFrame = 30 * 1_024 + 11;
    const decodeStartOrdinal = 22;
    const expectedAnchor = seekPoints
      .filter((point) => point.frameOrdinal <= decodeStartOrdinal)
      .at(-1);
    const result = createAacDecoderDescriptor({
      ...descriptorOptions(scanFixture({ frameCount, seekPoints }), mediaFrame),
      prerollAccessUnits: 8,
    });
    expect(result.startPlan.decodeStartAccessUnitOrdinal).toBe(decodeStartOrdinal);
    expect(result.startPlan.scanAnchorAccessUnitOrdinal).toBe(expectedAnchor?.frameOrdinal);
    expect(result.startPlan.scanAnchorByteOffset).toBe(expectedAnchor?.byteOffset);
  });

  it.each([
    [0, 9, 9, 37],
    [1, 8, 7, 1_024 + 37],
    [8, 1, 0, 8 * 1_024 + 37],
  ])(
    'supports %i bounded preroll AUs with exact decode/discard coordinates',
    (prerollAccessUnits, decodeStart, anchor, discard) => {
      const result = createAacDecoderDescriptor({
        ...descriptorOptions(scanFixture(), 9 * 1_024 + 37),
        prerollAccessUnits,
      });
      expect(result.startPlan).toMatchObject({
        decodeStartAccessUnitOrdinal: decodeStart,
        scanAnchorAccessUnitOrdinal: anchor,
        discardCoreFrames: discard,
      });
    },
  );

  it('rejects exclusive EOF, over-bound preroll, and noncanonical options', () => {
    const scan = scanFixture();
    expect(() =>
      createAacDecoderDescriptor(descriptorOptions(scan, scan.totalCoreSamples)),
    ).toThrow(/exclusive media EOF/i);
    expect(() =>
      createAacDecoderDescriptor({
        ...descriptorOptions(scan, 0),
        prerollAccessUnits: AAC_DECODER_MAX_TRANSFORM_PREROLL_ACCESS_UNITS + 1,
      }),
    ).toThrow(/prerollAccessUnits/i);
    expect(() =>
      createAacDecoderDescriptor({ ...descriptorOptions(scan, 0), forged: true } as never),
    ).toThrow(/exact data-only record/i);

    let mediaFrameReads = 0;
    const options = descriptorOptions(scan, 0);
    Object.defineProperty(options, 'mediaFrame', {
      enumerable: true,
      get() {
        mediaFrameReads += 1;
        return 0;
      },
    });
    expect(() => createAacDecoderDescriptor(options)).toThrow(/exact data-only record/i);
    expect(mediaFrameReads).toBe(0);
  });

  it('rejects output rates outside the protocol ceiling and safe resampler totals', () => {
    const scan = scanFixture();
    expect(() => createAacDecoderDescriptor(descriptorOptions(scan, 0, 0))).toThrow(
      /outputSampleRateHz/i,
    );
    expect(() =>
      createAacDecoderDescriptor(
        descriptorOptions(scan, 0, AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ + 1),
      ),
    ).toThrow(/outputSampleRateHz/i);

    const frameCount = Math.floor(Number.MAX_SAFE_INTEGER / 1_024);
    const sourceSize = frameCount * 8;
    const hugeScan = scanFixture({
      frameCount,
      frameBytes: 8,
      seekPoints: [
        { frameOrdinal: 0, byteOffset: 0 },
        { frameOrdinal: frameCount - 1, byteOffset: sourceSize - 8 },
      ],
      coreConfiguration: {
        ...CORE_CONFIGURATION,
        sampleRateIndex: 12,
        channelConfiguration: 1,
      },
      coreSampleRateHz: 7_350,
      coreChannelCount: 1,
    });
    expect(() =>
      createAacDecoderDescriptor(
        descriptorOptions(hugeScan, 0, AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ),
      ),
    ).toThrow(/safe-integer range/i);
  });

  it('returns equal, deeply immutable descriptors detached from every input', () => {
    const scan = scanFixture();
    const first = createAacDecoderDescriptor(descriptorOptions(scan, 3 * 1_024 + 5, 48_000));
    const second = createAacDecoderDescriptor(descriptorOptions(scan, 3 * 1_024 + 5, 48_000));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(sameAacDecoderDescriptor(first, second)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.coreConfiguration)).toBe(true);
    expect(Object.isFrozen(first.timeline)).toBe(true);
    expect(Object.isFrozen(first.startPlan)).toBe(true);

    Reflect.set(scan, 'sourceIdentity', 'later-mutation');
    Reflect.set(scan.seekPoints[0]!, 'byteOffset', 1);
    expect(first.sourceIdentity).toBe(SOURCE_IDENTITY);
    expect(first.startPlan.scanAnchorByteOffset).toBe(0);
  });
});

describe('AAC decoder output geometry helpers', () => {
  it('computes exact native and pinned-Lanczos generation remainders', () => {
    const scan = scanFixture();
    const mediaFrame = 4 * 1_024 + 77;
    const native = createAacDecoderDescriptor(descriptorOptions(scan, mediaFrame));
    expect(remainingAacCoreFrames(native)).toBe(scan.totalCoreSamples - mediaFrame);
    expect(expectedAacOutputFrames(native)).toBe(scan.totalCoreSamples - mediaFrame);

    const resampled = createAacDecoderDescriptor(descriptorOptions(scan, mediaFrame, 48_000));
    expect(expectedAacOutputFrames(resampled)).toBe(
      expectedLanczosOutputFrames({
        inputSampleRate: scan.coreSampleRateHz,
        outputSampleRate: 48_000,
        totalSourceFrames: scan.totalCoreSamples,
        startSourceFrame: mediaFrame,
      }),
    );
  });

  it('rejects forged descriptors instead of deriving counters from them', () => {
    expect(() =>
      remainingAacCoreFrames({} as Parameters<typeof remainingAacCoreFrames>[0]),
    ).toThrow(/valid AAC decoder descriptor/i);
    expect(() =>
      expectedAacOutputFrames({} as Parameters<typeof expectedAacOutputFrames>[0]),
    ).toThrow(/valid AAC decoder descriptor/i);
    expect(AacDecoderHelperError.prototype).toBeInstanceOf(Error);
  });
});
