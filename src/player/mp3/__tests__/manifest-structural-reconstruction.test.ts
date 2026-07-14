import { describe, expect, it } from 'vitest';

import { sealMp3MetadataTimelineManifest } from '../../manifests/codec-timeline-manifest-seal.ts';
import type { Mp3NoFrameCountTimelineManifest } from '../../manifests/codec-timeline-manifest.ts';
import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  createMp3DecoderDescriptorFromTimelineEvidence,
  createMp3DecoderTimelineEvidenceFromManifestReconstruction,
} from '../decoder-helpers.ts';
import {
  createMp3DecoderTimelineEvidence,
  type Mp3DecoderTimelineEvidence,
} from '../decoder-timeline-evidence.ts';
import { parseMpegLayer3FrameHeader } from '../frame-header.ts';
import { scannerIssuedMp3MetadataSource } from '../metadata.ts';
import {
  MP3_MANIFEST_RECONSTRUCTION_MAX_PREFIX_FRAMES,
  MP3_MANIFEST_RECONSTRUCTION_MAX_SINGLE_READ_BYTES,
  MP3_MANIFEST_RECONSTRUCTION_MAX_SOURCE_READS,
  MP3_MANIFEST_RECONSTRUCTION_MAX_TOTAL_READ_BYTES,
  reconstructMp3ManifestStructure,
} from '../manifest-structural-reconstruction.ts';
import { createMp3SampleTimeline } from '../timeline.ts';

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

interface Scenario {
  readonly bytes: Uint8Array;
  readonly manifest: Mp3NoFrameCountTimelineManifest;
  readonly audioOffsets: readonly number[];
}

type TagKind = 'none' | 'xing' | 'info' | 'xing-count' | 'info-count' | 'vbri';

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function setUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value;
}

function setUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value / 0x1_00_00_00;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function makeFrame(fill = 0, mainDataBeginBytes = 0): Uint8Array {
  const headerBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const bytes = new Uint8Array(header.frameLengthBytes).fill(fill);
  bytes.set(headerBytes);
  bytes[4] = mainDataBeginBytes >>> 1;
  bytes[5] = (mainDataBeginBytes & 1) << 7;
  return bytes;
}

function writeXing(
  frame: Uint8Array,
  identifier: 'Xing' | 'Info',
  streamBytes: number | null,
  frameCount: number | null,
): void {
  const header = parseMpegLayer3FrameHeader(frame.subarray(0, 4));
  const offset = 4 + header.sideInfoBytes;
  setAscii(frame, offset, identifier);
  const flags = (frameCount === null ? 0 : 1) | (streamBytes === null ? 0 : 2);
  setUint32(frame, offset + 4, flags);
  let cursor = offset + 8;
  if (frameCount !== null) {
    setUint32(frame, cursor, frameCount);
    cursor += 4;
  }
  if (streamBytes !== null) setUint32(frame, cursor, streamBytes);
}

function writeVbri(frame: Uint8Array, streamBytes: number, frameCount: number): void {
  const offset = 36;
  setAscii(frame, offset, 'VBRI');
  setUint16(frame, offset + 4, 1);
  setUint16(frame, offset + 6, 0);
  setUint16(frame, offset + 8, 0);
  setUint32(frame, offset + 10, streamBytes);
  setUint32(frame, offset + 14, frameCount);
  setUint16(frame, offset + 18, 1);
  setUint16(frame, offset + 20, 1);
  setUint16(frame, offset + 22, 2);
  setUint16(frame, offset + 24, frameCount);
  setUint16(frame, offset + 26, streamBytes);
}

function leadingId3(): Uint8Array {
  return Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0);
}

function trailingId3v1(): Uint8Array {
  const bytes = new Uint8Array(128);
  setAscii(bytes, 0, 'TAG');
  return bytes;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function makeScenario(
  options: {
    readonly audioFrameCount?: number;
    readonly declareStreamBytes?: boolean;
    readonly leading?: boolean;
    readonly tagKind?: TagKind;
    readonly trailing?: boolean;
  } = {},
): Scenario {
  const audioFrameCount = options.audioFrameCount ?? 8;
  const leading = options.leading === false ? new Uint8Array(0) : leadingId3();
  const trailing = options.trailing === false ? new Uint8Array(0) : trailingId3v1();
  const tagKind = options.tagKind ?? 'xing';
  const tag = tagKind === 'none' ? null : makeFrame(0, 0);
  const audioFrames = Array.from({ length: audioFrameCount }, (_, index) =>
    makeFrame(index + 1, index === 0 ? 0 : Math.min(16 + index, 511)),
  );
  const id3FreeBytes =
    (tag?.byteLength ?? 0) + audioFrames.reduce((total, frame) => total + frame.byteLength, 0);
  if (tag) {
    if (tagKind === 'vbri') {
      writeVbri(tag, id3FreeBytes, audioFrameCount);
    } else {
      writeXing(
        tag,
        tagKind === 'info' || tagKind === 'info-count' ? 'Info' : 'Xing',
        options.declareStreamBytes === false ? null : id3FreeBytes,
        tagKind === 'xing-count' || tagKind === 'info-count' ? audioFrameCount : null,
      );
    }
  }

  const dataStart = leading.byteLength;
  const audioStartByte = dataStart + (tag?.byteLength ?? 0);
  const audioOffsets: number[] = [];
  let cursor = audioStartByte;
  const header = parseMpegLayer3FrameHeader(audioFrames[0]!.subarray(0, 4));
  const points = audioFrames.map((frame, frameOrdinal) => {
    audioOffsets.push(cursor);
    const point = {
      frameOrdinal,
      byteOffset: cursor,
      mainDataCapacityBytes: header.mainDataCapacityBytes,
      mainDataBeginBytes: frameOrdinal === 0 ? 0 : Math.min(16 + frameOrdinal, 511),
    };
    cursor += frame.byteLength;
    return point;
  });
  const audioEndByte = cursor;
  const bytes = concatenate(leading, ...(tag ? [tag] : []), ...audioFrames, trailing);
  const totalRawSamples = audioFrameCount * 1_152;
  const manifest: Mp3NoFrameCountTimelineManifest = {
    manifestVersion: 1,
    codec: 'mp3-no-frame-count',
    sourceBindingSha256: Array.from({ length: 32 }, (_, index) => index),
    sourceSize: bytes.byteLength,
    audioStartByte,
    audioEndByte,
    frameCount: audioFrameCount,
    sampleRateHz: 44_100,
    samplesPerFrame: 1_152,
    channels: 2,
    mpegVersion: '1',
    layer: 3,
    hasFrameCountDeclaration: false,
    hasTagFrame: tag !== null,
    tagFrameBytes: tag?.byteLength ?? 0,
    gapless: null,
    totalMediaFrames: createMp3SampleTimeline({
      totalRawSamples,
      samplesPerFrame: 1_152,
      gapless: null,
    }).totalMediaFrames,
    points,
  };
  return Object.freeze({ bytes, manifest, audioOffsets: Object.freeze(audioOffsets) });
}

class MemorySource implements EncodedRandomAccessSource {
  readonly reads: ReadRecord[] = [];
  size: number;
  identity = 'source:mp3-manifest-structure';
  closeCount = 0;
  shortRead = false;
  sharedRead = false;
  subclassRead = false;
  invalidRead = false;
  onRead: ((source: MemorySource) => void | Promise<void>) | null = null;

  constructor(readonly bytes: Uint8Array) {
    this.size = bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    await this.onRead?.(this);
    throwIfAborted(signal);
    const actualEnd = end - (this.shortRead && length > 0 ? 1 : 0);
    if (this.invalidRead) return {} as Uint8Array;
    if (this.sharedRead) {
      const shared = new Uint8Array(new SharedArrayBuffer(Math.max(0, actualEnd - offset)));
      shared.set(this.bytes.subarray(offset, actualEnd));
      return shared;
    }
    if (this.subclassRead) {
      class HostileByteSubclass extends Uint8Array {
        override set(): void {
          throw new Error('subclass set must not be called');
        }
      }
      const result = new HostileByteSubclass(Math.max(0, actualEnd - offset));
      Uint8Array.prototype.set.call(result, this.bytes.subarray(offset, actualEnd));
      return result;
    }
    return this.bytes.slice(offset, actualEnd);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function options(
  source: EncodedRandomAccessSource,
  manifest: Readonly<Mp3NoFrameCountTimelineManifest>,
  abortSignal: AbortSignal = signal(),
) {
  return { manifest, signal: abortSignal, source } as const;
}

function containsEncodedStorage(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((nested) => containsEncodedStorage(nested, seen));
}

function mutableEvidence(evidence: Readonly<Mp3DecoderTimelineEvidence>): Record<string, unknown> {
  return {
    ...evidence,
    tagFrame: evidence.tagFrame
      ? {
          ...evidence.tagFrame,
          declaration: { ...evidence.tagFrame.declaration, gapless: null },
        }
      : null,
    timeline: { ...evidence.timeline },
    manifestEndpointEvidence: evidence.manifestEndpointEvidence
      ? {
          ...evidence.manifestEndpointEvidence,
          tagDeclaration: evidence.manifestEndpointEvidence.tagDeclaration
            ? { ...evidence.manifestEndpointEvidence.tagDeclaration, gapless: null }
            : null,
        }
      : null,
    seekPoints: evidence.seekPoints.map((point) => ({ ...point })),
  };
}

describe('MP3 no-frame-count manifest structural reconstruction', () => {
  it('validates ID3, tag, four audio-prefix frames, and the terminal frame as non-authority', async () => {
    const scenario = makeScenario();
    const source = new MemorySource(scenario.bytes);
    const result = await reconstructMp3ManifestStructure(options(source, scenario.manifest));

    expect(result).toMatchObject({
      evidenceKind: 'mp3-manifest-structural-reconstruction',
      authority: 'none',
      sourceIdentity: source.identity,
      sourceSize: source.size,
      id3Geometry: {
        dataStart: 10,
        audioEnd: scenario.manifest.audioEndByte,
        leadingTagCount: 1,
        trailingTagCount: 0,
        hasTrailingId3v1: true,
        trailingId3v1Offset: scenario.manifest.audioEndByte,
      },
      version: '1',
      sampleRateHz: 44_100,
      channels: 2,
      samplesPerFrame: 1_152,
      hasTagFrame: true,
      tagFrameOffset: 10,
      tagFrameBytes: 417,
      gapless: null,
      firstAudioFrameOffset: scenario.manifest.audioStartByte,
      audioEndByteOffset: scenario.manifest.audioEndByte,
      audioFrameCount: 8,
      totalRawSamples: 8 * 1_152,
      totalMediaFrames: scenario.manifest.totalMediaFrames,
      endpointChecks: {
        tagDeclaration: {
          kind: 'xing',
          frameCount: null,
          streamBytes: scenario.manifest.audioEndByte - 10,
          gapless: null,
        },
        verifiedPrefixFrameCount: MP3_MANIFEST_RECONSTRUCTION_MAX_PREFIX_FRAMES,
        verifiedPrefixByteEnd: scenario.audioOffsets[4],
        terminalFrameOrdinal: 7,
        terminalFrameByteOffset: scenario.audioOffsets[7],
        terminalFrameByteLength: 417,
      },
    });
    expect(result.seekPoints).toEqual(
      scenario.manifest.points.map((point) => ({
        ...point,
        rawSample: point.frameOrdinal * 1_152,
      })),
    );
    expect(source.reads.length).toBeLessThanOrEqual(MP3_MANIFEST_RECONSTRUCTION_MAX_SOURCE_READS);
    expect(
      source.reads.every(
        (read) => read.length <= MP3_MANIFEST_RECONSTRUCTION_MAX_SINGLE_READ_BYTES,
      ),
    ).toBe(true);
    expect(source.reads.reduce((total, read) => total + read.length, 0)).toBeLessThanOrEqual(
      MP3_MANIFEST_RECONSTRUCTION_MAX_TOTAL_READ_BYTES,
    );
    expect(source.closeCount).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.id3Geometry)).toBe(true);
    expect(Object.isFrozen(result.firstAudioFrameHeader)).toBe(true);
    expect(Object.isFrozen(result.seekPoints)).toBe(true);
    expect(result.seekPoints.every((point) => Object.isFrozen(point))).toBe(true);
    expect(Object.isFrozen(result.endpointChecks)).toBe(true);
    expect(Object.isFrozen(result.endpointChecks.tagDeclaration)).toBe(true);
    expect(containsEncodedStorage(result)).toBe(false);
    expect(result).not.toHaveProperty('fullyVerifiedFrameSpan');
    expect(result).not.toHaveProperty('frameCountEvidence');
    expect(scannerIssuedMp3MetadataSource(result)).toBeNull();
    expect(() => sealMp3MetadataTimelineManifest(result, new Uint8Array(32))).toThrow(
      /exact scanner-issued/i,
    );
    expect(() => createMp3DecoderTimelineEvidence(result)).toThrow(/missing|unsupported/i);
  });

  it('converts admitted sparse anchors into non-authority decoder planning evidence', async () => {
    const scenario = makeScenario({ audioFrameCount: 600 });
    const sparseManifest: Mp3NoFrameCountTimelineManifest = {
      ...scenario.manifest,
      points: [
        scenario.manifest.points[0]!,
        scenario.manifest.points[60]!,
        scenario.manifest.points[599]!,
      ],
    };
    const source = new MemorySource(scenario.bytes);
    const reconstruction = await reconstructMp3ManifestStructure(options(source, sparseManifest));
    const readsAfterReconstruction = source.reads.length;
    const evidence = createMp3DecoderTimelineEvidenceFromManifestReconstruction(reconstruction);

    expect(evidence).toMatchObject({
      format: 'mp3-decoder-timeline',
      authority: 'none',
      provenanceKind: 'admitted-manifest',
      sourceIdentity: reconstruction.sourceIdentity,
      sourceSize: reconstruction.sourceSize,
      frameCountEvidence: 'admitted-manifest',
      fullyVerifiedFrameSpan: false,
      verifiedAudioFrameCount: MP3_MANIFEST_RECONSTRUCTION_MAX_PREFIX_FRAMES,
      verifiedAudioBytes:
        reconstruction.endpointChecks.verifiedPrefixByteEnd - reconstruction.firstAudioFrameOffset,
      timeline: {
        totalRawSamples: reconstruction.totalRawSamples,
        totalMediaFrames: reconstruction.totalMediaFrames,
      },
      manifestEndpointEvidence: reconstruction.endpointChecks,
    });
    expect(evidence.seekPoints.map((point) => point.frameOrdinal)).toEqual([0, 60, 599]);
    expect(Object.isFrozen(evidence.manifestEndpointEvidence)).toBe(true);
    expect(Object.isFrozen(evidence.manifestEndpointEvidence?.tagDeclaration)).toBe(true);
    expect(containsEncodedStorage(evidence)).toBe(false);
    expect(source.reads).toHaveLength(readsAfterReconstruction);
    expect(source.closeCount).toBe(0);
    expect(evidence).not.toHaveProperty('admission');
    expect(evidence).not.toHaveProperty('lease');
    expect(scannerIssuedMp3MetadataSource(evidence)).toBeNull();
    expect(() => sealMp3MetadataTimelineManifest(evidence, new Uint8Array(32))).toThrow(
      /exact scanner-issued/i,
    );

    const descriptor = createMp3DecoderDescriptorFromTimelineEvidence({
      evidence,
      mediaFrame: 580 * evidence.samplesPerFrame + 17,
      minimumWarmupFrames: 0,
    });
    expect(descriptor.startPlan).toMatchObject({
      audioFrameOrdinal: 580,
      scanAnchorFrameOrdinal: 60,
      scanAnchorByteOffset: scenario.audioOffsets[60],
    });
  });

  it('cross-checks admitted provenance, exact prefix, tag, and terminal endpoint capsules', async () => {
    const scenario = makeScenario();
    const reconstruction = await reconstructMp3ManifestStructure(
      options(new MemorySource(scenario.bytes), scenario.manifest),
    );
    const evidence = createMp3DecoderTimelineEvidenceFromManifestReconstruction(reconstruction);
    const raw = mutableEvidence(evidence);

    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...raw,
        provenanceKind: 'scanner',
      }),
    ).toThrow(/scanner provenance/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...raw,
        frameCountEvidence: 'verified-scan',
      }),
    ).toThrow(/admitted-manifest provenance/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...raw,
        fullyVerifiedFrameSpan: true,
      }),
    ).toThrow(/admitted-manifest provenance/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...raw,
        verifiedAudioFrameCount: evidence.verifiedAudioFrameCount - 1,
      }),
    ).toThrow(/prefix frame count/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...raw,
        manifestEndpointEvidence: {
          ...evidence.manifestEndpointEvidence!,
          tagDeclaration: null,
        },
      }),
    ).toThrow(/declaration/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...raw,
        manifestEndpointEvidence: {
          ...evidence.manifestEndpointEvidence!,
          terminalFrameByteOffset: evidence.manifestEndpointEvidence!.terminalFrameByteOffset - 1,
        },
      }),
    ).toThrow(/terminal endpoint/i);
    expect(() =>
      createMp3DecoderTimelineEvidence({
        ...raw,
        seekPoints: evidence.seekPoints.slice(0, -1),
      }),
    ).toThrow(/terminal endpoint/i);
  });

  it('supports a tag-free one-frame stream and reuses the prefix as its terminal check', async () => {
    const scenario = makeScenario({
      audioFrameCount: 1,
      leading: false,
      tagKind: 'none',
      trailing: false,
    });
    const source = new MemorySource(scenario.bytes);
    const result = await reconstructMp3ManifestStructure(options(source, scenario.manifest));

    expect(result).toMatchObject({
      hasTagFrame: false,
      tagFrameOffset: null,
      tagFrameBytes: 0,
      endpointChecks: {
        tagDeclaration: null,
        verifiedPrefixFrameCount: 1,
        verifiedPrefixByteEnd: source.size,
        terminalFrameOrdinal: 0,
        terminalFrameByteOffset: 0,
      },
    });
    expect(source.reads.filter((read) => read.offset === 0 && read.length === 4)).toHaveLength(1);
    expect(source.closeCount).toBe(0);
    expect(createMp3DecoderTimelineEvidenceFromManifestReconstruction(result)).toMatchObject({
      provenanceKind: 'admitted-manifest',
      tagFrame: null,
      verifiedAudioFrameCount: 1,
      verifiedAudioBytes: source.size,
      manifestEndpointEvidence: {
        tagDeclaration: null,
        terminalFrameOrdinal: 0,
        terminalFrameByteOffset: 0,
      },
    });
  });

  it.each([
    ['info', true, expect.any(Number)],
    ['xing', true, expect.any(Number)],
    ['xing', false, null],
  ] as const)(
    'preserves the actual %s no-count declaration (stream bytes: %s)',
    async (kind, declareStreamBytes, expectedStreamBytes) => {
      const scenario = makeScenario({ tagKind: kind, declareStreamBytes });
      const source = new MemorySource(scenario.bytes);
      const result = await reconstructMp3ManifestStructure(options(source, scenario.manifest));
      expect(result.endpointChecks.tagDeclaration).toEqual({
        kind,
        frameCount: null,
        streamBytes: expectedStreamBytes,
        gapless: null,
      });
    },
  );

  it.each([
    ['Xing frame count', 'xing-count' as const],
    ['Info frame count', 'info-count' as const],
    ['VBRI frame count', 'vbri' as const],
  ])('rejects an actual %s declaration on the no-count route', async (_label, tagKind) => {
    const scenario = makeScenario({ tagKind });
    await expect(
      reconstructMp3ManifestStructure(options(new MemorySource(scenario.bytes), scenario.manifest)),
    ).rejects.toThrow(/frame-count declaration/i);
  });

  it('rejects untrusted gapless fields before reading the source', async () => {
    const scenario = makeScenario();
    const source = new MemorySource(scenario.bytes);
    const gapless = { encoderDelaySamples: 100, endPaddingSamples: 200 } as const;
    const manifest: Mp3NoFrameCountTimelineManifest = {
      ...scenario.manifest,
      gapless,
      totalMediaFrames: createMp3SampleTimeline({
        totalRawSamples: scenario.manifest.frameCount * 1_152,
        samplesPerFrame: 1_152,
        gapless,
      }).totalMediaFrames,
    };
    await expect(reconstructMp3ManifestStructure(options(source, manifest))).rejects.toThrow(
      /gapless metadata to be null/i,
    );
    expect(source.reads).toHaveLength(0);
  });

  it('rejects an initial source-size mismatch before any byte read', async () => {
    const scenario = makeScenario();
    const source = new MemorySource(scenario.bytes);
    source.size += 1;
    await expect(
      reconstructMp3ManifestStructure(options(source, scenario.manifest)),
    ).rejects.toThrow(/sourceSize/i);
    expect(source.reads).toHaveLength(0);
  });

  it('rejects an undeclared structural tag in audio frame zero', async () => {
    const scenario = makeScenario({ tagKind: 'none', leading: false, trailing: false });
    writeXing(scenario.bytes, 'Xing', scenario.bytes.byteLength, null);
    await expect(
      reconstructMp3ManifestStructure(options(new MemorySource(scenario.bytes), scenario.manifest)),
    ).rejects.toThrow(/undeclared.*tag/i);
  });

  it('rejects ID3 and Xing stream-byte geometry contradictions', async () => {
    const id3Scenario = makeScenario();
    id3Scenario.bytes[0] = 0;
    await expect(
      reconstructMp3ManifestStructure(
        options(new MemorySource(id3Scenario.bytes), id3Scenario.manifest),
      ),
    ).rejects.toThrow(/ID3 boundaries/i);

    const streamScenario = makeScenario();
    const tagOffset = 10;
    const tag = streamScenario.bytes.subarray(tagOffset, tagOffset + 417);
    writeXing(tag, 'Xing', streamScenario.manifest.audioEndByte - tagOffset - 1, null);
    await expect(
      reconstructMp3ManifestStructure(
        options(new MemorySource(streamScenario.bytes), streamScenario.manifest),
      ),
    ).rejects.toThrow(/stream-byte declaration/i);
  });

  it('rejects prefix and terminal retained-point byte contradictions', async () => {
    const prefixScenario = makeScenario();
    const prefixSideInfo = prefixScenario.audioOffsets[1]! + 4;
    prefixScenario.bytes[prefixSideInfo] = 0;
    prefixScenario.bytes[prefixSideInfo + 1] = 0;
    await expect(
      reconstructMp3ManifestStructure(
        options(new MemorySource(prefixScenario.bytes), prefixScenario.manifest),
      ),
    ).rejects.toThrow(/Prefix frame 1.*retained manifest point/i);

    const terminalScenario = makeScenario();
    const terminalSideInfo = terminalScenario.audioOffsets[7]! + 4;
    terminalScenario.bytes[terminalSideInfo] = 0;
    terminalScenario.bytes[terminalSideInfo + 1] = 0;
    await expect(
      reconstructMp3ManifestStructure(
        options(new MemorySource(terminalScenario.bytes), terminalScenario.manifest),
      ),
    ).rejects.toThrow(/Terminal frame.*retained manifest point/i);
  });

  it('anchors sparse post-prefix geometry to the actual fourth-frame end', async () => {
    const actual = makeScenario({
      audioFrameCount: 5,
      leading: false,
      tagKind: 'none',
      trailing: false,
    });
    const terminal = actual.manifest.points[4]!;
    const declaredFrameCount = 6;
    const manifest: Mp3NoFrameCountTimelineManifest = {
      ...actual.manifest,
      frameCount: declaredFrameCount,
      totalMediaFrames: createMp3SampleTimeline({
        totalRawSamples: declaredFrameCount * 1_152,
        samplesPerFrame: 1_152,
        gapless: null,
      }).totalMediaFrames,
      points: [actual.manifest.points[0]!, { ...terminal, frameOrdinal: declaredFrameCount - 1 }],
    };
    await expect(
      reconstructMp3ManifestStructure(options(new MemorySource(actual.bytes), manifest)),
    ).rejects.toThrow(/retained point geometry.*verified prefix/i);

    const fourActualFrames = makeScenario({
      audioFrameCount: 4,
      leading: false,
      tagKind: 'none',
      trailing: false,
    });
    const phantomFrameCount = 5;
    const phantomManifest: Mp3NoFrameCountTimelineManifest = {
      ...fourActualFrames.manifest,
      frameCount: phantomFrameCount,
      totalMediaFrames: createMp3SampleTimeline({
        totalRawSamples: phantomFrameCount * 1_152,
        samplesPerFrame: 1_152,
        gapless: null,
      }).totalMediaFrames,
      points: [
        fourActualFrames.manifest.points[0]!,
        { ...fourActualFrames.manifest.points[3]!, frameOrdinal: phantomFrameCount - 1 },
      ],
    };
    await expect(
      reconstructMp3ManifestStructure(
        options(new MemorySource(fourActualFrames.bytes), phantomManifest),
      ),
    ).rejects.toThrow(/next retained|prefix consumes.*middle and terminal/i);

    const sparse = makeScenario({
      audioFrameCount: 8,
      leading: false,
      tagKind: 'none',
      trailing: false,
    });
    const forgedMiddle = {
      ...sparse.manifest.points[4]!,
      frameOrdinal: 5,
    };
    const sparseManifest: Mp3NoFrameCountTimelineManifest = {
      ...sparse.manifest,
      points: [sparse.manifest.points[0]!, forgedMiddle, sparse.manifest.points[7]!],
    };
    await expect(
      reconstructMp3ManifestStructure(options(new MemorySource(sparse.bytes), sparseManifest)),
    ).rejects.toThrow(/retained point geometry.*verified prefix/i);
  });

  it.each([
    ['a short read', (source: MemorySource) => (source.shortRead = true)],
    ['shared storage', (source: MemorySource) => (source.sharedRead = true)],
    ['a non-byte value', (source: MemorySource) => (source.invalidRead = true)],
  ])('rejects %s from the transport', async (_label, mutate) => {
    const scenario = makeScenario();
    const source = new MemorySource(scenario.bytes);
    mutate(source);
    await expect(
      reconstructMp3ManifestStructure(options(source, scenario.manifest)),
    ).rejects.toThrow();
    expect(source.closeCount).toBe(0);
  });

  it('copies a Uint8Array subclass without calling hostile prototype methods', async () => {
    const scenario = makeScenario();
    const source = new MemorySource(scenario.bytes);
    source.subclassRead = true;
    await expect(
      reconstructMp3ManifestStructure(options(source, scenario.manifest)),
    ).resolves.toMatchObject({ audioFrameCount: 8 });
  });

  it('propagates abort and rejects dynamic source binding across a read', async () => {
    const scenario = makeScenario();
    const abortSource = new MemorySource(scenario.bytes);
    const controller = new AbortController();
    const reason = new Error('stop MP3 structural reconstruction');
    abortSource.onRead = () => controller.abort(reason);
    await expect(
      reconstructMp3ManifestStructure(options(abortSource, scenario.manifest, controller.signal)),
    ).rejects.toBe(reason);

    const mutatingSource = new MemorySource(scenario.bytes);
    mutatingSource.onRead = (current) => {
      current.identity = 'source:changed-during-read';
    };
    await expect(
      reconstructMp3ManifestStructure(options(mutatingSource, scenario.manifest)),
    ).rejects.toThrow(/identity changed/i);

    const resizingSource = new MemorySource(scenario.bytes);
    resizingSource.onRead = (current) => {
      current.size += 1;
    };
    await expect(
      reconstructMp3ManifestStructure(options(resizingSource, scenario.manifest)),
    ).rejects.toThrow(/size changed/i);
  });

  it('rejects hostile option and manifest prototypes before source reads', async () => {
    const scenario = makeScenario();
    const source = new MemorySource(scenario.bytes);
    const hostileOptions = Object.assign(
      Object.create({ inherited: true }),
      options(source, scenario.manifest),
    );
    await expect(
      reconstructMp3ManifestStructure(
        hostileOptions as Parameters<typeof reconstructMp3ManifestStructure>[0],
      ),
    ).rejects.toThrow(/exact plain record/i);

    const hostileManifest = Object.assign(Object.create({ inherited: true }), scenario.manifest);
    await expect(
      reconstructMp3ManifestStructure(
        options(source, hostileManifest as Mp3NoFrameCountTimelineManifest),
      ),
    ).rejects.toThrow(/plain or null prototype/i);

    const accessorOptions = Object.defineProperty(
      { manifest: scenario.manifest, signal: signal() },
      'source',
      { enumerable: true, get: () => source },
    );
    await expect(
      reconstructMp3ManifestStructure(
        accessorOptions as Parameters<typeof reconstructMp3ManifestStructure>[0],
      ),
    ).rejects.toThrow(/enumerable data field/i);

    const accessorManifest = { ...scenario.manifest };
    Object.defineProperty(accessorManifest, 'frameCount', {
      enumerable: true,
      get: () => scenario.manifest.frameCount,
    });
    await expect(
      reconstructMp3ManifestStructure(
        options(source, accessorManifest as Mp3NoFrameCountTimelineManifest),
      ),
    ).rejects.toThrow(/canonical/i);
    expect(source.reads).toHaveLength(0);
  });
});
