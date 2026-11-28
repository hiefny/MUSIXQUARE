/**
 * Custom scrollbars inside a view transition of the page.
 *
 * Tab changes and setup steps run in a document view transition
 * (animateTransition() in src/ui/dom.ts). Its new image is live, so a bar that
 * showed with its own 0.3 s fade from transparent (src/ui/custom-scrollbar.ts)
 * faded inside that image, behind the page: the entered tab's bar dimmed and
 * lagged the page, and quick switches blinked it 1 to 0 to 1. Now
 * animateTransition() marks <html> from a transition's update until one frame
 * after it ends, and under that mark a bar shows and hides at once
 * (css/style.css). A tab change also lays its bar out inside the update.
 * animateTransition() starts no second transition while one runs: a later tab
 * change joins the running update, or applies in place while the new image
 * fades in.
 *
 * An init script records each startViewTransition() call without changing
 * it, and samples every custom scrollbar: inside the update, once the
 * transition is ready, in each frame and after each frame's layout. Each
 * sample reads a bar's computed opacity and the CSS transitions running on
 * it. The checks are on that state, not on frame timing: the Windows
 * Playwright WebKit build can run only one or two main-thread frames inside a
 * transition, and the update and ready samples come without frames.
 *
 * Both lanes seed the host role in the initialized app (as
 * theme-switch-motion and app-touch-policy do in WebKit), so no room opens
 * and no room code is typed.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { waitForViewTransitionEnd } from './helpers/wait.ts';

test.use({ serviceWorkers: 'block' });

/** The class animateTransition() keeps on <html> during a transition, read from its one home. */
const TRANSITION_MARK =
  /const VIEW_TRANSITION_CLASS = '([^']+)';/u.exec(readFileSync('src/ui/dom.ts', 'utf8'))?.[1] ??
  '';

/** Both tabs overflow on a phone: their bars show when they are entered. */
const TABS = ['settings', 'guide'] as const;
type Tab = (typeof TABS)[number];

interface BarReading {
  /** The bar's place: the id of its track's parent, or its first class. */
  owner: string;
  opacity: number;
  /** CSS transitions running on the bar's track. */
  fading: string[];
}

interface Sample {
  at: 'update' | 'ready' | 'frame' | 'layout';
  /** The transition whose update has run and that has not ended, or -1. */
  transition: number;
  activeTab: string | null;
  marked: boolean;
  bars: BarReading[];
}

interface TransitionEntry {
  /** Another recorded transition had started and not ended yet. */
  overlapped: boolean;
  updated: boolean;
  ready: 'resolved' | 'rejected' | null;
  ended: boolean;
}

interface RecorderWindow extends Window {
  __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
  __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
  __barTransitions: TransitionEntry[];
  __barSamples: Sample[];
  __barSampling: boolean;
}

/**
 * Init script: records each startViewTransition() call and, while sampling
 * is on, samples every custom scrollbar inside the update, once ready, in
 * each animation frame and after each frame's layout (a ResizeObserver
 * report).
 */
function installBarRecorder(mark: string): void {
  const runtime = window as unknown as RecorderWindow;
  runtime.__barTransitions = [];
  runtime.__barSamples = [];
  runtime.__barSampling = false;
  const runningTransition = (): number =>
    runtime.__barTransitions.findIndex((entry) => entry.updated && !entry.ended);
  const readBar = (track: HTMLElement): BarReading => {
    const parent = track.parentElement;
    return {
      owner: parent?.id || parent?.classList[0] || 'unknown',
      opacity: Number(getComputedStyle(track).opacity),
      fading: track
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map(
          (animation) =>
            `${(animation as CSSTransition).transitionProperty} ${animation.playState}`,
        ),
    };
  };
  const sample = (at: Sample['at']): void => {
    if (!runtime.__barSampling) return;
    runtime.__barSamples.push({
      at,
      transition: runningTransition(),
      activeTab: document.querySelector('.tab-content.active')?.id ?? null,
      marked: document.documentElement.classList.contains(mark),
      bars: Array.from(document.querySelectorAll<HTMLElement>('.cscroll-track'), readBar),
    });
  };
  (runtime as unknown as { __barSample: typeof sample }).__barSample = sample;

  if (typeof document.startViewTransition !== 'function') return;
  const native = document.startViewTransition.bind(document);
  // The app passes its update as a function (src/ui/dom.ts).
  document.startViewTransition = (...args: Parameters<Document['startViewTransition']>) => {
    const [update] = args;
    const entry: TransitionEntry = {
      overlapped: runtime.__barTransitions.some((other) => !other.ended),
      updated: false,
      ready: null,
      ended: false,
    };
    runtime.__barTransitions.push(entry);
    const transition = native(() => {
      const result = typeof update === 'function' ? update() : undefined;
      entry.updated = true;
      sample('update');
      return result;
    });
    transition.ready.then(
      () => {
        entry.ready = 'resolved';
        sample('ready');
      },
      () => {
        entry.ready = 'rejected';
      },
    );
    const end = (): void => {
      entry.ended = true;
    };
    transition.finished.then(end, end);
    return transition;
  };
}

/** Starts sampling in every frame and after each frame's layout, until stopped. */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as unknown as RecorderWindow & {
      __barSample: (at: Sample['at']) => void;
    };
    runtime.__barSamples = [];
    runtime.__barSampling = true;
    // A box whose size flips each frame, so its observer reports after
    // every frame's layout.
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(probe);
    const observer = new ResizeObserver(() => runtime.__barSample('layout'));
    observer.observe(probe);
    let wide = false;
    const frame = (): void => {
      if (!runtime.__barSampling) {
        observer.disconnect();
        probe.remove();
        return;
      }
      runtime.__barSample('frame');
      wide = !wide;
      probe.style.width = wide ? '2px' : '1px';
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function stopSampling(
  page: Page,
): Promise<{ samples: Sample[]; transitions: TransitionEntry[] }> {
  return page.evaluate(() => {
    const runtime = window as unknown as RecorderWindow;
    runtime.__barSampling = false;
    return { samples: runtime.__barSamples, transitions: runtime.__barTransitions };
  });
}

async function openApp(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(installBarRecorder, TRANSITION_MARK);
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  // Browser Insights rejects preview origins in WebKit (setup-carousel-autoplay.test.ts).
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await waitForBootstrapReady(page);
  await expect(page.locator('#btn-setup-host')).toBeVisible();
  const hasApi = await page.evaluate(() => typeof document.startViewTransition === 'function');
  expect(hasApi, 'document.startViewTransition: this lane must run view transitions').toBe(true);
}

/** Seeds the host role in the initialized app and waits for the room's entrance to end. */
async function openSeededRoom(page: Page): Promise<void> {
  await openApp(page);
  await page.evaluate(() => {
    const runtime = window as unknown as RecorderWindow;
    runtime.__MUSIXQUARE_SET_STATE__('network.appRole', 'host');
    runtime.__MUSIXQUARE_SET_STATE__('setup.sessionStarted', true);
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
    runtime.__MUSIXQUARE_BUS__.emit('setup:app-entrance');
  });
  await page.waitForFunction(
    () =>
      !document.documentElement.classList.contains('is-booting') &&
      document.querySelector('.app-entrance') === null,
    undefined,
    { timeout: 10_000 },
  );
}

async function switchTab(page: Page, tab: Tab): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as RecorderWindow).__MUSIXQUARE_BUS__.emit('ui:switch-tab', id);
  }, tab);
}

/** Waits until every bar has faded out and no CSS transition runs, so a step starts at rest. */
async function waitForRest(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('.cscroll-track')).every(
        (track) => track.style.opacity !== '1',
      ) && document.getAnimations().every((animation) => !(animation instanceof CSSTransition)),
    undefined,
    { timeout: 15_000 },
  );
}

function barOf(sample: Sample, owner: string): BarReading | undefined {
  return sample.bars.find((bar) => bar.owner === owner);
}

/** The samples taken after a transition's update and before it ended. */
function duringTransitions(samples: Sample[]): Sample[] {
  return samples.filter((sample) => sample.transition !== -1);
}

/** No custom scrollbar fades while a transition's new image is live, and <html> carries the mark. */
function expectNoBarFades(samples: Sample[]): void {
  for (const sample of samples) {
    const fading = sample.bars.filter((bar) => bar.fading.length > 0);
    expect(
      fading,
      `bars fading in a ${sample.at} sample of transition ${sample.transition}`,
    ).toEqual([]);
    expect(sample.marked, `the transition mark in a ${sample.at} sample`).toBe(true);
  }
}

test.beforeAll(() => {
  expect(TRANSITION_MARK, 'VIEW_TRANSITION_CLASS in src/ui/dom.ts').toMatch(
    /^[a-z]+(?:-[a-z]+)*$/u,
  );
});

test.describe('custom scrollbars in a tab change on a phone', () => {
  test.beforeEach(async ({ page, browserName }) => {
    // The WebKit lane is an iPhone 13 already; Chromium takes its width.
    if (browserName === 'chromium') await page.setViewportSize({ width: 390, height: 844 });
    await openSeededRoom(page);
    // Both tabs overflow on a phone, so both bars show when entered.
    for (const tab of TABS) {
      await switchTab(page, tab);
      await page.waitForFunction(
        (id) => document.getElementById(`tab-${id}`)?.classList.contains('active') ?? false,
        tab,
      );
      await waitForViewTransitionEnd(page);
      const overflow = await page
        .locator(`#tab-${tab} > .tab-body`)
        .evaluate((body) => body.scrollHeight - body.clientHeight);
      expect(overflow, `how far the ${tab} tab overflows`).toBeGreaterThan(2);
    }
  });

  test('shows the entered tab’s bar at full opacity from the transition’s update on', async ({
    page,
  }) => {
    // The guide tab's bar shows as it was entered; the switch comes while it is up.
    await switchTab(page, 'settings');
    await waitForViewTransitionEnd(page);
    await waitForRest(page);
    await switchTab(page, 'guide');
    await waitForViewTransitionEnd(page);
    await expect(page.locator('#tab-guide > .cscroll-track')).toHaveCSS('opacity', '1');

    await startSampling(page);
    await switchTab(page, 'settings');
    await page.waitForFunction(() =>
      (window as unknown as RecorderWindow).__barTransitions.every((entry) => entry.ended),
    );
    await waitForViewTransitionEnd(page);
    const { samples, transitions } = await stopSampling(page);

    const switched = transitions.at(-1)!;
    expect(switched.ready, 'the tab change ran its transition to the end').toBe('resolved');
    const during = duringTransitions(samples);
    expect(
      during.map((sample) => sample.at),
      'samples taken inside the update and once ready',
    ).toEqual(expect.arrayContaining(['update', 'ready']));
    for (const sample of during) {
      expect(sample.activeTab).toBe('tab-settings');
      expect(
        barOf(sample, 'tab-settings')?.opacity,
        `the entered bar in a ${sample.at} sample`,
      ).toBe(1);
    }
    expectNoBarFades(during);
  });

  test('keeps quick tab changes in one transition at a time, each entered bar at full opacity', async ({
    page,
  }) => {
    await switchTab(page, 'guide');
    await waitForViewTransitionEnd(page);
    await waitForRest(page);

    await startSampling(page);
    // Three changes about 110 ms apart: the later ones come while the
    // first transition runs, as arrow keys on the tab list do.
    for (const tab of ['settings', 'guide', 'settings'] as const) {
      await switchTab(page, tab);
      await page.waitForTimeout(110);
    }
    await page.waitForFunction(() =>
      (window as unknown as RecorderWindow).__barTransitions.every((entry) => entry.ended),
    );
    await waitForViewTransitionEnd(page);
    const { samples, transitions } = await stopSampling(page);

    expect(transitions.length, 'view transitions the three changes ran').toBeGreaterThan(0);
    for (const [index, entry] of transitions.entries()) {
      expect(entry.overlapped, `transition ${index} started while another ran`).toBe(false);
      expect(entry.ready, `transition ${index} ran to its end without being skipped`).toBe(
        'resolved',
      );
    }
    const during = duringTransitions(samples);
    expect(during.length, 'samples taken while a transition ran').toBeGreaterThan(0);
    for (const sample of during) {
      const tab = sample.activeTab;
      expect(tab === 'tab-settings' || tab === 'tab-guide', `the active tab ${tab}`).toBe(true);
      expect(barOf(sample, tab!)?.opacity, `the entered bar in a ${sample.at} sample`).toBe(1);
    }
    expectNoBarFades(during);
    expect(await page.locator('.tab-content.active').getAttribute('id')).toBe('tab-settings');
  });
});

test('reveals a setup step’s bar without its own fade while the step transition runs', async ({
  page,
}) => {
  // A short phone, where the join step overflows (setup-scroll-edge.test.ts).
  await page.setViewportSize({ width: 320, height: 568 });
  await openApp(page);
  await waitForRest(page);

  await startSampling(page);
  await page.locator('#btn-setup-guest').click();
  await expect(page.locator('#setup-join-area')).toBeVisible();
  await page.waitForFunction(() =>
    (window as unknown as RecorderWindow).__barTransitions.every((entry) => entry.ended),
  );
  await waitForViewTransitionEnd(page);
  const { samples, transitions } = await stopSampling(page);

  expect(transitions.length, 'the join step ran in a view transition').toBe(1);
  expect(transitions[0]!.ready).toBe('resolved');
  // The step's bar shows from a timer after the update (src/ui/setup-shared.ts).
  const overflow = await page
    .locator('#setup-join-area')
    .evaluate((area) => area.scrollHeight - area.clientHeight);
  expect(overflow, 'how far the join step overflows').toBeGreaterThan(2);
  const during = duringTransitions(samples);
  expect(during.length, 'samples taken while the transition ran').toBeGreaterThan(0);
  expectNoBarFades(during);
  const shown = during.filter((sample) =>
    sample.bars.some((bar) => bar.owner === 'setup-mobile-view' && bar.opacity > 0),
  );
  for (const sample of shown) {
    const bars = sample.bars.filter((bar) => bar.owner === 'setup-mobile-view' && bar.opacity > 0);
    expect(
      bars.map((bar) => bar.opacity),
      `a step bar shows at full opacity at once (${sample.at} sample)`,
    ).toEqual(bars.map(() => 1));
  }
});
