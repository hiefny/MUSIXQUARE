import { expect, test, type Locator, type Page } from '@playwright/test';
import { uploadFixtures } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { readQueueSnapshot } from './helpers/queue-state.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import {
  clickPlayButton,
  navigateToTab,
  waitForFilePlaybackReady,
  waitForPlaylistCount,
} from './helpers/wait.ts';

interface Point {
  x: number;
  y: number;
}

const TRACK_COUNT = 12;
const LONG_PRESS_MS = 700;

async function scrollTopOf(scroller: Locator): Promise<number> {
  return scroller.evaluate((element) => Math.round(element.scrollTop));
}

async function sampleScrollTop(page: Page, scroller: Locator, ms: number): Promise<number[]> {
  const samples: number[] = [];
  for (let elapsed = 0; elapsed <= ms; elapsed += 100) {
    samples.push(await scrollTopOf(scroller));
    await page.waitForTimeout(100);
  }
  return samples;
}

async function resetScroll(page: Page, scroller: Locator): Promise<void> {
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(250);
}

/** Center of the last element matching `selector` that is fully inside the pane. */
async function lastVisibleCenter(page: Page, selector: string, paneBottom: number): Promise<Point> {
  return page.evaluate(
    ({ selector, paneBottom }) => {
      const visible = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
        (element) => element.getBoundingClientRect().bottom <= paneBottom,
      );
      const rect = visible[visible.length - 1].getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { selector, paneBottom },
  );
}

async function queueOrder(page: Page): Promise<string[]> {
  return (await readQueueSnapshot(page)).items.map((item) => item.queueItemId);
}

test.describe('Playlist desktop reorder', () => {
  // At 1280x720 the playlist shares its column with chat, leaving a pane only
  // a few rows tall: the geometry where edge auto-scroll used to misfire.
  test.use({ viewport: { width: 1280, height: 720 } });

  test('mouse hold, lifted current row, and edge auto-scroll behave on a short pane', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await injectPeerServer(page);
    await setupHostAndStart(page);
    const fixtures = (['test01', 'test02', 'test03'] as const).flatMap((name) => [name, name]);
    await uploadFixtures(page, fixtures);
    await waitForPlaylistCount(page, fixtures.length);
    await uploadFixtures(page, fixtures);
    await waitForPlaylistCount(page, TRACK_COUNT);
    await navigateToTab(page, 'playlist');
    await waitForFilePlaybackReady(page, 30_000);
    await clickPlayButton(page);
    await expect(page.locator('.track-type-slot.playlist-current-leading')).toHaveClass(
      /is-current-playing/,
    );

    const scroller = page.locator('#tab-playlist .tab-body');
    const pane = await scroller.boundingBox();
    if (!pane) throw new Error('Playlist pane has no geometry');
    expect(pane.height).toBeLessThan(400);
    const paneBottom = pane.y + pane.height;
    const middleY = pane.y + pane.height / 2;
    const ghost = page.locator('.playlist-reorder-ghost');

    // 1. Lifting the playing row by its handle shows only the grip.
    await resetScroll(page, scroller);
    const currentHandle = page.locator(
      '.playlist-entry:has(.playlist-current-leading) .playlist-reorder-handle',
    );
    const handleBox = await currentHandle.boundingBox();
    if (!handleBox) throw new Error('Current handle has no geometry');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await expect(ghost).toBeVisible();
    const ghostLeading = await ghost.evaluate((element) => ({
      stateIcons: element.querySelectorAll('.track-playback-state-icon').length,
      currentClass: !!element.querySelector('.playlist-current-leading'),
      gripOpacity: getComputedStyle(element.querySelector('.playlist-reorder-grip')!).opacity,
    }));
    expect(ghostLeading).toEqual({ stateIcons: 0, currentClass: false, gripOpacity: '1' });
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
    await page.waitForTimeout(500);

    // 2. Grabbing the bottom visible row never scrolls by itself; moving to
    // the edge scrolls, and returning to the middle stops on the spot.
    await resetScroll(page, scroller);
    const edgeHandle = await lastVisibleCenter(page, '.playlist-reorder-handle', paneBottom);
    await page.mouse.move(edgeHandle.x, edgeHandle.y);
    await page.mouse.down();
    await expect(ghost).toBeVisible();
    expect(new Set(await sampleScrollTop(page, scroller, 600))).toEqual(new Set([0]));
    await page.mouse.move(edgeHandle.x, middleY, { steps: 4 });
    await page.mouse.move(edgeHandle.x, paneBottom - 3, { steps: 4 });
    await expect.poll(() => scrollTopOf(scroller)).toBeGreaterThan(100);
    await page.mouse.move(edgeHandle.x, middleY, { steps: 4 });
    const settled = await sampleScrollTop(page, scroller, 1_000);
    expect(new Set(settled.slice(1)).size).toBe(1);
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
    await page.waitForTimeout(500);

    // 3. A short click on a title still plays that row.
    await resetScroll(page, scroller);
    const orderBeforeClick = await queueOrder(page);
    const clickTarget = page.locator('.playlist-entry[data-queue-item-id]').nth(2);
    await clickTarget.locator('.track-name').click();
    await expect
      .poll(async () => (await readQueueSnapshot(page)).currentQueueItemId)
      .toBe(orderBeforeClick[2]);
    expect(await queueOrder(page)).toEqual(orderBeforeClick);
    await navigateToTab(page, 'playlist');

    // 4. Outside edit mode a stationary mouse hold on the row body selects
    // that row and enters edit mode; the release neither plays nor toggles it.
    await resetScroll(page, scroller);
    const before = await readQueueSnapshot(page);
    const title = page.locator('.playlist-entry[data-queue-item-id] .track-name').nth(0);
    const titleBox = await title.boundingBox();
    if (!titleBox) throw new Error('Title has no geometry');
    const start = { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 };
    const firstSelect = page.locator('#playlist-ui .btn-playlist-select').nth(0);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.waitForTimeout(LONG_PRESS_MS + 300);
    await expect(firstSelect).toHaveAttribute('aria-pressed', 'true');
    await expect(ghost).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(firstSelect).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.playlist-selection-title')).toHaveText('1 selected');
    expect((await readQueueSnapshot(page)).currentQueueItemId).toBe(before.currentQueueItemId);

    // 5. In edit mode the same hold moves the held row, and the release does
    // not also play it.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.waitForTimeout(LONG_PRESS_MS - 250);
    await expect(ghost).toHaveCount(0);
    await expect(ghost).toBeVisible({ timeout: 1_000 });
    await page.mouse.move(start.x, start.y + 64 * 2 + 16, { steps: 6 });
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
    const expected = [...before.items.map((item) => item.queueItemId)];
    const [moved] = expected.splice(0, 1);
    expected.splice(2, 0, moved);
    await expect.poll(() => queueOrder(page)).toEqual(expected);
    expect((await readQueueSnapshot(page)).currentQueueItemId).toBe(before.currentQueueItemId);
    // The moved row is still the one picked.
    await expect(page.locator('#playlist-ui .btn-playlist-select').nth(2)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.playlist-selection-title')).toHaveText('1 selected');
  });
});
