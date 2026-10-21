import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { uploadFixtures } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { readQueueSnapshot } from './helpers/queue-state.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToTab, waitForPlaylistCount } from './helpers/wait.ts';

interface Point {
  x: number;
  y: number;
}

const FIXTURES: Parameters<typeof uploadFixtures>[1] = [
  'test01',
  'test02',
  'test03',
  'test01',
  'test02',
];

async function openFiveTrackPlaylist(page: Page, phone: boolean): Promise<void> {
  await injectPeerServer(page);
  await setupHostAndStart(page);
  await uploadFixtures(page, FIXTURES);
  await waitForPlaylistCount(page, FIXTURES.length);
  if (phone) await navigateToTab(page, 'playlist');
  // Let the list's entrance motion settle before measuring.
  await page.waitForTimeout(800);
}

async function centerOf(locator: Locator): Promise<Point> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Target has no geometry');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function pressedStates(page: Page): Promise<string[]> {
  return page
    .locator('#playlist-ui .btn-playlist-select')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-pressed') ?? ''));
}

async function currentQueueItemId(page: Page): Promise<unknown> {
  return page.evaluate(() =>
    (
      window as unknown as { __MUSIXQUARE_GET_STATE__: (path: string) => unknown }
    ).__MUSIXQUARE_GET_STATE__('playlist.currentQueueItemId'),
  );
}

function selected(indices: number[], total = FIXTURES.length): string[] {
  return Array.from({ length: total }, (_, index) => String(indices.includes(index)));
}

async function selectionFills(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('#playlist-ui > .playlist-entry'),
      (entry) => {
        const fill = getComputedStyle(entry, '::before');
        const rect = entry.getBoundingClientRect();
        return {
          background: fill.backgroundColor,
          radius: fill.borderRadius,
          top: fill.top,
          entryTop: rect.top,
          entryBottom: rect.bottom,
        };
      },
    ),
  );
}

async function cssColor(page: Page, value: string): Promise<string> {
  return page.evaluate((color) => {
    const probe = document.createElement('span');
    probe.style.color = color;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, value);
}

test.describe('Playlist edit mode (mouse)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('check circles enter edit mode and paint joined blocks and lone pills', async ({ page }) => {
    test.setTimeout(90_000);
    await openFiveTrackPlaylist(page, false);
    const checks = page.locator('#playlist-ui .btn-playlist-select');
    await expect(checks).toHaveCount(5);
    await expect(page.locator('#playlist-ui .btn-playlist-remove')).toHaveCount(0);

    // The check sits after the title, where the X was.
    const order = await page
      .locator('#playlist-ui .track-item')
      .first()
      .evaluate((row) => Array.from(row.children, (child) => child.className.split(' ')[0]));
    expect(order.at(-1)).toBe('btn-playlist-select');
    expect(order.at(-2)).toBe('track-name');

    for (const index of [0, 1, 3]) await checks.nth(index).click();
    await expect(page.locator('.playlist-selection-title')).toHaveText('3 selected');
    expect(await pressedStates(page)).toEqual(selected([0, 1, 3]));
    // Reorder stays off while editing.
    await expect(page.locator('.playlist-reorder-handle').first()).toBeDisabled();

    // Let the fill's color transition finish.
    await page.waitForTimeout(400);
    const fills = await selectionFills(page);
    const transparent = 'rgba(0, 0, 0, 0)';
    expect(fills[0]).toMatchObject({ radius: '28px 28px 0px 0px', top: '0px' });
    expect(fills[1]).toMatchObject({ radius: '0px 0px 28px 28px', top: '-8px' });
    expect(fills[3]).toMatchObject({ radius: '999px', top: '0px' });
    expect(fills[2]!.background).toBe(transparent);
    expect(fills[4]!.background).toBe(transparent);
    expect(fills[0]!.background).not.toBe(transparent);
    expect(fills[1]!.background).toBe(fills[0]!.background);
    expect(fills[3]!.background).toBe(fills[0]!.background);
    // Row 2's fill starts exactly where row 1 ends: one seamless block.
    expect(Math.abs(fills[1]!.entryTop - 8 - fills[0]!.entryBottom)).toBeLessThan(0.5);
    // The single pill's corners equal the block's: half the 56px row.
    expect(fills[3]!.entryBottom - fills[3]!.entryTop).toBeCloseTo(56, 0);

    // A selected row shows the language list's check in the brand blue and
    // hides its minus.
    const selectedLook = await checks.nth(0).evaluate((button) => ({
      color: getComputedStyle(button).color,
      minus: getComputedStyle(button.querySelector('.playlist-select-minus')!).opacity,
      mark: getComputedStyle(button.querySelector('.playlist-select-mark')!).opacity,
    }));
    expect(selectedLook).toEqual({
      color: await cssColor(page, 'var(--primary)'),
      minus: '0',
      mark: '1',
    });

    // The panel holds three circular icon buttons: move (the room has other
    // playlists), delete and close.
    const actions = page.locator('.playlist-selection-bar .playlist-selection-action');
    await expect(actions).toHaveCount(3);
    const actionLooks = await actions.evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          label: button.getAttribute('aria-label'),
          title: button.getAttribute('title'),
          text: button.textContent?.trim(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          radius: style.borderRadius,
          background: style.backgroundColor,
          color: style.color,
          icon: !!button.querySelector('svg path'),
        };
      }),
    );
    expect(actionLooks).toEqual([
      {
        label: 'Move',
        title: 'Move',
        text: '',
        width: 54,
        height: 54,
        radius: '999px',
        background: await cssColor(page, 'var(--primary-filled)'),
        color: 'rgb(255, 255, 255)',
        icon: true,
      },
      {
        label: 'Delete',
        title: 'Delete',
        text: '',
        width: 54,
        height: 54,
        radius: '999px',
        background: await cssColor(page, 'var(--danger-filled)'),
        color: 'rgb(255, 255, 255)',
        icon: true,
      },
      {
        label: 'Cancel',
        title: 'Cancel',
        text: '',
        width: 54,
        height: 54,
        radius: '999px',
        background: await cssColor(page, 'var(--surface-2)'),
        color: await cssColor(page, 'var(--text-main)'),
        icon: true,
      },
    ]);

    await page.locator('[data-selection-action="cancel"]').click();
    await expect(page.locator('.playlist-selection-bar')).toBeHidden();
    expect(await pressedStates(page)).toEqual(selected([]));
    await expect(page.locator('.playlist-reorder-handle').first()).toBeEnabled();
  });

  test('dragging along the check column selects and deselects ranges', async ({ page }) => {
    test.setTimeout(90_000);
    await openFiveTrackPlaylist(page, false);
    const checks = page.locator('#playlist-ui .btn-playlist-select');
    const before = await readQueueSnapshot(page);
    const currentBefore = await currentQueueItemId(page);

    const drag = async (from: number, to: number) => {
      const start = await centerOf(checks.nth(from));
      const end = await centerOf(checks.nth(to));
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let step = 1; step <= 8; step += 1) {
        await page.mouse.move(start.x, start.y + ((end.y - start.y) * step) / 8);
      }
      await page.mouse.up();
    };

    await drag(0, 3);
    expect(await pressedStates(page)).toEqual(selected([0, 1, 2, 3]));
    await expect(page.locator('.playlist-selection-title')).toHaveText('4 selected');

    // Starting on a selected row deselects what the drag passes.
    await drag(1, 2);
    expect(await pressedStates(page)).toEqual(selected([0, 3]));

    // Nothing played and nothing moved.
    const afterDrag = await readQueueSnapshot(page);
    expect(afterDrag.items.map((item) => item.queueItemId)).toEqual(
      before.items.map((item) => item.queueItemId),
    );
    expect(await currentQueueItemId(page)).toBe(currentBefore);

    await page.locator('[data-selection-action="delete"]').click();
    await waitForPlaylistCount(page, 3);
    const after = await readQueueSnapshot(page);
    expect(after.items.map((item) => item.queueItemId)).toEqual(
      [1, 2, 4].map((index) => before.items[index]!.queueItemId),
    );
    await expect(page.locator('.playlist-selection-bar')).toBeHidden();
  });

  test('in edit mode a title tap selects the row instead of playing it', async ({ page }) => {
    test.setTimeout(90_000);
    await openFiveTrackPlaylist(page, false);
    const checks = page.locator('#playlist-ui .btn-playlist-select');
    const titles = page.locator('#playlist-ui .track-name');
    const currentBefore = await currentQueueItemId(page);

    await checks.nth(0).click();
    await titles.nth(2).click();
    expect(await pressedStates(page)).toEqual(selected([0, 2]));
    await titles.nth(0).click();
    expect(await pressedStates(page)).toEqual(selected([2]));
    // The number column is part of the row while picking. It takes no pointer
    // events then, so click its spot rather than the element.
    const number = await centerOf(page.locator('#playlist-ui .playlist-reorder-handle').nth(4));
    await page.mouse.click(number.x, number.y);
    expect(await pressedStates(page)).toEqual(selected([2, 4]));
    await page.mouse.click(number.x, number.y);
    expect(await pressedStates(page)).toEqual(selected([2]));
    expect(await currentQueueItemId(page)).toBe(currentBefore);

    // Deselecting the last row by its title ends edit mode, and titles play again.
    await titles.nth(2).click();
    await expect(page.locator('.playlist-selection-bar')).toBeHidden();
    await titles.nth(3).click();
    await expect.poll(() => currentQueueItemId(page)).not.toBe(currentBefore);
  });

  test('edit mode folds YouTube playlists and restores each expansion', async ({ page }) => {
    test.setTimeout(90_000);
    await openFiveTrackPlaylist(page, false);
    await page.evaluate(() => {
      const w = window as unknown as {
        __MUSIXQUARE_GET_STATE__: (path: string) => unknown;
        __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
      };
      w.__MUSIXQUARE_SET_STATE__('youtube.subItemsMap', {
        PL_edit_open: { ids: ['vopen000001', 'vopen000002'], titles: ['Open one', 'Open two'] },
      });
      const items = w.__MUSIXQUARE_GET_STATE__('playlist.items') as unknown[];
      w.__MUSIXQUARE_SET_STATE__('playlist.items', [
        ...items,
        {
          queueItemId: '00000000-0000-4000-8000-0000000000e1',
          type: 'youtube',
          name: 'Open list',
          title: 'Open list',
          videoId: 'vopen000001',
          playlistId: 'PL_edit_open',
          isExpanded: true,
        },
        {
          queueItemId: '00000000-0000-4000-8000-0000000000e2',
          type: 'youtube',
          name: 'Closed list',
          title: 'Closed list',
          videoId: 'vclosed0001',
          playlistId: 'PL_edit_closed',
          isExpanded: false,
        },
      ]);
    });
    await waitForPlaylistCount(page, 7);
    const subList = page.locator('#playlist-ui .sub-playlist');
    const toggles = page.locator('#playlist-ui .expand-toggle');
    await expect(subList).toHaveCount(1);
    await expect(subList).toBeVisible();
    await expect(toggles).toHaveCount(2);

    await page.locator('#playlist-ui .btn-playlist-select').first().click();
    await expect(subList).toBeHidden();
    await expect(toggles.nth(0)).toBeHidden();
    await expect(toggles.nth(1)).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(page.locator('.playlist-selection-bar')).toBeHidden();
    await expect(subList).toBeVisible();
    await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggles.nth(1)).toBeVisible();
  });
});

test.describe('Playlist edit mode (touch)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });

  async function touch(
    cdp: CDPSession,
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: Point[],
  ): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((point, index) => ({
        ...point,
        id: index + 1,
        radiusX: 1,
        radiusY: 1,
        force: 1,
      })),
    });
  }

  /** Moves the contact(s) in steps, then rests before lifting like a finger. */
  async function swipe(
    page: Page,
    cdp: CDPSession,
    from: number,
    to: number,
    at: (y: number) => Point[],
  ): Promise<void> {
    await touch(cdp, 'touchStart', at(from));
    for (let step = 1; step <= 10; step += 1) {
      await touch(cdp, 'touchMove', at(from + ((to - from) * step) / 10));
    }
    // Synthetic contacts that lift while still moving read as a fling, and
    // Chromium then swallows the next tap as the fling's stop.
    await page.waitForTimeout(250);
    await touch(cdp, 'touchMove', at(to));
    await touch(cdp, 'touchEnd', []);
  }

  test('a check-column swipe and a two-finger pan select ranges without scrolling', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openFiveTrackPlaylist(page, true);
    const cdp = await page.context().newCDPSession(page);
    const checks = page.locator('#playlist-ui .btn-playlist-select');
    const scroller = page.locator('#tab-playlist .tab-body');
    const scrollTop = () => scroller.evaluate((element) => element.scrollTop);
    const currentBefore = await currentQueueItemId(page);

    // One finger along the check column.
    const start = await centerOf(checks.nth(0));
    const end = await centerOf(checks.nth(3));
    const scrollBefore = await scrollTop();
    await swipe(page, cdp, start.y, end.y, (y) => [{ x: start.x, y }]);
    expect(await pressedStates(page)).toEqual(selected([0, 1, 2, 3]));
    expect(await scrollTop()).toBe(scrollBefore);
    await expect(page.locator('.playlist-selection-bar')).toBeVisible();

    const cancel = await centerOf(page.locator('[data-selection-action="cancel"]'));
    await touch(cdp, 'touchStart', [cancel]);
    await touch(cdp, 'touchEnd', []);
    await expect(page.locator('.playlist-selection-bar')).toBeHidden();

    // Two fingers on the row bodies, moving down together.
    const titles = page.locator('#playlist-ui .track-name');
    const from = await centerOf(titles.nth(1));
    const to = await centerOf(titles.nth(3));
    await swipe(page, cdp, from.y, to.y, (y) => [
      { x: from.x - 40, y },
      { x: from.x + 40, y },
    ]);
    expect(await pressedStates(page)).toEqual(selected([1, 2, 3]));
    expect(await scrollTop()).toBe(scrollBefore);
    await expect(page.locator('.playlist-selection-title')).toHaveText('3 selected');
    // Neither gesture played a row.
    expect(await currentQueueItemId(page)).toBe(currentBefore);

    await touch(cdp, 'touchStart', [cancel]);
    await touch(cdp, 'touchEnd', []);
    await expect(page.locator('.playlist-selection-bar')).toBeHidden();
  });
});
