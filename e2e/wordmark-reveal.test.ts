import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

type WordmarkTimingWindow = Window & { __wordmarkStartedAt?: number };

async function openPausedSetup(page: Page): Promise<void> {
  const initialTime = new Date('2026-09-29T00:00:00Z');
  await page.clock.install({ time: initialTime });
  await page.clock.pauseAt(initialTime);
  await page.addInitScript(() => {
    document.addEventListener('mxqr:wordmark-start', () => {
      (window as WordmarkTimingWindow).__wordmarkStartedAt ??= performance.now();
    });
  });
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForBootstrapReady(page);
  await expect(page.locator('#setup-overlay')).toHaveClass(/\bactive\b/u);
}

async function advanceRevealTo(page: Page, milliseconds: number): Promise<void> {
  const elapsed = await page.evaluate(() => {
    const start = (window as WordmarkTimingWindow).__wordmarkStartedAt;
    if (start === undefined) throw new Error('Setup did not start its wordmark reveal');
    return performance.now() - start;
  });
  expect(
    elapsed,
    'The controlled clock must not already have passed this sample',
  ).toBeLessThanOrEqual(milliseconds);
  await page.clock.runFor(milliseconds - elapsed);
}

async function readMaskInstances(page: Page) {
  return page.locator('.logo-welcome').evaluateAll((logos) =>
    logos.map((logo) => ({
      id: logo.querySelector('[data-wordmark-mask]')?.id,
      mask: logo.querySelector('.wg')?.getAttribute('mask'),
      path: logo.querySelector('[data-wordmark-reveal]')?.getAttribute('d'),
      complete: (logo as SVGSVGElement).dataset.wordmarkDrawComplete,
    })),
  );
}

test.describe('setup wordmark reveal', () => {
  test('keeps the same unfinished reveal when resizing between mobile and cloned desktop headers', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPausedSetup(page);
    await advanceRevealTo(page, 800);
    const initial = await readMaskInstances(page);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.path).toBeTruthy();
    await expect(page.locator('.setup-greeting-row.is-visible')).toHaveCount(0);

    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await expect(page.locator('.logo-welcome')).toHaveCount(size.width >= 1280 ? 2 : 1);
      await page.clock.runFor(32);
      const instances = await readMaskInstances(page);
      expect(instances).toHaveLength(size.width >= 1280 ? 2 : 1);
      const maskIds = instances.map((instance) => instance.id);
      expect(maskIds.every(Boolean)).toBe(true);
      expect(new Set(maskIds).size).toBe(instances.length);
      for (const instance of instances) {
        expect(instance.mask).toBe(`url(#${instance.id})`);
        expect(instance.path).toBe(instances[0]?.path);
        expect(instance.path).not.toBe(initial[0]?.path);
        expect(instance.complete).not.toBe('true');
      }
      await expect(page.locator('.setup-greeting-row.is-visible')).toHaveCount(0);
    }

    await advanceRevealTo(page, 2_500);
    await expect(page.locator('.setup-greeting-row.is-visible')).toHaveCount(0);
    await advanceRevealTo(page, 2_600);
    await expect(page.locator('.setup-greeting-row.is-visible')).toHaveCount(2);
    for (const instance of await readMaskInstances(page)) expect(instance.complete).toBe('true');
    await advanceRevealTo(page, 3_000);
    await expect(page.locator('.logo-welcome > .wg[mask]')).toHaveCount(0);
  });

  test('does not reveal the later M stems or the second X diagonal ahead of their turn', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPausedSetup(page);
    await advanceRevealTo(page, 800);

    const coverage = await page.locator('.logo-welcome').evaluate((logo) => {
      const path = logo.querySelector<SVGPathElement>('[data-wordmark-reveal]');
      if (!path) throw new Error('The startup logo has no reveal mask');
      const contains = (x: number, y: number) => path.isPointInFill(new DOMPoint(x, y));
      return {
        // These samples are inside the actual logo but belong to strokes whose
        // scheduled drawing has not started at 800ms. Overscanning leaked here.
        middleMStem: contains(56, 17.6),
        lastMStem: contains(65, 17.6),
        secondXDiagonal: contains(125.5, 13.4),
        firstXDiagonal: contains(141, 16),
      };
    });
    expect(coverage).toEqual({
      middleMStem: false,
      lastMStem: false,
      secondXDiagonal: false,
      firstXDiagonal: true,
    });
    // The old separately painted strokes must be geometry inputs only.
    await expect(page.locator('.logo-welcome > .wl')).toHaveCount(0);
    await expect(page.locator('.logo-welcome [data-wordmark-reveal]')).toHaveCount(1);
  });

  test('rasterizes completed joins without internal seams at low and high pixel density', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPausedSetup(page);
    await advanceRevealTo(page, 2_550);

    // Render the real current SVG with each browser's own SVG rasterizer. The
    // unmasked canonical silhouette is the reference; no saved pixel snapshots
    // or copied reveal algorithm are involved.
    const samples = await page.locator('.logo-welcome').evaluate(async (logo) => {
      const definitions = logo.querySelector('defs');
      const silhouette = logo.querySelector<SVGGElement>('.wg');
      if (!definitions || !silhouette?.hasAttribute('mask')) {
        throw new Error('Expected the completed reveal to still be masked before cleanup');
      }
      const baseline = silhouette.cloneNode(true) as SVGGElement;
      baseline.removeAttribute('mask');
      const samples: Array<{
        height: number;
        dpr: number;
        offset: number;
        interior: number;
        seams: number;
        seamPixels: Array<{ x: number; y: number; alpha: number; neighbors: number[] }>;
      }> = [];
      for (const height of [22, 29]) {
        for (const dpr of [1, 2]) {
          for (const offset of [0, 0.25, 0.5, 0.75]) {
            const width = 300 * dpr;
            const canvasHeight = 60 * dpr;
            const draw = async (content: string) => {
              const svg =
                `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${canvasHeight}" viewBox="0 0 300 60">` +
                definitions.outerHTML +
                `<g fill="white" color="white" transform="translate(${4 + offset} ${4 + offset}) scale(${height / 24}) translate(-43 -12)">` +
                content +
                '</g></svg>';
              const image = new Image();
              image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
              await image.decode();
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = canvasHeight;
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Canvas unavailable for SVG raster regression');
              context.drawImage(image, 0, 0);
              return context.getImageData(0, 0, width, canvasHeight).data;
            };
            const expected = await draw(baseline.outerHTML);
            const actual = await draw(silhouette.outerHTML);
            let interior = 0;
            let seams = 0;
            const seamPixels: Array<{ x: number; y: number; alpha: number; neighbors: number[] }> =
              [];
            for (let y = 1; y < canvasHeight - 1; y += 1) {
              for (let x = 1; x < width - 1; x += 1) {
                const alpha = (y * width + x) * 4 + 3;
                // Erode all eight neighbors, including diagonals. A cross-only
                // check accidentally includes the U's inner contour corner;
                // that is an outer mask edge, not an internal stroke join.
                const neighbors = [-1, 0, 1].flatMap((dy) =>
                  [-1, 0, 1].map((dx) => alpha + dy * width * 4 + dx * 4),
                );
                if (!neighbors.every((index) => expected[index] === 255)) continue;
                interior += 1;
                if (actual[alpha]! < 252) {
                  seams += 1;
                  seamPixels.push({
                    x,
                    y,
                    alpha: actual[alpha]!,
                    neighbors: [-1, 0, 1].flatMap((dy) =>
                      [-1, 0, 1].map((dx) => expected[alpha + dy * width * 4 + dx * 4]!),
                    ),
                  });
                }
              }
            }
            samples.push({ height, dpr, offset, interior, seams, seamPixels });
          }
        }
      }
      return samples;
    });
    expect(samples).toHaveLength(16);
    for (const sample of samples) {
      expect(sample.interior, JSON.stringify(sample)).toBeGreaterThan(100);
      expect(sample.seams, JSON.stringify(sample)).toBe(0);
    }
  });

  test('shows a complete static logo and greeting with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPausedSetup(page);
    await page.clock.runFor(32);
    await expect(page.locator('.logo-welcome > .wg[mask]')).toHaveCount(0);
    for (const silhouette of await page.locator('.logo-welcome > .wg').all()) {
      await expect(silhouette).toHaveCSS('opacity', '1');
    }
    await expect(page.locator('.setup-greeting-row').first()).toHaveClass(/\bis-visible\b/u);
  });

  test('finishes cleanly if reduced motion is enabled during the reveal', async ({ page }) => {
    await openPausedSetup(page);
    await advanceRevealTo(page, 800);
    expect((await readMaskInstances(page))[0]?.path).toBeTruthy();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.logo-welcome > .wg[mask]')).toHaveCount(0);
    await page.clock.runFor(32);
    await expect(page.locator('.setup-greeting-row').first()).toHaveClass(/\bis-visible\b/u);
  });

  test('keeps a readable logo and reaches the greeting when the optional reveal script fails', async ({
    page,
  }) => {
    let blocked = false;
    await page.route('**/wordmark-anim.js', (route) => {
      blocked = true;
      return route.abort('failed');
    });
    await openPausedSetup(page);
    expect(blocked).toBe(true);
    await expect(page.locator('.logo-welcome [data-wordmark-mask]')).toHaveCount(0);
    for (const logo of await page.locator('.logo-welcome > .wg').all()) {
      await expect(logo).toHaveCSS('opacity', '1');
      await expect(logo).not.toHaveAttribute('mask', /.+/u);
    }
    await page.clock.runFor(3_100);
    await expect(page.locator('.setup-greeting-row').first()).toHaveClass(/\bis-visible\b/u);
  });
});
