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
  clickAndWaitActive,
  navigateToSubtab,
  navigateToTab,
  readState,
  waitForState,
  waitForTheme,
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
  // Language selection moved from inline chips to a dialog (a1269f9e):
  // "Select" (#btn-language-select) opens #language-dialog-overlay, which
  // holds .language-option[data-lang] entries. Active state lives on the
  // chosen option (class "active" + aria-selected) and on the grid button
  // (#btn-language-select vs #btn-language-system).

  /** Open the language dialog from the settings General panel. */
  async function openLanguageDialog(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#btn-language-select').click();
    await page.waitForFunction(
      () =>
        document.getElementById('language-dialog-overlay')?.classList.contains('show') ?? false,
      undefined,
      { timeout: 5_000 },
    );
  }

  /** Wait until the i18n module has applied the resolved language to <html lang>. */
  async function waitForResolvedLang(
    page: import('@playwright/test').Page,
    lang: string,
  ): Promise<void> {
    await page.waitForFunction((l) => document.documentElement.getAttribute('lang') === l, lang, {
      timeout: 10_000,
    });
  }

  test('switching to English changes i18n text', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await openLanguageDialog(pair.hostPage);

    // Round-trip through Korean so picking English provably CHANGES the text
    // (the app already boots in English under the test browser locale).
    await clickAndWaitActive(pair.hostPage, '.language-option[data-lang="ko"]');
    await waitForResolvedLang(pair.hostPage, 'ko');

    await clickAndWaitActive(pair.hostPage, '.language-option[data-lang="en"]');
    await waitForResolvedLang(pair.hostPage, 'en');

    // Element-specific assertion: whole-body text checks are tautological now
    // because the always-rendered language list contains native names (한국어…).
    await pair.hostPage.waitForFunction(
      () =>
        document.querySelector('.section-title[data-i18n="settings.language"]')?.textContent ===
        'Language Settings',
      undefined,
      { timeout: 10_000 },
    );
    const themeTitle = await pair.hostPage
      .locator('.section-title[data-i18n="settings.theme"]')
      .textContent();
    expect(themeTitle).toBe('Theme');
  });

  test('switching to Korean changes i18n text', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await openLanguageDialog(pair.hostPage);

    await clickAndWaitActive(pair.hostPage, '.language-option[data-lang="ko"]');
    await waitForResolvedLang(pair.hostPage, 'ko');

    // Element-specific assertion against a static UI label (not the language
    // list, which contains \uD55C\uAD6D\uC5B4 in every locale).
    await pair.hostPage.waitForFunction(
      () =>
        document.querySelector('.section-title[data-i18n="settings.theme"]')?.textContent ===
        '\uD14C\uB9C8',
      undefined,
      { timeout: 10_000 },
    );
    const langTitle = await pair.hostPage
      .locator('.section-title[data-i18n="settings.language"]')
      .textContent();
    expect(langTitle).toContain('\uC5B8\uC5B4');
  });

  test('language selection shows active class', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await openLanguageDialog(pair.hostPage);

    await clickAndWaitActive(pair.hostPage, '.language-option[data-lang="en"]');

    const optionState = await pair.hostPage
      .locator('.language-option[data-lang="en"]')
      .evaluate((el) => ({
        active: el.classList.contains('active'),
        selected: el.getAttribute('aria-selected'),
      }));
    expect(optionState.active).toBe(true);
    expect(optionState.selected).toBe('true');

    // Explicit selection also marks the grid's "Select" button active
    // (vs "Use system language").
    const gridActive = await pair.hostPage
      .locator('#btn-language-select')
      .evaluate((el) => el.classList.contains('active'));
    expect(gridActive).toBe(true);
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
