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
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import {
  clickPlayButton,
  readState,
  waitForFilePlaybackReady,
  waitForPlaylistCount,
  waitForPlayState,
} from './helpers/wait.ts';
import type { Page } from '@playwright/test';

/** Click an element by selector with JS fallback. */
async function jsClick(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector);
  try {
    await el.waitFor({ state: 'visible', timeout: 3_000 });
    await el.click();
  } catch {
    await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement)?.click(), selector);
  }
}

async function openSyncOverlay(page: Page): Promise<void> {
  await jsClick(page, '#btn-sync');
  await page.waitForFunction(
    () => {
      const overlay = document.getElementById('manual-sync-overlay');
      if (!overlay) return false;
      return overlay.classList.contains('show');
    },
    { timeout: 5_000 },
  );
}

async function prepareGuestManualSync(): Promise<void> {
  await connectHostAndGuest(pair.hostPage, pair.guestPage);
  await uploadFixture(pair.hostPage, 'test01');
  await waitForPlaylistCount(pair.hostPage, 1);
  await waitForPlaylistCount(pair.guestPage, 1, 25_000);
  await waitForFilePlaybackReady(pair.hostPage, 20_000);
  await clickPlayButton(pair.hostPage);
  await waitForPlayState(pair.hostPage, true);
  await pair.guestPage.waitForFunction(
    () => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      const hostConn = get?.('network.hostConn') as { open?: boolean } | null | undefined;
      return (
        hostConn?.open === true &&
        get?.('playback.mode') === 'file' &&
        get?.('files.currentFileBlob') !== null
      );
    },
    { timeout: 25_000 },
  );
}

/**
 * Wait for sync.localOffset to reach the expected value (in seconds).
 * Nudge values are in ms, but adjustSync stores them as seconds.
 */
async function waitForSyncOffset(
  page: Page,
  expectedSeconds: number,
  timeout = 10_000,
): Promise<void> {
  await page.waitForFunction(
    ([expected]) => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return false;
      const current = get('sync.localOffset') as number;
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
    await prepareGuestManualSync();

    await openSyncOverlay(pair.guestPage);

    const isShown = await pair.guestPage.evaluate(() => {
      const overlay = document.getElementById('manual-sync-overlay');
      return overlay?.classList.contains('show') ?? false;
    });
    expect(isShown).toBe(true);
  });

  test('nudge +1ms button increases offset', async () => {
    await prepareGuestManualSync();

    await openSyncOverlay(pair.guestPage);

    const initialOffset = ((await readState(pair.guestPage, 'sync.localOffset')) as number) ?? 0;

    await jsClick(pair.guestPage, '#btn-nudge-plus1');
    await waitForSyncOffset(pair.guestPage, initialOffset + 0.001);

    const newOffset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(newOffset).toBeCloseTo(initialOffset + 0.001, 4);
  });

  test('nudge -1ms button decreases offset', async () => {
    await prepareGuestManualSync();

    await openSyncOverlay(pair.guestPage);

    const initialOffset = ((await readState(pair.guestPage, 'sync.localOffset')) as number) ?? 0;

    await jsClick(pair.guestPage, '#btn-nudge-minus1');
    await waitForSyncOffset(pair.guestPage, initialOffset - 0.001);

    const newOffset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(newOffset).toBeCloseTo(initialOffset - 0.001, 4);
  });

  test('nudge +10ms button increases offset by 10', async () => {
    await prepareGuestManualSync();

    await openSyncOverlay(pair.guestPage);

    const initialOffset = ((await readState(pair.guestPage, 'sync.localOffset')) as number) ?? 0;

    await jsClick(pair.guestPage, '#btn-nudge-plus10');
    await waitForSyncOffset(pair.guestPage, initialOffset + 0.01);

    const newOffset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(newOffset).toBeCloseTo(initialOffset + 0.01, 4);
  });

  test('nudge -10ms button decreases offset by 10', async () => {
    await prepareGuestManualSync();

    await openSyncOverlay(pair.guestPage);

    const initialOffset = ((await readState(pair.guestPage, 'sync.localOffset')) as number) ?? 0;

    await jsClick(pair.guestPage, '#btn-nudge-minus10');
    await waitForSyncOffset(pair.guestPage, initialOffset - 0.01);

    const newOffset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(newOffset).toBeCloseTo(initialOffset - 0.01, 4);
  });

  test('multiple nudges accumulate correctly', async () => {
    await prepareGuestManualSync();

    await openSyncOverlay(pair.guestPage);

    await jsClick(pair.guestPage, '#btn-nudge-plus10');
    await waitForSyncOffset(pair.guestPage, 0.01);

    await jsClick(pair.guestPage, '#btn-nudge-plus10');
    await waitForSyncOffset(pair.guestPage, 0.02);

    await jsClick(pair.guestPage, '#btn-nudge-plus1');
    await waitForSyncOffset(pair.guestPage, 0.021);

    const offset = (await readState(pair.guestPage, 'sync.localOffset')) as number;
    expect(offset).toBeCloseTo(0.021, 4); // 10 + 10 + 1 = 21ms = 0.021s
  });

  test('sync display shows current offset value', async () => {
    await prepareGuestManualSync();

    await openSyncOverlay(pair.guestPage);

    const text = await pair.guestPage.evaluate(() => {
      const display = document.getElementById('manual-sync-value');
      return display?.textContent ?? '';
    });
    expect(text).toBeTruthy();
    expect(text).toMatch(/\d/);
  });

  test('done button closes sync overlay', async () => {
    await prepareGuestManualSync();

    await openSyncOverlay(pair.guestPage);

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
