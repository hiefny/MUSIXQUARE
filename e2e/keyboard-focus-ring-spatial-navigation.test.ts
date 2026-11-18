/**
 * E2E: focus rings follow keyboard navigation under spatial navigation, where
 * the arrow keys move focus as a TV remote's D-pad does.
 *
 * Chromium moves focus with the arrows here from the page, a panel or a plain
 * button alike; Android TV and Google TV WebViews turn it on by default. Such
 * an arrow is keyboard navigation wherever it was pressed, so the control it
 * lands on rings, while a click still draws no ring (e2e/keyboard-focus-ring.test.ts
 * covers the browser without spatial navigation).
 */
import { expect, test } from '@playwright/test';
import {
  DESKTOP,
  emptySpot,
  focusRing,
  openRoomWithTrack,
  openStartScreen,
} from './helpers/focus-ring.ts';

test.use({
  serviceWorkers: 'block',
  colorScheme: 'dark',
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-spatial-navigation',
    ],
  },
});

test('the first arrow from the page rings the control it moves focus to', async ({ page }) => {
  await openStartScreen(page);
  const onPage = () => page.evaluate(() => document.activeElement === document.body);
  expect(await onPage(), 'focus on the page').toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect.poll(onPage).toBe(false);
  expect(await focusRing(page), 'first arrow').toMatchObject({ ring: true });
});

test('an arrow from a clicked panel or a clicked track rings the control it moves focus to', async ({
  page,
}) => {
  await openRoomWithTrack(page, DESKTOP);
  const play = page.locator('#tab-play');
  const spot = await emptySpot(page, '#tab-play');
  await page.mouse.click(spot.x, spot.y);
  await expect(play).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(play).not.toBeFocused();
  expect(await focusRing(page), 'from the panel').toMatchObject({ ring: true });

  const track = page.locator('#playlist-ui button.track-name').first();
  await track.click();
  await expect(track).toBeFocused();
  expect(await focusRing(page), 'the clicked track').toMatchObject({ ring: false });
  await page.keyboard.press('ArrowDown');
  await expect(track).not.toBeFocused();
  expect(await focusRing(page), 'from the track').toMatchObject({ ring: true });
});
