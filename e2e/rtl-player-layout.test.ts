import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_STYLES = readFileSync(resolve('css/style.css'), 'utf8');
const RTL_STYLES = readFileSync(resolve('css/rtl.css'), 'utf8');

test.describe('RTL player layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(`
      <!doctype html>
      <html lang="ur" dir="rtl">
        <head>
          <style>${APP_STYLES}\n${RTL_STYLES}</style>
        </head>
        <body>
          <div class="track-box" style="width: 420px">
            <div class="track-artist" id="track-artist">≈192 kbps · MP3</div>
          </div>
          <div class="play-btn-group">
            <button class="ctrl-btn" id="btn-prev" aria-label="Previous track">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>
            <button class="play-fab" id="play-btn" aria-label="Play/Pause"></button>
            <button class="ctrl-btn" id="btn-next" aria-label="Next track">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
          </div>
        </body>
      </html>
    `);
  });

  test('keeps technical metadata visually LTR without forcing localized prose LTR', async ({
    page,
  }) => {
    const technical = await page.locator('#track-artist').evaluate((element) => {
      const text = element.firstChild!;
      const xPositions = Array.from(element.textContent ?? '', (_character, index) => {
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const rect = range.getBoundingClientRect();
        return rect.left + rect.width / 2;
      });
      const style = getComputedStyle(element);
      return {
        direction: style.direction,
        textAlign: style.textAlign,
        unicodeBidi: style.unicodeBidi,
        xPositions,
      };
    });

    expect(technical.direction).toBe('rtl');
    expect(technical.textAlign).toBe('right');
    expect(technical.unicodeBidi).toBe('plaintext');
    expect(
      technical.xPositions.every((position, index, positions) =>
        index === 0 ? true : position >= positions[index - 1]! - 0.5,
      ),
    ).toBe(true);

    await page.locator('#track-artist').evaluate((element) => {
      element.textContent = 'فائل منتخب کریں';
    });
    await expect(page.locator('#track-artist')).toHaveCSS('direction', 'rtl');
    await expect(page.locator('#track-artist')).toHaveCSS('text-align', 'right');
  });

  test('keeps previous, play, and next in temporal order', async ({ page }) => {
    const positions = await page
      .locator('.play-btn-group > button')
      .evaluateAll((buttons) =>
        Object.fromEntries(buttons.map((button) => [button.id, button.getBoundingClientRect().x])),
      );

    expect(positions['btn-prev']).toBeLessThan(positions['play-btn']!);
    expect(positions['play-btn']).toBeLessThan(positions['btn-next']!);
  });
});
