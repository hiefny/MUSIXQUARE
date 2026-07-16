import type { ProRoomMediaProgress } from './media-transfer.ts';

interface ByteSizedValue {
  readonly size: number;
}

interface WeightedProgressEntry<T extends ByteSizedValue> {
  value: T;
  onProgress: ProRoomMediaProgress;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Build one progress observer per sequential transfer and report aggregate
 * progress by bytes. A large file therefore contributes proportionally more
 * than a small one, while repeated/out-of-order transport ticks cannot move
 * the visible batch progress backwards.
 */
export function createByteWeightedProgressEntries<T extends ByteSizedValue>(
  values: readonly T[],
  report: ProRoomMediaProgress,
): WeightedProgressEntry<T>[] {
  const weights = values.map((value) =>
    Number.isSafeInteger(value.size) && value.size > 0 ? value.size : 0,
  );
  const totalBytes = weights.reduce((sum, size) => sum + size, 0);
  const fractions = values.map(() => 0);
  let lastReported = 0;

  return values.map((value, index) => ({
    value,
    onProgress(fraction): void {
      fractions[index] = Math.max(fractions[index] ?? 0, clampFraction(fraction));
      const weightedFraction =
        totalBytes > 0
          ? weights.reduce((sum, size, weightIndex) => {
              return sum + size * (fractions[weightIndex] ?? 0);
            }, 0) / totalBytes
          : fractions.reduce((sum, valueFraction) => sum + valueFraction, 0) /
            Math.max(1, fractions.length);
      lastReported = Math.max(lastReported, clampFraction(weightedFraction));
      report(lastReported);
    },
  }));
}
