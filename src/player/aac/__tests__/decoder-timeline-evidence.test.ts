import { describe, expect, it, vi } from 'vitest';

import { sealAdtsFrameScanTimelineManifest } from '../../manifests/codec-timeline-manifest-seal.ts';
import {
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  createAacDecoderDescriptor,
  createAacDecoderDescriptorFromTimelineEvidence,
  rebuildAacDecoderTimelinePlanningState,
} from '../decoder-helpers.ts';
import {
  createAdtsDecoderTimelineEvidence,
  createAdtsDecoderTimelineEvidenceFromManifestReconstruction,
  createAdtsDecoderTimelineEvidenceFromScanResult,
  type AdtsDecoderTimelineEvidence,
} from '../decoder-timeline-evidence.ts';
import type { AdtsManifestStructuralReconstruction } from '../adts-manifest-structural-reconstruction.ts';
import {
  isScannerIssuedAdtsFrameScanResult,
  scanAdtsFrames,
  type AdtsFrameScanResult,
} from '../frame-scanner.ts';
import { createAdtsCoreTimeline } from '../timeline.ts';

const SOURCE_IDENTITY = 'source:adts-decoder-timeline-evidence';

function adtsFrame(byteLength: number, payload: number): Uint8Array {
  const bytes = new Uint8Array(byteLength).fill(payload);
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = 0x50;
  bytes[3] = 0x80 | ((byteLength >>> 11) & 0x03);
  bytes[4] = (byteLength >>> 3) & 0xff;
  bytes[5] = ((byteLength & 0x07) << 5) | 0x1f;
  bytes[6] = 0xfc;
  return bytes;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly identity = SOURCE_IDENTITY;
  readonly metadata = Object.freeze({ name: 'fixture.aac', mime: 'audio/aac' });
  readonly readAt = vi.fn(
    async (offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> => {
      const end = validateExactRead(this.size, offset, length);
      throwIfAborted(signal);
      return this.bytes.slice(offset, end);
    },
  );
  readonly close = vi.fn(async (): Promise<void> => undefined);

  constructor(readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }
}

function frames(): readonly Uint8Array[] {
  return [
    adtsFrame(19, 0x11),
    adtsFrame(31, 0x22),
    adtsFrame(47, 0x33),
    adtsFrame(59, 0x44),
    adtsFrame(71, 0x55),
    adtsFrame(83, 0x66),
  ];
}

async function issuedScan(): Promise<{
  readonly source: MemorySource;
  readonly scan: Readonly<AdtsFrameScanResult>;
}> {
  const source = new MemorySource(concatenate(frames()));
  const scan = await scanAdtsFrames(source, new AbortController().signal);
  return { source, scan };
}

function manifestReconstruction(
  scan: Readonly<AdtsFrameScanResult>,
): Readonly<AdtsManifestStructuralReconstruction> {
  const fixtureFrames = frames();
  const terminal = scan.seekPoints.at(-1);
  if (!terminal) throw new Error('Expected terminal ADTS seek point');
  return Object.freeze({
    evidenceKind: 'adts-manifest-structural-reconstruction' as const,
    authority: 'none' as const,
    sourceIdentity: scan.sourceIdentity,
    sourceSize: scan.sourceSize,
    audioStartByte: scan.audioStartByte,
    coreConfiguration: scan.coreConfiguration,
    coreSampleRateHz: scan.coreSampleRateHz,
    coreChannelCount: scan.coreChannelCount,
    samplesPerFrame: scan.samplesPerFrame,
    frameCount: scan.frameCount,
    totalCoreSamples: scan.totalCoreSamples,
    audioEndByteOffset: scan.audioEndByteOffset,
    seekPoints: scan.seekPoints,
    endpointChecks: Object.freeze({
      firstFrameByteLength: fixtureFrames[0]!.byteLength,
      terminalFrameOrdinal: terminal.frameOrdinal,
      terminalFrameByteOffset: terminal.byteOffset,
      terminalFrameByteLength: fixtureFrames.at(-1)!.byteLength,
    }),
  });
}

function evidenceFixture(): AdtsDecoderTimelineEvidence {
  const frameBytes = 100;
  const frameCount = 6;
  return {
    format: 'adts-decoder-timeline',
    authority: 'none',
    sourceIdentity: SOURCE_IDENTITY,
    sourceSize: frameCount * frameBytes,
    audioStartByte: 0,
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
    frameCount,
    audioEndByteOffset: frameCount * frameBytes,
    timeline: createAdtsCoreTimeline(frameCount),
    seekPoints: [
      { frameOrdinal: 0, byteOffset: 0 },
      { frameOrdinal: 2, byteOffset: 2 * frameBytes },
      { frameOrdinal: 5, byteOffset: 5 * frameBytes },
    ],
  };
}

describe('ADTS decoder timeline evidence', () => {
  it('normalizes nonzero absolute seek points and carries the exact origin into decoder planning', () => {
    const base = evidenceFixture();
    const audioStartByte = 37;
    const evidence = createAdtsDecoderTimelineEvidence({
      ...base,
      sourceSize: base.sourceSize + audioStartByte,
      audioStartByte,
      audioEndByteOffset: base.audioEndByteOffset + audioStartByte,
      seekPoints: base.seekPoints.map((point) => ({
        frameOrdinal: point.frameOrdinal,
        byteOffset: point.byteOffset + audioStartByte,
      })),
    });
    const descriptor = createAacDecoderDescriptorFromTimelineEvidence({
      timelineEvidence: evidence,
      outputSampleRateHz: 48_000,
      mediaFrame: 0,
    });

    expect(evidence).toMatchObject({
      sourceSize: base.sourceSize + audioStartByte,
      audioStartByte,
      audioEndByteOffset: base.audioEndByteOffset + audioStartByte,
    });
    expect(evidence.seekPoints[0]).toEqual({ frameOrdinal: 0, byteOffset: audioStartByte });
    expect(descriptor).toMatchObject({
      audioStartByte,
      startPlan: {
        scanAnchorByteOffset: audioStartByte,
        scanAnchorAccessUnitOrdinal: 0,
      },
    });
  });

  it('converts only the exact scanner-issued result without additional source reads', async () => {
    const { source, scan } = await issuedScan();
    const readCount = source.readAt.mock.calls.length;
    const evidence = createAdtsDecoderTimelineEvidenceFromScanResult(scan);

    expect(source.readAt).toHaveBeenCalledTimes(readCount);
    expect(source.close).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      format: 'adts-decoder-timeline',
      authority: 'none',
      sourceIdentity: scan.sourceIdentity,
      sourceSize: scan.sourceSize,
      frameCount: scan.frameCount,
      audioEndByteOffset: scan.audioEndByteOffset,
      timeline: {
        frameCount: scan.frameCount,
        coreFramesPerAccessUnit: 1_024,
        totalMediaFrames: scan.totalCoreSamples,
      },
    });
    expect(evidence.seekPoints).toEqual(scan.seekPoints);
    expect(evidence.seekPoints).not.toBe(scan.seekPoints);
    expect(evidence.coreConfiguration).not.toBe(scan.coreConfiguration);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.timeline)).toBe(true);
    expect(Object.isFrozen(evidence.coreConfiguration)).toBe(true);
    expect(Object.isFrozen(evidence.seekPoints)).toBe(true);
    expect(evidence.seekPoints.every(Object.isFrozen)).toBe(true);
    expect('fullyVerifiedFrameSpan' in evidence).toBe(false);
    expect('bytes' in evidence).toBe(false);
    expect(isScannerIssuedAdtsFrameScanResult(evidence)).toBe(false);
  });

  it('rejects scanner clones and cannot be laundered into manifest-sealer authority', async () => {
    const { scan } = await issuedScan();
    const clone = { ...scan };
    expect(isScannerIssuedAdtsFrameScanResult(clone)).toBe(false);
    expect(() => createAdtsDecoderTimelineEvidenceFromScanResult(clone)).toThrow(
      /exact scanner-issued result/i,
    );

    const evidence = createAdtsDecoderTimelineEvidenceFromScanResult(scan);
    expect(() =>
      sealAdtsFrameScanTimelineManifest(
        evidence as unknown as Readonly<AdtsFrameScanResult>,
        new Uint8Array(32),
      ),
    ).toThrow(/exact scanner/i);
  });

  it('normalizes admitted-manifest reconstruction without inheriting admission authority', async () => {
    const { scan } = await issuedScan();
    const reconstruction = manifestReconstruction(scan);
    const evidence = createAdtsDecoderTimelineEvidenceFromManifestReconstruction(reconstruction);

    expect(evidence).toEqual(createAdtsDecoderTimelineEvidenceFromScanResult(scan));
    expect(evidence).not.toBe(reconstruction);
    expect(evidence.authority).toBe('none');
    expect('endpointChecks' in evidence).toBe(false);
    expect(isScannerIssuedAdtsFrameScanResult(evidence)).toBe(false);
    expect(() =>
      sealAdtsFrameScanTimelineManifest(
        evidence as unknown as Readonly<AdtsFrameScanResult>,
        new Uint8Array(32),
      ),
    ).toThrow(/exact scanner/i);
  });

  it('rejects contradictory admitted-manifest endpoint observations', async () => {
    const { scan } = await issuedScan();
    const reconstruction = manifestReconstruction(scan);

    expect(() =>
      createAdtsDecoderTimelineEvidenceFromManifestReconstruction({
        ...reconstruction,
        endpointChecks: {
          ...reconstruction.endpointChecks,
          terminalFrameByteLength: reconstruction.endpointChecks.terminalFrameByteLength - 1,
        },
      }),
    ).toThrow(/terminal endpoint|EOF/i);
    expect(() =>
      createAdtsDecoderTimelineEvidenceFromManifestReconstruction({
        ...reconstruction,
        totalCoreSamples: reconstruction.totalCoreSamples - 1,
      }),
    ).toThrow(/sample total/i);
  });

  it('returns a deeply detached canonical snapshot', () => {
    const input = evidenceFixture();
    const evidence = createAdtsDecoderTimelineEvidence(input);

    expect(evidence).toEqual(input);
    expect(evidence).not.toBe(input);
    expect(evidence.coreConfiguration).not.toBe(input.coreConfiguration);
    expect(evidence.timeline).not.toBe(input.timeline);
    expect(evidence.seekPoints).not.toBe(input.seekPoints);

    Reflect.set(input, 'sourceIdentity', 'source:mutated');
    Reflect.set(input.coreConfiguration, 'sampleRateIndex', 3);
    Reflect.set(input.seekPoints[1]!, 'byteOffset', 201);
    expect(evidence.sourceIdentity).toBe(SOURCE_IDENTITY);
    expect(evidence.coreConfiguration.sampleRateIndex).toBe(4);
    expect(evidence.seekPoints[1]).toEqual({ frameOrdinal: 2, byteOffset: 200 });
  });

  it('rejects accessors, exotic records, sparse arrays, typed views, and extra fields', () => {
    let getterReads = 0;
    const accessorConfiguration = { ...evidenceFixture().coreConfiguration };
    Object.defineProperty(accessorConfiguration, 'sampleRateIndex', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 4;
      },
    });
    expect(() =>
      createAdtsDecoderTimelineEvidence({
        ...evidenceFixture(),
        coreConfiguration: accessorConfiguration,
      }),
    ).toThrow(/data property/i);
    expect(getterReads).toBe(0);

    const exotic = evidenceFixture();
    Object.setPrototypeOf(exotic, { forged: true });
    expect(() => createAdtsDecoderTimelineEvidence(exotic)).toThrow(/plain or null prototype/i);

    const sparse = [...evidenceFixture().seekPoints];
    delete sparse[1];
    expect(() =>
      createAdtsDecoderTimelineEvidence({ ...evidenceFixture(), seekPoints: sparse }),
    ).toThrow(/dense/i);
    expect(() =>
      createAdtsDecoderTimelineEvidence({
        ...evidenceFixture(),
        seekPoints: new Uint8Array(16),
      }),
    ).toThrow(/dense data-only array/i);
    expect(() => createAdtsDecoderTimelineEvidence({ ...evidenceFixture(), forged: true })).toThrow(
      /unsupported fields/i,
    );

    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(() =>
        createAdtsDecoderTimelineEvidence({
          ...evidenceFixture(),
          seekPoints: new Uint8Array(new SharedArrayBuffer(16)),
        }),
      ).toThrow(/dense data-only array/i);
    }
  });

  it('rejects contradictory origin, terminal, EOF, timeline, and safe-integer geometry', () => {
    const base = evidenceFixture();
    expect(() =>
      createAdtsDecoderTimelineEvidence({
        ...base,
        seekPoints: base.seekPoints.slice(1),
      }),
    ).toThrow(/origin/i);
    expect(() =>
      createAdtsDecoderTimelineEvidence({
        ...base,
        seekPoints: base.seekPoints.slice(0, -1),
      }),
    ).toThrow(/terminal/i);
    expect(() =>
      createAdtsDecoderTimelineEvidence({ ...base, audioEndByteOffset: base.sourceSize - 1 }),
    ).toThrow(/physical EOF/i);
    expect(() =>
      createAdtsDecoderTimelineEvidence({
        ...base,
        timeline: { ...base.timeline, totalMediaFrames: base.timeline.totalMediaFrames - 1 },
      }),
    ).toThrow(/media-frame total/i);

    const frameCount = Math.floor(Number.MAX_SAFE_INTEGER / 1_024) + 1;
    expect(() =>
      createAdtsDecoderTimelineEvidence({
        ...base,
        sourceSize: frameCount * 8,
        audioEndByteOffset: frameCount * 8,
        frameCount,
        timeline: {
          frameCount,
          coreFramesPerAccessUnit: 1_024,
          totalMediaFrames: Number.MAX_SAFE_INTEGER,
        },
        seekPoints: [
          { frameOrdinal: 0, byteOffset: 0 },
          { frameOrdinal: frameCount - 1, byteOffset: (frameCount - 1) * 8 },
        ],
      }),
    ).toThrow(/safe-integer range/i);
  });

  it.each([0, 2 * 1_024 + 17, 6 * 1_024 - 1])(
    'produces the legacy descriptor exactly at media frame %i',
    async (mediaFrame) => {
      const { scan } = await issuedScan();
      const evidence = createAdtsDecoderTimelineEvidenceFromScanResult(scan);
      const legacy = createAacDecoderDescriptor({
        scan,
        outputSampleRateHz: 48_000,
        mediaFrame,
      });
      const normalized = createAacDecoderDescriptorFromTimelineEvidence({
        timelineEvidence: evidence,
        outputSampleRateHz: 48_000,
        mediaFrame,
      });

      expect(normalized).toEqual(legacy);
      expect(normalized).not.toBe(legacy);
      expect(Object.isFrozen(normalized)).toBe(true);
      expect(Object.isFrozen(normalized.startPlan)).toBe(true);
    },
  );

  it('rebuilds normalized planning without retaining the caller snapshot', () => {
    const input = evidenceFixture();
    const planning = rebuildAacDecoderTimelinePlanningState(input);
    expect(planning.evidence).toEqual(input);
    expect(planning.evidence).not.toBe(input);
    expect(planning.timeline).toBe(planning.evidence.timeline);
    expect(planning.seekPoints).toBe(planning.evidence.seekPoints);
    expect(Object.isFrozen(planning)).toBe(true);
  });
});
