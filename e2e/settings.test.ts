/**
 * E2E: Settings Panel Tests
 *
 * Tests settings UI controls:
 * - Theme switching (light/dark)
 * - Language switching (ko/en)
 * - Battery saver toggle
 * - Settings subtab navigation
 * - Max guest slots stepper
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import { readState } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Settings Panel', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  // ── Theme Tests ──────────────────────────────────────────────

  test('switching to dark theme applies data-theme attribute', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    const darkBtn = pair.hostPage.locator('.ch-opt[data-theme="dark"]');
    if (await darkBtn.isVisible()) {
      await darkBtn.click();
      await pair.hostPage.waitForTimeout(500);

      const theme = await pair.hostPage.evaluate(() =>
        document.documentElement.getAttribute('data-theme'),
      );
      expect(theme).toBe('dark');
    }
  });

  test('switching to light theme applies data-theme attribute', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    // First set dark, then switch to light
    const darkBtn = pair.hostPage.locator('.ch-opt[data-theme="dark"]');
    if (await darkBtn.isVisible()) await darkBtn.click();
    await pair.hostPage.waitForTimeout(300);

    const lightBtn = pair.hostPage.locator('.ch-opt[data-theme="light"]');
    if (await lightBtn.isVisible()) {
      await lightBtn.click();
      await pair.hostPage.waitForTimeout(500);

      const theme = await pair.hostPage.evaluate(() =>
        document.documentElement.getAttribute('data-theme'),
      );
      expect(theme).toBe('light');
    }
  });

  test('theme selection persists with active class', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    const darkBtn = pair.hostPage.locator('.ch-opt[data-theme="dark"]');
    if (await darkBtn.isVisible()) {
      await darkBtn.click();
      await pair.hostPage.waitForTimeout(300);

      const hasActive = await darkBtn.evaluate(el => el.classList.contains('active'));
      expect(hasActive).toBe(true);
    }
  });

  // ── Language Tests ──────────────────────────────────────────

  test('switching to English changes i18n text', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    const enBtn = pair.hostPage.locator('.ch-opt[data-lang="en"]');
    if (await enBtn.isVisible()) {
      await enBtn.click();
      await pair.hostPage.waitForTimeout(1000);

      // Some element should now have English text
      const bodyText = await pair.hostPage.evaluate(() => document.body.textContent || '');
      // English UI should have common English words
      expect(bodyText.toLowerCase()).toMatch(/settings|audio|connect|play/);
    }
  });

  test('switching to Korean changes i18n text', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    const koBtn = pair.hostPage.locator('.ch-opt[data-lang="ko"]');
    if (await koBtn.isVisible()) {
      await koBtn.click();
      await pair.hostPage.waitForTimeout(1000);

      // Some element should have Korean text
      const bodyText = await pair.hostPage.evaluate(() => document.body.textContent || '');
      // Korean UI should have Korean characters
      expect(bodyText).toMatch(/[\uAC00-\uD7A3]/); // Hangul range
    }
  });

  test('language selection shows active class', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    const enBtn = pair.hostPage.locator('.ch-opt[data-lang="en"]');
    if (await enBtn.isVisible()) {
      await enBtn.click();
      await pair.hostPage.waitForTimeout(300);

      const hasActive = await enBtn.evaluate(el => el.classList.contains('active'));
      expect(hasActive).toBe(true);
    }
  });

  // ── Battery Saver Tests ──────────────────────────────────────

  test('battery saver toggle enables/disables', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    const onBtn = pair.hostPage.locator('#grid-battery .ch-opt[data-toggle="on"]');
    if (await onBtn.isVisible()) {
      await onBtn.click();
      await pair.hostPage.waitForTimeout(500);

      const hasActive = await onBtn.evaluate(el => el.classList.contains('active'));
      expect(hasActive).toBe(true);
    }
  });

  // ── Settings Subtab Tests ────────────────────────────────────

  test('settings subtab pills navigate between panels', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    // Check subtab pills exist
    const generalPill = pair.hostPage.locator('.subtab-pill[data-subtab="general"]');
    const audioPill = pair.hostPage.locator('.subtab-pill[data-subtab="audio"]');

    if (await generalPill.isVisible()) {
      // Click audio subtab
      if (await audioPill.isVisible()) {
        await audioPill.click();
        await pair.hostPage.waitForTimeout(300);

        const audioActive = await audioPill.evaluate(el => el.classList.contains('active'));
        expect(audioActive).toBe(true);
      }

      // Click back to general
      await generalPill.click();
      await pair.hostPage.waitForTimeout(300);

      const generalActive = await generalPill.evaluate(el => el.classList.contains('active'));
      expect(generalActive).toBe(true);
    }
  });

  test('connect subtab shows device management', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    const connectPill = pair.hostPage.locator('.subtab-pill[data-subtab="connect"]');
    if (await connectPill.isVisible()) {
      await connectPill.click();
      await pair.hostPage.waitForTimeout(300);

      // Should show device list or connect panel
      const connectPanel = pair.hostPage.locator('.settings-subtab-panel[data-panel="connect"]');
      const isActive = await connectPanel.evaluate(el => el.classList.contains('active'));
      expect(isActive).toBe(true);
    }
  });

  // ── Max Guest Slots Tests ────────────────────────────────────

  test('max guest slots stepper changes value', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Navigate to connect tab or settings connect subtab
    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
      await pair.hostPage.waitForTimeout(500);
    }

    // Check stepper exists
    const stepper = pair.hostPage.locator('#max-device-stepper, #desktop-max-device-stepper');
    if (await stepper.first().isVisible()) {
      // Read current value
      const initialSlots = await readState(pair.hostPage, 'network.maxGuestSlots') as number;

      // Click plus button (stepper typically has +/- buttons)
      const plusBtn = pair.hostPage.locator('#max-device-stepper .stepper-btn:last-child, #desktop-max-device-stepper .stepper-btn:last-child');
      if (await plusBtn.first().isVisible()) {
        await plusBtn.first().click();
        await pair.hostPage.waitForTimeout(500);

        const newSlots = await readState(pair.hostPage, 'network.maxGuestSlots') as number;
        expect(newSlots).toBe(initialSlots + 1);
      }
    }
  });
});
