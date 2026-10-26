/**
 * Forced update (train 9.0.14) against the local Standard signaling Worker (C5-0
 * lab). The wrapper's lab route sets the App build floor and the live-App
 * report on the local ServiceControl, which production sets only through the
 * App Worker. The pages are the working tree's E2E build and report its cache
 * epoch as `appBuild`; the lab config blocks service workers, so the update
 * machine's early handler presents the forced dialog.
 *
 * Room codes are the ones the local Worker hands out; no real room is involved.
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import WebSocket from 'ws';
import {
  APP_UPDATE_REQUIRED_CODE,
  APP_UPDATE_REQUIRED_ERROR_TYPE,
} from '../../cloudflare/app-build-floor-contract.ts';
import { waitForBootstrapReady } from '../helpers/bootstrap.ts';
import { useAnonymousAccountSession } from '../helpers/context-factory.ts';
import { isBenignPageError } from '../helpers/page-errors.ts';
import {
  LAB_APP_BUILD_FLOOR_PATH,
  LAB_APP_ORIGIN,
  LAB_SIGNALING_ORIGIN,
  LAB_SIGNALING_URL,
} from './lab-env.ts';

/**
 * The Workers cache their floor read for one second per binding
 * (cloudflare/service-maintenance.ts), so a change reaches the room object
 * within this much.
 */
const FLOOR_CHANGE_SETTLE_MS = 1_500;
const FORCED_APPLY_KEY = 'mxqr-forced-apply';

/** The E2E artifact's build: the integer of its service-worker cache epoch. */
async function artifactBuild(page: Page): Promise<number> {
  const source = await (await page.request.get(`${LAB_APP_ORIGIN}/service-worker.js`)).text();
  const epoch = /\bconst\s+CACHE_VERSION\s*=\s*['"]v(\d+)['"]\s*;/u.exec(source)?.[1];
  expect(epoch, 'the artifact names its cache epoch').toBeDefined();
  return Number(epoch);
}

/** Sets the stored floor and the live-App report (so the effective floor is `minAppBuild`). */
async function setFloor(page: Page, minAppBuild: number, liveAppBuild: number): Promise<void> {
  const response = await page.request.post(`${LAB_SIGNALING_ORIGIN}${LAB_APP_BUILD_FLOOR_PATH}`, {
    data: { minAppBuild, liveAppBuild },
  });
  expect(response.status(), await response.text()).toBe(200);
  expect(((await response.json()) as { effectiveMinAppBuild: number }).effectiveMinAppBuild).toBe(
    minAppBuild,
  );
  await page.waitForTimeout(FLOOR_CHANGE_SETTLE_MS);
}

async function openPage(browser: Browser, pageErrors: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    if (!isBenignPageError(error)) pageErrors.push(String(error));
  });
  await page.addInitScript((signalingUrl) => {
    const w = window as unknown as Record<string, unknown>;
    w.__MUSIXQUARE_TRANSPORT__ = { provider: 'cloudflare', signalingUrl };
    try {
      localStorage.setItem('musixquare-lang', 'en');
      localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
      localStorage.setItem('musixquare-app-used-v1', '1');
    } catch {
      // Opaque documents have no storage.
    }
  }, LAB_SIGNALING_URL);
  await useAnonymousAccountSession(page);
  return page;
}

async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await waitForBootstrapReady(page);
  await page.waitForSelector('#btn-setup-host', { state: 'visible', timeout: 15_000 });
}

async function waitForRoomCode(page: Page): Promise<string> {
  await page.waitForFunction(
    () =>
      /^\d{6}$/.test(
        (document.getElementById('setup-code') as HTMLInputElement | null)?.value ?? '',
      ),
    undefined,
    { timeout: 20_000 },
  );
  return page.locator('#setup-code').inputValue();
}

async function openHostRoom(page: Page): Promise<string> {
  await openSetup(page);
  await page.click('#btn-setup-host');
  const code = await waitForRoomCode(page);
  await page.click('#btn-setup-confirm:not([disabled])');
  await page.waitForFunction(
    () => !document.getElementById('setup-overlay')?.classList.contains('active'),
    undefined,
    { timeout: 20_000 },
  );
  return code;
}

/** The update dialog without Later, with the message for an entry that was never admitted. */
async function expectForcedDialog(page: Page): Promise<void> {
  await expect(page.locator('#dialog-overlay')).toBeVisible();
  await expect(page.locator('#dialog-title')).toHaveText('Update');
  await expect(page.locator('#dialog-message')).toContainText('A new version is ready.');
  await expect(page.locator('#dialog-message')).toContainText('Applying it reloads the page.');
  await expect(page.locator('#btn-dialog-ok')).toHaveText('Apply');
  await expect(page.locator('#btn-dialog-secondary')).toBeHidden();
}

/** Taps Apply and waits for the next document (Apply first settles the dialog's Back guard). */
async function applyAndWaitForNextDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as { forcedApplyOldDocument?: boolean }).forcedApplyOldDocument = true;
  });
  const loaded = page.waitForEvent('load');
  await page.locator('#btn-dialog-ok').click();
  await loaded;
  expect(
    await page.evaluate(
      () => (window as { forcedApplyOldDocument?: boolean }).forcedApplyOldDocument ?? false,
    ),
    'Apply loaded a new document',
  ).toBe(false);
}

/** A 9.0.13-shape guest (no appBuild) on a raw socket: every frame it gets, and the close. */
function legacyGuestAdmission(
  code: string,
): Promise<{ frames: unknown[]; close: { code: number; reason: string } }> {
  return new Promise((resolve, reject) => {
    const peerId = `lab-legacy-guest-${randomBytes(6).toString('hex')}`;
    const socket = new WebSocket(`${LAB_SIGNALING_URL}/${code}/ws?role=guest&peerId=${peerId}`, {
      origin: LAB_APP_ORIGIN,
    });
    const frames: unknown[] = [];
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('the legacy guest socket was not closed within 10 s'));
    }, 10_000);
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'guest-auth',
          password: '',
          reconnectSecret: randomBytes(32).toString('base64url'),
        }),
      );
    });
    socket.on('message', (data) => frames.push(JSON.parse(String(data))));
    socket.on('close', (closeCode, reason) => {
      clearTimeout(timer);
      resolve({ frames, close: { code: closeCode, reason: reason.toString() } });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test.describe('forced update over the local signaling Worker', () => {
  test('a host refused while creating its room: forced dialog, Back keeps it, Apply reloads once, then the loop guard and floor 0', async ({
    browser,
  }) => {
    const pageErrors: string[] = [];
    const page = await openPage(browser, pageErrors);
    const build = await artifactBuild(page);
    await setFloor(page, build + 1, build + 1);

    await openSetup(page);
    const historyLength = await page.evaluate(() => history.length);
    await page.click('#btn-setup-host');
    await expectForcedDialog(page);
    // The forced dialog owns the refusal: no creation error text under it.
    await expect(page.locator('#setup-host-error')).not.toContainText("Couldn't create session");

    // Escape and history Back keep it (not dismissible, `closeOnBack: false`).
    await page.keyboard.press('Escape');
    await expect(page.locator('#dialog-overlay')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => history.length), {
        message: 'the Back guard arms for the open window',
      })
      .toBeGreaterThan(historyLength);
    await page.goBack();
    await expect(page.locator('#dialog-overlay')).toBeVisible();

    // A host creating its room reloads in place.
    await applyAndWaitForNextDocument(page);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await page.evaluate((key) => sessionStorage.getItem(key), FORCED_APPLY_KEY)).toBe(
      `${build}:${build + 1}`,
    );

    // The same build again: its refusal meets the loop guard, so the ordinary
    // creation error shows and no second dialog opens.
    await waitForBootstrapReady(page);
    await page.waitForSelector('#btn-setup-host', { state: 'visible', timeout: 15_000 });
    await page.click('#btn-setup-host');
    await expect(page.locator('#setup-host-error')).toContainText("Couldn't create session");
    await expect(page.locator('#dialog-overlay')).toBeHidden();

    // Floor 0 (off): Retry creates the room.
    await setFloor(page, 0, build);
    await page.click('#btn-setup-confirm:not([disabled])');
    expect(await waitForRoomCode(page)).toMatch(/^\d{6}$/);
    await expect(page.locator('#setup-host-error')).not.toContainText("Couldn't create session");
    expect(pageErrors).toEqual([]);
    await page.context().close();
  });

  test('below the floor, an old-shape guest gets the exact refusal and a guest on a typed code returns to that room', async ({
    browser,
  }) => {
    const pageErrors: string[] = [];
    const host = await openPage(browser, pageErrors);
    const build = await artifactBuild(host);
    await setFloor(host, 0, build);
    const code = await openHostRoom(host);

    await setFloor(host, build + 1, build + 1);

    // A guest that sends no appBuild (9.0.13 and older) counts as build 0.
    const legacy = await legacyGuestAdmission(code);
    expect(legacy.frames).toEqual([
      {
        type: 'error',
        errorType: APP_UPDATE_REQUIRED_ERROR_TYPE,
        message: APP_UPDATE_REQUIRED_CODE,
        minAppBuild: build + 1,
      },
    ]);
    expect(legacy.close).toEqual({ code: 1008, reason: APP_UPDATE_REQUIRED_CODE });

    // This build, on a code typed on the home screen.
    const guest = await openPage(browser, pageErrors);
    await openSetup(guest);
    await guest.click('#btn-setup-guest');
    await guest.fill('#setup-join-code', code);
    await guest.click('#btn-setup-confirm');
    await expectForcedDialog(guest);
    await expect(guest.locator('#setup-guest-error')).toBeEmpty();
    await applyAndWaitForNextDocument(guest);
    expect(new URL(guest.url()).pathname).toBe(`/${code}`);

    // The admitted host is never re-checked: its room stays open, no dialog.
    await expect(host.locator('#dialog-overlay')).toBeHidden();
    expect(
      await host.evaluate(() =>
        (
          window as unknown as { __MUSIXQUARE_GET_STATE__: (key: string) => unknown }
        ).__MUSIXQUARE_GET_STATE__('setup.sessionStarted'),
      ),
    ).toBe(true);

    await setFloor(host, 0, build);
    expect(pageErrors).toEqual([]);
    await guest.context().close();
    await host.context().close();
  });
});
