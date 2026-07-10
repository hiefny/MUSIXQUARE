/**
 * Host and guest setup-flow helpers for E2E tests.
 */
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const HOST_CODE_ATTEMPTS = 2;
const HOST_CODE_TIMEOUT_MS = 15_000;
const GUEST_JOIN_ATTEMPTS = 2;
const GUEST_JOIN_TIMEOUT_MS = 20_000;

/** Navigate to the app and wait for the setup choices. */
async function navigateAndWaitForSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#btn-setup-host', { state: 'visible', timeout: 15_000 });
}

async function setChannelModeForTest(page: Page, channelMode: number): Promise<void> {
  await page.evaluate((mode) => {
    const bus = (window as unknown as Record<string, { emit?: (...args: unknown[]) => void }>)
      .__MUSIXQUARE_BUS__;
    bus?.emit?.('audio:set-channel-mode', mode);
  }, channelMode);
}

async function waitForGeneratedHostCode(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('setup-code');
      if (!el) return false;
      const val = el.tagName === 'INPUT' ? (el as HTMLInputElement).value : el.textContent || '';
      return /^\d{6}$/.test(val.trim());
    },
    undefined,
    { timeout: HOST_CODE_TIMEOUT_MS },
  );

  const code = await page.evaluate(() => {
    const el = document.getElementById('setup-code')!;
    return el.tagName === 'INPUT' ? (el as HTMLInputElement).value : el.textContent || '';
  });

  return code.trim();
}

/**
 * Complete the host code-generation flow.
 * Returns the 6-digit session code.
 */
export async function setupHost(page: Page, channelMode = 0): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= HOST_CODE_ATTEMPTS; attempt += 1) {
    try {
      await navigateAndWaitForSetup(page);

      await page.click('#btn-setup-host');

      await page.waitForSelector('#setup-code-area', { state: 'visible', timeout: 10_000 });
      return await waitForGeneratedHostCode(page);
    } catch (error) {
      lastError = error;
      if (attempt === HOST_CODE_ATTEMPTS || page.isClosed()) break;
      await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  throw lastError;
}

/**
 * Complete host setup including starting the session.
 * Returns the 6-digit session code.
 */
export async function setupHostAndStart(page: Page, channelMode = 0): Promise<string> {
  const code = await setupHost(page, channelMode);

  await page.waitForSelector('#btn-setup-confirm:not([disabled])', { timeout: 15_000 });
  await page.click('#btn-setup-confirm');

  await page.waitForFunction(
    () => !document.getElementById('setup-overlay')?.classList.contains('active'),
    undefined,
    { timeout: 15_000 },
  );

  await setChannelModeForTest(page, channelMode);

  return code;
}

/**
 * Join as a guest, then apply the requested test channel after connection.
 */
export async function setupGuest(page: Page, joinCode: string, channelMode = 0): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= GUEST_JOIN_ATTEMPTS; attempt += 1) {
    try {
      await navigateAndWaitForSetup(page);

      await page.click('#btn-setup-guest');

      await page.waitForSelector('#setup-join-area', { state: 'visible', timeout: 10_000 });
      await page.fill('#setup-join-code', joinCode);
      await page.click('#btn-setup-confirm');

      await page.waitForFunction(
        () => !document.getElementById('setup-overlay')?.classList.contains('active'),
        undefined,
        { timeout: GUEST_JOIN_TIMEOUT_MS },
      );

      await setChannelModeForTest(page, channelMode);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === GUEST_JOIN_ATTEMPTS || page.isClosed()) break;
      await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  throw lastError;
}

/**
 * Full host+guest connection: sets up host, starts session, then joins guest.
 * Returns the session code.
 */
export async function connectHostAndGuest(
  hostPage: Page,
  guestPage: Page,
  hostChannel = 0,
  guestChannel = 0,
): Promise<string> {
  const code = await setupHostAndStart(hostPage, hostChannel);
  await setupGuest(guestPage, code, guestChannel);
  return code;
}
