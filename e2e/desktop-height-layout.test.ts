import { expect, test, type Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';

const TOLERANCE_PX = 1;

type Band = 'desktop' | 'short-desktop' | 'compact';

const VIEWPORTS: ReadonlyArray<{ width: number; height: number; band: Band }> = [
  { width: 1440, height: 900, band: 'desktop' },
  { width: 1440, height: 800, band: 'short-desktop' },
  { width: 1366, height: 768, band: 'short-desktop' },
  { width: 1280, height: 720, band: 'short-desktop' },
  { width: 1440, height: 700, band: 'compact' },
  { width: 1280, height: 719, band: 'compact' },
  { width: 1024, height: 700, band: 'compact' },
  { width: 1280, height: 900, band: 'desktop' },
  { width: 1440, height: 800, band: 'short-desktop' },
];

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

async function readLayout(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string): Box | null => {
      // Measure the first rendered match. Once the room announces its
      // playlists, the playlist header hides its plain title (and the edit
      // mode's count title) and shows the switcher's title instead.
      const element = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (candidate) => candidate.getClientRects().length > 0,
      );
      if (!element) return null;
      const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      header: box('#main-header'),
      play: box('#tab-play'),
      playlist: box('#tab-playlist'),
      playlistTitle: box('#tab-playlist > .tab-header .tab-title'),
      chat: box('#chat-drawer'),
      settings: box('#tab-settings'),
      settingsTitle: box('#tab-settings > .tab-header .tab-title'),
      navVisible: getComputedStyle(document.querySelector('.bottom-nav')!).display !== 'none',
    };
  });
}

async function resizeTo(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate((nextHeight) => {
    document.documentElement.style.setProperty('--app-height', `${nextHeight}px`);
  }, height);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function startRoom(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await setupHostAndStart(page);
  // Entrance motion translates the panels; measure the settled grid.
  await page.waitForFunction(
    () => !document.querySelector('.app-entrance, .app-chat-entrance'),
    undefined,
    { timeout: 5_000 },
  );
}

function near(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    TOLERANCE_PX,
  );
}

test.describe('desktop layout height bands', () => {
  test.beforeEach(async ({ page }) => {
    await injectPeerServer(page);
  });

  test('switches between full, Play-only and compact headers as the height changes', async ({
    page,
  }) => {
    await startRoom(page, 1440, 900);
    let desktopTitleOffset: number | null = null;

    for (const { width, height, band } of VIEWPORTS) {
      await resizeTo(page, width, height);
      const layout = await readLayout(page);
      const size = `${width}x${height}`;
      expect(layout.scrollWidth, `${size} horizontal scroll`).toBeLessThanOrEqual(width);
      const header = layout.header!;

      if (band === 'compact') {
        // The sidebar header runs down the inline end; only the active tab shows.
        expect(layout.navVisible, size).toBe(true);
        near(header.right, width, `${size} sidebar edge`);
        near(header.height, height, `${size} sidebar height`);
        expect(layout.playlist, size).toBeNull();
        continue;
      }

      expect(layout.navVisible, size).toBe(false);
      const play = layout.play!;
      const playlist = layout.playlist!;
      const chat = layout.chat!;
      const settings = layout.settings!;
      near(header.top, 0, `${size} header top`);
      near(play.top, header.bottom, `${size} play top`);
      near(play.bottom, height, `${size} play bottom`);
      near(chat.bottom, height, `${size} chat bottom`);
      near(settings.bottom, height, `${size} settings bottom`);
      near(playlist.height, chat.height, `${size} playlist/chat split`);

      if (band === 'desktop') {
        near(header.width, width, `${size} header width`);
        near(playlist.top, header.bottom, `${size} playlist top`);
        near(settings.top, header.bottom, `${size} settings top`);
        desktopTitleOffset ??= layout.playlistTitle!.top - playlist.top;
        continue;
      }

      // Short desktop: the header covers only Play; the side columns run to the top.
      near(header.left, play.left, `${size} header left`);
      near(header.right, play.right, `${size} header right`);
      near(playlist.top, 0, `${size} playlist top`);
      near(settings.top, 0, `${size} settings top`);
      near(settings.height, height, `${size} settings height`);
      // The title rows keep the full dashboard's top spacing below the edge.
      expect(desktopTitleOffset, 'desktop band measured first').not.toBeNull();
      near(layout.playlistTitle!.top - playlist.top, desktopTitleOffset!, `${size} playlist title`);
      near(layout.settingsTitle!.top - settings.top, desktopTitleOffset!, `${size} settings title`);
    }
  });

  test('mirrors the Play-only header for right-to-left documents', async ({ page }) => {
    await startRoom(page, 1440, 800);
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    await resizeTo(page, 1440, 800);

    const layout = await readLayout(page);
    expect(layout.scrollWidth).toBeLessThanOrEqual(1440);
    near(layout.header!.right, 1440, 'rtl header right');
    near(layout.header!.left, layout.play!.left, 'rtl header left');
    near(layout.playlist!.top, 0, 'rtl playlist top');
    expect(layout.settings!.right).toBeLessThanOrEqual(layout.playlist!.left + TOLERANCE_PX);
  });
});
