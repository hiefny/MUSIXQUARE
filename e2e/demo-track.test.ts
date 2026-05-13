import { expect, test, type Page } from '@playwright/test';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { readState, waitForToast } from './helpers/wait.ts';

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
    await expect(page.locator('#dialog-overlay.show')).toContainText('Try MUSIXQUARE');
    await expect(page.locator('#dialog-overlay.show')).toContainText(
      "Looks like you're new here. Want to try the basics?",
    );
    await expect(page.locator('#btn-dialog-ok')).toHaveText('Start');
    await page.locator('#btn-dialog-ok').click();

    await expect(page.locator('#demo-overlay')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('#demo-overlay')).toHaveCSS('opacity', '1');
    await expect(page.locator('.bottom-nav')).toHaveCSS('opacity', '0');
    await expect(page.locator('body')).toHaveClass(/viz-spectrum/);
    await expect(page.locator('.demo-track-title')).toContainText('Linelight OST - Adventure');
    await expect(page.locator('.demo-track-artist')).toContainText('Brett Taylor');
    await expect(page.locator('.demo-visual-stage .demo-track-header')).toBeVisible();
    await expect(page.locator('.demo-visual-stage')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    const portraitPanelTheme = await page.evaluate(() => {
      const shell = document.querySelector('.demo-mobile-shell')!;
      const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
      const probe = document.createElement('span');
      document.body.append(probe);
      probe.style.color = 'var(--surface-1)';
      const surface1 = getComputedStyle(probe).color;
      probe.remove();
      const pseudo = getComputedStyle(shell, '::before');
      const panelTop = Number.parseFloat(pseudo.top);
      return {
        panelBackground: pseudo.backgroundColor,
        panelTop,
        surface1,
        controlsTop: controls.top,
      };
    });
    expect(portraitPanelTheme.panelBackground).toBe(portraitPanelTheme.surface1);
    expect(portraitPanelTheme.panelTop).toBeGreaterThan(0);
    expect(portraitPanelTheme.panelTop).toBeLessThanOrEqual(portraitPanelTheme.controlsTop);
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
    await expect(page.locator('[data-demo-step="1"]')).toContainText('1. Connect devices');
    await expect(page.locator('[data-demo-step="4"]')).toHaveCount(0);
    await expect(page.locator('[data-demo-next] svg')).toBeVisible();
    const portraitNavLayout = await page.evaluate(() => {
      const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
      const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
      const nav = document.querySelector('.demo-step-nav')!.getBoundingClientRect();
      const activeButton = document
        .querySelector('.demo-step-nav button.active')!
        .getBoundingClientRect();
      const inactiveButton = document
        .querySelector('[data-demo-step="2"]')!
        .getBoundingClientRect();
      const bottomNavStyles = getComputedStyle(document.querySelector('.bottom-nav')!);
      return {
        visualTop: visual.top,
        visualBottom: visual.bottom,
        controlsTop: controls.top,
        navTop: nav.top,
        navBottom: nav.bottom,
        activeButtonWidth: activeButton.width,
        inactiveButtonWidth: inactiveButton.width,
        buttonHeight: inactiveButton.height,
        bottomNavOpacity: bottomNavStyles.opacity,
        bottomNavPointerEvents: bottomNavStyles.pointerEvents,
        viewportHeight: window.innerHeight,
      };
    });
    expect(portraitNavLayout.controlsTop).toBeGreaterThanOrEqual(
      portraitNavLayout.visualBottom - 1,
    );
    expect(portraitNavLayout.navTop).toBeGreaterThan(portraitNavLayout.controlsTop);
    expect(portraitNavLayout.navBottom).toBeLessThanOrEqual(portraitNavLayout.viewportHeight);
    expect(portraitNavLayout.buttonHeight).toBeGreaterThanOrEqual(46);
    expect(portraitNavLayout.activeButtonWidth).toBeGreaterThan(
      portraitNavLayout.inactiveButtonWidth * 2,
    );
    expect(portraitNavLayout.bottomNavOpacity).toBe('0');
    expect(portraitNavLayout.bottomNavPointerEvents).toBe('none');
    await expect(page.locator('[data-demo-panel="1"]')).toHaveClass(/active/);
    await expect(page.locator('#demo-session-qr svg')).toBeVisible();
    const qrSize = await page.locator('#demo-session-qr').boundingBox();
    expect(qrSize?.width).toBeGreaterThanOrEqual(164);
    await page.locator('[data-demo-step="2"]').click();
    await expect(page.locator('[data-demo-panel="2"]')).toHaveClass(/active/);
    await expect(page.locator('[data-role-diagram="demo"]')).toBeVisible();
    await expect(page.locator('[data-demo-role="-1"]')).toBeVisible();
    await page.locator('[data-demo-step="3"]').click();
    await expect(page.locator('.demo-support-copy')).toHaveCount(0);
    await expect(page.locator('[data-demo-effect="bass"]')).toBeVisible();
    await expect(page.locator('[data-demo-effect="bass"]')).toContainText('Bass Boost On/Off');
    await expect(page.locator('[data-demo-effect="treble"]')).toContainText('Treble Boost On/Off');
    await expect(page.locator('[data-demo-effect="reverb"]')).toContainText('Reverb On/Off');
    await expect(page.locator('[data-demo-effect="surround"]')).toContainText('Surround On/Off');
    const effectLayout = await page.evaluate(() => {
      const bass = document.querySelector('[data-demo-effect="bass"]')!;
      const treble = document.querySelector('[data-demo-effect="treble"]')!;
      const reverb = document.querySelector('[data-demo-effect="reverb"]')!;
      const actions = document
        .querySelector('[data-demo-panel="3"] .demo-large-actions')!
        .getBoundingClientRect();
      const styles = getComputedStyle(bass);
      const actionStyles = getComputedStyle(
        document.querySelector('[data-demo-panel="3"] .demo-large-actions')!,
      );
      const bassRect = bass.getBoundingClientRect();
      const trebleRect = treble.getBoundingClientRect();
      const reverbRect = reverb.getBoundingClientRect();
      return {
        buttonCount: document.querySelectorAll('[data-demo-effect]').length,
        columns: actionStyles.gridTemplateColumns.split(' ').filter(Boolean).length,
        flexDirection: styles.flexDirection,
        height: bassRect.height,
        sameFirstRow: Math.abs(bassRect.top - trebleRect.top) < 2,
        secondRowBelow: reverbRect.top >= bassRect.bottom,
        actionsHeight: actions.height,
      };
    });
    expect(effectLayout.buttonCount).toBe(4);
    expect(effectLayout.columns).toBe(2);
    expect(effectLayout.flexDirection).toBe('column');
    expect(effectLayout.height).toBeGreaterThanOrEqual(82);
    expect(effectLayout.height).toBeLessThanOrEqual(120);
    expect(effectLayout.sameFirstRow).toBe(true);
    expect(effectLayout.secondRowBelow).toBe(true);
    expect(effectLayout.actionsHeight).toBeLessThanOrEqual(250);
    await page.locator('[data-demo-next]').click();
    await expect(page.locator('.demo-track-row')).toHaveCount(4);
    await expect(page.locator('[data-demo-next]')).toHaveClass(/is-final/);
    await expect(page.locator('[data-demo-next] svg')).toBeHidden();
    await expect(page.locator('[data-demo-next]')).toContainText('4. Quit demo');
    await expect(page.locator('[data-demo-track-index="0"]')).toHaveClass(/active/);
    await expect(page.locator('[data-demo-track-index="0"] strong')).toHaveText(
      'Linelight OST - Adventure',
    );
    await expect(page.locator('[data-demo-track-index="3"] strong')).toHaveText(
      'Linelight OST - Spring',
    );
    await expect(page.locator('.demo-track-notice')).toBeHidden();
    await expect(page.locator('[data-demo-info] svg')).toBeVisible();
    await expect(page.locator('[data-demo-exit] svg')).toBeVisible();
    const portraitFinishActions = await page.evaluate(() => {
      const actions = document
        .querySelector('[data-demo-panel="4"] .demo-large-actions')!
        .getBoundingClientRect();
      const styles = getComputedStyle(
        document.querySelector('[data-demo-panel="4"] .demo-large-actions')!,
      );
      const info = document.querySelector('[data-demo-info]')!.getBoundingClientRect();
      const exit = document.querySelector('[data-demo-exit]')!.getBoundingClientRect();
      return {
        gap: Number.parseFloat(styles.columnGap),
        height: Math.max(info.height, exit.height),
        actionsHeight: actions.height,
      };
    });
    expect(portraitFinishActions.gap).toBeLessThanOrEqual(8);
    expect(portraitFinishActions.height).toBeGreaterThanOrEqual(52);
    expect(portraitFinishActions.height).toBeLessThanOrEqual(60);
    expect(portraitFinishActions.actionsHeight).toBeLessThanOrEqual(62);

    await page.setViewportSize({ width: 390, height: 460 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const controls = document.querySelector<HTMLElement>('.demo-control-stage')!;
          return controls.scrollHeight > controls.clientHeight + 1;
        }),
      )
      .toBe(true);
    const tinyPortrait = await page.evaluate(() => {
      const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
      const controls = document.querySelector<HTMLElement>('.demo-control-stage')!;
      const controlsRect = controls.getBoundingClientRect();
      const track = document.querySelector<HTMLElement>('.demo-mobile-shell > .cscroll-track');
      const thumb = document.querySelector<HTMLElement>(
        '.demo-mobile-shell > .cscroll-track .cscroll-thumb',
      );
      const trackRect = track?.getBoundingClientRect();
      return {
        visualHeight: visual.height,
        hasCustomScroll: controls.hasAttribute('data-custom-scroll'),
        scrollHeight: controls.scrollHeight,
        clientHeight: controls.clientHeight,
        controlHeight: controlsRect.height,
        trackHeight: trackRect?.height ?? 0,
        thumbDisplay: thumb ? getComputedStyle(thumb).display : 'missing',
      };
    });
    expect(tinyPortrait.visualHeight).toBeLessThanOrEqual(132);
    expect(tinyPortrait.hasCustomScroll).toBe(true);
    expect(tinyPortrait.scrollHeight).toBeGreaterThan(tinyPortrait.clientHeight);
    expect(tinyPortrait.trackHeight).toBeCloseTo(tinyPortrait.controlHeight, 1);
    expect(tinyPortrait.thumbDisplay).not.toBe('none');

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
    await expect
      .poll(() =>
        page.evaluate(() => {
          const activeButton = document
            .querySelector('.demo-step-nav button.active')!
            .getBoundingClientRect();
          const inactiveButton = document
            .querySelector('[data-demo-step="1"]')!
            .getBoundingClientRect();
          return activeButton.width > inactiveButton.width * 2;
        }),
      )
      .toBe(true);
    const compactDashboard = await page.evaluate(() => {
      const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
      const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
      const nav = document.querySelector('.demo-step-nav')!.getBoundingClientRect();
      const spectrum = document
        .querySelector('#demo-visualizer-slot .vinyl-wrapper')!
        .getBoundingClientRect();
      const activeButton = document
        .querySelector('.demo-step-nav button.active')!
        .getBoundingClientRect();
      const inactiveButton = document
        .querySelector('[data-demo-step="1"]')!
        .getBoundingClientRect();
      const probe = document.createElement('span');
      document.body.append(probe);
      probe.style.color = 'var(--surface-1)';
      const surface1 = getComputedStyle(probe).color;
      probe.remove();
      return {
        visualTop: visual.top,
        visualLeft: visual.left,
        visualRight: visual.right,
        visualBottom: visual.bottom,
        visualCenter: visual.top + visual.height / 2,
        controlsTop: controls.top,
        controlsLeft: controls.left,
        navLeft: nav.left,
        navTop: nav.top,
        navRight: nav.right,
        navBottom: nav.bottom,
        activeButtonWidth: activeButton.width,
        inactiveButtonWidth: inactiveButton.width,
        navButtonHeight: inactiveButton.height,
        controlsBackground: getComputedStyle(document.querySelector('.demo-control-stage')!)
          .backgroundColor,
        surface1,
        spectrumCenter: spectrum.top + spectrum.height / 2,
      };
    });
    expect(compactDashboard.controlsLeft).toBeGreaterThanOrEqual(compactDashboard.visualRight - 1);
    expect(compactDashboard.controlsTop).toBeLessThanOrEqual(compactDashboard.visualTop);
    expect(compactDashboard.navLeft).toBeGreaterThanOrEqual(compactDashboard.visualLeft - 1);
    expect(compactDashboard.navTop).toBeGreaterThanOrEqual(compactDashboard.visualTop);
    expect(compactDashboard.navRight).toBeLessThanOrEqual(compactDashboard.visualRight + 1);
    expect(compactDashboard.navBottom).toBeLessThanOrEqual(compactDashboard.visualBottom + 1);
    expect(compactDashboard.visualBottom - compactDashboard.navBottom).toBeLessThanOrEqual(32);
    expect(compactDashboard.navButtonHeight).toBeGreaterThanOrEqual(46);
    expect(compactDashboard.activeButtonWidth).toBeGreaterThan(
      compactDashboard.inactiveButtonWidth * 2,
    );
    expect(compactDashboard.controlsBackground).toBe(compactDashboard.surface1);
    expect(Math.abs(compactDashboard.spectrumCenter - compactDashboard.visualCenter)).toBeLessThan(
      2,
    );

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
          const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
          return controls.left >= visual.right - 1;
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
          return Math.abs(controls.top + controls.height / 2 - window.innerHeight / 2) < 24;
        }),
      )
      .toBe(true);
    const roomyLandscape = await page.evaluate(() => {
      const controls = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
      const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
      const inactiveButton = document
        .querySelector('[data-demo-step="1"]')!
        .getBoundingClientRect();
      const activeButton = document
        .querySelector('.demo-step-nav button.active')!
        .getBoundingClientRect();
      const spectrum = document
        .querySelector('#demo-visualizer-slot .vinyl-wrapper')!
        .getBoundingClientRect();
      return {
        controlsCenter: controls.top + controls.height / 2,
        spectrumCenter: spectrum.top + spectrum.height / 2,
        spectrumHeight: spectrum.height,
        visualCenter: visual.top + visual.height / 2,
        spectrumBottomGap: visual.bottom - spectrum.bottom,
        navButtonHeight: inactiveButton.height,
        activeButtonWidth: activeButton.width,
        inactiveButtonWidth: inactiveButton.width,
        viewportCenter: window.innerHeight / 2,
      };
    });
    expect(Math.abs(roomyLandscape.controlsCenter - roomyLandscape.viewportCenter)).toBeLessThan(
      24,
    );
    expect(Math.abs(roomyLandscape.spectrumCenter - roomyLandscape.visualCenter)).toBeLessThan(2);
    expect(roomyLandscape.spectrumBottomGap).toBeGreaterThan(120);
    expect(roomyLandscape.spectrumHeight).toBeGreaterThan(320);
    expect(roomyLandscape.spectrumHeight).toBeLessThanOrEqual(380);
    expect(roomyLandscape.navButtonHeight).toBeGreaterThanOrEqual(46);
    expect(roomyLandscape.activeButtonWidth).toBeGreaterThan(
      roomyLandscape.inactiveButtonWidth * 2,
    );
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

  test('host demo entry automatically brings connected guest into the demo', async ({
    browser,
  }) => {
    const pair = await createHostGuestContexts(browser);
    try {
      await Promise.all([
        pair.hostPage.addInitScript(() => {
          localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
        }),
        pair.guestPage.addInitScript(() => {
          localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
        }),
      ]);
      await Promise.all([mockDemoTrack(pair.hostPage), mockDemoTrack(pair.guestPage)]);
      await connectHostAndGuest(pair.hostPage, pair.guestPage);

      await pair.hostPage.evaluate(() => {
        const bus = (window as unknown as Record<string, { emit?: (...args: unknown[]) => void }>)
          .__MUSIXQUARE_BUS__;
        bus?.emit?.('demo:enter');
      });

      await expect(pair.hostPage.locator('#demo-overlay')).toHaveClass(/active/, {
        timeout: 15_000,
      });
      await expect(pair.guestPage.locator('#demo-overlay')).toHaveClass(/active/, {
        timeout: 15_000,
      });
      await expect(pair.guestPage.locator('body')).toHaveClass(/mode-demo/);
      await expect(pair.guestPage.locator('.demo-track-title')).toContainText(
        'Linelight OST - Adventure',
      );
      await expect
        .poll(() => readState(pair.guestPage, 'demo.active'), { timeout: 15_000 })
        .toBe(true);
      await expect
        .poll(() => readState(pair.guestPage, 'playlist.currentTrackIndex'), { timeout: 15_000 })
        .toBe(0);

      await pair.hostPage.locator('[data-demo-step="3"]').click();
      await pair.hostPage.locator('[data-demo-effect="reverb"]').click();
      await expect
        .poll(() => readState(pair.guestPage, 'demo.reverbOn'), { timeout: 10_000 })
        .toBe(true);
      await pair.hostPage.locator('[data-demo-effect="treble"]').click();
      await expect
        .poll(() => readState(pair.guestPage, 'demo.trebleBoostOn'), { timeout: 10_000 })
        .toBe(true);
      await expect
        .poll(() => readState(pair.guestPage, 'audio.eqValues'), { timeout: 10_000 })
        .toEqual([0, -2, 0, 4, 6]);
      await pair.hostPage.locator('[data-demo-effect="bass"]').click();
      await expect
        .poll(() => readState(pair.guestPage, 'demo.bassBoostOn'), { timeout: 10_000 })
        .toBe(true);
      await expect
        .poll(() => readState(pair.guestPage, 'demo.trebleBoostOn'), { timeout: 10_000 })
        .toBe(true);
      await expect
        .poll(() => readState(pair.guestPage, 'audio.eqValues'), { timeout: 10_000 })
        .toEqual([5, 3, 0, 4, 6]);
      await expect
        .poll(() => readState(pair.guestPage, 'audio.virtualBass'), { timeout: 10_000 })
        .toBe(0.6);
      await pair.hostPage.locator('[data-demo-effect="surround"]').click();
      await expect
        .poll(() => readState(pair.guestPage, 'demo.surroundOn'), { timeout: 10_000 })
        .toBe(true);

      await pair.hostPage.locator('[data-demo-next]').click();
      await pair.hostPage.locator('[data-demo-exit]').click();
      await expect(pair.guestPage.locator('body')).not.toHaveClass(/mode-demo/, {
        timeout: 10_000,
      });
    } finally {
      await cleanupContexts(pair);
    }
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
      const activeButton = document
        .querySelector('.demo-step-nav button.active')!
        .getBoundingClientRect();
      const inactiveButton = document
        .querySelector('[data-demo-step="2"]')!
        .getBoundingClientRect();
      const probe = document.createElement('span');
      document.body.append(probe);
      probe.style.color = 'var(--surface-1)';
      const surface1 = getComputedStyle(probe).color;
      probe.remove();
      return {
        visualLeft: visual.left,
        visualRight: visual.right,
        visualBottom: visual.bottom,
        visualTop: visual.top,
        visualCenter: visual.top + visual.height / 2,
        controlsLeft: controls.left,
        navLeft: nav.left,
        navTop: nav.top,
        navRight: nav.right,
        navBottom: nav.bottom,
        activeButtonWidth: activeButton.width,
        inactiveButtonWidth: inactiveButton.width,
        navButtonHeight: inactiveButton.height,
        controlsBackground: getComputedStyle(document.querySelector('.demo-control-stage')!)
          .backgroundColor,
        surface1,
        qrSize: document.querySelector('#demo-session-qr')!.getBoundingClientRect().width,
        spectrumCenter: spectrum.top + spectrum.height / 2,
        spectrumHeight: spectrum.height,
        spectrumBottomGap: visual.bottom - spectrum.bottom,
      };
    });
    expect(desktopLayout.controlsLeft).toBeGreaterThanOrEqual(desktopLayout.visualRight - 1);
    expect(desktopLayout.navLeft).toBeGreaterThanOrEqual(desktopLayout.visualLeft - 1);
    expect(desktopLayout.navTop).toBeGreaterThanOrEqual(desktopLayout.visualTop);
    expect(desktopLayout.navRight).toBeLessThanOrEqual(desktopLayout.visualRight + 1);
    expect(desktopLayout.navBottom).toBeLessThanOrEqual(desktopLayout.visualBottom + 1);
    expect(desktopLayout.visualBottom - desktopLayout.navBottom).toBeLessThanOrEqual(32);
    expect(Math.abs(desktopLayout.spectrumCenter - desktopLayout.visualCenter)).toBeLessThan(2);
    expect(desktopLayout.spectrumBottomGap).toBeGreaterThan(180);
    expect(desktopLayout.spectrumHeight).toBeGreaterThan(400);
    expect(desktopLayout.spectrumHeight).toBeLessThanOrEqual(440);
    expect(desktopLayout.navButtonHeight).toBeGreaterThanOrEqual(46);
    expect(desktopLayout.activeButtonWidth).toBeGreaterThan(desktopLayout.inactiveButtonWidth * 2);
    expect(desktopLayout.controlsBackground).toBe(desktopLayout.surface1);
    expect(desktopLayout.qrSize).toBeGreaterThanOrEqual(260);

    await page.locator('[data-demo-step="3"]').click();
    const desktopEffectSize = await page
      .locator('[data-demo-effect="bass"]')
      .evaluate((button) => button.getBoundingClientRect().height);
    expect(desktopEffectSize).toBeGreaterThanOrEqual(90);
    expect(desktopEffectSize).toBeLessThanOrEqual(120);

    await page.locator('[data-demo-next]').click();
    await expect(page.locator('[data-demo-next]')).toHaveClass(/is-final/);
    await expect(page.locator('[data-demo-next] svg')).toBeHidden();
    await expect(page.locator('[data-demo-info] svg path')).toHaveAttribute('d', INFO_ICON_PATH);
    await expect(page.locator('[data-demo-exit] svg path')).toHaveAttribute('d', EXIT_ICON_PATH);
    const readFinishActions = () =>
      page.evaluate(() => {
        const actions = document
          .querySelector('[data-demo-panel="4"] .demo-large-actions')!
          .getBoundingClientRect();
        const styles = getComputedStyle(
          document.querySelector('[data-demo-panel="4"] .demo-large-actions')!,
        );
        const info = document.querySelector('[data-demo-info]')!.getBoundingClientRect();
        const exit = document.querySelector('[data-demo-exit]')!.getBoundingClientRect();
        return {
          gap: Number.parseFloat(styles.columnGap),
          width: actions.width,
          buttonGap: exit.left - info.right,
          height: Math.max(info.height, exit.height),
          actionsHeight: actions.height,
        };
      });

    await page.setViewportSize({ width: 1279, height: 720 });
    const preDesktopFinishActions = await readFinishActions();
    await page.setViewportSize({ width: 1280, height: 720 });
    const desktopFinishActions = await readFinishActions();
    expect(preDesktopFinishActions.width).toBeGreaterThanOrEqual(440);
    expect(preDesktopFinishActions.width).toBeLessThanOrEqual(650);
    expect(preDesktopFinishActions.buttonGap).toBeLessThanOrEqual(10);
    expect(
      Math.abs(desktopFinishActions.width - preDesktopFinishActions.width),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(desktopFinishActions.buttonGap - preDesktopFinishActions.buttonGap),
    ).toBeLessThanOrEqual(1);
    expect(desktopFinishActions.gap).toBeLessThanOrEqual(8);
    expect(desktopFinishActions.width).toBeGreaterThanOrEqual(440);
    expect(desktopFinishActions.width).toBeLessThanOrEqual(650);
    expect(desktopFinishActions.buttonGap).toBeLessThanOrEqual(10);
    expect(desktopFinishActions.height).toBeGreaterThanOrEqual(56);
    expect(desktopFinishActions.height).toBeLessThanOrEqual(60);
    expect(desktopFinishActions.actionsHeight).toBeLessThanOrEqual(62);

    const popupPromise = page.waitForEvent('popup');
    await page.locator('[data-demo-info]').click();
    const popup = await popupPromise;
    await expect.poll(() => popup.url()).toBe(INFO_URL);

    await page.locator('[data-demo-next]').click();
    await expect(page.locator('#demo-overlay')).toHaveClass(/exiting/);
    await waitForToast(page, 'You can try it anytime from the Help tab.');
    await expect(page.locator('body')).not.toHaveClass(/mode-demo/);
  });
});
