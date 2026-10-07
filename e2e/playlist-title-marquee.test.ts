import { expect, test, type Page } from '@playwright/test';
import { E2E_APP_ORIGIN } from './config.ts';

const LONG_TITLE =
  'This title is intentionally long enough to overflow the narrow playlist title viewport';

async function mountMarqueeHarness(page: Page): Promise<void> {
  await page.goto(E2E_APP_ORIGIN);
  const stylesheetHref = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => {
    const main = links.find((link) => (link as HTMLLinkElement).href.includes('/assets/main-'));
    return (main as HTMLLinkElement | undefined)?.href ?? '';
  });
  if (!stylesheetHref) throw new Error('Built application stylesheet was not found');
  await page.setContent(`
    <link rel="stylesheet" href="${stylesheetHref}">
    <main style="width: 260px">
      <div style="width: 150px; overflow: hidden">
        <span id="main-title" class="track-title marquee"
              style="--marquee-offset: -240px; --marquee-duration: 10s">${LONG_TITLE}</span>
      </div>
      <ul class="playlist-ul" style="padding: 0; margin: 0">
        <li class="playlist-entry" id="short-entry">
          <div class="track-item active">
            <button class="track-name">
              <span class="track-name-text" style="width: 150px; flex: none">
                <span class="playlist-title-marquee-content">Short</span>
              </span>
            </button>
          </div>
        </li>
        <li class="playlist-entry" id="current-entry">
          <div class="track-item active">
            <span class="playlist-current-leading is-current-playing"></span>
            <button class="track-name">
              <span class="track-name-text is-playlist-title-overflowing"
                    style="width: 150px; flex: none; --playlist-marquee-offset: -240px; --playlist-marquee-duration: 10s">
                <span class="playlist-title-marquee-content">${LONG_TITLE}</span>
              </span>
            </button>
          </div>
        </li>
        <li class="playlist-entry" id="paused-entry">
          <div class="track-item active">
            <span class="playlist-current-leading is-current-paused"></span>
            <button class="track-name">
              <span class="track-name-text is-playlist-title-overflowing"
                    style="width: 150px; flex: none; --playlist-marquee-offset: -240px; --playlist-marquee-duration: 10s">
                <span class="playlist-title-marquee-content">${LONG_TITLE}</span>
              </span>
            </button>
          </div>
        </li>
        <li class="playlist-entry" id="idle-entry">
          <div class="track-item">
            <button class="track-name">
              <span class="track-name-text is-playlist-title-overflowing"
                    style="width: 150px; flex: none; --playlist-marquee-offset: -240px; --playlist-marquee-duration: 10s">
                <span class="playlist-title-marquee-content">${LONG_TITLE}</span>
              </span>
            </button>
          </div>
        </li>
        <li class="playlist-entry" id="expanded-entry">
          <div class="track-item active">
            <span class="playlist-current-leading is-current-playing"></span>
            <button class="track-name">
              <span class="track-name-text is-playlist-title-overflowing"
                    style="width: 150px; flex: none; --playlist-marquee-offset: -240px; --playlist-marquee-duration: 10s">
                <span class="playlist-title-marquee-content">${LONG_TITLE}</span>
              </span>
            </button>
          </div>
          <ul class="sub-playlist">
            <li class="sub-track-item active" tabindex="0">
              <span class="sub-name is-playlist-title-overflowing"
                    style="width: 150px; flex: none; --playlist-marquee-offset: -240px; --playlist-marquee-duration: 10s">
                <span class="playlist-title-marquee-content">${LONG_TITLE}</span>
              </span>
            </li>
          </ul>
        </li>
      </ul>
    </main>
  `);
  await page.waitForFunction(
    (href) =>
      Array.from(document.styleSheets).some(
        (sheet) => sheet.href === href && (sheet.cssRules?.length ?? 0) > 0,
      ),
    stylesheetHref,
  );
}

async function animationName(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((node) => getComputedStyle(node).animationName);
}

async function expectMarqueeStart(page: Page, selector: string, startMs: number): Promise<void> {
  for (const durationSeconds of [4, 10, 40]) {
    const timing = await page.locator(selector).evaluate(
      (node, { durationSeconds, startMs }) => {
        const element = node as HTMLElement;
        element.style.setProperty('--marquee-duration', `${durationSeconds}s`);
        element.style.setProperty('--playlist-marquee-duration', `${durationSeconds}s`);
        const animation = element.getAnimations()[0];
        if (!animation?.effect) throw new Error('Expected an active marquee animation');
        animation.pause();
        const positionAt = (time: number) => {
          animation.currentTime = time;
          const transform = getComputedStyle(element).transform;
          return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
        };
        const before = positionAt(Math.max(0, startMs - 100));
        const after = positionAt(startMs + 100);
        return { before, after };
      },
      { durationSeconds, startMs },
    );
    expect(timing.before).toBeCloseTo(0, 5);
    expect(timing.after).toBeLessThan(0);
  }
}

test('desktop interaction, narrow touch autoplay, and reduced-motion marquee policy', async ({
  browser,
}) => {
  // A narrow hover-capable desktop still uses desktop policy: current alone
  // is static, while hovering an overflowing row opts it into motion.
  const content = '.playlist-title-marquee-content';
  const desktop = await browser.newContext({
    hasTouch: false,
    isMobile: false,
    viewport: { width: 390, height: 844 },
  });
  const desktopPage = await desktop.newPage();
  try {
    await mountMarqueeHarness(desktopPage);
    await expectMarqueeStart(desktopPage, '#main-title', 1000);
    expect(await desktopPage.evaluate(() => matchMedia('(any-hover: hover)').matches)).toBe(true);
    expect(await animationName(desktopPage, `#current-entry ${content}`)).toBe('none');
    expect(
      await desktopPage.locator(`#current-entry ${content}`).evaluate((node) => ({
        display: getComputedStyle(node).display,
        overflow: getComputedStyle(node.parentElement!).overflow,
        textOverflow: getComputedStyle(node.parentElement!).textOverflow,
      })),
    ).toEqual({ display: 'inline', overflow: 'hidden', textOverflow: 'ellipsis' });
    await desktopPage.locator('#idle-entry .track-name').focus();
    expect(await animationName(desktopPage, `#idle-entry ${content}`)).toBe('marquee-pingpong');
    await expectMarqueeStart(desktopPage, `#idle-entry ${content}`, 1000);
    const focusedPosition = await desktopPage
      .locator(`#idle-entry ${content}`)
      .evaluate((node) => getComputedStyle(node).transform);
    await desktopPage.locator('#idle-entry .track-item').hover();
    expect(
      await desktopPage
        .locator(`#idle-entry ${content}`)
        .evaluate((node) => getComputedStyle(node).transform),
    ).toBe(focusedPosition);
    await desktopPage.locator('#short-entry .track-item').hover();
    expect(
      await desktopPage
        .locator(`#idle-entry ${content}`)
        .evaluate((node) => getComputedStyle(node).transform),
    ).toBe(focusedPosition);
    await desktopPage.locator('#idle-entry .track-name').blur();
    expect(await animationName(desktopPage, `#idle-entry ${content}`)).toBe('none');
    await desktopPage.locator('#idle-entry .track-item').hover();
    expect(await animationName(desktopPage, `#idle-entry ${content}`)).toBe('marquee-pingpong');
    await expectMarqueeStart(desktopPage, `#idle-entry ${content}`, 0);
    await desktopPage.locator('#expanded-entry .sub-track-item').hover();
    await expectMarqueeStart(desktopPage, `#expanded-entry .sub-track-item ${content}`, 0);
    await desktopPage.locator('#idle-entry .track-item').hover();
    expect(
      await desktopPage
        .locator(`#idle-entry ${content}`)
        .evaluate((node) => getComputedStyle(node).display),
    ).toBe('inline-block');
    await desktopPage.locator('#short-entry .track-item').hover();
    expect(await animationName(desktopPage, `#short-entry ${content}`)).toBe('none');
  } finally {
    await desktop.close();
  }

  const touch = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const touchPage = await touch.newPage();
  try {
    await mountMarqueeHarness(touchPage);
    expect(
      await touchPage.evaluate(
        () => matchMedia('(hover: none)').matches && matchMedia('(pointer: coarse)').matches,
      ),
    ).toBe(true);
    expect(await animationName(touchPage, `#current-entry ${content}`)).toBe('marquee-pingpong');
    await expectMarqueeStart(touchPage, `#current-entry ${content}`, 1000);
    expect(await animationName(touchPage, `#idle-entry ${content}`)).toBe('none');
    expect(await animationName(touchPage, `#paused-entry ${content}`)).toBe('none');
    // When the exact expanded sub-track is visible, it moves instead of also
    // animating its parent playlist title.
    expect(await animationName(touchPage, `#expanded-entry > .track-item ${content}`)).toBe('none');
    expect(await animationName(touchPage, `#expanded-entry .sub-track-item ${content}`)).toBe(
      'marquee-pingpong',
    );
    await expectMarqueeStart(touchPage, `#expanded-entry .sub-track-item ${content}`, 1000);

    await touchPage.setViewportSize({ width: 844, height: 390 });
    expect(await animationName(touchPage, `#current-entry ${content}`)).toBe('marquee-pingpong');
  } finally {
    await touch.close();
  }

  // The same non-hover coarse pointer must not opt a wide desktop layout into
  // automatic motion. Hover-capable hardware can still use the global hover
  // rule, and keyboard focus remains available on every viewport size.
  const coarseDesktop = await browser.newContext({
    hasTouch: true,
    isMobile: false,
    viewport: { width: 1440, height: 900 },
  });
  const coarseDesktopPage = await coarseDesktop.newPage();
  try {
    await mountMarqueeHarness(coarseDesktopPage);
    expect(
      await coarseDesktopPage.evaluate(
        () => matchMedia('(hover: none)').matches && matchMedia('(pointer: coarse)').matches,
      ),
    ).toBe(true);
    expect(await animationName(coarseDesktopPage, `#current-entry ${content}`)).toBe('none');
    await coarseDesktopPage.locator('#current-entry .track-name').focus();
    expect(await animationName(coarseDesktopPage, `#current-entry ${content}`)).toBe(
      'marquee-pingpong',
    );
  } finally {
    await coarseDesktop.close();
  }

  const reduced = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  const reducedPage = await reduced.newPage();
  try {
    await mountMarqueeHarness(reducedPage);
    expect(await animationName(reducedPage, `#current-entry ${content}`)).toBe('none');
    expect(
      await reducedPage
        .locator(`#current-entry ${content}`)
        .evaluate((node) => getComputedStyle(node).transform),
    ).toBe('matrix(1, 0, 0, 1, 0, 0)');
  } finally {
    await reduced.close();
  }
});
