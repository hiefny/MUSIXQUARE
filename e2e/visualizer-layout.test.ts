import { expect, test, type Page } from '@playwright/test';
import { setupHostAndStart } from './helpers/setup-flow.ts';

const MOBILE_WIDTHS = [360, 390, 430] as const;
const MAX_LAYOUT_DRIFT_PX = 0.5;

interface VisualizerGeometry {
  stageHeight: number;
  stageWidth: number;
  titleTop: number;
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

test.describe('mobile visualizer layout', () => {
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
  });
});
