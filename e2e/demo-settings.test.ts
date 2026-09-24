import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToSubtab, navigateToTab, readState } from './helpers/wait.ts';

async function emit(page: Page, event: string): Promise<void> {
  await page.evaluate((name) => {
    (
      window as unknown as { __MUSIXQUARE_BUS__: { emit(event: string): void } }
    ).__MUSIXQUARE_BUS__.emit(name);
  }, event);
}

async function expectDemoHidden(page: Page): Promise<void> {
  await expect(page.locator('#demo-overlay')).not.toHaveClass(/active/);
  // visibility:hidden on the overlay alone is insufficient: a descendant
  // declaring visibility:visible can still paint over the ordinary app.
  for (const selector of [
    '.demo-track-copy',
    '.demo-track-title',
    '.demo-track-artist',
    '.demo-controls-pill',
    '#btn-demo-settings',
    '#demo-inline-controls',
    '[data-demo-play]',
    '#btn-demo-next-track',
    '#demo-vol-icon-btn',
    '#demo-volume-slider',
    '#btn-demo-sync',
  ]) {
    await expect(page.locator(selector)).toBeHidden();
  }
}

async function enterDemo(page: Page, theme: 'dark' | 'light' = 'dark'): Promise<void> {
  await injectPeerServer(page);
  await page.addInitScript((value) => {
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-theme', value);
  }, theme);
  await page.route('https://demo.musixquare.com/linelight/*.m4a', (route) =>
    route.fulfill({
      path: fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url)),
      contentType: 'audio/mpeg',
    }),
  );
  await setupHostAndStart(page);
  await expectDemoHidden(page);
  await emit(page, 'demo:enter');
  await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
  await expect(page.locator('.demo-track-title')).toBeVisible();
  await expect(page.locator('.demo-track-artist')).toBeVisible();
  await expect(page.locator('#demo-inline-controls')).toBeHidden();
}

async function expectExpanded(page: Page, expanded: boolean): Promise<void> {
  await expect(page.locator('#btn-demo-settings')).toHaveAttribute(
    'aria-expanded',
    String(expanded),
  );
  await expect(page.locator('#demo-inline-controls')).toHaveJSProperty('inert', !expanded);
  await expect(page.locator('#demo-inline-controls')).toHaveAttribute(
    'aria-hidden',
    String(!expanded),
  );
}

for (const theme of ['dark', 'light'] as const) {
  test(`demo inline controls share device state and open the complete sync panel (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await enterDemo(page, theme);
    const toggle = page.locator('#btn-demo-settings');
    const controls = page.locator('#demo-inline-controls');
    const overlay = page.locator('#manual-sync-overlay');
    const panel = overlay.locator('.sync-glass-panel');
    const slider = page.locator('#demo-volume-slider');
    const mute = page.locator('#demo-vol-icon-btn');
    const mainMute = page.locator('#vol-icon-btn');
    const mainSlider = page.locator('#volume-slider');
    const sync = page.locator('#btn-demo-sync');

    await expectExpanded(page, false);
    await toggle.click();
    await expectExpanded(page, true);
    await expect(page.locator('.demo-track-title')).toBeHidden();
    await expect(page.locator('.demo-track-artist')).toBeHidden();
    await expect(page.locator('.demo-track-header')).toHaveClass(/demo-controls-expanded/);
    await expect(overlay).not.toHaveClass(/show/);
    await expect(controls.locator('[data-demo-play]')).toBeEnabled();
    await expect(page.locator('#btn-demo-next-track')).toBeEnabled();
    await expect(page.locator('#btn-demo-previous')).toHaveCount(0);
    const rowItems = [
      toggle,
      controls.locator('[data-demo-play]'),
      page.locator('#btn-demo-next-track'),
      mute,
      slider,
      sync,
    ];
    await expect(slider).toHaveCSS('width', '74px');
    const rowBounds = await Promise.all(rowItems.map((item) => item.boundingBox()));
    const centers = rowBounds.map((bounds) => bounds!.y + bounds!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
    for (let i = 1; i < rowBounds.length; i += 1) {
      expect(rowBounds[i]!.x).toBeGreaterThanOrEqual(
        rowBounds[i - 1]!.x + rowBounds[i - 1]!.width - 1,
      );
    }
    expect(rowBounds.at(-1)!.x + rowBounds.at(-1)!.width - rowBounds[0]!.x).toBeLessThanOrEqual(
      305,
    );
    await page.screenshot({ path: testInfo.outputPath('demo-inline-portrait.png') });

    await controls.locator('[data-demo-play]').click();
    await expect.poll(() => readState(page, 'playback.activity')).toBe('paused');
    await controls.locator('[data-demo-play]').click();
    await expect.poll(() => readState(page, 'playback.activity')).toBe('playing');
    await slider.focus();
    await slider.press('Home');
    await slider.press('ArrowRight');
    await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0.01);
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
    await expectExpanded(page, true);

    await page.locator('html').evaluate((element) => element.setAttribute('dir', 'rtl'));
    await expect(slider).toHaveCSS('direction', 'rtl');
    await expect(slider).toHaveCSS('--range-track-direction', 'to left');
    for (const button of [mute, mainMute]) {
      await expect(button.locator('.volume-icon')).toHaveCSS(
        'transform',
        'matrix(-1, 0, 0, 1, 0, 0)',
      );
    }
    await slider.focus();
    await slider.press('ArrowLeft');
    await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0.02);
    await expect(mainSlider).toHaveValue('2');
    await mute.click();
    await expect(mainMute).toHaveAttribute('aria-pressed', 'true');
    await expect(mute.locator('.volume-muted-mark')).toHaveCSS('opacity', '1');
    await expect(mute.locator('.volume-wave-inner')).toHaveCSS('opacity', '0');
    await page.screenshot({ path: testInfo.outputPath('demo-inline-rtl-muted.png') });
    await mute.click();
    await expect.poll(() => readState(page, 'audio.masterVolume')).toBe(0.02);
    await page.locator('html').evaluate((element) => element.setAttribute('dir', 'ltr'));
    await expect(mute.locator('.volume-icon')).toHaveCSS('transform', 'none');

    await sync.click();
    await expect(overlay).toHaveClass(/demo-settings-open/);
    await expect(panel).toHaveAttribute('aria-label', 'Sync');
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel.locator('[data-demo-play]')).toHaveCount(0);
    await expect(panel.locator('.sync-nudge-row')).toBeVisible();
    for (const id of ['minus10', 'minus1', 'plus1', 'plus10']) {
      await expect(page.locator(`#btn-nudge-${id}`)).toBeVisible();
    }
    const editor = page.locator('#manual-sync-value');
    await expect(editor).toHaveAttribute('aria-label', 'Manual sync (ms)');
    await editor.fill('-321');
    await editor.press('Enter');
    await expect.poll(() => readState(page, 'sync.localOffset')).toBe(-0.321);
    await page.locator('#btn-nudge-plus10').click();
    await expect.poll(() => readState(page, 'sync.localOffset')).toBeCloseTo(-0.311, 4);
    await page.locator('#btn-nudge-minus10').click();
    await expect.poll(() => readState(page, 'sync.localOffset')).toBeCloseTo(-0.321, 4);
    await page.screenshot({ path: testInfo.outputPath('demo-inline-sync.png') });
    await page.locator('#btn-sync-done').click();
    await expect(overlay).not.toHaveClass(/show/);
    await expect(overlay).toBeHidden();
    await expectExpanded(page, true);
    await expect(sync).toBeFocused();

    await page.setViewportSize({ width: 320, height: 568 });
    await expect
      .poll(async () => {
        const bounds = (await controls.boundingBox())!;
        return bounds.x + bounds.width;
      })
      .toBeLessThanOrEqual(320);
    const narrowBounds = await controls.boundingBox();
    const narrowRail = await slider.boundingBox();
    expect(narrowRail!.width).toBeGreaterThanOrEqual(24);
    expect(narrowRail!.width).toBeLessThanOrEqual(74);
    expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(320);
    await page.screenshot({ path: testInfo.outputPath('demo-inline-narrow.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(slider).toHaveCSS('width', '74px');
    const desktopFirst = (await toggle.boundingBox())!;
    const desktopLast = (await sync.boundingBox())!;
    expect(desktopLast.x + desktopLast.width - desktopFirst.x).toBeLessThanOrEqual(305);
    await page.screenshot({ path: testInfo.outputPath('demo-inline-desktop.png') });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    await page.locator('#btn-demo-next-track').click();
    await expect.poll(() => readState(page, 'demo.currentTrackIndex')).toBe(1);
    await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
    await expectExpanded(page, true);
    await toggle.click();
    await expectExpanded(page, false);
    await expect(page.locator('.demo-track-title')).toBeVisible();
    await expect(page.locator('.demo-track-artist')).toBeVisible();
    await expect(controls).toBeHidden();
    await toggle.click();
    await expectExpanded(page, true);
    await page.keyboard.press('Escape');
    await expectExpanded(page, false);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.locator('[data-demo-step="2"]').click();
    await expectExpanded(page, false);

    await toggle.click();
    await sync.click();
    await page.setViewportSize({ width: 844, height: 240 });
    const scrollBody = panel.locator('.sync-scroll-body');
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    await expect
      .poll(() => scrollBody.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const bounds = (await panel.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(240);
    await expect(scrollBody).toHaveClass(/has-scroll-overflow/);
    const footer = panel.locator('.sync-bottom-row');
    const footerBeforeScroll = (await footer.boundingBox())!;
    await scrollBody.hover();
    await page.mouse.wheel(0, 220);
    await expect.poll(() => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await footer.boundingBox())!.y).toBe(footerBeforeScroll.y);
    await page.screenshot({ path: testInfo.outputPath('demo-inline-sync-landscape.png') });
    await page.locator('#btn-sync-done').click();
    await expectExpanded(page, true);
    await emit(page, 'demo:request-exit');
    await expect.poll(() => readState(page, 'demo.active')).toBe(false);
    await expectExpanded(page, false);
    await expectDemoHidden(page);
    expect(await readState(page, 'sync.localOffset')).toBeCloseTo(-0.321, 4);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectDemoHidden(page);
    await emit(page, 'demo:enter');
    await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
    await expectExpanded(page, false);
    await expect(page.locator('.demo-track-title')).toBeVisible();
    await expect(page.locator('.demo-track-artist')).toBeVisible();
    await toggle.click();
    await sync.click();
    await expect(editor).toHaveText('-321');
    await page.locator('#btn-auto-sync').click();
    await expect.poll(() => readState(page, 'sync.localOffset')).toBe(0);
    await page.locator('#btn-sync-done').click();
  });
}

test('demo virtual effects stay reflected in settings after enabling and disabling them', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterDemo(page);

  for (const enabled of [true, false]) {
    await test.step(`${enabled ? 'enable' : 'disable'} effects in demo and retain their settings`, async () => {
      if (!enabled) {
        await emit(page, 'demo:enter');
        await expect.poll(() => readState(page, 'demo.active')).toBe(true);
        await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
        await expect(page.locator('.demo-track-title')).toBeVisible();
      }
      await page.locator('[data-demo-step="3"]').click();
      for (const effect of ['bass', 'treble', 'surround']) {
        const button = page.locator(`[data-demo-effect="${effect}"]`);
        await expect(button).toHaveAttribute('aria-pressed', String(!enabled));
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', String(enabled));
      }

      await page.locator('[data-demo-next]').click();
      await page.locator('[data-demo-exit]').click();
      await expect.poll(() => readState(page, 'demo.active')).toBe(false);
      await expectDemoHidden(page);
      await navigateToTab(page, 'settings');
      await navigateToSubtab(page, 'audio');

      // Normal demo completion deliberately retains the chosen audio effects.
      // Assert both the retained state and the visible controls: state alone
      // misses a stale Off chip even while the effects remain audible.
      await expect.poll(() => readState(page, 'audio.virtualBass')).toBe(enabled ? 0.6 : 0);
      await expect.poll(() => readState(page, 'audio.exciter')).toBe(enabled);
      await expect.poll(() => readState(page, 'audio.stereoWidth')).toBe(enabled ? 1.2 : 1);
      for (const effect of ['bass', 'treble', 'surround', 'off']) {
        const selected = effect === 'off' ? !enabled : enabled;
        const chip = page.locator(`#grid-virtual-effects [data-virtual-effect="${effect}"]`);
        await expect(chip).toBeVisible();
        await expect(chip).toHaveAttribute('aria-pressed', String(selected));
        if (selected) await expect(chip).toHaveClass(/active/);
        else await expect(chip).not.toHaveClass(/active/);
      }
    });
  }
});

test('demo inline controls remain keyboard accessible with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await enterDemo(page);
  const toggle = page.locator('#btn-demo-settings');
  const controls = page.locator('#demo-inline-controls');
  await toggle.focus();
  await toggle.press('Enter');
  await expectExpanded(page, true);
  await expect(controls.locator('[data-demo-play]')).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(controls.locator('[data-demo-play]')).toBeFocused();
  const animatedDurations = await controls.evaluate((element) =>
    [element, element.parentElement!].flatMap((item) =>
      getComputedStyle(item)
        .transitionDuration.split(',')
        .map((value) => Number.parseFloat(value)),
    ),
  );
  expect(Math.max(...animatedDurations)).toBeLessThanOrEqual(0.01);
  await page.keyboard.press('Escape');
  await expectExpanded(page, false);
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(controls.locator('[data-demo-play]')).not.toBeFocused();
});
