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
import {
  readState,
  navigateToTab,
  navigateToSubtab,
  clickAndWaitActive,
  waitForTheme,
  waitForLang,
  waitForState,
} from './helpers/wait.ts';

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

    await navigateToTab(pair.hostPage, 'settings');

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-theme="dark"]');
    await waitForTheme(pair.hostPage, 'dark');

    const theme = await pair.hostPage.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(theme).toBe('dark');
  });

  test('switching to light theme applies data-theme attribute', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // First set dark, then switch to light
    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-theme="dark"]');
    await waitForTheme(pair.hostPage, 'dark');

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-theme="light"]');
    await waitForTheme(pair.hostPage, 'light');

    const theme = await pair.hostPage.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(theme).toBe('light');
  });

  test('theme selection persists with active class', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-theme="dark"]');

    const hasActive = await pair.hostPage.locator('.ch-opt[data-theme="dark"]').evaluate(el => el.classList.contains('active'));
    expect(hasActive).toBe(true);
  });

  // ── Language Tests ──────────────────────────────────────────

  test('switching to English changes i18n text', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-lang="en"]');
    await waitForLang(pair.hostPage, 'en');

    // Some element should now have English text
    const bodyText = await pair.hostPage.evaluate(() => document.body.textContent || '');
    // English UI should have common English words
    expect(bodyText.toLowerCase()).toMatch(/settings|audio|connect|play/);
  });

  test('switching to Korean changes i18n text', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-lang="ko"]');
    await waitForLang(pair.hostPage, 'ko');

    // Some element should have Korean text
    const bodyText = await pair.hostPage.evaluate(() => document.body.textContent || '');
    // Korean UI should have Korean characters
    expect(bodyText).toMatch(/[\uAC00-\uD7A3]/); // Hangul range
  });

  test('language selection shows active class', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-lang="en"]');

    const hasActive = await pair.hostPage.locator('.ch-opt[data-lang="en"]').evaluate(el => el.classList.contains('active'));
    expect(hasActive).toBe(true);
  });

  // ── Virtual Surround Toggle Tests ──────────────────────────────────────

  test('battery saver toggle enables/disables', async () => {
    test.setTimeout(90_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings', 15_000);

    // Navigate to audio subtab where surround toggle lives
    await navigateToSubtab(pair.hostPage, 'audio');

    // Use #grid-surround as the on/off toggle (battery saver grid was removed)
    await clickAndWaitActive(pair.hostPage, '#grid-surround .ch-opt[data-toggle="on"]');

    const hasActive = await pair.hostPage.locator('#grid-surround .ch-opt[data-toggle="on"]').evaluate(el => el.classList.contains('active'));
    expect(hasActive).toBe(true);
  });

  // ── Settings Subtab Tests ────────────────────────────────────

  test('settings subtab pills navigate between panels', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // Click audio subtab
    await navigateToSubtab(pair.hostPage, 'audio');

    const audioActive = await pair.hostPage.locator('.subtab-pill[data-subtab="audio"]').evaluate(el => el.classList.contains('active'));
    expect(audioActive).toBe(true);

    // Click back to general
    await navigateToSubtab(pair.hostPage, 'general');

    const generalActive = await pair.hostPage.locator('.subtab-pill[data-subtab="general"]').evaluate(el => el.classList.contains('active'));
    expect(generalActive).toBe(true);
  });

  test('connect subtab shows device management', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await navigateToSubtab(pair.hostPage, 'connect');

    // Should show device list or connect panel
    const connectPanel = pair.hostPage.locator('.settings-subtab-panel[data-panel="connect"]');
    const isActive = await connectPanel.evaluate(el => el.classList.contains('active'));
    expect(isActive).toBe(true);
  });

  // ── Max Guest Slots Tests ────────────────────────────────────

  test('max guest slots stepper changes value', async () => {
    test.setTimeout(90_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Try connect tab first (mobile layout), fall back to settings > connect subtab (desktop)
    await navigateToTab(pair.hostPage, 'connect', 15_000).catch(async () => {
      await navigateToTab(pair.hostPage, 'settings', 15_000);
      await navigateToSubtab(pair.hostPage, 'connect');
    });

    // Read current value
    const initialSlots = await readState(pair.hostPage, 'network.maxGuestSlots') as number;

    // Click plus button via JS fallback (stepper may be CSS-hidden)
    await pair.hostPage.evaluate(() => {
      const stepper = document.getElementById('max-device-stepper')
        || document.getElementById('desktop-max-device-stepper');
      if (!stepper) return;
      const plusBtn = stepper.querySelector('.stepper-btn[data-dir="1"]') as HTMLElement;
      plusBtn?.click();
    });
    await waitForState(pair.hostPage, 'network.maxGuestSlots', initialSlots + 1, 10_000);

    const newSlots = await readState(pair.hostPage, 'network.maxGuestSlots') as number;
    expect(newSlots).toBe(initialSlots + 1);
  });
});
