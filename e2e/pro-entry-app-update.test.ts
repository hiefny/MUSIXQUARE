/**
 * Forced update (train 9.0.12): a PRO entry refused below the App build floor.
 *
 * Every API answer is synthetic (the room code and claim are fixtures, never a
 * real room). The PRO front door answers bootstrap with 426
 * APP_UPDATE_REQUIRED at a floor far above any build, so this page is below
 * it: the update dialog appears without Later, Escape and history Back keep
 * it, and Apply reloads into the same (still refused) build, whose second
 * refusal meets the loop guard and shows the ordinary connection failure.
 * Service workers are blocked, so the update machine's early handler
 * presents (the page has no registration).
 */
import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const ROOM_CODE = '000001';
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
/** Far above any real build: every page of this artifact is below it. */
const FLOOR = 2_000_000_000;

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });
}

/** The artifact's build: the integer of its service-worker cache epoch. */
async function artifactBuild(page: Page): Promise<number> {
  const source = await (await page.request.get('/service-worker.js')).text();
  const epoch = /\bconst\s+CACHE_VERSION\s*=\s*['"]v(\d+)['"]\s*;/u.exec(source)?.[1];
  expect(epoch, 'the artifact names its cache epoch').toBeDefined();
  return Number(epoch);
}

async function refuseEveryEntry(page: Page) {
  const bootstrapBuilds: Array<string | null> = [];
  const navigations: string[] = [];
  const unexpected: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem('musixquare-lang', 'en');
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-app-used-v1', '1');
  });
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') {
      await json(route, { configured: true, authenticated: false, account: null });
      return;
    }
    if (url.pathname.endsWith(`/v1/rooms/${ROOM_CODE}/bootstrap`)) {
      bootstrapBuilds.push(route.request().headers()['x-mxqr-app-build'] ?? null);
      await json(route, { error: 'APP_UPDATE_REQUIRED', minAppBuild: FLOOR }, 426);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await json(route, { error: 'LOCAL_FIXTURE_UNAVAILABLE' }, 503);
      return;
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      unexpected.push(url.origin);
      await route.abort();
      return;
    }
    await route.continue();
  });
  return { bootstrapBuilds, navigations, unexpected };
}

async function expectForcedDialog(page: Page): Promise<void> {
  await expect(page.locator('#dialog-overlay')).toBeVisible();
  await expect(page.locator('#dialog-title')).toHaveText('Update');
  await expect(page.locator('#dialog-message')).toContainText('A new version is ready.');
  await expect(page.locator('#btn-dialog-ok')).toHaveText('Apply');
  // No Later: the forced variant has only Apply.
  await expect(page.locator('#btn-dialog-secondary')).toBeHidden();
}

for (const entry of ['invite', 'claim'] as const) {
  test(`a refused PRO entry (${entry}) shows the update dialog without Later; Apply reloads once and the loop guard then shows the connection failure`, async ({
    page,
  }) => {
    const fixture = await refuseEveryEntry(page);
    const build = await artifactBuild(page);
    await page.goto(entry === 'claim' ? `/${ROOM_CODE}#pro-claim=${CLAIM}` : `/${ROOM_CODE}`);
    const historyLength = await page.evaluate(() => history.length);
    await page.locator('#btn-setup-confirm:not([disabled])').click();

    await expectForcedDialog(page);
    expect(fixture.bootstrapBuilds).toEqual([String(build)]);

    // Escape and history Back keep it (no dismiss, `closeOnBack: false`).
    await page.keyboard.press('Escape');
    await expect(page.locator('#dialog-overlay')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => history.length), {
        message: 'the Back guard arms for the open window',
      })
      .toBeGreaterThan(historyLength);
    await page.goBack();
    await expect(page.locator('#dialog-overlay')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/${ROOM_CODE}`);

    const navigatedBefore = fixture.navigations.length;
    // Apply first settles the dialog's Back guard (a same-document history
    // entry, which also reports a navigation), so wait for the next document's
    // load and tell it from the old one by a mark the old document carries.
    await page.evaluate(() => {
      (window as { forcedApplyOldDocument?: boolean }).forcedApplyOldDocument = true;
    });
    const reloaded = page.waitForEvent('load');
    await page.locator('#btn-dialog-ok').click();
    await reloaded;
    expect(
      await page.evaluate(
        () => (window as { forcedApplyOldDocument?: boolean }).forcedApplyOldDocument ?? false,
      ),
      'Apply loaded a new document',
    ).toBe(false);
    // An invite returns to this room's /CODE start screen; a claim link
    // reloads in place with the claim restored for the reload.
    if (entry === 'claim') {
      await expect
        .poll(() =>
          fixture.navigations
            .slice(navigatedBefore)
            .some((url) => url.includes(`#pro-claim=${CLAIM}`)),
        )
        .toBe(true);
    }
    const applied = fixture.navigations.slice(navigatedBefore);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((url) => new URL(url).pathname === `/${ROOM_CODE}`)).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('mxqr-forced-apply'))).toBe(
      `${build}:${FLOOR}`,
    );

    // The reloaded page runs the same build (this artifact), so its own
    // refusal meets the loop guard: the ordinary failure, no second dialog.
    await page.locator('#btn-setup-confirm:not([disabled])').click();
    await expect(page.locator('#setup-auto-join-error')).toContainText(
      'Could not connect to the PRO room',
    );
    await expect(page.locator('#dialog-overlay')).toBeHidden();
    expect(fixture.bootstrapBuilds).toEqual([String(build), String(build)]);
    expect(fixture.unexpected).toEqual([]);
  });
}
