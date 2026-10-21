import { expect, test, type Page } from '@playwright/test';
import { uploadFixtures } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToTab, waitForPlaylistCount } from './helpers/wait.ts';

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
