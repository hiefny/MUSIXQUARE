import { describe, expect, it } from 'vitest';
import { readMp3GaplessTrim } from '../mp3-gapless.ts';

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
    await expect(readMp3GaplessTrim(new Blob([new Uint8Array(512)]))).resolves.toEqual({
      startSamples: 0,
      endSamples: 0,
    });
  });
});
