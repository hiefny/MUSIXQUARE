/**
 * Tab header title geometry: where a title's text baseline sits, and a page
 * whose fonts draw a taller line than the shipped @font-face metrics give.
 */
import type { Locator, Page } from '@playwright/test';

/** Waits until no tab header moves for a few frames (fonts, layout swaps). */
export async function waitForStillHeaders(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let previous = '';
        let stillFrames = 0;
        const check = () => {
          const current = [...document.querySelectorAll('.tab-header')]
            .map((header) => {
              const box = header.getBoundingClientRect();
              return `${box.x},${box.y},${box.width},${box.height}`;
            })
            .join('|');
          stillFrames = current === previous ? stillFrames + 1 : 0;
          previous = current;
          if (stillFrames >= 5) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}

/** The text's baseline, in CSS px below its tab header's top edge. */
export async function titleBaseline(text: Locator): Promise<number> {
  await waitForStillHeaders(text.page());
  return text.evaluate((element) => {
    const header = element.closest('.tab-header')!;
    // A zero-size inline block sits on the line's baseline.
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    element.appendChild(probe);
    const baseline = probe.getBoundingClientRect().bottom;
    probe.remove();
    return baseline - header.getBoundingClientRect().top;
  });
}

/**
 * The metrics every served @font-face draws with under serveTallerFontLines():
 * a line of 1.5em, which takes a 28px tab title's line past the 36px row.
 * The shipped faces' overrides keep that line within 36px; iOS Safari ignores
 * the overrides, so it draws the CJK fonts' own, taller metrics.
 */
const TALLER_LINE_METRICS = 'ascent-override:120%;descent-override:30%;line-gap-override:0%;';

/**
 * Serves the generated font sheets (font-*.css: Inter, the CJK families and
 * Thai) with each face's ascent-override, descent-override and
 * line-gap-override replaced by TALLER_LINE_METRICS (size-adjust stays), so
 * the CJK title lines grow past 36px as they do on iOS Safari today. The
 * taller line comes from these values, not from the font files, so the case
 * still holds once the files carry the shipped metrics themselves. Returns
 * how many faces were served so far. The context needs service workers
 * blocked, or the worker answers the sheets before the route sees them.
 */
export async function serveTallerFontLines(page: Page): Promise<() => number> {
  let faces = 0;
  await page.route(/\/assets\/font-[^/]*\.css(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(/(ascent|descent|line-gap)-override:[^;}]+;?/g, '')
      .replace(/@font-face\s*\{/g, () => {
        faces += 1;
        return `@font-face{${TALLER_LINE_METRICS}`;
      });
    await route.fulfill({ response, body });
  });
  return () => faces;
}
