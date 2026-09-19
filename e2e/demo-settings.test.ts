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

for (const theme of ['dark', 'light'] as const) {
  test(`demo settings share device controls and remain usable on short screens (${theme})`, async ({
    page,
  }, testInfo) => {
    await injectPeerServer(page);
    await page.addInitScript((theme) => {
      localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
      localStorage.setItem('musixquare-theme', theme);
    }, theme);
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
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel.locator('.sync-nudge-row')).toBeHidden();
    await expect(page.locator('#btn-demo-previous')).toBeEnabled();
    await expect(page.locator('#btn-demo-next-track')).toBeEnabled();
    const controls = page.locator('.demo-settings-controls');
    const rowItems = [
      page.locator('#btn-demo-previous'),
      controls.locator('[data-demo-play]'),
      page.locator('#btn-demo-next-track'),
      page.locator('#demo-vol-icon-btn'),
      page.locator('#demo-volume-slider'),
    ];
    const rowBounds = await Promise.all(rowItems.map((item) => item.boundingBox()));
    const centers = rowBounds.map((bounds) => bounds!.y + bounds!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
    for (let i = 1; i < rowBounds.length; i += 1) {
      expect(rowBounds[i]!.x).toBeGreaterThanOrEqual(rowBounds[i - 1]!.x + rowBounds[i - 1]!.width);
    }
    await expect(controls).toHaveCSS('border-bottom-style', 'none');
    const pillBounds = (await controls.boundingBox())!;
    expect(rowBounds.at(-1)!.x + rowBounds.at(-1)!.width).toBeLessThan(
      pillBounds.x + pillBounds.width,
    );
    for (const button of await controls.locator('.demo-settings-transport > button').all()) {
      await expect(button).toHaveCSS('width', '48px');
      await expect(button).toHaveCSS('height', '56px');
    }
    for (const icon of [
      '#btn-demo-previous > svg',
      '[data-demo-play] > svg',
      '#btn-demo-next-track > svg',
    ]) {
      await expect(controls.locator(icon)).toHaveCSS('width', '24px');
      await expect(controls.locator(icon)).toHaveCSS('height', '24px');
    }
    const slider = page.locator('#demo-volume-slider');
    const wideRailWidth = (await slider.boundingBox())!.width;
    await slider.focus();
    await slider.press('Home');
    await slider.press('ArrowRight');
    await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0.01);
    const mute = page.locator('#demo-vol-icon-btn');
    const mainMute = page.locator('#vol-icon-btn');
    const mainSlider = page.locator('#volume-slider');
    await expect(mainSlider).toHaveValue('1');
    await mute.click();
    await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0);
    await expect(slider).toHaveValue('0');
    await expect(mainSlider).toHaveValue('0');
    for (const button of [mute, mainMute]) {
      await expect(button).toHaveClass(/is-muted/);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
    }
    await mute.click();
    await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0.01);
    await expect(slider).toHaveValue('1');
    await expect(mainSlider).toHaveValue('1');
    for (const button of [mute, mainMute]) {
      await expect(button).not.toHaveClass(/is-muted/);
      await expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    const editor = page.locator('#manual-sync-value');
    await expect(editor).toHaveAttribute('aria-label', 'Manual sync (ms)');
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
    await page.locator('html').evaluate((element) => element.setAttribute('dir', 'rtl'));
    await expect(slider).toHaveCSS('direction', 'rtl');
    await expect(slider).toHaveCSS('--range-track-direction', 'to left');
    await expect(mute.locator('.volume-icon')).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
    await expect(mainMute.locator('.volume-icon')).toHaveCSS(
      'transform',
      'matrix(-1, 0, 0, 1, 0, 0)',
    );
    await slider.focus();
    await slider.press('ArrowLeft');
    await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0.02);
    await expect(mainSlider).toHaveValue('2');
    await mute.click();
    await expect(mainMute).toHaveAttribute('aria-pressed', 'true');
    await expect(mute.locator('.volume-muted-mark')).toHaveCSS('opacity', '1');
    await expect(mute.locator('.volume-wave-inner')).toHaveCSS('opacity', '0');
    await page.screenshot({ path: testInfo.outputPath('demo-settings-rtl-muted.png') });
    await mute.click();
    await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0.02);
    await expect(mute.locator('.volume-wave-inner')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath('demo-settings-rtl.png') });
    await page.locator('html').evaluate((element) => element.setAttribute('dir', 'ltr'));
    await expect(slider).toHaveCSS('direction', 'ltr');
    await expect(mute.locator('.volume-icon')).toHaveCSS('transform', 'none');

    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.setViewportSize({ width: 320, height: 568 });
    const narrowSlider = await slider.boundingBox();
    const narrowPanel = await panel.boundingBox();
    expect(narrowSlider!.width).toBeGreaterThan(40);
    expect(narrowSlider!.width).toBeLessThan(wideRailWidth);
    expect(narrowSlider!.x + narrowSlider!.width).toBeLessThan(narrowPanel!.x + narrowPanel!.width);
    await page.screenshot({ path: testInfo.outputPath('demo-settings-narrow.png') });

    await page.locator('#btn-demo-next-track').click();
    await expect.poll(() => readState(page, 'demo.currentTrackIndex')).toBe(1);
    await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
    await page.locator('#btn-demo-previous').click();
    await expect.poll(() => readState(page, 'demo.currentTrackIndex')).toBe(0);
    await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
    await page.locator('#btn-demo-next-track').click();
    await expect.poll(() => readState(page, 'demo.currentTrackIndex')).toBe(1);
    await page.locator('#btn-sync-done').click();
    await emit(page, 'demo:request-exit');
    await expect.poll(() => readState(page, 'demo.active')).toBe(false);
    expect(await readState(page, 'sync.localOffset')).toBe(-0.321);
    await emit(page, 'demo:enter');
    await page.locator('#btn-demo-settings').click();
    await expect(editor).toHaveText('-321');
    await page.setViewportSize({ width: 844, height: 300 });
    const scrollBody = panel.locator('.sync-scroll-body');
    await expect
      .poll(() => scrollBody.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await expect(panel).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(300);
    await expect(scrollBody).toHaveClass(/has-scroll-overflow/);
    const footer = panel.locator('.sync-bottom-row');
    const footerBeforeScroll = await footer.boundingBox();
    await scrollBody.hover();
    await page.mouse.wheel(0, 220);
    await expect.poll(() => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await footer.boundingBox())!.y).toBe(footerBeforeScroll!.y);
    const scrollbar = panel.locator('.sync-scroll-frame > .cscroll-track-contained');
    await expect(scrollbar).toHaveCSS('opacity', '1');
    const scrollBounds = await scrollbar.boundingBox();
    expect(scrollBounds!.x + scrollBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    expect(scrollBounds!.x).toBeGreaterThan(bounds!.x + bounds!.width - 32);
    expect(scrollBounds!.y).toBeGreaterThanOrEqual(bounds!.y + 16);
    expect(scrollBounds!.y + scrollBounds!.height).toBeLessThanOrEqual(footerBeforeScroll!.y);
    await page.screenshot({ path: testInfo.outputPath('demo-settings-landscape.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(scrollBody).not.toHaveClass(/has-scroll-overflow/);
    await expect(scrollbar).toHaveCSS('opacity', '0');
    await page.locator('#btn-sync-done').click();
    await expect(page.locator('#manual-sync-overlay')).toHaveAttribute('aria-hidden', 'true');
  });
}
