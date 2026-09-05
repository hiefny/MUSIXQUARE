/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { getManagedTimer } from '../../core/timers.ts';
import { capturePlaylistQueueModeState } from '../../player/playlist.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  ProRoomApiClient,
  ProRoomApiError,
  type ProRoomPlaybackCommitEvent,
  type ProRoomPlaybackPrepareEvent,
  type ProRoomSignalingAccess,
} from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomPlaybackCheckpoint,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import {
  registerProPlaybackMediaEndpoint,
  routeProPlaybackCommand,
  type ProPlaybackAuthorityToken,
  type ProPlaybackCommitResult,
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import { requestProRoomTransportRecovery } from '../transport-recovery.ts';
import {
  acceptProRoomRealtimeFrameForTests,
  joinProRoom,
  kickActiveProRoomMember,
  kickActiveProRoomPresence,
  requestActiveProRoomPlaybackReconciliation,
  requestFirstAppendSelectionForTests,
} from '../runtime.ts';

const ROOM_CODE = '000001';
const ROOM_EPOCH = 7;
const PARTICIPANT_ID = 'participant_00001';
const QUEUE_ITEM_ID = '40000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'dQw4w9WgXcQ';
const ADDED_QUEUE_ITEM_ID = '40000000-0000-4000-8000-000000000002' as QueueItemId;
const ADDED_VIDEO_ID = 'M7lc1UVf-VE';
const TRANSITION_READY = `transition_${'a'.repeat(22)}`;
const TRANSITION_FAILED = `transition_${'b'.repeat(22)}`;
const TRANSITION_COMMIT = `transition_${'c'.repeat(22)}`;

function playback(
  revision: number,
  overrides: Partial<ProRoomPlaybackCheckpoint> = {},
): ProRoomPlaybackCheckpoint {
  return {
    coordinatorEpoch: ROOM_EPOCH,
    revision,
    state: revision === 0 ? 'idle' : 'playing',
    queueItemId: revision === 0 ? null : QUEUE_ITEM_ID,
    positionSeconds: 0,
    youtubeVideoId: revision === 0 ? null : VIDEO_ID,
    youtubeSubIndex: revision === 0 ? null : 0,
    updatedAtMs: 10_000 + revision,
    ...overrides,
  };
}

function snapshot(currentPlayback = playback(0)): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      {
        queueItemId: QUEUE_ITEM_ID,
        name: 'Server-authoritative track',
        source: { kind: 'youtube', videoId: VIDEO_ID },
      },
    ],
    currentQueueItemId: currentPlayback.queueItemId,
    playback: currentPlayback,
    presence: {
      coordinatorEpoch: ROOM_EPOCH,
      revision: 1,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: 'member_0000000001',
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Equal member',
          devicePlatform: 'other',
          role: 'owner',
          capabilities: [...capabilitiesForProRoomRole('owner')],
          joinedAtMs: 1,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_0000000001',
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Equal member',
      role: 'owner',
      capabilities: [...capabilitiesForProRoomRole('owner')],
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_0000000001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Equal member',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ],
  };
}

function signalingAccess(): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: Date.now() + 60_000,
    role: 'member',
    coordinatorEpoch: ROOM_EPOCH,
    presenceIncarnationId: 'presence_0000000001',
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

function prepareEvent(transitionId: string, basePlaybackRevision = 0): ProRoomPlaybackPrepareEvent {
  return {
    type: 'pro-playback-prepare',
    transitionId,
    serverTimeMs: 10_000,
    deadlineAtMs: 13_000,
    basePlaybackRevision,
    target: playback(basePlaybackRevision + 1),
  };
}

function commitEvent(
  transitionId: string | null,
  revision = 1,
  wireLeadMs = 0,
): ProRoomPlaybackCommitEvent {
  return {
    type: 'pro-playback-commit',
    transitionId,
    serverTimeMs: 10_100,
    executeAtMs: 10_100 + wireLeadMs,
    playback: playback(revision),
  };
}

function serverFrame(event: Record<string, unknown>, coordinatorEpoch = ROOM_EPOCH) {
  return {
    type: 'pro-server-event' as const,
    version: 1 as const,
    roomCode: ROOM_CODE,
    coordinatorEpoch,
    event: event as Record<string, unknown> & { type: string },
  };
}

function setDocumentVisibility(value: 'hidden' | 'visible', dispatch = true): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
  if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
}

function createReconciliationLiveness(): {
  liveness: { identity: object; isCurrent: () => boolean };
  invalidate: () => void;
} {
  let current = true;
  return {
    liveness: { identity: {}, isCurrent: () => current },
    invalidate: () => {
      current = false;
    },
  };
}

describe.sequential('coordinator-free PRO playback runtime', () => {
  const restoreSpies: Array<{ mockRestore(): void }> = [];
  let prepareResult: 'ready' | 'failed';
  let prepareMedia: Mock<ProPlaybackMediaEndpoint['prepare']>;
  let commitMedia: Mock<ProPlaybackMediaEndpoint['commit']>;
  let cancelMedia: Mock<NonNullable<ProPlaybackMediaEndpoint['cancel']>>;
  let reportReady: ReturnType<typeof vi.spyOn>;
  let executeCommand: ReturnType<typeof vi.spyOn>;
  let waitForClock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    setDocumentVisibility('visible', false);
    resetState();
    prepareResult = 'ready';
    const initial = snapshot();

    waitForClock = vi
      .spyOn(ServerProRoomNetworkBridge.prototype, 'waitForFreshClockCalibration')
      .mockResolvedValue(true);
    restoreSpies.push(
      vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(initial),
      vi
        .spyOn(ProRoomApiClient.prototype, 'createSignalingTicket')
        .mockResolvedValue(signalingAccess()),
      vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(initial),
      vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockResolvedValue({
        schemaVersion: 1,
        view: 'settings-sync',
        roomCode: ROOM_CODE,
        revision: 0,
        updatedAtMs: 1,
        masterVolume: 1,
        effects: createDefaultRoomEffectsState(),
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
        schemaVersion: 1,
        view: 'queue-mode',
        roomCode: ROOM_CODE,
        revision: 0,
        playlistRevision: 1,
        updatedAtMs: 1,
        repeatMode: 0,
        shuffleEnabled: false,
        shuffleOrder: [],
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
        generation: 0,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined),
      vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined),
      vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined),
      vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {}),
      waitForClock,
    );

    reportReady = vi
      .spyOn(ProRoomApiClient.prototype, 'reportPlaybackTransitionReady')
      .mockResolvedValue('waiting');
    executeCommand = vi
      .spyOn(ProRoomApiClient.prototype, 'executePlaybackCommand')
      .mockResolvedValue({
        schemaVersion: 1,
        roomCode: ROOM_CODE,
        status: 'unchanged',
        transition: null,
        playback: playback(0),
        serverTimeMs: 10_000,
      });
    restoreSpies.push(reportReady, executeCommand);

    prepareMedia = vi.fn<ProPlaybackMediaEndpoint['prepare']>(
      async (request): Promise<ProPlaybackPrepareResult> =>
        prepareResult === 'ready'
          ? {
              status: 'ready',
              authority: request.authority,
              queueItemId: request.queueItemId,
              mediaKind: 'youtube',
              durationSeconds: 180,
              youtubeSubIndex: request.youtubeSubIndex ?? null,
              youtubeVideoId: request.youtubeVideoId ?? null,
            }
          : {
              status: 'failed',
              authority: request.authority,
              queueItemId: request.queueItemId,
              reason: 'player-unavailable',
            },
    );
    commitMedia = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => ({
      status: 'applied' as const,
      authority: request.authority,
    }));
    cancelMedia = vi.fn<NonNullable<ProPlaybackMediaEndpoint['cancel']>>(
      (_authority: ProPlaybackAuthorityToken) => undefined,
    );
    registerProPlaybackMediaEndpoint({
      prepare: prepareMedia,
      commit: commitMedia,
      cancel: cancelMedia,
    });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
  });

  afterEach(async () => {
    const closeSession = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced);
    const closeCallsBeforeLeave = closeSession.mock.calls.length;
    const hadActiveSession = getState('room.context').kind === 'pro';
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    if (hadActiveSession) {
      await vi.waitFor(() =>
        expect(closeSession.mock.calls.length).toBeGreaterThan(closeCallsBeforeLeave),
      );
    }
    registerProPlaybackMediaEndpoint(null);
    for (const spy of restoreSpies.splice(0).reverse()) spy.mockRestore();
    resetState();
  });

  async function establishCurrentPlayingCheckpoint(): Promise<ProRoomSnapshot> {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    const current = {
      ...snapshot(playback(1, { positionSeconds: 18, updatedAtMs: Date.now(), state: 'playing' })),
      revision: 2,
    };
    acceptProRoomRealtimeFrameForTests(
      serverFrame({ ...commitEvent(null, 1), playback: current.playback } as unknown as Record<
        string,
        unknown
      >),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    heartbeat.mockClear();
    waitForClock.mockClear();
    prepareMedia.mockClear();
    commitMedia.mockClear();
    cancelMedia.mockClear();
    return current;
  }

  async function beginStaleNewerCheckpointPreparation(): Promise<{
    requestA: Promise<boolean>;
    requestB: Promise<boolean>;
    resolveA: (result: ProPlaybackPrepareResult) => void;
    rejectA: (reason: unknown) => void;
    authorityA: ProPlaybackAuthorityToken;
  }> {
    const newer = {
      ...snapshot(playback(1, { positionSeconds: 18, updatedAtMs: Date.now(), state: 'playing' })),
      revision: 2,
    };
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    heartbeat.mockResolvedValue(newer);
    waitForClock.mockClear();
    prepareMedia.mockClear();
    commitMedia.mockClear();
    cancelMedia.mockClear();

    let resolveA!: (result: ProPlaybackPrepareResult) => void;
    let rejectA!: (reason: unknown) => void;
    prepareMedia.mockImplementationOnce(
      () =>
        new Promise<ProPlaybackPrepareResult>((resolve, reject) => {
          resolveA = resolve;
          rejectA = reject;
        }),
    );
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();
    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    const prepareRequestA = prepareMedia.mock.calls[0]?.[0];
    expect(prepareRequestA?.isCurrent?.()).toBe(true);
    const authorityA = prepareRequestA!.authority;

    ownerA.invalidate();
    expect(prepareRequestA?.isCurrent?.()).toBe(false);
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    return { requestA, requestB, resolveA, rejectA, authorityA };
  }

  it('maps user intents to server commands with the canonical playback revision', async () => {
    expect(
      routeProPlaybackCommand({
        kind: 'select',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 4.5,
        youtubeSubIndex: 0,
        youtubeVideoId: VIDEO_ID,
      }),
    ).toBe(true);

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
    expect(executeCommand).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        command: {
          type: 'select',
          baseRevision: 0,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
          positionSeconds: 4.5,
          youtubeVideoId: VIDEO_ID,
          youtubeSubIndex: 0,
        },
        idempotencyKey: expect.any(String),
      },
      expect.any(AbortSignal),
    );
  });

  it('submits first-append auto-play as one exact server-authority select command', async () => {
    await requestFirstAppendSelectionForTests({
      roomCode: ROOM_CODE,
      queueItemId: QUEUE_ITEM_ID,
      coordinatorEpoch: ROOM_EPOCH,
      basePlaybackRevision: 0,
      youtubeVideoId: VIDEO_ID,
      youtubeSubIndex: 0,
    });

    expect(executeCommand).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        command: {
          type: 'select',
          baseRevision: 0,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
          positionSeconds: 0,
          youtubeVideoId: VIDEO_ID,
          youtubeSubIndex: 0,
        },
        idempotencyKey: expect.any(String),
      },
      expect.any(AbortSignal),
    );
  });

  it('replays one lost playback response with the same idempotency key', async () => {
    executeCommand
      .mockRejectedValueOnce(new ProRoomApiError('NETWORK_ERROR'))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        roomCode: ROOM_CODE,
        status: 'unchanged',
        transition: null,
        playback: playback(0),
        serverTimeMs: 10_000,
      });
    const settled: Array<{ status: string }> = [];
    const off = bus.on('pro-playback:ui-control-settled', (event) => settled.push(event));
    try {
      routeProPlaybackCommand(
        { kind: 'play', queueItemId: QUEUE_ITEM_ID, positionSeconds: 0 },
        { wasPlaying: false },
      );

      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(2));
      expect(executeCommand.mock.calls[0]?.[0].idempotencyKey).toBe(
        executeCommand.mock.calls[1]?.[0].idempotencyKey,
      );
      await vi.waitFor(() =>
        expect(settled).toEqual([expect.objectContaining({ status: 'applied' })]),
      );
    } finally {
      off();
    }
  });

  it('delegates public playback intents and recovers terminal session failures', async () => {
    const terminalError = new ProRoomApiError('SESSION_REQUIRED', 401);
    const recoverTerminalSession = vi.fn().mockResolvedValue(undefined);
    const controller = new ProRoomPlaybackController({
      isActive: () => true,
      getCanonicalSnapshot: () => snapshot(),
      getPlaylistSnapshot: () => snapshot(),
      capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM_CODE }),
      isPlaylistLeaseCurrent: () => true,
      getRoomAbortSignal: () => undefined,
      subscribePlaylistProjection: () => () => undefined,
      runHeartbeat: vi.fn().mockResolvedValue(undefined),
      reportPlaybackTransitionReady: vi.fn().mockResolvedValue('waiting'),
      executePlaybackCommand: vi.fn().mockRejectedValue(terminalError),
      recoverTerminalSession,
    });

    await controller.enqueueIntent({
      kind: 'play',
      roomId: ROOM_CODE,
      roomEpoch: ROOM_EPOCH,
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 0,
    });

    expect(recoverTerminalSession).toHaveBeenCalledOnce();
    expect(recoverTerminalSession).toHaveBeenCalledWith(terminalError);
  });

  it('drops a superseded UI command before it reaches the serialized API tail', async () => {
    let resolveFirst!: (
      value: Awaited<ReturnType<ProRoomApiClient['executePlaybackCommand']>>,
    ) => void;
    executeCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        schemaVersion: 1,
        roomCode: ROOM_CODE,
        status: 'unchanged',
        transition: null,
        playback: playback(0),
        serverTimeMs: 10_001,
      });

    routeProPlaybackCommand(
      { kind: 'pause', queueItemId: QUEUE_ITEM_ID, positionSeconds: 10 },
      { wasPlaying: true },
    );
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: QUEUE_ITEM_ID, positionSeconds: 30 },
      { wasPlaying: true },
    );
    routeProPlaybackCommand(
      { kind: 'play', queueItemId: QUEUE_ITEM_ID, positionSeconds: 30 },
      { wasPlaying: false },
    );

    resolveFirst({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(0),
      serverTimeMs: 10_000,
    });

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(2));
    expect(
      executeCommand.mock.calls.map(
        ([input]: Parameters<ProRoomApiClient['executePlaybackCommand']>) => input.command.type,
      ),
    ).toEqual(['pause', 'play']);
  });

  it('does not restart a PREPARE cancelled before its HTTP response arrives', async () => {
    let resolveCommand!: (
      value: Awaited<ReturnType<ProRoomApiClient['executePlaybackCommand']>>,
    ) => void;
    executeCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const settled: Array<{ status: string }> = [];
    const off = bus.on('pro-playback:ui-control-settled', (event) => settled.push(event));
    try {
      routeProPlaybackCommand(
        { kind: 'seek', queueItemId: QUEUE_ITEM_ID, positionSeconds: 42 },
        { wasPlaying: true },
      );
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());

      acceptProRoomRealtimeFrameForTests(
        serverFrame({
          type: 'pro-playback-cancel',
          transitionId: TRANSITION_READY,
          serverTimeMs: 10_050,
          reason: 'superseded',
        }),
      );
      resolveCommand({
        schemaVersion: 1,
        roomCode: ROOM_CODE,
        status: 'preparing',
        transition: prepareEvent(TRANSITION_READY),
        playback: playback(0),
        serverTimeMs: 10_000,
      });

      await vi.waitFor(() =>
        expect(settled).toEqual([expect.objectContaining({ status: 'superseded' })]),
      );
      expect(prepareMedia).not.toHaveBeenCalled();
      expect(reportReady).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('drops stale first-append auto-play after another actor advances playback', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    executeCommand.mockClear();

    await requestFirstAppendSelectionForTests({
      roomCode: ROOM_CODE,
      queueItemId: QUEUE_ITEM_ID,
      coordinatorEpoch: ROOM_EPOCH,
      basePlaybackRevision: 0,
      youtubeVideoId: VIDEO_ID,
      youtubeSubIndex: 0,
    });

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('sends a playlist sub-index even when no optional video assertion is available', async () => {
    expect(
      routeProPlaybackCommand({
        kind: 'select',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 0,
        youtubeSubIndex: 0,
        youtubeVideoId: null,
      }),
    ).toBe(true);

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
    expect(executeCommand.mock.calls[0]?.[0].command).toEqual({
      type: 'select',
      baseRevision: 0,
      queueItemId: QUEUE_ITEM_ID,
      state: 'playing',
      positionSeconds: 0,
      youtubeSubIndex: 0,
    });
  });

  it('reports both READY and FAILED from participant-local PREPARE work and cancels exactly', async () => {
    const ready = prepareEvent(TRANSITION_READY);
    acceptProRoomRealtimeFrameForTests(serverFrame(ready as unknown as Record<string, unknown>));

    await vi.waitFor(() =>
      expect(reportReady).toHaveBeenCalledWith({
        code: ROOM_CODE,
        transitionId: TRANSITION_READY,
        basePlaybackRevision: 0,
        status: 'ready',
      }),
    );
    expect(prepareMedia).toHaveBeenCalledOnce();

    acceptProRoomRealtimeFrameForTests(
      serverFrame({
        type: 'pro-playback-cancel',
        transitionId: TRANSITION_READY,
        serverTimeMs: 10_050,
        reason: 'superseded',
      }),
    );
    expect(cancelMedia).toHaveBeenCalledOnce();

    prepareResult = 'failed';
    const failed = prepareEvent(TRANSITION_FAILED);
    acceptProRoomRealtimeFrameForTests(serverFrame(failed as unknown as Record<string, unknown>));
    await vi.waitFor(() =>
      expect(reportReady).toHaveBeenCalledWith({
        code: ROOM_CODE,
        transitionId: TRANSITION_FAILED,
        basePlaybackRevision: 0,
        status: 'failed',
      }),
    );
  });

  it('keeps all participants visibly busy from PREPARE through media COMMIT', async () => {
    let resolveCommit!: (value: {
      status: 'applied';
      authority: ProPlaybackAuthorityToken;
    }) => void;
    commitMedia.mockImplementationOnce((request) =>
      new Promise((resolve) => {
        resolveCommit = resolve;
      }).then(() => ({ status: 'applied' as const, authority: request.authority })),
    );
    const loadingStates: boolean[] = [];
    const off = bus.on('pro-playback:transition-loading', (loading) => loadingStates.push(loading));
    try {
      acceptProRoomRealtimeFrameForTests(
        serverFrame(prepareEvent(TRANSITION_COMMIT) as unknown as Record<string, unknown>),
      );
      await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());
      expect(loadingStates).toEqual([true]);

      acceptProRoomRealtimeFrameForTests(
        serverFrame(commitEvent(TRANSITION_COMMIT, 1, 699) as unknown as Record<string, unknown>),
      );
      await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
      expect(loadingStates).toEqual([true]);

      const authority = commitMedia.mock.calls[0]?.[0].authority as ProPlaybackAuthorityToken;
      resolveCommit({ status: 'applied', authority });
      await vi.waitFor(() => expect(loadingStates).toEqual([true, false]));
    } finally {
      off();
    }
  });

  it('does not let a stale transition cancel clear the newer rendezvous spinner', async () => {
    const loadingStates: boolean[] = [];
    const off = bus.on('pro-playback:transition-loading', (loading) => loadingStates.push(loading));
    try {
      acceptProRoomRealtimeFrameForTests(
        serverFrame(prepareEvent(TRANSITION_READY) as unknown as Record<string, unknown>),
      );
      acceptProRoomRealtimeFrameForTests(
        serverFrame(prepareEvent(TRANSITION_FAILED) as unknown as Record<string, unknown>),
      );
      expect(loadingStates).toEqual([true]);

      acceptProRoomRealtimeFrameForTests(
        serverFrame({
          type: 'pro-playback-cancel',
          transitionId: TRANSITION_READY,
          serverTimeMs: 10_050,
          reason: 'superseded',
        }),
      );
      expect(loadingStates).toEqual([true]);

      acceptProRoomRealtimeFrameForTests(
        serverFrame({
          type: 'pro-playback-cancel',
          transitionId: TRANSITION_FAILED,
          serverTimeMs: 10_060,
          reason: 'superseded',
        }),
      );
      expect(loadingStates).toEqual([true, false]);
    } finally {
      off();
    }
  });

  it('atomically transfers the spinner when a superseded PREPARE cancel is lost', async () => {
    const loadingStates: boolean[] = [];
    const off = bus.on('pro-playback:transition-loading', (loading) => loadingStates.push(loading));
    try {
      acceptProRoomRealtimeFrameForTests(
        serverFrame(prepareEvent(TRANSITION_READY) as unknown as Record<string, unknown>),
      );
      acceptProRoomRealtimeFrameForTests(
        serverFrame(prepareEvent(TRANSITION_FAILED) as unknown as Record<string, unknown>),
      );
      expect(loadingStates).toEqual([true]);

      // No CANCEL for TRANSITION_READY arrives. Settling the replacement must
      // still release the one shared loading indicator.
      acceptProRoomRealtimeFrameForTests(
        serverFrame({
          type: 'pro-playback-cancel',
          transitionId: TRANSITION_FAILED,
          serverTimeMs: 10_060,
          reason: 'superseded',
        }),
      );
      expect(loadingStates).toEqual([true, false]);
    } finally {
      off();
    }
  });

  it('clears the shared rendezvous spinner when the PRO lifecycle is torn down', async () => {
    const loadingStates: boolean[] = [];
    const off = bus.on('pro-playback:transition-loading', (loading) => loadingStates.push(loading));
    try {
      acceptProRoomRealtimeFrameForTests(
        serverFrame(prepareEvent(TRANSITION_READY) as unknown as Record<string, unknown>),
      );
      expect(loadingStates).toEqual([true]);

      requestProRoomLeave();
      await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
      expect(loadingStates).toEqual([true, false]);
    } finally {
      off();
    }
  });

  it('hydrates a newly-added BOT target without re-fetching unrelated system audio', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const systemAudio = vi.mocked(ProRoomApiClient.prototype.getSystemAudioState);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(systemAudio).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();
    systemAudio.mockClear();
    const hydrated: ProRoomSnapshot = {
      ...snapshot(),
      revision: 2,
      playlistRevision: 2,
      playlist: [
        ...snapshot().playlist,
        {
          queueItemId: ADDED_QUEUE_ITEM_ID,
          name: 'BOT-added track',
          source: { kind: 'youtube', videoId: ADDED_VIDEO_ID },
        },
      ],
    };
    heartbeat.mockResolvedValue(hydrated);
    prepareMedia.mockImplementationOnce(async (request): Promise<ProPlaybackPrepareResult> => {
      expect(
        getState('playlist.items').some((item) => item.queueItemId === ADDED_QUEUE_ITEM_ID),
      ).toBe(true);
      return {
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: 180,
        youtubeSubIndex: request.youtubeSubIndex ?? null,
        youtubeVideoId: request.youtubeVideoId ?? null,
      };
    });
    const event = {
      ...prepareEvent(TRANSITION_READY),
      target: playback(1, {
        queueItemId: ADDED_QUEUE_ITEM_ID,
        youtubeVideoId: ADDED_VIDEO_ID,
      }),
    };

    acceptProRoomRealtimeFrameForTests(serverFrame(event as unknown as Record<string, unknown>));

    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    expect(heartbeat).toHaveBeenCalled();
    expect(systemAudio).not.toHaveBeenCalled();
    expect(prepareMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        queueItemId: ADDED_QUEUE_ITEM_ID,
        youtubeVideoId: ADDED_VIDEO_ID,
      }),
    );
    await vi.waitFor(() =>
      expect(reportReady).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: TRANSITION_READY, status: 'ready' }),
      ),
    );
  });

  it('hydrates a BOT target even when an independent system-audio refresh never settles', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const systemAudio = vi.mocked(ProRoomApiClient.prototype.getSystemAudioState);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(systemAudio).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();
    systemAudio.mockClear();

    const hydrated: ProRoomSnapshot = {
      ...snapshot(),
      revision: 2,
      playlistRevision: 2,
      playlist: [
        ...snapshot().playlist,
        {
          queueItemId: ADDED_QUEUE_ITEM_ID,
          name: 'BOT-added track',
          source: { kind: 'youtube', videoId: ADDED_VIDEO_ID },
        },
      ],
    };
    heartbeat.mockResolvedValueOnce(snapshot()).mockResolvedValue(hydrated);
    systemAudio.mockImplementationOnce(() => new Promise(() => {}));

    // A realtime invalidation owns the independent system-audio refresh. Even
    // if that read never settles, it must not occupy the heartbeat flight used
    // to hydrate a just-added playlist row.
    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'system-audio-invalidated', generation: 1 }),
    );
    await vi.waitFor(() => expect(systemAudio).toHaveBeenCalledOnce());

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 2 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());

    const event = {
      ...prepareEvent(TRANSITION_READY),
      target: playback(1, {
        queueItemId: ADDED_QUEUE_ITEM_ID,
        youtubeVideoId: ADDED_VIDEO_ID,
      }),
    };
    acceptProRoomRealtimeFrameForTests(serverFrame(event as unknown as Record<string, unknown>));

    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    expect(prepareMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        queueItemId: ADDED_QUEUE_ITEM_ID,
        youtubeVideoId: ADDED_VIDEO_ID,
      }),
    );
    await vi.waitFor(() =>
      expect(reportReady).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: TRANSITION_READY, status: 'ready' }),
      ),
    );
  });

  it('hydrates a BOT target after the older joined heartbeat rejects', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();

    let rejectOlderHeartbeat!: (error: unknown) => void;
    const hydrated: ProRoomSnapshot = {
      ...snapshot(),
      revision: 2,
      playlistRevision: 2,
      playlist: [
        ...snapshot().playlist,
        {
          queueItemId: ADDED_QUEUE_ITEM_ID,
          name: 'BOT-added track',
          source: { kind: 'youtube', videoId: ADDED_VIDEO_ID },
        },
      ],
    };
    heartbeat
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOlderHeartbeat = reject;
          }),
      )
      .mockResolvedValue(hydrated);
    prepareMedia.mockImplementationOnce(async (request): Promise<ProPlaybackPrepareResult> => {
      expect(
        getState('playlist.items').some((item) => item.queueItemId === ADDED_QUEUE_ITEM_ID),
      ).toBe(true);
      return {
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: 180,
        youtubeSubIndex: request.youtubeSubIndex ?? null,
        youtubeVideoId: request.youtubeVideoId ?? null,
      };
    });

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 2 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    acceptProRoomRealtimeFrameForTests(
      serverFrame({
        ...prepareEvent(TRANSITION_READY),
        target: playback(1, {
          queueItemId: ADDED_QUEUE_ITEM_ID,
          youtubeVideoId: ADDED_VIDEO_ID,
        }),
      } as unknown as Record<string, unknown>),
    );

    rejectOlderHeartbeat(new ProRoomApiError('NETWORK_ERROR'));
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(reportReady).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: TRANSITION_READY, status: 'ready' }),
      ),
    );
  });

  it.each(['before', 'during'] as const)(
    'preserves a repeat edit made %s an invalidation queue-mode read',
    async (timing) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const mode = {
        schemaVersion: 1 as const,
        view: 'queue-mode' as const,
        roomCode: ROOM_CODE,
        revision: 1,
        playlistRevision: 1,
        updatedAtMs: 2,
        repeatMode: 0 as const,
        shuffleEnabled: false,
        shuffleOrder: [],
      };
      let resolveRead!: (value: typeof mode) => void;
      vi.mocked(ProRoomApiClient.prototype.getQueueMode).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      );
      const update = vi
        .spyOn(ProRoomApiClient.prototype, 'updateQueueMode')
        .mockImplementation(async (input) => ({
          ...mode,
          revision: 2,
          repeatMode: input.repeatMode,
          shuffleEnabled: input.shuffleEnabled,
          shuffleOrder: input.shuffleOrder,
        }));
      restoreSpies.push(update);
      vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue({
        ...snapshot(),
        revision: 2,
        queueModeRevision: 1,
        presence: { ...snapshot().presence, revision: 2 },
      });
      if (timing === 'before') setState('playlist.repeatMode', 1);
      acceptProRoomRealtimeFrameForTests(serverFrame({ type: 'pro-room-invalidated' }));
      await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'));
      if (timing === 'during') setState('playlist.repeatMode', 1);
      resolveRead(mode);
      await vi.waitFor(() => expect(update).toHaveBeenCalled());
      expect(update.mock.calls.at(-1)?.[0].repeatMode).toBe(1);
      expect(getState('playlist.repeatMode')).toBe(1);
    },
  );

  it.each([false, true])(
    'preserves a newer repeat edit after the preceding checkpoint (conflict=%s)',
    async (conflict) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const mode = {
        schemaVersion: 1 as const,
        view: 'queue-mode' as const,
        roomCode: ROOM_CODE,
        revision: 1,
        playlistRevision: 1,
        updatedAtMs: 2,
        repeatMode: 1 as const,
        shuffleEnabled: false,
        shuffleOrder: [],
      };
      let resolveUpdate!: (value: typeof mode) => void;
      let rejectUpdate!: (error: unknown) => void;
      const update = vi
        .spyOn(ProRoomApiClient.prototype, 'updateQueueMode')
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              resolveUpdate = resolve;
              rejectUpdate = reject;
            }),
        )
        .mockImplementation(async (input) => ({
          ...mode,
          revision: 2,
          repeatMode: input.repeatMode,
        }));
      restoreSpies.push(update);
      setState('playlist.repeatMode', 1);
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
      setState('playlist.repeatMode', 2);
      vi.mocked(ProRoomApiClient.prototype.getQueueMode).mockResolvedValue(mode);
      vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue({
        ...snapshot(),
        revision: 2,
        queueModeRevision: 1,
        presence: { ...snapshot().presence, revision: 2 },
      });
      acceptProRoomRealtimeFrameForTests(serverFrame({ type: 'pro-room-invalidated' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (conflict) rejectUpdate(new ProRoomApiError('QUEUE_MODE_REVISION_CONFLICT', 409));
      else resolveUpdate(mode);
      await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
      expect(update.mock.calls[1]?.[0].repeatMode).toBe(2);
      expect(getState('playlist.repeatMode')).toBe(2);
    },
  );

  it.each([false, true])(
    'applies canonical queue mode without newer local intent (conflict=%s)',
    async (conflict) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const mode = {
        schemaVersion: 1 as const,
        view: 'queue-mode' as const,
        roomCode: ROOM_CODE,
        revision: 1,
        playlistRevision: 1,
        updatedAtMs: 2,
        repeatMode: 2 as const,
        shuffleEnabled: true,
        shuffleOrder: [QUEUE_ITEM_ID],
      };
      vi.mocked(ProRoomApiClient.prototype.getQueueMode).mockResolvedValue(mode);
      const update = vi
        .spyOn(ProRoomApiClient.prototype, 'updateQueueMode')
        .mockRejectedValue(new ProRoomApiError('QUEUE_MODE_REVISION_CONFLICT', 409));
      restoreSpies.push(update);
      if (conflict) {
        setState('playlist.repeatMode', 1);
        await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
      } else {
        vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue({
          ...snapshot(),
          revision: 2,
          queueModeRevision: 1,
          presence: { ...snapshot().presence, revision: 2 },
        });
        acceptProRoomRealtimeFrameForTests(serverFrame({ type: 'pro-room-invalidated' }));
      }
      await vi.waitFor(() => expect(getState('playlist.repeatMode')).toBe(2));
      expect(getState('playlist.isShuffle')).toBe(true);
      expect(capturePlaylistQueueModeState().shuffleOrder).toEqual([QUEUE_ITEM_ID]);
      if (!conflict) expect(update).not.toHaveBeenCalled();
    },
  );

  it('preserves a newer shuffle-off edit while keeping the incoming repeat setting', async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mode = {
      schemaVersion: 1 as const,
      view: 'queue-mode' as const,
      roomCode: ROOM_CODE,
      revision: 1,
      playlistRevision: 1,
      updatedAtMs: 2,
      repeatMode: 0 as 0 | 1 | 2,
      shuffleEnabled: true,
      shuffleOrder: [QUEUE_ITEM_ID],
    };
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const read = vi.mocked(ProRoomApiClient.prototype.getQueueMode).mockResolvedValue(mode);
    heartbeat.mockResolvedValue({
      ...snapshot(),
      revision: 2,
      queueModeRevision: 1,
      presence: { ...snapshot().presence, revision: 2 },
    });
    acceptProRoomRealtimeFrameForTests(serverFrame({ type: 'pro-room-invalidated' }));
    await vi.waitFor(() => expect(getState('playlist.isShuffle')).toBe(true));
    let resolveRead!: (value: typeof mode) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const update = vi
      .spyOn(ProRoomApiClient.prototype, 'updateQueueMode')
      .mockImplementation(async (input) => ({
        ...mode,
        revision: 3,
        repeatMode: input.repeatMode,
        shuffleEnabled: input.shuffleEnabled,
        shuffleOrder: input.shuffleOrder,
      }));
    restoreSpies.push(update);
    heartbeat.mockResolvedValue({
      ...snapshot(),
      revision: 3,
      queueModeRevision: 2,
      presence: { ...snapshot().presence, revision: 3 },
    });
    acceptProRoomRealtimeFrameForTests(serverFrame({ type: 'pro-room-invalidated' }));
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'));
    setState('playlist.isShuffle', false);
    resolveRead({ ...mode, revision: 2, repeatMode: 2 });
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls.at(-1)?.[0]).toMatchObject({
      repeatMode: 2,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
  });

  it('coalesces pending effects and queue-mode GETs then follows the newest revision once', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const getSettingsSync = vi.mocked(ProRoomApiClient.prototype.getSettingsSync);
    const getQueueMode = vi.mocked(ProRoomApiClient.prototype.getQueueMode);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();
    getSettingsSync.mockClear();
    getQueueMode.mockClear();

    let resolveEffects!: (value: Awaited<ReturnType<ProRoomApiClient['getSettingsSync']>>) => void;
    let resolveQueueMode!: (value: Awaited<ReturnType<ProRoomApiClient['getQueueMode']>>) => void;
    getSettingsSync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEffects = resolve;
        }),
    );
    getQueueMode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQueueMode = resolve;
        }),
    );
    getSettingsSync.mockResolvedValue({
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM_CODE,
      revision: 2,
      updatedAtMs: 3,
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    });
    getQueueMode.mockResolvedValue({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM_CODE,
      revision: 2,
      playlistRevision: 1,
      updatedAtMs: 3,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });

    const invalidatedSnapshot = (revision: number, dedicatedRevision: number): ProRoomSnapshot => ({
      ...snapshot(),
      revision,
      effectsRevision: dedicatedRevision,
      queueModeRevision: dedicatedRevision,
      presence: {
        ...snapshot().presence,
        revision,
      },
    });
    heartbeat
      .mockResolvedValueOnce(invalidatedSnapshot(2, 1))
      .mockResolvedValueOnce(invalidatedSnapshot(3, 2))
      .mockResolvedValue(invalidatedSnapshot(4, 2));

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 2 }),
    );
    await vi.waitFor(() => expect(getSettingsSync).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getQueueMode).toHaveBeenCalledOnce());

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 3 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSettingsSync).toHaveBeenCalledOnce();
    expect(getQueueMode).toHaveBeenCalledOnce();

    resolveEffects({
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM_CODE,
      revision: 1,
      updatedAtMs: 2,
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    });
    resolveQueueMode({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM_CODE,
      revision: 1,
      playlistRevision: 1,
      updatedAtMs: 2,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
    await vi.waitFor(() => expect(getSettingsSync).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getQueueMode).toHaveBeenCalledTimes(2));

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 4 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(3));
    expect(getSettingsSync).toHaveBeenCalledTimes(2);
    expect(getQueueMode).toHaveBeenCalledTimes(2);
  });

  it('applies virtual treble when a server invalidation advances the effects revision', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const getSettingsSync = vi.mocked(ProRoomApiClient.prototype.getSettingsSync);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(getSettingsSync).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();
    getSettingsSync.mockClear();

    const effects = createDefaultRoomEffectsState();
    effects.virtualTreble.enabled = true;
    getSettingsSync.mockResolvedValueOnce({
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM_CODE,
      revision: 1,
      updatedAtMs: 2,
      masterVolume: 1,
      effects,
    });
    heartbeat.mockResolvedValueOnce({
      ...snapshot(),
      revision: 2,
      effectsRevision: 1,
      presence: { ...snapshot().presence, revision: 2 },
    });

    expect(getState('audio.exciter')).toBe(false);
    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-room-invalidated', roomRevision: 2, effectsRevision: 1 }),
    );

    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(getSettingsSync).toHaveBeenCalled());
    await vi.waitFor(() => expect(getState('audio.exciter')).toBe(true));
  });

  it('preserves a newer settings edit when an older PUT repairs an epoch mismatch', async () => {
    const getSettingsSync = vi.mocked(ProRoomApiClient.prototype.getSettingsSync);
    await vi.waitFor(() => expect(getSettingsSync).toHaveBeenCalled());
    setState('setup.sessionStarted', true);
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();

    let rejectFirst!: (error: unknown) => void;
    const updateSettingsSync = vi
      .spyOn(ProRoomApiClient.prototype, 'updateSettingsSync')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementation(async (input) => ({
        schemaVersion: 1,
        view: 'settings-sync',
        roomCode: ROOM_CODE,
        revision: 1,
        updatedAtMs: 2,
        masterVolume: input.masterVolume,
        effects: input.effects,
      }));
    restoreSpies.push(updateSettingsSync);

    setState('audio.masterVolume', 0.51);
    await vi.waitFor(() => expect(updateSettingsSync).toHaveBeenCalledOnce());
    setState('audio.masterVolume', 0.62);
    rejectFirst(new ProRoomApiError('ROOM_EPOCH_MISMATCH', 409));

    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(updateSettingsSync).toHaveBeenCalledTimes(2));
    expect(updateSettingsSync.mock.calls[1]?.[0]).toMatchObject({ masterVolume: 0.62 });
  });

  it('preserves a newer settings edit when an older PUT fails terminally', async () => {
    const getSettingsSync = vi.mocked(ProRoomApiClient.prototype.getSettingsSync);
    await vi.waitFor(() => expect(getSettingsSync).toHaveBeenCalled());
    setState('setup.sessionStarted', true);

    let rejectFirst!: (error: unknown) => void;
    const updateSettingsSync = vi
      .spyOn(ProRoomApiClient.prototype, 'updateSettingsSync')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementation(async (input) => ({
        schemaVersion: 1,
        view: 'settings-sync',
        roomCode: ROOM_CODE,
        revision: 1,
        updatedAtMs: 2,
        masterVolume: input.masterVolume,
        effects: input.effects,
      }));
    restoreSpies.push(updateSettingsSync);

    setState('audio.masterVolume', 0.41);
    await vi.waitFor(() => expect(updateSettingsSync).toHaveBeenCalledOnce());
    setState('audio.masterVolume', 0.73);
    rejectFirst(new ProRoomApiError('INVALID_EFFECTS', 400));

    await vi.waitFor(() => expect(updateSettingsSync).toHaveBeenCalledTimes(2));
    expect(updateSettingsSync.mock.calls[1]?.[0]).toMatchObject({ masterVolume: 0.73 });
  });

  it('retries one pending effects and queue-mode refresh after the first GET rejects', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const getSettingsSync = vi.mocked(ProRoomApiClient.prototype.getSettingsSync);
    const getQueueMode = vi.mocked(ProRoomApiClient.prototype.getQueueMode);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();
    getSettingsSync.mockClear();
    getQueueMode.mockClear();

    let rejectEffects!: (error: unknown) => void;
    let rejectQueueMode!: (error: unknown) => void;
    getSettingsSync
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectEffects = reject;
          }),
      )
      .mockResolvedValue({
        schemaVersion: 1,
        view: 'settings-sync',
        roomCode: ROOM_CODE,
        revision: 1,
        updatedAtMs: 2,
        masterVolume: 1,
        effects: createDefaultRoomEffectsState(),
      });
    getQueueMode
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectQueueMode = reject;
          }),
      )
      .mockResolvedValue({
        schemaVersion: 1,
        view: 'queue-mode',
        roomCode: ROOM_CODE,
        revision: 1,
        playlistRevision: 1,
        updatedAtMs: 2,
        repeatMode: 0,
        shuffleEnabled: false,
        shuffleOrder: [],
      });

    const invalidatedSnapshot = (revision: number): ProRoomSnapshot => ({
      ...snapshot(),
      revision,
      effectsRevision: 1,
      queueModeRevision: 1,
      presence: { ...snapshot().presence, revision },
    });
    heartbeat
      .mockResolvedValueOnce(invalidatedSnapshot(2))
      .mockResolvedValueOnce(invalidatedSnapshot(3))
      .mockResolvedValue(invalidatedSnapshot(4));

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 2 }),
    );
    await vi.waitFor(() => expect(getSettingsSync).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getQueueMode).toHaveBeenCalledOnce());
    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 3 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));

    rejectEffects(new Error('effects unavailable'));
    rejectQueueMode(new Error('queue mode unavailable'));
    await vi.waitFor(() => expect(getSettingsSync).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getQueueMode).toHaveBeenCalledTimes(2));

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 4 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(3));
    expect(getSettingsSync).toHaveBeenCalledTimes(2);
    expect(getQueueMode).toHaveBeenCalledTimes(2);
  });

  it('does not start a late BOT target preparation after the transition is cancelled', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    heartbeat.mockClear();
    let resolveHeartbeat!: (value: ProRoomSnapshot) => void;
    heartbeat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );
    const event = {
      ...prepareEvent(TRANSITION_READY),
      target: playback(1, {
        queueItemId: ADDED_QUEUE_ITEM_ID,
        youtubeVideoId: ADDED_VIDEO_ID,
      }),
    };

    acceptProRoomRealtimeFrameForTests(serverFrame(event as unknown as Record<string, unknown>));
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    acceptProRoomRealtimeFrameForTests(
      serverFrame({
        type: 'pro-playback-cancel',
        transitionId: TRANSITION_READY,
        serverTimeMs: 10_050,
        reason: 'superseded',
      }),
    );
    resolveHeartbeat({
      ...snapshot(),
      revision: 2,
      playlistRevision: 2,
      playlist: [
        ...snapshot().playlist,
        {
          queueItemId: ADDED_QUEUE_ITEM_ID,
          name: 'BOT-added track',
          source: { kind: 'youtube', videoId: ADDED_VIDEO_ID },
        },
      ],
    });
    await vi.waitFor(() =>
      expect(
        getState('playlist.items').some((item) => item.queueItemId === ADDED_QUEUE_ITEM_ID),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(prepareMedia).not.toHaveBeenCalled();
    expect(reportReady).not.toHaveBeenCalled();
  });

  it('announces authoritative PRO joins and leaves once without treating rename as churn', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    heartbeat.mockClear();
    const messages: string[] = [];
    const off = bus.on('chat:system-message', (text) => messages.push(text));
    const peerTwo = {
      participantId: 'participant_00002',
      memberId: 'member_0000000002',
      memberDisplayNumber: 1,
      isAuthenticated: true,
      displayName: 'Peer 2',
      devicePlatform: 'other' as const,
      role: 'controller' as const,
      capabilities: ['effects.control' as const, 'playback.control' as const],
      joinedAtMs: 2,
    };
    try {
      const joined: ProRoomSnapshot = {
        ...snapshot(),
        revision: 2,
        administrators: [
          ...snapshot().administrators,
          {
            memberId: peerTwo.memberId,
            memberDisplayNumber: peerTwo.memberDisplayNumber,
            isAuthenticated: peerTwo.isAuthenticated,
            displayName: peerTwo.displayName,
            role: 'controller',
            permissions: {
              'media.add': false,
              'playback.control': true,
              'members.kick': false,
              'chat.notice': false,
            },
            inheritedPermissions: [],
            onlineDeviceCount: 1,
          },
        ],
        presence: {
          ...snapshot().presence,
          revision: 2,
          participants: [...snapshot().presence.participants, peerTwo],
        },
      };
      heartbeat.mockResolvedValue(joined);
      acceptProRoomRealtimeFrameForTests(
        serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 2 }),
      );
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0]).toContain('Peer 2');

      // Replayed invalidations and a name change keep the same participant ID,
      // so neither may create a second join/leave row.
      acceptProRoomRealtimeFrameForTests(
        serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 2 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages).toHaveLength(1);

      const renamed: ProRoomSnapshot = {
        ...joined,
        revision: 3,
        administrators: joined.administrators.map((administrator) =>
          administrator.memberId === peerTwo.memberId
            ? { ...administrator, displayName: 'Listening room' }
            : administrator,
        ),
        presence: {
          ...joined.presence,
          revision: 3,
          participants: [
            joined.presence.participants[0],
            { ...peerTwo, displayName: 'Listening room' },
          ],
        },
      };
      heartbeat.mockResolvedValue(renamed);
      acceptProRoomRealtimeFrameForTests(
        serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 3 }),
      );
      await vi.waitFor(() =>
        expect(getState('network.peerLabels').participant_00002).toBe('Listening room'),
      );
      expect(messages).toHaveLength(1);

      const departed: ProRoomSnapshot = {
        ...renamed,
        revision: 4,
        administrators: renamed.administrators.map((administrator) =>
          administrator.memberId === peerTwo.memberId
            ? { ...administrator, onlineDeviceCount: 0 }
            : administrator,
        ),
        presence: {
          ...renamed.presence,
          revision: 4,
          participants: [renamed.presence.participants[0]],
        },
      };
      heartbeat.mockResolvedValue(departed);
      acceptProRoomRealtimeFrameForTests(
        serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 4 }),
      );
      await vi.waitFor(() => expect(messages).toHaveLength(2));
      expect(messages[1]).toContain('Listening room');
    } finally {
      off();
    }
  });

  it('does not report media READY until a fresh server clock sample is available', async () => {
    let resolveClock!: (value: boolean) => void;
    waitForClock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveClock = resolve;
      }),
    );

    acceptProRoomRealtimeFrameForTests(
      serverFrame(prepareEvent(TRANSITION_READY) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    expect(reportReady).not.toHaveBeenCalled();

    resolveClock(true);
    await vi.waitFor(() =>
      expect(reportReady).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: TRANSITION_READY, status: 'ready' }),
      ),
    );
  });

  it('cancels an uncommitted PREPARE and restores it from the replacement control ticket', async () => {
    const pending = prepareEvent(TRANSITION_READY);
    acceptProRoomRealtimeFrameForTests(serverFrame(pending as unknown as Record<string, unknown>));
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());

    const reconfigure = vi
      .spyOn(ServerProRoomNetworkBridge.prototype, 'reconfigure')
      .mockResolvedValue(undefined);
    const consumePending = vi
      .spyOn(ServerProRoomNetworkBridge.prototype, 'consumePendingPlaybackTransition')
      .mockReturnValueOnce(pending);
    restoreSpies.push(reconfigure, consumePending);

    expect(requestProRoomTransportRecovery()).toBe(true);
    expect(cancelMedia).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(reconfigure).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledTimes(2));
  });

  it('re-prepares the exact committed checkpoint when the original PREPARE failed', async () => {
    prepareMedia
      .mockImplementationOnce(async (request) => ({
        status: 'failed' as const,
        authority: request.authority,
        queueItemId: request.queueItemId,
        reason: 'player-unavailable' as const,
      }))
      .mockImplementationOnce(async (request) => ({
        status: 'ready' as const,
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube' as const,
        durationSeconds: 180,
        youtubeSubIndex: request.youtubeSubIndex ?? null,
        youtubeVideoId: request.youtubeVideoId ?? null,
      }));

    const prepared = prepareEvent(TRANSITION_FAILED);
    acceptProRoomRealtimeFrameForTests(serverFrame(prepared as unknown as Record<string, unknown>));
    await vi.waitFor(() =>
      expect(reportReady).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: TRANSITION_FAILED, status: 'failed' }),
      ),
    );

    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(TRANSITION_FAILED) as unknown as Record<string, unknown>),
    );

    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    expect(commitMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        committedPlaybackRevision: 1,
        queueItemId: QUEUE_ITEM_ID,
        state: 'playing',
        timingMode: 'scheduled-control',
      }),
    );
  });

  it('serializes canonical COMMITs and prevents a slow older revision from finishing last', async () => {
    let resolveFirst!: (value: { status: 'applied'; authority: ProPlaybackAuthorityToken }) => void;
    commitMedia.mockImplementationOnce(
      (_request) =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 2) as unknown as Record<string, unknown>),
    );
    await Promise.resolve();
    expect(commitMedia).toHaveBeenCalledTimes(1);

    const firstAuthority = commitMedia.mock.calls[0]?.[0].authority as ProPlaybackAuthorityToken;
    resolveFirst({ status: 'applied', authority: firstAuthority });
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledTimes(2));

    executeCommand.mockResolvedValueOnce({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(2),
      serverTimeMs: 10_300,
    });
    routeProPlaybackCommand({
      kind: 'pause',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 5,
    });
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
    expect(executeCommand.mock.calls[0]?.[0].command).toEqual({ type: 'pause', baseRevision: 2 });
  });

  it('ignores an out-of-order stale COMMIT without cancelling the newer in-flight revision', async () => {
    let resolveNewer!: (value: { status: 'applied'; authority: ProPlaybackAuthorityToken }) => void;
    commitMedia.mockImplementationOnce(
      (_request) =>
        new Promise((resolve) => {
          resolveNewer = resolve;
        }),
    );

    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 2) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await Promise.resolve();
    expect(commitMedia).toHaveBeenCalledOnce();

    const newerAuthority = commitMedia.mock.calls[0]?.[0].authority as ProPlaybackAuthorityToken;
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    resolveNewer({ status: 'applied', authority: newerAuthority });
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());

    // A duplicate rev2 must now be stale. In the buggy ordering, late rev1
    // cancelled rev2 before it could publish lastAppliedPlaybackRevision, so
    // this duplicate started a second media commit.
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 2) as unknown as Record<string, unknown>),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commitMedia).toHaveBeenCalledOnce();
  });

  it('does not serialize a new room incarnation behind an abandoned media COMMIT', async () => {
    let resolveAbandoned!: (value: {
      status: 'applied';
      authority: ProPlaybackAuthorityToken;
    }) => void;
    commitMedia.mockImplementationOnce(
      (_request) =>
        new Promise((resolve) => {
          resolveAbandoned = resolve;
        }),
    );

    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });

    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledTimes(2));

    const abandonedAuthority = commitMedia.mock.calls[0]?.[0]
      .authority as ProPlaybackAuthorityToken;
    resolveAbandoned({ status: 'applied', authority: abandonedAuthority });
  });

  it('does not let a late command response poison a new room incarnation revision', async () => {
    let resolveAbandoned!: (
      value: Awaited<ReturnType<ProRoomApiClient['executePlaybackCommand']>>,
    ) => void;
    executeCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAbandoned = resolve;
        }),
    );

    routeProPlaybackCommand(
      { kind: 'pause', queueItemId: QUEUE_ITEM_ID, positionSeconds: 5 },
      { wasPlaying: true },
    );
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());

    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });

    resolveAbandoned({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(99),
      serverTimeMs: 10_099,
    });
    await Promise.resolve();

    routeProPlaybackCommand(
      { kind: 'play', queueItemId: QUEUE_ITEM_ID, positionSeconds: 0 },
      { wasPlaying: false },
    );
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(2));
    expect(executeCommand.mock.calls[1]?.[0].command).toEqual({
      type: 'play',
      baseRevision: 0,
    });
  });

  it('does not run an old queued command after rejoining the same room incarnation', async () => {
    let resolveAbandoned!: (
      value: Awaited<ReturnType<ProRoomApiClient['executePlaybackCommand']>>,
    ) => void;
    executeCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAbandoned = resolve;
        }),
    );

    routeProPlaybackCommand(
      { kind: 'pause', queueItemId: QUEUE_ITEM_ID, positionSeconds: 5 },
      { wasPlaying: true },
    );
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
    routeProPlaybackCommand(
      { kind: 'play', queueItemId: QUEUE_ITEM_ID, positionSeconds: 0 },
      { wasPlaying: false },
    );

    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });

    resolveAbandoned({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(0),
      serverTimeMs: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executeCommand).toHaveBeenCalledOnce();

    routeProPlaybackCommand(
      { kind: 'play', queueItemId: QUEUE_ITEM_ID, positionSeconds: 0 },
      { wasPlaying: false },
    );
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(2));
    expect(executeCommand.mock.calls[1]?.[0].command).toEqual({
      type: 'play',
      baseRevision: 0,
    });
  });

  it.each([
    ['kickMember', 'SESSION_REQUIRED', 401],
    ['kickMember', 'PERMISSION_REQUIRED', 403],
    ['kickPresence', 'SESSION_REQUIRED', 401],
    ['kickPresence', 'PERMISSION_REQUIRED', 403],
  ] as const)('fences a stale %s failure %s after rejoining', async (method, code, status) => {
    let rejectKick!: (reason: unknown) => void;
    const kick = vi.spyOn(ProRoomApiClient.prototype, method).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectKick = reject;
        }),
    );
    restoreSpies.push(kick);
    const operation =
      method === 'kickMember'
        ? kickActiveProRoomMember('member_target_0001')
        : kickActiveProRoomPresence('participant_target_0001');
    const rejected = expect(operation).rejects.toMatchObject({
      code: 'PRO_ROOM_SESSION_SUPERSEDED',
    });
    await vi.waitFor(() => expect(kick).toHaveBeenCalledOnce());
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    rejectKick(new ProRoomApiError(code, status));
    await rejected;
    expect(getState('room.context')).toMatchObject({ kind: 'pro', roomId: ROOM_CODE });
  });

  it.each([
    ['kickMember', 'SESSION_REQUIRED', 401],
    ['kickMember', 'PERMISSION_REQUIRED', 403],
    ['kickPresence', 'SESSION_REQUIRED', 401],
    ['kickPresence', 'PERMISSION_REQUIRED', 403],
  ] as const)('preserves the current session %s failure %s', async (method, code, status) => {
    const failure = new ProRoomApiError(code, status);
    const kick = vi.spyOn(ProRoomApiClient.prototype, method).mockRejectedValueOnce(failure);
    restoreSpies.push(kick);
    const operation =
      method === 'kickMember'
        ? kickActiveProRoomMember('member_target_0001')
        : kickActiveProRoomPresence('participant_target_0001');
    await expect(operation).rejects.toBe(failure);
  });

  it.each([false, true])(
    'recovers a terminal chat kick only while its session remains current (rejoined=%s)',
    async (rejoined) => {
      requestProRoomLeave();
      await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
      const withTarget = snapshot();
      withTarget.presence.participants.push({
        participantId: 'participant_target_0001',
        memberId: 'member_target_0001',
        memberDisplayNumber: 1,
        isAuthenticated: false,
        displayName: 'Target',
        devicePlatform: 'other',
        role: 'member',
        capabilities: [],
        joinedAtMs: 2,
      });
      vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValue(withTarget);
      await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
      let rejectKick!: (reason: unknown) => void;
      const kick = vi.spyOn(ProRoomApiClient.prototype, 'kickMember').mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectKick = reject;
          }),
      );
      restoreSpies.push(kick);
      bus.emit('pro-room:kick-member', 'member_target_0001');
      await vi.waitFor(() => expect(kick).toHaveBeenCalledOnce());
      if (rejoined) {
        requestProRoomLeave();
        await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
        await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
      }
      const closeSession = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced);
      const closeCallsBeforeFailure = closeSession.mock.calls.length;
      rejectKick(new ProRoomApiError('SESSION_REQUIRED', 401));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getState('room.context').kind).toBe(rejoined ? 'pro' : 'standard');
      if (rejoined) expect(closeSession).toHaveBeenCalledTimes(closeCallsBeforeFailure);
    },
  );

  it('does not let a late terminal command error close a new room incarnation', async () => {
    let rejectAbandoned!: (reason: unknown) => void;
    executeCommand.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAbandoned = reject;
        }),
    );

    routeProPlaybackCommand(
      { kind: 'pause', queueItemId: QUEUE_ITEM_ID, positionSeconds: 5 },
      { wasPlaying: true },
    );
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());

    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    const closeSession = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced);
    const closeCallsAfterRejoin = closeSession.mock.calls.length;

    rejectAbandoned(new ProRoomApiError('SESSION_REQUIRED'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getState('room.context')).toMatchObject({ kind: 'pro', roomId: ROOM_CODE });
    expect(closeSession).toHaveBeenCalledTimes(closeCallsAfterRejoin);
  });

  it('applies one matching COMMIT, ignores duplicate/stale epochs, and fences CANCEL by transition', async () => {
    const prepared = prepareEvent(TRANSITION_COMMIT);
    acceptProRoomRealtimeFrameForTests(serverFrame(prepared as unknown as Record<string, unknown>));
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());

    const committed = commitEvent(TRANSITION_COMMIT, 1, 699);
    acceptProRoomRealtimeFrameForTests(
      serverFrame(committed as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    expect(commitMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        committedPlaybackRevision: 1,
        queueItemId: QUEUE_ITEM_ID,
        state: 'playing',
        timingMode: 'zero-start',
        youtubeVideoId: VIDEO_ID,
        youtubeSubIndex: 0,
      }),
    );

    acceptProRoomRealtimeFrameForTests(
      serverFrame(committed as unknown as Record<string, unknown>),
    );
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 2) as unknown as Record<string, unknown>, ROOM_EPOCH + 1),
    );
    acceptProRoomRealtimeFrameForTests(
      serverFrame(
        {
          type: 'pro-playback-cancel',
          transitionId: TRANSITION_FAILED,
          serverTimeMs: 10_200,
          reason: 'wrong-transition',
        },
        ROOM_EPOCH + 1,
      ),
    );
    await Promise.resolve();

    expect(commitMedia).toHaveBeenCalledOnce();
    expect(cancelMedia).not.toHaveBeenCalled();
  });

  it('treats the legacy transition timing as a scheduled control', async () => {
    const prepared = prepareEvent(TRANSITION_COMMIT);
    acceptProRoomRealtimeFrameForTests(serverFrame(prepared as unknown as Record<string, unknown>));
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());

    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(TRANSITION_COMMIT, 1, 700) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    expect(commitMedia).toHaveBeenCalledWith(
      expect.objectContaining({ timingMode: 'scheduled-control' }),
    );
  });

  it('treats an unknown transition timing as a scheduled control', async () => {
    const nextPrepared = prepareEvent(TRANSITION_FAILED);
    acceptProRoomRealtimeFrameForTests(
      serverFrame(nextPrepared as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(TRANSITION_FAILED, 1, 702) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    expect(commitMedia).toHaveBeenCalledWith(
      expect.objectContaining({ timingMode: 'scheduled-control' }),
    );
  });

  it('advances command baseRevision after a canonical COMMIT', async () => {
    const prepared = prepareEvent(TRANSITION_COMMIT);
    acceptProRoomRealtimeFrameForTests(serverFrame(prepared as unknown as Record<string, unknown>));
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(TRANSITION_COMMIT) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    executeCommand.mockResolvedValueOnce({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(1),
      serverTimeMs: 10_200,
    });
    expect(
      routeProPlaybackCommand({
        kind: 'seek',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 42,
      }),
    ).toBe(true);

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
    expect(executeCommand.mock.calls[0]?.[0].command).toEqual({
      type: 'seek',
      baseRevision: 1,
      positionSeconds: 42,
    });
  });

  it('rendezvous-releases the current running checkpoint locally after a fresh heartbeat', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    heartbeat.mockResolvedValueOnce({
      ...snapshot(playback(1, { positionSeconds: 23, updatedAtMs: Date.now() })),
      revision: 2,
    });
    const loading: boolean[] = [];
    const off = bus.on('pro-playback:transition-loading', (value) => loading.push(value));
    try {
      await expect(requestActiveProRoomPlaybackReconciliation()).resolves.toBe(true);
    } finally {
      off();
    }

    expect(heartbeat).toHaveBeenCalledOnce();
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(commitMedia).toHaveBeenCalledTimes(2);
    expect(commitMedia.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        committedPlaybackRevision: 1,
        queueItemId: QUEUE_ITEM_ID,
        state: 'playing',
        timingMode: 'scheduled-control',
        scheduleDelayMs: 700,
        positionSeconds: expect.closeTo(23.7, 1),
      }),
    );
    expect(commitMedia.mock.calls[1]?.[0].authority.transitionId).toMatch(/^local_sync_1_/);
    expect(loading).toEqual([true, false]);
  });

  it('uses a freshly calibrated server clock instead of a skewed local wall clock', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    heartbeat.mockResolvedValueOnce({
      ...snapshot(playback(1, { positionSeconds: 23, updatedAtMs: 10_000 })),
      revision: 2,
    });
    waitForClock.mockClear();
    const serverNow = vi
      .spyOn(ServerProRoomNetworkBridge.prototype, 'serverNowMs', 'get')
      .mockReturnValue(12_000);
    const localNow = vi.spyOn(Date, 'now').mockReturnValue(9_000_000);
    restoreSpies.push(serverNow, localNow);

    await expect(requestActiveProRoomPlaybackReconciliation()).resolves.toBe(true);

    expect(waitForClock).toHaveBeenCalledWith({
      serverDeadlineAtMs: Number.MAX_SAFE_INTEGER,
      fallbackTimeoutMs: 1_000,
    });
    expect(commitMedia.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        committedPlaybackRevision: 1,
        scheduleDelayMs: 700,
        positionSeconds: expect.closeTo(25.7, 3),
      }),
    );
  });

  it('lets a newer server PREPARE supersede an in-flight local manual rendezvous', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValueOnce({
      ...snapshot(playback(1, { positionSeconds: 23, updatedAtMs: Date.now() })),
      revision: 2,
    });
    let resolveLocal!: (result: ProPlaybackPrepareResult) => void;
    prepareMedia.mockImplementationOnce(
      (_request) =>
        new Promise<ProPlaybackPrepareResult>((resolve) => {
          resolveLocal = resolve;
        }),
    );

    const syncing = requestActiveProRoomPlaybackReconciliation();
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    const localAuthority = prepareMedia.mock.calls[0]?.[0].authority;

    acceptProRoomRealtimeFrameForTests(
      serverFrame(prepareEvent(TRANSITION_READY, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(cancelMedia).toHaveBeenCalledWith(localAuthority));

    resolveLocal({
      status: 'ready',
      authority: localAuthority,
      queueItemId: QUEUE_ITEM_ID,
      mediaKind: 'youtube',
      durationSeconds: 180,
      youtubeSubIndex: 0,
      youtubeVideoId: VIDEO_ID,
    });

    await expect(syncing).resolves.toBe(false);
    await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());
    expect(commitMedia).toHaveBeenCalledOnce();
  });

  it('does not wait for clock calibration when reconciling an exact paused checkpoint', async () => {
    const paused = playback(1, { state: 'paused', positionSeconds: 37 });
    acceptProRoomRealtimeFrameForTests(
      serverFrame({
        ...commitEvent(null, 1),
        playback: paused,
      } as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValueOnce({
      ...snapshot(paused),
      revision: 2,
    });
    waitForClock.mockClear();

    await expect(requestActiveProRoomPlaybackReconciliation()).resolves.toBe(true);

    expect(waitForClock).not.toHaveBeenCalled();
    expect(commitMedia.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ state: 'paused', positionSeconds: 37 }),
    );
  });

  it('remembers a lifecycle that starts hidden and reconciles when first shown', async () => {
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));

    const resumed = snapshot(
      playback(1, { positionSeconds: 18, updatedAtMs: Date.now(), state: 'playing' }),
    );
    vi.mocked(ProRoomApiClient.prototype.createSession).mockResolvedValueOnce(resumed);
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(resumed);
    setDocumentVisibility('hidden', false);
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.heartbeat).toHaveBeenCalled());
    commitMedia.mockClear();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockClear();

    setDocumentVisibility('visible');

    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    expect(ProRoomApiClient.prototype.heartbeat).toHaveBeenCalled();
  });

  it('runs a stronger manual rendezvous after an overlapping visibility repair', async () => {
    const current = {
      ...snapshot(playback(1, { positionSeconds: 18, updatedAtMs: Date.now(), state: 'playing' })),
      revision: 2,
    };
    acceptProRoomRealtimeFrameForTests(
      serverFrame({ ...commitEvent(null, 1), playback: current.playback } as unknown as Record<
        string,
        unknown
      >),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    prepareMedia.mockClear();
    commitMedia.mockClear();
    let resolveVisibilityHeartbeat!: (value: ProRoomSnapshot) => void;
    heartbeat
      .mockImplementationOnce(
        () =>
          new Promise<ProRoomSnapshot>((resolve) => {
            resolveVisibilityHeartbeat = resolve;
          }),
      )
      .mockResolvedValue(current);

    setDocumentVisibility('hidden');
    setDocumentVisibility('visible');
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());

    // The foreground repair is YouTube-only and deliberately skips a local
    // rendezvous. A manual Sync arriving during that request is stronger and
    // must not silently inherit the weaker in-flight promise.
    const manualSync = requestActiveProRoomPlaybackReconciliation();
    resolveVisibilityHeartbeat(current);

    await expect(manualSync).resolves.toBe(true);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(commitMedia).toHaveBeenCalledTimes(2);
    expect(commitMedia.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        state: 'playing',
        timingMode: 'scheduled-control',
        scheduleDelayMs: 700,
      }),
    );
  });

  it('does not share A heartbeat with B and runs the live B follow-up', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    let resolveAHeartbeat!: (value: ProRoomSnapshot) => void;
    heartbeat
      .mockImplementationOnce(
        () =>
          new Promise<ProRoomSnapshot>((resolve) => {
            resolveAHeartbeat = resolve;
          }),
      )
      .mockResolvedValue(current);
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();

    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    ownerA.invalidate();
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    resolveAHeartbeat(current);

    await expect(requestA).resolves.toBe(false);
    await expect(requestB).resolves.toBe(true);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(waitForClock).toHaveBeenCalledOnce();
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(commitMedia).toHaveBeenCalledOnce();
  });

  it('runs B after a rejected A heartbeat instead of stranding the follow-up', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    let rejectAHeartbeat!: (reason: unknown) => void;
    heartbeat
      .mockImplementationOnce(
        () =>
          new Promise<ProRoomSnapshot>((_resolve, reject) => {
            rejectAHeartbeat = reject;
          }),
      )
      .mockResolvedValue(current);
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();

    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    ownerA.invalidate();
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    rejectAHeartbeat(new ProRoomApiError('NETWORK_ERROR'));

    await expect(requestA).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(requestB).resolves.toBe(true);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(commitMedia).toHaveBeenCalledOnce();
  });

  it('drops A after a late clock calibration and runs B from a fresh heartbeat', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(current);
    let resolveAClock!: (value: boolean) => void;
    waitForClock
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveAClock = resolve;
          }),
      )
      .mockResolvedValue(true);
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();

    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(waitForClock).toHaveBeenCalledOnce());
    ownerA.invalidate();
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    resolveAClock(true);

    await expect(requestA).resolves.toBe(false);
    await expect(requestB).resolves.toBe(true);
    expect(ProRoomApiClient.prototype.heartbeat).toHaveBeenCalledTimes(2);
    expect(waitForClock).toHaveBeenCalledTimes(2);
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(commitMedia).toHaveBeenCalledOnce();
  });

  it('returns false without preparing when the current clock wait reports unavailable', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(current);
    waitForClock.mockResolvedValueOnce(false);
    const owner = createReconciliationLiveness();

    await expect(
      requestActiveProRoomPlaybackReconciliation({
        showLoading: false,
        liveness: owner.liveness,
      }),
    ).resolves.toBe(false);

    expect(prepareMedia).not.toHaveBeenCalled();
    expect(commitMedia).not.toHaveBeenCalled();
  });

  it('runs B after a rejected A clock wait', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(current);
    let rejectAClock!: (reason: unknown) => void;
    waitForClock
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((_resolve, reject) => {
            rejectAClock = reject;
          }),
      )
      .mockResolvedValue(true);
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();

    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(waitForClock).toHaveBeenCalledOnce());
    ownerA.invalidate();
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    rejectAClock(new Error('clock unavailable'));

    await expect(requestA).rejects.toThrow('clock unavailable');
    await expect(requestB).resolves.toBe(true);
    expect(waitForClock).toHaveBeenCalledTimes(2);
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(commitMedia).toHaveBeenCalledOnce();
  });

  it.each(['ready', 'failed'] as const)(
    'cancels stale A after a newer-checkpoint %s PREPARE and gives B a fresh restore',
    async (outcome) => {
      const scenario = await beginStaleNewerCheckpointPreparation();
      scenario.resolveA(
        outcome === 'ready'
          ? {
              status: 'ready',
              authority: scenario.authorityA,
              queueItemId: QUEUE_ITEM_ID,
              mediaKind: 'youtube',
              durationSeconds: 180,
              youtubeSubIndex: 0,
              youtubeVideoId: VIDEO_ID,
            }
          : {
              status: 'failed',
              authority: scenario.authorityA,
              queueItemId: QUEUE_ITEM_ID,
              reason: 'player-unavailable',
            },
      );

      await expect(scenario.requestA).resolves.toBe(false);
      await expect(scenario.requestB).resolves.toBe(true);
      expect(prepareMedia).toHaveBeenCalledTimes(2);
      expect(commitMedia).toHaveBeenCalledOnce();
      expect(cancelMedia).toHaveBeenCalledWith(scenario.authorityA);
    },
  );

  it('cancels a rejected newer-checkpoint PREPARE and lets B retry from a clean endpoint', async () => {
    const scenario = await beginStaleNewerCheckpointPreparation();
    scenario.rejectA(new Error('prepare failed'));

    await expect(scenario.requestA).rejects.toThrow('prepare failed');
    await expect(scenario.requestB).resolves.toBe(true);
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    expect(commitMedia).toHaveBeenCalledOnce();
    expect(cancelMedia).toHaveBeenCalledWith(scenario.authorityA);
  });

  it('keeps an overlapping ordinary heartbeat authoritative when local A becomes stale', async () => {
    const newer = {
      ...snapshot(playback(1, { positionSeconds: 18, updatedAtMs: Date.now(), state: 'playing' })),
      revision: 2,
    };
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    let resolveHeartbeat!: (value: ProRoomSnapshot) => void;
    heartbeat.mockClear();
    heartbeat.mockImplementationOnce(
      () =>
        new Promise<ProRoomSnapshot>((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );
    heartbeat.mockResolvedValue(newer);
    prepareMedia.mockClear();
    commitMedia.mockClear();
    cancelMedia.mockClear();
    let endpointCurrentAtPrepare: boolean | undefined;
    prepareMedia.mockImplementationOnce(async (request) => {
      endpointCurrentAtPrepare = request.isCurrent?.();
      return {
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: 180,
        youtubeSubIndex: request.youtubeSubIndex ?? null,
        youtubeVideoId: request.youtubeVideoId ?? null,
      };
    });
    const ownerA = createReconciliationLiveness();
    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());

    // A visible lifecycle pulse is an ordinary room-authoritative heartbeat.
    // It shares the network flight but must keep its own default playback owner.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(heartbeat).toHaveBeenCalledOnce();
    ownerA.invalidate();
    resolveHeartbeat(newer);

    await expect(requestA).resolves.toBe(false);
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(endpointCurrentAtPrepare).toBe(true);
    expect(cancelMedia).not.toHaveBeenCalled();
  });

  it('runs one ordinary same-revision follower after A PREPARE goes stale, then gives B fresh work', async () => {
    const newer = {
      ...snapshot(playback(1, { positionSeconds: 18, updatedAtMs: Date.now(), state: 'playing' })),
      revision: 2,
    };
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    let resolveHeartbeat!: (value: ProRoomSnapshot) => void;
    let resolveAPrepare!: (value: ProPlaybackPrepareResult) => void;
    heartbeat.mockClear();
    heartbeat.mockImplementationOnce(
      () =>
        new Promise<ProRoomSnapshot>((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );
    heartbeat.mockResolvedValue(newer);
    prepareMedia.mockClear();
    commitMedia.mockClear();
    cancelMedia.mockClear();
    prepareMedia.mockImplementationOnce(
      () =>
        new Promise<ProPlaybackPrepareResult>((resolve) => {
          resolveAPrepare = resolve;
        }),
    );
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();
    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());

    document.dispatchEvent(new Event('visibilitychange'));
    resolveHeartbeat(newer);
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    const authorityA = prepareMedia.mock.calls[0]![0].authority;
    ownerA.invalidate();
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    resolveAPrepare({
      status: 'ready',
      authority: authorityA,
      queueItemId: QUEUE_ITEM_ID,
      mediaKind: 'youtube',
      durationSeconds: 180,
      youtubeSubIndex: 0,
      youtubeVideoId: VIDEO_ID,
    });

    await expect(requestA).resolves.toBe(false);
    await expect(requestB).resolves.toBe(true);
    expect(prepareMedia).toHaveBeenCalledTimes(3);
    expect(commitMedia).toHaveBeenCalledTimes(2);
    expect(cancelMedia).toHaveBeenCalledWith(authorityA);
  });

  it('drops A after late preparation resolves and gives B its own rendezvous', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(current);
    let resolveAPrepare!: (value: ProPlaybackPrepareResult) => void;
    prepareMedia.mockImplementationOnce(
      () =>
        new Promise<ProPlaybackPrepareResult>((resolve) => {
          resolveAPrepare = resolve;
        }),
    );
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();

    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    const authorityA = prepareMedia.mock.calls[0]?.[0].authority;
    ownerA.invalidate();
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    resolveAPrepare({
      status: 'ready',
      authority: authorityA,
      queueItemId: QUEUE_ITEM_ID,
      mediaKind: 'youtube',
      durationSeconds: 180,
      youtubeSubIndex: 0,
      youtubeVideoId: VIDEO_ID,
    });

    await expect(requestA).resolves.toBe(false);
    await expect(requestB).resolves.toBe(true);
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    expect(commitMedia).toHaveBeenCalledOnce();
    expect(cancelMedia).toHaveBeenCalledWith(authorityA);
  });

  it('returns false and releases preparation when the current endpoint is not ready', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(current);
    prepareResult = 'failed';
    const owner = createReconciliationLiveness();

    await expect(
      requestActiveProRoomPlaybackReconciliation({
        showLoading: false,
        liveness: owner.liveness,
      }),
    ).resolves.toBe(false);

    expect(prepareMedia).toHaveBeenCalledOnce();
    expect(commitMedia).not.toHaveBeenCalled();
    expect(cancelMedia).toHaveBeenCalledOnce();
  });

  it('releases rejected A preparation and runs B instead of inheriting the failed owner', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(current);
    let rejectAPrepare!: (reason: unknown) => void;
    prepareMedia.mockImplementationOnce(
      () =>
        new Promise<ProPlaybackPrepareResult>((_resolve, reject) => {
          rejectAPrepare = reject;
        }),
    );
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();

    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());
    const authorityA = prepareMedia.mock.calls[0]?.[0].authority;
    ownerA.invalidate();
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    rejectAPrepare(new Error('prepare failed'));

    await expect(requestA).rejects.toThrow('prepare failed');
    await expect(requestB).resolves.toBe(true);
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    expect(commitMedia).toHaveBeenCalledOnce();
    expect(cancelMedia).toHaveBeenCalledWith(authorityA);
  });

  it('checks exact ownership after commit resolves before starting B', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(current);
    let resolveACommit!: (value: ProPlaybackCommitResult) => void;
    commitMedia.mockImplementationOnce(
      () =>
        new Promise<ProPlaybackCommitResult>((resolve) => {
          resolveACommit = resolve;
        }),
    );
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();

    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    const commitRequestA = commitMedia.mock.calls[0]?.[0];
    ownerA.invalidate();
    expect(commitRequestA?.isCurrent?.()).toBe(false);
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    resolveACommit({ status: 'applied', authority: commitRequestA!.authority });

    await expect(requestA).resolves.toBe(false);
    await expect(requestB).resolves.toBe(true);
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    expect(commitMedia).toHaveBeenCalledTimes(2);
  });

  it('releases rejected A commit ownership before B prepares', async () => {
    const current = await establishCurrentPlayingCheckpoint();
    vi.mocked(ProRoomApiClient.prototype.heartbeat).mockResolvedValue(current);
    let rejectACommit!: (reason: unknown) => void;
    commitMedia.mockImplementationOnce(
      () =>
        new Promise<ProPlaybackCommitResult>((_resolve, reject) => {
          rejectACommit = reject;
        }),
    );
    const ownerA = createReconciliationLiveness();
    const ownerB = createReconciliationLiveness();

    const requestA = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerA.liveness,
    });
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    const authorityA = commitMedia.mock.calls[0]![0].authority;
    ownerA.invalidate();
    const requestB = requestActiveProRoomPlaybackReconciliation({
      showLoading: false,
      liveness: ownerB.liveness,
    });
    rejectACommit(new Error('commit failed'));

    await expect(requestA).rejects.toThrow('commit failed');
    await expect(requestB).resolves.toBe(true);
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    expect(commitMedia).toHaveBeenCalledTimes(2);
    expect(cancelMedia).toHaveBeenCalledWith(authorityA);
  });

  it('retains foreground recovery after an async failure and schedules a retry', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());

    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    heartbeat.mockClear();
    heartbeat.mockRejectedValueOnce(new ProRoomApiError('NETWORK_ERROR')).mockResolvedValue({
      ...snapshot(playback(1, { updatedAtMs: Date.now() })),
      revision: 2,
    });
    setDocumentVisibility('hidden');
    setDocumentVisibility('visible');

    await vi.waitFor(() =>
      expect(getManagedTimer('pro-room-visibility-playback-recovery')).not.toBeNull(),
    );
    expect(commitMedia).toHaveBeenCalledOnce();

    // A duplicate visible notification is harmless and demonstrates that the
    // failed attempt did not consume the pending recovery intent.
    setDocumentVisibility('visible');
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledTimes(2));
  });

  it('re-applies unchanged playing state before settling a local play control', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    executeCommand.mockClear();
    executeCommand.mockResolvedValueOnce({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(1, { positionSeconds: 31, updatedAtMs: Date.now() }),
      serverTimeMs: Date.now(),
    });
    const settled: Array<{ kind: string; status: string }> = [];
    const off = bus.on('pro-playback:ui-control-settled', (event) => settled.push(event));
    try {
      expect(
        routeProPlaybackCommand(
          { kind: 'play', queueItemId: QUEUE_ITEM_ID, positionSeconds: 0 },
          { wasPlaying: false },
        ),
      ).toBe(true);
      await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(settled).toEqual([expect.objectContaining({ kind: 'play', status: 'applied' })]),
      );
    } finally {
      off();
    }

    expect(commitMedia.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        committedPlaybackRevision: 1,
        positionSeconds: expect.closeTo(31, 1),
      }),
    );
  });

  it('maps a native YouTube sub-video boundary to one exact-revision server next', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    executeCommand.mockClear();
    executeCommand.mockResolvedValueOnce({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(1),
      serverTimeMs: 10_200,
    });

    expect(
      routeProPlaybackCommand({
        kind: 'advance-sub-video',
        queueItemId: QUEUE_ITEM_ID,
        positionSeconds: 179.5,
      }),
    ).toBe(true);

    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
    expect(executeCommand.mock.calls[0]?.[0].command).toEqual({
      type: 'next',
      baseRevision: 1,
    });
  });

  it('settles a local seek token only after the canonical media endpoint applies', async () => {
    const targetPlayback = playback(1, { positionSeconds: 42 });
    const transition = {
      ...prepareEvent(TRANSITION_READY),
      target: targetPlayback,
    };
    executeCommand.mockResolvedValueOnce({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'preparing',
      transition,
      playback: playback(0),
      serverTimeMs: 10_000,
    });
    let resolveCommit!: (value: {
      status: 'applied';
      authority: ProPlaybackAuthorityToken;
    }) => void;
    commitMedia.mockImplementationOnce(
      (_request) =>
        new Promise((resolve) => {
          resolveCommit = resolve;
        }),
    );
    const settled: Array<{ token: number; status: string }> = [];
    const off = bus.on('pro-playback:ui-control-settled', (event) => settled.push(event));
    try {
      routeProPlaybackCommand(
        { kind: 'seek', queueItemId: QUEUE_ITEM_ID, positionSeconds: 42 },
        { wasPlaying: true },
      );
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledOnce());

      acceptProRoomRealtimeFrameForTests(
        serverFrame({
          ...commitEvent(TRANSITION_READY, 1),
          playback: targetPlayback,
        } as unknown as Record<string, unknown>),
      );
      await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
      expect(settled).toEqual([]);

      const request = commitMedia.mock.calls[0]?.[0];
      resolveCommit({ status: 'applied', authority: request.authority });
      await vi.waitFor(() =>
        expect(settled).toEqual([expect.objectContaining({ status: 'applied' })]),
      );
    } finally {
      off();
    }
  });

  it('does not mistake another participant revision for a provisional local command', async () => {
    let rejectCommand!: (error: unknown) => void;
    executeCommand.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCommand = reject;
        }),
    );
    const settled: Array<{ token: number; status: string }> = [];
    const off = bus.on('pro-playback:ui-control-settled', (event) => settled.push(event));
    try {
      routeProPlaybackCommand(
        { kind: 'seek', queueItemId: QUEUE_ITEM_ID, positionSeconds: 42 },
        { wasPlaying: true },
      );
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());

      acceptProRoomRealtimeFrameForTests(
        serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
      );
      await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
      expect(settled.some((event) => event.status === 'applied')).toBe(false);

      rejectCommand(new ProRoomApiError('PLAYBACK_REVISION_CONFLICT', 409));
      await vi.waitFor(() =>
        expect(settled).toEqual([expect.objectContaining({ status: 'superseded' })]),
      );
    } finally {
      off();
    }
  });

  it('never rebases a delayed native sub-video boundary onto a newer revision', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    executeCommand.mockClear();

    let resolveBlockingCommand!: (
      value: Awaited<ReturnType<ProRoomApiClient['executePlaybackCommand']>>,
    ) => void;
    executeCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBlockingCommand = resolve;
        }),
    );
    routeProPlaybackCommand({
      kind: 'pause',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 10,
    });
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());

    routeProPlaybackCommand({
      kind: 'advance-sub-video',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 179.5,
    });
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 2) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledTimes(2));

    resolveBlockingCommand({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(1),
      serverTimeMs: 10_200,
    });
    // Drain the command tail through a full task turn before asserting no HTTP submission.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0]?.[0].command).toEqual({
      type: 'pause',
      baseRevision: 1,
    });
  });

  it('never rebases a delayed ENDED observation onto a newer accepted revision', async () => {
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 1) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledOnce());
    executeCommand.mockClear();

    let resolveBlockingCommand!: (
      value: Awaited<ReturnType<ProRoomApiClient['executePlaybackCommand']>>,
    ) => void;
    executeCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBlockingCommand = resolve;
        }),
    );
    routeProPlaybackCommand({
      kind: 'pause',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 10,
    });
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());

    // The media event is stamped as revision 1 now, even though its queued
    // HTTP submission cannot run until the preceding command settles.
    routeProPlaybackCommand({
      kind: 'ended',
      queueItemId: QUEUE_ITEM_ID,
      positionSeconds: 120,
      observedPositionSeconds: 120,
      durationSeconds: 120,
      mediaKind: 'youtube',
      youtubeVideoId: VIDEO_ID,
      youtubeSubIndex: 0,
    });
    acceptProRoomRealtimeFrameForTests(
      serverFrame(commitEvent(null, 2) as unknown as Record<string, unknown>),
    );
    await vi.waitFor(() => expect(commitMedia).toHaveBeenCalledTimes(2));

    resolveBlockingCommand({
      schemaVersion: 1,
      roomCode: ROOM_CODE,
      status: 'unchanged',
      transition: null,
      playback: playback(1),
      serverTimeMs: 10_200,
    });
    // Drain the command tail through a full task turn before asserting no HTTP submission.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // A buggy queue would submit ENDED with baseRevision 2 here. The exact
    // observation fence drops it before HTTP instead.
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0]?.[0].command).toEqual({
      type: 'pause',
      baseRevision: 1,
    });
  });
});
