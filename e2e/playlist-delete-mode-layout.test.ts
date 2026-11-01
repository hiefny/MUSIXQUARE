import { expect, test, type Page } from '@playwright/test';
import { uploadFixtures } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { serveTallerFontLines, titleBaseline } from './helpers/tab-header.ts';
import { navigateToTab, waitForAppFonts, waitForPlaylistCount } from './helpers/wait.ts';

async function playlistGeometry(
  page: Page,
): Promise<{ header: number; list: number; scroll: number; max: number }> {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('#tab-playlist .tab-header')!;
    const list = document.querySelector<HTMLElement>('#playlist-ui')!;
    const body = document.querySelector<HTMLElement>('#tab-playlist .tab-body')!;
    return {
      scroll: body.scrollTop,
      max: body.scrollHeight - body.clientHeight,
      header: header.getBoundingClientRect().height,
      list: list.getBoundingClientRect().top,
    };
  });
}

for (const [label, viewport] of [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
  ['short desktop', { width: 1366, height: 768 }],
] as const) {
  test(`entering delete mode keeps the ${label} playlist in place`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await injectPeerServer(page);
    await setupHostAndStart(page);
    await uploadFixtures(page, ['test01', 'test02', 'test03']);
    await waitForPlaylistCount(page, 3);
    if (label === 'phone') await navigateToTab(page, 'playlist');

    // Let the list's entrance motion settle before taking the reference.
    await page.waitForTimeout(1500);
    const before = await playlistGeometry(page);
    // The header crossfade keeps an inert, aria-hidden copy of the controls
    // while it fades, so target only the live title.
    const selectionTitle = page.locator('.playlist-selection-title:not(.playlist-header-fade *)');
    await page.locator('.btn-playlist-select').nth(1).click();
    await expect(selectionTitle).toBeVisible();
    const during = await playlistGeometry(page);
    await page.locator('[data-selection-action="cancel"]').click();
    await expect(selectionTitle).toBeHidden();
    const after = await playlistGeometry(page);

    for (const state of [during, after]) {
      expect(Math.abs(state.header - before.header)).toBeLessThan(0.5);
      expect(Math.abs(state.list - before.list)).toBeLessThan(0.5);
      expect(state.scroll).toBe(before.scroll);
    }
  });
}

// A title line taller than the 36px row grows the header: Arabic and Thai,
// and CJK drawn with taller font lines (as iOS Safari drew them before the
// font files carried the shipped line box). The mode keeps that row and the
// title's baseline, with several playlists (the switch button) and with one
// (the plain title), and the count title draws the title's whole line, so no
// mark above or below it is cut.
for (const [language, fonts] of [
  ['ar', 'shipped fonts'],
  ['th', 'shipped fonts'],
  ['ko', 'taller font lines'],
] as const) {
  test.describe(`a taller title line (${language}, ${fonts})`, () => {
    test.use({ serviceWorkers: 'block', viewport: { width: 402, height: 874 } });

    test('entering delete mode keeps the title and the playlist in place', async ({ page }) => {
      test.setTimeout(90_000);
      const faces = fonts === 'taller font lines' ? await serveTallerFontLines(page) : null;
      await page.addInitScript((locale) => {
        localStorage.setItem('musixquare-lang', locale);
      }, language);
      await injectPeerServer(page);
      await setupHostAndStart(page);
      await waitForAppFonts(page);
      await uploadFixtures(page, ['test01', 'test02']);
      await waitForPlaylistCount(page, 2);
      await navigateToTab(page, 'playlist');
      await page.waitForTimeout(1500);
      if (faces) expect(faces()).toBeGreaterThan(0);

      const selectionTitle = page.locator('.playlist-selection-title:not(.playlist-header-fade *)');
      const slots = await page.evaluate(() =>
        (
          window as unknown as { __MUSIXQUARE_GET_STATE__: (path: string) => unknown }
        ).__MUSIXQUARE_GET_STATE__('playlist.slots'),
      );
      for (const [variant, slotState, title] of [
        ['several playlists', slots, '#playlist-switch-label .playlist-slot-name-base'],
        [
          'one playlist',
          null,
          '#tab-playlist > .tab-header > .tab-title[data-i18n="nav.playlist"]',
        ],
      ] as const) {
        await page.evaluate((value) => {
          (
            window as unknown as {
              __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
            }
          ).__MUSIXQUARE_SET_STATE__('playlist.slots', value);
        }, slotState);
        await expect(page.locator(title)).toBeVisible();
        const titleBefore = await titleBaseline(page.locator(title));
        const lineBefore = (await page.locator(title).boundingBox())!.height;
        const before = await playlistGeometry(page);
        // The row is taller than 36px, or this case proves nothing.
        expect(before.header, variant).toBeGreaterThan(80.5);

        await page.locator('.btn-playlist-select').first().click();
        await expect(selectionTitle).toBeVisible();
        const titleDuring = await titleBaseline(selectionTitle);
        const lineDuring = (await selectionTitle.boundingBox())!.height;
        const during = await playlistGeometry(page);
        await page.locator('[data-selection-action="cancel"]').click();
        await expect(selectionTitle).toBeHidden();
        const after = await playlistGeometry(page);

        expect(Math.abs(titleDuring - titleBefore), variant).toBeLessThan(0.5);
        expect(Math.abs(lineDuring - lineBefore), `${variant}: count title line`).toBeLessThan(0.5);
        for (const state of [during, after]) {
          expect(Math.abs(state.header - before.header), variant).toBeLessThan(0.5);
          expect(Math.abs(state.list - before.list), variant).toBeLessThan(0.5);
        }
      }
    });
  });
}
