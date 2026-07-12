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
  const connectGate = deferred<FilePlaybackSourceSnapshot>();
  let prepareGated = false;
  let connectGated = false;
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
      if (prepareGated) return prepareGate.promise;
      currentPhase = 'ready';
      return snapshot();
    }),
    connect: vi.fn(async () => {
      calls.push(`connect:${queueItemId}`);
      if (connectGated) return connectGate.promise;
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
      prepareGated = true;
    },
    resolvePrepare() {
      currentPhase = 'ready';
      prepareGate.resolve(snapshot());
    },
    rejectPrepare(error: Error) {
      prepareGate.reject(error);
    },
    gateConnect() {
      connectGated = true;
    },
    resolveConnect() {
      currentPhase = 'connected';
      connectGate.resolve(snapshot());
    },
    rejectConnect(error: Error) {
      connectGate.reject(error);
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

  it('deduplicates concurrent standby preparation of the same source', async () => {
    const manager = new FilePlaybackManager();
    const next = makeSource(Q2);
    next.gatePrepare();

    const first = manager.prepareStandby(next.source);
    const second = manager.prepareStandby(next.source);

    expect(second).toBe(first);
    expect(next.source.prepare).toHaveBeenCalledOnce();
    next.resolvePrepare();
    await expect(first).resolves.toMatchObject({ published: true });
    expect(manager.standbySource()).toBe(next.source);
  });

  it('atomically transfers a pending standby preparation into activation', async () => {
    const manager = new FilePlaybackManager();
    const next = makeSource(Q2);
    next.gatePrepare();

    const standby = manager.prepareStandby(next.source);
    const active = manager.activate(next.source, destination);

    await expect(standby).resolves.toMatchObject({ published: false, reason: 'superseded' });
    expect(next.source.prepare).toHaveBeenCalledOnce();
    expect(next.source.destroy).not.toHaveBeenCalled();
    expect(manager.standbySource()).toBeNull();

    next.resolvePrepare();
    await expect(active).resolves.toMatchObject({ published: true });
    expect(next.source.prepare).toHaveBeenCalledOnce();
    expect(next.source.connect).toHaveBeenCalledOnce();
    expect(next.source.destroy).not.toHaveBeenCalled();
    expect(manager.activeSource()).toBe(next.source);
    expect(manager.standbySource()).toBeNull();
  });

  it('maps a standby request racing an existing activation to duplicates-active', async () => {
    const manager = new FilePlaybackManager();
    const next = makeSource(Q2);
    next.gatePrepare();

    const active = manager.activate(next.source, destination);
    const standby = manager.prepareStandby(next.source);
    next.resolvePrepare();

    await expect(active).resolves.toMatchObject({ published: true });
    await expect(standby).resolves.toMatchObject({
      published: false,
      reason: 'duplicates-active',
    });
    expect(next.source.prepare).toHaveBeenCalledOnce();
    expect(next.source.connect).toHaveBeenCalledOnce();
    expect(next.source.destroy).not.toHaveBeenCalled();
    expect(manager.activeSource()).toBe(next.source);
    expect(manager.standbySource()).toBeNull();
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

  it('keeps the existing active source while its replacement prepares and connects', async () => {
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, 'ready');
    const replacement = makeSource(Q2);
    replacement.gatePrepare();
    replacement.gateConnect();
    await manager.activate(current.source, destination);

    const activation = manager.activate(replacement.source, destination);
    expect(manager.activeSource()).toBe(current.source);
    expect(current.source.destroy).not.toHaveBeenCalled();

    replacement.resolvePrepare();
    await vi.waitFor(() => expect(replacement.source.connect).toHaveBeenCalledOnce());
    expect(manager.activeSource()).toBe(current.source);
    expect(current.source.destroy).not.toHaveBeenCalled();

    replacement.resolveConnect();
    await expect(activation).resolves.toMatchObject({ published: true });
    expect(manager.activeSource()).toBe(replacement.source);
    expect(current.source.destroy).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent activation of the same source', async () => {
    const manager = new FilePlaybackManager();
    const next = makeSource(Q2, 'ready');
    next.gateConnect();

    const first = manager.activate(next.source, destination);
    const second = manager.activate(next.source, destination);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(next.source.connect).toHaveBeenCalledOnce());
    next.resolveConnect();
    await expect(first).resolves.toMatchObject({ published: true });
  });

  it('supersedes and destroys an older pending activation exactly once', async () => {
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, 'ready');
    const slow = makeSource(Q2);
    const latest = makeSource(Q3);
    slow.gatePrepare();
    await manager.activate(current.source, destination);

    const slowActivation = manager.activate(slow.source, destination);
    const latestActivation = manager.activate(latest.source, destination);

    await expect(slowActivation).resolves.toMatchObject({
      published: false,
      reason: 'superseded',
    });
    await expect(latestActivation).resolves.toMatchObject({ published: true });
    expect(slow.source.destroy).toHaveBeenCalledOnce();
    expect(current.source.destroy).toHaveBeenCalledOnce();
    expect(manager.activeSource()).toBe(latest.source);

    slow.resolvePrepare();
    await Promise.resolve();
    expect(slow.source.connect).not.toHaveBeenCalled();
    expect(slow.source.destroy).toHaveBeenCalledOnce();
    expect(manager.activeSource()).toBe(latest.source);
  });

  it('cancels a pending standby when its queue item is discarded and never revives it', async () => {
    const manager = new FilePlaybackManager();
    const removed = makeSource(Q2);
    removed.gatePrepare();

    const preparation = manager.prepareStandby(removed.source);
    await manager.discardQueueItem(Q2);

    await expect(preparation).resolves.toMatchObject({ published: false, reason: 'superseded' });
    expect(removed.source.destroy).toHaveBeenCalledOnce();
    expect(manager.standbySource()).toBeNull();

    removed.resolvePrepare();
    await Promise.resolve();
    expect(manager.standbySource()).toBeNull();
    expect(removed.source.destroy).toHaveBeenCalledOnce();

    const recreated = makeSource(Q2);
    await expect(manager.prepareStandby(recreated.source)).resolves.toMatchObject({
      published: false,
      reason: 'superseded',
    });
    expect(recreated.source.prepare).not.toHaveBeenCalled();
    expect(recreated.source.destroy).toHaveBeenCalledOnce();
    expect(manager.standbySource()).toBeNull();
  });

  it('cancels a pending activation when its queue item is discarded', async () => {
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, 'ready');
    const removed = makeSource(Q2);
    removed.gatePrepare();
    await manager.activate(current.source, destination);

    const activation = manager.activate(removed.source, destination);
    await manager.discardQueueItem(Q2);

    await expect(activation).resolves.toMatchObject({ published: false, reason: 'superseded' });
    expect(removed.source.destroy).toHaveBeenCalledOnce();
    expect(current.source.destroy).not.toHaveBeenCalled();
    expect(manager.activeSource()).toBe(current.source);

    removed.resolvePrepare();
    await Promise.resolve();
    expect(removed.source.connect).not.toHaveBeenCalled();
    expect(manager.activeSource()).toBe(current.source);
  });

  it('cancels an activation blocked in connect without replacing the current active', async () => {
    const manager = new FilePlaybackManager();
    const current = makeSource(Q1, 'ready');
    const removed = makeSource(Q2, 'ready');
    removed.gateConnect();
    await manager.activate(current.source, destination);

    const activation = manager.activate(removed.source, destination);
    await vi.waitFor(() => expect(removed.source.connect).toHaveBeenCalledOnce());
    await manager.discardQueueItem(Q2);

    await expect(activation).resolves.toMatchObject({ published: false, reason: 'superseded' });
    expect(removed.source.destroy).toHaveBeenCalledOnce();
    expect(current.source.destroy).not.toHaveBeenCalled();
    expect(manager.activeSource()).toBe(current.source);

    removed.resolveConnect();
    await Promise.resolve();
    expect(removed.source.destroy).toHaveBeenCalledOnce();
    expect(manager.activeSource()).toBe(current.source);
  });

  it('clear cancels every pending slot and ignores all late completions', async () => {
    const manager = new FilePlaybackManager();
    const pendingActive = makeSource(Q2);
    const pendingStandby = makeSource(Q3);
    pendingActive.gatePrepare();
    pendingStandby.gatePrepare();

    const activation = manager.activate(pendingActive.source, destination);
    const preparation = manager.prepareStandby(pendingStandby.source);
    await manager.clear();

    await expect(activation).resolves.toMatchObject({ published: false, reason: 'superseded' });
    await expect(preparation).resolves.toMatchObject({ published: false, reason: 'superseded' });
    expect(pendingActive.source.destroy).toHaveBeenCalledOnce();
    expect(pendingStandby.source.destroy).toHaveBeenCalledOnce();
    expect(manager.snapshot()).toEqual({ active: null, standby: null });

    pendingActive.resolvePrepare();
    pendingStandby.resolvePrepare();
    await Promise.resolve();
    expect(pendingActive.source.connect).not.toHaveBeenCalled();
    expect(pendingActive.source.destroy).toHaveBeenCalledOnce();
    expect(pendingStandby.source.destroy).toHaveBeenCalledOnce();
    expect(manager.snapshot()).toEqual({ active: null, standby: null });
  });

  it('releases removed queue tombstones only at a full authority clear', async () => {
    const manager = new FilePlaybackManager();
    await manager.discardQueueItem(Q2);

    const stale = makeSource(Q2);
    await expect(manager.prepareStandby(stale.source)).resolves.toMatchObject({
      published: false,
      reason: 'superseded',
    });
    expect(stale.source.prepare).not.toHaveBeenCalled();

    await manager.clear();
    const authoritative = makeSource(Q2);
    await expect(manager.prepareStandby(authoritative.source)).resolves.toMatchObject({
      published: true,
    });
    expect(authoritative.source.prepare).toHaveBeenCalledOnce();
    expect(manager.standbySource()).toBe(authoritative.source);
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
