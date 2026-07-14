import type { AdtsAacLcTimelineManifest } from '../manifests/codec-timeline-manifest.ts';
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
import { type AdtsSampleRateIndex } from './adts-header.ts';
import { ADTS_CORE_SAMPLES_PER_FRAME } from './frame-scanner.ts';
import {
  ADTS_MAX_FRAME_BYTES,
  AdtsIncrementalFrameReader,
  type AdtsCoreConfiguration,
  type AdtsIncrementalFrame,
} from './incremental-frame-reader.ts';
import type { AdtsSeekIndexPoint } from './seek-index.ts';

const OPTION_KEYS = Object.freeze(['manifest', 'signal', 'source'] as const);
const OPTION_KEY_SET: ReadonlySet<PropertyKey> = new Set(OPTION_KEYS);

export interface ReconstructAdtsManifestStructureOptions {
  /** Canonical data already obtained from an authority-owning outer layer. */
  readonly manifest: Readonly<AdtsAacLcTimelineManifest>;
  /** Borrowed exact media window. This function never closes it. */
  readonly source: EncodedRandomAccessSource;
  readonly signal: AbortSignal;
}

export interface AdtsManifestEndpointChecks {
  readonly firstFrameByteLength: number;
  readonly terminalFrameOrdinal: number;
  readonly terminalFrameByteOffset: number;
  readonly terminalFrameByteLength: number;
}

/**
 * Structurally reconstructed ADTS decoder timeline.
 *
 * This is deliberately not `AdtsFrameScanResult`: endpoint reads do not prove
 * the bytes between sparse manifest anchors, and this value carries no scanner
 * seal, live admission, lease, or decoder authority. An outer acquisition
 * owner must resolve its opaque live admission before calling this helper and
 * must compare `sourceIdentity` to the exact registry-acquired lease and issue
 * any downstream authority separately. The WebCodecs worker canary likewise
 * remains an outer-factory step; it may boundedly re-read the first frame.
 */
export interface AdtsManifestStructuralReconstruction {
  readonly evidenceKind: 'adts-manifest-structural-reconstruction';
  readonly authority: 'none';
  readonly sourceIdentity: string;
  readonly sourceSize: number;
  readonly coreConfiguration: Readonly<AdtsCoreConfiguration>;
  readonly coreSampleRateHz: number;
  readonly coreChannelCount: 1 | 2;
  readonly samplesPerFrame: typeof ADTS_CORE_SAMPLES_PER_FRAME;
  readonly frameCount: number;
  readonly totalCoreSamples: number;
  readonly audioEndByteOffset: number;
  readonly seekPoints: readonly Readonly<AdtsSeekIndexPoint>[];
  readonly endpointChecks: Readonly<AdtsManifestEndpointChecks>;
}

export class AdtsManifestStructuralReconstructionError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AdtsManifestStructuralReconstructionError';
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

interface SourceSnapshot {
  readonly authority: EncodedRandomAccessSource;
  readonly source: EncodedRandomAccessSource;
  readonly size: number;
  readonly identity: string;
}

function snapshotOptions(value: unknown): OptionsSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('ADTS manifest reconstruction options must be an exact data-only record');
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new TypeError('ADTS manifest reconstruction options could not be snapshotted', {
      cause: error,
    });
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== OPTION_KEYS.length || keys.some((key) => !OPTION_KEY_SET.has(key))) {
    throw new TypeError('ADTS manifest reconstruction options have missing or extra fields');
  }
  const readData = (key: (typeof OPTION_KEYS)[number]): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
      throw new TypeError(
        `ADTS manifest reconstruction ${key} must be an enumerable data property`,
      );
    }
    return descriptor.value;
  };
  return Object.freeze({
    manifest: readData('manifest'),
    signal: readData('signal'),
    source: readData('source'),
  });
}

function canonicalAdtsManifest(value: unknown): Readonly<AdtsAacLcTimelineManifest> {
  let parsed;
  try {
    parsed = parseCodecTimelineManifest(encodeCodecTimelineManifest(value));
  } catch (error) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS timeline manifest is not canonical',
      error,
    );
  }
  if (parsed.codec !== 'adts-aac-lc') {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS timeline reconstruction requires an ADTS AAC-LC manifest',
    );
  }
  return parsed;
}

function discoverableOwnDataValue(
  authority: EncodedRandomAccessSource,
  key: 'identity' | 'size',
): { readonly discovered: boolean; readonly value: unknown } {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(authority, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return Object.freeze({ discovered: false, value: undefined });
    }
    return Object.freeze({ discovered: true, value: descriptor.value });
  } catch {
    return Object.freeze({ discovered: false, value: undefined });
  }
}

function assertDiscoverableSourceStability(
  authority: EncodedRandomAccessSource,
  size: number,
  identity: string,
): void {
  const currentSize = discoverableOwnDataValue(authority, 'size');
  if (currentSize.discovered && currentSize.value !== size) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS encoded source size changed during manifest reconstruction',
    );
  }
  const currentIdentity = discoverableOwnDataValue(authority, 'identity');
  if (currentIdentity.discovered && currentIdentity.value !== identity) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS encoded source identity changed during manifest reconstruction',
    );
  }
}

function snapshotSource(value: unknown): SourceSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('ADTS manifest reconstruction requires an encoded source');
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
    throw new TypeError('ADTS encoded source could not be inspected safely', { cause: error });
  }
  validateExactRead(size, 0, 0);
  if (!isEncodedAudioSourceIdentity(identity)) {
    throw new TypeError('ADTS encoded source identity is invalid');
  }
  if (typeof readAt !== 'function' || typeof close !== 'function') {
    throw new TypeError('ADTS encoded source methods are invalid');
  }

  const source = Object.freeze({
    size,
    identity,
    async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
      assertDiscoverableSourceStability(authority, size, identity);
      try {
        return (await Reflect.apply(readAt, authority, [offset, length, signal])) as Uint8Array;
      } finally {
        assertDiscoverableSourceStability(authority, size, identity);
      }
    },
    // Readers borrow this facade. A future accidental close must not consume
    // the caller's source lease.
    async close(): Promise<void> {},
  });
  assertDiscoverableSourceStability(authority, size, identity);
  return Object.freeze({ authority, source, size, identity });
}

function configurationFromManifest(
  manifest: Readonly<AdtsAacLcTimelineManifest>,
): Readonly<AdtsCoreConfiguration> {
  return Object.freeze({
    mpegId: 0,
    profile: 1,
    coreAudioObjectType: 2,
    sampleRateIndex: manifest.sampleRateIndex as AdtsSampleRateIndex,
    channelConfiguration: manifest.channelConfiguration,
    protectionAbsent: true,
    rawDataBlocks: 1,
  });
}

function assertHeaderMatchesManifest(
  frame: Readonly<AdtsIncrementalFrame>,
  manifest: Readonly<AdtsAacLcTimelineManifest>,
  label: string,
): void {
  const header = frame.descriptor.header;
  if (
    header.mpegId !== manifest.mpegId ||
    header.profile !== manifest.profile ||
    header.coreAudioObjectType !== manifest.audioObjectType ||
    header.sampleRateIndex !== manifest.sampleRateIndex ||
    header.coreSampleRateHz !== manifest.sampleRateHz ||
    header.channelConfiguration !== manifest.channelConfiguration ||
    header.coreChannelCount !== manifest.channels ||
    header.protectionAbsent !== manifest.protectionAbsent ||
    header.rawDataBlocks !== manifest.rawDataBlocks ||
    frame.bytes.byteLength !== header.frameLengthBytes
  ) {
    throw new AdtsManifestStructuralReconstructionError(
      `${label} ADTS frame contradicts the canonical timeline manifest`,
    );
  }
}

async function readFirstFrame(
  source: EncodedRandomAccessSource,
  manifest: Readonly<AdtsAacLcTimelineManifest>,
  configuration: Readonly<AdtsCoreConfiguration>,
  signal: AbortSignal,
): Promise<Readonly<AdtsIncrementalFrame>> {
  const reader = new AdtsIncrementalFrameReader({
    source,
    expectedConfig: configuration,
    pageBytes: ADTS_MAX_FRAME_BYTES,
  });
  const frame = await reader.readNext(signal);
  throwIfAborted(signal);
  if (
    !frame ||
    frame.descriptor.frameOrdinal !== 0 ||
    frame.descriptor.byteOffset !== manifest.audioStartByte
  ) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS manifest origin does not resolve to its declared first frame',
    );
  }
  assertHeaderMatchesManifest(frame, manifest, 'First');
  return frame;
}

async function readTerminalFrame(
  source: EncodedRandomAccessSource,
  terminalPoint: Readonly<AdtsSeekIndexPoint>,
  configuration: Readonly<AdtsCoreConfiguration>,
  signal: AbortSignal,
): Promise<Readonly<AdtsIncrementalFrame>> {
  const reader = new AdtsIncrementalFrameReader({
    source,
    start: terminalPoint,
    expectedConfig: configuration,
    pageBytes: ADTS_MAX_FRAME_BYTES,
  });
  const frame = await reader.readNext(signal);
  throwIfAborted(signal);
  if (
    !frame ||
    frame.descriptor.frameOrdinal !== terminalPoint.frameOrdinal ||
    frame.descriptor.byteOffset !== terminalPoint.byteOffset
  ) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS terminal manifest point does not resolve to its declared frame',
    );
  }
  return frame;
}

/**
 * Reconstruct bounded structural data after at most two source reads of at
 * most 8,191 bytes each. This function verifies endpoint bytes only; its
 * return value is never sufficient proof of a fully verified frame span.
 */
export async function reconstructAdtsManifestStructure(
  optionsValue: ReconstructAdtsManifestStructureOptions,
): Promise<Readonly<AdtsManifestStructuralReconstruction>> {
  const options = snapshotOptions(optionsValue);
  if (!(options.signal instanceof AbortSignal)) {
    throw new TypeError('ADTS manifest reconstruction signal must be an AbortSignal');
  }
  const signal = options.signal;
  throwIfAborted(signal);
  const manifest = canonicalAdtsManifest(options.manifest);
  const source = snapshotSource(options.source);
  if (source.size !== manifest.sourceSize) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS manifest sourceSize does not match the exact encoded source',
    );
  }

  const configuration = configurationFromManifest(manifest);
  const first = await readFirstFrame(source.source, manifest, configuration, signal);
  assertDiscoverableSourceStability(source.authority, source.size, source.identity);

  const terminalPoint = manifest.points.at(-1);
  if (!terminalPoint) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS manifest lacks its terminal frame point',
    );
  }
  if (manifest.frameCount > 1 && first.descriptor.byteEndOffset > terminalPoint.byteOffset) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS first and terminal manifest frames overlap',
    );
  }
  const secondPoint = manifest.points.find((point) => point.frameOrdinal === 1);
  if (secondPoint && secondPoint.byteOffset !== first.descriptor.byteEndOffset) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS first frame end contradicts the retained second-frame boundary',
    );
  }
  let terminal = first;
  if (terminalPoint.frameOrdinal !== 0 || terminalPoint.byteOffset !== 0) {
    terminal = await readTerminalFrame(source.source, terminalPoint, configuration, signal);
    assertHeaderMatchesManifest(terminal, manifest, 'Terminal');
  }
  throwIfAborted(signal);
  assertDiscoverableSourceStability(source.authority, source.size, source.identity);

  if (terminal.descriptor.byteEndOffset !== manifest.audioEndByte) {
    throw new AdtsManifestStructuralReconstructionError(
      'ADTS terminal frame does not end exactly at physical EOF',
    );
  }

  const seekPoints = Object.freeze(
    manifest.points.map((point) =>
      Object.freeze({ frameOrdinal: point.frameOrdinal, byteOffset: point.byteOffset }),
    ),
  );
  const totalCoreSamples = manifest.frameCount * ADTS_CORE_SAMPLES_PER_FRAME;
  const endpointChecks = Object.freeze({
    firstFrameByteLength: first.bytes.byteLength,
    terminalFrameOrdinal: terminalPoint.frameOrdinal,
    terminalFrameByteOffset: terminalPoint.byteOffset,
    terminalFrameByteLength: terminal.bytes.byteLength,
  });
  return Object.freeze({
    evidenceKind: 'adts-manifest-structural-reconstruction',
    authority: 'none',
    sourceIdentity: source.identity,
    sourceSize: source.size,
    coreConfiguration: configuration,
    coreSampleRateHz: manifest.sampleRateHz,
    coreChannelCount: manifest.channels,
    samplesPerFrame: ADTS_CORE_SAMPLES_PER_FRAME,
    frameCount: manifest.frameCount,
    totalCoreSamples,
    audioEndByteOffset: manifest.audioEndByte,
    seekPoints,
    endpointChecks,
  });
}
