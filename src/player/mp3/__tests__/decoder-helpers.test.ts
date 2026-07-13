import { describe, expect, it } from 'vitest';

import { expectedLanczosOutputFrames } from '../../streaming/resampler-plan.ts';
import {
  MP3_DECODER_DEFAULT_WARMUP_FRAMES,
  Mp3DecoderHelperError,
  createMp3DecoderDescriptor,
  expectedMp3OutputFrames,
  rebuildMp3DecoderPlanningState,
  remainingMp3SourceFrames,
  resolveMp3DecoderPrelude,
} from '../decoder-helpers.ts';
import { parseMpegLayer3FrameHeader, type MpegLayer3FrameHeader } from '../frame-header.ts';
import type { Mp3Metadata } from '../metadata.ts';
import type { MpegLayer3SeekIndexPoint } from '../seek-index.ts';
import { createMp3SampleTimeline } from '../timeline.ts';
import type { Mp3GaplessMetadata, Mp3XingMetadata } from '../vbr-metadata.ts';

const SOURCE_IDENTITY = 'mp3-helper:0123456789abcdef';
const DEFAULT_AUDIO_FRAME_COUNT = 700;

interface MetadataFixtureOptions {
  readonly audioFrameCount?: number;
  readonly header?: MpegLayer3FrameHeader;
  readonly gapless?: Mp3GaplessMetadata | null;
  readonly seekOrdinals?: readonly number[];
  readonly mainDataBeginByOrdinal?: Readonly<Record<number, number>>;
}

function defaultHeader(): MpegLayer3FrameHeader {
  return parseMpegLayer3FrameHeader(Uint8Array.of(0xff, 0xfb, 0x90, 0x00));
}

function fixturePoint(
  header: MpegLayer3FrameHeader,
  firstAudioFrameOffset: number,
  frameOrdinal: number,
  mainDataBeginBytes = 0,
): Readonly<MpegLayer3SeekIndexPoint> {
  return Object.freeze({
    rawSample: frameOrdinal * header.samplesPerFrame,
    byteOffset: firstAudioFrameOffset + frameOrdinal * header.frameLengthBytes,
    frameOrdinal,
    mainDataCapacityBytes: header.mainDataCapacityBytes,
    mainDataBeginBytes,
  });
}

function metadataFixture(options: MetadataFixtureOptions = {}): Readonly<Mp3Metadata> {
  const header = options.header ?? defaultHeader();
  const audioFrameCount = options.audioFrameCount ?? DEFAULT_AUDIO_FRAME_COUNT;
  const gapless = options.gapless ?? null;
  const hasTagFrame = gapless !== null;
  const tagFrameBytes = hasTagFrame ? header.frameLengthBytes : 0;
  const firstAudioFrameOffset = tagFrameBytes;
  const audioBytes = audioFrameCount * header.frameLengthBytes;
  const sourceBytes = firstAudioFrameOffset + audioBytes;
  const timeline = createMp3SampleTimeline({
    totalRawSamples: audioFrameCount * header.samplesPerFrame,
    samplesPerFrame: header.samplesPerFrame,
    gapless,
  });
  const seekOrdinals = options.seekOrdinals ?? [0];
  const seekPoints = Object.freeze(
    seekOrdinals.map((frameOrdinal) =>
      fixturePoint(
        header,
        firstAudioFrameOffset,
        frameOrdinal,
        options.mainDataBeginByOrdinal?.[frameOrdinal] ?? 0,
      ),
    ),
  );
  const vbr: Mp3XingMetadata | null = gapless
    ? Object.freeze({
        kind: 'xing' as const,
        identifier: 'Xing' as const,
        headerOffset: 36,
        flags: 3,
        frameCount: audioFrameCount,
        streamBytes: sourceBytes,
        toc: null,
        quality: null,
        gapless,
      })
    : null;
  const fullyVerifiedFrameSpan = !hasTagFrame;
  const verifiedAudioFrameCount = fullyVerifiedFrameSpan
    ? audioFrameCount
    : Math.min(3, audioFrameCount);
  const verifiedAudioBytes = verifiedAudioFrameCount * header.frameLengthBytes;

  return Object.freeze({
    format: 'mp3' as const,
    id3: Object.freeze({
      sourceBytes,
      dataStart: 0,
      audioEnd: sourceBytes,
      leadingTagCount: 0,
      leadingTags: Object.freeze([]),
      hasTrailingId3v1: false,
      trailingId3v1Offset: null,
      trailingTagCount: 0,
      trailingTags: Object.freeze([]),
    }),
    vbr,
    gapless,
    version: header.version,
    sampleRateHz: header.sampleRateHz,
    channels: header.channelCount,
    samplesPerFrame: header.samplesPerFrame,
    firstAudioFrameHeader: header,
    hasTagFrame,
    tagFrameOffset: hasTagFrame ? 0 : null,
    tagFrameBytes,
    firstAudioFrameOffset,
    audioEndByteOffset: sourceBytes,
    id3FreeMpegBytes: sourceBytes,
    audioBytes,
    physicalFrameCount: audioFrameCount + (hasTagFrame ? 1 : 0),
    audioFrameCount,
    totalRawSamples: timeline.totalRawSamples,
    totalMediaFrames: timeline.totalMediaFrames,
    durationSeconds: timeline.totalMediaFrames / header.sampleRateHz,
    frameCountEvidence: fullyVerifiedFrameSpan ? ('verified-scan' as const) : ('xing' as const),
    fullyVerifiedFrameSpan,
    verifiedAudioFrameCount,
    verifiedAudioBytes,
    seekPoints,
  });
}

function sourceSize(metadata: Readonly<Mp3Metadata>): number {
  return metadata.id3.sourceBytes;
}

function pointsThrough(
  metadata: Readonly<Mp3Metadata>,
  lastFrameOrdinal: number,
  mainDataBeginByOrdinal: Readonly<Record<number, number>> = {},
): readonly Readonly<MpegLayer3SeekIndexPoint>[] {
  return Object.freeze(
    Array.from({ length: lastFrameOrdinal + 1 }, (_, frameOrdinal) =>
      fixturePoint(
        metadata.firstAudioFrameHeader,
        metadata.firstAudioFrameOffset,
        frameOrdinal,
        mainDataBeginByOrdinal[frameOrdinal] ?? 0,
      ),
    ),
  );
}

function patchMetadata(
  metadata: Readonly<Mp3Metadata>,
  patch: Record<string, unknown>,
): Mp3Metadata {
  return { ...metadata, ...patch } as Mp3Metadata;
}

describe('MP3 decoder helpers', () => {
  it('rebuilds an exact timeline and bounded seek index from strict metadata', () => {
    const metadata = metadataFixture({ seekOrdinals: [0, 100, 300, 699] });
    const planning = rebuildMp3DecoderPlanningState({
      metadata,
      sourceSize: sourceSize(metadata),
    });

    expect(planning.metadata).toEqual(metadata);
    expect(planning.sourceSize).toBe(sourceSize(metadata));
    expect(planning.timeline).toEqual(
      createMp3SampleTimeline({
        totalRawSamples: metadata.totalRawSamples,
        samplesPerFrame: metadata.samplesPerFrame,
        gapless: null,
      }),
    );
    expect(planning.seekIndex.snapshot()).toEqual(metadata.seekPoints);
    expect(planning.seekPoints).toEqual(metadata.seekPoints);
    expect(Object.isFrozen(planning)).toBe(true);
  });

  it('accepts a progressively enriched point snapshot while preserving metadata origin', () => {
    const metadata = metadataFixture();
    const enriched = Object.freeze([
      fixturePoint(metadata.firstAudioFrameHeader, metadata.firstAudioFrameOffset, 0),
      fixturePoint(metadata.firstAudioFrameHeader, metadata.firstAudioFrameOffset, 250),
      fixturePoint(metadata.firstAudioFrameHeader, metadata.firstAudioFrameOffset, 500),
    ]);
    const planning = rebuildMp3DecoderPlanningState({
      metadata,
      sourceSize: sourceSize(metadata),
      seekPoints: enriched,
    });
    expect(planning.seekIndex.snapshot()).toEqual(enriched);

    const wrongOrigin = [
      { ...enriched[0]!, byteOffset: metadata.firstAudioFrameOffset + 1 },
      ...enriched.slice(1),
    ];
    expect(() =>
      rebuildMp3DecoderPlanningState({
        metadata,
        sourceSize: sourceSize(metadata),
        seekPoints: wrongOrigin,
      }),
    ).toThrow(/origin|offset/i);
  });

  it.each([
    [
      'source size',
      (metadata: Readonly<Mp3Metadata>) => ({ sourceSize: sourceSize(metadata) - 1 }),
    ],
    [
      'raw total',
      (metadata: Readonly<Mp3Metadata>) => ({
        metadata: patchMetadata(metadata, { totalRawSamples: metadata.totalRawSamples - 1 }),
      }),
    ],
    [
      'media total',
      (metadata: Readonly<Mp3Metadata>) => ({
        metadata: patchMetadata(metadata, { totalMediaFrames: metadata.totalMediaFrames - 1 }),
      }),
    ],
    [
      'physical frame count',
      (metadata: Readonly<Mp3Metadata>) => ({
        metadata: patchMetadata(metadata, { physicalFrameCount: metadata.physicalFrameCount + 1 }),
      }),
    ],
    [
      'first point capacity',
      (metadata: Readonly<Mp3Metadata>) => ({
        metadata: patchMetadata(metadata, {
          seekPoints: [{ ...metadata.seekPoints[0]!, mainDataCapacityBytes: 1 }],
        }),
      }),
    ],
    [
      'duplicate point',
      (metadata: Readonly<Mp3Metadata>) => ({
        seekPoints: [metadata.seekPoints[0]!, metadata.seekPoints[0]!],
      }),
    ],
  ])('fails closed on forged %s metadata geometry', (_label, mutate) => {
    const metadata = metadataFixture();
    const changed = mutate(metadata);
    expect(() =>
      rebuildMp3DecoderPlanningState({
        metadata: changed.metadata ?? metadata,
        sourceSize: changed.sourceSize ?? sourceSize(metadata),
        seekPoints: changed.seekPoints,
      }),
    ).toThrow();
  });

  it('rejects metadata extras and accessor-backed fields', () => {
    const metadata = metadataFixture();
    expect(() =>
      rebuildMp3DecoderPlanningState({
        metadata: { ...metadata, extra: true } as unknown as Mp3Metadata,
        sourceSize: sourceSize(metadata),
      }),
    ).toThrow(/exact-key/i);

    const accessor = { ...metadata } as Record<string, unknown>;
    Object.defineProperty(accessor, 'format', { enumerable: true, get: () => 'mp3' });
    expect(() =>
      rebuildMp3DecoderPlanningState({
        metadata: accessor as unknown as Mp3Metadata,
        sourceSize: sourceSize(metadata),
      }),
    ).toThrow(/exact-key/i);
  });

  it('creates an origin descriptor with default native output and clamped warmup', () => {
    const metadata = metadataFixture();
    const result = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      mediaFrame: 0,
    });
    expect(result.outputSampleRate).toBe(metadata.sampleRateHz);
    expect(result.startPlan).toMatchObject({
      mediaFrame: 0,
      rawSample: 0,
      audioFrameOrdinal: 0,
      scanAnchorByteOffset: metadata.firstAudioFrameOffset,
      scanAnchorFrameOrdinal: 0,
      minimumWarmupFrames: 0,
      historyFrameLimit: 0,
    });
    expect(MP3_DECODER_DEFAULT_WARMUP_FRAMES).toBe(16);
  });

  it('uses verified early history and clamps default warmup at the origin', () => {
    const metadata = metadataFixture({ audioFrameCount: 10 });
    const seekPoints = pointsThrough(metadata, 2);
    const mediaFrame = 2 * metadata.samplesPerFrame + 17;
    const result = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      seekPoints,
      mediaFrame,
    });
    expect(result.startPlan).toMatchObject({
      mediaFrame,
      rawSample: mediaFrame,
      audioFrameOrdinal: 2,
      sampleWithinAudioFrame: 17,
      scanAnchorFrameOrdinal: 0,
      minimumWarmupFrames: 2,
      historyFrameLimit: 2,
    });
  });

  it('creates a bounded worker-resolvable sparse plan without inventing offsets', () => {
    const metadata = metadataFixture();
    const targetOrdinal = 600;
    const mediaFrame = targetOrdinal * metadata.samplesPerFrame + 9;
    const result = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      mediaFrame,
    });
    expect(result.startPlan).toMatchObject({
      audioFrameOrdinal: targetOrdinal,
      scanAnchorFrameOrdinal: 0,
      scanAnchorByteOffset: metadata.firstAudioFrameOffset,
      minimumWarmupFrames: 16,
      historyFrameLimit: 527,
    });
  });

  it('rejects EOF, invalid identity, output rate, and warmup before opening a realm', () => {
    const metadata = metadataFixture();
    const base = {
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      mediaFrame: 0,
    };
    expect(() =>
      createMp3DecoderDescriptor({ ...base, mediaFrame: metadata.totalMediaFrames }),
    ).toThrow(/exclusive media EOF/i);
    expect(() => createMp3DecoderDescriptor({ ...base, sourceIdentity: '' })).toThrow(/identity/i);
    expect(() => createMp3DecoderDescriptor({ ...base, outputSampleRate: 0 })).toThrow(/output/i);
    expect(() => createMp3DecoderDescriptor({ ...base, minimumWarmupFrames: 512 })).toThrow(
      /warmup/i,
    );
  });

  it('rebuilds trusted gapless timing and computes exact native and resampled remainders', () => {
    const gapless: Mp3GaplessMetadata = Object.freeze({
      encoderFamily: 'LAME',
      encoderTag: 'LAME3.100',
      encoderDelaySamples: 576,
      endPaddingSamples: 1_000,
    });
    const metadata = metadataFixture({ audioFrameCount: 100, gapless });
    const mediaFrame = 2_000;
    const native = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      mediaFrame,
    });
    expect(native.timeline.headTrimSamples).toBe(1_105);
    expect(native.timeline.tailTrimSamples).toBe(471);
    expect(remainingMp3SourceFrames(native)).toBe(metadata.totalMediaFrames - mediaFrame);
    expect(expectedMp3OutputFrames(native)).toBe(metadata.totalMediaFrames - mediaFrame);

    const resampled = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      mediaFrame,
      outputSampleRate: 48_000,
    });
    expect(expectedMp3OutputFrames(resampled)).toBe(
      expectedLanczosOutputFrames({
        inputSampleRate: metadata.sampleRateHz,
        outputSampleRate: 48_000,
        totalSourceFrames: metadata.totalMediaFrames,
        startSourceFrame: mediaFrame,
      }),
    );
  });

  it('resolves origin and early rolling windows without retaining encoded bodies', () => {
    const metadata = metadataFixture({ audioFrameCount: 10 });
    const originDescriptor = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      mediaFrame: 0,
    });
    const origin = resolveMp3DecoderPrelude({
      descriptor: originDescriptor,
      points: [pointsThrough(metadata, 0)[0]!],
    });
    expect(origin).toMatchObject({
      decodeStart: { frameOrdinal: 0 },
      warmupStart: { frameOrdinal: 0 },
      target: { frameOrdinal: 0 },
      reachedAudioOrigin: true,
      discardSamples: 0,
      rereadFrameCount: 1,
    });
    expect('bytes' in origin.points[0]!).toBe(false);

    const earlyPoints = pointsThrough(metadata, 2);
    const earlyDescriptor = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      seekPoints: earlyPoints,
      mediaFrame: 2 * metadata.samplesPerFrame + 23,
    });
    const early = resolveMp3DecoderPrelude({ descriptor: earlyDescriptor, points: earlyPoints });
    expect(early).toMatchObject({
      decodeStart: { frameOrdinal: 0 },
      warmupStart: { frameOrdinal: 0 },
      target: { frameOrdinal: 2 },
      reachedAudioOrigin: true,
      discardSamples: 2 * metadata.samplesPerFrame + 23,
      rereadFrameCount: 3,
    });
  });

  it('uses exact preceding capacities to resolve a reservoir-complete reread start', () => {
    const metadata = metadataFixture({ audioFrameCount: 10 });
    const mainDataBegin = { 3: 500 };
    const seekPoints = pointsThrough(metadata, 5, mainDataBegin);
    const mediaFrame = 5 * metadata.samplesPerFrame + 123;
    const descriptor = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      seekPoints,
      mediaFrame,
      minimumWarmupFrames: 2,
    });
    expect(descriptor.startPlan).toMatchObject({
      scanAnchorFrameOrdinal: 1,
      minimumWarmupFrames: 2,
      historyFrameLimit: 4,
    });
    const resolved = resolveMp3DecoderPrelude({
      descriptor,
      points: seekPoints.slice(1),
    });
    expect(resolved).toMatchObject({
      decodeStart: { frameOrdinal: 1 },
      warmupStart: { frameOrdinal: 3, mainDataBeginBytes: 500 },
      target: { frameOrdinal: 5 },
      reservoirCapacityBeforeWarmupBytes: 762,
      reachedAudioOrigin: false,
      discardSamples: 4 * metadata.samplesPerFrame + 123,
      rereadFrameCount: 5,
    });
    expect(resolved.points.map((point) => point.frameOrdinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it('resolves a sparse scan from only its bounded rolling tail', () => {
    const metadata = metadataFixture();
    const targetOrdinal = 600;
    const mediaFrame = targetOrdinal * metadata.samplesPerFrame + 7;
    const descriptor = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      mediaFrame,
    });
    const firstRollingOrdinal = targetOrdinal - descriptor.startPlan.historyFrameLimit;
    const rolling = Array.from({ length: descriptor.startPlan.historyFrameLimit + 1 }, (_, index) =>
      fixturePoint(
        metadata.firstAudioFrameHeader,
        metadata.firstAudioFrameOffset,
        firstRollingOrdinal + index,
      ),
    );
    const resolved = resolveMp3DecoderPrelude({ descriptor, points: rolling });
    expect(firstRollingOrdinal).toBe(73);
    expect(resolved.decodeStart.frameOrdinal).toBe(targetOrdinal - 16);
    expect(resolved.warmupStart.frameOrdinal).toBe(targetOrdinal - 16);
    expect(resolved.target.frameOrdinal).toBe(targetOrdinal);
    expect(resolved.points).toHaveLength(17);
  });

  it('rejects incomplete, over-bound, noncontiguous, and forged-capacity windows', () => {
    const metadata = metadataFixture({ audioFrameCount: 10 });
    const seekPoints = pointsThrough(metadata, 5, { 3: 500 });
    const descriptor = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      seekPoints,
      mediaFrame: 5 * metadata.samplesPerFrame,
      minimumWarmupFrames: 2,
    });
    const validWindow = seekPoints.slice(1);
    expect(() => resolveMp3DecoderPrelude({ descriptor, points: validWindow.slice(1) })).toThrow(
      /incomplete/i,
    );
    expect(() => resolveMp3DecoderPrelude({ descriptor, points: seekPoints })).toThrow(/bound/i);
    expect(() =>
      resolveMp3DecoderPrelude({
        descriptor,
        points: validWindow.filter((point) => point.frameOrdinal !== 3),
      }),
    ).toThrow(/incomplete|contiguous/i);
    expect(() =>
      resolveMp3DecoderPrelude({
        descriptor,
        points: validWindow.map((point) =>
          point.frameOrdinal === 2
            ? { ...point, mainDataCapacityBytes: point.mainDataCapacityBytes - 1 }
            : point,
        ),
      }),
    ).toThrow(/contiguous|capacity/i);
  });

  it('fails closed when a forged target needs more reservoir than the audio origin can supply', () => {
    const metadata = metadataFixture({ audioFrameCount: 3 });
    const seekPoints = pointsThrough(metadata, 1, { 1: 381 });
    const descriptor = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      seekPoints,
      mediaFrame: metadata.samplesPerFrame,
      minimumWarmupFrames: 0,
    });
    const forgedWindow = [seekPoints[0]!, { ...seekPoints[1]!, mainDataBeginBytes: 382 }];
    expect(() => resolveMp3DecoderPrelude({ descriptor, points: forgedWindow })).toThrow(
      /audio origin/i,
    );
  });

  it('rejects an origin descriptor that claims unavailable earlier reservoir data', () => {
    const metadata = metadataFixture({ audioFrameCount: 3 });
    const descriptor = createMp3DecoderDescriptor({
      metadata,
      sourceSize: sourceSize(metadata),
      sourceIdentity: SOURCE_IDENTITY,
      mediaFrame: 0,
    });
    const forgedOrigin = {
      ...pointsThrough(metadata, 0)[0]!,
      mainDataBeginBytes: 1,
    };
    expect(() => resolveMp3DecoderPrelude({ descriptor, points: [forgedOrigin] })).toThrow(
      /frame zero|origin/i,
    );
  });

  it('rejects invalid descriptors in remaining-frame helpers', () => {
    expect(() =>
      remainingMp3SourceFrames({} as Parameters<typeof remainingMp3SourceFrames>[0]),
    ).toThrow(/valid MP3 decoder descriptor/i);
    expect(() =>
      expectedMp3OutputFrames({} as Parameters<typeof expectedMp3OutputFrames>[0]),
    ).toThrow(/valid MP3 decoder descriptor/i);
    expect(Mp3DecoderHelperError.prototype).toBeInstanceOf(Error);
  });
});
