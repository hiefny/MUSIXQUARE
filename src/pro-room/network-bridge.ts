import { log } from '../core/log.ts';
import { batchSetState, getState } from '../core/state.ts';
import { recordProStartObservation } from '../diagnostics/pro-start-observations.ts';
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
const CLOCK_CANDIDATE_MAX_AGE_MS = 60_000;
const CLOCK_CANDIDATE_LIMIT = 16;
const CLOCK_LATE_RESPONSE_MAX_AGE_MS = 5_000;
// Diagnostic margins tolerate timer precision; neither changes clock selection or lease validity.
const CLOCK_COMPARISON_TOLERANCE_MS = 5;
const CLOCK_CONTINUITY_TOLERANCE_MS = 50;

export interface ProRoomClockSnapshot {
  readonly generation: number;
  readonly sampleId: number;
  readonly offsetMs: number;
  readonly rttMs: number;
  readonly sampledAtMs: number;
  readonly roundId: number | null;
  readonly source: 'connection' | 'refresh' | 'ready' | 'ready-late';
}

interface ProRoomClockAcquisitionOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  fresh?: boolean;
  serverDeadlineAtMs?: number;
}

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
  roundId: number | null;
  serverDeadlineAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (snapshot: ProRoomClockSnapshot | null) => void;
}

interface ClockPendingSample {
  sentAtMs: number;
  sentPerformanceMs: number;
  generation: number;
  roundId: number | null;
  source: ProRoomClockSnapshot['source'];
  expiresAtMs: number | null;
}

interface ClockCalibrationRound {
  id: number;
  generation: number;
  started: boolean;
  decisionWindowElapsed: boolean;
  responseCount: number;
  bestRttMs: number;
  bestOffsetMs: number;
  bestReceivedAtMs: number;
  bestSnapshot: ProRoomClockSnapshot | null;
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
  #clockCandidates: ProRoomClockSnapshot[] = [];
  #clockConfirmed: ProRoomClockSnapshot | null = null;
  #clockSnapshotTokens = new WeakSet<ProRoomClockSnapshot>();
  #lastClockSelectionId: number | null = null;
  #lastClockCandidateId: number | null = null;
  #clockReadyCalibratedAtMs = 0;
  #clockWaiters = new Set<ClockCalibrationWaiter>();
  #pendingPlaybackTransition: ProRoomPlaybackPrepareEvent | null = null;
  #timers = new Set<ReturnType<typeof setTimeout>>();

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  get serverNowMs(): number {
    // Without calibration this is only local wall time. Playback must acquire a
    // clock lease or check clockCalibrated before treating it as server time.
    return Date.now() + (this.captureClockSnapshot()?.offsetMs ?? 0);
  }

  get clockCalibrated(): boolean {
    return this.captureClockSnapshot() !== null;
  }

  get clockDiagnostics(): ProRoomServerClockDiagnostics {
    const selected = this.captureClockSnapshot();
    return {
      connected: this.connected,
      calibrated: selected !== null,
      bestOffsetMs: selected?.offsetMs ?? 0,
      bestRttMs: selected?.rttMs ?? null,
      readyCalibrationAgeMs:
        this.#clockReadyCalibratedAtMs > 0
          ? Math.max(0, Date.now() - this.#clockReadyCalibratedAtMs)
          : null,
    };
  }

  /** Selection freshness limits new acquisitions, never a transition's existing lease. */
  captureClockSnapshot(): ProRoomClockSnapshot | null {
    if (!this.connected) return null;
    const candidate = this.#bestClockCandidate();
    const confirmed = this.#hasFreshClockCalibration() ? this.#clockConfirmed : null;
    const selected = confirmed ?? candidate;
    if (
      (selected?.sampleId ?? null) !== this.#lastClockSelectionId ||
      (candidate?.sampleId ?? null) !== this.#lastClockCandidateId
    ) {
      this.#lastClockSelectionId = selected?.sampleId ?? null;
      this.#lastClockCandidateId = candidate?.sampleId ?? null;
      recordProStartObservation('clock-selection', {
        generation: this.#generation,
        reason: confirmed ? 'confirmed' : 'candidate',
        selectedSampleId: selected?.sampleId ?? null,
        selectedOffsetMs: selected?.offsetMs ?? null,
        selectedRttMs: selected?.rttMs ?? null,
        bestCandidateSampleId: candidate?.sampleId ?? null,
        bestCandidateRttMs: candidate?.rttMs ?? null,
        bestCandidateOffsetMs: candidate?.offsetMs ?? null,
        uncertaintyMs: candidate ? candidate.rttMs / 2 : null,
        excessDistanceMs:
          selected && candidate
            ? Math.max(0, Math.abs(selected.offsetMs - candidate.offsetMs) - candidate.rttMs / 2)
            : null,
        comparisonToleranceMs: CLOCK_COMPARISON_TOLERANCE_MS,
        disjointIntervals:
          selected && candidate
            ? Math.abs(selected.offsetMs - candidate.offsetMs) >
              (selected.rttMs + candidate.rttMs) / 2 + CLOCK_COMPARISON_TOLERANCE_MS
            : null,
        confirmed: confirmed !== null,
        candidateCount: this.#clockCandidates.length,
      });
    }
    return selected;
  }

  isClockSnapshotCurrent(snapshot: ProRoomClockSnapshot): boolean {
    // Unexpected close preserves clocks already leased to admitted work.
    // Explicit disconnect and socket replacement revoke them via generation.
    return snapshot.generation === this.#generation && this.#clockSnapshotTokens.has(snapshot);
  }

  acquireClock(options: ProRoomClockAcquisitionOptions): Promise<ProRoomClockSnapshot | null> {
    const { signal } = options;
    const serverDeadlineAtMs = options.serverDeadlineAtMs ?? Number.MAX_SAFE_INTEGER;
    if (
      !this.connected ||
      signal?.aborted ||
      !Number.isFinite(serverDeadlineAtMs) ||
      !Number.isFinite(options.timeoutMs)
    ) {
      return Promise.resolve(null);
    }
    const selected = options.fresh
      ? this.#hasFreshClockCalibration()
        ? this.#clockConfirmed
        : null
      : this.captureClockSnapshot();
    if (selected) {
      return Promise.resolve(
        Date.now() + selected.offsetMs <= serverDeadlineAtMs ? selected : null,
      );
    }
    const timeoutMs = Math.max(0, Math.min(CLOCK_WAIT_MAX_MS, options.timeoutMs));
    if (timeoutMs === 0) return Promise.resolve(null);
    const generation = this.#generation;
    return new Promise<ProRoomClockSnapshot | null>((resolve) => {
      const round = options.fresh ? this.#getOrCreateClockCalibrationRound(generation) : null;
      const timer = globalThis.setTimeout(() => this.#settleClockWaiterAtBudget(waiter), timeoutMs);
      const waiter: ClockCalibrationWaiter = {
        generation,
        roundId: round?.id ?? null,
        serverDeadlineAtMs,
        timer,
        signal,
        resolve,
      };
      waiter.onAbort = () => this.#settleClockWaiter(waiter, null, 'aborted');
      this.#clockWaiters.add(waiter);
      this.#timers.add(timer);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      // Passive acquisition only observes the connection's already scheduled requests.
      // Install ownership before a fresh round can receive a synchronous reply.
      if (round && !round.started) this.#startClockCalibrationRound(round);
    });
  }

  /** Compatibility API for callers that only need the READY decision. */
  async waitForFreshClockCalibration(options: {
    serverDeadlineAtMs: number;
    fallbackTimeoutMs: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    return (
      (await this.acquireClock({
        timeoutMs: options.fallbackTimeoutMs,
        signal: options.signal,
        fresh: true,
        serverDeadlineAtMs: options.serverDeadlineAtMs,
      })) !== null
    );
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
      !this.connected ||
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
    this.#settleClockWaiters(null);
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
      viewer.presenceIncarnationId === activeViewer.presenceIncarnationId &&
      snapshot.presence.coordinatorEpoch === this.#snapshot.presence.coordinatorEpoch &&
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

    // Ticket responses may complete out of order across heartbeat/account and
    // reconnect lanes. Reject a superseded ticket before closing the socket
    // that already installed its successor. An equal ticket may retry only
    // after a failed/disconnected attempt; the server still owns single use.
    if (
      this.#snapshot?.roomCode === snapshot.roomCode &&
      access.coordinatorEpoch < this.#snapshot.presence.coordinatorEpoch
    ) {
      throw new Error('PRO_ROOM_SIGNALING_TICKET_SUPERSEDED');
    }
    const currentSequence = this.#access?.ticketSequence;
    if (
      currentSequence !== undefined &&
      this.#matchesActiveIdentity(snapshot, access) &&
      (access.ticketSequence < currentSequence ||
        (access.ticketSequence === currentSequence &&
          (this.#socket?.readyState === WebSocket.OPEN ||
            this.#socket?.readyState === WebSocket.CONNECTING)))
    ) {
      throw new Error('PRO_ROOM_SIGNALING_TICKET_SUPERSEDED');
    }

    const generation = ++this.#generation;
    this.#intentionalClose = true;
    this.#latestChatControlSnapshotRevision = -1;
    this.#clearTimers();
    this.#settleClockWaiters(null);
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
    this.#clockCandidates = [];
    this.#clockConfirmed = null;
    this.#lastClockSelectionId = null;
    this.#lastClockCandidateId = null;
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
        this.#clockCandidates = [];
        this.#clockConfirmed = null;
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
      this.#settleClockWaiters(null);
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
      const receivedPerformanceMs = performance.now();
      if (pending.expiresAtMs !== null && receivedAt > pending.expiresAtMs) {
        recordProStartObservation('clock-sample', {
          requestId: requestId as number,
          generation: pending.generation,
          roundId: pending.roundId,
          reason: 'expired',
        });
        return;
      }
      const wallElapsedMs = receivedAt - pending.sentAtMs;
      const monotonicElapsedMs = receivedPerformanceMs - pending.sentPerformanceMs;
      const rtt = Math.max(0, wallElapsedMs);
      const offset = serverTimeMs - (pending.sentAtMs + receivedAt) / 2;
      const sample: ProRoomClockSnapshot = Object.freeze({
        generation: pending.generation,
        sampleId: requestId as number,
        offsetMs: offset,
        rttMs: rtt,
        sampledAtMs: receivedAt,
        roundId: pending.roundId,
        source: pending.source,
      });
      this.#clockSnapshotTokens.add(sample);
      this.#storeClockCandidate(sample);
      recordProStartObservation('clock-sample', {
        requestId: requestId as number,
        sampleId: sample.sampleId,
        generation: sample.generation,
        roundId: sample.roundId,
        source: sample.source,
        sentAtMs: pending.sentAtMs,
        receivedAtMs: receivedAt,
        serverTimeMs,
        sentPerformanceMs: pending.sentPerformanceMs,
        receivedPerformanceMs,
        wallElapsedMs,
        monotonicElapsedMs,
        continuityToleranceMs: CLOCK_CONTINUITY_TOLERANCE_MS,
        clockContinuitySuspect:
          Math.abs(wallElapsedMs - monotonicElapsedMs) > CLOCK_CONTINUITY_TOLERANCE_MS,
        rttMs: rtt,
        offsetMs: offset,
        uncertaintyMs: rtt / 2,
      });

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
          round.bestSnapshot = sample;
        }
        if (round.responseCount >= CLOCK_READY_MIN_RESPONSES || round.decisionWindowElapsed) {
          this.#finalizeClockCalibrationRound(round);
        }
      }
      const selected = this.captureClockSnapshot();
      if (selected) {
        for (const waiter of [...this.#clockWaiters]) {
          if (waiter.roundId !== null || waiter.generation !== this.#generation) continue;
          this.#settleClockWaiter(
            waiter,
            Date.now() + selected.offsetMs <= waiter.serverDeadlineAtMs ? selected : null,
          );
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
      decisionWindowElapsed: false,
      responseCount: 0,
      bestRttMs: Number.POSITIVE_INFINITY,
      bestOffsetMs: 0,
      bestReceivedAtMs: 0,
      bestSnapshot: null,
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
    // Selection belongs to this round; background candidates cannot replace its result.

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
      () => {
        // This is a sample-selection window, not the caller's timeout. On a
        // slower route, keep the requests alive until a response arrives or
        // each waiter exhausts its own budget (or is aborted/disconnected).
        round.decisionWindowElapsed = true;
        if (round.responseCount > 0) this.#finalizeClockCalibrationRound(round);
      },
      CLOCK_READY_DECISION_WINDOW_MS,
      round.generation,
    );
    round.timers.add(decisionTimer);
  }

  #bestClockCandidate(): ProRoomClockSnapshot | null {
    const now = Date.now();
    this.#clockCandidates = this.#clockCandidates.filter((sample) => {
      const age = now - sample.sampledAtMs;
      return (
        sample.generation === this.#generation && age >= 0 && age <= CLOCK_CANDIDATE_MAX_AGE_MS
      );
    });
    let best: ProRoomClockSnapshot | null = null;
    for (const sample of this.#clockCandidates) {
      if (!best || sample.rttMs <= best.rttMs) best = sample;
    }
    return best;
  }

  #storeClockCandidate(sample: ProRoomClockSnapshot): void {
    this.#bestClockCandidate();
    this.#clockCandidates.push(sample);
    if (this.#clockCandidates.length > CLOCK_CANDIDATE_LIMIT) this.#clockCandidates.shift();
  }

  #finalizeClockCalibrationRound(round: ClockCalibrationRound): void {
    if (round !== this.#clockCalibrationRound || round.generation !== this.#generation) {
      return;
    }
    const snapshot = round.bestSnapshot;
    if (snapshot) {
      // Fresh acquisitions share this exact immutable decision. Later replies are
      // candidates for future selection, never mutations of a READY lease.
      this.#clockConfirmed = snapshot;
      this.#clockReadyCalibratedAtMs = Date.now();
    }
    recordProStartObservation('clock-round', {
      generation: round.generation,
      roundId: round.id,
      sampleId: snapshot?.sampleId ?? null,
      reason: snapshot ? 'complete' : 'cancelled',
      responseCount: round.responseCount,
    });
    this.#closeClockCalibrationRound(round, snapshot !== null);
    for (const waiter of [...this.#clockWaiters]) {
      if (waiter.generation !== round.generation || waiter.roundId !== round.id) continue;
      this.#settleClockWaiter(
        waiter,
        snapshot && Date.now() + snapshot.offsetMs <= waiter.serverDeadlineAtMs ? snapshot : null,
      );
    }
  }

  #closeClockCalibrationRound(round: ClockCalibrationRound, retainLateCandidates = false): void {
    for (const timer of round.timers) {
      clearTimeout(timer);
      this.#timers.delete(timer);
    }
    for (const requestId of round.requestIds) {
      const pending = this.#clockPending.get(requestId);
      if (retainLateCandidates && pending?.generation === this.#generation) {
        pending.source = 'ready-late';
        pending.expiresAtMs = Date.now() + CLOCK_LATE_RESPONSE_MAX_AGE_MS;
      } else {
        this.#clockPending.delete(requestId);
      }
    }
    round.timers.clear();
    round.requestIds.clear();
    if (this.#clockCalibrationRound === round) this.#clockCalibrationRound = null;
  }

  #scheduleClockRefresh(generation: number): void {
    this.#schedule(
      () => {
        this.#requestClockSample(null, 'refresh');
        this.#scheduleClockRefresh(generation);
      },
      CLOCK_REFRESH_MS,
      generation,
    );
  }

  #requestClockSample(
    roundId: number | null = null,
    source: ProRoomClockSnapshot['source'] = 'connection',
  ): number | null {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return null;
    const requestId = ++this.#clockRequestSequence;
    const clientSentAtMs = Date.now();
    const sentPerformanceMs = performance.now();
    this.#clockPending.set(requestId, {
      sentAtMs: clientSentAtMs,
      sentPerformanceMs,
      generation: this.#generation,
      roundId,
      source: roundId === null ? source : 'ready',
      expiresAtMs: clientSentAtMs + CLOCK_CANDIDATE_MAX_AGE_MS,
    });
    for (const [id, sample] of this.#clockPending) {
      if (sample.expiresAtMs !== null && clientSentAtMs > sample.expiresAtMs) {
        this.#clockPending.delete(id);
      }
    }
    while (this.#clockPending.size > 16) {
      const oldest = this.#clockPending.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#clockPending.delete(oldest);
    }
    recordProStartObservation('clock-request', {
      requestId,
      generation: this.#generation,
      roundId,
      source: roundId === null ? source : 'ready',
      sentAtMs: clientSentAtMs,
      sentPerformanceMs,
    });
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
      this.#clockConfirmed !== null &&
      this.isClockSnapshotCurrent(this.#clockConfirmed) &&
      this.#clockReadyCalibratedAtMs > 0 &&
      ageMs >= 0 &&
      ageMs <= CLOCK_READY_FRESHNESS_MS
    );
  }

  #settleClockWaiterAtBudget(waiter: ClockCalibrationWaiter): void {
    if (!this.#clockWaiters.has(waiter)) return;
    const round = this.#clockCalibrationRound;
    if (waiter.roundId === null) {
      this.#settleClockWaiter(waiter, null, 'timeout');
      return;
    }
    if (
      waiter.generation !== this.#generation ||
      !round ||
      round.id !== waiter.roundId ||
      round.generation !== waiter.generation
    ) {
      this.#settleClockWaiter(waiter, null, 'timeout');
      return;
    }
    if (!Number.isFinite(round.bestRttMs) || round.bestReceivedAtMs <= 0) {
      this.#settleClockWaiter(waiter, null, 'timeout');
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
    this.#settleClockWaiter(
      waiter,
      Date.now() + round.bestOffsetMs <= waiter.serverDeadlineAtMs ? round.bestSnapshot : null,
    );
  }

  #settleClockWaiters(snapshot: ProRoomClockSnapshot | null): void {
    for (const waiter of [...this.#clockWaiters]) {
      this.#settleClockWaiter(waiter, snapshot, 'disconnected');
    }
  }

  #settleClockWaiter(
    waiter: ClockCalibrationWaiter,
    snapshot: ProRoomClockSnapshot | null,
    reason = snapshot ? 'complete' : 'deadline',
  ): void {
    if (!this.#clockWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    this.#timers.delete(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    recordProStartObservation('clock-wait', {
      generation: waiter.generation,
      roundId: waiter.roundId,
      sampleId: snapshot?.sampleId ?? null,
      reason,
    });
    waiter.resolve(snapshot);

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

/** An immutable estimate owned by the current connected socket generation. */
export function captureProRoomServerClockSnapshot(): ProRoomClockSnapshot | null {
  return proRoomServerBridge.captureClockSnapshot();
}

export function isProRoomClockSnapshotCurrent(snapshot: ProRoomClockSnapshot): boolean {
  return proRoomServerBridge.isClockSnapshotCurrent(snapshot);
}

export function acquireProRoomServerClock(
  options: ProRoomClockAcquisitionOptions,
): Promise<ProRoomClockSnapshot | null> {
  return proRoomServerBridge.acquireClock(options);
}
