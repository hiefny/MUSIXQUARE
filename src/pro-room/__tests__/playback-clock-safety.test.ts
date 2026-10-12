/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { ProRoomSignalingAccess } from '../../pro-room/api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
} from '../../pro-room/contracts.ts';
import { ServerProRoomNetworkBridge, proRoomServerBridge } from '../../pro-room/network-bridge.ts';
import { ProRoomPlaybackController } from '../../pro-room/playback-controller.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackMediaEndpoint,
} from '../../pro-room/playback-authority-hooks.ts';

type SocketListener = (event: { data?: unknown; reason?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;
  closeCount = 0;
  private readonly listeners = new Map<string, Set<SocketListener>>();

  readonly protocols: string[];

  constructor(
    readonly url: string,
    protocols: string | string[] = [],
  ) {
    this.protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: SocketListener): void {
    const listeners = this.listeners.get(event) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: SocketListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCount += 1;
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
    this.dispatch('close');
  }

  dispatch(event: string, data?: unknown): void {
    if (event === 'open') this.readyState = FakeWebSocket.OPEN;
    if (event === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data, reason: event === 'close' ? (this.closeReason ?? '') : undefined });
    }
  }
}

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_00001';
const INCARNATION_ID = 'presence_0000000001';
const MEMBER_ID = 'member_0000000001';
const OWNER_CAPABILITIES = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
  'room.configure',
] as const;

function snapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 4,
    playlistRevision: 0,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 2,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 2,
      revision: 3,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: MEMBER_ID,
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Equal member',
          devicePlatform: 'other',
          role: 'owner',
          capabilities: [...OWNER_CAPABILITIES],
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
      memberId: MEMBER_ID,
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: INCARNATION_ID,
      displayName: 'Equal member',
      role: 'owner',
      capabilities: [...OWNER_CAPABILITIES],
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: MEMBER_ID,
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

function access(): ProRoomSignalingAccess {
  return {
    ticket: `${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: 10_000,
    role: 'member',
    coordinatorEpoch: 2,
    presenceIncarnationId: INCARNATION_ID,
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

async function openBridge(bridge: ServerProRoomNetworkBridge): Promise<FakeWebSocket> {
  const connecting = bridge.connect(snapshot(), access());
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('fake socket was not created');
  socket.dispatch('open');
  await connecting;
  return socket;
}

function clockRequests(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.channel === 'clock');
}

function answerClockRequest(
  socket: FakeWebSocket,
  request: Record<string, unknown>,
  serverTimeMs: number,
): void {
  const payload = request.payload as Record<string, unknown>;
  socket.dispatch(
    'message',
    JSON.stringify({
      type: 'pro-clock',
      version: 1,
      requestId: payload.requestId,
      clientSentAtMs: payload.clientSentAtMs,
      serverTimeMs,
    }),
  );
}

function createSnapshotPlaybackController(state: 'playing' | 'paused' = 'playing') {
  const current = snapshot();
  const queueItemId = '40000000-0000-4000-8000-000000000001' as QueueItemId;
  current.playlist = [
    { queueItemId, name: 'Late join', source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
  ];
  current.currentQueueItemId = queueItemId;
  current.playback = {
    ...current.playback,
    revision: 1,
    state,
    queueItemId,
    positionSeconds: 23,
    updatedAtMs: 10_000,
    youtubeSubIndex: 0,
    youtubeVideoId: 'dQw4w9WgXcQ',
  };
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    role: 'member',
    coordinatorId: null,
    epoch: current.presence.coordinatorEpoch,
    snapshotRevision: current.revision,
    capabilities: [],
  });
  const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (request) => ({
    status: 'ready',
    authority: request.authority,
    queueItemId: request.queueItemId,
    mediaKind: 'youtube',
    durationSeconds: 180,
    youtubeSubIndex: 0,
    youtubeVideoId: 'dQw4w9WgXcQ',
  }));
  const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => ({
    status: 'applied',
    authority: request.authority,
  }));
  const invalidate = vi.fn<NonNullable<ProPlaybackMediaEndpoint['invalidateCommitted']>>();
  const unregister = registerProPlaybackMediaEndpoint({
    prepare,
    commit,
    invalidateCommitted: invalidate,
  });
  const heartbeat = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn();
  const reportReady = vi.fn();
  const controller = new ProRoomPlaybackController({
    isActive: () => true,
    getCanonicalSnapshot: () => current,
    getPlaylistSnapshot: () => current,
    capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM_CODE }),
    isPlaylistLeaseCurrent: () => true,
    getRoomAbortSignal: () => undefined,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: heartbeat,
    reportPlaybackTransitionReady: reportReady,
    executePlaybackCommand: execute,
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  });
  return {
    controller,
    current,
    prepare,
    commit,
    execute,
    reportReady,
    unregister,
    invalidate,
    heartbeat,
  };
}

beforeEach(() => {
  resetState();
  resetProPlaybackAuthorityHooks();
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  (
    window as Window & { __MUSIXQUARE_TRANSPORT__?: Record<string, unknown> }
  ).__MUSIXQUARE_TRANSPORT__ = {
    provider: 'cloudflare',
    signalingUrl: 'wss://signal.example.test/api/rooms',
  };
});

afterEach(() => {
  delete (window as Window & { __MUSIXQUARE_TRANSPORT__?: Record<string, unknown> })
    .__MUSIXQUARE_TRANSPORT__;
  proRoomServerBridge.disconnect();
  resetProPlaybackAuthorityHooks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetState();
});

function prepareControllerTransition(fixture: ReturnType<typeof createSnapshotPlaybackController>) {
  const { current, controller } = fixture;
  setState('playlist.items', current.playlist as never);
  const target = { ...current.playback, revision: 2, positionSeconds: 0, updatedAtMs: Date.now() };
  const event = {
    type: 'pro-playback-prepare' as const,
    transitionId: `transition_${'q'.repeat(22)}`,
    serverTimeMs: Date.now(),
    deadlineAtMs: Date.now() + 3_000,
    basePlaybackRevision: 1,
    target,
  };
  controller.acceptPrepare(event);
  return event;
}

async function answerSymmetricReady(socket: FakeWebSocket) {
  const first = clockRequests(socket).at(-1)!;
  await vi.advanceTimersByTimeAsync(20);
  answerClockRequest(socket, first, Date.now() - 10);
  await vi.advanceTimersByTimeAsync(60);
  const second = clockRequests(socket).at(-1)!;
  await vi.advanceTimersByTimeAsync(20);
  answerClockRequest(socket, second, Date.now() - 10);
  await vi.advanceTimersByTimeAsync(0);
}

describe('PRO work-scoped clock selection', () => {
  it.each([true, false])(
    'bounds an early non-cohort COMMIT independently of pending READY (clock reply %s)',
    async (respond) => {
      const socket = await openBridge(proRoomServerBridge);
      const fixture = createSnapshotPlaybackController();
      try {
        const prepared = prepareControllerTransition(fixture);
        await vi.advanceTimersByTimeAsync(0);
        fixture.controller.acceptCommit({
          type: 'pro-playback-commit',
          transitionId: prepared.transitionId,
          serverTimeMs: 1000,
          executeAtMs: 1700,
          playback: { ...prepared.target, updatedAtMs: 1700 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.commit).not.toHaveBeenCalled();
        if (respond) {
          const request = clockRequests(socket).at(-1)!;
          await vi.advanceTimersByTimeAsync(20);
          answerClockRequest(socket, request, 1010);
          await vi.advanceTimersByTimeAsync(0);
          expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ scheduleDelayMs: 680, positionSeconds: 0 }),
          );
        } else {
          await vi.advanceTimersByTimeAsync(700);
          expect(fixture.commit).not.toHaveBeenCalled();
          expect(fixture.invalidate).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(250);
          expect(fixture.heartbeat).toHaveBeenCalledTimes(1);
        }
        expect(fixture.reportReady).not.toHaveBeenCalled();
      } finally {
        fixture.controller.resetPlaylistRuntime();
        fixture.unregister();
      }
    },
  );

  it.each(['file', 'youtube'] as const)(
    'keeps READY clock through a background refresh for %s',
    async (mediaKind) => {
      const socket = await openBridge(proRoomServerBridge);
      const fixture = createSnapshotPlaybackController();
      const { controller, current, commit, reportReady } = fixture;
      if (mediaKind === 'file') {
        current.playlist[0]!.source = {
          kind: 'pro-r2',
          assetId: 'asset_00000001',
          version: 1,
          byteLength: 1000,
          mime: 'audio/mpeg',
        };
        current.playback.youtubeSubIndex = null;
        current.playback.youtubeVideoId = null;
        fixture.prepare.mockImplementation(async (request) => ({
          status: 'ready',
          authority: request.authority,
          queueItemId: request.queueItemId,
          mediaKind: 'file',
          durationSeconds: 180,
          youtubeSubIndex: null,
          youtubeVideoId: null,
        }));
      }
      try {
        await vi.advanceTimersByTimeAsync(29_000);
        const prepared = prepareControllerTransition(fixture);
        await vi.advanceTimersByTimeAsync(0);
        await answerSymmetricReady(socket);
        expect(reportReady).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
        await vi.advanceTimersByTimeAsync(900);
        const refresh = clockRequests(socket).at(-1)!;
        await vi.advanceTimersByTimeAsync(200);
        // Uplink 10ms / downlink 190ms would replace the estimate by -90ms.
        answerClockRequest(socket, refresh, 31_010);
        controller.acceptCommit({
          type: 'pro-playback-commit',
          transitionId: prepared.transitionId,
          serverTimeMs: 31_200,
          executeAtMs: 31_900,
          playback: { ...prepared.target, updatedAtMs: 31_900 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(commit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ scheduleDelayMs: 700, positionSeconds: 0 }),
        );
      } finally {
        controller.resetPlaylistRuntime();
        fixture.unregister();
      }
    },
  );

  it.each([null, `transition_${'q'.repeat(22)}`])(
    'waits for the first clock in a snapshotless COMMIT (%s)',
    async (transitionId) => {
      vi.setSystemTime(10_180);
      const socket = await openBridge(proRoomServerBridge);
      const fixture = createSnapshotPlaybackController();
      try {
        fixture.controller.acceptCommit({
          type: 'pro-playback-commit',
          transitionId,
          serverTimeMs: 10_000,
          executeAtMs: 10_700,
          playback: { ...fixture.current.playback, positionSeconds: 0 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.commit).not.toHaveBeenCalled();
        const request = clockRequests(socket).at(-1)!;
        await vi.advanceTimersByTimeAsync(20);
        answerClockRequest(socket, request, 10_190);
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            scheduleDelayMs: 500,
            positionSeconds: 0,
            timingMode: 'scheduled-control',
          }),
        );
      } finally {
        fixture.controller.resetPlaylistRuntime();
        fixture.unregister();
      }
    },
  );

  it('uses the signed deadline to catch up after clock acquisition passes execution', async () => {
    vi.setSystemTime(10_680);
    const socket = await openBridge(proRoomServerBridge);
    const fixture = createSnapshotPlaybackController();
    try {
      fixture.controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: null,
        serverTimeMs: 10_000,
        executeAtMs: 10_700,
        playback: { ...fixture.current.playback, positionSeconds: 12 },
      });
      await vi.advanceTimersByTimeAsync(0);
      const request = clockRequests(socket).at(-1)!;
      await vi.advanceTimersByTimeAsync(60);
      answerClockRequest(socket, request, 10_710);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ scheduleDelayMs: 0, positionSeconds: 12.04 }),
      );
    } finally {
      fixture.controller.resetPlaylistRuntime();
      fixture.unregister();
    }
  });

  it('never plays without a clock and requests one bounded recovery heartbeat', async () => {
    await openBridge(proRoomServerBridge);
    const fixture = createSnapshotPlaybackController();
    try {
      const event = {
        type: 'pro-playback-commit' as const,
        transitionId: null,
        serverTimeMs: 1000,
        executeAtMs: 1700,
        playback: fixture.current.playback,
      };
      fixture.controller.acceptCommit(event);
      await vi.advanceTimersByTimeAsync(700);
      expect(fixture.commit).not.toHaveBeenCalled();
      expect(fixture.invalidate).toHaveBeenCalledTimes(1);
      expect(fixture.prepare).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(fixture.heartbeat).toHaveBeenCalledTimes(1);
      fixture.controller.acceptCommit(event);
      await vi.advanceTimersByTimeAsync(1500);
      expect(fixture.commit).not.toHaveBeenCalled();
      expect(fixture.heartbeat).toHaveBeenCalledTimes(1);
    } finally {
      fixture.controller.resetPlaylistRuntime();
      fixture.unregister();
    }
  });

  it.each(['paused', 'idle'] as const)(
    'does not make a newer %s wait for an obsolete clock',
    async (state) => {
      const socket = await openBridge(proRoomServerBridge);
      const fixture = createSnapshotPlaybackController();
      try {
        fixture.controller.acceptCommit({
          type: 'pro-playback-commit',
          transitionId: null,
          serverTimeMs: 1000,
          executeAtMs: 1700,
          playback: fixture.current.playback,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.commit).not.toHaveBeenCalled();
        fixture.controller.acceptCommit({
          type: 'pro-playback-commit',
          transitionId: null,
          serverTimeMs: 1000,
          executeAtMs: 1000,
          playback: {
            ...fixture.current.playback,
            revision: 2,
            state,
            queueItemId: state === 'idle' ? null : fixture.current.playback.queueItemId,
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ state, committedPlaybackRevision: 2 }),
        );
        const request = clockRequests(socket).at(-1)!;
        await vi.advanceTimersByTimeAsync(20);
        answerClockRequest(socket, request, 1010);
        await vi.advanceTimersByTimeAsync(1000);
        expect(fixture.commit).toHaveBeenCalledTimes(1);
      } finally {
        fixture.controller.resetPlaylistRuntime();
        fixture.unregister();
      }
    },
  );

  it('aborts a pending clock on room teardown and ignores its late response', async () => {
    const socket = await openBridge(proRoomServerBridge);
    const fixture = createSnapshotPlaybackController();
    try {
      fixture.controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: null,
        serverTimeMs: 1000,
        executeAtMs: 1700,
        playback: fixture.current.playback,
      });
      await vi.advanceTimersByTimeAsync(0);
      const request = clockRequests(socket).at(-1)!;
      fixture.controller.resetPlaylistRuntime();
      await vi.advanceTimersByTimeAsync(20);
      answerClockRequest(socket, request, 1010);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.commit).not.toHaveBeenCalled();
      expect(fixture.heartbeat).not.toHaveBeenCalled();
    } finally {
      fixture.controller.resetPlaylistRuntime();
      fixture.unregister();
    }
  });

  it('reacquires a clock after reconnect rather than using the old READY lease', async () => {
    const socket = await openBridge(proRoomServerBridge);
    const fixture = createSnapshotPlaybackController();
    try {
      const prepared = prepareControllerTransition(fixture);
      await vi.advanceTimersByTimeAsync(0);
      await answerSymmetricReady(socket);
      const opening = proRoomServerBridge.reconfigure(snapshot(), {
        ...access(),
        ticketSequence: 2,
      });
      const replacement = FakeWebSocket.instances.at(-1)!;
      replacement.dispatch('open');
      await opening;
      const execution = Date.now() + 700;
      fixture.controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: prepared.transitionId,
        serverTimeMs: Date.now(),
        executeAtMs: execution,
        playback: { ...prepared.target, updatedAtMs: execution },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.commit).not.toHaveBeenCalled();
      const request = clockRequests(replacement).at(-1)!;
      await vi.advanceTimersByTimeAsync(20);
      answerClockRequest(replacement, request, Date.now() - 10);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ scheduleDelayMs: 680, positionSeconds: 0 }),
      );
    } finally {
      fixture.controller.resetPlaylistRuntime();
      fixture.unregister();
    }
  });
});
