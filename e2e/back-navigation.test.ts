import { expect, test, type Page } from '@playwright/test';
import { E2E_APP_ORIGIN } from './config.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupGuest } from './helpers/setup-flow.ts';
import {
  clickPlayButton,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
  waitForState,
} from './helpers/wait.ts';

test.use({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });

// Real browser History API traversal and production overlay owners are under
// test here. Desktop Playwright WebKit does not reproduce Safari's native edge
// swipe snapshots, nor does its Windows build provide PeerJS/WebRTC transport.
interface HistoryObservation {
  duringPopstate: boolean;
  setupVisible: boolean;
  dialogVisible: boolean;
  pathname: string;
}

interface BackProbe {
  pushes: HistoryObservation[];
  popCount: number;
  forwardOnNextPop: boolean;
  closeEvents?: ('opacity-end' | 'opacity-cancel' | 'push')[];
  closeEventDetails?: string[];
}

interface TestWindow extends Window {
  __backNavigationProbe: BackProbe;
  __MUSIXQUARE_GET_STATE__: (path: string) => unknown;
  __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
  __MUSIXQUARE_BUS__: { emit: (type: string, ...args: unknown[]) => void };
}

const BEFORE_PATH = '/__e2e_back_navigation_before__';

async function preparePage(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  await page.route(`**${BEFORE_PATH}`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Before MUSIXQUARE</title><h1 id="previous-document">Previous document</h1>',
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem('musixquare-lang', 'en');
    const runtime = window as unknown as TestWindow;
    const probe: BackProbe = { pushes: [], popCount: 0, forwardOnNextPop: false };
    runtime.__backNavigationProbe = probe;
    let duringPopstate = false;
    const originalPush = history.pushState.bind(history);
    history.pushState = (...args) => {
      probe.closeEvents?.push('push');
      probe.pushes.push({
        duringPopstate,
        setupVisible:
          document.getElementById('setup-overlay')?.classList.contains('active') ?? false,
        dialogVisible:
          document.getElementById('dialog-overlay')?.classList.contains('show') ?? false,
        pathname: location.pathname,
      });
      originalPush(...args);
    };
    window.addEventListener('popstate', () => {
      duringPopstate = true;
      probe.popCount += 1;
      // Keep the flag through the next rendering opportunity, including
      // microtasks that a browser may run between native event listeners.
      requestAnimationFrame(() => {
        duringPopstate = false;
      });
      queueMicrotask(() => {
        if (probe.forwardOnNextPop) {
          probe.forwardOnNextPop = false;
          history.forward();
        }
      });
    });
  });
  await page.goto(BEFORE_PATH);
  await expect(page.locator('#previous-document')).toBeVisible();
}

async function readProbe(page: Page): Promise<BackProbe> {
  return page.evaluate(() => (window as unknown as TestWindow).__backNavigationProbe);
}

async function waitForAnotherGuard(page: Page, previousPushes: number): Promise<void> {
  await expect
    .poll(async () => (await readProbe(page)).pushes.length)
    .toBeGreaterThan(previousPushes);
  const observations = (await readProbe(page)).pushes;
  // This is the regression boundary: history mutation may not run in the
  // popstate event that is still handing the browser's snapshot back to us.
  expect(observations.every((entry) => !entry.duringPopstate)).toBe(true);
}

async function goBackAndRearm(page: Page): Promise<void> {
  const previous = await readProbe(page);
  await page.goBack();
  await expect
    .poll(async () => (await readProbe(page)).popCount)
    .toBeGreaterThan(previous.popCount);
  await waitForAnotherGuard(page, previous.pushes.length);
}

async function openRoom(
  page: Page,
  browserName: string,
  beforeJoin?: () => Promise<void>,
): Promise<string | null> {
  await preparePage(page);
  await page.goto('/');
  await waitForBootstrapReady(page);
  await beforeJoin?.();
  let code: string | null = null;
  if (browserName === 'webkit') {
    // As in app-touch-policy, use the initialized application but replace only
    // unsupported signaling with a role fixture. State and setup DOM change in
    // the same order as the real host/guest entry; guard scheduling is real.
    await page.locator('[data-setup-language-trigger]').first().focus();
    await page.evaluate(() => {
      const runtime = window as unknown as TestWindow;
      runtime.__MUSIXQUARE_SET_STATE__('network.appRole', 'host');
      runtime.__MUSIXQUARE_SET_STATE__('setup.sessionStarted', true);
      document.getElementById('setup-overlay')?.classList.remove('active');
      document.body.classList.remove('overlay-open');
      runtime.__MUSIXQUARE_BUS__.emit('setup:app-entrance');
    });
  } else {
    await page.locator('#btn-setup-host').click();
    await expect(page.locator('#setup-code')).toHaveValue(/^\d{6}$/);
    code = await page.locator('#setup-code').inputValue();
    await page.locator('#btn-setup-confirm:not([disabled])').click();
  }
  await expect(page.locator('#setup-overlay')).not.toHaveClass(/\bactive\b/);
  await waitForAnotherGuard(page, 0);
  await expect(page.locator('#btn-media-source')).toBeVisible();
  return code;
}

test('room entry registers its guard after the setup surface has gone', async ({
  page,
  browserName,
}) => {
  await openRoom(page, browserName);
  const probe = await readProbe(page);
  expect(probe.pushes).toHaveLength(1);
  expect(probe.pushes[0]).toMatchObject({ duringPopstate: false, setupVisible: false });
  await goBackAndRearm(page);
  await expect(page.locator('#dialog-overlay')).toHaveClass(/\bshow\b/);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText('Stay');
  await page.locator('#btn-dialog-secondary').click();
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/\bshow\b/);
  await waitForState(page, 'setup.sessionStarted', true);
});

test('a window outside a room closes on Back before the previous document is reached', async ({
  page,
}) => {
  await preparePage(page);
  await page.goto('/');
  await waitForBootstrapReady(page);
  await page.locator('[data-setup-language-trigger]').first().click();
  await expect(page.locator('#language-dialog-overlay')).toHaveClass(/\bshow\b/);
  await waitForAnotherGuard(page, 0);
  await page.goBack();
  await expect(page.locator('#language-dialog-overlay')).not.toHaveClass(/\bshow\b/);
  await expect(page.locator('#setup-overlay')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/\bshow\b/);
  await page.goBack();
  await expect(page).toHaveURL(`${E2E_APP_ORIGIN}${BEFORE_PATH}`);
  await expect(page.locator('#previous-document')).toBeVisible();
});

test('closing a setup window by its button leaves no extra Back stop', async ({ page }) => {
  await preparePage(page);
  await page.goto('/');
  await waitForBootstrapReady(page);
  await page.locator('[data-setup-language-trigger]').first().click();
  await expect(page.locator('#language-dialog-overlay')).toHaveClass(/\bshow\b/);
  await waitForAnotherGuard(page, 0);
  await page.locator('#btn-language-dialog-done').click();
  await expect(page.locator('#language-dialog-overlay')).not.toHaveClass(/\bshow\b/);
  expect((await readProbe(page)).pushes).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(`${E2E_APP_ORIGIN}${BEFORE_PATH}`);
  await expect(page.locator('#previous-document')).toBeVisible();
});

test('room entry reuses the guard left by a dismissed account window', async ({
  page,
  browserName,
}) => {
  await openRoom(page, browserName, async () => {
    await page.evaluate(() =>
      (window as unknown as TestWindow).__MUSIXQUARE_BUS__.emit('account:open'),
    );
    await expect(page.locator('#account-dialog-overlay')).toHaveClass(/\bshow\b/);
    await waitForAnotherGuard(page, 0);
    await page.locator('#btn-account-login-close').click();
    await expect(page.locator('#account-dialog-overlay')).not.toHaveClass(/\bshow\b/);
    expect((await readProbe(page)).pushes).toHaveLength(1);
  });
  expect((await readProbe(page)).pushes).toHaveLength(1);
  await goBackAndRearm(page);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText('Stay');
  await page.locator('#btn-dialog-secondary').click();
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/\bshow\b/);
  expect((await readProbe(page)).pushes).toHaveLength(2);
  await waitForState(page, 'setup.sessionStarted', true);
});

test('Back closes nested windows and the leave confirmation one level at a time', async ({
  page,
  browserName,
}) => {
  await openRoom(page, browserName);
  await page.locator('#btn-media-source').click();
  await expect(page.locator('#media-source-overlay')).toHaveClass(/\bactive\b/);
  // Account events can arrive from several app surfaces. Keep the real media
  // window underneath, exercising modal-stack priority rather than a fake DOM.
  await page.evaluate(() =>
    (window as unknown as TestWindow).__MUSIXQUARE_BUS__.emit('account:open'),
  );
  await expect(page.locator('#account-dialog-overlay')).toHaveClass(/\bshow\b/);
  await goBackAndRearm(page);
  await expect(page.locator('#account-dialog-overlay')).not.toHaveClass(/\bshow\b/);
  await expect(page.locator('#media-source-overlay')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/\bshow\b/);
  await goBackAndRearm(page);
  await expect(page.locator('#media-source-overlay')).not.toHaveClass(/\bactive\b/);
  await goBackAndRearm(page);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText('Stay');
  await goBackAndRearm(page);
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/\bshow\b/);
  await waitForState(page, 'setup.sessionStarted', true);
  await goBackAndRearm(page);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText('Stay');
});

test('normal-motion Back re-arms only after the account closing transition ends', async ({
  page,
  browserName,
}) => {
  await openRoom(page, browserName);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const overlay = page.locator('#account-dialog-overlay');
  const hasTransition = await page.evaluate(async () => {
    const element = document.getElementById('account-dialog-overlay')!;
    let resolveOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      resolveOpened = resolve;
    });
    const onOpened = (event: TransitionEvent) => {
      if (
        event.target === element &&
        event.propertyName === 'opacity' &&
        element.classList.contains('show')
      ) {
        element.removeEventListener('transitionend', onOpened);
        resolveOpened();
      }
    };
    // In WebKit Animation.finished may resolve before its transitionend is
    // dispatched. Drain the actual opening event before observing the close.
    element.addEventListener('transitionend', onOpened);
    (window as unknown as TestWindow).__MUSIXQUARE_BUS__.emit('account:open');
    const hasMotion = getComputedStyle(element)
      .transitionDuration.split(',')
      .some((duration) => Number.parseFloat(duration) > 0);
    if (!hasMotion) {
      element.removeEventListener('transitionend', onOpened);
      return false;
    }
    await opened;
    const probe = (window as unknown as TestWindow).__backNavigationProbe;
    probe.closeEvents = [];
    probe.closeEventDetails = [];
    element.addEventListener('transitionend', (event) => {
      if (event.target === element && event.propertyName === 'opacity') {
        probe.closeEvents?.push('opacity-end');
        probe.closeEventDetails?.push(
          JSON.stringify({
            target: (event.target as HTMLElement).id,
            propertyName: event.propertyName,
            elapsedTime: event.elapsedTime,
            timeStamp: event.timeStamp,
            show: element.classList.contains('show'),
            opacity: getComputedStyle(element).opacity,
            pseudoElement: event.pseudoElement,
          }),
        );
      }
    });
    element.addEventListener('transitioncancel', (event) => {
      if (event.target === element && event.propertyName === 'opacity') {
        probe.closeEvents?.push('opacity-cancel');
      }
    });
    return true;
  });
  expect(hasTransition).toBe(true);

  await goBackAndRearm(page);
  await expect(overlay).not.toHaveClass(/\bshow\b/);
  await expect(overlay).toHaveCSS('opacity', '0');
  // Compare actual browser events, not a guessed 200 ms sleep. A push before
  // the opacity transition completes would snapshot the outgoing window.
  const observed = await readProbe(page);
  expect(observed.closeEvents, observed.closeEventDetails?.join('\n')).toEqual([
    'opacity-end',
    'push',
  ]);
  await waitForState(page, 'setup.sessionStarted', true);
});

test('Forward to the existing guard does not act as another Back', async ({
  page,
  browserName,
}) => {
  await openRoom(page, browserName);
  const before = await readProbe(page);
  // Traverse Forward immediately after reaching the base, before the two-frame
  // re-arm. This also covers a delayed Back event followed by a newer traversal.
  await page.evaluate(() => {
    (window as unknown as TestWindow).__backNavigationProbe.forwardOnNextPop = true;
  });
  await page.goBack();
  await expect
    .poll(async () => (await readProbe(page)).popCount)
    .toBeGreaterThanOrEqual(before.popCount + 2);
  await expect(page.locator('#dialog-overlay')).toHaveClass(/\bshow\b/);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText('Stay');
  await waitForState(page, 'setup.sessionStarted', true);
  await page.locator('#btn-dialog-secondary').click();
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/\bshow\b/);
  await goBackAndRearm(page);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText('Stay');
});

test('confirming Leave reaches the actual previous document without leaving an inert app', async ({
  page,
  browserName,
}) => {
  await openRoom(page, browserName);
  await goBackAndRearm(page);
  await expect(page.locator('#btn-dialog-ok')).toHaveText('Leave');
  await page.locator('#btn-dialog-ok').click();
  await expect(page).toHaveURL(`${E2E_APP_ORIGIN}${BEFORE_PATH}`);
  await expect(page.locator('#previous-document')).toBeVisible();
});

test('a required audio recovery dialog survives Back without leaving the session', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Actual file playback recovery uses the Chromium room transport lane.',
  );
  await openRoom(page, browserName);
  await uploadFixture(page, 'test01');
  await waitForFilePlaybackReady(page, 20_000);
  await clickPlayButton(page);
  await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 15_000);
  await page.evaluate(() => {
    const runtime = window as unknown as TestWindow;
    runtime.__MUSIXQUARE_BUS__.emit('audio:output-recovery-needed', {
      reason: 'clock-stalled',
      source: 'background-resume',
      queueItemId: runtime.__MUSIXQUARE_GET_STATE__('playlist.currentQueueItemId'),
    });
  });
  await expect(page.locator('#dialog-title')).toHaveText('Audio paused unexpectedly');
  await goBackAndRearm(page);
  await expect(page.locator('#dialog-title')).toHaveText('Audio paused unexpectedly');
  await expect(page.locator('#dialog-overlay')).toHaveClass(/\bshow\b/);
  await waitForState(page, 'setup.sessionStarted', true);
});

test('a guest joining through the code input retains a working Back guard', async ({
  page,
  browser,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'PeerJS host/guest transport is not available in Windows Playwright WebKit.',
  );
  const code = await openRoom(page, browserName);
  expect(code).toMatch(/^\d{6}$/);
  const context = await browser.newContext({ baseURL: E2E_APP_ORIGIN, serviceWorkers: 'block' });
  try {
    const guest = await context.newPage();
    await preparePage(guest);
    await setupGuest(guest, code!);
    await waitForAnotherGuard(guest, 0);
    expect((await readProbe(guest)).pushes.every((entry) => !entry.setupVisible)).toBe(true);
    await goBackAndRearm(guest);
    await expect(guest.locator('#btn-dialog-secondary')).toHaveText('Stay');
    await guest.locator('#btn-dialog-secondary').click();
    await waitForState(guest, 'setup.sessionStarted', true);
    await waitForState(page, 'setup.sessionStarted', true);
  } finally {
    await context.close();
  }
});
