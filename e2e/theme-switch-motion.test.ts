/**
 * Theme switch motion: a switch between light and dark eases no surface from
 * the previous theme's colours.
 *
 * Owner report: right after a switch, surfaces with a colour transition (the
 * pressed theme chip, the header) showed the previous theme's colour for a
 * moment. setTheme() now holds a class on <html> that turns every transition
 * off for the one style change that swaps the palette (src/ui/settings.ts,
 * css/style.css).
 *
 * Each switch is pressed and read in one page script: it lists the running
 * animations, presses the other theme chip in the page, lists them again
 * (document getAnimations() flushes style first, so a transition from the
 * previous palette would be listed) and reads the surfaces' colours. No frame
 * passes in between. A mouse hover on an inactive chip shows first that
 * transitions run in this page, and again after each switch that the hold is
 * gone.
 *
 * Chromium opens a real local room in the desktop dashboard, where the play
 * actions sit beside Settings. The Windows Playwright WebKit build has no
 * PeerJS WebRTC transport, so the WebKit lane (iPhone layout) seeds the host
 * role in the initialized app instead, as app-touch-policy and
 * back-navigation do. No room code is typed anywhere.
 */
import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToSubtab, navigateToTab } from './helpers/wait.ts';

test.use({ serviceWorkers: 'block' });

type Theme = 'dark' | 'light';

interface TestWindow extends Window {
  __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
  __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
  __themeChipHoverRuns?: string[];
}

interface SurfaceReading {
  name: string;
  before: string;
  after: string;
  token: string;
}

interface SwitchReading {
  theme: string | null;
  started: string[];
  rootClassesKept: boolean;
  surfaces: SurfaceReading[];
}

function themeChip(page: Page, theme: Theme) {
  return page.locator(`#grid-theme .ch-opt[data-theme="${theme}"]`);
}

/** Waits for every running CSS transition to end, so the next step starts at rest. */
async function settleTransitions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

/**
 * Opens Settings in a room with the dark theme stored, once the boot guard and
 * the room entrance have let go of the transitions they own.
 */
async function openSettings(page: Page, browserName: string): Promise<{ playActions: boolean }> {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('musixquare-theme', 'dark');
    } catch {
      // Opaque documents such as about:blank have no storage.
    }
  });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  if (browserName === 'webkit') {
    await page.goto('/');
    await waitForBootstrapReady(page);
    await page.evaluate(() => {
      const runtime = window as unknown as TestWindow;
      runtime.__MUSIXQUARE_SET_STATE__('network.appRole', 'host');
      runtime.__MUSIXQUARE_SET_STATE__('setup.sessionStarted', true);
      document.getElementById('setup-overlay')?.classList.remove('active');
      document.body.classList.remove('overlay-open');
      runtime.__MUSIXQUARE_BUS__.emit('setup:app-entrance');
    });
  } else {
    await setupHostAndStart(page);
  }
  await page.waitForFunction(
    () =>
      !document.documentElement.classList.contains('is-booting') &&
      document.querySelector('.app-entrance') === null,
    undefined,
    { timeout: 10_000 },
  );

  await navigateToTab(page, 'settings');
  const general = page.locator('.subtab-pill[data-subtab="general"]');
  if (await general.isVisible()) await navigateToSubtab(page, 'general');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(themeChip(page, 'dark')).toHaveAttribute('aria-pressed', 'true');

  // Beside Settings (the desktop dashboard) the play actions ease their
  // surface only once the room's motion is ready.
  const actions = page.locator('.play-action-buttons');
  const playActions = await actions.isVisible();
  if (playActions) await expect(actions).toHaveAttribute('data-motion-ready', 'true');
  await settleTransitions(page);
  return { playActions };
}

/**
 * Hovers an inactive theme chip and waits for the background transition its
 * hover rule starts: proof that transitions run in this page. The listener is
 * in place before the pointer arrives, so a short transition cannot end
 * unseen between two polls.
 */
async function expectHoverTransition(page: Page, theme: Theme): Promise<void> {
  const chip = themeChip(page, theme);
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.evaluate((element) => {
    const runs: string[] = [];
    (window as unknown as TestWindow).__themeChipHoverRuns = runs;
    const listening = new AbortController();
    (element as HTMLElement).addEventListener(
      'transitionrun',
      (event) => {
        if (event.target !== element) return;
        runs.push(event.propertyName);
        if (event.propertyName === 'background-color') listening.abort();
      },
      { signal: listening.signal },
    );
  });
  await chip.hover();
  // A mouse turns the app's hover gate on (src/ui/hover-pointer.ts).
  await expect(page.locator('html')).toHaveAttribute('data-hover-pointer');
  await page.waitForFunction(
    () =>
      ((window as unknown as TestWindow).__themeChipHoverRuns ?? []).includes('background-color'),
    undefined,
    { timeout: 5_000 },
  );
}

/**
 * Presses a theme chip in the page and, in the same task, lists the CSS
 * transitions the press started and reads the backgrounds of the header, the
 * chip the press released and, beside Settings, the Sync pill, next to each
 * one's colour token as the new palette resolves it.
 */
async function switchTheme(page: Page, theme: Theme): Promise<SwitchReading> {
  return page.evaluate((target) => {
    const root = document.documentElement;
    const chips = Array.from(
      document.querySelectorAll<HTMLElement>('#grid-theme .ch-opt[data-theme]'),
    );
    const pressed = chips.find((chip) => chip.dataset.theme === target)!;
    const released = chips.find((chip) => chip.dataset.theme !== target)!;
    const sync = document.getElementById('btn-sync');
    const surfaces = [
      { name: 'header', element: document.getElementById('main-header')!, token: '--surface-1' },
      { name: 'released chip', element: released, token: '--surface-2' },
      ...(sync && sync.getClientRects().length > 0
        ? [{ name: 'sync pill', element: sync, token: '--play-action-surface' }]
        : []),
    ];
    const rootClasses = root.className;
    const running = new Set(document.getAnimations());
    const before = surfaces.map(({ element }) => getComputedStyle(element).backgroundColor);

    pressed.click();

    const started = document
      .getAnimations()
      .filter(
        (animation): animation is CSSTransition =>
          animation instanceof CSSTransition && !running.has(animation),
      )
      .map((transition) => {
        const effect = transition.effect as KeyframeEffect | null;
        const element = effect?.target;
        const label = element
          ? element.tagName.toLowerCase() +
            (element.id ? `#${element.id}` : '') +
            Array.from(element.classList, (name) => `.${name}`).join('')
          : '(no target)';
        return `${label}${effect?.pseudoElement ?? ''} ${transition.transitionProperty}`;
      });
    const after = surfaces.map(({ element }) => getComputedStyle(element).backgroundColor);
    const probe = document.createElement('span');
    document.body.append(probe);
    const tokens = surfaces.map(({ token }) => {
      probe.style.backgroundColor = `var(${token})`;
      return getComputedStyle(probe).backgroundColor;
    });
    probe.remove();

    return {
      theme: root.getAttribute('data-theme'),
      started,
      rootClassesKept: root.className === rootClasses,
      surfaces: surfaces.map(({ name }, index) => ({
        name,
        before: before[index]!,
        after: after[index]!,
        token: tokens[index]!,
      })),
    };
  }, theme);
}

function expectHeldSwitch(reading: SwitchReading, theme: Theme, playActions: boolean): void {
  expect(reading.theme).toBe(theme);
  // A transition listed here would start from the previous palette and show
  // its colour for its first frames.
  expect(reading.started, `transitions the switch to ${theme} started`).toEqual([]);
  expect(reading.rootClassesKept, `the root's classes after the switch to ${theme}`).toBe(true);
  expect(reading.surfaces.map(({ name }) => name)).toEqual([
    'header',
    'released chip',
    ...(playActions ? ['sync pill'] : []),
  ]);
  for (const surface of reading.surfaces) {
    expect(surface.after, `${surface.name} right after the switch to ${theme}`).toBe(surface.token);
    expect(surface.after, `${surface.name} before the switch to ${theme}`).not.toBe(surface.before);
  }
}

test('a theme switch eases no surface from the previous palette, in either direction', async ({
  page,
  browserName,
}) => {
  const { playActions } = await openSettings(page, browserName);

  // Transitions run in this page: a hover eases the inactive chip.
  await expectHoverTransition(page, 'light');
  await settleTransitions(page);

  for (const [theme, released] of [
    ['light', 'dark'],
    ['dark', 'light'],
  ] as const) {
    expectHeldSwitch(await switchTheme(page, theme), theme, playActions);
    // The hold went with the switch: a hover on the released chip eases again.
    await expectHoverTransition(page, released);
    await settleTransitions(page);
  }
});
