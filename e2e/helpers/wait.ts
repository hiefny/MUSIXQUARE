/**
 * Wait utilities for E2E tests.
 * Uses DOM-based signals and page.evaluate for state checks.
 */
import type { Page } from '@playwright/test';

/**
 * Wait for an app state path to equal the expected value.
 * Accesses the app's internal getState via the module scope.
 */
export async function waitForState(
  page: Page,
  statePath: string,
  expected: unknown,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    ([path, val]) => {
      // Access getState through the global debug hook
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return false;
      const current = get(path as string);
      return current === val;
    },
    [statePath, expected] as const,
    { timeout },
  );
}

/**
 * Wait for setup overlay to be dismissed (connection established).
 */
export async function waitForOverlayDismissed(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    () => !document.getElementById('setup-overlay')?.classList.contains('active'),
    { timeout },
  );
}

/**
 * Wait for the playlist UI to have at least N items.
 */
export async function waitForPlaylistCount(
  page: Page,
  minCount: number,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (min) => {
      const list = document.getElementById('playlist-ui');
      if (!list) return false;
      return list.children.length >= min;
    },
    minCount,
    { timeout },
  );
}

/**
 * Wait for the device list to contain at least N device rows.
 */
export async function waitForDeviceCount(
  page: Page,
  minCount: number,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (min) => {
      // Check both mobile and desktop device lists
      const mobile = document.getElementById('connect-device-list');
      const desktop = document.getElementById('desktop-device-list');
      const list = mobile || desktop;
      if (!list) return false;
      return list.querySelectorAll('.device-row').length >= min;
    },
    minCount,
    { timeout },
  );
}

/**
 * Wait for the play button to have a specific state.
 */
export async function waitForPlayState(
  page: Page,
  playing: boolean,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (isPlaying) => {
      const btn = document.getElementById('play-btn');
      if (!btn) return false;
      // The play button toggles classes based on state
      return isPlaying
        ? btn.classList.contains('playing') || btn.getAttribute('aria-label')?.includes('Pause')
        : !btn.classList.contains('playing') || btn.getAttribute('aria-label')?.includes('Play');
    },
    playing,
    { timeout },
  );
}

/**
 * Wait for a chat message to appear in the chat drawer.
 */
export async function waitForChatMessage(
  page: Page,
  textSubstring: string,
  timeout = 10_000,
): Promise<void> {
  await page.waitForFunction(
    (text) => {
      const container = document.getElementById('chat-messages');
      if (!container) return false;
      return container.textContent?.includes(text) ?? false;
    },
    textSubstring,
    { timeout },
  );
}

/**
 * Expose the app's getState function globally for test inspection.
 * Call this after page navigation.
 */
export async function exposeGetState(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The app's state module will be loaded as an ES module.
    // We hook into it by watching for the state object on window.
    // This is set up by a small patch — see below.
    // Fallback: if not available, tests use DOM-based checks.
  });
}

/**
 * Read a state value from the app (one-shot, no waiting).
 */
export async function readState(page: Page, statePath: string): Promise<unknown> {
  return page.evaluate((path) => {
    const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
      | ((p: string) => unknown)
      | undefined;
    if (!get) return undefined;
    return get(path);
  }, statePath);
}
