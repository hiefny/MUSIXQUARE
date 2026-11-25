import { expect, test, type Page } from '@playwright/test';

// The boot splash draws the wordmark once at the centre, then raises it as
// the loader fades in below (index.html, browser/classic-runtime/wordmark-anim.ts).
// These tests answer the app's module graph with empty modules so the splash
// stays up, and pause the page clock so the drawing can be sampled. The
// splash's own CSS motion (the rise, the fades) runs on real time.

type SplashWindow = Window & {
  __splashDrawStart?: number;
  /** The splash's first phase and where its CSS clock stood when it was set. */
  __splashFirstPhase?: { phase: string; clock: number | null };
};

/** The first stroke starts 500 ms into the drawing (index.html, DRAW_BASE_DELAY). */
const FIRST_STROKE_MS = 500;
/** The page clock runs animation frames 16 ms apart. */
const FRAME_MS = 16;

interface HeldSplash {
  /** Wait for this release's runtime. */
  runtime?: boolean;
  /** Pin the drawing's start on the paused clock (it must draw). */
  draw?: boolean;
  /** An app reset stamped this tab just before navigating here. */
  continuity?: boolean;
  /** Pause the page clock (the drawing is sampled on it); otherwise it runs. */
  pausedClock?: boolean;
}

async function openHeldSplash(
  page: Page,
  { runtime = true, draw = runtime, continuity = false, pausedClock = true }: HeldSplash = {},
): Promise<void> {
  const initialTime = new Date('2026-09-29T00:00:00Z');
  if (pausedClock) {
    await page.clock.install({ time: initialTime });
    await page.clock.pauseAt(initialTime);
  }
  if (continuity) {
    // On the page's (paused) clock: init scripts run in the order they were added.
    await page.addInitScript(() => {
      sessionStorage.setItem('mxqr-boot-continuity', String(Date.now()));
    });
  }
  // Empty modules: setup never takes the screen, and nothing reports a failed
  // load (a request left unanswered also stalls WebKit's other requests).
  await page.route(/\/assets\/[^?]*\.js(?:\?.*)?$/u, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/', { waitUntil: 'commit' });
  await page.locator('.boot-splash-logo').waitFor({ state: 'attached' });
  if (!runtime) return;
  await expect(page.locator('html')).toHaveAttribute('data-boot-splash-runtime', 'true');
  if (draw) await pinDrawStart(page);
}

/**
 * Step the paused clock a frame at a time until the first stroke shows. The
 * runtime times its start on the splash's CSS clock, which a page clock does
 * not run, so this pins the start from the drawing itself, within a frame.
 */
async function pinDrawStart(page: Page): Promise<void> {
  for (let frame = 0; frame < 200; frame += 1) {
    const started = await page.evaluate(
      ({ firstStroke, frameMs }) => {
        const path = document.querySelector('.boot-splash-logo [data-wordmark-reveal]');
        if (!path?.getAttribute('d')) return false;
        // The first frame past the stroke's start came within the last step.
        (window as SplashWindow).__splashDrawStart = performance.now() - firstStroke - frameMs;
        return true;
      },
      { firstStroke: FIRST_STROKE_MS, frameMs: FRAME_MS },
    );
    if (started) return;
    await page.clock.runFor(FRAME_MS);
  }
  throw new Error('The splash wordmark never started drawing');
}

async function advanceDrawTo(page: Page, milliseconds: number): Promise<void> {
  const elapsed = await page.evaluate(
    () => performance.now() - ((window as SplashWindow).__splashDrawStart ?? NaN),
  );
  expect(elapsed, 'The paused clock must not already have passed this sample').toBeLessThanOrEqual(
    milliseconds,
  );
  await page.clock.runFor(Math.ceil(milliseconds - elapsed));
}

/** When the last stroke ends: strokes start 500 ms into the drawing. */
async function drawEnd(page: Page): Promise<number> {
  return page
    .locator('.boot-splash-logo')
    .evaluate(
      (logo) =>
        500 +
        Math.max(
          ...[...logo.querySelectorAll<SVGElement>('[data-wt]')].map(
            (stroke) => Number(stroke.dataset.wt) + Number(stroke.dataset.wd),
          ),
        ),
    );
}

/** Vertical offsets of the wordmark's and the loader's centres from the viewport's. */
async function offsets(page: Page): Promise<{ logo: number; loader: number }> {
  return page.evaluate(() => {
    const middle = innerHeight / 2;
    const centre = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return Math.round((box.top + box.height / 2 - middle) * 10) / 10;
    };
    return {
      logo: centre('.boot-splash-logo'),
      loader: centre('.boot-splash-spinner .material-elastic-turn'),
    };
  });
}

function markRise(page: Page): Promise<number> {
  return page
    .locator('.boot-splash-mark')
    .evaluate((mark) => new DOMMatrix(getComputedStyle(mark).transform).m42);
}

test.describe('boot splash wordmark reveal', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('draws at the centre and never reveals a stroke ahead of its turn', async ({ page }) => {
    await openHeldSplash(page);
    await advanceDrawTo(page, 800);

    const coverage = await page.locator('.boot-splash-logo').evaluate((logo) => {
      const path = logo.querySelector<SVGPathElement>('[data-wordmark-reveal]');
      if (!path) throw new Error('The splash wordmark has no reveal mask');
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
    // The strokes are geometry inputs only.
    await expect(page.locator('.boot-splash-logo > .wl')).toHaveCount(0);
    await expect(page.locator('.boot-splash-logo [data-wordmark-reveal]')).toHaveCount(1);
    // Alone at the exact centre, the loader not shown yet.
    expect((await offsets(page)).logo).toBe(0);
    await expect(page.locator('.boot-splash .boot-splash-spinner')).toHaveCSS('opacity', '0');
    await expect(page.locator('.boot-splash')).not.toHaveAttribute('data-phase', /.+/u);
  });

  test('raises the drawn wordmark as the loader fades in, ending with the pair centred', async ({
    page,
  }) => {
    await openHeldSplash(page);
    const end = await drawEnd(page);
    await advanceDrawTo(page, end - 40);
    await expect(page.locator('.boot-splash')).not.toHaveAttribute('data-phase', /.+/u);
    expect(await markRise(page)).toBe(24);

    await advanceDrawTo(page, end + 40);
    await expect(page.locator('.boot-splash')).toHaveAttribute('data-phase', 'loader');
    // The rise (1.2 s) and the loader's fade (0.35 s after 0.6 s) run on real time.
    const riseAndLoader = await page.evaluate(() => {
      const read = (selector: string, name: string) => {
        const animation = document
          .querySelector(selector)
          ?.getAnimations()
          .find((entry) => (entry as CSSAnimation).animationName === name);
        const timing = animation?.effect?.getTiming();
        return timing
          ? {
              duration: timing.duration,
              delay: timing.delay,
              easing: timing.easing,
            }
          : null;
      };
      return {
        rise: read('.boot-splash-mark', 'boot-splash-mark-rise'),
        loader: read('.boot-splash-spinner', 'boot-splash-spinner-in'),
      };
    });
    expect(riseAndLoader).toEqual({
      rise: { duration: 1200, delay: 0, easing: 'cubic-bezier(0.8, 0, 0.2, 1)' },
      loader: { duration: 350, delay: 600, easing: 'ease-out' },
    });
    await expect.poll(() => markRise(page)).toBe(0);
    await expect(page.locator('.boot-splash .boot-splash-spinner')).toHaveCSS('opacity', '1');
    // One 24px unit: the wordmark 24px above the centre, the loader 24px below.
    expect(await offsets(page)).toEqual({ logo: -24, loader: 24 });
    await expect(page.locator('.boot-splash-logo')).toHaveCSS('height', '24px');
    await expect(page.locator('.boot-splash-spinner .material-elastic-turn')).toHaveCSS(
      'height',
      '24px',
    );
  });

  test('rasterizes completed joins without internal seams at low and high pixel density', async ({
    page,
  }) => {
    await openHeldSplash(page);
    // Past the last stroke by more than the pinned start's frame, before cleanup.
    await advanceDrawTo(page, (await drawEnd(page)) + 80);

    // Render the real current SVG with each browser's own SVG rasterizer. The
    // unmasked canonical silhouette is the reference; no saved pixel snapshots
    // or copied reveal algorithm are involved.
    const samples = await page.locator('.boot-splash-logo').evaluate(async (logo) => {
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
      for (const height of [24, 29]) {
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

  test('stops the drawing where it is when the app takes the screen, then leaves rendering', async ({
    page,
  }) => {
    await openHeldSplash(page);
    await advanceDrawTo(page, 1200);
    const before = await page.locator('.boot-splash-logo [data-wordmark-reveal]').getAttribute('d');
    // What setup does once its surface has painted.
    await page.evaluate(() => document.documentElement.classList.remove('setup-boot-block'));
    await page.clock.runFor(2_000);
    // Drawing the rest at once would flash the whole wordmark in the fade.
    await expect(page.locator('.boot-splash-logo > .wg')).toHaveAttribute('mask', /^url\(#/u);
    expect(await page.locator('.boot-splash-logo [data-wordmark-reveal]').getAttribute('d')).toBe(
      before,
    );
    await expect(page.locator('.boot-splash')).not.toHaveAttribute('data-phase', /.+/u);
    // Out of rendering once its 0.3 s fade has ended (real time).
    await expect(page.locator('.boot-splash')).toHaveAttribute('hidden', '');
  });

  test("continues an app reset's screen in its final place, with no motion", async ({ page }) => {
    await openHeldSplash(page, { continuity: true, draw: false });
    await expect(page.locator('.boot-splash')).toHaveAttribute('data-phase', 'settled');
    expect(
      await page.evaluate(() => ({
        rise: new DOMMatrix(
          getComputedStyle(document.querySelector('.boot-splash-mark')!).transform,
        ).m42,
        mark: getComputedStyle(document.querySelector('.boot-splash-mark')!).opacity,
        loader: getComputedStyle(document.querySelector('.boot-splash .boot-splash-spinner')!)
          .opacity,
        ink: getComputedStyle(document.querySelector('.boot-splash-logo > .wg')!).opacity,
        masked: document.querySelector('.boot-splash-logo > .wg')!.hasAttribute('mask'),
        stamp: sessionStorage.getItem('mxqr-boot-continuity'),
        animations: document
          .getAnimations()
          .map((animation) => (animation as CSSAnimation).animationName)
          .filter((name) => /mark-in|mark-rise|spinner-in/u.test(name)),
      })),
    ).toEqual({
      rise: 0,
      mark: '1',
      loader: '1',
      ink: '1',
      masked: false,
      stamp: null,
      animations: [],
    });
    expect(await offsets(page)).toEqual({ logo: -24, loader: 24 });
  });

  test('shows a complete static wordmark and its loader with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Nothing is drawn, so the page clock runs: the runtime times the loader on
    // the splash's own CSS clock, and a runtime that arrives after the mark has
    // shown adds it at once. Record where that clock stood when it joined.
    await page.addInitScript(() => {
      new MutationObserver(() => {
        const splash = document.querySelector<HTMLElement>('.boot-splash');
        const target = window as SplashWindow;
        if (!splash?.dataset.phase || target.__splashFirstPhase) return;
        const fadeIn = document
          .querySelector('.boot-splash-mark')
          ?.getAnimations()
          .find((animation) => (animation as CSSAnimation).animationName === 'boot-splash-mark-in');
        const start = fadeIn?.startTime;
        const now = document.timeline.currentTime;
        target.__splashFirstPhase = {
          phase: splash.dataset.phase,
          clock: typeof start === 'number' && typeof now === 'number' ? now - start : null,
        };
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-phase'] });
    });
    await openHeldSplash(page, { draw: false, pausedClock: false });
    await expect(page.locator('.boot-splash')).toHaveAttribute('data-phase', 'loader');
    // The loader joins as the mark shows (0.3 s on the CSS clock), never before
    // it. A timer callback reads that clock at the last frame, hence the slack.
    // (A loader set before the mark's fade-in has even started reads null.)
    const first = await page.evaluate(() => (window as SplashWindow).__splashFirstPhase);
    expect(first).toEqual({ phase: 'loader', clock: expect.any(Number) });
    expect(first!.clock).toBeGreaterThanOrEqual(200);
    await expect(page.locator('.boot-splash-logo > .wg[mask]')).toHaveCount(0);
    await expect(page.locator('.boot-splash-logo > .wg')).toHaveCSS('opacity', '1');
    await expect.poll(() => markRise(page)).toBe(0);
    // A still arc: once the mark's zero-length fade-in has passed its 0.3 s
    // delay, nothing inside the splash runs.
    await expect(page.locator('.boot-splash .boot-splash-spinner')).toHaveCSS('opacity', '1');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const splash = document.querySelector('.boot-splash');
          return document
            .getAnimations()
            .filter((animation) => {
              const target = (animation.effect as KeyframeEffect | null)?.target;
              return target instanceof Element && target !== splash && splash?.contains(target);
            })
            .filter((animation) => animation.playState === 'running')
            .map((animation) => (animation as CSSAnimation).animationName);
        }),
      )
      .toEqual([]);
  });

  test('finishes cleanly if reduced motion is enabled during the drawing', async ({ page }) => {
    await openHeldSplash(page);
    await advanceDrawTo(page, 800);
    await expect(page.locator('.boot-splash-logo > .wg')).toHaveAttribute('mask', /^url\(#/u);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.boot-splash-logo > .wg[mask]')).toHaveCount(0);
    await expect(page.locator('.boot-splash-logo [data-wordmark-mask]')).toHaveCount(0);
  });

  for (const [label, runtime] of [
    ['the optional runtime fails', null],
    // An older release's service worker still serves its own runtime on the
    // update's first load: it marks the root with its own attribute and waits
    // for a start event nothing sends now.
    [
      "an older release's runtime arrives",
      "document.documentElement.setAttribute('data-wordmark-runtime-ready', 'true');",
    ],
  ] as const) {
    test(`keeps a readable wordmark and still raises it when ${label}`, async ({ page }) => {
      let requested = false;
      await page.route('**/wordmark-anim.js', (route) => {
        requested = true;
        return runtime === null
          ? route.abort('failed')
          : route.fulfill({ contentType: 'text/javascript', body: runtime });
      });
      await openHeldSplash(page, { runtime: false });
      expect(requested).toBe(true);
      await expect(page.locator('html')).not.toHaveAttribute('data-boot-splash-runtime', /.*/u);
      await expect(page.locator('.boot-splash-logo [data-wordmark-mask]')).toHaveCount(0);
      // The CSS fallback: the whole wordmark at 1.8 s, the rise at 3.2 s (real time).
      await expect(page.locator('.boot-splash-logo > .wg')).toHaveCSS('opacity', '1', {
        timeout: 8_000,
      });
      await expect.poll(() => markRise(page), { timeout: 8_000 }).toBe(0);
      await expect(page.locator('.boot-splash .boot-splash-spinner')).toHaveCSS('opacity', '1', {
        timeout: 8_000,
      });
      expect(await offsets(page)).toEqual({ logo: -24, loader: 24 });
    });
  }
});
