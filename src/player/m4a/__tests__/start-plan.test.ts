import { describe, expect, it } from 'vitest';

import { IsoBmffBoxReader } from '../../mp4/box-reader.ts';
import {
  M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS as DECODER_PREROLL_POLICY,
  createM4aAacDecoderStartPlan,
  type M4aAacDecoderStartPlan,
} from '../decoder-protocol.ts';
import { readM4aAacLcMetadata, snapshotM4aAacLcManifest } from '../metadata.ts';
import {
  M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS as RUNTIME_PREROLL_POLICY,
  openM4aAacRuntime,
  type M4aAacGenerationStartPlan,
} from '../runtime.ts';
import {
  M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
  createM4aAacStartPlan,
  type M4aAacStartPlan,
  type M4aAacStartPlanTimelineGeometry,
} from '../start-plan.ts';
import { M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT } from '../timeline.ts';
import { buildM4aAacFixture } from './m4a-aac-fixture.ts';

function signal(): AbortSignal {
  return new AbortController().signal;
}

function thrownBy(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected operation to throw');
}

describe('common M4A AAC generation start plan', () => {
  const geometry: M4aAacStartPlanTimelineGeometry = Object.freeze({
    accessUnitCount: 5,
    coreFramesPerAccessUnit: M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
    headTrimCoreFrames: 0,
    totalMediaFrames: 4_097,
  });

  it('maps access-unit zero, boundaries, and the last media frame exactly', () => {
    expect(createM4aAacStartPlan(geometry, 0)).toEqual({
      mediaFrame: 0,
      rawTargetCoreFrame: 0,
      targetAccessUnitOrdinal: 0,
      coreFrameWithinTargetAccessUnit: 0,
      decodeStartAccessUnitOrdinal: 0,
      actualPrerollAccessUnits: 0,
      discardCoreFrames: 0,
    });
    expect(createM4aAacStartPlan(geometry, 1_024)).toEqual({
      mediaFrame: 1_024,
      rawTargetCoreFrame: 1_024,
      targetAccessUnitOrdinal: 1,
      coreFrameWithinTargetAccessUnit: 0,
      decodeStartAccessUnitOrdinal: 0,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_024,
    });
    const last = createM4aAacStartPlan(geometry, 4_096);
    expect(last).toEqual({
      mediaFrame: 4_096,
      rawTargetCoreFrame: 4_096,
      targetAccessUnitOrdinal: 4,
      coreFrameWithinTargetAccessUnit: 0,
      decodeStartAccessUnitOrdinal: 3,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_024,
    });
    expect(Object.isFrozen(last)).toBe(true);
    expect(M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS).toBe(1);
    expect(RUNTIME_PREROLL_POLICY).toBe(M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS);
    expect(DECODER_PREROLL_POLICY).toBe(M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS);
    const commonPlan: Readonly<M4aAacStartPlan> = last;
    const runtimePlan: Readonly<M4aAacGenerationStartPlan> = commonPlan;
    const decoderPlan: Readonly<M4aAacDecoderStartPlan> = runtimePlan;
    expect(decoderPlan).toBe(last);
  });

  it('rejects exclusive EOF, range violations, impossible geometry, and overflow', () => {
    expect(() => createM4aAacStartPlan(geometry, 4_097)).toThrow(/exclusive media EOF/i);
    expect(() => createM4aAacStartPlan(geometry, 4_098)).toThrow(/outside/i);
    expect(() => createM4aAacStartPlan(geometry, -0)).toThrow(/mediaFrame/i);
    expect(() => createM4aAacStartPlan(geometry, 0.5)).toThrow(/mediaFrame/i);
    expect(() =>
      createM4aAacStartPlan(
        {
          ...geometry,
          accessUnitCount:
            Math.floor(Number.MAX_SAFE_INTEGER / M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT) + 1,
          headTrimCoreFrames: 0,
          totalMediaFrames: 1,
        },
        0,
      ),
    ).toThrow(/raw core-frame capacity.*safe-integer range/i);
    expect(() =>
      createM4aAacStartPlan(
        {
          ...geometry,
          accessUnitCount: 1,
          headTrimCoreFrames: Number.MAX_SAFE_INTEGER,
          totalMediaFrames: 2,
        },
        1,
      ),
    ).toThrow(/audible timeline end.*safe-integer range/i);
    expect(() =>
      createM4aAacStartPlan(
        {
          ...geometry,
          accessUnitCount: 1,
          headTrimCoreFrames: 1_024,
          totalMediaFrames: 1,
        },
        0,
      ),
    ).toThrow(/audible timeline exceeds/i);
  });

  it('keeps live runtime and structured-clone protocol plans exactly identical', async () => {
    const fixture = buildM4aAacFixture();
    const manifest = structuredClone(
      snapshotM4aAacLcManifest(await readM4aAacLcMetadata(fixture.source, signal())),
    );
    const runtime = await openM4aAacRuntime(
      new IsoBmffBoxReader(fixture.source),
      manifest,
      signal(),
    );

    for (const mediaFrame of [0, 1_024, 2_048, 3_072, 4_096, 4_607]) {
      const runtimePlan = runtime.createGenerationStartPlan(mediaFrame);
      const protocolPlan = createM4aAacDecoderStartPlan(manifest, mediaFrame);
      expect(runtimePlan).toEqual(protocolPlan);
      expect(Object.keys(runtimePlan)).toEqual(Object.keys(protocolPlan));
      expect(Object.isFrozen(runtimePlan)).toBe(true);
      expect(Object.isFrozen(protocolPlan)).toBe(true);
    }

    for (const invalidFrame of [4_608, 4_609, -0, 0.5, Number.MAX_SAFE_INTEGER]) {
      const runtimeError = thrownBy(() => runtime.createGenerationStartPlan(invalidFrame));
      const protocolError = thrownBy(() => createM4aAacDecoderStartPlan(manifest, invalidFrame));
      expect(protocolError.constructor).toBe(runtimeError.constructor);
      expect(protocolError.message).toBe(runtimeError.message);
    }
    runtime.close();
  });
});
