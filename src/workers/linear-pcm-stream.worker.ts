/// <reference lib="webworker" />

import { ChunkedResampler, initWithBase64 } from 'lanczos-resampler/loader.js';
import {
  expectedLanczosOutputFrames,
  minimumLanczosInputFrames,
  planBoundedLanczosChunk,
  planShortLanczosInput,
} from '../player/streaming/resampler-plan.js';
import {
  decodeInterleavedLinearPcm,
  expectedLinearPcmOutputFrames,
  planLinearPcmInputRead,
  validateLinearPcmDecoderDescriptor,
} from '../player/linear-pcm/decoder-helpers.js';
import {
  LINEAR_PCM_DECODER_DESCRIPTOR_KEYS,
  LINEAR_PCM_DECODER_PROTOCOL_VERSION,
  isLinearPcmDecoderGeneration,
  isLinearPcmSourceLifetimeGeneration,
  isLinearPcmSourceSize,
  type LinearPcmDecoderCommand,
  type LinearPcmDecoderDescriptor,
  type LinearPcmDecoderEvent,
  type LinearPcmDecoderInitMessage,
  type LinearPcmSourceCloseMessage,
  type LinearPcmSourceOpenMessage,
} from '../player/linear-pcm/decoder-protocol.js';
import { LinearPcmDecodeError } from '../player/linear-pcm/sample-format.js';
import { LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES } from '../player/linear-pcm/stream-protocol.js';
import { isEncodedAudioSourceIdentity } from '../player/sources/encoded-audio-source.js';
import {
  PCM_STREAM_MAX_MESSAGE_FRAMES,
  PCM_STREAM_PROTOCOL_VERSION,
  type PcmSupplyMessage,
} from '../player/streaming/pcm-stream-protocol.js';
import {
  EncodedSourcePortClient,
  EncodedSourcePortError,
} from '../player/sources/encoded-source-port.js';

const scope = self as DedicatedWorkerGlobalScope;

const PROGRESS_INTERVAL_BYTES = 1024 * 1024;
// lanczos-resampler@0.4.1 may touch a small phase tail beyond its nominal
// maxNumOutputFrames allocation at extreme ratios. These frames stay private.
const RESAMPLER_SCRATCH_GUARD_FRAMES = 64;

class LinearPcmWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LinearPcmWorkerError';
  }
}

class SessionCancelledError extends Error {
  constructor() {
    super('Linear PCM decoder session was cancelled');
    this.name = 'SessionCancelledError';
  }
}

interface SourceLifetime {
  readonly generation: number;
  readonly size: number;
  readonly identity: string;
  readonly client: EncodedSourcePortClient;
  decoderStarted: boolean;
  closed: boolean;
}

interface SourcePcmCarry {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
}

interface PcmSegment {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
  offset: number;
}

interface DecoderSession {
  readonly sourceLifetimeGeneration: number;
  readonly decoderGeneration: number;
  readonly descriptor: LinearPcmDecoderDescriptor;
  readonly source: SourceLifetime;
  readonly port: MessagePort;
  readonly portListener: (event: MessageEvent<unknown>) => void;
  readonly abortController: AbortController;
  readonly expectedFrames: number;
  resamplers: ChunkedResampler[];
  sourceCarry: SourcePcmCarry | null;
  outputSegment: PcmSegment | null;
  nextSourceFrame: number;
  decodedInputBytes: number;
  decodedSourceFrames: number;
  resamplerConsumedSourceFrames: number;
  producedOutputFrames: number;
  lastProgressBytes: number;
  inputEof: boolean;
  requestChain: Promise<void>;
  demandPending: boolean;
  stopped: boolean;
  terminal: boolean;
  released: boolean;
}

let activeSession: DecoderSession | null = null;
let activeSource: SourceLifetime | null = null;
let latestDecoderGeneration = 0;
let lanczosReadyPromise: Promise<void> | null = null;

function ensureLanczosReady(): Promise<void> {
  if (!lanczosReadyPromise) {
    lanczosReadyPromise = initWithBase64().catch((error: unknown) => {
      lanczosReadyPromise = null;
      throw error;
    });
  }
  return lanczosReadyPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof LinearPcmWorkerError) return error.code;
  if (error instanceof LinearPcmDecodeError) return `invalid-linear-pcm-${error.code}`;
  if (error instanceof EncodedSourcePortError) return `source-${error.code}`;
  return 'decode-failed';
}

function postControl(message: LinearPcmDecoderEvent): void {
  scope.postMessage(message);
}

function assertCurrent(session: DecoderSession): void {
  if (activeSession !== session || session.stopped || session.terminal) {
    throw new SessionCancelledError();
  }
}

function postProgress(session: DecoderSession, force = false): void {
  assertCurrent(session);
  if (!force && session.decodedInputBytes - session.lastProgressBytes < PROGRESS_INTERVAL_BYTES) {
    return;
  }
  session.lastProgressBytes = session.decodedInputBytes;
  postControl({
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'decode-progress',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    decodedInputBytes: session.decodedInputBytes,
    decodedSourceFrames: session.decodedSourceFrames,
    producedOutputFrames: session.producedOutputFrames,
  });
}

function releaseSessionResources(session: DecoderSession): void {
  if (session.released) return;
  session.released = true;
  session.abortController.abort(new DOMException('Linear PCM decoder stopped', 'AbortError'));
  session.port.removeEventListener('message', session.portListener);
  session.port.onmessage = null;
  try {
    session.port.close();
  } catch {
    // Closing an already-disentangled MessagePort is harmless.
  }
  for (const resampler of session.resamplers) {
    try {
      resampler.free();
    } catch {
      // A fatal WASM path may already have consumed an allocation.
    }
  }
  session.resamplers = [];
  session.sourceCarry = null;
  session.outputSegment = null;
}

function detachActiveSession(session: DecoderSession): void {
  if (activeSession === session) activeSession = null;
}

function releaseAfterPendingDemand(session: DecoderSession): void {
  const pending = session.requestChain;
  void pending.catch(() => undefined).finally(() => releaseSessionResources(session));
}

function stopSession(session: DecoderSession): void {
  if (session.terminal) return;
  session.stopped = true;
  session.terminal = true;
  session.abortController.abort(new DOMException('Linear PCM decoder stopped', 'AbortError'));
  session.port.removeEventListener('message', session.portListener);
  try {
    session.port.close();
  } catch {
    // The owner may have already closed its half of the channel.
  }
  detachActiveSession(session);
  postControl({
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'decoder-stopped',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
  });
  releaseAfterPendingDemand(session);
}

function failSession(session: DecoderSession, error: unknown): void {
  if (session.terminal || error instanceof SessionCancelledError) return;
  if (error instanceof DOMException && error.name === 'AbortError' && session.stopped) return;
  session.stopped = true;
  session.terminal = true;
  const code = errorCode(error);
  try {
    const supply: PcmSupplyMessage = {
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'source-error',
      generation: session.decoderGeneration,
      code,
    };
    session.port.postMessage(supply);
  } catch {
    // The control-channel error remains authoritative if the PCM port is gone.
  }
  postControl({
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'decoder-error',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    code,
    message: errorMessage(error),
  });
  session.abortController.abort(error);
  session.port.removeEventListener('message', session.portListener);
  try {
    session.port.close();
  } catch {
    // The PCM peer may already have closed after receiving source-error.
  }
  detachActiveSession(session);
  releaseAfterPendingDemand(session);
}

function finishSession(session: DecoderSession, sentFinalPcm: boolean): void {
  assertCurrent(session);
  if (
    session.decodedSourceFrames !==
    session.descriptor.totalSourceFrames - session.descriptor.targetSourceFrame
  ) {
    throw new LinearPcmWorkerError(
      'source-frame-mismatch',
      `Linear PCM input decoded ${session.decodedSourceFrames} frames; expected ${session.descriptor.totalSourceFrames - session.descriptor.targetSourceFrame}`,
    );
  }
  if (session.producedOutputFrames !== session.expectedFrames) {
    throw new LinearPcmWorkerError(
      'output-frame-mismatch',
      `Linear PCM output produced ${session.producedOutputFrames} frames; expected ${session.expectedFrames}`,
    );
  }
  if (!sentFinalPcm) {
    const supply: PcmSupplyMessage = {
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'eof',
      generation: session.decoderGeneration,
    };
    session.port.postMessage(supply);
  }
  postProgress(session, true);
  postControl({
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'decoder-eof',
    sourceLifetimeGeneration: session.sourceLifetimeGeneration,
    decoderGeneration: session.decoderGeneration,
    decodedInputBytes: session.decodedInputBytes,
    decodedSourceFrames: session.decodedSourceFrames,
    producedOutputFrames: session.producedOutputFrames,
  });
  session.stopped = true;
  session.terminal = true;
  detachActiveSession(session);
  releaseSessionResources(session);
}

function descriptorMinimumResamplerInput(session: DecoderSession): number {
  if (session.descriptor.sourceSampleRate === session.descriptor.outputSampleRate) return 1;
  return minimumLanczosInputFrames({
    inputSampleRate: session.descriptor.sourceSampleRate,
    outputSampleRate: session.descriptor.outputSampleRate,
  });
}

function appendSourceCarry(
  session: DecoderSession,
  channels: readonly Float32Array[],
  frames: number,
): void {
  if (frames <= 0) return;
  const carry = session.sourceCarry;
  if (!carry) {
    session.sourceCarry = { channels, frames };
    return;
  }
  const maximumCarryFrames = descriptorMinimumResamplerInput(session) - 1;
  if (carry.frames > maximumCarryFrames) {
    throw new LinearPcmWorkerError(
      'pcm-carry-overrun',
      'Linear PCM carry was not drained before read',
    );
  }
  const combinedFrames = carry.frames + frames;
  if (combinedFrames > LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES + maximumCarryFrames) {
    throw new LinearPcmWorkerError('pcm-carry-overrun', 'Linear PCM carry exceeds its fixed bound');
  }
  const combined = carry.channels.map((previous, channel) => {
    const next = channels[channel];
    if (!next) {
      throw new LinearPcmWorkerError('invalid-pcm', 'Decoded linear PCM channel is missing');
    }
    const output = new Float32Array(combinedFrames);
    output.set(previous, 0);
    output.set(next, carry.frames);
    return output;
  });
  session.sourceCarry = { channels: combined, frames: combinedFrames };
}

function consumeSourceCarry(session: DecoderSession, frames: number): readonly Float32Array[] {
  const carry = session.sourceCarry;
  if (!carry || frames <= 0 || frames > carry.frames) {
    throw new LinearPcmWorkerError('invalid-pcm-carry', 'Linear PCM carry consumption is invalid');
  }
  const consumed = carry.channels.map((channel) => channel.subarray(0, frames));
  if (frames === carry.frames) session.sourceCarry = null;
  else {
    session.sourceCarry = {
      channels: carry.channels.map((channel) => channel.subarray(frames)),
      frames: carry.frames - frames,
    };
  }
  return consumed;
}

async function decodeNextChunk(session: DecoderSession): Promise<boolean> {
  assertCurrent(session);
  const plan = planLinearPcmInputRead(session.descriptor, session.nextSourceFrame);
  if (!plan) {
    session.inputEof = true;
    postProgress(session, true);
    return false;
  }
  const bytes = await session.source.client.readAt(
    plan.byteOffset,
    plan.bytes,
    session.abortController.signal,
  );
  assertCurrent(session);
  if (bytes.byteLength !== plan.bytes) {
    throw new LinearPcmWorkerError(
      'source-integrity',
      'Encoded source returned a short linear PCM read',
    );
  }
  const decoded = decodeInterleavedLinearPcm(bytes, session.descriptor);
  if (decoded.frames !== plan.frames || decoded.channels.length !== session.descriptor.channels) {
    throw new LinearPcmWorkerError('invalid-pcm', 'Linear PCM read decoded to an unexpected shape');
  }
  appendSourceCarry(session, decoded.channels, decoded.frames);
  session.nextSourceFrame += decoded.frames;
  session.decodedInputBytes += bytes.byteLength;
  session.decodedSourceFrames += decoded.frames;
  if (
    !Number.isSafeInteger(session.decodedInputBytes) ||
    !Number.isSafeInteger(session.decodedSourceFrames)
  ) {
    throw new LinearPcmWorkerError(
      'counter-overflow',
      'Linear PCM decode counters exceed safe integers',
    );
  }
  session.inputEof = plan.final;
  postProgress(session, plan.final);
  return true;
}

function createResamplers(session: DecoderSession): void {
  if (session.resamplers.length > 0) return;
  const created: ChunkedResampler[] = [];
  try {
    for (let channel = 0; channel < session.descriptor.channels; channel += 1) {
      created.push(
        new ChunkedResampler(
          session.descriptor.sourceSampleRate,
          session.descriptor.outputSampleRate,
        ),
      );
    }
  } catch (error) {
    for (const resampler of created) resampler.free();
    throw new LinearPcmWorkerError('resampler-init-failed', errorMessage(error));
  }
  session.resamplers = created;
}

function expectedResamplerFramesAfter(
  session: DecoderSession,
  consumedSourceFrames: number,
): number {
  return expectedLanczosOutputFrames({
    inputSampleRate: session.descriptor.sourceSampleRate,
    outputSampleRate: session.descriptor.outputSampleRate,
    totalSourceFrames: consumedSourceFrames,
    startSourceFrame: 0,
  });
}

function runResamplers(
  session: DecoderSession,
  inputs: readonly Float32Array[],
  inputFrames: number,
  maximumOutputFrames: number,
  keepOutputFrames: number,
  requireExactWritten: boolean,
): readonly Float32Array[] {
  createResamplers(session);
  const outputs: Float32Array[] = [];
  for (let channel = 0; channel < session.descriptor.channels; channel += 1) {
    const resampler = session.resamplers[channel];
    const input = inputs[channel];
    if (!resampler || !input) {
      throw new LinearPcmWorkerError(
        'resampler-channel-missing',
        'Linear PCM resampler channel is missing',
      );
    }
    if (resampler.maxNumOutputFrames(inputFrames) !== maximumOutputFrames) {
      throw new LinearPcmWorkerError('resampler-contract-mismatch', 'Pinned Lanczos bound changed');
    }
    const output = new Float32Array(maximumOutputFrames + RESAMPLER_SCRATCH_GUARD_FRAMES);
    const outcome = resampler.resample(input, output);
    try {
      if (outcome.numRead !== inputFrames) {
        throw new LinearPcmWorkerError(
          'resampler-stalled',
          'Linear PCM resampler did not consume its input',
        );
      }
      if (
        !Number.isSafeInteger(outcome.numWritten) ||
        outcome.numWritten < keepOutputFrames ||
        outcome.numWritten > maximumOutputFrames ||
        (requireExactWritten && outcome.numWritten !== keepOutputFrames)
      ) {
        throw new LinearPcmWorkerError(
          'resampler-contract-mismatch',
          'Pinned Lanczos output changed',
        );
      }
      outputs.push(output.subarray(0, keepOutputFrames));
    } finally {
      outcome.free();
    }
  }
  return outputs;
}

function accountProducedFrames(session: DecoderSession, frames: number): void {
  session.producedOutputFrames += frames;
  if (
    !Number.isSafeInteger(session.producedOutputFrames) ||
    session.producedOutputFrames > session.expectedFrames
  ) {
    throw new LinearPcmWorkerError(
      'output-frame-overrun',
      'Linear PCM output exceeds its exact timeline',
    );
  }
}

function createDirectSegment(session: DecoderSession): PcmSegment | null {
  const carry = session.sourceCarry;
  if (!carry) return null;
  const frames = Math.min(carry.frames, PCM_STREAM_MAX_MESSAGE_FRAMES);
  const channels = consumeSourceCarry(session, frames);
  accountProducedFrames(session, frames);
  return { channels, frames, offset: 0 };
}

function createNormalResampledSegment(session: DecoderSession): PcmSegment | null {
  const carry = session.sourceCarry;
  if (!carry) return null;
  const rates = {
    inputSampleRate: session.descriptor.sourceSampleRate,
    outputSampleRate: session.descriptor.outputSampleRate,
  };
  const plan = planBoundedLanczosChunk({
    ...rates,
    remainingSourceFrames: carry.frames,
    maxOutputFrames: PCM_STREAM_MAX_MESSAGE_FRAMES,
  });
  if (!plan) return null;

  const inputs = consumeSourceCarry(session, plan.inputFrames);
  const consumedAfter = session.resamplerConsumedSourceFrames + plan.inputFrames;
  const expectedAfter = expectedResamplerFramesAfter(session, consumedAfter);
  const outputFrames = expectedAfter - session.producedOutputFrames;
  if (outputFrames <= 0 || outputFrames > plan.maximumOutputFrames) {
    throw new LinearPcmWorkerError(
      'resampler-contract-mismatch',
      'Lanczos output delta is invalid',
    );
  }
  const outputs = runResamplers(
    session,
    inputs,
    plan.inputFrames,
    plan.maximumOutputFrames,
    outputFrames,
    true,
  );
  session.resamplerConsumedSourceFrames = consumedAfter;
  accountProducedFrames(session, outputFrames);
  return { channels: outputs, frames: outputFrames, offset: 0 };
}

function createEofResampledSegment(session: DecoderSession): PcmSegment | null {
  const carry = session.sourceCarry;
  if (!carry) return null;
  const plan = planShortLanczosInput({
    inputSampleRate: session.descriptor.sourceSampleRate,
    outputSampleRate: session.descriptor.outputSampleRate,
    consumedSourceFrames: session.resamplerConsumedSourceFrames,
    producedOutputFrames: session.producedOutputFrames,
    carriedSourceFrames: carry.frames,
    endOfStream: true,
  });
  if (plan.kind !== 'pad-and-trim') {
    throw new LinearPcmWorkerError(
      'resampler-contract-mismatch',
      'EOF Lanczos plan did not finalize',
    );
  }
  const realInputs = consumeSourceCarry(session, plan.realInputFrames);
  const paddedInputs = realInputs.map((input) => {
    const padded = new Float32Array(plan.paddedInputFrames);
    padded.set(input);
    return padded;
  });
  const outputs = runResamplers(
    session,
    paddedInputs,
    plan.paddedInputFrames,
    plan.maximumOutputFrames,
    plan.trimToOutputFrames,
    false,
  );
  session.resamplerConsumedSourceFrames += plan.realInputFrames;
  accountProducedFrames(session, plan.trimToOutputFrames);
  if (plan.trimToOutputFrames === 0) return null;
  return { channels: outputs, frames: plan.trimToOutputFrames, offset: 0 };
}

function createOutputSegment(session: DecoderSession): PcmSegment | null {
  if (session.descriptor.sourceSampleRate === session.descriptor.outputSampleRate) {
    return createDirectSegment(session);
  }
  const normal = createNormalResampledSegment(session);
  if (normal) return normal;
  if (!session.inputEof) return null;
  return createEofResampledSegment(session);
}

async function ensureOutputSegment(session: DecoderSession): Promise<void> {
  while (!session.outputSegment) {
    assertCurrent(session);
    const segment = createOutputSegment(session);
    if (segment) {
      session.outputSegment = segment;
      return;
    }
    if (session.inputEof) return;
    await decodeNextChunk(session);
    assertCurrent(session);
  }
}

function validateDemand(session: DecoderSession, value: unknown): number | null {
  if (!isRecord(value)) return null;
  if (
    value.protocolVersion !== PCM_STREAM_PROTOCOL_VERSION ||
    value.type !== 'need' ||
    value.generation !== session.decoderGeneration
  ) {
    return null;
  }
  const maxFrames = value.maxFrames;
  if (
    typeof maxFrames !== 'number' ||
    !Number.isFinite(maxFrames) ||
    !Number.isSafeInteger(maxFrames) ||
    maxFrames <= 0
  ) {
    throw new LinearPcmWorkerError('invalid-demand', 'PCM demand has an invalid frame count');
  }
  return Math.min(maxFrames, PCM_STREAM_MAX_MESSAGE_FRAMES);
}

async function handleDemand(session: DecoderSession, maxFrames: number): Promise<void> {
  assertCurrent(session);
  const collected = Array.from(
    { length: session.descriptor.channels },
    () => new Float32Array(maxFrames),
  );
  let collectedFrames = 0;

  while (collectedFrames < maxFrames) {
    await ensureOutputSegment(session);
    assertCurrent(session);
    const segment = session.outputSegment;
    if (!segment) break;
    const frames = Math.min(maxFrames - collectedFrames, segment.frames - segment.offset);
    if (frames <= 0) {
      throw new LinearPcmWorkerError('invalid-segment', 'Linear PCM segment is empty');
    }
    const end = segment.offset + frames;
    for (let channel = 0; channel < collected.length; channel += 1) {
      const target = collected[channel];
      const source = segment.channels[channel];
      if (!target || !source) {
        throw new LinearPcmWorkerError('invalid-segment', 'Linear PCM segment channel is missing');
      }
      target.set(source.subarray(segment.offset, end), collectedFrames);
    }
    collectedFrames += frames;
    segment.offset = end;
    if (segment.offset >= segment.frames) session.outputSegment = null;
  }

  if (collectedFrames === 0) {
    if (!session.inputEof || session.sourceCarry || session.outputSegment) {
      throw new LinearPcmWorkerError(
        'decoder-stalled',
        'Linear PCM decoder produced neither PCM nor EOF',
      );
    }
    finishSession(session, false);
    return;
  }

  const buffers: ArrayBuffer[] = collected.map((channel) => {
    const copy = channel.slice(0, collectedFrames);
    return copy.buffer as ArrayBuffer;
  });
  const final =
    session.inputEof &&
    session.sourceCarry === null &&
    session.outputSegment === null &&
    session.producedOutputFrames === session.expectedFrames;
  const supply: PcmSupplyMessage = {
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'pcm',
    generation: session.decoderGeneration,
    frames: collectedFrames,
    channels: buffers,
    final,
  };
  session.port.postMessage(supply, buffers);
  if (final) finishSession(session, true);
}

function queueDemand(session: DecoderSession, event: MessageEvent<unknown>): void {
  if (session.stopped || session.terminal || activeSession !== session || session.demandPending) {
    return;
  }
  let maxFrames: number | null;
  try {
    maxFrames = validateDemand(session, event.data);
  } catch (error) {
    failSession(session, error);
    return;
  }
  if (maxFrames === null) return;
  session.demandPending = true;
  session.requestChain = handleDemand(session, maxFrames)
    .catch((error: unknown) => failSession(session, error))
    .finally(() => {
      session.demandPending = false;
    });
}

function createSession(
  message: LinearPcmDecoderInitMessage,
  source: SourceLifetime,
): DecoderSession {
  const descriptor = message.descriptor;
  const session: DecoderSession = {
    sourceLifetimeGeneration: source.generation,
    decoderGeneration: message.decoderGeneration,
    descriptor,
    source,
    port: message.pcmPort,
    portListener: (event: MessageEvent<unknown>) => queueDemand(session, event),
    abortController: new AbortController(),
    expectedFrames: expectedLinearPcmOutputFrames(descriptor),
    resamplers: [],
    sourceCarry: null,
    outputSegment: null,
    nextSourceFrame: descriptor.targetSourceFrame,
    decodedInputBytes: 0,
    decodedSourceFrames: 0,
    resamplerConsumedSourceFrames: 0,
    producedOutputFrames: 0,
    lastProgressBytes: 0,
    inputEof: descriptor.targetSourceFrame === descriptor.totalSourceFrames,
    requestChain: Promise.resolve(),
    demandPending: false,
    stopped: false,
    terminal: false,
    released: false,
  };
  return session;
}

function validateSourceBounds(message: LinearPcmDecoderInitMessage, source: SourceLifetime): void {
  if (message.descriptor.logicalFileBytes !== source.size) {
    throw new LinearPcmWorkerError(
      'invalid-source',
      'Linear PCM descriptor logical size differs from the encoded source',
    );
  }
  const dataEnd = BigInt(message.descriptor.dataOffset) + BigInt(message.descriptor.dataBytes);
  if (dataEnd > BigInt(source.size)) {
    throw new LinearPcmWorkerError('invalid-source', 'Linear PCM data exceeds the encoded source');
  }
}

async function initialize(message: LinearPcmDecoderInitMessage): Promise<void> {
  try {
    const source = activeSource;
    if (
      !source ||
      source.closed ||
      source.client.closed ||
      source.generation !== message.sourceLifetimeGeneration
    ) {
      throw new LinearPcmWorkerError('source-not-open', 'Linear PCM encoded source is not open');
    }
    if (message.decoderGeneration <= latestDecoderGeneration) {
      message.pcmPort.close();
      return;
    }
    validateLinearPcmDecoderDescriptor(message.descriptor);
    validateSourceBounds(message, source);

    if (activeSession) stopSession(activeSession);
    if (source.decoderStarted) source.client.beginDecoderGeneration();
    source.decoderStarted = true;
    latestDecoderGeneration = message.decoderGeneration;
    const session = createSession(message, source);
    activeSession = session;
    session.port.addEventListener('message', session.portListener);

    assertCurrent(session);
    if (session.descriptor.sourceSampleRate !== session.descriptor.outputSampleRate) {
      await ensureLanczosReady();
    }
    assertCurrent(session);
    postControl({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-ready',
      sourceLifetimeGeneration: session.sourceLifetimeGeneration,
      decoderGeneration: session.decoderGeneration,
      descriptor: session.descriptor,
    });
    session.port.start();
  } catch (error) {
    const session = activeSession;
    if (session && session.decoderGeneration === message.decoderGeneration) {
      failSession(session, error);
    } else if (!(error instanceof SessionCancelledError)) {
      try {
        message.pcmPort.close();
      } catch {
        // Invalid initialization may not contain a live MessagePort.
      }
      postControl({
        protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
        type: 'decoder-error',
        sourceLifetimeGeneration: message.sourceLifetimeGeneration,
        decoderGeneration: message.decoderGeneration,
        code: errorCode(error),
        message: errorMessage(error),
      });
    }
  }
}

type WorkerRecord = Readonly<Record<string, unknown>>;

function snapshotWorkerRecord(value: unknown): WorkerRecord | null {
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
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || Object.prototype.hasOwnProperty.call(record, key)) return null;
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
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}

function hasExactKeys(record: WorkerRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function snapshotDescriptor(value: unknown): LinearPcmDecoderDescriptor | null {
  const record = snapshotWorkerRecord(value);
  if (!record || !hasExactKeys(record, LINEAR_PCM_DECODER_DESCRIPTOR_KEYS)) return null;
  const descriptor = Object.freeze({ ...record }) as unknown as LinearPcmDecoderDescriptor;
  try {
    validateLinearPcmDecoderDescriptor(descriptor);
    return descriptor;
  } catch {
    return null;
  }
}

function parseWorkerCommand(value: unknown): LinearPcmDecoderCommand | null {
  const record = snapshotWorkerRecord(value);
  if (
    !record ||
    record.protocolVersion !== LINEAR_PCM_DECODER_PROTOCOL_VERSION ||
    typeof record.type !== 'string'
  ) {
    return null;
  }
  if (record.type === 'open-source') {
    if (
      !hasExactKeys(record, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'sourceSize',
        'sourceIdentity',
        'sourcePort',
      ]) ||
      !isLinearPcmSourceLifetimeGeneration(record.sourceLifetimeGeneration) ||
      !isLinearPcmSourceSize(record.sourceSize) ||
      !isEncodedAudioSourceIdentity(record.sourceIdentity) ||
      !(record.sourcePort instanceof MessagePort)
    ) {
      return null;
    }
    return record as unknown as LinearPcmSourceOpenMessage;
  }
  if (record.type === 'init-decoder') {
    if (
      !hasExactKeys(record, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'decoderGeneration',
        'descriptor',
        'pcmPort',
      ]) ||
      !isLinearPcmSourceLifetimeGeneration(record.sourceLifetimeGeneration) ||
      !isLinearPcmDecoderGeneration(record.decoderGeneration) ||
      !(record.pcmPort instanceof MessagePort)
    ) {
      return null;
    }
    const descriptor = snapshotDescriptor(record.descriptor);
    if (!descriptor) return null;
    return Object.freeze({ ...record, descriptor }) as unknown as LinearPcmDecoderInitMessage;
  }
  if (record.type === 'stop-decoder') {
    if (
      !hasExactKeys(record, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'decoderGeneration',
      ]) ||
      !isLinearPcmSourceLifetimeGeneration(record.sourceLifetimeGeneration) ||
      !isLinearPcmDecoderGeneration(record.decoderGeneration)
    ) {
      return null;
    }
    return record as unknown as LinearPcmDecoderCommand;
  }
  if (record.type === 'close-source') {
    if (
      !hasExactKeys(record, ['protocolVersion', 'type', 'sourceLifetimeGeneration']) ||
      !isLinearPcmSourceLifetimeGeneration(record.sourceLifetimeGeneration)
    ) {
      return null;
    }
    return record as unknown as LinearPcmSourceCloseMessage;
  }
  return null;
}

function postSourceError(sourceLifetimeGeneration: number, code: string): void {
  postControl({
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'source-error',
    sourceLifetimeGeneration,
    code,
  });
}

function openSource(message: LinearPcmSourceOpenMessage): void {
  if (activeSource) {
    message.sourcePort.close();
    postSourceError(message.sourceLifetimeGeneration, 'source-already-open');
    return;
  }
  try {
    const client = new EncodedSourcePortClient({
      port: message.sourcePort,
      generation: message.sourceLifetimeGeneration,
      size: message.sourceSize,
      maxPendingReads: 1,
    });
    activeSource = {
      generation: message.sourceLifetimeGeneration,
      size: message.sourceSize,
      identity: message.sourceIdentity,
      client,
      decoderStarted: false,
      closed: false,
    };
    latestDecoderGeneration = 0;
    postControl({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'source-opened',
      sourceLifetimeGeneration: message.sourceLifetimeGeneration,
      sourceSize: message.sourceSize,
      sourceIdentity: message.sourceIdentity,
    });
  } catch {
    message.sourcePort.close();
    postSourceError(message.sourceLifetimeGeneration, 'source-open-failed');
  }
}

async function closeSource(source: SourceLifetime): Promise<void> {
  if (source.closed) return;
  source.closed = true;
  if (activeSession?.sourceLifetimeGeneration === source.generation) stopSession(activeSession);
  if (activeSource === source) activeSource = null;
  await source.client.close();
  postControl({
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'source-closed',
    sourceLifetimeGeneration: source.generation,
  });
}

function closeTransferredCommandPorts(value: unknown): void {
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
      Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
      descriptor.value instanceof MessagePort
    ) {
      descriptor.value.close();
    }
  }
}

function protocolFailure(value?: unknown): void {
  closeTransferredCommandPorts(value);
  const session = activeSession;
  if (session) {
    failSession(
      session,
      new LinearPcmWorkerError(
        'invalid-command',
        'Linear PCM worker command failed strict validation',
      ),
    );
  }
  const source = activeSource;
  if (source) {
    postSourceError(source.generation, 'invalid-command');
    void closeSource(source);
  }
}

function handleCommand(value: unknown): void {
  const command = parseWorkerCommand(value);
  if (!command) {
    protocolFailure(value);
    return;
  }
  if (command.type === 'open-source') {
    openSource(command);
    return;
  }
  const source = activeSource;
  if (!source || source.generation !== command.sourceLifetimeGeneration) {
    protocolFailure(command);
    return;
  }
  if (command.type === 'close-source') {
    void closeSource(source);
    return;
  }
  if (command.type === 'stop-decoder') {
    const session = activeSession;
    if (session?.decoderGeneration === command.decoderGeneration) stopSession(session);
    return;
  }
  void initialize(command);
}

scope.onmessage = (event: MessageEvent<LinearPcmDecoderCommand>) => handleCommand(event.data);

scope.addEventListener('messageerror', () => {
  const session = activeSession;
  if (session) {
    failSession(
      session,
      new LinearPcmWorkerError('message-deserialization', 'Worker message failed to deserialize'),
    );
  }
  const source = activeSource;
  if (source) {
    postSourceError(source.generation, 'message-deserialization');
    void closeSource(source);
  }
});

export {};
