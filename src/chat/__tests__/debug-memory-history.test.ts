import { describe, expect, it } from 'vitest';
import {
  appendDebugMemoryGraphSample,
  createDebugMemoryGraphHistory,
} from '../debug-memory-history.ts';

const DEBUG_MEMORY_GRAPH_POINT_LIMIT = 4_096;

describe('debug memory graph history', () => {
  it('keeps every raw sample and its original index until the point limit', () => {
    const history = createDebugMemoryGraphHistory(null);

    for (let value = 0; value < DEBUG_MEMORY_GRAPH_POINT_LIMIT; value += 1) {
      appendDebugMemoryGraphSample(history, value);
    }

    expect(history.points).toHaveLength(DEBUG_MEMORY_GRAPH_POINT_LIMIT);
    expect(history.sampleCount).toBe(DEBUG_MEMORY_GRAPH_POINT_LIMIT);
    expect(history.currentValue).toBe(DEBUG_MEMORY_GRAPH_POINT_LIMIT - 1);
    expect(history.maxValue).toBe(DEBUG_MEMORY_GRAPH_POINT_LIMIT - 1);
    expect(history.points[0]).toEqual({ sampleIndex: 0, value: 0 });
    expect(history.points[2_048]).toEqual({ sampleIndex: 2_048, value: 2_048 });
    expect(history.points.at(-1)).toEqual({
      sampleIndex: DEBUG_MEMORY_GRAPH_POINT_LIMIT - 1,
      value: DEBUG_MEMORY_GRAPH_POINT_LIMIT - 1,
    });
  });

  it('stays bounded while retaining the full time span and global extrema', () => {
    const history = createDebugMemoryGraphHistory(null);
    const sampleCount = 100_000;
    const troughIndex = 12_345;
    const spikeIndex = 67_890;
    let retainedPeak = 0;

    for (let index = 0; index < sampleCount; index += 1) {
      let value = 100 + (index % 31);
      if (index === troughIndex) value = 1;
      if (index === spikeIndex) value = 10_000;
      appendDebugMemoryGraphSample(history, value);
      retainedPeak = Math.max(retainedPeak, history.points.length);
    }

    expect(retainedPeak).toBeLessThanOrEqual(DEBUG_MEMORY_GRAPH_POINT_LIMIT);
    expect(history.sampleCount).toBe(sampleCount);
    expect(history.currentValue).toBe(100 + ((sampleCount - 1) % 31));
    expect(history.maxValue).toBe(10_000);
    expect(history.points[0]).toEqual({ sampleIndex: 0, value: 100 });
    expect(history.points.at(-1)).toEqual({
      sampleIndex: sampleCount - 1,
      value: 100 + ((sampleCount - 1) % 31),
    });
    expect(history.points).toContainEqual({ sampleIndex: troughIndex, value: 1 });
    expect(history.points).toContainEqual({ sampleIndex: spikeIndex, value: 10_000 });

    for (let index = 1; index < history.points.length; index += 1) {
      expect(history.points[index]?.sampleIndex).toBeGreaterThan(
        history.points[index - 1]?.sampleIndex ?? -1,
      );
    }
  });

  it('ignores unavailable and non-finite samples without corrupting counters', () => {
    const history = createDebugMemoryGraphHistory(12);

    appendDebugMemoryGraphSample(history, null);
    appendDebugMemoryGraphSample(history, Number.NaN);
    appendDebugMemoryGraphSample(history, Number.POSITIVE_INFINITY);
    appendDebugMemoryGraphSample(history, Number.NEGATIVE_INFINITY);

    expect(history).toEqual({
      points: [{ sampleIndex: 0, value: 12 }],
      sampleCount: 1,
      currentValue: 12,
      maxValue: 12,
    });
  });
});
