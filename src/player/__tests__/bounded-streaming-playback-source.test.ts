import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  BoundedStreamingPlaybackSource,
  type BoundedStreamingPlaybackSourceOptions,
} from '../backends/bounded-streaming-playback-source.ts';
import type { StreamingDecoderAdapter } from '../streaming/decoder-adapter.ts';

const QID = '00000000-0000-4000-8000-000000000901' as QueueItemId;

function decoder(totalMediaFrames = 480_000) {
  const open = vi.fn(async () => undefined);
  const startGeneration = vi.fn(async () => undefined);
  const stopGeneration = vi.fn();
  const close = vi.fn(async () => undefined);
  const adapter: StreamingDecoderAdapter = {
    info: Object.freeze({
      mediaSampleRateHz: 48_000,
      channelCount: 2,
      totalMediaFrames,
    }),
    opened: false,
    open,
    startGeneration,
    stopGeneration,
    close,
  };
  return { adapter, open, startGeneration, stopGeneration, close };
}

function options(
  createDecoder: () => StreamingDecoderAdapter,
): BoundedStreamingPlaybackSourceOptions {
  return {
    queueItemId: QID,
    createDecoder,
    audioContext: { sampleRate: 48_000 } as AudioContext,
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (performanceTimeMs) => performanceTimeMs / 1_000,
  };
}

describe('BoundedStreamingPlaybackSource ownership', () => {
  it('validates common inputs before invoking the decoder factory', () => {
    const createDecoder = vi.fn(() => decoder().adapter);
    const invalid = {
      ...options(createDecoder),
      audioContext: { sampleRate: 0 } as AudioContext,
    };

    expect(() => new BoundedStreamingPlaybackSource(invalid)).toThrow(/AudioContext is invalid/i);
    expect(createDecoder).not.toHaveBeenCalled();
  });

  it('invokes the decoder factory once without opening it and closes an unprepared source once', async () => {
    const h = decoder();
    const createDecoder = vi.fn(() => h.adapter);
    const source = new BoundedStreamingPlaybackSource(options(createDecoder));

    expect(source.backend).toBe('bounded-stream');
    expect(createDecoder).toHaveBeenCalledTimes(1);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.startGeneration).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();

    await source.destroy();
    await source.destroy();
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('best-effort closes exactly once when validation fails after the factory returns', async () => {
    const h = decoder(0);
    h.close.mockRejectedValueOnce(new Error('synthetic close failure'));
    const createDecoder = vi.fn(() => h.adapter);

    expect(() => new BoundedStreamingPlaybackSource(options(createDecoder))).toThrow(
      /invalid adapter/i,
    );
    await Promise.resolve();
    expect(createDecoder).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.open).not.toHaveBeenCalled();
  });
});
