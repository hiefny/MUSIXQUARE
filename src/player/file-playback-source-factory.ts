import type { QueueItemId } from '../types/index.ts';
import {
  AudioBufferPlaybackSource,
  type AudioBufferPlaybackSourceOptions,
} from './backends/audio-buffer-playback-source.ts';
import {
  createDefaultAacStreamingWorker,
  StreamingAacPlaybackSource,
  type StreamingAacPlaybackSourceOptions,
} from './backends/streaming-aac-playback-source.ts';
import {
  StreamingFlacPlaybackSource,
  type StreamingFlacPlaybackSourceOptions,
} from './backends/streaming-flac-playback-source.ts';
import {
  StreamingLinearPcmPlaybackSource,
  type StreamingLinearPcmPlaybackSourceOptions,
} from './backends/streaming-linear-pcm-playback-source.ts';
import {
  StreamingM4aAacPlaybackSource,
  type StreamingM4aAacPlaybackSourceOptions,
} from './backends/streaming-m4a-aac-playback-source.ts';
import {
  StreamingMp3PlaybackSource,
  type StreamingMp3PlaybackSourceOptions,
} from './backends/streaming-mp3-playback-source.ts';
import type { FilePlaybackSource } from './file-playback-source.ts';
import {
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import { AdtsHeaderError, parseAdtsHeader } from './aac/adts-header.ts';
import { scanAdtsFrames, type AdtsFrameScanResult } from './aac/frame-scanner.ts';
import {
  ADTS_MAX_FRAME_BYTES,
  AdtsIncrementalFrameReader,
  type AdtsCoreConfiguration,
} from './aac/incremental-frame-reader.ts';
import {
  probeAacWebCodecsAdtsFrameInWorker,
  type AacWorkerCapabilityProbeRuntime,
} from './aac/worker-capability-probe.ts';
import { readAiffPcmMetadata } from './aiff/metadata.ts';
import { readCafLinearPcmMetadata } from './caf/metadata.ts';
import { readFlacMetadata } from './flac/metadata.ts';
import type { LinearPcmMetadata } from './linear-pcm/sample-format.ts';
import { readM4aAacLcMetadata } from './m4a/metadata.ts';
import { MpegLayer3FrameHeaderError, parseMpegLayer3FrameHeader } from './mp3/frame-header.ts';
import { readLeadingId3v2Boundaries } from './mp3/id3.ts';
import { readMp3Metadata, type Mp3Metadata } from './mp3/metadata.ts';
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
import {
  createCodecTimelineHostArtifact,
  type CodecTimelineHostArtifact,
  type CodecTimelineHostArtifactBinding,
} from './manifests/codec-timeline-host-artifact.ts';
import { isMp3MetadataTimelineManifestEligible } from './manifests/codec-timeline-manifest-seal.ts';

const NATIVE_FLAC_MARKER = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
const OGG_MARKER = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const WAVE_MARKER = new Uint8Array([0x57, 0x41, 0x56, 0x45]);
const FORM_MARKER = new Uint8Array([0x46, 0x4f, 0x52, 0x4d]);
const AIFF_MARKER = new Uint8Array([0x41, 0x49, 0x46, 0x46]);
const AIFC_MARKER = new Uint8Array([0x41, 0x49, 0x46, 0x43]);
const CAF_MARKER = new Uint8Array([0x63, 0x61, 0x66, 0x66]);
const ID3_MARKER = new Uint8Array([0x49, 0x44, 0x33]);
const ISO_BMFF_FILE_TYPE_MARKER = new Uint8Array([0x66, 0x74, 0x79, 0x70]);
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
  readonly createStreamingAacSource: (
    options: StreamingAacPlaybackSourceOptions,
  ) => BoundedStreamSource;
  readonly createStreamingLinearPcmSource: (
    options: StreamingLinearPcmPlaybackSourceOptions,
  ) => BoundedStreamSource;
  readonly createStreamingMp3Source: (
    options: StreamingMp3PlaybackSourceOptions,
  ) => BoundedStreamSource;
  readonly createStreamingM4aAacSource: (
    options: StreamingM4aAacPlaybackSourceOptions,
  ) => BoundedStreamSource;
}

type AacFilePlaybackCapabilityProbe = (
  frame: Uint8Array,
  signal: AbortSignal,
  runtime: AacWorkerCapabilityProbeRuntime,
) => Promise<void>;

interface FilePlaybackSourceFactoryCommonOptions {
  readonly queueItemId: QueueItemId;
  readonly audioContext: AudioContext;
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly signal: AbortSignal;
  /** Decoder-specific Worker seams. Raw AAC may start one admission-only Worker here. */
  readonly flacRuntime?: Partial<BoundedStreamingCodecRuntime>;
  readonly linearPcmRuntime?: Partial<BoundedStreamingCodecRuntime>;
  readonly mp3Runtime?: Partial<BoundedStreamingCodecRuntime>;
  readonly aacRuntime?: Partial<BoundedStreamingCodecRuntime>;
  /** Test seam; production defaults to the same fresh Worker module used by playback. */
  readonly aacCapabilityProbe?: AacFilePlaybackCapabilityProbe;
  readonly m4aRuntime?: Partial<BoundedStreamingCodecRuntime>;
  /** MP3/raw AAC/M4A remain ordinary AudioBuffer routes unless explicitly opted in. */
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  /**
   * Exact host registry binding for an optional reusable codec timeline.
   * Omit on guest, ordinary, and feature-gated-off construction paths.
   */
  readonly codecTimelineHostArtifactBinding?: CodecTimelineHostArtifactBinding;
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
      | 'createStreamingFlacSource'
      | 'createStreamingAacSource'
      | 'createStreamingLinearPcmSource'
      | 'createStreamingMp3Source'
      | 'createStreamingM4aAacSource'
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

const CODEC_TIMELINE_HOST_ARTIFACT_BINDING_KEYS = Object.freeze([
  'queueItemId',
  'sourceIdentity',
  'transferSessionId',
  'encodedSize',
  'name',
  'mime',
] as const);
const CODEC_TIMELINE_HOST_ARTIFACTS = new WeakMap<
  object,
  Readonly<CodecTimelineHostArtifact> | null
>();

/**
 * Read the opaque host timeline authority attached to one authentic factory
 * result. Structural copies and caller-created lookalikes deliberately return
 * null, and the result's public enumerable shape remains unchanged.
 */
export function codecTimelineHostArtifactForFilePlaybackSourceResult(
  value: unknown,
): Readonly<CodecTimelineHostArtifact> | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  return CODEC_TIMELINE_HOST_ARTIFACTS.get(value) ?? null;
}

function issueFilePlaybackSourceResult<T extends BlobFilePlaybackSourceResult>(
  result: T,
  artifact: Readonly<CodecTimelineHostArtifact> | null,
): T {
  CODEC_TIMELINE_HOST_ARTIFACTS.set(result, artifact);
  return result;
}

function snapshotOptionalCodecTimelineHostArtifactBinding(
  value: unknown,
): Readonly<CodecTimelineHostArtifactBinding> | undefined {
  if (value === undefined) return undefined;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Codec timeline host artifact binding must be an exact data record');
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Codec timeline host artifact binding must have a plain prototype');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set<string>(CODEC_TIMELINE_HOST_ARTIFACT_BINDING_KEYS);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      throw new TypeError('Codec timeline host artifact binding fields are not exact');
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of CODEC_TIMELINE_HOST_ARTIFACT_BINDING_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`Codec timeline host artifact binding field ${key} must be data`);
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot) as Readonly<CodecTimelineHostArtifactBinding>;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Codec timeline host artifact binding could not be inspected', {
      cause: error,
    });
  }
}

async function createOptionalCodecTimelineHostArtifact(
  binding: Readonly<CodecTimelineHostArtifactBinding> | undefined,
  queueItemId: QueueItemId,
  source: EncodedAudioSource,
  timeline: Readonly<AdtsFrameScanResult> | Readonly<Mp3Metadata>,
  signal: AbortSignal,
): Promise<Readonly<CodecTimelineHostArtifact> | null> {
  if (binding === undefined) return null;
  if (binding.queueItemId !== queueItemId) {
    throw new TypeError('Codec timeline host artifact binding queue item does not match playback');
  }
  return createCodecTimelineHostArtifact({ binding, source, timeline, signal });
}

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
  createStreamingAacSource: (options) => new StreamingAacPlaybackSource(options),
  createStreamingLinearPcmSource: (options) => new StreamingLinearPcmPlaybackSource(options),
  createStreamingMp3Source: (options) => new StreamingMp3PlaybackSource(options),
  createStreamingM4aAacSource: (options) => new StreamingM4aAacPlaybackSource(options),
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

function claimsMp3(name: string, mime: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedMime = mimeEssence(mime);
  return (
    normalizedName.endsWith('.mp3') ||
    normalizedMime === 'audio/mpeg' ||
    normalizedMime === 'audio/mp3' ||
    normalizedMime === 'audio/x-mp3'
  );
}

function claimsRawAac(name: string, mime: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedMime = mimeEssence(mime);
  return (
    normalizedName.endsWith('.aac') ||
    normalizedName.endsWith('.adts') ||
    normalizedMime === 'audio/aac' ||
    normalizedMime === 'audio/x-aac' ||
    normalizedMime === 'audio/adts'
  );
}

function claimsM4a(name: string, mime: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  const normalizedMime = mimeEssence(mime);
  return (
    normalizedName.endsWith('.m4a') ||
    normalizedMime === 'audio/mp4' ||
    normalizedMime === 'audio/x-m4a' ||
    normalizedMime === 'audio/m4a'
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

function isIsoBmffFileType(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= CONTAINER_PROBE_BYTES &&
    ISO_BMFF_FILE_TYPE_MARKER.every((byte, index) => bytes[index + 4] === byte)
  );
}

function isRawMp3FrameStart(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  try {
    parseMpegLayer3FrameHeader(bytes.subarray(0, 4));
    return true;
  } catch (error) {
    if (error instanceof MpegLayer3FrameHeaderError) return false;
    throw error;
  }
}

function isRawAdtsFrameStart(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 7) return false;
  const headerBytes = (bytes[1]! & 1) === 1 ? 7 : 9;
  if (bytes.byteLength < headerBytes) return false;
  try {
    parseAdtsHeader(bytes.subarray(0, headerBytes));
    return true;
  } catch (error) {
    if (
      error instanceof AdtsHeaderError ||
      error instanceof RangeError ||
      error instanceof TypeError
    ) {
      return false;
    }
    throw error;
  }
}

interface OptionalFrameContentClassification {
  readonly audioStartByte: number;
  readonly adts: boolean;
  readonly mp3: boolean;
}

async function classifyOptionalFrameContent(
  source: EncodedAudioSource,
  initialBytes: Uint8Array,
  signal: AbortSignal,
  inspectLeadingId3: boolean,
): Promise<Readonly<OptionalFrameContentClassification>> {
  const initialAdts = isRawAdtsFrameStart(initialBytes);
  const initialMp3 = isRawMp3FrameStart(initialBytes);
  if (initialAdts || initialMp3 || !inspectLeadingId3 || !hasMarker(initialBytes, ID3_MARKER)) {
    return Object.freeze({ audioStartByte: 0, adts: initialAdts, mp3: initialMp3 });
  }

  // The trusted ID3 reader validates v2.2/v2.3/v2.4 header geometry, the
  // eight-tag bound, syncsafe sizes, and v2.4 footer mirrors without touching
  // a tag body. Codec authority comes only from the exact post-tag bytes.
  const leading = await readLeadingId3v2Boundaries(source, signal);
  const available = source.size - leading.dataStart;
  const probeLength = Math.min(9, available);
  if (probeLength < 4) {
    return Object.freeze({ audioStartByte: leading.dataStart, adts: false, mp3: false });
  }
  validateExactRead(source.size, leading.dataStart, probeLength);
  const header = await source.readAt(leading.dataStart, probeLength, signal);
  throwIfAborted(signal);
  if (!(header instanceof Uint8Array) || header.byteLength !== probeLength) {
    throw new EncodedSourceIntegrityError(
      'Post-ID3 audio classifier returned an inexact frame-header probe',
    );
  }
  return Object.freeze({
    audioStartByte: leading.dataStart,
    adts: isRawAdtsFrameStart(header),
    mp3: isRawMp3FrameStart(header),
  });
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

function snapshotAacCapabilityProbe(value: unknown): AacFilePlaybackCapabilityProbe {
  if (value === undefined) return probeAacWebCodecsAdtsFrameInWorker;
  if (typeof value !== 'function') {
    throw new TypeError('AAC capability probe must be a function');
  }
  return value as AacFilePlaybackCapabilityProbe;
}

interface AacRouteRuntimeSnapshot {
  readonly capabilityRuntime: Readonly<AacWorkerCapabilityProbeRuntime>;
  readonly playbackRuntime: Readonly<Partial<BoundedStreamingCodecRuntime>>;
}

function snapshotOptionalAacRuntimeMethod<K extends keyof BoundedStreamingCodecRuntime>(
  runtime: Partial<BoundedStreamingCodecRuntime> | undefined,
  key: K,
): BoundedStreamingCodecRuntime[K] | undefined {
  let method: unknown;
  try {
    method = runtime?.[key];
  } catch (cause) {
    throw new TypeError(`AAC ${String(key)} runtime could not be inspected`, { cause });
  }
  if (method === undefined) return undefined;
  if (typeof method !== 'function') {
    throw new TypeError(`AAC ${String(key)} runtime is invalid`);
  }
  const authority = runtime;
  return ((...args: unknown[]) =>
    Reflect.apply(method, authority, args)) as BoundedStreamingCodecRuntime[K];
}

/**
 * Capture every optional AAC browser seam once. In particular, the one-shot
 * canary and all later decoder generations receive the exact same bound
 * createWorker authority even when a caller supplied a getter or mutates the
 * original runtime after admission begins.
 */
function snapshotAacRouteRuntime(
  runtime: Partial<BoundedStreamingCodecRuntime> | undefined,
): Readonly<AacRouteRuntimeSnapshot> {
  const createWorker =
    snapshotOptionalAacRuntimeMethod(runtime, 'createWorker') ?? createDefaultAacStreamingWorker;
  const loadWorklet = snapshotOptionalAacRuntimeMethod(runtime, 'loadWorklet');
  const createWorkletNode = snapshotOptionalAacRuntimeMethod(runtime, 'createWorkletNode');
  const createMessageChannel = snapshotOptionalAacRuntimeMethod(runtime, 'createMessageChannel');
  const playbackRuntime = Object.freeze({
    createWorker,
    ...(loadWorklet ? { loadWorklet } : {}),
    ...(createWorkletNode ? { createWorkletNode } : {}),
    ...(createMessageChannel ? { createMessageChannel } : {}),
  });
  return Object.freeze({
    capabilityRuntime: playbackRuntime,
    playbackRuntime,
  });
}

interface RawAacCapabilityEvidence {
  readonly coreConfiguration: Readonly<AdtsCoreConfiguration>;
}

async function preflightRawAacCapability(
  source: EncodedAudioSource,
  audioStartByte: number,
  signal: AbortSignal,
  probe: AacFilePlaybackCapabilityProbe,
  runtime: Readonly<AacWorkerCapabilityProbeRuntime>,
): Promise<Readonly<RawAacCapabilityEvidence>> {
  const reader = new AdtsIncrementalFrameReader({
    source,
    audioStartByte,
    pageBytes: ADTS_MAX_FRAME_BYTES,
  });
  const frame = await reader.readNext(signal);
  if (!frame) {
    throw new EncodedSourceIntegrityError(
      'Raw AAC source does not contain a complete first ADTS frame',
    );
  }
  const header = frame.descriptor.header;
  const coreConfiguration: Readonly<AdtsCoreConfiguration> = Object.freeze({
    mpegId: 0,
    profile: 1,
    coreAudioObjectType: 2,
    sampleRateIndex: header.sampleRateIndex,
    channelConfiguration: header.channelConfiguration as 1 | 2,
    protectionAbsent: true,
    rawDataBlocks: 1,
  });
  try {
    await probe(frame.bytes, signal, runtime);
    throwIfAborted(signal);
    return Object.freeze({ coreConfiguration });
  } finally {
    try {
      frame.bytes.fill(0);
    } catch {
      // The reader-issued frame is bounded and becomes unreachable here.
    }
  }
}

function sameAacCoreConfiguration(
  left: Readonly<AdtsCoreConfiguration>,
  right: Readonly<AdtsCoreConfiguration>,
): boolean {
  return (
    left.mpegId === right.mpegId &&
    left.profile === right.profile &&
    left.coreAudioObjectType === right.coreAudioObjectType &&
    left.sampleRateIndex === right.sampleRateIndex &&
    left.channelConfiguration === right.channelConfiguration &&
    left.protectionAbsent === right.protectionAbsent &&
    left.rawDataBlocks === right.rawDataBlocks
  );
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
    const codecTimelineHostArtifactBinding = snapshotOptionalCodecTimelineHostArtifactBinding(
      options.codecTimelineHostArtifactBinding,
    );
    assertFactoryInput(options);
    throwIfAborted(options.signal);
    const boundedRoutePolicy = snapshotFilePlaybackBoundedRoutePolicy(options.boundedRoutePolicy);
    const factories: BlobFilePlaybackBackendFactories = {
      createAudioBufferSource:
        options.backendFactories?.createAudioBufferSource ??
        defaultBackendFactories.createAudioBufferSource,
      createStreamingFlacSource:
        options.backendFactories?.createStreamingFlacSource ??
        defaultBackendFactories.createStreamingFlacSource,
      createStreamingAacSource:
        options.backendFactories?.createStreamingAacSource ??
        defaultBackendFactories.createStreamingAacSource,
      createStreamingLinearPcmSource:
        options.backendFactories?.createStreamingLinearPcmSource ??
        defaultBackendFactories.createStreamingLinearPcmSource,
      createStreamingMp3Source:
        options.backendFactories?.createStreamingMp3Source ??
        defaultBackendFactories.createStreamingMp3Source,
      createStreamingM4aAacSource:
        options.backendFactories?.createStreamingM4aAacSource ??
        defaultBackendFactories.createStreamingM4aAacSource,
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
      return issueFilePlaybackSourceResult(result, null);
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
      return issueFilePlaybackSourceResult(result, null);
    }

    const universalRoute = boundedRoutePolicy.mode === 'universal-v1';
    const formatGatedRoute = boundedRoutePolicy.mode === 'format-gated-v1';
    const mp3RouteEnabled =
      universalRoute || (formatGatedRoute && boundedRoutePolicy.mp3 === 'bounded-stream');
    const m4aBackendId = universalRoute
      ? boundedRoutePolicy.m4aBackendId
      : formatGatedRoute && boundedRoutePolicy.m4aAacLc === 'webcodecs'
        ? boundedRoutePolicy.m4aAacLc
        : null;
    const rawAdtsAacBackendId = universalRoute
      ? boundedRoutePolicy.aacBackendId
      : formatGatedRoute && boundedRoutePolicy.rawAdtsAac === 'webcodecs'
        ? boundedRoutePolicy.rawAdtsAac
        : null;
    // Content authority remains independent from activation. For example, an
    // ADTS stream cannot enter an enabled MP3 route merely because raw AAC is
    // disabled and its filename claims MP3.
    const frameContent = await classifyOptionalFrameContent(
      encodedSource,
      marker,
      options.signal,
      mp3RouteEnabled || rawAdtsAacBackendId !== null,
    );
    const aacContentCandidate = frameContent.adts;
    const m4aContentCandidate = isIsoBmffFileType(marker);
    const mp3ContentCandidate = frameContent.mp3;
    const aacClaim =
      rawAdtsAacBackendId !== null &&
      claimsRawAac(encodedSource.metadata.name, encodedSource.metadata.mime);
    const m4aClaim =
      m4aBackendId !== null && claimsM4a(encodedSource.metadata.name, encodedSource.metadata.mime);
    const mp3Claim =
      mp3RouteEnabled && claimsMp3(encodedSource.metadata.name, encodedSource.metadata.mime);

    if (
      rawAdtsAacBackendId !== null &&
      (aacContentCandidate ||
        (!m4aContentCandidate &&
          !mp3ContentCandidate &&
          aacClaim &&
          !hasMarker(marker, ID3_MARKER)))
    ) {
      const aacCapabilityProbe = snapshotAacCapabilityProbe(options.aacCapabilityProbe);
      const aacRouteRuntime = snapshotAacRouteRuntime(options.aacRuntime);
      const capabilityEvidence = await preflightRawAacCapability(
        encodedSource,
        frameContent.audioStartByte,
        options.signal,
        aacCapabilityProbe,
        aacRouteRuntime.capabilityRuntime,
      );
      throwIfAborted(options.signal);
      const scan = await scanAdtsFrames(encodedSource, options.signal, {
        audioStartByte: frameContent.audioStartByte,
      });
      throwIfAborted(options.signal);
      if (!sameAacCoreConfiguration(capabilityEvidence.coreConfiguration, scan.coreConfiguration)) {
        throw new EncodedSourceIntegrityError(
          'Raw AAC source configuration changed after capability admission',
        );
      }
      const codecTimelineHostArtifact = await createOptionalCodecTimelineHostArtifact(
        codecTimelineHostArtifactBinding,
        options.queueItemId,
        encodedSource,
        scan,
        options.signal,
      );
      throwIfAborted(options.signal);
      const returnedSource = factories.createStreamingAacSource({
        queueItemId: options.queueItemId,
        encodedSource,
        scan,
        backendId: rawAdtsAacBackendId,
        audioContext: options.audioContext,
        nowRoomTimeMs: options.nowRoomTimeMs,
        roomTimeMsToContextTime: options.roomTimeMsToContextTime,
        localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
        runtime: aacRouteRuntime.playbackRuntime,
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
      return issueFilePlaybackSourceResult(result, codecTimelineHostArtifact);
    }

    if (
      m4aBackendId !== null &&
      (m4aContentCandidate || (!aacContentCandidate && !mp3ContentCandidate && m4aClaim))
    ) {
      const manifest = await readM4aAacLcMetadata(encodedSource, options.signal);
      throwIfAborted(options.signal);
      const returnedSource = factories.createStreamingM4aAacSource({
        queueItemId: options.queueItemId,
        encodedSource,
        manifest,
        backendId: m4aBackendId,
        audioContext: options.audioContext,
        nowRoomTimeMs: options.nowRoomTimeMs,
        roomTimeMsToContextTime: options.roomTimeMsToContextTime,
        localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
        runtime: options.m4aRuntime,
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
      return issueFilePlaybackSourceResult(result, null);
    }

    if (
      mp3RouteEnabled &&
      (mp3ContentCandidate || (!aacContentCandidate && !m4aContentCandidate && mp3Claim))
    ) {
      const metadata = await readMp3Metadata(encodedSource, options.signal);
      throwIfAborted(options.signal);
      const codecTimelineHostArtifact = isMp3MetadataTimelineManifestEligible(metadata)
        ? await createOptionalCodecTimelineHostArtifact(
            codecTimelineHostArtifactBinding,
            options.queueItemId,
            encodedSource,
            metadata,
            options.signal,
          )
        : null;
      throwIfAborted(options.signal);
      const returnedSource = factories.createStreamingMp3Source({
        queueItemId: options.queueItemId,
        encodedSource,
        metadata,
        audioContext: options.audioContext,
        nowRoomTimeMs: options.nowRoomTimeMs,
        roomTimeMsToContextTime: options.roomTimeMsToContextTime,
        localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
        runtime: options.mp3Runtime,
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
      return issueFilePlaybackSourceResult(result, codecTimelineHostArtifact);
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
    return issueFilePlaybackSourceResult(result, null);
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
  const codecTimelineHostArtifactBinding = snapshotOptionalCodecTimelineHostArtifactBinding(
    options.codecTimelineHostArtifactBinding,
  );
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
      mp3Runtime: options.mp3Runtime,
      aacRuntime: options.aacRuntime,
      aacCapabilityProbe: options.aacCapabilityProbe,
      m4aRuntime: options.m4aRuntime,
      boundedRoutePolicy: options.boundedRoutePolicy,
      codecTimelineHostArtifactBinding,
      backendFactories: options.backendFactories,
    },
    {
      blob,
      decodeOrdinaryAudio,
    },
  );
}
