/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId } from '../../types/index.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => {
  const pending = new Map<
    string,
    { promise: Promise<unknown>; resolve: (value: unknown) => void }
  >();
  const runtime = {
    enabled: vi.fn(() => true),
    hostRoomSnapshot: vi.fn(() => Object.freeze({ roomGeneration: 1 })),
    currentHostRendererSnapshot: vi.fn(() => null),
    startLocalTrack: vi.fn(
      ({ queueItemId }: { queueItemId: string; file: File; signal: AbortSignal }) =>
        pending.get(queueItemId)?.promise ?? Promise.reject(new Error('missing deferred start')),
    ),
    replayCurrent: vi.fn(),
  };
  return { pending, runtime };
});

vi.mock('../file-playback-product-runtime.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../file-playback-product-runtime.ts')>();
  return {
    ...actual,
    getFilePlaybackProductRuntime: () => mocks.runtime,
  };
});

import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { playTrack } from '../playlist.ts';

function committedTrack(queueItemId: QueueItemId, revision: number): Readonly<object> {
  const runId = `run-${revision}`;
  return Object.freeze({
    status: 'committed',
    asset: Object.freeze({ queueItemId }),
    attempt: Object.freeze({ queueItemId, revision, runId }),
    timeline: Object.freeze({
      phase: 'playing',
      revision,
      positionSeconds: 0,
      run: Object.freeze({ queueItemId, runId }),
    }),
  });
}

function installDeferredStart(queueItemId: QueueItemId): Deferred<unknown> {
  const operation = deferred<unknown>();
  mocks.pending.set(queueItemId, operation);
  return operation;
}

beforeEach(() => {
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  mocks.pending.clear();
  mocks.runtime.enabled.mockReturnValue(true);
  mocks.runtime.hostRoomSnapshot.mockReturnValue(Object.freeze({ roomGeneration: 1 }));
  mocks.runtime.currentHostRendererSnapshot.mockReturnValue(null);
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
  setState('room.context', {
    kind: 'standard',
    roomId: null,
    role: 'idle',
    coordinatorId: null,
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  });
});

afterEach(() => {
  clearAllManagedTimers();
});

describe('V2 playlist intent ownership', () => {
  it('supersedes an older start without publishing its queue selection or loading owner', async () => {
    const firstQueueItemId = '10000000-0000-4000-8000-000000000001';
    const secondQueueItemId = '10000000-0000-4000-8000-000000000002';
    const firstFile = new File(['first'], 'first.mp3', { type: 'audio/mpeg' });
    const secondFile = new File(['second'], 'second.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [
      {
        queueItemId: firstQueueItemId,
        type: 'file',
        name: firstFile.name,
        file: firstFile,
        videoId: null,
        playlistId: null,
      },
      {
        queueItemId: secondQueueItemId,
        type: 'file',
        name: secondFile.name,
        file: secondFile,
        videoId: null,
        playlistId: null,
      },
    ]);
    const firstStart = installDeferredStart(firstQueueItemId);
    const secondStart = installDeferredStart(secondQueueItemId);
    const pending: Array<{ owner: string; token: string | number }> = [];
    const settled: Array<{ owner: string; token: string | number }> = [];
    bus.on('player:v2-file-loading-pending', (event) => pending.push(event));
    bus.on('player:v2-file-loading-settled', (event) => settled.push(event));

    const firstPlay = playTrack(firstQueueItemId);
    const firstSignal = mocks.runtime.startLocalTrack.mock.calls[0]?.[0].signal;
    const secondPlay = playTrack(secondQueueItemId);

    expect(firstSignal?.aborted).toBe(true);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ owner: 'host-start' });
    expect(settled).toContainEqual(pending[0]);

    firstStart.resolve(committedTrack(firstQueueItemId, 1));
    await firstPlay;
    expect(getState('playlist.currentQueueItemId')).not.toBe(firstQueueItemId);

    secondStart.resolve(committedTrack(secondQueueItemId, 2));
    await secondPlay;

    expect(getState('playlist.currentQueueItemId')).toBe(secondQueueItemId);
    expect(settled).toEqual(expect.arrayContaining(pending));
    expect(new Set(settled.map((event) => event.token)).size).toBe(2);
  });
});
