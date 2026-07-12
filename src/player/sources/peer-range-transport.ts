import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
  throwIfAborted,
} from './encoded-audio-source.ts';
import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import type {
  PeerRangeReadRequest,
  PeerRangeTransport,
} from './peer-range-encoded-audio-source.ts';
import {
  PEER_RANGE_MAX_CONNECTION_ID_LENGTH,
  PeerRangeAssemblerClosedError,
  PeerRangeProtocolError,
  PeerRangeRequestCancelledError,
  PeerRangeResponseAssembler,
  createPeerRangeCancelFrame,
  createPeerRangeChunkFrames,
  createPeerRangeCloseHandleFrame,
  createPeerRangeErrorFrame,
  createPeerRangeReadFrame,
  parsePeerRangeControlFrame,
  validatePeerRangeOpaqueId,
  type PeerRangeAssemblyStatus,
  type PeerRangeBulkFrame,
  type PeerRangeCancelFrame,
  type PeerRangeCloseHandleFrame,
  type PeerRangeControlFrame,
  type PeerRangeReadDescriptor,
  type PeerRangeReadFrame,
  type PeerRangeRemoteErrorCode,
} from './peer-range-protocol.ts';

const MAX_ACTIVE_REQUESTS = 64;
const MAX_DELIVERY_TASKS = 256;
const MAX_SOURCE_LEASES = 256;
const MAX_SETTLED_REQUESTS = 8_192;
const MAX_DELIVERY_TIMEOUT_MS = 60_000;
const MAX_TERMINAL_EGRESS_CREDITS = 256;
const MAX_TERMINAL_EGRESS_REFILL_MS = 60_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINAL_EGRESS_CREDITS = 128;
const DEFAULT_TERMINAL_EGRESS_REFILL_MS = 5;
let deliveryTimerSequence = 0;

type MaybePromise<T> = T | PromiseLike<T>;

export interface PeerRangeTrustedConnectionContext {
  /** Exact live DataConnection/RTC owner object; never derived from a frame. */
  readonly token: object;
  /** Locally assigned immutable correlation ID for that exact connection. */
  readonly connectionId: string;
}

const trustedConnectionContexts = new WeakSet<object>();

/**
 * Bind peer-range state to one live DataConnection identity.
 *
 * The owner must pass the actual connection object as `token`, route inbound
 * frames with that same object, and call transport/responder `close()` from
 * the connection's close/error lifecycle. A replacement DataConnection gets
 * a new token and new peer-range instances even if its string ID is reused.
 */
export function bindPeerRangeTrustedConnection(
  token: object,
  connectionId: string,
): PeerRangeTrustedConnectionContext {
  if ((typeof token !== 'object' || token === null) && typeof token !== 'function') {
    throw new TypeError('Peer range connection token must be an opaque object');
  }
  const context = Object.freeze({
    token,
    connectionId: validatePeerRangeOpaqueId(
      connectionId,
      'connectionId',
      PEER_RANGE_MAX_CONNECTION_ID_LENGTH,
    ),
  });
  trustedConnectionContexts.add(context);
  return context;
}

function assertTrustedContext(
  value: PeerRangeTrustedConnectionContext,
): PeerRangeTrustedConnectionContext {
  if (!value || !trustedConnectionContexts.has(value)) {
    throw new TypeError('Peer range trusted connection context must be bound locally');
  }
  return value;
}

function assertTrustedToken(context: PeerRangeTrustedConnectionContext, token: object): void {
  if (token !== context.token) {
    throw new PeerRangeProtocolError('Peer range frame was routed from a different connection');
  }
}

function descriptorKey(descriptor: PeerRangeReadDescriptor): string {
  return JSON.stringify([
    descriptor.connectionId,
    descriptor.sourceIdentity,
    descriptor.handleId,
    descriptor.requestId,
    descriptor.offset,
    descriptor.totalLength,
  ]);
}

function correlationKey(descriptor: PeerRangeReadDescriptor): string {
  return JSON.stringify([
    descriptor.connectionId,
    descriptor.sourceIdentity,
    descriptor.handleId,
    descriptor.requestId,
  ]);
}

function exactDescriptorMatch(
  left: PeerRangeReadDescriptor,
  right: PeerRangeReadDescriptor,
): boolean {
  return descriptorKey(left) === descriptorKey(right);
}

function configuredLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RangeError(`${label} must be a positive safe integer up to ${maximum}`);
  }
  return selected;
}

function configuredTimeout(value: number | undefined): number {
  return configuredLimit(
    value,
    DEFAULT_DELIVERY_TIMEOUT_MS,
    MAX_DELIVERY_TIMEOUT_MS,
    'deliveryTimeoutMs',
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Peer range request was aborted', 'AbortError');
}

function nextDeliveryTimerName(): string {
  deliveryTimerSequence =
    deliveryTimerSequence >= Number.MAX_SAFE_INTEGER ? 1 : deliveryTimerSequence + 1;
  return `peer-range-delivery:${deliveryTimerSequence.toString(36)}`;
}

function monotonicNow(): number {
  try {
    const now = globalThis.performance?.now();
    if (typeof now === 'number' && Number.isFinite(now)) return now;
  } catch {
    // Fall through to the local wall clock; a frozen fallback only denies refill.
  }
  try {
    const now = Date.now();
    return Number.isFinite(now) ? now : 0;
  } catch {
    return 0;
  }
}

export class PeerRangeConnectionFatalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'PeerRangeConnectionFatalError';
  }
}

export class PeerRangeDeliveryTimeoutError extends PeerRangeConnectionFatalError {
  constructor() {
    super('Peer range delivery did not settle before its deadline');
    this.name = 'PeerRangeDeliveryTimeoutError';
  }
}

interface DeliveryWaiter {
  readonly reject: (error: unknown) => void;
  readonly timerName: string;
  settled: boolean;
}

interface PhysicalDeliveryTask {
  promise: Promise<void> | null;
}

class LocalEgressCreditWindow {
  readonly #capacity: number;
  readonly #refillMs: number;
  #credits: number;
  #lastRefillAt = monotonicNow();

  constructor(capacity: number, refillMs: number) {
    this.#capacity = capacity;
    this.#credits = capacity;
    this.#refillMs = refillMs;
  }

  consume(): boolean {
    const now = monotonicNow();
    if (now >= this.#lastRefillAt) {
      const elapsed = now - this.#lastRefillAt;
      const restored = Math.floor(elapsed / this.#refillMs);
      if (restored > 0) {
        this.#credits = Math.min(this.#capacity, this.#credits + restored);
        this.#lastRefillAt += restored * this.#refillMs;
      }
    } else {
      // A local clock discontinuity never grants attacker-controlled credit.
      this.#lastRefillAt = now;
    }
    if (this.#credits <= 0) return false;
    this.#credits -= 1;
    return true;
  }
}

/** Tracks raw callback promises until they physically settle, even after quarantine. */
class BoundedDeliveryTracker<TFrame> {
  readonly #send: (frame: TFrame) => MaybePromise<void>;
  readonly #canSend: (frame: TFrame) => boolean;
  readonly #onFatal: (error: Error) => void;
  readonly #maxTasks: number;
  readonly #timeoutMs: number;
  readonly #tasks = new Set<PhysicalDeliveryTask>();
  readonly #waiters = new Set<DeliveryWaiter>();
  readonly #terminalCredits: LocalEgressCreditWindow;
  #quarantined = false;
  #quarantinedReason: unknown = null;

  constructor(options: {
    readonly send: (frame: TFrame) => MaybePromise<void>;
    readonly canSend: (frame: TFrame) => boolean;
    readonly onFatal: (error: Error) => void;
    readonly maxTasks: number;
    readonly timeoutMs: number;
    readonly terminalEgressCredits: number;
    readonly terminalEgressRefillMs: number;
  }) {
    this.#send = options.send;
    this.#canSend = options.canSend;
    this.#onFatal = options.onFatal;
    this.#maxTasks = options.maxTasks;
    this.#timeoutMs = options.timeoutMs;
    this.#terminalCredits = new LocalEgressCreditWindow(
      options.terminalEgressCredits,
      options.terminalEgressRefillMs,
    );
  }

  get physicalTaskCount(): number {
    return this.#tasks.size;
  }

  deliver(frame: TFrame, terminal = false): Promise<void> {
    if (this.#quarantined) {
      return Promise.reject(this.#quarantinedReason);
    }
    if (this.#tasks.size >= this.#maxTasks) {
      const error = new PeerRangeConnectionFatalError(
        'Peer range delivery task capacity was exhausted',
      );
      this.#onFatal(error);
      return Promise.reject(error);
    }

    // Reserve before either product callback. Both callbacks may synchronously
    // reenter close(), fatal handling, or another delivery attempt.
    const physicalTask: PhysicalDeliveryTask = { promise: null };
    this.#tasks.add(physicalTask);

    if (terminal && !this.#terminalCredits.consume()) {
      this.#tasks.delete(physicalTask);
      const error = new PeerRangeConnectionFatalError(
        'Peer range terminal egress credit was exhausted',
      );
      this.#onFatal(error);
      return Promise.reject(error);
    }
    let permitted: boolean;
    try {
      permitted = this.#canSend(frame) === true;
    } catch (cause) {
      this.#tasks.delete(physicalTask);
      if (this.#quarantined) return Promise.reject(this.#quarantinedReason);
      const error = new PeerRangeConnectionFatalError(
        'Peer range channel backpressure check failed',
        cause,
      );
      this.#onFatal(error);
      return Promise.reject(error);
    }
    if (this.#quarantined) {
      this.#tasks.delete(physicalTask);
      return Promise.reject(this.#quarantinedReason);
    }
    if (!permitted) {
      this.#tasks.delete(physicalTask);
      const error = new PeerRangeConnectionFatalError(
        'Peer range channel cannot accept bounded delivery',
      );
      this.#onFatal(error);
      return Promise.reject(error);
    }

    let outcome: MaybePromise<void>;
    try {
      outcome = this.#send(frame);
    } catch (error) {
      this.#tasks.delete(physicalTask);
      if (this.#quarantined) return Promise.reject(this.#quarantinedReason);
      const fatal = new PeerRangeConnectionFatalError('Peer range delivery threw', error);
      this.#onFatal(fatal);
      return Promise.reject(fatal);
    }
    if ((typeof outcome !== 'object' || outcome === null) && typeof outcome !== 'function') {
      this.#tasks.delete(physicalTask);
      return this.#quarantined ? Promise.reject(this.#quarantinedReason) : Promise.resolve();
    }
    let task: Promise<void>;
    try {
      task = Promise.resolve(outcome);
    } catch (cause) {
      this.#tasks.delete(physicalTask);
      if (this.#quarantined) return Promise.reject(this.#quarantinedReason);
      const fatal = new PeerRangeConnectionFatalError(
        'Peer range delivery promise registration failed',
        cause,
      );
      this.#onFatal(fatal);
      return Promise.reject(fatal);
    }

    physicalTask.promise = task;
    void task.then(
      () => this.#tasks.delete(physicalTask),
      () => this.#tasks.delete(physicalTask),
    );
    if (this.#quarantined) return Promise.reject(this.#quarantinedReason);

    return new Promise<void>((resolve, reject) => {
      const timerName = nextDeliveryTimerName();
      const waiter: DeliveryWaiter = {
        reject,
        timerName,
        settled: false,
      };
      setManagedTimer(
        timerName,
        () => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#waiters.delete(waiter);
          const error = new PeerRangeDeliveryTimeoutError();
          reject(error);
          this.#onFatal(error);
        },
        this.#timeoutMs,
      );
      this.#waiters.add(waiter);
      void task.then(
        () => {
          if (waiter.settled) return;
          waiter.settled = true;
          clearManagedTimer(waiter.timerName);
          this.#waiters.delete(waiter);
          resolve();
        },
        (error: unknown) => {
          if (waiter.settled) return;
          waiter.settled = true;
          clearManagedTimer(waiter.timerName);
          this.#waiters.delete(waiter);
          const fatal = new PeerRangeConnectionFatalError('Peer range delivery rejected', error);
          reject(fatal);
          this.#onFatal(fatal);
        },
      );
    });
  }

  quarantine(reason: unknown): void {
    if (this.#quarantined) return;
    this.#quarantined = true;
    this.#quarantinedReason = reason;
    for (const waiter of this.#waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      clearManagedTimer(waiter.timerName);
      waiter.reject(reason);
    }
    this.#waiters.clear();
  }
}

interface ClientRequestState {
  readonly descriptor: PeerRangeReadFrame;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

export interface FramedPeerRangeClientTransportOptions {
  readonly connection: PeerRangeTrustedConnectionContext;
  /** Must close the exact DataConnection captured by `connection.token`. */
  readonly onFatalConnection: (
    connection: PeerRangeTrustedConnectionContext,
    error: PeerRangeConnectionFatalError,
  ) => void;
  /**
   * Synchronous gate over the exact captured channel's readyState and
   * bufferedAmount. Production adapters must not implement this as a constant.
   */
  readonly canSend: (
    connection: PeerRangeTrustedConnectionContext,
    frame: PeerRangeControlFrame,
  ) => boolean;
  readonly sendControl: (frame: PeerRangeControlFrame) => MaybePromise<void>;
  readonly maxActiveRequests?: number;
  readonly maxRetainedBytes?: number;
  readonly maxSettledRequests?: number;
  readonly maxDeliveryTasks?: number;
  readonly deliveryTimeoutMs?: number;
  readonly terminalEgressCredits?: number;
  readonly terminalEgressRefillMs?: number;
}

/** Client half of exact bounded peer range reads for one DataConnection. */
export class FramedPeerRangeClientTransport implements PeerRangeTransport {
  readonly #connection: PeerRangeTrustedConnectionContext;
  readonly #onFatalConnection: FramedPeerRangeClientTransportOptions['onFatalConnection'];
  readonly #assembler: PeerRangeResponseAssembler;
  readonly #deliveries: BoundedDeliveryTracker<PeerRangeControlFrame>;
  readonly #active = new Map<string, ClientRequestState>();
  #closed = false;
  #fatalError: PeerRangeConnectionFatalError | null = null;

  constructor(options: FramedPeerRangeClientTransportOptions) {
    if (typeof options.sendControl !== 'function') {
      throw new TypeError('Peer range control sender is required');
    }
    if (typeof options.onFatalConnection !== 'function') {
      throw new TypeError('Peer range fatal connection callback is required');
    }
    if (typeof options.canSend !== 'function') {
      throw new TypeError('Peer range channel backpressure callback is required');
    }
    this.#connection = assertTrustedContext(options.connection);
    this.#onFatalConnection = options.onFatalConnection;
    this.#assembler = new PeerRangeResponseAssembler({
      connectionId: this.#connection.connectionId,
      maxActiveRequests: options.maxActiveRequests,
      maxRetainedBytes: options.maxRetainedBytes,
      maxSettledRequests: options.maxSettledRequests,
    });
    this.#deliveries = new BoundedDeliveryTracker({
      send: options.sendControl,
      canSend: (frame) => options.canSend(this.#connection, frame),
      onFatal: (error) => this.#fatal(error),
      maxTasks: configuredLimit(
        options.maxDeliveryTasks,
        16,
        MAX_DELIVERY_TASKS,
        'maxDeliveryTasks',
      ),
      timeoutMs: configuredTimeout(options.deliveryTimeoutMs),
      terminalEgressCredits: configuredLimit(
        options.terminalEgressCredits,
        DEFAULT_TERMINAL_EGRESS_CREDITS,
        MAX_TERMINAL_EGRESS_CREDITS,
        'terminalEgressCredits',
      ),
      terminalEgressRefillMs: configuredLimit(
        options.terminalEgressRefillMs,
        DEFAULT_TERMINAL_EGRESS_REFILL_MS,
        MAX_TERMINAL_EGRESS_REFILL_MS,
        'terminalEgressRefillMs',
      ),
    });
  }

  get activeRequestCount(): number {
    return this.#assembler.activeRequestCount;
  }

  get retainedByteLength(): number {
    return this.#assembler.retainedByteLength;
  }

  get settledRequestCount(): number {
    return this.#assembler.settledRequestCount;
  }

  get physicalDeliveryTaskCount(): number {
    return this.#deliveries.physicalTaskCount;
  }

  async read(request: PeerRangeReadRequest): Promise<Uint8Array> {
    if (this.#closed) throw this.#fatalError ?? new PeerRangeAssemblerClosedError();
    throwIfAborted(request.signal);

    const descriptor = createPeerRangeReadFrame({
      connectionId: this.#connection.connectionId,
      sourceIdentity: request.sourceIdentity,
      handleId: request.handleId,
      requestId: request.requestId,
      offset: request.offset,
      totalLength: request.length,
    });
    const key = descriptorKey(descriptor);
    const state: ClientRequestState = {
      descriptor,
      signal: request.signal,
      onAbort: () => this.#cancel(state, abortReason(request.signal), true),
    };
    const response = this.#assembler.open(descriptor, request.signal);
    this.#active.set(key, state);
    request.signal.addEventListener('abort', state.onAbort, { once: true });

    void this.#deliveries.deliver(descriptor, true).catch(() => undefined);
    try {
      return await response;
    } finally {
      request.signal.removeEventListener('abort', state.onAbort);
      if (this.#active.get(key) === state) this.#active.delete(key);
    }
  }

  acceptBulk(token: object, value: unknown): PeerRangeAssemblyStatus {
    assertTrustedToken(this.#connection, token);
    return this.#assembler.accept(value);
  }

  closeHandle(handleId: string, sourceIdentity: string): void {
    for (const state of [...this.#active.values()]) {
      if (
        state.descriptor.handleId === handleId &&
        state.descriptor.sourceIdentity === sourceIdentity
      ) {
        this.#cancel(state, new PeerRangeRequestCancelledError(), true);
      }
    }
    if (!this.#closed && !this.#fatalError) {
      const closeHandle = createPeerRangeCloseHandleFrame({
        connectionId: this.#connection.connectionId,
        sourceIdentity,
        handleId,
      });
      void this.#deliveries.deliver(closeHandle, true).catch(() => undefined);
    }
  }

  close(reason: unknown = new PeerRangeAssemblerClosedError()): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#deliveries.quarantine(reason);
    for (const state of [...this.#active.values()]) this.#cancel(state, reason, false);
    this.#assembler.close(reason);
  }

  #cancel(state: ClientRequestState, reason: unknown, sendRemote: boolean): void {
    const key = descriptorKey(state.descriptor);
    if (this.#active.get(key) !== state) return;
    this.#active.delete(key);
    state.signal.removeEventListener('abort', state.onAbort);
    this.#assembler.cancel(state.descriptor, reason);
    if (sendRemote && !this.#closed && !this.#fatalError) {
      const cancel = createPeerRangeCancelFrame(state.descriptor);
      void this.#deliveries.deliver(cancel, true).catch(() => undefined);
    }
  }

  #fatal(error: Error): void {
    if (this.#fatalError) return;
    const fatal =
      error instanceof PeerRangeConnectionFatalError
        ? error
        : new PeerRangeConnectionFatalError('Peer range connection failed', error);
    this.#fatalError = fatal;
    this.#closed = true;
    for (const state of this.#active.values()) {
      state.signal.removeEventListener('abort', state.onAbort);
    }
    this.#active.clear();
    this.#assembler.close(fatal);
    this.#deliveries.quarantine(fatal);
    try {
      this.#onFatalConnection(this.#connection, fatal);
    } catch {
      // Local state is already quarantined; the callback cannot reopen it.
    }
  }
}

export type PeerRangeHostSource = EncodedAudioSource | Blob;

export interface PeerRangeHostSourceRegistryProvider {
  resolve(
    sourceIdentity: string,
    signal: AbortSignal,
  ): MaybePromise<PeerRangeHostSource | null | undefined>;
}

export type PeerRangeHostControlStatus =
  | 'accepted'
  | 'cancelled'
  | 'duplicate'
  | 'ignored'
  | 'rejected'
  | 'replayed'
  | 'revoked';

export interface PeerRangeHostResponderOptions {
  readonly connection: PeerRangeTrustedConnectionContext;
  readonly sources: PeerRangeHostSourceRegistryProvider;
  /** Must close the exact DataConnection captured by `connection.token`. */
  readonly onFatalConnection: (
    connection: PeerRangeTrustedConnectionContext,
    error: PeerRangeConnectionFatalError,
  ) => void;
  /**
   * Synchronous gate over the exact captured channel's readyState and
   * bufferedAmount. Production adapters must not implement this as a constant.
   */
  readonly canSend: (
    connection: PeerRangeTrustedConnectionContext,
    frame: PeerRangeBulkFrame,
  ) => boolean;
  readonly sendBulk: (frame: PeerRangeBulkFrame) => MaybePromise<void>;
  /** Physical resolver/read/send jobs, not merely logical active descriptors. */
  readonly maxActiveRequests?: number;
  readonly maxSettledRequests?: number;
  readonly maxDeliveryTasks?: number;
  readonly maxSourceLeases?: number;
  readonly maxRevokedHandleClaims?: number;
  readonly deliveryTimeoutMs?: number;
  readonly terminalEgressCredits?: number;
  readonly terminalEgressRefillMs?: number;
}

interface HostSourceLease {
  readonly handleId: string;
  readonly sourceIdentity: string;
  readonly controller: AbortController;
  resolvePromise: Promise<PeerRangeHostSource> | null;
  source: PeerRangeHostSource | null;
  size: number | null;
  physicalTaskCount: number;
  revoked: boolean;
}

interface HostRequestState {
  readonly descriptor: PeerRangeReadFrame;
  readonly correlationKey: string;
  readonly controller: AbortController;
  readonly lease: HostSourceLease;
}

function isEncodedAudioSource(value: PeerRangeHostSource): value is EncodedAudioSource {
  return !(value instanceof Blob);
}

function sourceByteLength(source: PeerRangeHostSource): number {
  const size = source.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new EncodedSourceIntegrityError('Peer range source has an invalid byte length');
  }
  return size;
}

function validatePinnedSource(
  source: PeerRangeHostSource | null | undefined,
  sourceIdentity: string,
): PeerRangeHostSource {
  if (!source) throw new PeerRangeSourceNotFoundError();
  if (isEncodedAudioSource(source)) {
    if (source.identity !== sourceIdentity) {
      throw new EncodedSourceIntegrityError('Source registry returned a different identity');
    }
    if (typeof source.readAt !== 'function') {
      throw new EncodedSourceIntegrityError('Source registry returned an unreadable source');
    }
  }
  sourceByteLength(source);
  return source;
}

class PeerRangeSourceNotFoundError extends Error {
  constructor() {
    super('Requested audio source was not found');
    this.name = 'PeerRangeSourceNotFoundError';
  }
}

function remoteError(error: unknown): {
  readonly code: PeerRangeRemoteErrorCode;
  readonly message: string;
} {
  if (error instanceof EncodedSourceRangeError || error instanceof RangeError) {
    return { code: 'range', message: 'Requested byte range is unavailable' };
  }
  if (error instanceof EncodedSourceIntegrityError) {
    return { code: 'integrity', message: 'Source bytes failed exact validation' };
  }
  if (error instanceof EncodedSourceClosedError) {
    return { code: 'unavailable', message: 'Source is temporarily unavailable' };
  }
  if (error instanceof PeerRangeSourceNotFoundError) {
    return { code: 'not-found', message: 'Requested audio source was not found' };
  }
  return { code: 'internal', message: 'Peer range read failed' };
}

/** Host half of bounded peer range reads for one exact DataConnection. */
export class PeerRangeHostResponder {
  readonly #connection: PeerRangeTrustedConnectionContext;
  readonly #sources: PeerRangeHostSourceRegistryProvider;
  readonly #onFatalConnection: PeerRangeHostResponderOptions['onFatalConnection'];
  readonly #deliveries: BoundedDeliveryTracker<PeerRangeBulkFrame>;
  readonly #maxPhysicalReadTasks: number;
  readonly #maxSettledRequests: number;
  readonly #maxSourceLeases: number;
  readonly #maxRevokedHandleClaims: number;
  readonly #active = new Map<string, HostRequestState>();
  readonly #physicalReadTasks = new Set<Promise<void>>();
  readonly #settled = new Map<string, string>();
  readonly #leases = new Map<string, HostSourceLease>();
  readonly #revokedHandleClaims = new Map<string, string>();
  #closed = false;
  #fatalError: PeerRangeConnectionFatalError | null = null;

  constructor(options: PeerRangeHostResponderOptions) {
    if (!options.sources || typeof options.sources.resolve !== 'function') {
      throw new TypeError('Peer range source registry provider is required');
    }
    if (typeof options.sendBulk !== 'function') {
      throw new TypeError('Peer range bulk sender is required');
    }
    if (typeof options.onFatalConnection !== 'function') {
      throw new TypeError('Peer range fatal connection callback is required');
    }
    if (typeof options.canSend !== 'function') {
      throw new TypeError('Peer range channel backpressure callback is required');
    }
    this.#connection = assertTrustedContext(options.connection);
    this.#sources = options.sources;
    this.#onFatalConnection = options.onFatalConnection;
    this.#maxPhysicalReadTasks = configuredLimit(
      options.maxActiveRequests,
      8,
      MAX_ACTIVE_REQUESTS,
      'maxActiveRequests',
    );
    this.#maxSettledRequests = configuredLimit(
      options.maxSettledRequests,
      512,
      MAX_SETTLED_REQUESTS,
      'maxSettledRequests',
    );
    this.#maxSourceLeases = configuredLimit(
      options.maxSourceLeases,
      32,
      MAX_SOURCE_LEASES,
      'maxSourceLeases',
    );
    this.#maxRevokedHandleClaims = configuredLimit(
      options.maxRevokedHandleClaims,
      512,
      MAX_SETTLED_REQUESTS,
      'maxRevokedHandleClaims',
    );
    this.#deliveries = new BoundedDeliveryTracker({
      send: options.sendBulk,
      canSend: (frame) => options.canSend(this.#connection, frame),
      onFatal: (error) => this.#fatal(error),
      maxTasks: configuredLimit(
        options.maxDeliveryTasks,
        16,
        MAX_DELIVERY_TASKS,
        'maxDeliveryTasks',
      ),
      timeoutMs: configuredTimeout(options.deliveryTimeoutMs),
      terminalEgressCredits: configuredLimit(
        options.terminalEgressCredits,
        DEFAULT_TERMINAL_EGRESS_CREDITS,
        MAX_TERMINAL_EGRESS_CREDITS,
        'terminalEgressCredits',
      ),
      terminalEgressRefillMs: configuredLimit(
        options.terminalEgressRefillMs,
        DEFAULT_TERMINAL_EGRESS_REFILL_MS,
        MAX_TERMINAL_EGRESS_REFILL_MS,
        'terminalEgressRefillMs',
      ),
    });
  }

  get activeRequestCount(): number {
    return this.#active.size;
  }

  get physicalReadTaskCount(): number {
    return this.#physicalReadTasks.size;
  }

  get physicalDeliveryTaskCount(): number {
    return this.#deliveries.physicalTaskCount;
  }

  get settledRequestCount(): number {
    return this.#settled.size;
  }

  get sourceLeaseCount(): number {
    return this.#leases.size;
  }

  acceptControl(token: object, value: unknown): PeerRangeHostControlStatus {
    assertTrustedToken(this.#connection, token);
    if (this.#closed) return 'ignored';
    const frame = parsePeerRangeControlFrame(value);
    if (frame.connectionId !== this.#connection.connectionId) {
      throw new PeerRangeProtocolError('Peer range frame claimed a different connection');
    }
    if (frame.type === 'read') return this.#acceptRead(frame);
    if (frame.type === 'cancel') return this.#acceptCancel(frame);
    return this.#acceptCloseHandle(frame);
  }

  revokeHandle(
    token: object,
    handleId: string,
    sourceIdentity: string,
    reason: unknown = new PeerRangeRequestCancelledError(),
  ): boolean {
    assertTrustedToken(this.#connection, token);
    if (this.#closed) return false;
    const canonical = createPeerRangeCloseHandleFrame({
      connectionId: this.#connection.connectionId,
      sourceIdentity,
      handleId,
    });
    const lease = this.#leases.get(canonical.handleId);
    if (!lease) {
      return this.#rememberRevokedHandle(canonical.handleId, canonical.sourceIdentity);
    }
    if (lease.sourceIdentity !== canonical.sourceIdentity) return false;
    if (lease.revoked) return true;
    this.#revokeLease(lease, reason);
    return !this.#fatalError;
  }

  close(reason: unknown = new EncodedSourceClosedError()): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#deliveries.quarantine(reason);
    for (const state of this.#active.values()) state.controller.abort(reason);
    this.#active.clear();
    for (const lease of this.#leases.values()) {
      lease.revoked = true;
      lease.controller.abort(reason);
    }
    this.#leases.clear();
  }

  #acceptRead(frame: PeerRangeReadFrame): PeerRangeHostControlStatus {
    const key = correlationKey(frame);
    const exact = descriptorKey(frame);
    const active = this.#active.get(key);
    if (active) {
      if (exactDescriptorMatch(active.descriptor, frame)) return 'duplicate';
      this.#sendError(frame, 'integrity', 'Request identity was reused with a different range');
      return 'rejected';
    }
    const settled = this.#settled.get(key);
    if (settled !== undefined) {
      if (settled === exact) {
        this.#sendError(frame, 'unavailable', 'Request was already settled');
        return 'replayed';
      }
      this.#sendError(frame, 'integrity', 'Request identity was reused with a different range');
      return 'rejected';
    }
    if (this.#physicalReadTasks.size >= this.#maxPhysicalReadTasks) {
      this.#rememberSettled(frame);
      this.#sendError(frame, 'unavailable', 'Peer range request capacity was reached');
      return 'rejected';
    }

    const lease = this.#claimLease(frame);
    if (!lease) return 'rejected';
    const state: HostRequestState = {
      descriptor: frame,
      correlationKey: key,
      controller: new AbortController(),
      lease,
    };
    lease.physicalTaskCount += 1;
    this.#active.set(key, state);
    const task = this.#serve(state);
    this.#physicalReadTasks.add(task);
    void task.then(
      () => this.#releasePhysicalReadTask(task, lease),
      () => this.#releasePhysicalReadTask(task, lease),
    );
    return 'accepted';
  }

  #acceptCancel(frame: PeerRangeCancelFrame): PeerRangeHostControlStatus {
    const state = this.#active.get(correlationKey(frame));
    if (!state || !exactDescriptorMatch(state.descriptor, frame)) return 'ignored';
    this.#settle(state);
    state.controller.abort(new PeerRangeRequestCancelledError());
    return 'cancelled';
  }

  #acceptCloseHandle(frame: PeerRangeCloseHandleFrame): PeerRangeHostControlStatus {
    const lease = this.#leases.get(frame.handleId);
    if (lease) {
      if (lease.sourceIdentity !== frame.sourceIdentity || lease.revoked) return 'ignored';
      this.#revokeLease(lease, new PeerRangeRequestCancelledError());
      return this.#closed ? 'rejected' : 'revoked';
    }
    const revokedIdentity = this.#revokedHandleClaims.get(frame.handleId);
    if (revokedIdentity !== undefined) {
      return revokedIdentity === frame.sourceIdentity ? 'revoked' : 'ignored';
    }
    return this.#rememberRevokedHandle(frame.handleId, frame.sourceIdentity)
      ? 'revoked'
      : 'rejected';
  }

  #revokeLease(lease: HostSourceLease, reason: unknown): void {
    lease.revoked = true;
    lease.controller.abort(reason);
    for (const state of [...this.#active.values()]) {
      if (state.lease === lease) {
        this.#settle(state);
        state.controller.abort(reason);
      }
    }
    if (lease.physicalTaskCount === 0) this.#releaseRevokedLease(lease);
  }

  #claimLease(frame: PeerRangeReadFrame): HostSourceLease | null {
    const existing = this.#leases.get(frame.handleId);
    if (existing) {
      if (existing.sourceIdentity !== frame.sourceIdentity || existing.revoked) {
        this.#rememberSettled(frame);
        this.#sendError(frame, 'integrity', 'Handle is pinned to a different source');
        return null;
      }
      return existing;
    }
    const revokedIdentity = this.#revokedHandleClaims.get(frame.handleId);
    if (revokedIdentity !== undefined) {
      this.#rememberSettled(frame);
      this.#sendError(frame, 'integrity', 'Handle was already revoked');
      return null;
    }
    if (this.#leases.size >= this.#maxSourceLeases) {
      this.#rememberSettled(frame);
      this.#sendError(frame, 'unavailable', 'Peer range source lease capacity was reached');
      return null;
    }
    const lease: HostSourceLease = {
      handleId: frame.handleId,
      sourceIdentity: frame.sourceIdentity,
      controller: new AbortController(),
      resolvePromise: null,
      source: null,
      size: null,
      physicalTaskCount: 0,
      revoked: false,
    };
    this.#leases.set(frame.handleId, lease);
    return lease;
  }

  async #serve(state: HostRequestState): Promise<void> {
    try {
      const source = await this.#resolveLease(state.lease);
      if (!this.#isCurrent(state)) return;
      const size = state.lease.size;
      if (size === null || source !== state.lease.source || sourceByteLength(source) !== size) {
        this.#fail(state, 'integrity', 'Pinned source changed during the connection');
        return;
      }
      if (isEncodedAudioSource(source) && source.identity !== state.lease.sourceIdentity) {
        this.#fail(state, 'integrity', 'Pinned source identity changed during the connection');
        return;
      }

      const end = state.descriptor.offset + state.descriptor.totalLength;
      if (!Number.isSafeInteger(end) || end > size) {
        this.#fail(state, 'range', 'Requested byte range exceeds the source');
        return;
      }
      const bytes = await this.#readExact(source, state);
      if (!this.#isCurrent(state)) return;
      if (bytes.byteLength !== state.descriptor.totalLength) {
        this.#fail(state, 'integrity', 'Source returned a short byte range');
        return;
      }

      const frames = createPeerRangeChunkFrames(state.descriptor, bytes);
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index]!;
        if (!this.#isCurrent(state)) return;
        await this.#deliveries.deliver(frame, index === frames.length - 1);
      }
      this.#settle(state);
    } catch (error) {
      if (!this.#isCurrent(state) || state.controller.signal.aborted || this.#fatalError) return;
      const remote = remoteError(error);
      this.#fail(state, remote.code, remote.message);
    }
  }

  #resolveLease(lease: HostSourceLease): Promise<PeerRangeHostSource> {
    if (lease.source) return Promise.resolve(lease.source);
    if (lease.resolvePromise) return lease.resolvePromise;
    lease.resolvePromise = Promise.resolve()
      .then(() => this.#sources.resolve(lease.sourceIdentity, lease.controller.signal))
      .then((candidate) => {
        throwIfAborted(lease.controller.signal);
        if (lease.revoked || this.#closed) throw new EncodedSourceClosedError();
        const source = validatePinnedSource(candidate, lease.sourceIdentity);
        lease.source = source;
        lease.size = sourceByteLength(source);
        return source;
      });
    return lease.resolvePromise;
  }

  async #readExact(source: PeerRangeHostSource, state: HostRequestState): Promise<Uint8Array> {
    throwIfAborted(state.controller.signal);
    if (isEncodedAudioSource(source)) {
      const bytes = await source.readAt(
        state.descriptor.offset,
        state.descriptor.totalLength,
        state.controller.signal,
      );
      throwIfAborted(state.controller.signal);
      return bytes;
    }
    const end = state.descriptor.offset + state.descriptor.totalLength;
    const buffer = await source.slice(state.descriptor.offset, end).arrayBuffer();
    throwIfAborted(state.controller.signal);
    return new Uint8Array(buffer);
  }

  #isCurrent(state: HostRequestState): boolean {
    return (
      !this.#closed && !state.lease.revoked && this.#active.get(state.correlationKey) === state
    );
  }

  #settle(state: HostRequestState): boolean {
    if (this.#active.get(state.correlationKey) !== state) return false;
    this.#active.delete(state.correlationKey);
    this.#rememberSettled(state.descriptor);
    return true;
  }

  #fail(state: HostRequestState, code: PeerRangeRemoteErrorCode, message: string): void {
    if (!this.#settle(state)) return;
    this.#sendError(state.descriptor, code, message);
  }

  #sendError(
    descriptor: PeerRangeReadDescriptor,
    code: PeerRangeRemoteErrorCode,
    message: string,
  ): void {
    if (this.#closed) return;
    const frame = createPeerRangeErrorFrame(descriptor, code, message);
    void this.#deliveries.deliver(frame, true).catch(() => undefined);
  }

  #releasePhysicalReadTask(task: Promise<void>, lease: HostSourceLease): void {
    this.#physicalReadTasks.delete(task);
    lease.physicalTaskCount = Math.max(0, lease.physicalTaskCount - 1);
    if (lease.revoked && lease.physicalTaskCount === 0) this.#releaseRevokedLease(lease);
  }

  #releaseRevokedLease(lease: HostSourceLease): void {
    if (this.#leases.get(lease.handleId) !== lease) return;
    this.#leases.delete(lease.handleId);
    this.#rememberRevokedHandle(lease.handleId, lease.sourceIdentity);
  }

  #rememberRevokedHandle(handleId: string, sourceIdentity: string): boolean {
    const existing = this.#revokedHandleClaims.get(handleId);
    if (existing !== undefined) return existing === sourceIdentity;
    if (this.#revokedHandleClaims.size >= this.#maxRevokedHandleClaims) {
      this.#fatal(
        new PeerRangeConnectionFatalError(
          'Peer range revoked-handle tombstone capacity was exhausted',
        ),
      );
      return false;
    }
    this.#revokedHandleClaims.set(handleId, sourceIdentity);
    return true;
  }

  #rememberSettled(descriptor: PeerRangeReadDescriptor): void {
    const key = correlationKey(descriptor);
    this.#settled.delete(key);
    this.#settled.set(key, descriptorKey(descriptor));
    while (this.#settled.size > this.#maxSettledRequests) {
      const oldest = this.#settled.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#settled.delete(oldest);
    }
  }

  #fatal(error: Error): void {
    if (this.#fatalError) return;
    const fatal =
      error instanceof PeerRangeConnectionFatalError
        ? error
        : new PeerRangeConnectionFatalError('Peer range connection failed', error);
    this.#fatalError = fatal;
    this.#closed = true;
    for (const state of this.#active.values()) state.controller.abort(fatal);
    this.#active.clear();
    for (const lease of this.#leases.values()) {
      lease.revoked = true;
      lease.controller.abort(fatal);
    }
    this.#leases.clear();
    this.#deliveries.quarantine(fatal);
    try {
      this.#onFatalConnection(this.#connection, fatal);
    } catch {
      // The exact connection is already quarantined.
    }
  }
}
