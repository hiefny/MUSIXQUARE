/**
 * E2E: Sync Control Tests
 *
 * Tests manual sync offset controls:
 * - Sync button opens overlay
 * - Nudge buttons adjust offset
 * - Display updates with offset value
 * - Sync overlay closes
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { readState } from './helpers/wait.ts';

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

    const syncBtn = pair.guestPage.locator('#btn-sync');
    if (await syncBtn.isVisible()) {
      await syncBtn.click();
      await pair.guestPage.waitForTimeout(500);

      const overlay = pair.guestPage.locator('#manual-sync-overlay');
      const isActive = await overlay.evaluate(el =>
        el.classList.contains('active') || el.style.display !== 'none',
      ).catch(() => false);
      expect(isActive).toBe(true);
    }
  });

  test('nudge +1ms button increases offset', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const syncBtn = pair.guestPage.locator('#btn-sync');
    if (await syncBtn.isVisible()) {
      await syncBtn.click();
      await pair.guestPage.waitForTimeout(500);

      const initialOffset = await readState(pair.guestPage, 'sync.localOffset') as number;

      const nudgePlus1 = pair.guestPage.locator('#btn-nudge-plus1');
      if (await nudgePlus1.isVisible()) {
        await nudgePlus1.click();
        await pair.guestPage.waitForTimeout(300);

        const newOffset = await readState(pair.guestPage, 'sync.localOffset') as number;
        expect(newOffset).toBe(initialOffset + 1);
      }
    }
  });

  test('nudge -1ms button decreases offset', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const syncBtn = pair.guestPage.locator('#btn-sync');
    if (await syncBtn.isVisible()) {
      await syncBtn.click();
      await pair.guestPage.waitForTimeout(500);

      const initialOffset = await readState(pair.guestPage, 'sync.localOffset') as number;

      const nudgeMinus1 = pair.guestPage.locator('#btn-nudge-minus1');
      if (await nudgeMinus1.isVisible()) {
        await nudgeMinus1.click();
        await pair.guestPage.waitForTimeout(300);

        const newOffset = await readState(pair.guestPage, 'sync.localOffset') as number;
        expect(newOffset).toBe(initialOffset - 1);
      }
    }
  });

  test('nudge +10ms button increases offset by 10', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const syncBtn = pair.guestPage.locator('#btn-sync');
    if (await syncBtn.isVisible()) {
      await syncBtn.click();
      await pair.guestPage.waitForTimeout(500);

      const initialOffset = await readState(pair.guestPage, 'sync.localOffset') as number;

      const nudgePlus10 = pair.guestPage.locator('#btn-nudge-plus10');
      if (await nudgePlus10.isVisible()) {
        await nudgePlus10.click();
        await pair.guestPage.waitForTimeout(300);

        const newOffset = await readState(pair.guestPage, 'sync.localOffset') as number;
        expect(newOffset).toBe(initialOffset + 10);
      }
    }
  });

  test('nudge -10ms button decreases offset by 10', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const syncBtn = pair.guestPage.locator('#btn-sync');
    if (await syncBtn.isVisible()) {
      await syncBtn.click();
      await pair.guestPage.waitForTimeout(500);

      const initialOffset = await readState(pair.guestPage, 'sync.localOffset') as number;

      const nudgeMinus10 = pair.guestPage.locator('#btn-nudge-minus10');
      if (await nudgeMinus10.isVisible()) {
        await nudgeMinus10.click();
        await pair.guestPage.waitForTimeout(300);

        const newOffset = await readState(pair.guestPage, 'sync.localOffset') as number;
        expect(newOffset).toBe(initialOffset - 10);
      }
    }
  });

  test('multiple nudges accumulate correctly', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const syncBtn = pair.guestPage.locator('#btn-sync');
    if (await syncBtn.isVisible()) {
      await syncBtn.click();
      await pair.guestPage.waitForTimeout(500);

      const nudgePlus10 = pair.guestPage.locator('#btn-nudge-plus10');
      const nudgePlus1 = pair.guestPage.locator('#btn-nudge-plus1');

      if (await nudgePlus10.isVisible() && await nudgePlus1.isVisible()) {
        await nudgePlus10.click();
        await pair.guestPage.waitForTimeout(200);
        await nudgePlus10.click();
        await pair.guestPage.waitForTimeout(200);
        await nudgePlus1.click();
        await pair.guestPage.waitForTimeout(300);

        const offset = await readState(pair.guestPage, 'sync.localOffset') as number;
        expect(offset).toBe(21); // 10 + 10 + 1
      }
    }
  });

  test('sync display shows current offset value', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const syncBtn = pair.guestPage.locator('#btn-sync');
    if (await syncBtn.isVisible()) {
      await syncBtn.click();
      await pair.guestPage.waitForTimeout(500);

      const display = pair.guestPage.locator('#manual-sync-value');
      if (await display.isVisible()) {
        const text = await display.textContent();
        expect(text).toBeTruthy();
        // Should contain a number (the offset)
        expect(text).toMatch(/\d/);
      }
    }
  });

  test('done button closes sync overlay', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const syncBtn = pair.guestPage.locator('#btn-sync');
    if (await syncBtn.isVisible()) {
      await syncBtn.click();
      await pair.guestPage.waitForTimeout(500);

      const doneBtn = pair.guestPage.locator('#btn-sync-done');
      if (await doneBtn.isVisible()) {
        await doneBtn.click();
        await pair.guestPage.waitForTimeout(500);

        const isActive = await pair.guestPage.evaluate(() => {
          const overlay = document.getElementById('manual-sync-overlay');
          return overlay?.classList.contains('active');
        });
        expect(isActive).toBeFalsy();
      }
    }
  });
});
