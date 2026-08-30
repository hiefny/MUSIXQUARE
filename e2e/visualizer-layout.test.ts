import { expect, test, type Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToTab } from './helpers/wait.ts';

const MOBILE_WIDTHS = [360, 390, 430] as const;
const MAX_LAYOUT_DRIFT_PX = 0.5;

interface VisualizerGeometry {
  stageHeight: number;
  stageWidth: number;
  titleTop: number;
}

interface PlaybackGeometry {
  stageHeight: number;
  stageWidth: number;
  stageTop: number;
  titleTop: number;
}

interface VariableGapGeometry {
  aboveMedia: number;
  mediaToMetadata: number;
  metadataToTransport: number;
  transportToSecondary: number;
  secondaryToBottom: number;
  artistVisible: boolean;
}

async function readVisualizerGeometry(page: Page): Promise<VisualizerGeometry> {
  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.vinyl-wrapper');
    const title = document.querySelector<HTMLElement>('.track-title-wrapper');

    if (!stage || !title) throw new Error('Visualizer layout elements are missing');

    const stageRect = stage.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      stageHeight: stageRect.height,
      stageWidth: stageRect.width,
      titleTop: titleRect.top,
    };
  });
}

async function readPlaybackGeometry(page: Page): Promise<PlaybackGeometry> {
  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.playback-stage');
    const title = document.querySelector<HTMLElement>('.track-title-wrapper');

    if (!stage || !title) throw new Error('Playback layout elements are missing');

    const stageRect = stage.getBoundingClientRect();
    return {
      stageHeight: stageRect.height,
      stageWidth: stageRect.width,
      stageTop: stageRect.top,
      titleTop: title.getBoundingClientRect().top,
    };
  });
}

async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function readVariableGaps(page: Page): Promise<VariableGapGeometry> {
  return page.evaluate(() => {
    const tabBody = document.querySelector<HTMLElement>('#tab-play > .tab-body');
    const stage = document.querySelector<HTMLElement>('.playback-stage');
    const title = document.querySelector<HTMLElement>('.track-title-wrapper');
    const artist = document.querySelector<HTMLElement>('.track-artist');
    const seek = document.querySelector<HTMLElement>('#seek-slider');
    const transport = document.querySelector<HTMLElement>('.play-controls-left');
    const secondaryArea = document.querySelector<HTMLElement>('.play-secondary-area');
    const chatPreview = document.querySelector<HTMLElement>('#chat-preview-btn');
    const actions = document.querySelector<HTMLElement>('.play-action-buttons');

    if (
      !tabBody ||
      !stage ||
      !title ||
      !artist ||
      !seek ||
      !transport ||
      !secondaryArea ||
      !chatPreview ||
      !actions
    ) {
      throw new Error('Variable-gap layout elements are missing');
    }

    const tabBodyRect = tabBody.getBoundingClientRect();
    const tabBodyStyle = getComputedStyle(tabBody);
    const stageRect = stage.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const artistRect = artist.getBoundingClientRect();
    const artistVisible = getComputedStyle(artist).display !== 'none';
    const metadataBottom = artistVisible ? artistRect.bottom : titleRect.bottom;
    const seekRect = seek.getBoundingClientRect();
    const transportRect = transport.getBoundingClientRect();
    const secondaryAreaRect = secondaryArea.getBoundingClientRect();
    const secondaryTarget =
      getComputedStyle(chatPreview).display === 'none' ? actions : chatPreview;
    const secondaryRect = secondaryTarget.getBoundingClientRect();

    const borderTop = Number.parseFloat(tabBodyStyle.borderTopWidth);
    const paddingTop = Number.parseFloat(tabBodyStyle.paddingTop);
    const paddingBottom = Number.parseFloat(tabBodyStyle.paddingBottom);
    const secondaryLogicalBottom =
      secondaryAreaRect.bottom - tabBodyRect.top - borderTop + tabBody.scrollTop;

    return {
      aboveMedia: stageRect.top - tabBodyRect.top - borderTop + tabBody.scrollTop - paddingTop,
      mediaToMetadata: titleRect.top - stageRect.bottom,
      metadataToTransport: seekRect.top - metadataBottom,
      transportToSecondary: secondaryRect.top - transportRect.bottom,
      secondaryToBottom: tabBody.scrollHeight - paddingBottom - secondaryLogicalBottom,
      artistVisible,
    };
  });
}

test.describe('mobile visualizer layout', () => {
  test.beforeEach(async ({ page }) => {
    await injectPeerServer(page);
  });

  test('matches bottom clearance to the edge-to-edge nav without crowding feedback', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupHostAndStart(page);

    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const nav = document.querySelector<HTMLElement>('.bottom-nav');
      const tabBody = document.querySelector<HTMLElement>('#tab-play > .tab-body');
      const secondary = document.querySelector<HTMLElement>('.play-secondary-area');
      const toast = document.querySelector<HTMLElement>('.toast');
      const selection = document.querySelector<HTMLElement>('.playlist-selection-pill');

      if (!nav || !tabBody || !secondary || !toast || !selection) {
        throw new Error('Mobile nav-clearance elements are missing');
      }

      const navHeight = nav.getBoundingClientRect().height;
      return {
        navHeight,
        navToken: Number.parseFloat(getComputedStyle(root).getPropertyValue('--nav-height')),
        playBottomClearance: Number.parseFloat(getComputedStyle(tabBody).paddingBottom),
        secondaryPadding: Number.parseFloat(getComputedStyle(secondary).paddingBottom),
        toastGap: Number.parseFloat(getComputedStyle(toast).bottom) - navHeight,
        selectionGap: Number.parseFloat(getComputedStyle(selection).bottom) - navHeight,
      };
    });

    expect(geometry.navHeight).toBe(64);
    expect(geometry.navToken).toBe(64);
    expect(geometry.playBottomClearance).toBe(64);
    expect(geometry.secondaryPadding).toBe(24);
    expect(geometry.toastGap).toBe(46);
    expect(geometry.selectionGap).toBe(14);
  });

  test('ties the YouTube frame treatment to the active mobile UI tier', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupHostAndStart(page);

    for (const viewport of [
      { width: 700, height: 400, narrowUi: true },
      { width: 1024, height: 1366, narrowUi: false },
    ]) {
      await page.setViewportSize(viewport);
      await settleLayout(page);

      const treatment = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('.playback-stage');
        const video = document.querySelector<HTMLElement>('.video-wrapper');
        if (!stage || !video) throw new Error('Playback surfaces are missing');

        return {
          stageMaxWidth: getComputedStyle(stage).maxWidth,
          videoRadius: Number.parseFloat(getComputedStyle(video).borderTopLeftRadius),
        };
      });

      if (viewport.narrowUi) {
        expect(treatment.stageMaxWidth).toBe('none');
        expect(treatment.videoRadius).toBe(0);
      } else {
        expect(treatment.stageMaxWidth).toBe('600px');
        expect(treatment.videoRadius).toBe(16);
      }
    }
  });

  test('keeps the no-media subtitle when crossing into the desktop layout', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await setupHostAndStart(page);

    const subtitle = page.locator('#track-artist');
    await expect(subtitle).toBeVisible();
    const initialHint = (await subtitle.textContent())?.trim();
    expect(initialHint).toBeTruthy();

    await page.setViewportSize({ width: 1400, height: 900 });
    // The desktop breakpoint schedules its player-text refresh after 80 ms.
    await page.waitForTimeout(120);

    await expect(subtitle).toBeVisible();
    await expect(subtitle).toHaveText(initialHint!);
  });

  test('hides the track subtitle only on short portrait mobile UI tiers', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupHostAndStart(page);

    const artist = page.locator('#track-artist');
    await artist.evaluate((element) => {
      element.textContent = 'Responsive subtitle fixture';
      (element as HTMLElement).style.removeProperty('display');
    });

    for (const viewport of [
      { width: 390, height: 721, hidden: false },
      { width: 390, height: 720, hidden: true },
      { width: 844, height: 390, hidden: false },
      { width: 1279, height: 720, hidden: false },
      { width: 1280, height: 720, hidden: false },
      { width: 1280, height: 600, hidden: false },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(({ height }) => {
        document.documentElement.style.setProperty('--app-height', `${height}px`);
      }, viewport);
      await settleLayout(page);

      const display = await artist.evaluate((element) => getComputedStyle(element).display);
      expect(display === 'none', `${viewport.width}x${viewport.height}`).toBe(viewport.hidden);
    }
  });

  test('keeps the stage height and track title stable while modes change', async ({ page }) => {
    await page.setViewportSize({ width: MOBILE_WIDTHS[0], height: 844 });
    await setupHostAndStart(page);
    await navigateToTab(page, 'play');
    await expect(page.locator('.track-title-wrapper')).not.toHaveClass(/app-entrance/, {
      timeout: 5_000,
    });

    for (const width of MOBILE_WIDTHS) {
      await page.setViewportSize({ width, height: 844 });

      if (await page.locator('body').evaluate((body) => body.classList.contains('viz-spectrum'))) {
        await page.locator('#visualizerCanvas').click();
      }
      await expect(page.locator('body')).not.toHaveClass(/viz-spectrum/);

      const circular = await readVisualizerGeometry(page);
      await page.locator('#visualizerCanvas').click();
      await expect(page.locator('body')).toHaveClass(/viz-spectrum/);
      const spectrum = await readVisualizerGeometry(page);

      expect(Math.abs(spectrum.stageHeight - circular.stageHeight)).toBeLessThanOrEqual(
        MAX_LAYOUT_DRIFT_PX,
      );
      expect(Math.abs(spectrum.titleTop - circular.titleTop)).toBeLessThanOrEqual(
        MAX_LAYOUT_DRIFT_PX,
      );
      expect(spectrum.stageWidth).toBeGreaterThan(circular.stageWidth);
    }

    for (const viewport of [
      { width: 720, height: 1024 },
      { width: 1280, height: 900 },
      { width: 1366, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(({ height }) => {
        document.documentElement.style.setProperty('--app-height', `${height}px`);
        document.body.classList.remove('viz-spectrum');
      }, viewport);
      await settleLayout(page);

      const circular = await readVisualizerGeometry(page);
      expect(
        Math.abs(circular.stageWidth - circular.stageHeight),
        `${viewport.width}x${viewport.height}: ${JSON.stringify(circular)}`,
      ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
    }
  });

  test('keeps the shared playback footprint stable when the engine changes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupHostAndStart(page);
    await expect(page.locator('.track-title-wrapper')).not.toHaveClass(/app-entrance/, {
      timeout: 5_000,
    });
    await page.locator('#track-artist').evaluate((artist) => {
      // Keep a stable fixture wherever the active height tier permits the row;
      // short mobile layouts intentionally hide it through the CSS contract.
      (artist as HTMLElement).style.display = 'block';
      artist.textContent = 'Layout fixture metadata';
    });

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(({ height }) => {
        document.documentElement.style.setProperty('--app-height', `${height}px`);
        document.body.classList.remove('mode-youtube');
      }, viewport);
      await settleLayout(page);
      const local = await readPlaybackGeometry(page);

      await page.evaluate(() => document.body.classList.add('mode-youtube'));
      await settleLayout(page);
      const youtube = await readPlaybackGeometry(page);

      for (const key of ['stageHeight', 'stageWidth', 'stageTop', 'titleTop'] as const) {
        expect(
          Math.abs(youtube[key] - local[key]),
          `${viewport.width}x${viewport.height} ${key}: local=${local[key]}, youtube=${youtube[key]}`,
        ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
      }
    }
  });

  test('keeps fixed visual insets and divides free height across the active variable gaps', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupHostAndStart(page);
    await expect(page.locator('.track-title-wrapper')).not.toHaveClass(/app-entrance/, {
      timeout: 5_000,
    });
    await page.locator('#track-artist').evaluate((artist) => {
      artist.textContent = 'Layout fixture metadata';
    });

    let sawExpandedVariableGap = false;
    let sawExpandedDesktopGap = false;
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(({ height }) => {
        document.documentElement.style.setProperty('--app-height', `${height}px`);
      }, viewport);
      await settleLayout(page);

      const gaps = await readVariableGaps(page);
      expect(
        Math.abs(gaps.metadataToTransport - 12),
        `${viewport.width}x${viewport.height}: ${JSON.stringify(gaps)}`,
      ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
      const secondaryInset = viewport.width < 1280 ? 32 : 20;
      const aboveMedia = gaps.aboveMedia;
      const mediaToMetadata = gaps.mediaToMetadata - 20;
      const transportToSecondary = gaps.transportToSecondary - secondaryInset;
      const variableShares = [aboveMedia, mediaToMetadata, transportToSecondary];
      if (viewport.width < 720) {
        variableShares.push(gaps.secondaryToBottom);
      } else {
        expect(
          Math.abs(gaps.secondaryToBottom),
          `${viewport.width}x${viewport.height}: ${JSON.stringify(gaps)}`,
        ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
      }
      expect(Math.min(...variableShares)).toBeGreaterThanOrEqual(-MAX_LAYOUT_DRIFT_PX);
      if (viewport.width >= 1280) {
        expect(
          Math.abs(aboveMedia - mediaToMetadata * 2),
          `${viewport.width}x${viewport.height}: ${JSON.stringify(gaps)}`,
        ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
        expect(
          Math.abs(transportToSecondary - mediaToMetadata * 2),
          `${viewport.width}x${viewport.height}: ${JSON.stringify(gaps)}`,
        ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
        sawExpandedDesktopGap ||= mediaToMetadata > 1;
      } else {
        expect(
          Math.max(...variableShares) - Math.min(...variableShares),
          `${viewport.width}x${viewport.height}: ${JSON.stringify(gaps)}`,
        ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
      }
      sawExpandedVariableGap ||= variableShares[0] > 1;
    }
    expect(sawExpandedVariableGap).toBe(true);
    expect(sawExpandedDesktopGap).toBe(true);
  });
});
