/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaylistReorderController } from '../playlist-reorder.ts';
import { installPlaylistSelectionGestures } from '../playlist-selection-gestures.ts';
import { edgeAutoScrollVelocity, prefersReducedMotion } from '../playlist-motion.ts';

// RO-27: the reorder drag and the check-column selection drag share one edge
// auto-scroll contract (zone, arming and speed over the pane's visible part
// above an overlapping bottom navigation). Both controllers run the same
// pointer path over the same scrolled pane here and must take identical
// scroll steps.

const PANE_HEIGHT = 300;
const NAV_TOP = 260;
const IDS = ['r0', 'r1', 'r2', 'r3', 'r4'];

function rect(top: number, height: number, left = 0, width = 390): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function mountPane(): { list: HTMLElement; scroller: HTMLElement } {
  document.body.innerHTML = `<div class="tab-body"><ul id="playlist-ui">${IDS.map(
    (id) => `<li class="playlist-entry" data-queue-item-id="${id}">
      <div class="track-item" data-queue-item-id="${id}">
        <button type="button" class="playlist-reorder-handle" data-queue-item-id="${id}"><span class="track-idx">1</span></button>
        <button type="button" class="track-name" data-action="play" data-queue-item-id="${id}"></button>
        <button type="button" class="btn-playlist-select" data-action="select" data-queue-item-id="${id}"></button>
      </div>
    </li>`,
  ).join('')}</ul></div><nav class="bottom-nav"></nav>`;
  const list = document.getElementById('playlist-ui')!;
  const scroller = document.querySelector<HTMLElement>('.tab-body')!;
  let scrollTop = 40;
  Object.defineProperties(scroller, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: PANE_HEIGHT },
  });
  scroller.getBoundingClientRect = () => rect(0, PANE_HEIGHT);
  // A phone's bottom navigation covers the last 40px of the pane.
  document.querySelector<HTMLElement>('.bottom-nav')!.getBoundingClientRect = () =>
    rect(NAV_TOP, 80);
  return { list, scroller };
}

function dispatchPointer(target: EventTarget, type: string, clientY: number): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: 20,
    clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
    pointerType: { value: 'mouse' },
  });
  target.dispatchEvent(event);
}

type PathStep = { move: number } | { frames: number };

function runPath(
  kind: 'reorder' | 'selection',
  startY: number,
  path: readonly PathStep[],
): number[] {
  const { list, scroller } = mountPane();
  let teardown: () => void;
  let pressed: HTMLElement;
  if (kind === 'reorder') {
    const controller = createPlaylistReorderController({
      list,
      canReorder: () => true,
      isPlaylistVisible: () => true,
      onCommit: () => {},
      getAnnouncement: () => '',
    });
    teardown = () => controller.destroy();
    pressed = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;
  } else {
    const selected = new Set<string>();
    teardown = installPlaylistSelectionGestures({
      list,
      canSelect: () => true,
      isSelected: (id) => selected.has(id),
      toggle: (id) => {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      },
    });
    pressed = list.querySelector<HTMLElement>('.btn-playlist-select')!;
  }

  const steps: number[] = [];
  try {
    dispatchPointer(pressed, 'pointerdown', startY);
    let lastY = startY;
    for (const step of path) {
      if ('move' in step) {
        lastY = step.move;
        dispatchPointer(pressed, 'pointermove', lastY);
        continue;
      }
      for (let frame = 0; frame < step.frames; frame += 1) {
        vi.advanceTimersToNextFrame();
        steps.push(scroller.scrollTop);
      }
    }
    dispatchPointer(pressed, 'pointerup', lastY);
  } finally {
    teardown();
  }
  return steps;
}

describe('playlist edge auto-scroll parity (reorder drag and check-column drag)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('takes the same steps toward each edge of the pane visible above the bottom nav', () => {
    const path: PathStep[] = [
      { move: 110 },
      { frames: 3 },
      // Inside the bottom zone of the visible pane (it ends at the nav's top).
      { move: 248 },
      { frames: 6 },
      // Deeper in the zone scrolls faster.
      { move: 258 },
      { frames: 4 },
      // Back in the middle: the loop ends on the next frame.
      { move: 150 },
      { frames: 3 },
      // The top zone was armed when the pointer was outside it.
      { move: 6 },
      { frames: 6 },
    ];
    const reorder = runPath('reorder', 100, path);
    const selection = runPath('selection', 100, path);

    expect(reorder).toEqual(selection);
    // The path really scrolled down, held in the middle, then scrolled up.
    expect(reorder.slice(0, 3)).toEqual([40, 40, 40]);
    expect(reorder[8]!).toBeGreaterThan(40);
    expect(reorder[12]! - reorder[11]!).toBeGreaterThan(reorder[8]! - reorder[7]!);
    expect(reorder.slice(13, 16)).toEqual([reorder[12], reorder[12], reorder[12]]);
    expect(reorder.at(-1)!).toBeLessThan(reorder[15]!);
  });

  it('arms an edge that a press starts in only after travel toward it, the same way', () => {
    const path: PathStep[] = [
      // Moving away from the edge it started in does not arm it.
      { move: 241 },
      { frames: 4 },
      { move: 250 },
      { frames: 4 },
      // Travelling 8px toward the edge arms it.
      { move: 258 },
      { frames: 4 },
    ];
    const reorder = runPath('reorder', 250, path);
    const selection = runPath('selection', 250, path);

    expect(reorder).toEqual(selection);
    expect(reorder.slice(0, 8)).toEqual(Array(8).fill(40));
    expect(reorder.at(-1)!).toBeGreaterThan(40);
  });
});

describe('edgeAutoScrollVelocity', () => {
  interface NavBox {
    top: number;
    height: number;
    left?: number;
    display?: string;
  }

  function pane(height: number, nav: NavBox | null = null): HTMLElement {
    document.body.innerHTML = '<div class="tab-body"></div>';
    const scroller = document.querySelector<HTMLElement>('.tab-body')!;
    scroller.getBoundingClientRect = () => rect(0, height);
    if (nav) {
      const element = document.createElement('nav');
      element.className = 'bottom-nav';
      if (nav.display) element.style.display = nav.display;
      element.getBoundingClientRect = () => rect(nav.top, nav.height, nav.left ?? 0);
      document.body.appendChild(element);
    }
    return scroller;
  }

  function track(startClientY: number, lastClientY = startClientY) {
    return { startClientY, lastClientY, topEdgeArmed: false, bottomEdgeArmed: false };
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    // [case, pane height, nav, pointer y, pixels per frame]
    ['middle of a 300px pane', 300, null, 150, 0],
    ['bottom zone start (12% of 300px is 36px)', 300, null, 264, 0],
    ['half way into the bottom zone', 300, null, 282, 4.5],
    ['bottom edge', 300, null, 300, 18],
    ['past the bottom edge', 300, null, 320, 18],
    ['half way into the top zone', 300, null, 18, -4.5],
    ['bottom edge of the pane above an overlapping nav', 300, { top: 260, height: 80 }, 260, 18],
    ['zone floor of 24px in a short pane', 100, null, 88, 4.5],
    ['zone cap of 72px in a tall pane', 1000, null, 964, 4.5],
    ['a hidden nav', 300, { top: 260, height: 80, display: 'none' }, 282, 4.5],
    ['a side nav that does not overlap', 300, { top: 0, height: 300, left: 400 }, 282, 4.5],
    ['a nav with no height', 300, { top: 260, height: 0 }, 282, 4.5],
  ] as const)('%s', (_case, height, nav, y, expected) => {
    const scroller = pane(height, nav);
    const armed = { ...track(height / 2, y), topEdgeArmed: true, bottomEdgeArmed: true };
    expect(edgeAutoScrollVelocity(scroller, armed)).toBeCloseTo(expected, 10);
  });

  it('arms an edge a drag starts in only once it leaves the zone or travels 8px toward it', () => {
    const scroller = pane(300);
    const state = track(290);
    expect(edgeAutoScrollVelocity(scroller, state)).toBe(0);
    expect(state).toMatchObject({ topEdgeArmed: true, bottomEdgeArmed: false });

    const jitter = { ...state, lastClientY: 297 };
    expect(edgeAutoScrollVelocity(scroller, jitter)).toBe(0);
    expect(jitter.bottomEdgeArmed).toBe(false);

    const travelled = { ...state, lastClientY: 298 };
    expect(edgeAutoScrollVelocity(scroller, travelled)).toBeGreaterThan(0);
    expect(travelled.bottomEdgeArmed).toBe(true);

    const left = { ...state, lastClientY: 200 };
    expect(edgeAutoScrollVelocity(scroller, left)).toBe(0);
    expect(left.bottomEdgeArmed).toBe(true);
  });
});

describe('prefersReducedMotion', () => {
  function stubMatchMedia(matchMedia: (query: string) => MediaQueryList): void {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
  }

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it.each([true, false])('reads the media query (%s)', (matches) => {
    stubMatchMedia(
      (query) =>
        ({ matches: query === '(prefers-reduced-motion: reduce)' && matches }) as MediaQueryList,
    );
    expect(prefersReducedMotion()).toBe(matches);
  });

  it('allows motion when the media query is unavailable', () => {
    expect(prefersReducedMotion()).toBe(false);
    stubMatchMedia(() => {
      throw new Error('unsupported');
    });
    expect(prefersReducedMotion()).toBe(false);
  });
});
