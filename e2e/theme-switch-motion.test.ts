/**
 * Theme switch motion: a switch between light and dark cross-fades the whole
 * screen at once, and no surface eases from the previous theme's colours.
 *
 * Owner reports: in 9.0.835 surfaces with a colour transition (the pressed
 * theme chip, the header) showed the previous theme's colour for a moment
 * after a switch. 9.0.836 held every transition off for the one style change
 * that swaps the palette (setTheme() in src/ui/settings.ts and its class in
 * css/style.css), and the switch turned abrupt. A theme chip press that
 * changes the palette now runs setTheme() inside the update of the app's view
 * transition (animateTransition() in src/ui/dom.ts, which tab changes use).
 * The old screen holds still, and the new one fades in over it with normal
 * blending on the tab change's timing, header and bottom bar included: both
 * stay in the page's images, as only a tab change lifts them out. The hold
 * stays inside the update, so the new image is final from its first frame.
 * Without the View Transition API (older browsers, the legacy TV build) and
 * under reduced motion the switch stays immediate, as in 9.0.836.
 *
 * An init script records each view transition the page starts, without
 * changing it: whether the header was kept live, the timing and keyframes of
 * its ::view-transition animations, and, once it is ready, the computed
 * display, opacity, blend mode and animation of the old and new page images
 * and the bottom bar's view-transition-name. Each switch is pressed and
 * read in one page script. It reads the press's own task, the page once the
 * update is done (document getAnimations() flushes style first, so a
 * transition from the previous palette would be listed), the header during
 * the fade, and the page after it, with every transitionrun event in
 * between. Before each press the page is at rest: the mouse waits at the
 * middle of the header, where no hover rule applies, and no toast or
 * scrollbar is left to fade out. A mouse hover on an inactive chip shows
 * that transitions run in this page, and again after each switch that the
 * hold is gone.
 *
 * Chromium opens a real local room in the desktop dashboard, where the play
 * actions sit beside Settings, and seeds the host role for its phone layout
 * row. The Windows Playwright WebKit build has no PeerJS WebRTC transport, so
 * the WebKit lane (iPhone layout) seeds the host role in the initialized app
 * instead, as app-touch-policy and back-navigation do. No room code is typed
 * anywhere.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToSubtab, navigateToTab } from './helpers/wait.ts';

test.use({ serviceWorkers: 'block' });

/** The class setTheme() holds on <html> for the swap, read from its one home. */
const HOLD_CLASS =
  /const THEME_SWITCHING_CLASS = '([^']+)';/u.exec(
    readFileSync('src/ui/settings.ts', 'utf8'),
  )?.[1] ?? '';

/**
 * The class animateTransition() keeps on <html> from a transition's update
 * until one frame after it ends (custom scrollbars do not fade under it),
 * read from its one home.
 */
const TRANSITION_MARK =
  /const VIEW_TRANSITION_CLASS = '([^']+)';/u.exec(readFileSync('src/ui/dom.ts', 'utf8'))?.[1] ??
  '';

/** The only group a theme cross-fade may have: the page (header and bottom bar fade with it). */
const THEME_GROUPS = ['root'];

type Theme = 'dark' | 'light';

/** One animation of a ::view-transition pseudo-element, read once it runs. */
interface PseudoAnimation {
  name: string;
  duration: number;
  delay: number;
  /** The effect's own easing. A CSS animation eases through its keyframes. */
  easing: string;
  keyframes: { offset: number; easing: string; opacity: string | null }[];
}

/** The computed style of a page image, ::view-transition-old(root) or -new(root). */
interface PageImage {
  display: string;
  opacity: string;
  mixBlendMode: string;
  animationName: string;
}

/** One startViewTransition() call as the recorder saw it. */
interface TransitionRecord {
  /** <html> had the tab change's live header class when the owner called. */
  tabHeader: boolean;
  /** The active tab panel once the update was done. */
  activeTab: string | null;
  /** The animations of each ::view-transition pseudo-element once ready. */
  pseudo: Record<string, PseudoAnimation[]>;
  /** The old and new page images once ready. */
  images: { old: PageImage; new: PageImage } | null;
  /** The bottom bar's computed view-transition-name once ready. */
  navName: string | null;
}

interface TestWindow extends Window {
  __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
  __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
  __themeChipHoverRuns?: string[];
  __themeViewTransitions?: ViewTransition[];
  __themeViewTransitionLog?: TransitionRecord[];
}

/** One theme chip press, read in the page from the press to the end of its switch. */
interface PressReading {
  /** The surfaces read, in order. */
  names: string[];
  /** Each surface's background before the press. */
  before: string[];
  /** The phone's bottom bar had a box at the press. */
  bottomNav: boolean;
  /** View transitions the press started. */
  started: number;
  /** The press's view transition as the recorder saw it; null without one. */
  record: TransitionRecord | null;
  /** Read in the press's own task. */
  press: {
    theme: string | null;
    pressed: string | null;
    transitions: string[];
    surfaces: string[];
    tokens: string[];
  };
  /** Read once the transition's update was done; null without one. */
  update: {
    theme: string | null;
    pressed: string | null;
    held: boolean;
    tabHeader: boolean;
    headerName: string;
    transitions: string[];
    surfaces: string[];
    tokens: string[];
    /** The root's classes, the transition owner's mark aside, are those from before the press. */
    classesKept: boolean;
    /** <html> has the transition owner's mark. */
    marked: boolean;
  } | null;
  /** Read once the fade began; null without a view transition. */
  fade: {
    error: string | null;
    tabHeader: boolean;
    headerName: string;
    /** document.activeViewTransition is this transition; null where it does not exist. */
    active: boolean | null;
  } | null;
  /** Read after the fade (or the immediate switch) and two more frames. */
  after: {
    theme: string | null;
    pressed: string | null;
    stored: string | null;
    /** document.activeViewTransition is null; null where it does not exist. */
    idle: boolean | null;
    surfaces: string[];
    tokens: string[];
    classesKept: boolean;
    marked: boolean;
    /** Every transitionrun event from the press on. */
    runs: string[];
  };
}

function themeChip(page: Page, theme: Theme) {
  return page.locator(`#grid-theme .ch-opt[data-theme="${theme}"]`);
}

/**
 * Init script. Records every startViewTransition() call without changing it:
 * the transition, whether the owner kept the header live, the active tab once
 * the update is done, and the ::view-transition animations once they run.
 * With `withoutApi` it removes the API instead, as an older browser or the
 * legacy TV build has none. One script does both, so their order is fixed.
 */
function installTransitionRecorder({ withoutApi }: { withoutApi: boolean }): void {
  const runtime = window as unknown as TestWindow;
  runtime.__themeViewTransitions = [];
  runtime.__themeViewTransitionLog = [];
  if (withoutApi) {
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: undefined,
    });
    return;
  }
  if (typeof document.startViewTransition !== 'function') return;
  const native = document.startViewTransition.bind(document);
  const readPseudoAnimations = (): Record<string, PseudoAnimation[]> => {
    const pseudo: Record<string, PseudoAnimation[]> = {};
    const animations = new Set([
      ...document.getAnimations(),
      ...document.documentElement.getAnimations({ subtree: true }),
    ]);
    for (const animation of animations) {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect)) continue;
      const name = effect.pseudoElement;
      if (!name?.startsWith('::view-transition')) continue;
      const timing = effect.getTiming();
      (pseudo[name] ??= []).push({
        name: animation instanceof CSSAnimation ? animation.animationName : '',
        duration: Number(effect.getComputedTiming().duration),
        delay: Number(timing.delay ?? 0),
        easing: String(timing.easing ?? ''),
        keyframes: effect.getKeyframes().map((keyframe) => ({
          offset: keyframe.computedOffset,
          easing: keyframe.easing,
          opacity:
            keyframe.opacity === undefined || keyframe.opacity === null
              ? null
              : String(keyframe.opacity),
        })),
      });
    }
    return pseudo;
  };
  const readPageImage = (pseudo: string): PageImage => {
    const style = getComputedStyle(document.documentElement, pseudo);
    return {
      display: style.display,
      opacity: style.opacity,
      mixBlendMode: style.mixBlendMode,
      animationName: style.animationName,
    };
  };
  document.startViewTransition = (...args: Parameters<Document['startViewTransition']>) => {
    const record: TransitionRecord = {
      tabHeader: document.documentElement.classList.contains('tab-header-transition'),
      activeTab: null,
      pseudo: {},
      images: null,
      navName: null,
    };
    const transition = native(...args);
    runtime.__themeViewTransitions?.push(transition);
    runtime.__themeViewTransitionLog?.push(record);
    transition.updateCallbackDone.then(
      () => {
        record.activeTab = document.querySelector('.tab-content.active')?.id ?? null;
      },
      () => undefined,
    );
    transition.ready.then(
      () => {
        record.pseudo = readPseudoAnimations();
        record.images = {
          old: readPageImage('::view-transition-old(root)'),
          new: readPageImage('::view-transition-new(root)'),
        };
        const nav = document.querySelector('.bottom-nav');
        record.navName = nav
          ? getComputedStyle(nav).getPropertyValue('view-transition-name').trim()
          : null;
      },
      () => undefined,
    );
    return transition;
  };
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

interface OpenOptions {
  /** The reduced motion preference the page sees (no-preference by default). */
  reducedMotion?: 'no-preference' | 'reduce';
  /** False removes the View Transition API before the app starts. */
  viewTransitions?: boolean;
  /** Seeds the host role instead of opening a real room (the WebKit lane always does). */
  seeded?: boolean;
}

interface OpenedSettings {
  playActions: boolean;
  /** How many view transitions had started when the Settings tab change ended. */
  transitionsToSettings: number;
}

/**
 * Opens Settings in a room with the dark theme stored, once the boot guard and
 * the room entrance have let go of the transitions they own.
 */
async function openSettings(
  page: Page,
  browserName: string,
  options: OpenOptions = {},
): Promise<OpenedSettings> {
  await page.emulateMedia({ reducedMotion: options.reducedMotion ?? 'no-preference' });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('musixquare-theme', 'dark');
    } catch {
      // Opaque documents such as about:blank have no storage.
    }
  });
  await page.addInitScript(installTransitionRecorder, {
    withoutApi: options.viewTransitions === false,
  });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  if (browserName === 'webkit' || options.seeded) {
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
  const transitionsToSettings = await page.evaluate(
    () => (window as unknown as TestWindow).__themeViewTransitionLog?.length ?? 0,
  );
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
  return { playActions, transitionsToSettings };
}

/** Whether the page has the View Transition API: the branch a lane runs depends on it. */
async function expectViewTransitionApi(page: Page, present: boolean): Promise<void> {
  const type = await page.evaluate(() => typeof document.startViewTransition);
  expect(
    type,
    present
      ? 'document.startViewTransition: without it this row would run the immediate ' +
          'path, which the row without the API covers'
      : 'document.startViewTransition after the init script removed it',
  ).toBe(present ? 'function' : 'undefined');
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
 * Brings the page to rest before a press, so that only the press can start a
 * transition while it is read. The mouse waits at the middle of the header:
 * no hover rule applies there and no scroll panel reveals its bar for it,
 * and in Chromium a view transition moves every pointer hit to <html> and
 * back. No toast is left to hide and no scrollbar to fade out
 * (src/ui/custom-scrollbar.ts hides a bar 1.2 s after its reveal), since both
 * leave with a transition of their own. Then every running transition ends.
 */
async function restBeforePress(page: Page): Promise<void> {
  const header = await page.locator('#main-header').boundingBox();
  expect(header, 'the header box').not.toBeNull();
  await page.mouse.move(header!.x + header!.width / 2, header!.y + header!.height / 2);
  await page.waitForFunction(
    () =>
      document.querySelector('.toast.show') === null &&
      Array.from(document.querySelectorAll<HTMLElement>('.cscroll-track')).every(
        (track) => track.style.opacity !== '1',
      ),
    undefined,
    { timeout: 15_000 },
  );
  await settleTransitions(page);
}

/**
 * Presses a theme chip in the page and reads the switch to its end in the
 * same page script: the press's own task, the page once the view transition's
 * update is done, the header once the fade runs, and the page after it, with
 * every transitionrun event from the press on. The surfaces are the
 * backgrounds of the header, the chip the press releases and, beside
 * Settings, the Sync pill, each next to its colour token as the current
 * palette resolves it.
 */
async function pressThemeChip(page: Page, theme: Theme, holdClass: string): Promise<PressReading> {
  return page.evaluate(
    async ({ target, hold, mark }) => {
      const runtime = window as unknown as TestWindow;
      const root = document.documentElement;
      const header = document.getElementById('main-header')!;
      const chips = Array.from(
        document.querySelectorAll<HTMLElement>('#grid-theme .ch-opt[data-theme]'),
      );
      const pressed = chips.find((chip) => chip.dataset.theme === target)!;
      const released = chips.find((chip) => chip.dataset.theme !== target)!;
      const sync = document.getElementById('btn-sync');
      const surfaces = [
        { name: 'header', element: header, token: '--surface-1' },
        { name: 'released chip', element: released, token: '--surface-2' },
        ...(sync && sync.getClientRects().length > 0
          ? [{ name: 'sync pill', element: sync, token: '--play-action-surface' }]
          : []),
      ];
      // A probe without a box resolves each token as the current palette has it.
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.append(probe);
      const readSurfaces = () =>
        surfaces.map(({ element }) => getComputedStyle(element).backgroundColor);
      const readTokens = () =>
        surfaces.map(({ token }) => {
          probe.style.backgroundColor = `var(${token})`;
          return getComputedStyle(probe).backgroundColor;
        });
      const label = (node: EventTarget | null): string =>
        node instanceof Element
          ? node.tagName.toLowerCase() +
            (node.id ? `#${node.id}` : '') +
            Array.from(node.classList, (name) => `.${name}`).join('')
          : '(no target)';
      const running = new Set(document.getAnimations());
      // getAnimations() flushes style, so a transition the last write started is listed.
      const newTransitions = () =>
        document
          .getAnimations()
          .filter(
            (animation): animation is CSSTransition =>
              animation instanceof CSSTransition && !running.has(animation),
          )
          .map((transition) => {
            const effect = transition.effect as KeyframeEffect | null;
            return `${label(effect?.target ?? null)}${effect?.pseudoElement ?? ''} ${transition.transitionProperty}`;
          });
      const headerName = () =>
        getComputedStyle(header).getPropertyValue('view-transition-name').trim();
      const activeTransition = () =>
        (document as { activeViewTransition?: ViewTransition | null }).activeViewTransition;
      const twoFrames = () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      const runs: string[] = [];
      const onRun = (event: TransitionEvent) => {
        runs.push(`${label(event.target)}${event.pseudoElement} ${event.propertyName}`);
      };
      // The transition owner's mark comes and goes with each transition.
      const classes = () =>
        Array.from(root.classList)
          .filter((name) => name !== mark)
          .join(' ');
      const rootClasses = classes();
      const recorded = runtime.__themeViewTransitions?.length ?? 0;
      const bottomNav = (document.querySelector('.bottom-nav')?.getClientRects().length ?? 0) > 0;
      const before = readSurfaces();

      document.addEventListener('transitionrun', onRun, true);
      try {
        pressed.click();
        const press = {
          theme: root.getAttribute('data-theme'),
          pressed: pressed.getAttribute('aria-pressed'),
          transitions: newTransitions(),
          surfaces: readSurfaces(),
          tokens: readTokens(),
        };

        // The owner starts the view transition one microtask after the press.
        await Promise.resolve();
        await Promise.resolve();
        const started = (runtime.__themeViewTransitions ?? []).slice(recorded);
        let update: PressReading['update'] = null;
        let fade: PressReading['fade'] = null;
        if (started.length === 1) {
          const transition = started[0]!;
          await transition.updateCallbackDone;
          update = {
            theme: root.getAttribute('data-theme'),
            pressed: pressed.getAttribute('aria-pressed'),
            held: root.classList.contains(hold),
            tabHeader: root.classList.contains('tab-header-transition'),
            headerName: headerName(),
            transitions: newTransitions(),
            surfaces: readSurfaces(),
            tokens: readTokens(),
            classesKept: classes() === rootClasses,
            marked: root.classList.contains(mark),
          };
          let error: string | null = null;
          try {
            await transition.ready;
          } catch (reason) {
            error = String(reason);
          }
          const active = activeTransition();
          fade = {
            error,
            tabHeader: root.classList.contains('tab-header-transition'),
            headerName: headerName(),
            active: active === undefined ? null : active === transition,
          };
          await transition.finished;
        }
        // transitionrun events are sent with the next frames.
        await twoFrames();
        const active = activeTransition();
        let stored: string | null = null;
        try {
          stored = localStorage.getItem('musixquare-theme');
        } catch {
          stored = null;
        }
        return {
          names: surfaces.map(({ name }) => name),
          before,
          bottomNav,
          started: started.length,
          record:
            started.length === 1 ? (runtime.__themeViewTransitionLog?.[recorded] ?? null) : null,
          press,
          update,
          fade,
          after: {
            theme: root.getAttribute('data-theme'),
            pressed: pressed.getAttribute('aria-pressed'),
            stored,
            idle: active === undefined ? null : active === null,
            surfaces: readSurfaces(),
            tokens: readTokens(),
            classesKept: classes() === rootClasses,
            marked: root.classList.contains(mark),
            runs: [...runs],
          },
        };
      } finally {
        document.removeEventListener('transitionrun', onRun, true);
        probe.remove();
      }
    },
    { target: theme, hold: holdClass, mark: TRANSITION_MARK },
  );
}

/** The opacity fade among a pseudo-element's animations. */
function fadeOf(record: TransitionRecord, pseudo: string): PseudoAnimation | undefined {
  return record.pseudo[pseudo]?.find((animation) =>
    animation.keyframes.some((keyframe) => keyframe.opacity !== null),
  );
}

/** A fade's timing: what two fades must share to move together at every moment. */
function fadeTiming(fade: PseudoAnimation | undefined) {
  return (
    fade && {
      duration: fade.duration,
      delay: fade.delay,
      easing: fade.easing,
      keyframeEasing: [...new Set(fade.keyframes.map((keyframe) => keyframe.easing))],
    }
  );
}

/** Whether a fade has a keyframe at `offset` that is fully transparent. */
function transparentAt(fade: PseudoAnimation | undefined, offset: number): boolean {
  return (
    fade?.keyframes.some(
      (keyframe) =>
        keyframe.offset === offset && keyframe.opacity !== null && Number(keyframe.opacity) === 0,
    ) ?? false
  );
}

/** Whether a fade has a keyframe at `offset` that is fully opaque. */
function opaqueAt(fade: PseudoAnimation | undefined, offset: number): boolean {
  return (
    fade?.keyframes.some(
      (keyframe) =>
        keyframe.offset === offset && keyframe.opacity !== null && Number(keyframe.opacity) === 1,
    ) ?? false
  );
}

/**
 * The page images as a tab change and a theme switch draw them: the old page
 * holds still at full opacity with normal blending and no animation, and the
 * new page fades in over it from transparent to opaque with normal blending.
 * No image blends plus-lighter, so a pixel the switch leaves alone stays put
 * whatever the two images' timing.
 */
function expectHeldPageImages(record: TransitionRecord, context: string): void {
  expect(record.images, `the page images of ${context}, read once it was ready`).not.toBeNull();
  expect(record.images!.old, `the old page image of ${context}`).toEqual({
    display: 'block',
    opacity: '1',
    mixBlendMode: 'normal',
    animationName: 'none',
  });
  expect(record.images!.new.mixBlendMode, `the new page image's blend in ${context}`).toBe(
    'normal',
  );
  expect(record.images!.new.animationName, `the new page image's animation in ${context}`).toBe(
    'view-transition-fade-in',
  );
  expect(
    record.pseudo['::view-transition-old(root)'] ?? [],
    `animations of the old page image in ${context}`,
  ).toEqual([]);
  expect(
    Object.values(record.pseudo)
      .flat()
      .map((animation) => animation.name)
      .filter((name) => name.includes('plus-lighter')),
    `plus-lighter blending in ${context}`,
  ).toEqual([]);
  const newRoot = fadeOf(record, '::view-transition-new(root)');
  expect(transparentAt(newRoot, 0), `the new page of ${context} at its start`).toBe(true);
  expect(opaqueAt(newRoot, 1), `the new page of ${context} at its end`).toBe(true);
}

/** The transition groups a record animated: the names inside the pseudo-elements. */
function groupsOf(record: TransitionRecord): string[] {
  return [
    ...new Set(Object.keys(record.pseudo).map((key) => /\(([^)]*)\)$/u.exec(key)?.[1] ?? key)),
  ].sort();
}

/** The Settings tab change: the timing the theme's cross-fade must share. */
async function readTabChange(page: Page, opened: OpenedSettings): Promise<TransitionRecord> {
  expect(opened.transitionsToSettings, 'view transitions up to the Settings tab').toBeGreaterThan(
    0,
  );
  const record = await page.evaluate(
    (index) => (window as unknown as TestWindow).__themeViewTransitionLog?.[index] ?? null,
    opened.transitionsToSettings - 1,
  );
  expect(record, 'the Settings tab change').not.toBeNull();
  expect(record!.activeTab, 'the panel after the Settings tab change').toBe('tab-settings');
  expect(
    fadeOf(record!, '::view-transition-old(root)'),
    "the tab change's old page holds steady without a fade-out animation",
  ).toBeUndefined();
  expect(fadeOf(record!, '::view-transition-new(root)'), "the tab change's new page").toBeTruthy();
  expectHeldPageImages(record!, 'the Settings tab change');
  // A tab change lifts the bottom bar out of the page's images as a live
  // layer whenever it keeps the header live (no window or toast over them).
  expect(record!.navName, "the bottom bar's group in the Settings tab change").toBe(
    record!.tabHeader ? 'bottom-nav' : 'none',
  );
  return record!;
}

function expectSurfaces(
  reading: PressReading,
  read: { surfaces: string[]; tokens: string[] },
  when: string,
): void {
  reading.names.forEach((name, index) => {
    expect(read.surfaces[index], `${name} ${when}`).toBe(read.tokens[index]);
    expect(read.surfaces[index], `${name} ${when}, against before the press`).not.toBe(
      reading.before[index],
    );
  });
}

/** A press on the active chip: nothing to swap, so no view transition and no change. */
function expectNoSwitch(reading: PressReading, theme: Theme): void {
  expect(reading.started, `view transitions a press on the active ${theme} chip started`).toBe(0);
  expect(reading.press.theme).toBe(theme);
  expect(reading.press.pressed).toBe('true');
  expect(reading.press.transitions).toEqual([]);
  expect(reading.after.theme).toBe(theme);
  expect(reading.after.stored).toBe(theme);
  expect(reading.after.classesKept).toBe(true);
}

/**
 * A press that changes the palette: one view transition, the old screen in the
 * press's own task, the whole new screen final once the update is done, and
 * the new page fading in over the held old page on the tab change's fade, with
 * the header and the bottom bar in the page's images.
 */
function expectCrossFade(
  reading: PressReading,
  theme: Theme,
  previous: Theme,
  tabChange: TransitionRecord,
  playActions: boolean,
): void {
  const context = `the switch to ${theme}`;
  expect(reading.names).toEqual(['header', 'released chip', ...(playActions ? ['sync pill'] : [])]);
  expect(reading.started, `view transitions ${context} started`).toBe(1);

  // The press's own task still shows the old screen: the browser captures it next.
  expect(reading.press.theme, `the theme in the task of ${context}`).toBe(previous);
  expect(reading.press.pressed).toBe('false');
  expect(reading.press.transitions).toEqual([]);
  expect(reading.press.surfaces).toEqual(reading.before);

  // Once the update is done the new screen is final: no transition eases a
  // surface from the previous palette inside the new image.
  const update = reading.update!;
  expect(update, `the update of ${context}`).not.toBeNull();
  expect(update.theme).toBe(theme);
  expect(update.pressed).toBe('true');
  expect(update.transitions, `transitions ${context} started in its update`).toEqual([]);
  expect(update.held, 'the hold class after the update').toBe(false);
  expect(update.classesKept, `the root's classes after the update of ${context}`).toBe(true);
  expect(update.marked, `the transition owner's mark during the update of ${context}`).toBe(true);
  expectSurfaces(reading, update, `after the update of ${context}`);

  // The header is part of the page's images: no live header group.
  expect(update.tabHeader).toBe(false);
  expect(update.headerName).toBe('none');
  const record = reading.record!;
  expect(record, `the view transition of ${context}`).not.toBeNull();
  expect(record.tabHeader, 'the live header class when the owner started it').toBe(false);
  const groups = groupsOf(record);
  expect(groups, `the groups of ${context}`).toContain('root');
  expect(groups.filter((group) => !THEME_GROUPS.includes(group))).toEqual([]);
  // The bottom bar too: only a tab change lifts it out as a live layer.
  expect(record.navName, `the bottom bar's group in ${context}`).toBe('none');

  // The old page holds steady underneath while the new page fades in with
  // normal alpha on the same timing as a tab change (no plus-lighter flash).
  const oldRoot = fadeOf(record, '::view-transition-old(root)');
  const newRoot = fadeOf(record, '::view-transition-new(root)');
  expect(oldRoot, 'the old page holds steady without fading out').toBeUndefined();
  expect(fadeTiming(newRoot), 'the new page fade').toBeTruthy();
  expect(fadeTiming(newRoot)).toEqual(fadeTiming(fadeOf(tabChange, '::view-transition-new(root)')));
  expectHeldPageImages(record, context);

  const fade = reading.fade!;
  expect(fade, `the fade of ${context}`).not.toBeNull();
  expect(fade.error, `the ready promise of ${context}`).toBeNull();
  expect(fade.tabHeader).toBe(false);
  expect(fade.headerName, 'the header during the fade').toBe('none');
  if (fade.active !== null) expect(fade.active, 'document.activeViewTransition').toBe(true);

  // After the fade the live page is the new screen, and nothing eased at any point.
  expect(reading.after.runs, `transitions that ran from the press to after ${context}`).toEqual([]);
  if (reading.after.idle !== null) expect(reading.after.idle).toBe(true);
  expect(reading.after.theme).toBe(theme);
  expect(reading.after.pressed).toBe('true');
  expect(reading.after.stored).toBe(theme);
  expect(reading.after.classesKept).toBe(true);
  expect(reading.after.marked, `the transition owner's mark after ${context}`).toBe(false);
  expectSurfaces(reading, reading.after, `after ${context}`);
}

/** No view transition: the whole new screen in the press's own task, nothing eased. */
function expectImmediateSwitch(reading: PressReading, theme: Theme, playActions: boolean): void {
  const context = `the switch to ${theme}`;
  expect(reading.names).toEqual(['header', 'released chip', ...(playActions ? ['sync pill'] : [])]);
  expect(reading.started, `view transitions ${context} started`).toBe(0);
  expect(reading.press.theme, `the theme in the task of ${context}`).toBe(theme);
  expect(reading.press.pressed).toBe('true');
  // A transition listed here would start from the previous palette and show
  // its colour for its first frames.
  expect(reading.press.transitions, `transitions ${context} started`).toEqual([]);
  expectSurfaces(reading, reading.press, `in the task of ${context}`);
  expect(reading.after.runs, `transitions that ran after ${context}`).toEqual([]);
  if (reading.after.idle !== null) expect(reading.after.idle).toBe(true);
  expect(reading.after.theme).toBe(theme);
  expect(reading.after.stored).toBe(theme);
  expect(reading.after.classesKept, `the root's classes after ${context}`).toBe(true);
  expect(reading.after.marked, `the transition owner's mark after ${context}`).toBe(false);
  expectSurfaces(reading, reading.after, `after ${context}`);
}

/** What a switch exercised, in words for the gate report. */
function describeSwitch(reading: PressReading): string {
  if (!reading.record) return 'immediate';
  const fade = fadeOf(reading.record, '::view-transition-new(root)');
  return `view transition: ${groupsOf(reading.record).join(', ')}, ${fade?.duration} ms`;
}

/** Names what a row exercised, once per row, for the gate report. */
function annotateSwitches(testInfo: TestInfo, descriptions: Set<string>): void {
  testInfo.annotations.push({ type: 'theme switch', description: [...descriptions].join('; ') });
}

/** The cross-fade rows: a press on the active chip, then both directions. */
async function expectCrossFadeSwitches(
  page: Page,
  opened: OpenedSettings,
  testInfo: TestInfo,
  layout: { bottomNav: boolean },
): Promise<void> {
  await expectViewTransitionApi(page, true);
  const tabChange = await readTabChange(page, opened);

  // Transitions run in this page: a hover eases the inactive chip.
  await expectHoverTransition(page, 'light');

  // The active chip has nothing to swap, so it starts no cross-fade.
  await restBeforePress(page);
  expectNoSwitch(await pressThemeChip(page, 'dark', HOLD_CLASS), 'dark');

  const descriptions = new Set<string>();
  for (const [theme, previous] of [
    ['light', 'dark'],
    ['dark', 'light'],
  ] as const) {
    await restBeforePress(page);
    const reading = await pressThemeChip(page, theme, HOLD_CLASS);
    expect(reading.bottomNav, 'the bottom bar at the press').toBe(layout.bottomNav);
    expectCrossFade(reading, theme, previous, tabChange, opened.playActions);
    descriptions.add(describeSwitch(reading));
    // The hold went with the switch: a hover on the released chip eases again.
    await expectHoverTransition(page, previous);
  }
  annotateSwitches(testInfo, descriptions);
}

test.beforeAll(() => {
  expect(HOLD_CLASS, 'THEME_SWITCHING_CLASS in src/ui/settings.ts').toMatch(
    /^[a-z]+(?:-[a-z]+)*$/u,
  );
  expect(TRANSITION_MARK, 'VIEW_TRANSITION_CLASS in src/ui/dom.ts').toMatch(
    /^[a-z]+(?:-[a-z]+)*$/u,
  );
});

test('a theme switch cross-fades the whole screen at once, in either direction', async ({
  page,
  browserName,
}, testInfo) => {
  const opened = await openSettings(page, browserName);
  // The desktop dashboard draws no bottom bar; the iPhone layout does.
  await expectCrossFadeSwitches(page, opened, testInfo, { bottomNav: browserName === 'webkit' });
});

test('a theme switch on a phone layout fades the bottom navigation with the page', async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== 'chromium',
    'The WebKit lane runs the first row on the iPhone layout, bottom navigation included.',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const opened = await openSettings(page, browserName, { seeded: true });
  await expectCrossFadeSwitches(page, opened, testInfo, { bottomNav: true });
});

test('with reduced motion a theme switch stays immediate and eases nothing', async ({
  page,
  browserName,
}, testInfo) => {
  const { playActions } = await openSettings(page, browserName, { reducedMotion: 'reduce' });
  // The API is there, so this row proves the reduced motion branch.
  await expectViewTransitionApi(page, true);

  const descriptions = new Set<string>();
  for (const theme of ['light', 'dark'] as const) {
    await restBeforePress(page);
    const reading = await pressThemeChip(page, theme, HOLD_CLASS);
    expectImmediateSwitch(reading, theme, playActions);
    descriptions.add(describeSwitch(reading));
  }
  annotateSwitches(testInfo, descriptions);
});

test('without the View Transition API a theme switch stays immediate and eases nothing (older browsers, the TV build)', async ({
  page,
  browserName,
}, testInfo) => {
  const { playActions } = await openSettings(page, browserName, { viewTransitions: false });
  await expectViewTransitionApi(page, false);

  // Transitions run in this page: a hover eases the inactive chip.
  await expectHoverTransition(page, 'light');

  const descriptions = new Set<string>();
  for (const [theme, released] of [
    ['light', 'dark'],
    ['dark', 'light'],
  ] as const) {
    await restBeforePress(page);
    const reading = await pressThemeChip(page, theme, HOLD_CLASS);
    expectImmediateSwitch(reading, theme, playActions);
    descriptions.add(describeSwitch(reading));
    // The hold went with the switch: a hover on the released chip eases again.
    await expectHoverTransition(page, released);
  }
  annotateSwitches(testInfo, descriptions);
});
