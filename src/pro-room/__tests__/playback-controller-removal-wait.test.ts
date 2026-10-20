/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { PlaylistItem, QueueItemId, RoomContext } from '../../types/index.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomSnapshot } from '../contracts.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import * as serverClock from '../network-bridge.ts';
import { installProClockSnapshotMocks } from './__helpers__/pro-clock-fixture.ts';
import type { ProRoomApiClient } from '../api.ts';
import {
  registerProPlaybackCommandHandler,
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  routeProPlaybackCommand,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import { noteProQueueRemoval, pendingProQueueRemoval } from '../queue-removal-wait.ts';

const ROOM = '000001';
const EPOCH = 7;
const QID = '40000000-0000-4000-8000-000000000001' as QueueItemId;
const OTHER = '40000000-0000-4000-8000-000000000003' as QueueItemId;

function checkpoint(): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: EPOCH,
    revision: 0,
    state: 'idle',
    queueItemId: null,
    positionSeconds: 0,
    youtubeVideoId: null,
    youtubeSubIndex: null,
    updatedAtMs: 10_000,
  };
}

function snapshot(): ProRoomSnapshot {
  return {
    roomCode: ROOM,
    playback: checkpoint(),
    presence: { coordinatorEpoch: EPOCH },
    playlist: [{ queueItemId: QID, source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } }],
  } as unknown as ProRoomSnapshot;
}

function context() {
  return {
    kind: 'pro' as const,
    roomId: ROOM,
    role: 'member' as const,
    coordinatorId: 'participant_00001',
    epoch: EPOCH,
    snapshotRevision: 1,
    capabilities: ['playback.control', 'queue.mutate'] as RoomContext['capabilities'],
  };
}

function unchangedResult() {
  return {
    schemaVersion: 1 as const,
    roomCode: ROOM,
    status: 'unchanged' as const,
    transition: null,
    playback: checkpoint(),
    serverTimeMs: 10_000,
  };
}

function startController() {
  const execute = vi.fn<ProRoomApiClient['executePlaybackCommand']>(async () => unchangedResult());
  registerProPlaybackMediaEndpoint({
    prepare: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  });
  const controller = new ProRoomPlaybackController({
    isActive: () => true,
    getCanonicalSnapshot: snapshot,
    getPlaylistSnapshot: snapshot,
    capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM }),
    isPlaylistLeaseCurrent: () => true,
    getRoomAbortSignal: () => undefined,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: vi.fn().mockResolvedValue('waiting'),
    executePlaybackCommand: execute,
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  });
  const operations: Promise<void>[] = [];
  const unregister = registerProPlaybackCommandHandler((intent) => {
    const operation = controller.enqueueIntent(intent);
    operations.push(operation);
    return operation;
  });
  return { execute, operations, unregister };
}

const unsettledRemovals: Array<() => void> = [];

function deferredRemoval(): { settle: () => void } {
  let settle!: () => void;
  noteProQueueRemoval(
    new Promise<void>((resolve) => {
      settle = resolve;
    }),
  );
  unsettledRemovals.push(settle);
  return { settle };
}

function commandTypes(execute: ReturnType<typeof startController>['execute']): string[] {
  return execute.mock.calls.map(([request]) => request.command.type);
}

beforeEach(() => {
  installProClockSnapshotMocks(serverClock);
  vi.spyOn(serverClock, 'getProRoomServerNow').mockReturnValue(10_000);
  vi.spyOn(ServerProRoomNetworkBridge.prototype, 'waitForFreshClockCalibration').mockResolvedValue(
    true,
  );
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetProPlaybackAuthorityHooks();
  setState('room.context', context());
  setState('playlist.items', [
    { queueItemId: QID, type: 'youtube', name: 'track', title: 'track' } as PlaylistItem,
  ]);
  setState('playlist.currentQueueItemId', QID);
});

afterEach(async () => {
  for (const settle of unsettledRemovals.splice(0)) settle();
  await vi.waitFor(() => expect(pendingProQueueRemoval()).toBeNull());
  registerProPlaybackCommandHandler(null);
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  vi.restoreAllMocks();
});

describe('PRO navigation after a sent playlist removal', () => {
  it.each([
    ['next', { kind: 'next', queueItemId: QID, positionSeconds: 12 }],
    ['previous', { kind: 'previous', queueItemId: QID, positionSeconds: 1 }],
    [
      'select',
      {
        kind: 'select',
        queueItemId: OTHER,
        positionSeconds: 0,
        youtubeSubIndex: null,
        youtubeVideoId: null,
      },
    ],
  ] as const)('holds %s until the Worker has applied the removal', async (kind, intent) => {
    const { execute, operations, unregister } = startController();
    try {
      const removal = deferredRemoval();

      expect(routeProPlaybackCommand(intent)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(execute).not.toHaveBeenCalled();

      removal.settle();
      await Promise.all(operations);
      expect(commandTypes(execute)).toEqual([kind]);
      expect(pendingProQueueRemoval()).toBeNull();
    } finally {
      unregister();
    }
  });

  it('does not hold pause behind a removal', async () => {
    const { execute, unregister } = startController();
    try {
      const removal = deferredRemoval();

      expect(routeProPlaybackCommand({ kind: 'pause', queueItemId: QID, positionSeconds: 3 })).toBe(
        true,
      );
      await vi.waitFor(() => expect(commandTypes(execute)).toEqual(['pause']));
      removal.settle();
    } finally {
      unregister();
    }
  });

  it('sends navigation at once when no removal is pending', async () => {
    const { execute, operations, unregister } = startController();
    try {
      expect(pendingProQueueRemoval()).toBeNull();
      expect(routeProPlaybackCommand({ kind: 'next', queueItemId: QID, positionSeconds: 3 })).toBe(
        true,
      );
      await Promise.all(operations);
      expect(commandTypes(execute)).toEqual(['next']);
    } finally {
      unregister();
    }
  });

  it('keeps holding while a newer removal is still pending', async () => {
    const { execute, operations, unregister } = startController();
    try {
      const first = deferredRemoval();
      const second = deferredRemoval();
      first.settle();
      await Promise.resolve();
      expect(pendingProQueueRemoval()).not.toBeNull();

      routeProPlaybackCommand({ kind: 'next', queueItemId: QID, positionSeconds: 3 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(execute).not.toHaveBeenCalled();

      second.settle();
      await Promise.all(operations);
      expect(commandTypes(execute)).toEqual(['next']);
    } finally {
      unregister();
    }
  });
});
