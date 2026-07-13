import { describe, expect, it, vi } from 'vitest';

import {
  AIFF_MAX_CHUNKS,
  AIFF_MAX_METADATA_READ_BYTES,
  UnsupportedAiffCodecError,
  UnsupportedAiffContainerError,
  readAiffPcmMetadata,
} from '../metadata.ts';
import {
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';

const AIFC_VERSION = 0xa280_5140;
const EXTENDED_BIAS = 16_383;

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function be16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

function be32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function extendedParts(signAndExponent: number, significand: bigint): Uint8Array {
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, signAndExponent, false);
  view.setBigUint64(2, significand, false);
  return bytes;
}

function extendedInteger(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('invalid fixture rate');
  const highestBit = Math.floor(Math.log2(value));
  return extendedParts(EXTENDED_BIAS + highestBit, BigInt(value) << BigInt(63 - highestBit));
}

function iffChunk(id: string, body: Uint8Array, paddingByte = 0): Uint8Array {
  return concat(
    ascii(id),
    be32(body.byteLength),
    body,
    body.byteLength % 2 === 0 ? new Uint8Array() : Uint8Array.of(paddingByte),
  );
}

function form(type: 'AIFF' | 'AIFC' | string, chunks: readonly Uint8Array[]): Uint8Array {
  const body = concat(ascii(type), ...chunks);
  return concat(ascii('FORM'), be32(body.byteLength), body);
}

interface CommonOptions {
  readonly channels?: number;
  readonly frames?: number;
  readonly sampleSize?: number;
  readonly sampleRate?: number;
  readonly rateBytes?: Uint8Array;
}

function commonPrefix(options: CommonOptions = {}): Uint8Array {
  return concat(
    be16(options.channels ?? 2),
    be32(options.frames ?? 4),
    be16(options.sampleSize ?? 16),
    options.rateBytes ?? extendedInteger(options.sampleRate ?? 48_000),
  );
}

function aiffCommon(options: CommonOptions = {}): Uint8Array {
  return commonPrefix(options);
}

interface AifcCommonOptions extends CommonOptions {
  readonly compressionType?: string;
  readonly compressionName?: string;
  readonly paddingByte?: number;
}

function aifcCommon(options: AifcCommonOptions = {}): Uint8Array {
  const compressionName = options.compressionName ?? 'PCM';
  const name = ascii(compressionName);
  const rawPascal = concat(Uint8Array.of(name.byteLength), name);
  const paddedPascal =
    rawPascal.byteLength % 2 === 0
      ? rawPascal
      : concat(rawPascal, Uint8Array.of(options.paddingByte ?? 0));
  return concat(commonPrefix(options), ascii(options.compressionType ?? 'NONE'), paddedPascal);
}

function versionChunk(version = AIFC_VERSION): Uint8Array {
  return iffChunk('FVER', be32(version));
}

function soundData(
  dataBytes: number,
  options: { readonly offset?: number; readonly blockSize?: number } = {},
): Uint8Array {
  const offset = options.offset ?? 0;
  return concat(
    be32(offset),
    be32(options.blockSize ?? 0),
    new Uint8Array(offset),
    new Uint8Array(dataBytes),
  );
}

interface FixtureOptions extends CommonOptions {
  readonly container?: 'AIFF' | 'AIFC';
  readonly compressionType?: string;
  readonly compressionName?: string;
  readonly dataBytes?: number;
  readonly ssndOffset?: number;
  readonly ssndBlockSize?: number;
  readonly before?: readonly Uint8Array[];
}

function fixture(options: FixtureOptions = {}): Uint8Array {
  const container = options.container ?? 'AIFF';
  const channels = options.channels ?? 2;
  const frames = options.frames ?? 4;
  const sampleSize = options.sampleSize ?? 16;
  const dataBytes = options.dataBytes ?? frames * channels * Math.ceil(sampleSize / 8);
  const commonOptions = {
    channels,
    frames,
    sampleSize,
    sampleRate: options.sampleRate,
    rateBytes: options.rateBytes,
  };
  const comm =
    container === 'AIFF'
      ? aiffCommon(commonOptions)
      : aifcCommon({
          ...commonOptions,
          compressionType: options.compressionType,
          compressionName: options.compressionName,
        });
  return form(container, [
    ...(options.before ?? []),
    ...(container === 'AIFC' ? [versionChunk()] : []),
    iffChunk('COMM', comm),
    iffChunk(
      'SSND',
      soundData(dataBytes, {
        offset: options.ssndOffset,
        blockSize: options.ssndBlockSize,
      }),
    ),
  ]);
}

function sourceFrom(bytes: Uint8Array, identity = 'aiff-fixture'): EncodedAudioSource {
  return {
    kind: 'blob',
    size: bytes.byteLength,
    identity,
    metadata: { name: `${identity}.aiff`, mime: 'audio/aiff' },
    async readAt(offset, length, signal) {
      validateExactRead(bytes.byteLength, offset, length);
      throwIfAborted(signal);
      return bytes.slice(offset, offset + length);
    },
    async close() {},
  };
}

async function parse(bytes: Uint8Array) {
  return readAiffPcmMetadata(sourceFrom(bytes), new AbortController().signal);
}

function replaceChunkBody(container: 'AIFF' | 'AIFC', chunks: readonly Uint8Array[]): Uint8Array {
  return form(container, chunks);
}

describe('readAiffPcmMetadata', () => {
  it.each([
    [1, 'pcm-s8', 8],
    [8, 'pcm-s8', 8],
    [9, 'pcm-s16be', 16],
    [12, 'pcm-s16be', 16],
    [16, 'pcm-s16be', 16],
    [17, 'pcm-s24be', 24],
    [20, 'pcm-s24be', 24],
    [24, 'pcm-s24be', 24],
    [25, 'pcm-s32be', 32],
    [32, 'pcm-s32be', 32],
  ] as const)(
    'parses signed %i-bit AIFF PCM as high-aligned %s',
    async (sampleSize, encoding, containerBitsPerSample) => {
      const metadata = await parse(
        fixture({ sampleSize, sampleRate: 96_000, channels: 2, frames: 12 }),
      );

      expect(metadata).toMatchObject({
        format: 'aiff',
        container: 'aiff',
        encoding,
        compressionType: 'NONE',
        compressionName: null,
        sourceSampleRate: 96_000,
        channels: 2,
        containerBitsPerSample,
        validBitsPerSample: sampleSize,
        blockAlign: 2 * (containerBitsPerSample / 8),
        totalSourceFrames: 12,
        durationSeconds: 12 / 96_000,
      });
      expect(metadata.dataBytes).toBe(12 * 2 * (containerBitsPerSample / 8));
      expect(metadata.logicalFileBytes).toBeGreaterThan(metadata.dataOffset);
    },
  );

  it.each([
    ['NONE', 12, 'pcm-s16be', 16],
    ['twos', 20, 'pcm-s24be', 24],
    ['sowt', 8, 'pcm-s8', 8],
    ['sowt', 12, 'pcm-s16le', 16],
    ['sowt', 20, 'pcm-s24le', 24],
    ['sowt', 32, 'pcm-s32le', 32],
    ['fl32', 32, 'float32be', 32],
    ['fl64', 64, 'float64be', 64],
  ] as const)(
    'parses AIFC %s/%i as %s',
    async (compressionType, sampleSize, encoding, containerBitsPerSample) => {
      const metadata = await parse(
        fixture({
          container: 'AIFC',
          compressionType,
          compressionName: `name-${compressionType}`,
          sampleSize,
        }),
      );

      expect(metadata).toMatchObject({
        container: 'aifc',
        compressionType,
        compressionName: `name-${compressionType}`,
        encoding,
        containerBitsPerSample,
        validBitsPerSample: sampleSize,
      });
    },
  );

  it('skips an odd padded unknown chunk and computes SSND offset without reading it', async () => {
    const bytes = fixture({
      before: [iffChunk('ANNO', Uint8Array.of(1))],
      channels: 2,
      frames: 4,
      sampleSize: 16,
      ssndOffset: 4,
      ssndBlockSize: 16,
    });
    const source = sourceFrom(bytes);
    const readAt = vi.spyOn(source, 'readAt');
    const metadata = await readAiffPcmMetadata(source, new AbortController().signal);

    expect(metadata).toMatchObject({
      ssndOffset: 4,
      ssndBlockSize: 16,
      dataBytes: 16,
    });
    expect(readAt.mock.calls.every(([, length]) => length <= AIFF_MAX_METADATA_READ_BYTES)).toBe(
      true,
    );
    expect(
      readAt.mock.calls.every(([offset, length]) => offset + length <= metadata.dataOffset),
    ).toBe(true);
  });

  it('requires an exact FORM logical size and a supported form type', async () => {
    const valid = fixture();
    const shortDeclaration = valid.slice();
    new DataView(shortDeclaration.buffer).setUint32(4, valid.byteLength - 9, false);
    await expect(parse(shortDeclaration)).rejects.toThrow(/logical size/i);

    const longDeclaration = valid.slice();
    new DataView(longDeclaration.buffer).setUint32(4, valid.byteLength - 7, false);
    await expect(parse(longDeclaration)).rejects.toThrow(/logical size/i);

    const unsupported = valid.slice();
    unsupported.set(ascii('8SVX'), 8);
    await expect(parse(unsupported)).rejects.toBeInstanceOf(UnsupportedAiffContainerError);

    const notForm = valid.slice();
    notForm.set(ascii('RIFF'), 0);
    await expect(parse(notForm)).rejects.toBeInstanceOf(UnsupportedAiffContainerError);
  });

  it('requires one exact AIFF COMM and one SSND chunk', async () => {
    const comm = iffChunk('COMM', aiffCommon());
    const ssnd = iffChunk('SSND', soundData(16));
    await expect(
      parse(form('AIFF', [iffChunk('COMM', concat(aiffCommon(), Uint8Array.of(0))), ssnd])),
    ).rejects.toThrow(/exactly 18 bytes/i);
    await expect(parse(form('AIFF', [comm, comm, ssnd]))).rejects.toThrow(/duplicate COMM/i);
    await expect(parse(form('AIFF', [ssnd]))).rejects.toThrow(/COMM chunk is missing/i);
    await expect(parse(form('AIFF', [comm]))).rejects.toThrow(/SSND chunk is missing/i);
    await expect(parse(form('AIFF', [comm, ssnd, ssnd]))).rejects.toThrow(/duplicate SSND/i);
  });

  it('requires one exact AIFC version chunk with version 0xA2805140', async () => {
    const comm = iffChunk('COMM', aifcCommon());
    const ssnd = iffChunk('SSND', soundData(16));
    await expect(parse(form('AIFC', [comm, ssnd]))).rejects.toThrow(/FVER chunk is missing/i);
    await expect(
      parse(
        form('AIFC', [iffChunk('FVER', concat(be32(AIFC_VERSION), Uint8Array.of(0))), comm, ssnd]),
      ),
    ).rejects.toThrow(/exactly 4 bytes/i);
    await expect(parse(form('AIFC', [versionChunk(0), comm, ssnd]))).rejects.toThrow(/0xA2805140/i);
    await expect(parse(form('AIFC', [versionChunk(), versionChunk(), comm, ssnd]))).rejects.toThrow(
      /duplicate FVER/i,
    );
  });

  it('validates the complete AIFC compression Pascal string', async () => {
    const ssnd = iffChunk('SSND', soundData(16));
    await expect(
      parse(
        form('AIFC', [
          versionChunk(),
          iffChunk('COMM', aifcCommon({ compressionName: '' }).subarray(0, 23)),
          ssnd,
        ]),
      ),
    ).rejects.toThrow(/truncated compression name/i);

    const extra = concat(aifcCommon({ compressionName: 'PCM' }), Uint8Array.of(0, 0));
    await expect(
      parse(form('AIFC', [versionChunk(), iffChunk('COMM', extra), ssnd])),
    ).rejects.toThrow(/does not exactly match/i);

    await expect(
      parse(
        form('AIFC', [
          versionChunk(),
          iffChunk('COMM', aifcCommon({ compressionName: '', paddingByte: 1 })),
          ssnd,
        ]),
      ),
    ).rejects.toThrow(/padding byte must be zero/i);

    const maximumName = 'x'.repeat(255);
    const maximum = fixture({
      container: 'AIFC',
      compressionType: 'NONE',
      compressionName: maximumName,
    });
    const source = sourceFrom(maximum, 'maximum-aifc-name');
    const readAt = vi.spyOn(source, 'readAt');
    await expect(readAiffPcmMetadata(source, new AbortController().signal)).resolves.toMatchObject({
      compressionName: maximumName,
    });
    expect(Math.max(...readAt.mock.calls.map(([, length]) => length))).toBe(
      AIFF_MAX_METADATA_READ_BYTES,
    );
  });

  it.each([
    ['zero', new Uint8Array(10), /canonical finite normalized/i],
    [
      'negative',
      (() => {
        const bytes = extendedInteger(48_000);
        bytes[0] = (bytes[0] ?? 0) | 0x80;
        return bytes;
      })(),
      /must be positive/i,
    ],
    ['infinite', extendedParts(0x7fff, 1n << 63n), /canonical finite normalized/i],
    ['unnormalized', extendedParts(EXTENDED_BIAS + 15, 1n), /canonical finite normalized/i],
    ['fractional', extendedParts(EXTENDED_BIAS + 15, 88_201n << 47n), /must be an integer/i],
    ['too-high', extendedInteger(1_000_001), /1 through 1000000 Hz/i],
  ] as const)('rejects a %s extended sample rate', async (_label, rateBytes, pattern) => {
    await expect(parse(fixture({ rateBytes }))).rejects.toThrow(pattern);
  });

  it('rejects unsupported or contradictory sample encodings', async () => {
    await expect(parse(fixture({ sampleSize: 0, dataBytes: 0 }))).rejects.toBeInstanceOf(
      UnsupportedAiffCodecError,
    );
    await expect(parse(fixture({ sampleSize: 33 }))).rejects.toBeInstanceOf(
      UnsupportedAiffCodecError,
    );
    await expect(
      parse(fixture({ container: 'AIFC', compressionType: 'ulaw', sampleSize: 8 })),
    ).rejects.toBeInstanceOf(UnsupportedAiffCodecError);
    await expect(
      parse(fixture({ container: 'AIFC', compressionType: 'fl32', sampleSize: 64 })),
    ).rejects.toThrow(/fl32 must use a 32-bit/i);
    await expect(
      parse(fixture({ container: 'AIFC', compressionType: 'fl64', sampleSize: 32 })),
    ).rejects.toThrow(/fl64 must use a 64-bit/i);
  });

  it('validates SSND offset and requires at least the COMM frame bytes', async () => {
    await expect(
      parse(
        form('AIFF', [iffChunk('COMM', aiffCommon()), iffChunk('SSND', concat(be32(17), be32(0)))]),
      ),
    ).rejects.toThrow(/offset exceeds/i);
    await expect(parse(fixture({ ssndOffset: 4, ssndBlockSize: 4 }))).rejects.toThrow(
      /smaller than blockSize/i,
    );
    await expect(parse(fixture({ dataBytes: 15 }))).rejects.toThrow(/all sample frames/i);

    await expect(parse(fixture({ ssndBlockSize: 6 }))).resolves.toMatchObject({
      blockAlign: 4,
      ssndBlockSize: 6,
    });
    await expect(
      parse(
        fixture({
          channels: 2,
          frames: 1,
          sampleSize: 24,
          dataBytes: 512,
          ssndBlockSize: 512,
        }),
      ),
    ).resolves.toMatchObject({
      blockAlign: 6,
      dataBytes: 6,
      totalSourceFrames: 1,
      ssndBlockSize: 512,
    });

    const tooShort = form('AIFF', [
      iffChunk('COMM', aiffCommon()),
      iffChunk('SSND', Uint8Array.of(0, 0, 0, 0)),
    ]);
    await expect(parse(tooShort)).rejects.toThrow(/shorter than 8 bytes/i);
  });

  it('enforces even chunk padding and the 1024-chunk traversal ceiling', async () => {
    const unpaddedOddChunk = concat(ascii('ANNO'), be32(1), Uint8Array.of(1));
    await expect(
      parse(
        replaceChunkBody('AIFF', [
          unpaddedOddChunk,
          iffChunk('COMM', aiffCommon()),
          iffChunk('SSND', soundData(16)),
        ]),
      ),
    ).rejects.toBeInstanceOf(EncodedSourceIntegrityError);

    await expect(
      parse(
        fixture({
          before: [iffChunk('ANNO', Uint8Array.of(1), 0x7f)],
        }),
      ),
    ).rejects.toThrow(/nonzero padding byte/i);

    const excessive = Array.from({ length: AIFF_MAX_CHUNKS + 1 }, () =>
      iffChunk('JUNK', new Uint8Array()),
    );
    await expect(parse(form('AIFF', excessive))).rejects.toThrow(/too many chunks/i);
  });

  it('requires canonical printable local chunk IDs with trailing spaces only', async () => {
    await expect(
      parse(fixture({ before: [iffChunk('\u001fBAD', new Uint8Array())] })),
    ).rejects.toThrow(/printable ASCII/i);
    await expect(parse(fixture({ before: [iffChunk(' JNK', new Uint8Array())] }))).rejects.toThrow(
      /trailing characters/i,
    );
    await expect(
      parse(fixture({ before: [iffChunk('JNK ', new Uint8Array())] })),
    ).resolves.toMatchObject({ format: 'aiff' });
  });

  it('rejects zero frames and malformed exact reads', async () => {
    await expect(parse(fixture({ frames: 0, dataBytes: 0 }))).rejects.toThrow(
      /at least one sample frame/i,
    );

    const bytes = fixture();
    const shortSource: EncodedAudioSource = {
      ...sourceFrom(bytes),
      async readAt(offset, length, signal) {
        throwIfAborted(signal);
        return bytes.slice(offset, offset + Math.max(0, length - 1));
      },
    };
    await expect(readAiffPcmMetadata(shortSource, new AbortController().signal)).rejects.toThrow(
      /metadata read returned/i,
    );
  });

  it('honors aborts before and immediately after an exact transport read', async () => {
    const bytes = fixture();
    const before = new AbortController();
    const beforeReason = new Error('before-read-abort');
    before.abort(beforeReason);
    await expect(readAiffPcmMetadata(sourceFrom(bytes), before.signal)).rejects.toBe(beforeReason);

    const after = new AbortController();
    const afterReason = new Error('after-read-abort');
    const base = sourceFrom(bytes);
    const abortingSource: EncodedAudioSource = {
      ...base,
      async readAt(offset, length, signal) {
        const result = await base.readAt(offset, length, signal);
        after.abort(afterReason);
        return result;
      },
    };
    await expect(readAiffPcmMetadata(abortingSource, after.signal)).rejects.toBe(afterReason);
  });
});

interface SparseRegion {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

class SparseEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly identity = 'sparse-aiff-fixture';
  readonly metadata = { name: 'sparse.aiff', mime: 'audio/aiff' };
  readonly reads: Array<{ readonly offset: number; readonly length: number }> = [];

  constructor(
    readonly size: number,
    private readonly regions: readonly SparseRegion[],
  ) {}

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push({ offset, length });
    const end = offset + length;
    const region = this.regions.find(
      (candidate) => offset >= candidate.offset && end <= candidate.offset + candidate.bytes.length,
    );
    if (!region) throw new Error(`Sparse fixture has no bytes for [${offset}, ${end})`);
    const relative = offset - region.offset;
    return region.bytes.slice(relative, relative + length);
  }

  async close(): Promise<void> {}
}

describe('readAiffPcmMetadata sparse input', () => {
  it('parses an approximately 4 GiB AIFF without reading sample bytes', async () => {
    const frames = 0xffff_ffd0;
    const ssndBytes = 8 + frames;
    const sourceSize = 54 + frames;
    const top = concat(ascii('FORM'), be32(sourceSize - 8), ascii('AIFF'));
    const commHeader = concat(ascii('COMM'), be32(18));
    const commBody = aiffCommon({ channels: 1, frames, sampleSize: 8, sampleRate: 48_000 });
    const ssndHeader = concat(ascii('SSND'), be32(ssndBytes));
    const ssndPrefix = concat(be32(0), be32(0));
    const source = new SparseEncodedAudioSource(sourceSize, [
      { offset: 0, bytes: top },
      { offset: 12, bytes: commHeader },
      { offset: 20, bytes: commBody },
      { offset: 38, bytes: ssndHeader },
      { offset: 46, bytes: ssndPrefix },
    ]);

    const metadata = await readAiffPcmMetadata(source, new AbortController().signal);

    expect(metadata).toMatchObject({
      encoding: 'pcm-s8',
      channels: 1,
      dataOffset: 54,
      dataBytes: frames,
      totalSourceFrames: frames,
      logicalFileBytes: sourceSize,
    });
    expect(source.reads).toHaveLength(5);
    expect(source.reads.every(({ offset, length }) => offset + length <= 54)).toBe(true);
    expect(Math.max(...source.reads.map(({ length }) => length))).toBe(18);
  });
});
