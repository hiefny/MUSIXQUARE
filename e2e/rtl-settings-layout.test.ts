import { expect, test } from '@playwright/test';
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_STYLES = readFileSync(resolve('css/style.css'), 'utf8');
const RTL_STYLES = readFileSync(resolve('css/rtl.css'), 'utf8');
const RANGE_DRAG_RUNTIME = transformSync(
  `${readFileSync(resolve('src/ui/range-drag.ts'), 'utf8')}\ninstallRangeDragGuard();`,
  { loader: 'ts', format: 'iife', target: 'es2020' },
).code;

function effectSlider(id: string, label: string): string {
  return `
    <div class="slider-wrap">
      <div class="slider-header">
        <span>${label} <span class="role-hint-label">القيمة الافتراضية الدقيقة</span></span>
        <span class="val-disp">20.0kHz</span>
      </div>
      <input type="range" id="${id}" min="0" max="100" value="50" />
    </div>
  `;
}

function eqBand(index: number, label: string): string {
  return `
    <div class="eq-band">
      <span class="eq-val">0</span>
      <input type="range" class="eq-slider" id="eq-slider-${index}" min="-12" max="12" value="0" />
      <span class="eq-label">${label}</span>
    </div>
  `;
}

test.describe('RTL settings and directional controls', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.setContent(`
      <!doctype html>
      <html lang="ar" dir="rtl">
        <head><style>${APP_STYLES}\n${RTL_STYLES}</style></head>
        <body>
          <header id="main-header" style="height:40px">
            <div class="header-progress-bg" id="header-progress-bg"></div>
          </header>
          <main style="width:302px;margin:60px auto 0">
            <div class="progress-bar">
              <input type="range" id="seek-slider" min="0" max="100" value="50" />
              <div class="time-info"><span>0:30</span><span>1:00</span></div>
            </div>
            <div class="vol-group-playback">
              <span>volume</span>
              <input type="range" id="volume-slider" min="0" max="100" value="50" />
            </div>
            <div id="settings-subtab-panel-audio">
              <div id="reverb-sliders-area" class="reverb-sliders-area">
                <div class="collapsible-slider-content">
                  ${effectSlider('reverb-slider', 'المزج')}
                  ${effectSlider('reverb-decay-slider', 'زمن الاضمحلال')}
                  ${effectSlider('reverb-predelay-slider', 'التأخير المسبق')}
                  ${effectSlider('reverb-lowcut-slider', 'مرشح الترددات العالية')}
                  ${effectSlider('reverb-highcut-slider', 'مرشح الترددات المنخفضة الطويل')}
                </div>
              </div>
              <div id="after-reverb">Equalizer</div>
              <div id="eq-sliders-area" class="reverb-sliders-area">
                <div class="collapsible-slider-content">
                  <div class="eq-container">
                    ${eqBand(0, '60')}
                    ${eqBand(1, '230')}
                    ${eqBand(2, '910')}
                    ${eqBand(3, '3.6k')}
                    ${eqBand(4, '14k')}
                  </div>
                </div>
              </div>
            </div>
            <button id="btn-setup-back" aria-label="Back">
              <svg viewBox="0 0 24 24"><path d="M15 18 9 12l6-6" /></svg>
            </button>
            <div class="play-btn-group" style="margin-top:20px">
              <button id="btn-prev"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg></button>
              <button id="play-btn"></button>
              <button id="btn-next"><svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg></button>
            </div>
            <div class="dialog-input-split">
              <input class="dialog-input-segment" value="1234" />
              <span class="dialog-input-separator">-</span>
              <input class="dialog-input-segment" value="5678" />
            </div>
            <div id="chat-messages" class="chat-drawer-messages" style="width:302px;height:160px">
              <div class="chat-group others">
                <div class="chat-sender" dir="auto">مضيف</div>
                <div class="chat-row"><div class="chat-bubble others"><div class="chat-text" dir="auto">مرحبا</div></div></div>
              </div>
              <div class="chat-group mine">
                <div class="chat-row"><div class="chat-bubble mine"><div class="chat-text" dir="auto">hello</div></div></div>
              </div>
            </div>
          </main>
          <script>${RANGE_DRAG_RUNTIME}</script>
        </body>
      </html>
    `);
  });

  test('keeps media axes LTR and mirrors ordinary RTL setting sliders coherently', async ({
    page,
  }) => {
    const directions = await page.evaluate(() => {
      const read = (id: string) => {
        const element = document.getElementById(id)!;
        const style = getComputedStyle(element);
        return {
          direction: style.direction,
          trackDirection: style.getPropertyValue('--range-track-direction').trim(),
        };
      };
      return {
        seek: read('seek-slider'),
        volume: read('volume-slider'),
        reverb: read('reverb-slider'),
        eq: read('eq-slider-0'),
      };
    });

    expect(directions).toEqual({
      seek: { direction: 'ltr', trackDirection: 'to right' },
      volume: { direction: 'ltr', trackDirection: 'to right' },
      reverb: { direction: 'rtl', trackDirection: 'to left' },
      eq: { direction: 'ltr', trackDirection: 'to right' },
    });

    const seek = page.locator('#seek-slider');
    await seek.focus();
    await seek.press('ArrowRight');
    await expect(seek).toHaveValue('51');

    const reverb = page.locator('#reverb-slider');
    await reverb.focus();
    await reverb.press('ArrowRight');
    await expect(reverb).toHaveValue('49');
    await reverb.press('ArrowLeft');
    await expect(reverb).toHaveValue('50');
  });

  test('sizes wrapped Arabic reverb content without colliding with the next section', async ({
    page,
  }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await page.evaluate(() => {
        const panel = document.getElementById('reverb-sliders-area')!;
        const lastSlider = document.getElementById('reverb-highcut-slider')!;
        const next = document.getElementById('after-reverb')!;
        return {
          panelClientHeight: panel.clientHeight,
          panelScrollHeight: panel.scrollHeight,
          panelBottom: panel.getBoundingClientRect().bottom,
          lastSliderBottom: lastSlider.getBoundingClientRect().bottom,
          nextTop: next.getBoundingClientRect().top,
        };
      });

      expect(geometry.panelClientHeight, `${width}px client height`).toBeGreaterThan(380);
      expect(geometry.panelScrollHeight, `${width}px scroll height`).toBeLessThanOrEqual(
        geometry.panelClientHeight + 1,
      );
      expect(geometry.lastSliderBottom, `${width}px last slider`).toBeLessThanOrEqual(
        geometry.panelBottom + 1,
      );
      expect(geometry.panelBottom, `${width}px next section`).toBeLessThanOrEqual(
        geometry.nextTop + 1,
      );
    }

    await page
      .locator('#reverb-sliders-area')
      .evaluate((element) => element.classList.add('collapsed'));
    await page.waitForTimeout(400);
    await expect(page.locator('#reverb-sliders-area')).toHaveCSS('visibility', 'hidden');
    expect(
      await page
        .locator('#reverb-sliders-area')
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(0.5);

    await page
      .locator('#reverb-sliders-area')
      .evaluate((element) => element.classList.remove('collapsed'));
    await page.waitForTimeout(100);
    await expect(page.locator('#reverb-sliders-area')).toHaveCSS('overflow', 'hidden');
    await page.waitForTimeout(300);
    const reopened = await page.locator('#reverb-sliders-area').evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(reopened.scrollHeight).toBeLessThanOrEqual(reopened.clientHeight + 1);
  });

  test('centers every EQ rail and preserves the physical frequency order', async ({ page }) => {
    const geometry = await page.locator('.eq-band').evaluateAll((bands) =>
      bands.map((band) => {
        const slider = band.querySelector<HTMLInputElement>('.eq-slider')!;
        const label = band.querySelector<HTMLElement>('.eq-label')!;
        const bandRect = band.getBoundingClientRect();
        const sliderRect = slider.getBoundingClientRect();
        return {
          bandCenter: bandRect.left + bandRect.width / 2,
          sliderCenter: sliderRect.left + sliderRect.width / 2,
          label: label.textContent,
        };
      }),
    );

    for (const band of geometry) {
      expect(Math.abs(band.bandCenter - band.sliderCenter), band.label ?? '').toBeLessThanOrEqual(
        1,
      );
    }
    expect(geometry.map(({ label }) => label)).toEqual(['60', '230', '910', '3.6k', '14k']);
    expect(geometry.map(({ bandCenter }) => bandCenter)).toEqual(
      [...geometry.map(({ bandCenter }) => bandCenter)].sort((a, b) => a - b),
    );
  });

  test('starts determinate loading at the RTL edge and mirrors setup back only', async ({
    page,
  }) => {
    const progress = await page.locator('#header-progress-bg').evaluate((element) => {
      (element as HTMLElement).style.transform = 'scaleX(0.25)';
      const rect = element.getBoundingClientRect();
      const headerRect = document.getElementById('main-header')!.getBoundingClientRect();
      const originX = Number.parseFloat(getComputedStyle(element).transformOrigin);
      return {
        layoutWidth: (element as HTMLElement).offsetWidth,
        paintedWidth: rect.width,
        paintedRight: rect.right,
        headerRight: headerRect.right,
        originX,
      };
    });
    expect(Math.abs(progress.layoutWidth - progress.originX)).toBeLessThanOrEqual(1);
    expect(Math.abs(progress.paintedWidth - progress.layoutWidth * 0.25)).toBeLessThanOrEqual(1);
    expect(Math.abs(progress.paintedRight - progress.headerRight)).toBeLessThanOrEqual(1);
    await expect(page.locator('#btn-setup-back svg')).toHaveCSS(
      'transform',
      'matrix(-1, 0, 0, 1, 0, 0)',
    );
    await expect(page.locator('#btn-prev svg')).toHaveCSS('transform', 'none');
    await expect(page.locator('#btn-next svg')).toHaveCSS('transform', 'none');
  });

  test('keeps machine input and chat ownership physically stable', async ({ page }) => {
    const directions = await page.evaluate(() => {
      const split = document.querySelector<HTMLElement>('.dialog-input-split')!;
      const segment = document.querySelector<HTMLElement>('.dialog-input-segment')!;
      const other = document.querySelector<HTMLElement>('.chat-group.others')!;
      const mine = document.querySelector<HTMLElement>('.chat-group.mine')!;
      const otherBubble = document.querySelector<HTMLElement>('.chat-bubble.others')!;
      const mineBubble = document.querySelector<HTMLElement>('.chat-bubble.mine')!;
      return {
        splitDirection: getComputedStyle(split).direction,
        segmentDirection: getComputedStyle(segment).direction,
        splitUnicodeBidi: getComputedStyle(split).unicodeBidi,
        otherX: other.getBoundingClientRect().x,
        mineX: mine.getBoundingClientRect().x,
        otherTail: getComputedStyle(otherBubble).borderBottomLeftRadius,
        mineTail: getComputedStyle(mineBubble).borderBottomRightRadius,
      };
    });

    expect(directions.splitDirection).toBe('ltr');
    expect(directions.segmentDirection).toBe('ltr');
    expect(directions.splitUnicodeBidi).toBe('isolate');
    expect(directions.mineX).toBeGreaterThan(directions.otherX);
    expect(directions.otherTail).toBe('4px');
    expect(directions.mineTail).toBe('4px');
    await expect(page.locator('.chat-text').first()).toHaveCSS('direction', 'rtl');
    await expect(page.locator('.chat-text').last()).toHaveCSS('direction', 'ltr');
  });
});
