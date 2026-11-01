/**
 * Every tab title sits on one baseline.
 *
 * Each tab header centres its title in a row whose other items take 36px:
 * the invite code, or the Playlist actions' 44px touch boxes with -4px
 * margins. A title line taller than 36px grows that row: a taller script
 * (Arabic, Thai, Indic), or CJK fonts drawn without the @font-face metric
 * overrides, as iOS Safari draws them. With several playlists the Playlist
 * title sits in the switch button, whose share of the row has to grow with
 * its line the same way, or that title ends up above the other tabs' titles.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { LANGUAGE_OPTIONS, type LanguageCode } from '../src/i18n/locales.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { dropFontMetricOverrides, titleBaseline } from './helpers/tab-header.ts';
import { navigateToTab, waitForAppFonts } from './helpers/wait.ts';

const PHONE = { width: 402, height: 874 };
const DESKTOP = { width: 1440, height: 900 };
const TOLERANCE = 0.5;

const SWITCH_BUTTON = '#btn-playlist-switch';
const SWITCH_TEXT = '#playlist-switch-label .playlist-slot-name-base';
const PLAIN_TEXT = '#tab-playlist > .tab-header > .tab-title[data-i18n="nav.playlist"]';
const TAB_TEXT = (tab: string) => `#tab-${tab} > .tab-header .tab-title`;

// Latin, Hangul, kana and Han with the shipped metric overrides, then scripts
// drawn taller than the 36px row: Arabic (right to left), Thai, Devanagari
// and Kannada.
const LANGUAGES: readonly LanguageCode[] = ['ko', 'en', 'ja', 'zh-hans', 'ar', 'th', 'hi', 'kn'];
// The CJK fonts' own metrics, which iOS Safari uses.
const WITHOUT_OVERRIDES: readonly LanguageCode[] = ['ko', 'ja'];

async function setPlaylistSlots(page: Page, slots: unknown): Promise<void> {
  await page.evaluate((value) => {
    (
      window as unknown as { __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void }
    ).__MUSIXQUARE_SET_STATE__('playlist.slots', value);
  }, slots);
}

async function readPlaylistSlots(page: Page): Promise<unknown> {
  return page.evaluate(() =>
    (
      window as unknown as { __MUSIXQUARE_GET_STATE__: (path: string) => unknown }
    ).__MUSIXQUARE_GET_STATE__('playlist.slots'),
  );
}

/**
 * The Playlist title's baseline with several playlists (the switch button)
 * and with one (the plain title an older host shows).
 */
async function playlistBaselines(page: Page): Promise<{ several: number; one: number }> {
  const slots = await readPlaylistSlots(page);
  const switchButton = page.locator(SWITCH_BUTTON);
  await expect(switchButton).toBeVisible();
  const several = await titleBaseline(page.locator(SWITCH_TEXT));
  // The title's line never shrinks the button below a 44px touch target.
  expect((await switchButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await setPlaylistSlots(page, null);
  await expect(switchButton).toBeHidden();
  const one = await titleBaseline(page.locator(PLAIN_TEXT));
  await setPlaylistSlots(page, slots);
  await expect(switchButton).toBeVisible();
  return { several, one };
}

async function expectSharedBaselines(
  info: TestInfo,
  label: string,
  playlist: Record<string, number>,
  others: Record<string, number>,
): Promise<void> {
  await info.attach(`${label} baselines`, {
    body: JSON.stringify({ playlist, others }, null, 2),
    contentType: 'application/json',
  });
  for (const [variant, baseline] of Object.entries(playlist)) {
    for (const [tab, other] of Object.entries(others)) {
      expect
        .soft(
          Math.abs(baseline - other),
          `${label}: Playlist (${variant}) at ${baseline}px, ${tab} at ${other}px`,
        )
        .toBeLessThanOrEqual(TOLERANCE);
    }
  }
}

async function checkHeaders(page: Page, info: TestInfo, language: LanguageCode): Promise<void> {
  await page.addInitScript((locale) => {
    localStorage.setItem('musixquare-lang', locale);
  }, language);
  await injectPeerServer(page);
  await page.setViewportSize(PHONE);
  await setupHostAndStart(page);
  await waitForAppFonts(page);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe(
    LANGUAGE_OPTIONS.find((locale) => locale.code === language)!.htmlLang,
  );

  await navigateToTab(page, 'playlist');
  const phonePlaylist = await playlistBaselines(page);
  const phoneOthers: Record<string, number> = {};
  for (const [tab, name] of [
    ['connect', 'Connect'],
    ['settings', 'Settings'],
    ['guide', 'Help'],
  ] as const) {
    await navigateToTab(page, tab);
    phoneOthers[name] = await titleBaseline(page.locator(TAB_TEXT(tab)));
  }
  await expectSharedBaselines(info, `${language} phone`, phonePlaylist, phoneOthers);

  // The dashboard shows Playlist beside Settings; Connect and Help are
  // phone-only tabs.
  await page.setViewportSize(DESKTOP);
  const desktopPlaylist = await playlistBaselines(page);
  const desktopSettings = await titleBaseline(page.locator(TAB_TEXT('settings')));
  await expectSharedBaselines(info, `${language} desktop`, desktopPlaylist, {
    Settings: desktopSettings,
  });
}

for (const language of LANGUAGES) {
  test(`the Playlist title shares the other tabs' baseline (${language})`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    await checkHeaders(page, info, language);
  });
}

test.describe('without the font metric overrides', () => {
  test.use({ serviceWorkers: 'block' });

  for (const language of WITHOUT_OVERRIDES) {
    test(`the Playlist title shares the other tabs' baseline (${language})`, async ({
      page,
    }, info) => {
      test.setTimeout(90_000);
      const dropped = await dropFontMetricOverrides(page);
      await checkHeaders(page, info, language);
      expect(dropped()).toBeGreaterThan(0);
    });
  }
});
