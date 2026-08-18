import { log } from '../core/log.ts';
import { batchSetState, getState } from '../core/state.ts';
import { proSignalingWebSocketProtocols } from '../network/pro-signaling-websocket.ts';
import { getRuntimeTransportConfig } from '../network/transport/config.ts';
import type { ProRoomSignalingAccess } from './api.ts';
import type { ProRoomPlaybackPrepareEvent } from './api.ts';
import type { ProRoomSnapshot } from './contracts.ts';
import type { ProRoomTransportBridge } from './session-controller.ts';

const SOCKET_OPEN_TIMEOUT_MS = 15_000;
const MAX_SERVER_FRAME_BYTES = 256 * 1024;
const CLOCK_REFRESH_MS = 30_000;
const CLOCK_BURST_DELAYS_MS = [0, 120, 300, 700, 1_500] as const;
const CLOCK_READY_BURST_DELAYS_MS = [0, 80, 180] as const;
const CLOCK_READY_MIN_RESPONSES = 2;
const CLOCK_READY_DECISION_WINDOW_MS = 220;
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

interface ProRoomServerClockDiagnostics {
  connected: boolean;
  calibrated: boolean;
  bestOffsetMs: number;
  bestRttMs: number | null;
  readyCalibrationAgeMs: number | null;
}

interface ClockCalibrationWaiter {
  generation: number;
  roundId: number;
  serverDeadlineAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (calibrated: boolean) => void;
}

interface ClockPendingSample {
  sentAtMs: number;
  generation: number;
  roundId: number | null;
}

interface ClockCalibrationRound {
  id: number;
  generation: number;
  started: boolean;
  responseCount: number;
  bestRttMs: number;
  bestOffsetMs: number;
  bestReceivedAtMs: number;
  requestIds: Set<number>;
  timers: Set<ReturnType<typeof setTimeout>>;
}

const realtimeListeners = new Set<RealtimeListener>();
const connectionListeners = new Set<ConnectionListener>();

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isSafeIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function isProServerEventEnvelope(value: JsonRecord): value is JsonRecord & ProServerEventEnvelope {
  return (
    value.type === 'pro-server-event' &&
    value.version === 1 &&
    typeof value.roomCode === 'string' &&
    /^\d{6}$/.test(value.roomCode) &&
    isSafePositiveInteger(value.coordinatorEpoch) &&
    isRecord(value.event) &&
    typeof value.event.type === 'string'
  );
}

function isProRealtimeRelayEnvelope(
  value: JsonRecord,
): value is JsonRecord & ProRealtimeRelayEnvelope {
  if (
    value.type !== 'pro-realtime' ||
    value.version !== 1 ||
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
        !/^(?:member|owner)_[A-Za-z0-9_-]{16,128}$/.test(value.sender.memberId))) ||
    (value.sender.displayName !== undefined && typeof value.sender.displayName !== 'string')
  ) {
    return false;
  }
  return (
    value.channel !== 'chat-control-snapshot' ||
    (value.sender.participantId === 'server' &&
      value.sender.presenceIncarnationId === 'server-chat-state' &&
      hasExactKeys(value.payload, [
        'revision',
        'frozen',
        'filterEnabled',
        'slowmodeSeconds',
        'muted',
      ]) &&
      isSafeIntegerBetween(value.payload.revision, 0, Number.MAX_SAFE_INTEGER) &&
      typeof value.payload.frozen === 'boolean' &&
      typeof value.payload.filterEnabled === 'boolean' &&
      isSafeIntegerBetween(value.payload.slowmodeSeconds, 0, 60) &&
      typeof value.payload.muted === 'boolean')
  );
}

function randomEventId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function signalingSocketUrl(roomCode: string): string {
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
  return url.toString();
}

function parseServerFrame(
  value: unknown,
): ProServerEventEnvelope | ProRealtimeRelayEnvelope | null {
  if (!isRecord(value)) return null;
  if (isProServerEventEnvelope(value)) return value;
  if (isProRealtimeRelayEnvelope(value)) return value;
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
  #latestChatControlSnapshotRevision = -1;
  #intentionalClose = false;
  #clockRequestSequence = 0;
  #clockPending = new Map<number, ClockPendingSample>();
  #clockCalibrationRoundSequence = 0;
  #clockCalibrationRound: ClockCalibrationRound | null = null;
  #clockBestRttMs = Number.POSITIVE_INFINITY;
  #clockOffsetMs = 0;
  #clockCalibrated = false;
  #clockReadyCalibratedAtMs = 0;
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

  get clockDiagnostics(): ProRoomServerClockDiagnostics {
    return {
      connected: this.connected,
      calibrated: this.#clockCalibrated,
      bestOffsetMs: this.#clockOffsetMs,
      bestRttMs: Number.isFinite(this.#clockBestRttMs) ? this.#clockBestRttMs : null,
      readyCalibrationAgeMs:
        this.#clockReadyCalibratedAtMs > 0
          ? Math.max(0, Date.now() - this.#clockReadyCalibratedAtMs)
          : null,
    };
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

    return new Promise<boolean>((resolve) => {
      const round = this.#getOrCreateClockCalibrationRound(generation);
      const timer = globalThis.setTimeout(() => this.#settleClockWaiterAtBudget(waiter), timeoutMs);
      const waiter: ClockCalibrationWaiter = {
        generation,
        roundId: round.id,
        serverDeadlineAtMs,
        timer,
        signal,
        resolve,
      };
      waiter.onAbort = () => this.#settleClockWaiter(waiter, false);
      this.#clockWaiters.add(waiter);
      this.#timers.add(timer);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });

      // Register the waiter before starting the burst so a synchronous test
      // socket (or an unusually fast platform implementation) cannot answer
      // the first sample before the wait owns its calibration round.
      if (!round.started) this.#startClockCalibrationRound(round);
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
    this.#latestChatControlSnapshotRevision = -1;
    this.#clearTimers();
    this.#settleClockWaiters(false);
    this.#clockPending.clear();
    this.#clockCalibrationRound = null;
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

  send(
    channel: 'chat' | 'presence' | 'control-ready' | 'system-audio-signal',
    payload: JsonRecord,
  ): boolean {
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

  #ownsSocket(socket: WebSocket, generation: number): boolean {
    return generation === this.#generation && this.#socket === socket;
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
    this.#latestChatControlSnapshotRevision = -1;
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
    this.#clockCalibrationRound = null;
    this.#clockBestRttMs = Number.POSITIVE_INFINITY;
    this.#clockCalibrated = false;
    this.#clockReadyCalibratedAtMs = 0;

    const url = signalingSocketUrl(snapshot.roomCode);
    const socket = new WebSocket(url, proSignalingWebSocketProtocols(access.ticket));
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
          socket.removeEventListener('close', onClose);
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
        const onClose = (event: CloseEvent) => {
          if (
            event.reason === 'PRO_SOCKET_REPLACED' ||
            event.reason === 'PRO_CONNECT_ABORTED' ||
            event.reason === 'PRO_CONNECT_FAILED'
          ) {
            // The local lifecycle that issued close owns settlement. In
            // particular, a replacement must not turn its predecessor into an
            // unrelated signaling-start failure.
            return;
          }
          finish(new Error('PRO_SIGNALING_START_FAILED'));
        };
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
        socket.addEventListener('close', onClose, { once: true });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    } catch (error) {
      // Only the attempt that still owns the bridge may publish disconnected
      // state. A superseded failure must never tear down a newer generation.
      if (generation === this.#generation && this.#socket === socket) {
        this.#socket = null;
        this.#clockPending.clear();
        this.#clockCalibrationRound = null;
        this.#clockCalibrated = false;
        this.#clockReadyCalibratedAtMs = 0;
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

    if (!this.#ownsSocket(socket, generation)) {
      try {
        socket.close(1000, 'PRO_CONNECT_SUPERSEDED');
      } catch {
        /* best effort */
      }
      throw new Error('PRO_ROOM_SESSION_SUPERSEDED');
    }

    socket.addEventListener('message', (event) => {
      if (!this.#ownsSocket(socket, generation)) return;
      this.#handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (!this.#ownsSocket(socket, generation)) return;
      this.#socket = null;
      this.#latestChatControlSnapshotRevision = -1;
      this.#clearTimers();
      this.#settleClockWaiters(false);
      this.#clockPending.clear();
      this.#clockCalibrationRound = null;
      this.#publishConnected(false);
      if (!this.#intentionalClose) {
        log.warn('[PRO] Server control channel disconnected; recovery requested');
      }
    });
    socket.addEventListener('error', () => {
      if (this.#ownsSocket(socket, generation)) {
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
      const pending = this.#clockPending.get(requestId as number);
      if (
        !pending ||
        pending.sentAtMs !== clientSentAtMs ||
        pending.generation !== this.#generation
      ) {
        return;
      }
      this.#clockPending.delete(requestId as number);
      const receivedAt = Date.now();
      const rtt = Math.max(0, receivedAt - pending.sentAtMs);
      const offset = serverTimeMs - (pending.sentAtMs + receivedAt) / 2;
      this.#adoptClockSample(rtt, offset);

      const round = this.#clockCalibrationRound;
      if (
        pending.roundId !== null &&
        round?.id === pending.roundId &&
        round.generation === pending.generation
      ) {
        round.requestIds.delete(requestId as number);
        round.responseCount += 1;
        if (rtt <= round.bestRttMs) {
          round.bestRttMs = rtt;
          round.bestOffsetMs = offset;
          round.bestReceivedAtMs = receivedAt;
        }
        if (round.responseCount >= CLOCK_READY_MIN_RESPONSES) {
          this.#finalizeClockCalibrationRound(round);
        }
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
    if (frame.type === 'pro-realtime' && frame.channel === 'chat-control-snapshot') {
      const revision = frame.payload.revision as number;
      if (revision <= this.#latestChatControlSnapshotRevision) return;
      this.#latestChatControlSnapshotRevision = revision;
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

  #getOrCreateClockCalibrationRound(generation: number): ClockCalibrationRound {
    const active = this.#clockCalibrationRound;
    if (active && active.generation === generation) return active;
    const round: ClockCalibrationRound = {
      id: ++this.#clockCalibrationRoundSequence,
      generation,
      started: false,
      responseCount: 0,
      bestRttMs: Number.POSITIVE_INFINITY,
      bestOffsetMs: 0,
      bestReceivedAtMs: 0,
      requestIds: new Set<number>(),
      timers: new Set<ReturnType<typeof setTimeout>>(),
    };
    this.#clockCalibrationRound = round;
    return round;
  }

  #startClockCalibrationRound(round: ClockCalibrationRound): void {
    if (
      round.started ||
      round !== this.#clockCalibrationRound ||
      round.generation !== this.#generation
    ) {
      return;
    }
    round.started = true;
    // A minimum RTT from an older sampling window must not prevent this
    // deadline-relevant burst from refreshing the general scheduling clock.
    this.#clockBestRttMs = Number.POSITIVE_INFINITY;

    for (const delay of CLOCK_READY_BURST_DELAYS_MS) {
      if (delay === 0) {
        const requestId = this.#requestClockSample(round.id);
        if (requestId !== null) round.requestIds.add(requestId);
        continue;
      }
      const timer = this.#schedule(
        () => {
          const requestId = this.#requestClockSample(round.id);
          if (requestId !== null && this.#clockCalibrationRound === round) {
            round.requestIds.add(requestId);
          }
        },
        delay,
        round.generation,
      );
      round.timers.add(timer);
    }

    const decisionTimer = this.#schedule(
      () => this.#finalizeClockCalibrationRound(round),
      CLOCK_READY_DECISION_WINDOW_MS,
      round.generation,
    );
    round.timers.add(decisionTimer);
  }

  #adoptClockSample(rtt: number, offset: number): void {
    if (rtt > this.#clockBestRttMs) return;
    this.#clockBestRttMs = rtt;
    this.#clockOffsetMs = offset;
    this.#clockCalibrated = true;
  }

  #finalizeClockCalibrationRound(round: ClockCalibrationRound): void {
    if (round !== this.#clockCalibrationRound || round.generation !== this.#generation) {
      return;
    }
    const calibrated = Number.isFinite(round.bestRttMs) && round.bestReceivedAtMs > 0;
    if (calibrated) {
      // Commit the minimum-RTT candidate even if a concurrent background
      // sample arrived during the bounded window. READY must use one coherent
      // calibration round, never whichever response happened to arrive first.
      this.#clockBestRttMs = round.bestRttMs;
      this.#clockOffsetMs = round.bestOffsetMs;
      this.#clockCalibrated = true;
      this.#clockReadyCalibratedAtMs = Date.now();
    }
    this.#closeClockCalibrationRound(round);
    for (const waiter of [...this.#clockWaiters]) {
      if (waiter.generation !== round.generation || waiter.roundId !== round.id) continue;
      this.#settleClockWaiter(
        waiter,
        calibrated && Date.now() + round.bestOffsetMs <= waiter.serverDeadlineAtMs,
      );
    }
  }

  #closeClockCalibrationRound(round: ClockCalibrationRound): void {
    for (const timer of round.timers) {
      clearTimeout(timer);
      this.#timers.delete(timer);
    }
    for (const requestId of round.requestIds) this.#clockPending.delete(requestId);
    round.timers.clear();
    round.requestIds.clear();
    if (this.#clockCalibrationRound === round) this.#clockCalibrationRound = null;
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

  #requestClockSample(roundId: number | null = null): number | null {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return null;
    const requestId = ++this.#clockRequestSequence;
    const clientSentAtMs = Date.now();
    this.#clockPending.set(requestId, {
      sentAtMs: clientSentAtMs,
      generation: this.#generation,
      roundId,
    });
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
      return null;
    }
    return requestId;
  }

  #schedule(
    callback: () => void,
    delay: number,
    generation: number,
  ): ReturnType<typeof setTimeout> {
    const timer = globalThis.setTimeout(() => {
      this.#timers.delete(timer);
      if (generation === this.#generation) callback();
    }, delay);
    this.#timers.add(timer);
    return timer;
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #hasFreshClockCalibration(): boolean {
    const ageMs = Date.now() - this.#clockReadyCalibratedAtMs;
    return (
      this.#clockCalibrated &&
      this.#clockReadyCalibratedAtMs > 0 &&
      ageMs >= 0 &&
      ageMs <= CLOCK_READY_FRESHNESS_MS
    );
  }

  #settleClockWaiterAtBudget(waiter: ClockCalibrationWaiter): void {
    if (!this.#clockWaiters.has(waiter)) return;
    const round = this.#clockCalibrationRound;
    if (
      waiter.generation !== this.#generation ||
      !round ||
      round.id !== waiter.roundId ||
      round.generation !== waiter.generation
    ) {
      this.#settleClockWaiter(waiter, false);
      return;
    }
    if (!Number.isFinite(round.bestRttMs) || round.bestReceivedAtMs <= 0) {
      this.#settleClockWaiter(waiter, false);
      return;
    }

    const otherRoundWaiters = [...this.#clockWaiters].some(
      (candidate) => candidate !== waiter && candidate.roundId === round.id,
    );
    if (!otherRoundWaiters) {
      // A short PREPARE remainder cannot wait out the normal 220ms decision
      // window. Finalize the best sample already available at its own bounded
      // budget instead of either missing the server deadline or discarding a
      // usable estimate.
      this.#finalizeClockCalibrationRound(round);
      return;
    }
    this.#settleClockWaiter(waiter, Date.now() + round.bestOffsetMs <= waiter.serverDeadlineAtMs);
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

    const round = this.#clockCalibrationRound;
    if (
      round?.id === waiter.roundId &&
      ![...this.#clockWaiters].some((candidate) => candidate.roundId === round.id)
    ) {
      this.#closeClockCalibrationRound(round);
    }
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
  channel: 'chat' | 'presence' | 'control-ready' | 'system-audio-signal',
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

export function getProRoomServerClockDiagnostics(): ProRoomServerClockDiagnostics {
  return proRoomServerBridge.clockDiagnostics;
}

export function waitForFreshProRoomServerClockCalibration(options: {
  serverDeadlineAtMs: number;
  fallbackTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  return proRoomServerBridge.waitForFreshClockCalibration(options);
}
