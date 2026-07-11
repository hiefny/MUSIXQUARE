import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { uploadFixtures } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { readQueueSnapshot, waitForCurrentQueueItemId } from './helpers/queue-state.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToTab, waitForPlaylistCount } from './helpers/wait.ts';

interface TouchPoint {
  x: number;
  y: number;
}

async function centerOf(locator: Locator): Promise<TouchPoint> {
  await locator.scrollIntoViewIfNeeded();
  await locator.waitFor({ state: 'visible' });
  const box = await locator.boundingBox();
  if (!box) throw new Error('Touch target has no browser geometry');
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

async function touchStart(cdp: CDPSession, point: TouchPoint): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
}

async function touchMove(cdp: CDPSession, point: TouchPoint): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
}

async function touchEnd(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

async function quickTap(cdp: CDPSession, point: TouchPoint): Promise<void> {
  await touchStart(cdp, point);
  await touchEnd(cdp);
}

async function resetPlaylistScroll(page: Page): Promise<void> {
  await page.locator('#tab-playlist .tab-body').evaluate((scroller) => {
    scroller.scrollTop = 0;
  });
  // The reorder controller intentionally treats a recent scroll as momentum.
  // Let that guard settle so each gesture below proves its own disqualifier.
  await page.waitForTimeout(200);
}

test.describe('Playlist touch reorder', () => {
  test.use({
    viewport: { width: 390, height: 568 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });

  test('stationary 700 ms long-press activates reorder, but a scrolled contact stays disqualified', async ({
    page,
  }) => {
    await injectPeerServer(page);
    await setupHostAndStart(page);

    // Enough real uploaded queue occurrences to make the mobile playlist a
    // native vertical scroller. Duplicate files still receive distinct IDs.
    await uploadFixtures(page, [
      'test01',
      'test02',
      'test03',
      'test01',
      'test02',
      'test03',
      'test01',
      'test02',
      'test03',
    ]);
    await waitForPlaylistCount(page, 9);
    await navigateToTab(page, 'playlist');

    await expect
      .poll(() =>
        page.evaluate(() => ({
          coarse: matchMedia('(pointer: coarse)').matches,
          touchPoints: navigator.maxTouchPoints,
        })),
      )
      .toEqual({ coarse: true, touchPoints: 1 });

    const before = await readQueueSnapshot(page);
    expect(before.items).toHaveLength(9);
    const originalOrder = before.items.map((item) => item.queueItemId);
    const cdp = await page.context().newCDPSession(page);
    const rows = page.locator('.playlist-entry[data-queue-item-id] .track-item');
    const ghost = page.locator('.playlist-reorder-ghost');

    // The row X is an interactive child: holding it past the reorder threshold
    // must only toggle deletion selection after release, never arm a drag.
    const firstRemoveButton = page.locator('.btn-playlist-remove').first();
    const firstHandle = page.locator('.playlist-reorder-handle').first();
    const controlGeometry = await Promise.all(
      [firstHandle, firstRemoveButton].map((control) =>
        control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const radius = getComputedStyle(element).borderRadius;
          return { width: rect.width, height: rect.height, radius };
        }),
      ),
    );
    expect(controlGeometry[0]).toEqual(controlGeometry[1]);
    expect(controlGeometry[0]).toEqual({ width: 44, height: 44, radius: '999px' });

    const removePoint = await centerOf(firstRemoveButton);
    await touchStart(cdp, removePoint);
    try {
      await page.waitForTimeout(800);
      await expect(ghost).toHaveCount(0);
      await expect(page.locator('body')).not.toHaveClass(/playlist-reorder-active/);
    } finally {
      await touchEnd(cdp);
    }
    await expect(firstRemoveButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.playlist-selection-pill')).toHaveClass(/is-visible/);
    await expect(page.locator('.playlist-selection-count')).toHaveText('1');

    const actionSizes = await page.locator('.playlist-selection-action').evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(actionSizes).toHaveLength(3);
    expect(actionSizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);

    const selectAllAction = page.locator('[data-selection-action="select-all"]');
    await quickTap(cdp, await centerOf(selectAllAction));
    await expect(selectAllAction).toHaveAttribute('aria-pressed', 'true');
    await quickTap(cdp, await centerOf(page.locator('[data-selection-action="cancel"]')));
    await expect(firstRemoveButton).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.playlist-selection-pill')).not.toHaveClass(/is-visible/);

    // A short touch on the non-interactive row body must retain the existing
    // tap-to-play behavior.
    await resetPlaylistScroll(page);
    const tapTargetId = originalOrder[2];
    await quickTap(cdp, await centerOf(rows.nth(2).locator('.track-name')));
    await waitForCurrentQueueItemId(page, tapTargetId);
    const afterTap = await readQueueSnapshot(page);
    expect(afterTap.items.map((item) => item.queueItemId)).toEqual(originalOrder);

    // Selecting a row returns to the player tab. Re-enter the playlist before
    // exercising the two reorder gestures.
    await navigateToTab(page, 'playlist');

    // A truly stationary row-body contact must not activate early, then must
    // cross the production 700 ms threshold and create the real drag ghost.
    await resetPlaylistScroll(page);
    const longPressPoint = await centerOf(rows.nth(1).locator('.track-name'));
    await touchStart(cdp, longPressPoint);
    try {
      await page.waitForTimeout(600);
      await expect(ghost).toHaveCount(0);
      await expect(ghost).toBeVisible({ timeout: 500 });
      await expect(page.locator('body')).toHaveClass(/playlist-reorder-active/);
      const activeDragColors = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--primary)';
        document.body.appendChild(probe);
        const primary = getComputedStyle(probe).color;
        probe.remove();
        return {
          primary,
          source: getComputedStyle(
            document.querySelector<HTMLElement>(
              '.playlist-entry.is-reorder-source .playlist-reorder-handle',
            )!,
          ).color,
          ghost: getComputedStyle(
            document.querySelector<HTMLElement>(
              '.playlist-reorder-ghost .playlist-reorder-handle',
            )!,
          ).color,
        };
      });
      expect(activeDragColors.source).toBe(activeDragColors.primary);
      expect(activeDragColors.ghost).toBe(activeDragColors.primary);
    } finally {
      await touchEnd(cdp);
    }
    await expect(ghost).toHaveCount(0);
    const idleHandleColor = await firstHandle.evaluate((handle) => getComputedStyle(handle).color);
    const mutedColor = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-muted)';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(idleHandleColor).toBe(mutedColor);
    expect((await readQueueSnapshot(page)).items.map((item) => item.queueItemId)).toEqual(
      originalOrder,
    );
    await waitForCurrentQueueItemId(page, tapTargetId);

    // Now start another row-body contact, move it enough to produce an actual
    // browser-native scroll, and keep the same finger down well beyond 700 ms.
    // Once scrolling begins, pausing to think must never arm drag reorder.
    await resetPlaylistScroll(page);
    const scrollTarget = await centerOf(rows.nth(3).locator('.track-name'));
    const scrollTopBefore = await page
      .locator('#tab-playlist .tab-body')
      .evaluate((scroller) => scroller.scrollTop);
    await touchStart(cdp, scrollTarget);
    try {
      for (const deltaY of [18, 42, 72, 108]) {
        await touchMove(cdp, { x: scrollTarget.x, y: scrollTarget.y - deltaY });
        await page.waitForTimeout(24);
      }

      await expect
        .poll(() =>
          page.locator('#tab-playlist .tab-body').evaluate((scroller) => scroller.scrollTop),
        )
        .toBeGreaterThan(scrollTopBefore);
      await expect(ghost).toHaveCount(0);

      // This is intentionally longer than the 700 ms arming delay. No further
      // move is sent: the contact remains down and stationary after scrolling.
      await page.waitForTimeout(900);
      await expect(ghost).toHaveCount(0);
      await expect(page.locator('body')).not.toHaveClass(/playlist-reorder-active/);
    } finally {
      await touchEnd(cdp);
    }

    const afterScroll = await readQueueSnapshot(page);
    expect(afterScroll.items.map((item) => item.queueItemId)).toEqual(originalOrder);
    expect(afterScroll.revision).toBe(afterTap.revision);
    await waitForCurrentQueueItemId(page, tapTargetId);
  });
});
