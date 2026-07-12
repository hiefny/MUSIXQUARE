/// <reference lib="webworker" />

import { FLACDecoder, type FLACDecodedAudio } from '@wasm-audio-decoders/flac';
import { ChunkedResampler, initWithBase64 } from 'lanczos-resampler/loader.js';
import {
  NativeFlacFrameError,
  NativeFlacFrameReader,
  type NativeFlacFrame,
} from '../player/flac/frame-scanner.js';
import {
  expectedLanczosOutputFrames,
  minimumLanczosInputFrames,
  planBoundedLanczosChunk,
  planShortLanczosInput,
} from '../player/flac/resampler-plan.js';
import {
  discardDecodedSourcePrefix,
  expectedOutputFrames,
  validateFlacStreamDescriptor,
} from '../player/flac/decoder-helpers.js';
import {
  FLAC_STREAM_INPUT_CHUNK_BYTES,
  FLAC_STREAM_MAX_CHANNELS,
  FLAC_STREAM_MAX_PCM_MESSAGE_FRAMES,
  FLAC_STREAM_PROTOCOL_VERSION,
  isFlacStreamGeneration,
  type FlacDecoderCommand,
  type FlacDecoderEvent,
  type FlacDecoderInitMessage,
  type FlacStreamDescriptor,
  type PcmSupplyMessage,
} from '../player/flac/stream-protocol.js';

const scope = self as DedicatedWorkerGlobalScope;

const PRODUCT_MAX_ENCODED_FRAME_BYTES = 0xff_ffff;
const PROGRESS_INTERVAL_BYTES = 1024 * 1024;
const MAX_FRAME_INDEX_EVENTS = 8_192;
// lanczos-resampler@0.4.1 can touch a small phase tail beyond its nominal
// maxNumOutputFrames buffer at extreme ratios. The published frame count still
// follows the pinned plan; this fixed scratch guard is never transferred.
const RESAMPLER_SCRATCH_GUARD_FRAMES = 64;

class FlacWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FlacWorkerError';
  }
}

class SessionCancelledError extends Error {
  constructor() {
    super('FLAC decoder session was cancelled');
    this.name = 'SessionCancelledError';
  }
}

/** Blob-backed random reader; a future range ByteSource can implement this seam. */
class BlobRangeSource {
  constructor(readonly blob: Blob) {}

  get size(): number {
    return this.blob.size;
  }

  async readChunk(
    absoluteByteOffset: number,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(absoluteByteOffset) ||
      absoluteByteOffset < 0 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes <= 0
    ) {
      throw new FlacWorkerError('invalid-source-read', 'FLAC source read range is invalid');
    }
    if (absoluteByteOffset >= this.blob.size) return new Uint8Array();
    const requestedEnd = absoluteByteOffset + maximumBytes;
    if (!Number.isSafeInteger(requestedEnd)) {
      throw new FlacWorkerError('invalid-source-read', 'FLAC source read exceeds safe integers');
    }
    const end = Math.min(this.blob.size, requestedEnd);
    const buffer = await this.blob.slice(absoluteByteOffset, end).arrayBuffer();
    signal?.throwIfAborted();
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== end - absoluteByteOffset) {
      throw new FlacWorkerError('source-read-short', 'Blob returned an incomplete FLAC read');
    }
    return bytes;
  }
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
  readonly generation: number;
  readonly descriptor: FlacStreamDescriptor;
  readonly source: BlobRangeSource;
  readonly port: MessagePort;
  readonly portListener: (event: MessageEvent<unknown>) => void;
  readonly abortController: AbortController;
  readonly expectedFrames: number;
  readonly frameIndexSpacingSamples: number;
  decoder: FLACDecoder | null;
  frameReader: NativeFlacFrameReader | null;
  resamplers: ChunkedResampler[];
  sourceCarry: SourcePcmCarry | null;
  outputSegment: PcmSegment | null;
  sourceSamplesToDiscard: number;
  decodedInputBytes: number;
  decodedSourceSamples: number;
  resamplerConsumedSourceFrames: number;
  producedOutputFrames: number;
  lastProgressBytes: number;
  lastFrameIndexSample: number;
  frameIndexEvents: number;
  hasDecodedFrame: boolean;
  originFallbackUsed: boolean;
  inputEof: boolean;
  requestChain: Promise<void>;
  demandPending: boolean;
  stopped: boolean;
  terminal: boolean;
  released: boolean;
}

let activeSession: DecoderSession | null = null;
let latestGeneration = 0;
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
  if (error instanceof FlacWorkerError) return error.code;
  if (error instanceof NativeFlacFrameError) return 'invalid-flac-frame';
  return 'decode-failed';
}

function postControl(message: FlacDecoderEvent): void {
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
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'decode-progress',
    generation: session.generation,
    decodedInputBytes: session.decodedInputBytes,
    decodedSourceSamples: session.decodedSourceSamples,
    producedOutputFrames: session.producedOutputFrames,
  });
}

function releaseSessionResources(session: DecoderSession): void {
  if (session.released) return;
  session.released = true;
  session.abortController.abort(new DOMException('FLAC decoder stopped', 'AbortError'));
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
  try {
    session.decoder?.free();
  } catch {
    // Best-effort release after a decoder failure.
  }
  session.decoder = null;
  session.frameReader = null;
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
  session.abortController.abort(new DOMException('FLAC decoder stopped', 'AbortError'));
  session.port.removeEventListener('message', session.portListener);
  try {
    session.port.close();
  } catch {
    // The owner may have already closed its half of the channel.
  }
  detachActiveSession(session);
  postControl({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'decoder-stopped',
    generation: session.generation,
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
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'source-error',
      generation: session.generation,
      code,
    };
    session.port.postMessage(supply);
  } catch {
    // The control-channel error remains authoritative if the PCM port is gone.
  }
  postControl({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'decoder-error',
    generation: session.generation,
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
  // `failSession` can run from the global messageerror handler while a WASM
  // decode is still awaiting. It can also run inside requestChain.catch(); in
  // both cases registering (not awaiting) this continuation is non-deadlocking
  // and prevents freeing decoder/resampler memory until the operation settles.
  releaseAfterPendingDemand(session);
}

function finishSession(session: DecoderSession, sentFinalPcm: boolean): void {
  assertCurrent(session);
  if (session.producedOutputFrames !== session.expectedFrames) {
    throw new FlacWorkerError(
      'output-frame-mismatch',
      `FLAC output produced ${session.producedOutputFrames} frames; expected ${session.expectedFrames}`,
    );
  }
  if (!sentFinalPcm) {
    const supply: PcmSupplyMessage = {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'eof',
      generation: session.generation,
    };
    session.port.postMessage(supply);
  }
  postProgress(session, true);
  postControl({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'decoder-eof',
    generation: session.generation,
    decodedInputBytes: session.decodedInputBytes,
    decodedSourceSamples: session.decodedSourceSamples,
    producedOutputFrames: session.producedOutputFrames,
  });
  session.stopped = true;
  session.terminal = true;
  detachActiveSession(session);
  releaseSessionResources(session);
}

function createFrameReader(
  session: DecoderSession,
  startByteOffset: number,
): NativeFlacFrameReader {
  const descriptor = session.descriptor;
  return new NativeFlacFrameReader({
    readChunk: (offset, maximumBytes, signal) =>
      session.source.readChunk(offset, maximumBytes, signal),
    startByteOffset,
    readSize: FLAC_STREAM_INPUT_CHUNK_BYTES,
    streamInfo: {
      sampleRate: descriptor.sourceSampleRate,
      channels: descriptor.channels,
      bitDepth: descriptor.bitDepth,
      maxBlockSize: descriptor.maxBlockSize,
      minFrameSize: descriptor.minFrameSize,
      maxFrameSize: descriptor.maxFrameSize,
    },
    productMaxFrameSize: PRODUCT_MAX_ENCODED_FRAME_BYTES,
  });
}

function resetToOriginAfterUnverifiedAnchor(session: DecoderSession): void {
  const descriptor = session.descriptor;
  session.originFallbackUsed = true;
  session.frameReader = createFrameReader(session, descriptor.firstAudioFrameOffset);
  session.decodedInputBytes = descriptor.firstAudioFrameOffset;
  session.decodedSourceSamples = 0;
  session.sourceSamplesToDiscard = descriptor.targetSourceSample;
  session.lastProgressBytes = descriptor.firstAudioFrameOffset;
  session.lastFrameIndexSample = -session.frameIndexSpacingSamples;
  session.frameIndexEvents = 0;
}

async function readNextVerifiedFrame(session: DecoderSession): Promise<NativeFlacFrame | null> {
  const reader = session.frameReader;
  if (!reader) throw new FlacWorkerError('decoder-not-ready', 'FLAC frame reader is missing');
  assertCurrent(session);
  try {
    const frame = await reader.next(session.abortController.signal);
    assertCurrent(session);
    return frame;
  } catch (error) {
    assertCurrent(session);
    const descriptor = session.descriptor;
    if (
      error instanceof NativeFlacFrameError &&
      !session.hasDecodedFrame &&
      !session.originFallbackUsed &&
      descriptor.decodeAnchorByteOffset !== descriptor.firstAudioFrameOffset
    ) {
      resetToOriginAfterUnverifiedAnchor(session);
      const originReader = session.frameReader;
      if (!originReader) throw new FlacWorkerError('decoder-not-ready', 'Origin reader is missing');
      assertCurrent(session);
      const frame = await originReader.next(session.abortController.signal);
      assertCurrent(session);
      return frame;
    }
    throw error;
  }
}

function maybeEmitFrameIndexPoint(session: DecoderSession, frame: NativeFlacFrame): void {
  if (session.frameIndexEvents >= MAX_FRAME_INDEX_EVENTS) return;
  if (
    session.frameIndexEvents > 0 &&
    frame.absoluteSourceSample - session.lastFrameIndexSample < session.frameIndexSpacingSamples
  ) {
    return;
  }
  session.lastFrameIndexSample = frame.absoluteSourceSample;
  session.frameIndexEvents += 1;
  postControl({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'frame-index-point',
    generation: session.generation,
    sourceSample: frame.absoluteSourceSample,
    byteOffset: frame.byteOffset,
  });
}

function validateDecodedFrame(
  session: DecoderSession,
  frame: NativeFlacFrame,
  result: FLACDecodedAudio,
): void {
  if (result.errors.length > 0) {
    throw new FlacWorkerError(
      'decode-error',
      result.errors[0]?.message ?? 'FLAC decoder reported a frame error',
    );
  }
  if (result.samplesDecoded !== frame.blockSize) {
    throw new FlacWorkerError(
      'metadata-mismatch',
      'FLAC scanner and decoder disagree on the frame block size',
    );
  }
  const descriptor = session.descriptor;
  if (
    result.sampleRate !== descriptor.sourceSampleRate ||
    result.bitDepth !== descriptor.bitDepth ||
    result.channelData.length !== descriptor.channels
  ) {
    throw new FlacWorkerError(
      'metadata-mismatch',
      'Decoded FLAC sample rate, bit depth, or channel count differs from STREAMINFO',
    );
  }
  if (result.channelData.length < 1 || result.channelData.length > FLAC_STREAM_MAX_CHANNELS) {
    throw new FlacWorkerError('unsupported-channels', 'Decoded FLAC channel count is unsupported');
  }
  for (const channel of result.channelData) {
    if (!(channel instanceof Float32Array) || channel.length !== result.samplesDecoded) {
      throw new FlacWorkerError('invalid-frame', 'Decoded FLAC channels have inconsistent lengths');
    }
  }
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
    throw new FlacWorkerError('pcm-carry-overrun', 'FLAC PCM carry was not drained before decode');
  }
  const combinedFrames = carry.frames + frames;
  if (combinedFrames > session.descriptor.maxBlockSize + maximumCarryFrames) {
    throw new FlacWorkerError('pcm-carry-overrun', 'FLAC PCM carry exceeds its fixed bound');
  }
  const combined = carry.channels.map((previous, channel) => {
    const next = channels[channel];
    if (!next) throw new FlacWorkerError('invalid-frame', 'Decoded FLAC channel is missing');
    const output = new Float32Array(combinedFrames);
    output.set(previous, 0);
    output.set(next, carry.frames);
    return output;
  });
  session.sourceCarry = { channels: combined, frames: combinedFrames };
}

function descriptorMinimumResamplerInput(session: DecoderSession): number {
  if (session.descriptor.sourceSampleRate === session.descriptor.outputSampleRate) return 1;
  return minimumLanczosInputFrames({
    inputSampleRate: session.descriptor.sourceSampleRate,
    outputSampleRate: session.descriptor.outputSampleRate,
  });
}

function consumeSourceCarry(session: DecoderSession, frames: number): readonly Float32Array[] {
  const carry = session.sourceCarry;
  if (!carry || frames <= 0 || frames > carry.frames) {
    throw new FlacWorkerError('invalid-pcm-carry', 'FLAC PCM carry consumption is invalid');
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

async function decodeNextFrame(session: DecoderSession): Promise<boolean> {
  const decoder = session.decoder;
  if (!decoder) throw new FlacWorkerError('decoder-not-ready', 'FLAC decoder is not initialized');
  const frame = await readNextVerifiedFrame(session);
  assertCurrent(session);
  if (!frame) {
    if (session.decodedSourceSamples !== session.descriptor.totalSourceSamples) {
      throw new FlacWorkerError(
        'total-samples-underrun',
        `FLAC ended at sample ${session.decodedSourceSamples}; STREAMINFO declares ${session.descriptor.totalSourceSamples}`,
      );
    }
    if (session.sourceSamplesToDiscard !== 0) {
      throw new FlacWorkerError(
        'seek-out-of-range',
        'FLAC ended before the requested source sample',
      );
    }
    session.inputEof = true;
    postProgress(session, true);
    return false;
  }

  if (frame.absoluteSourceSample !== session.decodedSourceSamples) {
    if (
      !session.hasDecodedFrame &&
      !session.originFallbackUsed &&
      session.descriptor.decodeAnchorByteOffset !== session.descriptor.firstAudioFrameOffset
    ) {
      resetToOriginAfterUnverifiedAnchor(session);
      return decodeNextFrame(session);
    }
    throw new FlacWorkerError(
      'anchor-sequence-mismatch',
      `FLAC frame begins at sample ${frame.absoluteSourceSample}; expected ${session.decodedSourceSamples}`,
    );
  }
  const frameEndSample = frame.absoluteSourceSample + frame.blockSize;
  const frameEndByte = frame.byteOffset + frame.data.byteLength;
  if (
    !Number.isSafeInteger(frameEndSample) ||
    frameEndSample > session.descriptor.totalSourceSamples ||
    !Number.isSafeInteger(frameEndByte) ||
    frameEndByte > session.source.size
  ) {
    throw new FlacWorkerError('frame-overrun', 'Verified FLAC frame exceeds STREAMINFO or Blob');
  }

  assertCurrent(session);
  const result = await decoder.decodeFrames([frame.data]);
  assertCurrent(session);
  validateDecodedFrame(session, frame, result);
  session.hasDecodedFrame = true;
  session.decodedInputBytes = frameEndByte;
  session.decodedSourceSamples = frameEndSample;

  const discarded = discardDecodedSourcePrefix(
    result.channelData,
    result.samplesDecoded,
    session.sourceSamplesToDiscard,
  );
  session.sourceSamplesToDiscard = discarded.remainingDiscard;
  appendSourceCarry(session, discarded.channels, discarded.frames);
  maybeEmitFrameIndexPoint(session, frame);
  postProgress(session);

  if (session.decodedSourceSamples === session.descriptor.totalSourceSamples) {
    const extra = await readNextVerifiedFrame(session);
    assertCurrent(session);
    if (extra) {
      throw new FlacWorkerError(
        'total-samples-overrun',
        'FLAC contains a verified frame after the STREAMINFO total sample count',
      );
    }
    session.inputEof = true;
    postProgress(session, true);
  }
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
    throw new FlacWorkerError('resampler-init-failed', errorMessage(error));
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
      throw new FlacWorkerError('resampler-channel-missing', 'FLAC resampler channel is missing');
    }
    if (resampler.maxNumOutputFrames(inputFrames) !== maximumOutputFrames) {
      throw new FlacWorkerError('resampler-contract-mismatch', 'Pinned Lanczos bound changed');
    }
    const output = new Float32Array(maximumOutputFrames + RESAMPLER_SCRATCH_GUARD_FRAMES);
    const outcome = resampler.resample(input, output);
    try {
      if (outcome.numRead !== inputFrames) {
        throw new FlacWorkerError('resampler-stalled', 'FLAC resampler did not consume its input');
      }
      if (
        !Number.isSafeInteger(outcome.numWritten) ||
        outcome.numWritten < keepOutputFrames ||
        outcome.numWritten > maximumOutputFrames ||
        (requireExactWritten && outcome.numWritten !== keepOutputFrames)
      ) {
        throw new FlacWorkerError('resampler-contract-mismatch', 'Pinned Lanczos output changed');
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
    throw new FlacWorkerError('output-frame-overrun', 'FLAC output exceeds its exact timeline');
  }
}

function createDirectSegment(session: DecoderSession): PcmSegment | null {
  const carry = session.sourceCarry;
  if (!carry) return null;
  const frames = Math.min(carry.frames, FLAC_STREAM_MAX_PCM_MESSAGE_FRAMES);
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
    maxOutputFrames: FLAC_STREAM_MAX_PCM_MESSAGE_FRAMES,
  });
  if (!plan) return null;

  const inputs = consumeSourceCarry(session, plan.inputFrames);
  const consumedAfter = session.resamplerConsumedSourceFrames + plan.inputFrames;
  const expectedAfter = expectedResamplerFramesAfter(session, consumedAfter);
  const outputFrames = expectedAfter - session.producedOutputFrames;
  if (outputFrames <= 0 || outputFrames > plan.maximumOutputFrames) {
    throw new FlacWorkerError('resampler-contract-mismatch', 'Lanczos output delta is invalid');
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
  const rates = {
    inputSampleRate: session.descriptor.sourceSampleRate,
    outputSampleRate: session.descriptor.outputSampleRate,
  };
  const plan = planShortLanczosInput({
    ...rates,
    consumedSourceFrames: session.resamplerConsumedSourceFrames,
    producedOutputFrames: session.producedOutputFrames,
    carriedSourceFrames: carry.frames,
    endOfStream: true,
  });
  if (plan.kind !== 'pad-and-trim') {
    throw new FlacWorkerError('resampler-contract-mismatch', 'EOF Lanczos plan did not finalize');
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
    await decodeNextFrame(session);
    assertCurrent(session);
  }
}

function validateDemand(session: DecoderSession, value: unknown): number | null {
  if (!isRecord(value)) return null;
  if (
    value.protocolVersion !== FLAC_STREAM_PROTOCOL_VERSION ||
    value.type !== 'need' ||
    value.generation !== session.generation
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
    throw new FlacWorkerError('invalid-demand', 'PCM demand has an invalid frame count');
  }
  return Math.min(maxFrames, FLAC_STREAM_MAX_PCM_MESSAGE_FRAMES);
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
    if (frames <= 0) throw new FlacWorkerError('invalid-segment', 'FLAC PCM segment is empty');
    const end = segment.offset + frames;
    for (let channel = 0; channel < collected.length; channel += 1) {
      const target = collected[channel];
      const source = segment.channels[channel];
      if (!target || !source) {
        throw new FlacWorkerError('invalid-segment', 'FLAC PCM segment channel is missing');
      }
      target.set(source.subarray(segment.offset, end), collectedFrames);
    }
    collectedFrames += frames;
    segment.offset = end;
    if (segment.offset >= segment.frames) session.outputSegment = null;
  }

  if (collectedFrames === 0) {
    if (!session.inputEof || session.sourceCarry || session.outputSegment) {
      throw new FlacWorkerError('decoder-stalled', 'FLAC decoder produced neither PCM nor EOF');
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
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'pcm',
    generation: session.generation,
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

function createSession(message: FlacDecoderInitMessage): DecoderSession {
  const descriptor = Object.freeze({ ...message.descriptor });
  const source = new BlobRangeSource(message.blob);
  const spacingByBound = Math.ceil(descriptor.totalSourceSamples / (MAX_FRAME_INDEX_EVENTS - 2));
  const session: DecoderSession = {
    generation: message.generation,
    descriptor,
    source,
    port: message.pcmPort,
    portListener: (event) => queueDemand(session, event),
    abortController: new AbortController(),
    expectedFrames: expectedOutputFrames(descriptor),
    frameIndexSpacingSamples: Math.max(descriptor.sourceSampleRate, spacingByBound),
    decoder: null,
    frameReader: null,
    resamplers: [],
    sourceCarry: null,
    outputSegment: null,
    sourceSamplesToDiscard: descriptor.targetSourceSample - descriptor.decodeAnchorSourceSample,
    decodedInputBytes: descriptor.decodeAnchorByteOffset,
    decodedSourceSamples: descriptor.decodeAnchorSourceSample,
    resamplerConsumedSourceFrames: 0,
    producedOutputFrames: 0,
    lastProgressBytes: descriptor.decodeAnchorByteOffset,
    lastFrameIndexSample: -Math.max(descriptor.sourceSampleRate, spacingByBound),
    frameIndexEvents: 0,
    hasDecodedFrame: false,
    originFallbackUsed: false,
    inputEof: false,
    requestChain: Promise.resolve(),
    demandPending: false,
    stopped: false,
    terminal: false,
    released: false,
  };
  session.frameReader = createFrameReader(session, descriptor.decodeAnchorByteOffset);
  return session;
}

function validateSourceBounds(message: FlacDecoderInitMessage): void {
  if (!(message.blob instanceof Blob) || message.blob.size <= 0) {
    throw new FlacWorkerError('invalid-source', 'FLAC decoder requires a non-empty Blob source');
  }
  if (message.descriptor.firstAudioFrameOffset >= message.blob.size) {
    throw new FlacWorkerError('invalid-source', 'FLAC audio-frame offset is outside the Blob');
  }
  if (message.descriptor.decodeAnchorByteOffset >= message.blob.size) {
    throw new FlacWorkerError('invalid-source', 'FLAC decode anchor is outside the Blob');
  }
}

async function initialize(message: FlacDecoderInitMessage): Promise<void> {
  let candidateDecoder: FLACDecoder | null = null;
  try {
    if (message.generation <= latestGeneration) {
      if (message.pcmPort instanceof MessagePort) message.pcmPort.close();
      return;
    }
    if (!(message.pcmPort instanceof MessagePort)) {
      throw new FlacWorkerError('invalid-port', 'FLAC decoder requires a MessagePort');
    }
    validateFlacStreamDescriptor(message.descriptor);
    validateSourceBounds(message);
    latestGeneration = message.generation;

    if (activeSession) stopSession(activeSession);
    const session = createSession(message);
    activeSession = session;
    session.port.addEventListener('message', session.portListener);

    assertCurrent(session);
    candidateDecoder = new FLACDecoder();
    const decoderReady = candidateDecoder.ready;
    if (session.descriptor.sourceSampleRate === session.descriptor.outputSampleRate) {
      await decoderReady;
    } else {
      await Promise.all([decoderReady, ensureLanczosReady()]);
    }
    assertCurrent(session);
    session.decoder = candidateDecoder;
    candidateDecoder = null;
    postControl({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-ready',
      generation: session.generation,
      descriptor: session.descriptor,
    });
    session.port.start();
  } catch (error) {
    try {
      candidateDecoder?.free();
    } catch {
      // Candidate initialization failed before it was owned by a session.
    }
    const session = activeSession;
    if (session && session.generation === message.generation) {
      failSession(session, error);
    } else if (!(error instanceof SessionCancelledError)) {
      try {
        message.pcmPort.close();
      } catch {
        // Invalid initialization may not contain a live MessagePort.
      }
      postControl({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'decoder-error',
        generation: message.generation,
        code: errorCode(error),
        message: errorMessage(error),
      });
    }
  }
}

function handleCommand(value: unknown): void {
  if (!isRecord(value) || !isFlacStreamGeneration(value.generation)) return;
  const generation = value.generation;
  if (value.protocolVersion !== FLAC_STREAM_PROTOCOL_VERSION) {
    postControl({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-error',
      generation,
      code: 'protocol-version',
      message: 'Unsupported FLAC stream protocol version',
    });
    return;
  }
  if (value.type === 'stop') {
    const session = activeSession;
    if (session?.generation === generation) stopSession(session);
    return;
  }
  if (value.type !== 'init') return;
  void initialize(value as unknown as FlacDecoderInitMessage);
}

scope.onmessage = (event: MessageEvent<FlacDecoderCommand>) => handleCommand(event.data);

scope.addEventListener('messageerror', () => {
  const session = activeSession;
  if (session) {
    failSession(
      session,
      new FlacWorkerError('message-deserialization', 'Worker message failed to deserialize'),
    );
  }
});

export {};
