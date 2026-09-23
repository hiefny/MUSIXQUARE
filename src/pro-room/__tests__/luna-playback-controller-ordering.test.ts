/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { PlaylistItem, QueueItemId, RoomContext } from '../../types/index.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomSnapshot } from '../contracts.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import {
  ProRoomApiClient,
  ProRoomApiError,
  type ProRoomPlaybackCommandResult,
  type ProRoomPlaybackPrepareEvent,
} from '../api.ts';
import {
  registerProPlaybackCommandHandler,
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  routeProPlaybackCommand,
  type ProPlaybackCommitRequest,
  type ProPlaybackCommitResult,
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareRequest,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';

const ROOM = '000001';
const NEXT_ROOM = '000002';
const EPOCH = 7;
const QID = '40000000-0000-4000-8000-000000000001' as QueueItemId;
const TRANSITION = `transition_${'l'.repeat(22)}`;

function checkpoint(
  epoch = EPOCH,
  revision = 0,
  state: ProRoomPlaybackCheckpoint['state'] = 'idle',
): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: epoch,
    revision,
    state,
    queueItemId: revision ? QID : null,
    positionSeconds: revision ? 30 : 0,
    youtubeVideoId: revision ? 'dQw4w9WgXcQ' : null,
    youtubeSubIndex: revision ? 0 : null,
    updatedAtMs: 10_000 + revision,
  };
}

function snapshot(roomCode = ROOM, epoch = EPOCH): ProRoomSnapshot {
  return {
    roomCode,
    playback: checkpoint(epoch),
    presence: { coordinatorEpoch: epoch },
    playlist: [{ queueItemId: QID, source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } }],
  } as unknown as ProRoomSnapshot;
}

function context(roomId = ROOM, epoch = EPOCH, capabilities = ['playback.control']) {
  return {
    kind: 'pro' as const,
    roomId,
    role: 'member' as const,
    coordinatorId: 'participant_00001',
    epoch,
    snapshotRevision: 1,
    capabilities: [...capabilities] as RoomContext['capabilities'],
  };
}

function prepareEvent(epoch = EPOCH): ProRoomPlaybackPrepareEvent {
  return {
    type: 'pro-playback-prepare',
    transitionId: TRANSITION,
    serverTimeMs: 10_000,
    deadlineAtMs: 13_000,
    basePlaybackRevision: 0,
    target: { ...checkpoint(epoch, 1, 'playing') },
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

function controllerPorts(
  options: {
    getSnapshot?: () => ProRoomSnapshot | null;
    execute?: (
      ...args: Parameters<ProRoomApiClient['executePlaybackCommand']>
    ) => ReturnType<ProRoomApiClient['executePlaybackCommand']>;
    prepare?: ProPlaybackMediaEndpoint['prepare'];
    commit?: ProPlaybackMediaEndpoint['commit'];
    cancel?: ProPlaybackMediaEndpoint['cancel'];
    reportReady?: (
      ...args: Parameters<ProRoomApiClient['reportPlaybackTransitionReady']>
    ) => ReturnType<ProRoomApiClient['reportPlaybackTransitionReady']>;
    runHeartbeat?: (
      force?: boolean,
      includePersistedState?: boolean,
      playbackIsCurrent?: () => boolean,
    ) => Promise<void>;
  } = {},
) {
  const getSnapshot = options.getSnapshot ?? (() => snapshot());
  const endpoint: ProPlaybackMediaEndpoint = {
    prepare:
      options.prepare ??
      vi.fn(async (request: ProPlaybackPrepareRequest): Promise<ProPlaybackPrepareResult> => ({
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: 180,
        youtubeSubIndex: 0,
        youtubeVideoId: 'dQw4w9WgXcQ',
      })),
    commit:
      options.commit ??
      vi.fn(async (request: ProPlaybackCommitRequest) => ({
        status: 'applied' as const,
        authority: request.authority,
      })),
    cancel: options.cancel ?? vi.fn(),
    reset: vi.fn(),
  };
  registerProPlaybackMediaEndpoint(endpoint);
  const controller = new ProRoomPlaybackController({
    isActive: () => true,
    getCanonicalSnapshot: getSnapshot,
    getPlaylistSnapshot: getSnapshot,
    capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM }),
    isPlaylistLeaseCurrent: () => true,
    getRoomAbortSignal: () => undefined,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: options.runHeartbeat ?? vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: options.reportReady ?? vi.fn().mockResolvedValue('waiting'),
    executePlaybackCommand: options.execute ?? vi.fn().mockResolvedValue(unchangedResult()),
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  });
  return { controller, endpoint };
}

beforeEach(() => {
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

afterEach(() => {
  registerProPlaybackCommandHandler(null);
  registerProPlaybackMediaEndpoint(null);
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  vi.restoreAllMocks();
});

describe('PRO playback controller authority ordering', () => {
  it('uses the participant capability projection to consume a command before the controller or server call', () => {
    const execute = vi.fn().mockResolvedValue(unchangedResult());
    const { controller } = controllerPorts({ execute });
    controller.startLifecycle();
    // The canonical snapshot may still advertise the owner's server permission;
    // the current participant capability controls whether this UI command routes.
    setState('room.context', context(ROOM, EPOCH, []));
    expect(routeProPlaybackCommand({ kind: 'next', queueItemId: QID, positionSeconds: 12 })).toBe(
      true,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(controller).toBeDefined();
    controller.stopLifecycle();
  });

  it('applies a server-authorized PREPARE after local playback-control capability is revoked', async () => {
    const clockWait = vi
      .spyOn(ServerProRoomNetworkBridge.prototype, 'waitForFreshClockCalibration')
      .mockResolvedValue(true);
    const prepare = vi.fn(
      async (request: ProPlaybackPrepareRequest): Promise<ProPlaybackPrepareResult> => ({
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: 180,
        youtubeSubIndex: 0,
        youtubeVideoId: 'dQw4w9WgXcQ',
      }),
    );
    const reportReady = vi.fn().mockResolvedValue('waiting');
    const execute = vi.fn().mockResolvedValue(unchangedResult());
    const { controller } = controllerPorts({ prepare, reportReady, execute });
    setState('room.context', context(ROOM, EPOCH, []));

    controller.acceptPrepare(prepareEvent());
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());

    expect(execute).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.objectContaining({
          roomId: ROOM,
          roomEpoch: EPOCH,
          transitionId: TRANSITION,
        }),
        queueItemId: QID,
        isCurrent: expect.any(Function),
      }),
    );
    expect(reportReady).toHaveBeenCalledWith({
      code: ROOM,
      transitionId: TRANSITION,
      basePlaybackRevision: 0,
      status: 'ready',
    });
    expect(clockWait).toHaveBeenCalledOnce();
  });

  it('lets the server reject a queued command after participant capability changes without preparing or committing media', async () => {
    let resolveFirst!: (result: ReturnType<typeof unchangedResult>) => void;
    const execute = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockRejectedValueOnce(new ProRoomApiError('PERMISSION_REQUIRED', 403));
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const { controller, endpoint } = controllerPorts({ execute, runHeartbeat: heartbeat });
    const operations: Promise<void>[] = [];
    const unregister = registerProPlaybackCommandHandler((intent) => {
      const operation = controller.enqueueIntent(intent);
      operations.push(operation);
      return operation;
    });

    try {
      expect(
        routeProPlaybackCommand({ kind: 'pause', queueItemId: QID, positionSeconds: 12 }),
      ).toBe(true);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(routeProPlaybackCommand({ kind: 'next', queueItemId: QID, positionSeconds: 12 })).toBe(
        true,
      );
      setState('room.context', context(ROOM, EPOCH, []));

      resolveFirst(unchangedResult());
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      await Promise.all(operations);

      expect(execute.mock.calls.map(([request]) => request.command.type)).toEqual([
        'pause',
        'next',
      ]);
      expect(heartbeat).toHaveBeenCalledOnce();
      expect(endpoint.prepare).not.toHaveBeenCalled();
      expect(endpoint.commit).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('drops an old-room queued command and a late admission response after playlist runtime reset', async () => {
    let resolveCommand!: (result: ProRoomPlaybackCommandResult) => void;
    const execute = vi.fn<ProRoomApiClient['executePlaybackCommand']>(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const { controller, endpoint } = controllerPorts({ execute });
    const first = controller.enqueueIntent({
      kind: 'select',
      roomId: ROOM,
      roomEpoch: EPOCH,
      queueItemId: QID,
      positionSeconds: 0,
      youtubeSubIndex: 0,
      youtubeVideoId: 'dQw4w9WgXcQ',
    });
    const queued = controller.enqueueIntent({
      kind: 'next',
      roomId: ROOM,
      roomEpoch: EPOCH,
      queueItemId: QID,
      positionSeconds: 0,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    controller.resetPlaylistRuntime();
    setState('room.context', context(NEXT_ROOM, EPOCH + 1));
    resolveCommand({
      schemaVersion: 1,
      roomCode: ROOM,
      status: 'preparing',
      transition: prepareEvent(),
      playback: checkpoint(EPOCH, 1, 'playing'),
      serverTimeMs: 10_000,
    });
    await Promise.all([first, queued]);

    expect(execute).toHaveBeenCalledOnce();
    expect(endpoint.prepare).not.toHaveBeenCalled();
    expect(endpoint.commit).not.toHaveBeenCalled();
  });

  it('cancels prepared media and suppresses stale READY when room epoch changes before prepare settles', async () => {
    let resolvePrepare!: (result: ProPlaybackPrepareResult) => void;
    const prepare = vi.fn(
      (request: ProPlaybackPrepareRequest) =>
        new Promise<ProPlaybackPrepareResult>((resolve) => {
          resolvePrepare = resolve;
          expect(request.isCurrent?.()).toBe(true);
        }),
    );
    const reportReady = vi.fn().mockResolvedValue('waiting');
    const cancel = vi.fn();
    const { controller } = controllerPorts({ prepare, reportReady, cancel });
    controller.acceptPrepare(prepareEvent());
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const authority = prepare.mock.calls[0]![0].authority;

    setState('room.context', context(NEXT_ROOM, EPOCH + 1));
    controller.resetPlaylistRuntime();
    expect(cancel).toHaveBeenCalledWith(authority);
    expect(prepare.mock.calls[0]![0].isCurrent?.()).toBe(false);
    resolvePrepare({
      status: 'ready',
      authority,
      queueItemId: QID,
      mediaKind: 'youtube',
      durationSeconds: 180,
      youtubeSubIndex: 0,
      youtubeVideoId: 'dQw4w9WgXcQ',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(reportReady).not.toHaveBeenCalled();
  });

  it('does not record a canonical commit completed after its room epoch was reset', async () => {
    const ready = vi.fn().mockResolvedValue('waiting');
    let resolveCommit!: (result: ProPlaybackCommitResult) => void;
    const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(
      (request) =>
        new Promise((resolve) => {
          expect(request.isCurrent?.()).toBe(true);
          resolveCommit = resolve;
        }),
    );
    const prepare = vi.fn(
      async (request: ProPlaybackPrepareRequest): Promise<ProPlaybackPrepareResult> => ({
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: 180,
        youtubeSubIndex: 0,
        youtubeVideoId: 'dQw4w9WgXcQ',
      }),
    );
    const { controller } = controllerPorts({ prepare, commit, reportReady: ready });
    const checkpointApplied = vi.fn();
    bus.on('sync:diagnostic-pro-checkpoint', checkpointApplied);
    controller.acceptPrepare(prepareEvent());
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    controller.acceptCommit({
      type: 'pro-playback-commit',
      transitionId: TRANSITION,
      serverTimeMs: 10_100,
      executeAtMs: 10_100,
      playback: checkpoint(EPOCH, 1, 'playing'),
    });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());

    setState('room.context', context(NEXT_ROOM, EPOCH + 1));
    controller.resetPlaylistRuntime();
    expect(commit.mock.calls[0]![0].isCurrent?.()).toBe(false);
    resolveCommit({ status: 'applied', authority: commit.mock.calls[0]![0].authority });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(checkpointApplied).not.toHaveBeenCalled();
  });
});
