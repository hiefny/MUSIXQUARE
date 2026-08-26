import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

const AUTOPLAY_DWELL_MS = 6_000;
const EARLY_TRANSITION_GUARD_MS = 5_000;
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
  await expect(page.locator('.setup-greeting-row').first()).toHaveClass(/is-visible/);

  // The four-slide welcome surface intentionally exposes only direct
  // navigation. Autoplay has no separate control or visual state badge.
  await expect(page.locator('#ob-autoplay-toggle')).toHaveCount(0);
  await expect(slider).not.toHaveAttribute('data-autoplay', /.+/);
  await expect(nav.locator('button')).toHaveCount(6);
  await expect(nav.locator('#ob-prev, #ob-next')).toHaveCount(2);
  await expect(nav.locator('#ob-dots .ob-dot')).toHaveCount(4);
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
      const dispatch = (
        type: 'touchstart' | 'touchend',
        property: 'touches' | 'changedTouches',
        clientX: number,
      ) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, property, {
          configurable: true,
          value: [{ clientX, clientY: 120 }],
        });
        element.dispatchEvent(event);
      };

      dispatch('touchstart', 'touches', touchStartX);
      dispatch('touchend', 'changedTouches', touchEndX);
    },
    { startX, endX },
  );
}

test.describe('setup carousel unobtrusive autoplay', () => {
  test('advances every six seconds, wraps, and keeps rotating while untouched', async ({
    page,
  }) => {
    await openSetupCarousel(page);

    const track = page.locator('#ob-slider-track');
    await expect(track).toHaveAttribute('aria-live', 'off');
    expect(await currentSlideIndex(page)).toBe(0);

    // The first dwell starts only after the logo hands off to the greeting.
    // Guard the configured delay in real time; unit tests own fake-timer edges.
    await page.waitForTimeout(EARLY_TRANSITION_GUARD_MS);
    expect(await currentSlideIndex(page)).toBe(0);

    for (const expectedIndex of [1, 2, 3, 0, 1]) {
      await expect
        .poll(() => currentSlideIndex(page), { timeout: TRANSITION_TOLERANCE_MS + 6_000 })
        .toBe(expectedIndex);
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
    await page.waitForTimeout(EARLY_TRANSITION_GUARD_MS);
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
