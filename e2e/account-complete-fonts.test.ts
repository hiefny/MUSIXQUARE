/**
 * The app's sign-in completion window (public/account-complete.html) tells
 * the app tab that sign-in finished before it asks for any font, then draws
 * its text with the app's faces through the shared sheets its script adds
 * (/web-fonts/). Until the faces are ready the text waits invisible, 600 ms
 * at most (public/account-complete.css), so it never shows in a device font
 * first and never stays hidden: a sheet that fails shows it at once in the
 * device's fonts, and one that never answers lets the wait end by itself.
 *
 * Runs in Chromium (the default suite) and in the WebKit lane
 * (playwright.webkit.config.ts). While a sheet for the screen loads, WebKit
 * holds the page's rendering (its frames, and so the wait), so the script
 * adds each sheet for print and turns it to every medium once it has loaded.
 */
import { expect, test, type Page } from '@playwright/test';

// The cancelled outcome keeps the window open (success closes it after 250 ms).
const COMPLETION_PATH = '/account-complete.html?accountClient=e2e-0001&accountAuth=cancelled';

const CANCELLED_KO = '로그인이 취소됐어요.';

test.use({ locale: 'ko-KR', serviceWorkers: 'block' });

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    const order: string[] = [];
    Object.assign(window, { __completionOrder: order });
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message: unknown) {
      order.push('broadcast');
      return post.call(this, message);
    };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'mxqr-account-refresh') order.push('storage');
      return setItem.call(this, key, value);
    };
    const appendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
      if (node instanceof HTMLLinkElement) order.push(`link ${node.getAttribute('href') ?? ''}`);
      return appendChild.call(this, node) as T;
    };
    // Every animation frame: whether the message or the button draws its
    // text, that text, and how many faces are loading and loaded.
    const frames: [visible: number, text: string, loading: number, loaded: number][] = [];
    Object.assign(window, { __completionFrames: frames });
    const transparent = /^rgba\([^)]*,\s*0\)$|^transparent$/u;
    const sample = () => {
      const message = document.getElementById('account-complete-message');
      const button = document.getElementById('account-complete-close');
      if (message && button) {
        let loading = 0;
        let loaded = 0;
        document.fonts.forEach((face) => {
          if (face.status === 'loading') loading += 1;
          else if (face.status === 'loaded') loaded += 1;
        });
        const visible =
          !transparent.test(getComputedStyle(message).color) ||
          !transparent.test(getComputedStyle(button).color);
        frames.push([visible ? 1 : 0, message.textContent?.trim() ?? '', loading, loaded]);
      }
      if (frames.length < 600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
});

interface WindowState {
  readonly order: string[];
  readonly mark: string | null;
  readonly message: string;
  readonly color: string;
  readonly family: string;
  readonly headLinks: string[];
  readonly loadedFamilies: string[];
}

function windowState(page: Page): Promise<WindowState> {
  return page.evaluate(() => {
    const message = document.getElementById('account-complete-message');
    if (!message) throw new Error('the completion message is missing');
    const style = getComputedStyle(message);
    const loaded: string[] = [];
    document.fonts.forEach((face) => {
      if (face.status === 'loaded') loaded.push(face.family.replace(/^(['"])(.*)\1$/u, '$2'));
    });
    return {
      order: (window as unknown as { __completionOrder: string[] }).__completionOrder,
      mark: document.documentElement.getAttribute('data-mxqr-fonts'),
      message: message.textContent?.trim() ?? '',
      color: style.color,
      family: style.fontFamily,
      headLinks: [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
        (link) => `${link.getAttribute('href') ?? ''} ${link.media || 'all'}`,
      ),
      loadedFamilies: [...new Set(loaded)].sort(),
    };
  });
}

/** Whether the message's colour draws anything (transparent while it waits). */
const drawn = (color: string) => !/^rgba\([^)]*,\s*0\)$/u.test(color) && color !== 'transparent';

test('sends its completion message first, then draws its text with the app faces', async ({
  page,
}) => {
  await page.goto(COMPLETION_PATH);
  await page.waitForSelector(':root[data-mxqr-fonts]', { state: 'attached' });
  const state = await windowState(page);
  expect(state.mark).toBe('app');
  // Both completion channels fire before the page adds any font sheet.
  expect(state.order).toEqual([
    'broadcast',
    'storage',
    'link /web-fonts/first.css',
    'link /web-fonts/stacks.css',
  ]);
  expect(state.headLinks).toEqual([
    '/account-complete.css all',
    '/web-fonts/first.css all',
    '/web-fonts/stacks.css all',
  ]);
  expect(state.message).toBe(CANCELLED_KO);
  expect(drawn(state.color)).toBe(true);
  expect(state.family).toMatch(/^Inter, "?MUSIXQUARE Hangul"?,/u);
  // The faces of the Korean copy: Inter for the full stop, MUSIXQUARE Hangul.
  expect(state.loadedFamilies).toEqual(['Inter', 'MUSIXQUARE Hangul']);
});

test('never shows its text before its faces are ready', async ({ page }) => {
  await page.goto(COMPLETION_PATH);
  await page.waitForSelector(':root[data-mxqr-fonts="app"]', { state: 'attached' });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const { frames, loaded } = await page.evaluate(() => {
    let count = 0;
    document.fonts.forEach((face) => {
      if (face.status === 'loaded') count += 1;
    });
    return {
      frames: (window as unknown as { __completionFrames: [number, string, number, number][] })
        .__completionFrames,
      loaded: count,
    };
  });
  expect(frames.filter(([visible]) => visible === 1).length).toBeGreaterThan(0);
  // No frame drew the text before every face it draws with had loaded, or
  // drew any copy but the one the window settles on.
  expect(
    frames.filter(
      ([visible, text, loadingNow, loadedNow]) =>
        visible === 1 && (loadingNow > 0 || loadedNow < loaded || text !== CANCELLED_KO),
    ),
  ).toEqual([]);
});

test('shows its text when the wait ends, if the shared sheets never answer', async ({ page }) => {
  await page.route('**/web-fonts/**', () => undefined);
  // A sheet that never answers holds the load event too.
  await page.goto(COMPLETION_PATH, { waitUntil: 'domcontentloaded' });
  // The text first waits: the animation exists and no mark is set.
  await page.waitForFunction(() => document.getAnimations().length > 0);
  const started = await page.evaluate(() => performance.now());
  await page.waitForFunction(
    () => {
      const message = document.getElementById('account-complete-message');
      if (!message) return false;
      const { color } = getComputedStyle(message);
      return !/^rgba\([^)]*,\s*0\)$/u.test(color) && color !== 'transparent';
    },
    undefined,
    { timeout: 10_000 },
  );
  const shown = await page.evaluate(() => performance.now());
  const state = await windowState(page);
  expect(state.mark).toBeNull();
  expect(state.message).toBe(CANCELLED_KO);
  // The wait is 600 ms; allow a slow runner, never seconds.
  expect(shown - started).toBeLessThan(2_000);
});

test("shows its text at once in the device's fonts when a shared sheet fails", async ({ page }) => {
  await page.route('**/web-fonts/stacks.css', (route) => route.abort());
  await page.goto(COMPLETION_PATH);
  await page.waitForSelector(':root[data-mxqr-fonts]', { state: 'attached' });
  const state = await windowState(page);
  expect(state.mark).toBe('device');
  expect(state.message).toBe(CANCELLED_KO);
  expect(drawn(state.color)).toBe(true);
  // Without stacks.css the text reads the device's fonts, the sheet's fallback.
  expect(state.family).toMatch(
    /^-apple-system, BlinkMacSystemFont, "?Segoe UI"?, Roboto, sans-serif$/u,
  );
});
