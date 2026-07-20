/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  ProRoomApiClient,
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
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';
import { requestProRoomTransportRecovery } from '../transport-recovery.ts';
import {
  acceptProRoomRealtimeFrameForTests,
  joinProRoom,
  requestFirstAppendSelectionForTests,
} from '../runtime.ts';

const ROOM_CODE = '000001';
const ROOM_EPOCH = 7;
const PARTICIPANT_ID = 'participant_00001';
const QUEUE_ITEM_ID = '40000000-0000-4000-8000-000000000001' as QueueItemId;
const VIDEO_ID = 'dQw4w9WgXcQ';
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
          displayName: 'Equal member',
          role: 'owner',
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
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Equal member',
      role: 'owner',
      capabilities: [...capabilitiesForProRoomRole('owner')],
      coordinatorEligible: false,
    },
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

describe.sequential('coordinator-free PRO playback runtime', () => {
  const restoreSpies: Array<{ mockRestore(): void }> = [];
  let prepareResult: 'ready' | 'failed';
  let prepareMedia: ReturnType<typeof vi.fn>;
  let commitMedia: ReturnType<typeof vi.fn>;
  let cancelMedia: ReturnType<typeof vi.fn>;
  let reportReady: ReturnType<typeof vi.spyOn>;
  let executeCommand: ReturnType<typeof vi.spyOn>;
  let waitForClock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
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
        schemaVersion: 1,
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

    prepareMedia = vi.fn(
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
    commitMedia = vi.fn(async (request) => ({
      status: 'applied' as const,
      authority: request.authority,
    }));
    cancelMedia = vi.fn((_authority: ProPlaybackAuthorityToken) => undefined);
    registerProPlaybackMediaEndpoint({
      prepare: prepareMedia,
      commit: commitMedia,
      cancel: cancelMedia,
    });

    await joinProRoom({ code: ROOM_CODE, pin: '12345678', displayName: 'Equal member' });
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
    expect(executeCommand).toHaveBeenCalledWith({
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
    });
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

    expect(executeCommand).toHaveBeenCalledWith({
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
    });
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
      (request) =>
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
      (request) =>
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
      (request) =>
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
    await joinProRoom({ code: ROOM_CODE, pin: '12345678', displayName: 'Equal member' });

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
