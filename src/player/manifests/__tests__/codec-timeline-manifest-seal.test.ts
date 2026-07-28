import { describe, expect, it } from 'vitest';

import { isScannerIssuedAdtsFrameScanResult, scanAdtsFrames } from '../../aac/frame-scanner.ts';
import { parseMpegLayer3FrameHeader } from '../../mp3/frame-header.ts';
import { readMp3Metadata, scannerIssuedMp3MetadataSource } from '../../mp3/metadata.ts';
import {
  type EncodedAudioSource,
  type EncodedAudioSourceMetadata,
  throwIfAborted,
  validateExactRead,
} from '../../sources/encoded-audio-source.ts';
import {
  isMp3MetadataTimelineManifestEligible,
  sealAdtsFrameScanTimelineManifest,
  sealMp3MetadataTimelineManifest,
} from '../codec-timeline-manifest-seal.ts';
import { parseCodecTimelineManifest } from '../codec-timeline-manifest.ts';

class MemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly metadata: EncodedAudioSourceMetadata;
  readonly identity: string;
  closeCount = 0;

  constructor(
    readonly bytes: Uint8Array,
    identity: string,
    mime: string,
  ) {
    this.identity = identity;
    this.metadata = Object.freeze({ name: identity, mime });
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function adtsFrame(frameLengthBytes: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(frameLengthBytes).fill(fill);
  const sampleRateIndex = 4;
  const channelConfiguration = 2;
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = (1 << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100;
  return bytes;
}

function mp3Frame(mainDataBeginBytes: number, fill: number): Uint8Array {
  const headerBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const bytes = new Uint8Array(header.frameLengthBytes).fill(fill);
  bytes.set(headerBytes);
  bytes[4] = mainDataBeginBytes >>> 1;
  bytes[5] = (mainDataBeginBytes & 1) << 7;
  return bytes;
}

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function setUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value / 0x1_00_00_00;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function setUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value;
}

function lameInfoTagCrc16(bytes: Uint8Array, endOffset: number): number {
  let crc = 0;
  for (let offset = 0; offset < endOffset; offset += 1) {
    crc ^= bytes[offset] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xa001);
    }
  }
  return crc & 0xffff;
}

function xingTaggedMp3(
  audioFrameCount: number,
  declaredFrameCount: number | null,
  gapless: Readonly<{ delay: number; padding: number }> | null = null,
): Uint8Array {
  const tag = mp3Frame(0, 0);
  const header = parseMpegLayer3FrameHeader(tag.subarray(0, 4));
  const markerOffset = 4 + header.sideInfoBytes;
  setAscii(tag, markerOffset, 'Xing');
  setUint32(tag, markerOffset + 4, declaredFrameCount === null ? 0 : 1);
  if (declaredFrameCount !== null) setUint32(tag, markerOffset + 8, declaredFrameCount);
  if (gapless !== null) {
    const encoderOffset = markerOffset + 12;
    setAscii(tag, encoderOffset, 'LAME3.100');
    const packed = gapless.delay * 0x1000 + gapless.padding;
    tag[encoderOffset + 21] = packed >>> 16;
    tag[encoderOffset + 22] = packed >>> 8;
    tag[encoderOffset + 23] = packed;
    const crcOffset = encoderOffset + 34;
    setUint16(tag, crcOffset, lameInfoTagCrc16(tag, crcOffset));
  }
  const audio = Array.from({ length: audioFrameCount }, (_, index) =>
    mp3Frame(index === 0 ? 0 : 16, index + 1),
  );
  return concatenate(tag, ...audio);
}

function digest(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 3);
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('scanner-issued codec timeline manifest seals', () => {
  it('seals a real ADTS EOF scan deterministically and reconstructs every timeline scalar', async () => {
    const frames = [adtsFrame(19, 0x11), adtsFrame(41, 0x22), adtsFrame(83, 0x33)];
    const source = new MemorySource(concatenate(...frames), 'sealed-adts-source', 'audio/aac');
    const scan = await scanAdtsFrames(source, signal());
    const binding = digest();

    expect(isScannerIssuedAdtsFrameScanResult(scan)).toBe(true);
    const first = sealAdtsFrameScanTimelineManifest(scan, binding);
    const second = sealAdtsFrameScanTimelineManifest(scan, binding);
    expect(first.copyBytes()).toEqual(second.copyBytes());
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toMatchObject({
      codec: 'adts-aac-lc',
      sourceIdentity: source.identity,
      sourceSize: source.size,
      byteLength: first.copyBytes().byteLength,
    });

    const parsed = parseCodecTimelineManifest(first.copyBytes());
    expect(parsed).toMatchObject({
      codec: 'adts-aac-lc',
      sourceBindingSha256: Array.from(binding),
      sourceSize: scan.sourceSize,
      audioStartByte: 0,
      audioEndByte: scan.audioEndByteOffset,
      frameCount: scan.frameCount,
      sampleRateHz: scan.coreSampleRateHz,
      samplesPerFrame: scan.samplesPerFrame,
      channels: scan.coreChannelCount,
      sampleRateIndex: scan.coreConfiguration.sampleRateIndex,
      channelConfiguration: scan.coreConfiguration.channelConfiguration,
      points: scan.seekPoints,
    });
    expect(source.closeCount).toBe(0);
  });

  it('seals a real no-count Xing MP3 only after its complete fallback scan', async () => {
    const bytes = xingTaggedMp3(6, null);
    const source = new MemorySource(bytes, 'sealed-mp3-source', 'audio/mpeg');
    const metadata = await readMp3Metadata(source, signal());
    const binding = digest();

    expect(metadata).toMatchObject({
      frameCountEvidence: 'verified-scan',
      fullyVerifiedFrameSpan: true,
      verifiedAudioFrameCount: 6,
      audioFrameCount: 6,
      vbr: { kind: 'xing', frameCount: null },
    });
    expect(scannerIssuedMp3MetadataSource(metadata)).toEqual({
      sourceIdentity: source.identity,
      sourceSize: source.size,
    });
    expect(isMp3MetadataTimelineManifestEligible(metadata)).toBe(true);

    const seal = sealMp3MetadataTimelineManifest(metadata, binding);
    const parsed = parseCodecTimelineManifest(seal.copyBytes());
    expect(seal).toMatchObject({
      codec: 'mp3-no-frame-count',
      sourceIdentity: source.identity,
      sourceSize: source.size,
    });
    expect(parsed).toMatchObject({
      codec: 'mp3-no-frame-count',
      sourceBindingSha256: Array.from(binding),
      sourceSize: source.size,
      audioStartByte: metadata.firstAudioFrameOffset,
      audioEndByte: metadata.audioEndByteOffset,
      frameCount: metadata.audioFrameCount,
      sampleRateHz: metadata.sampleRateHz,
      samplesPerFrame: metadata.samplesPerFrame,
      channels: metadata.channels,
      mpegVersion: metadata.version,
      hasFrameCountDeclaration: false,
      hasTagFrame: true,
      tagFrameBytes: metadata.tagFrameBytes,
      gapless: null,
      totalMediaFrames: metadata.totalMediaFrames,
      points: metadata.seekPoints.map((point) => ({
        frameOrdinal: point.frameOrdinal,
        byteOffset: point.byteOffset,
        mainDataCapacityBytes: point.mainDataCapacityBytes,
        mainDataBeginBytes: point.mainDataBeginBytes,
      })),
    });
    expect(source.closeCount).toBe(0);
  });

  it('seals absolute ADTS points after leading bytes without changing manifest version', async () => {
    const prefix = new Uint8Array(37).fill(0x49);
    const frames = [adtsFrame(19, 0x11), adtsFrame(41, 0x22), adtsFrame(83, 0x33)];
    const source = new MemorySource(
      concatenate(prefix, ...frames),
      'sealed-prefixed-adts-source',
      'audio/aac',
    );
    const scan = await scanAdtsFrames(source, signal(), { audioStartByte: prefix.byteLength });
    const seal = sealAdtsFrameScanTimelineManifest(scan, digest());
    const parsed = parseCodecTimelineManifest(seal.copyBytes());

    expect(parsed).toMatchObject({
      manifestVersion: 1,
      codec: 'adts-aac-lc',
      sourceSize: source.size,
      audioStartByte: prefix.byteLength,
      audioEndByte: source.size,
      points: [
        { frameOrdinal: 0, byteOffset: prefix.byteLength },
        { frameOrdinal: 1, byteOffset: prefix.byteLength + frames[0]!.byteLength },
        {
          frameOrdinal: 2,
          byteOffset: prefix.byteLength + frames[0]!.byteLength + frames[1]!.byteLength,
        },
      ],
    });
  });

  it('does not grant seal authority to structural copies or cross-codec results', async () => {
    const adts = await scanAdtsFrames(
      new MemorySource(adtsFrame(31, 1), 'copy-adts', 'audio/aac'),
      signal(),
    );
    const mp3 = await readMp3Metadata(
      new MemorySource(
        concatenate(...Array.from({ length: 5 }, (_, index) => mp3Frame(index === 0 ? 0 : 1, 1))),
        'copy-mp3',
        'audio/mpeg',
      ),
      signal(),
    );

    const adtsCopy = { ...adts };
    const mp3Copy = { ...mp3 };
    expect(isScannerIssuedAdtsFrameScanResult(adtsCopy)).toBe(false);
    expect(scannerIssuedMp3MetadataSource(mp3Copy)).toBeNull();
    expect(() => sealAdtsFrameScanTimelineManifest(adtsCopy, digest())).toThrow(/exact scanner/i);
    expect(() => sealMp3MetadataTimelineManifest(mp3Copy, digest())).toThrow(/exact scanner/i);
    expect(() => sealAdtsFrameScanTimelineManifest(mp3, digest())).toThrow(/exact scanner/i);
    expect(() => sealMp3MetadataTimelineManifest(adts, digest())).toThrow(/exact scanner/i);
  });

  it('rejects a declaration-backed MP3 even when a tiny prefix reaches verified EOF', async () => {
    const source = new MemorySource(xingTaggedMp3(2, 2), 'declared-mp3', 'audio/mpeg');
    const metadata = await readMp3Metadata(source, signal());

    expect(metadata).toMatchObject({
      frameCountEvidence: 'verified-scan',
      fullyVerifiedFrameSpan: true,
      vbr: { kind: 'xing', frameCount: 2 },
    });
    expect(isMp3MetadataTimelineManifestEligible(metadata)).toBe(false);
    expect(() => sealMp3MetadataTimelineManifest(metadata, digest())).toThrow(
      /frame-count declarations/i,
    );
  });

  it('routes scanner-issued gapless MP3 metadata away from manifest publication', async () => {
    const source = new MemorySource(
      xingTaggedMp3(2, 2, { delay: 576, padding: 100 }),
      'gapless-mp3',
      'audio/mpeg',
    );
    const metadata = await readMp3Metadata(source, signal());

    expect(metadata.gapless).toMatchObject({
      encoderDelaySamples: 576,
      endPaddingSamples: 100,
    });
    expect(isMp3MetadataTimelineManifestEligible(metadata)).toBe(false);
    expect(() => sealMp3MetadataTimelineManifest(metadata, digest())).toThrow(/gapless.*null/i);
  });

  it('keeps digest and manifest copies isolated and rejects forged seal receivers', async () => {
    const scan = await scanAdtsFrames(
      new MemorySource(adtsFrame(31, 1), 'isolated-adts', 'audio/aac'),
      signal(),
    );
    const binding = digest();
    const expectedBinding = Array.from(binding);
    const seal = sealAdtsFrameScanTimelineManifest(scan, binding);
    binding.fill(0);

    const first = seal.copyBytes();
    const pristine = first.slice();
    first.fill(0);
    expect(seal.copyBytes()).toEqual(pristine);
    expect(parseCodecTimelineManifest(seal.copyBytes()).sourceBindingSha256).toEqual(
      expectedBinding,
    );
    expect(seal.copyBytes()).not.toBe(seal.copyBytes());

    const forged = {
      codec: seal.codec,
      sourceIdentity: seal.sourceIdentity,
      sourceSize: seal.sourceSize,
      byteLength: seal.byteLength,
      copyBytes: seal.copyBytes,
    };
    expect(() => forged.copyBytes()).toThrow(/not authentic/i);

    const escapedConstructor = seal.constructor;
    const constructorForged = Reflect.construct(escapedConstructor, [
      seal.codec,
      'constructor-forged-source',
      seal.sourceSize,
      seal.byteLength,
      pristine,
    ]) as { copyBytes(): Uint8Array };
    expect(() => constructorForged.copyBytes()).toThrow(/not authentic/i);
  });

  it('rejects wrong, shared, and non-byte source bindings', async () => {
    const scan = await scanAdtsFrames(
      new MemorySource(adtsFrame(31, 1), 'digest-adts', 'audio/aac'),
      signal(),
    );
    expect(() => sealAdtsFrameScanTimelineManifest(scan, new Uint8Array(31))).toThrow(
      /exactly 32/i,
    );
    expect(() => sealAdtsFrameScanTimelineManifest(scan, Array.from(digest()))).toThrow(
      /Uint8Array/i,
    );
    expect(() =>
      sealAdtsFrameScanTimelineManifest(scan, new DataView(new ArrayBuffer(32))),
    ).toThrow(/storage|Uint8Array/i);
    if (typeof SharedArrayBuffer === 'function') {
      expect(() =>
        sealAdtsFrameScanTimelineManifest(scan, new Uint8Array(new SharedArrayBuffer(32))),
      ).toThrow(/non-shared/i);
    }
  });

  it('issues no authority from aborted scans or metadata reads', async () => {
    const adtsAbort = new AbortController();
    const adtsReason = new Error('abort ADTS before seal authority');
    adtsAbort.abort(adtsReason);
    await expect(
      scanAdtsFrames(
        new MemorySource(adtsFrame(31, 1), 'aborted-adts', 'audio/aac'),
        adtsAbort.signal,
      ),
    ).rejects.toBe(adtsReason);

    const mp3Abort = new AbortController();
    const mp3Reason = new Error('abort MP3 before seal authority');
    mp3Abort.abort(mp3Reason);
    await expect(
      readMp3Metadata(
        new MemorySource(mp3Frame(0, 1), 'aborted-mp3', 'audio/mpeg'),
        mp3Abort.signal,
      ),
    ).rejects.toBe(mp3Reason);

    expect(() => sealAdtsFrameScanTimelineManifest({}, digest())).toThrow(/exact scanner/i);
    expect(() => sealMp3MetadataTimelineManifest({}, digest())).toThrow(/exact scanner/i);
  });
});
