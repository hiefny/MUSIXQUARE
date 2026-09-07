import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

const AUTOPLAY_DWELL_MS = 6_000;
const FIRST_DWELL_MS = 3_000;
const FIRST_EARLY_TRANSITION_GUARD_MS = 2_000;
const TRANSITION_TOLERANCE_MS = 2_000;
const STICKY_STOP_GUARD_MS = AUTOPLAY_DWELL_MS + 350;

async function openSetupCarousel(page: Page): Promise<void> {
  // Browser Insights rejects preview origins in WebKit. Keep that third-party
  // response out of this production-wiring test while preserving app errors.
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);

  const slider = page.locator('#ob-slider-area');
  const nav = slider.locator('.ob-nav-row');
  await expect(slider).toBeVisible();
  // The carousel is already visible while the independent logo/greeting runs.

  // The four-slide welcome surface intentionally exposes only direct
  // navigation. Autoplay has no separate control or visual state badge.
  await expect(page.locator('#ob-autoplay-toggle')).toHaveCount(0);
  await expect(slider).not.toHaveAttribute('data-autoplay', /.+/);
  await expect(nav.locator('button')).toHaveCount(6);
  await expect(nav.locator('#ob-prev, #ob-next')).toHaveCount(2);
  await expect(nav.locator('#ob-dots .ob-dot')).toHaveCount(4);
}

interface CarouselTimingSample {
  index: number;
  at: number;
}
type CarouselTimingWindow = Window & { __mxqrCarouselSamples?: CarouselTimingSample[] };

async function observeVisibleCarouselTiming(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const samples: CarouselTimingSample[] = [];
    (window as CarouselTimingWindow).__mxqrCarouselSamples = samples;
    const observer = new MutationObserver(() => {
      const overlay = document.getElementById('setup-overlay');
      const area = document.getElementById('ob-slider-area');
      if (
        !overlay?.classList.contains('active') ||
        document.documentElement.classList.contains('setup-boot-block') ||
        !area ||
        area.getBoundingClientRect().width === 0 ||
        getComputedStyle(area).visibility !== 'visible'
      )
        return;
      const active = document.querySelector<HTMLElement>('#ob-dots .ob-dot[aria-current="true"]');
      const index = Number(active?.dataset.idx);
      if (!Number.isInteger(index) || samples.at(-1)?.index === index) return;
      samples.push({ index, at: performance.now() });
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-current', 'style'],
    });
  });
}

async function currentSlideIndex(page: Page): Promise<number> {
  const rawIndex = await page
    .locator('#ob-dots .ob-dot[aria-current="true"]')
    .getAttribute('data-idx');
  if (rawIndex === null) throw new Error('Carousel has no current slide');
  const index = Number(rawIndex);
  if (!Number.isInteger(index)) throw new Error(`Invalid active carousel index: ${rawIndex}`);
  return index;
}

async function expectStickyStop(page: Page, expectedIndex: number): Promise<void> {
  await expect(page.locator('#ob-slider-track')).toHaveAttribute('aria-live', 'polite');
  expect(await currentSlideIndex(page)).toBe(expectedIndex);
  await page.waitForTimeout(STICKY_STOP_GUARD_MS);
  expect(await currentSlideIndex(page)).toBe(expectedIndex);
}

async function expectAutoplayDotLabel(dot: Locator, position: string): Promise<void> {
  const label = await dot.getAttribute('aria-label');
  expect(label?.startsWith(`${position}, `)).toBe(true);
  expect(label?.codePointAt(position.length)).toBe(0x2c);
  expect(label?.slice(position.length + 2).trim()).toBeTruthy();
}

async function dispatchTouch(viewport: Locator, startX: number, endX: number): Promise<void> {
  await viewport.evaluate(
    (element, { startX: touchStartX, endX: touchEndX }) => {
      const dispatch = (type: 'touchstart' | 'touchend', clientX: number) => {
        const touch = { identifier: 1, target: element, clientX, clientY: 120 };
        const activeTouches = type === 'touchstart' ? [touch] : [];
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { configurable: true, value: activeTouches },
          targetTouches: { configurable: true, value: activeTouches },
          changedTouches: { configurable: true, value: [touch] },
        });
        element.dispatchEvent(event);
      };

      dispatch('touchstart', touchStartX);
      dispatch('touchend', touchEndX);
    },
    { startX, endX },
  );
}

test.describe('setup carousel unobtrusive autoplay', () => {
  test('advances after three visible seconds, then keeps six-second reading intervals through wrapping', async ({
    page,
  }) => {
    await observeVisibleCarouselTiming(page);
    await openSetupCarousel(page);

    const track = page.locator('#ob-slider-track');
    await expect(track).toHaveAttribute('aria-live', 'off');

    // Capture the initial index before page.goto/load/driver waits can consume
    // part of the shorter first dwell. Observe the sequence instead of assuming
    // that the browser is still on slide zero when the test process catches up.
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as CarouselTimingWindow).__mxqrCarouselSamples?.length ?? 0),
        { timeout: FIRST_DWELL_MS + 4 * AUTOPLAY_DWELL_MS + TRANSITION_TOLERANCE_MS },
      )
      .toBeGreaterThanOrEqual(6);

    const samples = await page.evaluate(() =>
      (window as CarouselTimingWindow).__mxqrCarouselSamples?.slice(0, 6),
    );
    await test.info().attach('carousel-visible-dwell-timings.json', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    });
    expect(samples?.map(({ index }) => index)).toEqual([0, 1, 2, 3, 0, 1]);
    if (!samples) throw new Error('Missing visible carousel timing samples');
    for (let index = 1; index < samples.length; index++) {
      const elapsed = samples[index]!.at - samples[index - 1]!.at;
      const expectedDwell = index === 1 ? FIRST_DWELL_MS : AUTOPLAY_DWELL_MS;
      // DOM observations can land on adjacent frames; allow scheduling delay
      // but reject both an early transition and the former greeting+6s gate.
      expect(elapsed).toBeGreaterThanOrEqual(expectedDwell - 100);
      expect(elapsed).toBeLessThanOrEqual(expectedDwell + TRANSITION_TOLERANCE_MS);
    }

    // 4 -> 1 wrapped and a fifth transition still occurred, proving the
    // untouched carousel continues rather than stopping after one cycle.
    await expect(track).toHaveAttribute('aria-live', 'off');
    await expectAutoplayDotLabel(page.locator('#ob-dots .ob-dot[data-idx="1"]'), '2 / 4');
  });

  test('a dot selection stops rotation at the selected slide', async ({ page }) => {
    await openSetupCarousel(page);

    const target = page.locator('#ob-dots .ob-dot[data-idx="2"]');
    await expectAutoplayDotLabel(target, '3 / 4');
    await target.click();
    await expect(target).toHaveAttribute('aria-label', '3 / 4');
    await expectStickyStop(page, 2);
  });

  test('an arrow wraps manually and stops rotation', async ({ page }) => {
    await openSetupCarousel(page);

    const previous = page.locator('#ob-prev');
    test.skip(!(await previous.isVisible()), 'Arrow controls are hidden in the mobile layout');
    await previous.click();
    await expectStickyStop(page, 3);
  });

  test('a swipe advances once and stops rotation', async ({ page }) => {
    await openSetupCarousel(page);

    await dispatchTouch(page.locator('#ob-slider-viewport'), 300, 180);
    await expectStickyStop(page, 1);
  });

  test('a non-swipe touch stops rotation without changing slides', async ({ page }) => {
    await openSetupCarousel(page);

    await dispatchTouch(page.locator('#ob-slider-viewport'), 240, 240);
    await expectStickyStop(page, 0);
  });

  test('keyboard focus stops rotation without changing slides', async ({ page }) => {
    await openSetupCarousel(page);

    const currentDot = page.locator('#ob-dots .ob-dot[data-idx="0"]');
    await currentDot.focus();
    await expect(currentDot).toBeFocused();
    await expectStickyStop(page, 0);
  });

  test('desktop hover only suspends rotation and restarts a fresh dwell on leave', async ({
    page,
  }) => {
    const hoverCapable = await page.evaluate(() => matchMedia('(any-hover: hover)').matches);
    test.skip(!hoverCapable, 'Desktop hover behavior does not apply to touch-only contexts');
    await openSetupCarousel(page);

    const area = page.locator('#ob-slider-area');
    const track = page.locator('#ob-slider-track');
    await area.hover();
    await page.waitForTimeout(STICKY_STOP_GUARD_MS);
    expect(await currentSlideIndex(page)).toBe(0);
    await expect(track).toHaveAttribute('aria-live', 'off');

    await page.mouse.move(0, 0);
    await page.waitForTimeout(FIRST_EARLY_TRANSITION_GUARD_MS);
    expect(await currentSlideIndex(page)).toBe(0);
    await expect.poll(() => currentSlideIndex(page), { timeout: TRANSITION_TOLERANCE_MS }).toBe(1);
    await expect(track).toHaveAttribute('aria-live', 'off');
  });

  test('keeps reduced-motion users on a manual, transition-free carousel', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openSetupCarousel(page);

    const track = page.locator('#ob-slider-track');
    await expect(track).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#ob-dots .ob-dot[data-idx="0"]')).toHaveAttribute(
      'aria-label',
      '1 / 4',
    );
    await expect
      .poll(() => track.evaluate((element) => getComputedStyle(element).transitionDuration))
      .toBe('0s');

    const initialSlide = await currentSlideIndex(page);
    await page.waitForTimeout(STICKY_STOP_GUARD_MS);
    expect(await currentSlideIndex(page)).toBe(initialSlide);
  });
});
