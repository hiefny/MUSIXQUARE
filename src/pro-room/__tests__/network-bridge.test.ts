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

type SocketListener = (event: { data?: unknown }) => void;

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

  constructor(readonly url: string) {
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
    for (const listener of this.listeners.get(event) ?? []) listener({ data });
  }
}

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_00001';
const INCARNATION_ID = 'presence_0000000001';

function snapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 4,
    playlistRevision: 0,
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
          displayName: 'Equal member',
          role: 'controller',
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
      presenceIncarnationId: INCARNATION_ID,
      displayName: 'Equal member',
      role: 'controller',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
      ],
      coordinatorEligible: false,
    },
  };
}

function access(): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
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
    expect(url.searchParams.get('ticket')).toBe(access().ticket);
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
      ticket: `v1.${'c'.repeat(32)}.${'D'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
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
      ticket: `v1.${'c'.repeat(32)}.${'D'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
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
    void calibrated.then(() => {
      settled = true;
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

    await expect(calibrated).resolves.toBe(true);
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
    void calibrated.then(() => {
      settled = true;
    });
    const first = clockRequests(socket).at(-1);
    if (!first) throw new Error('ready clock request was not sent');

    await vi.advanceTimersByTimeAsync(40);
    answerClockRequest(socket, first, 1_500);
    await vi.advanceTimersByTimeAsync(179);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(calibrated).resolves.toBe(true);
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
    socket.dispatch('message', JSON.stringify(serverEvent));
    socket.dispatch('message', JSON.stringify(realtimeEvent));

    expect(received).toEqual([serverEvent, realtimeEvent]);
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
