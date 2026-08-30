/**
 * Bounded cumulative history for the live `/debug memory` graphs.
 *
 * The graph contract is cumulative-since-open rather than a sliding window.
 * Raw samples therefore stay exact for the first hour at 1 Hz, then older and
 * newer samples are summarized across the full time span as a min/max envelope.
 */

const DEBUG_MEMORY_GRAPH_POINT_LIMIT = 4_096;

const DEBUG_MEMORY_GRAPH_COMPACT_TARGET = DEBUG_MEMORY_GRAPH_POINT_LIMIT / 2;

interface DebugMemoryGraphPoint {
  readonly sampleIndex: number;
  readonly value: number;
}

export interface DebugMemoryGraphHistory {
  points: DebugMemoryGraphPoint[];
  sampleCount: number;
  currentValue: number | null;
  maxValue: number | null;
}

interface DebugMemoryGraphBucket {
  min: DebugMemoryGraphPoint;
  max: DebugMemoryGraphPoint;
}

function compactDebugMemoryGraphPoints(
  points: readonly DebugMemoryGraphPoint[],
): DebugMemoryGraphPoint[] {
  const first = points[0];
  const latest = points[points.length - 1];
  if (!first || !latest || points.length <= DEBUG_MEMORY_GRAPH_COMPACT_TARGET) {
    return Array.from(points);
  }

  // Each time bucket contributes at most two points. Keeping both extrema in
  // their original order retains short-lived spikes without distorting time.
  const bucketCount = Math.max(1, Math.floor((DEBUG_MEMORY_GRAPH_COMPACT_TARGET - 2) / 2));
  const sampleSpan = Math.max(1, latest.sampleIndex - first.sampleIndex);
  const buckets: Array<DebugMemoryGraphBucket | undefined> = new Array(bucketCount);

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    if (!point) continue;
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.floor(((point.sampleIndex - first.sampleIndex) * bucketCount) / sampleSpan),
    );
    const bucket = buckets[bucketIndex];
    if (!bucket) {
      buckets[bucketIndex] = { min: point, max: point };
      continue;
    }
    if (point.value < bucket.min.value) bucket.min = point;
    if (point.value > bucket.max.value) bucket.max = point;
  }

  const compacted: DebugMemoryGraphPoint[] = [first];
  for (const bucket of buckets) {
    if (!bucket) continue;
    if (bucket.min === bucket.max) {
      compacted.push(bucket.min);
    } else if (bucket.min.sampleIndex < bucket.max.sampleIndex) {
      compacted.push(bucket.min, bucket.max);
    } else {
      compacted.push(bucket.max, bucket.min);
    }
  }
  compacted.push(latest);
  return compacted;
}

export function createDebugMemoryGraphHistory(
  initialValue: number | null,
): DebugMemoryGraphHistory {
  const history: DebugMemoryGraphHistory = {
    points: [],
    sampleCount: 0,
    currentValue: null,
    maxValue: null,
  };
  appendDebugMemoryGraphSample(history, initialValue);
  return history;
}

export function appendDebugMemoryGraphSample(
  history: DebugMemoryGraphHistory,
  value: number | null,
): void {
  if (value === null || !Number.isFinite(value)) return;

  const sampleIndex = history.sampleCount;
  history.sampleCount += 1;
  history.currentValue = value;
  history.maxValue = history.maxValue === null ? value : Math.max(history.maxValue, value);
  history.points.push({ sampleIndex, value });

  if (history.points.length > DEBUG_MEMORY_GRAPH_POINT_LIMIT) {
    history.points = compactDebugMemoryGraphPoints(history.points);
  }
}
