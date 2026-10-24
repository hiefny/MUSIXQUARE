/**
 * A 2D context double that keeps the stroke bookkeeping of WebKit's GPU-process
 * canvas recorder (RemoteGraphicsContextProxy before the WebKit Recorder state
 * rework of August 2026; checked at WebKit cb0ff890 and 564c069cbc).
 *
 * - The recorder remembers the state it last sent. A setter marks a property
 *   pending only when it differs from that state. A gradient brush is the same
 *   when it is the same gradient object, and it keeps the last solid colour set.
 * - A drawing call with anything pending sends it and remembers the whole state.
 * - A one-segment line with a solid colour, when only the stroke colour or width
 *   is pending, is batched with that colour. Only the colour of the remembered
 *   brush is updated, so its old gradient stays.
 *
 * So setting the same gradient object again after a batched solid line is
 * elided, and the stroke paints with that line's colour. Save/restore levels and
 * other state are not modelled.
 */
type Brush = { color: string; gradient: object | null };

export function webKitStrokeRecorder(
  canvas: { width: number; height: number } = { width: 604, height: 240 },
) {
  let brush: Brush = { color: '#000', gradient: null };
  let fill: unknown = '#000';
  let width = 1;
  let sent: { brush: Brush; fill: unknown; width: number } | null = null;
  const pending = { brush: false, fill: false, width: false };
  let painting: string | object = '#000';
  let segments = 0;
  const painted: Array<string | object> = [];

  const sameBrush = (a: Brush, b: Brush) => a.color === b.color && a.gradient === b.gradient;
  const clearPending = () => {
    pending.brush = pending.fill = pending.width = false;
  };
  const flush = () => {
    if (!pending.brush && !pending.fill && !pending.width) return;
    if (pending.brush) painting = brush.gradient ?? brush.color;
    sent = { brush: { ...brush }, fill, width };
    clearPending();
  };

  const context = {
    canvas,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    setTransform: () => {},
    save: flush,
    restore: flush,
    clip: flush,
    clearRect: flush,
    fill: flush,
    fillRect: flush,
    closePath: () => {},
    arc: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    globalCompositeOperation: 'source-over',
    get strokeStyle(): string | object {
      return brush.gradient ?? brush.color;
    },
    set strokeStyle(style: string | object) {
      const next: Brush =
        typeof style === 'string'
          ? { color: style, gradient: null }
          : { color: brush.color, gradient: style };
      if (sameBrush(next, brush)) return;
      brush = next;
      pending.brush = !sent || !sameBrush(sent.brush, brush);
    },
    get fillStyle(): unknown {
      return fill;
    },
    set fillStyle(style: unknown) {
      if (style === fill) return;
      fill = style;
      pending.fill = !sent || sent.fill !== fill;
    },
    get lineWidth(): number {
      return width;
    },
    set lineWidth(value: number) {
      if (value === width) return;
      width = value;
      pending.width = !sent || sent.width !== width;
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
      if (segments === 1 && !brush.gradient && !pending.fill) {
        painting = brush.color;
        if (!sent) sent = { brush: { ...brush }, fill, width };
        else {
          if (pending.brush) sent.brush.color = brush.color;
          if (pending.width) sent.width = width;
        }
        clearPending();
      } else flush();
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
