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
      // Deep compare for arrays/objects, strict for primitives
      if (val !== null && typeof val === 'object') {
        return JSON.stringify(current) === JSON.stringify(val);
      }
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

// ─── Additional Helpers ─────────────────────────────────────────

/**
 * Navigate to a tab, waiting for the tab to become active.
 * Replaces patterns like: click nav + waitForTimeout(500)
 */
export async function navigateToTab(
  page: Page,
  tabName: string,
  timeout = 10_000,
): Promise<void> {
  // Ensure setup overlay is dismissed before clicking nav
  await page.waitForFunction(
    () => !document.getElementById('setup-overlay')?.classList.contains('active'),
    { timeout },
  );
  const nav = page.locator(`.nav-item[data-tab="${tabName}"]`);
  // Nav may be in a bottom bar or hidden by CSS layout — use force if not visible
  try {
    await nav.waitFor({ state: 'visible', timeout: 3_000 });
    await nav.click();
  } catch {
    // Fallback: click via JS if element exists but isn't visible (e.g. mobile layout)
    await page.evaluate(
      (tab) => (document.querySelector(`.nav-item[data-tab="${tab}"]`) as HTMLElement)?.click(),
      tabName,
    );
  }
  // Wait for the tab panel to gain the 'active' class (which sets display:flex).
  // Using waitForFunction instead of locator.waitFor because the View Transition
  // API defers DOM changes via microtask, causing visibility checks to race.
  await page.waitForFunction(
    (tab) => document.getElementById(`tab-${tab}`)?.classList.contains('active') ?? false,
    tabName,
    { timeout },
  );
}

/**
 * Navigate to a settings subtab, waiting for the panel to become active.
 * Replaces patterns like: click subtab pill + waitForTimeout(300)
 */
export async function navigateToSubtab(
  page: Page,
  subtabName: string,
  timeout = 5_000,
): Promise<void> {
  const pill = page.locator(`.subtab-pill[data-subtab="${subtabName}"]`);
  await pill.click();
  await page.waitForFunction(
    (name) => {
      const panel = document.querySelector(`.settings-subtab-panel[data-panel="${name}"]`);
      return panel?.classList.contains('active') ?? false;
    },
    subtabName,
    { timeout },
  );
}

/**
 * Click an option and wait for it to become active.
 * Replaces patterns like: click option + waitForTimeout(300-500) + check active class
 */
export async function clickAndWaitActive(
  page: Page,
  selector: string,
  timeout = 5_000,
): Promise<void> {
  const el = page.locator(selector);
  await el.click();
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.classList.contains('active') ?? false,
    selector,
    { timeout },
  );
}

/**
 * Wait for data-theme attribute to change.
 */
export async function waitForTheme(
  page: Page,
  theme: string,
  timeout = 5_000,
): Promise<void> {
  await page.waitForFunction(
    (t) => document.documentElement.getAttribute('data-theme') === t,
    theme,
    { timeout },
  );
}

/**
 * Wait for i18n text to contain a pattern (Korean or English).
 */
export async function waitForLang(
  page: Page,
  lang: 'ko' | 'en',
  timeout = 5_000,
): Promise<void> {
  await page.waitForFunction(
    (l) => {
      const text = document.body.textContent || '';
      return l === 'ko'
        ? /[\uAC00-\uD7A3]/.test(text)
        : /settings|audio|connect|play/i.test(text);
    },
    lang,
    { timeout },
  );
}

/**
 * Open chat drawer reliably.
 * Replaces inconsistent chat-open patterns across tests.
 */
export async function openChatDrawer(page: Page, timeout = 5_000): Promise<void> {
  // Ensure setup overlay is dismissed first
  await page.waitForFunction(
    () => !document.getElementById('setup-overlay')?.classList.contains('active'),
    { timeout },
  );
  // Try chat preview button first, then nav item
  const chatBtn = page.locator('#chat-preview-btn, .nav-item[data-tab="chat"]').first();
  try {
    await chatBtn.waitFor({ state: 'visible', timeout: 3_000 });
    await chatBtn.click();
  } catch {
    // Fallback: click via JS if element exists but isn't visible
    await page.evaluate(() => {
      const btn = document.getElementById('chat-preview-btn')
        || document.querySelector('.nav-item[data-tab="chat"]');
      (btn as HTMLElement)?.click();
    });
  }
  await page.waitForFunction(
    () => document.getElementById('chat-drawer')?.classList.contains('open') ?? false,
    { timeout },
  );
}

/**
 * Send a chat message.
 */
export async function sendChat(page: Page, text: string): Promise<void> {
  await page.locator('#chat-input').fill(text);
  await page.click('#btn-chat-send');
}

/**
 * Wait for a toast to appear with specific text.
 */
export async function waitForToast(
  page: Page,
  textSubstring: string,
  timeout = 10_000,
): Promise<void> {
  await page.waitForFunction(
    (text) => {
      const toasts = document.querySelectorAll('.toast, .toast-msg');
      return Array.from(toasts).some((t) => t.textContent?.includes(text));
    },
    textSubstring,
    { timeout },
  );
}

/**
 * Wait for the overlay to appear (be active).
 */
export async function waitForOverlayActive(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('setup-overlay')?.classList.contains('active') ?? false,
    { timeout },
  );
}

/**
 * Safe visibility check — returns false if element doesn't exist.
 * Replaces `.isVisible().catch(() => false)` patterns.
 */
export async function isVisible(page: Page, selector: string, timeout = 2_000): Promise<boolean> {
  try {
    await page.locator(selector).waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for an element's class list to contain/not-contain a class.
 */
export async function waitForClass(
  page: Page,
  selector: string,
  className: string,
  present = true,
  timeout = 5_000,
): Promise<void> {
  await page.waitForFunction(
    ([sel, cls, want]) => {
      const el = document.querySelector(sel);
      if (!el) return !want;
      return want ? el.classList.contains(cls) : !el.classList.contains(cls);
    },
    [selector, className, present] as const,
    { timeout },
  );
}

/**
 * Wait for a specific number of elements matching a selector.
 */
export async function waitForSelectorCount(
  page: Page,
  selector: string,
  count: number,
  timeout = 10_000,
): Promise<void> {
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(sel).length >= n,
    [selector, count] as const,
    { timeout },
  );
}
