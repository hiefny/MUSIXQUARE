import type { FrameLocator, Page } from '@playwright/test';

interface CaptionInkSample {
  text: string;
  expectedPixels: number;
  missingPixels: number;
  unexpectedPixels: number;
  clippedPixels: number;
}

export interface CaptionInkEvidence {
  text: string;
  samples: CaptionInkSample[];
}

type CaptionProbeWindow = Window & {
  __mxqrCaptionInkProbe(): CaptionInkEvidence;
};

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
            !paints.every((paint) => paint.font.startsWith('500 ') && /^[A-Z]$/u.test(paint.text))
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
          samples.push({
            text: paints.map((paint) => paint.text).join(''),
            expectedPixels,
            missingPixels,
            unexpectedPixels,
            clippedPixels,
          });
        }
        return { text: samples.map((sample) => sample.text).join(''), samples };
      },
    });
  });
}

export async function readCaptionInk(child: FrameLocator): Promise<CaptionInkEvidence> {
  return child
    .locator('body')
    .evaluate(() => (window as unknown as CaptionProbeWindow).__mxqrCaptionInkProbe());
}
