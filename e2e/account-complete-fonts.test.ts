/**
 * The app's sign-in completion window (public/account-complete.html) tells
 * the app tab that sign-in finished before it asks for any font, then draws
 * its text with the app's faces through the shared sheets its script adds
 * (/web-fonts/). Until the faces are ready the text waits invisible, 600 ms
 * at most (public/account-complete.css), so it never shows in a device font
 * first and never stays hidden: a sheet that fails shows it at once in the
 * device's fonts, one that never answers lets the wait end by itself, and
 * faces that cannot load leave the text to the device's fonts at the end of
 * the app's stack. The success window closes itself 250 ms after its
 * message and ends the wait itself before that, so on a slow first load its
 * text shows, in the device's fonts, before it closes.
 *
 * Runs in Chromium (the default suite) and in the WebKit lane
 * (playwright.webkit.config.ts). While a sheet for the screen loads, WebKit
 * holds the page's rendering (its frames, and so the wait), so the script
 * adds each sheet for print and turns it to every medium once it has loaded.
 */
import { expect, test, type Page } from '@playwright/test';

// The cancelled outcome keeps the window open (success closes it after 250 ms).
const COMPLETION_PATH = '/account-complete.html?accountClient=e2e-0001&accountAuth=cancelled';
const SUCCESS_PATH = '/account-complete.html?accountClient=e2e-0001';

const CANCELLED_KO = '로그인이 취소됐어요.';
const SUCCESS_KO = '로그인이 완료됐어요. 이 창을 닫아도 돼요.';

test.use({ locale: 'ko-KR', serviceWorkers: 'block' });

/** The success window's state when it would have closed itself. */
interface SuccessClose {
  readonly drawn: boolean;
  readonly text: string;
  readonly mark: string | null;
  /** How many animation frames had been sampled by then. */
  readonly frames: number;
}

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
    // The success window closes itself: keep it open, and note whether its
    // message was drawn, the root's mark and the frames sampled so far when it
    // would have closed.
    const closes: SuccessClose[] = [];
    Object.assign(window, { __completionCloses: closes });
    window.close = () => {
      const message = document.getElementById('account-complete-message');
      closes.push({
        drawn: message !== null && !transparent.test(getComputedStyle(message).color),
        text: message?.textContent?.trim() ?? '',
        mark: document.documentElement.getAttribute('data-mxqr-fonts'),
        frames: frames.length,
      });
    };
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

test("shows its text in the device's fonts when its faces cannot load", async ({ page }) => {
  await page.route('**/assets/*.woff2', (route) => route.abort());
  await page.goto(COMPLETION_PATH);
  await page.waitForSelector(':root[data-mxqr-fonts]', { state: 'attached' });
  const state = await windowState(page);
  // The sheets loaded, so the text reads the app's stack; its faces failed,
  // so the device's fonts at the end of that stack draw it, and the script's
  // mark, not the capped wait, shows it.
  expect(state.mark).toBe('app');
  expect(state.message).toBe(CANCELLED_KO);
  expect(drawn(state.color)).toBe(true);
  expect(state.family).toMatch(/^Inter, "?MUSIXQUARE Hangul"?,/u);
  expect(state.loadedFamilies).toEqual([]);
  const failedFaces = await page.evaluate(() => {
    let failed = 0;
    document.fonts.forEach((face) => {
      if (face.status === 'error') failed += 1;
    });
    return failed;
  });
  expect(failedFaces).toBeGreaterThan(0);
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

/** Once the success window would have closed: its closes, the frames sampled, and the faces loaded. */
async function successClose(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __completionCloses: unknown[] }).__completionCloses.length > 0,
  );
  return page.evaluate(() => {
    let loaded = 0;
    document.fonts.forEach((face) => {
      if (face.status === 'loaded') loaded += 1;
    });
    const state = window as unknown as {
      __completionCloses: SuccessClose[];
      __completionFrames: [visible: number, text: string, loading: number, loaded: number][];
    };
    return { closes: state.__completionCloses, frames: state.__completionFrames, loaded };
  });
}

for (const [slow, pattern] of [
  ['shared sheets', '**/web-fonts/**'],
  ['faces', '**/assets/*.woff2'],
] as const) {
  test(`shows its success copy before it closes itself when its ${slow} are slow`, async ({
    page,
  }) => {
    // A first sign-in over a slow link: what the text waits for arrives only
    // after the success window closes, 250 ms after its message.
    await page.route(pattern, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue().catch(() => undefined);
    });
    // A sheet the script adds holds the load event.
    await page.goto(SUCCESS_PATH, { waitUntil: 'domcontentloaded' });
    const { closes } = await successClose(page);
    // The window ended its text's wait first: the copy was drawn, in the
    // device's fonts, when it closed.
    expect(closes.map(({ drawn, text, mark }) => ({ drawn, text, mark }))).toEqual([
      { drawn: true, text: SUCCESS_KO, mark: 'device' },
    ]);
  });
}

test('draws its success copy once, with the app faces, before it closes itself', async ({
  page,
  browserName,
}) => {
  // Nothing held. The copy is drawn when the window closes itself in both
  // lanes. The WebKit lane emulates a phone at scale 3, where this harness
  // draws a frame about every 250 ms and the faces' mark comes 360 to 510 ms
  // after the message, after the close; there the window's own end (200 ms
  // after its message) shows the copy in the device's fonts. In Chromium the
  // faces are ready well before that end, so the window draws as the
  // cancelled one does, with no frame before its faces are ready.
  await page.goto(SUCCESS_PATH);
  const { closes, frames, loaded } = await successClose(page);
  expect(closes.map(({ drawn, text }) => ({ drawn, text }))).toEqual([
    { drawn: true, text: SUCCESS_KO },
  ]);
  if (browserName === 'webkit') return;
  expect(closes[0]?.mark).toBe('app');
  const beforeClose = frames.slice(0, closes[0]?.frames ?? 0);
  expect(beforeClose.filter(([visible]) => visible === 1).length).toBeGreaterThan(0);
  expect(
    beforeClose.filter(
      ([visible, text, loadingNow, loadedNow]) =>
        visible === 1 && (loadingNow > 0 || loadedNow < loaded || text !== SUCCESS_KO),
    ),
  ).toEqual([]);
});
