/**
 * E2E: a window that opens by itself while a caret key is still down draws no
 * ring, in Chromium and in WebKit (review findings H-6 and H6-R1).
 *
 * A mouse user clicks the start screen's join-code field, types and holds
 * ArrowLeft. A caret key counts as keyboard navigation only when it moves
 * focus in its own turn, which ends with its keydown's task
 * (src/ui/hover-pointer.ts). Before the key is up, the "room is full" dialog
 * opens by itself and focuses its button, from a 0 ms timer: one that the
 * key's own task sets after the keyboard owner's listener, then one that a
 * page task after the key's sets. WebKit hands a port's message over only
 * after such a timer, so a turn that a message alone ended rang the button
 * there (Playwright's WebKit 26.6), never in Chromium.
 *
 * The WebKit lane (playwright.webkit.config.ts) runs this spec as Safari on a
 * Mac. e2e/keyboard-focus-ring.test.ts holds keys in a room, in Chromium.
 */
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { focusRing, openStartScreen, type FocusRing } from './helpers/focus-ring.ts';

test.use({
  serviceWorkers: 'block',
  colorScheme: 'dark',
  // A mouse or trackpad user: the WebKit lane's iPhone becomes Safari on a Mac.
  hasTouch: false,
  isMobile: false,
  userAgent: async ({ browserName }, use) => {
    await use(browserName === 'webkit' ? devices['Desktop Safari'].userAgent : undefined);
  },
});

type BusWindow = { __MUSIXQUARE_BUS__: { emit: (...args: unknown[]) => void } };

const dialog = (page: Page) => page.locator('#dialog-overlay.show');
const ok = (page: Page) => page.locator('#btn-dialog-ok');

/** Waits for focus to settle on `target`, then reads its ring. */
async function ringOn(page: Page, target: Locator): Promise<FocusRing> {
  await expect(target).toBeFocused();
  return focusRing(page);
}

/**
 * Sets a 0 ms timer that opens the "room is full" dialog, which src/ui/setup.ts
 * shows when a host turns the guest away: now, from this page task, or from
 * the task of the next keydown of `key`, after the keyboard owner's listener.
 */
async function openFullRoomDialogFromTimer(page: Page, at: 'now' | { key: string }): Promise<void> {
  await page.evaluate((when) => {
    const open = (): void => {
      window.setTimeout(() => {
        (window as unknown as BusWindow).__MUSIXQUARE_BUS__.emit(
          'network:session-full',
          'The room is full',
        );
      }, 0);
    };
    if (when === 'now') {
      open();
      return;
    }
    // Added after the app's own capture listener, so it runs after that one.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== when.key) return;
      document.removeEventListener('keydown', onKey, { capture: true });
      open();
    };
    document.addEventListener('keydown', onKey, { capture: true });
  }, at);
}

test('a dialog that opens by itself while a caret key is still down draws no ring', async ({
  page,
}) => {
  await openStartScreen(page);
  await page.locator('#btn-setup-guest').click();
  const field = page.locator('#setup-join-code');
  await expect(field).toBeVisible();

  await field.click();
  await page.keyboard.type('12');
  await openFullRoomDialogFromTimer(page, { key: 'ArrowLeft' });
  await page.keyboard.down('ArrowLeft');
  await expect(dialog(page)).toBeVisible();
  expect(await ringOn(page, ok(page)), "from the key's own task").toMatchObject({ ring: false });
  await page.keyboard.up('ArrowLeft');
  await ok(page).click();
  await expect(dialog(page)).toHaveCount(0);

  await field.click();
  await page.keyboard.down('ArrowLeft');
  await openFullRoomDialogFromTimer(page, 'now');
  await expect(dialog(page)).toBeVisible();
  expect(await ringOn(page, ok(page)), 'from a later task').toMatchObject({ ring: false });
  await page.keyboard.up('ArrowLeft');
});
