/**
 * Forced update (train 9.0.14, Inc 7): the start and resume floor check of
 * the exact production artifact.
 *
 * The page reads the effective App build floor (APP_BUILD_FLOOR_CLIENT_PATH)
 * at its load moment and on each return to the foreground, at most two read
 * starts per minute window, one spent read ending it. Here `page.route`
 * answers that read with a floor the test sets and counts the reads; no App
 * Worker runs (the preview server would answer 404). The build is read from
 * the artifact's /service-worker.js, so no build number is typed here.
 *
 * Resume: service workers are blocked (the page has no update machine, so the
 * early handler presents), and the page clock is installed so each counted
 * return can be moved past the read window without waiting a minute. The
 * count rises only on a return after the window, so each step proves the
 * listener it names. Apply: service workers are allowed, and the test first
 * proves that `page.route` sees the read of a controlled page.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { APP_BUILD_FLOOR_CLIENT_PATH } from '../cloudflare/app-build-floor-contract.ts';

/** Past the start and resume check's one-minute read window. */
const PAST_READ_WINDOW_MS = 61_000;

/** The artifact's build: the integer of its service-worker cache epoch. */
async function artifactBuild(page: Page): Promise<number> {
  const source = await (await page.request.get('/service-worker.js')).text();
  const epoch = /\bconst\s+CACHE_VERSION\s*=\s*['"]v(\d+)['"]\s*;/u.exec(source)?.[1];
  expect(epoch, 'the artifact names its cache epoch').toBeDefined();
  return Number(epoch);
}

interface FloorRoute {
  /** The floor reads the page made so far. */
  reads(): number;
  /** Answer the next reads with this floor, or with this HTTP status. */
  answer(next: { floor: number } | { status: number }): void;
}

async function routeFloorRead(page: Page, initialFloor: number): Promise<FloorRoute> {
  let count = 0;
  let next: { floor: number } | { status: number } = { floor: initialFloor };
  await page.addInitScript(() => {
    localStorage.setItem('musixquare-lang', 'en');
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-app-used-v1', '1');
  });
  await page.route(`**${APP_BUILD_FLOOR_CLIENT_PATH}`, async (route: Route) => {
    count += 1;
    if ('status' in next) {
      await route.fulfill({ status: next.status, contentType: 'text/plain', body: 'unavailable' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ effectiveMinAppBuild: next.floor }),
    });
  });
  return {
    reads: () => count,
    answer(value) {
      next = value;
    },
  };
}

/**
 * A return from the background: visibilitychange to hidden, then to visible,
 * with no real wait in between (the page clock is installed, so a timer would
 * not run by itself).
 */
async function bounce(page: Page): Promise<void> {
  await page.evaluate(() => {
    const setVisibility = (value: DocumentVisibilityState): void => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => value,
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => value === 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('hidden');
    setVisibility('visible');
  });
}

async function expectForcedDialog(page: Page): Promise<void> {
  await expect(page.locator('#dialog-overlay')).toBeVisible();
  await expect(page.locator('#dialog-title')).toHaveText('Update');
  await expect(page.locator('#dialog-message')).toContainText('A new version is ready.');
  await expect(page.locator('#btn-dialog-ok')).toHaveText('Apply');
  // No Later: the forced variant has only Apply.
  await expect(page.locator('#btn-dialog-secondary')).toBeHidden();
}

test.describe('the floor check on a return (no service worker)', () => {
  test.use({ serviceWorkers: 'block' });

  test('reads once at load, once per return after the window, never shows a dialog for its own build or a failed read, and shows the forced dialog below the floor', async ({
    page,
  }) => {
    const build = await artifactBuild(page);
    const floor = await routeFloorRead(page, build);
    await page.clock.install();
    await page.goto('/');
    await expect(page.locator('#btn-setup-host')).toBeVisible();

    // P1: the load moment reads once; the floor is this build, so nothing shows.
    await expect.poll(() => floor.reads()).toBe(1);
    await page.clock.runFor(7_000);
    await expect(page.locator('#dialog-overlay')).toBeHidden();

    // P2: returns inside the window read nothing more.
    for (let index = 0; index < 5; index += 1) await bounce(page);
    await page.clock.runFor(1_000);
    expect(floor.reads()).toBe(1);

    // P3: one return after the window reads once (the visibilitychange listener).
    await page.clock.fastForward(PAST_READ_WINDOW_MS);
    await bounce(page);
    await expect.poll(() => floor.reads()).toBe(2);
    await page.clock.runFor(1_000);
    await expect(page.locator('#dialog-overlay')).toBeHidden();

    // P4: a failed read shows nothing.
    floor.answer({ status: 500 });
    await page.clock.fastForward(PAST_READ_WINDOW_MS);
    await bounce(page);
    await expect.poll(() => floor.reads()).toBe(3);
    await page.clock.runFor(1_000);
    await expect(page.locator('#dialog-overlay')).toBeHidden();

    // P5: a floor above this build shows the forced dialog at once.
    floor.answer({ floor: build + 1 });
    await page.clock.fastForward(PAST_READ_WINDOW_MS);
    await bounce(page);
    await expect.poll(() => floor.reads()).toBe(4);
    await page.clock.runFor(1_000);
    await expectForcedDialog(page);

    // Escape and history Back keep it (no dismiss, `closeOnBack: false`).
    await page.keyboard.press('Escape');
    await page.clock.runFor(500);
    await expect(page.locator('#dialog-overlay')).toBeVisible();
    await page.evaluate(() => history.back());
    await page.clock.runFor(500);
    await expect(page.locator('#dialog-overlay')).toBeVisible();
    await expect(page.locator('#btn-dialog-secondary')).toBeHidden();
    expect(floor.reads()).toBe(4);
  });
});

test.describe('the floor check on a controlled page (service worker allowed)', () => {
  test('Apply below the floor reloads once; the next document of the same build is guarded and shows nothing', async ({
    page,
  }) => {
    const build = await artifactBuild(page);
    const floor = await routeFloorRead(page, build);
    await page.goto('/');
    await expect(page.locator('#btn-setup-host')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.ready.then(() => true)))
      .toBe(true);
    if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
      await page.reload();
      await expect(page.locator('#btn-setup-host')).toBeVisible();
    }
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // P0: page.route sees the floor read of a controlled page (the service
    // worker leaves /api/ to the network).
    await expect.poll(() => floor.reads()).toBeGreaterThan(0);
    const before = floor.reads();
    await page.evaluate(async (path) => {
      await fetch(path, { cache: 'no-store', credentials: 'omit' });
    }, APP_BUILD_FLOOR_CLIENT_PATH);
    expect(floor.reads()).toBe(before + 1);

    // The floor is above this build: the next document's start check
    // shows the forced dialog once its loads are quiet.
    floor.answer({ floor: build + 1 });
    await page.reload();
    await expectForcedDialog(page);

    const documentLoads: string[] = [];
    page.on('load', () => documentLoads.push(page.url()));
    await page.evaluate(() => {
      (window as { forcedApplyOldDocument?: boolean }).forcedApplyOldDocument = true;
    });
    const readsBeforeApply = floor.reads();
    const reloaded = page.waitForEvent('load');
    await page.locator('#btn-dialog-ok').click();
    await reloaded;
    expect(
      await page.evaluate(
        () => (window as { forcedApplyOldDocument?: boolean }).forcedApplyOldDocument ?? false,
      ),
      'Apply loaded a new document',
    ).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem('mxqr-forced-apply'))).toBe(
      `${build}:${build + 1}`,
    );

    // The new document runs the same build and reads the same floor at its
    // start: the loop guard holds, so no dialog and no second navigation.
    await expect.poll(() => floor.reads()).toBe(readsBeforeApply + 1);
    await page.waitForTimeout(10_000);
    expect(documentLoads).toHaveLength(1);
    await expect(page.locator('#dialog-overlay')).toBeHidden();
    expect(floor.reads()).toBe(readsBeforeApply + 1);
  });
});
