import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from '../file-playback-manager.ts';
import {
  FilePlaybackReadProjection,
  FilePlaybackRuntime,
  type FilePlaybackProductProjectionPort,
} from '../file-playback-runtime.ts';
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

function productSnapshot(
  queueItemId: QueueItemId,
  durationSeconds = 120,
): FilePlaybackSourceSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    queueItemId,
    backend: 'streaming-flac',
    phase: 'playing',
    revision: 1,
    run: Object.freeze({ queueItemId, runId: 'product-run-1', revision: 1 }),
    durationSeconds,
    positionSeconds: 4,
    bufferedAheadSeconds: 8,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
}

function productPosition(queueItemId: QueueItemId): FilePlaybackPosition {
  return Object.freeze({
    queueItemId,
    run: Object.freeze({ queueItemId, runId: 'product-run-1', revision: 1 }),
    phase: 'playing',
    positionSeconds: 4.25,
    bufferedAheadSeconds: 7,
    underrunCount: 0,
  });
}

function productPort(
  snapshot: FilePlaybackSourceSnapshot | null,
  position: FilePlaybackPosition | null,
): FilePlaybackProductProjectionPort & {
  readonly currentHostRendererSnapshot: ReturnType<typeof vi.fn>;
  readonly hostPositionAt: ReturnType<typeof vi.fn>;
} {
  return {
    currentHostRendererSnapshot: vi.fn(() => snapshot),
    hostPositionAt: vi.fn((_localPerformanceTimeMs: number) => position),
  };
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

describe('FilePlaybackReadProjection', () => {
  it('projects every V2 host read from the product runtime without consulting legacy state', async () => {
    const manager = new FilePlaybackManager();
    await manager.activate(source(Q2, 9), destination);
    const legacy = new FilePlaybackRuntime({
      manager,
      legacyView: () => ({ audioBuffer: legacyBuffer(9), queueItemId: Q2 }),
    });
    const activeSnapshot = vi.spyOn(legacy, 'activeSnapshot');
    const availability = vi.spyOn(legacy, 'hasPlayableSource');
    const duration = vi.spyOn(legacy, 'durationSeconds');
    const legacyPosition = vi.spyOn(legacy, 'position');
    const snapshot = productSnapshot(Q1, 180);
    const position = productPosition(Q1);
    const product = productPort(snapshot, position);
    const projection = new FilePlaybackReadProjection({
      v2Enabled: true,
      legacyRuntime: legacy,
      productRuntime: product,
      monotonicNow: () => 4_321,
    });

    const projectedSnapshot = projection.activeSnapshot();
    expect(projectedSnapshot).toEqual(snapshot);
    expect(projectedSnapshot).not.toBe(snapshot);
    expect(Object.isFrozen(projectedSnapshot)).toBe(true);
    expect(projection.hasPlayableSource(Q1)).toBe(true);
    expect(projection.hasPlayableSource(Q2)).toBe(false);
    expect(projection.durationSeconds(Q1)).toBe(180);
    expect(projection.durationSeconds(Q2)).toBeNull();
    expect(projection.position(Q1)).toEqual(position);
    expect(projection.position(Q2)).toBeNull();
    expect(product.hostPositionAt).toHaveBeenCalledWith(4_321);
    expect(activeSnapshot).not.toHaveBeenCalled();
    expect(availability).not.toHaveBeenCalled();
    expect(duration).not.toHaveBeenCalled();
    expect(legacyPosition).not.toHaveBeenCalled();
  });

  it('fails closed for a V2 guest instead of exposing the legacy shadow', () => {
    const legacyView = vi.fn(() => ({ audioBuffer: legacyBuffer(30), queueItemId: Q1 }));
    const legacy = new FilePlaybackRuntime({ legacyView });
    const product = productPort(null, null);
    const projection = new FilePlaybackReadProjection({
      v2Enabled: true,
      legacyRuntime: legacy,
      productRuntime: product,
      monotonicNow: () => 1_000,
    });

    expect(projection.activeSnapshot()).toBeNull();
    expect(projection.hasPlayableSource(Q1)).toBe(false);
    expect(projection.durationSeconds(Q1)).toBeNull();
    expect(projection.position(Q1)).toBeNull();
    expect(legacyView).not.toHaveBeenCalled();
  });

  it('rejects non-canonical product objects so native bodies and extra fields cannot escape', () => {
    const snapshot = {
      ...productSnapshot(Q1),
      body: new Blob([new Uint8Array([1])]),
    } as unknown as FilePlaybackSourceSnapshot;
    const position = {
      ...productPosition(Q1),
      source: { destroy: vi.fn() },
    } as unknown as FilePlaybackPosition;
    const projection = new FilePlaybackReadProjection({
      v2Enabled: true,
      legacyRuntime: new FilePlaybackRuntime(),
      productRuntime: productPort(snapshot, position),
      monotonicNow: () => 1_000,
    });

    expect(projection.activeSnapshot()).toBeNull();
    expect(projection.hasPlayableSource()).toBe(false);
    expect(projection.durationSeconds()).toBeNull();
    expect(projection.position()).toBeNull();
  });

  it('rejects forged queue identities and positions without an active revisioned run', () => {
    const forgedQueueItemId = 'not-a-queue-item-id' as QueueItemId;
    const forgedSnapshot = {
      ...productSnapshot(Q1),
      queueItemId: forgedQueueItemId,
      run: Object.freeze({
        queueItemId: forgedQueueItemId,
        runId: 'forged-run',
        revision: 1,
      }),
    } as FilePlaybackSourceSnapshot;
    const runlessPosition = {
      ...productPosition(Q1),
      run: null,
    } as FilePlaybackPosition;
    const projection = new FilePlaybackReadProjection({
      v2Enabled: true,
      legacyRuntime: new FilePlaybackRuntime(),
      productRuntime: productPort(forgedSnapshot, runlessPosition),
      monotonicNow: () => 1_000,
    });

    expect(projection.activeSnapshot()).toBeNull();
    expect(projection.hasPlayableSource()).toBe(false);
    expect(projection.position()).toBeNull();
  });

  it('keeps the legacy class behavior and object identity when the fixed gate is off', async () => {
    const manager = new FilePlaybackManager();
    const managed = source(Q1, 20);
    await manager.activate(managed, destination);
    const legacy = new FilePlaybackRuntime({
      manager,
      monotonicNow: () => 2_500,
      legacyView: () => ({ audioBuffer: legacyBuffer(9), queueItemId: Q1 }),
    });
    const product = productPort(productSnapshot(Q2), productPosition(Q2));
    const projection = new FilePlaybackReadProjection({
      v2Enabled: false,
      legacyRuntime: legacy,
      productRuntime: product,
    });
    const legacySnapshot = legacy.activeSnapshot();
    vi.spyOn(legacy, 'activeSnapshot').mockReturnValue(legacySnapshot);

    expect(projection.activeSnapshot()).toBe(legacySnapshot);
    expect(projection.hasPlayableSource(Q1)).toBe(legacy.hasPlayableSource(Q1));
    expect(projection.durationSeconds(Q1)).toBe(legacy.durationSeconds(Q1));
    expect(projection.position(Q1)).toEqual(legacy.position(Q1));
    expect(product.currentHostRendererSnapshot).not.toHaveBeenCalled();
    expect(product.hostPositionAt).not.toHaveBeenCalled();
  });

  it('captures its gate once and never invokes migration-only legacy mutations from reads', () => {
    const legacy = new FilePlaybackRuntime();
    const discard = vi.spyOn(legacy, 'discardQueueItem');
    const clear = vi.spyOn(legacy, 'clear');
    const product = productPort(productSnapshot(Q1), productPosition(Q1));
    let requestedMode = true;
    const projection = new FilePlaybackReadProjection({
      v2Enabled: requestedMode,
      legacyRuntime: legacy,
      productRuntime: product,
      monotonicNow: () => 2_000,
    });
    requestedMode = false;

    expect(projection.hasPlayableSource(Q1)).toBe(true);
    expect(projection.durationSeconds(Q1)).toBe(120);
    expect(projection.position(Q1)).not.toBeNull();
    expect(requestedMode).toBe(false);
    expect(product.currentHostRendererSnapshot).toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});
