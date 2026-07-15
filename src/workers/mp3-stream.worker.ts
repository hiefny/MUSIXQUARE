/// <reference lib="webworker" />

import {
  MP3_DECODER_MAX_ERROR_CODE_LENGTH,
  MP3_DECODER_MAX_ERROR_MESSAGE_LENGTH,
  MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS,
  MP3_DECODER_PROTOCOL_VERSION,
  parseMp3DecoderCommand,
  type Mp3DecoderDescriptor,
  type Mp3DecoderEvent,
  type Mp3DecoderOpenCommand,
} from '../player/mp3/decoder-protocol.js';
import { resolveMp3DecoderPrelude } from '../player/mp3/decoder-helpers.js';
import {
  MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES,
  MpegLayer3IncrementalFrameReader,
  type MpegLayer3IncrementalFrame,
} from '../player/mp3/incremental-frame-reader.js';
import { Mpg123FrameDecoder } from '../player/mp3/mpg123-frame-decoder.js';
import type { MpegLayer3SeekIndexPoint } from '../player/mp3/seek-index.js';
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
import { BoundedPcmOutput, ensureBoundedPcmOutputRuntimeReady } from './bounded-pcm-output.js';
import {
  RetryingPortEncodedSource,
  RetryingPortEncodedSourceError,
} from './retrying-port-encoded-source.js';

const scope = self as DedicatedWorkerGlobalScope;

const PROGRESS_INTERVAL_BYTES = 1024 * 1024;

class Mp3WorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'Mp3WorkerError';
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
    super('MP3 decoder session was cancelled');
    this.name = 'SessionCancelledError';
  }
}

interface DecoderSession {
  readonly sourceLifetimeGeneration: number;
  readonly decoderGeneration: number;
  readonly descriptor: Readonly<Mp3DecoderDescriptor>;
  readonly sourceClient: EncodedSourcePortClient;
  readonly source: RetryingPortEncodedSource;
  readonly pcmPort: MessagePort;
  readonly abortController: AbortController;
  readonly pcmListener: (event: MessageEvent<unknown>) => void;
  readonly pcmMessageErrorListener: () => void;
  decoder: Mpg123FrameDecoder | null;
  decodeReader: MpegLayer3IncrementalFrameReader | null;
  output: BoundedPcmOutput | null;
  decodedInputBytes: number;
  decodedRawSamples: number;
  lastProgressInputBytes: number;
  lastIndexedFrameOrdinal: number;
  progressiveIndexEvents: number;
  requestChain: Promise<void>;
  demandPending: boolean;
  inputEnded: boolean;
  ready: boolean;
  stopped: boolean;
  terminal: boolean;
  released: boolean;
  releasePromise: Promise<void> | null;
  activeOperations: number;
  readonly operationDrainResolvers: Set<() => void>;
  readonly cleanupFaults: unknown[];
  readonly retryState: () => Readonly<{
    retryWaitSequence: number;
    activeRetryWaits: number;
  }>;
}

interface CompletedGeneration {
  readonly sourceLifetimeGeneration: number;
  readonly decoderGeneration: number;
  readonly cleanup: Promise<void>;
  acknowledgementsPosted: boolean;
  readonly retryState: () => Readonly<{
    retryWaitSequence: number;
    activeRetryWaits: number;
  }>;
}

let activeSession: DecoderSession | null = null;
let completedGeneration: CompletedGeneration | null = null;
let realmOpened = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: string, maximumLength: number, fallback: string): string {
  const normalized = value.length > 0 ? value : fallback;
  return normalized.length <= maximumLength ? normalized : normalized.slice(0, maximumLength);
}

function errorCode(error: unknown): string {
  if (error instanceof Mp3WorkerError) return error.code;
  if (error instanceof RetryingPortEncodedSourceError) return error.code;
  if (error instanceof EncodedSourcePortError) return `source-${error.code}`;
  return 'decode-failed';
}

function postControl(message: Mp3DecoderEvent): void {
  scope.postMessage(message);
}

function assertCurrent(session: DecoderSession): void {
  if (activeSession !== session || session.stopped || session.terminal) {
    throw new SessionCancelledError();
  }
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // The peer may already have closed or disentangled its endpoint.
  }
}

function attemptTerminalCleanup(faults: unknown[], cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    faults.push(error);
  }
}

function finishSessionOperation(session: DecoderSession): void {
  session.activeOperations -= 1;
  if (session.activeOperations !== 0) return;
  const resolvers = [...session.operationDrainResolvers];
  session.operationDrainResolvers.clear();
  for (const resolve of resolvers) resolve();
}

function trackSessionOperation<T>(session: DecoderSession, operation: Promise<T>): Promise<T> {
  session.activeOperations += 1;
  return operation.then(
    (value) => {
      finishSessionOperation(session);
      return value;
    },
    (error: unknown) => {
      finishSessionOperation(session);
      throw error;
    },
  );
}

function whenSessionOperationsDrained(session: DecoderSession): Promise<void> {
  if (session.activeOperations === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    session.operationDrainResolvers.add(resolve);
  });
}

function releaseSession(session: DecoderSession): Promise<void> {
  if (session.releasePromise) return session.releasePromise;
  let resolveRelease!: () => void;
  let rejectRelease!: (reason: unknown) => void;
  const releasePromise = new Promise<void>((resolve, reject) => {
    resolveRelease = resolve;
    rejectRelease = reject;
  });
  // Publish the stable terminal owner before any abort, port, output, or
  // source cleanup hook can synchronously reenter this worker.
  session.releasePromise = releasePromise;
  session.released = true;
  const cleanupFaults = session.cleanupFaults;
  if (!session.abortController.signal.aborted) {
    session.abortController.abort(new DOMException('MP3 decoder stopped', 'AbortError'));
  }
  attemptTerminalCleanup(cleanupFaults, () =>
    session.pcmPort.removeEventListener('message', session.pcmListener),
  );
  attemptTerminalCleanup(cleanupFaults, () =>
    session.pcmPort.removeEventListener('messageerror', session.pcmMessageErrorListener),
  );
  attemptTerminalCleanup(cleanupFaults, () => {
    session.pcmPort.onmessage = null;
  });
  attemptTerminalCleanup(cleanupFaults, () => session.pcmPort.close());
  attemptTerminalCleanup(cleanupFaults, () => session.output?.close());
  session.output = null;
  session.decodeReader = null;
  session.decoder = null;
  const cleanup = Promise.allSettled([
    Promise.resolve().then(() => session.source.close()),
    session.source.whenRetryWaitsDrained(),
    whenSessionOperationsDrained(session),
  ]).then((results) => {
    if (session.source.activeRetryWaitCount !== 0) {
      throw new Mp3WorkerError(
        'retry-wait-leak',
        'MP3 worker retired with an active encoded-source retry wait',
      );
    }
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const cause = cleanupFaults[0] ?? rejected?.reason;
    if (cause !== undefined) {
      throw new Mp3WorkerError(
        'cleanup-unconfirmed',
        'MP3 worker terminal cleanup could not be confirmed',
        cause,
      );
    }
  });
  void cleanup.then(resolveRelease, rejectRelease);
  return releasePromise;
}

function detachSession(session: DecoderSession): void {
  if (activeSession === session) activeSession = null;
}

function completeSession(session: DecoderSession): CompletedGeneration {
  const completed: CompletedGeneration = {
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    cleanup: releaseSession(session),
    acknowledgementsPosted: false,
    retryState: () => session.retryState(),
  };
  // Natural EOF/error keeps this generation until the owner's explicit stop.
  // Observe a cleanup rejection now without converting the stable barrier.
  void completed.cleanup.catch(() => undefined);
  completedGeneration = completed;
  return completed;
}

async function acknowledgeRetirement(completed: CompletedGeneration): Promise<void> {
  if (completed.acknowledgementsPosted) return;
  completed.acknowledgementsPosted = true;
  try {
    await completed.cleanup;
    postControl({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: completed.sourceLifetimeGeneration,
      decoderGeneration: completed.decoderGeneration,
    });
    postControl({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'worker-retired',
      sourceLifetimeGeneration: completed.sourceLifetimeGeneration,
      decoderGeneration: completed.decoderGeneration,
      ...completed.retryState(),
    });
    if (completedGeneration === completed) completedGeneration = null;
  } catch {
    // The adapter's bounded ACK deadline records this realm as unconfirmed.
  }
}

function stopSession(session: DecoderSession): void {
  if (session.terminal) return;
  session.stopped = true;
  session.terminal = true;
  try {
    postControl({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-stopped',
      sourceLifetimeGeneration: session.sourceLifetimeGeneration,
      decoderGeneration: session.decoderGeneration,
    });
  } finally {
    detachSession(session);
    const completed = completeSession(session);
    completedGeneration = null;
    void acknowledgeRetirement(completed);
  }
}

function failSession(session: DecoderSession, error: unknown): void {
  if (session.terminal || error instanceof SessionCancelledError) return;
  if (error instanceof DOMException && error.name === 'AbortError' && session.stopped) return;

  session.stopped = true;
  session.terminal = true;
  try {
    const code = boundedText(errorCode(error), MP3_DECODER_MAX_ERROR_CODE_LENGTH, 'decode-failed');
    const message = boundedText(
      errorMessage(error),
      MP3_DECODER_MAX_ERROR_MESSAGE_LENGTH,
      'MP3 decoder failed',
    );
    try {
      const supply: PcmSupplyMessage = {
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'source-error',
        generation: session.decoderGeneration,
        code,
      };
      session.pcmPort.postMessage(supply);
    } catch {
      // The control-channel event remains authoritative if PCM delivery failed.
    }
    try {
      postControl({
        protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
        type: 'decoder-error',
        sourceLifetimeGeneration: session.sourceLifetimeGeneration,
        decoderGeneration: session.decoderGeneration,
        code,
        message,
      });
    } catch (controlFailure) {
      // A failed terminal notification makes physical retirement
      // unconfirmable, but it must never prevent owned resource cleanup.
      session.cleanupFaults.push(controlFailure);
    }
  } catch (terminalFailure) {
    session.cleanupFaults.push(terminalFailure);
  } finally {
    detachSession(session);
    completeSession(session);
  }
}

function pointForFrame(frame: MpegLayer3IncrementalFrame): MpegLayer3SeekIndexPoint {
  return Object.freeze({
    rawSample: frame.descriptor.rawSample,
    byteOffset: frame.descriptor.byteOffset,
    frameOrdinal: frame.descriptor.frameOrdinal,
    mainDataCapacityBytes: frame.descriptor.header.mainDataCapacityBytes,
    mainDataBeginBytes: frame.descriptor.mainDataBeginBytes,
  });
}

function progressiveIndexStride(descriptor: Readonly<Mp3DecoderDescriptor>): number {
  return Math.max(
    1,
    Math.ceil(descriptor.audioFrameCount / MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS),
  );
}

function maybePostIndexPoint(session: DecoderSession, point: MpegLayer3SeekIndexPoint): void {
  if (
    point.frameOrdinal <= session.lastIndexedFrameOrdinal ||
    session.progressiveIndexEvents >= MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS ||
    point.frameOrdinal % progressiveIndexStride(session.descriptor) !== 0
  ) {
    return;
  }
  assertCurrent(session);
  postControl({
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'frame-index-point',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    ...point,
  });
  session.lastIndexedFrameOrdinal = point.frameOrdinal;
  session.progressiveIndexEvents += 1;
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
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'decode-progress',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    decodedInputBytes: session.decodedInputBytes,
    decodedRawSamples: session.decodedRawSamples,
    producedOutputFrames: session.output?.producedOutputFrames ?? 0,
  });
}

function createFrameReader(
  session: DecoderSession,
  start: { readonly byteOffset: number; readonly frameOrdinal: number },
): MpegLayer3IncrementalFrameReader {
  const descriptor = session.descriptor;
  return new MpegLayer3IncrementalFrameReader({
    source: session.source,
    firstAudioFrameOffset: descriptor.firstAudioFrameOffset,
    audioEndByteOffset: descriptor.audioEndByteOffset,
    audioFrameCount: descriptor.audioFrameCount,
    version: descriptor.version,
    sampleRateHz: descriptor.sourceSampleRate,
    channels: descriptor.channels,
    samplesPerFrame: descriptor.samplesPerFrame,
    start,
    pageBytes: Math.min(
      MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES,
      ENCODED_SOURCE_PORT_MAX_READ_BYTES,
    ),
  });
}

async function scanPrelude(
  session: DecoderSession,
): Promise<ReturnType<typeof resolveMp3DecoderPrelude>> {
  const plan = session.descriptor.startPlan;
  const reader = createFrameReader(session, {
    byteOffset: plan.scanAnchorByteOffset,
    frameOrdinal: plan.scanAnchorFrameOrdinal,
  });
  const points: MpegLayer3SeekIndexPoint[] = [];
  const maximumPoints = plan.historyFrameLimit + 1;

  while (true) {
    assertCurrent(session);
    const frame = await trackSessionOperation(
      session,
      reader.readNext(session.abortController.signal),
    );
    assertCurrent(session);
    if (!frame || frame.descriptor.frameOrdinal > plan.audioFrameOrdinal) {
      throw new Mp3WorkerError(
        'seek-target-missing',
        'MP3 prelude scan ended before its exact target frame',
      );
    }
    const point = pointForFrame(frame);
    maybePostIndexPoint(session, point);
    points.push(point);
    if (points.length > maximumPoints) points.shift();
    if (point.frameOrdinal === plan.audioFrameOrdinal) break;
  }

  try {
    return resolveMp3DecoderPrelude({
      descriptor: session.descriptor,
      points: Object.freeze(points.slice()),
    });
  } catch (error) {
    throw new Mp3WorkerError(
      'invalid-seek-prelude',
      `MP3 reservoir prelude could not be resolved: ${errorMessage(error)}`,
      error,
    );
  }
}

async function initializeSession(session: DecoderSession): Promise<void> {
  try {
    const prelude = await scanPrelude(session);
    assertCurrent(session);

    session.decodeReader = createFrameReader(session, {
      byteOffset: prelude.decodeStart.byteOffset,
      frameOrdinal: prelude.decodeStart.frameOrdinal,
    });
    session.decodedInputBytes = prelude.decodeStart.byteOffset;
    session.decodedRawSamples = prelude.decodeStart.rawSample;
    session.lastProgressInputBytes = prelude.decodeStart.byteOffset;

    const decoder = new Mpg123FrameDecoder({
      encodedChannels: session.descriptor.channels,
      sampleRateHz: session.descriptor.sourceSampleRate,
      samplesPerFrame: session.descriptor.samplesPerFrame,
    });
    session.decoder = decoder;
    const runtimePromises: Promise<unknown>[] = [decoder.ready];
    if (session.descriptor.sourceSampleRate !== session.descriptor.outputSampleRate) {
      runtimePromises.push(ensureBoundedPcmOutputRuntimeReady());
    }
    await trackSessionOperation(session, Promise.all(runtimePromises));
    assertCurrent(session);

    session.output = new BoundedPcmOutput({
      sourceSampleRateHz: session.descriptor.sourceSampleRate,
      outputSampleRateHz: session.descriptor.outputSampleRate,
      channelCount: session.descriptor.channels,
      totalSourceFrames:
        session.descriptor.timeline.totalMediaFrames - session.descriptor.startPlan.mediaFrame,
      maxAppendFrames: session.descriptor.samplesPerFrame,
    });
    session.ready = true;
    session.pcmPort.addEventListener('message', session.pcmListener);
    session.pcmPort.addEventListener('messageerror', session.pcmMessageErrorListener);
    session.pcmPort.start();
    postControl({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-ready',
      sourceLifetimeGeneration: session.sourceLifetimeGeneration,
      decoderGeneration: session.decoderGeneration,
      descriptor: session.descriptor,
    });
  } catch (error) {
    failSession(session, error);
  }
}

function appendClippedFrame(
  session: DecoderSession,
  frame: MpegLayer3IncrementalFrame,
  decodedChannels: readonly Float32Array[],
): void {
  const output = session.output;
  if (!output) throw new Mp3WorkerError('decoder-not-ready', 'MP3 PCM output is not ready');
  const frameStart = frame.descriptor.rawSample;
  const frameEnd = frameStart + session.descriptor.samplesPerFrame;
  const keepStart = Math.max(frameStart, session.descriptor.startPlan.rawSample);
  const keepEnd = Math.min(frameEnd, session.descriptor.timeline.rawEofSampleExclusive);
  if (keepEnd <= keepStart) return;

  const startOffset = keepStart - frameStart;
  const frames = keepEnd - keepStart;
  const clipped = decodedChannels.map((channel) =>
    channel.subarray(startOffset, startOffset + frames),
  );
  output.append(clipped, frames);
}

async function decodeNextFrame(session: DecoderSession): Promise<boolean> {
  assertCurrent(session);
  const reader = session.decodeReader;
  const decoder = session.decoder;
  const output = session.output;
  if (!reader || !decoder || !output) {
    throw new Mp3WorkerError('decoder-not-ready', 'MP3 decoder generation is incomplete');
  }

  const frame = await trackSessionOperation(
    session,
    reader.readNext(session.abortController.signal),
  );
  assertCurrent(session);
  if (!frame) {
    throw new Mp3WorkerError('unexpected-input-eof', 'MP3 input ended before the gapless EOF');
  }
  const decoded = decoder.decodeVerifiedAudioFrame(frame.bytes);
  assertCurrent(session);
  maybePostIndexPoint(session, pointForFrame(frame));
  appendClippedFrame(session, frame, decoded.channelData);
  session.decodedInputBytes = frame.descriptor.byteEndOffset;
  session.decodedRawSamples = frame.descriptor.rawSample + decoded.samplesDecoded;

  const reachedPhysicalEof =
    frame.descriptor.frameOrdinal + 1 === session.descriptor.audioFrameCount;
  if (reachedPhysicalEof) {
    if (
      frame.descriptor.byteEndOffset !== session.descriptor.audioEndByteOffset ||
      session.decodedRawSamples !== session.descriptor.timeline.totalRawSamples
    ) {
      throw new Mp3WorkerError(
        'physical-eof-mismatch',
        'MP3 final frame does not reach its exact byte and raw-sample boundaries',
      );
    }
    if (output.acceptedSourceFrames !== output.totalSourceFrames) {
      throw new Mp3WorkerError(
        'source-frame-mismatch',
        `MP3 decoder accepted ${output.acceptedSourceFrames} media frames; expected ${output.totalSourceFrames}`,
      );
    }
    output.endInput();
    session.inputEnded = true;
  }
  postProgress(session, reachedPhysicalEof);
  return !reachedPhysicalEof;
}

function postPcmSegment(session: DecoderSession, maxFrames: number): boolean {
  const output = session.output;
  if (!output) throw new Mp3WorkerError('decoder-not-ready', 'MP3 PCM output is not ready');
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
    throw new Mp3WorkerError('output-not-finished', 'MP3 PCM output reached an incomplete EOF');
  }
  if (output.producedOutputFrames !== output.expectedOutputFrames) {
    throw new Mp3WorkerError(
      'output-frame-mismatch',
      `MP3 output produced ${output.producedOutputFrames} frames; expected ${output.expectedOutputFrames}`,
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
  postProgress(session, true);
  postControl({
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'decoder-eof',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    decodedInputBytes: session.decodedInputBytes,
    decodedRawSamples: session.decodedRawSamples,
    producedOutputFrames: output.producedOutputFrames,
  });
  session.stopped = true;
  session.terminal = true;
  detachSession(session);
  completeSession(session);
}

async function satisfyDemand(session: DecoderSession, maxFrames: number): Promise<void> {
  assertCurrent(session);
  while (true) {
    if (postPcmSegment(session, maxFrames)) return;
    assertCurrent(session);
    const output = session.output;
    if (!output) throw new Mp3WorkerError('decoder-not-ready', 'MP3 PCM output is not ready');
    if (output.finished) {
      finishSession(session, false);
      return;
    }
    if (
      !output.needsInput &&
      output.acceptedSourceFrames === output.totalSourceFrames &&
      !session.inputEnded
    ) {
      await decodeNextFrame(session);
      continue;
    }
    if (!output.needsInput) {
      throw new Mp3WorkerError('pcm-output-stalled', 'MP3 PCM output made no bounded progress');
    }
    await decodeNextFrame(session);
  }
}

function receivePcmDemand(session: DecoderSession, value: unknown): void {
  if (!session.ready || session.terminal) return;
  const demand = parsePcmDemandMessage(value);
  if (!demand || demand.generation !== session.decoderGeneration || session.demandPending) {
    failSession(
      session,
      new Mp3WorkerError('invalid-pcm-demand', 'MP3 PCM demand failed strict validation'),
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

function createSession(command: Readonly<Mp3DecoderOpenCommand>): DecoderSession {
  const sourceClient = new EncodedSourcePortClient({
    port: command.sourcePort,
    generation: command.sourceLifetimeGeneration,
    size: command.descriptor.sourceSize,
    maxPendingReads: 1,
  });
  let retryWaitSequence = 0;
  const source = new RetryingPortEncodedSource({
    size: command.descriptor.sourceSize,
    identity: command.descriptor.sourceIdentity,
    client: sourceClient,
    onRetryWaitDelta: (delta, activeRetryWaits) => {
      retryWaitSequence += 1;
      postControl({
        protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
        type: 'retry-wait-delta',
        sourceLifetimeGeneration: command.sourceLifetimeGeneration,
        decoderGeneration: command.decoderGeneration,
        delta,
        retryWaitSequence,
        activeRetryWaits,
      });
    },
  });
  const abortController = new AbortController();
  const session: DecoderSession = {
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
    sourceClient,
    source,
    pcmPort: command.pcmPort,
    abortController,
    pcmListener: (event) => receivePcmDemand(session, event.data),
    pcmMessageErrorListener: () =>
      failSession(
        session,
        new Mp3WorkerError('pcm-message-deserialization', 'MP3 PCM demand could not deserialize'),
      ),
    decoder: null,
    decodeReader: null,
    output: null,
    decodedInputBytes: command.descriptor.startPlan.scanAnchorByteOffset,
    decodedRawSamples:
      command.descriptor.startPlan.scanAnchorFrameOrdinal * command.descriptor.samplesPerFrame,
    lastProgressInputBytes: command.descriptor.startPlan.scanAnchorByteOffset,
    lastIndexedFrameOrdinal: -1,
    progressiveIndexEvents: 0,
    requestChain: Promise.resolve(),
    demandPending: false,
    inputEnded: false,
    ready: false,
    stopped: false,
    terminal: false,
    released: false,
    releasePromise: null,
    activeOperations: 0,
    operationDrainResolvers: new Set(),
    cleanupFaults: [],
    retryState: () => ({
      retryWaitSequence,
      activeRetryWaits: source.activeRetryWaitCount,
    }),
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
      new Mp3WorkerError('invalid-command', 'MP3 worker command failed strict validation'),
    );
    return;
  }
  realmOpened = true;
  throw new Mp3WorkerError('invalid-command', 'MP3 worker command failed strict validation');
}

function handleCommand(value: unknown): void {
  const command = parseMp3DecoderCommand(value);
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
    const completed = completedGeneration;
    completedGeneration = null;
    postControl({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-stopped',
      sourceLifetimeGeneration: command.sourceLifetimeGeneration,
      decoderGeneration: command.decoderGeneration,
    });
    void acknowledgeRetirement(completed);
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
      new Mp3WorkerError('message-deserialization', 'MP3 worker command could not deserialize'),
    );
    return;
  }
  realmOpened = true;
  throw new Mp3WorkerError('message-deserialization', 'MP3 worker command could not deserialize');
});

export {};
