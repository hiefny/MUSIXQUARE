/**
 * Tab header title geometry: where a title's text baseline sits, and a page
 * whose fonts are drawn without their @font-face metric overrides.
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
 * Serves the font sheets without ascent-override, descent-override and
 * line-gap-override (size-adjust stays), as iOS Safari ignores them: each
 * font's line height is its own, and CJK lines grow past 36px. Returns how
 * many descriptors were dropped so far. The context needs service workers
 * blocked, or the worker answers the sheets before the route sees them.
 */
export async function dropFontMetricOverrides(page: Page): Promise<() => number> {
  let dropped = 0;
  await page.route(/\/assets\/font-[^/]*\.css(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /(ascent|descent|line-gap)-override:[^;}]+;?/g,
      () => {
        dropped += 1;
        return '';
      },
    );
    await route.fulfill({ response, body });
  });
  return () => dropped;
}
