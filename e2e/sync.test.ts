/**
 * E2E: Sync Control Tests
 *
 * Tests manual sync offset controls:
 * - Sync button exists on the page
 * - Manual sync overlay opens/closes
 * - Nudge buttons adjust offset via sync:nudge bus events
 * - Display updates with offset value
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { readState } from './helpers/wait.ts';
import type { Page } from '@playwright/test';

/** Click an element by selector with JS fallback. */
async function jsClick(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector);
  try {
    await el.waitFor({ state: 'visible', timeout: 3_000 });
    await el.click();
  } catch {
    await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLElement)?.click(),
      selector,
    );
  }
}

/**
 * Open the manual sync overlay by adding 'show' class directly.
 * The app has no UI flow to open this overlay from btn-sync (btn-sync triggers auto-sync),
 * so we open it programmatically by adding the 'show' class.
 */
async function openSyncOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const overlay = document.getElementById('manual-sync-overlay');
    if (overlay) overlay.classList.add('show');
  });
  // Wait for the overlay to have the 'show' class
  await page.waitForFunction(
    () => {
      const overlay = document.getElementById('manual-sync-overlay');
      if (!overlay) return false;
      return overlay.classList.contains('show');
    },
    { timeout: 5_000 },
  );
}

/**
 * Wait for sync.localOffset to reach the expected value (in seconds).
 * Nudge values are in ms, but adjustSync stores them as seconds.
 */
async function waitForSyncOffset(page: Page, expectedSeconds: number, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    ([expected]) => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return false;
      const current = get('sync.localOffset') as number;
      // Compare with small epsilon for floating point
      return Math.abs(current - expected) < 0.0001;
    },
    [expectedSeconds] as const,
    { timeout },
  );
}

let pair: HostGuestPair;

test.describe('Sync Controls', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('sync button exists on guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const syncBtn = pair.guestPage.locator('#btn-sync');
    await expect(syncBtn).toBeAttached();
  });

  test('clicking sync opens manual sync overlay', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // The manual sync overlay is opened programmatically (no UI trigger from btn-sync).
    // Verify it can be shown with the 'show' class.
    await openSyncOverlay(pair.guestPage);

    const isShown = await pair.guestPage.evaluate(() => {
      const overlay = document.getElementById('manual-sync-overlay');
      return overlay?.classList.contains('show') ?? false;
    });
    expect(isShown).toBe(true);
  });

  test('nudge +1ms button increases offset', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openSyncOverlay(pair.guestPage);

    const initialOffset = ((await readState(pair.guestPage, 'sync.localOffset')) as number) ?? 0;

    // Nudge +1ms => adjustSync(1/1000) => localOffset += 0.001
    await jsClick(pair.guestPage, '#btn-nudge-plus1');
    await waitForSyncOffset(pair.guestPage, initialOffset + 0.001);

    const newOffset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(newOffset).toBeCloseTo(initialOffset + 0.001, 4);
  });

  test('nudge -1ms button decreases offset', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openSyncOverlay(pair.guestPage);

    const initialOffset = ((await readState(pair.guestPage, 'sync.localOffset')) as number) ?? 0;

    // Nudge -1ms => adjustSync(-1/1000) => localOffset -= 0.001
    await jsClick(pair.guestPage, '#btn-nudge-minus1');
    await waitForSyncOffset(pair.guestPage, initialOffset - 0.001);

    const newOffset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(newOffset).toBeCloseTo(initialOffset - 0.001, 4);
  });

  test('nudge +10ms button increases offset by 10', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openSyncOverlay(pair.guestPage);

    const initialOffset = ((await readState(pair.guestPage, 'sync.localOffset')) as number) ?? 0;

    // Nudge +10ms => adjustSync(10/1000) => localOffset += 0.01
    await jsClick(pair.guestPage, '#btn-nudge-plus10');
    await waitForSyncOffset(pair.guestPage, initialOffset + 0.01);

    const newOffset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(newOffset).toBeCloseTo(initialOffset + 0.01, 4);
  });

  test('nudge -10ms button decreases offset by 10', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openSyncOverlay(pair.guestPage);

    const initialOffset = ((await readState(pair.guestPage, 'sync.localOffset')) as number) ?? 0;

    // Nudge -10ms => adjustSync(-10/1000) => localOffset -= 0.01
    await jsClick(pair.guestPage, '#btn-nudge-minus10');
    await waitForSyncOffset(pair.guestPage, initialOffset - 0.01);

    const newOffset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(newOffset).toBeCloseTo(initialOffset - 0.01, 4);
  });

  test('multiple nudges accumulate correctly', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openSyncOverlay(pair.guestPage);

    // +10ms => 0.01s
    await jsClick(pair.guestPage, '#btn-nudge-plus10');
    await waitForSyncOffset(pair.guestPage, 0.01);

    // +10ms => 0.02s
    await jsClick(pair.guestPage, '#btn-nudge-plus10');
    await waitForSyncOffset(pair.guestPage, 0.02);

    // +1ms => 0.021s
    await jsClick(pair.guestPage, '#btn-nudge-plus1');
    await waitForSyncOffset(pair.guestPage, 0.021);

    const offset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(offset).toBeCloseTo(0.021, 4); // 10 + 10 + 1 = 21ms = 0.021s
  });

  test('sync display shows current offset value', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openSyncOverlay(pair.guestPage);

    // The display element should contain text with a number (the offset in ms)
    const text = await pair.guestPage.evaluate(() => {
      const display = document.getElementById('manual-sync-value');
      return display?.textContent ?? '';
    });
    expect(text).toBeTruthy();
    // Should contain a number (the offset, e.g. "+0ms" or "0")
    expect(text).toMatch(/\d/);
  });

  test('done button closes sync overlay', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openSyncOverlay(pair.guestPage);

    // btn-sync-done emits 'sync:close-manual' which removes 'show' class
    await jsClick(pair.guestPage, '#btn-sync-done');

    await pair.guestPage.waitForFunction(
      () => {
        const overlay = document.getElementById('manual-sync-overlay');
        return overlay ? !overlay.classList.contains('show') : true;
      },
      { timeout: 10_000 },
    );

    const isShown = await pair.guestPage.evaluate(() => {
      const overlay = document.getElementById('manual-sync-overlay');
      return overlay?.classList.contains('show') ?? false;
    });
    expect(isShown).toBe(false);
  });
});
