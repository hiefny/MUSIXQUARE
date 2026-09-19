import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { readState } from './helpers/wait.ts';

async function emit(page: Page, event: string): Promise<void> {
  await page.evaluate((name) => {
    (
      window as unknown as { __MUSIXQUARE_BUS__: { emit(event: string): void } }
    ).__MUSIXQUARE_BUS__.emit(name);
  }, event);
}

test('demo settings share device controls and remain usable on short screens', async ({
  page,
}, testInfo) => {
  await injectPeerServer(page);
  await page.addInitScript(() => localStorage.setItem('musixquare-demo-prompt-seen-v1', '1'));
  await page.route('https://demo.musixquare.com/linelight/*.m4a', (route) =>
    route.fulfill({
      path: fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url)),
      contentType: 'audio/mpeg',
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await setupHostAndStart(page);
  await emit(page, 'demo:enter');
  await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
  await page.locator('#btn-demo-settings').click();
  const panel = page.locator('#manual-sync-overlay .sync-glass-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-label', 'Settings');
  await expect(page.locator('#btn-demo-previous')).toBeEnabled();
  await expect(page.locator('#btn-demo-next-track')).toBeEnabled();
  const slider = page.locator('#demo-volume-slider');
  await slider.focus();
  await slider.press('Home');
  await slider.press('ArrowRight');
  await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0.01);
  const editor = page.locator('#manual-sync-value');
  await editor.fill('-321');
  await editor.press('Enter');
  await expect.poll(() => readState(page, 'sync.localOffset')).toBe(-0.321);
  await expect(page.locator('#manual-sync-overlay')).toHaveCSS('opacity', '1');
  await expect(panel).toHaveCSS('opacity', '1');
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.x + 20, bounds.y + 20));
      }),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('demo-settings-portrait.png') });

  await page.locator('#btn-demo-next-track').click();
  await expect.poll(() => readState(page, 'demo.currentTrackIndex')).toBe(1);
  await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
  await page.locator('#btn-demo-previous').click();
  await expect.poll(() => readState(page, 'demo.currentTrackIndex')).toBe(0);
  await page.locator('#btn-sync-done').click();
  await emit(page, 'demo:request-exit');
  await expect.poll(() => readState(page, 'demo.active')).toBe(false);
  expect(await readState(page, 'sync.localOffset')).toBe(-0.321);
  await emit(page, 'demo:enter');
  await page.locator('#btn-demo-settings').click();
  await expect(editor).toHaveText('-321');
  await page.setViewportSize({ width: 844, height: 300 });
  await expect
    .poll(() => panel.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(300);
  await panel.hover();
  await page.mouse.wheel(0, 220);
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const scrollbar = page.locator('#manual-sync-overlay > .cscroll-track-contained');
  await expect(scrollbar).toHaveCSS('opacity', '1');
  const scrollBounds = await scrollbar.boundingBox();
  expect(scrollBounds!.x + scrollBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  expect(scrollBounds!.x).toBeGreaterThan(bounds!.x + bounds!.width - 24);
  await page.screenshot({ path: testInfo.outputPath('demo-settings-landscape.png') });
  await page.locator('#btn-sync-done').click();
  await expect(page.locator('#manual-sync-overlay')).toHaveAttribute('aria-hidden', 'true');
});
