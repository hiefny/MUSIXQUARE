import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';

async function readSessionLayout(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.demo-control-stage')!;
    const copy = document.querySelector('[data-demo-panel="1"] .demo-step-copy')!;
    const qr = document.querySelector('#demo-session-qr')!;
    const body = document.querySelector('[data-demo-session-body]')!;
    const stageRect = stage.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    const qrRect = qr.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    return {
      copyBottom: copyRect.bottom,
      qrTop: qrRect.top,
      qrBottom: qrRect.bottom,
      qrWidth: qrRect.width,
      qrHeight: qrRect.height,
      bodyTop: bodyRect.top,
      bodyBottom: bodyRect.bottom,
      stageTop: stageRect.top,
      stageBottom: stageRect.bottom,
      stageBottomPadding: Number.parseFloat(getComputedStyle(stage).paddingBottom),
      scrollTop: stage.scrollTop,
      scrollHeight: stage.scrollHeight,
      clientHeight: stage.clientHeight,
      horizontalOverflow: stage.scrollWidth - stage.clientWidth,
    };
  });
}

for (const language of ['en', 'ko', 'ar'] as const) {
  test(`demo invitation content stays separate and scrollable after short landscape rotation (${language})`, async ({
    page,
  }, testInfo) => {
    await injectPeerServer(page);
    await page.addInitScript((locale) => {
      localStorage.setItem('musixquare-lang', locale);
    }, language);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('https://demo.musixquare.com/linelight/*.m4a', (route) =>
      route.fulfill({
        path: fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url)),
        contentType: 'audio/mpeg',
      }),
    );
    await setupHostAndStart(page);
    await page.evaluate(() => {
      (
        window as unknown as { __MUSIXQUARE_BUS__: { emit(event: string): void } }
      ).__MUSIXQUARE_BUS__.emit('demo:enter');
    });
    await expect(page.locator('#demo-overlay')).toHaveClass(/active/);
    await expect(page.locator('#demo-session-qr svg')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 864, height: 303 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() =>
          page
            .locator('.demo-mobile-shell')
            .evaluate((shell) => shell.getBoundingClientRect().height),
        )
        .toBeCloseTo(viewport.height, 0);
      await page.locator('.demo-control-stage').evaluate((stage) => {
        stage.scrollTop = 0;
      });
      await expect
        .poll(async () => {
          const layout = await readSessionLayout(page);
          return {
            headingBeforeQR: layout.copyBottom <= layout.qrTop,
            qrBeforeBody: layout.qrBottom <= layout.bodyTop,
            qrSquare: Math.abs(layout.qrHeight - layout.qrWidth) < 1,
            noHorizontalOverflow: layout.horizontalOverflow <= 1,
          };
        })
        .toEqual({
          headingBeforeQR: true,
          qrBeforeBody: true,
          qrSquare: true,
          noHorizontalOverflow: true,
        });
      const layout = await readSessionLayout(page);
      expect(layout.qrWidth).toBeGreaterThanOrEqual(viewport.width >= 720 ? 180 : 164);

      if (viewport.height === 303) {
        expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
        await expect
          .poll(() =>
            page
              .locator('.demo-mobile-shell > .cscroll-track .cscroll-thumb')
              .evaluate((thumb) => getComputedStyle(thumb).display),
          )
          .not.toBe('none');
      } else {
        expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1);
      }

      // The final line must be reachable inside the existing scrolling panel,
      // including after a rotation back to a roomy viewport.
      await page.locator('.demo-control-stage').evaluate((stage) => {
        stage.scrollTop = stage.scrollHeight;
      });
      await expect
        .poll(async () => {
          const end = await readSessionLayout(page);
          return (
            end.bodyBottom <= end.stageBottom - end.stageBottomPadding + 1 &&
            end.bodyTop >= end.stageTop
          );
        })
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`demo-session-${viewport.width}x${viewport.height}.png`),
      });
    }

    if (language !== 'en') {
      // Stress longer translated copy without changing the shipped dictionary.
      // The existing first-panel DOM and the real locale font/direction remain.
      await page.setViewportSize({ width: 864, height: 303 });
      await page.locator('[data-demo-session-subtitle]').evaluate((subtitle, locale) => {
        subtitle.textContent =
          locale === 'ko'
            ? '같이 음악을 듣고 싶은 새로운 기기를 언제든지 이 방에 초대할 수 있어요.'
            : 'يمكنك دعوة جهاز آخر إلى هذه الغرفة في أي وقت للاستماع إلى الموسيقى معًا.';
      }, language);
      await expect
        .poll(async () => {
          const layout = await readSessionLayout(page);
          return layout.copyBottom <= layout.qrTop && layout.qrBottom <= layout.bodyTop;
        })
        .toBe(true);
      await page.locator('.demo-control-stage').evaluate((stage) => {
        stage.scrollTop = stage.scrollHeight;
      });
      await expect
        .poll(async () => {
          const end = await readSessionLayout(page);
          return (
            end.bodyBottom <= end.stageBottom - end.stageBottomPadding + 1 &&
            end.horizontalOverflow <= 1
          );
        })
        .toBe(true);
    }
  });
}
