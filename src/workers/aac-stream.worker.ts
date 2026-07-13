/// <reference lib="webworker" />

import {
  AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
  AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS,
  AacDecoderBackendIntegrityError,
  AacDecoderBackendUnavailableError,
  snapshotAacDecoderPcmBatch,
  type AacDecoderAccessUnit,
  type AacDecoderBackend,
  type AacDecoderPcmBatch,
} from '../player/aac/decoder-backend.js';
import {
  AAC_CAPABILITY_PROBE_GENERATION,
  AAC_CAPABILITY_PROBE_MAX_ERROR_MESSAGE_LENGTH,
  AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
  parseAacCapabilityProbeCommand,
  type AacCapabilityProbeCommand,
  type AacCapabilityProbeErrorCode,
  type AacCapabilityProbeEvent,
} from '../player/aac/capability-probe-protocol.js';
import { createAacDecoderBackend } from '../player/aac/decoder-backend-factory.js';
import { expectedAacOutputFrames } from '../player/aac/decoder-helpers.js';
import {
  AAC_DECODER_MAX_ERROR_CODE_LENGTH,
  AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH,
  AAC_DECODER_PROTOCOL_VERSION,
  parseAacDecoderCommand,
  type AacDecoderDescriptor,
  type AacDecoderEvent,
  type AacDecoderOpenCommand,
} from '../player/aac/decoder-protocol.js';
import {
  ADTS_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES,
  AdtsIncrementalFrameReader,
  AdtsIncrementalFrameReaderError,
} from '../player/aac/incremental-frame-reader.js';
import {
  AacWebCodecsIntegrityError,
  AacWebCodecsUnavailableError,
  probeAacWebCodecsAdtsFrame,
} from '../player/aac/webcodecs-canary.js';
import {
  ENCODED_SOURCE_PORT_MAX_READ_BYTES,
  EncodedSourcePortClient,
  EncodedSourcePortError,
} from '../player/sources/encoded-source-port.js';
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

class AacWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'AacWorkerError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

class SessionCancelledError extends Error {
  constructor() {
    super('AAC decoder session was cancelled');
    this.name = 'SessionCancelledError';
  }
}

interface DecoderSession {
  readonly sourceLifetimeGeneration: number;
  readonly decoderGeneration: number;
  readonly backendId: AacDecoderOpenCommand['backendId'];
  readonly descriptor: Readonly<AacDecoderDescriptor>;
  readonly sourceClient: EncodedSourcePortClient;
  readonly source: RetryingPortEncodedSource;
  readonly pcmPort: MessagePort;
  readonly abortController: AbortController;
  readonly pcmListener: (event: MessageEvent<unknown>) => void;
  readonly pcmMessageErrorListener: () => void;
  backend: AacDecoderBackend | null;
  decodeReader: AdtsIncrementalFrameReader | null;
  output: BoundedPcmOutput | null;
  decodedInputBytes: number;
  decodedCoreFrames: number;
  remainingDiscardCoreFrames: number;
  lastProgressInputBytes: number;
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
  if (error instanceof AacWorkerError) return error.code;
  if (error instanceof RetryingPortEncodedSourceError) return error.code;
  if (error instanceof EncodedSourcePortError) return `source-${error.code}`;
  if (error instanceof AdtsIncrementalFrameReaderError) return 'input-integrity';
  if (error instanceof AacWebCodecsUnavailableError) return 'canary-unavailable';
  if (error instanceof AacWebCodecsIntegrityError) return 'canary-integrity';
  if (error instanceof AacDecoderBackendUnavailableError) return 'backend-unavailable';
  if (error instanceof AacDecoderBackendIntegrityError) return 'backend-integrity';
  if (error instanceof BoundedPcmOutputError) return 'pcm-output-failed';
  return 'decode-failed';
}

function safeTerminalCode(error: unknown): string {
  try {
    return boundedText(errorCode(error), AAC_DECODER_MAX_ERROR_CODE_LENGTH, 'decode-failed');
  } catch {
    return 'decode-failed';
  }
}

function safeTerminalMessage(error: unknown): string {
  try {
    return boundedText(
      errorMessage(error),
      AAC_DECODER_MAX_ERROR_MESSAGE_LENGTH,
      'AAC decoder failed',
    );
  } catch {
    return 'AAC decoder failed';
  }
}

function isSessionCancelled(error: unknown): boolean {
  try {
    return error instanceof SessionCancelledError;
  } catch {
    return false;
  }
}

function postControl(message: AacDecoderEvent): void {
  scope.postMessage(message);
}

function postCapability(message: AacCapabilityProbeEvent): void {
  scope.postMessage(message);
}

function assertCurrent(session: DecoderSession): void {
  if (activeSession !== session || session.stopped || session.terminal) {
    throw new SessionCancelledError();
  }
}

/**
 * Stop owns the generation even when a native/WASM promise ignores AbortSignal.
 * A late value is consumed at its ownership boundary and a late rejection is
 * deliberately observed so neither can resurrect the stopped session.
 */
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
        // The session owns its private AbortController.
      }
    };
    const disposeLate = (value: T): void => {
      try {
        disposeLateValue?.(value);
      } catch {
        // Late cleanup cannot replace the already-authoritative stop.
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
          disposeLate(value);
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
    // The peer may already have closed or disentangled its endpoint.
  }
}

function clearBytes(bytes: Uint8Array): void {
  try {
    bytes.fill(0);
  } catch {
    // Cleanup is best-effort and must not replace a terminal decoder result.
  }
}

function clearPlanes(planes: readonly Float32Array[]): void {
  for (const plane of planes) {
    try {
      plane.fill(0);
    } catch {
      // Cleanup is best-effort and must not replace a terminal decoder result.
    }
  }
}

function clearRawPcmBatch(value: unknown): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  try {
    const planesDescriptor = Reflect.getOwnPropertyDescriptor(value, 'planes');
    if (!planesDescriptor || !Object.hasOwn(planesDescriptor, 'value')) return;
    const planes = planesDescriptor.value;
    if (!Array.isArray(planes)) return;
    for (const key of Reflect.ownKeys(planes)) {
      if (key === 'length' || typeof key !== 'string') continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(planes, key);
      if (
        descriptor &&
        Object.hasOwn(descriptor, 'value') &&
        descriptor.value instanceof Float32Array
      ) {
        try {
          descriptor.value.fill(0);
        } catch {
          // A detached or hostile view is already unusable.
        }
      }
    }
  } catch {
    // Hostile cleanup objects cannot replace the authoritative failure.
  }
}

function closeBackend(backend: AacDecoderBackend | null): void {
  if (!backend) return;
  try {
    backend.close();
  } catch {
    // Fresh-realm teardown remains authoritative over native cleanup errors.
  }
}

/** One terminal cleanup order shared by stop, error, and normal EOF. */
function releaseSession(session: DecoderSession): void {
  if (session.released) return;
  session.released = true;
  if (!session.abortController.signal.aborted) {
    session.abortController.abort(new SessionCancelledError());
  }
  session.pcmPort.removeEventListener('message', session.pcmListener);
  session.pcmPort.removeEventListener('messageerror', session.pcmMessageErrorListener);
  session.pcmPort.onmessage = null;
  closeBackend(session.backend);
  session.backend = null;
  try {
    session.output?.close();
  } catch {
    // Local terminal ownership is already published.
  }
  session.output = null;
  session.decodeReader = null;
  try {
    void session.source.close().catch(() => undefined);
  } catch {
    // Source-port cleanup cannot replace the decoder terminal result.
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
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
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
  if (session.terminal || isSessionCancelled(error)) return;
  if (session.stopped) return;

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
      // The control event remains authoritative if PCM delivery failed.
    }
    try {
      postControl({
        protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
        type: 'decoder-error',
        sourceLifetimeGeneration: session.sourceLifetimeGeneration,
        decoderGeneration: session.decoderGeneration,
        code,
        message,
      });
    } catch {
      // Teardown remains mandatory if the owner has already gone away.
    }
  } finally {
    detachSession(session);
    releaseSession(session);
  }
}

type CanaryRecord = Readonly<Record<string, unknown>>;

function snapshotCanaryRecord(value: unknown): CanaryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AacWorkerError('canary-evidence-mismatch', 'AAC canary evidence is not a record');
  }
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Reflect.getPrototypeOf(value);
  } catch (cause) {
    throw new AacWorkerError(
      'canary-evidence-mismatch',
      'AAC canary evidence could not be inspected',
      cause,
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AacWorkerError('canary-evidence-mismatch', 'AAC canary evidence is not canonical');
  }
  const expectedKeys = [
    'codec',
    'framing',
    'coreSampleRateHz',
    'coreChannelCount',
    'decodedCoreFrames',
    'outputCount',
    'f32PlanarCopyVerified',
  ];
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new AacWorkerError(
      'canary-evidence-mismatch',
      'AAC canary evidence fields are not exact',
    );
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new AacWorkerError(
        'canary-evidence-mismatch',
        'AAC canary evidence must use enumerable data fields',
      );
    }
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}

function verifyCanaryEvidence(value: unknown, descriptor: Readonly<AacDecoderDescriptor>): void {
  const evidence = snapshotCanaryRecord(value);
  if (
    evidence.codec !== 'mp4a.40.2' ||
    evidence.framing !== 'adts' ||
    evidence.coreSampleRateHz !== descriptor.coreSampleRateHz ||
    evidence.coreChannelCount !== descriptor.channels ||
    evidence.decodedCoreFrames !== AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES ||
    evidence.f32PlanarCopyVerified !== true ||
    typeof evidence.outputCount !== 'number' ||
    !Number.isSafeInteger(evidence.outputCount) ||
    evidence.outputCount < 1 ||
    evidence.outputCount > WEB_CODECS_MAX_CANARY_OUTPUTS
  ) {
    throw new AacWorkerError(
      'canary-evidence-mismatch',
      'AAC WebCodecs canary geometry contradicts the verified stream',
    );
  }
}

function createFrameReader(
  session: DecoderSession,
  start: { readonly byteOffset: number; readonly frameOrdinal: number },
): AdtsIncrementalFrameReader {
  return new AdtsIncrementalFrameReader({
    source: session.source,
    start,
    expectedConfig: session.descriptor.coreConfiguration,
    pageBytes: Math.min(
      ADTS_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES,
      ENCODED_SOURCE_PORT_MAX_READ_BYTES,
    ),
  });
}

async function resolveDecodeStartByteOffset(session: DecoderSession): Promise<number> {
  const plan = session.descriptor.startPlan;
  const scanner = createFrameReader(session, {
    byteOffset: plan.scanAnchorByteOffset,
    frameOrdinal: plan.scanAnchorAccessUnitOrdinal,
  });

  while (true) {
    assertCurrent(session);
    const frame = await awaitSessionOperation(
      session,
      scanner.readNext(session.abortController.signal),
      (lateFrame) => {
        if (lateFrame) clearBytes(lateFrame.bytes);
      },
    );
    assertCurrent(session);
    if (!frame || frame.descriptor.frameOrdinal > plan.decodeStartAccessUnitOrdinal) {
      throw new AacWorkerError(
        'seek-target-missing',
        'AAC anchor scan ended before its exact decode-start access unit',
      );
    }

    const reachedDecodeStart = frame.descriptor.frameOrdinal === plan.decodeStartAccessUnitOrdinal;
    try {
      if (!reachedDecodeStart) continue;
      if (session.backendId === 'webcodecs') {
        const evidence = await awaitSessionOperation(
          session,
          probeAacWebCodecsAdtsFrame(frame.bytes, session.abortController.signal),
        );
        assertCurrent(session);
        verifyCanaryEvidence(evidence, session.descriptor);
      }
      return frame.descriptor.byteOffset;
    } finally {
      clearBytes(frame.bytes);
    }
  }
}

async function initializeSession(session: DecoderSession): Promise<void> {
  try {
    const decodeStartByteOffset = await resolveDecodeStartByteOffset(session);
    assertCurrent(session);

    session.decodeReader = createFrameReader(session, {
      byteOffset: decodeStartByteOffset,
      frameOrdinal: session.descriptor.startPlan.decodeStartAccessUnitOrdinal,
    });
    session.decodedInputBytes = decodeStartByteOffset;
    session.lastProgressInputBytes = decodeStartByteOffset;
    session.decodedCoreFrames =
      session.descriptor.startPlan.decodeStartAccessUnitOrdinal *
      AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;

    if (session.descriptor.coreSampleRateHz !== session.descriptor.outputSampleRateHz) {
      await awaitSessionOperation(session, ensureBoundedPcmOutputRuntimeReady());
      assertCurrent(session);
    }

    const candidate = await awaitSessionOperation(
      session,
      createAacDecoderBackend(
        session.backendId,
        {
          coreConfiguration: session.descriptor.coreConfiguration,
          firstAccessUnitOrdinal: session.descriptor.startPlan.decodeStartAccessUnitOrdinal,
          framing: { kind: 'adts' },
        },
        session.abortController.signal,
      ),
      closeBackend,
    );
    try {
      assertCurrent(session);
    } catch (error) {
      closeBackend(candidate);
      throw error;
    }
    session.backend = candidate;

    session.output = new BoundedPcmOutput({
      sourceSampleRateHz: session.descriptor.coreSampleRateHz,
      outputSampleRateHz: session.descriptor.outputSampleRateHz,
      channelCount: session.descriptor.channels,
      totalSourceFrames:
        session.descriptor.timeline.totalMediaFrames - session.descriptor.startPlan.mediaFrame,
      maxAppendFrames:
        AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
    });
    session.ready = true;
    session.pcmPort.addEventListener('message', session.pcmListener);
    session.pcmPort.addEventListener('messageerror', session.pcmMessageErrorListener);
    session.pcmPort.start();
    postControl({
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
      type: 'decoder-ready',
      sourceLifetimeGeneration: session.sourceLifetimeGeneration,
      decoderGeneration: session.decoderGeneration,
      descriptor: session.descriptor,
      backendId: session.backendId,
    });
  } catch (error) {
    failSession(session, error);
  }
}

interface ReadAccessUnitBatch {
  readonly accessUnits: readonly Readonly<AacDecoderAccessUnit>[];
  readonly byteEndOffset: number;
  readonly nextCoreFrame: number;
  readonly physicalEof: boolean;
}

async function readAccessUnitBatch(session: DecoderSession): Promise<ReadAccessUnitBatch> {
  const reader = session.decodeReader;
  if (!reader) throw new AacWorkerError('decoder-not-ready', 'AAC decode reader is unavailable');
  const firstAccessUnitOrdinal =
    session.decodedCoreFrames / AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
  if (!Number.isSafeInteger(firstAccessUnitOrdinal)) {
    throw new AacWorkerError('core-cursor-mismatch', 'AAC core cursor is not AU-aligned');
  }
  const remainingAccessUnits = session.descriptor.frameCount - firstAccessUnitOrdinal;
  if (remainingAccessUnits <= 0) {
    throw new AacWorkerError('unexpected-input-eof', 'AAC decode cursor already reached EOF');
  }
  const requestedCount = Math.min(AAC_DECODER_BACKEND_MAX_BATCH_ACCESS_UNITS, remainingAccessUnits);
  const accessUnits: Readonly<AacDecoderAccessUnit>[] = [];
  let byteEndOffset = session.decodedInputBytes;

  try {
    for (let index = 0; index < requestedCount; index += 1) {
      assertCurrent(session);
      const frame = await awaitSessionOperation(
        session,
        reader.readNext(session.abortController.signal),
        (lateFrame) => {
          if (lateFrame) clearBytes(lateFrame.bytes);
        },
      );
      assertCurrent(session);
      const expectedOrdinal = firstAccessUnitOrdinal + index;
      if (!frame) {
        throw new AacWorkerError(
          'unexpected-input-eof',
          `AAC input ended before access unit ${expectedOrdinal}`,
        );
      }
      if (frame.descriptor.frameOrdinal !== expectedOrdinal) {
        clearBytes(frame.bytes);
        throw new AacWorkerError(
          'access-unit-ordinal-mismatch',
          'AAC reader returned a non-contiguous access-unit ordinal',
        );
      }
      byteEndOffset = frame.descriptor.byteEndOffset;
      accessUnits.push(
        Object.freeze({
          accessUnitOrdinal: expectedOrdinal,
          bytes: frame.bytes,
        }),
      );
    }

    const nextAccessUnitOrdinal = firstAccessUnitOrdinal + accessUnits.length;
    const nextCoreFrame = nextAccessUnitOrdinal * AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
    if (!Number.isSafeInteger(nextCoreFrame)) {
      throw new AacWorkerError(
        'core-cursor-mismatch',
        'AAC next core cursor exceeds safe integers',
      );
    }
    const physicalEof = nextAccessUnitOrdinal === session.descriptor.frameCount;
    if (
      (physicalEof && byteEndOffset !== session.descriptor.audioEndByteOffset) ||
      (!physicalEof && byteEndOffset >= session.descriptor.audioEndByteOffset)
    ) {
      throw new AacWorkerError(
        'physical-eof-mismatch',
        'AAC access-unit count contradicts its exact physical EOF',
      );
    }
    return Object.freeze({
      accessUnits: Object.freeze(accessUnits.slice()),
      byteEndOffset,
      nextCoreFrame,
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
  physicalEof: boolean,
): number {
  const output = session.output;
  if (!output) throw new AacWorkerError('decoder-not-ready', 'AAC PCM output is unavailable');
  const discard = Math.min(session.remainingDiscardCoreFrames, batch.frameCount);
  const remainingDiscard = session.remainingDiscardCoreFrames - discard;
  const keptFrames = batch.frameCount - discard;
  const acceptedAfter = output.acceptedSourceFrames + keptFrames;
  if (!Number.isSafeInteger(acceptedAfter) || acceptedAfter > output.totalSourceFrames) {
    throw new AacWorkerError(
      'source-frame-mismatch',
      'AAC decoded PCM exceeds its exact media timeline',
    );
  }
  if (physicalEof) {
    if (remainingDiscard !== 0 || acceptedAfter !== output.totalSourceFrames) {
      throw new AacWorkerError(
        'source-frame-mismatch',
        `AAC decoder would accept ${acceptedAfter} media frames; expected ${output.totalSourceFrames}`,
      );
    }
  } else if (acceptedAfter >= output.totalSourceFrames) {
    throw new AacWorkerError(
      'source-frame-mismatch',
      'AAC media timeline ended before its verified final access unit',
    );
  }

  if (keptFrames > 0) {
    const clipped = batch.planes.map((plane) => plane.subarray(discard));
    output.append(clipped, keptFrames);
  }
  if (physicalEof) output.endInput();
  return remainingDiscard;
}

async function decodeNextBatch(session: DecoderSession): Promise<boolean> {
  assertCurrent(session);
  const backend = session.backend;
  const output = session.output;
  if (!backend || !output) {
    throw new AacWorkerError('decoder-not-ready', 'AAC decoder generation is incomplete');
  }

  const readBatch = await readAccessUnitBatch(session);
  assertCurrent(session);
  const firstAccessUnit = readBatch.accessUnits[0];
  if (!firstAccessUnit) {
    throw new AacWorkerError('empty-access-unit-batch', 'AAC reader produced an empty batch');
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
        firstAccessUnitOrdinal: firstAccessUnit.accessUnitOrdinal,
        accessUnitCount: readBatch.accessUnits.length,
        coreConfiguration: session.descriptor.coreConfiguration,
      },
      session.abortController.signal,
    );
    assertCurrent(session);

    const remainingDiscard = appendCanonicalBatch(session, canonicalBatch, readBatch.physicalEof);
    // The reader, backend, canonical PCM copy, and output append have all
    // succeeded. Only now publish the batch's absolute progress atomically.
    session.decodedInputBytes = readBatch.byteEndOffset;
    session.decodedCoreFrames = readBatch.nextCoreFrame;
    session.remainingDiscardCoreFrames = remainingDiscard;
    session.inputEnded = readBatch.physicalEof;
    postProgress(session, readBatch.physicalEof);
    return !readBatch.physicalEof;
  } finally {
    for (const accessUnit of readBatch.accessUnits) clearBytes(accessUnit.bytes);
    if (canonicalBatch) clearPlanes(canonicalBatch.planes);
    clearRawPcmBatch(rawBatch);
  }
}

function postProgress(session: DecoderSession, force = false): void {
  assertCurrent(session);
  if (
    !force &&
    session.decodedInputBytes - session.lastProgressInputBytes < PROGRESS_INTERVAL_BYTES
  ) {
    return;
  }
  session.lastProgressInputBytes = session.decodedInputBytes;
  postControl({
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    type: 'decode-progress',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    decodedInputBytes: session.decodedInputBytes,
    decodedCoreFrames: session.decodedCoreFrames,
    producedOutputFrames: session.output?.producedOutputFrames ?? 0,
  });
}

function postPcmSegment(session: DecoderSession, maxFrames: number): boolean {
  const output = session.output;
  if (!output) throw new AacWorkerError('decoder-not-ready', 'AAC PCM output is unavailable');
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
    throw new AacWorkerError('output-not-finished', 'AAC PCM output reached an incomplete EOF');
  }
  const expectedOutputFrames = expectedAacOutputFrames(session.descriptor);
  if (
    session.decodedInputBytes !== session.descriptor.audioEndByteOffset ||
    session.decodedCoreFrames !== session.descriptor.timeline.totalMediaFrames ||
    session.remainingDiscardCoreFrames !== 0 ||
    output.acceptedSourceFrames !== output.totalSourceFrames ||
    output.producedOutputFrames !== expectedOutputFrames
  ) {
    throw new AacWorkerError(
      'output-frame-mismatch',
      'AAC decoder EOF counters contradict the exact descriptor geometry',
    );
  }
  if (!sentFinalPcm) {
    const supply: PcmSupplyMessage = {
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'eof',
      generation: session.decoderGeneration,
    };
    session.pcmPort.postMessage(supply);
  }
  postControl({
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    type: 'decoder-eof',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    decodedInputBytes: session.decodedInputBytes,
    decodedCoreFrames: session.decodedCoreFrames,
    producedOutputFrames: output.producedOutputFrames,
  });
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
    if (!output) throw new AacWorkerError('decoder-not-ready', 'AAC PCM output is unavailable');
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
      throw new AacWorkerError('pcm-output-stalled', 'AAC PCM output made no bounded progress');
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
      new AacWorkerError('invalid-pcm-demand', 'AAC PCM demand failed strict validation'),
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

function createSession(command: Readonly<AacDecoderOpenCommand>): DecoderSession {
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
  const session: DecoderSession = {
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    backendId: command.backendId,
    descriptor: command.descriptor,
    sourceClient,
    source,
    pcmPort: command.pcmPort,
    abortController,
    pcmListener: (event) => receivePcmDemand(session, event.data),
    pcmMessageErrorListener: () =>
      failSession(
        session,
        new AacWorkerError('pcm-message-deserialization', 'AAC PCM demand could not deserialize'),
      ),
    backend: null,
    decodeReader: null,
    output: null,
    decodedInputBytes: command.descriptor.startPlan.scanAnchorByteOffset,
    decodedCoreFrames:
      command.descriptor.startPlan.decodeStartAccessUnitOrdinal *
      AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
    remainingDiscardCoreFrames: command.descriptor.startPlan.discardCoreFrames,
    lastProgressInputBytes: command.descriptor.startPlan.scanAnchorByteOffset,
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

function clearCapabilityInputFrame(value: unknown): void {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'frame');
    if (
      descriptor &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.value instanceof Uint8Array
    ) {
      clearBytes(descriptor.value);
    }
  } catch {
    // The strict parser has already retained its independent bounded copy.
  }
}

function capabilityErrorCode(error: unknown): AacCapabilityProbeErrorCode {
  if (error instanceof AacWebCodecsUnavailableError) return 'unavailable';
  if (error instanceof AacWebCodecsIntegrityError) return 'integrity';
  return 'internal';
}

function safeCapabilityErrorCode(error: unknown): AacCapabilityProbeErrorCode {
  try {
    return capabilityErrorCode(error);
  } catch {
    return 'internal';
  }
}

function safeCapabilityErrorMessage(error: unknown): string {
  try {
    return boundedText(
      errorMessage(error),
      AAC_CAPABILITY_PROBE_MAX_ERROR_MESSAGE_LENGTH,
      'AAC WebCodecs capability probe failed',
    );
  } catch {
    return 'AAC WebCodecs capability probe failed';
  }
}

async function handleCapabilityProbe(command: Readonly<AacCapabilityProbeCommand>): Promise<void> {
  try {
    await probeAacWebCodecsAdtsFrame(command.frame, new AbortController().signal);
    postCapability({
      protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
      type: 'probe-ready',
      probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
    });
  } catch (error) {
    postCapability({
      protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
      type: 'probe-error',
      probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
      code: safeCapabilityErrorCode(error),
      message: safeCapabilityErrorMessage(error),
    });
  } finally {
    clearBytes(command.frame);
  }
}

function failWorkerProtocol(value: unknown): never | void {
  closeTransferredPorts(value);
  const session = activeSession;
  if (session) {
    failSession(
      session,
      new AacWorkerError('invalid-command', 'AAC worker command failed strict validation'),
    );
    return;
  }
  realmOpened = true;
  throw new AacWorkerError('invalid-command', 'AAC worker command failed strict validation');
}

function handleCommand(value: unknown): void {
  const capabilityCommand = parseAacCapabilityProbeCommand(value);
  if (capabilityCommand) {
    clearCapabilityInputFrame(value);
    if (realmOpened || activeSession) {
      clearBytes(capabilityCommand.frame);
      failWorkerProtocol(value);
      return;
    }
    realmOpened = true;
    void handleCapabilityProbe(capabilityCommand);
    return;
  }

  const command = parseAacDecoderCommand(value);
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
    command.type === 'stop-decoder' &&
    completedGeneration?.sourceLifetimeGeneration === command.sourceLifetimeGeneration &&
    completedGeneration.decoderGeneration === command.decoderGeneration
  ) {
    postControl({
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
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
      new AacWorkerError('message-deserialization', 'AAC worker command could not deserialize'),
    );
    return;
  }
  realmOpened = true;
  throw new AacWorkerError('message-deserialization', 'AAC worker command could not deserialize');
});

export {};
