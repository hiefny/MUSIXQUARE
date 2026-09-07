import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_STYLES = readFileSync(resolve('css/style.css'), 'utf8');
const RTL_STYLES = readFileSync(resolve('css/rtl.css'), 'utf8');
const DESKTOP_STYLES = readFileSync(resolve('css/desktop.css'), 'utf8');
const APP_MARKUP = readFileSync(resolve('index.html'), 'utf8');

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
          <div class="play-controls-left" style="width: 420px">
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
            <div class="vol-group-playback">
              <button id="vol-icon-btn" aria-label="Toggle mute"></button>
              <input id="volume-slider" type="range" min="0" max="100" value="100" />
            </div>
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

  test('keeps the LTR volume axis separated from the transport controls', async ({ page }) => {
    const layout = await page.locator('.play-controls-left').evaluate((parent) => {
      const transport = parent.querySelector<HTMLElement>('.play-btn-group')!;
      const volume = parent.querySelector<HTMLElement>('.vol-group-playback')!;
      const transportRect = transport.getBoundingClientRect();
      const volumeRect = volume.getBoundingClientRect();

      return {
        parentDirection: getComputedStyle(parent).direction,
        transportDirection: getComputedStyle(transport).direction,
        volumeDirection: getComputedStyle(volume).direction,
        volumeRight: volumeRect.right,
        transportLeft: transportRect.left,
        separation: transportRect.left - volumeRect.right,
      };
    });

    expect(layout.parentDirection).toBe('rtl');
    expect(layout.transportDirection).toBe('ltr');
    expect(layout.volumeDirection).toBe('ltr');
    expect(layout.volumeRight).toBeLessThan(layout.transportLeft);
    expect(layout.separation).toBeGreaterThan(32);
  });
});

test.describe('Playback controls in the authored application layout', () => {
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    for (const direction of ['ltr', 'rtl'] as const) {
      test(`preserves the rail and unclipped keyboard controls at ${viewport.width}px ${direction}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.setContent(
          `<!doctype html><html dir="${direction}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${APP_STYLES}\n${DESKTOP_STYLES}\n${RTL_STYLES}</style></head><body></body></html>`,
        );
        expect(await page.evaluate(() => document.compatMode)).toBe('CSS1Compat');
        await page.evaluate((markup) => {
          const authored = new DOMParser().parseFromString(markup, 'text/html');
          // Keep the real panel ancestry and controls. This is a CSS layout
          // fixture after setup closes; it does not initialize transports.
          authored.querySelectorAll('script').forEach((script) => script.remove());
          document.body.replaceChildren(...authored.body.childNodes);
          document.body.classList.add('fouc-loaded', 'viz-circular');
        }, APP_MARKUP);

        const readRails = () =>
          page.evaluate(() =>
            Object.fromEntries(
              ['.playback-stage', '#seek-slider', '.play-controls-left'].map((selector) => {
                const rect = document.querySelector(selector)!.getBoundingClientRect();
                return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
              }),
            ),
          );
        const audioRails = await readRails();
        expect(audioRails['#seek-slider']!.width).toBeGreaterThan(200);

        const layout = await page.evaluate(() => {
          const bounds = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          const prev = bounds('#btn-prev');
          const play = bounds('#play-btn');
          const next = bounds('#btn-next');
          const volume = bounds('.vol-group-playback');
          const seek = bounds('#seek-slider');
          return {
            prev: prev.x,
            play: play.x,
            next: next.x,
            glyphLeft: bounds('#btn-prev svg path').left,
            scale: prev.width / document.querySelector<HTMLElement>('#btn-prev')!.offsetWidth,
            seekLeft: seek.left,
            seekRight: seek.right,
            volumeLeft: volume.left,
            volumeRight: volume.right,
            volumeSliderRight: bounds('#volume-slider').right,
            separation:
              getComputedStyle(document.documentElement).direction === 'rtl'
                ? prev.left - volume.right
                : volume.left - next.right,
          };
        });
        expect(layout.prev).toBeLessThan(layout.play);
        expect(layout.play).toBeLessThan(layout.next);
        expect(layout.separation).toBeGreaterThan(0);
        if (direction === 'ltr') {
          expect(
            Math.abs(layout.glyphLeft - layout.seekLeft - 2 * layout.scale),
          ).toBeLessThanOrEqual(0.75);
          expect(Math.abs(layout.volumeRight - layout.seekRight)).toBeLessThanOrEqual(0.75);
          expect(Math.abs(layout.volumeSliderRight - layout.seekRight)).toBeLessThanOrEqual(0.75);
        } else {
          // The localized row mirrors, but the transport and volume axes do not.
          expect(Math.abs(layout.volumeLeft - layout.seekLeft)).toBeLessThanOrEqual(0.75);
        }

        await page.locator('#seek-slider').focus();
        await page.keyboard.press('Tab');
        await expect(page.locator('#btn-prev')).toBeFocused();
        const focus = await page.locator('#btn-prev').evaluate((element) => {
          const button = element as HTMLElement;
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          // Account for the authored QHD body transform when comparing the
          // painted outline with each ancestor's actual scrollport.
          const scale = rect.width / button.offsetWidth;
          const outset = (parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) * scale;
          const ring = {
            left: rect.left - outset,
            right: rect.right + outset,
            top: rect.top - outset,
            bottom: rect.bottom + outset,
          };
          const clearances: Array<{ ancestor: string; edge: string; space: number }> = [];
          for (let ancestor = button.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const ancestorStyle = getComputedStyle(ancestor);
            const clip = ancestor.getBoundingClientRect();
            const ancestorScale = ancestor.offsetWidth ? clip.width / ancestor.offsetWidth : 1;
            const left = clip.left + ancestor.clientLeft * ancestorScale;
            const top = clip.top + ancestor.clientTop * ancestorScale;
            const id = ancestor.id || ancestor.className || ancestor.tagName;
            if (ancestorStyle.overflowX !== 'visible') {
              clearances.push(
                { ancestor: id, edge: 'left', space: ring.left - left },
                {
                  ancestor: id,
                  edge: 'right',
                  space: left + ancestor.clientWidth * ancestorScale - ring.right,
                },
              );
            }
            if (ancestorStyle.overflowY !== 'visible') {
              clearances.push(
                { ancestor: id, edge: 'top', space: ring.top - top },
                {
                  ancestor: id,
                  edge: 'bottom',
                  space: top + ancestor.clientHeight * ancestorScale - ring.bottom,
                },
              );
            }
          }
          clearances.push(
            { ancestor: 'viewport', edge: 'left', space: ring.left },
            { ancestor: 'viewport', edge: 'right', space: innerWidth - ring.right },
            { ancestor: 'viewport', edge: 'top', space: ring.top },
            { ancestor: 'viewport', edge: 'bottom', space: innerHeight - ring.bottom },
          );
          return {
            visible: button.matches(':focus-visible'),
            outlineWidth: parseFloat(style.outlineWidth),
            clearances,
          };
        });
        expect(focus.visible).toBe(true);
        expect(focus.outlineWidth).toBeGreaterThan(0);
        for (const clearance of focus.clearances) {
          expect(
            clearance.space,
            `${clearance.ancestor} clips the ${clearance.edge} focus edge`,
          ).toBeGreaterThanOrEqual(-0.75);
        }

        await page.evaluate(() => document.body.classList.add('mode-youtube'));
        await expect(page.locator('.video-wrapper')).toBeVisible();
        const videoRails = await readRails();
        const videoFrame = await page.locator('.video-wrapper').boundingBox();
        expect(videoFrame).not.toBeNull();
        for (const dimension of ['x', 'y', 'width', 'height'] as const) {
          expect(
            Math.abs(videoFrame![dimension] - videoRails['.playback-stage']![dimension]),
            `Video ${dimension} no longer follows the playback stage`,
          ).toBeLessThanOrEqual(0.75);
        }
        for (const selector of Object.keys(audioRails)) {
          for (const dimension of ['x', 'y', 'width', 'height'] as const) {
            expect(
              Math.abs(videoRails[selector]![dimension] - audioRails[selector]![dimension]),
              `${selector} ${dimension} changed between audio and video`,
            ).toBeLessThanOrEqual(0.75);
          }
        }
      });
    }
  }
});
