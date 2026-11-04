import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';

/**
 * The phone setup scroll area (owner decision 2026-11-04). Under 720px the
 * visible step area, which is the element that scrolls, and the actions bar
 * under it span the screen, and the side spacing sits inside them: 56px in
 * the step area and 84px in the actions bar, where the card's and the view's
 * 28px insets used to put the content. A contained step area's scrollbar is
 * drawn at the right edge of .setup-mobile-view (src/ui/custom-scrollbar.ts),
 * so it sits at the screen edge, its bar 2px in, and a scroll that starts in
 * a side margin lands on the step area. No box inside the step areas or the
 * actions bar moves. From 720px the two-column panel keeps its own 28px.
 */

type Step = 'welcome' | 'join' | 'host';

const STEP_AREAS: Readonly<Record<Step, string>> = {
  welcome: '#setup-welcome-area',
  join: '#setup-join-area',
  host: '#setup-code-area',
};

// Short phones, where every step overflows and draws its bar, and a phone
// held sideways under 720px, which keeps the one-column layout.
const PHONE_VIEWPORTS = [
  { width: 390, height: 600 },
  { width: 320, height: 568 },
  { width: 667, height: 375 },
] as const;
// The two-column layout from 720px: a phone held sideways and a tablet.
const PANEL_VIEWPORTS = [
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
] as const;

const AREA_INSET = 56;
const ACTIONS_INSET = 84;
const PANEL_INSET = 28;
/** A contained track is 8px wide at right: 0; its bar sits inside a 2px border. */
const TRACK_WIDTH = 8;
const BAR_INSET = 2;
/** How far from each screen edge the side margins are probed, clear of the track. */
const MARGIN_PROBE = 20;

/**
 * The phone insets before this change, put back for a moment to compare
 * every box: the card's and the view's 28px each, none on the step areas,
 * the actions bar's own 28px.
 */
const EARLIER_PHONE_INSETS = `
  #setup-overlay .setup-card.full-screen,
  #setup-overlay .setup-mobile-view {
    padding-left: 28px !important;
    padding-right: 28px !important;
  }
  #setup-overlay .setup-mobile-view > div:not(.ob-actions):not(.cscroll-track) {
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  #setup-overlay .setup-mobile-view > .ob-actions {
    padding-left: 28px !important;
    padding-right: 28px !important;
  }
`;

interface Edges {
  left: number;
  right: number;
  paddingLeft: number;
  paddingRight: number;
}

interface SetupLayout {
  width: number;
  card: Edges;
  view: Edges;
  area: Edges;
  actions: Edges;
  /** The outer edges of the visible action buttons together. */
  buttons: { left: number; right: number };
  scrolls: { area: boolean; view: boolean };
  /** The distinct right edges and widths of the view's scrollbar tracks. */
  tracks: { rights: number[]; widths: number[] };
  /** The right edge of the drawn bar's paint, when the step area overflows. */
  barRight: number | null;
  /** Whether a point in the left and in the right side margin hits the step area. */
  marginHits: boolean[];
  /** The boxes inside the step areas and the actions bar that the earlier insets move. */
  moved: string[] | null;
}

interface ReadOptions {
  earlierInsets: string | null;
  marginProbe: number;
}

type TransitionWindow = Window & { __SETUP_SCROLL_EDGE_TRANSITIONS__?: Set<Promise<void>> };

function readSetupLayout(area: Element, { earlierInsets, marginProbe }: ReadOptions): SetupLayout {
  const round = (value: number): number => Math.round(value * 100) / 100;
  const px = (value: string): number => Number.parseFloat(value) || 0;
  const edges = (element: Element): Edges => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: round(rect.left),
      right: round(rect.right),
      paddingLeft: round(px(style.paddingLeft)),
      paddingRight: round(px(style.paddingRight)),
    };
  };
  const view = area.parentElement!;
  const card = view.parentElement!;
  const actions = view.querySelector(':scope > .ob-actions')!;
  const width = document.documentElement.clientWidth;

  const buttons = [...actions.querySelectorAll('button')]
    .filter((button) => button.getClientRects().length > 0)
    .map((button) => button.getBoundingClientRect());
  const tracks = [...view.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('cscroll-track'),
  );
  const bar = tracks
    .find((track) => px(track.style.height) > 0)
    ?.querySelector('.cscroll-thumb-visual');

  const areaRect = area.getBoundingClientRect();
  const middle = areaRect.top + areaRect.height / 2;
  const marginHits = [marginProbe, width - marginProbe].map((x) => {
    const hit = document.elementFromPoint(x, middle);
    return hit !== null && area.contains(hit);
  });

  let moved: string[] | null = null;
  if (earlierInsets !== null) {
    const boxes = [...view.querySelectorAll(':scope > div:not(.cscroll-track) *')];
    const read = () => boxes.map((box) => box.getBoundingClientRect());
    const label = (element: Element): string =>
      element.id
        ? `#${element.id}`
        : [element.tagName.toLowerCase(), ...element.classList].join('.');
    // Transitions off, so both reads see settled boxes and nothing animates back.
    const still = document.createElement('style');
    still.textContent = '#setup-overlay, #setup-overlay * { transition: none !important; }';
    const earlier = document.createElement('style');
    earlier.textContent = earlierInsets;
    document.head.append(still);
    const now = read();
    document.head.append(earlier);
    const then = read();
    earlier.remove();
    view.getBoundingClientRect();
    still.remove();
    moved = boxes.flatMap((box, index) => {
      const a = now[index]!;
      const b = then[index]!;
      const shift = Math.max(
        Math.abs(a.left - b.left),
        Math.abs(a.top - b.top),
        Math.abs(a.width - b.width),
        Math.abs(a.height - b.height),
      );
      return shift > 0.01 ? [`${label(box)} ${round(shift)}px`] : [];
    });
  }

  return {
    width,
    card: edges(card),
    view: edges(view),
    area: edges(area),
    actions: edges(actions),
    buttons: {
      left: round(Math.min(...buttons.map((rect) => rect.left))),
      right: round(Math.max(...buttons.map((rect) => rect.right))),
    },
    scrolls: {
      area: area.scrollHeight > area.clientHeight + 1,
      view: view.scrollHeight > view.clientHeight + 1,
    },
    tracks: {
      rights: [...new Set(tracks.map((track) => round(track.getBoundingClientRect().right)))],
      widths: [...new Set(tracks.map((track) => round(track.getBoundingClientRect().width)))],
    },
    barRight: bar
      ? round(bar.getBoundingClientRect().right - px(getComputedStyle(bar).borderRightWidth))
      : null,
    marginHits,
    moved,
  };
}

async function openSetup(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    // Setup steps change inside a view transition (src/ui/dom.ts), and while
    // one runs a hit test reaches only the root. Observe each one without
    // skipping or changing it, so a check can wait for it to finish.
    const pending = new Set<Promise<void>>();
    (window as TransitionWindow).__SETUP_SCROLL_EDGE_TRANSITIONS__ = pending;
    if (!document.startViewTransition) return;
    const original = document.startViewTransition.bind(document);
    document.startViewTransition = (...args) => {
      const transition = original(...args);
      pending.add(transition.finished);
      void transition.finished.then(
        () => pending.delete(transition.finished),
        () => pending.delete(transition.finished),
      );
      return transition;
    };
  });
  await injectPeerServer(page);
  await useAnonymousAccountSession(page);
  // Browser Insights rejects preview origins in WebKit (setup-carousel-autoplay.test.ts).
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await waitForBootstrapReady(page);
  await expect(page.locator('#btn-setup-host')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** Waits for the view transitions started so far to finish. */
async function settleViewTransitions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pending = (window as TransitionWindow).__SETUP_SCROLL_EDGE_TRANSITIONS__;
    await Promise.all([...(pending ?? [])].map((finished) => finished.catch(() => {})));
  });
}

/** Opens a step from the start screen. */
async function enterStep(page: Page, step: Step): Promise<Locator> {
  if (step === 'join') await page.locator('#btn-setup-guest').click();
  if (step === 'host') await page.locator('#btn-setup-host').click();
  const area = page.locator(STEP_AREAS[step]);
  await expect(area).toBeVisible();
  if (step === 'host') {
    // The room code and its QR give the step its final height.
    await expect(page.locator('#setup-code')).toHaveValue(/^\d{6}$/u, { timeout: 20_000 });
    await expect(page.locator('#setup-host-qr svg')).toBeVisible();
  }
  await settleViewTransitions(page);
  return area;
}

/** Goes back to the start screen from a step. */
async function leaveStep(page: Page, step: Step): Promise<void> {
  if (step === 'welcome') return;
  await page.locator('#btn-setup-back').click();
  await expect(page.locator(STEP_AREAS.welcome)).toBeVisible();
  await settleViewTransitions(page);
}

/** Waits until the step area overflows and its own contained track is laid out. */
async function waitForDrawnTrack(area: Locator): Promise<void> {
  await expect
    .poll(() =>
      area.evaluate((element) => {
        const drawn = [...element.parentElement!.children].filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            child.classList.contains('cscroll-track-contained') &&
            Number.parseFloat(child.style.height) > 0,
        );
        return (
          element.scrollHeight > element.clientHeight + 1 &&
          drawn.length === 1 &&
          Math.abs(Number.parseFloat(drawn[0]!.style.height) - element.clientHeight) < 1
        );
      }),
    )
    .toBe(true);
}

/** A mouse wheel in the left side margin scrolls the step area. */
async function expectMarginWheelScrolls(page: Page, area: Locator): Promise<void> {
  const box = await area.boundingBox();
  if (!box) throw new Error('The step area has no box');
  await area.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.mouse.move(MARGIN_PROBE, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => area.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await area.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.mouse.move(0, 0);
}

test.describe('phone setup scroll area', () => {
  for (const { width, height } of PHONE_VIEWPORTS) {
    test(`spans the step area and the actions across ${width}x${height}, the bar at the edge and every box in place`, async ({
      page,
      browserName,
    }) => {
      await openSetup(page, { width, height });
      // The WebKit lane opens no PeerJS room (component-cascade.test.ts), so
      // it checks the two steps that need none.
      const steps: Step[] =
        browserName === 'webkit' ? ['welcome', 'join'] : ['welcome', 'join', 'host'];
      for (const step of steps) {
        const area = await enterStep(page, step);
        await waitForDrawnTrack(area);
        const layout = await area.evaluate(readSetupLayout, {
          earlierInsets: EARLIER_PHONE_INSETS,
          marginProbe: MARGIN_PROBE,
        });
        expect(layout, `${step} at ${width}x${height}`).toEqual({
          width,
          card: { left: 0, right: width, paddingLeft: 0, paddingRight: 0 },
          view: { left: 0, right: width, paddingLeft: 0, paddingRight: 0 },
          area: { left: 0, right: width, paddingLeft: AREA_INSET, paddingRight: AREA_INSET },
          actions: {
            left: 0,
            right: width,
            paddingLeft: ACTIONS_INSET,
            paddingRight: ACTIONS_INSET,
          },
          buttons: { left: ACTIONS_INSET, right: width - ACTIONS_INSET },
          scrolls: { area: true, view: false },
          tracks: { rights: [width], widths: [TRACK_WIDTH] },
          barRight: width - BAR_INSET,
          marginHits: [true, true],
          moved: [],
        });
        if (browserName === 'chromium') await expectMarginWheelScrolls(page, area);
        await leaveStep(page, step);
      }
    });
  }

  for (const { width, height } of PANEL_VIEWPORTS) {
    test(`keeps the two-column panel's own 28px at ${width}x${height}`, async ({ page }) => {
      await openSetup(page, { width, height });
      for (const step of ['welcome', 'join'] as const) {
        const area = await enterStep(page, step);
        const layout = await area.evaluate(readSetupLayout, {
          earlierInsets: null,
          marginProbe: MARGIN_PROBE,
        });
        const panelLeft = layout.view.left;
        expect(layout, `${step} at ${width}x${height}`).toMatchObject({
          width,
          card: { paddingLeft: 0, paddingRight: 0 },
          view: { right: width, paddingLeft: 0, paddingRight: 0 },
          area: {
            left: panelLeft,
            right: width,
            paddingLeft: PANEL_INSET,
            paddingRight: PANEL_INSET,
          },
          actions: {
            left: panelLeft,
            right: width,
            paddingLeft: PANEL_INSET,
            paddingRight: PANEL_INSET,
          },
          buttons: { left: panelLeft + PANEL_INSET, right: width - PANEL_INSET },
          tracks: { rights: [width], widths: [TRACK_WIDTH] },
        });
        await leaveStep(page, step);
      }
    });
  }
});
