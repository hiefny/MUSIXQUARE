import { errors, expect, test, type Page } from '@playwright/test';
import { navigateToTab, waitForViewTransitionEnd, waitUntilPressReaches } from './helpers/wait.ts';

// The app switches tabs inside document.startViewTransition (src/ui/tabs.ts,
// src/ui/dom.ts animateTransition): the new panel gets `.active` in the update
// callback, well before the cross-fade ends, and the tab transition marks
// <html> with `tab-header-transition` until it finishes. While a view
// transition runs, pointer input is hit-tested to <html> (Chromium from the
// startViewTransition() call, WebKit once the update is done). These tests
// hold the helpers to that contract on a page of their own, with a cross-fade
// long enough that an early return cannot pass by luck.
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

/** Makes the engine look like one without the property: it reads undefined. */
async function hideActiveViewTransition(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(Document.prototype, 'activeViewTransition', {
      configurable: true,
      get: () => undefined,
    });
  });
  expect(await page.evaluate(() => document.activeViewTransition)).toBeUndefined();
}

async function openNextTab(page: Page): Promise<void> {
  await page.locator('.nav-item').click();
  await page.waitForFunction(() =>
    document.getElementById('tab-next')?.classList.contains('active'),
  );
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
  await hideActiveViewTransition(page);
  await openNextTab(page);
  // Take the app's marker away too, so only the animations can hold the wait.
  await page.evaluate(() => document.documentElement.classList.remove('tab-header-transition'));
  await waitForViewTransitionEnd(page);
  expect(await viewTransitionState(page)).toEqual({ running: false, marked: false });
  expect(await pressTarget(page)).toBe(1);
});

test('the fallback does not hang when a paused page clock stops animation frames', async ({
  page,
}) => {
  // Without its bound the fallback's two-frame read never resolves here.
  test.setTimeout(15_000);
  await page.clock.install({ time: new Date('2026-11-01T00:00:00Z') });
  await page.setContent(tabPage(CROSS_FADE_MS));
  await hideActiveViewTransition(page);
  await page.clock.pauseAt(new Date('2026-11-01T00:00:10Z'));
  const frame = await Promise.race([
    page.evaluate(
      () => new Promise<string>((resolve) => requestAnimationFrame(() => resolve('frame'))),
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('no frame'), 1_000)),
  ]);
  expect(frame).toBe('no frame');
  const started = Date.now();
  await waitForViewTransitionEnd(page, 5_000);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test('the wait names a view transition that does not end in time', async ({ page }) => {
  await page.setContent(tabPage(60_000));
  await openNextTab(page);
  await expect(waitForViewTransitionEnd(page, 500)).rejects.toThrow(
    'The view transition wait timed out after 500 ms: document.activeViewTransition was ' +
      'still set and <html> still had the tab-header-transition class. Until it ends, every ' +
      'raw press lands on <html>.',
  );
  // A press now lands on <html>: the reason the helpers wait.
  expect(await pressTarget(page)).toBe(0);
  await page.evaluate(() => document.activeViewTransition?.skipTransition());
  await waitForViewTransitionEnd(page);
});

test('the wait names a tab mark left behind with no transition running', async ({ page }) => {
  await page.setContent(tabPage(CROSS_FADE_MS));
  await page.evaluate(() => document.documentElement.classList.add('tab-header-transition'));
  await expect(waitForViewTransitionEnd(page, 300)).rejects.toThrow(
    'The view transition wait timed out after 300 ms: <html> still had the ' +
      'tab-header-transition class. No view transition was running: the tab transition left ' +
      'its mark behind.',
  );
});

test('the wait passes an error that is not its timeout through unchanged', async ({ page }) => {
  await page.setContent(tabPage(60_000));
  await openNextTab(page);
  const waiting = waitForViewTransitionEnd(page, 30_000).then(
    () => null,
    (error: unknown) => error,
  );
  // Close during the wait itself, not during the helper's first read.
  await page.waitForTimeout(300);
  await page.close();
  const error = await waiting;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(errors.TimeoutError);
  expect((error as Error).message).toContain('has been closed');
  expect((error as Error).message).not.toContain('timed out');
});

test('waitUntilPressReaches fails at once on a covering layer and waits out only a transition', async ({
  page,
}) => {
  await page.setContent(`<!doctype html>
<html>
  <head>
    <style id="cross-fade">
      ::view-transition-group(root) { animation-duration: ${CROSS_FADE_MS}ms; }
    </style>
  </head>
  <body>
    <button id="target" type="button" style="position:absolute;left:100px;top:120px;width:200px;height:80px">
      <span id="label">Target</span>
    </button>
    <div id="cover" class="toast show" style="position:absolute;inset:0"></div>
    <script>
      window.__targetPresses = 0;
      document.getElementById('target').addEventListener('pointerdown', () => {
        window.__targetPresses += 1;
      });
    </script>
  </body>
</html>`);
  const target = page.locator('#target');
  const point = { x: 200, y: 160 };

  // A layer over the target fails at once, even one about to leave: a real
  // press made now would be lost.
  await page.evaluate(() => {
    setTimeout(() => document.getElementById('cover')!.remove(), 1_000);
  });
  const started = Date.now();
  await expect(waitUntilPressReaches(target, point, 10_000)).rejects.toThrow(
    "A press at (200, 160) would land on div#cover.toast.show, not on locator('#target'), " +
      'with no view transition running: it covers the target.',
  );
  expect(Date.now() - started).toBeLessThan(1_000);
  await expect(page.locator('#cover')).toHaveCount(0);

  // A child of the target counts as the target.
  await page.evaluate(() => {
    document.getElementById('label')!.style.cssText = 'display:block;width:200px;height:80px';
  });
  await waitUntilPressReaches(target, point);
  expect(await pressTarget(page)).toBe(1);

  // A transition is waited out from its start: Chromium hit-tests <html> at
  // once, WebKit still hits the old page until the update is done.
  await page.evaluate(() => {
    document.startViewTransition(() => {});
  });
  await waitUntilPressReaches(target, point);
  expect(await page.evaluate(() => document.activeViewTransition)).toBeNull();
  expect(await pressTarget(page)).toBe(2);

  // A transition that does not end in time is named.
  await page.evaluate(async () => {
    document.getElementById('cross-fade')!.textContent =
      '::view-transition-group(root) { animation-duration: 60s; }';
    await document.startViewTransition(() => {}).ready;
  });
  await expect(waitUntilPressReaches(target, point, 300)).rejects.toThrow(
    "A press at (200, 160) would land on html, not on locator('#target'): a view transition " +
      'was still running after 300 ms (document.activeViewTransition was still set).',
  );
  await page.evaluate(() => document.activeViewTransition?.skipTransition());
  await waitUntilPressReaches(target, point);
});
