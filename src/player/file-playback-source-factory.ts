import type { QueueItemId } from '../types/index.ts';
import {
  AudioBufferPlaybackSource,
  type AudioBufferPlaybackSourceOptions,
} from './backends/audio-buffer-playback-source.ts';
import {
  StreamingFlacPlaybackSource,
  type StreamingFlacPlaybackRuntime,
  type StreamingFlacPlaybackSourceOptions,
} from './backends/streaming-flac-playback-source.ts';
import type { FilePlaybackSource } from './file-playback-source.ts';
import { readFlacMetadata, type FlacMetadata } from './flac/metadata.ts';
import { isFlacSourceIdentity } from './flac/stream-protocol.ts';
import { BlobEncodedAudioSource } from './sources/blob-encoded-audio-source.ts';
import {
  type EncodedAudioSource,
  EncodedSourceIntegrityError,
  throwIfAborted,
  validateExactRead,
} from './sources/encoded-audio-source.ts';

const NATIVE_FLAC_MARKER = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
const OGG_MARKER = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const MAX_IDENTIFIER_LENGTH = 256;

type AudioBufferSource = FilePlaybackSource & { readonly backend: 'audio-buffer' };
type StreamingFlacSource = FilePlaybackSource & { readonly backend: 'streaming-flac' };

export interface OrdinaryAudioDecodeRequest {
  /** The exact immutable Blob selected for this queue occurrence. */
  readonly blob: Blob;
  readonly audioContext: AudioContext;
  readonly signal: AbortSignal;
  /** Opaque object identity; never derived from the filename or byte length. */
  readonly sourceIdentity: string;
}

/**
 * A decoded buffer plus the decoder's temporary working-set reservation.
 *
 * The reservation covers construction/publication only. It must not be held
 * for the lifetime of the AudioBufferPlaybackSource because decoded PCM is
 * accounted separately once that exact AudioBuffer is published.
 */
export interface OrdinaryAudioDecodeResult {
  readonly audioBuffer: AudioBuffer;
  readonly release: () => void;
}

export type OrdinaryAudioDecoder = (
  request: OrdinaryAudioDecodeRequest,
) => Promise<OrdinaryAudioDecodeResult>;

export interface BlobFilePlaybackBackendFactories {
  readonly createAudioBufferSource: (
    options: AudioBufferPlaybackSourceOptions,
  ) => AudioBufferSource;
  readonly createStreamingFlacSource: (
    options: StreamingFlacPlaybackSourceOptions,
  ) => StreamingFlacSource;
}

interface FilePlaybackSourceFactoryCommonOptions {
  readonly queueItemId: QueueItemId;
  readonly audioContext: AudioContext;
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly signal: AbortSignal;
  /** Runtime seam is forwarded only to the streaming backend; it is not started here. */
  readonly streamingRuntime?: Partial<StreamingFlacPlaybackRuntime>;
}

export interface CreateBlobFilePlaybackSourceOptions extends FilePlaybackSourceFactoryCommonOptions {
  readonly blob: Blob;
  /** Product-owned ordinary-codec decoder. It must honor the supplied signal. */
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  /** Deterministic constructor seams for browser-boundary tests. */
  readonly backendFactories?: Partial<BlobFilePlaybackBackendFactories>;
}

/**
 * Generic random-access routing used by LAN peer-range and R2 sources.
 *
 * This public path deliberately supports native FLAC streaming only. Ordinary
 * browser decoding remains exclusive to createBlobFilePlaybackSource(), which
 * constructs the BlobEncodedAudioSource from the exact Blob it decodes.
 */
export interface CreateEncodedFilePlaybackSourceOptions extends FilePlaybackSourceFactoryCommonOptions {
  readonly encodedSource: EncodedAudioSource;
  readonly backendFactories?: Partial<
    Pick<BlobFilePlaybackBackendFactories, 'createStreamingFlacSource'>
  >;
}

interface ExactOrdinaryBlobBinding {
  readonly blob: Blob;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
}

interface CreateOwnedEncodedFilePlaybackSourceOptions extends FilePlaybackSourceFactoryCommonOptions {
  readonly encodedSource: EncodedAudioSource;
  readonly backendFactories?: Partial<BlobFilePlaybackBackendFactories>;
}

interface FilePlaybackSourceResultBase {
  /** Immutable identity of this exact encoded byte source. */
  readonly sourceIdentity: string;
  /**
   * Release the decoder's temporary construction lease after this source and
   * the exact decoded AudioBuffer have been published by one manager update.
   * The operation is idempotent. Streaming results expose a harmless no-op.
   */
  readonly releaseConstructionLease: () => void;
}

export interface AudioBufferFilePlaybackSourceResult extends FilePlaybackSourceResultBase {
  readonly backend: 'audio-buffer';
  readonly source: AudioBufferSource;
  /** The exact object supplied to the AudioBuffer backend. */
  readonly audioBuffer: AudioBuffer;
  readonly flacMetadata: null;
}

export interface StreamingFlacFilePlaybackSourceResult extends FilePlaybackSourceResultBase {
  readonly backend: 'streaming-flac';
  readonly source: StreamingFlacSource;
  /** Metadata verified from the native FLAC byte stream with bounded exact reads. */
  readonly flacMetadata: FlacMetadata;
}

export type BlobFilePlaybackSourceResult =
  | AudioBufferFilePlaybackSourceResult
  | StreamingFlacFilePlaybackSourceResult;

/** A claimed FLAC whose bytes use a container the streaming engine cannot decode. */
export class UnsupportedFlacContainerError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFlacContainerError';
  }
}

export class UnsupportedOrdinaryEncodedSourceError extends EncodedSourceIntegrityError {
  constructor() {
    super('Ordinary audio codecs require a local Blob; this encoded source can stream native FLAC');
    this.name = 'UnsupportedOrdinaryEncodedSourceError';
  }
}

const defaultBackendFactories: BlobFilePlaybackBackendFactories = {
  createAudioBufferSource: (options) => new AudioBufferPlaybackSource(options),
  createStreamingFlacSource: (options) => new StreamingFlacPlaybackSource(options),
};

function hasMarker(bytes: Uint8Array, marker: Uint8Array): boolean {
  return marker.every((byte, index) => bytes[index] === byte);
}

function claimsFlac(name: string, mime: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedMime = mime.trim().toLowerCase();
  return normalizedName.endsWith('.flac') || normalizedMime.includes('flac');
}

function assertFactoryInput(options: FilePlaybackSourceFactoryCommonOptions): void {
  if (
    typeof options.queueItemId !== 'string' ||
    options.queueItemId.length === 0 ||
    options.queueItemId.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new TypeError('Playback source queue item ID is invalid');
  }
  if (!options.audioContext) throw new TypeError('Playback source AudioContext is required');
  if (
    typeof options.roomTimeMsToContextTime !== 'function' ||
    typeof options.nowRoomTimeMs !== 'function' ||
    typeof options.localPerformanceMsToContextTime !== 'function'
  ) {
    throw new TypeError('Playback source clock mappings are invalid');
  }
  if (!(options.signal instanceof AbortSignal)) {
    throw new TypeError('Playback source AbortSignal is required');
  }
}

function assertBlobFactoryInput(
  options: CreateBlobFilePlaybackSourceOptions,
  blob: Blob,
  decodeOrdinaryAudio: OrdinaryAudioDecoder,
): void {
  assertFactoryInput(options);
  if (!(blob instanceof Blob)) throw new TypeError('Playback source requires a Blob');
  if (typeof decodeOrdinaryAudio !== 'function') {
    throw new TypeError('Ordinary audio decoder is required');
  }
}

function assertEncodedSource(source: EncodedAudioSource): void {
  if (
    !source ||
    typeof source.readAt !== 'function' ||
    typeof source.close !== 'function' ||
    !isFlacSourceIdentity(source.identity)
  ) {
    throw new TypeError('Playback encoded source is invalid');
  }
  validateExactRead(source.size, 0, 0);
}

function assertCreatedSource(
  source: FilePlaybackSource,
  backend: BlobFilePlaybackSourceResult['backend'],
  queueItemId: QueueItemId,
): void {
  if (source.backend !== backend || source.queueItemId !== queueItemId) {
    throw new TypeError('Playback backend factory returned a mismatched source');
  }
}

function assertDecodedAudioBuffer(value: unknown): asserts value is AudioBuffer {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Ordinary audio decoder returned an invalid AudioBuffer');
  }
  const candidate = value as Partial<AudioBuffer>;
  if (
    !Number.isFinite(candidate.duration) ||
    (candidate.duration as number) <= 0 ||
    !Number.isFinite(candidate.sampleRate) ||
    (candidate.sampleRate as number) <= 0 ||
    !Number.isSafeInteger(candidate.numberOfChannels) ||
    (candidate.numberOfChannels as number) <= 0 ||
    (candidate.numberOfChannels as number) > 8 ||
    !Number.isSafeInteger(candidate.length) ||
    (candidate.length as number) <= 0
  ) {
    throw new TypeError('Ordinary audio decoder returned an invalid AudioBuffer');
  }
}

function oneShotRelease(release: () => void): () => void {
  let ownedRelease: (() => void) | null = release;
  return () => {
    const current = ownedRelease;
    if (current === null) return;
    // Claim ownership before invoking client code so a throwing release cannot
    // be invoked twice by a later cleanup path.
    ownedRelease = null;
    current();
  };
}

function releaseWithoutMasking(release: (() => void) | null): void {
  if (release === null) return;
  try {
    release();
  } catch {
    // Preserve the decode/routing/abort error that caused construction to fail.
  }
}

const releaseNoConstructionLease = (): void => undefined;

async function destroyWithoutMasking(source: FilePlaybackSource | null): Promise<void> {
  if (!source) return;
  try {
    await source.destroy();
  } catch {
    // Preserve the routing/decode/abort error that caused construction to fail.
  }
}

function closeEncodedSourceOnce(source: EncodedAudioSource): () => Promise<void> {
  let closePromise: Promise<void> | null = null;
  return () => {
    if (closePromise) return closePromise;
    try {
      closePromise = Promise.resolve(source.close()).catch(() => undefined);
    } catch {
      closePromise = Promise.resolve();
    }
    return closePromise;
  };
}

/**
 * Select an encoded playback backend without preparing or connecting it.
 *
 * Routing is content-first: every viable input is inspected through one exact
 * four-byte read. A verified native `fLaC` stream always uses bounded
 * streaming playback. A file that claims FLAC but fails that byte signature
 * is rejected instead of being silently handed to the AudioBuffer decoder.
 */
async function createOwnedEncodedFilePlaybackSource(
  options: CreateOwnedEncodedFilePlaybackSourceOptions,
  ordinaryBinding?: ExactOrdinaryBlobBinding,
): Promise<BlobFilePlaybackSourceResult> {
  // Snapshot this public-boundary property exactly once. Runtime callers can
  // supply accessors despite the TypeScript readonly contract; validation,
  // ownership, reads, and the returned identity must all use one object.
  const encodedSource = options.encodedSource;
  assertEncodedSource(encodedSource);
  const closeEncodedSource = closeEncodedSourceOnce(encodedSource);
  let createdSource: FilePlaybackSource | null = null;
  let releaseConstructionLease: (() => void) | null = null;
  let streamingOwnsEncodedSource = false;
  let completed = false;

  try {
    assertFactoryInput(options);
    throwIfAborted(options.signal);
    const factories: BlobFilePlaybackBackendFactories = {
      createAudioBufferSource:
        options.backendFactories?.createAudioBufferSource ??
        defaultBackendFactories.createAudioBufferSource,
      createStreamingFlacSource:
        options.backendFactories?.createStreamingFlacSource ??
        defaultBackendFactories.createStreamingFlacSource,
    };
    if (encodedSource.size < NATIVE_FLAC_MARKER.byteLength) {
      throw new EncodedSourceIntegrityError(
        'Audio source is too short to identify its container safely',
      );
    }

    const marker = await encodedSource.readAt(0, NATIVE_FLAC_MARKER.byteLength, options.signal);
    throwIfAborted(options.signal);

    if (hasMarker(marker, NATIVE_FLAC_MARKER)) {
      const metadata = await readFlacMetadata(encodedSource, options.signal);
      throwIfAborted(options.signal);
      const source = factories.createStreamingFlacSource({
        queueItemId: options.queueItemId,
        encodedSource,
        metadata,
        audioContext: options.audioContext,
        nowRoomTimeMs: options.nowRoomTimeMs,
        roomTimeMsToContextTime: options.roomTimeMsToContextTime,
        localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
        runtime: options.streamingRuntime,
      });
      createdSource = source;
      // A successful constructor return transfers exact encoded-source
      // ownership immediately. Every later assertion/abort failure tears down
      // that returned source; the factory must not close the source again.
      streamingOwnsEncodedSource = true;
      assertCreatedSource(source, 'streaming-flac', options.queueItemId);
      throwIfAborted(options.signal);
      completed = true;
      return Object.freeze({
        backend: 'streaming-flac',
        source,
        sourceIdentity: encodedSource.identity,
        releaseConstructionLease: releaseNoConstructionLease,
        flacMetadata: metadata,
      });
    }

    if (claimsFlac(encodedSource.metadata.name, encodedSource.metadata.mime)) {
      if (hasMarker(marker, OGG_MARKER)) {
        throw new UnsupportedFlacContainerError(
          'Ogg-FLAC is not supported by the streaming playback engine; native FLAC is required',
        );
      }
      throw new EncodedSourceIntegrityError(
        'File claims to be FLAC but does not contain the native fLaC marker',
      );
    }

    if (!ordinaryBinding) {
      throw new UnsupportedOrdinaryEncodedSourceError();
    }

    const decoded = (await ordinaryBinding.decodeOrdinaryAudio({
      blob: ordinaryBinding.blob,
      audioContext: options.audioContext,
      signal: options.signal,
      sourceIdentity: encodedSource.identity,
    })) as unknown;
    if (!decoded || typeof decoded !== 'object') {
      throw new TypeError('Ordinary audio decoder returned an invalid result');
    }
    const decoderRelease = (decoded as Partial<OrdinaryAudioDecodeResult>).release;
    if (typeof decoderRelease !== 'function') {
      throw new TypeError('Ordinary audio decoder returned an invalid release function');
    }
    releaseConstructionLease = oneShotRelease(decoderRelease);
    const audioBuffer = (decoded as Partial<OrdinaryAudioDecodeResult>).audioBuffer;
    assertDecodedAudioBuffer(audioBuffer);
    throwIfAborted(options.signal);
    const source = factories.createAudioBufferSource({
      queueItemId: options.queueItemId,
      audioBuffer,
      audioContext: options.audioContext,
      nowRoomTimeMs: options.nowRoomTimeMs,
      roomTimeMsToContextTime: options.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
    });
    createdSource = source;
    assertCreatedSource(source, 'audio-buffer', options.queueItemId);
    throwIfAborted(options.signal);
    completed = true;
    return Object.freeze({
      backend: 'audio-buffer',
      source,
      sourceIdentity: encodedSource.identity,
      audioBuffer,
      releaseConstructionLease,
      flacMetadata: null,
    });
  } finally {
    if (!completed) {
      await destroyWithoutMasking(createdSource);
      releaseWithoutMasking(releaseConstructionLease);
    }
    if (!streamingOwnsEncodedSource) await closeEncodedSource();
  }
}

export async function createEncodedFilePlaybackSource(
  options: CreateEncodedFilePlaybackSourceOptions,
): Promise<BlobFilePlaybackSourceResult> {
  return createOwnedEncodedFilePlaybackSource(options);
}

/** Local Blob adapter with an exact-by-construction ordinary decode binding. */
export async function createBlobFilePlaybackSource(
  options: CreateBlobFilePlaybackSourceOptions,
): Promise<BlobFilePlaybackSourceResult> {
  // Snapshot runtime-accessible fields once so the object inspected, wrapped,
  // identified, and decoded is exact-by-construction even for hostile getters.
  const blob = options.blob;
  const decodeOrdinaryAudio = options.decodeOrdinaryAudio;
  assertBlobFactoryInput(options, blob, decodeOrdinaryAudio);
  const encodedSource = new BlobEncodedAudioSource(blob);
  return createOwnedEncodedFilePlaybackSource(
    {
      encodedSource,
      queueItemId: options.queueItemId,
      audioContext: options.audioContext,
      nowRoomTimeMs: options.nowRoomTimeMs,
      roomTimeMsToContextTime: options.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
      signal: options.signal,
      streamingRuntime: options.streamingRuntime,
      backendFactories: options.backendFactories,
    },
    {
      blob,
      decodeOrdinaryAudio,
    },
  );
}
