import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { navigateToSubtab, navigateToTab, waitForAppFonts } from './helpers/wait.ts';

/**
 * A custom scrollbar's thumb follows content that grows or shrinks inside its
 * scroller, frame by frame. The Settings reverb and EQ Advanced areas open and
 * close with a grid-rows transition inside a scroller whose own box never
 * changes, so the bar watches the scroller's direct element children
 * (src/ui/custom-scrollbar.ts). Before that the thumb kept the length of each
 * change's first frame: it stayed long while the list opened, then shortened
 * as the list closed.
 *
 * A page ResizeObserver on the area records one sample in every frame in which
 * the area changes size. Its callback runs after that frame's layout and
 * after the bar's own observer, which was created first and lays the bar out
 * in the same delivery, so each sample is what the frame paints. Every
 * sample, the first frame's included, must show the length the content calls
 * for, max(30, visible * visible / scrollHeight), where visible is the track's
 * height (the scroller above the phone's bottom nav). Where the engine has
 * ScrollTimeline, script places the thumb while the content changes size, and
 * a scroll timeline drives it again once the content rests.
 *
 * Nothing scrolls or moves the pointer while a phase runs: the chips are
 * clicked by a dispatched event, so no scroll session or hover re-measures the
 * bar by chance. Reduced motion is off, so the transitions run over frames.
 */

type Layout = 'desktop' | 'compact' | 'phone';
type Area = 'eq' | 'reverb';
type Direction = 'open' | 'close';

interface ThumbSample {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The track's height: the scroller's height, less the phone's bottom nav over it. */
  visible: number;
  /** The thumb's height. */
  length: number;
  /** The thumb's offset down the track. */
  top: number;
  driver: string;
}

interface PhaseRecord {
  before: ThumbSample;
  frames: ThumbSample[];
  settled: ThumbSample | null;
}

interface ThumbProbe {
  /** Set by the area observer's first callback, its initial report. */
  ready: boolean;
  phases: Record<string, PhaseRecord>;
  begin(phase: string): void;
  sample(): ThumbSample;
  /** The thumb shows the length and offset the content and scroll call for. */
  matches(): boolean;
  /** How far the bottom nav reaches over the scroller, on a phone. */
  navOverlap(): number;
}

type ProbeWindow = Window & {
  __thumbProbe?: ThumbProbe;
  __areaTransitionEnded?: boolean;
  __MUSIXQUARE_BUS__?: { emit(type: string, ...args: unknown[]): void };
};

interface ProbeConfig {
  scroller: string;
  /** The track's selector, or null for the settings pane's own track under body. */
  track: string | null;
  area: string;
  phone: boolean;
}

const VIEWPORTS: Readonly<Record<Layout, { width: number; height: number }>> = {
  desktop: { width: 1280, height: 720 },
  compact: { width: 1024, height: 768 },
  phone: { width: 390, height: 664 },
};

/**
 * The element that scrolls the settings, and its track. On a phone and on
 * the desktop dashboard the pane's body scrolls, and its bar sits in the
 * pane. In the compact layout the pane itself scrolls, its body grows with
 * the content, and the pane's bar sits under body.
 */
const SCROLL_PARTS: Readonly<Record<Layout, { scroller: string; track: string | null }>> = {
  desktop: { scroller: '#tab-settings > .tab-body', track: '#tab-settings > .cscroll-track' },
  compact: { scroller: '#tab-settings', track: null },
  phone: { scroller: '#tab-settings > .tab-body', track: '#tab-settings > .cscroll-track' },
};

const AREAS: Readonly<Record<Area, { area: string; open: string; close: string }>> = {
  eq: {
    area: '#eq-sliders-area',
    open: '#grid-eq .ch-opt[data-eq-type="advanced"]',
    close: '#grid-eq .ch-opt[data-eq-type="off"]',
  },
  reverb: {
    area: '#reverb-sliders-area',
    open: '#grid-reverb .ch-opt[data-rvb-type="advanced"]',
    close: '#grid-reverb .ch-opt[data-rvb-type="off"]',
  },
};

/** THUMB_MIN_HEIGHT in src/ui/custom-scrollbar.ts. */
const THUMB_MIN_LENGTH = 30;
const TOLERANCE_PX = 1;

function expectedLength(sample: ThumbSample): number {
  return Math.max(THUMB_MIN_LENGTH, (sample.visible * sample.visible) / sample.scrollHeight);
}

function expectedTop(sample: ThumbSample): number {
  const maxScroll = sample.scrollHeight - sample.clientHeight;
  if (maxScroll <= 0) return 0;
  return (sample.scrollTop / maxScroll) * (sample.visible - expectedLength(sample));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

async function openSettings(page: Page, layout: Layout): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);
  await page.locator('#btn-setup-host').waitFor({ state: 'visible', timeout: 15_000 });
  // The settings are reached without a room: with no session the effect
  // chips are the device's own and open their areas.
  await page.evaluate(() => {
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
  });
  await waitForAppFonts(page);
  await navigateToTab(page, 'settings');
  // Only the desktop dashboard shows one subtab at a time.
  if (layout === 'desktop') await navigateToSubtab(page, 'audio');
}

/** Clicks a chip and waits until its area's grid-rows transition has ended. */
async function toggleArea(page: Page, chip: string, area: string): Promise<void> {
  await page.locator(area).evaluate((element) => {
    const runtime = window as ProbeWindow;
    runtime.__areaTransitionEnded = false;
    const onEnd = (event: TransitionEvent): void => {
      if (event.target !== element || event.propertyName !== 'grid-template-rows') return;
      element.removeEventListener('transitionend', onEnd as EventListener);
      runtime.__areaTransitionEnded = true;
    };
    element.addEventListener('transitionend', onEnd as EventListener);
  });
  await page.locator(chip).dispatchEvent('click');
  await page.waitForFunction(
    () => (window as ProbeWindow).__areaTransitionEnded === true,
    undefined,
    { timeout: 5_000 },
  );
}

/**
 * Makes the scroller overflow by at least `minimum` px with the area under
 * test closed, opening the other area when the panel alone is too short.
 */
async function ensureOverflow(
  page: Page,
  scroller: string,
  area: Area,
  minimum: number,
): Promise<void> {
  const overflow = (): Promise<number> =>
    page.locator(scroller).evaluate((element) => element.scrollHeight - element.clientHeight);
  if ((await overflow()) >= minimum) return;
  const other = AREAS[area === 'eq' ? 'reverb' : 'eq'];
  await toggleArea(page, other.open, other.area);
  expect(await overflow(), 'the Audio settings overflow their scroller').toBeGreaterThanOrEqual(
    minimum,
  );
}

async function installProbe(page: Page, config: ProbeConfig): Promise<void> {
  if (!config.track) {
    // Wait until the pane left behind has measured its bar away as well.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLElement>('body > .cscroll-track')].filter(
          (candidate) => Number.parseFloat(candidate.style.height) > 0,
        ).length === 1,
      undefined,
      { timeout: 5_000 },
    );
  }
  await page.evaluate((probeConfig) => {
    const parts = (): {
      scroller: HTMLElement;
      track: HTMLElement;
      thumb: HTMLElement;
      area: HTMLElement;
    } => {
      const scroller = document.querySelector<HTMLElement>(probeConfig.scroller);
      // The settings pane's own track is the one body-level track with a
      // height: every hidden pane's bar has none.
      const paneTrack = (): HTMLElement | null => {
        const tracks = [...document.querySelectorAll<HTMLElement>('body > .cscroll-track')];
        const measured = tracks.filter(
          (candidate) => Number.parseFloat(candidate.style.height) > 0,
        );
        return measured.length === 1 ? measured[0]! : null;
      };
      const track = probeConfig.track
        ? document.querySelector<HTMLElement>(probeConfig.track)
        : paneTrack();
      const thumb = track?.querySelector<HTMLElement>(':scope > .cscroll-thumb') ?? null;
      const area = document.querySelector<HTMLElement>(probeConfig.area);
      if (!scroller || !track || !thumb || !area) {
        throw new Error('The settings scroller, its bar or the area is missing');
      }
      return { scroller, track, thumb, area };
    };
    const sample = (): ThumbSample => {
      const { scroller, track, thumb } = parts();
      const transform = getComputedStyle(thumb).transform;
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        visible: Number.parseFloat(getComputedStyle(track).height),
        length: Number.parseFloat(getComputedStyle(thumb).height),
        top: transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42,
        driver: track.dataset.scrollDriver ?? '',
      };
    };
    // The same formulas as the Node side, which this page code cannot import.
    const matches = (): boolean => {
      const current = sample();
      if (!(current.visible > 0) || !(current.length > 0)) return false;
      const length = Math.max(30, (current.visible * current.visible) / current.scrollHeight);
      const maxScroll = current.scrollHeight - current.clientHeight;
      const top = maxScroll > 0 ? (current.scrollTop / maxScroll) * (current.visible - length) : 0;
      return Math.abs(current.length - length) <= 1 && Math.abs(current.top - top) <= 1;
    };
    const navOverlap = (): number => {
      if (!probeConfig.phone) return 0;
      const nav = document.querySelector<HTMLElement>('.bottom-nav');
      const navRect = nav?.getBoundingClientRect();
      const scrollerRect = parts().scroller.getBoundingClientRect();
      if (!navRect || navRect.height <= 0 || scrollerRect.bottom <= navRect.top) return 0;
      return scrollerRect.bottom - navRect.top;
    };

    let current: PhaseRecord | null = null;
    const probe: ThumbProbe = {
      ready: false,
      phases: {},
      begin(phase) {
        current = { before: sample(), frames: [], settled: null };
        probe.phases[phase] = current;
      },
      sample,
      matches,
      navOverlap,
    };
    const { area } = parts();
    new ResizeObserver(() => {
      if (!probe.ready) {
        probe.ready = true;
        return;
      }
      if (current && !current.settled) current.frames.push(sample());
    }).observe(area);
    // Two frames after the transition ends the bar has measured its end.
    const settle = (event: TransitionEvent): void => {
      if (event.target !== area || event.propertyName !== 'grid-template-rows' || !current) return;
      const phase = current;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          phase.settled ??= sample();
        }),
      );
    };
    area.addEventListener('transitionend', settle);
    area.addEventListener('transitioncancel', settle);
    (window as ProbeWindow).__thumbProbe = probe;
  }, config);
  await page.waitForFunction(
    () => (window as ProbeWindow).__thumbProbe?.ready === true,
    undefined,
    { timeout: 5_000 },
  );
}

/** Lays every bar out once and waits until the thumb shows what the content calls for. */
async function settleBar(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as ProbeWindow).__MUSIXQUARE_BUS__?.emit('ui:scrollbar-relayout'),
  );
  await page.waitForFunction(() => (window as ProbeWindow).__thumbProbe!.matches(), undefined, {
    timeout: 5_000,
  });
}

/** Scrolls the list to the middle of its closed range, so no collapse clamps it. */
async function scrollToMiddle(page: Page, scroller: string): Promise<void> {
  await page.locator(scroller).evaluate((element) => {
    // Scroll anchoring would move scrollTop while content above the anchor
    // changes size; the offset must stay put for the thumb's travel to be read.
    element.style.overflowAnchor = 'none';
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
  });
}

/** Whether the engine can hand the thumb to a scroll timeline. */
async function hasScrollTimeline(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      typeof (globalThis as typeof globalThis & { ScrollTimeline?: unknown }).ScrollTimeline ===
      'function',
  );
}

async function runPhase(
  page: Page,
  phase: string,
  chip: string,
  timelineEngine: boolean,
): Promise<void> {
  await page.evaluate((name) => (window as ProbeWindow).__thumbProbe!.begin(name), phase);
  await page.locator(chip).dispatchEvent('click');
  await page.waitForFunction(
    (name) => Boolean((window as ProbeWindow).__thumbProbe!.phases[name]?.settled),
    phase,
    { timeout: 5_000 },
  );
  if (!timelineEngine) return;
  // Once the content rests, one scroll timeline is built for the settled
  // geometry and drives the thumb again.
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).__thumbProbe!.sample().driver), {
      message: `the scroll timeline drives the thumb again after the ${phase}`,
      timeout: 5_000,
    })
    .toBe('timeline');
}

/** Everything a phase got wrong, in words; empty when the thumb followed the content. */
function checkPhase(
  record: PhaseRecord | undefined,
  direction: Direction,
  checkTravel: boolean,
): string[] {
  if (!record?.settled) return ['the area never finished its transition'];
  const { before, frames, settled } = record;
  const problems: string[] = [];

  // The phase must really animate the content, over frames, away from the
  // thumb's floor, or it could pass without testing anything.
  if (frames.length < 4) problems.push(`only ${frames.length} frames were sampled`);
  const from = expectedLength(before);
  const to = expectedLength(settled);
  if (Math.abs(from - to) <= 3) {
    problems.push(`the content moved the thumb only ${round(from)} -> ${round(to)} px`);
  }
  if (Math.min(from, to) <= THUMB_MIN_LENGTH + TOLERANCE_PX) {
    problems.push('the thumb reached its floor');
  }
  const grew = to < from;
  if (grew !== (direction === 'open')) problems.push(`the list did not ${direction}`);
  if (checkTravel && Math.abs(expectedTop(before) - expectedTop(settled)) <= 3) {
    problems.push('the content barely moved the thumb along the track');
  }

  const compare = (sample: ThumbSample, label: string): void => {
    const length = expectedLength(sample);
    if (Math.abs(sample.length - length) > TOLERANCE_PX) {
      problems.push(
        `${label}: thumb ${round(sample.length)} px, content calls for ${round(length)}`,
      );
    }
    if (!checkTravel) return;
    const top = expectedTop(sample);
    if (Math.abs(sample.top - top) > TOLERANCE_PX) {
      problems.push(`${label}: thumb at ${round(sample.top)} px, scroll calls for ${round(top)}`);
    }
  };
  // The bar lays out in the report of the frame that changed, so the first
  // frame shows the new length and offset too.
  frames.forEach((sample, index) => compare(sample, `frame ${index + 1}`));
  compare(settled, 'settled');

  // The thumb shortens while the list grows and lengthens while it shrinks,
  // never the other way, even for a frame.
  const lengths = [before, ...frames, settled].map(({ length }) => length);
  const motion = direction === 'open' ? 'grew' : 'shrank';
  lengths.slice(1).forEach((length, index) => {
    const previous = lengths[index]!;
    const against = direction === 'open' ? length > previous + 0.5 : length < previous - 0.5;
    if (against) {
      problems.push(
        `the thumb went ${round(previous)} -> ${round(length)} px as the list ${motion}`,
      );
    }
  });

  const moved = [...frames, settled].find(
    (sample) => Math.abs(sample.scrollTop - before.scrollTop) > 0.5,
  );
  if (moved) {
    problems.push(`the list scrolled ${round(before.scrollTop)} -> ${round(moved.scrollTop)}`);
  }
  return problems;
}

interface ContentCase {
  area: Area;
  /** Scrolled to the middle, so the thumb's travel is checked too. */
  midList: boolean;
}

async function expectThumbFollowsArea(
  page: Page,
  layout: Layout,
  { area, midList }: ContentCase,
): Promise<void> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const { scroller, track } = SCROLL_PARTS[layout];
  const chips = AREAS[area];

  await openSettings(page, layout);
  await expect(page.locator(scroller)).toHaveCSS('overflow-y', /^(auto|scroll)$/u);
  await ensureOverflow(page, scroller, area, midList ? 160 : 40);
  await installProbe(page, { scroller, track, area: chips.area, phone: layout === 'phone' });
  if (midList) await scrollToMiddle(page, scroller);
  await settleBar(page);

  // The formula's visible height is the track's: the scroller's height, less
  // the bottom nav over it on a phone.
  const geometry = await page.evaluate(() => {
    const probe = (window as ProbeWindow).__thumbProbe!;
    const { visible, clientHeight } = probe.sample();
    return { visible, clientHeight, overlap: probe.navOverlap() };
  });
  expect(
    Math.abs(geometry.visible - (geometry.clientHeight - geometry.overlap)),
  ).toBeLessThanOrEqual(TOLERANCE_PX);

  const phases: ReadonlyArray<[name: string, direction: Direction, chip: string]> = [
    ['open', 'open', chips.open],
    ['close', 'close', chips.close],
    ['open again', 'open', chips.open],
    ['close again', 'close', chips.close],
  ];
  const timelineEngine = await hasScrollTimeline(page);
  for (const [name, , chip] of phases) await runPhase(page, name, chip, timelineEngine);
  const records = await page.evaluate(() => (window as ProbeWindow).__thumbProbe!.phases);

  const drivers = new Set(
    Object.values(records).flatMap(({ before, frames, settled }) =>
      [before, ...frames, ...(settled ? [settled] : [])].map(({ driver }) => driver),
    ),
  );
  test.info().annotations.push({ type: 'scroll driver', description: [...drivers].join(', ') });

  expect({
    problems: Object.fromEntries(
      phases.map(([name, direction]) => [name, checkPhase(records[name], direction, midList)]),
    ),
    resizeObserverErrors: pageErrors.filter((message) => message.includes('ResizeObserver')),
  }).toEqual({
    problems: Object.fromEntries(phases.map(([name]) => [name, []])),
    resizeObserverErrors: [],
  });
}

for (const layout of ['desktop', 'compact', 'phone'] as const) {
  test.describe(`custom scrollbar content size (${layout})`, () => {
    test.use({ viewport: VIEWPORTS[layout] });

    test.beforeEach(({ browserName }) => {
      // The WebKit lane emulates an iPhone, so it runs the phone layout only.
      test.skip(browserName === 'webkit' && layout !== 'phone', 'The WebKit lane is a phone');
    });

    const cases: ReadonlyArray<[title: string, contentCase: ContentCase]> =
      layout === 'compact'
        ? [['the EQ Advanced area', { area: 'eq', midList: false }]]
        : [
            ['the EQ Advanced area', { area: 'eq', midList: false }],
            ['the reverb Advanced area', { area: 'reverb', midList: false }],
            ['the EQ Advanced area, scrolled to the middle', { area: 'eq', midList: true }],
          ];
    for (const [title, contentCase] of cases) {
      test(`follows ${title} as it opens and closes, frame by frame`, async ({ page }) => {
        await expectThumbFollowsArea(page, layout, contentCase);
      });
    }
  });
}
