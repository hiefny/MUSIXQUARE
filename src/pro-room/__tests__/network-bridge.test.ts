/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState } from '../../core/state.ts';
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
} from '../network-bridge.ts';
import { ProRoomSessionController, type ProRoomSessionApiForTests } from '../session-controller.ts';

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

beforeEach(() => {
  resetState();
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
