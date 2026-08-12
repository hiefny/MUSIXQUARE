import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

interface HorizontalGeometry {
  left: number;
  right: number;
  width: number;
}

interface StageGeometry {
  viewportWidth: number;
  pane: HorizontalGeometry;
  wrapper: HorizontalGeometry;
  container: HorizontalGeometry;
  iframe: HorizontalGeometry;
  track: HorizontalGeometry;
  controls: HorizontalGeometry;
  documentScrollWidth: number;
  bodyScrollWidth: number;
  paneScrollWidth: number;
  paneClientWidth: number;
}

async function openYouTubeStageFixture(page: Page): Promise<void> {
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);

  await page.evaluate(() => {
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
    document.body.classList.add('mode-youtube');

    document.querySelectorAll('.tab-content').forEach((tab) => {
      tab.classList.toggle('active', tab.id === 'tab-play');
    });

    const wrapper = document.querySelector<HTMLElement>('.video-wrapper');
    if (!wrapper) throw new Error('YouTube stage wrapper is unavailable');
    wrapper.querySelector('#youtube-player-container')?.remove();

    // Mirror the box contract produced by the YouTube IFrame API without
    // depending on a third-party network response or poster aspect ratio.
    const container = document.createElement('div');
    container.id = 'youtube-player-container';
    container.style.cssText = 'width:100%; height:100%; position:relative;';
    const iframe = document.createElement('iframe');
    iframe.title = 'YouTube landscape geometry fixture';
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.setAttribute('frameborder', '0');
    container.appendChild(iframe);
    wrapper.appendChild(container);
  });
}

async function setViewportAndSafeInsets(
  page: Page,
  viewport: { width: number; height: number },
  safe: { left: number; right: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.evaluate(
    ({ height, left, right }) => {
      const root = document.documentElement;
      root.style.setProperty('--app-height', `${height}px`);
      root.style.setProperty('--safe-left', `${left}px`);
      root.style.setProperty('--safe-right', `${right}px`);
    },
    { height: viewport.height, left: safe.left, right: safe.right },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function readStageGeometry(page: Page): Promise<StageGeometry> {
  return page.evaluate(() => {
    const horizontal = (selector: string): HorizontalGeometry => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing geometry target: ${selector}`);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };

    const pane = document.getElementById('tab-play');
    if (!pane) throw new Error('Play pane is unavailable');
    return {
      viewportWidth: window.innerWidth,
      pane: horizontal('#tab-play'),
      wrapper: horizontal('.video-wrapper'),
      container: horizontal('#youtube-player-container'),
      iframe: horizontal('#youtube-player-container iframe'),
      track: horizontal('.track-box'),
      controls: horizontal('.controls-area'),
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      paneScrollWidth: pane.scrollWidth,
      paneClientWidth: pane.clientWidth,
    };
  });
}

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.75);
}

function expectStageMatchesWrapper(geometry: StageGeometry): void {
  for (const media of [geometry.container, geometry.iframe]) {
    expectClose(media.left, geometry.wrapper.left);
    expectClose(media.right, geometry.wrapper.right);
    expectClose(media.width, geometry.wrapper.width);
  }
}

function expectNoHorizontalOverflow(geometry: StageGeometry): void {
  expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.paneScrollWidth).toBeLessThanOrEqual(geometry.paneClientWidth + 1);
}

test.describe('mobile YouTube stage geometry', () => {
  for (const safe of [
    { name: 'notch on the media edge', left: 47, right: 0 },
    { name: 'notch on the sidebar edge', left: 0, right: 47 },
  ]) {
    test(`keeps Friday's inset 16:9 card with ${safe.name}`, async ({ page }) => {
      await openYouTubeStageFixture(page);
      await setViewportAndSafeInsets(page, { width: 844, height: 390 }, safe);

      const geometry = await readStageGeometry(page);
      const paneRight = 844 - 200 - safe.right;
      expectClose(geometry.pane.left, 0);
      expectClose(geometry.pane.right, paneRight);
      expectClose(geometry.wrapper.left, safe.left + 24);
      expectClose(geometry.wrapper.right, paneRight - 24);
      expectClose(geometry.wrapper.width, paneRight - safe.left - 48);
      expectStageMatchesWrapper(geometry);

      // The stage, metadata, and controls all keep the pane's safe inset. This
      // is the rounded/max-600 landscape contract used by the Friday release;
      // only explicit fake fullscreen may extend beneath a notch.
      expect(geometry.track.left).toBeGreaterThanOrEqual(geometry.wrapper.left);
      expect(geometry.controls.left).toBeGreaterThanOrEqual(geometry.wrapper.left);
      expect(geometry.track.right).toBeLessThanOrEqual(geometry.wrapper.right);
      expect(geometry.controls.right).toBeLessThanOrEqual(geometry.wrapper.right);
      expectNoHorizontalOverflow(geometry);
    });
  }

  test('keeps portrait geometry and fake fullscreen behavior stable across rotation', async ({
    page,
  }) => {
    await openYouTubeStageFixture(page);

    await setViewportAndSafeInsets(page, { width: 390, height: 844 }, { left: 0, right: 0 });
    const portraitBefore = await readStageGeometry(page);
    expectClose(portraitBefore.pane.left, 0);
    expectClose(portraitBefore.pane.right, 390);
    expectClose(portraitBefore.wrapper.left, 0);
    expectClose(portraitBefore.wrapper.right, 390);
    expectStageMatchesWrapper(portraitBefore);
    expectNoHorizontalOverflow(portraitBefore);

    await setViewportAndSafeInsets(page, { width: 844, height: 390 }, { left: 47, right: 0 });
    const landscape = await readStageGeometry(page);
    expectClose(landscape.pane.right, 644);
    expectClose(landscape.wrapper.left, 71);
    expectClose(landscape.wrapper.right, 620);
    expectClose(landscape.wrapper.width, 549);
    expectStageMatchesWrapper(landscape);
    expectNoHorizontalOverflow(landscape);

    await page.evaluate(() => {
      document.body.classList.add('has-fake-fullscreen');
      document.querySelector('.video-wrapper')?.classList.add('fake-fullscreen');
    });
    const fullscreen = await readStageGeometry(page);
    for (const media of [fullscreen.wrapper, fullscreen.container, fullscreen.iframe]) {
      expectClose(media.left, 0);
      expectClose(media.right, 844);
      expectClose(media.width, 844);
    }
    expectNoHorizontalOverflow(fullscreen);

    await page.evaluate(() => {
      document.body.classList.remove('has-fake-fullscreen');
      document.querySelector('.video-wrapper')?.classList.remove('fake-fullscreen');
    });
    await setViewportAndSafeInsets(page, { width: 390, height: 844 }, { left: 0, right: 0 });
    const portraitAfter = await readStageGeometry(page);
    expectClose(portraitAfter.wrapper.left, 0);
    expectClose(portraitAfter.wrapper.right, 390);
    expectStageMatchesWrapper(portraitAfter);
    expectClose(portraitAfter.wrapper.width, portraitBefore.wrapper.width);
    expectNoHorizontalOverflow(portraitAfter);
  });

  test('leaves narrow phone landscape outside the compact sidebar contract', async ({ page }) => {
    await openYouTubeStageFixture(page);
    await setViewportAndSafeInsets(page, { width: 667, height: 375 }, { left: 47, right: 0 });

    const geometry = await readStageGeometry(page);
    expectClose(geometry.pane.left, 0);
    expectClose(geometry.pane.right, 667);
    // Base mobile landscape protects the 47px notch, then centers the 600px
    // maximum media frame in the remaining 620px content box.
    expectClose(geometry.wrapper.left, 57);
    expectClose(geometry.wrapper.right, 657);
    expectClose(geometry.wrapper.width, 600);
    expectClose(geometry.container.left, geometry.wrapper.left);
    expectClose(geometry.container.right, geometry.wrapper.right);
    expectClose(geometry.iframe.left, geometry.wrapper.left);
    expectClose(geometry.iframe.right, geometry.wrapper.right);
    expectNoHorizontalOverflow(geometry);
  });
});
