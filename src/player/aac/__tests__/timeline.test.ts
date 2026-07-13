import { describe, expect, it } from 'vitest';

import {
  ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
  createAdtsCoreTimeline,
  locateAdtsMediaFrame,
  planAdtsDecodeGeneration,
  type AdtsCoreTimeline,
} from '../timeline.ts';

describe('createAdtsCoreTimeline', () => {
  it('builds a frozen untrimmed AAC-LC core timeline', () => {
    const timeline = createAdtsCoreTimeline(10);

    expect(timeline).toEqual({
      frameCount: 10,
      coreFramesPerAccessUnit: 1_024,
      totalMediaFrames: 10_240,
    });
    expect(ADTS_CORE_FRAMES_PER_ACCESS_UNIT).toBe(1_024);
    expect(Object.isFrozen(timeline)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', new Number(1)])(
    'rejects a non-positive or non-primitive safe frameCount %#',
    (frameCount) => {
      expect(() => createAdtsCoreTimeline(frameCount as number)).toThrow(/frameCount/i);
    },
  );

  it('accepts the largest frame count whose 1,024-frame product remains safe', () => {
    const maximumFrameCount = Math.floor(Number.MAX_SAFE_INTEGER / 1_024);
    const timeline = createAdtsCoreTimeline(maximumFrameCount);

    expect(timeline.totalMediaFrames).toBe(maximumFrameCount * 1_024);
    expect(Number.isSafeInteger(timeline.totalMediaFrames)).toBe(true);
    expect(() => createAdtsCoreTimeline(maximumFrameCount + 1)).toThrow(/safe-integer range/i);
  });
});

describe('ADTS media and generation coordinates', () => {
  const timeline = createAdtsCoreTimeline(4);

  it('maps access-unit boundaries and interior media frames exactly', () => {
    expect(locateAdtsMediaFrame(timeline, 0)).toEqual({
      mediaFrame: 0,
      coreFrame: 0,
      accessUnitOrdinal: 0,
      coreFrameWithinAccessUnit: 0,
    });
    expect(locateAdtsMediaFrame(timeline, 1_023)).toEqual({
      mediaFrame: 1_023,
      coreFrame: 1_023,
      accessUnitOrdinal: 0,
      coreFrameWithinAccessUnit: 1_023,
    });
    expect(locateAdtsMediaFrame(timeline, 1_024)).toEqual({
      mediaFrame: 1_024,
      coreFrame: 1_024,
      accessUnitOrdinal: 1,
      coreFrameWithinAccessUnit: 0,
    });
    expect(locateAdtsMediaFrame(timeline, 2_049)).toEqual({
      mediaFrame: 2_049,
      coreFrame: 2_049,
      accessUnitOrdinal: 2,
      coreFrameWithinAccessUnit: 1,
    });
  });

  it('represents exclusive EOF as a terminal one-past access-unit ordinal', () => {
    const location = locateAdtsMediaFrame(timeline, timeline.totalMediaFrames);

    expect(location).toEqual({
      mediaFrame: 4_096,
      coreFrame: 4_096,
      accessUnitOrdinal: 4,
      coreFrameWithinAccessUnit: 0,
    });
    expect(Object.isFrozen(location)).toBe(true);
    expect(() =>
      planAdtsDecodeGeneration(timeline, timeline.totalMediaFrames, timeline.frameCount - 1),
    ).toThrow(/exclusive EOF.*decode generation/i);
  });

  it('turns the selected preroll access unit into an exact core-frame discard', () => {
    const plan = planAdtsDecodeGeneration(timeline, 3_123, 1);

    expect(plan).toEqual({
      mediaFrame: 3_123,
      coreFrame: 3_123,
      accessUnitOrdinal: 3,
      coreFrameWithinAccessUnit: 51,
      prerollAccessUnitOrdinal: 1,
      prerollCoreFrame: 1_024,
      discardCoreFrames: 2_099,
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('supports a zero-discard generation at an exact target boundary', () => {
    expect(planAdtsDecodeGeneration(timeline, 2_048, 2)).toEqual({
      mediaFrame: 2_048,
      coreFrame: 2_048,
      accessUnitOrdinal: 2,
      coreFrameWithinAccessUnit: 0,
      prerollAccessUnitOrdinal: 2,
      prerollCoreFrame: 2_048,
      discardCoreFrames: 0,
    });
  });

  it('rejects media coordinates and prerolls outside exact bounds', () => {
    expect(() => locateAdtsMediaFrame(timeline, -1)).toThrow(/mediaFrame/i);
    expect(() => locateAdtsMediaFrame(timeline, 0.5)).toThrow(/mediaFrame/i);
    expect(() => locateAdtsMediaFrame(timeline, timeline.totalMediaFrames + 1)).toThrow(/outside/i);
    expect(() => planAdtsDecodeGeneration(timeline, 2_047, 2)).toThrow(
      /after its target access unit/i,
    );
    expect(() => planAdtsDecodeGeneration(timeline, 0, -1)).toThrow(/prerollAccessUnitOrdinal/i);
    expect(() => planAdtsDecodeGeneration(timeline, 0, 0.5)).toThrow(/prerollAccessUnitOrdinal/i);
  });

  it.each([
    [{ ...timeline, frameCount: 0 }, /frameCount/i],
    [{ ...timeline, coreFramesPerAccessUnit: 2_048 }, /coreFramesPerAccessUnit/i],
    [{ ...timeline, totalMediaFrames: timeline.totalMediaFrames - 1 }, /geometry/i],
    [{ ...timeline, extra: true }, /only exact timeline fields/i],
  ] as const)('rejects forged or corrupted exact timeline geometry %#', (forged, expected) => {
    expect(() => locateAdtsMediaFrame(forged as unknown as AdtsCoreTimeline, 0)).toThrow(expected);
  });

  it('rejects accessors instead of consulting caller-controlled timeline values', () => {
    const accessor = Object.defineProperties(
      {},
      {
        frameCount: { enumerable: true, get: () => 4 },
        coreFramesPerAccessUnit: { enumerable: true, value: 1_024 },
        totalMediaFrames: { enumerable: true, value: 4_096 },
      },
    );

    expect(() => locateAdtsMediaFrame(accessor as AdtsCoreTimeline, 0)).toThrow(/data property/i);
  });

  it('snapshots a hostile reentrant Proxy without consulting any caller trap twice', () => {
    const target = {
      frameCount: 4,
      coreFramesPerAccessUnit: 1_024,
      totalMediaFrames: 4_096,
    };
    let ownKeysCalls = 0;
    let ordinaryGetCalls = 0;
    const descriptorCalls = new Map<PropertyKey, number>();
    const proxy = new Proxy(target, {
      ownKeys(current) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(current);
      },
      getOwnPropertyDescriptor(current, key) {
        descriptorCalls.set(key, (descriptorCalls.get(key) ?? 0) + 1);
        if (key === 'frameCount') {
          // Reentrant mutation makes this descriptor sweep inconsistent. It
          // must fail geometry rather than trigger a second key snapshot.
          current.totalMediaFrames = 4_095;
        }
        return Reflect.getOwnPropertyDescriptor(current, key);
      },
      get() {
        ordinaryGetCalls += 1;
        throw new Error('ordinary property access is forbidden');
      },
    });

    expect(() => locateAdtsMediaFrame(proxy as AdtsCoreTimeline, 0)).toThrow(/geometry/i);
    expect(ownKeysCalls).toBe(1);
    expect(ordinaryGetCalls).toBe(0);
    expect(descriptorCalls).toEqual(
      new Map<PropertyKey, number>([
        ['frameCount', 1],
        ['coreFramesPerAccessUnit', 1],
        ['totalMediaFrames', 1],
      ]),
    );
  });
});
