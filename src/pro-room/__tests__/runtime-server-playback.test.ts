/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState } from '../../core/state.ts';
import { getManagedTimer } from '../../core/timers.ts';
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
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { requestProRoomTransportRecovery } from '../transport-recovery.ts';
import {
  acceptProRoomRealtimeFrameForTests,
  joinProRoom,
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
      vi.spyOn(ProRoomApiClient.prototype, 'getEffects').mockResolvedValue({
        schemaVersion: 2,
        view: 'effects',
        roomCode: ROOM_CODE,
        revision: 0,
        updatedAtMs: 1,
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
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    registerProPlaybackMediaEndpoint(null);
    for (const spy of restoreSpies.splice(0).reverse()) spy.mockRestore();
    resetState();
  });

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

  it('hydrates a newly-added BOT target before reporting PREPARE readiness', async () => {
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
    systemAudio.mockImplementationOnce(() => new Promise(() => {}));
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
    expect(systemAudio).toHaveBeenCalled();
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

  it('hydrates a BOT target even when an older heartbeat adjunct refresh never settles', async () => {
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

    // Start one routine heartbeat first. Its system-audio adjunct remains
    // pending forever, but must no longer occupy the heartbeat single-flight.
    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 2 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(systemAudio).toHaveBeenCalledOnce());

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

  it('coalesces pending effects and queue-mode GETs then follows the newest revision once', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const getEffects = vi.mocked(ProRoomApiClient.prototype.getEffects);
    const getQueueMode = vi.mocked(ProRoomApiClient.prototype.getQueueMode);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();
    getEffects.mockClear();
    getQueueMode.mockClear();

    let resolveEffects!: (value: Awaited<ReturnType<ProRoomApiClient['getEffects']>>) => void;
    let resolveQueueMode!: (value: Awaited<ReturnType<ProRoomApiClient['getQueueMode']>>) => void;
    getEffects.mockImplementationOnce(
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
    getEffects.mockResolvedValue({
      schemaVersion: 2,
      view: 'effects',
      roomCode: ROOM_CODE,
      revision: 2,
      updatedAtMs: 3,
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
    await vi.waitFor(() => expect(getEffects).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getQueueMode).toHaveBeenCalledOnce());

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 3 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getEffects).toHaveBeenCalledOnce();
    expect(getQueueMode).toHaveBeenCalledOnce();

    resolveEffects({
      schemaVersion: 2,
      view: 'effects',
      roomCode: ROOM_CODE,
      revision: 1,
      updatedAtMs: 2,
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
    await vi.waitFor(() => expect(getEffects).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getQueueMode).toHaveBeenCalledTimes(2));

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 4 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(3));
    expect(getEffects).toHaveBeenCalledTimes(2);
    expect(getQueueMode).toHaveBeenCalledTimes(2);
  });

  it('applies virtual treble when a server invalidation advances the effects revision', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const getEffects = vi.mocked(ProRoomApiClient.prototype.getEffects);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await vi.waitFor(() => expect(getEffects).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();
    getEffects.mockClear();

    const effects = createDefaultRoomEffectsState();
    effects.virtualTreble.enabled = true;
    getEffects.mockResolvedValueOnce({
      schemaVersion: 2,
      view: 'effects',
      roomCode: ROOM_CODE,
      revision: 1,
      updatedAtMs: 2,
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
    await vi.waitFor(() => expect(getEffects).toHaveBeenCalled());
    await vi.waitFor(() => expect(getState('audio.exciter')).toBe(true));
  });

  it('retries one pending effects and queue-mode refresh after the first GET rejects', async () => {
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const getEffects = vi.mocked(ProRoomApiClient.prototype.getEffects);
    const getQueueMode = vi.mocked(ProRoomApiClient.prototype.getQueueMode);
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    heartbeat.mockClear();
    getEffects.mockClear();
    getQueueMode.mockClear();

    let rejectEffects!: (error: unknown) => void;
    let rejectQueueMode!: (error: unknown) => void;
    getEffects
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectEffects = reject;
          }),
      )
      .mockResolvedValue({
        schemaVersion: 2,
        view: 'effects',
        roomCode: ROOM_CODE,
        revision: 1,
        updatedAtMs: 2,
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
    await vi.waitFor(() => expect(getEffects).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getQueueMode).toHaveBeenCalledOnce());
    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 3 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(2));

    rejectEffects(new Error('effects unavailable'));
    rejectQueueMode(new Error('queue mode unavailable'));
    await vi.waitFor(() => expect(getEffects).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getQueueMode).toHaveBeenCalledTimes(2));

    acceptProRoomRealtimeFrameForTests(
      serverFrame({ type: 'pro-presence-snapshot', presenceRevision: 4 }),
    );
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(3));
    expect(getEffects).toHaveBeenCalledTimes(2);
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
      capabilities: ['playback.control' as const],
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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

    // A buggy queue would submit ENDED with baseRevision 2 here. The exact
    // observation fence drops it before HTTP instead.
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0]?.[0].command).toEqual({
      type: 'pause',
      baseRevision: 1,
    });
  });
});
