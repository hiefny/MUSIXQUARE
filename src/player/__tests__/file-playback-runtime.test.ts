import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
import { FilePlaybackRuntime } from '../file-playback-runtime.ts';
import type {
  FilePlaybackPosition,
  FilePlaybackSource,
  FilePlaybackSourcePhase,
  FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';

const Q1 = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const destination = { context: {} } as AudioNode;

function source(queueItemId: QueueItemId, durationSeconds = 12): FilePlaybackSource {
  let phase: FilePlaybackSourcePhase = 'new';
  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId,
    backend: 'streaming-flac',
    phase,
    revision: 0,
    run: null,
    durationSeconds,
    positionSeconds: 2,
    bufferedAheadSeconds: 4,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
  return {
    queueItemId,
    backend: 'streaming-flac',
    prepare: vi.fn(async () => {
      phase = 'ready';
      return snapshot();
    }),
    connect: vi.fn(async () => {
      phase = 'connected';
      return snapshot();
    }),
    arm: vi.fn(),
    finalize: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    positionAt: vi.fn(
      (localPerformanceTimeMs): FilePlaybackPosition => ({
        queueItemId,
        run: null,
        phase,
        positionSeconds: localPerformanceTimeMs / 1_000,
        bufferedAheadSeconds: 4,
        underrunCount: 0,
      }),
    ),
    getSnapshot: vi.fn(snapshot),
    destroy: vi.fn(async () => {
      phase = 'destroyed';
    }),
  };
}

function legacyBuffer(duration: number): AudioBuffer {
  return { duration } as AudioBuffer;
}

describe('FilePlaybackRuntime', () => {
  it('falls back to the resident legacy AudioBuffer without changing playback', () => {
    const runtime = new FilePlaybackRuntime({
      legacyView: () => ({ audioBuffer: legacyBuffer(9), queueItemId: Q1 }),
    });

    expect(runtime.availability(Q1)).toEqual({
      available: true,
      backend: 'legacy-audio-buffer',
      queueItemId: Q1,
      durationSeconds: 9,
    });
    expect(runtime.hasPlayableSource(Q2)).toBe(false);
    expect(runtime.position(Q1)).toBeNull();
  });

  it('prefers the exact managed source and exposes its monotonic position', async () => {
    const manager = new FilePlaybackManager();
    const managed = source(Q1, 20);
    await manager.activate(managed, destination);
    const runtime = new FilePlaybackRuntime({
      manager,
      monotonicNow: () => 2_500,
      legacyView: () => ({ audioBuffer: legacyBuffer(9), queueItemId: Q1 }),
    });

    expect(runtime.availability(Q1)).toEqual({
      available: true,
      backend: 'streaming-flac',
      queueItemId: Q1,
      durationSeconds: 20,
    });
    expect(runtime.position(Q1)?.positionSeconds).toBe(2.5);
    expect(managed.positionAt).toHaveBeenCalledWith(2_500);
  });

  it('reads the exact cutover current instead of the empty legacy active slot', () => {
    const manager = new FilePlaybackManager();
    const port = Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
    const position: FilePlaybackPosition = {
      queueItemId: Q1,
      run: null,
      phase: 'playing',
      positionSeconds: 3.5,
      bufferedAheadSeconds: 4,
      underrunCount: 0,
    };
    vi.spyOn(manager, 'currentCutoverPort').mockReturnValue(port);
    vi.spyOn(manager, 'currentCutoverPosition').mockReturnValue(position);
    const runtime = new FilePlaybackRuntime({ manager, monotonicNow: () => 3_500 });

    expect(runtime.position(Q1)).toBe(position);
    expect(manager.currentCutoverPosition).toHaveBeenCalledWith(port, 3_500);
    expect(runtime.position(Q2)).toBeNull();
  });

  it('does not expose an unrelated managed or legacy queue occurrence', async () => {
    const manager = new FilePlaybackManager();
    await manager.activate(source(Q1), destination);
    const runtime = new FilePlaybackRuntime({
      manager,
      legacyView: () => ({ audioBuffer: legacyBuffer(9), queueItemId: Q1 }),
    });

    expect(runtime.availability(Q2)).toEqual({
      available: false,
      backend: null,
      queueItemId: null,
      durationSeconds: null,
    });
  });

  it('delegates queue removal and full teardown to the native source manager', async () => {
    const manager = new FilePlaybackManager();
    const active = source(Q1);
    const standby = source(Q2);
    await manager.activate(active, destination);
    await manager.prepareStandby(standby);
    const runtime = new FilePlaybackRuntime({ manager });

    await runtime.discardQueueItem(Q2);
    expect(standby.destroy).toHaveBeenCalledOnce();
    expect(runtime.standbySource()).toBeNull();

    await runtime.clear();
    expect(active.destroy).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toEqual({ active: null, standby: null });
  });
});
