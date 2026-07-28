/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId } from '../../types/index.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => {
  const pending = new Map<
    string,
    { promise: Promise<unknown>; resolve: (value: unknown) => void }
  >();
  const runtime = {
    enabled: vi.fn(() => true),
    hostRoomSnapshot: vi.fn(() => Object.freeze({ roomGeneration: 1 })),
    currentHostRendererSnapshot: vi.fn(
      (): { queueItemId: string; durationSeconds: number } | null => null,
    ),
    currentHostTerminalRendererObservation: vi.fn(
      (): { queueItemId: string; durationSeconds: number } | null => null,
    ),
    currentHostFailedRendererObservation: vi.fn(
      (): { queueItemId: string; durationSeconds: number } | null => null,
    ),
    startLocalTrack: vi.fn(
      ({ queueItemId }: { queueItemId: string; file: File; signal: AbortSignal }) =>
        pending.get(queueItemId)?.promise ?? Promise.reject(new Error('missing deferred start')),
    ),
    replayCurrent: vi.fn(),
    stopCurrent: vi.fn(),
  };
  return {
    pending,
    runtime,
    stopAllMediaAsync: vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock('../file-playback-product-runtime.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../file-playback-product-runtime.ts')>();
  return {
    ...actual,
    getFilePlaybackProductRuntime: () => mocks.runtime,
  };
});

vi.mock('../transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport.ts')>();
  return {
    ...actual,
    stopAllMediaAsync: mocks.stopAllMediaAsync,
  };
});

import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initPlaylist, playTrack } from '../playlist.ts';
import { cancelV2HostMutation, enqueueV2HostMutation } from '../v2-host-mutation-lane.ts';

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

function exactHostRoom() {
  return Object.freeze({
    schemaVersion: 1 as const,
    roomGeneration: 1,
    applicationSessionId: 'application-session-1',
    hostParticipantId: 'host-1',
  });
}

function failedRenderer(queueItemId: QueueItemId, revision: number) {
  const runId = `run-${revision}`;
  return Object.freeze({
    phase: 'failed' as const,
    queueItemId,
    revision,
    run: Object.freeze({ queueItemId, runId, revision }),
    positionSeconds: 17,
    durationSeconds: 180,
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
  mocks.runtime.currentHostTerminalRendererObservation.mockReturnValue(null);
  mocks.runtime.currentHostFailedRendererObservation.mockReturnValue(null);
  mocks.runtime.stopCurrent.mockReset();
  mocks.stopAllMediaAsync.mockReset();
  mocks.stopAllMediaAsync.mockResolvedValue(true);
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
  cancelV2HostMutation('V2 playlist integration test teardown');
  clearAllManagedTimers();
});

describe('V2 playlist intent ownership', () => {
  it('aborts a pre-commit predecessor and admits the successor only after settlement', async () => {
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
    const playButtonStates: boolean[] = [];
    const durationUpdates: number[] = [];
    bus.on('player:v2-file-loading-pending', (event) => pending.push(event));
    bus.on('player:v2-file-loading-settled', (event) => settled.push(event));
    bus.on('ui:play-btn-state', (enabled) => playButtonStates.push(enabled));
    bus.on('ui:duration-update', (duration) => durationUpdates.push(duration));

    const firstPlay = playTrack(firstQueueItemId);
    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);
    });
    const firstSignal = mocks.runtime.startLocalTrack.mock.calls[0]?.[0].signal;
    const secondPlay = playTrack(secondQueueItemId);

    expect(firstSignal?.aborted).toBe(true);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ owner: 'host-start' });
    expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);
    firstStart.reject(new DOMException('superseded before commit', 'AbortError'));
    await firstPlay;
    expect(getState('playlist.currentQueueItemId')).not.toBe(firstQueueItemId);
    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(2);
    });

    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: secondQueueItemId,
      durationSeconds: 187,
    });
    secondStart.resolve(committedTrack(secondQueueItemId, 2));
    await secondPlay;

    expect(getState('playlist.currentQueueItemId')).toBe(secondQueueItemId);
    expect(settled).toEqual(expect.arrayContaining(pending));
    expect(new Set(settled.map((event) => event.token)).size).toBe(2);
    expect(playButtonStates).toEqual([true]);
    expect(durationUpdates).toEqual([187]);
  });

  it('reconciles a commit-dominant predecessor when its queued successor fails', async () => {
    const firstQueueItemId = '20000000-0000-4000-8000-000000000001';
    const secondQueueItemId = '20000000-0000-4000-8000-000000000002';
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
    setState('player.isFirstTrackLoad', true);
    const firstStart = installDeferredStart(firstQueueItemId);
    const secondStart = installDeferredStart(secondQueueItemId);
    const pending: Array<{ owner: string; token: string | number }> = [];
    const settled: Array<{ owner: string; token: string | number }> = [];
    const switchedTabs: string[] = [];
    const playButtonStates: boolean[] = [];
    const durationUpdates: number[] = [];
    bus.on('player:v2-file-loading-pending', (event) => pending.push(event));
    bus.on('player:v2-file-loading-settled', (event) => settled.push(event));
    bus.on('ui:switch-tab', (tab) => switchedTabs.push(tab));
    bus.on('ui:play-btn-state', (enabled) => playButtonStates.push(enabled));
    bus.on('ui:duration-update', (duration) => durationUpdates.push(duration));

    const firstPlay = playTrack(firstQueueItemId);
    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);
    });
    const firstSignal = mocks.runtime.startLocalTrack.mock.calls[0]?.[0].signal;
    const secondPlay = playTrack(secondQueueItemId);
    expect(firstSignal?.aborted).toBe(true);
    expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);

    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: firstQueueItemId,
      durationSeconds: 121,
    });
    firstStart.resolve(committedTrack(firstQueueItemId, 1));
    await firstPlay;

    expect(getState('playlist.currentQueueItemId')).toBe(firstQueueItemId);
    expect(getState('playback.activity')).toBe('playing');
    expect(switchedTabs).toEqual([]);
    expect(getState('player.isFirstTrackLoad')).toBe(true);
    expect(playButtonStates).toEqual([true]);
    expect(durationUpdates).toEqual([121]);

    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(2);
    });
    secondStart.reject(new Error('successor preparation failed'));
    await secondPlay;

    expect(getState('playlist.currentQueueItemId')).toBe(firstQueueItemId);
    expect(getState('playback.activity')).toBe('playing');
    expect(switchedTabs).toEqual([]);
    expect(getState('player.isFirstTrackLoad')).toBe(true);
    expect(settled).toEqual(expect.arrayContaining(pending));
  });

  it('skips a superseded queued middle row across three rapid selections', async () => {
    const firstQueueItemId = '30000000-0000-4000-8000-000000000001';
    const secondQueueItemId = '30000000-0000-4000-8000-000000000002';
    const thirdQueueItemId = '30000000-0000-4000-8000-000000000003';
    const firstFile = new File(['first'], 'first.mp3', { type: 'audio/mpeg' });
    const secondFile = new File(['second'], 'second.mp3', { type: 'audio/mpeg' });
    const thirdFile = new File(['third'], 'third.mp3', { type: 'audio/mpeg' });
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
      {
        queueItemId: thirdQueueItemId,
        type: 'file',
        name: thirdFile.name,
        file: thirdFile,
        videoId: null,
        playlistId: null,
      },
    ]);
    const firstStart = installDeferredStart(firstQueueItemId);
    installDeferredStart(secondQueueItemId);
    const thirdStart = installDeferredStart(thirdQueueItemId);
    const pending: Array<{ owner: string; token: string | number }> = [];
    const settled: Array<{ owner: string; token: string | number }> = [];
    bus.on('player:v2-file-loading-pending', (event) => pending.push(event));
    bus.on('player:v2-file-loading-settled', (event) => settled.push(event));

    const firstPlay = playTrack(firstQueueItemId);
    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);
    });
    const secondPlay = playTrack(secondQueueItemId);
    const thirdPlay = playTrack(thirdQueueItemId);
    expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);

    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: firstQueueItemId,
      durationSeconds: 100,
    });
    firstStart.resolve(committedTrack(firstQueueItemId, 1));
    await firstPlay;
    await secondPlay;
    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(2);
    });
    expect(
      mocks.runtime.startLocalTrack.mock.calls.map(([request]) => request.queueItemId),
    ).toEqual([firstQueueItemId, thirdQueueItemId]);

    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: thirdQueueItemId,
      durationSeconds: 300,
    });
    thirdStart.resolve(committedTrack(thirdQueueItemId, 3));
    await thirdPlay;

    expect(getState('playlist.currentQueueItemId')).toBe(thirdQueueItemId);
    expect(pending).toHaveLength(3);
    expect(settled).toEqual(expect.arrayContaining(pending));
    expect(new Set(settled.map((event) => event.token)).size).toBe(3);
  });

  it('reconciles a commit-dominant renderer when its pending playlist row is removed', async () => {
    const currentQueueItemId = '40000000-0000-4000-8000-000000000001';
    const removedQueueItemId = '40000000-0000-4000-8000-000000000002';
    const currentFile = new File(['current'], 'current.mp3', { type: 'audio/mpeg' });
    const removedFile = new File(['removed'], 'removed.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [
      {
        queueItemId: currentQueueItemId,
        type: 'file',
        name: currentFile.name,
        file: currentFile,
        videoId: null,
        playlistId: null,
      },
      {
        queueItemId: removedQueueItemId,
        type: 'file',
        name: removedFile.name,
        file: removedFile,
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', currentQueueItemId);
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: currentQueueItemId,
      durationSeconds: 180,
    });

    const removedStart = installDeferredStart(removedQueueItemId);
    const restoredStart = installDeferredStart(currentQueueItemId);
    const pending: Array<{ owner: string; token: string | number }> = [];
    const settled: Array<{ owner: string; token: string | number }> = [];
    bus.on('player:v2-file-loading-pending', (event) => pending.push(event));
    bus.on('player:v2-file-loading-settled', (event) => settled.push(event));
    initPlaylist();

    const removedPlay = playTrack(removedQueueItemId);
    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);
    });
    const removedSignal = mocks.runtime.startLocalTrack.mock.calls[0]?.[0].signal;

    bus.emit('playlist:remove-tracks', [removedQueueItemId]);

    expect(removedSignal?.aborted).toBe(false);
    expect(getState('playlist.items')?.map((item) => item.queueItemId)).toEqual([
      currentQueueItemId,
    ]);
    expect(getState('playlist.currentQueueItemId')).toBe(currentQueueItemId);

    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: removedQueueItemId,
      durationSeconds: 240,
    });
    removedStart.resolve(committedTrack(removedQueueItemId, 2));

    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(2);
    });
    expect(mocks.runtime.startLocalTrack.mock.calls[1]?.[0]).toMatchObject({
      queueItemId: currentQueueItemId,
      file: currentFile,
      positionSeconds: 0,
    });

    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: currentQueueItemId,
      durationSeconds: 180,
    });
    restoredStart.resolve(committedTrack(currentQueueItemId, 3));
    await removedPlay;

    await vi.waitFor(() => {
      expect(getState('playlist.currentQueueItemId')).toBe(currentQueueItemId);
      expect(getState('playback.activity')).toBe('playing');
      expect(settled).toEqual(expect.arrayContaining(pending));
    });
    expect(pending.map((event) => event.owner)).toEqual(['host-start']);
    expect(new Set(settled.map((event) => event.token)).size).toBe(1);
    expect(mocks.runtime.currentHostRendererSnapshot()?.queueItemId).toBe(currentQueueItemId);
  });

  it.each([
    {
      label: 'retires a removed commit before admitting a superseding transport control',
      failedRendererRemains: false,
    },
    {
      label: 'does not publish false stopped UI while the removed renderer remains failed',
      failedRendererRemains: true,
    },
  ])('$label', async ({ failedRendererRemains }) => {
    const currentQueueItemId = '50000000-0000-4000-8000-000000000001';
    const removedQueueItemId = '50000000-0000-4000-8000-000000000002';
    const currentFile = new File(['current'], 'current.mp3', { type: 'audio/mpeg' });
    const removedFile = new File(['removed'], 'removed.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [
      {
        queueItemId: currentQueueItemId,
        type: 'file',
        name: currentFile.name,
        file: currentFile,
        videoId: null,
        playlistId: null,
      },
      {
        queueItemId: removedQueueItemId,
        type: 'file',
        name: removedFile.name,
        file: removedFile,
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', currentQueueItemId);
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: currentQueueItemId,
      durationSeconds: 180,
    });

    const removedStart = installDeferredStart(removedQueueItemId);
    const stopped = deferred<unknown>();
    mocks.runtime.stopCurrent.mockReturnValue(stopped.promise);
    initPlaylist();

    const removedPlay = playTrack(removedQueueItemId);
    await vi.waitFor(() => {
      expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);
    });
    const removedSignal = mocks.runtime.startLocalTrack.mock.calls[0]?.[0].signal;
    bus.emit('playlist:remove-tracks', [removedQueueItemId]);

    let successorAdmitted = false;
    const successor = enqueueV2HostMutation('simulated pause after deletion', async () => {
      successorAdmitted = true;
    });
    expect(removedSignal?.aborted).toBe(true);

    mocks.runtime.currentHostRendererSnapshot.mockReturnValue({
      queueItemId: removedQueueItemId,
      durationSeconds: 240,
    });
    removedStart.resolve(committedTrack(removedQueueItemId, 2));
    await vi.waitFor(() => {
      expect(mocks.runtime.stopCurrent).toHaveBeenCalledOnce();
    });
    expect(successorAdmitted).toBe(false);
    expect(mocks.runtime.startLocalTrack).toHaveBeenCalledTimes(1);

    mocks.runtime.currentHostRendererSnapshot.mockReturnValue(null);
    if (failedRendererRemains) {
      mocks.runtime.currentHostFailedRendererObservation.mockReturnValue({
        queueItemId: removedQueueItemId,
        durationSeconds: 240,
      });
    }
    stopped.resolve(
      Object.freeze({
        status: 'committed',
        kind: 'stop',
        timeline: Object.freeze({ phase: 'stopped', positionSeconds: 0 }),
      }),
    );
    await removedPlay;
    await successor;

    expect(successorAdmitted).toBe(true);
    expect(mocks.runtime.currentHostRendererSnapshot()).toBeNull();
    expect(getState('playlist.currentQueueItemId')).toBe(currentQueueItemId);
    expect(getState('playback.activity')).toBe(failedRendererRemains ? 'playing' : 'idle');
  });

  it('deletes the last failed V2 row only after exact renderer retirement settles', async () => {
    const queueItemId = '60000000-0000-4000-8000-000000000001';
    const file = new File(['failed current'], 'failed-current.mp3', { type: 'audio/mpeg' });
    setState('playlist.items', [
      {
        queueItemId,
        type: 'file',
        name: file.name,
        file,
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('network.myId', 'host-1');
    mocks.runtime.hostRoomSnapshot.mockReturnValue(exactHostRoom());
    mocks.runtime.currentHostFailedRendererObservation.mockReturnValue(
      failedRenderer(queueItemId, 1),
    );
    const stopped = deferred<boolean>();
    mocks.stopAllMediaAsync.mockReturnValue(stopped.promise);
    initPlaylist();

    bus.emit('playlist:remove-tracks', [queueItemId]);

    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('playlist.items')?.map((item) => item.queueItemId)).toEqual([queueItemId]);
    expect(mocks.stopAllMediaAsync).toHaveBeenCalledWith({ cancelInFlight: true });
    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('playlist.items')?.map((item) => item.queueItemId)).toEqual([queueItemId]);
    expect(getState('playback.activity')).toBe('playing');

    mocks.runtime.currentHostFailedRendererObservation.mockReturnValue(null);
    stopped.resolve(true);

    await vi.waitFor(() => {
      expect(getState('playlist.items')).toEqual([]);
      expect(getState('playlist.currentQueueItemId')).toBeNull();
    });
  });
});
