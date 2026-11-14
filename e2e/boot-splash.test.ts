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
    await expect(page.locator('#setup-welcome-header .logo-welcome')).toHaveCSS(
      'visibility',
      'hidden',
    );
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

    const leave = page.locator('#desktop-btn-leave-session:visible, #btn-leave-session:visible');
    if (!(await leave.first().isVisible())) {
      await page.locator('.nav-item[data-tab="connect"]:visible').click();
    }
    await leave.first().click();
    await expect(page.locator('#dialog-overlay.show')).toBeVisible();
    await page.locator('#btn-dialog-ok').click();

    const overlay = page.locator('#session-reset-overlay');
    await expect(overlay).toHaveClass(/\bshow\b/u);
    await expect(overlay.locator('.session-reset-wordmark')).toBeVisible();
    await expect(overlay.locator('.boot-splash-spinner > svg')).toBeVisible();
    const screen = await page.evaluate(() => {
      const middle = innerHeight / 2;
      const centre = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return Math.round((box.top + box.height / 2 - middle) * 10) / 10;
      };
      const message = document.getElementById('session-reset-message')!;
      const loader = document.querySelector('#session-reset-overlay .boot-splash-spinner > svg')!;
      return {
        // The boot splash's final place: wordmark 24px above the centre, loader 24px below.
        wordmark: centre('#session-reset-overlay .session-reset-wordmark'),
        loader: centre('#session-reset-overlay .boot-splash-spinner > svg'),
        wordmarkHeight: document
          .querySelector('#session-reset-overlay .session-reset-wordmark')!
          .getBoundingClientRect().height,
        loaderTurning: loader
          .getAnimations()
          .some((animation) => animation.playState === 'running'),
        // The message is for screen readers only.
        message: message.textContent,
        messageClipped: message.getBoundingClientRect().width <= 1,
        stamped: sessionStorage.getItem('mxqr-boot-continuity') !== null,
      };
    });
    releaseNavigation();
    expect(screen).toEqual({
      wordmark: -24,
      loader: 24,
      wordmarkHeight: 24,
      loaderTurning: true,
      message: 'Leaving session...',
      messageClipped: true,
      stamped: true,
    });

    // The page the reset opened shows them in their final place at once.
    await expect(page.locator('#setup-overlay.active')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.boot-splash')).toHaveAttribute('data-phase', 'settled');
    expect(await page.evaluate(() => sessionStorage.getItem('mxqr-boot-continuity'))).toBeNull();
  });
});
