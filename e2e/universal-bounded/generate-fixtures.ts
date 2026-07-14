import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUTPUT_DIR = resolve('.vite/universal-fixtures');
const MP3_SOURCE_PATH = resolve('e2e/fixtures/test-01.mp3');
const SAMPLE_RATE_HZ = 48_000;
const CHANNEL_COUNT = 2;
const DURATION_SECONDS = 60;
const MP3_XING_FRAME_BYTES = 384;
const MP3_SOURCE_SHA256 = 'f39bd1784a7cb58675e61ab17906f8ed2d675defc11eea1e10a6bd0258d359f3';
const MP3_NO_COUNT_SHA256 = '7862af77e2b6f27ecb9847ff3c1f3a75036bd342b34040b3e76477dfd9df48db';

// FFmpeg 8.0.1, bitexact AAC-LC, 48 kHz stereo, two seconds of generated
// silence. The bytes are fixed here so CI never needs an external encoder.
const ADTS_AAC_LC_BASE64 =
  '//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBz/8UyAAb/8IRAEYIwc//FMgAG//CEQBGCMHP/xTIABv/whEARgjBw=';
const ADTS_AAC_LC_SHA256 = 'fe13b8897987454cd52e67f7b4d4733fbc4348a27b6a4ba930fef0c17907e9fb';

function createPcm16(littleEndian: boolean): Buffer {
  const frameCount = SAMPLE_RATE_HZ * DURATION_SECONDS;
  const bytesPerSample = 2;
  const dataByteLength = frameCount * CHANNEL_COUNT * bytesPerSample;
  const bytes = Buffer.alloc(dataByteLength);
  let offset = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = frame % 96 < 48 ? 1_500 : -1_500;
    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
      if (littleEndian) bytes.writeInt16LE(sample, offset);
      else bytes.writeInt16BE(sample, offset);
      offset += bytesPerSample;
    }
  }
  return bytes;
}

function createWavePcm16(data: Buffer): Buffer {
  const bytesPerSample = 2;
  const bytes = Buffer.alloc(44 + data.byteLength);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(CHANNEL_COUNT, 22);
  bytes.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  bytes.writeUInt32LE(SAMPLE_RATE_HZ * CHANNEL_COUNT * bytesPerSample, 28);
  bytes.writeUInt16LE(CHANNEL_COUNT * bytesPerSample, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data.byteLength, 40);
  data.copy(bytes, 44);
  return bytes;
}

function writeExtendedInteger(bytes: Buffer, offset: number, value: number): void {
  const highestBit = Math.floor(Math.log2(value));
  bytes.writeUInt16BE(16_383 + highestBit, offset);
  bytes.writeBigUInt64BE(BigInt(value) << BigInt(63 - highestBit), offset + 2);
}

function createAiffPcm16(data: Buffer): Buffer {
  const frameCount = SAMPLE_RATE_HZ * DURATION_SECONDS;
  const bytes = Buffer.alloc(54 + data.byteLength);
  bytes.write('FORM', 0, 'ascii');
  bytes.writeUInt32BE(bytes.byteLength - 8, 4);
  bytes.write('AIFF', 8, 'ascii');
  bytes.write('COMM', 12, 'ascii');
  bytes.writeUInt32BE(18, 16);
  bytes.writeUInt16BE(CHANNEL_COUNT, 20);
  bytes.writeUInt32BE(frameCount, 22);
  bytes.writeUInt16BE(16, 26);
  writeExtendedInteger(bytes, 28, SAMPLE_RATE_HZ);
  bytes.write('SSND', 38, 'ascii');
  bytes.writeUInt32BE(8 + data.byteLength, 42);
  bytes.writeUInt32BE(0, 46);
  bytes.writeUInt32BE(0, 50);
  data.copy(bytes, 54);
  return bytes;
}

function createCafPcm16(data: Buffer): Buffer {
  const bytes = Buffer.alloc(68 + data.byteLength);
  bytes.write('caff', 0, 'ascii');
  bytes.writeUInt16BE(1, 4);
  bytes.writeUInt16BE(0, 6);
  bytes.write('desc', 8, 'ascii');
  bytes.writeBigInt64BE(32n, 12);
  bytes.writeDoubleBE(SAMPLE_RATE_HZ, 20);
  bytes.write('lpcm', 28, 'ascii');
  bytes.writeUInt32BE(2, 32);
  bytes.writeUInt32BE(CHANNEL_COUNT * 2, 36);
  bytes.writeUInt32BE(1, 40);
  bytes.writeUInt32BE(CHANNEL_COUNT, 44);
  bytes.writeUInt32BE(16, 48);
  bytes.write('data', 52, 'ascii');
  bytes.writeBigInt64BE(BigInt(4 + data.byteLength), 56);
  bytes.writeUInt32BE(0, 64);
  data.copy(bytes, 68);
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createNoFrameCountMp3(source: Buffer): Buffer {
  if (sha256(source) !== MP3_SOURCE_SHA256) {
    throw new Error('Tracked MP3 fixture no longer matches its exact SHA-256');
  }
  if (
    source.byteLength <= MP3_XING_FRAME_BYTES ||
    !source.subarray(0, 4).equals(Buffer.from([0xff, 0xfb, 0x94, 0x44])) ||
    source.toString('ascii', 36, 40) !== 'Xing' ||
    source.toString('ascii', 156, 160) !== 'LAME' ||
    source[MP3_XING_FRAME_BYTES] !== 0xff ||
    (source[MP3_XING_FRAME_BYTES + 1]! & 0xe0) !== 0xe0
  ) {
    throw new Error('Tracked MP3 fixture no longer has the exact 384-byte Xing/LAME frame');
  }
  const noFrameCount = source.subarray(MP3_XING_FRAME_BYTES);
  if (sha256(noFrameCount) !== MP3_NO_COUNT_SHA256) {
    throw new Error('Derived no-frame-count MP3 failed its exact SHA-256 check');
  }
  return noFrameCount;
}

async function writeExact(name: string, bytes: Buffer): Promise<void> {
  const path = resolve(OUTPUT_DIR, name);
  const current = await readFile(path).catch(() => null);
  if (current && current.equals(bytes)) return;
  await writeFile(path, bytes);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const adtsSeed = Buffer.from(ADTS_AAC_LC_BASE64, 'base64');
  if (sha256(adtsSeed) !== ADTS_AAC_LC_SHA256) {
    throw new Error('Embedded ADTS fixture failed its exact SHA-256 check');
  }
  const mp3 = createNoFrameCountMp3(await readFile(MP3_SOURCE_PATH));
  const adts = Buffer.concat([adtsSeed, adtsSeed, adtsSeed, adtsSeed]);
  const pcm16le = createPcm16(true);
  const pcm16be = createPcm16(false);
  await Promise.all([
    writeExact('bounded-tone.wav', createWavePcm16(pcm16le)),
    writeExact('bounded-tone.aiff', createAiffPcm16(pcm16be)),
    writeExact('bounded-tone.caf', createCafPcm16(pcm16le)),
    writeExact('bounded-tone.aac', adts),
    writeExact('bounded-tone-no-count.mp3', mp3),
  ]);
}

await main();
