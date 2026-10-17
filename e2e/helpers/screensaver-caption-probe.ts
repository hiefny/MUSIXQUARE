import type { FrameLocator, Page } from '@playwright/test';

interface CaptionInkSample {
  text: string;
  expectedPixels: number;
  missingPixels: number;
  unexpectedPixels: number;
  clippedPixels: number;
  halo: {
    pixels: number;
    bluePixels: number;
    outsideInkPixels: number;
    edgePixels: number;
    maxAlpha: number;
  } | null;
}

export interface CaptionInkEvidence {
  text: string;
  samples: CaptionInkSample[];
}

interface InfoGlyphGeometry {
  scene: string;
  width: number;
  height: number;
  glyphs: {
    char: string;
    role: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }[];
}

type CaptionProbeWindow = Window & {
  __mxqrCaptionInkProbe(): CaptionInkEvidence;
  __mxqrInfoGeometryProbe(): InfoGlyphGeometry | null;
};

export async function installInfoGeometryProbe(page: Page): Promise<void> {
  // Append read-only instrumentation to the served build, never production
  // source. The auxiliary build intentionally preserves names and its IIFE.
  await page.route(/\/assets\/screensaver-runtime-[a-f0-9]+\.js(?:\?.*)?$/u, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const ending = /\}\)\(\);\s*$/u;
    if (!/\b(?:var|let) currentInfoScene = null;/u.test(source) || !ending.test(source))
      throw new Error('Screensaver build no longer supports test-only geometry instrumentation');
    const probe = `
      Object.defineProperty(window, '__mxqrInfoGeometryProbe', { value: () => {
        if (!currentInfoScene) return null;
        const { name, layout, glyphs } = currentInfoScene;
        return {
          scene: name,
          width: layout.w,
          height: layout.h,
          glyphs: glyphs.map(({ char, role, x, y, metrics }) => ({
            char, role,
            left: x - metrics.actualBoundingBoxLeft,
            right: x + metrics.actualBoundingBoxRight,
            top: y - metrics.actualBoundingBoxAscent,
            bottom: y + metrics.actualBoundingBoxDescent,
          })),
        };
      }});
    `;
    await route.fulfill({ response, body: source.replace(ending, `${probe}\n})();`) });
  });
}

export async function readInfoGlyphBounds(child: FrameLocator) {
  return child.locator('body').evaluate(() => {
    const geometry = (window as unknown as CaptionProbeWindow).__mxqrInfoGeometryProbe();
    if (!geometry?.glyphs.length) throw new Error('Missing screensaver glyph geometry');
    // Union the positioned glyphs independently of layout.bounds. Moon's
    // synthetic glyph describes the full disc, irrespective of lunar phase.
    for (const glyph of geometry.glyphs) {
      if (![glyph.left, glyph.right, glyph.top, glyph.bottom].every(Number.isFinite))
        throw new Error(`Invalid screensaver glyph geometry: ${glyph.role}/${glyph.char}`);
    }
    const left = Math.min(...geometry.glyphs.map((glyph) => glyph.left));
    const right = Math.max(...geometry.glyphs.map((glyph) => glyph.right));
    const top = Math.min(...geometry.glyphs.map((glyph) => glyph.top));
    const bottom = Math.max(...geometry.glyphs.map((glyph) => glyph.bottom));
    return {
      ...geometry,
      left,
      right,
      top,
      bottom,
      centerOffset: (left + right) / 2 - geometry.width / 2,
    };
  });
}

export async function installCaptionInkProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Paint {
      text: string;
      x: number;
      y: number;
      font: string;
      alpha: number;
      fillStyle: string;
      align: CanvasTextAlign;
      baseline: CanvasTextBaseline;
      kerning: CanvasFontKerning;
      direction: CanvasDirection;
      transform: [number, number, number, number, number, number];
    }
    const records = new WeakMap<HTMLCanvasElement, Paint[]>();
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
      records.set(this.canvas, []);
      clearRect.call(this, x, y, width, height);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (typeof this.fillStyle === 'string') {
        const paints = records.get(this.canvas) || [];
        const { a, b, c, d, e, f } = this.getTransform();
        paints.push({
          text,
          x,
          y,
          font: this.font,
          alpha: this.globalAlpha,
          fillStyle: this.fillStyle,
          align: this.textAlign,
          baseline: this.textBaseline,
          kerning: this.fontKerning,
          direction: this.direction,
          transform: [a, b, c, d, e, f],
        });
        records.set(this.canvas, paints);
      }
      if (maxWidth === undefined) fillText.call(this, text, x, y);
      else fillText.call(this, text, x, y, maxWidth);
    };
    Object.assign(window, {
      __mxqrCaptionInkProbe() {
        const samples: CaptionInkSample[] = [];
        const canvases = document.querySelectorAll<HTMLCanvasElement>(
          '[data-compat-compositor="weatherCanvas"] canvas',
        );
        for (const canvas of canvases) {
          const paints = records.get(canvas);
          if (
            !paints?.length ||
            !paints.every(
              (paint) => paint.font.startsWith('500 ') && /^[A-Za-z]$/u.test(paint.text),
            )
          )
            continue;
          let visible = true;
          for (let node: Element | null = canvas; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0)
              visible = false;
          }
          if (!visible || !canvas.width || !canvas.height) continue;

          // Replay direct text into a larger surface, independent of compositor
          // allocation. Ink outside the source surface is genuine clipping.
          const margin = 32;
          const reference = document.createElement('canvas');
          reference.width = canvas.width + margin * 2;
          reference.height = canvas.height + margin * 2;
          const context = reference.getContext('2d', { willReadFrequently: true })!;
          for (const paint of paints) {
            const [a, b, c, d, e, f] = paint.transform;
            context.setTransform(a, b, c, d, e + margin, f + margin);
            context.font = paint.font;
            context.globalAlpha = paint.alpha;
            context.fillStyle = paint.fillStyle;
            context.textAlign = paint.align;
            context.textBaseline = paint.baseline;
            context.fontKerning = paint.kerning;
            context.direction = paint.direction;
            fillText.call(context, paint.text, paint.x, paint.y);
          }
          const referencePixels = context.getImageData(
            0,
            0,
            reference.width,
            reference.height,
          ).data;
          const actual = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let expectedPixels = 0;
          let missingPixels = 0;
          let unexpectedPixels = 0;
          let clippedPixels = 0;
          for (let y = 0; y < reference.height; y++) {
            for (let x = 0; x < reference.width; x++) {
              const expected = referencePixels[(y * reference.width + x) * 4 + 3]!;
              const inside =
                x >= margin &&
                y >= margin &&
                x < canvas.width + margin &&
                y < canvas.height + margin;
              if (!inside) {
                if (expected > 2) clippedPixels++;
                continue;
              }
              const observed = actual[((y - margin) * canvas.width + x - margin) * 4 + 3]!;
              if (expected > 2) expectedPixels++;
              if (expected - observed > 2) missingPixels++;
              if (observed - expected > 2) unexpectedPixels++;
            }
          }
          const bounds = canvas.getBoundingClientRect();
          const haloCanvas = [...canvases].find((candidate) => {
            if (candidate === canvas || records.get(candidate)?.length) return false;
            if (candidate.width !== canvas.width || candidate.height !== canvas.height)
              return false;
            const other = candidate.getBoundingClientRect();
            return (
              Math.abs(other.x - bounds.x) < 0.01 &&
              Math.abs(other.y - bounds.y) < 0.01 &&
              Math.abs(other.width - bounds.width) < 0.01 &&
              Math.abs(other.height - bounds.height) < 0.01
            );
          });
          let halo: CaptionInkSample['halo'] = null;
          if (haloCanvas) {
            halo = { pixels: 0, bluePixels: 0, outsideInkPixels: 0, edgePixels: 0, maxAlpha: 0 };
            const pixels = haloCanvas
              .getContext('2d')!
              .getImageData(0, 0, haloCanvas.width, haloCanvas.height).data;
            for (let y = 0; y < haloCanvas.height; y++) {
              for (let x = 0; x < haloCanvas.width; x++) {
                const index = (y * haloCanvas.width + x) * 4;
                const alpha = pixels[index + 3]!;
                halo.maxAlpha = Math.max(halo.maxAlpha, alpha);
                if (alpha <= 2) continue;
                halo.pixels++;
                if (pixels[index + 2]! > pixels[index]! + 40 && pixels[index + 1]! > pixels[index]!)
                  halo.bluePixels++;
                if (actual[index + 3]! <= 2) halo.outsideInkPixels++;
                if (x === 0 || y === 0 || x === haloCanvas.width - 1 || y === haloCanvas.height - 1)
                  halo.edgePixels++;
              }
            }
          }
          samples.push({
            text: paints.map((paint) => paint.text).join(''),
            expectedPixels,
            missingPixels,
            unexpectedPixels,
            clippedPixels,
            halo,
          });
        }
        return {
          text: samples
            .map((sample) => sample.text)
            .join('')
            .toUpperCase(),
          samples,
        };
      },
    });
  });
}

export async function readCaptionInk(child: FrameLocator): Promise<CaptionInkEvidence> {
  return child
    .locator('body')
    .evaluate(() => (window as unknown as CaptionProbeWindow).__mxqrCaptionInkProbe());
}

export async function readForegroundInkBounds(child: FrameLocator, canvasId = 'weatherCanvas') {
  return child.locator(`[data-compat-compositor="${canvasId}"]`).evaluate((root) => {
    const stage = root.getBoundingClientRect();
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const canvas of root.querySelectorAll('canvas')) {
      if (!canvas.width || !canvas.height) continue;
      let visible = true;
      for (let node: Element | null = canvas; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0)
          visible = false;
      }
      if (!visible) continue;
      const rect = canvas.getBoundingClientRect();
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          // Diagnostic high-alpha bounds: directional blur can remove unequal
          // amounts from opposite edges, so these are not a centering invariant.
          if (pixels[(y * canvas.width + x) * 4 + 3]! < 160) continue;
          left = Math.min(left, rect.left + (x * rect.width) / canvas.width);
          right = Math.max(right, rect.left + ((x + 1) * rect.width) / canvas.width);
          top = Math.min(top, rect.top + (y * rect.height) / canvas.height);
          bottom = Math.max(bottom, rect.top + ((y + 1) * rect.height) / canvas.height);
        }
      }
    }
    return {
      left,
      right,
      top,
      bottom,
      centerOffset: (left + right) / 2 - (stage.left + stage.width / 2),
      width: stage.width,
      height: stage.height,
    };
  });
}
