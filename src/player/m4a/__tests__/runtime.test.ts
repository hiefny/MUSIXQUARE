import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import { readM4aAacLcMetadata, snapshotM4aAacLcManifest } from '../metadata.ts';
import {
  closeM4aAacRuntime,
  createM4aAacGenerationStartPlan,
  openM4aAacRuntime,
  requireM4aAacGenerationStartPlan,
} from '../runtime.ts';
import { buildM4aAacFixture, M4aAacFixtureMemorySource } from './m4a-aac-fixture.ts';

function signal(): AbortSignal {
  return new AbortController().signal;
}

function findBoxType(bytes: Uint8Array, type: string): number {
  const encoded = new TextEncoder().encode(type);
  for (let offset = 0; offset <= bytes.byteLength - encoded.byteLength; offset += 1) {
    if (encoded.every((byte, index) => bytes[offset + index] === byte)) return offset;
  }
  throw new Error(`Missing fixture box ${type}`);
}

function writeBoxBodyUint32(bytes: Uint8Array, type: string, bodyOffset: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    findBoxType(bytes, type) + 4 + bodyOffset,
    value,
    false,
  );
}

async function transferableManifest(fixture: ReturnType<typeof buildM4aAacFixture>) {
  const manifest = await readM4aAacLcMetadata(fixture.source, signal());
  return structuredClone(snapshotM4aAacLcManifest(manifest));
}

describe('source-bound M4A AAC runtime opening', () => {
  it('atomically reopens authenticated indexes and exposes only bounded decoder info', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await transferableManifest(fixture);
    fixture.source.reads.length = 0;

    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      manifest,
      signal(),
    );

    expect(runtime.info).toMatchObject({
      format: 'm4a-aac-lc',
      sourceSize: fixture.bytes.byteLength,
      sourceIdentity: fixture.source.identity,
      codec: 'mp4a.40.2',
      sampleRateHz: 48_000,
      channelCount: 2,
      audioSpecificConfig: [0x11, 0x90, 0x56, 0xe5, 0x00],
      accessUnitCount: 6,
      totalEncodedBytes: 112,
      sourceRequiredPrerollAccessUnits: 1,
      transformPrerollPolicyAccessUnits: 1,
      timeline: {
        headTrimCoreFrames: 1_024,
        tailTrimCoreFrames: 512,
        totalMediaFrames: 4_608,
      },
    });
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.info)).toBe(true);
    expect(Object.isFrozen(runtime.info.audioSpecificConfig)).toBe(true);
    expect(Object.isFrozen(runtime.info.timeline)).toBe(true);
    expect(fixture.source.reads.map(({ length }) => length)).toEqual([12, 20, 8]);
    expect(fixture.source.closeCalls).toBe(0);
  });

  it('keeps absent source roll evidence separate from the fixed product preroll policy', async () => {
    const fixture = buildM4aAacFixture({ includeRollRecovery: false });
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      await transferableManifest(fixture),
      signal(),
    );

    expect(runtime.info.sourceRequiredPrerollAccessUnits).toBeNull();
    expect(runtime.info.transformPrerollPolicyAccessUnits).toBe(1);
    expect(runtime.createGenerationStartPlan(0).actualPrerollAccessUnits).toBe(1);
  });

  it('rejects exact source-size and identity mismatches before reading the foreign source', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await transferableManifest(fixture);
    const wrongIdentity = buildM4aAacFixture({ sourceIdentity: 'foreign-m4a-source' }).source;
    const wrongSizeFixture = buildM4aAacFixture({ sourceIdentity: fixture.source.identity });
    const wrongSizeSource = new M4aAacFixtureMemorySource(
      wrongSizeFixture.bytes.slice(0, -1),
      fixture.source.identity,
    );

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(wrongIdentity), manifest, signal()),
    ).rejects.toThrow(/source binding/);
    expect(wrongIdentity.reads).toHaveLength(0);

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(wrongSizeSource), manifest, signal()),
    ).rejects.toThrow(/source binding/);
    expect(wrongSizeSource.reads).toHaveLength(0);
  });

  it('rejects transferred stsc geometry changed without matching source evidence', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await transferableManifest(fixture);
    const forged = {
      ...manifest,
      chunks: {
        ...manifest.chunks,
        runs: [
          {
            firstChunk: 1,
            endChunkExclusive: 2,
            firstSampleOrdinal: 0,
            samplesPerChunk: 4,
          },
          {
            firstChunk: 2,
            endChunkExclusive: 4,
            firstSampleOrdinal: 4,
            samplesPerChunk: 1,
          },
        ],
      },
    };

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(fixture.source), forged, signal()),
    ).rejects.toThrow(/stsc (?:evidence conflicts|runs do not match)/i);
  });

  it('rejects tampered manifest digests and changed source metadata pages', async () => {
    const digestFixture = buildM4aAacFixture();
    const digestManifest = await transferableManifest(digestFixture);
    const forgedDigest = {
      ...digestManifest,
      sampleSizes: {
        ...digestManifest.sampleSizes,
        headerSha256: '0'.repeat(64),
      },
    };
    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(digestFixture.source), forgedDigest, signal()),
    ).rejects.toThrow(/header changed/i);

    const pageFixture = buildM4aAacFixture();
    const pageManifest = await transferableManifest(pageFixture);
    pageFixture.bytes[pageManifest.chunks.sampleToChunk.bodyStart + 12]! ^= 1;
    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(pageFixture.source), pageManifest, signal()),
    ).rejects.toThrow(/stsc body changed/i);
  });

  it('preserves a pre-abort reason before inspecting a hostile manifest', async () => {
    const fixture = buildM4aAacFixture();
    let inspected = false;
    const hostile = new Proxy(Object.create(null), {
      ownKeys() {
        inspected = true;
        throw new Error('manifest inspection must not win');
      },
    });
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'runtime-open-before' });
    controller.abort(reason);

    await expect(
      openM4aAacRuntime(new IsoBmffBoxReader(fixture.source), hostile, controller.signal),
    ).rejects.toBe(reason);
    expect(inspected).toBe(false);
    expect(fixture.source.reads).toHaveLength(0);
  });
});

describe('M4A AAC generation start authority', () => {
  it('maps audible media frames to exact one-AU preroll and discard coordinates', async () => {
    const fixture = buildM4aAacFixture();
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      await transferableManifest(fixture),
      signal(),
    );

    expect(runtime.createGenerationStartPlan(0)).toEqual({
      mediaFrame: 0,
      rawTargetCoreFrame: 1_024,
      targetAccessUnitOrdinal: 1,
      coreFrameWithinTargetAccessUnit: 0,
      decodeStartAccessUnitOrdinal: 0,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_024,
    });
    expect(runtime.createGenerationStartPlan(2_049)).toEqual({
      mediaFrame: 2_049,
      rawTargetCoreFrame: 3_073,
      targetAccessUnitOrdinal: 3,
      coreFrameWithinTargetAccessUnit: 1,
      decodeStartAccessUnitOrdinal: 2,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_025,
    });
    expect(runtime.createGenerationStartPlan(4_607)).toEqual({
      mediaFrame: 4_607,
      rawTargetCoreFrame: 5_631,
      targetAccessUnitOrdinal: 5,
      coreFrameWithinTargetAccessUnit: 511,
      decodeStartAccessUnitOrdinal: 4,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_535,
    });
    expect(() => runtime.createGenerationStartPlan(4_608)).toThrow(/exclusive media EOF/i);
    expect(() => runtime.createGenerationStartPlan(4_609)).toThrow(/outside/i);
    expect(() => runtime.createGenerationStartPlan(-0)).toThrow(/mediaFrame/i);
    expect(() => runtime.createGenerationStartPlan(0.5)).toThrow(/mediaFrame/i);
  });

  it('clamps product preroll to zero for a valid target in access unit zero', async () => {
    const fixture = buildM4aAacFixture({ includeITunSmpb: false });
    // Convert the canonical fixture to an untrimmed 5,632-frame timeline.
    writeBoxBodyUint32(fixture.bytes, 'elst', 8, 117);
    writeBoxBodyUint32(fixture.bytes, 'elst', 12, 0);
    writeBoxBodyUint32(fixture.bytes, 'tkhd', 20, 117);
    writeBoxBodyUint32(fixture.bytes, 'mvhd', 16, 117);
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      await transferableManifest(fixture),
      signal(),
    );

    expect(runtime.info.timeline.headTrimCoreFrames).toBe(0);
    expect(runtime.createGenerationStartPlan(0)).toEqual({
      mediaFrame: 0,
      rawTargetCoreFrame: 0,
      targetAccessUnitOrdinal: 0,
      coreFrameWithinTargetAccessUnit: 0,
      decodeStartAccessUnitOrdinal: 0,
      actualPrerollAccessUnits: 0,
      discardCoreFrames: 0,
    });
  });

  it('accepts only unchanged plans issued by the exact live same-realm runtime', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = await transferableManifest(fixture);
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      manifest,
      signal(),
    );
    const foreignRuntime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      manifest,
      signal(),
    );
    const plan = createM4aAacGenerationStartPlan(runtime, 17);

    expect(requireM4aAacGenerationStartPlan(runtime, plan)).toBe(plan);
    expect(runtime.requireGenerationStartPlan(plan)).toBe(plan);
    expect(() => requireM4aAacGenerationStartPlan(runtime, structuredClone(plan))).toThrow(
      /not issued/i,
    );
    expect(() => requireM4aAacGenerationStartPlan(foreignRuntime, plan)).toThrow(
      /different runtime/i,
    );
    expect(() => createM4aAacGenerationStartPlan({ ...runtime }, 17)).toThrow(/provenance/i);

    let getterRan = false;
    const hostilePlan = Object.create(null);
    Object.defineProperty(hostilePlan, 'mediaFrame', {
      enumerable: true,
      get() {
        getterRan = true;
        throw new Error('hostile plan getter must not run');
      },
    });
    expect(() => runtime.requireGenerationStartPlan(hostilePlan)).toThrow(/not issued/i);
    expect(getterRan).toBe(false);
  });

  it('closes idempotently, revokes plans, and never closes the borrowed source', async () => {
    const fixture = buildM4aAacFixture();
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      await transferableManifest(fixture),
      signal(),
    );
    const plan = runtime.createGenerationStartPlan(0);

    runtime.close();
    runtime.close();
    closeM4aAacRuntime(runtime);
    expect(fixture.source.closeCalls).toBe(0);
    expect(() => runtime.createGenerationStartPlan(0)).toThrow(/runtime is closed/i);
    expect(() => runtime.requireGenerationStartPlan(plan)).toThrow(/runtime is closed/i);
    expect(() => closeM4aAacRuntime({ ...runtime })).toThrow(/provenance/i);
  });
});
