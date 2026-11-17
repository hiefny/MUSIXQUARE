/**
 * Shared steps for the focus ring specs (e2e/keyboard-focus-ring*.test.ts):
 * read the focused element's ring, find an empty spot of a panel, and open
 * the start screen or a room with one local track.
 */
import type { Page } from '@playwright/test';
import { waitForBootstrapReady } from './bootstrap.ts';
import { uploadFixture } from './file-upload.ts';
import { injectPeerServer } from './peer-server.ts';
import { setupHostAndStart } from './setup-flow.ts';
import { waitForFilePlaybackReady, waitForViewTransitionEnd } from './wait.ts';

export const DESKTOP = { width: 1280, height: 800 };

export interface FocusRing {
  /** The focused element's id, or its tag and first class. */
  readonly focused: string;
  /** Whether the focused element draws an outline. */
  readonly ring: boolean;
  readonly outline: string;
}

export async function focusRing(page: Page): Promise<FocusRing> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    const style = element ? getComputedStyle(element) : null;
    const width = style ? Number.parseFloat(style.outlineWidth) : 0;
    return {
      focused: element?.id
        ? `#${element.id}`
        : `${element?.tagName.toLowerCase() ?? 'none'}.${element?.classList[0] ?? ''}`,
      ring: !!style && style.outlineStyle !== 'none' && width > 0,
      outline: style ? `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}` : '',
    };
  });
}

const NOT_EMPTY =
  'button, a, input, textarea, select, label, canvas, [role="button"], [role="slider"], ' +
  '[contenteditable], [tabindex]:not([tabindex="-1"])';

/**
 * A point inside `panel` whose topmost element is no control: empty space.
 * While a view transition runs, every point hits <html>, so this waits.
 */
export async function emptySpot(page: Page, panel: string): Promise<{ x: number; y: number }> {
  const spot = await page.waitForFunction(
    ({ selector, notEmpty }) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      for (let fy = 0.9; fy > 0.15; fy -= 0.05) {
        for (let fx = 0.2; fx < 0.85; fx += 0.1) {
          const x = rect.left + rect.width * fx;
          const y = rect.top + rect.height * fy;
          const hit = document.elementFromPoint(x, y);
          if (hit && element.contains(hit) && !hit.closest(notEmpty)) return { x, y };
        }
      }
      return null;
    },
    { selector: panel, notEmpty: NOT_EMPTY },
    { timeout: 10_000 },
  );
  return (await spot.jsonValue()) as { x: number; y: number };
}

export async function openRoomWithTrack(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  await injectPeerServer(page);
  await setupHostAndStart(page);
  await uploadFixture(page, 'test01');
  await waitForFilePlaybackReady(page, 30_000);
  await waitForViewTransitionEnd(page);
}

export async function openStartScreen(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await injectPeerServer(page);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);
  await page.locator('#btn-setup-host').waitFor({ state: 'visible', timeout: 15_000 });
}
