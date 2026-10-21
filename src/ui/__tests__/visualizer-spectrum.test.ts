/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSpectrumBinLayout,
  drawSpectrumCurve,
  updateSpectrumPoints,
  type SpectrumPoint,
} from '../visualizer-spectrum.ts';
import { dbToY, drawSpectrumGrid } from '../visualizer-spectrum-static.ts';

vi.mock('../../core/log.ts', () => ({ log: { debug: vi.fn() } }));

afterEach(() => vi.restoreAllMocks());

describe('spectrum aggregation', () => {
  it.each([44100, 48000, 96000])('covers every audible bin once at %i Hz', (sampleRate) => {
    const layout = createSpectrumBinLayout(2048, sampleRate, 604, 4);
    const visited = new Uint8Array(2048);
    for (let i = 0; i < layout.indices.length; i++) {
      expect(layout.binStarts[i]).toBeLessThanOrEqual(layout.indices[i]);
      expect(layout.binEnds[i]).toBeGreaterThan(layout.indices[i]);
      for (let bin = layout.binStarts[i]; bin < layout.binEnds[i]; bin++) visited[bin]++;
    }
    for (let bin = 0; bin < visited.length; bin++) {
      const frequency = (bin * sampleRate) / 4096;
      expect(visited[bin]).toBe(frequency >= 20 && frequency <= 20000 ? 1 : 0);
    }
  });

  it('retains a narrow high tone between sampled centers and excludes out-of-band data', () => {
    const layout = createSpectrumBinLayout(2048, 48000, 604, 4);
    expect(layout.indices).toHaveLength(310);
    expect(layout.indices).not.toContain(1692);
    const data = new Float32Array(2048).fill(-Infinity);
    data[1692] = -32; // 19,828.125 Hz, previously skipped between the last two centers.
    data[0] = 0;
    data[2000] = 0; // Above the displayed 20 kHz limit.
    const points: SpectrumPoint[] = [];
    updateSpectrumPoints(points, data, layout, 240, 8);
    expect(points.filter((point) => point.y < 232)).toHaveLength(1);
    const peak = points.findIndex((point) => point.y < 232);
    expect(layout.binStarts[peak]).toBeLessThanOrEqual(1692);
    expect(layout.binEnds[peak]).toBeGreaterThan(1692);
  });

  it('reuses point objects and maps nonfinite data to the resting baseline', () => {
    const layout = createSpectrumBinLayout(2048, 48000, 604, 4);
    const points: SpectrumPoint[] = [];
    const data = new Float32Array(2048).fill(-30);
    updateSpectrumPoints(points, data, layout, 240, 8);
    const first = points[0];
    const last = points[points.length - 1];
    data.fill(NaN);
    data[100] = Infinity;
    updateSpectrumPoints(points, data, layout, 240, 8);
    expect(points[0]).toBe(first);
    expect(points[points.length - 1]).toBe(last);
    expect(points.every((point) => point.y === 232 && Number.isFinite(point.x))).toBe(true);
    expect(dbToY(NaN, 240, 8)).toBe(232);
  });
});

function drawingContext() {
  const transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const context = {
    canvas: { width: 604, height: 240 },
    getTransform: vi.fn(() => ({ ...transform })),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    clip: vi.fn(),
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    restore: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  };
  return { context, transform, ctx: context as unknown as CanvasRenderingContext2D };
}

describe('spectrum drawing caches', () => {
  it('shares a gradient without retaining stale theme, geometry, density, or transforms', () => {
    const { context, transform, ctx } = drawingContext();
    const draw = (height = 240, pad = 8, light = false) =>
      drawSpectrumGrid(ctx, 604, height, 4, pad, light);
    draw();
    draw();
    expect(context.createLinearGradient).toHaveBeenCalledTimes(1);
    expect(context.stroke).toHaveBeenCalledTimes(6);
    draw(240, 8, true);
    draw(240, 9, true);
    draw(180, 9, true);
    context.canvas.width = 1208;
    context.canvas.height = 480;
    transform.a = 2;
    transform.d = 2;
    draw(180, 9, true);
    transform.e = 1;
    draw(180, 9, true);
    expect(context.createLinearGradient).toHaveBeenCalledTimes(6);
    const other = drawingContext();
    drawSpectrumGrid(other.ctx, 604, 240, 4, 8, false);
    expect(other.context.createLinearGradient).toHaveBeenCalledTimes(1);
  });

  it('still draws with a context that cannot report its transform', () => {
    const { context, ctx } = drawingContext();
    Object.defineProperty(ctx, 'getTransform', { value: undefined });
    drawSpectrumGrid(ctx, 604, 240, 4, 8, false);
    drawSpectrumGrid(ctx, 604, 240, 4, 8, false);
    expect(context.createLinearGradient).toHaveBeenCalledTimes(2);
    expect(context.stroke).toHaveBeenCalledTimes(6);
  });

  it('preserves the open stroke and closed fill with the gradient fallback', () => {
    const { context, ctx } = drawingContext();
    const points = [
      { x: 4, y: 90 },
      { x: 80, y: 45 },
      { x: 300, y: 80 },
    ];
    drawSpectrumCurve(ctx, points, 240, 4, 8, false);
    expect(context.quadraticCurveTo.mock.calls).toEqual([
      [4, 90, 42, 67.5],
      [80, 45, 190, 62.5],
      [4, 90, 42, 67.5],
      [80, 45, 190, 62.5],
    ]);
    expect(context.moveTo.mock.calls).toEqual([
      [4, 232],
      [4, 90],
    ]);
    expect(context.lineTo.mock.calls).toEqual([
      [4, 90],
      [300, 80],
      [300, 232],
      [300, 80],
    ]);
    expect(context.closePath).toHaveBeenCalledTimes(1);
    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.globalCompositeOperation).toBe('lighter');
    // A later, shorter curve must not replay stale scratch coordinates.
    context.quadraticCurveTo.mockClear();
    drawSpectrumCurve(ctx, points.slice(0, 2), 240, 4, 8, true);
    expect(context.quadraticCurveTo.mock.calls).toEqual([
      [4, 90, 42, 67.5],
      [4, 90, 42, 67.5],
    ]);
    expect(context.globalCompositeOperation).toBe('source-over');
  });

  it('keeps the dither in physical pixels and retains gradient fallback on pattern failure', () => {
    const { context, ctx } = drawingContext();
    context.canvas.width = 1208;
    context.canvas.height = 480;
    const pattern = {} as CanvasPattern;
    const createPattern = vi.fn(() => pattern);
    Object.assign(ctx, { createPattern });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const points = [
      { x: 4, y: 90 },
      { x: 300, y: 80 },
    ];
    drawSpectrumCurve(ctx, points, 240, 4, 8, false);
    drawSpectrumCurve(ctx, points, 240, 4, 8, false);
    expect(createPattern).toHaveBeenCalledTimes(1);
    expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1208, 480);
    expect(context.restore).toHaveBeenCalledTimes(2);
    createPattern.mockImplementation(() => {
      throw new Error('Unsupported pattern');
    });
    drawSpectrumCurve(ctx, points, 240, 4, 8, true);
    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(context.stroke).toHaveBeenCalledTimes(3);
  });
});
