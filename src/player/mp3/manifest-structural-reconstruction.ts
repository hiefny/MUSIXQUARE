import type {
  Mp3NoFrameCountTimelineManifest,
  Mp3NoFrameCountTimelinePoint,
} from '../manifests/codec-timeline-manifest.ts';
import {
  encodeCodecTimelineManifest,
  parseCodecTimelineManifest,
} from '../manifests/codec-timeline-manifest.ts';
import {
  EncodedSourceIntegrityError,
  type EncodedRandomAccessSource,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import {
  MpegLayer3FrameHeaderError,
  parseMpegLayer3FrameHeader,
  type MpegLayer3FrameHeader,
} from './frame-header.ts';
import { readMp3Id3Boundaries, type ParsedMp3Id3Boundaries } from './id3.ts';
import { Mp3SideInfoError, parseMpegLayer3MainDataBegin } from './side-info.ts';
import type { MpegLayer3SeekIndexPoint } from './seek-index.ts';
import { Mp3VbrMetadataError, parseMp3FirstFrameVbrMetadata } from './vbr-metadata.ts';

export const MP3_MANIFEST_RECONSTRUCTION_MAX_PREFIX_FRAMES = 4;
export const MP3_MANIFEST_RECONSTRUCTION_MAX_SOURCE_READS = 64;
export const MP3_MANIFEST_RECONSTRUCTION_MAX_SINGLE_READ_BYTES = 64 * 1_024;
export const MP3_MANIFEST_RECONSTRUCTION_MAX_TOTAL_READ_BYTES = 16 * 1_024;

const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 1_441;
const OPTION_KEYS = Object.freeze(['manifest', 'signal', 'source'] as const);
const OPTION_KEY_SET: ReadonlySet<PropertyKey> = new Set(OPTION_KEYS);

const Uint8ArrayIntrinsic = Uint8Array;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const typedArrayTagGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
  : undefined;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;

export interface ReconstructMp3ManifestStructureOptions {
  /**
   * Canonical data supplied by an outer layer. That layer, not this helper,
   * remains responsible for live admission and middle-byte authority.
   */
  readonly manifest: Readonly<Mp3NoFrameCountTimelineManifest>;
  /** Borrowed exact media source. This function never closes it. */
  readonly source: EncodedRandomAccessSource;
  readonly signal: AbortSignal;
}

export interface Mp3ManifestId3Geometry {
  readonly dataStart: number;
  readonly audioEnd: number;
  readonly leadingTagCount: number;
  readonly trailingTagCount: number;
  readonly hasTrailingId3v1: boolean;
  readonly trailingId3v1Offset: number | null;
}

export interface Mp3ManifestEndpointChecks {
  readonly tagDeclaration: Readonly<Mp3ManifestTagDeclaration> | null;
  readonly verifiedPrefixFrameCount: number;
  readonly verifiedPrefixByteEnd: number;
  readonly terminalFrameOrdinal: number;
  readonly terminalFrameByteOffset: number;
  readonly terminalFrameByteLength: number;
  readonly terminalMainDataCapacityBytes: number;
  readonly terminalMainDataBeginBytes: number;
}

export interface Mp3ManifestTagDeclaration {
  readonly kind: 'xing' | 'info';
  readonly frameCount: null;
  readonly streamBytes: number | null;
  readonly gapless: null;
}

/**
 * Bounded byte-level reconstruction of an admitted no-count MP3 manifest.
 *
 * Sparse endpoint reads cannot prove the media bytes between retained points,
 * so this value deliberately has no scanner seal, decoder authority, frame
 * count evidence, or `fullyVerifiedFrameSpan` claim. The live admission owner
 * remains responsible for the authenticated middle of the manifest timeline.
 */
export interface Mp3ManifestStructuralReconstruction {
  readonly evidenceKind: 'mp3-manifest-structural-reconstruction';
  readonly authority: 'none';
  /** Exact source label only; it is not a live lease or admission capability. */
  readonly sourceIdentity: string;
  readonly sourceSize: number;
  readonly id3Geometry: Readonly<Mp3ManifestId3Geometry>;
  readonly version: '1' | '2' | '2.5';
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly samplesPerFrame: 576 | 1_152;
  readonly firstAudioFrameHeader: Readonly<MpegLayer3FrameHeader>;
  readonly hasTagFrame: boolean;
  readonly tagFrameOffset: number | null;
  readonly tagFrameBytes: number;
  readonly gapless: null;
  readonly firstAudioFrameOffset: number;
  readonly audioEndByteOffset: number;
  readonly id3FreeMpegBytes: number;
  readonly audioBytes: number;
  readonly audioFrameCount: number;
  readonly totalRawSamples: number;
  readonly totalMediaFrames: number;
  readonly seekPoints: readonly Readonly<MpegLayer3SeekIndexPoint>[];
  readonly endpointChecks: Readonly<Mp3ManifestEndpointChecks>;
}

export class Mp3ManifestStructuralReconstructionError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'Mp3ManifestStructuralReconstructionError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

interface OptionsSnapshot {
  readonly manifest: unknown;
  readonly source: unknown;
  readonly signal: unknown;
}

interface ReadBudget {
  readCount: number;
  totalBytes: number;
}

interface SourceSnapshot {
  readonly authority: EncodedRandomAccessSource;
  readonly source: EncodedRandomAccessSource;
  readonly size: number;
  readonly identity: string;
}

interface ParsedFrame {
  readonly header: Readonly<MpegLayer3FrameHeader>;
  readonly bytes: Uint8Array;
  readonly byteOffset: number;
  readonly byteEndOffset: number;
  readonly mainDataBeginBytes: number;
}

function snapshotOptions(value: unknown): Readonly<OptionsSnapshot> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('MP3 manifest reconstruction options must be an exact plain record');
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new TypeError('MP3 manifest reconstruction options could not be snapshotted', {
      cause: error,
    });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('MP3 manifest reconstruction options must be an exact plain record');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== OPTION_KEYS.length || keys.some((key) => !OPTION_KEY_SET.has(key))) {
    throw new TypeError('MP3 manifest reconstruction options have missing or extra fields');
  }
  const readData = (key: (typeof OPTION_KEYS)[number]): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`MP3 manifest reconstruction ${key} must be an enumerable data field`);
    }
    return descriptor.value;
  };
  return Object.freeze({
    manifest: readData('manifest'),
    signal: readData('signal'),
    source: readData('source'),
  });
}

function canonicalMp3Manifest(value: unknown): Readonly<Mp3NoFrameCountTimelineManifest> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('MP3 timeline manifest must be an exact plain data record');
  }
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('MP3 timeline manifest must use a plain or null prototype');
    }
    const parsed = parseCodecTimelineManifest(encodeCodecTimelineManifest(value));
    if (parsed.codec !== 'mp3-no-frame-count') {
      throw new TypeError('MP3 structural reconstruction requires a no-frame-count manifest');
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof TypeError &&
      (error.message.includes('plain or null prototype') ||
        error.message.includes('no-frame-count manifest'))
    ) {
      throw error;
    }
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 no-frame-count timeline manifest is not canonical',
      error,
    );
  }
}

function assertSourceStable(
  authority: EncodedRandomAccessSource,
  size: number,
  identity: string,
): void {
  let currentSize: number;
  let currentIdentity: string;
  try {
    currentSize = authority.size;
    currentIdentity = authority.identity;
  } catch (error) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 encoded source binding could not be re-inspected safely',
      error,
    );
  }
  if (currentSize !== size) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 encoded source size changed during manifest reconstruction',
    );
  }
  if (currentIdentity !== identity) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 encoded source identity changed during manifest reconstruction',
    );
  }
}

function snapshotExactPage(value: unknown, expectedLength: number): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new Mp3ManifestStructuralReconstructionError('MP3 transport returned invalid page bytes');
  }

  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('not a Uint8Array');
    }
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // The ArrayBuffer intrinsic rejects SharedArrayBuffer and detached storage.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (error) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 transport page must be a readable local non-shared Uint8Array',
      error,
    );
  }
  if (byteLength !== expectedLength) {
    throw new Mp3ManifestStructuralReconstructionError(
      `MP3 transport page returned ${byteLength} bytes; expected ${expectedLength}`,
    );
  }

  const owned = new Uint8ArrayIntrinsic(expectedLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (error) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 transport page could not be copied into bounded local storage',
      error,
    );
  }
  return owned;
}

function chargeReadBudget(budget: ReadBudget, length: number): void {
  if (length > MP3_MANIFEST_RECONSTRUCTION_MAX_SINGLE_READ_BYTES) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 manifest reconstruction attempted an oversized source read',
    );
  }
  if (budget.readCount >= MP3_MANIFEST_RECONSTRUCTION_MAX_SOURCE_READS) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 manifest reconstruction exceeded its fixed source-read limit',
    );
  }
  const totalBytes = budget.totalBytes + length;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > MP3_MANIFEST_RECONSTRUCTION_MAX_TOTAL_READ_BYTES
  ) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 manifest reconstruction exceeded its fixed read-allocation limit',
    );
  }
  budget.readCount += 1;
  budget.totalBytes = totalBytes;
}

function snapshotSource(value: unknown): Readonly<SourceSnapshot> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('MP3 manifest reconstruction requires an encoded source');
  }
  const authority = value as EncodedRandomAccessSource;
  let size: number;
  let identity: string;
  let readAt: EncodedRandomAccessSource['readAt'];
  let close: EncodedRandomAccessSource['close'];
  try {
    size = authority.size;
    identity = authority.identity;
    readAt = authority.readAt;
    close = authority.close;
  } catch (error) {
    throw new TypeError('MP3 encoded source could not be inspected safely', { cause: error });
  }
  validateExactRead(size, 0, 0);
  if (!isEncodedAudioSourceIdentity(identity)) {
    throw new TypeError('MP3 encoded source identity is invalid');
  }
  if (typeof readAt !== 'function' || typeof close !== 'function') {
    throw new TypeError('MP3 encoded source methods are invalid');
  }

  const budget: ReadBudget = { readCount: 0, totalBytes: 0 };
  const source: EncodedRandomAccessSource = Object.freeze({
    size,
    identity,
    async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
      validateExactRead(size, offset, length);
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError('MP3 encoded source read requires an AbortSignal');
      }
      throwIfAborted(signal);
      assertSourceStable(authority, size, identity);
      chargeReadBudget(budget, length);

      let value: unknown;
      try {
        value = await Reflect.apply(readAt, authority, [offset, length, signal]);
      } catch (error) {
        throwIfAborted(signal);
        assertSourceStable(authority, size, identity);
        throw error;
      }
      throwIfAborted(signal);
      assertSourceStable(authority, size, identity);
      const page = snapshotExactPage(value, length);
      throwIfAborted(signal);
      assertSourceStable(authority, size, identity);
      return page;
    },
    // All readers borrow this facade. Never consume the caller's source lease.
    async close(): Promise<void> {},
  });
  assertSourceStable(authority, size, identity);
  return Object.freeze({ authority, source, size, identity });
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Mp3ManifestStructuralReconstructionError(
      `${label} exceeds the browser safe-integer range`,
    );
  }
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Mp3ManifestStructuralReconstructionError(
      `${label} exceeds the browser safe-integer range`,
    );
  }
  return result;
}

function spanCanContainFrames(
  byteSpan: number,
  frameCount: number,
  minimumFrameBytes: number,
): boolean {
  if (
    !Number.isSafeInteger(byteSpan) ||
    byteSpan < 0 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount < 0
  ) {
    return false;
  }
  if (frameCount > Math.floor(Number.MAX_SAFE_INTEGER / minimumFrameBytes)) return false;
  if (byteSpan < frameCount * minimumFrameBytes) return false;
  return (
    frameCount > Math.floor(Number.MAX_SAFE_INTEGER / MAX_FRAME_BYTES) ||
    byteSpan <= frameCount * MAX_FRAME_BYTES
  );
}

function parseHeader(bytes: Uint8Array, byteOffset: number): Readonly<MpegLayer3FrameHeader> {
  try {
    return parseMpegLayer3FrameHeader(bytes);
  } catch (error) {
    if (error instanceof MpegLayer3FrameHeaderError) {
      throw new Mp3ManifestStructuralReconstructionError(
        `Invalid MPEG Layer III frame at byte ${byteOffset}: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

function parseMainDataBegin(
  frame: Uint8Array,
  header: Readonly<MpegLayer3FrameHeader>,
  byteOffset: number,
): number {
  try {
    return parseMpegLayer3MainDataBegin(frame, header);
  } catch (error) {
    if (error instanceof Mp3SideInfoError || error instanceof MpegLayer3FrameHeaderError) {
      throw new Mp3ManifestStructuralReconstructionError(
        `Invalid MPEG Layer III side-info at byte ${byteOffset}: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

async function readFrameAt(
  source: EncodedRandomAccessSource,
  byteOffset: number,
  lowerBound: number,
  upperBound: number,
  signal: AbortSignal,
): Promise<Readonly<ParsedFrame>> {
  if (byteOffset < lowerBound || byteOffset >= upperBound) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 manifest frame coordinate lies outside its metadata-free audio span',
    );
  }
  if (upperBound - byteOffset < FRAME_HEADER_BYTES) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 manifest frame coordinate truncates its four-byte header',
    );
  }
  const headerBytes = await source.readAt(byteOffset, FRAME_HEADER_BYTES, signal);
  const header = parseHeader(headerBytes, byteOffset);
  if (header.frameLengthBytes > MAX_FRAME_BYTES) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 frame exceeds the bounded Layer III frame-size limit',
    );
  }
  const byteEndOffset = safeAdd(byteOffset, header.frameLengthBytes, 'MP3 frame end');
  if (byteEndOffset > upperBound) {
    throw new Mp3ManifestStructuralReconstructionError(
      `MPEG frame at byte ${byteOffset} is truncated at the declared audio end`,
    );
  }

  const bytes = new Uint8ArrayIntrinsic(header.frameLengthBytes);
  uint8ArraySet.call(bytes, headerBytes, 0);
  const remainderBytes = header.frameLengthBytes - FRAME_HEADER_BYTES;
  if (remainderBytes > 0) {
    const remainder = await source.readAt(byteOffset + FRAME_HEADER_BYTES, remainderBytes, signal);
    uint8ArraySet.call(bytes, remainder, FRAME_HEADER_BYTES);
  }
  const mainDataBeginBytes = parseMainDataBegin(bytes, header, byteOffset);
  return Object.freeze({
    header,
    bytes,
    byteOffset,
    byteEndOffset,
    mainDataBeginBytes,
  });
}

function assertHeaderMatchesManifest(
  frame: Readonly<ParsedFrame>,
  manifest: Readonly<Mp3NoFrameCountTimelineManifest>,
  label: string,
): void {
  const header = frame.header;
  if (
    header.version !== manifest.mpegVersion ||
    header.layer !== manifest.layer ||
    header.sampleRateHz !== manifest.sampleRateHz ||
    header.channelCount !== manifest.channels ||
    header.samplesPerFrame !== manifest.samplesPerFrame
  ) {
    throw new Mp3ManifestStructuralReconstructionError(
      `${label} MPEG frame contradicts the canonical timeline manifest`,
    );
  }
}

function assertFrameMatchesPoint(
  frame: Readonly<ParsedFrame>,
  point: Readonly<Mp3NoFrameCountTimelinePoint>,
  label: string,
): void {
  if (
    frame.byteOffset !== point.byteOffset ||
    frame.header.mainDataCapacityBytes !== point.mainDataCapacityBytes ||
    frame.mainDataBeginBytes !== point.mainDataBeginBytes
  ) {
    throw new Mp3ManifestStructuralReconstructionError(
      `${label} MPEG frame contradicts its retained manifest point`,
    );
  }
}

function parseVbr(frame: Readonly<ParsedFrame>, label: string) {
  try {
    return parseMp3FirstFrameVbrMetadata(frame.bytes, frame.header);
  } catch (error) {
    if (error instanceof Mp3VbrMetadataError) {
      throw new Mp3ManifestStructuralReconstructionError(
        `${label} MPEG frame contains invalid Xing, Info, or VBRI metadata: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

function validateId3Geometry(
  id3: Readonly<ParsedMp3Id3Boundaries>,
  manifest: Readonly<Mp3NoFrameCountTimelineManifest>,
): void {
  const expectedAudioStart = manifest.hasTagFrame
    ? safeAdd(id3.dataStart, manifest.tagFrameBytes, 'MP3 tag frame end')
    : id3.dataStart;
  if (
    id3.sourceBytes !== manifest.sourceSize ||
    id3.audioEnd !== manifest.audioEndByte ||
    expectedAudioStart !== manifest.audioStartByte
  ) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 ID3 boundaries contradict the manifest audio or tag geometry',
    );
  }
}

function cloneHeader(header: Readonly<MpegLayer3FrameHeader>): Readonly<MpegLayer3FrameHeader> {
  return Object.freeze({
    version: header.version,
    layer: 3,
    bitrateIndex: header.bitrateIndex,
    bitrateKbps: header.bitrateKbps,
    sampleRateIndex: header.sampleRateIndex,
    sampleRateHz: header.sampleRateHz,
    channelMode: header.channelMode,
    channelCount: header.channelCount,
    samplesPerFrame: header.samplesPerFrame,
    hasCrc: header.hasCrc,
    padding: header.padding,
    frameLengthBytes: header.frameLengthBytes,
    sideInfoBytes: header.sideInfoBytes,
    mainDataCapacityBytes: header.mainDataCapacityBytes,
  });
}

/**
 * Verify duration-independent MP3 structure with a fixed read/allocation cap.
 *
 * The ID3 reader performs only header/footer probes. This helper then reads at
 * most one tag frame, four leading audio frames, and one terminal frame. Every
 * source call is at most 64 KiB; all calls together request at most 16 KiB and
 * are limited to 64 even if lower-level ID3 logic changes later.
 */
export async function reconstructMp3ManifestStructure(
  optionsValue: ReconstructMp3ManifestStructureOptions,
): Promise<Readonly<Mp3ManifestStructuralReconstruction>> {
  const options = snapshotOptions(optionsValue);
  if (!(options.signal instanceof AbortSignal)) {
    throw new TypeError('MP3 manifest reconstruction signal must be an AbortSignal');
  }
  const signal = options.signal;
  throwIfAborted(signal);
  const manifest = canonicalMp3Manifest(options.manifest);
  const samplesPerFrame: 576 | 1_152 = manifest.mpegVersion === '1' ? 1_152 : 576;
  if (manifest.gapless !== null) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 no-frame-count structural reconstruction requires gapless metadata to be null',
    );
  }

  const source = snapshotSource(options.source);
  if (source.size !== manifest.sourceSize) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 manifest sourceSize does not match the exact encoded source',
    );
  }

  const id3 = await readMp3Id3Boundaries(source.source, signal);
  throwIfAborted(signal);
  assertSourceStable(source.authority, source.size, source.identity);
  validateId3Geometry(id3, manifest);

  let tagDeclaration: Readonly<Mp3ManifestTagDeclaration> | null = null;
  if (manifest.hasTagFrame) {
    const tag = await readFrameAt(
      source.source,
      id3.dataStart,
      id3.dataStart,
      id3.audioEnd,
      signal,
    );
    assertHeaderMatchesManifest(tag, manifest, 'Tag');
    if (
      tag.byteEndOffset !== manifest.audioStartByte ||
      tag.header.frameLengthBytes !== manifest.tagFrameBytes
    ) {
      throw new Mp3ManifestStructuralReconstructionError(
        'Actual MP3 tag frame contradicts the manifest tag geometry',
      );
    }
    const vbr = parseVbr(tag, 'Tag');
    if (!vbr) {
      throw new Mp3ManifestStructuralReconstructionError(
        'Manifest-declared MP3 tag frame lacks Xing, Info, or VBRI metadata',
      );
    }
    if (vbr.kind !== 'xing' || vbr.frameCount !== null) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 no-frame-count route rejects Xing, Info, or VBRI frame-count declarations',
      );
    }
    if (vbr.gapless !== null) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 no-frame-count tag cannot establish trusted gapless trim metadata',
      );
    }
    const id3FreeMpegBytes = id3.audioEnd - id3.dataStart;
    if (vbr.streamBytes !== null && vbr.streamBytes !== id3FreeMpegBytes) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 Xing/Info stream-byte declaration contradicts the exact ID3-free span',
      );
    }
    tagDeclaration = Object.freeze({
      kind: vbr.identifier === 'Xing' ? 'xing' : 'info',
      frameCount: null,
      streamBytes: vbr.streamBytes,
      gapless: null,
    });
  }

  const prefixFrameCount = Math.min(
    manifest.frameCount,
    MP3_MANIFEST_RECONSTRUCTION_MAX_PREFIX_FRAMES,
  );
  const prefixFrames: Readonly<ParsedFrame>[] = [];
  let cursor = manifest.audioStartByte;
  for (let frameOrdinal = 0; frameOrdinal < prefixFrameCount; frameOrdinal += 1) {
    const frame = await readFrameAt(
      source.source,
      cursor,
      manifest.audioStartByte,
      manifest.audioEndByte,
      signal,
    );
    assertHeaderMatchesManifest(frame, manifest, `Prefix frame ${frameOrdinal}`);
    if (frameOrdinal === 0 && frame.mainDataBeginBytes !== 0) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 first audio frame cannot reference an earlier bit reservoir',
      );
    }
    const retainedPoint = manifest.points.find((point) => point.frameOrdinal === frameOrdinal);
    if (retainedPoint) {
      assertFrameMatchesPoint(frame, retainedPoint, `Prefix frame ${frameOrdinal}`);
    }
    const followingPoint = manifest.points.find((point) => point.frameOrdinal === frameOrdinal + 1);
    if (followingPoint && followingPoint.byteOffset !== frame.byteEndOffset) {
      throw new Mp3ManifestStructuralReconstructionError(
        `Prefix frame ${frameOrdinal} end contradicts the next retained manifest point`,
      );
    }
    if (frameOrdinal === 0 && parseVbr(frame, 'First audio') !== null) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 first audio frame contains an undeclared Xing, Info, or VBRI tag',
      );
    }
    prefixFrames.push(frame);
    cursor = frame.byteEndOffset;
  }

  const firstAudioFrame = prefixFrames[0];
  if (!firstAudioFrame) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 manifest did not resolve a first audio frame',
    );
  }
  if (manifest.frameCount <= MP3_MANIFEST_RECONSTRUCTION_MAX_PREFIX_FRAMES) {
    if (cursor !== manifest.audioEndByte) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 bounded prefix leaves bytes after its declared final frame',
      );
    }
  } else if (cursor >= manifest.audioEndByte) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 bounded prefix consumes the declared middle and terminal frame span',
    );
  }

  const minimumFrameBytes = samplesPerFrame === 1_152 ? 96 : 24;
  const remainingFrameCount = manifest.frameCount - prefixFrameCount;
  if (
    !spanCanContainFrames(manifest.audioEndByte - cursor, remainingFrameCount, minimumFrameBytes)
  ) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 actual prefix leaves an impossible declared middle and terminal frame span',
    );
  }
  for (const point of manifest.points) {
    if (point.frameOrdinal < prefixFrameCount) continue;
    if (
      !spanCanContainFrames(
        point.byteOffset - cursor,
        point.frameOrdinal - prefixFrameCount,
        minimumFrameBytes,
      )
    ) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 retained point geometry contradicts the exact verified prefix end',
      );
    }
  }

  const terminalPoint = manifest.points[manifest.points.length - 1];
  if (!terminalPoint) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 manifest lacks its retained terminal frame point',
    );
  }
  let terminalFrame = prefixFrames[terminalPoint.frameOrdinal];
  if (!terminalFrame) {
    if (terminalPoint.byteOffset < cursor) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 terminal manifest point overlaps the verified prefix',
      );
    }
    if (terminalPoint.frameOrdinal === prefixFrameCount && terminalPoint.byteOffset !== cursor) {
      throw new Mp3ManifestStructuralReconstructionError(
        'MP3 terminal manifest point is not contiguous with the verified prefix',
      );
    }
    terminalFrame = await readFrameAt(
      source.source,
      terminalPoint.byteOffset,
      manifest.audioStartByte,
      manifest.audioEndByte,
      signal,
    );
  }
  assertHeaderMatchesManifest(terminalFrame, manifest, 'Terminal frame');
  assertFrameMatchesPoint(terminalFrame, terminalPoint, 'Terminal frame');
  if (terminalFrame.byteEndOffset !== manifest.audioEndByte) {
    throw new Mp3ManifestStructuralReconstructionError(
      'MP3 terminal frame does not end exactly at the metadata-free audio EOF',
    );
  }

  throwIfAborted(signal);
  assertSourceStable(source.authority, source.size, source.identity);

  const seekPoints = Object.freeze(
    manifest.points.map((point) =>
      Object.freeze({
        rawSample: safeMultiply(point.frameOrdinal, samplesPerFrame, 'MP3 seek-point sample'),
        byteOffset: point.byteOffset,
        frameOrdinal: point.frameOrdinal,
        mainDataCapacityBytes: point.mainDataCapacityBytes,
        mainDataBeginBytes: point.mainDataBeginBytes,
      }),
    ),
  );
  const id3Geometry: Readonly<Mp3ManifestId3Geometry> = Object.freeze({
    dataStart: id3.dataStart,
    audioEnd: id3.audioEnd,
    leadingTagCount: id3.leadingTagCount,
    trailingTagCount: id3.trailingTagCount,
    hasTrailingId3v1: id3.hasTrailingId3v1,
    trailingId3v1Offset: id3.trailingId3v1Offset,
  });
  const endpointChecks: Readonly<Mp3ManifestEndpointChecks> = Object.freeze({
    tagDeclaration,
    verifiedPrefixFrameCount: prefixFrameCount,
    verifiedPrefixByteEnd: cursor,
    terminalFrameOrdinal: terminalPoint.frameOrdinal,
    terminalFrameByteOffset: terminalFrame.byteOffset,
    terminalFrameByteLength: terminalFrame.header.frameLengthBytes,
    terminalMainDataCapacityBytes: terminalFrame.header.mainDataCapacityBytes,
    terminalMainDataBeginBytes: terminalFrame.mainDataBeginBytes,
  });

  return Object.freeze({
    evidenceKind: 'mp3-manifest-structural-reconstruction',
    authority: 'none',
    sourceIdentity: source.identity,
    sourceSize: source.size,
    id3Geometry,
    version: manifest.mpegVersion,
    sampleRateHz: manifest.sampleRateHz,
    channels: manifest.channels,
    samplesPerFrame,
    firstAudioFrameHeader: cloneHeader(firstAudioFrame.header),
    hasTagFrame: manifest.hasTagFrame,
    tagFrameOffset: manifest.hasTagFrame ? id3.dataStart : null,
    tagFrameBytes: manifest.tagFrameBytes,
    gapless: null,
    firstAudioFrameOffset: manifest.audioStartByte,
    audioEndByteOffset: manifest.audioEndByte,
    id3FreeMpegBytes: id3.audioEnd - id3.dataStart,
    audioBytes: manifest.audioEndByte - manifest.audioStartByte,
    audioFrameCount: manifest.frameCount,
    totalRawSamples: safeMultiply(manifest.frameCount, samplesPerFrame, 'MP3 raw sample count'),
    totalMediaFrames: manifest.totalMediaFrames,
    seekPoints,
    endpointChecks,
  });
}
