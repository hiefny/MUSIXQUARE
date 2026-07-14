import { describe, expect, it } from 'vitest';

import {
  throwIfAborted,
  validateExactRead,
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
} from '../../sources/encoded-audio-source.ts';
import {
  createMp3DecoderDescriptor,
  createMp3DecoderDescriptorFromTimelineEvidence,
  createMp3DecoderTimelineEvidenceFromMetadata,
  rebuildMp3DecoderTimelinePlanningState,
} from '../decoder-helpers.ts';
import {
  createMp3DecoderTimelineEvidence,
  type Mp3DecoderTimelineEvidence,
} from '../decoder-timeline-evidence.ts';
import { parseMpegLayer3FrameHeader } from '../frame-header.ts';
import { readMp3Metadata, type Mp3Metadata } from '../metadata.ts';
import { MP3_SEEK_INDEX_MAX_POINTS } from '../seek-index.ts';
import { createMp3SampleTimeline } from '../timeline.ts';

const SOURCE_IDENTITY = 'mp3-evidence-fixture:0123456789abcdef';
const AUDIO_FRAME_COUNT = 40;

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly identity: string;
  readonly metadata: EncodedAudioSourceMetadata = Object.freeze({
    name: 'decoder-timeline-evidence.mp3',
    mime: 'audio/mpeg',
  });
  readonly reads: ReadRecord[] = [];

  constructor(
    private readonly bytes: Uint8Array,
    identity = SOURCE_IDENTITY,
  ) {
    this.identity = identity;
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    const end = validateExactRead(this.size, offset, length);
    this.reads.push(Object.freeze({ offset, length }));
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {}
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeFrame(mainDataBeginBytes = 0): Uint8Array {
  const headerBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const frame = new Uint8Array(header.frameLengthBytes);
  frame.set(headerBytes);
  const sideInfoOffset = 4 + (header.hasCrc ? 2 : 0);
  frame[sideInfoOffset] = mainDataBeginBytes >>> 1;
  frame[sideInfoOffset + 1] = (mainDataBeginBytes & 1) << 7;
  return frame;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function setUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = Math.floor(value / 0x1_00_00_00) & 0xff;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function setUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value;
}

function lameInfoTagCrc16(bytes: Uint8Array, endOffset: number): number {
  let crc = 0;
  for (let offset = 0; offset < endOffset; offset += 1) {
    crc ^= bytes[offset] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xa001);
    }
  }
  return crc & 0xffff;
}

function cbrBytes(audioFrameCount = AUDIO_FRAME_COUNT): Uint8Array {
  return concatenate(
    Array.from({ length: audioFrameCount }, (_, ordinal) => makeFrame(ordinal === 0 ? 0 : 16)),
  );
}

function xingBytes(
  audioFrameCount = AUDIO_FRAME_COUNT,
  gapless: { readonly delay: number; readonly padding: number } | null = null,
): Uint8Array {
  const tag = makeFrame();
  const audioFrames = Array.from({ length: audioFrameCount }, (_, ordinal) =>
    makeFrame(ordinal === 0 ? 0 : 16),
  );
  const bytes = concatenate([tag, ...audioFrames]);
  const header = parseMpegLayer3FrameHeader(tag.subarray(0, 4));
  const xingOffset = 4 + header.sideInfoBytes;
  setAscii(bytes, xingOffset, 'Xing');
  setUint32(bytes, xingOffset + 4, 3);
  setUint32(bytes, xingOffset + 8, audioFrameCount);
  setUint32(bytes, xingOffset + 12, bytes.byteLength);
  if (gapless) {
    const encoderOffset = xingOffset + 16;
    setAscii(bytes, encoderOffset, 'LAME3.100');
    const packed = gapless.delay * 0x1000 + gapless.padding;
    bytes[encoderOffset + 21] = packed >>> 16;
    bytes[encoderOffset + 22] = packed >>> 8;
    bytes[encoderOffset + 23] = packed;
    const crcOffset = encoderOffset + 34;
    setUint16(bytes, crcOffset, lameInfoTagCrc16(bytes, crcOffset));
  }
  return bytes;
}

async function issuedMetadata(
  bytes: Uint8Array,
  identity = SOURCE_IDENTITY,
): Promise<{ readonly source: MemorySource; readonly metadata: Readonly<Mp3Metadata> }> {
  const source = new MemorySource(bytes, identity);
  const metadata = await readMp3Metadata(source, signal());
  return Object.freeze({ source, metadata });
}

function rawEvidence(evidence: Readonly<Mp3DecoderTimelineEvidence>): Record<string, unknown> {
  return {
    ...evidence,
    tagFrame: evidence.tagFrame
      ? {
          ...evidence.tagFrame,
          declaration: {
            ...evidence.tagFrame.declaration,
            gapless: evidence.tagFrame.declaration.gapless
              ? { ...evidence.tagFrame.declaration.gapless }
              : null,
          },
        }
      : null,
    timeline: { ...evidence.timeline },
    manifestEndpointEvidence: evidence.manifestEndpointEvidence
      ? {
          ...evidence.manifestEndpointEvidence,
          tagDeclaration: evidence.manifestEndpointEvidence.tagDeclaration
            ? {
                ...evidence.manifestEndpointEvidence.tagDeclaration,
                gapless: evidence.manifestEndpointEvidence.tagDeclaration.gapless
                  ? { ...evidence.manifestEndpointEvidence.tagDeclaration.gapless }
                  : null,
              }
            : null,
        }
      : null,
    seekPoints: evidence.seekPoints.map((point) => ({ ...point })),
  };
}

describe('MP3 decoder timeline evidence', () => {
  it('converts only exact scanner-issued metadata without additional source reads', async () => {
    const { source, metadata } = await issuedMetadata(cbrBytes());
    const readsAfterMetadata = source.reads.length;
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);

    expect(source.reads).toHaveLength(readsAfterMetadata);
    expect(evidence).toMatchObject({
      format: 'mp3-decoder-timeline',
      authority: 'none',
      provenanceKind: 'scanner',
      sourceIdentity: source.identity,
      sourceSize: source.size,
      audioFrameCount: AUDIO_FRAME_COUNT,
      frameCountEvidence: 'verified-scan',
      fullyVerifiedFrameSpan: true,
      verifiedAudioFrameCount: AUDIO_FRAME_COUNT,
      verifiedAudioBytes: source.size,
      manifestEndpointEvidence: null,
    });
    expect(evidence.seekPoints[0]).toMatchObject({ frameOrdinal: 0, rawSample: 0 });
    expect(evidence.seekPoints.at(-1)).toMatchObject({
      frameOrdinal: AUDIO_FRAME_COUNT - 1,
      rawSample: (AUDIO_FRAME_COUNT - 1) * metadata.samplesPerFrame,
    });

    const structuralCopy = { ...metadata } as Mp3Metadata;
    expect(() => createMp3DecoderTimelineEvidenceFromMetadata(structuralCopy)).toThrow(
      /scanner-issued/i,
    );
    expect(source.reads).toHaveLength(readsAfterMetadata);
  });

  it('preserves declared-count authority and bounds every point to its verified prefix', async () => {
    const { metadata } = await issuedMetadata(xingBytes(), `${SOURCE_IDENTITY}:xing`);
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);

    expect(evidence).toMatchObject({
      frameCountEvidence: 'xing',
      fullyVerifiedFrameSpan: false,
      audioFrameCount: AUDIO_FRAME_COUNT,
      verifiedAudioFrameCount: 3,
      tagFrame: {
        byteOffset: 0,
        byteLength: metadata.tagFrameBytes,
        declaration: {
          kind: 'xing',
          frameCount: AUDIO_FRAME_COUNT,
          streamBytes: metadata.id3FreeMpegBytes,
          gapless: null,
        },
      },
    });
    expect(evidence.seekPoints.map((point) => point.frameOrdinal)).toEqual([0, 1, 2]);
    expect(evidence.seekPoints.at(-1)?.frameOrdinal).not.toBe(AUDIO_FRAME_COUNT - 1);

    const header = metadata.firstAudioFrameHeader;
    const outsidePrefix = {
      rawSample: evidence.verifiedAudioFrameCount * evidence.samplesPerFrame,
      byteOffset:
        evidence.firstAudioFrameOffset + evidence.verifiedAudioFrameCount * header.frameLengthBytes,
      frameOrdinal: evidence.verifiedAudioFrameCount,
      mainDataCapacityBytes: header.mainDataCapacityBytes,
      mainDataBeginBytes: 16,
    };
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        seekPoints: [...evidence.seekPoints, outsidePrefix],
      }),
    ).toThrow(/verified prefix/i);
  });

  it('requires full-span evidence to retain the exact terminal point', async () => {
    const { metadata } = await issuedMetadata(cbrBytes());
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        seekPoints: evidence.seekPoints.slice(0, -1),
      }),
    ).toThrow(/terminal/i);

    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        verifiedAudioFrameCount: evidence.audioFrameCount - 1,
      }),
    ).toThrow(/complete audio span/i);
  });

  it('re-derives timing only from a tag-backed full gapless proof', async () => {
    const { metadata } = await issuedMetadata(
      xingBytes(AUDIO_FRAME_COUNT, { delay: 576, padding: 1_000 }),
    );
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);

    expect(evidence.tagFrame?.declaration).toMatchObject({
      kind: 'xing',
      frameCount: AUDIO_FRAME_COUNT,
      streamBytes: metadata.id3FreeMpegBytes,
      gapless: {
        encoderFamily: 'LAME',
        encoderTag: 'LAME3.100',
        encoderDelaySamples: 576,
        endPaddingSamples: 1_000,
      },
    });
    expect(evidence.timeline).toMatchObject({
      headTrimSamples: 1_105,
      tailTrimSamples: 471,
    });
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        timeline: {
          ...evidence.timeline,
          headTrimSamples: evidence.timeline.headTrimSamples + 1,
        },
      }),
    ).toThrow(/gapless geometry/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        tagFrame: {
          ...evidence.tagFrame!,
          declaration: {
            ...evidence.tagFrame!.declaration,
            gapless: {
              ...evidence.tagFrame!.declaration.gapless!,
              encoderDelaySamples: 0xfff,
            },
          },
        },
      }),
    ).toThrow(/encoder delay/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        tagFrame: {
          ...evidence.tagFrame!,
          declaration: {
            ...evidence.tagFrame!.declaration,
            gapless: {
              ...evidence.tagFrame!.declaration.gapless!,
              endPaddingSamples: 0xfff,
            },
          },
        },
      }),
    ).toThrow(/end padding/i);

    const upperBound = createMp3DecoderTimelineEvidenceFromMetadata(
      (
        await issuedMetadata(
          xingBytes(AUDIO_FRAME_COUNT, { delay: 0xffe, padding: 0xffe }),
          `${SOURCE_IDENTITY}:gapless-bound`,
        )
      ).metadata,
    );
    expect(upperBound.tagFrame?.declaration.gapless).toMatchObject({
      encoderDelaySamples: 0xffe,
      endPaddingSamples: 0xffe,
    });
  });

  it('rejects forged tag provenance and contradictory declarations', async () => {
    const { metadata: cbrMetadata } = await issuedMetadata(cbrBytes());
    const cbr = createMp3DecoderTimelineEvidenceFromMetadata(cbrMetadata);
    const forgedGapless = {
      encoderFamily: 'LAME',
      encoderTag: 'LAME3.100',
      encoderDelaySamples: 576,
      endPaddingSamples: 1_000,
    };
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(cbr),
        tagFrame: {
          byteOffset: 0,
          byteLength: cbrMetadata.firstAudioFrameHeader.frameLengthBytes,
          declaration: {
            kind: 'xing',
            frameCount: cbr.audioFrameCount,
            streamBytes: cbr.sourceSize,
            gapless: forgedGapless,
          },
        },
        timeline: createMp3SampleTimeline({
          totalRawSamples: cbr.timeline.totalRawSamples,
          samplesPerFrame: cbr.samplesPerFrame,
          gapless: forgedGapless,
        }),
      }),
    ).toThrow(/tag frame/i);

    const { metadata } = await issuedMetadata(xingBytes(), `${SOURCE_IDENTITY}:relations`);
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        tagFrame: {
          ...evidence.tagFrame!,
          declaration: {
            ...evidence.tagFrame!.declaration,
            frameCount: evidence.audioFrameCount + 1,
          },
        },
      }),
    ).toThrow(/frame count/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        tagFrame: {
          ...evidence.tagFrame!,
          declaration: {
            ...evidence.tagFrame!.declaration,
            streamBytes: evidence.tagFrame!.declaration.streamBytes! - 1,
          },
        },
      }),
    ).toThrow(/stream bytes/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        tagFrame: {
          ...evidence.tagFrame!,
          declaration: { ...evidence.tagFrame!.declaration, kind: 'info' },
        },
      }),
    ).toThrow(/matching tag declaration/i);
  });

  it('takes detached deep snapshots of mutable nested input', async () => {
    const { metadata } = await issuedMetadata(
      xingBytes(AUDIO_FRAME_COUNT, { delay: 576, padding: 1_000 }),
    );
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);
    const timeline = { ...evidence.timeline };
    const points = evidence.seekPoints.map((point) => ({ ...point }));
    const tagFrame = {
      ...evidence.tagFrame!,
      declaration: {
        ...evidence.tagFrame!.declaration,
        gapless: { ...evidence.tagFrame!.declaration.gapless! },
      },
    };
    const input = { ...evidence, tagFrame, timeline, seekPoints: points };
    const canonical = createMp3DecoderTimelineEvidence(input);
    const originalOffset = canonical.seekPoints[0]!.byteOffset;
    const originalTotal = canonical.timeline.totalRawSamples;
    const originalDeclaredCount = canonical.tagFrame!.declaration.frameCount;

    input.sourceIdentity = 'changed-after-snapshot';
    timeline.totalRawSamples = 1;
    points[0]!.byteOffset += 1;
    tagFrame.declaration.frameCount = 1;
    tagFrame.declaration.gapless.encoderDelaySamples = 1;

    expect(canonical.sourceIdentity).toBe(SOURCE_IDENTITY);
    expect(canonical.timeline.totalRawSamples).toBe(originalTotal);
    expect(canonical.seekPoints[0]!.byteOffset).toBe(originalOffset);
    expect(canonical.tagFrame!.declaration.frameCount).toBe(originalDeclaredCount);
    expect(canonical.tagFrame!.declaration.gapless!.encoderDelaySamples).toBe(576);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.timeline)).toBe(true);
    expect(Object.isFrozen(canonical.seekPoints)).toBe(true);
    expect(canonical.seekPoints.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(canonical.tagFrame)).toBe(true);
    expect(Object.isFrozen(canonical.tagFrame!.declaration)).toBe(true);
    expect(Object.isFrozen(canonical.tagFrame!.declaration.gapless)).toBe(true);
  });

  it('rejects accessors, exotic prototypes, sparse or species-bearing arrays, and typed views', async () => {
    const { metadata } = await issuedMetadata(cbrBytes());
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);
    let getterReads = 0;
    const accessor = rawEvidence(evidence);
    Object.defineProperty(accessor, 'sourceSize', {
      enumerable: true,
      get() {
        getterReads += 1;
        return evidence.sourceSize;
      },
    });
    expect(() => createMp3DecoderTimelineEvidence(accessor)).toThrow(/data property/i);
    expect(getterReads).toBe(0);

    const nonPlain = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(nonPlain, rawEvidence(evidence));
    expect(() => createMp3DecoderTimelineEvidence(nonPlain)).toThrow(/prototype/i);

    const sparse = new Array<unknown>(evidence.seekPoints.length + 1);
    sparse[0] = { ...evidence.seekPoints[0]! };
    expect(() =>
      createMp3DecoderTimelineEvidence({ ...rawEvidence(evidence), seekPoints: sparse }),
    ).toThrow(/dense|data property/i);

    const species = evidence.seekPoints.map((point) => ({ ...point }));
    Object.defineProperty(species, Symbol.species, { value: Array });
    expect(() =>
      createMp3DecoderTimelineEvidence({ ...rawEvidence(evidence), seekPoints: species }),
    ).toThrow(/extra fields/i);

    const pointAccessor = evidence.seekPoints.map((point) => ({ ...point }));
    Object.defineProperty(pointAccessor, '0', {
      enumerable: true,
      get() {
        getterReads += 1;
        return evidence.seekPoints[0];
      },
    });
    expect(() =>
      createMp3DecoderTimelineEvidence({ ...rawEvidence(evidence), seekPoints: pointAccessor }),
    ).toThrow(/data property/i);
    expect(getterReads).toBe(0);

    const sharedView = new Uint8Array(new SharedArrayBuffer(8));
    expect(() =>
      createMp3DecoderTimelineEvidence({ ...rawEvidence(evidence), seekPoints: sharedView }),
    ).toThrow(/array/i);
  });

  it('rejects point-count, byte-geometry, and safe-integer overflow attacks', async () => {
    const { metadata } = await issuedMetadata(cbrBytes());
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        seekPoints: Array.from({ length: MP3_SEEK_INDEX_MAX_POINTS + 1 }, () => ({
          ...evidence.seekPoints[0]!,
        })),
      }),
    ).toThrow(/8,?192|8192/i);

    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        audioEndByteOffset: evidence.firstAudioFrameOffset + 1,
      }),
    ).toThrow(/span|frame count/i);

    const overflowingFrameCount =
      Math.floor(Number.MAX_SAFE_INTEGER / evidence.samplesPerFrame) + 1;
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...rawEvidence(evidence),
        sourceSize: Number.MAX_SAFE_INTEGER,
        audioEndByteOffset: Number.MAX_SAFE_INTEGER,
        audioFrameCount: overflowingFrameCount,
      }),
    ).toThrow(/safe-integer|raw samples/i);
  });

  it('creates byte-for-byte equivalent start, middle, and EOF-1 descriptors', async () => {
    const { source, metadata } = await issuedMetadata(cbrBytes());
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);
    const mediaFrames = [
      0,
      Math.floor(metadata.totalMediaFrames / 2),
      metadata.totalMediaFrames - 1,
    ];

    for (const mediaFrame of mediaFrames) {
      const legacy = createMp3DecoderDescriptor({
        metadata,
        sourceSize: source.size,
        sourceIdentity: source.identity,
        mediaFrame,
        outputSampleRate: 48_000,
        minimumWarmupFrames: 8,
      });
      const normalized = createMp3DecoderDescriptorFromTimelineEvidence({
        evidence,
        mediaFrame,
        outputSampleRate: 48_000,
        minimumWarmupFrames: 8,
      });
      expect(normalized).toEqual(legacy);
      expect(JSON.stringify(normalized)).toBe(JSON.stringify(legacy));
    }
  });

  it('accepts the same progressively enriched exact points on both planning paths', async () => {
    const { source, metadata } = await issuedMetadata(
      xingBytes(),
      `${SOURCE_IDENTITY}:progressive`,
    );
    const evidence = createMp3DecoderTimelineEvidenceFromMetadata(metadata);
    const header = metadata.firstAudioFrameHeader;
    const enriched = Array.from({ length: 12 }, (_, frameOrdinal) => ({
      rawSample: frameOrdinal * metadata.samplesPerFrame,
      byteOffset: metadata.firstAudioFrameOffset + frameOrdinal * header.frameLengthBytes,
      frameOrdinal,
      mainDataCapacityBytes: header.mainDataCapacityBytes,
      mainDataBeginBytes: frameOrdinal === 0 ? 0 : 16,
    }));
    const mediaFrame = 11 * metadata.samplesPerFrame + 17;

    const planning = rebuildMp3DecoderTimelinePlanningState({ evidence, seekPoints: enriched });
    expect(planning.seekPoints).toEqual(enriched);
    expect(
      createMp3DecoderDescriptorFromTimelineEvidence({
        evidence,
        seekPoints: enriched,
        mediaFrame,
      }),
    ).toEqual(
      createMp3DecoderDescriptor({
        metadata,
        sourceSize: source.size,
        sourceIdentity: source.identity,
        seekPoints: enriched,
        mediaFrame,
      }),
    );
  });
});
