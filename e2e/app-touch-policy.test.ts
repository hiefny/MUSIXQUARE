import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { E2E_APP_ORIGIN } from './config.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupGuest, setupHostAndStart } from './helpers/setup-flow.ts';

const MOBILE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  serviceWorkers: 'block' as const,
};

test.use(MOBILE);

// These exercise the shipped app in Chromium and Playwright WebKit. Neither
// engine emulates an installed iOS 17 PWA or its post-keyboard viewport bug.
async function openHost(page: Page): Promise<string> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  return setupHostAndStart(page);
}

async function viewportSnapshot(page: Page) {
  return page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    offsetTop: window.visualViewport?.offsetTop ?? 0,
    offsetLeft: window.visualViewport?.offsetLeft ?? 0,
    visualHeight: window.visualViewport?.height ?? window.innerHeight,
    visualWidth: window.visualViewport?.width ?? window.innerWidth,
    innerHeight: window.innerHeight,
    rootHeight: document.documentElement.getBoundingClientRect().height,
    bodyTop: document.body.getBoundingClientRect().top,
    bodyBottom: document.body.getBoundingClientRect().bottom,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    headerTop: document.querySelector('header')!.getBoundingClientRect().top,
  }));
}

async function doubleTapUnavailable(page: Page, id: string): Promise<void> {
  const button = page.locator(`#${id}`);
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(await button.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(false);
  await expect(button).toHaveCSS('touch-action', 'manipulation');
  // A real user can tap aria-disabled controls to receive their explanation.
  // Locator.tap intentionally refuses them, so use the trusted touchscreen at
  // the rendered center rather than a synthetic DOM click or a force option.
  const box = await button.boundingBox();
  if (!box) throw new Error(`${id} has no touch target`);
  const before = await viewportSnapshot(page);
  expect(before.scale).toBe(1);
  await page.evaluate((id) => {
    const target = document.getElementById(id)!;
    target.dataset.touchPolicyClicks = '0';
    target.addEventListener('click', () => {
      target.dataset.touchPolicyClicks = String(Number(target.dataset.touchPolicyClicks) + 1);
    });
  }, id);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(40);
  await page.touchscreen.tap(x, y);
  await expect(button).toHaveAttribute('data-touch-policy-clicks', '2');
  await expect(page.locator('#toast')).toHaveClass(/\bshow\b/);
  // Allow a browser double-tap gesture to settle before sampling geometry.
  await page.waitForTimeout(400);
  expect(await viewportSnapshot(page)).toEqual(before);
}

test('unavailable host and guest controls keep tap feedback without changing the viewport', async ({
  page,
  browser,
}) => {
  const code = await openHost(page);
  await doubleTapUnavailable(page, 'play-btn');

  const guestContext = await browser.newContext({
    ...MOBILE,
    baseURL: E2E_APP_ORIGIN,
    userAgent: await page.evaluate(() => navigator.userAgent),
  });
  try {
    const guest = await guestContext.newPage();
    await guest.emulateMedia({ reducedMotion: 'reduce' });
    await injectPeerServer(guest);
    await useAnonymousAccountSession(guest);
    // Uses the real room-code entry and join flow. Desktop automation does not
    // provide the physical iOS software keyboard, despite editable focus.
    await setupGuest(guest, code);
    for (const id of ['btn-prev', 'play-btn', 'btn-next']) {
      await doubleTapUnavailable(guest, id);
    }

    await guest.locator('.nav-item[data-tab="playlist"]').tap();
    await expect(guest.locator('#tab-playlist')).toHaveClass(/\bactive\b/);
    await guest.locator('.nav-item[data-tab="play"]').tap();
    await expect(guest.locator('#tab-play')).toHaveClass(/\bactive\b/);
  } finally {
    await guestContext.close();
  }
});

async function touchStroke(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...from, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
  try {
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * step) / 8,
            y: from.y + ((to.y - from.y) * step) / 8,
            id: 1,
            radiusX: 1,
            radiusY: 1,
            force: 1,
          },
        ],
      });
      await page.waitForTimeout(24);
    }
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

async function swipeScroller(page: Page, cdp: CDPSession, scroller: Locator): Promise<void> {
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(150);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const box = await scroller.boundingBox();
  if (!box) throw new Error('Scroll surface has no touch target');
  const start = { x: box.x + box.width / 2, y: box.y + box.height * 0.75 };
  await touchStroke(page, cdp, start, { x: start.x, y: start.y - Math.min(150, box.height / 2) });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(30);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

test('nested playlist and chat keep scrolling while range and drag surfaces keep their own policy', async ({
  page,
  browserName,
}) => {
  await openHost(page);
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
      __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
    };
    // Seed content through the existing E2E state/event boundary; leave the
    // real renderers, scroll containers, controls and gesture handlers intact.
    runtime.__MUSIXQUARE_SET_STATE__(
      'playlist.items',
      Array.from({ length: 24 }, (_, index) => ({
        queueItemId: crypto.randomUUID(),
        type: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        name: `Touch policy track ${index + 1}`,
      })),
    );
    for (let index = 0; index < 40; index += 1) {
      runtime.__MUSIXQUARE_BUS__.emit('chat:system-message', `Touch policy message ${index + 1}`);
    }
  });

  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  try {
    const volume = page.locator('#volume-slider');
    await expect(volume).toHaveCSS('touch-action', 'none');
    if (cdp) {
      const before = Number(await volume.inputValue());
      const box = await volume.boundingBox();
      if (!box) throw new Error('Volume slider has no touch target');
      await touchStroke(
        page,
        cdp,
        { x: box.x + box.width * 0.85, y: box.y + box.height / 2 },
        { x: box.x + box.width * 0.25, y: box.y + box.height / 2 },
      );
      await expect.poll(async () => Number(await volume.inputValue())).toBeLessThan(before - 20);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }

    await page.locator('.nav-item[data-tab="playlist"]').tap();
    await expect(page.locator('#tab-playlist')).toHaveClass(/\bactive\b/);
    const playlist = page.locator('#tab-playlist .tab-body');
    await expect(playlist).toHaveCSS('touch-action', 'manipulation');
    await expect(page.locator('.track-item').first()).toHaveCSS('touch-action', 'pan-y');
    await expect(page.locator('.track-name').first()).toHaveCSS('touch-action', 'manipulation');
    await expect(page.locator('.playlist-reorder-handle').first()).toHaveCSS(
      'touch-action',
      'none',
    );
    if (cdp) await swipeScroller(page, cdp, playlist);

    await page.locator('.nav-item[data-tab="play"]').tap();
    await expect(page.locator('#tab-play')).toHaveClass(/\bactive\b/);
    await page.locator('#chat-preview-btn').tap();
    await expect(page.locator('#chat-drawer')).toHaveClass(/\bopen\b/);
    const messages = page.locator('#chat-messages');
    await expect(messages).toHaveCSS('touch-action', 'manipulation');
    await expect(page.locator('.chat-drawer-header')).toHaveCSS('touch-action', 'none');
    if (cdp) await swipeScroller(page, cdp, messages);
  } finally {
    await cdp?.detach();
  }
});
