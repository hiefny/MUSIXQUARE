import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

const AUTOPLAY_DWELL_MS = 6_000;
const EARLY_TRANSITION_GUARD_MS = 5_000;
const TRANSITION_TOLERANCE_MS = 2_000;
const STICKY_PAUSE_GUARD_MS = AUTOPLAY_DWELL_MS + 350;

async function openSetupCarousel(page: Page): Promise<void> {
  // Browser Insights rejects preview origins in WebKit. Keep that third-party
  // response out of this production-wiring test while preserving app errors.
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);
  await expect(page.locator('#ob-slider-area')).toBeVisible();
  await expect(page.locator('#ob-autoplay-toggle')).toBeVisible();
  // The first dwell intentionally starts only after the logo hands off to the
  // greeting, so anchor real-time assertions to that production lifecycle gate.
  await expect(page.locator('.setup-greeting-row').first()).toHaveClass(/is-visible/);
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

async function expectAutoplayState(
  slider: Locator,
  toggle: Locator,
  state: 'playing' | 'paused',
): Promise<void> {
  await expect(slider).toHaveAttribute('data-autoplay', state);
  await expect(toggle).toHaveAttribute('data-state', state);
}

async function dispatchSuccessfulSwipeLeft(viewport: Locator): Promise<void> {
  await viewport.evaluate((element) => {
    const dispatchTouch = (
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

    dispatchTouch('touchstart', 'touches', 300);
    dispatchTouch('touchend', 'changedTouches', 180);
  });
}

test.describe('setup carousel controlled autoplay', () => {
  test('uses the production dwell and requires explicit resume after manual navigation', async ({
    page,
  }) => {
    await openSetupCarousel(page);

    const slider = page.locator('#ob-slider-area');
    const track = page.locator('#ob-slider-track');
    const toggle = page.locator('#ob-autoplay-toggle');

    await expectAutoplayState(slider, toggle, 'playing');
    await expect(track).toHaveAttribute('aria-live', 'off');

    const initialSlide = await currentSlideIndex(page);
    await page.mouse.move(0, 0);
    await expect
      .poll(() => currentSlideIndex(page), {
        timeout: AUTOPLAY_DWELL_MS + TRANSITION_TOLERANCE_MS,
      })
      .toBe((initialSlide + 1) % 4);

    // Restart the one-shot timer at a known point so this assertion covers the
    // configured six-second dwell rather than time spent bootstrapping.
    const playingLabel = await toggle.getAttribute('aria-label');
    expect(playingLabel).toBeTruthy();
    await toggle.click();
    await expectAutoplayState(slider, toggle, 'paused');
    await expect(track).toHaveAttribute('aria-live', 'polite');
    const pausedLabel = await toggle.getAttribute('aria-label');
    expect(pausedLabel).toBeTruthy();
    expect(pausedLabel).not.toBe(playingLabel);

    await page.locator('#ob-dots .ob-dot[data-idx="3"]').click();
    expect(await currentSlideIndex(page)).toBe(3);
    await toggle.click();
    await expectAutoplayState(slider, toggle, 'playing');
    await expect(track).toHaveAttribute('aria-live', 'off');
    // A real pointer click temporarily hovers the control; leaving the carousel
    // begins the fresh dwell that a desktop user receives after pressing Play.
    await page.mouse.move(0, 0);

    const beforeTimer = await currentSlideIndex(page);
    // Intentional real-time guard: this E2E test verifies the built app's timer,
    // while the unit suite owns synthetic-timer edge cases.
    await page.waitForTimeout(EARLY_TRANSITION_GUARD_MS);
    expect(await currentSlideIndex(page)).toBe(beforeTimer);
    await expect
      .poll(() => currentSlideIndex(page), { timeout: TRANSITION_TOLERANCE_MS })
      .toBe((beforeTimer + 1) % 4);
    expect((beforeTimer + 1) % 4).toBe(0);

    const manualTarget = 2;
    await page.locator(`#ob-dots .ob-dot[data-idx="${manualTarget}"]`).click();
    await expectAutoplayState(slider, toggle, 'paused');
    await expect(track).toHaveAttribute('aria-live', 'polite');
    expect(await currentSlideIndex(page)).toBe(manualTarget);

    // A dot selection is sticky: it must not silently restart after one dwell.
    await page.waitForTimeout(STICKY_PAUSE_GUARD_MS);
    expect(await currentSlideIndex(page)).toBe(manualTarget);

    // A successful mobile swipe is another explicit navigation and remains
    // sticky-paused. dispatchEvent exercises the same touch listeners in both
    // desktop Chromium and the real iPhone/WebKit lane.
    await toggle.click();
    await expectAutoplayState(slider, toggle, 'playing');
    const viewport = page.locator('#ob-slider-viewport');
    await dispatchSuccessfulSwipeLeft(viewport);
    await expectAutoplayState(slider, toggle, 'paused');
    expect(await currentSlideIndex(page)).toBe((manualTarget + 1) % 4);
  });

  test('keeps reduced-motion users on a manual, transition-free carousel', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    // This helper's visible-toggle assertion is intentionally bypassed because
    // reduced motion removes the autoplay affordance altogether.
    await page.route('https://static.cloudflareinsights.com/**', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await waitForBootstrapReady(page);

    const slider = page.locator('#ob-slider-area');
    const track = page.locator('#ob-slider-track');
    const toggle = page.locator('#ob-autoplay-toggle');
    await expect(slider).toBeVisible();
    await expect(page.locator('.setup-greeting-row').first()).toHaveClass(/is-visible/);
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toBeHidden();
    await expectAutoplayState(slider, toggle, 'paused');
    await expect(track).toHaveAttribute('aria-live', 'polite');
    await expect
      .poll(() => track.evaluate((element) => getComputedStyle(element).transitionDuration))
      .toBe('0s');

    const initialSlide = await currentSlideIndex(page);
    // Intentional real-time guard: no autoplay callback may survive reduced
    // motion even after a complete production dwell has elapsed.
    await page.waitForTimeout(STICKY_PAUSE_GUARD_MS);
    expect(await currentSlideIndex(page)).toBe(initialSlide);
  });
});
