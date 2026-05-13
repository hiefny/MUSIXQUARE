import { expect, test, type Page } from '@playwright/test';
import { setupHostAndStart } from './helpers/setup-flow.ts';

const DEMO_URL_PATTERN = 'https://demo.musixquare.com/linelight/*.m4a';
const INFO_URL = 'https://batzerk.bandcamp.com/album/linelight-ost';
const INFO_ICON_PATH =
  'M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h5V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-5h-2v5z';
const EXIT_ICON_PATH =
  'M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z';

async function mockDemoTrack(page: Page): Promise<void> {
  await page.route(DEMO_URL_PATTERN, (route) =>
    route.fulfill({
      path: 'public/demo_track.mp3',
      contentType: 'audio/mpeg',
      headers: {
        'cache-control': 'public, max-age=31536000, immutable',
      },
    }),
  );
}

test.describe('Linelight demo mode', () => {
  test('first-run prompt does not block the setup screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('#btn-setup-host').waitFor({ state: 'visible', timeout: 15_000 });

    await page.waitForTimeout(1300);
    await expect(page.locator('#setup-overlay.active')).toHaveCount(1);
    await expect(page.locator('#dialog-overlay.show')).toHaveCount(0);
  });

  test('first visit accept enters mobile demo overlay after host setup', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockDemoTrack(page);
    await setupHostAndStart(page);

    await page.locator('#dialog-overlay.show').waitFor({ timeout: 10_000 });
    await page.locator('#btn-dialog-ok').click();

    await expect(page.locator('#demo-overlay')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('body')).toHaveClass(/viz-spectrum/);
    await expect(page.locator('.demo-track-title')).toContainText('Linelight OST - 01 Adventure');
    await expect(page.locator('.demo-track-artist')).toContainText('Brett Taylor');
    await expect(page.locator('.demo-visual-stage .demo-track-header')).toBeVisible();
    await expect(page.locator('.demo-visual-stage')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    const playButtonThemeStyles = await page.evaluate(() => {
      const button = getComputedStyle(document.querySelector('.demo-play-button')!);
      const probe = document.createElement('span');
      document.body.append(probe);
      probe.style.color = 'var(--text-main)';
      const textMain = getComputedStyle(probe).color;
      probe.style.color = 'var(--bg)';
      const bg = getComputedStyle(probe).color;
      probe.remove();
      return {
        background: button.backgroundColor,
        color: button.color,
        textMain,
        bg,
      };
    });
    expect(playButtonThemeStyles.background).toBe(playButtonThemeStyles.textMain);
    expect(playButtonThemeStyles.color).toBe(playButtonThemeStyles.bg);
    expect(playButtonThemeStyles.background).not.toBe('rgb(0, 122, 255)');
    await expect(page.locator('#demo-mini-seek')).toHaveCount(0);
    await expect(page.locator('[data-demo-panel="1"]')).toHaveClass(/active/);
    await expect(page.locator('#demo-session-qr svg')).toBeVisible();
    const qrSize = await page.locator('#demo-session-qr').boundingBox();
    expect(qrSize?.width).toBeGreaterThanOrEqual(164);
    await page.locator('[data-demo-step="2"]').click();
    await expect(page.locator('[data-demo-panel="2"]')).toHaveClass(/active/);
    await expect(page.locator('[data-role-diagram="demo"]')).toBeVisible();
    await expect(page.locator('[data-demo-role="-1"]')).toBeVisible();
    await page.locator('[data-demo-step="3"]').click();
    await expect(page.locator('.demo-support-copy')).toBeVisible();
    await expect(page.locator('[data-demo-effect="bass"]')).toBeVisible();
    const effectLayout = await page.evaluate(() => {
      const button = document.querySelector('[data-demo-effect="bass"]')!;
      const styles = getComputedStyle(button);
      const copy = document.querySelector('.demo-support-copy')!.getBoundingClientRect();
      const actions = document
        .querySelector('[data-demo-panel="3"] .demo-large-actions')!
        .getBoundingClientRect();
      return {
        flexDirection: styles.flexDirection,
        height: button.getBoundingClientRect().height,
        copyBelowButtons: copy.top >= actions.bottom,
      };
    });
    expect(effectLayout.flexDirection).toBe('column');
    expect(effectLayout.height).toBeGreaterThanOrEqual(100);
    expect(effectLayout.copyBelowButtons).toBe(true);
    await page.locator('[data-demo-step="4"]').click();
    await expect(page.locator('.demo-track-row')).toHaveCount(4);
    await expect(page.locator('[data-demo-track-index="0"]')).toHaveClass(/active/);
    await expect(page.locator('.demo-track-notice')).toBeVisible();
    await expect(page.locator('[data-demo-info] svg')).toBeVisible();
    await expect(page.locator('[data-demo-exit] svg')).toBeVisible();

    await page.setViewportSize({ width: 640, height: 390 });
    const narrowLandscape = await page.evaluate(() => {
      const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
      const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
      return {
        visualBottom: visual.bottom,
        controlsTop: controls.top,
      };
    });
    expect(narrowLandscape.controlsTop).toBeGreaterThanOrEqual(narrowLandscape.visualBottom - 1);

    await page.setViewportSize({ width: 740, height: 390 });
    const compactDashboard = await page.evaluate(() => {
      const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
      const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
      const nav = document.querySelector('.demo-step-nav')!.getBoundingClientRect();
      const spectrum = document
        .querySelector('#demo-visualizer-slot .vinyl-wrapper')!
        .getBoundingClientRect();
      return {
        visualTop: visual.top,
        visualRight: visual.right,
        visualBottom: visual.bottom,
        visualCenter: visual.top + visual.height / 2,
        controlsTop: controls.top,
        controlsLeft: controls.left,
        navTop: nav.top,
        navRight: nav.right,
        navButtonSize: document.querySelector('[data-demo-step="1"]')!.getBoundingClientRect()
          .width,
        spectrumCenter: spectrum.top + spectrum.height / 2,
      };
    });
    expect(compactDashboard.controlsLeft).toBeGreaterThanOrEqual(compactDashboard.visualRight - 1);
    expect(compactDashboard.controlsTop).toBeGreaterThanOrEqual(compactDashboard.visualTop - 1);
    expect(compactDashboard.navTop).toBeGreaterThanOrEqual(compactDashboard.visualBottom - 1);
    expect(compactDashboard.navRight).toBeLessThanOrEqual(compactDashboard.visualRight + 1);
    expect(compactDashboard.navButtonSize).toBeGreaterThanOrEqual(54);
    expect(Math.abs(compactDashboard.spectrumCenter - compactDashboard.visualCenter)).toBeLessThan(
      2,
    );

    await page.setViewportSize({ width: 1024, height: 768 });
    const roomyLandscape = await page.evaluate(() => {
      const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
      const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
      const navButton = document.querySelector('[data-demo-step="1"]')!.getBoundingClientRect();
      const spectrum = document
        .querySelector('#demo-visualizer-slot .vinyl-wrapper')!
        .getBoundingClientRect();
      return {
        controlsCenter: controls.top + controls.height / 2,
        spectrumCenter: spectrum.top + spectrum.height / 2,
        spectrumHeight: spectrum.height,
        visualCenter: visual.top + visual.height / 2,
        spectrumBottomGap: visual.bottom - spectrum.bottom,
        navButtonSize: navButton.width,
        viewportCenter: window.innerHeight / 2,
      };
    });
    expect(Math.abs(roomyLandscape.controlsCenter - roomyLandscape.viewportCenter)).toBeLessThan(
      24,
    );
    expect(Math.abs(roomyLandscape.spectrumCenter - roomyLandscape.visualCenter)).toBeLessThan(2);
    expect(roomyLandscape.spectrumBottomGap).toBeGreaterThan(24);
    expect(roomyLandscape.spectrumHeight).toBeGreaterThan(400);
    expect(roomyLandscape.navButtonSize).toBeGreaterThanOrEqual(60);
  });

  test('first visit decline stores prompt choice after host setup', async ({ page }) => {
    await setupHostAndStart(page);

    await page.locator('#dialog-overlay.show').waitFor({ timeout: 10_000 });
    await page.locator('#btn-dialog-secondary').click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('musixquare-demo-prompt-seen-v1')))
      .toBe('1');

    await setupHostAndStart(page);
    await page.waitForTimeout(1300);
    await expect(page.locator('#dialog-overlay.show')).toHaveCount(0);
  });

  test('desktop demo uses the same guided landscape overlay after host setup', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockDemoTrack(page);
    await setupHostAndStart(page);

    await page.locator('#dialog-overlay.show').waitFor({ timeout: 10_000 });
    await page.locator('#btn-dialog-ok').click();
    await expect(page.locator('body')).toHaveClass(/mode-demo/, { timeout: 15_000 });
    await expect(page.locator('#demo-overlay')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('[data-demo-panel="1"]')).toHaveClass(/active/);

    const desktopLayout = await page.evaluate(() => {
      const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
      const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
      const nav = document.querySelector('.demo-step-nav')!.getBoundingClientRect();
      const spectrum = document
        .querySelector('#demo-visualizer-slot .vinyl-wrapper')!
        .getBoundingClientRect();
      return {
        visualRight: visual.right,
        visualBottom: visual.bottom,
        visualCenter: visual.top + visual.height / 2,
        controlsLeft: controls.left,
        navLeft: nav.left,
        navTop: nav.top,
        navRight: nav.right,
        navButtonSize: document.querySelector('[data-demo-step="1"]')!.getBoundingClientRect()
          .width,
        qrSize: document.querySelector('#demo-session-qr')!.getBoundingClientRect().width,
        navBottomGap: window.innerHeight - nav.bottom,
        spectrumCenter: spectrum.top + spectrum.height / 2,
        spectrumHeight: spectrum.height,
        spectrumBottomGap: visual.bottom - spectrum.bottom,
      };
    });
    expect(desktopLayout.controlsLeft).toBeGreaterThanOrEqual(desktopLayout.visualRight - 1);
    expect(desktopLayout.navTop).toBeGreaterThanOrEqual(desktopLayout.visualBottom - 1);
    expect(desktopLayout.navRight).toBeLessThanOrEqual(desktopLayout.visualRight + 1);
    expect(desktopLayout.navBottomGap).toBeGreaterThan(10);
    expect(Math.abs(desktopLayout.spectrumCenter - desktopLayout.visualCenter)).toBeLessThan(2);
    expect(desktopLayout.spectrumBottomGap).toBeGreaterThan(80);
    expect(desktopLayout.spectrumHeight).toBeGreaterThan(500);
    expect(desktopLayout.navButtonSize).toBeGreaterThanOrEqual(64);
    expect(desktopLayout.qrSize).toBeGreaterThanOrEqual(260);

    await page.locator('[data-demo-step="3"]').click();
    const desktopEffectSize = await page
      .locator('[data-demo-effect="bass"]')
      .evaluate((button) => button.getBoundingClientRect().height);
    expect(desktopEffectSize).toBeGreaterThanOrEqual(140);

    await page.locator('[data-demo-step="4"]').click();
    await expect(page.locator('[data-demo-info] svg path')).toHaveAttribute('d', INFO_ICON_PATH);
    await expect(page.locator('[data-demo-exit] svg path')).toHaveAttribute('d', EXIT_ICON_PATH);

    const popupPromise = page.waitForEvent('popup');
    await page.locator('[data-demo-info]').click();
    const popup = await popupPromise;
    await expect.poll(() => popup.url()).toBe(INFO_URL);

    await page.locator('[data-demo-exit]').click();
    await expect(page.locator('body')).not.toHaveClass(/mode-demo/);
  });
});
