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
const TOLERANCE_PX = 1;

function none(): Insets {
  return { top: 0, right: 0, bottom: 0, left: 0 };
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
    test(`every tab pane fills the safe content box beside the sidebar (${sample.name})`, async ({
      page,
    }) => {
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
          Math.abs(box.y + box.height - (sample.height - sample.insets.bottom)),
          `${label} bottom`,
        ).toBeLessThanOrEqual(TOLERANCE_PX);
        expect(Math.abs(box.x), `${label} left`).toBeLessThanOrEqual(TOLERANCE_PX);
        expect(Math.abs(box.x + box.width - sidebar.x), `${label} right`).toBeLessThanOrEqual(
          TOLERANCE_PX,
        );
      }
    });
  }
});
