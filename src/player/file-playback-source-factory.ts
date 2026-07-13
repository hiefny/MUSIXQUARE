import type { QueueItemId } from '../types/index.ts';
import {
  AudioBufferPlaybackSource,
  type AudioBufferPlaybackSourceOptions,
} from './backends/audio-buffer-playback-source.ts';
import {
  StreamingFlacPlaybackSource,
  type StreamingFlacPlaybackSourceOptions,
} from './backends/streaming-flac-playback-source.ts';
import {
  StreamingLinearPcmPlaybackSource,
  type StreamingLinearPcmPlaybackSourceOptions,
} from './backends/streaming-linear-pcm-playback-source.ts';
import type { FilePlaybackSource } from './file-playback-source.ts';
import { readAiffPcmMetadata } from './aiff/metadata.ts';
import { readCafLinearPcmMetadata } from './caf/metadata.ts';
import { readFlacMetadata } from './flac/metadata.ts';
import type { LinearPcmMetadata } from './linear-pcm/sample-format.ts';
import { BlobEncodedAudioSource } from './sources/blob-encoded-audio-source.ts';
import {
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  EncodedSourceIntegrityError,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from './sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from './streaming/bounded-codec-runtime.ts';
import { readWavePcmMetadata } from './wave/metadata.ts';

const NATIVE_FLAC_MARKER = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
const OGG_MARKER = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const WAVE_MARKER = new Uint8Array([0x57, 0x41, 0x56, 0x45]);
const FORM_MARKER = new Uint8Array([0x46, 0x4f, 0x52, 0x4d]);
const AIFF_MARKER = new Uint8Array([0x41, 0x49, 0x46, 0x46]);
const AIFC_MARKER = new Uint8Array([0x41, 0x49, 0x46, 0x43]);
const CAF_MARKER = new Uint8Array([0x63, 0x61, 0x66, 0x66]);
const WAVE_FAMILY_MARKERS = Object.freeze([
  new Uint8Array([0x52, 0x49, 0x46, 0x46]),
  new Uint8Array([0x52, 0x46, 0x36, 0x34]),
  new Uint8Array([0x42, 0x57, 0x36, 0x34]),
  new Uint8Array([0x52, 0x49, 0x46, 0x58]),
] as const);
const CONTAINER_PROBE_BYTES = 12;
const MAX_IDENTIFIER_LENGTH = 256;
const ENCODED_SOURCE_KINDS = new Set(['blob', 'peer-range', 'r2-records'] as const);
const FILE_PLAYBACK_SOURCE_METHODS = Object.freeze([
  'prepare',
  'connect',
  'arm',
  'finalize',
  'cancel',
  'pause',
  'seek',
  'positionAt',
  'getSnapshot',
  'destroy',
] as const satisfies readonly (keyof FilePlaybackSource)[]);

type AudioBufferSource = FilePlaybackSource & { readonly backend: 'audio-buffer' };
type BoundedStreamSource = FilePlaybackSource & { readonly backend: 'bounded-stream' };

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
  ) => BoundedStreamSource;
  readonly createStreamingLinearPcmSource: (
    options: StreamingLinearPcmPlaybackSourceOptions,
  ) => BoundedStreamSource;
}

interface FilePlaybackSourceFactoryCommonOptions {
  readonly queueItemId: QueueItemId;
  readonly audioContext: AudioContext;
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly signal: AbortSignal;
  /** Decoder-specific Worker seams; neither runtime is started here. */
  readonly flacRuntime?: Partial<BoundedStreamingCodecRuntime>;
  readonly linearPcmRuntime?: Partial<BoundedStreamingCodecRuntime>;
}

export interface CreateBlobFilePlaybackSourceOptions extends FilePlaybackSourceFactoryCommonOptions {
  readonly blob: Blob;
  /**
   * Exact distributed identity already bound to this queue occurrence.
   * Omit only for process-local/demo playback where object identity is enough.
   */
  readonly sourceIdentity?: string;
  /** Canonical metadata retained by the room asset registry for a plain received Blob. */
  readonly sourceMetadata?: EncodedAudioSourceMetadata;
  /** Product-owned ordinary-codec decoder. It must honor the supplied signal. */
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  /** Deterministic constructor seams for browser-boundary tests. */
  readonly backendFactories?: Partial<BlobFilePlaybackBackendFactories>;
}

/**
 * Generic random-access routing used by LAN peer-range and R2 sources.
 *
 * This public path accepts every content-verified bounded container. Ordinary
 * browser decoding remains exclusive to createBlobFilePlaybackSource(), which
 * constructs the BlobEncodedAudioSource from the exact Blob it decodes.
 */
export interface CreateEncodedFilePlaybackSourceOptions extends FilePlaybackSourceFactoryCommonOptions {
  readonly encodedSource: EncodedAudioSource;
  readonly backendFactories?: Partial<
    Pick<
      BlobFilePlaybackBackendFactories,
      'createStreamingFlacSource' | 'createStreamingLinearPcmSource'
    >
  >;
}

interface ExactOrdinaryBlobBinding {
  readonly blob: Blob;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
}

const SOURCE_METADATA_KEYS = Object.freeze(['mime', 'name'] as const);
const MAX_SOURCE_NAME_LENGTH = 512;
const MAX_SOURCE_MIME_LENGTH = 128;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function canonicalSourceMetadata(value: unknown): Readonly<EncodedAudioSourceMetadata> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set<string>(SOURCE_METADATA_KEYS);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const name = descriptors.name;
    const mime = descriptors.mime;
    if (
      !name?.enumerable ||
      !Object.hasOwn(name, 'value') ||
      typeof name.value !== 'string' ||
      name.value.trim().length === 0 ||
      name.value.length > MAX_SOURCE_NAME_LENGTH ||
      containsControlCharacter(name.value) ||
      !mime?.enumerable ||
      !Object.hasOwn(mime, 'value') ||
      typeof mime.value !== 'string' ||
      mime.value.trim().length === 0 ||
      mime.value.length > MAX_SOURCE_MIME_LENGTH ||
      mime.value !== mime.value.trim() ||
      containsControlCharacter(mime.value)
    ) {
      return null;
    }
    return Object.freeze(
      Object.assign(Object.create(null), {
        name: name.value,
        mime: mime.value,
      }),
    ) as Readonly<EncodedAudioSourceMetadata>;
  } catch {
    return null;
  }
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
}

export interface BoundedStreamFilePlaybackSourceResult extends FilePlaybackSourceResultBase {
  readonly backend: 'bounded-stream';
  readonly source: BoundedStreamSource;
}

export type BlobFilePlaybackSourceResult =
  | AudioBufferFilePlaybackSourceResult
  | BoundedStreamFilePlaybackSourceResult;

/** A claimed FLAC whose bytes use a container the streaming engine cannot decode. */
export class UnsupportedFlacContainerError extends EncodedSourceIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFlacContainerError';
  }
}

export class UnsupportedOrdinaryEncodedSourceError extends EncodedSourceIntegrityError {
  constructor() {
    super('This encoded source does not contain a supported bounded-stream container');
    this.name = 'UnsupportedOrdinaryEncodedSourceError';
  }
}

const defaultBackendFactories: BlobFilePlaybackBackendFactories = {
  createAudioBufferSource: (options) => new AudioBufferPlaybackSource(options),
  createStreamingFlacSource: (options) => new StreamingFlacPlaybackSource(options),
  createStreamingLinearPcmSource: (options) => new StreamingLinearPcmPlaybackSource(options),
};

function hasMarker(bytes: Uint8Array, marker: Uint8Array): boolean {
  return marker.every((byte, index) => bytes[index] === byte);
}

function mimeEssence(mime: string): string {
  const separator = mime.indexOf(';');
  return (separator < 0 ? mime : mime.slice(0, separator)).trim().toLowerCase();
}

function claimsFlac(name: string, mime: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedMime = mimeEssence(mime);
  return normalizedName.endsWith('.flac') || normalizedMime.includes('flac');
}

function claimsWave(name: string, mime: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedMime = mimeEssence(mime);
  return (
    normalizedName.endsWith('.wav') ||
    normalizedName.endsWith('.wave') ||
    normalizedMime === 'audio/wav' ||
    normalizedMime === 'audio/wave' ||
    normalizedMime === 'audio/x-wav' ||
    normalizedMime === 'audio/vnd.wave'
  );
}

function claimsAiff(name: string, mime: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedMime = mimeEssence(mime);
  return (
    normalizedName.endsWith('.aif') ||
    normalizedName.endsWith('.aiff') ||
    normalizedName.endsWith('.aifc') ||
    normalizedMime === 'audio/aiff' ||
    normalizedMime === 'audio/x-aiff' ||
    normalizedMime === 'audio/aifc' ||
    normalizedMime === 'audio/x-aifc'
  );
}

function claimsCaf(name: string, mime: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedMime = mimeEssence(mime);
  return (
    normalizedName.endsWith('.caf') ||
    normalizedMime === 'audio/caf' ||
    normalizedMime === 'audio/x-caf'
  );
}

function isWaveFamily(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= CONTAINER_PROBE_BYTES &&
    WAVE_FAMILY_MARKERS.some((marker) => hasMarker(bytes, marker)) &&
    WAVE_MARKER.every((byte, index) => bytes[index + 8] === byte)
  );
}

function isAiffFamily(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= CONTAINER_PROBE_BYTES &&
    hasMarker(bytes, FORM_MARKER) &&
    (AIFF_MARKER.every((byte, index) => bytes[index + 8] === byte) ||
      AIFC_MARKER.every((byte, index) => bytes[index + 8] === byte))
  );
}

function isCafFamily(bytes: Uint8Array): boolean {
  return hasMarker(bytes, CAF_MARKER);
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
  sourceIdentity: string | undefined,
  sourceMetadata: Readonly<EncodedAudioSourceMetadata> | undefined,
): void {
  assertFactoryInput(options);
  if (!(blob instanceof Blob)) throw new TypeError('Playback source requires a Blob');
  if (
    sourceIdentity !== undefined &&
    (!isEncodedAudioSourceIdentity(sourceIdentity) || sourceIdentity.trim() !== sourceIdentity)
  ) {
    throw new TypeError('Playback source identity is invalid');
  }
  if (sourceMetadata !== undefined && canonicalSourceMetadata(sourceMetadata) === null) {
    throw new TypeError('Playback source metadata is invalid');
  }
  if (typeof decodeOrdinaryAudio !== 'function') {
    throw new TypeError('Ordinary audio decoder is required');
  }
}

/**
 * Snapshot one public EncodedAudioSource boundary into a stable delegating
 * lease. The original object remains the exact byte/resource owner, while
 * parsers, decoders, and the returned result all observe the same immutable
 * identity, size, and metadata even when a caller supplied accessors.
 */
function snapshotEncodedSource(value: EncodedAudioSource): EncodedAudioSource {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('Playback encoded source is invalid');
  }

  let kind: unknown;
  let size: unknown;
  let identity: unknown;
  let rawMetadata: unknown;
  let readAt: unknown;
  let close: unknown;
  try {
    kind = value.kind;
    size = value.size;
    identity = value.identity;
    rawMetadata = value.metadata;
    readAt = value.readAt;
    close = value.close;
  } catch (error) {
    throw new TypeError('Playback encoded source is invalid', { cause: error });
  }

  const metadata = canonicalSourceMetadata(rawMetadata);
  if (
    typeof kind !== 'string' ||
    !ENCODED_SOURCE_KINDS.has(kind as EncodedAudioSource['kind']) ||
    !isEncodedAudioSourceIdentity(identity) ||
    identity.trim() !== identity ||
    metadata === null ||
    typeof readAt !== 'function' ||
    typeof close !== 'function'
  ) {
    throw new TypeError('Playback encoded source is invalid');
  }
  validateExactRead(size as number, 0, 0);

  const owner = value;
  const stableReadAt = readAt as EncodedAudioSource['readAt'];
  const stableClose = close as EncodedAudioSource['close'];
  let closePromise: Promise<void> | null = null;
  const source: EncodedAudioSource = Object.assign(Object.create(null), {
    kind: kind as EncodedAudioSource['kind'],
    size: size as number,
    identity,
    metadata,
    readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
      return Reflect.apply(stableReadAt, owner, [offset, length, signal]) as Promise<Uint8Array>;
    },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      try {
        closePromise = Promise.resolve(Reflect.apply(stableClose, owner, []));
      } catch (error) {
        closePromise = Promise.reject(error);
      }
      return closePromise;
    },
  });
  return Object.freeze(source);
}

interface CreatedSourceInspection {
  readonly source: FilePlaybackSource;
  readonly backend: unknown;
  readonly queueItemId: unknown;
  readonly destroy: () => Promise<void>;
}

function inspectCreatedSource(value: unknown): CreatedSourceInspection {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('Playback backend factory returned an invalid source');
  }
  const source = value as FilePlaybackSource;
  let backend: unknown;
  let queueItemId: unknown;
  const methods = new Map<keyof FilePlaybackSource, (...args: never[]) => unknown>();
  try {
    backend = source.backend;
    queueItemId = source.queueItemId;
    for (const key of FILE_PLAYBACK_SOURCE_METHODS) {
      const method = source[key];
      if (typeof method !== 'function') {
        throw new TypeError('Playback backend factory returned an invalid source');
      }
      methods.set(key, method as (...args: never[]) => unknown);
    }
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === 'Playback backend factory returned an invalid source'
    ) {
      throw error;
    }
    throw new TypeError('Playback backend factory returned an invalid source', { cause: error });
  }
  const destroy = methods.get('destroy');
  if (!destroy) throw new TypeError('Playback backend factory returned an invalid source');
  return Object.freeze({
    source,
    backend,
    queueItemId,
    destroy: async () => {
      await Reflect.apply(destroy, source, []);
    },
  });
}

function assertCreatedSource(
  inspected: CreatedSourceInspection,
  backend: BlobFilePlaybackSourceResult['backend'],
  queueItemId: QueueItemId,
): void {
  if (inspected.backend !== backend || inspected.queueItemId !== queueItemId) {
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

async function destroyWithoutMasking(destroy: (() => Promise<void>) | null): Promise<void> {
  if (!destroy) return;
  try {
    await destroy();
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
 * Routing is content-first: every viable input is inspected through one
 * bounded header read. Verified native `fLaC`, WAVE, AIFF/AIFC, and CAF LPCM
 * streams always use bounded playback. Claimed formats that fail content
 * verification are never handed to the AudioBuffer decoder.
 */
async function createOwnedEncodedFilePlaybackSource(
  options: CreateOwnedEncodedFilePlaybackSourceOptions,
  ordinaryBinding?: ExactOrdinaryBlobBinding,
): Promise<BlobFilePlaybackSourceResult> {
  // Snapshot this public-boundary property exactly once. Runtime callers can
  // supply accessors despite the TypeScript readonly contract; validation,
  // ownership, reads, and the returned identity must all use one object.
  const encodedSource = snapshotEncodedSource(options.encodedSource);
  const closeEncodedSource = closeEncodedSourceOnce(encodedSource);
  let destroyCreatedSource: (() => Promise<void>) | null = null;
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
      createStreamingLinearPcmSource:
        options.backendFactories?.createStreamingLinearPcmSource ??
        defaultBackendFactories.createStreamingLinearPcmSource,
    };
    if (encodedSource.size < NATIVE_FLAC_MARKER.byteLength) {
      throw new EncodedSourceIntegrityError(
        'Audio source is too short to identify its container safely',
      );
    }

    const probeBytes = Math.min(encodedSource.size, CONTAINER_PROBE_BYTES);
    const marker = await encodedSource.readAt(0, probeBytes, options.signal);
    if (!(marker instanceof Uint8Array) || marker.byteLength !== probeBytes) {
      throw new EncodedSourceIntegrityError('Audio source returned an inexact container probe');
    }
    throwIfAborted(options.signal);

    if (hasMarker(marker, NATIVE_FLAC_MARKER)) {
      const metadata = await readFlacMetadata(encodedSource, options.signal);
      throwIfAborted(options.signal);
      const returnedSource = factories.createStreamingFlacSource({
        queueItemId: options.queueItemId,
        encodedSource,
        metadata,
        audioContext: options.audioContext,
        nowRoomTimeMs: options.nowRoomTimeMs,
        roomTimeMsToContextTime: options.roomTimeMsToContextTime,
        localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
        runtime: options.flacRuntime,
      });
      const inspected = inspectCreatedSource(returnedSource);
      destroyCreatedSource = inspected.destroy;
      // A successful constructor return transfers exact encoded-source
      // ownership immediately. Every later assertion/abort failure tears down
      // that returned source; the factory must not close the source again.
      streamingOwnsEncodedSource = true;
      assertCreatedSource(inspected, 'bounded-stream', options.queueItemId);
      throwIfAborted(options.signal);
      const result = Object.freeze({
        backend: 'bounded-stream' as const,
        source: inspected.source as BoundedStreamSource,
        sourceIdentity: encodedSource.identity,
        releaseConstructionLease: releaseNoConstructionLease,
      });
      completed = true;
      return result;
    }

    let linearPcmMetadata: Readonly<LinearPcmMetadata> | null = null;
    if (isWaveFamily(marker)) {
      linearPcmMetadata = await readWavePcmMetadata(encodedSource, options.signal);
    } else if (isAiffFamily(marker)) {
      linearPcmMetadata = await readAiffPcmMetadata(encodedSource, options.signal);
    } else if (isCafFamily(marker)) {
      linearPcmMetadata = await readCafLinearPcmMetadata(encodedSource, options.signal);
    }

    if (linearPcmMetadata !== null) {
      throwIfAborted(options.signal);
      const returnedSource = factories.createStreamingLinearPcmSource({
        queueItemId: options.queueItemId,
        encodedSource,
        metadata: linearPcmMetadata,
        audioContext: options.audioContext,
        nowRoomTimeMs: options.nowRoomTimeMs,
        roomTimeMsToContextTime: options.roomTimeMsToContextTime,
        localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
        runtime: options.linearPcmRuntime,
      });
      const inspected = inspectCreatedSource(returnedSource);
      destroyCreatedSource = inspected.destroy;
      streamingOwnsEncodedSource = true;
      assertCreatedSource(inspected, 'bounded-stream', options.queueItemId);
      throwIfAborted(options.signal);
      const result = Object.freeze({
        backend: 'bounded-stream' as const,
        source: inspected.source as BoundedStreamSource,
        sourceIdentity: encodedSource.identity,
        releaseConstructionLease: releaseNoConstructionLease,
      });
      completed = true;
      return result;
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

    if (claimsWave(encodedSource.metadata.name, encodedSource.metadata.mime)) {
      throw new EncodedSourceIntegrityError(
        'File claims to be WAVE but does not contain a supported RIFF/RF64/BW64 WAVE header',
      );
    }

    if (claimsAiff(encodedSource.metadata.name, encodedSource.metadata.mime)) {
      throw new EncodedSourceIntegrityError(
        'File claims to be AIFF/AIFC but does not contain a supported FORM AIFF/AIFC header',
      );
    }

    if (claimsCaf(encodedSource.metadata.name, encodedSource.metadata.mime)) {
      throw new EncodedSourceIntegrityError(
        'File claims to be CAF but does not contain a supported caff header',
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
    const returnedSource = factories.createAudioBufferSource({
      queueItemId: options.queueItemId,
      audioBuffer,
      audioContext: options.audioContext,
      nowRoomTimeMs: options.nowRoomTimeMs,
      roomTimeMsToContextTime: options.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
    });
    const inspected = inspectCreatedSource(returnedSource);
    destroyCreatedSource = inspected.destroy;
    assertCreatedSource(inspected, 'audio-buffer', options.queueItemId);
    throwIfAborted(options.signal);
    const result = Object.freeze({
      backend: 'audio-buffer' as const,
      source: inspected.source as AudioBufferSource,
      sourceIdentity: encodedSource.identity,
      audioBuffer,
      releaseConstructionLease,
    });
    completed = true;
    return result;
  } finally {
    if (!completed) {
      await destroyWithoutMasking(destroyCreatedSource);
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
  const sourceIdentity = options.sourceIdentity;
  const rawSourceMetadata = options.sourceMetadata;
  const sourceMetadata =
    rawSourceMetadata === undefined ? undefined : canonicalSourceMetadata(rawSourceMetadata);
  if (rawSourceMetadata !== undefined && sourceMetadata === null) {
    throw new TypeError('Playback source metadata is invalid');
  }
  assertBlobFactoryInput(
    options,
    blob,
    decodeOrdinaryAudio,
    sourceIdentity,
    sourceMetadata ?? undefined,
  );
  const encodedSource = new BlobEncodedAudioSource(blob, {
    identity: sourceIdentity,
    metadata: sourceMetadata ?? undefined,
  });
  return createOwnedEncodedFilePlaybackSource(
    {
      encodedSource,
      queueItemId: options.queueItemId,
      audioContext: options.audioContext,
      nowRoomTimeMs: options.nowRoomTimeMs,
      roomTimeMsToContextTime: options.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
      signal: options.signal,
      flacRuntime: options.flacRuntime,
      linearPcmRuntime: options.linearPcmRuntime,
      backendFactories: options.backendFactories,
    },
    {
      blob,
      decodeOrdinaryAudio,
    },
  );
}
