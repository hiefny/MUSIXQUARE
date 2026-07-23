const BAYER_ORDER_8X8 = new Uint8Array([
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
]);

export const SPECTRUM_DITHER_TILE_SIZE = 8;
const SPECTRUM_BLUE = [59, 130, 246] as const;
const SPECTRUM_DITHER_STRENGTH = 1.6;

/**
 * Quantize an exact 8-bit alpha with a stable 8x8 ordered threshold.
 * The centered threshold is intentionally boosted to 160% (about +/-0.8
 * alpha LSB), preserving the original spatial average while replacing
 * visible horizontal bands with slightly stronger sub-pixel-scale texture.
 */
function orderedDitherAlphaByte(exactAlphaByte: number, x: number, y: number): number {
  const bounded = Math.max(0, Math.min(255, exactAlphaByte));
  if (bounded <= 0) return 0;
  if (bounded >= 255) return 255;

  const matrixX =
    ((Math.trunc(x) % SPECTRUM_DITHER_TILE_SIZE) + SPECTRUM_DITHER_TILE_SIZE) %
    SPECTRUM_DITHER_TILE_SIZE;
  const matrixY =
    ((Math.trunc(y) % SPECTRUM_DITHER_TILE_SIZE) + SPECTRUM_DITHER_TILE_SIZE) %
    SPECTRUM_DITHER_TILE_SIZE;
  const rank = BAYER_ORDER_8X8[matrixY * SPECTRUM_DITHER_TILE_SIZE + matrixX];
  const threshold = (rank + 0.5) / (SPECTRUM_DITHER_TILE_SIZE * SPECTRUM_DITHER_TILE_SIZE);
  const centeredOffset = (0.5 - threshold) * SPECTRUM_DITHER_STRENGTH;
  return Math.max(0, Math.min(255, Math.round(bounded + centeredOffset)));
}

/**
 * Build a narrow, full-height RGBA strip that repeats horizontally at device
 * pixel scale. The alpha ramp matches the existing Canvas gradient exactly;
 * only its 8-bit quantization is spatially distributed.
 */
export function buildSpectrumDitherStrip(
  physicalHeight: number,
  logicalHeight: number,
  padY: number,
  maxAlpha: number,
): Uint8ClampedArray {
  const safePhysicalHeight = Math.max(1, Math.trunc(physicalHeight));
  const safeLogicalHeight = Math.max(1, logicalHeight);
  const scaleY = safePhysicalHeight / safeLogicalHeight;
  const gradientSpan = Math.max(Number.EPSILON, safeLogicalHeight - padY * 2);
  const rgba = new Uint8ClampedArray(SPECTRUM_DITHER_TILE_SIZE * safePhysicalHeight * 4);

  for (let y = 0; y < safePhysicalHeight; y++) {
    const logicalY = (y + 0.5) / scaleY;
    const progress = Math.max(0, Math.min(1, (logicalY - padY) / gradientSpan));
    const exactAlphaByte = Math.max(0, Math.min(1, maxAlpha)) * (1 - progress) * 255;

    for (let x = 0; x < SPECTRUM_DITHER_TILE_SIZE; x++) {
      const offset = (y * SPECTRUM_DITHER_TILE_SIZE + x) * 4;
      rgba[offset] = SPECTRUM_BLUE[0];
      rgba[offset + 1] = SPECTRUM_BLUE[1];
      rgba[offset + 2] = SPECTRUM_BLUE[2];
      rgba[offset + 3] = orderedDitherAlphaByte(exactAlphaByte, x, y);
    }
  }

  return rgba;
}
