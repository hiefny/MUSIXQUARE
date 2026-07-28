import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import type { MpegLayer3FrameHeader, MpegLayer3Version } from './frame-header.ts';
import {
  scanMpegLayer3Frames,
  type MpegLayer3FrameScanResult,
  type MpegLayer3VerifiedFrame,
} from './frame-scanner.ts';
import { readMp3Id3Boundaries, type ParsedMp3Id3Boundaries } from './id3.ts';
import {
  MP3_SEEK_INDEX_MAX_POINTS,
  MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES,
  MpegLayer3SeekIndex,
  type MpegLayer3SeekIndexPoint,
} from './seek-index.ts';
import { createMp3SampleTimeline } from './timeline.ts';
import {
  Mp3VbrMetadataError,
  parseMp3FirstFrameVbrMetadata,
  type Mp3FirstFrameVbrMetadata,
  type Mp3GaplessMetadata,
} from './vbr-metadata.ts';

export const MP3_METADATA_PREFIX_PHYSICAL_FRAMES = 4;

const PROTECTED_TAIL_POINTS = MP3_SEEK_MAX_PROTECTED_PRELUDE_FRAMES + 1;
const SPARSE_POINT_LIMIT = MP3_SEEK_INDEX_MAX_POINTS - PROTECTED_TAIL_POINTS;

export type Mp3FrameCountEvidence = 'verified-scan' | 'xing' | 'info' | 'vbri';

/**
 * Strict, normalized metadata for one bounded native MPEG Layer III stream.
 *
 * `audioFrameCount` and all sample coordinates exclude a leading
 * Xing/Info/VBRI tag frame. `id3FreeMpegBytes` deliberately includes that tag
 * frame because Xing/VBRI stream-byte declarations use the physical MPEG span.
 */
export interface Mp3Metadata {
  readonly format: 'mp3';
  readonly id3: ParsedMp3Id3Boundaries;
  readonly vbr: Mp3FirstFrameVbrMetadata | null;
  readonly gapless: Mp3GaplessMetadata | null;

  readonly version: MpegLayer3Version;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly samplesPerFrame: 576 | 1_152;
  readonly firstAudioFrameHeader: MpegLayer3FrameHeader;

  readonly hasTagFrame: boolean;
  readonly tagFrameOffset: number | null;
  readonly tagFrameBytes: number;
  readonly firstAudioFrameOffset: number;
  readonly audioEndByteOffset: number;
  /** ID3-free physical MPEG span, including an optional leading tag frame. */
  readonly id3FreeMpegBytes: number;
  /** Decodable MPEG audio span after an optional leading tag frame. */
  readonly audioBytes: number;

  /** Physical frames in the ID3-free span, including an optional tag frame. */
  readonly physicalFrameCount: number;
  /** Decodable MPEG frames after removing an optional tag frame. */
  readonly audioFrameCount: number;
  readonly totalRawSamples: number;
  readonly totalMediaFrames: number;
  readonly durationSeconds: number;

  readonly frameCountEvidence: Mp3FrameCountEvidence;
  readonly fullyVerifiedFrameSpan: boolean;
  readonly verifiedAudioFrameCount: number;
  readonly verifiedAudioBytes: number;
  /** Scanner-verified, audio-rebased frame boundaries only; TOCs are not seeds. */
  readonly seekPoints: readonly MpegLayer3SeekIndexPoint[];
}

export interface ScannerIssuedMp3MetadataSource {
  readonly sourceIdentity: string;
  readonly sourceSize: number;
}

// Keep source binding and issuance authority out of Mp3Metadata's public exact
// data shape. Decoder boundaries intentionally validate that shape strictly.
// A structural copy therefore neither gains seal authority nor leaks a hidden
// mutable marker into decoder metadata.
const scannerIssuedMp3MetadataSources = new WeakMap<
  object,
  Readonly<ScannerIssuedMp3MetadataSource>
>();

/** Internal trust boundary used by the timeline-manifest sealer. */
export function scannerIssuedMp3MetadataSource(
  value: unknown,
): Readonly<ScannerIssuedMp3MetadataSource> | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  return scannerIssuedMp3MetadataSources.get(value) ?? null;
}

export class Mp3MetadataError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'Mp3MetadataError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

interface AudioFrameDescriptor extends MpegLayer3SeekIndexPoint {
  readonly header: MpegLayer3FrameHeader;
}

interface SelectedScan {
  readonly scan: MpegLayer3FrameScanResult;
  readonly descriptors: readonly AudioFrameDescriptor[];
  readonly audioFrameCount: number;
  readonly evidence: Mp3FrameCountEvidence;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Mp3MetadataError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Mp3MetadataError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function snapshotSourceBinding(source: EncodedAudioSource): ScannerIssuedMp3MetadataSource {
  let sourceSize: number;
  let sourceIdentity: string;
  try {
    sourceSize = source.size;
    sourceIdentity = source.identity;
  } catch (error) {
    throw new TypeError('MP3 metadata source binding could not be inspected safely', {
      cause: error,
    });
  }
  validateExactRead(sourceSize, 0, 0);
  if (!isEncodedAudioSourceIdentity(sourceIdentity)) {
    throw new TypeError('MP3 metadata source identity is invalid');
  }
  return Object.freeze({ sourceIdentity, sourceSize });
}

function assertSourceBindingStable(
  source: EncodedAudioSource,
  expected: Readonly<ScannerIssuedMp3MetadataSource>,
): void {
  let sourceSize: number;
  let sourceIdentity: string;
  try {
    sourceSize = source.size;
    sourceIdentity = source.identity;
  } catch (error) {
    throw new Mp3MetadataError('MP3 encoded source binding changed during metadata read', error);
  }
  if (sourceSize !== expected.sourceSize || sourceIdentity !== expected.sourceIdentity) {
    throw new Mp3MetadataError('MP3 encoded source binding changed during metadata read');
  }
}

function immutableDescriptor(
  frame: MpegLayer3VerifiedFrame,
  physicalOrdinalBase: 0 | 1,
): AudioFrameDescriptor | null {
  if (frame.frameOrdinal < physicalOrdinalBase) return null;
  const frameOrdinal = frame.frameOrdinal - physicalOrdinalBase;
  const rawSample = safeMultiply(
    frameOrdinal,
    frame.header.samplesPerFrame,
    'MP3 rebased raw sample',
  );
  return Object.freeze({
    rawSample,
    byteOffset: frame.byteOffset,
    frameOrdinal,
    mainDataCapacityBytes: frame.header.mainDataCapacityBytes,
    mainDataBeginBytes: frame.mainDataBeginBytes,
    header: frame.header,
  });
}

/**
 * Duration-independent collector for a complete frame scan.
 *
 * It preserves frame zero, a sparse exact history, and enough contiguous tail
 * points for the seek index's maximum reservoir plus synthesis prelude. The
 * target point itself is additional to the protected predecessor count.
 */
class BoundedSeekSeedCollector {
  private readonly sparse: AudioFrameDescriptor[] = [];
  private readonly tail: AudioFrameDescriptor[] = [];
  private addedCount = 0;

  add(frame: MpegLayer3VerifiedFrame, physicalOrdinalBase: 0 | 1): void {
    const descriptor = immutableDescriptor(frame, physicalOrdinalBase);
    if (descriptor === null) return;
    if (descriptor.frameOrdinal !== this.addedCount) {
      throw new Mp3MetadataError('MP3 verified audio frames are not contiguous after tag rebasing');
    }
    this.addedCount = safeAdd(this.addedCount, 1, 'MP3 verified audio frame count');
    this.tail.push(descriptor);
    if (this.tail.length <= PROTECTED_TAIL_POINTS) return;

    const aged = this.tail.shift();
    if (!aged) throw new Mp3MetadataError('MP3 bounded seek collector lost its oldest point');
    if (this.sparse.length >= SPARSE_POINT_LIMIT) this.compactSparse();
    this.sparse.push(aged);
  }

  get count(): number {
    return this.addedCount;
  }

  snapshot(): readonly AudioFrameDescriptor[] {
    const points = [...this.sparse, ...this.tail];
    if (points.length > MP3_SEEK_INDEX_MAX_POINTS) {
      throw new Mp3MetadataError('MP3 bounded seek collector exceeded its hard point limit');
    }
    return Object.freeze(points.slice());
  }

  private compactSparse(): void {
    const origin = this.sparse[0];
    if (!origin || origin.frameOrdinal !== 0) {
      throw new Mp3MetadataError('MP3 bounded seek collector lost frame zero');
    }
    const compacted: AudioFrameDescriptor[] = [origin];
    for (let index = 2; index < this.sparse.length; index += 2) {
      const point = this.sparse[index];
      if (point) compacted.push(point);
    }
    if (compacted.length >= this.sparse.length) {
      throw new Mp3MetadataError('MP3 bounded seek collector could not compact its sparse points');
    }
    this.sparse.splice(0, this.sparse.length, ...compacted);
  }
}

function parseVbr(scan: MpegLayer3FrameScanResult): Mp3FirstFrameVbrMetadata | null {
  try {
    return parseMp3FirstFrameVbrMetadata(scan.firstFrame, scan.firstHeader);
  } catch (error) {
    if (error instanceof Mp3VbrMetadataError) {
      throw new Mp3MetadataError(
        `MP3 first-frame VBR metadata is invalid: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

function declaredAudioFrameCount(metadata: Mp3FirstFrameVbrMetadata | null): number | null {
  return metadata?.frameCount ?? null;
}

function declaredStreamBytes(metadata: Mp3FirstFrameVbrMetadata | null): number | null {
  return metadata?.streamBytes ?? null;
}

function declarationEvidence(metadata: Mp3FirstFrameVbrMetadata): Mp3FrameCountEvidence {
  if (metadata.kind === 'vbri') return 'vbri';
  return metadata.identifier === 'Info' ? 'info' : 'xing';
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function sameFrameHeader(left: MpegLayer3FrameHeader, right: MpegLayer3FrameHeader): boolean {
  return (
    left.version === right.version &&
    left.layer === right.layer &&
    left.bitrateIndex === right.bitrateIndex &&
    left.bitrateKbps === right.bitrateKbps &&
    left.sampleRateIndex === right.sampleRateIndex &&
    left.sampleRateHz === right.sampleRateHz &&
    left.channelMode === right.channelMode &&
    left.channelCount === right.channelCount &&
    left.samplesPerFrame === right.samplesPerFrame &&
    left.hasCrc === right.hasCrc &&
    left.padding === right.padding &&
    left.frameLengthBytes === right.frameLengthBytes &&
    left.sideInfoBytes === right.sideInfoBytes &&
    left.mainDataCapacityBytes === right.mainDataCapacityBytes
  );
}

function sameVerifiedFrame(left: MpegLayer3VerifiedFrame, right: MpegLayer3VerifiedFrame): boolean {
  return (
    left.frameOrdinal === right.frameOrdinal &&
    left.rawSample === right.rawSample &&
    left.byteOffset === right.byteOffset &&
    left.mainDataBeginBytes === right.mainDataBeginBytes &&
    sameFrameHeader(left.header, right.header)
  );
}

function audioDescriptorsFromPrefix(
  physicalFrames: readonly MpegLayer3VerifiedFrame[],
  hasTagFrame: boolean,
): readonly AudioFrameDescriptor[] {
  const base = hasTagFrame ? 1 : 0;
  return Object.freeze(
    physicalFrames
      .map((frame) => immutableDescriptor(frame, base))
      .filter((frame): frame is AudioFrameDescriptor => frame !== null),
  );
}

function validateFirstAudioDescriptor(
  descriptors: readonly AudioFrameDescriptor[],
  firstAudioFrameOffset: number,
): AudioFrameDescriptor {
  const first = descriptors[0];
  if (
    !first ||
    first.frameOrdinal !== 0 ||
    first.rawSample !== 0 ||
    first.byteOffset !== firstAudioFrameOffset
  ) {
    throw new Mp3MetadataError('MP3 does not contain a verified first audio frame');
  }
  if (first.mainDataBeginBytes !== 0) {
    throw new Mp3MetadataError('MP3 first audio frame cannot reference an earlier bit reservoir');
  }
  return first;
}

function validateStreamByteDeclaration(
  vbr: Mp3FirstFrameVbrMetadata | null,
  id3FreeMpegBytes: number,
): void {
  const streamBytes = declaredStreamBytes(vbr);
  if (streamBytes !== null && streamBytes !== id3FreeMpegBytes) {
    throw new Mp3MetadataError(
      `MP3 VBR stream byte count ${streamBytes} does not match the ID3-free MPEG span ${id3FreeMpegBytes}`,
    );
  }
}

function buildValidatedSeekPoints(options: {
  readonly sourceSize: number;
  readonly firstAudioFrameOffset: number;
  readonly audioEndByteOffset: number;
  readonly totalRawSamples: number;
  readonly samplesPerFrame: 576 | 1_152;
  readonly descriptors: readonly AudioFrameDescriptor[];
}): readonly MpegLayer3SeekIndexPoint[] {
  const first = validateFirstAudioDescriptor(options.descriptors, options.firstAudioFrameOffset);
  let index: MpegLayer3SeekIndex;
  try {
    index = new MpegLayer3SeekIndex({
      sourceSize: options.sourceSize,
      firstAudioFrameOffset: options.firstAudioFrameOffset,
      audioEndByteOffset: options.audioEndByteOffset,
      totalRawSamples: options.totalRawSamples,
      samplesPerFrame: options.samplesPerFrame,
      firstFrameMainDataCapacityBytes: first.mainDataCapacityBytes,
      firstFrameMainDataBeginBytes: first.mainDataBeginBytes,
      maxPoints: MP3_SEEK_INDEX_MAX_POINTS,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Mp3MetadataError(`MP3 frame-count geometry is invalid: ${error.message}`, error);
    }
    throw error;
  }

  for (const descriptor of options.descriptors.slice(1)) {
    if (
      !index.addVerifiedFrame(
        descriptor.rawSample,
        descriptor.byteOffset,
        descriptor.frameOrdinal,
        descriptor.mainDataCapacityBytes,
        descriptor.mainDataBeginBytes,
      )
    ) {
      throw new Mp3MetadataError(
        `MP3 verified seek seed ${descriptor.frameOrdinal} contradicts the declared stream geometry`,
      );
    }
  }
  return index.snapshot();
}

function validateDeclaredFrameCount(options: {
  readonly declaredFrames: number;
  readonly verifiedAudioFrames: number;
  readonly prefixComplete: boolean;
  readonly samplesPerFrame: 576 | 1_152;
}): number {
  const { declaredFrames, verifiedAudioFrames, prefixComplete, samplesPerFrame } = options;
  if (!Number.isSafeInteger(declaredFrames) || declaredFrames <= 0) {
    throw new Mp3MetadataError('MP3 declared audio frame count must be a positive safe integer');
  }
  if (
    prefixComplete ? declaredFrames !== verifiedAudioFrames : declaredFrames <= verifiedAudioFrames
  ) {
    throw new Mp3MetadataError(
      prefixComplete
        ? 'MP3 declared audio frame count does not match the fully verified physical span'
        : 'MP3 declared audio frame count does not extend beyond its verified prefix',
    );
  }
  return safeMultiply(declaredFrames, samplesPerFrame, 'MP3 declared raw sample count');
}

function validateSelectedScan(options: {
  readonly scan: MpegLayer3FrameScanResult;
  readonly descriptors: readonly AudioFrameDescriptor[];
  readonly hasTagFrame: boolean;
  readonly audioFrameCount: number;
}): void {
  const expectedPhysicalCount = safeAdd(
    options.audioFrameCount,
    options.hasTagFrame ? 1 : 0,
    'MP3 physical frame count',
  );
  if (options.scan.complete && options.scan.frameCount !== expectedPhysicalCount) {
    throw new Mp3MetadataError(
      'MP3 physical frame count disagrees with its normalized audio count',
    );
  }
  if (options.descriptors.length === 0) {
    throw new Mp3MetadataError('MP3 tag frame is not followed by an audio frame');
  }
}

/**
 * Read strict bounded MP3 metadata without taking ownership of the source.
 *
 * A recognized Xing/Info/VBRI first frame is structural metadata and is never
 * exposed as PCM frame zero. Declared counts can establish the media timeline,
 * but only synchronously scanner-verified coordinates become exact seek seeds.
 */
export async function readMp3Metadata(
  source: EncodedAudioSource,
  signal: AbortSignal,
): Promise<Mp3Metadata> {
  if (!source || typeof source !== 'object') {
    throw new TypeError('MP3 metadata requires an encoded audio source');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('MP3 metadata signal must be an AbortSignal');
  }
  const sourceBinding = snapshotSourceBinding(source);
  const sourceSize = sourceBinding.sourceSize;
  throwIfAborted(signal);

  const id3 = await readMp3Id3Boundaries(source, signal);
  throwIfAborted(signal);
  const prefixPhysicalFrames: MpegLayer3VerifiedFrame[] = [];
  const prefix = await scanMpegLayer3Frames(source, id3, signal, {
    maxFrames: MP3_METADATA_PREFIX_PHYSICAL_FRAMES,
    onVerifiedFrame: (frame) => prefixPhysicalFrames.push(frame),
  });
  throwIfAborted(signal);

  const vbr = parseVbr(prefix);
  const hasTagFrame = vbr !== null;
  const physicalOrdinalBase: 0 | 1 = hasTagFrame ? 1 : 0;
  const tagFrameBytes = hasTagFrame ? prefix.firstHeader.frameLengthBytes : 0;
  const firstAudioFrameOffset = safeAdd(id3.dataStart, tagFrameBytes, 'MP3 first audio offset');
  const id3FreeMpegBytes = id3.audioEnd - id3.dataStart;
  const audioBytes = id3.audioEnd - firstAudioFrameOffset;
  if (audioBytes <= 0) {
    throw new Mp3MetadataError('MP3 tag frame is not followed by an audio frame');
  }
  validateStreamByteDeclaration(vbr, id3FreeMpegBytes);

  const prefixDescriptors = audioDescriptorsFromPrefix(prefixPhysicalFrames, hasTagFrame);
  validateFirstAudioDescriptor(prefixDescriptors, firstAudioFrameOffset);
  const declaredFrames = declaredAudioFrameCount(vbr);
  let selected: SelectedScan;

  if (prefix.complete) {
    const exactFrames = prefix.frameCount - physicalOrdinalBase;
    if (exactFrames <= 0) {
      throw new Mp3MetadataError('MP3 tag frame is not followed by an audio frame');
    }
    if (declaredFrames !== null) {
      validateDeclaredFrameCount({
        declaredFrames,
        verifiedAudioFrames: exactFrames,
        prefixComplete: true,
        samplesPerFrame: prefix.samplesPerFrame,
      });
    }
    selected = Object.freeze({
      scan: prefix,
      descriptors: prefixDescriptors,
      audioFrameCount: exactFrames,
      evidence: 'verified-scan' as const,
    });
  } else if (declaredFrames !== null && vbr !== null) {
    validateDeclaredFrameCount({
      declaredFrames,
      verifiedAudioFrames: prefixDescriptors.length,
      prefixComplete: false,
      samplesPerFrame: prefix.samplesPerFrame,
    });
    selected = Object.freeze({
      scan: prefix,
      descriptors: prefixDescriptors,
      audioFrameCount: declaredFrames,
      evidence: declarationEvidence(vbr),
    });
  } else {
    const collector = new BoundedSeekSeedCollector();
    let fullPhysicalPrefixIndex = 0;
    const full = await scanMpegLayer3Frames(source, id3, signal, {
      onVerifiedFrame: (frame) => {
        const prefixFrame = prefixPhysicalFrames[fullPhysicalPrefixIndex];
        if (prefixFrame && !sameVerifiedFrame(prefixFrame, frame)) {
          throw new Mp3MetadataError('MP3 encoded source changed between bounded metadata scans');
        }
        fullPhysicalPrefixIndex += 1;
        collector.add(frame, physicalOrdinalBase);
      },
    });
    throwIfAborted(signal);
    if (!sameBytes(prefix.firstFrame, full.firstFrame)) {
      throw new Mp3MetadataError('MP3 encoded source changed between bounded metadata scans');
    }
    const exactFrames = full.frameCount - physicalOrdinalBase;
    if (!full.complete || exactFrames <= 0 || collector.count !== exactFrames) {
      throw new Mp3MetadataError('MP3 full frame scan did not prove a complete audio span');
    }
    selected = Object.freeze({
      scan: full,
      descriptors: collector.snapshot(),
      audioFrameCount: exactFrames,
      evidence: 'verified-scan' as const,
    });
  }

  validateSelectedScan({
    scan: selected.scan,
    descriptors: selected.descriptors,
    hasTagFrame,
    audioFrameCount: selected.audioFrameCount,
  });
  const selectedFirstAudioDescriptor = validateFirstAudioDescriptor(
    selected.descriptors,
    firstAudioFrameOffset,
  );
  const totalRawSamples = safeMultiply(
    selected.audioFrameCount,
    prefix.samplesPerFrame,
    'MP3 raw sample count',
  );
  const seekPoints = buildValidatedSeekPoints({
    sourceSize,
    firstAudioFrameOffset,
    audioEndByteOffset: id3.audioEnd,
    totalRawSamples,
    samplesPerFrame: prefix.samplesPerFrame,
    descriptors: selected.descriptors,
  });

  const gapless = vbr?.kind === 'xing' ? vbr.gapless : null;
  let totalMediaFrames: number;
  try {
    totalMediaFrames = createMp3SampleTimeline({
      totalRawSamples,
      samplesPerFrame: prefix.samplesPerFrame,
      gapless,
    }).totalMediaFrames;
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new Mp3MetadataError(`MP3 sample timeline is invalid: ${error.message}`, error);
    }
    throw error;
  }

  const verifiedAudioFrameCount = selected.scan.frameCount - physicalOrdinalBase;
  const verifiedAudioBytes = selected.scan.next.byteOffset - firstAudioFrameOffset;
  if (
    !Number.isSafeInteger(verifiedAudioFrameCount) ||
    verifiedAudioFrameCount <= 0 ||
    !Number.isSafeInteger(verifiedAudioBytes) ||
    verifiedAudioBytes <= 0
  ) {
    throw new Mp3MetadataError('MP3 verified audio prefix has invalid normalized coordinates');
  }

  throwIfAborted(signal);
  assertSourceBindingStable(source, sourceBinding);
  const result: Readonly<Mp3Metadata> = Object.freeze({
    format: 'mp3' as const,
    id3,
    vbr,
    gapless,
    version: prefix.version,
    sampleRateHz: prefix.sampleRateHz,
    channels: prefix.channelCount,
    samplesPerFrame: prefix.samplesPerFrame,
    firstAudioFrameHeader: selectedFirstAudioDescriptor.header,
    hasTagFrame,
    tagFrameOffset: hasTagFrame ? id3.dataStart : null,
    tagFrameBytes,
    firstAudioFrameOffset,
    audioEndByteOffset: id3.audioEnd,
    id3FreeMpegBytes,
    audioBytes,
    physicalFrameCount: safeAdd(
      selected.audioFrameCount,
      physicalOrdinalBase,
      'MP3 physical frame count',
    ),
    audioFrameCount: selected.audioFrameCount,
    totalRawSamples,
    totalMediaFrames,
    durationSeconds: totalMediaFrames / prefix.sampleRateHz,
    frameCountEvidence: selected.evidence,
    fullyVerifiedFrameSpan: selected.scan.complete,
    verifiedAudioFrameCount,
    verifiedAudioBytes,
    seekPoints,
  });
  scannerIssuedMp3MetadataSources.set(result, sourceBinding);
  return result;
}
