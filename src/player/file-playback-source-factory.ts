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
import { BlobEncodedAudioSource } from './sources/blob-encoded-audio-source.ts';
import { EncodedSourceIntegrityError, throwIfAborted } from './sources/encoded-audio-source.ts';

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

export interface CreateBlobFilePlaybackSourceOptions {
  readonly blob: Blob;
  readonly queueItemId: QueueItemId;
  readonly audioContext: AudioContext;
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  /** Product-owned ordinary-codec decoder. It must honor the supplied signal. */
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly signal: AbortSignal;
  /** Runtime seam is forwarded only to the streaming backend; it is not started here. */
  readonly streamingRuntime?: Partial<StreamingFlacPlaybackRuntime>;
  /** Deterministic constructor seams for browser-boundary tests. */
  readonly backendFactories?: Partial<BlobFilePlaybackBackendFactories>;
}

interface BlobFilePlaybackSourceResultBase {
  /** Runtime identity of this exact Blob object, independent of filename and size. */
  readonly sourceIdentity: string;
  /**
   * Release the decoder's temporary construction lease after this source and
   * the exact decoded AudioBuffer have been published by one manager update.
   * The operation is idempotent. Streaming results expose a harmless no-op.
   */
  readonly releaseConstructionLease: () => void;
}

export interface AudioBufferFilePlaybackSourceResult extends BlobFilePlaybackSourceResultBase {
  readonly backend: 'audio-buffer';
  readonly source: AudioBufferSource;
  /** The exact object supplied to the AudioBuffer backend. */
  readonly audioBuffer: AudioBuffer;
  readonly flacMetadata: null;
}

export interface StreamingFlacFilePlaybackSourceResult extends BlobFilePlaybackSourceResultBase {
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

function assertFactoryInput(options: CreateBlobFilePlaybackSourceOptions): void {
  if (!(options.blob instanceof Blob)) throw new TypeError('Playback source requires a Blob');
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
  if (typeof options.decodeOrdinaryAudio !== 'function') {
    throw new TypeError('Ordinary audio decoder is required');
  }
  if (!(options.signal instanceof AbortSignal)) {
    throw new TypeError('Playback source AbortSignal is required');
  }
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

/**
 * Select a Blob-backed playback backend without preparing or connecting it.
 *
 * Routing is content-first: every viable input is inspected through one exact
 * four-byte read. A verified native `fLaC` stream always uses bounded
 * streaming playback. A file that claims FLAC but fails that byte signature
 * is rejected instead of being silently handed to the AudioBuffer decoder.
 */
export async function createBlobFilePlaybackSource(
  options: CreateBlobFilePlaybackSourceOptions,
): Promise<BlobFilePlaybackSourceResult> {
  assertFactoryInput(options);
  throwIfAborted(options.signal);

  const encodedSource = new BlobEncodedAudioSource(options.blob);
  const factories: BlobFilePlaybackBackendFactories = {
    createAudioBufferSource:
      options.backendFactories?.createAudioBufferSource ??
      defaultBackendFactories.createAudioBufferSource,
    createStreamingFlacSource:
      options.backendFactories?.createStreamingFlacSource ??
      defaultBackendFactories.createStreamingFlacSource,
  };
  let createdSource: FilePlaybackSource | null = null;
  let releaseConstructionLease: (() => void) | null = null;
  let completed = false;

  try {
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
        blob: options.blob,
        metadata,
        audioContext: options.audioContext,
        nowRoomTimeMs: options.nowRoomTimeMs,
        roomTimeMsToContextTime: options.roomTimeMsToContextTime,
        localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
        runtime: options.streamingRuntime,
      });
      createdSource = source;
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

    const decoded = (await options.decodeOrdinaryAudio({
      blob: options.blob,
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
    await encodedSource.close();
    if (!completed) {
      await destroyWithoutMasking(createdSource);
      releaseWithoutMasking(releaseConstructionLease);
    }
  }
}
