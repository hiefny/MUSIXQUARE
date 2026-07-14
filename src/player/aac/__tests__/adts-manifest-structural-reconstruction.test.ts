import { describe, expect, it } from 'vitest';

import { sealAdtsFrameScanTimelineManifest } from '../../manifests/codec-timeline-manifest-seal.ts';
import type { AdtsAacLcTimelineManifest } from '../../manifests/codec-timeline-manifest.ts';
import {
  type EncodedRandomAccessSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  AdtsManifestStructuralReconstructionError,
  reconstructAdtsManifestStructure,
} from '../adts-manifest-structural-reconstruction.ts';
import { rebuildAacDecoderPlanningState } from '../decoder-helpers.ts';
import { createAdtsDecoderTimelineEvidenceFromScanResult } from '../decoder-timeline-evidence.ts';
import { type AdtsFrameScanResult, isScannerIssuedAdtsFrameScanResult } from '../frame-scanner.ts';
import { ADTS_MAX_FRAME_BYTES } from '../incremental-frame-reader.ts';

interface FrameOptions {
  readonly frameLengthBytes?: number;
  readonly sampleRateIndex?: number;
  readonly channelConfiguration?: number;
  readonly payloadByte?: number;
}

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

function makeFrame(options: FrameOptions = {}): Uint8Array {
  const frameLengthBytes = options.frameLengthBytes ?? 31;
  const sampleRateIndex = options.sampleRateIndex ?? 4;
  const channelConfiguration = options.channelConfiguration ?? 2;
  const bytes = new Uint8Array(frameLengthBytes).fill(options.payloadByte ?? 0x5a);
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = (1 << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100;
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

function pointsFor(frames: readonly Uint8Array[]): Array<{
  readonly frameOrdinal: number;
  readonly byteOffset: number;
}> {
  let byteOffset = 0;
  return frames.map((frame, frameOrdinal) => {
    const point = { frameOrdinal, byteOffset };
    byteOffset += frame.byteLength;
    return point;
  });
}

function manifestFor(
  frames: readonly Uint8Array[],
  patch: Partial<AdtsAacLcTimelineManifest> = {},
): AdtsAacLcTimelineManifest {
  const sourceSize = frames.reduce((total, frame) => total + frame.byteLength, 0);
  return {
    manifestVersion: 1,
    codec: 'adts-aac-lc',
    sourceBindingSha256: Array.from({ length: 32 }, (_, index) => index),
    sourceSize,
    audioStartByte: 0,
    audioEndByte: sourceSize,
    frameCount: frames.length,
    sampleRateHz: 44_100,
    samplesPerFrame: 1_024,
    channels: 2,
    mpegId: 0,
    profile: 1,
    audioObjectType: 2,
    sampleRateIndex: 4,
    channelConfiguration: 2,
    protectionAbsent: true,
    rawDataBlocks: 1,
    points: pointsFor(frames),
    ...patch,
  };
}

class MemorySource implements EncodedRandomAccessSource {
  readonly reads: ReadRecord[] = [];
  size: number;
  identity = 'source:adts-manifest-structure';
  closeCount = 0;
  shortRead = false;
  sharedRead = false;
  subclassRead = false;
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
    if (this.sharedRead) {
      const shared = new Uint8Array(new SharedArrayBuffer(Math.max(0, actualEnd - offset)));
      shared.set(this.bytes.subarray(offset, actualEnd));
      return shared;
    }
    if (this.subclassRead) {
      class ByteSubclass extends Uint8Array {}
      const result = new ByteSubclass(Math.max(0, actualEnd - offset));
      result.set(this.bytes.subarray(offset, actualEnd));
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
  manifest: Readonly<AdtsAacLcTimelineManifest>,
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

describe('ADTS manifest structural reconstruction', () => {
  it('cross-checks bounded endpoint frames and returns deeply frozen non-authority data', async () => {
    const frames = [
      makeFrame({ frameLengthBytes: 19, payloadByte: 0x11 }),
      makeFrame({ frameLengthBytes: 41, payloadByte: 0x22 }),
      makeFrame({ frameLengthBytes: 83, payloadByte: 0x33 }),
    ];
    const source = new MemorySource(concatenate(...frames));
    const result = await reconstructAdtsManifestStructure(options(source, manifestFor(frames)));

    expect(result).toEqual({
      evidenceKind: 'adts-manifest-structural-reconstruction',
      authority: 'none',
      sourceIdentity: source.identity,
      sourceSize: source.size,
      coreConfiguration: {
        mpegId: 0,
        profile: 1,
        coreAudioObjectType: 2,
        sampleRateIndex: 4,
        channelConfiguration: 2,
        protectionAbsent: true,
        rawDataBlocks: 1,
      },
      coreSampleRateHz: 44_100,
      coreChannelCount: 2,
      samplesPerFrame: 1_024,
      frameCount: 3,
      totalCoreSamples: 3_072,
      audioEndByteOffset: source.size,
      seekPoints: pointsFor(frames),
      endpointChecks: {
        firstFrameByteLength: 19,
        terminalFrameOrdinal: 2,
        terminalFrameByteOffset: 60,
        terminalFrameByteLength: 83,
      },
    });
    expect(source.reads).toHaveLength(2);
    expect(source.reads.every((read) => read.length <= ADTS_MAX_FRAME_BYTES)).toBe(true);
    expect(source.closeCount).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.coreConfiguration)).toBe(true);
    expect(Object.isFrozen(result.seekPoints)).toBe(true);
    expect(result.seekPoints.every((point) => Object.isFrozen(point))).toBe(true);
    expect(Object.isFrozen(result.endpointChecks)).toBe(true);
    expect(containsEncodedStorage(result)).toBe(false);
    expect('fullyVerifiedFrameSpan' in result).toBe(false);
    expect(isScannerIssuedAdtsFrameScanResult(result)).toBe(false);
  });

  it('uses one bounded read when the first frame is also terminal', async () => {
    const frames = [makeFrame({ frameLengthBytes: ADTS_MAX_FRAME_BYTES })];
    const source = new MemorySource(concatenate(...frames));
    const result = await reconstructAdtsManifestStructure(options(source, manifestFor(frames)));

    expect(source.reads).toEqual([{ offset: 0, length: ADTS_MAX_FRAME_BYTES }]);
    expect(result.endpointChecks).toEqual({
      firstFrameByteLength: ADTS_MAX_FRAME_BYTES,
      terminalFrameOrdinal: 0,
      terminalFrameByteOffset: 0,
      terminalFrameByteLength: ADTS_MAX_FRAME_BYTES,
    });
  });

  it('keeps a long structural probe to two reads of at most one maximum ADTS frame', async () => {
    const frames = [
      makeFrame({ frameLengthBytes: ADTS_MAX_FRAME_BYTES, payloadByte: 0x11 }),
      makeFrame({ frameLengthBytes: ADTS_MAX_FRAME_BYTES, payloadByte: 0x22 }),
      makeFrame({ frameLengthBytes: ADTS_MAX_FRAME_BYTES, payloadByte: 0x33 }),
    ];
    const source = new MemorySource(concatenate(...frames));
    await reconstructAdtsManifestStructure(options(source, manifestFor(frames)));

    expect(source.reads).toEqual([
      { offset: 0, length: ADTS_MAX_FRAME_BYTES },
      { offset: ADTS_MAX_FRAME_BYTES * 2, length: ADTS_MAX_FRAME_BYTES },
    ]);
  });

  it('copies a local Uint8Array subclass before parsing it', async () => {
    const frames = [makeFrame(), makeFrame()];
    const source = new MemorySource(concatenate(...frames));
    source.subclassRead = true;
    await expect(
      reconstructAdtsManifestStructure(options(source, manifestFor(frames))),
    ).resolves.toMatchObject({ frameCount: 2 });
  });

  it.each([
    ['a short transport page', (source: MemorySource) => (source.shortRead = true)],
    ['shared transport storage', (source: MemorySource) => (source.sharedRead = true)],
  ])('rejects %s', async (_label, mutate) => {
    const frames = [makeFrame(), makeFrame()];
    const source = new MemorySource(concatenate(...frames));
    mutate(source);
    await expect(
      reconstructAdtsManifestStructure(options(source, manifestFor(frames))),
    ).rejects.toThrow();
  });

  it.each([
    ['first', 0],
    ['terminal', 1],
  ])('rejects a %s-frame codec configuration mismatch', async (_label, mismatchedOrdinal) => {
    const frames = [makeFrame(), makeFrame()];
    frames[mismatchedOrdinal] = makeFrame({ sampleRateIndex: 3 });
    const source = new MemorySource(concatenate(...frames));
    await expect(
      reconstructAdtsManifestStructure(options(source, manifestFor(frames))),
    ).rejects.toThrow(/configuration|manifest/i);
  });

  it('rejects a terminal header whose declared frame ends before physical EOF', async () => {
    const first = makeFrame({ frameLengthBytes: 31 });
    const terminal = makeFrame({ frameLengthBytes: 30 });
    const bytes = concatenate(first, terminal, Uint8Array.of(0xaa));
    const source = new MemorySource(bytes);
    const declaredFrames = [first, new Uint8Array(31)];
    await expect(
      reconstructAdtsManifestStructure(options(source, manifestFor(declaredFrames))),
    ).rejects.toThrow(/physical EOF/i);
  });

  it('rejects an actual first frame that overlaps the terminal manifest point', async () => {
    const bytes = new Uint8Array(28).fill(0x55);
    bytes.set(makeFrame({ frameLengthBytes: 20 }), 0);
    bytes.set(makeFrame({ frameLengthBytes: 8 }), 20);
    const source = new MemorySource(bytes);
    const manifest = manifestFor([new Uint8Array(20), new Uint8Array(8)], {
      points: [
        { frameOrdinal: 0, byteOffset: 0 },
        { frameOrdinal: 1, byteOffset: 16 },
      ],
    });
    await expect(reconstructAdtsManifestStructure(options(source, manifest))).rejects.toThrow(
      /overlap/i,
    );
  });

  it('rejects a retained second-frame point that contradicts the first actual frame end', async () => {
    const frames = [
      makeFrame({ frameLengthBytes: 20 }),
      makeFrame({ frameLengthBytes: 20 }),
      makeFrame({ frameLengthBytes: 20 }),
    ];
    const source = new MemorySource(concatenate(...frames));
    const manifest = manifestFor(frames, {
      points: [
        { frameOrdinal: 0, byteOffset: 0 },
        { frameOrdinal: 1, byteOffset: 19 },
        { frameOrdinal: 2, byteOffset: 40 },
      ],
    });
    await expect(reconstructAdtsManifestStructure(options(source, manifest))).rejects.toThrow(
      /first frame end/i,
    );
  });

  it('rejects source-size disagreement before any read', async () => {
    const frames = [makeFrame()];
    const source = new MemorySource(concatenate(...frames));
    const manifest = manifestFor(frames, {
      sourceSize: source.size + 8,
      audioEndByte: source.size + 8,
    });
    await expect(reconstructAdtsManifestStructure(options(source, manifest))).rejects.toThrow(
      /sourceSize/i,
    );
    expect(source.reads).toHaveLength(0);
  });

  it('rejects noncanonical manifests and non-data-only options without reading', async () => {
    const frames = [makeFrame()];
    const source = new MemorySource(concatenate(...frames));
    const manifest = { ...manifestFor(frames), extra: true };
    await expect(
      reconstructAdtsManifestStructure(
        options(source, manifest as unknown as AdtsAacLcTimelineManifest),
      ),
    ).rejects.toThrow(/canonical/i);
    expect(source.reads).toHaveLength(0);

    const accessorOptions = Object.defineProperty(
      { manifest: manifestFor(frames), signal: signal() },
      'source',
      { enumerable: true, get: () => source },
    );
    await expect(
      reconstructAdtsManifestStructure(
        accessorOptions as unknown as Parameters<typeof reconstructAdtsManifestStructure>[0],
      ),
    ).rejects.toThrow(/enumerable data property/i);

    const nonEnumerableOptions = Object.defineProperty(
      { manifest: manifestFor(frames), source },
      'signal',
      { enumerable: false, value: signal() },
    );
    await expect(
      reconstructAdtsManifestStructure(
        nonEnumerableOptions as unknown as Parameters<typeof reconstructAdtsManifestStructure>[0],
      ),
    ).rejects.toThrow(/enumerable data property/i);
  });

  it('propagates abort and rejects discoverable source mutation across a read', async () => {
    const frames = [makeFrame(), makeFrame()];
    const abortSource = new MemorySource(concatenate(...frames));
    const controller = new AbortController();
    const reason = new Error('stop ADTS endpoint reconstruction');
    abortSource.onRead = () => controller.abort(reason);
    await expect(
      reconstructAdtsManifestStructure(
        options(abortSource, manifestFor(frames), controller.signal),
      ),
    ).rejects.toBe(reason);

    const mutatingSource = new MemorySource(concatenate(...frames));
    mutatingSource.onRead = (current) => {
      current.identity = 'source:changed-mid-read';
    };
    await expect(
      reconstructAdtsManifestStructure(options(mutatingSource, manifestFor(frames))),
    ).rejects.toThrow(/identity changed/i);
  });

  it('cannot be reused as scanner-issued seal or current decoder-helper authority', async () => {
    const frames = [makeFrame(), makeFrame()];
    const source = new MemorySource(concatenate(...frames));
    const result = await reconstructAdtsManifestStructure(options(source, manifestFor(frames)));

    expect(() => sealAdtsFrameScanTimelineManifest(result, new Uint8Array(32))).toThrow(
      /exact scanner-issued/i,
    );
    expect(() => rebuildAacDecoderPlanningState(result as unknown as AdtsFrameScanResult)).toThrow(
      /canonical|complete physical frame span/i,
    );
    expect(() =>
      createAdtsDecoderTimelineEvidenceFromScanResult(
        result as unknown as Readonly<AdtsFrameScanResult>,
      ),
    ).toThrow(/exact scanner-issued result/i);
    expect(result).not.toHaveProperty('manifestSeal');
  });
});
