/**
 * A 2D context double that keeps the stroke bookkeeping of WebKit's GPU-process
 * canvas recorder (RemoteGraphicsContextProxy, as shipped before the WebKit
 * Recorder state rework of August 2026).
 *
 * - A gradient brush equals the remembered one when it is the same gradient
 *   object; its solid colour field keeps the last solid colour set.
 * - A one-segment line with a solid colour is batched with that colour. Only the
 *   colour of the remembered brush is updated, so its old gradient stays.
 * - Any other stroke sends a pending brush change and remembers the whole brush.
 *
 * So setting the same gradient object again after a batched solid line is
 * elided, and the stroke paints with that line's colour.
 */
type Brush = { color: string; gradient: object | null };

export function webKitStrokeRecorder(
  canvas: { width: number; height: number } = { width: 604, height: 240 },
) {
  let brush: Brush = { color: '#000', gradient: null };
  let remembered: Brush | null = null;
  let changed = false;
  let painting: string | object = '#000';
  let segments = 0;
  const painted: Array<string | object> = [];

  const context = {
    canvas,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    setTransform: () => {},
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    clip: () => {},
    fill: () => {},
    fillRect: () => {},
    closePath: () => {},
    arc: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    globalCompositeOperation: 'source-over',
    fillStyle: '' as unknown,
    lineWidth: 1,
    get strokeStyle(): string | object {
      return brush.gradient ?? brush.color;
    },
    set strokeStyle(style: string | object) {
      brush =
        typeof style === 'string'
          ? { color: style, gradient: null }
          : { color: brush.color, gradient: style };
      changed =
        !remembered || remembered.color !== brush.color || remembered.gradient !== brush.gradient;
    },
    beginPath: () => {
      segments = 0;
    },
    moveTo: () => {},
    lineTo: () => {
      segments++;
    },
    quadraticCurveTo: () => {
      segments++;
    },
    stroke: () => {
      if (segments === 1 && !brush.gradient) {
        painting = brush.color;
        if (remembered) remembered.color = brush.color;
        else remembered = { ...brush };
      } else {
        if (changed) painting = brush.gradient ?? brush.color;
        remembered = { ...brush };
      }
      changed = false;
      painted.push(painting);
    },
  };

  return {
    context,
    ctx: context as unknown as CanvasRenderingContext2D,
    /** The style each stroke() call actually painted with, in call order. */
    painted,
  };
}
