import { expect, test, type Page } from '@playwright/test';
import { setupHostAndStart } from './helpers/setup-flow.ts';

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
    const chatPreview = document.querySelector<HTMLElement>('#chat-preview-btn');
    const actions = document.querySelector<HTMLElement>('.play-action-buttons');

    if (
      !tabBody ||
      !stage ||
      !title ||
      !artist ||
      !seek ||
      !transport ||
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
    const seekRect = seek.getBoundingClientRect();
    const transportRect = transport.getBoundingClientRect();
    const secondaryTarget =
      getComputedStyle(chatPreview).display === 'none' ? actions : chatPreview;
    const secondaryRect = secondaryTarget.getBoundingClientRect();

    return {
      aboveMedia:
        stageRect.top -
        tabBodyRect.top -
        Number.parseFloat(tabBodyStyle.borderTopWidth) -
        Number.parseFloat(tabBodyStyle.paddingTop) +
        tabBody.scrollTop,
      mediaToMetadata: titleRect.top - stageRect.bottom,
      metadataToTransport: seekRect.top - artistRect.bottom,
      transportToSecondary: secondaryRect.top - transportRect.bottom,
    };
  });
}

test.describe('mobile visualizer layout', () => {
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

  test('keeps the stage height and track title stable while modes change', async ({ page }) => {
    await page.setViewportSize({ width: MOBILE_WIDTHS[0], height: 844 });
    await setupHostAndStart(page);
    await expect(page.locator('.track-box')).not.toHaveClass(/app-entrance/, { timeout: 5_000 });

    for (const width of MOBILE_WIDTHS) {
      await page.setViewportSize({ width, height: 844 });

      if (await page.locator('body').evaluate((body) => body.classList.contains('viz-spectrum'))) {
        await page
          .locator('#visualizerCanvas')
          .evaluate((canvas) => (canvas as HTMLElement).click());
      }
      await expect(page.locator('body')).not.toHaveClass(/viz-spectrum/);

      const circular = await readVisualizerGeometry(page);
      await page.locator('#visualizerCanvas').evaluate((canvas) => (canvas as HTMLElement).click());
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
    await expect(page.locator('.track-box')).not.toHaveClass(/app-entrance/, { timeout: 5_000 });
    await page.locator('#track-artist').evaluate((artist) => {
      // Player metadata may settle just after setup. Reserve the row explicitly
      // so this test isolates playback-engine geometry from that independent update.
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

  test('fixes the middle gap and divides free height across three variable gaps', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupHostAndStart(page);
    await expect(page.locator('.track-box')).not.toHaveClass(/app-entrance/, { timeout: 5_000 });
    await page.locator('#track-artist').evaluate((artist) => {
      (artist as HTMLElement).style.display = 'block';
      artist.textContent = 'Layout fixture metadata';
    });

    let sawExpandedVariableGap = false;
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
        Math.abs(gaps.metadataToTransport - 20),
        `${viewport.width}x${viewport.height}: ${JSON.stringify(gaps)}`,
      ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
      const variableShares = [
        gaps.aboveMedia,
        gaps.mediaToMetadata - 20,
        gaps.transportToSecondary - 20,
      ];
      expect(Math.min(...variableShares)).toBeGreaterThanOrEqual(-MAX_LAYOUT_DRIFT_PX);
      expect(
        Math.max(...variableShares) - Math.min(...variableShares),
        `${viewport.width}x${viewport.height}: ${JSON.stringify(gaps)}`,
      ).toBeLessThanOrEqual(MAX_LAYOUT_DRIFT_PX);
      sawExpandedVariableGap ||= gaps.aboveMedia > 1;
    }
    expect(sawExpandedVariableGap).toBe(true);
  });
});
