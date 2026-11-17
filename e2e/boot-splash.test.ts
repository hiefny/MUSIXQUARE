import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';

// The boot splash (index.html) paints from the page file before any script or
// stylesheet and steps aside when the app takes the screen. The session reset
// screen shows its wordmark and loader, and the page a reset opens continues
// them.

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => !document.documentElement.classList.contains('setup-boot-block'),
    null,
    { timeout: 30_000, polling: 50 },
  );
  await expect(page.locator('#setup-overlay')).toHaveClass(/\bactive\b/u);
}

/** The animations still running on anything inside the splash. */
function runningInsideSplash(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return target instanceof Element && target.closest('.boot-splash') !== null;
      })
      .filter((animation) => animation.playState === 'running')
      .map((animation) => (animation as CSSAnimation).animationName),
  );
}

// The app's background (css/style.css --bg) and, in the installed iOS app, the
// colour iOS paints the strip under a short first screen with before any
// stylesheet loads (owner report, 2026-11-16), which the splash starts on.
const APP_BG = { dark: 'rgb(18, 18, 18)', light: 'rgb(248, 249, 250)' } as const;
const STRIP = { dark: 'rgb(0, 0, 0)', light: 'rgb(255, 255, 255)' } as const;

function channels(colour: string): number[] {
  return (colour.match(/[\d.]+/gu) ?? []).map(Number);
}

/** Within one step per channel: two animations interpolate each on its own. */
function near(colour: string, other: string): boolean {
  const [left, right] = [channels(colour), channels(other)];
  return (
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - (right[index] ?? Number.NaN)) <= 1)
  );
}

/** On the way from one colour to the other, at neither end. */
function between(colour: string, from: string, to: string): boolean {
  const [value, start, end] = [channels(colour), channels(from), channels(to)];
  return (
    colour !== from &&
    colour !== to &&
    value.length === 3 &&
    value.every(
      (channel, index) =>
        channel >= Math.min(start[index]!, end[index]!) &&
        channel <= Math.max(start[index]!, end[index]!),
    )
  );
}

/** The page's own background as WebKit reads it: body's over the root's. */
function pageColour(frame: { root: string; body: string }): string {
  return frame.body === 'rgba(0, 0, 0, 0)' || frame.body === 'transparent'
    ? frame.root
    : frame.body;
}

/** How many frames differ in each way (an empty record when none does). */
function tally<T>(
  frames: readonly T[],
  differences: (frame: T) => (string | false)[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const frame of frames) {
    const found = differences(frame).filter((difference) => difference !== false);
    if (found.length === 0) continue;
    const key = found.join('; ');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

test.describe('boot splash', () => {
  test('renders frames while the start-up scripts are still loading', async ({ page }) => {
    // Hold the first start-up script: the parser waits on it with only the
    // splash parsed, as on a slow first visit. WebKit renders nothing until
    // the page holds enough fixed-size SVG (index.html, .boot-splash-logo).
    let releaseBootstrap = (): void => undefined;
    const bootstrapHeld = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    await page.route(/\/bootstrap\.js(?:\?.*)?$/u, async (route) => {
      await bootstrapHeld;
      await route.fallback();
    });
    await page.goto('/', { waitUntil: 'commit' });
    await page.locator('.boot-splash-logo').waitFor({ state: 'attached' });
    const rendered = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          requestAnimationFrame(() => resolve(true));
          setTimeout(() => resolve(false), 3_000);
        }),
    );
    const scriptsWaiting = await page.evaluate(
      () => !document.querySelector('script[src*="fouc-cleanup"]'),
    );
    releaseBootstrap();
    expect({ rendered, scriptsWaiting }).toEqual({ rendered: true, scriptsWaiting: true });
  });

  test('hands over to setup and leaves no animation running in the hidden splash', async ({
    page,
  }) => {
    await openApp(page);
    // The loader turns through the 0.3 s fade; then the runtime takes the
    // splash out of rendering.
    await expect(page.locator('.boot-splash')).toBeHidden();
    await expect(page.locator('.boot-splash')).toHaveAttribute('hidden', '');
    expect(await runningInsideSplash(page)).toEqual([]);
  });

  // The installed iOS app holds the page's background on the strip's colour
  // (index.html, data-boot-installed). A browser tab, a desktop or an Android
  // phone keeps the app's background on the page and the splash, and nothing
  // animates the root.
  test("keeps the page and the splash on the app's background outside the installed iOS app", async ({
    page,
  }) => {
    type PageFrame = {
      installed: boolean;
      animations: string[];
      sheet: boolean;
      theme: string | null;
      root: string;
      body: string;
      splash: string;
    };
    await page.addInitScript(() => {
      const frames: PageFrame[] = [];
      (window as typeof window & { __pageFrames: PageFrame[] }).__pageFrames = frames;
      // Every frame from the splash's first until the runtime retires it.
      const sample = () => {
        const root = document.documentElement;
        const splash = document.querySelector<HTMLElement>('.boot-splash');
        if (splash?.hidden) return;
        if (splash && document.body) {
          const rootStyle = getComputedStyle(root);
          frames.push({
            installed: root.hasAttribute('data-boot-installed'),
            animations: root
              .getAnimations()
              .map((animation) => (animation as CSSAnimation).animationName),
            // The app stylesheet has applied: the root has its --bg.
            sheet: rootStyle.getPropertyValue('--bg').trim() !== '',
            theme: root.getAttribute('data-theme'),
            root: rootStyle.backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
            splash: getComputedStyle(splash).backgroundColor,
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await openApp(page);
    await expect(page.locator('.boot-splash')).toHaveAttribute('hidden', '');
    const frames = await page.evaluate(
      () => (window as typeof window & { __pageFrames: PageFrame[] }).__pageFrames,
    );
    expect(frames.some((frame) => frame.sheet)).toBe(true);
    const theme = frames[0]?.theme === 'dark' ? 'dark' : 'light';
    const background = APP_BG[theme];
    expect(
      tally(frames, (frame) => [
        frame.installed && 'installed',
        frame.animations.length > 0 && `root animations ${frame.animations.join(', ')}`,
        frame.theme !== theme && `theme ${frame.theme}`,
        frame.splash !== background && `splash ${frame.splash}`,
        frame.sheet &&
          (frame.root !== background || frame.body !== background) &&
          `root ${frame.root}, body ${frame.body}`,
      ]),
    ).toEqual({});
  });

  for (const [label, runtime] of [
    ['without the drawing runtime', null],
    // What an older release's runtime does to this page: its service worker
    // still serves that one on the update's first load. It marks the root with
    // its own attribute and waits for a start event nothing sends now.
    [
      "under an older release's cached runtime",
      "document.documentElement.setAttribute('data-wordmark-runtime-ready', 'true');",
    ],
  ] as const) {
    test(`hands over ${label} too, frozen where it was`, async ({ page }) => {
      await page.route('**/wordmark-anim.js', (route) =>
        runtime === null
          ? route.abort('failed')
          : route.fulfill({ contentType: 'text/javascript', body: runtime }),
      );
      await openApp(page);
      await expect(page.locator('.boot-splash')).toBeHidden();
      // Nothing hides it without this release's runtime, so it freezes at release.
      await expect(page.locator('.boot-splash')).not.toHaveAttribute('hidden', /.*/u);
      await expect.poll(() => runningInsideSplash(page)).toEqual([]);
    });
  }

  test('greets with a working language button from the first frame', async ({ page }) => {
    // The phone layout shows the welcome header itself (wide screens copy it).
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    const greeting = page.locator('#setup-welcome-header .setup-greeting-row');
    await expect(greeting).toHaveClass(/\bis-visible\b/u);
    await expect(greeting).toHaveCSS('opacity', '1');
    await expect(greeting).not.toHaveAttribute('aria-hidden', /.*/u);
    // The wordmark drew on the splash; the start screen has none.
    await expect(page.locator('#setup-welcome-header .logo-welcome:visible')).toHaveCount(0);
    await page.locator('#setup-welcome-header [data-setup-language-trigger]').click();
    await expect(page.locator('#language-dialog-overlay')).toBeVisible();
  });

  test('steps aside for the page when nothing after the page file arrives', async ({ page }) => {
    // A connection that drops right after the document: the start-up scripts,
    // the app stylesheet and the module graph never arrive, so neither
    // fouc-cleanup.js nor the stylesheet's fallback can lift the splash.
    await page.route(/\/(?:bootstrap|fouc-cleanup)\.js(?:\?.*)?$/u, (route) => route.abort());
    await page.route(/\/(?:assets|src|css)\//u, (route) => route.abort());
    await page.goto('/', { waitUntil: 'commit' });
    await page.locator('.boot-splash').waitFor({ state: 'attached' });
    await expect(page.locator('.boot-splash')).toBeVisible();
    // Shorten the shared boot-failure delay (the splash adds its 5 s margin).
    await page.addStyleTag({ content: ':root { --setup-boot-failure-delay: 0s !important; }' });

    await expect(page.locator('html')).toHaveClass(/\bsetup-boot-block\b/u);
    await expect(page.locator('.boot-splash')).toBeHidden({ timeout: 8_000 });
    // The unstyled page's own Retry form is reachable again.
    await page.locator('#bootstrap-retry').click({ trial: true, timeout: 2_000 });
  });
});

test.describe('session reset screen', () => {
  // The page's own routes see the reset's navigation (no worker answers it).
  test.use({ serviceWorkers: 'block' });

  test("shows the splash's wordmark and loader without text, and the page it opens continues them", async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await injectPeerServer(page);
    if (browserName === 'webkit') {
      // The Windows Playwright WebKit build has no PeerJS WebRTC transport.
      // As in app-touch-policy.test.ts, seed the host role and dismiss setup;
      // the leave, its reset screen and the next page stay production code.
      await useAnonymousAccountSession(page);
      await page.goto('/');
      await waitForBootstrapReady(page);
      await page.evaluate(() => {
        const runtime = window as typeof window & {
          __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
          __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
        };
        runtime.__MUSIXQUARE_SET_STATE__('network.appRole', 'host');
        runtime.__MUSIXQUARE_SET_STATE__('setup.sessionStarted', true);
        document.getElementById('setup-overlay')?.classList.remove('active');
        document.body.classList.remove('overlay-open');
        runtime.__MUSIXQUARE_BUS__.emit('setup:app-entrance');
      });
    } else {
      await setupHostAndStart(page);
    }

    // Hold the page the leave opens, so the reset screen can be read; release
    // it well inside the reset's 2 s commit window.
    let releaseNavigation = (): void => undefined;
    const navigationHeld = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    await page.route('**/*', async (route) => {
      if (route.request().isNavigationRequest()) await navigationHeld;
      await route.fallback();
    });

    // Where the screen's fade-in stood when this page started to leave.
    await page.evaluate(() => {
      window.addEventListener('beforeunload', () => {
        const overlay = document.getElementById('session-reset-overlay');
        if (overlay) {
          sessionStorage.setItem('e2e-reset-opacity-at-leave', getComputedStyle(overlay).opacity);
        }
      });
    });

    const leave = page.locator('#desktop-btn-leave-session:visible, #btn-leave-session:visible');
    if (!(await leave.first().isVisible())) {
      await page.locator('.nav-item[data-tab="connect"]:visible').click();
    }
    await leave.first().click();
    await expect(page.locator('#dialog-overlay.show')).toBeVisible();
    await page.locator('#btn-dialog-ok').click();

    // Read the screen as soon as it shows and release the next page at once,
    // well inside the reset's 2 s commit window (past it the page recovers).
    await page.waitForFunction(
      () => document.getElementById('session-reset-overlay')?.classList.contains('show'),
      null,
      { timeout: 10_000, polling: 20 },
    );
    const screen = await page.evaluate(() => {
      const middle = innerHeight / 2;
      const centre = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return Math.round((box.top + box.height / 2 - middle) * 10) / 10;
      };
      const message = document.getElementById('session-reset-message')!;
      const loader = document.querySelector(
        '#session-reset-overlay .boot-splash-spinner .material-elastic-turn',
      )!;
      const wordmark = document.querySelector('#session-reset-overlay .session-reset-wordmark')!;
      return {
        // Drawn: the screen is what the page shows while its input is blocked
        // and the rest is inert (boxes and animations ignore visibility).
        visible: [document.getElementById('session-reset-overlay')!, wordmark, loader].every(
          (element) => getComputedStyle(element).visibility === 'visible',
        ),
        // The boot splash's final place: wordmark 24px above the centre, loader 24px below.
        wordmark: centre('#session-reset-overlay .session-reset-wordmark'),
        loader: centre('#session-reset-overlay .boot-splash-spinner .material-elastic-turn'),
        wordmarkHeight: wordmark.getBoundingClientRect().height,
        // Its turn and the arc's three turning parts.
        loaderMoving: loader
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running')
          .map((animation) => (animation as CSSAnimation).animationName)
          .sort(),
        // The message is for screen readers only.
        message: message.textContent,
        messageClipped: message.getBoundingClientRect().width <= 1,
        stamped: sessionStorage.getItem('mxqr-boot-continuity') !== null,
        // The box the screen centres them in, for the next page to keep.
        box:
          sessionStorage.getItem('mxqr-boot-continuity-box') ===
          `${Math.round(innerWidth)}x${document.getElementById('session-reset-overlay')!.offsetHeight}`,
        // Still the reset's page: the next one has not been let in yet.
        pending: document.documentElement.classList.contains('session-reset-pending'),
      };
    });
    releaseNavigation();
    expect(screen).toEqual({
      visible: true,
      wordmark: -24,
      loader: 24,
      wordmarkHeight: 24,
      loaderMoving: ['boot-splash-arc', 'boot-splash-head', 'boot-splash-spin', 'boot-splash-tail'],
      message: 'Leaving session...',
      messageClipped: true,
      stamped: true,
      box: true,
      pending: true,
    });

    // The page the reset opened shows them in their final place at once.
    await expect(page.locator('#setup-overlay.active')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.boot-splash')).toHaveAttribute('data-phase', 'settled');
    expect(await page.evaluate(() => sessionStorage.getItem('mxqr-boot-continuity'))).toBeNull();
    expect(
      await page.evaluate(() => sessionStorage.getItem('mxqr-boot-continuity-box')),
    ).toBeNull();
    // It left only once the screen had faded in (0.2 s), so the next page took
    // over a whole screen rather than a half-shown one.
    expect(
      Number(await page.evaluate(() => sessionStorage.getItem('e2e-reset-opacity-at-leave'))),
    ).toBeGreaterThanOrEqual(0.95);
  });

  test('a page a reset opens shows the stored theme and the settled splash from its first frame', async ({
    page,
  }) => {
    // The device is light and the app dark: bootstrap.js applies the stored
    // theme, but the splash can paint before it runs.
    await page.emulateMedia({ colorScheme: 'light' });
    await useAnonymousAccountSession(page);
    await page.goto('/');
    await waitForBootstrapReady(page);
    await page.evaluate(() => {
      localStorage.setItem('musixquare-theme', 'dark');
      // What a reset stamps just before it navigates (session-reset.ts).
      sessionStorage.setItem('mxqr-boot-continuity', String(Date.now()));
    });
    type Frame = { bg: string; mark: string; loader: string; ring: string };
    await page.addInitScript(() => {
      const frames: Frame[] = [];
      (window as typeof window & { __firstFrames: Frame[] }).__firstFrames = frames;
      const sample = () => {
        const splash = document.querySelector('.boot-splash');
        const mark = splash?.querySelector('.boot-splash-mark');
        const loader = splash?.querySelector('.boot-splash-spinner');
        if (splash && mark && loader) {
          const loaderStyle = getComputedStyle(loader);
          // The loader's ring needs no image: a clip path, drawn in the same
          // frame (a mask image's data URL decodes on a later task in WebKit,
          // which paints nothing of a masked element until it has loaded).
          const clip = loaderStyle.clipPath || loaderStyle.getPropertyValue('-webkit-clip-path');
          const mask =
            loaderStyle.getPropertyValue('mask-image') ||
            loaderStyle.getPropertyValue('-webkit-mask-image');
          frames.push({
            bg: getComputedStyle(splash).backgroundColor,
            mark: getComputedStyle(mark).opacity,
            loader: loaderStyle.opacity,
            ring: `${clip.startsWith('path(') ? 'clip' : clip} ${mask}`,
          });
        }
        if (frames.length < 3) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    // Hold the next page's bootstrap.js, so its first frames come before it.
    let releaseBootstrap = (): void => undefined;
    const bootstrapHeld = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    await page.route(/\/bootstrap\.js(?:\?.*)?$/u, async (route) => {
      await bootstrapHeld;
      await route.fallback();
    });
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(
      () =>
        ((window as typeof window & { __firstFrames?: Frame[] }).__firstFrames?.length ?? 0) >= 2,
      null,
      { timeout: 10_000, polling: 20 },
    );
    const frames = await page.evaluate(
      () => (window as typeof window & { __firstFrames: Frame[] }).__firstFrames,
    );
    releaseBootstrap();
    // Dark from the first frame, with the wordmark and loader where the reset
    // screen showed them, the loader's ring a clip.
    expect(frames.slice(0, 2)).toEqual([
      { bg: 'rgb(18, 18, 18)', mark: '1', loader: '1', ring: 'clip none' },
      { bg: 'rgb(18, 18, 18)', mark: '1', loader: '1', ring: 'clip none' },
    ]);
  });

  // Owner report 2026-11-16: on an iPhone the page a refresh opened got a
  // first screen short by the home indicator strip, and the wordmark and
  // loader, centred in that screen, jumped up by half the strip and back.
  test("a page a reset opens keeps the reset screen's place while its first screen is shorter", async ({
    page,
  }) => {
    await useAnonymousAccountSession(page);
    await page.goto('/');
    await waitForBootstrapReady(page);
    const { width, height } = page.viewportSize()!;
    // What a reset leaves just before it navigates (session-reset.ts): the
    // stamp and the box its screen centred the wordmark and loader in.
    await page.evaluate(() => {
      sessionStorage.setItem('mxqr-boot-continuity', String(Date.now()));
      sessionStorage.setItem('mxqr-boot-continuity-box', `${innerWidth}x${innerHeight}`);
    });
    type Frame = { screen: number; mark: number };
    await page.addInitScript(() => {
      const frames: Frame[] = [];
      (window as typeof window & { __firstFrames: Frame[] }).__firstFrames = frames;
      const sample = () => {
        const mark = document.querySelector('.boot-splash .boot-splash-mark');
        if (mark) {
          const box = mark.getBoundingClientRect();
          frames.push({ screen: innerHeight, mark: box.top + box.height / 2 });
        }
        if (frames.length < 3) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    // Hold the next page's bootstrap.js, so its first frames come before it.
    let releaseBootstrap = (): void => undefined;
    const bootstrapHeld = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    await page.route(/\/bootstrap\.js(?:\?.*)?$/u, async (route) => {
      await bootstrapHeld;
      await route.fallback();
    });
    // The next page's first screen stops 34 px short, as an iPhone's does by
    // its home indicator strip.
    await page.setViewportSize({ width, height: height - 34 });
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(
      () =>
        ((window as typeof window & { __firstFrames?: Frame[] }).__firstFrames?.length ?? 0) >= 2,
      null,
      { timeout: 10_000, polling: 20 },
    );
    const frames = await page.evaluate(
      () => (window as typeof window & { __firstFrames: Frame[] }).__firstFrames,
    );
    releaseBootstrap();
    await page.setViewportSize({ width, height });
    // The mark stays where the reset screen centred it: half the full screen down.
    expect(
      frames
        .slice(0, 2)
        .map((frame) => ({ screen: frame.screen, mark: Math.round(frame.mark * 2) / 2 })),
    ).toEqual([
      { screen: height - 34, mark: height / 2 },
      { screen: height - 34, mark: height / 2 },
    ]);
  });

  // Owner report 2026-11-16, after 9.0.51: opening the installed app for the
  // first time, the first screen stopped short by the strip and the wordmark,
  // centred in it, came down when it went. No reset leaves a box there; the
  // installed app fills the screen iOS reports, so the splash takes that height.
  test("an installed app's first open keeps the wordmark where the full screen centres it while its first screen is shorter", async ({
    page,
  }) => {
    await useAnonymousAccountSession(page);
    await page.goto('/');
    await waitForBootstrapReady(page);
    const { width, height } = page.viewportSize()!;
    type Frame = { screen: number; wordmark: number; installed: boolean };
    // Opened from the iOS home screen (WebKit's navigator.standalone), on a
    // screen the size of this window.
    await page.addInitScript(
      ({ screenWidth, screenHeight }) => {
        Object.defineProperty(Navigator.prototype, 'standalone', {
          configurable: true,
          get: () => true,
        });
        // An iPhone's touch screen (Chromium and desktop WebKit report none).
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
          configurable: true,
          get: () => 5,
        });
        Object.defineProperty(Screen.prototype, 'width', {
          configurable: true,
          get: () => screenWidth,
        });
        Object.defineProperty(Screen.prototype, 'height', {
          configurable: true,
          get: () => screenHeight,
        });
        const frames: Frame[] = [];
        (window as typeof window & { __firstFrames: Frame[] }).__firstFrames = frames;
        const sample = () => {
          // The wordmark itself: on a first open it stands alone at the centre (its
          // mark box also holds the loader's place below it).
          const wordmark = document.querySelector('.boot-splash .boot-splash-logo');
          if (wordmark) {
            const box = wordmark.getBoundingClientRect();
            frames.push({
              screen: innerHeight,
              wordmark: box.top + box.height / 2,
              installed: document.documentElement.hasAttribute('data-boot-installed'),
            });
          }
          if (frames.length < 3) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      },
      { screenWidth: width, screenHeight: height },
    );
    // Hold bootstrap.js, so the first frames come before it.
    let releaseBootstrap = (): void => undefined;
    const bootstrapHeld = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    await page.route(/\/bootstrap\.js(?:\?.*)?$/u, async (route) => {
      await bootstrapHeld;
      await route.fallback();
    });
    // A first open (no reset stamp), on a first screen 34 px short, as an
    // iPhone's is by its home indicator strip.
    await page.evaluate(() => sessionStorage.clear());
    await page.setViewportSize({ width, height: height - 34 });
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForFunction(
      () =>
        ((window as typeof window & { __firstFrames?: Frame[] }).__firstFrames?.length ?? 0) >= 2,
      null,
      { timeout: 10_000, polling: 20 },
    );
    const frames = await page.evaluate(
      () => (window as typeof window & { __firstFrames: Frame[] }).__firstFrames,
    );
    releaseBootstrap();
    await page.setViewportSize({ width, height });
    // The wordmark sits where the full screen centres it: half the full screen down.
    expect(
      frames.slice(0, 2).map((frame) => ({
        screen: frame.screen,
        wordmark: Math.round(frame.wordmark * 2) / 2,
        installed: frame.installed,
      })),
    ).toEqual([
      { screen: height - 34, wordmark: height / 2, installed: true },
      { screen: height - 34, wordmark: height / 2, installed: true },
    ]);
  });

  // The strip iOS paints there is pure black in the dark theme and pure white
  // in the light one (owner report, 2026-11-16): an installed app's splash
  // starts on that colour, its refresh screen ends on it, and elsewhere both
  // keep the app's palette.
  test("an installed app's splash starts on the strip's colour, rises to the app's once the strip is gone, and its refresh screen ends on it", async ({
    page,
  }) => {
    await useAnonymousAccountSession(page);
    await page.goto('/');
    await waitForBootstrapReady(page);
    const { width, height } = page.viewportSize()!;
    await page.addInitScript(
      ({ screenWidth, screenHeight }) => {
        Object.defineProperty(Navigator.prototype, 'standalone', {
          configurable: true,
          get: () => true,
        });
        // An iPhone's touch screen (Chromium and desktop WebKit report none).
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
          configurable: true,
          get: () => 5,
        });
        Object.defineProperty(Screen.prototype, 'width', {
          configurable: true,
          get: () => screenWidth,
        });
        Object.defineProperty(Screen.prototype, 'height', {
          configurable: true,
          get: () => screenHeight,
        });
      },
      { screenWidth: width, screenHeight: height },
    );
    // Hold bootstrap.js, so the app never takes the screen while this reads it.
    let releaseBootstrap = (): void => undefined;
    const bootstrapHeld = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    await page.route(/\/bootstrap\.js(?:\?.*)?$/u, async (route) => {
      await bootstrapHeld;
      await route.fallback();
    });
    // A first open on a first screen 34 px short: the strip shows, so the
    // preflight holds the splash.
    await page.evaluate(() => sessionStorage.clear());
    await page.setViewportSize({ width, height: height - 34 });
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForFunction(
      () => document.documentElement.hasAttribute('data-boot-hold'),
      null,
      { timeout: 10_000, polling: 20 },
    );
    const read = () =>
      page.evaluate(() => {
        const splash = document.querySelector('.boot-splash') as HTMLElement;
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          background: getComputedStyle(splash).backgroundColor,
          up: !splash.hidden && getComputedStyle(splash).opacity === '1',
        };
      });
    const held = await read();
    expect(held.background).toBe(held.theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
    expect(held.up).toBe(true);
    // The strip goes: the screen grows and platform.ts ends the hold (its own
    // part, src/core/__tests__/platform.test.ts); the app still loads.
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.documentElement.removeAttribute('data-boot-hold'));
    await page.waitForTimeout(500);
    const risen = await read();
    expect(risen.background).toBe(
      risen.theme === 'dark' ? 'rgb(18, 18, 18)' : 'rgb(248, 249, 250)',
    );
    expect(risen.up).toBe(true);
    releaseBootstrap();
    await waitForBootstrapReady(page);
    // The refresh screen with the app stylesheet (its layer and palette) loaded.
    const overlay = await page.evaluate(() => {
      const root = document.documentElement;
      const screen = document.createElement('div');
      screen.className = 'session-reset-overlay';
      document.body.append(screen);
      const read = (theme: string, installed: boolean) => {
        root.setAttribute('data-theme', theme);
        root.toggleAttribute('data-boot-installed', installed);
        return getComputedStyle(screen).backgroundColor;
      };
      const colours = {
        installedDark: read('dark', true),
        installedLight: read('light', true),
        browserDark: read('dark', false),
        browserLight: read('light', false),
      };
      screen.remove();
      return colours;
    });
    expect(overlay).toEqual({
      installedDark: 'rgb(0, 0, 0)',
      installedLight: 'rgb(255, 255, 255)',
      browserDark: 'rgb(18, 18, 18)',
      browserLight: 'rgb(248, 249, 250)',
    });
  });

  test('a continued splash keeps the wordmark and loader on a screen turned after its first frame', async ({
    page,
  }) => {
    await useAnonymousAccountSession(page);
    await page.goto('/');
    await waitForBootstrapReady(page);
    const { width, height } = page.viewportSize()!;
    await page.evaluate(() => {
      sessionStorage.setItem('mxqr-boot-continuity', String(Date.now()));
      sessionStorage.setItem('mxqr-boot-continuity-box', `${innerWidth}x${innerHeight}`);
    });
    let releaseBootstrap = (): void => undefined;
    const bootstrapHeld = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    await page.route(/\/bootstrap\.js(?:\?.*)?$/u, async (route) => {
      await bootstrapHeld;
      await route.fallback();
    });
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(
      () => document.documentElement.hasAttribute('data-boot-continued'),
      null,
      { timeout: 10_000, polling: 20 },
    );
    // The device turns while the page still boots.
    await page.setViewportSize({ width: height, height: width });
    const turned = await page.evaluate(
      () =>
        new Promise<{ screen: number; mark: number }>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const box = document
                .querySelector('.boot-splash .boot-splash-mark')!
                .getBoundingClientRect();
              resolve({ screen: innerHeight, mark: box.top + box.height / 2 });
            }),
          );
        }),
    );
    releaseBootstrap();
    await page.setViewportSize({ width, height });
    // On the turned screen, within half the kept height's 64 px window of its
    // centre (and half a pixel of rounding).
    expect(turned.screen).toBe(width);
    expect(Math.abs(turned.mark - turned.screen / 2)).toBeLessThanOrEqual(32.5);
  });

  test('a continued splash fills the page wherever the desktop layout scales it', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'the desktop layout runs in the Chromium lane');
    // A QHD screen: the app stylesheet scales body by 1.2 (css/desktop.css).
    await page.setViewportSize({ width: 2560, height: 1440 });
    await useAnonymousAccountSession(page);
    await page.goto('/');
    await waitForBootstrapReady(page);
    // A box as tall as the window, as a reset screen in the fake fullscreen
    // (which unscales body) measures it.
    await page.evaluate(() => {
      sessionStorage.setItem('mxqr-boot-continuity', String(Date.now()));
      sessionStorage.setItem('mxqr-boot-continuity-box', `${innerWidth}x${innerHeight}`);
    });
    // Hold the app module, so the splash stays while the app stylesheet applies.
    let releaseApp = (): void => undefined;
    const appHeld = new Promise<void>((resolve) => {
      releaseApp = resolve;
    });
    await page.route(/\/assets\/main-[^/]+\.js$/u, async (route) => {
      await appHeld;
      await route.fallback();
    });
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => getComputedStyle(document.body).transform !== 'none', null, {
      timeout: 15_000,
      polling: 50,
    });
    const placed = await page.evaluate(() => {
      const box = document.querySelector('.boot-splash .boot-splash-mark')!.getBoundingClientRect();
      return { screen: innerHeight, mark: Math.round(box.top + box.height / 2) };
    });
    releaseApp();
    await page.setViewportSize({ width: 1280, height: 720 });
    expect(placed).toEqual({ screen: 1440, mark: 720 });
  });
});

// Owner decision 2026-11-16: over an installed iOS app's first screen that iOS
// gives short by the home indicator strip, the splash stays over the app until
// the screen has grown (index.html's head preflight marks data-boot-hold,
// src/core/platform.ts ends it, at the latest when its boot window ends), so the
// app never shows on that screen and never jumps as it grows.
test.describe('installed iOS app', () => {
  // platform.ts reads iOS from the user agent (the WebKit lane's iPhone has it).
  test.use({
    serviceWorkers: 'block',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  });

  type HoldLog = { held: boolean; fades: number; fadeWhileHeld: boolean };

  async function openInstalledOnShortScreen(
    page: Page,
  ): Promise<{ width: number; height: number }> {
    await useAnonymousAccountSession(page);
    await page.goto('/');
    await waitForBootstrapReady(page);
    const { width, height } = page.viewportSize()!;
    await page.addInitScript(
      ({ screenWidth, screenHeight }) => {
        Object.defineProperty(Navigator.prototype, 'standalone', {
          configurable: true,
          get: () => true,
        });
        // An iPhone's touch screen (Chromium and desktop WebKit report none).
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
          configurable: true,
          get: () => 5,
        });
        Object.defineProperty(Screen.prototype, 'width', {
          configurable: true,
          get: () => screenWidth,
        });
        Object.defineProperty(Screen.prototype, 'height', {
          configurable: true,
          get: () => screenHeight,
        });
        const log: HoldLog = { held: false, fades: 0, fadeWhileHeld: false };
        (window as typeof window & { __holdLog: HoldLog }).__holdLog = log;
        // The document has no root yet when this runs: watch the document itself.
        const held = () => document.documentElement?.hasAttribute('data-boot-hold') === true;
        new MutationObserver(() => {
          if (held()) log.held = true;
        }).observe(document, {
          attributes: true,
          subtree: true,
          attributeFilter: ['data-boot-hold'],
        });
        document.addEventListener(
          'animationstart',
          (event) => {
            if ((event as AnimationEvent).animationName !== 'boot-splash-out') return;
            log.fades += 1;
            if (held()) log.fadeWhileHeld = true;
          },
          true,
        );
      },
      { screenWidth: width, screenHeight: height },
    );
    // A first open (no reset stamp) on a first screen 34 px short.
    await page.evaluate(() => sessionStorage.clear());
    await page.setViewportSize({ width, height: height - 34 });
    await page.goto('/');
    await page.waitForFunction(
      () => !document.documentElement.classList.contains('setup-boot-block'),
      null,
      { timeout: 30_000, polling: 50 },
    );
    return { width, height };
  }

  const splashRetired = (page: Page) =>
    page.waitForFunction(
      () => (document.querySelector('.boot-splash') as HTMLElement | null)?.hidden === true,
      null,
      { timeout: 5_000, polling: 50 },
    );

  test('keeps the splash over the app while the first screen is short, and fades it only once the hold ends', async ({
    page,
  }) => {
    const { width, height } = await openInstalledOnShortScreen(page);
    await page.setViewportSize({ width, height });
    await splashRetired(page);
    const log = await page.evaluate(
      () => (window as typeof window & { __holdLog: HoldLog }).__holdLog,
    );
    expect(log.held).toBe(true);
    expect(log.fades).toBeGreaterThan(0);
    expect(log.fadeWhileHeld).toBe(false);
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-boot-hold'))).toBe(
      false,
    );
  });

  test('ends the hold with the boot window when the first screen never grows', async ({ page }) => {
    await openInstalledOnShortScreen(page);
    await splashRetired(page);
    const log = await page.evaluate(
      () => (window as typeof window & { __holdLog: HoldLog }).__holdLog,
    );
    expect(log.held).toBe(true);
    expect(log.fadeWhileHeld).toBe(false);
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-boot-hold'))).toBe(
      false,
    );
  });

  // Owner report 2026-11-17: on a refresh of the installed iPhone app the strip
  // under the short first screen showed the app's own background (dark in the
  // dark theme, light in the light one) around the time the app finished
  // loading, under a splash still pure black or white. iOS paints the strip with
  // the page's own background, body's over the root's: the system's black or
  // white until the app stylesheet gives both the app's --bg. Every frame from
  // the splash's first to its last reads what iOS reads there.
  type StripFrame = {
    held: boolean;
    /** The app stylesheet has applied: the root has its --bg. */
    sheet: boolean;
    theme: string | null;
    root: string;
    body: string;
    splash: string;
  };

  for (const row of [
    {
      label: 'a first open whose screen grows',
      device: 'dark',
      stored: null,
      refresh: false,
      grows: true,
    },
    {
      label: 'a first open whose screen never grows',
      device: 'light',
      stored: null,
      refresh: false,
      grows: false,
    },
    {
      label: 'a session refresh whose screen grows, the app dark on a light device',
      device: 'light',
      stored: 'dark',
      refresh: true,
      grows: true,
    },
    {
      label: 'a session refresh whose screen grows, the app light on a dark device',
      device: 'dark',
      stored: 'light',
      refresh: true,
      grows: true,
    },
  ] as const) {
    test(`keeps the page's background on the splash's colour while it holds, and raises it with the splash: ${row.label}`, async ({
      page,
    }) => {
      const theme = row.stored ?? row.device;
      await page.emulateMedia({ colorScheme: row.device });
      await useAnonymousAccountSession(page);
      await page.goto('/');
      await waitForBootstrapReady(page);
      const { width, height } = page.viewportSize()!;
      await page.evaluate((stored) => {
        if (stored) localStorage.setItem('musixquare-theme', stored);
        else localStorage.removeItem('musixquare-theme');
        sessionStorage.clear();
      }, row.stored);
      await page.addInitScript(
        ({ screenWidth, screenHeight }) => {
          Object.defineProperty(Navigator.prototype, 'standalone', {
            configurable: true,
            get: () => true,
          });
          // An iPhone's touch screen (Chromium and desktop WebKit report none).
          Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
            configurable: true,
            get: () => 5,
          });
          Object.defineProperty(Screen.prototype, 'width', {
            configurable: true,
            get: () => screenWidth,
          });
          Object.defineProperty(Screen.prototype, 'height', {
            configurable: true,
            get: () => screenHeight,
          });
          const frames: StripFrame[] = [];
          (window as typeof window & { __stripFrames: StripFrame[] }).__stripFrames = frames;
          // Every frame from the splash's first until the runtime retires it.
          const sample = () => {
            const root = document.documentElement;
            const splash = document.querySelector<HTMLElement>('.boot-splash');
            if (splash?.hidden) return;
            if (splash && document.body) {
              const rootStyle = getComputedStyle(root);
              frames.push({
                held: root.hasAttribute('data-boot-hold'),
                sheet: rootStyle.getPropertyValue('--bg').trim() !== '',
                theme: root.getAttribute('data-theme'),
                root: rootStyle.backgroundColor,
                body: getComputedStyle(document.body).backgroundColor,
                splash: getComputedStyle(splash).backgroundColor,
              });
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        },
        { screenWidth: width, screenHeight: height },
      );
      // The first screen stops 34 px short, as an iPhone's does by its home
      // indicator strip.
      await page.setViewportSize({ width, height: height - 34 });
      if (row.refresh) {
        // What a session refresh leaves just before it navigates
        // (session-reset.ts): the stamp, and the box its full screen centred
        // the wordmark and loader in.
        await page.evaluate((box) => {
          sessionStorage.setItem('mxqr-boot-continuity', String(Date.now()));
          sessionStorage.setItem('mxqr-boot-continuity-box', box);
        }, `${width}x${height}`);
        await page.reload({ waitUntil: 'commit' });
      } else {
        await page.goto('/', { waitUntil: 'commit' });
      }
      if (row.grows) {
        // The strip goes once the app stylesheet has applied under the hold and
        // the app waits behind the splash (unless the boot window already ended
        // the hold); platform.ts ends the hold when it sees the screen grow.
        await page.waitForFunction(
          () => {
            const root = document.documentElement;
            const frames =
              (window as typeof window & { __stripFrames?: StripFrame[] }).__stripFrames ?? [];
            return (
              !root.hasAttribute('data-boot-hold') ||
              (!root.classList.contains('setup-boot-block') &&
                frames.some((frame) => frame.held && frame.sheet))
            );
          },
          null,
          { timeout: 30_000, polling: 50 },
        );
        await page.setViewportSize({ width, height });
      }
      await page.waitForFunction(
        () => (document.querySelector('.boot-splash') as HTMLElement | null)?.hidden === true,
        null,
        { timeout: 30_000, polling: 50 },
      );
      const frames = await page.evaluate(
        () => (window as typeof window & { __stripFrames: StripFrame[] }).__stripFrames,
      );

      const strip = STRIP[theme];
      const background = APP_BG[theme];
      const lastHeld = frames.map((frame) => frame.held).lastIndexOf(true);
      const held = frames.slice(0, lastHeld + 1);
      const after = frames.slice(lastHeld + 1);
      // The run reached both halves: the app stylesheet applied while the splash
      // held, and the splash rose in the frames after.
      expect(tally(frames, (frame) => [frame.theme !== theme && `theme ${frame.theme}`])).toEqual(
        {},
      );
      expect(held.filter((frame) => frame.held && frame.sheet).length).toBeGreaterThan(0);
      expect(
        after.filter((frame) => between(frame.splash, strip, background)).length,
      ).toBeGreaterThanOrEqual(3);
      expect({
        // While it holds, the page is the splash's colour, before and after the
        // app stylesheet applies.
        held: tally(held, (frame) => [
          !frame.held && 'not held',
          (pageColour(frame) !== strip || frame.splash !== strip) &&
            `${frame.sheet ? 'with' : 'before'} the app stylesheet: page ${pageColour(frame)}, splash ${frame.splash}`,
        ]),
        // Then it rises with the splash, frame for frame, body with the root.
        rising: after
          .filter((frame) => !near(frame.root, frame.splash) || frame.body !== frame.root)
          .map((frame) => `root ${frame.root}, body ${frame.body}, splash ${frame.splash}`),
      }).toEqual({ held: {}, rising: [] });

      // Nothing stays on the root afterwards: the app's own background follows
      // a theme change at once.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const root = document.documentElement;
            return {
              root: getComputedStyle(root).backgroundColor,
              body: getComputedStyle(document.body).backgroundColor,
              inEffect: root
                .getAnimations()
                .filter(
                  (animation) => (animation.effect?.getComputedTiming().progress ?? null) !== null,
                )
                .map((animation) => (animation as CSSAnimation).animationName),
            };
          }),
        )
        .toEqual({ root: background, body: background, inEffect: [] });
      const other = theme === 'dark' ? 'light' : 'dark';
      const flipped = await page.evaluate(
        (next) =>
          new Promise<{ root: string; body: string }>((resolve) => {
            const root = document.documentElement;
            root.setAttribute('data-theme', next);
            requestAnimationFrame(() =>
              resolve({
                root: getComputedStyle(root).backgroundColor,
                body: getComputedStyle(document.body).backgroundColor,
              }),
            );
          }),
        other,
      );
      expect(flipped).toEqual({ root: APP_BG[other], body: APP_BG[other] });
    });
  }
});
