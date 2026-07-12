import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import type {
  FilePlaybackSource,
  FilePlaybackSourcePhase,
  FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeSource(queueItemId: QueueItemId, phase: FilePlaybackSourcePhase = 'new') {
  let currentPhase = phase;
  const calls: string[] = [];
  const prepareGate = deferred<FilePlaybackSourceSnapshot>();
  let gated = false;
  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId,
    backend: 'streaming-flac',
    phase: currentPhase,
    revision: 0,
    run: null,
    durationSeconds: 10,
    positionSeconds: 0,
    bufferedAheadSeconds: currentPhase === 'ready' || currentPhase === 'connected' ? 4 : 0,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
  const source = {
    queueItemId,
    backend: 'streaming-flac',
    prepare: vi.fn(async () => {
      calls.push(`prepare:${queueItemId}`);
      if (gated) return prepareGate.promise;
      currentPhase = 'ready';
      return snapshot();
    }),
    connect: vi.fn(async () => {
      calls.push(`connect:${queueItemId}`);
      currentPhase = 'connected';
      return snapshot();
    }),
    arm: vi.fn(),
    finalize: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    positionAt: vi.fn(),
    getSnapshot: vi.fn(snapshot),
    destroy: vi.fn(async () => {
      calls.push(`destroy:${queueItemId}`);
      currentPhase = 'destroyed';
    }),
  } as unknown as FilePlaybackSource;
  return {
    source,
    calls,
    gatePrepare() {
      gated = true;
    },
    resolvePrepare() {
      currentPhase = 'ready';
      prepareGate.resolve(snapshot());
    },
    rejectPrepare(error: Error) {
      prepareGate.reject(error);
    },
  };
}

const Q1 = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const Q2 = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const Q3 = '00000000-0000-4000-8000-000000000003' as QueueItemId;
const destination = {} as AudioNode;

describe('FilePlaybackManager', () => {
  it('primes a standby without connecting it to the audible graph', async () => {
    const manager = new FilePlaybackManager();
    const next = makeSource(Q2);

    await expect(manager.prepareStandby(next.source)).resolves.toMatchObject({ published: true });
    expect(next.source.prepare).toHaveBeenCalledOnce();
    expect(next.source.connect).not.toHaveBeenCalled();
    expect(manager.snapshot().standby?.queueItemId).toBe(Q2);
  });

  it('promotes the exact standby object without preparing or downloading it again', async () => {
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, 'ready');
    const next = makeSource(Q2);
    await manager.activate(current.source, destination);
    await manager.prepareStandby(next.source);

    const promoted = await manager.promoteStandby(Q2, destination);

    expect(promoted).toMatchObject({ published: true });
    expect(manager.activeSource()).toBe(next.source);
    expect(manager.standbySource()).toBeNull();
    expect(next.source.prepare).toHaveBeenCalledOnce();
    expect(next.source.connect).toHaveBeenCalledOnce();
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });

  it('does not care that a prepared occurrence changed array position', async () => {
    const manager = new FilePlaybackManager();
    const target = makeSource(Q3);
    await manager.prepareStandby(target.source);

    // A queue reorder has no manager API because array position is not source identity.
    expect(await manager.promoteStandby(Q3, destination)).toMatchObject({ published: true });
    expect(manager.activeSource()).toBe(target.source);
  });

  it('prevents a superseded slow standby from publishing', async () => {
    const manager = new FilePlaybackManager();
    const slow = makeSource(Q2);
    slow.gatePrepare();
    const fast = makeSource(Q3);

    const slowResult = manager.prepareStandby(slow.source);
    await Promise.resolve();
    await manager.prepareStandby(fast.source);
    slow.resolvePrepare();

    await expect(slowResult).resolves.toMatchObject({ published: false, reason: 'superseded' });
    expect(slow.source.destroy).toHaveBeenCalledOnce();
    expect(manager.standbySource()).toBe(fast.source);
  });

  it('keeps an existing standby when a replacement fails to prepare', async () => {
    const manager = new FilePlaybackManager();
    const existing = makeSource(Q2);
    const failing = makeSource(Q3);
    failing.gatePrepare();
    await manager.prepareStandby(existing.source);
    const replacement = manager.prepareStandby(failing.source);
    failing.rejectPrepare(new Error('decode failed'));

    await expect(replacement).rejects.toThrow('decode failed');
    expect(manager.standbySource()).toBe(existing.source);
    expect(failing.source.destroy).toHaveBeenCalledOnce();
  });

  it('discards only the source owned by the removed queue item', async () => {
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, 'ready');
    const next = makeSource(Q2);
    await manager.activate(current.source, destination);
    await manager.prepareStandby(next.source);

    await manager.discardQueueItem(Q1);
    expect(current.source.destroy).toHaveBeenCalledOnce();
    expect(next.source.destroy).not.toHaveBeenCalled();
    expect(manager.standbySource()).toBe(next.source);
  });

  it('clears active and standby exactly once and publishes no native objects', async () => {
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, 'ready');
    const next = makeSource(Q2);
    await manager.activate(current.source, destination);
    await manager.prepareStandby(next.source);

    const serialized = JSON.parse(JSON.stringify(manager.snapshot()));
    expect(serialized.active.queueItemId).toBe(Q1);
    expect(serialized.standby.queueItemId).toBe(Q2);
    await manager.clear();

    expect(current.source.destroy).toHaveBeenCalledOnce();
    expect(next.source.destroy).toHaveBeenCalledOnce();
    expect(manager.snapshot()).toEqual({ active: null, standby: null });
  });
});
