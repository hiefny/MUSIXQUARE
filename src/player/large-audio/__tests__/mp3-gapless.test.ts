import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { readMp3GaplessTrim } from '../mp3-gapless.ts';

const NO_TRIM = { startSamples: 0, endSamples: 0 };
const LAME_TRIM = { startSamples: 1105, endSamples: 771 };

function taggedFrame({
  version = 3,
  mono = false,
  protectedFrame = false,
  flags = 1,
  frameCount = 100,
  delay = 576,
  padding = 1300,
  encoderName = 'LAME3.100',
} = {}): { bytes: Uint8Array<ArrayBuffer>; encoder: number; xing: number } {
  const bytes = new Uint8Array(2048);
  bytes.set([255, 0xe2 | (version << 3) | Number(!protectedFrame), 0x90, mono ? 0xc0 : 0]);
  const xing = 4 + (version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17);
  bytes.set(new TextEncoder().encode('Xing'), xing);
  const view = new DataView(bytes.buffer);
  view.setUint32(xing + 4, flags);
  let encoder = xing + 8;
  if (flags & 1) {
    view.setUint32(encoder, frameCount);
    encoder += 4;
  }
  if (flags & 2) {
    view.setUint32(encoder, 100_000);
    encoder += 4;
  }
  if (flags & 4) encoder += 100;
  if (flags & 8) encoder += 4;
  bytes.set(new TextEncoder().encode(encoderName), encoder);
  bytes[encoder + 21] = delay >> 4;
  bytes[encoder + 22] = ((delay & 15) << 4) | (padding >> 8);
  bytes[encoder + 23] = padding & 255;
  return { bytes, encoder, xing };
}

describe('MP3 audible timeline normalization', () => {
  it.each([false, true])(
    'preserves gapless timing with CRC protection = %s',
    async (protectedFrame) => {
      const bytes = new Uint8Array(512);
      bytes.set([255, protectedFrame ? 250 : 251, 144, 0]);
      bytes.set(new TextEncoder().encode('Xing'), 36);
      const tag = 44;
      bytes.set(new TextEncoder().encode('LAME3.100'), tag);
      const delay = 576;
      const padding = 1300;
      bytes[tag + 21] = delay >> 4;
      bytes[tag + 22] = ((delay & 15) << 4) | (padding >> 8);
      bytes[tag + 23] = padding & 255;
      await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual({
        startSamples: 1105,
        endSamples: 771,
      });
    },
  );

  it('reads the audio header after an ID3v2.4 tag and its optional footer', async () => {
    const bytes = new Uint8Array(1024);
    // Header, 200 metadata bytes and a separate ten-byte footer.
    bytes.set([73, 68, 51, 4, 0, 16, 0, 0, 1, 72]);
    bytes.set([51, 68, 73, 4, 0, 16, 0, 0, 1, 72], 210);
    bytes.set([255, 251, 144, 0], 220);
    bytes.set(new TextEncoder().encode('Info'), 256);
    bytes.set(new TextEncoder().encode('LAME3.100'), 264);
    bytes.set([36, 5, 20], 285); // Encoder delay 576; padding 1300.
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual({
      startSamples: 1105,
      endSamples: 771,
    });
  });

  it('does not invent encoder trimming for an MP3 with no gapless tag', async () => {
    await expect(readMp3GaplessTrim(new Blob([new Uint8Array(512)]))).resolves.toEqual(NO_TRIM);
  });

  it.each([3, 2, 0])('reads MPEG version %i mono/stereo with either CRC mode', async (version) => {
    for (const mono of [false, true]) {
      for (const protectedFrame of [false, true]) {
        const { bytes } = taggedFrame({ version, mono, protectedFrame });
        await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(LAME_TRIM);
      }
    }
  });

  it.each([0, 1, 3, 7, 15])('locates the extension for Xing flag combination %i', async (flags) => {
    const { bytes } = taggedFrame({ flags });
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(LAME_TRIM);
  });

  it.each(['LAME3.100', 'Lavc62.11', 'Lavf60.3', 'LAME3.99r'])(
    'preserves encoder %s',
    async (encoderName) => {
      const { bytes } = taggedFrame({ encoderName });
      await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(LAME_TRIM);
    },
  );

  it.each([
    ['reserved version', 1, 0xeb],
    ['wrong layer', 1, 0xfd],
    ['free bitrate', 2, 0x00],
    ['reserved bitrate', 2, 0xf0],
    ['reserved frequency', 2, 0x9c],
  ] as const)('ignores a tag attached to a %s header', async (_name, offset, value) => {
    const { bytes } = taggedFrame();
    bytes[offset] = value;
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(NO_TRIM);
  });

  it('does not borrow gapless timing from a later frame or bytes inside audio payload', async () => {
    for (const laterOffset of [100, 417]) {
      const { bytes } = taggedFrame();
      const concatenated = new Uint8Array(4096);
      concatenated.set([255, 251, 144, 0]); // A complete 417-byte ordinary MPEG frame.
      concatenated.set(bytes, laterOffset);
      await expect(readMp3GaplessTrim(new Blob([concatenated]))).resolves.toEqual(NO_TRIM);
    }
  });

  it('keeps the complete encoder extension inside its declared first-frame boundary', async () => {
    const { bytes } = taggedFrame({ flags: 15 });
    bytes[2] = 0x10; // 32 kbps: 104 bytes; the extension now crosses into following audio.
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(NO_TRIM);
  });

  it('rejects a truncated frame even when its delay bytes survived', async () => {
    const { bytes, encoder } = taggedFrame();
    await expect(readMp3GaplessTrim(new Blob([bytes.slice(0, encoder + 36)]))).resolves.toEqual(
      NO_TRIM,
    );
  });

  it.each([16, 0x80000001])('ignores unknown Xing flag bits %i', async (flags) => {
    const { bytes } = taggedFrame({ flags });
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(NO_TRIM);
  });

  it.each(['LAME\0junk', 'LAMEjunk!', 'LAME3.\x1f00', 'LAME3.\x8000', 'L3.99r'])(
    'ignores unproven encoder field %j',
    async (encoderName) => {
      const { bytes } = taggedFrame({ encoderName });
      await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(NO_TRIM);
    },
  );

  it('does not interpret a future extension revision as revision zero', async () => {
    const { bytes, encoder } = taggedFrame();
    bytes[encoder + 9] = 0x10;
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(NO_TRIM);
  });

  it.each([
    { delay: 4095 },
    { padding: 4095 },
    { padding: 528 },
    { frameCount: 0 },
    { frameCount: 1 },
    { frameCount: 2, padding: 1728 }, // Exactly all 2 * 1152 coded samples.
  ])('rejects impossible trim/count metadata %j', async (metadata) => {
    const { bytes } = taggedFrame(metadata);
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual(NO_TRIM);
  });

  it('permits zero encoder delay and padding equal to the synthesis delay', async () => {
    const { bytes } = taggedFrame({ delay: 0, padding: 529 });
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual({
      startSamples: 529,
      endSamples: 0,
    });
  });

  it('skips a large ID3 tag without reading it or the complete audio file', async () => {
    const { bytes } = taggedFrame();
    const tagSize = 200_000;
    const header = new Uint8Array([
      73,
      68,
      51,
      3,
      0,
      0,
      0,
      tagSize >> 14,
      (tagSize >> 7) & 127,
      tagSize & 127,
    ]);
    const blob = new Blob([header, new Uint8Array(tagSize), bytes, new Uint8Array(300_000)]);
    const slices = vi.spyOn(blob, 'slice');
    await expect(readMp3GaplessTrim(blob)).resolves.toEqual(LAME_TRIM);
    expect(slices.mock.calls).toEqual([
      [0, 10],
      [tagSize + 10, tagSize + 10 + 64 * 1024],
    ]);
  });

  it.each([
    { header: [73, 68, 51, 5, 0, 0, 0, 0, 0, 0] },
    { header: [73, 68, 51, 3, 0, 0, 128, 0, 0, 0] },
    { header: [73, 68, 51, 4, 0, 16, 127, 127, 127, 127] },
  ])(
    'does not read gapless values through invalid/truncated ID3 framing %j',
    async ({ header }) => {
      const { bytes } = taggedFrame();
      await expect(readMp3GaplessTrim(new Blob([new Uint8Array(header), bytes]))).resolves.toEqual(
        NO_TRIM,
      );
    },
  );

  it.each([
    ['e2e/fixtures/large-audio-chirp.mp3', 731],
    ['e2e/fixtures/test-01.mp3', 414],
    ['e2e/fixtures/demo-track.mp3', 1143],
    ['public/dummy_audio.mp3', 1037],
  ] as const)('preserves the real-file audible origin and end for %s', async (path, endSamples) => {
    const bytes = new Uint8Array(await readFile(path));
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual({
      startSamples: 1105,
      endSamples,
    });
  });

  it('keeps native-compatible timing when a real file has a stale optional tag CRC', async () => {
    const bytes = new Uint8Array(await readFile('e2e/fixtures/large-audio-chirp.mp3'));
    const encoder = new TextDecoder('latin1').decode(bytes).indexOf('Lavc62.11');
    expect(encoder).toBeGreaterThan(0);
    bytes[encoder + 34] ^= 0xff;
    bytes[encoder + 35] ^= 0xff;
    await expect(readMp3GaplessTrim(new Blob([bytes]))).resolves.toEqual({
      startSamples: 1105,
      endSamples: 731,
    });
  });
});
