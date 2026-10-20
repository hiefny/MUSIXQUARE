import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOCK_BACKGROUND } from '../../../browser/screensaver-backgrounds.ts';

describe('screensaver background asset contract', () => {
  it('ships each immutable clock image with the content hash and size used by the manifest', async () => {
    const files = new Set<string>();
    expect(CLOCK_BACKGROUND.variants.length).toBeGreaterThan(0);
    expect(CLOCK_BACKGROUND.grainOpacity).toBe(0.62);
    for (const variant of CLOCK_BACKGROUND.variants) {
      expect(variant.file).toMatch(
        /^\/assets\/screensaver\/backgrounds\/clock\/[a-z0-9-]+-[a-f0-9]{8}\.webp$/u,
      );
      expect(files.has(variant.file), variant.file).toBe(false);
      files.add(variant.file);
      const bytes = await readFile(resolve(process.cwd(), 'public', variant.file.slice(1)));
      const hash = createHash('sha256').update(bytes).digest('hex');
      expect(variant.file.endsWith(`-${hash.slice(0, 8)}.webp`), variant.file).toBe(true);
      expect(bytes.length, variant.file).toBe(variant.bytes);
      expect(bytes.toString('ascii', 0, 4), variant.file).toBe('RIFF');
      expect(bytes.toString('ascii', 8, 12), variant.file).toBe('WEBP');
      for (const dimension of [
        variant.width,
        variant.height,
        variant.viewportWidth,
        variant.viewportHeight,
      ]) {
        expect(Number.isFinite(dimension) && dimension > 0, variant.file).toBe(true);
      }
    }
  });

  it('keeps the clock-only runtime off the retired scene backgrounds', async () => {
    const source = await readFile(
      new URL('../../../browser/auxiliary-runtime/screensaver.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/photo-|air-[a-z]|assets\/backgrounds\//u);
    expect(source).not.toMatch(/open-meteo|geolocation/iu);
  });
});
