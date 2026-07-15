import {
  EncodedSourceBusyError,
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { confirmFilePlaybackUniversalLifecycleRetirement } from '../diagnostics/file-playback-universal-lifecycle-retirement.ts';

export const ENCODED_SOURCE_PORT_MAX_READ_BYTES = 64 * 1024;
export const ENCODED_SOURCE_PORT_DEFAULT_MAX_PHYSICAL_READS = 8;
export const ENCODED_SOURCE_PORT_MAX_PHYSICAL_READS = 64;
export const ENCODED_SOURCE_PORT_DEFAULT_MAX_PENDING_READS = 1;
export const ENCODED_SOURCE_PORT_MAX_PENDING_READS = 8;
const ENCODED_SOURCE_PORT_DEFAULT_MAX_CANCELLED_READS = 8;
export const ENCODED_SOURCE_PORT_MAX_CANCELLED_READS = 64;
export const ENCODED_SOURCE_PORT_DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
export const ENCODED_SOURCE_PORT_MAX_RESPONSE_TIMEOUT_MS = 5 * 60_000;

const READ_TYPE = 'encoded-source:read';
const CANCEL_TYPE = 'encoded-source:cancel';
const SETTLE_ACK_TYPE = 'encoded-source:settle-ack';
const CLOSE_TYPE = 'encoded-source:close';
const RESULT_TYPE = 'encoded-source:result';
const ERROR_TYPE = 'encoded-source:error';
const CANCEL_ACK_TYPE = 'encoded-source:cancel-ack';
const CLOSED_TYPE = 'encoded-source:closed';

export type EncodedSourcePortErrorCode =
  | 'aborted'
  | 'busy'
  | 'closed'
  | 'integrity'
  | 'protocol'
  | 'range'
  | 'read-failed';

type EncodedSourcePortReadErrorCode = Exclude<EncodedSourcePortErrorCode, 'protocol'>;

const READ_ERROR_CODES = new Set<EncodedSourcePortReadErrorCode>([
  'aborted',
  'busy',
  'closed',
  'integrity',
  'range',
  'read-failed',
]);

const ERROR_MESSAGES: Readonly<Record<EncodedSourcePortErrorCode, string>> = Object.freeze({
  aborted: 'Encoded source port read was aborted',
  busy: 'Encoded source port read capacity is exhausted',
  closed: 'Encoded source port is closed',
  integrity: 'Encoded source port returned invalid bytes',
  protocol: 'Encoded source port protocol violation',
  range: 'Encoded source port read is outside the source range',
  'read-failed': 'Encoded source port read failed',
});

export class EncodedSourcePortError extends Error {
  readonly code: EncodedSourcePortErrorCode;

  constructor(code: EncodedSourcePortErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'EncodedSourcePortError';
    this.code = code;
  }
}

type PortRecord = Readonly<Record<string, unknown>>;

function canonicalRecord(entries: Record<string, unknown>): PortRecord {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, entries));
}

/**
 * Snapshot an exact ordinary record without invoking accessors.
 *
 * Real MessagePorts deliver fresh ordinary structured-clone objects. Requiring
 * an ordinary/null prototype plus own enumerable data properties keeps fake
 * ports and future same-realm adapters subject to the same trust boundary.
 */
function snapshotOwnDataRecord(value: unknown): PortRecord | null {
  if (typeof value !== 'object' || value === null) return null;

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== null && prototype !== Object.prototype) return null;

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || Object.prototype.hasOwnProperty.call(snapshot, key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function hasExactKeys(record: PortRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const ArrayBufferIntrinsic = ArrayBuffer;
const Uint8ArrayIntrinsic = Uint8Array;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBufferIntrinsic.prototype,
  'byteLength',
)?.get;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;

function exactArrayBufferByteLength(value: unknown): number | null {
  if (!arrayBufferByteLengthGetter || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }
  try {
    return arrayBufferByteLengthGetter.call(value);
  } catch {
    return null;
  }
}

function copyExactArrayBuffer(value: unknown, expectedLength: number): Uint8Array | null {
  const capturedLength = exactArrayBufferByteLength(value);
  if (capturedLength !== expectedLength) return null;
  try {
    const view = new Uint8ArrayIntrinsic(value as ArrayBuffer, 0, capturedLength);
    const copy = new Uint8ArrayIntrinsic(capturedLength);
    uint8ArraySet.call(copy, view, 0);
    return copy;
  } catch {
    return null;
  }
}

function copyExactSourceBytes(value: unknown, expectedLength: number): Uint8Array | null {
  if (!(value instanceof Uint8ArrayIntrinsic) || !typedArrayByteLengthGetter) return null;
  try {
    if (typedArrayByteLengthGetter.call(value) !== expectedLength) return null;
    const copy = new Uint8ArrayIntrinsic(expectedLength);
    uint8ArraySet.call(copy, value, 0);
    return copy;
  } catch {
    return null;
  }
}

function exactOwnedBuffer(value: Uint8Array, expectedLength: number): ArrayBuffer | null {
  if (!typedArrayBufferGetter) return null;
  try {
    const buffer = typedArrayBufferGetter.call(value) as unknown;
    return exactArrayBufferByteLength(buffer) === expectedLength ? (buffer as ArrayBuffer) : null;
  } catch {
    return null;
  }
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
    ENCODED_SOURCE_PORT_DEFAULT_RESPONSE_TIMEOUT_MS,
    ENCODED_SOURCE_PORT_MAX_RESPONSE_TIMEOUT_MS,
    'responseTimeoutMs',
  );
}

function closePort(port: MessagePort): boolean {
  try {
    port.close();
    return true;
  } catch {
    // Local ownership is already closed even if an adapter rejects close().
    return false;
  }
}

function attemptCleanup(cleanup: () => void): boolean {
  try {
    cleanup();
    return true;
  } catch {
    return false;
  }
}

function startPort(port: MessagePort): void {
  port.start();
}

function addCloseListener(port: MessagePort, listener: EventListener): void {
  (port as EventTarget).addEventListener('close', listener);
}

function removeCloseListener(port: MessagePort, listener: EventListener): void {
  (port as EventTarget).removeEventListener('close', listener);
}

function unrefTimer(timer: ReturnType<typeof globalThis.setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

function classifyReadError(error: unknown, signal: AbortSignal): EncodedSourcePortReadErrorCode {
  if (signal.aborted) return 'aborted';
  if (error instanceof EncodedSourceBusyError) return 'busy';
  if (error instanceof EncodedSourceClosedError) return 'closed';
  if (error instanceof EncodedSourceIntegrityError) return 'integrity';
  if (error instanceof EncodedSourceRangeError || error instanceof RangeError) return 'range';
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  return 'read-failed';
}

interface ReadCorrelation {
  readonly decoderGeneration: number;
  readonly requestId: number;
  readonly offset: number;
  readonly length: number;
}

interface ReadCommand extends ReadCorrelation {
  readonly type: typeof READ_TYPE;
  readonly generation: number;
}

interface CancelCommand extends ReadCorrelation {
  readonly type: typeof CANCEL_TYPE;
  readonly generation: number;
}

interface SettleAckCommand extends ReadCorrelation {
  readonly type: typeof SETTLE_ACK_TYPE;
  readonly generation: number;
}

interface CloseCommand {
  readonly type: typeof CLOSE_TYPE;
  readonly generation: number;
}

type PortCommand = ReadCommand | CancelCommand | SettleAckCommand | CloseCommand;

function parseCorrelation(record: PortRecord): boolean {
  return (
    isPositiveSafeInteger(record.decoderGeneration) &&
    isPositiveSafeInteger(record.requestId) &&
    isNonNegativeSafeInteger(record.offset) &&
    isPositiveSafeInteger(record.length) &&
    record.length <= ENCODED_SOURCE_PORT_MAX_READ_BYTES
  );
}

const CORRELATION_KEYS = [
  'type',
  'generation',
  'decoderGeneration',
  'requestId',
  'offset',
  'length',
] as const;

function parseCommand(value: unknown): PortCommand | null {
  const record = snapshotOwnDataRecord(value);
  if (!record || typeof record.type !== 'string') return null;

  if (record.type === READ_TYPE || record.type === CANCEL_TYPE || record.type === SETTLE_ACK_TYPE) {
    if (
      !hasExactKeys(record, CORRELATION_KEYS) ||
      !isPositiveSafeInteger(record.generation) ||
      !parseCorrelation(record)
    ) {
      return null;
    }
    return record as unknown as ReadCommand | CancelCommand | SettleAckCommand;
  }

  if (record.type === CLOSE_TYPE) {
    if (!hasExactKeys(record, ['type', 'generation'])) return null;
    if (!isPositiveSafeInteger(record.generation)) return null;
    return record as unknown as CloseCommand;
  }

  return null;
}

interface ResultResponse extends ReadCorrelation {
  readonly type: typeof RESULT_TYPE;
  readonly generation: number;
  /** An owned copy made while the ArrayBuffer's intrinsic length is validated. */
  readonly bytes: Uint8Array;
}

interface ErrorResponse extends ReadCorrelation {
  readonly type: typeof ERROR_TYPE;
  readonly generation: number;
  readonly code: EncodedSourcePortReadErrorCode;
}

interface CancelAckResponse extends ReadCorrelation {
  readonly type: typeof CANCEL_ACK_TYPE;
  readonly generation: number;
}

interface ClosedResponse {
  readonly type: typeof CLOSED_TYPE;
  readonly generation: number;
}

type PortResponse = ResultResponse | ErrorResponse | CancelAckResponse | ClosedResponse;

function parseResponse(value: unknown): PortResponse | null {
  const record = snapshotOwnDataRecord(value);
  if (!record || typeof record.type !== 'string') return null;

  if (record.type === RESULT_TYPE) {
    if (!hasExactKeys(record, [...CORRELATION_KEYS, 'payload'])) return null;
    if (!isPositiveSafeInteger(record.generation) || !parseCorrelation(record)) return null;
    const bytes = copyExactArrayBuffer(record.payload, record.length as number);
    if (!bytes) return null;
    return Object.freeze({
      type: RESULT_TYPE,
      generation: record.generation,
      decoderGeneration: record.decoderGeneration,
      requestId: record.requestId,
      offset: record.offset,
      length: record.length,
      bytes,
    }) as ResultResponse;
  }

  if (record.type === ERROR_TYPE) {
    if (!hasExactKeys(record, [...CORRELATION_KEYS, 'code'])) return null;
    if (
      !isPositiveSafeInteger(record.generation) ||
      !parseCorrelation(record) ||
      typeof record.code !== 'string' ||
      !READ_ERROR_CODES.has(record.code as EncodedSourcePortReadErrorCode)
    ) {
      return null;
    }
    return record as unknown as ErrorResponse;
  }

  if (record.type === CANCEL_ACK_TYPE) {
    if (
      !hasExactKeys(record, CORRELATION_KEYS) ||
      !isPositiveSafeInteger(record.generation) ||
      !parseCorrelation(record)
    ) {
      return null;
    }
    return record as unknown as CancelAckResponse;
  }

  if (record.type === CLOSED_TYPE) {
    if (!hasExactKeys(record, ['type', 'generation'])) return null;
    if (!isPositiveSafeInteger(record.generation)) return null;
    return record as unknown as ClosedResponse;
  }

  return null;
}

function sameCorrelation(left: ReadCorrelation, right: ReadCorrelation): boolean {
  return (
    left.decoderGeneration === right.decoderGeneration &&
    left.requestId === right.requestId &&
    left.offset === right.offset &&
    left.length === right.length
  );
}

function correlationRecord(
  type: string,
  generation: number,
  correlation: ReadCorrelation,
): PortRecord {
  return canonicalRecord({
    type,
    generation,
    decoderGeneration: correlation.decoderGeneration,
    requestId: correlation.requestId,
    offset: correlation.offset,
    length: correlation.length,
  });
}

interface BrokerReadTask extends ReadCorrelation {
  readonly controller: AbortController;
  readonly lifecycleLease: FilePlaybackUniversalLifecycleLease;
  physicalPromise: Promise<void> | null;
  cancelled: boolean;
}

interface AwaitingSettlement {
  readonly correlation: ReadCorrelation;
  cancelAckSent: boolean;
}

export interface EncodedSourcePortBrokerOptions {
  readonly source: EncodedAudioSource;
  /**
   * Ownership transfers to the broker as soon as construction is invoked.
   * The broker closes this endpoint exactly once on success or on any throw;
   * callers must never attempt a fallback close after calling the constructor.
   * Encoded-source ownership remains governed by its separate source contract.
   */
  readonly port: MessagePort;
  /**
   * Identifies the playback-source lifetime, not a decoder/seek generation.
   * Keep this broker alive across every seek and decoder restart for the source.
   */
  readonly generation: number;
  readonly maxPhysicalReads?: number;
  /** Playback-source ownership signal; aborting it destroys this whole bridge. */
  readonly lifetimeSignal?: AbortSignal;
}

/**
 * Main-thread owner for one exact EncodedAudioSource playback lifetime.
 *
 * Decoder seeks use `EncodedSourcePortClient.beginDecoderGeneration()` on the
 * existing port. They must never construct a new broker: this single broker's
 * physical-read set is the source-lifetime ledger that bounds even
 * abort-resistant reads across arbitrarily many decoder generations.
 */
export class EncodedSourcePortBroker {
  readonly generation: number;
  readonly size: number;

  readonly #source: EncodedAudioSource;
  readonly #port: MessagePort;
  readonly #portLifecycleLease: FilePlaybackUniversalLifecycleLease;
  readonly #maxPhysicalReads: number;
  readonly #lifetimeSignal: AbortSignal | undefined;
  readonly #physicalTasks = new Set<BrokerReadTask>();
  readonly #activeReads = new Map<number, BrokerReadTask>();
  readonly #awaitingSettlement = new Map<number, AwaitingSettlement>();
  readonly #onMessage = (event: MessageEvent<unknown>): void => this.#receive(event.data);
  readonly #onMessageError = (): void => {
    void this.#closeInternal(false, true);
  };
  readonly #onPortClose = (): void => {
    void this.#closeInternal(false, true);
  };
  readonly #onLifetimeAbort = (): void => {
    void this.#closeInternal(true, false);
  };
  #lastRequestId = 0;
  #lastDecoderGeneration = 0;
  #closed = false;
  #dispatching = false;
  #sourceCloseStarted = false;
  #sourceClosePromise: Promise<void> = Promise.resolve();
  #physicalClosePromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #portFault = false;

  constructor(options: EncodedSourcePortBrokerOptions) {
    const ownedPort = options.port;
    let ownedSource: EncodedAudioSource;
    let sourceSize: number;
    let generation: number;
    let lifetimeSignal: AbortSignal | undefined;
    let maxPhysicalReads: number;
    let portLifecycleLease: FilePlaybackUniversalLifecycleLease;
    try {
      // Snapshot every caller-controlled option before acquiring the port
      // lifecycle lease. Accessor re-entry or a second-read throw must never
      // strand the already-transferred endpoint or an acquired lease.
      ownedSource = options.source;
      generation = options.generation;
      const configuredMaxPhysicalReads = options.maxPhysicalReads;
      lifetimeSignal = options.lifetimeSignal;
      if (!ownedSource || typeof ownedSource.readAt !== 'function') {
        throw new TypeError('Encoded audio source is required');
      }
      sourceSize = ownedSource.size;
      validateExactRead(sourceSize, 0, 0);
      if (!isPositiveSafeInteger(generation)) {
        throw new RangeError('generation must be a positive safe integer');
      }
      maxPhysicalReads = configuredLimit(
        configuredMaxPhysicalReads,
        ENCODED_SOURCE_PORT_DEFAULT_MAX_PHYSICAL_READS,
        ENCODED_SOURCE_PORT_MAX_PHYSICAL_READS,
        'maxPhysicalReads',
      );
      portLifecycleLease = acquireFilePlaybackUniversalLifecycleLease('ports');
    } catch (error) {
      closePort(ownedPort);
      throw error;
    }
    this.#source = ownedSource;
    this.#port = ownedPort;
    this.generation = generation;
    this.size = sourceSize;
    this.#lifetimeSignal = lifetimeSignal;
    this.#maxPhysicalReads = maxPhysicalReads;
    this.#portLifecycleLease = portLifecycleLease;
    try {
      this.#port.addEventListener('message', this.#onMessage);
      if (this.#closed) {
        this.#detachPortHandlers();
        return;
      }
      this.#port.addEventListener('messageerror', this.#onMessageError);
      if (this.#closed) {
        this.#detachPortHandlers();
        return;
      }
      addCloseListener(this.#port, this.#onPortClose);
      if (this.#closed) {
        this.#detachPortHandlers();
        return;
      }
      this.#lifetimeSignal?.addEventListener('abort', this.#onLifetimeAbort, { once: true });
      if (this.#closed) {
        this.#detachPortHandlers();
        return;
      }
      startPort(this.#port);
      if (this.#closed) {
        this.#detachPortHandlers();
        return;
      }
      const lifetimeAborted = this.#lifetimeSignal?.aborted === true;
      if (this.#closed) {
        this.#detachPortHandlers();
        return;
      }
      if (lifetimeAborted) {
        void this.#closeInternal(true, false);
        this.#detachPortHandlers();
      }
    } catch (error) {
      void this.#closeInternal(false, true);
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Includes abort-resistant reads until their physical promises actually settle. */
  get physicalReadCount(): number {
    return this.#physicalTasks.size;
  }

  /** Ends the playback-source lifetime and closes the underlying source exactly once. */
  close(): Promise<void> {
    return this.#closeInternal(true, false);
  }

  #ensurePhysicalClosePromise(): Promise<void> {
    this.#physicalClosePromise ??= Promise.allSettled(
      [...this.#physicalTasks]
        .map((task) => task.physicalPromise)
        .filter((task): task is Promise<void> => task !== null),
    )
      .then(() => this.#sourceClosePromise)
      .then(() => undefined);
    return this.#physicalClosePromise;
  }

  #receive(value: unknown): void {
    if (this.#closed) return;
    if (this.#dispatching) {
      this.#protocolFailure();
      return;
    }
    this.#dispatching = true;
    try {
      const command = parseCommand(value);
      if (!command || command.generation !== this.generation) {
        this.#protocolFailure();
        return;
      }
      if (this.#closed) return;
      if (command.type === READ_TYPE) this.#beginRead(command);
      else if (command.type === CANCEL_TYPE) this.#cancelRead(command);
      else if (command.type === SETTLE_ACK_TYPE) this.#settleAck(command);
      else this.#closeInternal(false, false);
    } finally {
      this.#dispatching = false;
    }
  }

  #beginRead(command: ReadCommand): void {
    if (
      command.requestId <= this.#lastRequestId ||
      command.decoderGeneration < this.#lastDecoderGeneration
    ) {
      this.#protocolFailure();
      return;
    }
    this.#lastRequestId = command.requestId;
    this.#lastDecoderGeneration = command.decoderGeneration;

    if (this.#activeReads.size + this.#awaitingSettlement.size >= this.#maxPhysicalReads) {
      // A peer that does not acknowledge terminal responses must not grow the
      // correlation ledger by eliciting an unbounded stream of busy replies.
      this.#protocolFailure();
      return;
    }

    try {
      validateExactRead(this.size, command.offset, command.length);
    } catch {
      this.#sendTerminalError(command, 'range');
      return;
    }

    if (this.#physicalTasks.size >= this.#maxPhysicalReads) {
      this.#sendTerminalError(command, 'busy');
      return;
    }

    const controller = new AbortController();
    let lifecycleLease: FilePlaybackUniversalLifecycleLease;
    try {
      lifecycleLease = acquireFilePlaybackUniversalLifecycleLease('pendingReads');
    } catch {
      // Acquisition is part of the bounded correlation fence. The session
      // cannot safely accept this request without accounting for it, so fail
      // the exact port closed and start source retirement immediately.
      this.#protocolFailure();
      return;
    }
    const task: BrokerReadTask = {
      decoderGeneration: command.decoderGeneration,
      requestId: command.requestId,
      offset: command.offset,
      length: command.length,
      controller,
      lifecycleLease,
      physicalPromise: null,
      cancelled: false,
    };
    this.#physicalTasks.add(task);
    this.#activeReads.set(task.requestId, task);

    const physicalPromise = Promise.resolve()
      .then(() => this.#source.readAt(task.offset, task.length, controller.signal))
      .then((sourceBytes) => {
        if (task.cancelled || this.#closed || controller.signal.aborted) return;
        const bytes = copyExactSourceBytes(sourceBytes, task.length);
        if (!bytes) {
          this.#sendTerminalError(task, 'integrity');
          return;
        }
        const payload = exactOwnedBuffer(bytes, task.length);
        if (!payload) {
          this.#sendTerminalError(task, 'integrity');
          return;
        }
        this.#sendTerminal(
          task,
          canonicalRecord({
            type: RESULT_TYPE,
            generation: this.generation,
            decoderGeneration: task.decoderGeneration,
            requestId: task.requestId,
            offset: task.offset,
            length: task.length,
            payload,
          }),
          [payload],
        );
      })
      .catch((error: unknown) => {
        if (task.cancelled || this.#closed) return;
        this.#sendTerminalError(task, classifyReadError(error, controller.signal));
      })
      .finally(() => {
        this.#physicalTasks.delete(task);
        task.lifecycleLease.beginRetire().release();
        if (this.#activeReads.get(task.requestId) === task) {
          this.#activeReads.delete(task.requestId);
        }
      });
    task.physicalPromise = physicalPromise;
    void physicalPromise;
  }

  #cancelRead(command: CancelCommand): void {
    const active = this.#activeReads.get(command.requestId);
    if (active) {
      if (!sameCorrelation(active, command)) {
        this.#protocolFailure();
        return;
      }
      this.#activeReads.delete(command.requestId);
      active.cancelled = true;
      if (!active.controller.signal.aborted) {
        active.controller.abort(new EncodedSourcePortError('aborted'));
      }
      this.#send(correlationRecord(CANCEL_ACK_TYPE, this.generation, active));
      return;
    }

    const awaiting = this.#awaitingSettlement.get(command.requestId);
    if (!awaiting || !sameCorrelation(awaiting.correlation, command)) {
      this.#protocolFailure();
      return;
    }
    // Any terminal response was posted before this ACK and MessagePort keeps
    // messages from this broker ordered. The client retains its exact tombstone
    // until the ACK arrives, so a raced completion remains safe and bounded.
    if (awaiting.cancelAckSent) return;
    awaiting.cancelAckSent = true;
    this.#send(correlationRecord(CANCEL_ACK_TYPE, this.generation, awaiting.correlation));
  }

  #settleAck(command: SettleAckCommand): void {
    const awaiting = this.#awaitingSettlement.get(command.requestId);
    if (!awaiting || !sameCorrelation(awaiting.correlation, command)) {
      this.#protocolFailure();
      return;
    }
    this.#awaitingSettlement.delete(command.requestId);
  }

  #sendTerminalError(correlation: ReadCorrelation, code: EncodedSourcePortReadErrorCode): void {
    this.#sendTerminal(
      correlation,
      canonicalRecord({
        type: ERROR_TYPE,
        generation: this.generation,
        decoderGeneration: correlation.decoderGeneration,
        requestId: correlation.requestId,
        offset: correlation.offset,
        length: correlation.length,
        code,
      }),
    );
  }

  #sendTerminal(
    correlation: ReadCorrelation,
    message: PortRecord,
    transfer: Transferable[] = [],
  ): void {
    if (this.#closed) return;
    const active = this.#activeReads.get(correlation.requestId);
    if (active) this.#activeReads.delete(correlation.requestId);
    if (this.#awaitingSettlement.size >= this.#maxPhysicalReads) {
      this.#protocolFailure();
      return;
    }
    this.#awaitingSettlement.set(correlation.requestId, {
      correlation,
      cancelAckSent: false,
    });
    this.#send(message, transfer);
  }

  #send(message: PortRecord, transfer: Transferable[] = []): boolean {
    if (this.#closed) return false;
    try {
      this.#port.postMessage(message, transfer);
      return true;
    } catch {
      this.#closeInternal(false, true);
      return false;
    }
  }

  #protocolFailure(): void {
    this.#closeInternal(false, true);
  }

  #detachPortHandlers(): void {
    if (!attemptCleanup(() => this.#port.removeEventListener('message', this.#onMessage))) {
      this.#portFault = true;
    }
    if (
      !attemptCleanup(() => this.#port.removeEventListener('messageerror', this.#onMessageError))
    ) {
      this.#portFault = true;
    }
    if (!attemptCleanup(() => removeCloseListener(this.#port, this.#onPortClose))) {
      this.#portFault = true;
    }
    if (
      !attemptCleanup(() =>
        this.#lifetimeSignal?.removeEventListener('abort', this.#onLifetimeAbort),
      )
    ) {
      this.#portFault = true;
    }
  }

  #closeInternal(notifyPeer: boolean, portFault: boolean): Promise<void> {
    if (portFault) this.#portFault = true;
    if (this.#closePromise) return this.#closePromise;

    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Claim the one public result and the cleanup right before any adapter
    // callback. postMessage(), listener detach, source.close(), and port.close()
    // are all allowed to synchronously reenter close() in same-realm adapters.
    this.#closePromise = closePromise;
    this.#closed = true;
    void closePromise.catch(() => undefined);

    if (notifyPeer) {
      try {
        this.#port.postMessage(canonicalRecord({ type: CLOSED_TYPE, generation: this.generation }));
      } catch {
        // A close/messageerror event or owner signal remains authoritative.
      }
    }
    this.#detachPortHandlers();
    for (const task of this.#activeReads.values()) {
      task.cancelled = true;
      if (!task.controller.signal.aborted) {
        task.controller.abort(new EncodedSourcePortError('closed'));
      }
    }
    this.#activeReads.clear();
    this.#awaitingSettlement.clear();
    if (!closePort(this.#port)) this.#portFault = true;

    if (!this.#sourceCloseStarted) {
      this.#sourceCloseStarted = true;
      try {
        this.#sourceClosePromise = Promise.resolve(this.#source.close()).catch(() => undefined);
      } catch {
        // Bridge closure is deterministic even if source cleanup fails.
        this.#sourceClosePromise = Promise.resolve();
      }
    }

    const physicalClosePromise = this.#ensurePhysicalClosePromise();
    let portRetirementPromise: Promise<void>;
    if (this.#portFault) {
      this.#portLifecycleLease.forceUnconfirmed();
      portRetirementPromise = Promise.resolve();
    } else {
      portRetirementPromise = confirmFilePlaybackUniversalLifecycleRetirement(
        this.#portLifecycleLease,
        () =>
          physicalClosePromise.then(() => {
            if (this.#portFault) {
              throw new Error('Encoded source broker port cleanup could not be confirmed');
            }
          }),
      ).then(() => undefined);
    }

    void Promise.all([physicalClosePromise, portRetirementPromise]).then(
      () => resolveClose(),
      (error: unknown) => rejectClose(error),
    );
    return closePromise;
  }
}

interface PendingClientRead extends ReadCorrelation {
  readonly signal: AbortSignal;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  timeout: ReturnType<typeof globalThis.setTimeout> | null;
  readonly lifecycleLease: FilePlaybackUniversalLifecycleLease;
  timerLifecycleLease: FilePlaybackUniversalLifecycleLease | null;
  timerArming: boolean;
  timerFired: boolean;
  timerRetireRequested: boolean;
  listenerState: 'not-installed' | 'installing' | 'installed' | 'retired' | 'unconfirmed';
  listenerRetireRequested: boolean;
}

interface CancelledClientRead {
  readonly correlation: ReadCorrelation;
  completionSeen: boolean;
}

export interface EncodedSourcePortClientOptions {
  /**
   * The caller retains ownership if validation or transactional listener
   * installation throws. Successful construction transfers the endpoint to
   * the client, including when an installation callback closes it reentrantly.
   */
  readonly port: MessagePort;
  /** Must match the broker's playback-source lifetime generation. */
  readonly generation: number;
  readonly size: number;
  readonly maxPendingReads?: number;
  readonly maxCancelledReads?: number;
  /** Bounds silent-port failures where postMessage succeeds but no peer exists. */
  readonly responseTimeoutMs?: number;
}

/**
 * Worker-side bounded random-access client for one playback-source lifetime.
 *
 * Keep one client alive across decoder restarts. `beginDecoderGeneration()`
 * cancels only the superseded decoder's logical reads; it deliberately keeps
 * the port, monotonic request IDs, broker physical ledger, and source alive.
 */
export class EncodedSourcePortClient {
  readonly generation: number;
  readonly size: number;

  readonly #port: MessagePort;
  readonly #maxPendingReads: number;
  readonly #maxCancelledReads: number;
  readonly #responseTimeoutMs: number;
  readonly #pendingReads = new Map<number, PendingClientRead>();
  readonly #cancelledReads = new Map<number, CancelledClientRead>();
  readonly #onMessage = (event: MessageEvent<unknown>): void => this.#receive(event.data);
  readonly #onMessageError = (): void => {
    const error = new EncodedSourcePortError('closed');
    this.#closeInternal(error, error);
  };
  readonly #onPortClose = (): void => {
    const error = new EncodedSourcePortError('closed');
    this.#closeInternal(error, error);
  };
  #nextRequestId = 1;
  #decoderGeneration = 1;
  #closed = false;
  #dispatching = false;
  #closePromise: Promise<void> | null = null;
  #closeCleanupStarted = false;
  #resolveClose: (() => void) | null = null;
  #rejectClose: ((reason: unknown) => void) | null = null;
  readonly #closeFailures: unknown[] = [];
  #constructionPending = true;
  #closeSettlementPending = false;
  #physicalSetupCount = 0;

  constructor(options: EncodedSourcePortClientOptions) {
    const port = options.port;
    const generation = options.generation;
    const size = options.size;
    const maxPendingReads = options.maxPendingReads;
    const maxCancelledReads = options.maxCancelledReads;
    const responseTimeoutMs = options.responseTimeoutMs;
    if (!isPositiveSafeInteger(generation)) {
      throw new RangeError('generation must be a positive safe integer');
    }
    validateExactRead(size, 0, 0);
    this.#port = port;
    this.generation = generation;
    this.size = size;
    this.#maxPendingReads = configuredLimit(
      maxPendingReads,
      ENCODED_SOURCE_PORT_DEFAULT_MAX_PENDING_READS,
      ENCODED_SOURCE_PORT_MAX_PENDING_READS,
      'maxPendingReads',
    );
    this.#maxCancelledReads = configuredLimit(
      maxCancelledReads,
      ENCODED_SOURCE_PORT_DEFAULT_MAX_CANCELLED_READS,
      ENCODED_SOURCE_PORT_MAX_CANCELLED_READS,
      'maxCancelledReads',
    );
    this.#responseTimeoutMs = configuredTimeout(responseTimeoutMs);

    try {
      this.#port.addEventListener('message', this.#onMessage);
      if (this.#closed) {
        this.#detachPortHandlers(this.#closeFailures);
        return;
      }
      this.#port.addEventListener('messageerror', this.#onMessageError);
      if (this.#closed) {
        this.#detachPortHandlers(this.#closeFailures);
        return;
      }
      addCloseListener(this.#port, this.#onPortClose);
      if (this.#closed) {
        this.#detachPortHandlers(this.#closeFailures);
        return;
      }
      startPort(this.#port);
      if (this.#closed) this.#detachPortHandlers(this.#closeFailures);
    } catch (error) {
      if (this.#closed) {
        this.#closeFailures.push(error);
        this.#detachPortHandlers(this.#closeFailures);
        return;
      }
      const rollbackFailures: unknown[] = [];
      this.#detachPortHandlers(rollbackFailures);
      if (rollbackFailures.length === 0) throw error;
      throw new AggregateError(
        [error, ...rollbackFailures],
        'Encoded source port client installation rollback failed',
        { cause: error },
      );
    } finally {
      this.#constructionPending = false;
      this.#settleCloseIfReady();
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pendingReadCount(): number {
    return this.#pendingReads.size;
  }

  get cancelledReadCount(): number {
    return this.#cancelledReads.size;
  }

  get decoderGeneration(): number {
    return this.#decoderGeneration;
  }

  /** Supersedes decoder work without replacing or closing the source bridge. */
  beginDecoderGeneration(): number {
    if (this.#closed) throw new EncodedSourceClosedError();
    if (!Number.isSafeInteger(this.#decoderGeneration + 1)) {
      this.#closeInternal(new EncodedSourcePortError('protocol'));
      throw new EncodedSourcePortError('protocol');
    }
    const superseded = [...this.#pendingReads.values()];
    for (const pending of superseded) {
      this.#cancelPending(pending, new EncodedSourcePortError('aborted'));
      if (this.#closed) throw new EncodedSourcePortError('protocol');
    }
    this.#decoderGeneration += 1;
    return this.#decoderGeneration;
  }

  readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) return Promise.reject(new EncodedSourceClosedError());
    try {
      validateExactRead(this.size, offset, length);
      if (length > ENCODED_SOURCE_PORT_MAX_READ_BYTES) {
        throw new EncodedSourceRangeError(
          `Encoded source port read exceeds ${ENCODED_SOURCE_PORT_MAX_READ_BYTES} bytes`,
        );
      }
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (length === 0) return Promise.resolve(new Uint8ArrayIntrinsic(0));
    if (this.#pendingReads.size >= this.#maxPendingReads) {
      return Promise.reject(new EncodedSourcePortError('busy'));
    }
    if (!Number.isSafeInteger(this.#nextRequestId) || this.#nextRequestId <= 0) {
      this.#closeInternal(new EncodedSourcePortError('protocol'));
      return Promise.reject(new EncodedSourcePortError('protocol'));
    }

    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const correlation: ReadCorrelation = Object.freeze({
      decoderGeneration: this.#decoderGeneration,
      requestId,
      offset,
      length,
    });

    return new Promise<Uint8Array>((resolve, reject) => {
      const lifecycleLease = acquireFilePlaybackUniversalLifecycleLease('pendingReads');
      let timerLifecycleLease: FilePlaybackUniversalLifecycleLease;
      try {
        timerLifecycleLease = acquireFilePlaybackUniversalLifecycleLease('timers');
      } catch (error) {
        lifecycleLease.beginRetire().release();
        throw error;
      }
      const onAbort = (): void => {
        const pending = this.#pendingReads.get(requestId);
        if (pending !== entry) return;
        let reason: unknown = new EncodedSourcePortError('aborted');
        try {
          throwIfAborted(signal);
        } catch (error) {
          reason = error;
        }
        this.#cancelPending(entry, reason);
      };

      const entry: PendingClientRead = {
        ...correlation,
        signal,
        resolve,
        reject,
        onAbort,
        timeout: null,
        lifecycleLease,
        timerLifecycleLease,
        timerArming: true,
        timerFired: false,
        timerRetireRequested: false,
        listenerState: 'not-installed',
        listenerRetireRequested: false,
      };
      this.#pendingReads.set(requestId, entry);
      this.#beginPhysicalSetup();
      let timerSetupError: unknown | null = null;
      try {
        const timeout = globalThis.setTimeout(() => {
          if (this.#pendingReads.get(requestId) !== entry) return;
          entry.timerFired = true;
          if (!entry.timerArming) this.#retirePendingTimer(entry);
          // MessagePort may accept postMessage after its peer was disentangled.
          // A bounded response deadline prevents that silent case from hanging a
          // decoder read forever.
          const error = new EncodedSourcePortError('closed');
          this.#closeInternal(error, error);
        }, this.#responseTimeoutMs);
        entry.timerArming = false;
        if (entry.timerFired) {
          this.#retirePendingTimer(entry);
        } else {
          entry.timeout = timeout;
          if (
            entry.timerRetireRequested ||
            this.#pendingReads.get(requestId) !== entry ||
            this.#closed
          ) {
            this.#retirePendingTimer(entry, this.#closeFailures);
          } else {
            unrefTimer(timeout);
          }
        }
      } catch (error) {
        timerSetupError = error;
        entry.timerArming = false;
        if (entry.timerFired || entry.timeout !== null) {
          this.#retirePendingTimer(
            entry,
            this.#closeCleanupStarted ? this.#closeFailures : undefined,
          );
        } else {
          const timerLease = entry.timerLifecycleLease;
          entry.timerLifecycleLease = null;
          timerLease?.forceUnconfirmed();
        }
        if (this.#closeCleanupStarted) this.#closeFailures.push(error);
      } finally {
        this.#endPhysicalSetup();
      }

      if (timerSetupError !== null) {
        if (this.#pendingReads.get(requestId) === entry) this.#pendingReads.delete(requestId);
        this.#retirePendingListener(entry);
        reject(timerSetupError);
        return;
      }
      if (this.#pendingReads.get(requestId) !== entry || this.#closed) return;

      this.#beginPhysicalSetup();
      entry.listenerState = 'installing';
      let listenerSetupError: unknown | null = null;
      try {
        signal.addEventListener('abort', onAbort, { once: true });
      } catch (error) {
        listenerSetupError = error;
      } finally {
        entry.listenerState = 'installed';
        if (
          entry.listenerRetireRequested ||
          this.#pendingReads.get(requestId) !== entry ||
          this.#closed ||
          listenerSetupError !== null
        ) {
          this.#retirePendingListener(
            entry,
            this.#closeCleanupStarted ? this.#closeFailures : undefined,
          );
        }
        if (listenerSetupError !== null && this.#closeCleanupStarted) {
          this.#closeFailures.push(listenerSetupError);
        }
        this.#endPhysicalSetup();
      }
      if (listenerSetupError !== null) {
        if (this.#pendingReads.get(requestId) === entry) this.#pendingReads.delete(requestId);
        this.#retirePendingTimer(entry);
        reject(listenerSetupError);
        return;
      }
      if (this.#pendingReads.get(requestId) !== entry || this.#closed) return;

      let signalAborted: boolean;
      try {
        signalAborted = signal.aborted;
      } catch (error) {
        if (this.#pendingReads.get(requestId) === entry) this.#pendingReads.delete(requestId);
        this.#retirePendingResources(entry);
        reject(error);
        return;
      }
      if (this.#pendingReads.get(requestId) !== entry || this.#closed) return;
      if (signalAborted) {
        onAbort();
        return;
      }

      const sent = this.#post(correlationRecord(READ_TYPE, this.generation, correlation));
      if (!sent && this.#pendingReads.get(requestId) === entry) {
        this.#settlePending(entry, new EncodedSourcePortError('closed'));
      }
    });
  }

  /** Ends the playback-source lifetime; decoder seeks must not call this. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const closePromise = this.#claimClosePromise();
    // Claim cleanup before the worker-retired notification. A same-realm port
    // may synchronously invoke close(), messageerror, or close listeners here.
    this.#closeCleanupStarted = true;
    this.#closed = true;
    try {
      this.#port.postMessage(canonicalRecord({ type: CLOSE_TYPE, generation: this.generation }));
    } catch (cause) {
      this.#closeFailures.push(cause);
    }
    this.#finishClose(new EncodedSourceClosedError());
    return closePromise;
  }

  #cancelPending(pending: PendingClientRead, reason: unknown): void {
    if (this.#pendingReads.get(pending.requestId) !== pending) return;
    this.#pendingReads.delete(pending.requestId);
    this.#retirePendingResources(pending);
    pending.reject(reason);

    if (this.#cancelledReads.size >= this.#maxCancelledReads) {
      this.#closeInternal(new EncodedSourcePortError('protocol'));
      return;
    }
    const correlation: ReadCorrelation = Object.freeze({
      decoderGeneration: pending.decoderGeneration,
      requestId: pending.requestId,
      offset: pending.offset,
      length: pending.length,
    });
    this.#cancelledReads.set(correlation.requestId, {
      correlation,
      completionSeen: false,
    });
    this.#postBestEffort(correlationRecord(CANCEL_TYPE, this.generation, correlation));
  }

  #receive(value: unknown): void {
    if (this.#closed) return;
    if (this.#dispatching) {
      this.#closeInternal(new EncodedSourcePortError('protocol'));
      return;
    }
    this.#dispatching = true;
    try {
      const response = parseResponse(value);
      if (!response || response.generation !== this.generation) {
        this.#closeInternal(new EncodedSourcePortError('protocol'));
        return;
      }
      if (this.#closed) return;
      if (response.type === CLOSED_TYPE) {
        this.#closeInternal(new EncodedSourceClosedError());
        return;
      }
      if (response.type === CANCEL_ACK_TYPE) {
        this.#acceptCancelAck(response);
        return;
      }

      const pending = this.#pendingReads.get(response.requestId);
      if (!pending) {
        this.#acceptCancelledCompletion(response);
        return;
      }
      if (!sameCorrelation(pending, response)) {
        this.#closeInternal(new EncodedSourcePortError('protocol'));
        return;
      }

      if (response.type === RESULT_TYPE) {
        this.#deferSettlementAck(response);
        this.#settlePending(pending, null, response.bytes);
      } else {
        this.#deferSettlementAck(response);
        this.#settlePending(pending, this.#errorForCode(response.code));
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #acceptCancelledCompletion(response: ResultResponse | ErrorResponse): void {
    const cancelled = this.#cancelledReads.get(response.requestId);
    if (!cancelled || !sameCorrelation(cancelled.correlation, response)) {
      this.#closeInternal(new EncodedSourcePortError('protocol'));
      return;
    }
    if (cancelled.completionSeen) return;
    cancelled.completionSeen = true;
    this.#deferSettlementAck(response);
  }

  #acceptCancelAck(response: CancelAckResponse): void {
    const cancelled = this.#cancelledReads.get(response.requestId);
    if (!cancelled || !sameCorrelation(cancelled.correlation, response)) {
      this.#closeInternal(new EncodedSourcePortError('protocol'));
      return;
    }
    this.#cancelledReads.delete(response.requestId);
  }

  #deferSettlementAck(correlation: ReadCorrelation): void {
    // Real MessagePorts always enqueue delivery. Deferring the ACK preserves
    // that boundary for same-realm adapters too, so an otherwise honest
    // terminal response cannot reenter the broker's command parser.
    queueMicrotask(() => {
      this.#postBestEffort(correlationRecord(SETTLE_ACK_TYPE, this.generation, correlation));
    });
  }

  #errorForCode(code: EncodedSourcePortReadErrorCode): Error {
    if (code === 'closed') return new EncodedSourceClosedError();
    if (code === 'range') return new EncodedSourceRangeError(ERROR_MESSAGES.range);
    if (code === 'integrity') return new EncodedSourceIntegrityError(ERROR_MESSAGES.integrity);
    return new EncodedSourcePortError(code);
  }

  #settlePending(pending: PendingClientRead, error: unknown | null, bytes?: Uint8Array): void {
    if (this.#pendingReads.get(pending.requestId) !== pending) return;
    this.#pendingReads.delete(pending.requestId);
    this.#retirePendingResources(pending);
    if (error !== null) pending.reject(error);
    else pending.resolve(bytes ?? new Uint8ArrayIntrinsic(0));
  }

  #retirePendingResources(pending: PendingClientRead, failures?: unknown[]): void {
    this.#retirePendingTimer(pending, failures);
    this.#retirePendingListener(pending, failures);
  }

  #retirePendingTimer(pending: PendingClientRead, failures?: unknown[]): void {
    const timerLease = pending.timerLifecycleLease;
    if (!timerLease) return;
    if (pending.timerArming) {
      pending.timerRetireRequested = true;
      return;
    }

    pending.timerLifecycleLease = null;
    pending.timerRetireRequested = false;
    const timer = pending.timeout;
    pending.timeout = null;
    if (pending.timerFired) {
      timerLease.beginRetire().release();
      return;
    }
    if (timer === null) {
      timerLease.forceUnconfirmed();
      return;
    }
    try {
      globalThis.clearTimeout(timer);
      timerLease.beginRetire().release();
    } catch (cause) {
      failures?.push(cause);
      timerLease.forceUnconfirmed();
    }
  }

  #retirePendingListener(pending: PendingClientRead, failures?: unknown[]): void {
    if (pending.listenerState === 'retired' || pending.listenerState === 'unconfirmed') return;
    if (pending.listenerState === 'installing') {
      pending.listenerRetireRequested = true;
      return;
    }
    if (pending.listenerState === 'not-installed') {
      pending.listenerState = 'retired';
      pending.listenerRetireRequested = false;
      pending.lifecycleLease.beginRetire().release();
      return;
    }

    pending.listenerRetireRequested = false;
    try {
      pending.signal.removeEventListener('abort', pending.onAbort);
    } catch (cause) {
      failures?.push(cause);
      pending.listenerState = 'unconfirmed';
      pending.lifecycleLease.forceUnconfirmed();
      return;
    }
    pending.listenerState = 'retired';
    pending.lifecycleLease.beginRetire().release();
  }

  #beginPhysicalSetup(): void {
    this.#physicalSetupCount += 1;
  }

  #endPhysicalSetup(): void {
    this.#physicalSetupCount = Math.max(0, this.#physicalSetupCount - 1);
    this.#settleCloseIfReady();
  }

  #post(message: PortRecord): boolean {
    if (this.#closed) return false;
    try {
      this.#port.postMessage(message);
      return true;
    } catch (cause) {
      this.#closeInternal(new EncodedSourcePortError('closed'), cause);
      return false;
    }
  }

  #postBestEffort(message: PortRecord): void {
    if (this.#closed) return;
    try {
      this.#port.postMessage(message);
    } catch (cause) {
      this.#closeInternal(new EncodedSourcePortError('closed'), cause);
    }
  }

  #claimClosePromise(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.#closePromise = closePromise;
    this.#resolveClose = resolveClose;
    this.#rejectClose = rejectClose;
    void closePromise.catch(() => undefined);
    return closePromise;
  }

  #closeInternal(error: unknown, physicalFailure?: unknown): void {
    this.#claimClosePromise();
    if (physicalFailure !== undefined) this.#closeFailures.push(physicalFailure);
    if (this.#closeCleanupStarted) return;
    this.#closeCleanupStarted = true;
    this.#closed = true;
    this.#finishClose(error);
  }

  #finishClose(error: unknown): void {
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (cause) {
        this.#closeFailures.push(cause);
      }
    };
    this.#detachPortHandlers(this.#closeFailures);
    const reads = [...this.#pendingReads.values()];
    this.#pendingReads.clear();
    this.#cancelledReads.clear();
    for (const pending of reads) {
      this.#retirePendingResources(pending, this.#closeFailures);
      attempt(() => pending.reject(error));
    }
    attempt(() => this.#port.close());
    this.#closeSettlementPending = true;
    this.#settleCloseIfReady();
  }

  #detachPortHandlers(failures: unknown[]): void {
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (cause) {
        failures.push(cause);
      }
    };
    attempt(() => this.#port.removeEventListener('message', this.#onMessage));
    attempt(() => this.#port.removeEventListener('messageerror', this.#onMessageError));
    attempt(() => removeCloseListener(this.#port, this.#onPortClose));
  }

  #settleCloseIfReady(): void {
    if (
      !this.#closeSettlementPending ||
      this.#constructionPending ||
      this.#physicalSetupCount !== 0
    ) {
      return;
    }
    const resolveClose = this.#resolveClose;
    const rejectClose = this.#rejectClose;
    this.#resolveClose = null;
    this.#rejectClose = null;
    if (!resolveClose || !rejectClose) return;
    if (this.#closeFailures.length === 0) {
      resolveClose();
    } else if (this.#closeFailures.length === 1) {
      rejectClose(this.#closeFailures[0]);
    } else {
      rejectClose(
        new AggregateError(
          this.#closeFailures,
          'Encoded source port physical cleanup could not be confirmed',
        ),
      );
    }
  }
}
