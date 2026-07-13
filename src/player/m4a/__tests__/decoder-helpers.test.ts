import { beforeAll, describe, expect, it } from 'vitest';

import { expectedLanczosOutputFrames } from '../../streaming/resampler-plan.ts';
import {
  createM4aAacDecoderDescriptor,
  expectedM4aAacDecoderEofProgress,
  expectedM4aAacOutputFrames,
  remainingM4aAacMediaFrames,
} from '../decoder-helpers.ts';
import type { M4aAacDecoderDescriptor } from '../decoder-protocol.ts';
import { readM4aAacLcMetadata, snapshotM4aAacLcManifest } from '../metadata.ts';
import type { M4aAacLcManifest } from '../metadata.ts';
import { buildM4aAacFixture } from './m4a-aac-fixture.ts';

const TARGET_MEDIA_FRAME = 2_049;
let MANIFEST: Readonly<M4aAacLcManifest>;

function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeAll(async () => {
  const fixture = buildM4aAacFixture();
  const issued = await readM4aAacLcMetadata(fixture.source, signal());
  MANIFEST = structuredClone(snapshotM4aAacLcManifest(issued));
});

describe('M4A AAC decoder descriptor helpers', () => {
  it('creates a deeply detached descriptor with fixed one-AU product preroll', () => {
    const mutableManifest = structuredClone(MANIFEST);
    const descriptor = createM4aAacDecoderDescriptor({
      manifest: mutableManifest,
      outputSampleRateHz: 44_100,
      mediaFrame: TARGET_MEDIA_FRAME,
    });

    expect(descriptor).toMatchObject({
      format: 'm4a-aac-lc',
      sourceSize: MANIFEST.sourceSize,
      sourceIdentity: MANIFEST.sourceIdentity,
      outputSampleRateHz: 44_100,
      transformPrerollPolicyAccessUnits: 1,
      startPlan: {
        mediaFrame: 2_049,
        rawTargetCoreFrame: 3_073,
        targetAccessUnitOrdinal: 3,
        coreFrameWithinTargetAccessUnit: 1,
        decodeStartAccessUnitOrdinal: 2,
        actualPrerollAccessUnits: 1,
        discardCoreFrames: 1_025,
      },
    });
    expect(descriptor.manifest).not.toBe(mutableManifest);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.manifest)).toBe(true);
    expect(Object.isFrozen(descriptor.startPlan)).toBe(true);

    (mutableManifest.container.compatibleBrands as string[])[0] = 'free';
    expect(descriptor.manifest.container.compatibleBrands[0]).not.toBe('free');
  });

  it('rejects noncanonical options without invoking accessors', () => {
    const valid = {
      manifest: MANIFEST,
      outputSampleRateHz: 48_000,
      mediaFrame: 0,
    };
    expect(() => createM4aAacDecoderDescriptor({ ...valid, extra: true } as never)).toThrow(
      /exact-key/i,
    );
    expect(() => createM4aAacDecoderDescriptor(Object.assign(Object.create({}), valid))).toThrow(
      /exact-key/i,
    );
    expect(() => createM4aAacDecoderDescriptor({ ...valid, mediaFrame: -0 })).toThrow(
      /mediaFrame/i,
    );
    expect(() => createM4aAacDecoderDescriptor({ ...valid, mediaFrame: 4_608 })).toThrow(
      /exclusive media EOF/i,
    );

    let calls = 0;
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'manifest', {
      enumerable: true,
      get() {
        calls += 1;
        return MANIFEST;
      },
    });
    expect(() => createM4aAacDecoderDescriptor(accessor as never)).toThrow(/exact-key/i);
    expect(calls).toBe(0);
  });

  it('preserves one coherent manifest snapshot under later mutation', () => {
    const backing = structuredClone(MANIFEST) as unknown as Record<string, unknown>;
    const options = {
      manifest: new Proxy(backing, {
        ownKeys(target) {
          target.sourceIdentity = 'm4a-aac-reentrant-snapshot';
          return Reflect.ownKeys(target);
        },
      }) as unknown as M4aAacLcManifest,
      outputSampleRateHz: 48_000,
      mediaFrame: 0,
    };
    const descriptor = createM4aAacDecoderDescriptor(options);
    expect(descriptor.sourceIdentity).toBe('m4a-aac-reentrant-snapshot');
    backing.sourceIdentity = 'm4a-aac-mutated-later';
    expect(descriptor.sourceIdentity).toBe('m4a-aac-reentrant-snapshot');
  });
});

describe('M4A AAC exact EOF geometry', () => {
  it('publishes absolute source cursors and generation-local media/output totals', () => {
    const descriptor = createM4aAacDecoderDescriptor({
      manifest: MANIFEST,
      outputSampleRateHz: 44_100,
      mediaFrame: TARGET_MEDIA_FRAME,
    });
    const expectedOutput = expectedLanczosOutputFrames({
      inputSampleRate: 48_000,
      outputSampleRate: 44_100,
      totalSourceFrames: 4_608,
      startSourceFrame: TARGET_MEDIA_FRAME,
    });

    expect(remainingM4aAacMediaFrames(descriptor)).toBe(2_559);
    expect(expectedM4aAacOutputFrames(descriptor)).toBe(expectedOutput);
    expect(expectedM4aAacDecoderEofProgress(descriptor)).toEqual({
      nextAccessUnitOrdinal: 6,
      consumedEncodedBytes: 112,
      decodedRawCoreFrames: 6_144,
      acceptedMediaFrames: 2_559,
      producedOutputFrames: expectedOutput,
    });
    expect(Object.isFrozen(expectedM4aAacDecoderEofProgress(descriptor))).toBe(true);
  });

  it('uses exact remaining media frames when no resampling is needed', () => {
    const descriptor = createM4aAacDecoderDescriptor({
      manifest: MANIFEST,
      outputSampleRateHz: 48_000,
      mediaFrame: 17,
    });
    expect(expectedM4aAacOutputFrames(descriptor)).toBe(4_591);
    expect(expectedM4aAacDecoderEofProgress(descriptor).producedOutputFrames).toBe(4_591);
  });

  it('rejects forged descriptor input instead of deriving plausible EOF counters', () => {
    expect(() => remainingM4aAacMediaFrames({} as M4aAacDecoderDescriptor)).toThrow(/valid/i);
    expect(() => expectedM4aAacOutputFrames({} as M4aAacDecoderDescriptor)).toThrow(/valid/i);
    expect(() => expectedM4aAacDecoderEofProgress({} as M4aAacDecoderDescriptor)).toThrow(/valid/i);
  });
});
