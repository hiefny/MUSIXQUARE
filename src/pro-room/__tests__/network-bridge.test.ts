/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import {
  getProStartObservations,
  resetProStartObservations,
} from '../../diagnostics/pro-start-observations.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
} from '../contracts.ts';
import {
  ServerProRoomNetworkBridge,
  onProRoomRealtimeConnection,
  onProRoomRealtimeEvent,
  proRoomServerBridge,
} from '../network-bridge.ts';
import { ProRoomSessionController, type ProRoomSessionApiForTests } from '../session-controller.ts';
import { sendProRoomRealtime } from '../realtime-sender.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackMediaEndpoint,
} from '../playback-authority-hooks.ts';

type SocketListener = (event: { data?: unknown; reason?: string }) => void;

const PRO_SIGNALING_WEBSOCKET_PROTOCOL = 'mxqr.pro-signaling.v1';
const PRO_SIGNALING_TICKET_PROTOCOL_PREFIX = 'mxqr.ticket.';

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

function chatControlSnapshot(
  revision: number,
  eventId: string,
  frozen = false,
): Record<string, unknown> {
  return {
    type: 'pro-realtime',
    version: 1,
    roomCode: ROOM_CODE,
    coordinatorEpoch: 2,
    eventId,
    channel: 'chat-control-snapshot',
    payload: {
      revision,
      frozen,
      filterEnabled: false,
      slowmodeSeconds: 0,
      muted: false,
    },
    sender: {
      participantId: 'server',
      presenceIncarnationId: 'server-chat-state',
      displayName: 'MUSIXQUARE',
    },
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

it.each(['same epoch', 'advanced epoch'] as const)(
  'keeps the latest socket when an older concurrent ticket response arrives late in the %s',
  async (epochCase) => {
    const bridge = new ServerProRoomNetworkBridge();
    const renamedSnapshot = snapshot();
    renamedSnapshot.revision += 1;
    renamedSnapshot.presence.revision += 1;
    renamedSnapshot.viewer!.displayName = 'Updated owner';
    renamedSnapshot.presence.participants[0]!.displayName = 'Updated owner';
    renamedSnapshot.administrators[0]!.displayName = 'Updated owner';
    const latestSnapshot = snapshot();
    const latestAccess = { ...access(), ticketSequence: 3 };
    if (epochCase === 'advanced epoch') {
      // A completed nickname edit triggers account attachment and a new ticket.
      // Owner PIN rotation can then advance the room while that response waits.
      Object.assign(latestSnapshot, structuredClone(renamedSnapshot));
      latestSnapshot.revision += 1;
      latestSnapshot.presence.revision += 1;
      latestSnapshot.presence.coordinatorEpoch += 1;
      latestSnapshot.playback.coordinatorEpoch += 1;
      latestAccess.coordinatorEpoch += 1;
      latestAccess.ticketSequence = 1;
    }
    let releaseOlderTicket!: (value: ProRoomSignalingAccess) => void;
    const api = {
      createSession: vi.fn(async () => snapshot()),
      attachCurrentAccount: vi.fn(async () => renamedSnapshot),
      heartbeat: vi.fn(async () => latestSnapshot),
      createSignalingTicket: vi
        .fn()
        .mockResolvedValueOnce(access())
        .mockImplementationOnce(
          () =>
            new Promise<ProRoomSignalingAccess>((resolve) => {
              releaseOlderTicket = resolve;
            }),
        )
        .mockResolvedValueOnce(latestAccess),
      clearPresenceIdentity: vi.fn(),
      closeSessionFenced: vi.fn(async () => {}),
    } as unknown as ProRoomSessionApiForTests;
    const controller = new ProRoomSessionController(api, bridge, {
      snapshot: () => {},
      authority: () => {},
      cleared: () => {},
    });
    const joined = controller.join({ code: ROOM_CODE, pin: '12345678' });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]!.dispatch('open');
    await joined;
    if (epochCase === 'same epoch') {
      FakeWebSocket.instances[0]!.dispatch('close');
      controller.invalidateControlChannel();
    }
    const olderRefresh = (
      epochCase === 'advanced epoch'
        ? controller.attachCurrentAccount()
        : controller.refreshSignaling()
    ).catch((error) => error);
    await vi.waitFor(() => expect(releaseOlderTicket).toBeTypeOf('function'));
    const heartbeat = controller.heartbeat();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const latest = FakeWebSocket.instances[1]!;
    latest.dispatch('open');
    await heartbeat;
    releaseOlderTicket({ ...access(), ticketSequence: 2 });
    await vi.advanceTimersByTimeAsync(0);
    // A real server rejects sequence 2 after accepting sequence 3. Deliver that
    // native handshake failure if the old response incorrectly opened a socket.
    if (FakeWebSocket.instances.length > 2) FakeWebSocket.instances[2]!.dispatch('error');
    await olderRefresh;
    expect(latest.closeCount).toBe(0);
    expect(bridge.connected).toBe(true);
    bridge.disconnect();
  },
);

it.each(['connecting', 'open'] as const)(
  'rejects a duplicate ticket before replacing its %s socket',
  async (phase) => {
    const bridge = new ServerProRoomNetworkBridge();
    const opening = bridge.connect(snapshot(), access());
    const socket = FakeWebSocket.instances[0]!;
    if (phase === 'open') {
      socket.dispatch('open');
      await opening;
    }
    await expect(bridge.reconfigure(snapshot(), access())).rejects.toThrow(
      'PRO_ROOM_SIGNALING_TICKET_SUPERSEDED',
    );
    expect(socket.closeCount).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    if (phase === 'connecting') {
      socket.dispatch('open');
      await opening;
    }
    expect(bridge.connected).toBe(true);
    bridge.disconnect();
  },
);

it('reconnects with a new ticket and permits a sequence reset in a new room epoch', async () => {
  const bridge = new ServerProRoomNetworkBridge();
  const oldSocket = await openBridge(bridge);
  oldSocket.dispatch('close');
  const nextAccess = { ...access(), ticketSequence: 2 };
  expect(bridge.refreshCredentials(snapshot(), nextAccess)).toBe(false);
  const reconnecting = bridge.reconfigure(snapshot(), nextAccess);
  const reconnectedSocket = FakeWebSocket.instances[1]!;
  reconnectedSocket.dispatch('open');
  await reconnecting;
  expect(bridge.connected).toBe(true);
  const nextSnapshot = snapshot();
  nextSnapshot.presence.coordinatorEpoch = 3;
  nextSnapshot.playback.coordinatorEpoch = 3;
  const nextEpochAccess = { ...access(), coordinatorEpoch: 3 };
  expect(bridge.refreshCredentials(nextSnapshot, nextEpochAccess)).toBe(false);
  const replacing = bridge.reconfigure(nextSnapshot, nextEpochAccess);
  FakeWebSocket.instances[2]!.dispatch('open');
  await replacing;
  expect(reconnectedSocket.closeCount).toBe(1);
  expect(bridge.connected).toBe(true);
  bridge.disconnect();
});

it('allows the same ticket to retry after a failed opening without an active socket', async () => {
  const bridge = new ServerProRoomNetworkBridge();
  const opening = bridge.connect(snapshot(), access());
  FakeWebSocket.instances[0]!.dispatch('error');
  await expect(opening).rejects.toThrow('PRO_SIGNALING_START_FAILED');
  const retrying = bridge.reconfigure(snapshot(), access());
  FakeWebSocket.instances[1]!.dispatch('open');
  await retrying;
  expect(bridge.connected).toBe(true);
  bridge.disconnect();
});

it.each(['new room', 'new presence'] as const)(
  'allows a fresh ticket identity for a %s',
  async (replacement) => {
    const bridge = new ServerProRoomNetworkBridge();
    const oldSocket = await openBridge(bridge);
    const nextSnapshot = snapshot();
    const nextAccess = access();
    if (replacement === 'new room') {
      nextSnapshot.roomCode = '000002';
      nextSnapshot.presence.coordinatorEpoch = 1;
      nextSnapshot.playback.coordinatorEpoch = 1;
      nextAccess.coordinatorEpoch = 1;
    } else {
      nextSnapshot.viewer!.presenceIncarnationId = 'presence_0000000002';
      nextAccess.presenceIncarnationId = nextSnapshot.viewer!.presenceIncarnationId;
    }
    const connecting = bridge.reconfigure(nextSnapshot, nextAccess);
    const nextSocket = FakeWebSocket.instances[1]!;
    nextSocket.dispatch('open');
    await connecting;
    expect(oldSocket.closeCount).toBe(1);
    expect(bridge.connected).toBe(true);
    bridge.disconnect();
  },
);

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
  const unregister = registerProPlaybackMediaEndpoint({ prepare, commit });
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
    runHeartbeat: vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: reportReady,
    executePlaybackCommand: execute,
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  });
  return { controller, current, prepare, commit, execute, reportReady, unregister };
}

beforeEach(() => {
  resetState();
  resetProStartObservations();
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetState();
});

describe('coordinator-free PRO server channel', () => {
  it('binds the chat port before connection callbacks and keeps the current socket after a stale close', async () => {
    const bridge = proRoomServerBridge;
    bridge.disconnect();
    expect(sendProRoomRealtime('chat', { text: 'not connected' })).toBe(false);
    const onConnected = vi.fn((connected: boolean) => {
      if (connected)
        expect(sendProRoomRealtime('chat', { text: 'first connected frame' })).toBe(true);
    });
    const unsubscribe = onProRoomRealtimeConnection(onConnected);
    try {
      const first = await openBridge(bridge);
      expect(onConnected).toHaveBeenCalledWith(true);
      expect(first.sent.map((frame) => JSON.parse(frame))).toContainEqual(
        expect.objectContaining({
          type: 'pro-realtime',
          version: 1,
          channel: 'chat',
          payload: { text: 'first connected frame' },
        }),
      );
      const opening = bridge.reconfigure(snapshot(), { ...access(), ticketSequence: 2 });
      expect(sendProRoomRealtime('chat', { text: 'connecting' })).toBe(false);
      const replacement = FakeWebSocket.instances.at(-1)!;
      replacement.dispatch('open');
      await opening;
      const firstCount = first.sent.length;
      first.dispatch('close');
      expect(sendProRoomRealtime('chat', { text: 'current socket' })).toBe(true);
      expect(first.sent).toHaveLength(firstCount);
      expect(JSON.parse(replacement.sent.at(-1)!)).toMatchObject({
        channel: 'chat',
        payload: { text: 'current socket' },
      });
      replacement.dispatch('close');
      expect(sendProRoomRealtime('chat', { text: 'closed' })).toBe(false);
    } finally {
      unsubscribe();
      bridge.disconnect();
    }
    expect(sendProRoomRealtime('chat', { text: 'left' })).toBe(false);
  });

  it('opens the direct room WebSocket without constructing a peer topology', async () => {
    const rtcConstructor = vi.fn(() => {
      throw new Error('RTCPeerConnection must not be constructed');
    });
    vi.stubGlobal('RTCPeerConnection', rtcConstructor);
    const bridge = new ServerProRoomNetworkBridge();

    const socket = await openBridge(bridge);
    const url = new URL(socket.url);

    expect(url.origin).toBe('wss://signal.example.test');
    expect(url.pathname).toBe('/api/pro-rooms/000001/ws');
    expect(url.search).toBe('');
    expect(socket.protocols).toEqual([
      PRO_SIGNALING_WEBSOCKET_PROTOCOL,
      `${PRO_SIGNALING_TICKET_PROTOCOL_PREFIX}${access().ticket}`,
    ]);
    expect(rtcConstructor).not.toHaveBeenCalled();
    expect(getState('network.hostConn')).toBeNull();
    expect(getState('network.connectedPeers')).toEqual([]);
    expect(getState('network.myId')).toBe(PARTICIPANT_ID);
    expect(getState('network.isOperator')).toBe(true);

    bridge.disconnect();
  });

  it('requires a new socket when the authenticated sender display name changes', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const originalSocket = await openBridge(bridge);
    const renamed: ProRoomSnapshot = {
      ...snapshot(),
      revision: 5,
      presence: {
        ...snapshot().presence,
        revision: 4,
        participants: snapshot().presence.participants.map((participant) => ({
          ...participant,
          displayName: 'Renamed member',
        })),
      },
      viewer: {
        ...snapshot().viewer!,
        displayName: 'Renamed member',
      },
    };
    const replacementAccess: ProRoomSignalingAccess = {
      ...access(),
      ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
      ticketSequence: 2,
    };

    expect(bridge.refreshCredentials(renamed, replacementAccess)).toBe(false);
    expect(originalSocket.readyState).toBe(FakeWebSocket.OPEN);
    expect(getState('network.myDeviceLabel')).toBe('Equal member');

    const replacing = bridge.reconfigure(renamed, replacementAccess);
    const replacementSocket = FakeWebSocket.instances.at(-1);
    if (!replacementSocket || replacementSocket === originalSocket) {
      throw new Error('replacement fake socket was not created');
    }
    replacementSocket.dispatch('open');
    await replacing;

    expect(originalSocket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(originalSocket.closeReason).toBe('PRO_SOCKET_REPLACED');
    expect(getState('network.myDeviceLabel')).toBe('Renamed member');
    bridge.disconnect();
  });

  it('rejects late frames from a superseded socket generation', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const received: unknown[] = [];
    const unsubscribe = onProRoomRealtimeEvent((frame) => received.push(frame));

    try {
      const originalSocket = await openBridge(bridge);
      const replacementAccess: ProRoomSignalingAccess = {
        ...access(),
        ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
        ticketSequence: 2,
      };
      const replacing = bridge.reconfigure(snapshot(), replacementAccess);
      const replacementSocket = FakeWebSocket.instances.at(-1);
      if (!replacementSocket || replacementSocket === originalSocket) {
        throw new Error('replacement fake socket was not created');
      }
      replacementSocket.dispatch('open');
      await replacing;

      const currentSnapshot = chatControlSnapshot(8, 'control-current');
      const lateServerEvent = {
        type: 'pro-server-event',
        version: 1,
        roomCode: ROOM_CODE,
        coordinatorEpoch: 2,
        event: { type: 'pro-room-invalidated', source: 'superseded-socket' },
      };
      const lateHigherRevision = chatControlSnapshot(9, 'control-late', true);

      replacementSocket.dispatch('message', JSON.stringify(currentSnapshot));
      originalSocket.dispatch('message', JSON.stringify(lateServerEvent));
      originalSocket.dispatch('message', JSON.stringify(lateHigherRevision));

      expect(received).toEqual([currentSnapshot]);
    } finally {
      unsubscribe();
      bridge.disconnect();
    }
  });

  it('accepts only increasing chat-control revisions within each socket generation', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const received: unknown[] = [];
    const unsubscribe = onProRoomRealtimeEvent((frame) => received.push(frame));

    try {
      const originalSocket = await openBridge(bridge);
      const revision8 = chatControlSnapshot(8, 'control-revision-8');
      const staleRevision7 = chatControlSnapshot(7, 'control-revision-7', true);
      const conflictingRevision8 = chatControlSnapshot(8, 'control-revision-8-conflict', true);
      const revision9 = chatControlSnapshot(9, 'control-revision-9', true);

      for (const frame of [revision8, staleRevision7, conflictingRevision8, revision9]) {
        originalSocket.dispatch('message', JSON.stringify(frame));
      }
      expect(received).toEqual([revision8, revision9]);

      const replacementAccess: ProRoomSignalingAccess = {
        ...access(),
        ticket: `${'e'.repeat(32)}.${'F'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
        ticketSequence: 2,
      };
      const replacing = bridge.reconfigure(snapshot(), replacementAccess);
      const replacementSocket = FakeWebSocket.instances.at(-1);
      if (!replacementSocket || replacementSocket === originalSocket) {
        throw new Error('replacement fake socket was not created');
      }
      replacementSocket.dispatch('open');
      await replacing;

      const replacementHydration = chatControlSnapshot(9, 'control-replacement-hydration', true);
      replacementSocket.dispatch('message', JSON.stringify(replacementHydration));

      expect(received).toEqual([revision8, revision9, replacementHydration]);
    } finally {
      unsubscribe();
      bridge.disconnect();
    }
  });

  it('closes and releases a socket whose initial connection reports an error', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const connected: boolean[] = [];
    const unsubscribe = onProRoomRealtimeConnection((value) => connected.push(value));
    const opening = bridge.connect(snapshot(), access());
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error('fake socket was not created');

    socket.dispatch('error');

    await expect(opening).rejects.toThrow('PRO_SIGNALING_START_FAILED');
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(socket.closeReason).toBe('PRO_CONNECT_FAILED');
    expect(bridge.connected).toBe(false);
    expect(getState('network.isConnecting')).toBe(false);
    expect(connected).toEqual([false]);
    unsubscribe();
  });

  it('keeps a timed-out attempt closed when a delayed open event arrives', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const opening = bridge.connect(snapshot(), access());
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error('fake socket was not created');

    const rejected = expect(opening).rejects.toThrow('PRO_ROOM_CONNECT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(socket.closeCount).toBe(1);
    expect(getState('network.isConnecting')).toBe(false);

    socket.dispatch('open');

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(socket.closeCount).toBe(2);
    expect(socket.closeReason).toBe('PRO_CONNECT_FAILED');
    expect(bridge.connected).toBe(false);
  });

  it('does not let a superseded timeout tear down the replacement generation', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const firstOpening = bridge.connect(snapshot(), access());
    const firstSocket = FakeWebSocket.instances.at(-1);
    if (!firstSocket) throw new Error('first fake socket was not created');
    const firstRejected = expect(firstOpening).rejects.toThrow('PRO_ROOM_CONNECT_TIMEOUT');

    const replacementAccess: ProRoomSignalingAccess = {
      ...access(),
      ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
      ticketSequence: 2,
    };
    const replacing = bridge.reconfigure(snapshot(), replacementAccess);
    const replacementSocket = FakeWebSocket.instances.at(-1);
    if (!replacementSocket || replacementSocket === firstSocket) {
      throw new Error('replacement fake socket was not created');
    }
    replacementSocket.dispatch('open');
    await replacing;

    await vi.advanceTimersByTimeAsync(15_000);
    await firstRejected;

    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(replacementSocket.readyState).toBe(FakeWebSocket.OPEN);
    expect(bridge.connected).toBe(true);
    expect(getState('network.isConnecting')).toBe(false);
    bridge.disconnect();
  });

  it.each([1_000, 9_000_000])(
    'waits for a real clock response before restoring a running snapshot at local time %i',
    async (localTimeMs) => {
      vi.setSystemTime(localTimeMs);
      resetProPlaybackAuthorityHooks();
      const bridge = proRoomServerBridge;
      const socket = await openBridge(bridge);
      const { controller, current, commit, execute, reportReady, unregister } =
        createSnapshotPlaybackController();
      try {
        // OPEN only schedules clock probes. A ready local endpoint can beat the
        // first response, so the snapshot has no trustworthy current server time.
        const restoring = controller.restorePersistedPlayback(current);
        await vi.advanceTimersByTimeAsync(100);
        expect(bridge.clockCalibrated).toBe(false);
        expect.soft(commit).not.toHaveBeenCalled();

        for (const request of clockRequests(socket)) answerClockRequest(socket, request, 12_000);
        await vi.advanceTimersByTimeAsync(220);
        await restoring;
        expect(commit).toHaveBeenCalledOnce();
        // The running YouTube checkpoint is already past its instant, so the
        // restore settles at a planned participant-local instant three seconds
        // ahead (25s now -> 28s then) instead of seeking during release.
        expect(commit.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            committedPlaybackRevision: 1,
            positionSeconds: expect.closeTo(28, 0),
            scheduleDelayMs: expect.closeTo(3_000, -2),
          }),
        );
        // Late joining is participant-local; it must not rendezvous the room.
        expect(execute).not.toHaveBeenCalled();
        expect(reportReady).not.toHaveBeenCalled();
      } finally {
        controller.resetPlaylistRuntime();
        unregister();
        bridge.disconnect();
      }
    },
  );

  async function calibratedSnapshotRestore() {
    vi.setSystemTime(1_000);
    resetProPlaybackAuthorityHooks();
    const bridge = proRoomServerBridge;
    const socket = await openBridge(bridge);
    const harness = createSnapshotPlaybackController();
    await vi.advanceTimersByTimeAsync(100);
    for (const request of clockRequests(socket)) answerClockRequest(socket, request, 12_000);
    expect(bridge.clockCalibrated).toBe(true);
    return { bridge, ...harness };
  }

  function readyFor(request: Parameters<ProPlaybackMediaEndpoint['prepare']>[0]) {
    return {
      status: 'ready' as const,
      authority: request.authority,
      queueItemId: request.queueItemId,
      mediaKind: 'youtube' as const,
      durationSeconds: 180,
      youtubeSubIndex: 0,
      youtubeVideoId: 'dQw4w9WgXcQ',
    };
  }

  it('re-arms an overrun YouTube restore at a fresh planned instant instead of seeking', async () => {
    const { bridge, controller, current, prepare, commit, unregister } =
      await calibratedSnapshotRestore();
    try {
      // A cold first player load outlasts the whole planned lead.
      prepare.mockImplementationOnce(async (request) => {
        vi.setSystemTime(Date.now() + 5_000);
        return readyFor(request);
      });
      await controller.restorePersistedPlayback(current);
      await vi.advanceTimersByTimeAsync(0);

      expect(prepare).toHaveBeenCalledTimes(2);
      expect(commit).toHaveBeenCalledOnce();
      const [first, second] = prepare.mock.calls.map(([request]) => request);
      const committed = commit.mock.calls[0]![0];
      // The re-arm settles at its own plan, so release only presses play.
      expect(committed.positionSeconds).toBe(second!.positionSeconds);
      expect(committed.positionSeconds).toBeGreaterThan(first!.positionSeconds + 4.9);
      expect(committed.scheduleDelayMs).toBeCloseTo(3_000, -2);
    } finally {
      controller.resetPlaylistRuntime();
      unregister();
      bridge.disconnect();
    }
  });

  it('genuinely retries a failed YouTube restore preparation before the next heartbeat', async () => {
    const { bridge, controller, current, prepare, commit, unregister } =
      await calibratedSnapshotRestore();
    try {
      prepare.mockImplementationOnce(async (request) => ({
        status: 'failed',
        authority: request.authority,
        queueItemId: request.queueItemId,
        reason: 'timeout',
      }));
      await controller.restorePersistedPlayback(current);
      await vi.advanceTimersByTimeAsync(0);

      // The catch-up shares the snapshot authority; it must not merely observe
      // the settled failure and leave the participant silent for 15 seconds.
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(commit).toHaveBeenCalledOnce();
      expect(commit.mock.calls[0]![0].positionSeconds).toBe(
        prepare.mock.calls[1]![0].positionSeconds,
      );
    } finally {
      controller.resetPlaylistRuntime();
      unregister();
      bridge.disconnect();
    }
  });

  it.each([
    ['released', 'ready'],
    ['failed twice', 'failed'],
  ] as const)(
    'shows the loading state while a YouTube restore prepares until it is %s',
    async (_label, outcome) => {
      const { bridge, controller, current, prepare, unregister } =
        await calibratedSnapshotRestore();
      const loading: boolean[] = [];
      const stopListening = bus.on('pro-playback:transition-loading', (value) => {
        loading.push(value);
      });
      const duringPrepare: boolean[][] = [];
      prepare.mockImplementation(async (request) => {
        duringPrepare.push([...loading]);
        return outcome === 'ready'
          ? readyFor(request)
          : {
              status: 'failed' as const,
              authority: request.authority,
              queueItemId: request.queueItemId,
              reason: 'timeout' as const,
            };
      });
      try {
        await controller.restorePersistedPlayback(current);
        await vi.advanceTimersByTimeAsync(0);

        // The silent iframe shows a spinner, never a pressable room control,
        // and the spinner ends so a failed endpoint can be rejoined by Play.
        expect(duringPrepare.length).toBeGreaterThan(0);
        for (const seen of duringPrepare) expect(seen).toEqual([true]);
        expect(loading).toEqual([true, false]);
      } finally {
        stopListening();
        controller.resetPlaylistRuntime();
        unregister();
        bridge.disconnect();
      }
    },
  );

  it('restores an exact paused snapshot immediately while the device clock is behind', async () => {
    vi.setSystemTime(1_000);
    resetProPlaybackAuthorityHooks();
    const bridge = proRoomServerBridge;
    await openBridge(bridge);
    const { controller, current, commit, unregister } = createSnapshotPlaybackController('paused');
    try {
      await controller.restorePersistedPlayback(current);
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.clockCalibrated).toBe(false);
      expect(commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ state: 'paused', positionSeconds: 23, scheduleDelayMs: 0 }),
      );
    } finally {
      controller.resetPlaylistRuntime();
      unregister();
      bridge.disconnect();
    }
  });

  it('waits for a clock when an unchanged command overtakes the first snapshot clock read', async () => {
    vi.setSystemTime(9_000_000);
    resetProPlaybackAuthorityHooks();
    const bridge = proRoomServerBridge;
    const socket = await openBridge(bridge);
    const { controller, current, commit, execute, unregister } = createSnapshotPlaybackController();
    // The surrounding recovery cases model a listener. This case also sends a
    // human play command, so its participant needs delegated playback control.
    setState('room.context', {
      ...getState('room.context'),
      capabilities: ['playback.control'],
    });
    try {
      const restoring = controller.restorePersistedPlayback(current);
      await vi.advanceTimersByTimeAsync(100);
      execute.mockResolvedValue({
        schemaVersion: 1,
        roomCode: ROOM_CODE,
        status: 'unchanged',
        transition: null,
        playback: current.playback,
        serverTimeMs: 12_000,
      });
      await controller.enqueueIntent({
        kind: 'play',
        roomId: ROOM_CODE,
        roomEpoch: current.presence.coordinatorEpoch,
        queueItemId: current.playback.queueItemId,
        positionSeconds: 23,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledOnce();
      expect(bridge.clockCalibrated).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      for (const request of clockRequests(socket)) {
        const sentAt = (request.payload as { clientSentAtMs: number }).clientSentAtMs;
        answerClockRequest(socket, request, 12_000 - (Date.now() - sentAt) / 2);
      }
      await vi.advanceTimersByTimeAsync(0);
      // The overdue running YouTube checkpoint joins at a planned instant
      // three seconds ahead rather than seeking during an immediate release.
      expect(commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ positionSeconds: 28, scheduleDelayMs: 3_000 }),
      );
      await vi.advanceTimersByTimeAsync(220);
      await restoring;
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      controller.resetPlaylistRuntime();
      unregister();
      bridge.disconnect();
    }
  });

  it('keeps a paused snapshot immediate when clock calibration finishes during media preparation', async () => {
    vi.setSystemTime(9_000_000);
    resetProPlaybackAuthorityHooks();
    const bridge = proRoomServerBridge;
    const socket = await openBridge(bridge);
    const { controller, current, prepare, commit, unregister } =
      createSnapshotPlaybackController('paused');
    let finishPreparation!: () => void;
    prepare.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finishPreparation = () =>
            resolve({
              status: 'ready',
              authority: request.authority,
              queueItemId: request.queueItemId,
              mediaKind: 'youtube',
              durationSeconds: 180,
              youtubeSubIndex: 0,
              youtubeVideoId: 'dQw4w9WgXcQ',
            });
        }),
    );
    try {
      await controller.restorePersistedPlayback(current);
      await vi.advanceTimersByTimeAsync(100);
      expect(prepare).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(bridge.clockCalibrated).toBe(false);
      for (const request of clockRequests(socket)) answerClockRequest(socket, request, 12_000);
      expect(bridge.clockCalibrated).toBe(true);
      finishPreparation();
      await vi.advanceTimersByTimeAsync(0);
      expect(commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ state: 'paused', positionSeconds: 23, scheduleDelayMs: 0 }),
      );
    } finally {
      controller.resetPlaylistRuntime();
      unregister();
      bridge.disconnect();
    }
  });

  it('lets a newer live COMMIT overtake a snapshot waiting for its first clock response', async () => {
    vi.setSystemTime(9_000_000);
    resetProPlaybackAuthorityHooks();
    const bridge = proRoomServerBridge;
    const socket = await openBridge(bridge);
    const { controller, current, commit, unregister } = createSnapshotPlaybackController();
    try {
      const restoring = controller.restorePersistedPlayback(current);
      await vi.advanceTimersByTimeAsync(100);
      controller.acceptCommit({
        type: 'pro-playback-commit',
        transitionId: null,
        serverTimeMs: 12_000,
        executeAtMs: 12_000,
        playback: { ...current.playback, revision: 2, positionSeconds: 60, updatedAtMs: 12_000 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.clockCalibrated).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      for (const request of clockRequests(socket)) {
        const sentAt = (request.payload as { clientSentAtMs: number }).clientSentAtMs;
        answerClockRequest(socket, request, 12_000 - (Date.now() - sentAt) / 2);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ committedPlaybackRevision: 2, positionSeconds: 60 }),
      );
      await vi.advanceTimersByTimeAsync(220);
      await restoring;
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      controller.resetPlaylistRuntime();
      unregister();
      bridge.disconnect();
    }
  });

  it('settles an uncalibrated snapshot wait and restores on a later calibrated heartbeat', async () => {
    vi.setSystemTime(9_000_000);
    resetProPlaybackAuthorityHooks();
    const bridge = proRoomServerBridge;
    const socket = await openBridge(bridge);
    const { controller, current, commit, unregister } = createSnapshotPlaybackController();
    try {
      const restoring = controller.restorePersistedPlayback(current);
      await vi.advanceTimersByTimeAsync(1_000);
      await restoring;
      expect(commit).not.toHaveBeenCalled();
      const request = clockRequests(socket).at(-1);
      expect(request).toBeDefined();
      answerClockRequest(socket, request!, 12_000);
      expect(bridge.clockCalibrated).toBe(true);
      await controller.restorePersistedPlayback(current);
      await vi.advanceTimersByTimeAsync(0);
      expect(commit).toHaveBeenCalledOnce();
      // Restored at the planned participant-local instant three seconds ahead.
      expect(commit.mock.calls[0]?.[0].positionSeconds).toBeCloseTo(28, 0);
      expect(commit.mock.calls[0]?.[0].scheduleDelayMs).toBeCloseTo(3_000, -2);
    } finally {
      controller.resetPlaylistRuntime();
      unregister();
      bridge.disconnect();
    }
  });

  it.each(['youtube', 'pro-r2'] as const)(
    'reconciles a playing %s checkpoint over a 334ms clock route',
    async (sourceKind) => {
      resetProPlaybackAuthorityHooks();
      const bridge = proRoomServerBridge;
      const socket = await openBridge(bridge);
      const { controller, current, prepare, commit, unregister } =
        createSnapshotPlaybackController();
      if (sourceKind === 'pro-r2') {
        current.playlist[0]!.source = {
          kind: 'pro-r2',
          assetId: 'asset_00000001',
          version: 1,
          byteLength: 11_000_000,
          mime: 'audio/mpeg',
        };
        current.playback.youtubeSubIndex = null;
        current.playback.youtubeVideoId = null;
        prepare.mockImplementation(async (request) => ({
          status: 'ready',
          authority: request.authority,
          queueItemId: request.queueItemId,
          mediaKind: 'file',
          durationSeconds: 240,
          youtubeSubIndex: null,
          youtubeVideoId: null,
        }));
      }
      try {
        await vi.advanceTimersByTimeAsync(0);
        const reconcile = controller.requestReconciliation();
        await vi.advanceTimersByTimeAsync(0);
        const request = clockRequests(socket).at(-1)!;
        await vi.advanceTimersByTimeAsync(334);
        answerClockRequest(socket, request, 11_167);
        await expect(reconcile).resolves.toBe(true);
        expect(prepare).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledOnce();
        expect(commit.mock.calls[0]?.[0].queueItemId).toBe(current.currentQueueItemId);
      } finally {
        controller.resetPlaylistRuntime();
        unregister();
        bridge.disconnect();
      }
    },
  );

  it('calibrates server time from the best round-trip clock sample', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);

    await vi.advanceTimersByTimeAsync(0);
    const request = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((frame) => frame.channel === 'clock');
    expect(request).toMatchObject({
      type: 'pro-realtime',
      version: 1,
      channel: 'clock',
      payload: { requestId: 1, clientSentAtMs: 1_000 },
    });

    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'pro-clock',
        version: 1,
        requestId: 1,
        clientSentAtMs: 1_000,
        serverTimeMs: 1_500,
      }),
    );

    expect(bridge.clockCalibrated).toBe(true);
    expect(bridge.serverNowMs).toBe(1_500);
    expect(bridge.clockDiagnostics).toEqual({
      connected: true,
      calibrated: true,
      bestOffsetMs: 500,
      bestRttMs: 0,
      readyCalibrationAgeMs: null,
    });
    bridge.disconnect();
  });

  it('waits for two fresh samples and commits the minimum-RTT candidate before READY', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    await vi.advanceTimersByTimeAsync(0);

    const calibrated = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 2_000,
      fallbackTimeoutMs: 750,
    });
    let settled = false;
    const observedCalibration = calibrated.then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const first = clockRequests(socket).at(-1);
    if (!first) throw new Error('first ready clock request was not sent');
    await vi.advanceTimersByTimeAsync(60);
    // RTT 60ms, offset +400ms.
    answerClockRequest(socket, first, 1_430);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    const second = clockRequests(socket).at(-1);
    const firstPayload = first.payload as Record<string, unknown>;
    const secondPayload = second?.payload as Record<string, unknown> | undefined;
    if (!second || secondPayload?.requestId === firstPayload.requestId) {
      throw new Error('second ready clock request was not sent');
    }
    await vi.advanceTimersByTimeAsync(10);
    // RTT 10ms, offset +505ms. This lower-RTT sample must win the round.
    answerClockRequest(socket, second, 1_590);

    await expect(observedCalibration).resolves.toBe(true);
    expect(bridge.serverNowMs).toBe(1_595);
    bridge.disconnect();
  });

  it('uses the best available sample after the bounded 220ms decision window', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    await vi.advanceTimersByTimeAsync(0);

    const calibrated = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 2_000,
      fallbackTimeoutMs: 750,
    });
    let settled = false;
    const observedCalibration = calibrated.then((result) => {
      settled = true;
      return result;
    });
    const first = clockRequests(socket).at(-1);
    if (!first) throw new Error('ready clock request was not sent');

    await vi.advanceTimersByTimeAsync(40);
    answerClockRequest(socket, first, 1_500);
    await vi.advanceTimersByTimeAsync(179);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(observedCalibration).resolves.toBe(true);
    expect(bridge.serverNowMs).toBe(1_700);
    bridge.disconnect();
  });

  it.each([221, 334, 900])(
    'accepts a fresh response with %ims RTT within the caller budget after the selection window',
    async (rtt) => {
      const bridge = new ServerProRoomNetworkBridge();
      const socket = await openBridge(bridge);
      await vi.advanceTimersByTimeAsync(0);
      const initial = clockRequests(socket).at(-1)!;
      await vi.advanceTimersByTimeAsync(334);
      answerClockRequest(socket, initial, 1_984);
      expect(bridge.clockDiagnostics).toMatchObject({
        connected: true,
        calibrated: true,
        bestRttMs: 334,
        bestOffsetMs: 817,
        readyCalibrationAgeMs: null,
      });
      await vi.advanceTimersByTimeAsync(2_000);

      const startedAt = Date.now();
      const settled = vi.fn();
      const calibrated = bridge
        .waitForFreshClockCalibration({
          serverDeadlineAtMs: Number.MAX_SAFE_INTEGER,
          fallbackTimeoutMs: 1_000,
        })
        .then(settled);
      const request = clockRequests(socket).at(-1)!;
      await vi.advanceTimersByTimeAsync(220);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(rtt - 220);
      answerClockRequest(socket, request, Math.round(startedAt + rtt / 2 + 817));
      await calibrated;
      expect(settled).toHaveBeenCalledExactlyOnceWith(true);
      expect(bridge.clockDiagnostics).toMatchObject({
        connected: true,
        calibrated: true,
        bestRttMs: rtt,
        readyCalibrationAgeMs: 0,
      });

      const requests = clockRequests(socket).length;
      await expect(
        bridge.waitForFreshClockCalibration({
          serverDeadlineAtMs: Number.MAX_SAFE_INTEGER,
          fallbackTimeoutMs: 1_000,
        }),
      ).resolves.toBe(true);
      expect(clockRequests(socket)).toHaveLength(requests);
      bridge.disconnect();
    },
  );

  it('fails at the caller budget without a response, ignores expired replies, and allows a retry', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    await vi.advanceTimersByTimeAsync(0);
    const settled = vi.fn();
    const calibrated = bridge
      .waitForFreshClockCalibration({
        serverDeadlineAtMs: 10_000,
        fallbackTimeoutMs: 1_000,
      })
      .then(settled);
    const expired = clockRequests(socket).at(-1)!;
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await calibrated;
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
    answerClockRequest(socket, expired, 2_500);
    expect(bridge.clockCalibrated).toBe(false);

    const retry = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 10_000,
      fallbackTimeoutMs: 1_000,
    });
    const request = clockRequests(socket).at(-1)!;
    await vi.advanceTimersByTimeAsync(334);
    answerClockRequest(socket, request, 2_167);
    await expect(retry).resolves.toBe(true);
    bridge.disconnect();
  });

  it('does not cancel a longer clock wait when a short PREPARE budget expires', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    await vi.advanceTimersByTimeAsync(0);
    const short = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 1_200,
      fallbackTimeoutMs: 200,
    });
    const request = clockRequests(socket).at(-1)!;
    const settled = vi.fn();
    const longer = bridge
      .waitForFreshClockCalibration({
        serverDeadlineAtMs: 5_000,
        fallbackTimeoutMs: 1_000,
      })
      .then(settled);
    await vi.advanceTimersByTimeAsync(220);
    await expect(short).resolves.toBe(false);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(114);
    answerClockRequest(socket, request, 1_167);
    await longer;
    expect(settled).toHaveBeenCalledExactlyOnceWith(true);
    bridge.disconnect();
  });

  it('retains a delayed round for another waiter when one caller aborts', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    await vi.advanceTimersByTimeAsync(0);
    const abort = new AbortController();
    const cancelled = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 5_000,
      fallbackTimeoutMs: 1_000,
      signal: abort.signal,
    });
    const request = clockRequests(socket).at(-1)!;
    const surviving = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 5_000,
      fallbackTimeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(250);
    abort.abort();
    await expect(cancelled).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(84);
    answerClockRequest(socket, request, 1_167);
    await expect(surviving).resolves.toBe(true);
    bridge.disconnect();
  });

  it('checks each server deadline even when the delayed sample fits both local budgets', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    await vi.advanceTimersByTimeAsync(0);
    const tooLate = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 2_000,
      fallbackTimeoutMs: 1_000,
    });
    const request = clockRequests(socket).at(-1)!;
    const inTime = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 3_000,
      fallbackTimeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(334);
    answerClockRequest(socket, request, 1_984);
    expect(bridge.serverNowMs).toBe(2_151);
    await expect(tooLate).resolves.toBe(false);
    await expect(inTime).resolves.toBe(true);
    bridge.disconnect();
  });

  it.each(['abort', 'disconnect'] as const)(
    'ignores a delayed response after %s closes the last waiter',
    async (ending) => {
      const bridge = new ServerProRoomNetworkBridge();
      const socket = await openBridge(bridge);
      await vi.advanceTimersByTimeAsync(0);
      const abort = new AbortController();
      const calibrated = bridge.waitForFreshClockCalibration({
        serverDeadlineAtMs: 5_000,
        fallbackTimeoutMs: 1_000,
        signal: abort.signal,
      });
      const request = clockRequests(socket).at(-1)!;
      await vi.advanceTimersByTimeAsync(250);
      if (ending === 'abort') abort.abort();
      else bridge.disconnect();
      await expect(calibrated).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(84);
      answerClockRequest(socket, request, 1_167);
      expect(bridge.clockCalibrated).toBe(false);
      expect(bridge.clockDiagnostics.readyCalibrationAgeMs).toBeNull();
      bridge.disconnect();
    },
  );

  it('finishes a short PREPARE budget with the best sample already available', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    await vi.advanceTimersByTimeAsync(0);

    const calibrated = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 1_600,
      fallbackTimeoutMs: 50,
    });
    const first = clockRequests(socket).at(-1);
    if (!first) throw new Error('ready clock request was not sent');

    await vi.advanceTimersByTimeAsync(30);
    answerClockRequest(socket, first, 1_530);
    await vi.advanceTimersByTimeAsync(20);

    await expect(calibrated).resolves.toBe(true);
    expect(bridge.serverNowMs).toBe(1_565);
    bridge.disconnect();
  });

  it('aborts a ready calibration round and ignores its late clock response', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    await vi.advanceTimersByTimeAsync(0);
    const abort = new AbortController();

    const calibrated = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 2_000,
      fallbackTimeoutMs: 750,
      signal: abort.signal,
    });
    const first = clockRequests(socket).at(-1);
    if (!first) throw new Error('ready clock request was not sent');

    abort.abort();
    await expect(calibrated).resolves.toBe(false);
    answerClockRequest(socket, first, 1_500);
    expect(bridge.clockCalibrated).toBe(false);
    bridge.disconnect();
  });

  it('settles a pending clock wait as false when its socket generation closes', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    await openBridge(bridge);
    const calibrated = bridge.waitForFreshClockCalibration({
      serverDeadlineAtMs: 2_000,
      fallbackTimeoutMs: 750,
    });

    bridge.disconnect();

    await expect(calibrated).resolves.toBe(false);
  });

  it('accepts only room-fenced server and realtime envelopes', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const received: unknown[] = [];
    const unsubscribe = onProRoomRealtimeEvent((frame) => received.push(frame));
    const socket = await openBridge(bridge);

    socket.dispatch('message', '{not json');
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'pro-server-event',
        version: 1,
        roomCode: ROOM_CODE,
        coordinatorEpoch: 99,
        event: { type: 'presence-snapshot' },
      }),
    );
    socket.dispatch(
      'message',
      JSON.stringify({
        type: 'pro-realtime',
        version: 1,
        roomCode: ROOM_CODE,
        coordinatorEpoch: 2,
        eventId: 'event-invalid-sender',
        channel: 'chat',
        payload: { kind: 'message', text: 'ignored' },
        sender: null,
      }),
    );

    const serverEvent = {
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM_CODE,
      coordinatorEpoch: 2,
      event: { type: 'presence-snapshot' },
    };
    const realtimeEvent = {
      type: 'pro-realtime',
      version: 1,
      roomCode: ROOM_CODE,
      coordinatorEpoch: 2,
      eventId: 'event_1234567890123456',
      channel: 'chat',
      payload: { kind: 'message', text: 'hello' },
      sender: {
        participantId: 'participant_00002',
        presenceIncarnationId: 'presence_0000000002',
        displayName: 'Friend',
      },
    };
    const controlSnapshot = {
      type: 'pro-realtime',
      version: 1,
      roomCode: ROOM_CODE,
      coordinatorEpoch: 2,
      eventId: 'control_snapshot_123456',
      channel: 'chat-control-snapshot',
      payload: {
        revision: 4,
        frozen: false,
        filterEnabled: true,
        slowmodeSeconds: 5,
        muted: false,
      },
      sender: {
        participantId: 'server',
        presenceIncarnationId: 'server-chat-state',
        displayName: 'MUSIXQUARE',
      },
    };
    const forgedControlSnapshot = {
      ...controlSnapshot,
      eventId: 'control_snapshot_forged1',
      sender: realtimeEvent.sender,
    };
    socket.dispatch('message', JSON.stringify(serverEvent));
    socket.dispatch('message', JSON.stringify(realtimeEvent));
    socket.dispatch('message', JSON.stringify(controlSnapshot));
    socket.dispatch('message', JSON.stringify(forgedControlSnapshot));

    // The server-only channel is structurally accepted by rolling clients but
    // ignored by their chat receiver. Current clients additionally authenticate
    // its reserved sender and exact full-state payload before applying it.
    expect(received).toEqual([serverEvent, realtimeEvent, controlSnapshot]);
    unsubscribe();
    bridge.disconnect();
  });

  it('clears compatibility state without reporting an intentional leave as a failure', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const connected: boolean[] = [];
    const unsubscribe = onProRoomRealtimeConnection((value) => connected.push(value));
    const socket = await openBridge(bridge);

    bridge.disconnect();

    expect(connected).toEqual([true]);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(socket.closeCode).toBe(1000);
    expect(socket.closeReason).toBe('PRO_SESSION_LEFT');
    expect(getState('network.appRole')).toBe('idle');
    expect(getState('network.myId')).toBeNull();
    expect(getState('network.hostConn')).toBeNull();
    expect(getState('network.connectedPeers')).toEqual([]);
    expect(getState('network.isOperator')).toBe(false);
    unsubscribe();
  });
});

describe('leased PRO clock estimates', () => {
  async function readyRound(bridge: ServerProRoomNetworkBridge, socket: FakeWebSocket) {
    const pending = bridge.acquireClock({ fresh: true, timeoutMs: 1_000 });
    const first = clockRequests(socket).at(-1)!;
    await vi.advanceTimersByTimeAsync(20);
    answerClockRequest(socket, first, Date.now() - 10);
    await vi.advanceTimersByTimeAsync(60);
    const second = clockRequests(socket).at(-1)!;
    await vi.advanceTimersByTimeAsync(20);
    answerClockRequest(socket, second, Date.now() - 10);
    const selected = await pending;
    expect(selected).not.toBeNull();
    return selected!;
  }

  it.each([
    { candidateOffsetMs: 100, disjointIntervals: false },
    { candidateOffsetMs: 101, disjointIntervals: true },
  ])(
    'records both RTT bounds and the margin for candidate offset $candidateOffsetMs',
    async (trace) => {
      const bridge = new ServerProRoomNetworkBridge();
      const socket = await openBridge(bridge);
      try {
        await vi.advanceTimersByTimeAsync(2_000);
        const pending = bridge.acquireClock({ fresh: true, timeoutMs: 1_000 });
        const first = clockRequests(socket).at(-1)!;
        await vi.advanceTimersByTimeAsync(80);
        const second = clockRequests(socket).at(-1)!;
        await vi.advanceTimersByTimeAsync(80);
        answerClockRequest(socket, first, 3_020);
        await vi.advanceTimersByTimeAsync(60);
        const leased = await pending;
        await vi.advanceTimersByTimeAsync(10);
        answerClockRequest(socket, second, 3_155 + trace.candidateOffsetMs);
        expect(bridge.captureClockSnapshot()).toBe(leased);
        expect(
          getProStartObservations()
            .filter((record) => record.kind === 'clock-selection')
            .at(-1)?.detail,
        ).toMatchObject({
          confirmed: true,
          selectedOffsetMs: -60,
          selectedRttMs: 160,
          bestCandidateOffsetMs: trace.candidateOffsetMs,
          bestCandidateRttMs: 150,
          comparisonToleranceMs: 5,
          excessDistanceMs: trace.candidateOffsetMs + 60 - 75,
          disjointIntervals: trace.disjointIntervals,
        });
        expect(bridge.isClockSnapshotCurrent(leased!)).toBe(true);
      } finally {
        bridge.disconnect();
      }
    },
  );

  it.each([50, 51])(
    'records a %ims wall/monotonic difference without invalidating a lease',
    async (differenceMs) => {
      const bridge = new ServerProRoomNetworkBridge();
      const socket = await openBridge(bridge);
      const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100);
      try {
        await vi.advanceTimersByTimeAsync(0);
        const first = clockRequests(socket).at(-1)!;
        await vi.advanceTimersByTimeAsync(20);
        monotonic.mockReturnValue(120);
        vi.setSystemTime(Date.now() + differenceMs);
        answerClockRequest(socket, first, 1_010);
        const leased = bridge.captureClockSnapshot();
        expect(leased).not.toBeNull();
        expect(
          getProStartObservations()
            .filter((record) => record.kind === 'clock-sample')
            .at(-1)?.detail,
        ).toMatchObject({
          wallElapsedMs: 20 + differenceMs,
          monotonicElapsedMs: 20,
          continuityToleranceMs: 50,
          clockContinuitySuspect: differenceMs > 50,
        });
        expect(bridge.isClockSnapshotCurrent(leased!)).toBe(true);
      } finally {
        monotonic.mockRestore();
        bridge.disconnect();
      }
    },
  );

  it('keeps a READY decision immutable across a worse 30-second refresh and the five-second reuse boundary', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    try {
      await vi.advanceTimersByTimeAsync(29_000);
      const leased = await readyRound(bridge, socket);
      expect(Object.isFrozen(leased)).toBe(true);
      expect(leased.offsetMs).toBe(0);
      await vi.advanceTimersByTimeAsync(900);
      const refresh = clockRequests(socket).at(-1)!;
      await vi.advanceTimersByTimeAsync(200);
      answerClockRequest(socket, refresh, 31_010);
      expect(bridge.captureClockSnapshot()).toBe(leased);
      expect(bridge.clockDiagnostics).toMatchObject({ bestOffsetMs: 0, bestRttMs: 20 });
      const requests = clockRequests(socket).length;
      await vi.advanceTimersByTimeAsync(3_900);
      expect(Date.now()).toBe(35_100);
      await expect(bridge.acquireClock({ fresh: true, timeoutMs: 1_000 })).resolves.toBe(leased);
      expect(clockRequests(socket)).toHaveLength(requests);
      await vi.advanceTimersByTimeAsync(1);
      const abort = new AbortController();
      const renewed = bridge.acquireClock({ fresh: true, timeoutMs: 1_000, signal: abort.signal });
      expect(clockRequests(socket)).toHaveLength(requests + 1);
      expect(bridge.isClockSnapshotCurrent(leased)).toBe(true);
      expect(leased.offsetMs).toBe(0);
      abort.abort();
      await expect(renewed).resolves.toBeNull();
    } finally {
      bridge.disconnect();
    }
  });

  it('retains a successful round late reply as a future candidate without replacing the READY lease', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      const pending = bridge.acquireClock({ fresh: true, timeoutMs: 1_000 });
      const first = clockRequests(socket).at(-1)!;
      await vi.advanceTimersByTimeAsync(80);
      const second = clockRequests(socket).at(-1)!;
      await vi.advanceTimersByTimeAsync(80);
      answerClockRequest(socket, first, 3_020);
      await vi.advanceTimersByTimeAsync(60);
      const leased = await pending;
      expect(leased).toMatchObject({ offsetMs: -60, rttMs: 160, source: 'ready' });
      await vi.advanceTimersByTimeAsync(10);
      answerClockRequest(socket, second, 3_155);
      expect(bridge.captureClockSnapshot()).toBe(leased);
      await vi.advanceTimersByTimeAsync(4_991);
      expect(bridge.captureClockSnapshot()).toMatchObject({
        offsetMs: 0,
        rttMs: 150,
        source: 'ready-late',
      });
      expect(leased!.offsetMs).toBe(-60);
      expect(bridge.isClockSnapshotCurrent(leased!)).toBe(true);
    } finally {
      bridge.disconnect();
    }
  });

  it('ignores successful-round replies arriving after the bounded late-response lifetime', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      const pending = bridge.acquireClock({ fresh: true, timeoutMs: 1_000 });
      const first = clockRequests(socket).at(-1)!;
      await vi.advanceTimersByTimeAsync(180);
      const late = clockRequests(socket).at(-1)!;
      answerClockRequest(socket, first, 3_090);
      await vi.advanceTimersByTimeAsync(40);
      const leased = await pending;
      await vi.advanceTimersByTimeAsync(5_001);
      answerClockRequest(socket, late, 90_000);
      expect(bridge.captureClockSnapshot()).toBe(leased);
    } finally {
      bridge.disconnect();
    }
  });

  it('acquires the first existing connection reply without a duplicate request or READY selection delay', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    try {
      const pending = bridge.acquireClock({ timeoutMs: 700 });
      expect(clockRequests(socket)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(0);
      const first = clockRequests(socket).at(-1)!;
      expect(clockRequests(socket)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20);
      answerClockRequest(socket, first, 1_010);
      const leased = await pending;
      expect(leased).toMatchObject({ offsetMs: 0, rttMs: 20, source: 'connection' });
      expect(clockRequests(socket)).toHaveLength(1);
      expect(bridge.clockDiagnostics.readyCalibrationAgeMs).toBeNull();
      await expect(bridge.acquireClock({ timeoutMs: 0 })).resolves.toBe(leased);
    } finally {
      bridge.disconnect();
    }
  });

  it.each(['abort', 'timeout', 'disconnect', 'socket-close'] as const)(
    'settles passive acquisition on %s without leaving a calibration round',
    async (ending) => {
      const bridge = new ServerProRoomNetworkBridge();
      const socket = await openBridge(bridge);
      try {
        const abort = new AbortController();
        const pending = bridge.acquireClock({ timeoutMs: 50, signal: abort.signal });
        await vi.advanceTimersByTimeAsync(0);
        expect(clockRequests(socket)).toHaveLength(1);
        if (ending === 'abort') abort.abort();
        else if (ending === 'timeout') await vi.advanceTimersByTimeAsync(50);
        else if (ending === 'socket-close') socket.dispatch('close');
        else bridge.disconnect();
        await expect(pending).resolves.toBeNull();
        expect(bridge.clockDiagnostics.readyCalibrationAgeMs).toBeNull();
      } finally {
        bridge.disconnect();
      }
    },
  );

  it('keeps another passive waiter alive when one caller aborts', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    try {
      const abort = new AbortController();
      const cancelled = bridge.acquireClock({ timeoutMs: 700, signal: abort.signal });
      const surviving = bridge.acquireClock({ timeoutMs: 700 });
      await vi.advanceTimersByTimeAsync(0);
      const first = clockRequests(socket).at(-1)!;
      abort.abort();
      await expect(cancelled).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(20);
      answerClockRequest(socket, first, 1_010);
      await expect(surviving).resolves.toMatchObject({ offsetMs: 0 });
    } finally {
      bridge.disconnect();
    }
  });

  it.each(['leave', 'replacement'] as const)(
    'preserves an issued lease across unexpected socket close until %s, while blocking new acquisition',
    async (ending) => {
      const bridge = new ServerProRoomNetworkBridge();
      const socket = await openBridge(bridge);
      try {
        await vi.advanceTimersByTimeAsync(0);
        answerClockRequest(socket, clockRequests(socket).at(-1)!, 1_000);
        const leased = bridge.captureClockSnapshot()!;
        expect(leased).toMatchObject({ offsetMs: 0 });
        await vi.advanceTimersByTimeAsync(100);
        socket.dispatch('close');
        expect(bridge.connected).toBe(false);
        expect(bridge.isClockSnapshotCurrent(leased)).toBe(true);
        expect(bridge.captureClockSnapshot()).toBeNull();
        await expect(bridge.acquireClock({ timeoutMs: 700 })).resolves.toBeNull();
        await expect(bridge.acquireClock({ timeoutMs: 700, fresh: true })).resolves.toBeNull();
        await vi.advanceTimersByTimeAsync(700);
        expect(bridge.isClockSnapshotCurrent(leased)).toBe(true);
        if (ending === 'leave') {
          bridge.disconnect();
        } else {
          const opening = bridge.reconfigure(snapshot(), { ...access(), ticketSequence: 2 });
          expect(bridge.isClockSnapshotCurrent(leased)).toBe(false);
          FakeWebSocket.instances.at(-1)!.dispatch('open');
          await opening;
        }
        expect(bridge.isClockSnapshotCurrent(leased)).toBe(false);
      } finally {
        bridge.disconnect();
      }
    },
  );

  it('invalidates leases and passive waits on socket replacement and rejects foreign-bridge leases', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    try {
      await vi.advanceTimersByTimeAsync(0);
      answerClockRequest(socket, clockRequests(socket).at(-1)!, 1_000);
      const leased = bridge.captureClockSnapshot()!;
      const foreign = new ServerProRoomNetworkBridge();
      await openBridge(foreign);
      expect(foreign.isClockSnapshotCurrent(leased)).toBe(false);
      foreign.disconnect();
      const opening = bridge.reconfigure(snapshot(), { ...access(), ticketSequence: 2 });
      const nextSocket = FakeWebSocket.instances.at(-1)!;
      nextSocket.dispatch('open');
      await opening;
      expect(bridge.isClockSnapshotCurrent(leased)).toBe(false);
      const pending = bridge.acquireClock({ timeoutMs: 700 });
      const replacing = bridge.reconfigure(snapshot(), { ...access(), ticketSequence: 3 });
      await expect(pending).resolves.toBeNull();
      FakeWebSocket.instances.at(-1)!.dispatch('open');
      await replacing;
      expect(bridge.captureClockSnapshot()).toBeNull();
    } finally {
      bridge.disconnect();
    }
  });

  it('bounds candidate retention while a previously issued lease remains current', async () => {
    const bridge = new ServerProRoomNetworkBridge();
    const socket = await openBridge(bridge);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      let firstLease;
      for (let round = 0; round < 9; round += 1) {
        const pending = bridge.acquireClock({ fresh: true, timeoutMs: 1_000 });
        const first = clockRequests(socket).at(-1)!;
        const firstRtt = round === 0 ? 2 : 20;
        await vi.advanceTimersByTimeAsync(firstRtt);
        answerClockRequest(socket, first, Date.now() - firstRtt / 2);
        await vi.advanceTimersByTimeAsync(80 - firstRtt);
        const second = clockRequests(socket).at(-1)!;
        await vi.advanceTimersByTimeAsync(20);
        answerClockRequest(socket, second, Date.now() - 10);
        const lease = await pending;
        if (round === 0) firstLease = lease;
        await vi.advanceTimersByTimeAsync(5_001);
      }
      // The original 2ms sample is less than 60s old, but has left the 16-item cache.
      expect(Date.now() - firstLease!.sampledAtMs).toBeLessThan(60_000);
      expect(bridge.captureClockSnapshot()?.rttMs).toBe(20);
      expect(bridge.isClockSnapshotCurrent(firstLease!)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(bridge.captureClockSnapshot()).toBeNull();
      expect(bridge.isClockSnapshotCurrent(firstLease!)).toBe(true);
    } finally {
      bridge.disconnect();
    }
  });
});
