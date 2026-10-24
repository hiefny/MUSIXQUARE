const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -100;
const MAX_DB = 0;
const LOG_MIN_FREQ = Math.log10(MIN_FREQ);
const LOG_FREQ_RANGE = Math.log10(MAX_FREQ) - LOG_MIN_FREQ;
const GRID_FREQUENCIES = [100, 1000, 10000] as const;

function freqToX(freq: number, width: number, padX: number): number {
  return padX + ((Math.log10(freq) - LOG_MIN_FREQ) / LOG_FREQ_RANGE) * (width - 2 * padX);
}

export function dbToY(db: number, height: number, padY: number): number {
  const clamped = Number.isNaN(db) ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, db));
  return padY + (1 - (clamped - MIN_DB) / (MAX_DB - MIN_DB)) * (height - 2 * padY);
}

export function drawSpectrumGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  padX: number,
  padY: number,
  isLight: boolean,
  gridXValues?: readonly number[],
): void {
  // One new gradient per draw. WebKit's GPU canvas recorder can treat a gradient
  // object it saw before a one-segment solid line (the resting line) as already
  // applied, and then strokes the grid in that line's blue.
  const gradient = ctx.createLinearGradient(0, padY, 0, height - padY);
  const color = isLight ? '0,0,0' : '255,255,255';
  gradient.addColorStop(0, `rgba(${color},0)`);
  gradient.addColorStop(0.15, `rgba(${color},0.06)`);
  gradient.addColorStop(0.85, `rgba(${color},0.06)`);
  gradient.addColorStop(1, `rgba(${color},0)`);
  ctx.lineWidth = 1;
  ctx.strokeStyle = gradient;
  const xValues =
    gridXValues ?? GRID_FREQUENCIES.map((frequency) => freqToX(frequency, width, padX));
  for (const x of xValues) {
    ctx.beginPath();
    ctx.moveTo(x, padY);
    ctx.lineTo(x, height - padY);
    ctx.stroke();
  }
}

export function drawSpectrumRestingLine(
  ctx: CanvasRenderingContext2D,
  logicalW: number,
  logicalH: number,
  padX: number,
  padY: number,
): void {
  const restY = dbToY(MIN_DB, logicalH, padY);
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.38)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, restY);
  ctx.lineTo(logicalW - padX, restY);
  ctx.stroke();
}
