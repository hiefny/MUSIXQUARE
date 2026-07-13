import { describe, expect, it } from 'vitest';

import {
  readM4aAacLcMetadata,
  snapshotM4aAacLcManifest,
  validateM4aAacLcManifest,
} from '../metadata.ts';
import {
  buildM4aAacFixture,
  M4A_AAC_FIXTURE_ACCESS_UNIT_COUNT,
  M4A_AAC_FIXTURE_AUDIBLE_CORE_FRAMES,
  M4A_AAC_FIXTURE_PRESENTATION_CORE_FRAMES,
  M4A_AAC_FIXTURE_RAW_CORE_FRAMES,
} from './m4a-aac-fixture.ts';

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('bounded M4A AAC-LC manifest assembly', () => {
  it('assembles one canonical tail-moov source into deeply frozen Worker data', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await readM4aAacLcMetadata(fixture.source, signal());

    expect(manifest).toMatchObject({
      manifestVersion: 1,
      format: 'm4a-aac-lc',
      sourceSize: fixture.bytes.byteLength,
      sourceIdentity: fixture.source.identity,
      container: {
        majorBrand: 'M4A ',
        minorVersion: 0x200,
        compatibleBrands: ['M4A ', 'isom', 'iso2'],
      },
      codec: {
        codec: 'mp4a.40.2',
        sampleRateHz: 48_000,
        channelCount: 2,
        audioSpecificConfig: [0x11, 0x90, 0x56, 0xe5, 0x00],
      },
      timeline: {
        accessUnitCount: M4A_AAC_FIXTURE_ACCESS_UNIT_COUNT,
        rawCoreFrames: M4A_AAC_FIXTURE_RAW_CORE_FRAMES,
        presentationEndCoreFrames: M4A_AAC_FIXTURE_PRESENTATION_CORE_FRAMES,
        headTrimCoreFrames: 1_024,
        tailTrimCoreFrames: 512,
        totalMediaFrames: M4A_AAC_FIXTURE_AUDIBLE_CORE_FRAMES,
      },
      rollRecovery: { requiredPrerollAccessUnits: 1 },
      sampleSizes: {
        sampleCount: 6,
        fixedSampleSizeBytes: 0,
        totalEncodedBytes: 112,
      },
      chunks: {
        sampleCount: 6,
        chunkCount: 3,
        chunkOffsetWidthBytes: 4,
        runs: [{ firstChunk: 1, endChunkExclusive: 4, firstSampleOrdinal: 0, samplesPerChunk: 2 }],
        mediaDataRanges: [fixture.expected.mdatPayloadRange],
      },
    });
    expect(manifest.sampleSizes.headerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.chunks.headerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.codec.audioSpecificConfig)).toBe(true);
    expect(Object.isFrozen(manifest.sampleSizes.checkpoints)).toBe(true);
    expect(Object.isFrozen(manifest.chunks.runs[0])).toBe(true);
    expect(fixture.source.closeCalls).toBe(0);
    expect(fixture.source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);

    const snapshot = snapshotM4aAacLcManifest(manifest);
    expect(snapshot).not.toBe(manifest);
    expect(snapshot.sampleSizes).not.toBe(manifest.sampleSizes);
    expect(snapshot.chunks).not.toBe(manifest.chunks);
    const roundTrip = validateM4aAacLcManifest(structuredClone(snapshot));
    expect(roundTrip).toEqual(snapshot);
    expect(Object.isFrozen(roundTrip)).toBe(true);
    expect(Object.isFrozen(roundTrip.container.compatibleBrands)).toBe(true);
  });

  it.each(['stco', 'co64'] as const)(
    'normalizes the %s chunk-offset branch without changing the audible timeline',
    async (chunkOffsetBoxType) => {
      const fixture = buildM4aAacFixture({ chunkOffsetBoxType });
      const manifest = await readM4aAacLcMetadata(fixture.source, signal());

      expect(manifest.chunks.chunkOffsetWidthBytes).toBe(chunkOffsetBoxType === 'stco' ? 4 : 8);
      expect(manifest.timeline.totalMediaFrames).toBe(M4A_AAC_FIXTURE_AUDIBLE_CORE_FRAMES);
      expect(manifest.chunks.mediaDataRanges).toEqual([fixture.expected.mdatPayloadRange]);
    },
  );

  it('keeps optional iTun and roll evidence independent', async () => {
    const fixture = buildM4aAacFixture({
      includeITunSmpb: false,
      includeRollRecovery: false,
    });
    const manifest = await readM4aAacLcMetadata(fixture.source, signal());

    expect(manifest.rollRecovery).toBeNull();
    expect(manifest.timeline.headTrimCoreFrames).toBe(1_024);
    expect(manifest.timeline.totalMediaFrames).toBe(M4A_AAC_FIXTURE_AUDIBLE_CORE_FRAMES);
  });

  it('treats brands as diagnostic data instead of a codec admission gate', async () => {
    const manifest = await readM4aAacLcMetadata(buildM4aAacFixture().source, signal());
    const clone = structuredClone(snapshotM4aAacLcManifest(manifest));
    clone.container.majorBrand = 'zzzz';
    clone.container.compatibleBrands = ['none'];

    expect(validateM4aAacLcManifest(clone).container).toEqual({
      majorBrand: 'zzzz',
      minorVersion: 0x200,
      compatibleBrands: ['none'],
    });
  });

  it('preserves an authoritative pre-read abort and leaves source ownership with the caller', async () => {
    const fixture = buildM4aAacFixture();
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'm4a-manifest-before-read' });
    controller.abort(reason);

    await expect(readM4aAacLcMetadata(fixture.source, controller.signal)).rejects.toBe(reason);
    expect(fixture.source.reads).toHaveLength(0);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('does not inspect source fields before honoring an existing abort', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'm4a-manifest-before-source-inspection' });
    controller.abort(reason);
    const source = Object.create(null) as Record<string, unknown>;
    for (const key of ['size', 'identity', 'readAt', 'close']) {
      Object.defineProperty(source, key, {
        enumerable: true,
        get(): never {
          throw new Error(`pre-aborted metadata inspected source.${key}`);
        },
      });
    }

    await expect(readM4aAacLcMetadata(source as never, controller.signal)).rejects.toBe(reason);
  });

  it('allows only the exact manifest object issued by the metadata reader to be exported', async () => {
    const manifest = await readM4aAacLcMetadata(buildM4aAacFixture().source, signal());
    expect(() => snapshotM4aAacLcManifest(structuredClone(manifest))).toThrow(/not issued/);

    const hostile = new Proxy(Object.create(null), {
      get(): never {
        throw new Error('manifest fields were inspected');
      },
    });
    expect(() => snapshotM4aAacLcManifest(hostile)).toThrow(/not issued/);
  });
});

describe('M4A AAC-LC structured manifest validation', () => {
  async function freshWire(): Promise<Record<string, any>> {
    const manifest = await readM4aAacLcMetadata(buildM4aAacFixture().source, signal());
    return structuredClone(snapshotM4aAacLcManifest(manifest)) as Record<string, any>;
  }

  it.each([
    [
      'an extra top-level field',
      (value: Record<string, any>) => {
        value.extra = true;
      },
    ],
    [
      'a symbol field',
      (value: Record<string, any>) => {
        value[Symbol('extra')] = true;
      },
    ],
    [
      'a conflicting codec rate',
      (value: Record<string, any>) => {
        value.codec.sampleRateHz = 44_100;
      },
    ],
    [
      'a noncanonical ASC suffix',
      (value: Record<string, any>) => {
        value.codec.audioSpecificConfig[4] = 1;
      },
    ],
    [
      'a contradictory media duration',
      (value: Record<string, any>) => {
        value.timeline.totalMediaFrames += 1;
      },
    ],
    [
      'an impossible one-entry shortened stts timeline',
      (value: Record<string, any>) => {
        value.timeline.sttsEntryCount = 1;
      },
    ],
    [
      'a contradictory table count',
      (value: Record<string, any>) => {
        value.sampleSizes.sampleCount -= 1;
      },
    ],
    [
      'an escaping source size',
      (value: Record<string, any>) => {
        value.sourceSize = 1;
      },
    ],
    [
      'an invalid source identity',
      (value: Record<string, any>) => {
        value.sourceIdentity = '';
      },
    ],
    [
      'a sparse brand array',
      (value: Record<string, any>) => {
        value.container.compatibleBrands = new Array(3);
      },
    ],
    [
      'a non-byte four-character brand',
      (value: Record<string, any>) => {
        value.container.majorBrand = '😀ab';
      },
    ],
    [
      'an accessor field',
      (value: Record<string, any>) => {
        Object.defineProperty(value.codec, 'sampleRateHz', {
          configurable: true,
          enumerable: true,
          get: () => 48_000,
        });
      },
    ],
  ] as const)('rejects %s', async (_label, mutate) => {
    const value = await freshWire();
    mutate(value);
    expect(() => validateM4aAacLcManifest(value)).toThrow();
  });
});
