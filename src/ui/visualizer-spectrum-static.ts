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

interface GridCache {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  logicalHeight: number;
  padY: number;
  isLight: boolean;
  transform: DOMMatrix;
  gradient: CanvasGradient;
}

let gridCache: GridCache | null = null;

export function drawSpectrumGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  padX: number,
  padY: number,
  isLight: boolean,
  gridXValues?: readonly number[],
): void {
  const transform = ctx.getTransform?.();
  const cached = gridCache;
  let gradient = cached?.gradient;
  if (
    !transform ||
    !cached ||
    cached.context !== ctx ||
    cached.width !== ctx.canvas.width ||
    cached.height !== ctx.canvas.height ||
    cached.logicalHeight !== height ||
    cached.padY !== padY ||
    cached.isLight !== isLight ||
    cached.transform.a !== transform.a ||
    cached.transform.b !== transform.b ||
    cached.transform.c !== transform.c ||
    cached.transform.d !== transform.d ||
    cached.transform.e !== transform.e ||
    cached.transform.f !== transform.f
  ) {
    gradient = ctx.createLinearGradient(0, padY, 0, height - padY);
    const color = isLight ? '0,0,0' : '255,255,255';
    gradient.addColorStop(0, `rgba(${color},0)`);
    gradient.addColorStop(0.15, `rgba(${color},0.06)`);
    gradient.addColorStop(0.85, `rgba(${color},0.06)`);
    gradient.addColorStop(1, `rgba(${color},0)`);
    // Older/constrained contexts can still share one gradient within this draw.
    gridCache = transform
      ? {
          context: ctx,
          width: ctx.canvas.width,
          height: ctx.canvas.height,
          logicalHeight: height,
          padY,
          isLight,
          transform,
          gradient,
        }
      : null;
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = gradient!;
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
