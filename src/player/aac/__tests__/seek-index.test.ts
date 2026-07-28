import { describe, expect, it } from 'vitest';

import {
  ADTS_SEEK_INDEX_MAX_POINTS,
  AdtsSeekIndex,
  type AdtsSeekIndexPoint,
} from '../seek-index.ts';

function point(frameOrdinal: number, byteOffset = 1_000 + frameOrdinal * 100) {
  return { frameOrdinal, byteOffset };
}

describe('AdtsSeekIndex', () => {
  it('retains only exact encoded coordinates in an immutable canonical origin', () => {
    const supplied = point(0);
    const index = new AdtsSeekIndex(supplied);

    expect(index.origin).toEqual({ frameOrdinal: 0, byteOffset: 1_000 });
    expect(index.origin).not.toBe(supplied);
    expect(Object.keys(index.origin)).toEqual(['frameOrdinal', 'byteOffset']);
    expect(Object.isFrozen(index.origin)).toBe(true);
    expect(index.origin).not.toHaveProperty('sample');
    expect(index.origin).not.toHaveProperty('sampleRate');
    expect(index.origin).not.toHaveProperty('channels');
    expect(index.origin).not.toHaveProperty('preroll');
    expect(index.maxPoints).toBe(ADTS_SEEK_INDEX_MAX_POINTS);
    expect(index.compactionStride).toBe(1);
    expect(index.latestVerified).toBe(index.origin);
  });

  it.each([
    [{ frameOrdinal: 1, byteOffset: 1_000 }, undefined],
    [{ frameOrdinal: -1, byteOffset: 1_000 }, undefined],
    [{ frameOrdinal: 0.5, byteOffset: 1_000 }, undefined],
    [{ frameOrdinal: 0, byteOffset: -1 }, undefined],
    [{ frameOrdinal: 0, byteOffset: Number.MAX_SAFE_INTEGER + 1 }, undefined],
    [{ frameOrdinal: 0, byteOffset: 1_000, sample: 0 }, undefined],
    [{ frameOrdinal: 0, byteOffset: 1_000 }, { maxPoints: 1 }],
    [{ frameOrdinal: 0, byteOffset: 1_000 }, { maxPoints: 8_193 }],
    [{ frameOrdinal: 0, byteOffset: 1_000 }, { maxPoints: 2.5 }],
    [
      { frameOrdinal: 0, byteOffset: 1_000 },
      { maxPoints: 8, extra: true },
    ],
  ] as const)('rejects invalid origin/options geometry %#', (origin, options) => {
    expect(
      () =>
        new AdtsSeekIndex(
          origin as unknown as AdtsSeekIndexPoint,
          options as unknown as { maxPoints?: number },
        ),
    ).toThrow();
  });

  it('appends strictly monotonic verified coordinates and resolves retained floor anchors', () => {
    const index = new AdtsSeekIndex(point(0), { maxPoints: 16 });

    expect(index.appendVerified(point(1))).toBe(true);
    expect(index.appendVerified(point(4))).toBe(true);
    expect(index.appendVerified(point(9))).toBe(true);
    expect(index.size).toBe(4);
    expect(index.latestVerified).toEqual(point(9));
    expect(index.floorAnchor(0)).toEqual(point(0));
    expect(index.floorAnchor(3)).toEqual(point(1));
    expect(index.floorAnchor(4)).toEqual(point(4));
    expect(index.floorAnchor(8)).toEqual(point(4));
    expect(index.floorAnchor(9)).toEqual(point(9));
    expect(index.floorAnchor(Number.MAX_SAFE_INTEGER)).toEqual(point(9));
  });

  it('rejects duplicate, rewind, and conflicting coordinate appends without mutation', () => {
    const index = new AdtsSeekIndex(point(0));
    expect(index.appendVerified(point(2))).toBe(true);
    const before = index.snapshot();

    expect(index.appendVerified(point(2))).toBe(false);
    expect(index.appendVerified({ frameOrdinal: 2, byteOffset: 1_201 })).toBe(false);
    expect(index.appendVerified({ frameOrdinal: 1, byteOffset: 1_300 })).toBe(false);
    expect(index.appendVerified({ frameOrdinal: 3, byteOffset: 1_199 })).toBe(false);
    expect(index.appendVerified({ frameOrdinal: 3, byteOffset: 1_200 })).toBe(false);
    expect(index.appendVerified({ frameOrdinal: 3, byteOffset: Number.NaN })).toBe(false);
    expect(
      index.appendVerified({ frameOrdinal: Number.MAX_SAFE_INTEGER + 1, byteOffset: 1_300 }),
    ).toBe(false);
    expect(index.snapshot()).toEqual(before);
  });

  it('does not invoke point or option accessors and contains hostile Proxy failures', () => {
    let accessorCalls = 0;
    const getterPoint = Object.defineProperties(
      {},
      {
        frameOrdinal: {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return 1;
          },
        },
        byteOffset: {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return 1_100;
          },
        },
      },
    );
    const index = new AdtsSeekIndex(point(0));

    expect(index.appendVerified(getterPoint as AdtsSeekIndexPoint)).toBe(false);
    expect(accessorCalls).toBe(0);
    expect(
      () =>
        new AdtsSeekIndex(
          point(0),
          Object.defineProperty({}, 'maxPoints', {
            get() {
              accessorCalls += 1;
              return 4;
            },
          }) as { maxPoints: number },
        ),
    ).toThrow('data property');
    expect(accessorCalls).toBe(0);

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile ownKeys');
        },
      },
    );
    expect(index.appendVerified(throwingProxy as AdtsSeekIndexPoint)).toBe(false);
    expect(index.snapshot()).toEqual([point(0)]);
  });

  it('fences a re-entrant Proxy append against the new verified tail', () => {
    const index = new AdtsSeekIndex(point(0));
    let reentered = false;
    const candidate = new Proxy(point(1), {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          expect(index.appendVerified(point(2))).toBe(true);
        }
        return Reflect.ownKeys(target);
      },
    });

    expect(index.appendVerified(candidate)).toBe(false);
    expect(index.latestVerified).toEqual(point(2));
    expect(index.snapshot()).toEqual([point(0), point(2)]);
  });

  it('revalidates the tail after re-entrant appends trigger compaction', () => {
    const index = new AdtsSeekIndex(point(0), { maxPoints: 2 });
    expect(index.appendVerified(point(1))).toBe(true);
    let reentered = false;
    const candidate = new Proxy(point(4), {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          expect(index.appendVerified(point(2))).toBe(true);
          expect(index.appendVerified(point(3))).toBe(true);
        }
        return Reflect.ownKeys(target);
      },
    });

    expect(index.appendVerified(candidate)).toBe(true);
    expect(index.snapshot()).toEqual([point(0), point(4)]);
    expect(index.size).toBe(2);
  });

  it('returns detached frozen snapshots whose points have one exact shape', () => {
    const index = new AdtsSeekIndex(point(0));
    index.appendVerified(point(1));
    const first = index.snapshot();
    const second = index.snapshot();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(index.origin);
    expect(Object.isFrozen(first)).toBe(true);
    for (const retained of first) {
      expect(Object.isFrozen(retained)).toBe(true);
      expect(Object.keys(retained)).toEqual(['frameOrdinal', 'byteOffset']);
    }
  });

  it('validates floor queries without arithmetic outside the safe-integer range', () => {
    const index = new AdtsSeekIndex({ frameOrdinal: 0, byteOffset: Number.MAX_SAFE_INTEGER });

    expect(index.floorAnchor(Number.MAX_SAFE_INTEGER)).toBe(index.origin);
    expect(() => index.floorAnchor(-1)).toThrow(RangeError);
    expect(() => index.floorAnchor(1.5)).toThrow(RangeError);
    expect(() => index.floorAnchor(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => index.floorAnchor(Number.NaN)).toThrow(RangeError);
  });

  it('compacts coordinates at the safe-integer ceiling without overflowing stride math', () => {
    const index = new AdtsSeekIndex(point(0, 0), { maxPoints: 2 });
    expect(
      index.appendVerified({
        frameOrdinal: Number.MAX_SAFE_INTEGER - 1,
        byteOffset: Number.MAX_SAFE_INTEGER - 1,
      }),
    ).toBe(true);
    expect(
      index.appendVerified({
        frameOrdinal: Number.MAX_SAFE_INTEGER,
        byteOffset: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(true);

    expect(index.snapshot()).toEqual([
      point(0, 0),
      {
        frameOrdinal: Number.MAX_SAFE_INTEGER,
        byteOffset: Number.MAX_SAFE_INTEGER,
      },
    ]);
    expect(Number.isSafeInteger(index.compactionStride)).toBe(true);
    expect(index.floorAnchor(Number.MAX_SAFE_INTEGER - 1)).toEqual(point(0, 0));
    expect(index.floorAnchor(Number.MAX_SAFE_INTEGER)).toEqual(index.latestVerified);
  });

  it('deterministically bounds 25k sequential points while preserving exact origin and tail', () => {
    const totalPoints = 25_001;
    const first = new AdtsSeekIndex(point(0));
    const second = new AdtsSeekIndex(point(0));

    for (let frameOrdinal = 1; frameOrdinal < totalPoints; frameOrdinal += 1) {
      expect(first.appendVerified(point(frameOrdinal))).toBe(true);
      expect(second.appendVerified(point(frameOrdinal))).toBe(true);
      expect(first.size).toBeLessThanOrEqual(ADTS_SEEK_INDEX_MAX_POINTS);
    }

    const snapshot = first.snapshot();
    expect(snapshot).toEqual(second.snapshot());
    expect(first.compactionStride).toBe(second.compactionStride);
    expect(first.compactionStride).toBeGreaterThan(1);
    expect(first.compactionStride).toBeLessThanOrEqual(8);
    expect(snapshot.length).toBeLessThanOrEqual(ADTS_SEEK_INDEX_MAX_POINTS);
    expect(snapshot[0]).toEqual(point(0));
    expect(snapshot.at(-1)).toEqual(point(totalPoints - 1));
    expect(first.latestVerified).toEqual(point(totalPoints - 1));

    for (let index = 1; index < snapshot.length; index += 1) {
      expect(snapshot[index]!.frameOrdinal).toBeGreaterThan(snapshot[index - 1]!.frameOrdinal);
      expect(snapshot[index]!.byteOffset).toBeGreaterThan(snapshot[index - 1]!.byteOffset);
      expect(snapshot[index]).toEqual(point(snapshot[index]!.frameOrdinal));
    }

    for (let target = 0; target < totalPoints; target += 137) {
      const anchor = first.floorAnchor(target);
      expect(anchor.frameOrdinal).toBeLessThanOrEqual(target);
      expect(anchor).toEqual(point(anchor.frameOrdinal));
      const retainedIndex = snapshot.findIndex(
        (retained) => retained.frameOrdinal === anchor.frameOrdinal,
      );
      expect(retainedIndex).toBeGreaterThanOrEqual(0);
      expect(snapshot[retainedIndex + 1]?.frameOrdinal ?? Number.POSITIVE_INFINITY).toBeGreaterThan(
        target,
      );
    }
  });

  it('keeps bounded deterministic anchors for a 20k hostile sparse monotonic sequence', () => {
    const maxPoints = 64;
    const first = new AdtsSeekIndex(point(0, 0), { maxPoints });
    const second = new AdtsSeekIndex(point(0, 0), { maxPoints });
    let frameOrdinal = 0;
    let byteOffset = 0;

    for (let count = 1; count <= 20_000; count += 1) {
      frameOrdinal += ((count * 17) % 11) + 1;
      byteOffset += ((count * 31) % 1_447) + 7;
      const candidate = { frameOrdinal, byteOffset };
      expect(first.appendVerified(candidate)).toBe(true);
      expect(second.appendVerified(candidate)).toBe(true);
      expect(first.size).toBeLessThanOrEqual(maxPoints);
    }

    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.compactionStride).toBe(second.compactionStride);
    expect(first.compactionStride).toBeLessThan(16_384);
    expect(first.snapshot().length).toBeGreaterThan(maxPoints / 4);
    expect(first.origin).toEqual(point(0, 0));
    expect(first.latestVerified).toEqual({ frameOrdinal, byteOffset });
    expect(first.floorAnchor(frameOrdinal)).toEqual({ frameOrdinal, byteOffset });
  });

  it('keeps a maxPoints=2 index bounded across repeated pathological compactions', () => {
    const first = new AdtsSeekIndex(point(0, 0), { maxPoints: 2 });
    const second = new AdtsSeekIndex(point(0, 0), { maxPoints: 2 });

    for (let frameOrdinal = 1; frameOrdinal <= 20_000; frameOrdinal += 1) {
      const candidate = point(frameOrdinal, frameOrdinal * 7);
      expect(first.appendVerified(candidate)).toBe(true);
      expect(second.appendVerified(candidate)).toBe(true);
      expect(first.size).toBeLessThanOrEqual(2);
    }

    expect(first.snapshot()).toEqual([point(0, 0), point(20_000, 140_000)]);
    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.latestVerified).toEqual(point(20_000, 140_000));
    expect(first.floorAnchor(19_999)).toEqual(point(0, 0));
    expect(first.floorAnchor(20_000)).toEqual(point(20_000, 140_000));
    expect(Number.isSafeInteger(first.compactionStride)).toBe(true);
    expect(first.compactionStride).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it('keeps maxPoints=3 snapshots bounded, ordered, exact, and immutable', () => {
    const index = new AdtsSeekIndex(point(0, 0), { maxPoints: 3 });
    let maximumObservedSize = index.size;

    for (let frameOrdinal = 1; frameOrdinal <= 20_000; frameOrdinal += 1) {
      expect(index.appendVerified(point(frameOrdinal, frameOrdinal * 11))).toBe(true);
      maximumObservedSize = Math.max(maximumObservedSize, index.size);
    }

    const snapshot = index.snapshot();
    expect(maximumObservedSize).toBeLessThanOrEqual(3);
    expect(snapshot.length).toBeLessThanOrEqual(3);
    expect(snapshot[0]).toEqual(point(0, 0));
    expect(snapshot.at(-1)).toEqual(point(20_000, 220_000));
    expect(Object.isFrozen(snapshot)).toBe(true);
    for (let retainedIndex = 0; retainedIndex < snapshot.length; retainedIndex += 1) {
      const retained = snapshot[retainedIndex]!;
      expect(Object.isFrozen(retained)).toBe(true);
      if (retainedIndex > 0) {
        expect(retained.frameOrdinal).toBeGreaterThan(snapshot[retainedIndex - 1]!.frameOrdinal);
        expect(retained.byteOffset).toBeGreaterThan(snapshot[retainedIndex - 1]!.byteOffset);
      }
    }
    expect(index.floorAnchor(20_000)).toEqual(point(20_000, 220_000));
  });

  it('terminates deterministic compaction when sparse ordinals share many power-of-two factors', () => {
    const maxPoints = 4;
    const ordinalStep = 2 ** 40;
    const first = new AdtsSeekIndex(point(0, 0), { maxPoints });
    const second = new AdtsSeekIndex(point(0, 0), { maxPoints });

    for (let index = 1; index <= 100; index += 1) {
      const frameOrdinal = index * ordinalStep;
      const candidate = { frameOrdinal, byteOffset: frameOrdinal + index };
      expect(first.appendVerified(candidate)).toBe(true);
      expect(second.appendVerified(candidate)).toBe(true);
      expect(first.size).toBeLessThanOrEqual(maxPoints);
    }

    const latest = {
      frameOrdinal: 100 * ordinalStep,
      byteOffset: 100 * ordinalStep + 100,
    };
    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.latestVerified).toEqual(latest);
    expect(first.floorAnchor(latest.frameOrdinal)).toEqual(latest);
    expect(first.floorAnchor(latest.frameOrdinal - 1).frameOrdinal).toBeLessThan(
      latest.frameOrdinal,
    );
    expect(Number.isSafeInteger(first.compactionStride)).toBe(true);
  });
});
