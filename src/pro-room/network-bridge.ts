import { log } from '../core/log.ts';
import { batchSetState, getState } from '../core/state.ts';
import { getRuntimeTransportConfig } from '../network/transport/config.ts';
import type { ProRoomSignalingAccess } from './api.ts';
import type { ProRoomPlaybackPrepareEvent } from './api.ts';
import type { ProRoomSnapshot } from './contracts.ts';
import type { ProRoomTransportBridge } from './session-controller.ts';

const SOCKET_OPEN_TIMEOUT_MS = 15_000;
const MAX_SERVER_FRAME_BYTES = 256 * 1024;
const CLOCK_REFRESH_MS = 30_000;
const CLOCK_BURST_DELAYS_MS = [0, 120, 300, 700, 1_500] as const;
const CLOCK_READY_FRESHNESS_MS = 5_000;
const CLOCK_WAIT_MAX_MS = 10_000;

type JsonRecord = Record<string, unknown>;

export interface ProServerEventEnvelope {
  type: 'pro-server-event';
  version: 1;
  roomCode: string;
  /** Kept as a wire name while it acts solely as the room-incarnation fence. */
  coordinatorEpoch: number;
  event: JsonRecord & { type: string };
}

export interface ProRealtimeRelayEnvelope {
  type: 'pro-realtime';
  version: 1;
  roomCode: string;
  coordinatorEpoch: number;
  eventId: string;
  channel: string;
  payload: JsonRecord;
  sender: {
    participantId: string;
    presenceIncarnationId: string;
    memberId?: string;
    displayName?: string;
  };
}

type RealtimeListener = (frame: ProServerEventEnvelope | ProRealtimeRelayEnvelope) => void;
type ConnectionListener = (connected: boolean) => void;

interface ClockCalibrationWaiter {
  generation: number;
  serverDeadlineAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (calibrated: boolean) => void;
}

const realtimeListeners = new Set<RealtimeListener>();
const connectionListeners = new Set<ConnectionListener>();

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function randomEventId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function signalingSocketUrl(roomCode: string, ticket: string): string {
  const configured = getRuntimeTransportConfig().signalingUrl;
  if (!configured) throw new Error('PRO_SIGNALING_URL_MISSING');
  const url = new URL(configured);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  const standardBase = url.pathname.replace(/\/+$/, '');
  const proBase = standardBase.endsWith('/api/rooms')
    ? `${standardBase.slice(0, -'/api/rooms'.length)}/api/pro-rooms`
    : standardBase.endsWith('/api/pro-rooms')
      ? standardBase
      : `${standardBase}/api/pro-rooms`;
  url.pathname = `${proBase}/${encodeURIComponent(roomCode)}/ws`;
  url.search = '';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

function parseServerFrame(
  value: unknown,
): ProServerEventEnvelope | ProRealtimeRelayEnvelope | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (value.type === 'pro-server-event') {
    if (
      typeof value.roomCode !== 'string' ||
      !/^\d{6}$/.test(value.roomCode) ||
      !isSafePositiveInteger(value.coordinatorEpoch) ||
      !isRecord(value.event) ||
      typeof value.event.type !== 'string'
    ) {
      return null;
    }
    return value as unknown as ProServerEventEnvelope;
  }
  if (value.type === 'pro-realtime') {
    if (
      typeof value.roomCode !== 'string' ||
      !/^\d{6}$/.test(value.roomCode) ||
      !isSafePositiveInteger(value.coordinatorEpoch) ||
      typeof value.eventId !== 'string' ||
      typeof value.channel !== 'string' ||
      !isRecord(value.payload) ||
      !isRecord(value.sender) ||
      typeof value.sender.participantId !== 'string' ||
      typeof value.sender.presenceIncarnationId !== 'string' ||
      (value.sender.memberId !== undefined &&
        (typeof value.sender.memberId !== 'string' ||
          !/^(?:member|owner)_[A-Za-z0-9_-]{16,128}$/.test(value.sender.memberId)))
    ) {
      return null;
    }
    return value as unknown as ProRealtimeRelayEnvelope;
  }
  return null;
}

export function onProRoomRealtimeEvent(listener: RealtimeListener): () => void {
  realtimeListeners.add(listener);
  return () => realtimeListeners.delete(listener);
}

export function onProRoomRealtimeConnection(listener: ConnectionListener): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

/**
 * Equal-participant PRO control channel.
 *
 * It intentionally exposes no DataConnection and opens no RTCPeerConnection:
 * every browser talks only to the hibernatable room WebSocket, while the PRO
 * Durable Object remains the sole state manager.
 */
export class ServerProRoomNetworkBridge implements ProRoomTransportBridge {
  #socket: WebSocket | null = null;
  #access: ProRoomSignalingAccess | null = null;
  #snapshot: ProRoomSnapshot | null = null;
  #generation = 0;
  #intentionalClose = false;
  #clockRequestSequence = 0;
  #clockPending = new Map<number, number>();
  #clockBestRttMs = Number.POSITIVE_INFINITY;
  #clockOffsetMs = 0;
  #clockCalibrated = false;
  #clockCalibratedAtMs = 0;
  #clockWaiters = new Set<ClockCalibrationWaiter>();
  #pendingPlaybackTransition: ProRoomPlaybackPrepareEvent | null = null;
  #timers = new Set<ReturnType<typeof setTimeout>>();

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  get serverNowMs(): number {
    return Date.now() + this.#clockOffsetMs;
  }

  get clockCalibrated(): boolean {
    // General frame scheduling may continue using the best sample from this
    // socket generation. PREPARE readiness applies the stricter freshness
    // policy through waitForFreshClockCalibration().
    return this.#clockCalibrated;
  }

  /**
   * Wait for a connection-generation-fenced, recent server clock sample.
   * `fallbackTimeoutMs` is derived from PREPARE's server-side deadline span,
   * so an uncalibrated local wall clock can never create an unbounded wait.
   */
  waitForFreshClockCalibration(options: {
    serverDeadlineAtMs: number;
    fallbackTimeoutMs: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const { serverDeadlineAtMs, signal } = options;
    if (
      !this.connected ||
      signal?.aborted ||
      !Number.isFinite(serverDeadlineAtMs) ||
      !Number.isFinite(options.fallbackTimeoutMs)
    ) {
      return Promise.resolve(false);
    }
    if (this.#hasFreshClockCalibration()) {
      return Promise.resolve(this.serverNowMs <= serverDeadlineAtMs);
    }

    const generation = this.#generation;
    const timeoutMs = Math.max(0, Math.min(CLOCK_WAIT_MAX_MS, options.fallbackTimeoutMs));
    if (timeoutMs === 0) return Promise.resolve(false);

    // The previous burst's minimum RTT must not prevent a newer (slightly
    // slower) but deadline-relevant sample from refreshing the clock.
    this.#clockBestRttMs = Number.POSITIVE_INFINITY;
    this.#requestClockSample();
    return new Promise<boolean>((resolve) => {
      const settle = (calibrated: boolean) => {
        if (!this.#clockWaiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        this.#timers.delete(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        resolve(calibrated);
      };
      const timer = globalThis.setTimeout(() => settle(false), timeoutMs);
      const waiter: ClockCalibrationWaiter = {
        generation,
        serverDeadlineAtMs,
        timer,
        signal,
        resolve,
      };
      waiter.onAbort = () => settle(false);
      this.#clockWaiters.add(waiter);
      this.#timers.add(timer);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });

      // A synchronous fake/test socket may have answered the request before
      // the waiter was registered. Re-check after registration.
      if (this.#hasFreshClockCalibration()) this.#settleFreshClockWaiters();
    });
  }

  consumePendingPlaybackTransition(): ProRoomPlaybackPrepareEvent | null {
    const pending = this.#pendingPlaybackTransition;
    this.#pendingPlaybackTransition = null;
    return pending;
  }

  async connect(
    snapshot: ProRoomSnapshot,
    access: ProRoomSignalingAccess,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#open(snapshot, access, signal);
  }

  async reconfigure(
    snapshot: ProRoomSnapshot,
    access: ProRoomSignalingAccess,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#open(snapshot, access, signal);
  }

  refreshCredentials(snapshot: ProRoomSnapshot, access: ProRoomSignalingAccess): boolean {
    const activeDisplayName = this.#snapshot?.viewer?.displayName;
    if (
      !this.#matchesActiveIdentity(snapshot, access) ||
      snapshot.viewer?.displayName !== activeDisplayName ||
      (this.#access !== null && access.ticketSequence <= this.#access.ticketSequence)
    ) {
      return false;
    }
    this.#snapshot = snapshot;
    this.#access = access;
    this.#pendingPlaybackTransition = access.pendingPlaybackTransition;
    return this.connected;
  }

  disconnect(): void {
    ++this.#generation;
    this.#intentionalClose = true;
    this.#clearTimers();
    this.#settleClockWaiters(false);
    this.#clockPending.clear();
    const socket = this.#socket;
    this.#socket = null;
    this.#access = null;
    this.#snapshot = null;
    this.#pendingPlaybackTransition = null;
    try {
      socket?.close(1000, 'PRO_SESSION_LEFT');
    } catch {
      /* best effort */
    }
    // An explicit leave already tears down the lifecycle synchronously. Do not
    // report it as a transport failure: the runtime's recovery listener would
    // otherwise race a heartbeat against the departing presence.
    batchSetState({
      'network.appRole': 'idle',
      'network.myId': null,
      'network.hostConn': null,
      'network.connectedPeers': [],
      'network.isOperator': false,
      'network.isConnecting': false,
      'network.connectionType': 'unknown',
    });
  }

  send(channel: 'chat' | 'presence' | 'control-ready', payload: JsonRecord): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(
        JSON.stringify({
          type: 'pro-realtime',
          version: 1,
          eventId: randomEventId(),
          channel,
          payload,
        }),
      );
      return true;
    } catch (error) {
      log.warn('[PRO] Realtime frame send failed', error);
      return false;
    }
  }

  #matchesActiveIdentity(snapshot: ProRoomSnapshot, access: ProRoomSignalingAccess): boolean {
    const viewer = snapshot.viewer;
    const activeViewer = this.#snapshot?.viewer;
    return !!(
      viewer &&
      activeViewer &&
      snapshot.roomCode === this.#snapshot?.roomCode &&
      viewer.participantId === activeViewer.participantId &&
      access.presenceIncarnationId === viewer.presenceIncarnationId &&
      access.coordinatorEpoch === snapshot.presence.coordinatorEpoch
    );
  }

  async #open(
    snapshot: ProRoomSnapshot,
    access: ProRoomSignalingAccess,
    signal?: AbortSignal,
  ): Promise<void> {
    const viewer = snapshot.viewer;
    if (
      !viewer ||
      access.presenceIncarnationId !== viewer.presenceIncarnationId ||
      access.coordinatorEpoch !== snapshot.presence.coordinatorEpoch
    ) {
      throw new Error('PRO_ROOM_SIGNALING_TICKET_MISMATCH');
    }

    const generation = ++this.#generation;
    this.#intentionalClose = true;
    this.#clearTimers();
    this.#settleClockWaiters(false);
    try {
      this.#socket?.close(1000, 'PRO_SOCKET_REPLACED');
    } catch {
      /* best effort */
    }
    this.#socket = null;
    this.#intentionalClose = false;
    this.#snapshot = snapshot;
    this.#access = access;
    this.#pendingPlaybackTransition = access.pendingPlaybackTransition;
    this.#clockPending.clear();
    this.#clockBestRttMs = Number.POSITIVE_INFINITY;
    this.#clockCalibrated = false;
    this.#clockCalibratedAtMs = 0;

    const url = signalingSocketUrl(snapshot.roomCode, access.ticket);
    const socket = new WebSocket(url);
    this.#socket = socket;

    const currentLabel = (getState('network.myDeviceLabel') || '').trim();
    batchSetState({
      // This is a local media-engine compatibility mode, never room authority.
      // No host socket, peer facade, or participant hierarchy is created.
      'network.appRole': 'host',
      'network.myId': viewer.participantId,
      'network.myDeviceLabel': viewer.displayName || currentLabel || 'Peer',
      'network.sessionCode': snapshot.roomCode,
      'network.lastJoinCode': snapshot.roomCode,
      'network.hostConn': null,
      'network.connectedPeers': [],
      'network.isOperator': true,
      'network.isConnecting': true,
      'network.isIntentionalDisconnect': false,
      'network.connectionType': 'remote',
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const closeLateOpen = () => {
          try {
            socket.close(1000, 'PRO_CONNECT_FAILED');
          } catch {
            /* best effort */
          }
        };
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
          socket.removeEventListener('error', onError);
          if (error) {
            // Keep the open listener as a final fence. Although close() while
            // CONNECTING normally prevents OPEN, a delayed platform event must
            // not resurrect a socket after this attempt has already failed.
            reject(error);
          } else {
            socket.removeEventListener('open', onOpen);
            resolve();
          }
        };
        const onOpen = () => {
          if (settled) {
            closeLateOpen();
            return;
          }
          finish();
        };
        const onError = () => finish(new Error('PRO_SIGNALING_START_FAILED'));
        const onAbort = () => {
          try {
            socket.close(1000, 'PRO_CONNECT_ABORTED');
          } catch {
            /* best effort */
          }
          finish(new DOMException('Aborted', 'AbortError'));
        };
        const timeout = globalThis.setTimeout(
          () => finish(new Error('PRO_ROOM_CONNECT_TIMEOUT')),
          SOCKET_OPEN_TIMEOUT_MS,
        );
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    } catch (error) {
      // Only the attempt that still owns the bridge may publish disconnected
      // state. A superseded failure must never tear down a newer generation.
      if (generation === this.#generation && this.#socket === socket) {
        this.#socket = null;
        this.#clockPending.clear();
        this.#clockCalibrated = false;
        this.#clockCalibratedAtMs = 0;
        batchSetState({ 'network.isConnecting': false });
        this.#publishConnected(false);
      }
      try {
        socket.close(1000, 'PRO_CONNECT_FAILED');
      } catch {
        /* best effort; retained open listener closes a delayed OPEN */
      }
      throw error;
    }

    if (generation !== this.#generation || this.#socket !== socket) {
      try {
        socket.close(1000, 'PRO_CONNECT_SUPERSEDED');
      } catch {
        /* best effort */
      }
      throw new Error('PRO_ROOM_SESSION_SUPERSEDED');
    }

    socket.addEventListener('message', (event) => this.#handleMessage(event.data));
    socket.addEventListener('close', () => {
      if (generation !== this.#generation || this.#socket !== socket) return;
      this.#socket = null;
      this.#clearTimers();
      this.#settleClockWaiters(false);
      this.#publishConnected(false);
      if (!this.#intentionalClose) {
        log.warn('[PRO] Server control channel disconnected; recovery requested');
      }
    });
    socket.addEventListener('error', () => {
      if (generation === this.#generation && this.#socket === socket) {
        log.warn('[PRO] Server control channel reported a socket error');
      }
    });

    batchSetState({
      'network.isConnecting': false,
      'network.connectionType': 'remote',
    });
    this.#publishConnected(true);
    this.#scheduleClockBurst(generation);
  }

  #handleMessage(raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > MAX_SERVER_FRAME_BYTES) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }

    if (isRecord(value) && value.type === 'pro-clock' && value.version === 1) {
      const requestId = value.requestId;
      const clientSentAtMs = value.clientSentAtMs;
      const serverTimeMs = value.serverTimeMs;
      if (
        !Number.isSafeInteger(requestId) ||
        typeof clientSentAtMs !== 'number' ||
        !Number.isFinite(clientSentAtMs) ||
        typeof serverTimeMs !== 'number' ||
        !Number.isFinite(serverTimeMs)
      ) {
        return;
      }
      const sentAt = this.#clockPending.get(requestId as number);
      if (sentAt === undefined || sentAt !== clientSentAtMs) return;
      this.#clockPending.delete(requestId as number);
      const receivedAt = Date.now();
      const rtt = Math.max(0, receivedAt - sentAt);
      const offset = serverTimeMs - (sentAt + receivedAt) / 2;
      if (rtt <= this.#clockBestRttMs) {
        this.#clockBestRttMs = rtt;
        this.#clockOffsetMs = offset;
        this.#clockCalibrated = true;
        this.#clockCalibratedAtMs = receivedAt;
        this.#settleFreshClockWaiters();
      }
      return;
    }

    const frame = parseServerFrame(value);
    if (!frame) return;
    const snapshot = this.#snapshot;
    if (
      !snapshot ||
      frame.roomCode !== snapshot.roomCode ||
      frame.coordinatorEpoch !== snapshot.presence.coordinatorEpoch
    ) {
      return;
    }
    for (const listener of realtimeListeners) {
      try {
        listener(frame);
      } catch (error) {
        log.warn('[PRO] Realtime listener failed', error);
      }
    }
  }

  #scheduleClockBurst(generation: number): void {
    for (const delay of CLOCK_BURST_DELAYS_MS) {
      this.#schedule(() => this.#requestClockSample(), delay, generation);
    }
    this.#scheduleClockRefresh(generation);
  }

  #scheduleClockRefresh(generation: number): void {
    this.#schedule(
      () => {
        this.#clockBestRttMs = Number.POSITIVE_INFINITY;
        this.#requestClockSample();
        this.#scheduleClockRefresh(generation);
      },
      CLOCK_REFRESH_MS,
      generation,
    );
  }

  #requestClockSample(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const requestId = ++this.#clockRequestSequence;
    const clientSentAtMs = Date.now();
    this.#clockPending.set(requestId, clientSentAtMs);
    while (this.#clockPending.size > 16) {
      const oldest = this.#clockPending.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#clockPending.delete(oldest);
    }
    try {
      socket.send(
        JSON.stringify({
          type: 'pro-realtime',
          version: 1,
          eventId: randomEventId(),
          channel: 'clock',
          payload: { requestId, clientSentAtMs },
        }),
      );
    } catch {
      this.#clockPending.delete(requestId);
    }
  }

  #schedule(callback: () => void, delay: number, generation: number): void {
    const timer = globalThis.setTimeout(() => {
      this.#timers.delete(timer);
      if (generation === this.#generation) callback();
    }, delay);
    this.#timers.add(timer);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #hasFreshClockCalibration(): boolean {
    const ageMs = Date.now() - this.#clockCalibratedAtMs;
    return this.#clockCalibrated && ageMs >= 0 && ageMs <= CLOCK_READY_FRESHNESS_MS;
  }

  #settleFreshClockWaiters(): void {
    if (!this.#hasFreshClockCalibration()) return;
    for (const waiter of [...this.#clockWaiters]) {
      if (waiter.generation !== this.#generation) {
        this.#settleClockWaiter(waiter, false);
        continue;
      }
      this.#settleClockWaiter(waiter, this.serverNowMs <= waiter.serverDeadlineAtMs);
    }
  }

  #settleClockWaiters(calibrated: boolean): void {
    for (const waiter of [...this.#clockWaiters]) this.#settleClockWaiter(waiter, calibrated);
  }

  #settleClockWaiter(waiter: ClockCalibrationWaiter, calibrated: boolean): void {
    if (!this.#clockWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    this.#timers.delete(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(calibrated);
  }

  #publishConnected(connected: boolean): void {
    for (const listener of connectionListeners) {
      try {
        listener(connected);
      } catch (error) {
        log.warn('[PRO] Realtime connection listener failed', error);
      }
    }
  }
}

export const proRoomServerBridge = new ServerProRoomNetworkBridge();

export function sendProRoomRealtime(
  channel: 'chat' | 'presence' | 'control-ready',
  payload: JsonRecord,
): boolean {
  return proRoomServerBridge.send(channel, payload);
}

export function getProRoomServerNow(): number {
  return proRoomServerBridge.serverNowMs;
}

export function isProRoomServerClockCalibrated(): boolean {
  return proRoomServerBridge.clockCalibrated;
}

export function waitForFreshProRoomServerClockCalibration(options: {
  serverDeadlineAtMs: number;
  fallbackTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  return proRoomServerBridge.waitForFreshClockCalibration(options);
}
