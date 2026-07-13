/// <reference lib="webworker" />

import {
  AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
  AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES,
  AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS,
  AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES,
  AacDecoderBackendIntegrityError,
  AacDecoderBackendUnavailableError,
  snapshotAacDecoderPcmBatch,
  type AacDecoderAccessUnit,
  type AacDecoderBackend,
  type AacDecoderPcmBatch,
} from '../player/aac/decoder-backend.js';
import { createAacDecoderBackend } from '../player/aac/decoder-backend-factory.js';
import { parseCanonicalAacLcAudioSpecificConfig } from '../player/aac/audio-specific-config.js';
import type { AdtsCoreConfiguration } from '../player/aac/incremental-frame-reader.js';
import { IsoBmffBoxReader } from '../player/mp4/box-reader.js';
import { EncodedSourceIntegrityError } from '../player/sources/encoded-audio-source.js';
import {
  EncodedSourcePortClient,
  EncodedSourcePortError,
} from '../player/sources/encoded-source-port.js';
import {
  expectedM4aAacDecoderEofProgress,
  remainingM4aAacMediaFrames,
} from '../player/m4a/decoder-helpers.js';
import {
  M4A_AAC_DECODER_MAX_ERROR_CODE_LENGTH,
  M4A_AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH,
  M4A_AAC_DECODER_PROTOCOL_VERSION,
  M4A_AAC_DECODER_START_PLAN_KEYS,
  parseM4aAacDecoderCommand,
  type M4aAacDecoderDescriptor,
  type M4aAacDecoderEvent,
  type M4aAacDecoderOpenCommand,
} from '../player/m4a/decoder-protocol.js';
import {
  closeM4aRawAacAccessUnitReader,
  type M4aRawAacAccessUnitRead,
  type M4aRawAacAccessUnitReader,
} from '../player/m4a/raw-aac-access-unit-reader.js';
import {
  closeM4aAacRuntime,
  openM4aAacRuntime,
  type M4aAacRuntime,
} from '../player/m4a/runtime.js';
import {
  M4aRawAacWebCodecsIntegrityError,
  M4aRawAacWebCodecsUnavailableError,
  probeM4aRawAacWebCodecsAccessUnit,
} from '../player/m4a/webcodecs-canary.js';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  parsePcmDemandMessage,
  type PcmSupplyMessage,
} from '../player/streaming/pcm-stream-protocol.js';
import {
  BoundedPcmOutput,
  BoundedPcmOutputError,
  ensureBoundedPcmOutputRuntimeReady,
} from './bounded-pcm-output.js';
import {
  RetryingPortEncodedSource,
  RetryingPortEncodedSourceError,
} from './retrying-port-encoded-source.js';

const scope = self as DedicatedWorkerGlobalScope;
const PROGRESS_INTERVAL_BYTES = 1024 * 1024;
const WEB_CODECS_MAX_CANARY_OUTPUTS = 64;

class M4aAacWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'M4aAacWorkerError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

class SessionCancelledError extends Error {
  constructor() {
    super('M4A AAC decoder session was cancelled');
    this.name = 'SessionCancelledError';
  }
}

interface DecoderSession {
  readonly sourceLifetimeGeneration: number;
  readonly decoderGeneration: number;
  readonly backendId: M4aAacDecoderOpenCommand['backendId'];
  readonly descriptor: Readonly<M4aAacDecoderDescriptor>;
  readonly source: RetryingPortEncodedSource;
  readonly pcmPort: MessagePort;
  readonly abortController: AbortController;
  readonly pcmListener: (event: MessageEvent<unknown>) => void;
  readonly pcmMessageErrorListener: () => void;
  runtime: M4aAacRuntime | null;
  cursor: M4aRawAacAccessUnitReader | null;
  prefetchedAccessUnit: Readonly<M4aRawAacAccessUnitRead> | null;
  backend: AacDecoderBackend | null;
  output: BoundedPcmOutput | null;
  coreConfiguration: Readonly<AdtsCoreConfiguration> | null;
  nextAccessUnitOrdinal: number;
  consumedEncodedBytes: number;
  decodedRawCoreFrames: number;
  lastProgressEncodedBytes: number;
  requestChain: Promise<void>;
  demandPending: boolean;
  inputEnded: boolean;
  ready: boolean;
  stopped: boolean;
  terminal: boolean;
  released: boolean;
}

interface CompletedGeneration {
  readonly sourceLifetimeGeneration: number;
  readonly decoderGeneration: number;
}

let activeSession: DecoderSession | null = null;
let completedGeneration: CompletedGeneration | null = null;
let realmOpened = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: unknown, maximumLength: number, fallback: string): string {
  const normalized = typeof value === 'string' && value.length > 0 ? value : fallback;
  return normalized.length <= maximumLength ? normalized : normalized.slice(0, maximumLength);
}

function errorCode(error: unknown): string {
  if (error instanceof M4aAacWorkerError) return error.code;
  if (error instanceof RetryingPortEncodedSourceError) return error.code;
  if (error instanceof EncodedSourcePortError) return `source-${error.code}`;
  if (error instanceof M4aRawAacWebCodecsUnavailableError) return 'canary-unavailable';
  if (error instanceof M4aRawAacWebCodecsIntegrityError) return 'canary-integrity';
  if (error instanceof AacDecoderBackendUnavailableError) return 'backend-unavailable';
  if (error instanceof AacDecoderBackendIntegrityError) return 'backend-integrity';
  if (error instanceof BoundedPcmOutputError) return 'pcm-output-failed';
  if (error instanceof EncodedSourceIntegrityError) return 'input-integrity';
  return 'decode-failed';
}

function safeTerminalCode(error: unknown): string {
  try {
    return boundedText(errorCode(error), M4A_AAC_DECODER_MAX_ERROR_CODE_LENGTH, 'decode-failed');
  } catch {
    return 'decode-failed';
  }
}

function safeTerminalMessage(error: unknown): string {
  try {
    return boundedText(
      errorMessage(error),
      M4A_AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH,
      'M4A AAC decoder failed',
    );
  } catch {
    return 'M4A AAC decoder failed';
  }
}

function postControl(message: M4aAacDecoderEvent): void {
  scope.postMessage(message);
}

function isSessionCancelled(error: unknown): boolean {
  try {
    return error instanceof SessionCancelledError;
  } catch {
    return false;
  }
}

function assertCurrent(session: DecoderSession): void {
  if (activeSession !== session || session.stopped || session.terminal) {
    throw new SessionCancelledError();
  }
}

function awaitSessionOperation<T>(
  session: DecoderSession,
  operation: Promise<T>,
  disposeLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let decided = false;
    const signal = session.abortController.signal;
    const removeAbortListener = (): void => {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // The session owns this exact AbortController.
      }
    };
    const onAbort = (): void => {
      if (decided) return;
      decided = true;
      removeAbortListener();
      reject(new SessionCancelledError());
    };
    operation.then(
      (value) => {
        if (decided) {
          try {
            disposeLateValue?.(value);
          } catch {
            // Stop remains authoritative over late cleanup.
          }
          return;
        }
        decided = true;
        removeAbortListener();
        resolve(value);
      },
      (error: unknown) => {
        if (decided) return;
        decided = true;
        removeAbortListener();
        reject(error);
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // Port cleanup is idempotent and best-effort.
  }
}

function clearBytes(bytes: Uint8Array | null | undefined): void {
  try {
    bytes?.fill(0);
  } catch {
    // Cleanup cannot replace the terminal decoder result.
  }
}

function clearPlanes(planes: readonly Float32Array[]): void {
  for (const plane of planes) {
    try {
      plane.fill(0);
    } catch {
      // Cleanup cannot replace the terminal decoder result.
    }
  }
}

function clearRawPcmBatch(value: unknown): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'planes');
    const planes = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
    if (!Array.isArray(planes)) return;
    for (const key of Reflect.ownKeys(planes)) {
      if (key === 'length' || typeof key !== 'string') continue;
      const plane = Reflect.getOwnPropertyDescriptor(planes, key)?.value;
      if (plane instanceof Float32Array) clearPlanes([plane]);
    }
  } catch {
    // Hostile cleanup values cannot replace their primary failure.
  }
}

function closeBackend(backend: AacDecoderBackend | null): void {
  if (!backend) return;
  try {
    backend.close();
  } catch {
    // Native cleanup cannot replace terminal ownership.
  }
}

function closeRuntime(runtime: M4aAacRuntime | null): void {
  if (!runtime) return;
  try {
    closeM4aAacRuntime(runtime);
  } catch {
    // Module-issued runtime close is specified as idempotent.
  }
}

function closeCursor(cursor: M4aRawAacAccessUnitReader | null): void {
  if (!cursor) return;
  try {
    closeM4aRawAacAccessUnitReader(cursor);
  } catch {
    // A runtime may already have revoked its sole cursor.
  }
}

function releaseSession(session: DecoderSession): void {
  if (session.released) return;
  session.released = true;
  if (!session.abortController.signal.aborted) {
    session.abortController.abort(new SessionCancelledError());
  }
  session.pcmPort.removeEventListener('message', session.pcmListener);
  session.pcmPort.removeEventListener('messageerror', session.pcmMessageErrorListener);
  session.pcmPort.onmessage = null;
  clearBytes(session.prefetchedAccessUnit?.bytes);
  session.prefetchedAccessUnit = null;
  closeRuntime(session.runtime);
  session.runtime = null;
  session.cursor = null;
  closeBackend(session.backend);
  session.backend = null;
  try {
    session.output?.close();
  } catch {
    // Local terminal ownership is already published.
  }
  session.output = null;
  try {
    void session.source.close().catch(() => undefined);
  } catch {
    // Source-port cleanup cannot replace the decoder result.
  }
  closePort(session.pcmPort);
}

function detachSession(session: DecoderSession): void {
  if (activeSession === session) activeSession = null;
}

function stopSession(session: DecoderSession): void {
  if (session.terminal) return;
  session.stopped = true;
  session.terminal = true;
  try {
    postControl({
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: 'decoder-stopped',
      sourceLifetimeGeneration: session.sourceLifetimeGeneration,
      decoderGeneration: session.decoderGeneration,
    });
  } finally {
    detachSession(session);
    releaseSession(session);
  }
}

function failSession(session: DecoderSession, error: unknown): void {
  if (session.terminal || session.stopped || isSessionCancelled(error)) return;
  session.stopped = true;
  session.terminal = true;
  try {
    const code = safeTerminalCode(error);
    const message = safeTerminalMessage(error);
    try {
      const supply: PcmSupplyMessage = {
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'source-error',
        generation: session.decoderGeneration,
        code,
      };
      session.pcmPort.postMessage(supply);
    } catch {
      // The control terminal event remains authoritative.
    }
    try {
      postControl({
        protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
        type: 'decoder-error',
        sourceLifetimeGeneration: session.sourceLifetimeGeneration,
        decoderGeneration: session.decoderGeneration,
        code,
        message,
      });
    } catch {
      // Teardown remains mandatory if the owner has disappeared.
    }
  } finally {
    detachSession(session);
    releaseSession(session);
  }
}

type CanaryRecord = Readonly<Record<string, unknown>>;

function snapshotCanaryRecord(value: unknown): CanaryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new M4aAacWorkerError(
      'canary-evidence-mismatch',
      'M4A AAC canary evidence is not a record',
    );
  }
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Reflect.getPrototypeOf(value);
  } catch (cause) {
    throw new M4aAacWorkerError(
      'canary-evidence-mismatch',
      'M4A AAC canary evidence could not be inspected',
      cause,
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new M4aAacWorkerError(
      'canary-evidence-mismatch',
      'M4A AAC canary evidence is not canonical',
    );
  }
  const expectedKeys = [
    'codec',
    'framing',
    'coreSampleRateHz',
    'coreChannelCount',
    'descriptionByteLength',
    'decodedCoreFrames',
    'outputCount',
    'timestampPropagationVerified',
    'f32PlanarCopyVerified',
  ];
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new M4aAacWorkerError(
      'canary-evidence-mismatch',
      'M4A AAC canary evidence fields are not exact',
    );
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new M4aAacWorkerError(
        'canary-evidence-mismatch',
        'M4A AAC canary evidence must use enumerable data fields',
      );
    }
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}

function verifyCanaryEvidence(value: unknown, descriptor: Readonly<M4aAacDecoderDescriptor>): void {
  const evidence = snapshotCanaryRecord(value);
  const descriptionLength = descriptor.manifest.codec.audioSpecificConfig.length;
  if (
    evidence.codec !== 'mp4a.40.2' ||
    evidence.framing !== 'raw-aac' ||
    evidence.coreSampleRateHz !== descriptor.manifest.codec.sampleRateHz ||
    evidence.coreChannelCount !== descriptor.manifest.codec.channelCount ||
    evidence.descriptionByteLength !== descriptionLength ||
    evidence.decodedCoreFrames !== AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES ||
    evidence.timestampPropagationVerified !== true ||
    evidence.f32PlanarCopyVerified !== true ||
    typeof evidence.outputCount !== 'number' ||
    !Number.isSafeInteger(evidence.outputCount) ||
    evidence.outputCount < 1 ||
    evidence.outputCount > WEB_CODECS_MAX_CANARY_OUTPUTS
  ) {
    throw new M4aAacWorkerError(
      'canary-evidence-mismatch',
      'M4A raw AAC WebCodecs canary contradicts the admitted stream',
    );
  }
}

function sameStartPlan(
  left: Readonly<M4aAacDecoderDescriptor['startPlan']>,
  right: Readonly<M4aAacDecoderDescriptor['startPlan']>,
): boolean {
  return M4A_AAC_DECODER_START_PLAN_KEYS.every((key) => left[key] === right[key]);
}

function canonicalCoreConfiguration(
  descriptor: Readonly<M4aAacDecoderDescriptor>,
): Readonly<AdtsCoreConfiguration> {
  const bytes = Uint8Array.from(descriptor.manifest.codec.audioSpecificConfig);
  try {
    const parsed = parseCanonicalAacLcAudioSpecificConfig(bytes);
    if (
      parsed.sampleRateHz !== descriptor.manifest.codec.sampleRateHz ||
      parsed.channelCount !== descriptor.manifest.codec.channelCount
    ) {
      throw new M4aAacWorkerError(
        'codec-configuration-mismatch',
        'M4A AAC AudioSpecificConfig contradicts the manifest codec geometry',
      );
    }
    return Object.freeze({
      mpegId: 0,
      profile: 1,
      coreAudioObjectType: 2,
      sampleRateIndex: parsed.sampleRateIndex,
      channelConfiguration: parsed.channelConfiguration,
      protectionAbsent: true,
      rawDataBlocks: 1,
    });
  } finally {
    clearBytes(bytes);
  }
}

function rawDescription(descriptor: Readonly<M4aAacDecoderDescriptor>): Uint8Array {
  return Uint8Array.from(descriptor.manifest.codec.audioSpecificConfig);
}

async function initializeSession(session: DecoderSession): Promise<void> {
  let canaryDescription: Uint8Array | null = null;
  try {
    if (session.backendId === 'symphonia-wasm') {
      throw new AacDecoderBackendUnavailableError(
        'The Symphonia WASM M4A AAC decoder backend has not been admitted',
      );
    }

    const runtime = await awaitSessionOperation(
      session,
      openM4aAacRuntime(
        new IsoBmffBoxReader(session.source),
        session.descriptor.manifest,
        session.abortController.signal,
      ),
      closeRuntime,
    );
    assertCurrent(session);
    session.runtime = runtime;

    const issuedPlan = runtime.createGenerationStartPlan(session.descriptor.startPlan.mediaFrame);
    if (!sameStartPlan(issuedPlan, session.descriptor.startPlan)) {
      throw new M4aAacWorkerError(
        'start-plan-mismatch',
        'M4A AAC runtime start plan contradicts the decoder descriptor',
      );
    }
    const cursor = await awaitSessionOperation(
      session,
      runtime.openAccessUnitReader(issuedPlan, session.abortController.signal),
      closeCursor,
    );
    assertCurrent(session);
    session.cursor = cursor;
    if (
      cursor.nextAccessUnitOrdinal !== session.descriptor.startPlan.decodeStartAccessUnitOrdinal
    ) {
      throw new M4aAacWorkerError(
        'access-unit-ordinal-mismatch',
        'M4A AAC cursor opened at the wrong logical access unit',
      );
    }
    session.consumedEncodedBytes = cursor.consumedEncodedBytes;
    session.lastProgressEncodedBytes = cursor.consumedEncodedBytes;

    const firstAccessUnit = await awaitSessionOperation(
      session,
      cursor.readNext(session.abortController.signal),
      (late) => clearBytes(late?.bytes),
    );
    assertCurrent(session);
    if (
      firstAccessUnit === null ||
      firstAccessUnit.descriptor.ordinal !==
        session.descriptor.startPlan.decodeStartAccessUnitOrdinal ||
      firstAccessUnit.descriptor.encodedBytePrefix !== session.consumedEncodedBytes
    ) {
      clearBytes(firstAccessUnit?.bytes);
      throw new M4aAacWorkerError(
        'access-unit-ordinal-mismatch',
        'M4A AAC cursor did not prefetch the exact decode-start access unit',
      );
    }
    session.prefetchedAccessUnit = firstAccessUnit;

    session.coreConfiguration = canonicalCoreConfiguration(session.descriptor);
    canaryDescription = rawDescription(session.descriptor);
    const evidence = await awaitSessionOperation(
      session,
      probeM4aRawAacWebCodecsAccessUnit(
        firstAccessUnit.bytes,
        canaryDescription,
        session.abortController.signal,
      ),
    );
    assertCurrent(session);
    verifyCanaryEvidence(evidence, session.descriptor);

    if (session.descriptor.manifest.codec.sampleRateHz !== session.descriptor.outputSampleRateHz) {
      await awaitSessionOperation(session, ensureBoundedPcmOutputRuntimeReady());
      assertCurrent(session);
    }

    const backendDescription = Object.freeze([
      ...session.descriptor.manifest.codec.audioSpecificConfig,
    ]) as typeof session.descriptor.manifest.codec.audioSpecificConfig;
    const backend = await awaitSessionOperation(
      session,
      createAacDecoderBackend(
        session.backendId,
        {
          coreConfiguration: session.coreConfiguration,
          firstAccessUnitOrdinal: session.descriptor.startPlan.decodeStartAccessUnitOrdinal,
          framing: { kind: 'raw', description: backendDescription },
        },
        session.abortController.signal,
      ),
      closeBackend,
    );
    try {
      assertCurrent(session);
    } catch (error) {
      closeBackend(backend);
      throw error;
    }
    session.backend = backend;

    session.output = new BoundedPcmOutput({
      sourceSampleRateHz: session.descriptor.manifest.codec.sampleRateHz,
      outputSampleRateHz: session.descriptor.outputSampleRateHz,
      channelCount: session.descriptor.manifest.codec.channelCount,
      totalSourceFrames: remainingM4aAacMediaFrames(session.descriptor),
      maxAppendFrames:
        AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
    });
    session.ready = true;
    session.pcmPort.addEventListener('message', session.pcmListener);
    session.pcmPort.addEventListener('messageerror', session.pcmMessageErrorListener);
    session.pcmPort.start();
    postControl({
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: 'decoder-ready',
      sourceLifetimeGeneration: session.sourceLifetimeGeneration,
      decoderGeneration: session.decoderGeneration,
      descriptor: session.descriptor,
      backendId: session.backendId,
    });
  } catch (error) {
    failSession(session, error);
  } finally {
    clearBytes(canaryDescription);
  }
}

interface ReadAccessUnitBatch {
  readonly accessUnits: readonly Readonly<AacDecoderAccessUnit>[];
  readonly nextAccessUnitOrdinal: number;
  readonly consumedEncodedBytes: number;
  readonly decodedRawCoreFrames: number;
  readonly physicalEof: boolean;
}

function validateAccessUnit(
  session: DecoderSession,
  read: Readonly<M4aRawAacAccessUnitRead>,
  expectedOrdinal: number,
  expectedEncodedPrefix: number,
): void {
  if (
    read.descriptor.ordinal !== expectedOrdinal ||
    read.descriptor.encodedBytePrefix !== expectedEncodedPrefix ||
    read.descriptor.byteLength !== read.bytes.byteLength
  ) {
    throw new M4aAacWorkerError(
      'access-unit-ordinal-mismatch',
      'M4A AAC cursor returned non-contiguous logical geometry',
    );
  }
  if (
    read.bytes.byteLength < 1 ||
    read.bytes.byteLength > AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES
  ) {
    throw new M4aAacWorkerError(
      'access-unit-size-mismatch',
      'M4A AAC access unit exceeds the admitted backend bound',
    );
  }
  if (expectedOrdinal >= session.descriptor.manifest.timeline.accessUnitCount) {
    throw new M4aAacWorkerError(
      'access-unit-ordinal-mismatch',
      'M4A AAC cursor advanced beyond the admitted access-unit count',
    );
  }
}

async function readAccessUnitBatch(session: DecoderSession): Promise<ReadAccessUnitBatch> {
  const cursor = session.cursor;
  if (!cursor) {
    throw new M4aAacWorkerError('decoder-not-ready', 'M4A AAC cursor is unavailable');
  }
  const accessUnitCount = session.descriptor.manifest.timeline.accessUnitCount;
  const remaining = accessUnitCount - session.nextAccessUnitOrdinal;
  if (remaining <= 0) {
    throw new M4aAacWorkerError(
      'unexpected-input-eof',
      'M4A AAC decode cursor already reached physical EOF',
    );
  }
  const requestedCount = Math.min(AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS, remaining);
  const accessUnits: Readonly<AacDecoderAccessUnit>[] = [];
  let nextOrdinal = session.nextAccessUnitOrdinal;
  let consumedEncodedBytes = session.consumedEncodedBytes;
  let cumulativeBytes = 0;

  try {
    for (let index = 0; index < requestedCount; index += 1) {
      assertCurrent(session);
      let read = session.prefetchedAccessUnit;
      if (read !== null) {
        session.prefetchedAccessUnit = null;
      } else {
        read = await awaitSessionOperation(
          session,
          cursor.readNext(session.abortController.signal),
          (late) => clearBytes(late?.bytes),
        );
        assertCurrent(session);
      }
      if (read === null) {
        throw new M4aAacWorkerError(
          'unexpected-input-eof',
          `M4A AAC input ended before access unit ${nextOrdinal}`,
        );
      }
      try {
        validateAccessUnit(session, read, nextOrdinal, consumedEncodedBytes);
        const nextCumulativeBytes = cumulativeBytes + read.bytes.byteLength;
        if (
          !Number.isSafeInteger(nextCumulativeBytes) ||
          nextCumulativeBytes > AAC_DECODER_BACKEND_MAX_BATCH_ENCODED_BYTES
        ) {
          throw new M4aAacWorkerError(
            'access-unit-batch-overrun',
            'M4A AAC batch exceeds its fixed encoded-byte bound',
          );
        }
        const nextConsumedEncodedBytes = consumedEncodedBytes + read.bytes.byteLength;
        if (!Number.isSafeInteger(nextConsumedEncodedBytes)) {
          throw new M4aAacWorkerError(
            'encoded-byte-cursor-overrun',
            'M4A AAC logical encoded-byte cursor exceeds safe integers',
          );
        }
        accessUnits.push(Object.freeze({ accessUnitOrdinal: nextOrdinal, bytes: read.bytes }));
        cumulativeBytes = nextCumulativeBytes;
        consumedEncodedBytes = nextConsumedEncodedBytes;
        nextOrdinal += 1;
      } catch (error) {
        clearBytes(read.bytes);
        throw error;
      }
    }

    const decodedRawCoreFrames = nextOrdinal * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
    if (!Number.isSafeInteger(decodedRawCoreFrames)) {
      throw new M4aAacWorkerError(
        'core-cursor-mismatch',
        'M4A AAC raw core cursor exceeds safe integers',
      );
    }
    const physicalEof = nextOrdinal === accessUnitCount;
    if (
      cursor.nextAccessUnitOrdinal !== nextOrdinal ||
      cursor.consumedEncodedBytes !== consumedEncodedBytes ||
      (physicalEof &&
        consumedEncodedBytes !== session.descriptor.manifest.sampleSizes.totalEncodedBytes) ||
      (!physicalEof &&
        consumedEncodedBytes >= session.descriptor.manifest.sampleSizes.totalEncodedBytes)
    ) {
      throw new M4aAacWorkerError(
        'physical-eof-mismatch',
        'M4A AAC cursor contradicts the authenticated logical EOF',
      );
    }
    return Object.freeze({
      accessUnits: Object.freeze(accessUnits.slice()),
      nextAccessUnitOrdinal: nextOrdinal,
      consumedEncodedBytes,
      decodedRawCoreFrames,
      physicalEof,
    });
  } catch (error) {
    for (const accessUnit of accessUnits) clearBytes(accessUnit.bytes);
    throw error;
  }
}

function appendCanonicalBatch(
  session: DecoderSession,
  batch: Readonly<AacDecoderPcmBatch>,
  readBatch: Readonly<ReadAccessUnitBatch>,
): void {
  const output = session.output;
  if (!output) {
    throw new M4aAacWorkerError('decoder-not-ready', 'M4A AAC PCM output is unavailable');
  }
  const timeline = session.descriptor.manifest.timeline;
  const batchRawStart = batch.firstAccessUnitOrdinal * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
  const batchRawEnd = batchRawStart + batch.frameCount;
  const publishRawStart = session.descriptor.startPlan.rawTargetCoreFrame;
  const publishRawEnd = timeline.presentationEndCoreFrames;
  if (
    !Number.isSafeInteger(batchRawStart) ||
    !Number.isSafeInteger(batchRawEnd) ||
    batchRawStart !== session.decodedRawCoreFrames ||
    batchRawEnd !== readBatch.decodedRawCoreFrames ||
    publishRawEnd - publishRawStart !== output.totalSourceFrames ||
    batchRawEnd > timeline.rawCoreFrames ||
    (readBatch.physicalEof
      ? batchRawEnd !== timeline.rawCoreFrames
      : batchRawEnd >= timeline.rawCoreFrames)
  ) {
    throw new M4aAacWorkerError(
      'core-cursor-mismatch',
      'M4A AAC decoded batch contradicts its absolute raw-core interval',
    );
  }

  // Every batch is clipped by absolute raw-core coordinates. This makes a
  // leading partial seek, whole intermediate batches, and the final stts/iTun
  // padding use one monotonic rule while decoding still continues to file EOF.
  const acceptedThrough = (rawCoreFrame: number): number =>
    Math.max(0, Math.min(rawCoreFrame, publishRawEnd) - publishRawStart);
  const expectedAcceptedBefore = acceptedThrough(batchRawStart);
  const expectedAcceptedAfter = acceptedThrough(batchRawEnd);
  const keptFrames = expectedAcceptedAfter - expectedAcceptedBefore;
  if (
    !Number.isSafeInteger(keptFrames) ||
    keptFrames < 0 ||
    output.acceptedSourceFrames !== expectedAcceptedBefore ||
    expectedAcceptedAfter > output.totalSourceFrames ||
    (readBatch.physicalEof && expectedAcceptedAfter !== output.totalSourceFrames)
  ) {
    throw new M4aAacWorkerError(
      'source-frame-mismatch',
      'M4A AAC publish interval contradicts the bounded PCM timeline',
    );
  }

  if (keptFrames > 0) {
    const firstKeptRawFrame = Math.max(batchRawStart, publishRawStart);
    const firstKeptBatchFrame = firstKeptRawFrame - batchRawStart;
    const channels = batch.planes.map((plane) =>
      plane.subarray(firstKeptBatchFrame, firstKeptBatchFrame + keptFrames),
    );
    output.append(channels, keptFrames);
  }
  if (readBatch.physicalEof) output.endInput();
}

async function decodeNextBatch(session: DecoderSession): Promise<boolean> {
  assertCurrent(session);
  const backend = session.backend;
  const output = session.output;
  const coreConfiguration = session.coreConfiguration;
  if (!backend || !output || !coreConfiguration) {
    throw new M4aAacWorkerError('decoder-not-ready', 'M4A AAC decoder generation is incomplete');
  }

  const readBatch = await readAccessUnitBatch(session);
  assertCurrent(session);
  const first = readBatch.accessUnits[0];
  if (!first) {
    throw new M4aAacWorkerError(
      'empty-access-unit-batch',
      'M4A AAC cursor produced an empty batch',
    );
  }
  let rawBatch: unknown;
  let canonicalBatch: Readonly<AacDecoderPcmBatch> | null = null;
  try {
    rawBatch = await awaitSessionOperation(
      session,
      backend.decodeBatch(readBatch.accessUnits, session.abortController.signal),
      clearRawPcmBatch,
    );
    assertCurrent(session);
    canonicalBatch = snapshotAacDecoderPcmBatch(
      rawBatch,
      {
        firstAccessUnitOrdinal: first.accessUnitOrdinal,
        accessUnitCount: readBatch.accessUnits.length,
        coreConfiguration,
      },
      session.abortController.signal,
    );
    assertCurrent(session);

    appendCanonicalBatch(session, canonicalBatch, readBatch);
    session.nextAccessUnitOrdinal = readBatch.nextAccessUnitOrdinal;
    session.consumedEncodedBytes = readBatch.consumedEncodedBytes;
    session.decodedRawCoreFrames = readBatch.decodedRawCoreFrames;
    session.inputEnded = readBatch.physicalEof;
    postProgress(session, readBatch.physicalEof);
    return !readBatch.physicalEof;
  } finally {
    for (const accessUnit of readBatch.accessUnits) clearBytes(accessUnit.bytes);
    if (canonicalBatch) clearPlanes(canonicalBatch.planes);
    clearRawPcmBatch(rawBatch);
  }
}

function logicalProgress(session: DecoderSession) {
  return {
    nextAccessUnitOrdinal: session.nextAccessUnitOrdinal,
    consumedEncodedBytes: session.consumedEncodedBytes,
    decodedRawCoreFrames: session.decodedRawCoreFrames,
    acceptedMediaFrames: session.output?.acceptedSourceFrames ?? 0,
    producedOutputFrames: session.output?.producedOutputFrames ?? 0,
  } as const;
}

function postProgress(session: DecoderSession, force = false): void {
  assertCurrent(session);
  if (
    !force &&
    session.consumedEncodedBytes - session.lastProgressEncodedBytes < PROGRESS_INTERVAL_BYTES
  ) {
    return;
  }
  session.lastProgressEncodedBytes = session.consumedEncodedBytes;
  postControl({
    protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
    type: 'decode-progress',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    ...logicalProgress(session),
  });
}

function postPcmSegment(session: DecoderSession, maxFrames: number): boolean {
  const output = session.output;
  if (!output) {
    throw new M4aAacWorkerError('decoder-not-ready', 'M4A AAC PCM output is unavailable');
  }
  const segment = output.pull(maxFrames);
  if (!segment) return false;
  const channels = segment.channels.map((channel) => channel.buffer as ArrayBuffer);
  const supply: PcmSupplyMessage = {
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'pcm',
    generation: session.decoderGeneration,
    frames: segment.frames,
    channels,
    final: segment.final,
  };
  session.pcmPort.postMessage(supply, channels);
  if (segment.final) finishSession(session, true);
  return true;
}

function finishSession(session: DecoderSession, sentFinalPcm: boolean): void {
  assertCurrent(session);
  const output = session.output;
  if (!output || !output.finished) {
    throw new M4aAacWorkerError(
      'output-not-finished',
      'M4A AAC PCM output reached an incomplete EOF',
    );
  }
  const expected = expectedM4aAacDecoderEofProgress(session.descriptor);
  const actual = logicalProgress(session);
  if (
    actual.nextAccessUnitOrdinal !== expected.nextAccessUnitOrdinal ||
    actual.consumedEncodedBytes !== expected.consumedEncodedBytes ||
    actual.decodedRawCoreFrames !== expected.decodedRawCoreFrames ||
    actual.acceptedMediaFrames !== expected.acceptedMediaFrames ||
    actual.producedOutputFrames !== expected.producedOutputFrames
  ) {
    throw new M4aAacWorkerError(
      'output-frame-mismatch',
      'M4A AAC decoder EOF counters contradict the exact descriptor geometry',
    );
  }
  try {
    if (!sentFinalPcm) {
      const supply: PcmSupplyMessage = {
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'eof',
        generation: session.decoderGeneration,
      };
      session.pcmPort.postMessage(supply);
    }
    postControl({
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: 'decoder-eof',
      sourceLifetimeGeneration: session.sourceLifetimeGeneration,
      decoderGeneration: session.decoderGeneration,
      ...actual,
    });
  } catch (error) {
    // Keep terminal cleanup local to EOF publication. The request-chain owner
    // also fails closed, but this function must remain safe if reused directly.
    failSession(session, error);
    return;
  }
  completedGeneration = Object.freeze({
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
  });
  session.stopped = true;
  session.terminal = true;
  detachSession(session);
  releaseSession(session);
}

async function satisfyDemand(session: DecoderSession, maxFrames: number): Promise<void> {
  assertCurrent(session);
  while (true) {
    if (postPcmSegment(session, maxFrames)) return;
    assertCurrent(session);
    const output = session.output;
    if (!output) {
      throw new M4aAacWorkerError('decoder-not-ready', 'M4A AAC PCM output is unavailable');
    }
    if (output.finished) {
      finishSession(session, false);
      return;
    }
    if (
      !output.needsInput &&
      output.acceptedSourceFrames === output.totalSourceFrames &&
      !session.inputEnded
    ) {
      await decodeNextBatch(session);
      continue;
    }
    if (!output.needsInput) {
      throw new M4aAacWorkerError(
        'pcm-output-stalled',
        'M4A AAC PCM output made no bounded progress',
      );
    }
    await decodeNextBatch(session);
  }
}

function receivePcmDemand(session: DecoderSession, value: unknown): void {
  if (!session.ready || session.terminal) return;
  const demand = parsePcmDemandMessage(value);
  if (!demand || demand.generation !== session.decoderGeneration || session.demandPending) {
    failSession(
      session,
      new M4aAacWorkerError('invalid-pcm-demand', 'M4A AAC PCM demand failed strict validation'),
    );
    return;
  }
  session.demandPending = true;
  const task = session.requestChain.then(() => satisfyDemand(session, demand.maxFrames));
  session.requestChain = task
    .catch((error: unknown) => failSession(session, error))
    .finally(() => {
      session.demandPending = false;
    });
}

function createSession(command: Readonly<M4aAacDecoderOpenCommand>): DecoderSession {
  const sourceClient = new EncodedSourcePortClient({
    port: command.sourcePort,
    generation: command.sourceLifetimeGeneration,
    size: command.descriptor.sourceSize,
    maxPendingReads: 1,
  });
  let source: RetryingPortEncodedSource;
  try {
    source = new RetryingPortEncodedSource({
      size: command.descriptor.sourceSize,
      identity: command.descriptor.sourceIdentity,
      client: sourceClient,
    });
  } catch (error) {
    void sourceClient.close().catch(() => undefined);
    throw error;
  }
  const abortController = new AbortController();
  const startOrdinal = command.descriptor.startPlan.decodeStartAccessUnitOrdinal;
  const session: DecoderSession = {
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    backendId: command.backendId,
    descriptor: command.descriptor,
    source,
    pcmPort: command.pcmPort,
    abortController,
    pcmListener: (event) => receivePcmDemand(session, event.data),
    pcmMessageErrorListener: () =>
      failSession(
        session,
        new M4aAacWorkerError(
          'pcm-message-deserialization',
          'M4A AAC PCM demand could not deserialize',
        ),
      ),
    runtime: null,
    cursor: null,
    prefetchedAccessUnit: null,
    backend: null,
    output: null,
    coreConfiguration: null,
    nextAccessUnitOrdinal: startOrdinal,
    consumedEncodedBytes: 0,
    decodedRawCoreFrames: startOrdinal * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
    lastProgressEncodedBytes: 0,
    requestChain: Promise.resolve(),
    demandPending: false,
    inputEnded: false,
    ready: false,
    stopped: false,
    terminal: false,
    released: false,
  };
  return session;
}

function closeTransferredPorts(value: unknown): void {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
  for (const key of ['sourcePort', 'pcmPort'] as const) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      continue;
    }
    if (
      descriptor &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.value instanceof MessagePort
    ) {
      closePort(descriptor.value);
    }
  }
}

function failWorkerProtocol(value: unknown): never | void {
  closeTransferredPorts(value);
  const session = activeSession;
  if (session) {
    failSession(
      session,
      new M4aAacWorkerError('invalid-command', 'M4A AAC worker command failed strict validation'),
    );
    return;
  }
  realmOpened = true;
  throw new M4aAacWorkerError('invalid-command', 'M4A AAC worker command failed strict validation');
}

function handleCommand(value: unknown): void {
  const command = parseM4aAacDecoderCommand(value);
  if (!command) {
    failWorkerProtocol(value);
    return;
  }
  if (command.type === 'open-decoder') {
    if (realmOpened || activeSession) {
      failWorkerProtocol(command);
      return;
    }
    realmOpened = true;
    let session: DecoderSession;
    try {
      session = createSession(command);
    } catch (error) {
      closePort(command.sourcePort);
      closePort(command.pcmPort);
      throw error;
    }
    activeSession = session;
    void initializeSession(session);
    return;
  }

  const session = activeSession;
  if (
    !session &&
    completedGeneration?.sourceLifetimeGeneration === command.sourceLifetimeGeneration &&
    completedGeneration.decoderGeneration === command.decoderGeneration
  ) {
    postControl({
      protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
      type: 'decoder-stopped',
      sourceLifetimeGeneration: command.sourceLifetimeGeneration,
      decoderGeneration: command.decoderGeneration,
    });
    completedGeneration = null;
    return;
  }
  if (
    !session ||
    command.sourceLifetimeGeneration !== session.sourceLifetimeGeneration ||
    command.decoderGeneration !== session.decoderGeneration
  ) {
    failWorkerProtocol(command);
    return;
  }
  stopSession(session);
}

scope.onmessage = (event: MessageEvent<unknown>) => handleCommand(event.data);

scope.addEventListener('messageerror', () => {
  const session = activeSession;
  if (session) {
    failSession(
      session,
      new M4aAacWorkerError(
        'message-deserialization',
        'M4A AAC worker command could not deserialize',
      ),
    );
    return;
  }
  realmOpened = true;
  throw new M4aAacWorkerError(
    'message-deserialization',
    'M4A AAC worker command could not deserialize',
  );
});

export {};
