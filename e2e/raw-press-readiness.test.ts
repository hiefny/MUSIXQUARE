import { expect, test, type Page } from '@playwright/test';
import { navigateToTab, waitForViewTransitionEnd } from './helpers/wait.ts';

// The app switches tabs inside document.startViewTransition (src/ui/tabs.ts,
// src/ui/dom.ts animateTransition): the new panel gets `.active` in the update
// callback, well before the cross-fade ends, and the tab transition marks
// <html> with `tab-header-transition` until it finishes. While a view
// transition runs, the browser hit-tests every pointer event to <html>. These
// tests hold the helpers to that contract on a page of their own, with a
// cross-fade long enough that an early return cannot pass by luck.
const CROSS_FADE_MS = 800;

function tabPage(crossFadeMs: number): string {
  return `<!doctype html>
<html>
  <head>
    <style>
      ::view-transition-group(root),
      ::view-transition-old(root),
      ::view-transition-new(root) {
        animation-duration: ${crossFadeMs}ms;
      }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
      #target { position: absolute; left: 100px; top: 120px; width: 200px; height: 80px; }
    </style>
  </head>
  <body>
    <nav><button class="nav-item" data-tab="next" type="button">Next</button></nav>
    <div id="tab-first" class="tab-content active">First</div>
    <div id="tab-next" class="tab-content"><button id="target" type="button">Target</button></div>
    <script>
      window.__targetPresses = 0;
      document.getElementById('target').addEventListener('pointerdown', () => {
        window.__targetPresses += 1;
      });
      document.querySelector('.nav-item').addEventListener('click', () => {
        // Like animateTransition: batched to a microtask, marked on <html>.
        queueMicrotask(() => {
          const root = document.documentElement;
          root.classList.add('tab-header-transition');
          const transition = document.startViewTransition(() => {
            document.getElementById('tab-first').classList.remove('active');
            document.getElementById('tab-next').classList.add('active');
          });
          const release = () => root.classList.remove('tab-header-transition');
          transition.finished.then(release, release);
        });
      });
    </script>
  </body>
</html>`;
}

async function pressTarget(page: Page): Promise<number> {
  const box = await page.locator('#target').boundingBox();
  if (!box) throw new Error('Target has no geometry');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return page.evaluate(() => (window as unknown as { __targetPresses: number }).__targetPresses);
}

async function viewTransitionState(page: Page) {
  return page.evaluate(() => ({
    running: document
      .getAnimations()
      .some((animation) =>
        (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition'),
      ),
    marked: document.documentElement.classList.contains('tab-header-transition'),
  }));
}

test('navigateToTab returns after the tab cross-fade, so a raw press reaches the new panel', async ({
  page,
}) => {
  await page.setContent(tabPage(CROSS_FADE_MS));
  await navigateToTab(page, 'next');
  expect(await page.evaluate(() => document.activeViewTransition)).toBeNull();
  expect(await viewTransitionState(page)).toEqual({ running: false, marked: false });
  expect(await pressTarget(page)).toBe(1);
});

test('the wait falls back to the transition animations where activeViewTransition is missing', async ({
  page,
}) => {
  await page.setContent(tabPage(CROSS_FADE_MS));
  // An engine without the property: it reads undefined, as on older WebKit.
  await page.evaluate(() => {
    Object.defineProperty(Document.prototype, 'activeViewTransition', {
      configurable: true,
      get: () => undefined,
    });
  });
  expect(await page.evaluate(() => document.activeViewTransition)).toBeUndefined();
  await page.locator('.nav-item').click();
  await page.waitForFunction(() =>
    document.getElementById('tab-next')?.classList.contains('active'),
  );
  // Take the app's marker away too, so only the animations can hold the wait.
  await page.evaluate(() => document.documentElement.classList.remove('tab-header-transition'));
  await waitForViewTransitionEnd(page);
  expect(await viewTransitionState(page)).toEqual({ running: false, marked: false });
  expect(await pressTarget(page)).toBe(1);
});

test('the wait names a view transition that does not end in time', async ({ page }) => {
  await page.setContent(tabPage(60_000));
  await page.locator('.nav-item').click();
  await page.waitForFunction(() =>
    document.getElementById('tab-next')?.classList.contains('active'),
  );
  await expect(waitForViewTransitionEnd(page, 500)).rejects.toThrow(
    /view transition was still running after 500 ms/,
  );
  // A press now lands on <html>: the reason the helpers wait.
  expect(await pressTarget(page)).toBe(0);
  await page.evaluate(() => document.activeViewTransition?.skipTransition());
  await waitForViewTransitionEnd(page);
});
