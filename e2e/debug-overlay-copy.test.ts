/**
 * The /debug overlay COPY button copies the text on screen inside its own tap
 * (owner decision 2026-11-04), which iPhone Safari requires of a clipboard
 * write. The page's clipboard and execCommand are stubbed, so the run never
 * touches the system clipboard; each call records the event the page was
 * handling when it ran (window.event), so 'click' means inside the tap. It runs
 * in the Chromium suite and in the iPhone WebKit lane.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { openChatDrawer, sendChat } from './helpers/wait.ts';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

interface CopyCall {
  readonly via: 'clipboard' | 'execCommand';
  /** The text written, or the hidden textarea's value. */
  readonly text: string;
  /** The overlay text on screen when the call ran. */
  readonly shown: string | null;
  /** The type of the event being dispatched when the call ran. */
  readonly event: string | null;
}

type CopyWindow = typeof window & {
  __debugCopyCalls?: CopyCall[];
  __debugCopyReject?: boolean;
};

async function installCopyRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const root = window as CopyWindow;
    root.__debugCopyCalls = [];
    root.__debugCopyReject = false;
    const shown = () => document.querySelector('.debug-memory-overlay pre')?.textContent ?? null;
    // window.event is the event being dispatched, or undefined outside one.
    const dispatching = () => (window as { event?: Event }).event?.type ?? null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(text: string): Promise<void> {
          root.__debugCopyCalls?.push({
            via: 'clipboard',
            text,
            shown: shown(),
            event: dispatching(),
          });
          return root.__debugCopyReject
            ? Promise.reject(new DOMException('Not allowed', 'NotAllowedError'))
            : Promise.resolve();
        },
      },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value(command: string): boolean {
        if (command !== 'copy') return false;
        const active = document.activeElement;
        root.__debugCopyCalls?.push({
          via: 'execCommand',
          text: active instanceof HTMLTextAreaElement ? active.value : '',
          shown: shown(),
          event: dispatching(),
        });
        return true;
      },
    });
  });
}

async function copyCalls(page: Page): Promise<CopyCall[]> {
  return page.evaluate(() => structuredClone((window as CopyWindow).__debugCopyCalls ?? []));
}

async function openHostApp(page: Page, browserName: string): Promise<void> {
  await installCopyRecorder(page);
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  if (browserName !== 'webkit') {
    await setupHostAndStart(page);
    return;
  }
  // The Windows Playwright WebKit build has no PeerJS WebRTC transport. As in
  // app-touch-policy.test.ts, seed the session role and dismiss setup; the
  // chat command, the overlay and the copy stay production code.
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
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
}

async function openDebugOverlay(
  page: Page,
  browserName: string,
  command: string,
  id: string,
): Promise<Locator> {
  await openHostApp(page, browserName);
  await openChatDrawer(page);
  await sendChat(page, command);
  const overlay = page.locator(`#${id}`);
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('pre')).not.toHaveText('');
  // The copy on open runs after the lazy import, outside any tap, and stays.
  await expect.poll(async () => (await copyCalls(page)).length).toBe(1);
  expect((await copyCalls(page))[0]).toMatchObject({ via: 'clipboard', event: null });
  return overlay;
}

test('COPY writes the console text on screen inside the tap and reads COPIED', async ({
  page,
  browserName,
}) => {
  const overlay = await openDebugOverlay(
    page,
    browserName,
    '/debug console',
    'debug-console-overlay',
  );
  const copy = overlay.locator('.onboarding-diagnostics-actions > button');
  await expect(copy).toHaveAccessibleName('COPY');

  await copy.tap();
  await expect(copy).toHaveText('COPIED');
  const calls = await copyCalls(page);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ via: 'clipboard', event: 'click' });
  expect(calls[1]!.text).toBe(calls[1]!.shown);
  await expect(overlay).toBeVisible();
});

test('COPY copies through a hidden textarea inside the tap when the Clipboard API rejects or is missing', async ({
  page,
  browserName,
}) => {
  const overlay = await openDebugOverlay(
    page,
    browserName,
    '/debug sync',
    'debug-sync-flight-overlay',
  );
  const copy = overlay.locator('.onboarding-diagnostics-actions > button');

  await page.evaluate(() => {
    (window as CopyWindow).__debugCopyReject = true;
  });
  await copy.tap();
  await expect(copy).toHaveText('COPIED');
  let calls = (await copyCalls(page)).slice(1);
  expect(calls.map(({ via, event }) => ({ via, event }))).toEqual([
    { via: 'clipboard', event: 'click' },
    { via: 'execCommand', event: 'click' },
  ]);
  expect(calls[1]!.text).toBe(calls[1]!.shown);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  // The first tap left COPIED: start from COPY, so the label shows this tap's result.
  await copy.evaluate((button) => {
    button.textContent = 'COPY';
  });
  await expect(copy).toHaveText('COPY');
  await copy.tap();
  calls = (await copyCalls(page)).slice(3);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ via: 'execCommand', event: 'click' });
  expect(calls[0]!.text).toBe(calls[0]!.shown);
  await expect(copy).toHaveText('COPIED');
  await expect(page.locator('body > textarea[readonly]')).toHaveCount(0);
  await expect(overlay).toBeVisible();
});

test('COPY leaves the tap-to-close screen overlay open', async ({ page, browserName }) => {
  const overlay = await openDebugOverlay(
    page,
    browserName,
    '/debug screen',
    'debug-screen-overlay',
  );
  const copy = overlay.locator('.onboarding-diagnostics-actions > button');

  await copy.tap();
  await expect(copy).toHaveText('COPIED');
  await expect(overlay).toBeVisible();
  expect((await copyCalls(page))[1]).toMatchObject({ via: 'clipboard', event: 'click' });

  await overlay.tap({ position: { x: 20, y: 20 } });
  await expect(overlay).toHaveCount(0);
});
