import { describe, expect, it } from 'vitest';
import { buildSpectrumDitherStrip, SPECTRUM_DITHER_TILE_SIZE } from '../spectrum-dither.ts';

describe('spectrum ordered dithering', () => {
  it('preserves a half-step alpha average across the complete threshold matrix', () => {
    const rgba = buildSpectrumDitherStrip(
      SPECTRUM_DITHER_TILE_SIZE,
      SPECTRUM_DITHER_TILE_SIZE,
      100,
      30.5 / 255,
    );
    const values = Array.from(rgba).filter((_, index) => index % 4 === 3);

    expect(values.filter((value) => value === 30)).toHaveLength(32);
    expect(values.filter((value) => value === 31)).toHaveLength(32);
    expect(values.reduce((sum, value) => sum + value, 0) / values.length).toBe(30.5);
  });

  it('applies the 160% spread symmetrically around an integer alpha', () => {
    const rgba = buildSpectrumDitherStrip(
      SPECTRUM_DITHER_TILE_SIZE,
      SPECTRUM_DITHER_TILE_SIZE,
      100,
      30 / 255,
    );
    const values = Array.from(rgba).filter((_, index) => index % 4 === 3);

    expect(values.filter((value) => value === 29)).toHaveLength(12);
    expect(values.filter((value) => value === 30)).toHaveLength(40);
    expect(values.filter((value) => value === 31)).toHaveLength(12);
    expect(values.reduce((sum, value) => sum + value, 0) / values.length).toBe(30);
  });

  it('clamps alpha endpoints without introducing noise', () => {
    const transparent = buildSpectrumDitherStrip(8, 8, 100, -1);
    const opaque = buildSpectrumDitherStrip(8, 8, 100, 2);
    expect(Array.from(transparent).filter((_, index) => index % 4 === 3)).toEqual(
      Array(64).fill(0),
    );
    expect(Array.from(opaque).filter((_, index) => index % 4 === 3)).toEqual(Array(64).fill(255));
  });

  it('builds a blue full-height strip with a transparent lower endpoint', () => {
    const physicalHeight = 64;
    const rgba = buildSpectrumDitherStrip(physicalHeight, 32, 4, 0.12);
    expect(rgba).toHaveLength(SPECTRUM_DITHER_TILE_SIZE * physicalHeight * 4);

    for (let x = 0; x < SPECTRUM_DITHER_TILE_SIZE; x++) {
      const topOffset = x * 4;
      const bottomOffset = ((physicalHeight - 1) * SPECTRUM_DITHER_TILE_SIZE + x) * 4;
      expect(Array.from(rgba.slice(topOffset, topOffset + 3))).toEqual([59, 130, 246]);
      expect(rgba[topOffset + 3]).toBeGreaterThan(0);
      expect(rgba[bottomOffset + 3]).toBe(0);
    }
  });
});
