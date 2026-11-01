/**
 * Wait utilities for E2E tests.
 * Uses DOM-based signals and page.evaluate for state checks.
 */
import { errors, expect, type Locator, type Page } from '@playwright/test';

/** E2E-only playback labels derived from the current playback state.
 *  Used by chaos/recovery tests that want to assert "app is in some
 *  legitimate state" without pinning the exact mode/activity/lifecycle. */
export const VALID_PLAYBACK_PROJECTIONS = [
  'IDLE',
  'PAUSED',
  'PLAYING_AUDIO',
  'PLAYING_YOUTUBE',
  'PLAYING_SYSTEM_AUDIO',
] as const;

type PlaybackProjection = (typeof VALID_PLAYBACK_PROJECTIONS)[number];

interface PlaybackSnapshot {
  mode: unknown;
  activity: unknown;
  lifecycle: unknown;
  isReceivingSystemAudio: unknown;
  currentTrackMeta: unknown;
}

function projectPlaybackState(snapshot: PlaybackSnapshot): PlaybackProjection {
  const meta = snapshot.currentTrackMeta as { systemAudioPlaceholder?: boolean } | null | undefined;

  if (snapshot.mode === 'youtube') return 'PLAYING_YOUTUBE';
  if (
    snapshot.mode === 'system-audio' ||
    snapshot.isReceivingSystemAudio === true ||
    meta?.systemAudioPlaceholder === true
  ) {
    return 'PLAYING_SYSTEM_AUDIO';
  }
  if (snapshot.mode === 'file') {
    if (snapshot.activity === 'playing' || snapshot.lifecycle === 'PLAYING') {
      return 'PLAYING_AUDIO';
    }
    if (
      snapshot.activity === 'paused' ||
      snapshot.lifecycle === 'PAUSED' ||
      snapshot.lifecycle === 'READY'
    ) {
      return 'PAUSED';
    }
  }
  if (snapshot.lifecycle === 'PLAYING') return 'PLAYING_AUDIO';
  if (snapshot.lifecycle === 'PAUSED' || snapshot.lifecycle === 'READY') return 'PAUSED';
  return 'IDLE';
}

async function readPlaybackSnapshot(page: Page): Promise<PlaybackSnapshot> {
  return page.evaluate(() => {
    const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
      ((p: string) => unknown) | undefined;
    if (!get) {
      return {
        mode: undefined,
        activity: undefined,
        lifecycle: undefined,
        isReceivingSystemAudio: undefined,
        currentTrackMeta: undefined,
      };
    }

    return {
      mode: get('playback.mode'),
      activity: get('playback.activity'),
      lifecycle: get('playback.lifecycle'),
      isReceivingSystemAudio: get('systemAudio.isReceiving'),
      currentTrackMeta: get('player.currentTrackMeta'),
    };
  });
}

/**
 * Wait until the app's font owner has declared every font sheet (phase B in
 * src/i18n/locale-fonts.ts) and the browser has loaded the faces the page
 * shows, so layout specs measure with the final faces. The hook exists only
 * in dev and e2e builds.
 */
export async function waitForAppFonts(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as Record<string, unknown>).__MUSIXQUARE_FONTS_SETTLED__ instanceof
      Promise,
    undefined,
    { timeout },
  );
  await page.evaluate(async () => {
    await (window as unknown as { __MUSIXQUARE_FONTS_SETTLED__: Promise<void> })
      .__MUSIXQUARE_FONTS_SETTLED__;
    await document.fonts.ready;
  });
}

export async function readPlaybackProjection(page: Page): Promise<PlaybackProjection> {
  const hookProjection = await page.evaluate(() => {
    const hook = (window as unknown as Record<string, unknown>)
      .__MUSIXQUARE_GET_PLAYBACK_PROJECTION__ as (() => unknown) | undefined;
    return typeof hook === 'function' ? hook() : undefined;
  });

  if (VALID_PLAYBACK_PROJECTIONS.includes(hookProjection as PlaybackProjection)) {
    return hookProjection as PlaybackProjection;
  }

  return projectPlaybackState(await readPlaybackSnapshot(page));
}

export async function waitForPlaybackProjection(
  page: Page,
  expected: PlaybackProjection,
  timeout = 15_000,
): Promise<void> {
  await waitForPlaybackProjectionIn(page, [expected], timeout);
}

export async function waitForPlaybackProjectionIn(
  page: Page,
  allowedProjections: readonly PlaybackProjection[],
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (allowed) => {
      const hook = (window as unknown as Record<string, unknown>)
        .__MUSIXQUARE_GET_PLAYBACK_PROJECTION__ as (() => unknown) | undefined;
      if (typeof hook === 'function') return allowed.includes(hook() as PlaybackProjection);

      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        ((p: string) => unknown) | undefined;
      if (!get) return false;

      const meta = get('player.currentTrackMeta') as
        { systemAudioPlaceholder?: boolean } | null | undefined;
      const mode = get('playback.mode');
      const activity = get('playback.activity');
      const lifecycle = get('playback.lifecycle');
      const isReceivingSystemAudio = get('systemAudio.isReceiving');

      let projection: PlaybackProjection = 'IDLE';
      if (mode === 'youtube') projection = 'PLAYING_YOUTUBE';
      else if (
        mode === 'system-audio' ||
        isReceivingSystemAudio === true ||
        meta?.systemAudioPlaceholder === true
      ) {
        projection = 'PLAYING_SYSTEM_AUDIO';
      } else if (mode === 'file') {
        if (activity === 'playing' || lifecycle === 'PLAYING') projection = 'PLAYING_AUDIO';
        else if (activity === 'paused' || lifecycle === 'PAUSED' || lifecycle === 'READY') {
          projection = 'PAUSED';
        }
      } else if (lifecycle === 'PLAYING') projection = 'PLAYING_AUDIO';
      else if (lifecycle === 'PAUSED' || lifecycle === 'READY') projection = 'PAUSED';

      return allowed.includes(projection);
    },
    [...allowedProjections],
    { timeout },
  );
}

export async function waitForPlaybackProjectionReady(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const hook = (window as unknown as Record<string, unknown>)
        .__MUSIXQUARE_GET_PLAYBACK_PROJECTION__ as (() => unknown) | undefined;
      if (typeof hook === 'function') return hook() !== undefined;

      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        ((p: string) => unknown) | undefined;
      return typeof get === 'function';
    },
    undefined,
    { timeout },
  );
}

/**
 * Wait for a raw state path to equal the expected value.
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
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        ((p: string) => unknown) | undefined;
      if (!get) return false;
      const current = get(path as string);
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
    undefined,
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
      return isPlaying
        ? btn.classList.contains('playing') || btn.getAttribute('aria-label')?.includes('Pause')
        : !btn.classList.contains('playing') || btn.getAttribute('aria-label')?.includes('Play');
    },
    playing,
    { timeout },
  );
}

/**
 * Wait until the current local file has decoded and the transport is ready.
 */
export async function waitForFilePlaybackReady(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        ((p: string) => unknown) | undefined;
      if (!get) return false;
      const lifecycle = get('playback.lifecycle');
      return (
        get('files.current') != null &&
        (lifecycle === 'READY' || lifecycle === 'PLAYING' || lifecycle === 'PAUSED')
      );
    },
    undefined,
    { timeout },
  );
}

/**
 * Wait until the play button is clickable from the user's point of view.
 */
async function waitForPlayButtonReady(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const btn = document.getElementById('play-btn') as HTMLButtonElement | null;
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !btn.disabled &&
        btn.getAttribute('aria-disabled') !== 'true' &&
        btn.getAttribute('aria-busy') !== 'true' &&
        !btn.classList.contains('is-loading')
      );
    },
    undefined,
    { timeout },
  );
}

/**
 * Click the play button after readiness checks, with a DOM click fallback for
 * transient layout wrappers that can intercept Playwright's pointer action.
 */
export async function clickPlayButton(page: Page, timeout = 15_000): Promise<void> {
  await waitForPlayButtonReady(page, timeout);
  try {
    await page.locator('#play-btn').click({ timeout: 3_000 });
  } catch {
    await page.evaluate(() => document.getElementById('play-btn')?.click());
  }
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
 * Read a state value from the app (one-shot, no waiting).
 */
export async function readState(page: Page, statePath: string): Promise<unknown> {
  return page.evaluate((path) => {
    const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
      ((p: string) => unknown) | undefined;
    if (!get) return undefined;
    return get(path);
  }, statePath);
}

// ─── Additional Helpers ─────────────────────────────────────────

/**
 * Longest the fallback in waitForViewTransitionEnd waits for its two frames.
 * They come from the page's requestAnimationFrame, which a paused `page.clock`
 * stops; this Node-side bound keeps the wait from hanging there.
 */
const VIEW_TRANSITION_FALLBACK_FRAMES_MS = 250;

/** What a view transition of the app holds while it runs. */
interface ViewTransitionHold {
  /** `document.activeViewTransition` is set; null where the engine lacks it. */
  active: boolean | null;
  /** Running `::view-transition` animations: the signal where `active` is null. */
  animations: number;
  /** <html> still has the tab transition's `tab-header-transition` class. */
  marked: boolean;
}

/** Page function that reads the hold. waitUntilPressReaches inlines a copy. */
function readViewTransitionHold(): ViewTransitionHold {
  const active = (document as { activeViewTransition?: unknown }).activeViewTransition;
  return {
    active: active === undefined ? null : active !== null,
    animations: document
      .getAnimations()
      .filter((animation) =>
        (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition'),
      ).length,
    marked: document.documentElement.classList.contains('tab-header-transition'),
  };
}

/** True while a view transition runs, so pointer input is hit-tested to <html>. */
function transitionRuns(hold: ViewTransitionHold): boolean {
  return hold.active ?? hold.animations > 0;
}

/** Names each part of `hold` that still held, for the failure messages. */
function describeViewTransitionHold(hold: ViewTransitionHold): string {
  const held: string[] = [];
  if (hold.active === true) held.push('document.activeViewTransition was still set');
  if (hold.active === null && hold.animations > 0) {
    held.push(`${hold.animations} ::view-transition animations were still running`);
  }
  if (hold.marked) held.push('<html> still had the tab-header-transition class');
  return held.length > 0 ? held.join(' and ') : 'nothing held any more when it was read again';
}

/**
 * Wait until no view transition is running.
 *
 * The app swaps tabs and its media popups inside document.startViewTransition
 * (src/ui/dom.ts animateTransition). The new state is in the DOM from the
 * update callback on, about 300 ms before the cross-fade ends. While the
 * transition runs, pointer input is hit-tested to <html>. Chromium 153 does
 * that from the startViewTransition() call until the transition finishes.
 * WebKit 26.6 still hit-tests the old page through the update callback and
 * switches to <html> only once the update is done (by `.ready`). A Playwright
 * `click()` retries until the element receives the press, but a raw
 * `page.mouse`, `page.touchscreen` or CDP input press has no such check: it is
 * lost, and the gesture under test silently never starts.
 *
 * `document.activeViewTransition` names the running transition (Chromium and
 * WebKit in Playwright 1.63 both have it). Where an engine lacks it, the
 * transition's `::view-transition` animations stand in, read after two frames
 * (or VIEW_TRANSITION_FALLBACK_FRAMES_MS, whichever comes first) so a
 * transition whose update callback just ran has created them. The tab
 * transition's own `tab-header-transition` mark on <html> must be gone too.
 *
 * A timeout fails with a message that names what still held. Any other error,
 * such as a closed page, passes through unchanged.
 */
export async function waitForViewTransitionEnd(page: Page, timeout = 10_000): Promise<void> {
  const hasActiveViewTransition = await page.evaluate(() => {
    const active = (document as { activeViewTransition?: unknown }).activeViewTransition;
    return active !== undefined;
  });
  if (!hasActiveViewTransition) {
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        ),
        new Promise<void>((resolve) => {
          bound = setTimeout(resolve, VIEW_TRANSITION_FALLBACK_FRAMES_MS);
        }),
      ]);
    } finally {
      clearTimeout(bound);
    }
  }
  try {
    await page.waitForFunction(
      () => {
        if (document.documentElement.classList.contains('tab-header-transition')) return false;
        const active = (document as { activeViewTransition?: unknown }).activeViewTransition;
        if (active !== undefined) return active === null;
        return !document
          .getAnimations()
          .some((animation) =>
            (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith(
              '::view-transition',
            ),
          );
      },
      undefined,
      { timeout },
    );
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    const hold = await page.evaluate(readViewTransitionHold).catch(() => null);
    let consequence = '';
    if (hold !== null && transitionRuns(hold)) {
      consequence = ' Until it ends, every raw press lands on <html>.';
    } else if (hold?.marked) {
      consequence = ' No view transition was running: the tab transition left its mark behind.';
    }
    throw new Error(
      `The view transition wait timed out after ${timeout} ms: ` +
        (hold === null ? 'the page could not be read again' : describeViewTransitionHold(hold)) +
        `.${consequence}`,
      { cause: error },
    );
  }
}

/**
 * Wait until a raw press at `point` would reach `target` (any element it
 * matches, or a child of one), and fail at once when another element is there.
 *
 * A raw press has no actionability check, so one that lands elsewhere is lost
 * and the gesture under test silently never starts. The helper waits only
 * while a view transition runs (document.activeViewTransition is set, or where
 * an engine lacks it, a `::view-transition` animation or the tab mark is
 * there). The hit then is <html> in Chromium, or still the old page in WebKit
 * before the update is done (see waitForViewTransitionEnd), and neither says
 * where the press will land. Once no transition runs, the point must hit the
 * target. A toast, loader, dialog or any other layer over it fails at once
 * with its name, so a cover that would soon leave is reported, not waited out.
 */
export async function waitUntilPressReaches(
  target: Locator,
  point: { x: number; y: number },
  timeout = 5_000,
): Promise<void> {
  const press = `A press at (${Math.round(point.x)}, ${Math.round(point.y)})`;
  let probe: (ViewTransitionHold & { reaches: boolean; landsOn: string }) | undefined;
  try {
    await expect
      .poll(
        async () => {
          probe = await target.evaluateAll(
            (elements, { x, y }) => {
              // readViewTransitionHold, inlined: a page function cannot call it.
              const active = (document as { activeViewTransition?: unknown }).activeViewTransition;
              const hit = document.elementFromPoint(x, y);
              return {
                active: active === undefined ? null : active !== null,
                animations: document
                  .getAnimations()
                  .filter((animation) =>
                    (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith(
                      '::view-transition',
                    ),
                  ).length,
                marked: document.documentElement.classList.contains('tab-header-transition'),
                reaches: hit !== null && elements.some((element) => element.contains(hit)),
                landsOn: hit
                  ? hit.tagName.toLowerCase() +
                    (hit.id ? `#${hit.id}` : '') +
                    Array.from(hit.classList, (token) => `.${token}`).join('')
                  : 'nothing',
              };
            },
            { x: point.x, y: point.y },
          );
          // Where the engine lacks activeViewTransition, the tab mark also
          // stands for a transition whose animations do not exist yet.
          return probe.active ?? (probe.animations > 0 || probe.marked);
        },
        { timeout, intervals: [25] },
      )
      .toBe(false);
  } catch (error) {
    throw new Error(
      `${press} would land on ${probe?.landsOn ?? 'nothing'}, not on ${target.toString()}: ` +
        `a view transition was still running after ${timeout} ms (` +
        (probe ? describeViewTransitionHold(probe) : 'the page could not be read') +
        ').',
      { cause: error },
    );
  }
  if (!probe!.reaches) {
    throw new Error(
      `${press} would land on ${probe!.landsOn}, not on ${target.toString()}, ` +
        'with no view transition running: it covers the target.',
    );
  }
}

/**
 * Navigate to a tab and wait for the corresponding panel to become active.
 * Returns once the tab's cross-fade has ended, so a raw press that follows
 * reaches the panel (see waitForViewTransitionEnd).
 */
export async function navigateToTab(page: Page, tabName: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => !document.getElementById('setup-overlay')?.classList.contains('active'),
    undefined,
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
  // `.active` arrives inside the transition's update callback, before the
  // cross-fade ends; a raw press in that window lands on <html>.
  await waitForViewTransitionEnd(page, timeout);
}

/**
 * Navigate to a settings subtab and wait for its panel to become active.
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
export async function waitForTheme(page: Page, theme: string, timeout = 5_000): Promise<void> {
  await page.waitForFunction(
    (t) => document.documentElement.getAttribute('data-theme') === t,
    theme,
    { timeout },
  );
}

/**
 * Open the chat drawer across desktop and mobile layouts.
 */
export async function openChatDrawer(page: Page, timeout = 5_000): Promise<void> {
  await page.waitForFunction(
    () => !document.getElementById('setup-overlay')?.classList.contains('active'),
    undefined,
    { timeout },
  );
  if (await page.locator('#chat-drawer').evaluate((drawer) => drawer.classList.contains('open'))) {
    return;
  }
  const chatBtn = page.locator('#chat-preview-btn, .nav-item[data-tab="chat"]').first();
  try {
    await chatBtn.waitFor({ state: 'visible', timeout: 3_000 });
    await chatBtn.click();
  } catch {
    // Fallback: click via JS if element exists but isn't visible
    await page.evaluate(() => {
      const btn =
        document.getElementById('chat-preview-btn') ||
        document.querySelector('.nav-item[data-tab="chat"]');
      (btn as HTMLElement)?.click();
    });
  }
  await page.waitForFunction(
    () => document.getElementById('chat-drawer')?.classList.contains('open') ?? false,
    undefined,
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
    undefined,
    { timeout },
  );
}

/**
 * Safe visibility check that returns false when the element does not exist.
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
