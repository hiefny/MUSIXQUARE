import {
  isScannerIssuedAdtsFrameScanResult,
  type AdtsFrameScanResult,
} from '../aac/frame-scanner.ts';
import { scannerIssuedMp3MetadataSource, type Mp3Metadata } from '../mp3/metadata.ts';
import {
  encodeCodecTimelineManifest,
  parseCodecTimelineManifest,
  type AdtsAacLcTimelineManifest,
  type CodecTimelineManifest,
  type Mp3NoFrameCountTimelineManifest,
} from './codec-timeline-manifest.ts';

export interface CodecTimelineManifestSeal {
  readonly codec: CodecTimelineManifest['codec'];
  readonly sourceIdentity: string;
  readonly sourceSize: number;
  readonly byteLength: number;
  /** Return a fresh copy. The seal never exposes its owned manifest bytes. */
  copyBytes(): Uint8Array;
}

export class CodecTimelineManifestSealError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CodecTimelineManifestSealError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

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

const ownedBytesBySeal = new WeakMap<object, Uint8Array>();

class FrozenCodecTimelineManifestSeal implements CodecTimelineManifestSeal {
  constructor(
    readonly codec: CodecTimelineManifest['codec'],
    readonly sourceIdentity: string,
    readonly sourceSize: number,
    readonly byteLength: number,
  ) {
    Object.freeze(this);
  }

  copyBytes(): Uint8Array {
    const owned = ownedBytesBySeal.get(this);
    if (!owned) throw new TypeError('Codec timeline manifest seal receiver is not authentic');
    const copy = new Uint8ArrayIntrinsic(owned.byteLength);
    uint8ArraySet.call(copy, owned, 0);
    return copy;
  }
}

Object.freeze(FrozenCodecTimelineManifestSeal.prototype);

function createOpaqueSeal(
  codec: CodecTimelineManifest['codec'],
  sourceIdentity: string,
  sourceSize: number,
  ownedBytes: Uint8Array,
): CodecTimelineManifestSeal {
  const seal = new FrozenCodecTimelineManifestSeal(
    codec,
    sourceIdentity,
    sourceSize,
    ownedBytes.byteLength,
  );
  // Registration is deliberately outside the escaped class constructor. An
  // attacker may reach `seal.constructor`, but only this module-private factory
  // can associate an instance with authentic owned bytes.
  ownedBytesBySeal.set(seal, ownedBytes);
  return seal;
}

function fail(message: string, cause?: unknown): never {
  throw new CodecTimelineManifestSealError(message, cause);
}

function snapshotSourceBindingSha256(value: unknown): readonly number[] {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new TypeError('sourceBindingSha256 must be an exact Uint8Array');
  }

  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('sourceBindingSha256 must be an exact Uint8Array');
    }
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // Reject SharedArrayBuffer: concurrent writes cannot produce one coherent
    // binding snapshot. Detached storage also fails here or in the exact copy.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (error) {
    throw new TypeError('sourceBindingSha256 must use readable, local, non-shared storage', {
      cause: error,
    });
  }
  if (byteLength !== 32) {
    throw new RangeError('sourceBindingSha256 must contain exactly 32 bytes');
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (error) {
    throw new TypeError('sourceBindingSha256 could not be copied exactly', { cause: error });
  }
  return Object.freeze(Array.from(owned));
}

function sameBytes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertCommonEquivalent(
  parsed: CodecTimelineManifest,
  digest: readonly number[],
  sourceSize: number,
  audioStartByte: number,
  audioEndByte: number,
  frameCount: number,
  sampleRateHz: number,
  samplesPerFrame: number,
  channels: 1 | 2,
): void {
  if (
    !sameBytes(parsed.sourceBindingSha256, digest) ||
    parsed.sourceSize !== sourceSize ||
    parsed.audioStartByte !== audioStartByte ||
    parsed.audioEndByte !== audioEndByte ||
    parsed.frameCount !== frameCount ||
    parsed.sampleRateHz !== sampleRateHz ||
    parsed.samplesPerFrame !== samplesPerFrame ||
    parsed.channels !== channels
  ) {
    fail('Encoded timeline manifest does not reconstruct its scanner-issued common timeline');
  }
}

function assertAdtsEquivalent(
  parsed: CodecTimelineManifest,
  scan: Readonly<AdtsFrameScanResult>,
  digest: readonly number[],
): asserts parsed is AdtsAacLcTimelineManifest {
  const configuration = scan.coreConfiguration;
  assertCommonEquivalent(
    parsed,
    digest,
    scan.sourceSize,
    0,
    scan.audioEndByteOffset,
    scan.frameCount,
    scan.coreSampleRateHz,
    scan.samplesPerFrame,
    scan.coreChannelCount,
  );
  if (
    parsed.codec !== 'adts-aac-lc' ||
    parsed.mpegId !== configuration.mpegId ||
    parsed.profile !== configuration.profile ||
    parsed.audioObjectType !== configuration.coreAudioObjectType ||
    parsed.sampleRateIndex !== configuration.sampleRateIndex ||
    parsed.channelConfiguration !== configuration.channelConfiguration ||
    parsed.protectionAbsent !== configuration.protectionAbsent ||
    parsed.rawDataBlocks !== configuration.rawDataBlocks ||
    parsed.points.length !== scan.seekPoints.length ||
    parsed.points.some((point, index) => {
      const expected = scan.seekPoints[index];
      return (
        !expected ||
        point.frameOrdinal !== expected.frameOrdinal ||
        point.byteOffset !== expected.byteOffset
      );
    })
  ) {
    fail('Encoded ADTS manifest does not reconstruct its scanner-issued configuration and index');
  }
}

function assertMp3MetadataSealable(metadata: Readonly<Mp3Metadata>, sourceSize: number): void {
  if (
    metadata.frameCountEvidence !== 'verified-scan' ||
    metadata.fullyVerifiedFrameSpan !== true ||
    metadata.verifiedAudioFrameCount !== metadata.audioFrameCount ||
    metadata.verifiedAudioBytes !== metadata.audioBytes
  ) {
    fail('MP3 manifest sealing requires a fully verified no-count frame scan');
  }
  if (metadata.vbr !== null && metadata.vbr.frameCount !== null) {
    fail('MP3 manifest sealing rejects Xing, Info, or VBRI frame-count declarations');
  }
  if (
    metadata.id3.sourceBytes !== sourceSize ||
    metadata.id3.audioEnd !== metadata.audioEndByteOffset ||
    metadata.audioBytes !== metadata.audioEndByteOffset - metadata.firstAudioFrameOffset ||
    metadata.totalRawSamples !== metadata.audioFrameCount * metadata.samplesPerFrame ||
    metadata.physicalFrameCount !== metadata.audioFrameCount + (metadata.hasTagFrame ? 1 : 0) ||
    (metadata.hasTagFrame ? metadata.tagFrameBytes <= 0 : metadata.tagFrameBytes !== 0) ||
    metadata.tagFrameOffset !==
      (metadata.hasTagFrame ? metadata.firstAudioFrameOffset - metadata.tagFrameBytes : null) ||
    metadata.firstAudioFrameHeader.version !== metadata.version ||
    metadata.firstAudioFrameHeader.layer !== 3 ||
    metadata.firstAudioFrameHeader.sampleRateHz !== metadata.sampleRateHz ||
    metadata.firstAudioFrameHeader.channelCount !== metadata.channels ||
    metadata.firstAudioFrameHeader.samplesPerFrame !== metadata.samplesPerFrame
  ) {
    fail('MP3 scanner-issued metadata contradicts its exact source or timeline geometry');
  }
  for (const point of metadata.seekPoints) {
    if (point.rawSample !== point.frameOrdinal * metadata.samplesPerFrame) {
      fail('MP3 scanner-issued seek point contradicts its decoder sample coordinate');
    }
  }
}

function assertMp3Equivalent(
  parsed: CodecTimelineManifest,
  metadata: Readonly<Mp3Metadata>,
  digest: readonly number[],
  sourceSize: number,
): asserts parsed is Mp3NoFrameCountTimelineManifest {
  assertCommonEquivalent(
    parsed,
    digest,
    sourceSize,
    metadata.firstAudioFrameOffset,
    metadata.audioEndByteOffset,
    metadata.audioFrameCount,
    metadata.sampleRateHz,
    metadata.samplesPerFrame,
    metadata.channels,
  );
  if (
    parsed.codec !== 'mp3-no-frame-count' ||
    parsed.mpegVersion !== metadata.version ||
    parsed.layer !== metadata.firstAudioFrameHeader.layer ||
    parsed.hasFrameCountDeclaration !== false ||
    parsed.hasTagFrame !== metadata.hasTagFrame ||
    parsed.tagFrameBytes !== metadata.tagFrameBytes ||
    parsed.totalMediaFrames !== metadata.totalMediaFrames ||
    (parsed.gapless === null) !== (metadata.gapless === null) ||
    (parsed.gapless !== null &&
      metadata.gapless !== null &&
      (parsed.gapless.encoderDelaySamples !== metadata.gapless.encoderDelaySamples ||
        parsed.gapless.endPaddingSamples !== metadata.gapless.endPaddingSamples)) ||
    parsed.points.length !== metadata.seekPoints.length ||
    parsed.points.some((point, index) => {
      const expected = metadata.seekPoints[index];
      return (
        !expected ||
        point.frameOrdinal !== expected.frameOrdinal ||
        point.byteOffset !== expected.byteOffset ||
        point.mainDataCapacityBytes !== expected.mainDataCapacityBytes ||
        point.mainDataBeginBytes !== expected.mainDataBeginBytes
      );
    })
  ) {
    fail('Encoded MP3 manifest does not reconstruct its scanner-issued timeline and seek index');
  }
}

/** Seal one exact, scanner-issued raw ADTS EOF result. */
export function sealAdtsFrameScanTimelineManifest(
  scan: unknown,
  sourceBindingSha256: unknown,
): CodecTimelineManifestSeal {
  if (!isScannerIssuedAdtsFrameScanResult(scan)) {
    fail('ADTS manifest sealing requires the exact scanner-issued result object');
  }
  if (
    scan.fullyVerifiedFrameSpan !== true ||
    scan.audioEndByteOffset !== scan.sourceSize ||
    scan.totalCoreSamples !== scan.frameCount * scan.samplesPerFrame
  ) {
    fail('ADTS manifest sealing requires a complete scanner-verified EOF timeline');
  }
  const digest = snapshotSourceBindingSha256(sourceBindingSha256);
  const configuration = scan.coreConfiguration;
  const manifest: AdtsAacLcTimelineManifest = {
    manifestVersion: 1,
    codec: 'adts-aac-lc',
    sourceBindingSha256: digest,
    sourceSize: scan.sourceSize,
    audioStartByte: 0,
    audioEndByte: scan.audioEndByteOffset,
    frameCount: scan.frameCount,
    sampleRateHz: scan.coreSampleRateHz,
    samplesPerFrame: scan.samplesPerFrame,
    channels: scan.coreChannelCount,
    mpegId: configuration.mpegId,
    profile: configuration.profile,
    audioObjectType: configuration.coreAudioObjectType,
    sampleRateIndex: configuration.sampleRateIndex,
    channelConfiguration: configuration.channelConfiguration,
    protectionAbsent: configuration.protectionAbsent,
    rawDataBlocks: configuration.rawDataBlocks,
    points: scan.seekPoints.map((point) => ({
      frameOrdinal: point.frameOrdinal,
      byteOffset: point.byteOffset,
    })),
  };

  let encoded: Uint8Array;
  let parsed: CodecTimelineManifest;
  try {
    encoded = encodeCodecTimelineManifest(manifest);
    parsed = parseCodecTimelineManifest(encoded);
    assertAdtsEquivalent(parsed, scan, digest);
  } catch (error) {
    if (error instanceof CodecTimelineManifestSealError) throw error;
    fail('Scanner-issued ADTS timeline could not be canonically sealed', error);
  }
  return createOpaqueSeal(parsed.codec, scan.sourceIdentity, scan.sourceSize, encoded);
}

/** Seal one exact, scanner-issued, fully scanned MP3 no-count result. */
export function sealMp3MetadataTimelineManifest(
  metadata: unknown,
  sourceBindingSha256: unknown,
): CodecTimelineManifestSeal {
  const source = scannerIssuedMp3MetadataSource(metadata);
  if (!source) {
    fail('MP3 manifest sealing requires the exact scanner-issued metadata object');
  }
  const issued = metadata as Readonly<Mp3Metadata>;
  assertMp3MetadataSealable(issued, source.sourceSize);
  const digest = snapshotSourceBindingSha256(sourceBindingSha256);
  const manifest: Mp3NoFrameCountTimelineManifest = {
    manifestVersion: 1,
    codec: 'mp3-no-frame-count',
    sourceBindingSha256: digest,
    sourceSize: source.sourceSize,
    audioStartByte: issued.firstAudioFrameOffset,
    audioEndByte: issued.audioEndByteOffset,
    frameCount: issued.audioFrameCount,
    sampleRateHz: issued.sampleRateHz,
    samplesPerFrame: issued.samplesPerFrame,
    channels: issued.channels,
    mpegVersion: issued.version,
    layer: 3,
    hasFrameCountDeclaration: false,
    hasTagFrame: issued.hasTagFrame,
    tagFrameBytes: issued.tagFrameBytes,
    gapless:
      issued.gapless === null
        ? null
        : {
            encoderDelaySamples: issued.gapless.encoderDelaySamples,
            endPaddingSamples: issued.gapless.endPaddingSamples,
          },
    totalMediaFrames: issued.totalMediaFrames,
    points: issued.seekPoints.map((point) => ({
      frameOrdinal: point.frameOrdinal,
      byteOffset: point.byteOffset,
      mainDataCapacityBytes: point.mainDataCapacityBytes,
      mainDataBeginBytes: point.mainDataBeginBytes,
    })),
  };

  let encoded: Uint8Array;
  let parsed: CodecTimelineManifest;
  try {
    encoded = encodeCodecTimelineManifest(manifest);
    parsed = parseCodecTimelineManifest(encoded);
    assertMp3Equivalent(parsed, issued, digest, source.sourceSize);
  } catch (error) {
    if (error instanceof CodecTimelineManifestSealError) throw error;
    fail('Scanner-issued MP3 timeline could not be canonically sealed', error);
  }
  return createOpaqueSeal(parsed.codec, source.sourceIdentity, source.sourceSize, encoded);
}
