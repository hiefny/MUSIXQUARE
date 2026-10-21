import { log } from '../core/log.ts';
import { dbToY } from './visualizer-spectrum-static.ts';
import { buildSpectrumDitherStrip, SPECTRUM_DITHER_TILE_SIZE } from './spectrum-dither.ts';

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const LOG_MIN_FREQ = Math.log10(MIN_FREQ);
const LOG_FREQ_RANGE = Math.log10(MAX_FREQ) - LOG_MIN_FREQ;
const GRID_FREQUENCIES = [100, 1000, 10000] as const;

export type SpectrumPoint = { x: number; y: number };

interface SpectrumBinLayout {
  bufferLength: number;
  sampleRate: number;
  logicalW: number;
  padX: number;
  indices: number[];
  xValues: number[];
  slopeValues: number[];
  gridXValues: number[];
  binStarts: number[];
  binEnds: number[];
}

function freqToX(freq: number, width: number, padX: number): number {
  return padX + ((Math.log10(freq) - LOG_MIN_FREQ) / LOG_FREQ_RANGE) * (width - 2 * padX);
}

export function createSpectrumBinLayout(
  bufferLength: number,
  sampleRate: number,
  logicalW: number,
  padX: number,
): SpectrumBinLayout {
  const indices: number[] = [];
  const xValues: number[] = [];
  const slopeValues: number[] = [];
  const binStarts: number[] = [];
  const binEnds: number[] = [];
  const binHz = sampleRate / (bufferLength * 2);

  for (let i = 1; i < bufferLength; i += Math.max(1, Math.floor(i / 64))) {
    const frequency = i * binHz;
    if (frequency < MIN_FREQ) continue;
    if (frequency > MAX_FREQ) break;
    indices.push(i);
    xValues.push(freqToX(frequency, logicalW, padX));
    slopeValues.push(4.5 * Math.log2(frequency / 1000));
  }

  // Keep the established x positions, but include every bin between them.
  // A geometric midpoint is halfway between neighboring centers on the log axis.
  let start = Math.max(1, Math.ceil(MIN_FREQ / binHz));
  const end = Math.min(bufferLength, Math.floor(MAX_FREQ / binHz) + 1);
  for (let i = 0; i < indices.length; i++) {
    const next =
      i + 1 < indices.length ? Math.floor(Math.sqrt(indices[i] * indices[i + 1])) + 1 : end;
    binStarts.push(start);
    binEnds.push(next);
    start = next;
  }

  return {
    bufferLength,
    sampleRate,
    logicalW,
    padX,
    indices,
    xValues,
    slopeValues,
    gridXValues: GRID_FREQUENCIES.map((frequency) => freqToX(frequency, logicalW, padX)),
    binStarts,
    binEnds,
  };
}

/** Peak aggregation keeps narrow tones that used to fall between sampled bins. */
export function updateSpectrumPoints(
  points: SpectrumPoint[],
  data: Float32Array,
  layout: SpectrumBinLayout,
  logicalH: number,
  padY: number,
): void {
  points.length = layout.indices.length;
  for (let i = 0; i < points.length; i++) {
    let peak = -Infinity;
    for (let bin = layout.binStarts[i]; bin < layout.binEnds[i]; bin++) {
      const value = data[bin];
      if (Number.isFinite(value) && value > peak) peak = value;
    }
    const point = points[i] ?? { x: 0, y: 0 };
    point.x = layout.xValues[i];
    point.y = dbToY(peak + layout.slopeValues[i], logicalH, padY);
    points[i] = point;
  }
}

interface DitherCache {
  context: CanvasRenderingContext2D;
  physicalHeight: number;
  logicalHeight: number;
  padY: number;
  maxAlpha: number;
  pattern: CanvasPattern;
}

let ditherCache: DitherCache | null = null;

function getSpectrumDitherPattern(
  ctx: CanvasRenderingContext2D,
  logicalHeight: number,
  padY: number,
  isLight: boolean,
): CanvasPattern | null {
  if (typeof document === 'undefined' || typeof ctx.createPattern !== 'function') return null;
  const physicalHeight = ctx.canvas.height;
  const maxAlpha = isLight ? 0.15 : 0.12;
  const cached = ditherCache;
  if (
    cached?.context === ctx &&
    cached.physicalHeight === physicalHeight &&
    cached.logicalHeight === logicalHeight &&
    cached.padY === padY &&
    cached.maxAlpha === maxAlpha
  ) {
    return cached.pattern;
  }
  try {
    const tile = document.createElement('canvas');
    tile.width = SPECTRUM_DITHER_TILE_SIZE;
    tile.height = physicalHeight;
    const tileContext = tile.getContext('2d');
    if (!tileContext) return null;
    const imageData = tileContext.createImageData(tile.width, tile.height);
    imageData.data.set(buildSpectrumDitherStrip(physicalHeight, logicalHeight, padY, maxAlpha));
    tileContext.putImageData(imageData, 0, 0);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return null;
    ditherCache = { context: ctx, physicalHeight, logicalHeight, padY, maxAlpha, pattern };
    return pattern;
  } catch (error) {
    log.debug('[Visualizer] spectrum dither unavailable:', error);
    return null;
  }
}

// The synchronous renderer reuses these coordinates for fill and stroke.
const midpointX: number[] = [];
const midpointY: number[] = [];

export function drawSpectrumCurve(
  ctx: CanvasRenderingContext2D,
  points: SpectrumPoint[],
  logicalH: number,
  padX: number,
  padY: number,
  isLight: boolean,
): void {
  if (points.length < 2) return;
  for (let i = 0; i < points.length - 1; i++) {
    midpointX[i] = (points[i].x + points[i + 1].x) / 2;
    midpointY[i] = (points[i].y + points[i + 1].y) / 2;
  }
  ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
  ctx.beginPath();
  ctx.moveTo(padX, logicalH - padY);
  ctx.lineTo(padX, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    ctx.quadraticCurveTo(points[i].x, points[i].y, midpointX[i], midpointY[i]);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.lineTo(last.x, logicalH - padY);
  ctx.closePath();
  const pattern = getSpectrumDitherPattern(ctx, logicalH, padY, isLight);
  if (pattern) {
    ctx.save();
    ctx.clip();
    // Keep the ordered threshold cells aligned to physical pixels.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  } else {
    const gradient = ctx.createLinearGradient(0, padY, 0, logicalH - padY);
    gradient.addColorStop(0, isLight ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.12)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    ctx.quadraticCurveTo(points[i].x, points[i].y, midpointX[i], midpointY[i]);
  }
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}
