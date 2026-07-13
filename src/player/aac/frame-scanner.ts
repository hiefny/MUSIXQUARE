import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import type { AdtsHeader } from './adts-header.ts';
import {
  AdtsIncrementalFrameReader,
  type AdtsCoreConfiguration,
} from './incremental-frame-reader.ts';
import {
  ADTS_SEEK_INDEX_MAX_POINTS,
  AdtsSeekIndex,
  type AdtsSeekIndexPoint,
} from './seek-index.ts';

export const ADTS_CORE_SAMPLES_PER_FRAME = 1_024;

const OPTION_KEYS = Object.freeze(['pageBytes', 'maxSeekPoints'] as const);
const OPTION_KEY_SET: ReadonlySet<PropertyKey> = new Set(OPTION_KEYS);

export interface AdtsFrameScanOptions {
  /** Transport page size forwarded to the bounded incremental reader. */
  readonly pageBytes?: number;
  /** Retained seek-coordinate bound, never greater than 8,192. */
  readonly maxSeekPoints?: number;
}

export interface AdtsFrameScanResult {
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
  readonly fullyVerifiedFrameSpan: true;
}

export class AdtsFrameScanError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AdtsFrameScanError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

interface OptionsSnapshot {
  readonly pageBytes: unknown;
  readonly maxSeekPoints: unknown;
}

interface SourceSnapshot {
  readonly authority: EncodedAudioSource;
  readonly size: number;
  readonly identity: string;
  readonly readerSource: EncodedAudioSource;
}

function snapshotOptions(value: unknown): OptionsSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('ADTS frame scan options must be an exact data-only record');
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new TypeError('ADTS frame scan options could not be snapshotted', { cause: error });
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => !OPTION_KEY_SET.has(key))) {
    throw new TypeError('ADTS frame scan options contain an unsupported field');
  }

  const readDataField = (key: (typeof OPTION_KEYS)[number]): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) {
      throw new TypeError(`ADTS frame scan ${key} must be a data property`);
    }
    return descriptor.value;
  };
  return Object.freeze({
    pageBytes: readDataField('pageBytes'),
    maxSeekPoints: readDataField('maxSeekPoints'),
  });
}

function requireOptionalSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AdtsFrameScanError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function discoverableOwnDataValue(
  authority: EncodedAudioSource,
  key: 'size' | 'identity',
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
  authority: EncodedAudioSource,
  size: number,
  identity: string,
): void {
  const currentSize = discoverableOwnDataValue(authority, 'size');
  if (currentSize.discovered && currentSize.value !== size) {
    throw new AdtsFrameScanError('ADTS encoded source size changed during its verified scan');
  }
  const currentIdentity = discoverableOwnDataValue(authority, 'identity');
  if (currentIdentity.discovered && currentIdentity.value !== identity) {
    throw new AdtsFrameScanError('ADTS encoded source identity changed during its verified scan');
  }
}

function snapshotSource(value: unknown): SourceSnapshot {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('ADTS frame scan requires an encoded source');
  }

  const authority = value as EncodedAudioSource;
  let size: number;
  let identity: string;
  let readAt: EncodedAudioSource['readAt'];
  let close: EncodedAudioSource['close'];
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

  const readerSource = Object.freeze({
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
    // The facade is private to this scan. The incremental reader never closes
    // it, and a future accidental close still cannot consume caller ownership.
    async close(): Promise<void> {},
  }) as unknown as EncodedAudioSource;

  const snapshot = Object.freeze({ authority, size, identity, readerSource });
  assertDiscoverableSourceStability(authority, size, identity);
  return snapshot;
}

interface FirstFrameCoreMetadata {
  readonly configuration: Readonly<AdtsCoreConfiguration>;
  readonly coreSampleRateHz: number;
  readonly coreChannelCount: 1 | 2;
}

function metadataFromFirstFrame(header: Readonly<AdtsHeader>): FirstFrameCoreMetadata {
  if (
    (header.channelConfiguration !== 1 && header.channelConfiguration !== 2) ||
    (header.coreChannelCount !== 1 && header.coreChannelCount !== 2) ||
    header.channelConfiguration !== header.coreChannelCount
  ) {
    throw new AdtsFrameScanError('ADTS reader admitted inconsistent core channel geometry');
  }
  const configuration: Readonly<AdtsCoreConfiguration> = Object.freeze({
    mpegId: 0,
    profile: 1,
    coreAudioObjectType: 2,
    sampleRateIndex: header.sampleRateIndex,
    channelConfiguration: header.channelConfiguration,
    protectionAbsent: true,
    rawDataBlocks: 1,
  });
  return Object.freeze({
    configuration,
    coreSampleRateHz: header.coreSampleRateHz,
    coreChannelCount: header.coreChannelCount,
  });
}

/**
 * Fully verify one raw, metadata-free ADTS byte source from zero to physical EOF.
 *
 * Encoded frame bytes are discarded after each iteration. The returned state
 * contains only immutable scalar metadata and a deterministically bounded set
 * of scanner-verified access-unit coordinates. The source remains caller-owned.
 */
export async function scanAdtsFrames(
  source: EncodedAudioSource,
  signal: AbortSignal,
  options: AdtsFrameScanOptions = {},
): Promise<AdtsFrameScanResult> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('ADTS frame scan signal must be an AbortSignal');
  }
  const input = snapshotOptions(options);
  const pageBytes = requireOptionalSafeInteger(input.pageBytes, 7, 64 * 1_024, 'ADTS pageBytes');
  const maxSeekPoints = requireOptionalSafeInteger(
    input.maxSeekPoints,
    2,
    ADTS_SEEK_INDEX_MAX_POINTS,
    'ADTS maxSeekPoints',
  );
  const sourceSnapshot = snapshotSource(source);
  throwIfAborted(signal);

  const reader = new AdtsIncrementalFrameReader({
    source: sourceSnapshot.readerSource,
    ...(pageBytes === undefined ? {} : { pageBytes }),
  });
  const indexOrigin = { frameOrdinal: 0, byteOffset: 0 } as const;
  const seekIndex =
    maxSeekPoints === undefined
      ? new AdtsSeekIndex(indexOrigin)
      : new AdtsSeekIndex(indexOrigin, { maxPoints: maxSeekPoints });
  let coreConfiguration: Readonly<AdtsCoreConfiguration> | null = null;
  let coreSampleRateHz = 0;
  let coreChannelCount: 1 | 2 | null = null;
  let frameCount = 0;
  let totalCoreSamples = 0;
  let audioEndByteOffset = 0;

  for (;;) {
    throwIfAborted(signal);
    const frame = await reader.readNext(signal);
    throwIfAborted(signal);
    if (frame === null) break;

    const { descriptor } = frame;
    if (descriptor.frameOrdinal !== frameCount) {
      throw new AdtsFrameScanError('ADTS reader returned a non-contiguous frame ordinal');
    }
    if (descriptor.byteOffset !== audioEndByteOffset) {
      throw new AdtsFrameScanError('ADTS reader returned a non-contiguous frame byte boundary');
    }
    if (frameCount > 0) {
      const appended = seekIndex.appendVerified({
        frameOrdinal: descriptor.frameOrdinal,
        byteOffset: descriptor.byteOffset,
      });
      if (!appended) {
        throw new AdtsFrameScanError('ADTS verified seek coordinate could not be indexed');
      }
    }

    if (coreConfiguration === null) {
      const coreMetadata = metadataFromFirstFrame(descriptor.header);
      coreConfiguration = coreMetadata.configuration;
      coreSampleRateHz = coreMetadata.coreSampleRateHz;
      coreChannelCount = coreMetadata.coreChannelCount;
    }
    frameCount = safeAdd(frameCount, 1, 'ADTS frame count');
    totalCoreSamples = safeAdd(
      totalCoreSamples,
      ADTS_CORE_SAMPLES_PER_FRAME,
      'ADTS total core sample count',
    );
    audioEndByteOffset = descriptor.byteEndOffset;
  }

  throwIfAborted(signal);
  assertDiscoverableSourceStability(
    sourceSnapshot.authority,
    sourceSnapshot.size,
    sourceSnapshot.identity,
  );
  if (coreConfiguration === null || coreChannelCount === null || frameCount === 0) {
    throw new AdtsFrameScanError('ADTS source does not contain a verified AAC access unit');
  }
  if (audioEndByteOffset !== sourceSnapshot.size) {
    throw new AdtsFrameScanError('ADTS verified frame span does not reach physical EOF');
  }

  const seekPoints = seekIndex.snapshot();
  return Object.freeze({
    sourceIdentity: sourceSnapshot.identity,
    sourceSize: sourceSnapshot.size,
    coreConfiguration,
    coreSampleRateHz,
    coreChannelCount,
    samplesPerFrame: ADTS_CORE_SAMPLES_PER_FRAME,
    frameCount,
    totalCoreSamples,
    audioEndByteOffset,
    seekPoints,
    fullyVerifiedFrameSpan: true,
  });
}
