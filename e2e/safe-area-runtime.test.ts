import { expect, test, type Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';

// safe-area-layout.test.ts stages the app's markup and CSS without its runtime.
// These rows enter a real room instead, because runtime inline styles take part
// in the geometry: the custom scrollbar, for one, positions the parent of every
// scroll container it adopts. The insets come from Chromium's DevTools
// emulation of env(safe-area-inset-*); they are not measured on a device.

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Sample {
  name: string;
  width: number;
  height: number;
  insets: Insets;
  locale?: string;
}

const tablet: Insets = { top: 24, right: 0, bottom: 20, left: 0 };
const samples: Sample[] = [
  { name: 'tablet landscape', width: 1024, height: 768, insets: tablet },
  { name: 'tablet portrait', width: 768, height: 1024, insets: tablet },
  {
    name: 'phone landscape',
    width: 844,
    height: 390,
    insets: { top: 0, right: 47, bottom: 21, left: 47 },
  },
  { name: 'tablet landscape without insets', width: 1024, height: 768, insets: none() },
  {
    name: 'right-to-left tablet landscape',
    width: 1024,
    height: 768,
    insets: tablet,
    locale: 'ar',
  },
  {
    name: 'right-to-left phone landscape with a left-only cutout',
    width: 844,
    height: 390,
    insets: { top: 0, right: 0, bottom: 21, left: 47 },
    locale: 'ar',
  },
];
const TABS = ['play', 'playlist', 'connect', 'settings', 'guide'] as const;
const PLAY_LAST_ROW_ACTIONS = ['btn-sync', 'btn-media-source'] as const;
const TOLERANCE_PX = 1;

function none(): Insets {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

// The list panes end at the home indicator, so no scroll position paints into
// it. The Play pane is a composed screen: cut there, its last row of actions
// showed three quarters of a button on a 1024x768 tablet. Its scrollport
// reaches the bottom edge of the screen instead.
function paneBottom(tab: (typeof TABS)[number], sample: Sample): number {
  return tab === 'play' ? sample.height : sample.height - sample.insets.bottom;
}

async function expectPlayPaneShowsItsLastRow(
  page: Page,
  sample: Sample,
  label: string,
): Promise<void> {
  for (const id of PLAY_LAST_ROW_ACTIONS) {
    const action = page.locator(`#${id}`);
    await expect(action, `${label} #${id}`).toBeVisible();
    const box = (await action.boundingBox())!;
    // Below the fold the row is reached by scrolling; on the screen it must
    // be painted down to its own bottom edge, not cut by the pane.
    if (box.y + box.height > sample.height) continue;
    const painted = await action.evaluate(
      (node, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit !== null && node.contains(hit);
      },
      { x: box.x + box.width / 2, y: box.y + box.height - 2 },
    );
    expect(painted, `${label} #${id} is painted down to its bottom edge`).toBe(true);
  }
  // The pane's end padding grows by the bottom inset, so the end of the
  // scroll still lifts the content clear of the home indicator.
  const contentEnd = await page.locator('#tab-play').evaluate((pane) => {
    pane.scrollTop = pane.scrollHeight;
    const end = pane.querySelector('.tab-body')!.getBoundingClientRect().bottom;
    pane.scrollTop = 0;
    return end;
  });
  expect(contentEnd, `${label} end of the scroll clears the bottom inset`).toBeLessThanOrEqual(
    sample.height - sample.insets.bottom + TOLERANCE_PX,
  );
}

async function startRoom(page: Page, sample: Sample): Promise<void> {
  await injectPeerServer(page);
  if (sample.locale) {
    await page.addInitScript((locale) => {
      try {
        localStorage.setItem('musixquare-lang', locale);
      } catch {
        // Opaque documents such as about:blank have no storage.
      }
    }, sample.locale);
  }
  await page.setViewportSize({ width: sample.width, height: sample.height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const devtools = await page.context().newCDPSession(page);
  await devtools.send('Emulation.setSafeAreaInsetsOverride', { insets: sample.insets });
  await setupHostAndStart(page);
  // Entrance motion translates the panes; measure the settled layout.
  await page.waitForFunction(
    () => !document.querySelector('.app-entrance, .app-chat-entrance'),
    undefined,
    { timeout: 5_000 },
  );
}

test.describe('compact tab panes in a running room', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'The safe-area emulation is a Chromium DevTools command.',
  );

  for (const sample of samples) {
    test(`every tab pane keeps its box beside the sidebar (${sample.name})`, async ({ page }) => {
      await startRoom(page, sample);
      const direction = await page.evaluate(() => document.documentElement.dir || 'ltr');
      expect(direction).toBe(sample.locale ? 'rtl' : 'ltr');
      const sidebar = (await page.locator('#main-header').boundingBox())!;
      // The sidebar keeps the physical right edge in both directions.
      expect(sidebar.x + sidebar.width).toBeCloseTo(sample.width, 0);

      for (const tab of TABS) {
        await page.locator(`#nav-${tab}`).click();
        const pane = page.locator(`#tab-${tab}`);
        await expect(pane).toHaveClass(/\bactive\b/);
        await expect(pane).toBeVisible();
        const box = (await pane.boundingBox())!;
        const label = `${sample.name} ${tab}`;
        expect(Math.abs(box.y - sample.insets.top), `${label} top`).toBeLessThanOrEqual(
          TOLERANCE_PX,
        );
        expect(
          Math.abs(box.y + box.height - paneBottom(tab, sample)),
          `${label} bottom`,
        ).toBeLessThanOrEqual(TOLERANCE_PX);
        if (tab === 'play') await expectPlayPaneShowsItsLastRow(page, sample, label);
        expect(Math.abs(box.x), `${label} left`).toBeLessThanOrEqual(TOLERANCE_PX);
        expect(Math.abs(box.x + box.width - sidebar.x), `${label} right`).toBeLessThanOrEqual(
          TOLERANCE_PX,
        );
        // A pane that outgrows the page makes the document itself scrollable,
        // and focus or scrollIntoView could then slide the app under the
        // status bar even though the body does not scroll by touch.
        const pageSize = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));
        expect(pageSize.width, `${label} page width`).toBeLessThanOrEqual(sample.width);
        expect(pageSize.height, `${label} page height`).toBeLessThanOrEqual(sample.height);
      }
    });
  }
});

// The media source and YouTube address screens take the place of the left
// content pane while the Play pane stays underneath. The Play pane reaches the
// bottom edge of the screen, so a screen that ends at the home indicator
// leaves the Play pane's last row showing in the strip below it. These
// screens cover the pane down to the bottom edge instead, and what they hold
// still ends above the indicator.
const SCREENS_OVER_THE_PLAY_PANE = [
  { overlay: 'media-source-overlay', opener: 'btn-media-source' },
  { overlay: 'youtube-url-overlay', opener: 'btn-youtube-source' },
] as const;

test.describe('screens over the Play pane in a running room', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'The safe-area emulation is a Chromium DevTools command.',
  );

  for (const sample of samples) {
    test(`the media screens cover the Play pane down to the bottom edge (${sample.name})`, async ({
      page,
    }) => {
      await startRoom(page, sample);
      const sidebar = (await page.locator('#main-header').boundingBox())!;
      const pane = (await page.locator('#tab-play').boundingBox())!;
      expect(
        Math.abs(pane.y + pane.height - sample.height),
        'the Play pane bottom',
      ).toBeLessThanOrEqual(TOLERANCE_PX);
      // Two rows of points across the pane: the last pixel row of the screen
      // and the first row below the safe bottom. Without a bottom inset both
      // are the last row.
      const probes: { x: number; y: number }[] = [];
      for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const x = Math.round(pane.x + pane.width * fraction);
        probes.push({ x, y: sample.height - 1 });
        probes.push({ x, y: sample.height - Math.max(1, sample.insets.bottom - 1) });
      }

      for (const screen of SCREENS_OVER_THE_PLAY_PANE) {
        await page.locator(`#${screen.opener}`).click();
        const overlay = page.locator(`#${screen.overlay}`);
        await expect(overlay).toHaveClass(/\bactive\b/);
        const label = `${sample.name} ${screen.overlay}`;
        const box = (await overlay.boundingBox())!;
        expect(Math.abs(box.y - sample.insets.top), `${label} top`).toBeLessThanOrEqual(
          TOLERANCE_PX,
        );
        expect(Math.abs(box.y + box.height - sample.height), `${label} bottom`).toBeLessThanOrEqual(
          TOLERANCE_PX,
        );
        expect(Math.abs(box.x), `${label} left`).toBeLessThanOrEqual(TOLERANCE_PX);
        expect(Math.abs(box.x + box.width - sidebar.x), `${label} right`).toBeLessThanOrEqual(
          TOLERANCE_PX,
        );
        // Hit testing answers for the screen only once it has finished
        // opening, so the points are polled.
        await expect
          .poll(
            () =>
              overlay.evaluate(
                (node, points) =>
                  points
                    .filter(({ x, y }) => {
                      const hit = document.elementFromPoint(x, y);
                      return hit === null || !node.contains(hit);
                    })
                    .map(({ x, y }) => `${x},${y}`),
                probes,
              ),
            { message: `${label} leaves the strip below it uncovered` },
          )
          .toEqual([]);
        // The screen's own content keeps the safe box it had.
        const card = (await overlay.locator('.onboarding-card').boundingBox())!;
        expect(card.y + card.height, `${label} content end`).toBeLessThanOrEqual(
          sample.height - sample.insets.bottom + TOLERANCE_PX,
        );
        if (screen.overlay === 'media-source-overlay') {
          // The close button keeps the options' inset from the pane edge, on
          // the side the writing direction puts it.
          const close = (await overlay.locator('#btn-close-media-popup').boundingBox())!;
          const option = (await overlay.locator('#btn-local-file').boundingBox())!;
          const outerEdge = (edge: { x: number; width: number }): number =>
            sample.locale ? edge.x : edge.x + edge.width;
          expect(
            Math.abs(outerEdge(close) - outerEdge(option)),
            `${label} close button inset`,
          ).toBeLessThanOrEqual(TOLERANCE_PX);
        }
      }
    });

    test(`the chat drawer opens over the content pane (${sample.name})`, async ({ page }) => {
      await startRoom(page, sample);
      const sidebar = (await page.locator('#main-header').boundingBox())!;
      await page.locator('#chat-preview-btn').click();
      const drawer = page.locator('#chat-drawer');
      await expect(drawer).toHaveClass(/\bopen\b/);
      // The drawer slides up; its horizontal place does not move with it.
      const box = (await drawer.boundingBox())!;
      expect(Math.abs(box.x), `${sample.name} drawer left`).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(
        Math.abs(box.x + box.width - sidebar.x),
        `${sample.name} drawer right`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    });
  }
});
