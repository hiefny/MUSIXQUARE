/**
 * E2E: Settings Panel Tests
 *
 * Tests settings UI controls:
 * - Theme switching (light/dark)
 * - Language switching (ko/en)
 * - Battery saver toggle
 * - Settings subtab navigation
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import {
  clickAndWaitActive,
  navigateToSubtab,
  navigateToTab,
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

  test('resolves the balanced surface-2 token in both themes', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await navigateToTab(pair.hostPage, 'settings');

    const readSurface = async (): Promise<{ token: string; resolved: string }> =>
      pair.hostPage.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--surface-2)';
        document.body.append(probe);
        const resolved = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          token: getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim(),
          resolved,
        };
      });

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-theme="dark"]');
    await waitForTheme(pair.hostPage, 'dark');
    expect(await readSurface()).toEqual({ token: '#202020', resolved: 'rgb(32, 32, 32)' });

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-theme="light"]');
    await waitForTheme(pair.hostPage, 'light');
    expect(await readSurface()).toEqual({ token: '#eff1f3', resolved: 'rgb(239, 241, 243)' });
  });

  test('theme selection persists with active class', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await clickAndWaitActive(pair.hostPage, '.ch-opt[data-theme="dark"]');

    const hasActive = await pair.hostPage
      .locator('.ch-opt[data-theme="dark"]')
      .evaluate((el) => el.classList.contains('active'));
    expect(hasActive).toBe(true);
  });

  // ── Language Tests ──────────────────────────────────────────
  // Language selection uses a dialog rather than inline chips:
  // "Select" (#btn-language-select) opens #language-dialog-overlay, which
  // holds .language-option[data-lang] entries. Active state lives on the
  // chosen option (class "active" + aria-pressed) and on the grid button
  // (#btn-language-select vs #btn-language-system).

  /** Open the language dialog from the settings General panel. */
  async function openLanguageDialog(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#btn-language-select').click();
    await page.waitForFunction(
      () => document.getElementById('language-dialog-overlay')?.classList.contains('show') ?? false,
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
        pressed: el.getAttribute('aria-pressed'),
      }));
    expect(optionState.active).toBe(true);
    expect(optionState.pressed).toBe('true');

    // Explicit selection also marks the grid's "Select" button active
    // (vs "Use system language").
    const gridActive = await pair.hostPage
      .locator('#btn-language-select')
      .evaluate((el) => el.classList.contains('active'));
    expect(gridActive).toBe(true);
  });

  // ── Virtual Effects Toggle Tests ──────────────────────────────────────

  test('virtual surround toggles inside the combined effects card', async () => {
    test.setTimeout(90_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings', 15_000);

    // Navigate to the audio subtab where the combined virtual effects card lives.
    await navigateToSubtab(pair.hostPage, 'audio');

    await clickAndWaitActive(
      pair.hostPage,
      '#grid-virtual-effects .ch-opt[data-virtual-effect="surround"]',
    );

    const hasActive = await pair.hostPage
      .locator('#grid-virtual-effects .ch-opt[data-virtual-effect="surround"]')
      .evaluate((el) => el.classList.contains('active'));
    expect(hasActive).toBe(true);
  });

  // ── Settings Subtab Tests ────────────────────────────────────

  test('settings subtab pills navigate between panels', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    // Click audio subtab
    await navigateToSubtab(pair.hostPage, 'audio');

    const audioActive = await pair.hostPage
      .locator('.subtab-pill[data-subtab="audio"]')
      .evaluate((el) => el.classList.contains('active'));
    expect(audioActive).toBe(true);

    // Click back to general
    await navigateToSubtab(pair.hostPage, 'general');

    const generalActive = await pair.hostPage
      .locator('.subtab-pill[data-subtab="general"]')
      .evaluate((el) => el.classList.contains('active'));
    expect(generalActive).toBe(true);
  });

  test('connect subtab shows device management', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await navigateToSubtab(pair.hostPage, 'connect');

    // Should show device list or connect panel
    const connectPanel = pair.hostPage.locator('.settings-subtab-panel[data-panel="connect"]');
    const isActive = await connectPanel.evaluate((el) => el.classList.contains('active'));
    expect(isActive).toBe(true);
  });
});
