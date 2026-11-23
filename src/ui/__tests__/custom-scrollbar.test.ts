/**
 * @vitest-environment jsdom
 *
 * Covers the module-level settled-relayout design of custom-scrollbar:
 * orientation/compact-landscape MQL changes are page-global events, so there
 * is ONE listener pair and ONE managed-timer debounce pair that re-lays out
 * EVERY live instance. Per-instance callbacks under one fixed managed-timer
 * key would coalesce into only the last registered closure, leaving the other
 * scrollbars without a post-rotation settled re-layout.
 */
import { readdir, readFile } from 'node:fs/promises';
import { parse as parseCss } from 'postcss';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { bus } from '../../core/events.ts';
import { COMPACT_LAYOUT_QUERY, SHORT_DESKTOP_LAYOUT_QUERY } from '../../core/layout-breakpoints.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';

// ── jsdom polyfills (module scope, installed once for the whole file) ──────
//
// The scrollbar module binds its global MQL listeners ONCE on first init, so
// the matchMedia mock must RECORD listeners (the settings.test.ts stub uses
// vi.fn() that swallows them) and must persist across tests — re-installing
// it per test would orphan the already-bound module-level listener.

type MqlListener = () => void;
const _mqlListeners = new Map<string, Set<MqlListener>>();
const _mqlMatches = new Map<string, boolean>();

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => {
    let listeners = _mqlListeners.get(query);
    if (!listeners) {
      listeners = new Set<MqlListener>();
      _mqlListeners.set(query, listeners);
    }
    const set = listeners;
    return {
      get matches(): boolean {
        return _mqlMatches.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: MqlListener): void => {
        set.add(cb);
      },
      removeEventListener: (_type: string, cb: MqlListener): void => {
        set.delete(cb);
      },
      addListener: (cb: MqlListener): void => {
        set.add(cb);
      },
      removeListener: (cb: MqlListener): void => {
        set.delete(cb);
      },
      dispatchEvent: (): boolean => false,
    };
  },
});

let _nextRafId = 1;
const _rafCallbacks = new Map<number, FrameRequestCallback>();

Object.defineProperty(window, 'requestAnimationFrame', {
  writable: true,
  configurable: true,
  value: (callback: FrameRequestCallback): number => {
    const id = _nextRafId++;
    _rafCallbacks.set(id, callback);
    return id;
  },
});
Object.defineProperty(window, 'cancelAnimationFrame', {
  writable: true,
  configurable: true,
  value: (id: number): void => {
    _rafCallbacks.delete(id);
  },
});

function flushAnimationFrame(now = performance.now()): void {
  const callbacks = [..._rafCallbacks.values()];
  _rafCallbacks.clear();
  callbacks.forEach((callback) => callback(now));
}

async function flushMutationObservers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Every observer that watches a target, with the box it watches. A bar's one
 * observer watches its container and the container's direct element children,
 * so an inner scroll container is watched by its own bar and the outer one.
 */
const _resizeObservations = new Map<Element, Map<ResizeObserverStub, ResizeObserverBoxOptions>>();

class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element, options?: ResizeObserverOptions): void {
    let observers = _resizeObservations.get(target);
    if (!observers) {
      observers = new Map();
      _resizeObservations.set(target, observers);
    }
    observers.set(this, options?.box ?? 'content-box');
  }

  unobserve(target: Element): void {
    const observers = _resizeObservations.get(target);
    observers?.delete(this);
    if (observers?.size === 0) _resizeObservations.delete(target);
  }

  disconnect(): void {
    for (const [target, observers] of _resizeObservations) {
      observers.delete(this);
      if (observers.size === 0) _resizeObservations.delete(target);
    }
  }

  notify(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

/** Reports a size change of a target to every observer watching it, as the browser does. */
function notifyResize(target: Element): void {
  for (const observer of [...(_resizeObservations.get(target)?.keys() ?? [])]) observer.notify();
}

/** The box each observer watching a target watches, sorted; empty when none does. */
function watchedBoxes(target: Element): ResizeObserverBoxOptions[] {
  return [...(_resizeObservations.get(target)?.values() ?? [])].sort();
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: ResizeObserverStub,
});
Object.defineProperty(globalThis, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: ResizeObserverStub,
});

import { initCustomScrollbar, destroyCustomScrollbar } from '../custom-scrollbar.ts';

/** Fire the recorded 'change' listeners for a media query (page-global event). */
function fireMqlChange(query: string): void {
  const listeners = _mqlListeners.get(query);
  expect(listeners && listeners.size, `no listeners recorded for ${query}`).toBeTruthy();
  listeners?.forEach((cb) => cb());
}

const ORIENTATION_QUERY = '(orientation: landscape)';

function makeRect(height: number, top = 0): DOMRect {
  return {
    x: 0,
    y: top,
    width: 100,
    height,
    top,
    right: 100,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  };
}

interface Scrollbox {
  container: HTMLElement;
  rectSpy: Mock<() => DOMRect>;
  scrollHeightSpy: Mock<() => number>;
  clientHeightSpy: Mock<() => number>;
  setClientHeight(px: number): void;
  setScrollHeight(px: number): void;
  track(): HTMLElement;
}

const _boxes: Scrollbox[] = [];

/**
 * Scrollable container with mocked geometry (jsdom has no layout engine).
 * Uses data-custom-scroll-contained so updateLayout takes the contained
 * branch: track height = clientHeight, no bottom-nav / transform-block walk.
 * rectSpy counts updateLayout runs (called exactly once per layout pass).
 * The container gets a parent of its own unless `wrapped` is false; then it
 * sits directly in `mount`, which also receives its track.
 */
function createScrollbox(
  id: string,
  mount: HTMLElement = document.body,
  wrapped = true,
): Scrollbox {
  const parent = wrapped ? document.createElement('div') : mount;
  const container = document.createElement('div');
  container.id = id;
  container.setAttribute('data-custom-scroll', '');
  container.setAttribute('data-custom-scroll-contained', '');
  container.style.overflowY = 'auto';
  parent.appendChild(container);
  if (wrapped) mount.appendChild(parent);

  let clientHeight = 200;
  let scrollHeight = 1000;
  const scrollHeightSpy = vi.fn(() => scrollHeight);
  const clientHeightSpy = vi.fn(() => clientHeight);
  Object.defineProperty(container, 'scrollHeight', {
    configurable: true,
    get: scrollHeightSpy,
  });
  Object.defineProperty(container, 'clientHeight', {
    configurable: true,
    get: clientHeightSpy,
  });
  const rectSpy = vi.fn((): DOMRect => makeRect(clientHeight));
  container.getBoundingClientRect = rectSpy;

  const box = {
    container,
    rectSpy,
    scrollHeightSpy,
    clientHeightSpy,
    setClientHeight: (px: number): void => {
      clientHeight = px;
    },
    setScrollHeight: (px: number): void => {
      scrollHeight = px;
    },
    track: (): HTMLElement => {
      const t = parent.querySelector<HTMLElement>(':scope > .cscroll-track');
      if (!t) throw new Error(`track not created for #${id}`);
      return t;
    },
  };
  _boxes.push(box);
  return box;
}

function readVisualTransform(element: HTMLElement): { translateY: number; scaleY: number } {
  const match = /^translateY\(([-+\d.eE]+)px\) scaleY\(([-+\d.eE]+)\)$/u.exec(
    element.style.transform,
  );
  if (!match) throw new Error(`Unexpected thumb visual transform: ${element.style.transform}`);
  return {
    translateY: Number(match[1]),
    scaleY: Number(match[2]),
  };
}

// The bar's hold on its scroller, as custom-scrollbar.ts names it
// (CUSTOM_SCROLL_HELD_ATTRIBUTE, kept to that module). The hold rows read the
// attribute by this name and the stylesheet row finds its rule by it, so a
// rename on either side fails rows here.
const HELD_ATTRIBUTE = 'data-custom-scroll-held';

/** Whether the bar holds its scroller still (overflow hidden, by the safety-layer rule). */
function isHeld(container: HTMLElement): boolean {
  return container.hasAttribute(HELD_ATTRIBUTE);
}

/**
 * In a browser the safety-layer rule makes a held scroller compute to overflow
 * hidden, and the bar's own layout reads that value. jsdom applies no
 * stylesheet, so this stands in for the rule until the row restores it.
 */
function computeHeldScrollersHidden(): { mockRestore(): void } {
  const nativeComputedStyle = window.getComputedStyle.bind(window);
  return vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element, pseudoElement) => {
    const style = nativeComputedStyle(element, pseudoElement);
    if (!element.hasAttribute(HELD_ATTRIBUTE)) return style;
    return new Proxy(style, {
      get(target, property) {
        if (property === 'overflow' || property === 'overflowX' || property === 'overflowY') {
          return 'hidden';
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

interface TouchPoint {
  identifier: number;
  clientY: number;
}

/** jsdom has no Touch constructor, so plain points stand in for the touch lists. */
function dispatchTouches(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: TouchPoint[],
  changedTouches: TouchPoint[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: changedTouches },
  });
  target.dispatchEvent(event);
  return event;
}

type PressEnd =
  'mouseup' | 'blur' | 'destroy' | 'touchend' | 'touchcancel' | 'touchcancel without touches';

/** Ends a press on the bar as the browser would, or tears the bar down. */
function endPress(end: PressEnd, box: Scrollbox, target: HTMLElement, finger: TouchPoint): void {
  if (end === 'mouseup') {
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  } else if (end === 'blur') {
    window.dispatchEvent(new Event('blur'));
  } else if (end === 'destroy') {
    destroyCustomScrollbar(box.container);
  } else if (end === 'touchcancel without touches') {
    target.dispatchEvent(new Event('touchcancel', { bubbles: true }));
  } else {
    dispatchTouches(target, end, [], [finger]);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  clearAllManagedTimers();
  bus.clear();
});

afterEach(() => {
  // Deregister from the module's live instance map — relayoutAll iterates it,
  // so leaking instances across tests would pollute later run counts.
  for (const box of _boxes) destroyCustomScrollbar(box.container);
  _boxes.length = 0;
  _rafCallbacks.clear();
  _resizeObservations.clear();
  _mqlMatches.clear();
  clearAllManagedTimers();
  vi.useRealTimers();
  document.body.style.removeProperty('--desktop-ui-scale');
  document.body.innerHTML = '';
});

describe('custom-scrollbar ownership', () => {
  it.each(['touchend', 'touchcancel'] as const)(
    'keeps the first thumb drag when a second finger triggers %s',
    (endType) => {
      const box = createScrollbox(`touch-owner-${endType}`);
      initCustomScrollbar(box.container);
      const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
      const owner = { identifier: 1, clientY: 0 };
      const second = { identifier: 2, clientY: 20 };
      dispatchTouches(thumb, 'touchstart', [owner], [owner]);
      dispatchTouches(thumb, 'touchstart', [owner, second], [second]);
      dispatchTouches(thumb, endType, [owner], [second]);
      const heldThroughSecond = isHeld(box.container);
      expect(thumb.classList.contains('dragging')).toBe(true);
      dispatchTouches(thumb, 'touchmove', [{ ...owner, clientY: 40 }], [owner]);
      expect(box.container.scrollTop).toBe(200);
      dispatchTouches(thumb, 'touchend', [], [owner]);
      expect(thumb.classList.contains('dragging')).toBe(false);
      dispatchTouches(thumb, 'touchmove', [{ ...owner, clientY: 80 }], [owner]);
      expect(box.container.scrollTop).toBe(200);
      // The hold outlives the second finger and ends with the first one's touch.
      expect({ heldThroughSecond, heldAfterOwnerEnd: isHeld(box.container) }).toEqual({
        heldThroughSecond: true,
        heldAfterOwnerEnd: false,
      });
    },
  );

  it('tracks the local thumb touch independently of a contact elsewhere on the document', () => {
    const box = createScrollbox('local-touch-owner');
    initCustomScrollbar(box.container);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    const outside = { identifier: 1, clientY: 300 };
    const owner = { identifier: 2, clientY: 0 };
    dispatchTouches(thumb, 'touchstart', [outside, owner], [owner]);
    dispatchTouches(thumb, 'touchmove', [outside, { ...owner, clientY: 40 }], [owner]);
    expect(box.container.scrollTop).toBe(200);
    dispatchTouches(thumb, 'touchcancel', [outside], [owner]);
    expect(thumb.classList.contains('dragging')).toBe(false);
    dispatchTouches(thumb, 'touchmove', [outside, { ...owner, clientY: 80 }], [owner]);
    expect(box.container.scrollTop).toBe(200);

    dispatchTouches(thumb, 'touchstart', [owner], [owner]);
    thumb.dispatchEvent(new Event('touchcancel'));
    expect(thumb.classList.contains('dragging')).toBe(false);
    dispatchTouches(thumb, 'touchstart', [owner], [owner]);
    dispatchTouches(thumb, 'touchmove', [{ ...owner, clientY: 40 }], [owner]);
    expect(box.container.scrollTop).toBe(400);
    window.dispatchEvent(new Event('blur'));
    expect(thumb.classList.contains('dragging')).toBe(false);
  });

  it('keeps an active thumb touch through a mouse click on a hybrid device', () => {
    const box = createScrollbox('hybrid-touch-owner');
    initCustomScrollbar(box.container);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    const owner = { identifier: 1, clientY: 0 };
    dispatchTouches(thumb, 'touchstart', [owner], [owner]);
    thumb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    expect(thumb.classList.contains('dragging')).toBe(true);
    dispatchTouches(thumb, 'touchmove', [{ ...owner, clientY: 40 }], [owner]);
    expect(box.container.scrollTop).toBe(200);
    window.dispatchEvent(new Event('blur'));
    expect(thumb.classList.contains('dragging')).toBe(false);
  });

  it.each([0, 1, 2])('only starts thumb dragging with the primary mouse button (%i)', (button) => {
    const box = createScrollbox(`thumb-button-${button}`);
    initCustomScrollbar(box.container);
    box.container.scrollTop = 100;
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button,
      clientY: 0,
    });

    thumb.dispatchEvent(down);
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 40 }));
    const observed = {
      scrollTop: box.container.scrollTop,
      dragging: thumb.classList.contains('dragging'),
      userSelect: document.body.style.userSelect,
      prevented: down.defaultPrevented,
      held: isHeld(box.container),
    };
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button }));

    expect(observed).toEqual({
      scrollTop: button === 0 ? 300 : 100,
      dragging: button === 0,
      userSelect: button === 0 ? 'none' : '',
      prevented: button === 0,
      held: button === 0,
    });
    expect(thumb.classList.contains('dragging')).toBe(false);
    expect(document.body.style.userSelect).toBe('');
    expect(isHeld(box.container)).toBe(false);
  });

  it.each([0, 1, 2])('only jumps along the track with the primary mouse button (%i)', (button) => {
    const box = createScrollbox(`track-button-${button}`);
    initCustomScrollbar(box.container);
    box.container.scrollTop = 100;
    box.track().getBoundingClientRect = () => makeRect(200);

    box
      .track()
      .dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, clientY: 150 }),
      );
    const observed = { scrollTop: box.container.scrollTop, held: isHeld(box.container) };
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button }));

    expect(observed).toEqual({ scrollTop: button === 0 ? 600 : 100, held: button === 0 });
    expect(isHeld(box.container)).toBe(false);
  });

  it('keeps the custom track on coarse mobile surfaces and hides native bars globally', async () => {
    _mqlMatches.set('(pointer: coarse)', true);
    _mqlMatches.set('(any-pointer: coarse)', true);
    const box = createScrollbox('coarse-mobile-owner');

    initCustomScrollbar(box.container);

    expect(box.track().querySelector('.cscroll-thumb')).toBeTruthy();
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toMatch(/::-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
    expect(stylesheet).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*none;/s);
    expect(stylesheet).not.toContain('--scrollbar-native-thumb');
    expect(stylesheet).not.toContain('.cscroll-custom-owner');
  });
});

describe('custom-scrollbar hold on its scroller while the bar is pressed', () => {
  // The bar lies outside its scroller, so a press on it cannot stop a glide the
  // browser is still running on the list, and the list follows the thumb only
  // once the glide has run down. From a press on the bar until that press ends,
  // the bar holds its scroller still (not user-scrollable); script still moves
  // it. jsdom applies no stylesheet, so these rows read the hold's attribute,
  // and one row reads the safety-layer rule that turns it into overflow hidden.

  /** What the bar shows, and whether it holds its scroller. */
  function readBar(box: Scrollbox): {
    held: boolean;
    opacity: string;
    pointerEvents: string;
    thumbDisplay: string;
    gutter: boolean;
  } {
    const track = box.track();
    return {
      held: isHeld(box.container),
      opacity: track.style.opacity,
      pointerEvents: track.style.pointerEvents,
      thumbDisplay: track.querySelector<HTMLElement>('.cscroll-thumb')!.style.display,
      gutter: box.container.classList.contains('has-scroll-overflow'),
    };
  }

  it.each<['mouse' | 'touch', PressEnd]>([
    ['mouse', 'mouseup'],
    ['mouse', 'blur'],
    ['mouse', 'destroy'],
    ['touch', 'touchend'],
    ['touch', 'touchcancel'],
    ['touch', 'touchcancel without touches'],
    ['touch', 'blur'],
    ['touch', 'destroy'],
  ])(
    'holds its scroller still from a %s press on the thumb until the drag ends by %s',
    (press, end) => {
      const box = createScrollbox(`thumb-hold-${press}-${end.replaceAll(' ', '-')}`);
      initCustomScrollbar(box.container);
      box.container.scrollTop = 100;
      const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
      const finger = { identifier: 1, clientY: 0 };

      if (press === 'mouse') {
        thumb.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }),
        );
      } else {
        dispatchTouches(thumb, 'touchstart', [finger], [finger]);
      }
      const heldAtPress = isHeld(box.container);
      if (press === 'mouse') {
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 40 }));
      } else {
        const moved = { ...finger, clientY: 40 };
        dispatchTouches(thumb, 'touchmove', [moved], [moved]);
      }
      const duringDrag = {
        held: isHeld(box.container),
        scrollTop: box.container.scrollTop,
        overflowY: box.container.style.overflowY,
      };
      endPress(end, box, thumb, finger);

      // The hold is the stylesheet's, not an inline overflow: the inline value
      // stays as it was, and the drag still maps from the press.
      expect({
        heldAtPress,
        duringDrag,
        heldAfterEnd: isHeld(box.container),
        overflowYAfterEnd: box.container.style.overflowY,
      }).toEqual({
        heldAtPress: true,
        duringDrag: { held: true, scrollTop: 300, overflowY: 'auto' },
        heldAfterEnd: false,
        overflowYAfterEnd: 'auto',
      });
    },
  );

  it('keeps a held bar and its drag through every relayout while its scroller computes to overflow hidden', async () => {
    const computedStyle = computeHeldScrollersHidden();
    try {
      const box = createScrollbox('held-through-relayout');
      box.container.setAttribute('data-custom-scroll-gutter', '');
      initCustomScrollbar(box.container);
      box.container.scrollTop = 100;
      const track = box.track();
      const thumb = track.querySelector<HTMLElement>('.cscroll-thumb')!;
      expect(box.container.classList.contains('has-scroll-overflow')).toBe(true);

      thumb.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }),
      );
      const heldAtPress = isHeld(box.container);

      // Every way a layout runs while the thumb is held: the bus, a resize, a
      // content change, a new scroll session and a settled rotation.
      bus.emit('ui:scrollbar-relayout');
      flushAnimationFrame();
      notifyResize(box.container);
      flushAnimationFrame();
      box.container.appendChild(document.createElement('div'));
      await flushMutationObservers();
      flushAnimationFrame();
      vi.advanceTimersByTime(1_200);
      box.container.dispatchEvent(new Event('scroll'));
      flushAnimationFrame();
      fireMqlChange(ORIENTATION_QUERY);
      vi.advanceTimersByTime(700);
      flushAnimationFrame();

      const duringDrag = {
        held: isHeld(box.container),
        opacity: track.style.opacity,
        pointerEvents: track.style.pointerEvents,
        thumbDisplay: thumb.style.display,
        thumbHeight: thumb.style.height,
        gutter: box.container.classList.contains('has-scroll-overflow'),
      };
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 40 }));
      const scrollTopAfterMove = box.container.scrollTop;
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      const heldAfterRelease = isHeld(box.container);
      bus.emit('ui:scrollbar-relayout');
      flushAnimationFrame();

      expect({
        heldAtPress,
        duringDrag,
        scrollTopAfterMove,
        heldAfterRelease,
        afterRelease: {
          opacity: track.style.opacity,
          thumbDisplay: thumb.style.display,
          gutter: box.container.classList.contains('has-scroll-overflow'),
        },
      }).toEqual({
        heldAtPress: true,
        duringDrag: {
          held: true,
          opacity: '1',
          pointerEvents: 'auto',
          thumbDisplay: '',
          thumbHeight: '40px',
          gutter: true,
        },
        scrollTopAfterMove: 300,
        heldAfterRelease: false,
        afterRelease: { opacity: '1', thumbDisplay: '', gutter: true },
      });
    } finally {
      computedStyle.mockRestore();
    }
  });

  it('keeps the bar through a relayout while a mouse press or a finger on its empty part holds its scroller', () => {
    const computedStyle = computeHeldScrollersHidden();
    try {
      const box = createScrollbox('bar-press-through-relayout');
      box.container.setAttribute('data-custom-scroll-gutter', '');
      initCustomScrollbar(box.container);
      box.container.scrollTop = 100;
      const track = box.track();
      track.getBoundingClientRect = () => makeRect(200);

      // The list has rested past the fade delay, so the scroll of the press's
      // own jump starts a new scroll session, which lays the bar out while the
      // press holds the scroller.
      vi.advanceTimersByTime(1_200);
      track.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 150 }),
      );
      box.container.dispatchEvent(new Event('scroll'));
      flushAnimationFrame();
      const duringMousePress = readBar(box);
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      flushAnimationFrame();

      // A finger on the empty part of the bar, through a relayout from the bus.
      const finger = { identifier: 1, clientY: 150 };
      dispatchTouches(track, 'touchstart', [finger], [finger]);
      bus.emit('ui:scrollbar-relayout');
      flushAnimationFrame();
      const duringFinger = readBar(box);
      dispatchTouches(track, 'touchend', [], [finger]);

      const shown = {
        held: true,
        opacity: '1',
        pointerEvents: 'auto',
        thumbDisplay: '',
        gutter: true,
      };
      expect({ duringMousePress, duringFinger }).toEqual({
        duringMousePress: shown,
        duringFinger: shown,
      });
    } finally {
      computedStyle.mockRestore();
    }
  });

  it('lays the bar out once its hold ends, so a scroller another holder keeps unscrollable loses its bar', async () => {
    const computedStyle = computeHeldScrollersHidden();
    try {
      const box = createScrollbox('held-then-unscrollable');
      box.container.setAttribute('data-custom-scroll-gutter', '');
      initCustomScrollbar(box.container);
      const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;

      thumb.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }),
      );
      // Another holder writes an inline overflow-y hidden while the thumb
      // holds, as the Android range lock does. The held bar keeps its scroller.
      box.container.style.overflowY = 'hidden';
      await flushMutationObservers();
      flushAnimationFrame();
      const whileHeld = readBar(box);
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      flushAnimationFrame();

      expect({ whileHeld, afterRelease: readBar(box) }).toEqual({
        whileHeld: {
          held: true,
          opacity: '1',
          pointerEvents: 'auto',
          thumbDisplay: '',
          gutter: true,
        },
        afterRelease: {
          held: false,
          opacity: '0',
          pointerEvents: 'none',
          thumbDisplay: 'none',
          gutter: false,
        },
      });
    } finally {
      computedStyle.mockRestore();
    }
  });

  it('lets a held touch drag go when a later touch no longer lists its finger or adds a contact under its identifier, and keeps it while it does', () => {
    const box = createScrollbox('lost-thumb-finger');
    initCustomScrollbar(box.container);
    box.container.scrollTop = 100;
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    const state = (): { dragging: boolean; held: boolean } => ({
      dragging: thumb.classList.contains('dragging'),
      held: isHeld(box.container),
    });

    // Another finger lands while the thumb's finger stays down, and an event
    // without touch lists names no contact: the drag goes on.
    const finger = { identifier: 3, clientY: 0 };
    const other = { identifier: 4, clientY: 50 };
    dispatchTouches(thumb, 'touchstart', [finger], [finger]);
    dispatchTouches(document.body, 'touchstart', [finger, other], [other]);
    document.body.dispatchEvent(new Event('touchstart', { bubbles: true }));
    const moved = { ...finger, clientY: 40 };
    dispatchTouches(thumb, 'touchmove', [moved, other], [moved]);
    const whileListed = { ...state(), scrollTop: box.container.scrollTop };
    dispatchTouches(thumb, 'touchend', [other], [finger]);
    const afterOwnEnd = state();

    // The finger's touchend never arrived (a window capture blocker, such as
    // the session reset's, swallowed it): the next touch no longer lists it.
    const lost = { identifier: 1, clientY: 0 };
    dispatchTouches(thumb, 'touchstart', [lost], [lost]);
    const lostAtPress = state();
    const next = { identifier: 2, clientY: 50 };
    dispatchTouches(document.body, 'touchstart', [next], [next]);
    const strayMove = { ...lost, clientY: 80 };
    dispatchTouches(thumb, 'touchmove', [strayMove], [strayMove]);
    const afterLoss = { ...state(), scrollTop: box.container.scrollTop };

    // A mouse drag names no finger, so a touch elsewhere leaves it alone.
    thumb.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }),
    );
    const touch = { identifier: 5, clientY: 50 };
    dispatchTouches(document.body, 'touchstart', [touch], [touch]);
    const mouseDragThroughTouch = state();
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    const afterMouseUp = state();

    // Chromium on Android and Windows can number touches from 0 again, so the
    // next touch may carry a lost finger's identifier. A contact that a
    // touchstart adds is new: the lost finger's drag goes, and a finger that
    // lands on the thumb drags from its own press.
    box.container.scrollTop = 100;
    const reused = { identifier: 0, clientY: 0 };
    dispatchTouches(thumb, 'touchstart', [reused], [reused]);
    const elsewhere = { identifier: 0, clientY: 50 };
    dispatchTouches(document.body, 'touchstart', [elsewhere], [elsewhere]);
    const afterReuseElsewhere = state();
    dispatchTouches(document.body, 'touchend', [], [elsewhere]);
    dispatchTouches(thumb, 'touchstart', [reused], [reused]);
    const draggedDown = { ...reused, clientY: 100 };
    dispatchTouches(thumb, 'touchmove', [draggedDown], [draggedDown]);
    // That finger's touchend is lost too, and the next lands on the thumb where
    // the drag left it (600 of 800 puts the thumb 120 to 160 px down the bar).
    const onThumb = { identifier: 0, clientY: 140 };
    dispatchTouches(thumb, 'touchstart', [onThumb], [onThumb]);
    const nudged = { ...onThumb, clientY: 150 };
    dispatchTouches(thumb, 'touchmove', [nudged], [nudged]);
    const reuseOnThumb = { ...state(), scrollTop: box.container.scrollTop };
    dispatchTouches(thumb, 'touchend', [], [nudged]);

    expect({
      whileListed,
      afterOwnEnd,
      lostAtPress,
      afterLoss,
      mouseDragThroughTouch,
      afterMouseUp,
      afterReuseElsewhere,
      reuseOnThumb,
      afterReuseLifts: state(),
    }).toEqual({
      whileListed: { dragging: true, held: true, scrollTop: 300 },
      afterOwnEnd: { dragging: false, held: false },
      lostAtPress: { dragging: true, held: true },
      afterLoss: { dragging: false, held: false, scrollTop: 300 },
      mouseDragThroughTouch: { dragging: true, held: true },
      afterMouseUp: { dragging: false, held: false },
      afterReuseElsewhere: { dragging: false, held: false },
      // 10 px down from its own press at 600; the lost press would give 850.
      reuseOnThumb: { dragging: true, held: true, scrollTop: 650 },
      afterReuseLifts: { dragging: false, held: false },
    });
  });

  it('turns the hold into overflow hidden in the safety layer, which no inline overflow outranks', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const declarations: string[] = [];
    parseCss(stylesheet).walkAtRules('layer', (layer) => {
      if (layer.params !== 'safety') return;
      layer.each((node) => {
        if (node.type !== 'rule' || !node.selectors.includes(`[${HELD_ATTRIBUTE}]`)) return;
        node.walkDecls((declaration) => {
          declarations.push(
            `${declaration.prop}: ${declaration.value}${declaration.important ? ' !important' : ''}`,
          );
        });
      });
    });
    // Important declarations take the layers in reverse, so the first layer's
    // rule outranks every stylesheet overflow and every inline value without
    // !important. Both axes: iOS drops an element's native scroller, and with
    // it the glide, only once no axis of the element can be scrolled by hand.
    expect(declarations).toEqual(['overflow: hidden !important']);

    // Only an inline important overflow would outrank the rule. No app code
    // writes one.
    const files = (await readdir('src', { recursive: true }))
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => /\.m?ts$/u.test(file) && !file.includes('__tests__/'));
    expect(files.length).toBeGreaterThan(100);
    const sources = await Promise.all(
      files.map(async (file) => ({ file, source: await readFile(`src/${file}`, 'utf8') })),
    );
    expect(
      sources
        .filter(({ source }) =>
          /setProperty\(\s*['"`]overflow(?:-[xy])?['"`][^)]*['"`]important['"`]/u.test(source),
        )
        .map(({ file }) => file),
    ).toEqual([]);
  });

  it.each<PressEnd>(['mouseup', 'blur', 'destroy'])(
    'holds its scroller still from a mouse press on the empty part of the bar until that press ends by %s',
    (end) => {
      const box = createScrollbox(`bar-hold-mouse-${end}`);
      initCustomScrollbar(box.container);
      box.container.scrollTop = 100;
      const track = box.track();
      track.getBoundingClientRect = () => makeRect(200);

      track.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 150 }),
      );
      // The press still jumps the list to the point pressed.
      const atPress = { held: isHeld(box.container), scrollTop: box.container.scrollTop };
      endPress(end, box, track, { identifier: 1, clientY: 150 });

      expect({
        atPress,
        heldAfterEnd: isHeld(box.container),
        overflowY: box.container.style.overflowY,
      }).toEqual({
        atPress: { held: true, scrollTop: 600 },
        heldAfterEnd: false,
        overflowY: 'auto',
      });
    },
  );

  it.each<PressEnd>(['touchend', 'touchcancel', 'touchcancel without touches', 'blur', 'destroy'])(
    'holds its scroller still from a finger on the empty part of the bar until that touch ends by %s',
    (end) => {
      const box = createScrollbox(`bar-hold-touch-${end.replaceAll(' ', '-')}`);
      initCustomScrollbar(box.container);
      box.container.scrollTop = 100;
      const track = box.track();
      track.getBoundingClientRect = () => makeRect(200);
      const finger = { identifier: 1, clientY: 150 };

      const start = dispatchTouches(track, 'touchstart', [finger], [finger]);
      // The touch is not cancelled and does not jump the list itself: the
      // tap's mousedown, which the browser sends after it, still does.
      const atPress = {
        held: isHeld(box.container),
        scrollTop: box.container.scrollTop,
        prevented: start.defaultPrevented,
      };
      endPress(end, box, track, finger);

      expect({
        atPress,
        heldAfterEnd: isHeld(box.container),
        overflowY: box.container.style.overflowY,
      }).toEqual({
        atPress: { held: true, scrollTop: 100, prevented: false },
        heldAfterEnd: false,
        overflowY: 'auto',
      });
    },
  );

  it('keeps a finger hold on the bar through another finger, and lets go when its own finger lifts or is lost, even under a reused identifier', () => {
    const box = createScrollbox('bar-hold-fingers');
    initCustomScrollbar(box.container);
    const track = box.track();
    const held: boolean[] = [];
    const note = (): void => {
      held.push(isHeld(box.container));
    };

    // Another finger lands on the list and lifts while the bar's finger stays.
    const finger = { identifier: 1, clientY: 150 };
    const other = { identifier: 2, clientY: 50 };
    dispatchTouches(track, 'touchstart', [finger], [finger]);
    note();
    dispatchTouches(box.container, 'touchstart', [finger, other], [other]);
    note();
    dispatchTouches(box.container, 'touchend', [finger], [other]);
    note();
    dispatchTouches(track, 'touchend', [], [finger]);
    note();

    // The bar finger's touchend never arrived: the next touch no longer lists it.
    const lost = { identifier: 3, clientY: 150 };
    dispatchTouches(track, 'touchstart', [lost], [lost]);
    note();
    const next = { identifier: 4, clientY: 50 };
    dispatchTouches(box.container, 'touchstart', [next], [next]);
    note();
    dispatchTouches(box.container, 'touchend', [], [next]);

    // Chromium on Android and Windows can give the next touch the lost
    // finger's identifier, which that touchstart adds as a new contact.
    const reused = { identifier: 0, clientY: 150 };
    dispatchTouches(track, 'touchstart', [reused], [reused]);
    note();
    const reusing = { identifier: 0, clientY: 50 };
    dispatchTouches(box.container, 'touchstart', [reusing], [reusing]);
    note();

    expect(held).toEqual([true, true, true, false, true, false, true, false]);
  });

  it('holds while the thumb drag or a press on the empty part of the bar lasts, whichever ends first', () => {
    const box = createScrollbox('drag-and-bar-press');
    initCustomScrollbar(box.container);
    const track = box.track();
    track.getBoundingClientRect = () => makeRect(200);
    const thumb = track.querySelector<HTMLElement>('.cscroll-thumb')!;
    const held: boolean[] = [];
    const note = (): void => {
      held.push(isHeld(box.container));
    };
    const mouseDown = (target: HTMLElement, clientY: number): void => {
      target.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY }),
      );
    };
    const mouseUp = (): void => {
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    };
    const onThumb = { identifier: 1, clientY: 0 };
    const onBar = { identifier: 2, clientY: 150 };

    // A finger drags the thumb, and another presses the bar and lifts first.
    dispatchTouches(thumb, 'touchstart', [onThumb], [onThumb]);
    dispatchTouches(track, 'touchstart', [onThumb, onBar], [onBar]);
    note();
    dispatchTouches(track, 'touchend', [onThumb], [onBar]);
    note();
    dispatchTouches(thumb, 'touchend', [], [onThumb]);
    note();

    // A finger presses the bar, and another drags the thumb and lifts first.
    dispatchTouches(track, 'touchstart', [onBar], [onBar]);
    dispatchTouches(thumb, 'touchstart', [onBar, onThumb], [onThumb]);
    note();
    dispatchTouches(thumb, 'touchend', [onBar], [onThumb]);
    note();
    dispatchTouches(track, 'touchend', [], [onBar]);
    note();

    // On a hybrid device: a mouse click on the bar during a finger's thumb
    // drag, then a finger on the bar during a mouse thumb drag.
    dispatchTouches(thumb, 'touchstart', [onThumb], [onThumb]);
    mouseDown(track, 150);
    mouseUp();
    note();
    dispatchTouches(thumb, 'touchend', [], [onThumb]);
    note();
    mouseDown(thumb, 0);
    dispatchTouches(track, 'touchstart', [onBar], [onBar]);
    dispatchTouches(track, 'touchend', [], [onBar]);
    note();
    mouseUp();
    note();

    expect(held).toEqual([true, true, false, true, true, false, true, false, true, false]);
  });

  it('hands no wheel to a scroller its pressed bar holds, and hands the wheel over again once the press ends', () => {
    const box = createScrollbox('held-wheel');
    initCustomScrollbar(box.container);
    box.container.scrollTop = 100;
    const track = box.track();
    track.getBoundingClientRect = () => makeRect(200);
    const thumb = track.querySelector<HTMLElement>('.cscroll-thumb')!;
    // Touchpad momentum from a flick that began over the bar keeps arriving at
    // the bar while it is pressed, over its track or its thumb.
    const wheel = (target: HTMLElement): { moved: number; prevented: boolean } => {
      const before = box.container.scrollTop;
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 50 });
      target.dispatchEvent(event);
      return { moved: box.container.scrollTop - before, prevented: event.defaultPrevented };
    };
    const wheelOverBar = (): Array<{ moved: number; prevented: boolean }> => [
      wheel(track),
      wheel(thumb),
    ];

    thumb.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }),
    );
    const duringThumbDrag = wheelOverBar();
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    track.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 150 }),
    );
    const duringBarPress = wheelOverBar();
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    const finger = { identifier: 1, clientY: 150 };
    dispatchTouches(track, 'touchstart', [finger], [finger]);
    const duringBarFinger = wheelOverBar();
    dispatchTouches(track, 'touchend', [], [finger]);
    const afterRelease = wheelOverBar();

    // Each wheel stays the bar's, so it scrolls nothing behind the bar either.
    const handedNone = { moved: 0, prevented: true };
    const handedOver = { moved: 50, prevented: true };
    expect({ duringThumbDrag, duringBarPress, duringBarFinger, afterRelease }).toEqual({
      duringThumbDrag: [handedNone, handedNone],
      duringBarPress: [handedNone, handedNone],
      duringBarFinger: [handedNone, handedNone],
      afterRelease: [handedOver, handedOver],
    });
  });
});

describe('custom-scrollbar settled re-layout (orientation/breakpoint)', () => {
  it('converts rendered track offsets and thumb drag distance at 1.5x', () => {
    document.body.style.setProperty('--desktop-ui-scale', '1.5');
    const box = createScrollbox('scaled-box');
    box.container.parentElement!.getBoundingClientRect = () => makeRect(600, 120);
    box.rectSpy.mockImplementation(() => makeRect(300, 300));

    initCustomScrollbar(box.container);
    const track = box.track();
    const thumb = track.querySelector<HTMLElement>('.cscroll-thumb')!;
    expect(track.style.top).toBe('120px');
    expect(track.style.height).toBe('200px');

    thumb.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 300 }),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 360 }));

    // 60 rendered px = 40 local px. With a 160px thumb travel and 800px
    // scroll range, the drag advances exactly 200 logical scroll pixels.
    expect(box.container.scrollTop).toBe(200);
  });

  it('re-lays out ALL live instances after one orientation change, on both settle tiers', () => {
    const a = createScrollbox('box-a');
    const b = createScrollbox('box-b');
    initCustomScrollbar(a.container);
    initCustomScrollbar(b.container);
    expect(a.track().style.height).toBe('200px');
    expect(b.track().style.height).toBe('200px');

    a.setClientHeight(300);
    b.setClientHeight(320);
    fireMqlChange(ORIENTATION_QUERY);

    // Before the fast tier fires nothing re-measures (CSS still settling).
    vi.advanceTimersByTime(349);
    expect(a.track().style.height).toBe('200px');
    expect(b.track().style.height).toBe('200px');

    // Fast tier (350ms): EVERY instance re-measures, not just the
    // last-registered one; instance `a` must not remain stale here.
    vi.advanceTimersByTime(1);
    expect(a.track().style.height).toBe('300px');
    expect(b.track().style.height).toBe('320px');

    // Slow tier (700ms) re-measures again for late-settling transitions.
    a.setClientHeight(310);
    vi.advanceTimersByTime(350);
    expect(a.track().style.height).toBe('310px');
  });

  it('coalesces rapid orientation flips into one re-layout per tier per instance', () => {
    const a = createScrollbox('box-a');
    const b = createScrollbox('box-b');
    initCustomScrollbar(a.container);
    initCustomScrollbar(b.container);
    a.rectSpy.mockClear();
    b.rectSpy.mockClear();

    fireMqlChange(ORIENTATION_QUERY);
    vi.advanceTimersByTime(100);
    fireMqlChange(ORIENTATION_QUERY); // replaces both pending tiers (debounce)

    vi.advanceTimersByTime(800); // past both tiers measured from second fire
    // One fast + one slow pass each — not 2 fires x 2 tiers.
    expect(a.rectSpy).toHaveBeenCalledTimes(2);
    expect(b.rectSpy).toHaveBeenCalledTimes(2);
  });

  it('skips instances destroyed inside the settle window, still re-lays out survivors', () => {
    const a = createScrollbox('box-a');
    const b = createScrollbox('box-b');
    initCustomScrollbar(a.container);
    initCustomScrollbar(b.container);
    fireMqlChange(ORIENTATION_QUERY);
    a.rectSpy.mockClear();
    b.rectSpy.mockClear();

    // Realistic case: dialog teardown during the 350/700ms window. The
    // relayout must iterate the live registry at fire time — a snapshot
    // captured at debounce registration would touch A's removed track.
    destroyCustomScrollbar(a.container);
    vi.advanceTimersByTime(700);

    expect(a.rectSpy).not.toHaveBeenCalled();
    expect(b.rectSpy).toHaveBeenCalledTimes(2);
  });

  it('includes instances initialized after the global listeners were bound (dynamic language list)', () => {
    const a = createScrollbox('box-a');
    initCustomScrollbar(a.container); // listeners are bound on first init
    const late = createScrollbox('box-late');
    initCustomScrollbar(late.container);

    late.setClientHeight(260);
    fireMqlChange(ORIENTATION_QUERY);
    vi.advanceTimersByTime(700);
    expect(late.track().style.height).toBe('260px');
  });

  it('compact-landscape breakpoint changes also trigger the settled re-layout', () => {
    const a = createScrollbox('box-a');
    initCustomScrollbar(a.container);

    a.setClientHeight(280);
    fireMqlChange(COMPACT_LAYOUT_QUERY);
    vi.advanceTimersByTime(350);
    expect(a.track().style.height).toBe('280px');
  });

  it('short-desktop header changes also trigger the settled re-layout', () => {
    const a = createScrollbox('box-a');
    initCustomScrollbar(a.container);

    a.setClientHeight(300);
    fireMqlChange(SHORT_DESKTOP_LAYOUT_QUERY);
    vi.advanceTimersByTime(350);
    expect(a.track().style.height).toBe('300px');
  });
});

describe('custom-scrollbar compositor hot path', () => {
  it('hands normal scrolling to one stable ScrollTimeline and uses script only for drag', async () => {
    const originalTimeline = Object.getOwnPropertyDescriptor(globalThis, 'ScrollTimeline');
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const animations: Array<{ cancel: Mock; timeline: unknown }> = [];
    const animate = vi.fn(
      (
        _keyframes: Keyframe[] | PropertyIndexedKeyframes,
        options?: number | KeyframeAnimationOptions,
      ) => {
        const animation = {
          cancel: vi.fn(),
          ready: Promise.resolve(),
          timeline: typeof options === 'object' ? options.timeline : null,
        };
        animations.push(animation);
        return animation as unknown as Animation;
      },
    );

    Object.defineProperty(globalThis, 'ScrollTimeline', {
      configurable: true,
      value: class ScrollTimelineStub {},
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });

    try {
      const box = createScrollbox('timeline-hot-path');
      initCustomScrollbar(box.container);
      const track = box.track();
      const thumb = track.querySelector<HTMLElement>('.cscroll-thumb')!;
      const visual = thumb.querySelector<HTMLElement>('.cscroll-thumb-visual')!;

      expect(track.dataset.scrollDriver).toBe('timeline');
      expect(animate).toHaveBeenCalledTimes(1);
      const visualMutations: MutationRecord[] = [];
      const visualObserver = new MutationObserver((records) => visualMutations.push(...records));
      visualObserver.observe(visual, { attributes: true, attributeFilter: ['style'] });

      box.container.scrollTop = 100;
      box.container.dispatchEvent(new Event('scroll'));
      flushAnimationFrame(); // session-start intrinsic layout refresh
      expect(track.dataset.scrollDriver).toBe('timeline');
      expect(animate).toHaveBeenCalledTimes(1); // unchanged geometry keeps the same timeline
      expect(thumb.style.transform).toBe('translateY(0px)'); // no JS scroll write
      flushAnimationFrame();
      flushAnimationFrame();
      flushAnimationFrame();
      await flushMutationObservers();
      expect(visualMutations).toHaveLength(0); // neutral probe is a cache hit
      expect(_rafCallbacks.size).toBe(0); // one bounded pump; no duplicate rAF chain
      visualObserver.disconnect();

      thumb.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 0 }),
      );
      expect(track.dataset.scrollDriver).toBe('script');
      expect(animations[0].cancel).toHaveBeenCalledOnce();
      expect(thumb.style.transform).toBe('translateY(20px)');

      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(track.dataset.scrollDriver).toBe('timeline');
      expect(animate).toHaveBeenCalledTimes(2);

      // A faded track's first scroll queues an intrinsic layout refresh. If
      // the user grabs the freshly revealed thumb in that same task, the
      // queued rAF must not restore ScrollTimeline beneath the held gesture.
      vi.advanceTimersByTime(1_200);
      expect(track.style.pointerEvents).toBe('none');
      box.container.dispatchEvent(new Event('scroll'));
      thumb.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 0 }),
      );
      expect(track.dataset.scrollDriver).toBe('script');
      flushAnimationFrame();
      expect(track.dataset.scrollDriver).toBe('script');
      expect(animate).toHaveBeenCalledTimes(2);

      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(track.dataset.scrollDriver).toBe('timeline');
      expect(animate).toHaveBeenCalledTimes(3);

      destroyCustomScrollbar(box.container);
      expect(animations[2].cancel).toHaveBeenCalledOnce();
    } finally {
      if (originalTimeline) Object.defineProperty(globalThis, 'ScrollTimeline', originalTimeline);
      else Reflect.deleteProperty(globalThis, 'ScrollTimeline');
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

  it('keeps timeline sampling alive through normal movement and delayed endpoint overscroll', () => {
    const originalTimeline = Object.getOwnPropertyDescriptor(globalThis, 'ScrollTimeline');
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(globalThis, 'ScrollTimeline', {
      configurable: true,
      value: class ScrollTimelineStub {},
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(
        (
          _keyframes: Keyframe[] | PropertyIndexedKeyframes,
          options?: number | KeyframeAnimationOptions,
        ) =>
          ({
            cancel: vi.fn(),
            ready: Promise.resolve(),
            timeline: typeof options === 'object' ? options.timeline : null,
          }) as unknown as Animation,
      ),
    });

    try {
      const box = createScrollbox('timeline-endpoint-tail');
      initCustomScrollbar(box.container);
      const visual = box.track().querySelector<HTMLElement>('.cscroll-thumb-visual')!;
      const base = performance.now();

      box.container.scrollTop = 100;
      box.container.dispatchEvent(new Event('scroll'));
      flushAnimationFrame(base + 16);

      // The compositor can publish a new raw offset before the next main-thread
      // scroll event. That movement itself keeps the sampler active.
      box.container.scrollTop = 200;
      flushAnimationFrame(base + 32);
      expect(_rafCallbacks.size).toBe(1);

      box.container.scrollTop = 800;
      box.container.dispatchEvent(new Event('scroll'));
      expect(readVisualTransform(visual)).toEqual({ translateY: 0, scaleY: 1 });

      // Four quiet frames exceed the ordinary three-frame budget. The 150ms
      // endpoint tail must still be running when iOS exposes overscroll late.
      flushAnimationFrame(base + 48);
      flushAnimationFrame(base + 64);
      flushAnimationFrame(base + 80);
      flushAnimationFrame(base + 96);
      expect(_rafCallbacks.size).toBe(1);

      box.container.scrollTop = 820;
      flushAnimationFrame(base + 112);
      expect(readVisualTransform(visual)).toEqual({ translateY: 4, scaleY: 0.9 });
      expect(_rafCallbacks.size).toBe(1);
    } finally {
      if (originalTimeline) Object.defineProperty(globalThis, 'ScrollTimeline', originalTimeline);
      else Reflect.deleteProperty(globalThis, 'ScrollTimeline');
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

  it('keeps timeline thumb height normal when relayout happens during rubber-band offsets, and compresses it by script only while the size changes', async () => {
    const originalTimeline = Object.getOwnPropertyDescriptor(globalThis, 'ScrollTimeline');
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const animate = vi.fn(
      (
        _keyframes: Keyframe[] | PropertyIndexedKeyframes,
        options?: number | KeyframeAnimationOptions,
      ) =>
        ({
          cancel: vi.fn(),
          ready: Promise.resolve(),
          timeline: typeof options === 'object' ? options.timeline : null,
        }) as unknown as Animation,
    );
    Object.defineProperty(globalThis, 'ScrollTimeline', {
      configurable: true,
      value: class ScrollTimelineStub {},
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });

    try {
      const box = createScrollbox('timeline-rubber-band-relayout');
      initCustomScrollbar(box.container);
      const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
      const visual = thumb.querySelector<HTMLElement>('.cscroll-thumb-visual')!;

      expect(animate).toHaveBeenCalledTimes(1);
      expect(thumb.style.height).toBe('40px');
      expect(visual.style.height).toBe('');
      expect(readVisualTransform(visual)).toEqual({ translateY: 0, scaleY: 1 });

      // Ordinary endpoint elasticity changes only the nested visual. The
      // browser-owned outer position/height and its timeline stay untouched.
      const outerMutations: MutationRecord[] = [];
      const observer = new MutationObserver((records) => outerMutations.push(...records));
      observer.observe(thumb, { attributes: true, attributeFilter: ['style'] });

      box.container.scrollTop = -20;
      box.container.dispatchEvent(new Event('scroll'));
      // Timeline mode samples in the scroll callback, avoiding an extra rAF of
      // visible endpoint delay while leaving the outer thumb browser-owned.
      expect(readVisualTransform(visual)).toEqual({ translateY: 0, scaleY: 0.9 });
      flushAnimationFrame();
      expect(box.track().dataset.scrollDriver).toBe('timeline');
      expect(animate).toHaveBeenCalledTimes(1);
      expect(thumb.style.height).toBe('40px');
      expect(thumb.style.transform).toBe('translateY(0px)');
      expect(visual.style.height).toBe('');
      expect(readVisualTransform(visual)).toEqual({ translateY: 0, scaleY: 0.9 });

      box.container.scrollTop = 820;
      box.container.dispatchEvent(new Event('scroll'));
      flushAnimationFrame();
      expect(animate).toHaveBeenCalledTimes(1);
      expect(thumb.style.height).toBe('40px');
      expect(visual.style.height).toBe('');
      expect(readVisualTransform(visual)).toEqual({ translateY: 4, scaleY: 0.9 });

      box.container.scrollTop = 400;
      box.container.dispatchEvent(new Event('scroll'));
      flushAnimationFrame();
      expect(visual.style.height).toBe('');
      expect(readVisualTransform(visual)).toEqual({ translateY: 0, scaleY: 1 });
      expect(animate).toHaveBeenCalledTimes(1);
      await flushMutationObservers();
      expect(outerMutations).toHaveLength(0);
      observer.disconnect();

      // A relayout that moves the endpoint is a size change: script places
      // the thumb, with the script driver's outer compression, until a whole
      // frame passes with no report. Then one timeline is built, its inline
      // state clamped like its 0%/100% endpoints, and only the nested visual
      // compresses again.
      box.container.scrollTop = -20;
      box.setClientHeight(220);
      notifyResize(box.container);
      expect(box.track().dataset.scrollDriver).toBe('script');
      expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(44, 5);
      expect(thumb.style.transform).toBe('translateY(0px)');
      expect(readVisualTransform(visual)).toEqual({ translateY: 0, scaleY: 1 });
      flushAnimationFrame(); // the frame that reported the change
      expect(box.track().dataset.scrollDriver).toBe('script');
      expect(animate).toHaveBeenCalledTimes(1);
      flushAnimationFrame(); // a whole frame with no report
      expect(box.track().dataset.scrollDriver).toBe('timeline');
      expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(48.4, 5);
      expect(thumb.style.transform).toBe('translateY(0px)');
      expect(visual.style.height).toBe('');
      expect(readVisualTransform(visual).translateY).toBe(0);
      expect(readVisualTransform(visual).scaleY).toBeCloseTo(44 / 48.4, 5);
      expect(animate).toHaveBeenCalledTimes(2);

      box.container.scrollTop = 900;
      box.setClientHeight(240);
      notifyResize(box.container);
      expect(box.track().dataset.scrollDriver).toBe('script');
      expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(24, 5);
      const scriptTop = /^translateY\(([-+\d.eE]+)px\)$/u.exec(thumb.style.transform)?.[1];
      expect(Number(scriptTop)).toBeCloseTo(216, 5);
      expect(readVisualTransform(visual)).toEqual({ translateY: 0, scaleY: 1 });
      flushAnimationFrame();
      flushAnimationFrame();
      expect(box.track().dataset.scrollDriver).toBe('timeline');
      expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(57.6, 5);
      expect(thumb.style.transform).toBe('translateY(182.4px)');
      expect(visual.style.height).toBe('');
      expect(readVisualTransform(visual).translateY).toBeCloseTo(33.6, 5);
      expect(readVisualTransform(visual).scaleY).toBeCloseTo(24 / 57.6, 5);
      // One timeline for each settled geometry, none for the frames between.
      expect(animate).toHaveBeenCalledTimes(3);
    } finally {
      if (originalTimeline) Object.defineProperty(globalThis, 'ScrollTimeline', originalTimeline);
      else Reflect.deleteProperty(globalThis, 'ScrollTimeline');
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

  it('falls back to the exact script position when timeline readiness rejects', async () => {
    const originalTimeline = Object.getOwnPropertyDescriptor(globalThis, 'ScrollTimeline');
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<Animation>((_resolve, reject) => {
      rejectReady = reject;
    });

    Object.defineProperty(globalThis, 'ScrollTimeline', {
      configurable: true,
      value: class ScrollTimelineStub {},
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(
        (
          _keyframes: Keyframe[] | PropertyIndexedKeyframes,
          options?: number | KeyframeAnimationOptions,
        ) =>
          ({
            cancel: vi.fn(),
            ready,
            timeline: typeof options === 'object' ? options.timeline : null,
          }) as unknown as Animation,
      ),
    });

    try {
      const box = createScrollbox('timeline-ready-rejection');
      initCustomScrollbar(box.container);
      box.container.scrollTop = 400;
      expect(box.track().dataset.scrollDriver).toBe('timeline');

      rejectReady(new Error('timeline could not become ready'));
      await flushMutationObservers();

      expect(box.track().dataset.scrollDriver).toBe('script');
      expect(box.track().querySelector<HTMLElement>('.cscroll-thumb')?.style.transform).toBe(
        'translateY(80px)',
      );
    } finally {
      if (originalTimeline) Object.defineProperty(globalThis, 'ScrollTimeline', originalTimeline);
      else Reflect.deleteProperty(globalThis, 'ScrollTimeline');
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

  it('samples compositor scroll positions without re-reading layout geometry', () => {
    const box = createScrollbox('hot-path');
    const computedStyleSpy = vi.spyOn(globalThis, 'getComputedStyle');
    initCustomScrollbar(box.container);

    // Prime the one-per-session intrinsic-size refresh, then measure the
    // sustained scroll path while the track is already active.
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    flushAnimationFrame();
    flushAnimationFrame();
    flushAnimationFrame();

    box.rectSpy.mockClear();
    box.scrollHeightSpy.mockClear();
    box.clientHeightSpy.mockClear();
    computedStyleSpy.mockClear();

    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    box.container.scrollTop = 100;
    box.container.dispatchEvent(new Event('scroll'));

    // The event handler reveals from cache and schedules the sampler. It does
    // not synchronously pull async scrolling back through style/layout.
    expect(computedStyleSpy).not.toHaveBeenCalled();
    expect(box.rectSpy).not.toHaveBeenCalled();
    expect(box.scrollHeightSpy).not.toHaveBeenCalled();
    expect(box.clientHeightSpy).not.toHaveBeenCalled();

    flushAnimationFrame();
    expect(thumb.style.height).toBe('40px');
    expect(thumb.style.transform).toBe('translateY(20px)');
    expect(computedStyleSpy).not.toHaveBeenCalled();
    expect(box.rectSpy).not.toHaveBeenCalled();
    expect(box.scrollHeightSpy).not.toHaveBeenCalled();
    expect(box.clientHeightSpy).not.toHaveBeenCalled();

    // iOS can advance the native scroller between main-thread scroll events.
    // The short active pump must sample that exact position on the next frame.
    box.container.scrollTop = 200;
    flushAnimationFrame();
    expect(thumb.style.transform).toBe('translateY(40px)');

    flushAnimationFrame();
    flushAnimationFrame();
    flushAnimationFrame();
    expect(_rafCallbacks.size).toBe(0);
    computedStyleSpy.mockRestore();
  });

  it('keeps exactly one fade timer while rapid scroll events extend its deadline', () => {
    const box = createScrollbox('fade-budget');
    initCustomScrollbar(box.container);

    for (let i = 0; i < 100; i += 1) box.container.dispatchEvent(new Event('scroll'));
    expect(box.track().style.opacity).toBe('1');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    box.container.dispatchEvent(new Event('scroll'));
    expect(vi.getTimerCount()).toBe(1);

    // The original timer wakes once, observes the extended deadline, and
    // re-arms a single bounded timer instead of one timer per scroll event.
    vi.advanceTimersByTime(200);
    expect(box.track().style.opacity).toBe('1');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(box.track().style.opacity).toBe('0');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes thumb height only for rubber-band compression and restoration', async () => {
    const box = createScrollbox('rubber-band');
    initCustomScrollbar(box.container);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    const visual = thumb.querySelector<HTMLElement>('.cscroll-thumb-visual')!;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(thumb, { attributes: true, attributeFilter: ['style'] });

    box.container.scrollTop = 100;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    await flushMutationObservers();
    expect(mutations).toHaveLength(1); // transform only
    expect(thumb.style.height).toBe('40px');

    mutations.length = 0;
    box.container.scrollTop = -20;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    await flushMutationObservers();
    expect(mutations).toHaveLength(2); // compressed height + clamped transform
    expect(Number.parseFloat(thumb.style.height)).toBeLessThan(40);
    expect(visual.style.height).toBe('');
    expect(visual.style.transform).toBe('translateY(0px) scaleY(1)');

    mutations.length = 0;
    box.container.scrollTop = 0;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    await flushMutationObservers();
    expect(mutations).toHaveLength(1); // height restoration; top was already zero
    expect(thumb.style.height).toBe('40px');
    observer.disconnect();
  });

  it('tracks exact positions without adding easing or EMA under reduced motion', () => {
    _mqlMatches.set('(prefers-reduced-motion: reduce)', true);
    const box = createScrollbox('reduced-motion');
    initCustomScrollbar(box.container);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;

    box.container.scrollTop = 600;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();

    expect(thumb.style.transform).toBe('translateY(120px)');
  });

  it('refreshes stale intrinsic overflow once when a new scroll session starts', () => {
    const box = createScrollbox('intrinsic-overflow');
    box.setScrollHeight(200);
    initCustomScrollbar(box.container);
    expect(box.track().style.opacity).toBe('0');

    // Simulate content that grows with no mutation record and no resize the
    // bar watches: text directly in the container, rewrapped by a late font.
    box.setScrollHeight(1000);
    box.container.scrollTop = 400;
    box.container.dispatchEvent(new Event('scroll'));
    expect(box.track().style.opacity).toBe('0');

    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('1');
    expect(box.track().querySelector<HTMLElement>('.cscroll-thumb')?.style.transform).toBe(
      'translateY(80px)',
    );
  });
});

describe('custom-scrollbar optional overflow gutter', () => {
  it('adds a gutter only for visible overflow and clears it when content fits or is hidden', () => {
    const box = createScrollbox('overflow-gutter');
    box.container.setAttribute('data-custom-scroll-gutter', '');
    box.setScrollHeight(200);
    initCustomScrollbar(box.container);
    expect(box.container.classList.contains('has-scroll-overflow')).toBe(false);

    box.setScrollHeight(202);
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    expect(box.container.classList.contains('has-scroll-overflow')).toBe(false);

    box.setScrollHeight(203);
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    expect(box.container.classList.contains('has-scroll-overflow')).toBe(true);

    box.setScrollHeight(200);
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    expect(box.container.classList.contains('has-scroll-overflow')).toBe(false);

    box.setScrollHeight(1000);
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    expect(box.container.classList.contains('has-scroll-overflow')).toBe(true);
    box.container.style.visibility = 'hidden';
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    expect(box.container.classList.contains('has-scroll-overflow')).toBe(false);

    box.container.style.visibility = 'visible';
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    expect(box.container.classList.contains('has-scroll-overflow')).toBe(true);
    destroyCustomScrollbar(box.container);
    expect(box.container.classList.contains('has-scroll-overflow')).toBe(false);
  });

  it('measures gutter-induced wrapping immediately and settles its own class mutation', async () => {
    const box = createScrollbox('gutter-wrapping');
    box.container.setAttribute('data-custom-scroll-gutter', '');
    box.scrollHeightSpy.mockImplementation(() =>
      box.container.classList.contains('has-scroll-overflow') ? 500 : 300,
    );
    initCustomScrollbar(box.container);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    expect(thumb.style.height).toBe('80px');

    // The class and its ResizeObserver notification coalesce into one extra
    // measurement, then stop. Rewriting it every frame would never settle.
    notifyResize(box.container);
    await flushMutationObservers();
    expect(_rafCallbacks.size).toBe(1);
    flushAnimationFrame();
    await flushMutationObservers();
    expect(box.rectSpy).toHaveBeenCalledTimes(2);
    expect(_rafCallbacks.size).toBe(0);

    box.container.scrollTop = 150;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    expect(thumb.style.transform).toBe('translateY(60px)');
  });

  it.each([false, true])(
    'leaves a non-opted-in container class unchanged when initially %s',
    (initialClass) => {
      const box = createScrollbox('no-gutter');
      box.container.classList.toggle('has-scroll-overflow', initialClass);
      initCustomScrollbar(box.container);
      expect(box.container.classList.contains('has-scroll-overflow')).toBe(initialClass);
      box.setScrollHeight(200);
      bus.emit('ui:scrollbar-relayout');
      flushAnimationFrame();
      expect(box.container.classList.contains('has-scroll-overflow')).toBe(initialClass);
      destroyCustomScrollbar(box.container);
      expect(box.container.classList.contains('has-scroll-overflow')).toBe(initialClass);
    },
  );
});

describe('custom-scrollbar relayout isolation', () => {
  it('does not let a nested thumb transform wake the outer scrollbar layout', async () => {
    const outer = createScrollbox('outer');
    const inner = createScrollbox('inner', outer.container);
    initCustomScrollbar(outer.container);
    initCustomScrollbar(inner.container);

    await flushMutationObservers();
    flushAnimationFrame();
    outer.rectSpy.mockClear();

    inner.container.scrollTop = 100;
    inner.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    await flushMutationObservers();
    flushAnimationFrame();

    expect(inner.track().querySelector<HTMLElement>('.cscroll-thumb')?.style.transform).toBe(
      'translateY(20px)',
    );
    expect(outer.rectSpy).not.toHaveBeenCalled();
  });

  it('ignores seek range paint progress while retaining layout-affecting mutations', async () => {
    const box = createScrollbox('seek-owner');
    const seek = document.createElement('input');
    seek.type = 'range';
    box.container.appendChild(seek);
    initCustomScrollbar(box.container);
    box.rectSpy.mockClear();

    for (let progress = 0; progress <= 100; progress += 10) {
      seek.style.setProperty('--range-progress', `${progress}%`);
    }
    await flushMutationObservers();
    flushAnimationFrame();
    expect(box.rectSpy).not.toHaveBeenCalled();

    seek.classList.add('layout-affecting-state');
    box.container.append(document.createElement('div'), document.createElement('div'));
    bus.emit('ui:scrollbar-relayout');
    await flushMutationObservers();

    // The mutation records and the bus converge on one frame.
    expect(box.rectSpy).not.toHaveBeenCalled();
    expect(_rafCallbacks.size).toBe(1);
    flushAnimationFrame();
    expect(box.rectSpy).toHaveBeenCalledTimes(1);

    // A resize report comes after the frame's layout, so the bar lays out in
    // it, from that clean layout, and asks for no frame.
    notifyResize(box.container);
    expect(box.rectSpy).toHaveBeenCalledTimes(2);
    expect(_rafCallbacks.size).toBe(0);
  });

  it('cancels queued layout, scroll and fade work on destroy', async () => {
    const box = createScrollbox('destroy-pending');
    initCustomScrollbar(box.container);
    box.container.appendChild(document.createElement('div'));
    box.container.dispatchEvent(new Event('scroll'));
    await flushMutationObservers();
    expect(_rafCallbacks.size).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(1);

    box.rectSpy.mockClear();
    destroyCustomScrollbar(box.container);
    flushAnimationFrame();
    vi.advanceTimersByTime(1200);

    expect(box.rectSpy).not.toHaveBeenCalled();
    expect(_rafCallbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('custom-scrollbar content that changes size inside its container', () => {
  // A container's own box stays put while its content grows or shrinks inside
  // it: a Settings collapsible area's grid-rows transition, a hidden toggle, a
  // late font or image. No mutation marks the frames in between, so the bar's
  // one resize observer also watches the container's direct element children,
  // and the bar lays itself out in the report of each frame in which one
  // changes size. The browser reports a child's new box after a frame's
  // animation frame callbacks and layout, before its paint; these rows stand
  // in for that with notifyResize after flushAnimationFrame. Their containers
  // are 400 px tall, so a thumb is 160000 / scrollHeight px long: 160 at 1000,
  // 128 at 1250, 100 at 1600 and 80 at 2000.

  /** An element child, named so a row can list what is watched. */
  function named(name: string): HTMLElement {
    const element = document.createElement('div');
    element.dataset.name = name;
    return element;
  }

  /** A 400 px tall scrollbox whose content is one panel holding `content`. */
  function createPanelScrollbox(
    id: string,
    ...content: HTMLElement[]
  ): { box: Scrollbox; panel: HTMLElement } {
    const box = createScrollbox(id);
    box.setClientHeight(400);
    const panel = named('panel');
    panel.append(...content);
    box.container.appendChild(panel);
    return { box, panel };
  }

  /** The thumb's length and offset as the bar last wrote them, in px. */
  function readThumb(box: Scrollbox): { length: number; top: number } {
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    const top = /^translateY\(([-+\d.eE]+)px\)$/u.exec(thumb.style.transform)?.[1];
    return { length: Number.parseFloat(thumb.style.height), top: Number(top) };
  }

  /**
   * Counts each container's layouts by its bar's one style read of it.
   * Rect reads cannot tell nested bars apart: an inner bar's layout also
   * reads its parent's rect, which is the outer container.
   */
  function countLayouts(...containers: HTMLElement[]): {
    read(): number[];
    restore(): void;
  } {
    const styleSpy = vi.spyOn(globalThis, 'getComputedStyle');
    return {
      read: (): number[] =>
        containers.map(
          (container) => styleSpy.mock.calls.filter(([element]) => element === container).length,
        ),
      restore: (): void => styleSpy.mockRestore(),
    };
  }

  /** The names of the named elements any observer watches, sorted. */
  function watchedNames(): string[] {
    return [..._resizeObservations.keys()]
      .flatMap((target) =>
        target instanceof HTMLElement && target.dataset.name ? [target.dataset.name] : [],
      )
      .sort();
  }

  /**
   * A working ScrollTimeline and animate, as in the compositor rows. Each
   * animation keeps its end keyframe and its cancel.
   */
  function installScrollTimeline(): {
    animations: Array<{ end: string; cancel: Mock }>;
    restore(): void;
  } {
    const originalTimeline = Object.getOwnPropertyDescriptor(globalThis, 'ScrollTimeline');
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const animations: Array<{ end: string; cancel: Mock }> = [];
    Object.defineProperty(globalThis, 'ScrollTimeline', {
      configurable: true,
      value: class ScrollTimelineStub {},
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: (keyframes: Keyframe[], options?: number | KeyframeAnimationOptions): Animation => {
        const cancel = vi.fn();
        animations.push({ end: String(keyframes.at(-1)?.transform), cancel });
        return {
          cancel,
          ready: Promise.resolve(),
          timeline: typeof options === 'object' ? options.timeline : null,
        } as unknown as Animation;
      },
    });
    return {
      animations,
      restore: (): void => {
        if (originalTimeline) {
          Object.defineProperty(globalThis, 'ScrollTimeline', originalTimeline);
        } else {
          Reflect.deleteProperty(globalThis, 'ScrollTimeline');
        }
        if (originalAnimate) {
          Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, 'animate');
        }
      },
    };
  }

  it('follows a child that grows or shrinks frame by frame with no mutation, and never moves against it', async () => {
    const area = named('area');
    area.className = 'collapsed';
    const { box, panel } = createPanelScrollbox('child-follows', area);
    box.container.scrollTop = 300;
    initCustomScrollbar(box.container);
    const frames = [readThumb(box)];
    const frame = (scrollHeight: number): void => {
      box.setScrollHeight(scrollHeight);
      notifyResize(panel);
      flushAnimationFrame();
      frames.push(readThumb(box));
    };

    // The class change lays the bar out in the transition's first frame,
    // which still has the closed height; the frames after it open the area.
    area.classList.remove('collapsed');
    await flushMutationObservers();
    flushAnimationFrame();
    frames.push(readThumb(box));
    [1250, 1600, 2000].forEach(frame);
    // Closing, the first frame still has the open height.
    area.classList.add('collapsed');
    await flushMutationObservers();
    flushAnimationFrame();
    frames.push(readThumb(box));
    [1600, 1250, 1000].forEach(frame);

    // The thumb shortens while the list gets longer and lengthens while it
    // gets shorter, and its offset keeps showing the same scroll position as
    // the range changes. Held at each change's first frame, it kept its
    // closed length through the open and then shortened as the list closed.
    expect(frames).toEqual([
      { length: 160, top: 120 },
      { length: 160, top: 120 },
      { length: 128, top: 96 },
      { length: 100, top: 75 },
      { length: 80, top: 60 },
      { length: 80, top: 60 },
      { length: 100, top: 75 },
      { length: 128, top: 96 },
      { length: 160, top: 120 },
    ]);
  });

  it('watches element children added later, lets removed or replaced ones go, and leaves text and grandchildren alone', async () => {
    const box = createScrollbox('child-bookkeeping');
    const [a, b, c, d, e, h, i] = ['a', 'b', 'c', 'd', 'e', 'h', 'i'].map(named);
    box.container.appendChild(a);
    initCustomScrollbar(box.container);
    const steps: Record<string, string[]> = { init: watchedNames() };
    const settle = async (step: string): Promise<void> => {
      await flushMutationObservers();
      steps[step] = watchedNames();
    };

    box.container.append(b, c);
    await settle('append');
    b.remove();
    await settle('remove');
    box.container.replaceChildren(d, e);
    await settle('replaceChildren');
    box.container.innerHTML = '<p data-name="f"></p><p data-name="g"></p>';
    await settle('innerHTML');
    const f = box.container.querySelector<HTMLElement>('[data-name="f"]')!;
    const g = box.container.querySelector<HTMLElement>('[data-name="g"]')!;
    box.container.appendChild(f);
    await settle('move inside');
    box.container.appendChild(h);
    h.remove();
    await settle('add and remove in one batch');
    g.appendChild(i);
    box.container.appendChild(document.createTextNode('text'));
    await settle('grandchild and text');
    g.appendChild(f);
    await settle('child moved into a sibling');
    const boxes = {
      container: watchedBoxes(box.container),
      g: watchedBoxes(g),
    };

    // A child that left reports nothing to the bar; one that stays lays it out.
    flushAnimationFrame();
    box.rectSpy.mockClear();
    [b, d, f].forEach(notifyResize);
    const framesFromGone = _rafCallbacks.size;
    notifyResize(g);
    flushAnimationFrame();

    expect({ steps, boxes, framesFromGone, layouts: box.rectSpy.mock.calls.length }).toEqual({
      steps: {
        init: ['a'],
        append: ['a', 'b', 'c'],
        remove: ['a', 'c'],
        replaceChildren: ['d', 'e'],
        innerHTML: ['f', 'g'],
        'move inside': ['f', 'g'],
        'add and remove in one batch': ['f', 'g'],
        'grandchild and text': ['f', 'g'],
        'child moved into a sibling': ['g'],
      },
      // The container's content box, so the gutter's padding counts; a
      // child's border box, so its own padding does.
      boxes: { container: ['content-box'], g: ['border-box'] },
      framesFromGone: 0,
      layouts: 1,
    });
  });

  it.each(['outer first', 'inner first'] as const)(
    'watches an inner scroll container as content of the outer one, but never its bar (%s)',
    async (order) => {
      const outer = createScrollbox(`content-outer-${order.replace(' ', '-')}`);
      const inner = createScrollbox(
        `content-inner-${order.replace(' ', '-')}`,
        outer.container,
        false,
      );
      if (order === 'outer first') {
        initCustomScrollbar(outer.container);
        initCustomScrollbar(inner.container);
      } else {
        initCustomScrollbar(inner.container);
        initCustomScrollbar(outer.container);
      }
      await flushMutationObservers();
      flushAnimationFrame();
      await flushMutationObservers();
      const innerTrack = inner.track();
      const framesBefore = _rafCallbacks.size;
      const layouts = countLayouts(outer.container, inner.container);

      notifyResize(innerTrack);
      const fromBar = { layouts: layouts.read(), frames: _rafCallbacks.size };
      // Each bar lays itself out in its own report, and neither asks for a frame.
      notifyResize(inner.container);
      const fromContainer = { layouts: layouts.read(), frames: _rafCallbacks.size };
      layouts.restore();

      expect({
        trackInOuter: innerTrack.parentElement === outer.container,
        watched: {
          innerContainer: watchedBoxes(inner.container),
          innerTrack: watchedBoxes(innerTrack),
        },
        framesBefore,
        fromBar,
        fromContainer,
      }).toEqual({
        // The inner bar sits beside its container, directly in the outer one.
        trackInOuter: true,
        // The outer bar watches the inner container's border box as content,
        // its own bar its content box; neither watches the inner bar.
        watched: { innerContainer: ['border-box', 'content-box'], innerTrack: [] },
        framesBefore: 0,
        // Layouts of [outer, inner].
        fromBar: { layouts: [0, 0], frames: 0 },
        fromContainer: { layouts: [1, 1], frames: 0 },
      });
    },
  );

  it('lets every child go on destroy, and a container given a bar again watches the children it has then', async () => {
    const box = createScrollbox('children-reinit');
    const [first, late, second] = ['first', 'late', 'second'].map(named);
    box.container.appendChild(first);
    initCustomScrollbar(box.container);
    const atInit = watchedNames();
    // A child added in the teardown's own task, before its records arrive.
    box.container.appendChild(late);
    destroyCustomScrollbar(box.container);
    await flushMutationObservers();
    const afterDestroy = { container: watchedBoxes(box.container), children: watchedNames() };

    // The same container gets a bar again, as a reused reading dialog's
    // message does, with new content.
    box.container.replaceChildren(second);
    initCustomScrollbar(box.container);
    await flushMutationObservers();
    flushAnimationFrame();
    const afterInit = { container: watchedBoxes(box.container), children: watchedNames() };
    box.rectSpy.mockClear();
    notifyResize(second);
    flushAnimationFrame();

    expect({ atInit, afterDestroy, afterInit, layouts: box.rectSpy.mock.calls.length }).toEqual({
      atInit: ['first'],
      afterDestroy: { container: [], children: [] },
      afterInit: { container: ['content-box'], children: ['second'] },
      layouts: 1,
    });
  });

  it('measures again when a hidden toggle inside a child resizes it, which no record it listens for marks', async () => {
    const note = named('note');
    note.hidden = true;
    const { box, panel } = createPanelScrollbox('hidden-toggle', note);
    initCustomScrollbar(box.container);

    note.hidden = false;
    await flushMutationObservers();
    // The hidden attribute is not one of the attributes the bar listens for.
    const framesFromToggle = _rafCallbacks.size;
    box.setScrollHeight(1250);
    notifyResize(panel);
    flushAnimationFrame();

    expect({ framesFromToggle, thumb: readThumb(box) }).toEqual({
      framesFromToggle: 0,
      thumb: { length: 128, top: 0 },
    });
  });

  it('measures through the script driver while a thumb drag lasts, and hands back to the timeline once on release', () => {
    const timeline = installScrollTimeline();
    try {
      const { box, panel } = createPanelScrollbox('drag-child-resize');
      initCustomScrollbar(box.container);
      const track = box.track();
      const thumb = track.querySelector<HTMLElement>('.cscroll-thumb')!;
      const atInit = { driver: track.dataset.scrollDriver, animations: timeline.animations.length };

      thumb.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }),
      );
      box.setScrollHeight(2000);
      notifyResize(panel);
      flushAnimationFrame();
      const duringDrag = {
        driver: track.dataset.scrollDriver,
        length: thumb.style.height,
        animations: timeline.animations.length,
      };
      // The drag maps the pointer with the new length: 32 of the thumb's
      // 320 px of travel is a tenth of the 1600 px scroll range.
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 32 }));
      const scrollTop = box.container.scrollTop;
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));

      expect({
        atInit,
        duringDrag,
        scrollTop,
        afterRelease: {
          driver: track.dataset.scrollDriver,
          ends: timeline.animations.map(({ end }) => end),
        },
      }).toEqual({
        atInit: { driver: 'timeline', animations: 1 },
        duringDrag: { driver: 'script', length: '80px', animations: 1 },
        scrollTop: 160,
        afterRelease: { driver: 'timeline', ends: ['translateY(240px)', 'translateY(320px)'] },
      });
    } finally {
      timeline.restore();
    }
  });

  it('lays a held scroller out from a child resize and keeps it held', () => {
    const computedStyle = computeHeldScrollersHidden();
    try {
      const { box, panel } = createPanelScrollbox('held-child-resize');
      initCustomScrollbar(box.container);
      const track = box.track();
      track.getBoundingClientRect = () => makeRect(400);
      // The bar is shown, as it is whenever it can be pressed.
      bus.emit('ui:scrollbar-reveal');
      flushAnimationFrame();
      track.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }),
      );

      box.setScrollHeight(2000);
      notifyResize(panel);
      flushAnimationFrame();
      const duringPress = {
        held: isHeld(box.container),
        opacity: track.style.opacity,
        thumbDisplay: track.querySelector<HTMLElement>('.cscroll-thumb')!.style.display,
        thumb: readThumb(box),
      };
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));

      expect(duringPress).toEqual({
        held: true,
        opacity: '1',
        thumbDisplay: '',
        thumb: { length: 80, top: 0 },
      });
    } finally {
      computedStyle.mockRestore();
    }
  });

  /** The bar's driver, the thumb as the bar last wrote it, and how many animations it built. */
  function readBar(
    box: Scrollbox,
    timeline: { animations: unknown[] },
  ): { driver: string | undefined; length: string; position: string; animations: number } {
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    return {
      driver: box.track().dataset.scrollDriver,
      length: thumb.style.height,
      position: thumb.style.transform,
      animations: timeline.animations.length,
    };
  }

  /** One frame of a child resize: its animation frame callbacks, then the report. */
  function resizeFrame(box: Scrollbox, child: HTMLElement, scrollHeight: number): void {
    flushAnimationFrame();
    box.setScrollHeight(scrollHeight);
    notifyResize(child);
  }

  it('places the thumb by script while a child resizes, frame by frame, and builds one timeline for the settled geometry', () => {
    const timeline = installScrollTimeline();
    try {
      const { box, panel } = createPanelScrollbox('timeline-child-frames');
      box.container.scrollTop = 300;
      initCustomScrollbar(box.container);
      const atInit = readBar(box, timeline);
      const frames = [1250, 1600, 2000].map((scrollHeight) => {
        resizeFrame(box, panel, scrollHeight);
        return readBar(box, timeline);
      });
      // The next frame's check finds the last report; the one after finds none.
      flushAnimationFrame();
      const quietFrame = readBar(box, timeline);
      flushAnimationFrame();
      const settled = readBar(box, timeline);

      expect({
        atInit,
        frames,
        quietFrame,
        settled,
        ends: timeline.animations.map(({ end }) => end),
        cancels: timeline.animations.map(({ cancel }) => cancel.mock.calls.length),
        framesLeft: _rafCallbacks.size,
      }).toEqual({
        atInit: {
          driver: 'timeline',
          length: '160px',
          position: 'translateY(120px)',
          animations: 1,
        },
        // Every frame of the change shows the length and the offset its own
        // layout calls for, with no animation built, pending or restarted.
        frames: [
          { driver: 'script', length: '128px', position: 'translateY(96px)', animations: 1 },
          { driver: 'script', length: '100px', position: 'translateY(75px)', animations: 1 },
          { driver: 'script', length: '80px', position: 'translateY(60px)', animations: 1 },
        ],
        quietFrame: {
          driver: 'script',
          length: '80px',
          position: 'translateY(60px)',
          animations: 1,
        },
        // The new animation starts pending over the same seeded offset.
        settled: {
          driver: 'timeline',
          length: '80px',
          position: 'translateY(60px)',
          animations: 2,
        },
        ends: ['translateY(240px)', 'translateY(320px)'],
        // The running animation is cancelled once, at the change's first frame.
        cancels: [1, 0],
        framesLeft: 0,
      });
    } finally {
      timeline.restore();
    }
  });

  it('keeps the script driver while a child still reports size changes that leave the range where it was', () => {
    const timeline = installScrollTimeline();
    try {
      const { box, panel } = createPanelScrollbox('timeline-child-rests');
      initCustomScrollbar(box.container);
      resizeFrame(box, panel, 1250);
      // The scroll range moves in whole pixels, so it can rest for a frame or
      // two while the content still grows by fractions of one.
      const resting = [1250, 1250, 1250].map((scrollHeight) => {
        resizeFrame(box, panel, scrollHeight);
        return readBar(box, timeline);
      });
      flushAnimationFrame();
      const quietFrame = readBar(box, timeline);
      flushAnimationFrame();

      expect({ resting, quietFrame, settled: readBar(box, timeline) }).toEqual({
        resting: Array.from({ length: 3 }, () => ({
          driver: 'script',
          length: '128px',
          position: 'translateY(0px)',
          animations: 1,
        })),
        quietFrame: {
          driver: 'script',
          length: '128px',
          position: 'translateY(0px)',
          animations: 1,
        },
        settled: {
          driver: 'timeline',
          length: '128px',
          position: 'translateY(0px)',
          animations: 2,
        },
      });
    } finally {
      timeline.restore();
    }
  });

  it('lays the bar out inside a resize report and asks for no frame, while a bar that manages its gutter keeps the next frame', async () => {
    const { box, panel } = createPanelScrollbox('report-layout');
    const gutter = createPanelScrollbox('report-layout-gutter');
    gutter.box.container.setAttribute('data-custom-scroll-gutter', '');
    initCustomScrollbar(box.container);
    initCustomScrollbar(gutter.box.container);
    // The gutter class written at init has a record of its own.
    await flushMutationObservers();
    flushAnimationFrame();
    await flushMutationObservers();
    box.rectSpy.mockClear();
    gutter.box.rectSpy.mockClear();

    box.setScrollHeight(1250);
    notifyResize(panel);
    const plain = {
      layouts: box.rectSpy.mock.calls.length,
      frames: _rafCallbacks.size,
      thumb: readThumb(box),
    };
    gutter.box.setScrollHeight(1250);
    notifyResize(gutter.panel);
    const gutterReport = {
      layouts: gutter.box.rectSpy.mock.calls.length,
      frames: _rafCallbacks.size,
    };
    flushAnimationFrame();

    expect({
      plain,
      gutterReport,
      gutterFrame: { layouts: gutter.box.rectSpy.mock.calls.length, thumb: readThumb(gutter.box) },
    }).toEqual({
      plain: { layouts: 1, frames: 0, thumb: { length: 128, top: 0 } },
      gutterReport: { layouts: 0, frames: 1 },
      gutterFrame: { layouts: 1, thumb: { length: 128, top: 0 } },
    });
  });

  it('requests no frame for a child resize where the engine has no ScrollTimeline', () => {
    const { box, panel } = createPanelScrollbox('no-timeline-child-frames');
    box.container.scrollTop = 300;
    initCustomScrollbar(box.container);
    const frames = [1250, 1600, 2000].map((scrollHeight) => {
      resizeFrame(box, panel, scrollHeight);
      return {
        driver: box.track().dataset.scrollDriver,
        thumb: readThumb(box),
        frames: _rafCallbacks.size,
      };
    });

    expect(frames).toEqual([
      { driver: 'script', thumb: { length: 128, top: 96 }, frames: 0 },
      { driver: 'script', thumb: { length: 100, top: 75 }, frames: 0 },
      { driver: 'script', thumb: { length: 80, top: 60 }, frames: 0 },
    ]);
  });

  it('reads the scroll offset once per layout, before it writes the thumb', () => {
    const timeline = installScrollTimeline();
    try {
      const { box, panel } = createPanelScrollbox('one-offset-read');
      box.container.scrollTop = 300;
      initCustomScrollbar(box.container);
      const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
      // In a browser a read after a write lays the thumb out again first, so
      // each read records the length the thumb had then.
      const lengthsAtRead: string[] = [];
      Object.defineProperty(box.container, 'scrollTop', {
        configurable: true,
        get: (): number => {
          lengthsAtRead.push(thumb.style.height);
          return 300;
        },
      });

      // A layout that changes the length under the running timeline.
      box.setScrollHeight(1250);
      notifyResize(panel);
      flushAnimationFrame();
      const resizeLayout = [...lengthsAtRead];
      // The layout that builds the timeline for the settled geometry.
      flushAnimationFrame();

      expect({
        resizeLayout,
        buildLayout: lengthsAtRead.slice(resizeLayout.length),
        settled: readBar(box, timeline),
      }).toEqual({
        resizeLayout: ['160px'],
        buildLayout: ['128px'],
        settled: {
          driver: 'timeline',
          length: '128px',
          position: 'translateY(96px)',
          animations: 2,
        },
      });
    } finally {
      timeline.restore();
    }
  });

  it('builds no timeline when a thumb drag ends while a child resizes, and builds one once the size settles', () => {
    const timeline = installScrollTimeline();
    try {
      const { box, panel } = createPanelScrollbox('drag-ends-in-resize');
      initCustomScrollbar(box.container);
      const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
      resizeFrame(box, panel, 1250);
      thumb.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }),
      );
      resizeFrame(box, panel, 1600);
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      const released = readBar(box, timeline);
      flushAnimationFrame();
      const quietFrame = readBar(box, timeline);
      flushAnimationFrame();

      expect({
        released,
        quietFrame,
        settled: readBar(box, timeline),
        ends: timeline.animations.map(({ end }) => end),
      }).toEqual({
        released: { driver: 'script', length: '100px', position: 'translateY(0px)', animations: 1 },
        quietFrame: {
          driver: 'script',
          length: '100px',
          position: 'translateY(0px)',
          animations: 1,
        },
        settled: {
          driver: 'timeline',
          length: '100px',
          position: 'translateY(0px)',
          animations: 2,
        },
        ends: ['translateY(240px)', 'translateY(300px)'],
      });
    } finally {
      timeline.restore();
    }
  });

  it('cancels the resize-end check when the bar is destroyed while a child resizes', () => {
    const timeline = installScrollTimeline();
    try {
      const { box, panel } = createPanelScrollbox('destroy-in-resize');
      initCustomScrollbar(box.container);
      resizeFrame(box, panel, 1250);
      const during = { ...readBar(box, timeline), frames: _rafCallbacks.size };
      destroyCustomScrollbar(box.container);
      const framesAfterDestroy = _rafCallbacks.size;
      flushAnimationFrame();
      flushAnimationFrame();

      expect({ during, framesAfterDestroy, animations: timeline.animations.length }).toEqual({
        during: {
          driver: 'script',
          length: '128px',
          position: 'translateY(0px)',
          animations: 1,
          frames: 1,
        },
        framesAfterDestroy: 0,
        animations: 1,
      });
    } finally {
      timeline.restore();
    }
  });

  it('drops a resize it follows once the content stops overflowing, and builds the timeline at once when it overflows again', () => {
    const timeline = installScrollTimeline();
    try {
      const { box, panel } = createPanelScrollbox('resize-without-overflow');
      initCustomScrollbar(box.container);
      resizeFrame(box, panel, 1250);
      resizeFrame(box, panel, 300);
      const fitted = { ...readBar(box, timeline), frames: _rafCallbacks.size };
      box.setScrollHeight(2000);
      notifyResize(panel);

      expect({
        fitted,
        overflowing: readBar(box, timeline),
        ends: timeline.animations.map(({ end }) => end),
      }).toEqual({
        // The bar has nothing to show and no check left to run.
        fitted: {
          driver: 'script',
          length: '128px',
          position: 'translateY(0px)',
          animations: 1,
          frames: 0,
        },
        overflowing: {
          driver: 'timeline',
          length: '80px',
          position: 'translateY(0px)',
          animations: 2,
        },
        ends: ['translateY(240px)', 'translateY(320px)'],
      });
    } finally {
      timeline.restore();
    }
  });

  it('settles a gutter class change in one extra layout when a child reports the rewrap too', async () => {
    const box = createScrollbox('gutter-child');
    box.container.setAttribute('data-custom-scroll-gutter', '');
    const child = named('child');
    box.container.appendChild(child);
    box.scrollHeightSpy.mockImplementation(() =>
      box.container.classList.contains('has-scroll-overflow') ? 500 : 300,
    );
    initCustomScrollbar(box.container);

    // The gutter's padding narrows the container and rewraps its child, so
    // both report a resize. With the class's own record they make one more
    // measurement, which writes nothing, and then the bar rests.
    notifyResize(box.container);
    notifyResize(child);
    await flushMutationObservers();
    const pending = _rafCallbacks.size;
    flushAnimationFrame();
    await flushMutationObservers();

    expect({
      pending,
      layouts: box.rectSpy.mock.calls.length,
      left: _rafCallbacks.size,
      gutter: box.container.classList.contains('has-scroll-overflow'),
    }).toEqual({ pending: 1, layouts: 2, left: 0, gutter: true });
  });
});

describe('custom-scrollbar transition reveal', () => {
  it('reveals only overflowing instances in the requested surface, then fades', () => {
    const scoped = createScrollbox('scoped-overflow');
    const background = createScrollbox('background-overflow');
    initCustomScrollbar(scoped.container);
    initCustomScrollbar(background.container);

    expect(scoped.track().style.opacity).toBe('0');
    expect(background.track().style.opacity).toBe('0');

    bus.emit('ui:scrollbar-reveal', scoped.container.parentElement!);

    expect(scoped.track().style.opacity).toBe('1');
    expect(scoped.track().style.pointerEvents).toBe('auto');
    expect(background.track().style.opacity).toBe('0');
    expect(background.track().style.pointerEvents).toBe('none');
    // The coalesced geometry refresh must not reveal a known-live surface a
    // second time and silently extend its fade deadline by one frame.
    vi.advanceTimersByTime(16);
    flushAnimationFrame();
    vi.advanceTimersByTime(1183);
    expect(scoped.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(scoped.track().style.opacity).toBe('0');
    expect(scoped.track().style.pointerEvents).toBe('none');
  });

  it('does not reveal a non-overflowing or zero-height parked instance', () => {
    const fitted = createScrollbox('fitted');
    fitted.setScrollHeight(200);
    const rounded = createScrollbox('rounded');
    rounded.setScrollHeight(202);
    const parked = createScrollbox('parked');
    parked.setClientHeight(0);
    initCustomScrollbar(fitted.container);
    initCustomScrollbar(rounded.container);
    initCustomScrollbar(parked.container);

    bus.emit('ui:scrollbar-reveal');

    for (const box of [fitted, rounded, parked]) {
      expect(box.track().style.opacity).toBe('0');
      expect(box.track().style.height).toBe('0px');
      expect(box.track().style.pointerEvents).toBe('none');
      expect(box.track().querySelector<HTMLElement>('.cscroll-thumb')?.style.display).toBe('none');
    }
  });

  it('reveals only a user-scrollable owner beyond the rounding tolerance', () => {
    const hiddenOuter = createScrollbox('hidden-outer');
    hiddenOuter.container.style.overflowY = 'hidden';
    const meaningful = createScrollbox('meaningful-overflow');
    meaningful.setScrollHeight(203);
    initCustomScrollbar(hiddenOuter.container);
    initCustomScrollbar(meaningful.container);

    bus.emit('ui:scrollbar-reveal');

    expect(hiddenOuter.track().style.opacity).toBe('0');
    expect(hiddenOuter.track().style.height).toBe('0px');
    expect(meaningful.track().style.opacity).toBe('1');
    expect(meaningful.track().style.height).toBe('200px');
  });

  it('does not reveal an overflowing surface hidden by an ancestor transition state', () => {
    const hidden = createScrollbox('visibility-hidden');
    hidden.container.style.visibility = 'hidden';
    initCustomScrollbar(hidden.container);

    bus.emit('ui:scrollbar-reveal', hidden.container.parentElement!);

    expect(hidden.track().style.opacity).toBe('0');
    expect(hidden.track().style.height).toBe('0px');
    expect(hidden.track().style.pointerEvents).toBe('none');
  });

  it('re-measures and reveals a dialog list initialized while hidden', () => {
    const dialogList = createScrollbox('hidden-dialog-list');
    dialogList.setClientHeight(0);
    initCustomScrollbar(dialogList.container);
    expect(dialogList.track().style.height).toBe('0px');

    dialogList.setClientHeight(180);
    bus.emit('ui:scrollbar-reveal', dialogList.container.parentElement!);
    flushAnimationFrame();

    expect(dialogList.track().style.height).toBe('180px');
    expect(dialogList.track().style.opacity).toBe('1');
    expect(dialogList.track().querySelector<HTMLElement>('.cscroll-thumb')?.style.display).toBe('');
  });
});

describe('compact-landscape scrollbar ownership contract', () => {
  it('gives the administrator permission toggle region a contained custom scrollbar', async () => {
    const [markup, stylesheet] = await Promise.all([
      readFile('index.html', 'utf8'),
      readFile('css/style.css', 'utf8'),
    ]);
    expect(markup).toMatch(
      /class="administrator-permissions-list"\s+data-custom-scroll\s+data-custom-scroll-contained/,
    );
    expect(stylesheet).toMatch(
      /\.administrator-permissions-dialog\s*>\s*\.cscroll-track\s*{[^}]*right:\s*24px;/s,
    );
  });

  it('applies the sidebar inset only to viewport-owned tracks', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const compactRules: string[] = [];
    parseCss(stylesheet).walkAtRules('media', (rule) => {
      if (rule.params === COMPACT_LAYOUT_QUERY) {
        compactRules.push(rule.toString());
      }
    });
    expect(compactRules.length).toBeGreaterThan(0);
    const compactStyles = compactRules.join('\n');

    expect(compactStyles).toMatch(
      /body\s*>\s*\.cscroll-track\s*\{[^}]*right:\s*calc\(200px \+ var\(--safe-physical-right\)\)\s*;/s,
    );
    expect(compactStyles).not.toMatch(
      /(?:^|})\s*\.cscroll-track\s*\{[^}]*right:\s*calc\(200px \+ var\(--safe-(?:physical-)?right\)\)\s*;/s,
    );
  });

  it('positions only a static parent, leaving one that its stylesheet positions alone', () => {
    const sheet = document.createElement('style');
    sheet.textContent = '.stylesheet-positioned { position: relative; }';
    document.head.appendChild(sheet);
    try {
      const unpositioned = createScrollbox('static-parent');
      const positioned = createScrollbox('stylesheet-positioned-parent');
      const positionedParent = positioned.container.parentElement!;
      positionedParent.className = 'stylesheet-positioned';

      initCustomScrollbar(unpositioned.container);
      initCustomScrollbar(positioned.container);

      // The track is positioned against the parent, so a static one is pinned
      // inline. That inline value then outranks every later stylesheet position.
      expect(unpositioned.container.parentElement!.style.position).toBe('relative');
      expect(positionedParent.style.position).toBe('');
    } finally {
      sheet.remove();
    }
  });

  it('positions every tab pane in the stylesheet before the scrollbar adopts it', async () => {
    const [markup, stylesheet] = await Promise.all([
      readFile('index.html', 'utf8'),
      readFile('css/style.css', 'utf8'),
    ]);
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const panes = [...parsed.querySelectorAll<HTMLElement>('.tab-content')];
    expect(panes.map((pane) => pane.id)).toEqual([
      'tab-play',
      'tab-playlist',
      'tab-connect',
      'tab-guide',
      'tab-settings',
    ]);
    // Four panes are hidden when the scrollbar adopts their scroll bodies, so
    // only a rule that does not depend on `.active` positions them by then.
    expect(
      panes.filter((pane) => pane.classList.contains('active')).map((pane) => pane.id),
    ).toEqual(['tab-play']);
    for (const pane of panes) {
      expect(
        pane.querySelector(':scope > .tab-body[data-custom-scroll]'),
        `#${pane.id} scroll body`,
      ).not.toBeNull();
    }

    const root = parseCss(stylesheet);
    const basePositions: string[] = [];
    root.walkAtRules('layer', (layer) => {
      if (layer.params !== 'base') return;
      layer.each((node) => {
        if (node.type !== 'rule' || node.selector !== '.tab-content') return;
        node.walkDecls('position', (declaration) => {
          basePositions.push(declaration.value);
        });
      });
    });
    expect(basePositions).toEqual(['relative']);

    // A pane pinned inline to `relative` would keep filling the page while the
    // compact layout's safe-area inset moved it past the bottom edge.
    const compactRules: string[] = [];
    root.walkAtRules('media', (rule) => {
      if (rule.params === COMPACT_LAYOUT_QUERY) compactRules.push(rule.toString());
    });
    const compactPane =
      compactRules.join('\n').match(/\n\s*\.tab-content\.active\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(compactPane).toMatch(/position:\s*fixed;/);
    expect(compactPane).toMatch(/top:\s*var\(--safe-top\);/);
    // The pane reaches the bottom edge of the screen; the bottom inset is end
    // padding and scroll padding instead.
    expect(compactPane).toMatch(
      /height:\s*calc\(var\(--app-height, 100dvh\) - var\(--safe-top\)\);/,
    );
    expect(compactPane).toMatch(/scroll-padding-bottom:\s*var\(--safe-bottom\);/);
  });

  it('does not style the setup scrollbar as an onboarding content section', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toMatch(
      /\.onboarding-card\s*>\s*div:not\(\.ob-actions\):not\(\.cscroll-track\)\s*\{/,
    );
    expect(stylesheet).toMatch(
      /\.setup-mobile-view\s*>\s*div:not\(\.ob-actions\):not\(\.setup-header-pill\):not\(\.cscroll-track\)\s*\{/,
    );
  });

  it('attaches discovery scrollbars to each real setup and dialog scroll owner', async () => {
    const [markup, stylesheet, desktopStylesheet] = await Promise.all([
      readFile('index.html', 'utf8'),
      readFile('css/style.css', 'utf8'),
      readFile('css/desktop.css', 'utf8'),
    ]);
    const parsed = new DOMParser().parseFromString(markup, 'text/html');

    for (const id of [
      'setup-welcome-area',
      'setup-code-area',
      'setup-join-area',
      'setup-auto-join-area',
      'setup-role-area',
      'account-dialog-content',
    ]) {
      const owner = parsed.getElementById(id);
      expect(owner, `missing #${id}`).not.toBeNull();
      expect(owner?.hasAttribute('data-custom-scroll'), `#${id} custom scroll`).toBe(true);
      expect(owner?.hasAttribute('data-custom-scroll-contained'), `#${id} contained track`).toBe(
        true,
      );
    }

    const mediaList = parsed.querySelector(
      '#media-source-overlay > .setup-card > .setup-slot-list',
    );
    expect(mediaList?.hasAttribute('data-custom-scroll')).toBe(true);
    expect(mediaList?.hasAttribute('data-custom-scroll-contained')).toBe(true);
    expect(stylesheet).toMatch(
      /#media-source-overlay\s+\.setup-slot-list\s*\{[^}]*align-self:\s*stretch\s*;[^}]*overflow-y:\s*auto\s*;/s,
    );
    expect(stylesheet).not.toMatch(
      /#media-source-overlay\s+\.setup-slot-list\s*\{[^}]*flex:\s*1(?:\s|;)/s,
    );
    expect(stylesheet).toMatch(
      /#media-source-overlay\s+\.setup-slot-list\s*\{[^}]*flex:\s*0\s+1\s+auto;[^}]*min-height:\s*0;[^}]*padding-block:\s*6px;[^}]*scroll-padding-block:\s*6px;[^}]*overflow-y:\s*auto;/s,
    );
    expect(stylesheet).toMatch(
      /#media-source-overlay\s+\.setup-slot-list\s*>\s*\.file-select-btn\s*\{[^}]*flex-shrink:\s*0;[^}]*margin-top:\s*0;/s,
    );
    expect(desktopStylesheet).toMatch(
      /#media-source-overlay\s+\.setup-card\.full-screen\s*>\s*div:not\(\.ob-actions\):not\(\.cscroll-track\)/,
    );
    expect(desktopStylesheet).toMatch(
      /#media-source-overlay\s+\.setup-card\.full-screen\s*>\s*\.setup-slot-list\s*\{[^}]*flex-shrink:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
    );
    const youtubeForm = parsed.querySelector(
      '#youtube-url-overlay > .setup-card > .setup-join-area',
    );
    expect(youtubeForm?.hasAttribute('data-custom-scroll')).toBe(true);
    expect(youtubeForm?.hasAttribute('data-custom-scroll-contained')).toBe(true);
  });

  it('keeps media-source hover and focus visuals inside their scrollport', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');

    expect(stylesheet).toMatch(
      /#media-source-overlay\s+\.setup-slot-list\s*\{[^}]*padding-block:\s*6px;[^}]*scroll-padding-block:\s*6px;/s,
    );
    expect(stylesheet).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*#media-source-overlay\s+\.file-select-btn:hover\s*\{[^}]*transform:\s*none;/s,
    );
  });
});

describe('custom-scrollbar pointer hover reveal and drag visuals', () => {
  // jsdom has no hit testing, so each test states what the browser reports:
  // the bar under a hover pointer (`:hover`), the one hover gate, which
  // hover-pointer.ts turns on for a mouse or pen and off for a touch press (a
  // mouse user here), and whether the window has focus.
  const hovered = new Set<Element>();
  let windowFocused = true;

  beforeEach(() => {
    hovered.clear();
    windowFocused = true;
    document.documentElement.setAttribute('data-hover-pointer', '');
    const nativeMatches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selectors: string,
    ): boolean {
      return selectors === ':hover' ? hovered.has(this) : nativeMatches.call(this, selectors);
    });
    vi.spyOn(document, 'hasFocus').mockImplementation(() => windowFocused);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-hover-pointer');
  });

  function dispatchPointer(
    target: EventTarget,
    type: 'pointerover' | 'pointermove' | 'pointerenter' | 'pointerleave',
    options: {
      pointerType?: string;
      pointerId?: number;
      clientX?: number;
      clientY?: number;
      relatedTarget?: EventTarget | null;
      bubbles?: boolean;
    } = {},
  ): void {
    const bubbles = options.bubbles ?? (type === 'pointerover' || type === 'pointermove');
    const event = new Event(type, { bubbles, cancelable: true });
    Object.defineProperties(event, {
      pointerType: { value: options.pointerType ?? 'mouse' },
      pointerId: { value: options.pointerId ?? 1 },
      clientX: { value: options.clientX ?? 0 },
      clientY: { value: options.clientY ?? 0 },
      relatedTarget: { value: options.relatedTarget ?? null },
    });
    target.dispatchEvent(event);
  }

  function dispatchTouch(
    thumb: HTMLElement,
    type: 'touchstart' | 'touchend',
    touches: Array<{ identifier: number; clientY: number }>,
    changedTouches: Array<{ identifier: number; clientY: number }>,
  ): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: touches },
      changedTouches: { value: changedTouches },
    });
    thumb.dispatchEvent(event);
  }

  /** A mouse comes over the content; the bar shows once a frame has measured it. */
  function revealByHover(box: Scrollbox, clientX = 50, clientY = 50): void {
    dispatchPointer(box.container, 'pointerover', { pointerType: 'mouse', clientX, clientY });
    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('1');
  }

  /** A pointer comes onto the bar: the browser hovers it and sends the boundary events. */
  function enterBar(box: Scrollbox, pointerType = 'mouse', pointerId = 1): void {
    const track = box.track();
    // A hidden bar lets the pointer through, so only a shown bar can be entered.
    expect(track.style.pointerEvents).toBe('auto');
    hovered.add(track);
    dispatchPointer(track, 'pointerover', { pointerType, pointerId, relatedTarget: box.container });
    dispatchPointer(track, 'pointerenter', { pointerType, pointerId });
  }

  function leaveBar(box: Scrollbox, pointerType = 'mouse', pointerId = 1): void {
    hovered.delete(box.track());
    dispatchPointer(box.track(), 'pointerleave', { pointerType, pointerId });
  }

  it('reveals an overflowing scrollbar on mouse/pen enter and movement, then fades when still', () => {
    const box = createScrollbox('hover-reveal');
    initCustomScrollbar(box.container);

    expect(box.track().style.opacity).toBe('0');
    expect(box.track().style.pointerEvents).toBe('none');

    // Entering with a hover pointer reveals the track at default thumb opacity
    // (0.2 via CSS), once a frame has measured it.
    dispatchPointer(box.container, 'pointerover', {
      pointerType: 'mouse',
      clientX: 40,
      clientY: 50,
    });
    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('1');
    expect(box.track().style.pointerEvents).toBe('auto');

    // Moving before the fade deadline keeps it visible and extends the deadline.
    vi.advanceTimersByTime(1000);
    dispatchPointer(box.container, 'pointermove', {
      pointerType: 'mouse',
      clientX: 44,
      clientY: 52,
    });
    vi.advanceTimersByTime(1199);
    expect(box.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(box.track().style.opacity).toBe('0');
    expect(box.track().style.pointerEvents).toBe('none');

    // A duplicate stationary pointermove at the exact same point must not wake it.
    dispatchPointer(box.container, 'pointermove', {
      pointerType: 'mouse',
      clientX: 44,
      clientY: 52,
    });
    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('0');

    // Moving to a new coordinate wakes it again (including pen input).
    dispatchPointer(box.container, 'pointermove', {
      pointerType: 'pen',
      clientX: 45,
      clientY: 52,
    });
    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('1');
    expect(box.track().style.pointerEvents).toBe('auto');

    // Re-entering is a pointerover, which reveals even at the last move's coordinates.
    vi.advanceTimersByTime(1200);
    expect(box.track().style.opacity).toBe('0');
    dispatchPointer(box.container, 'pointerleave', { pointerType: 'pen' });
    dispatchPointer(box.container, 'pointerover', {
      pointerType: 'pen',
      clientX: 45,
      clientY: 52,
    });
    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('1');
  });

  it('ignores touch on the content and a touch press on the bar, and never measures fitted content', () => {
    const overflowing = createScrollbox('touch-ignored');
    const fitted = createScrollbox('fitted-ignored');
    fitted.setScrollHeight(200);
    initCustomScrollbar(overflowing.container);
    initCustomScrollbar(fitted.container);
    fitted.rectSpy.mockClear();

    dispatchPointer(overflowing.container, 'pointerover', {
      pointerType: 'touch',
      clientX: 20,
      clientY: 20,
    });
    dispatchPointer(overflowing.container, 'pointermove', {
      pointerType: 'touch',
      clientX: 25,
      clientY: 30,
    });
    flushAnimationFrame();
    expect(overflowing.track().style.opacity).toBe('0');

    // A tap on a shown bar leaves :hover latched on it, but the touch press
    // turns the one hover gate off, so the bar fades on time.
    revealByHover(overflowing, 40, 40);
    document.documentElement.removeAttribute('data-hover-pointer');
    enterBar(overflowing, 'touch', 2);
    vi.advanceTimersByTime(1199);
    expect(overflowing.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(overflowing.track().style.opacity).toBe('0');

    dispatchPointer(fitted.container, 'pointerover', {
      pointerType: 'mouse',
      clientX: 20,
      clientY: 20,
    });
    dispatchPointer(fitted.container, 'pointermove', {
      pointerType: 'mouse',
      clientX: 30,
      clientY: 30,
    });
    flushAnimationFrame();
    expect(fitted.track().style.opacity).toBe('0');
    expect(fitted.rectSpy).not.toHaveBeenCalled();
  });

  it('keeps the track visible while hovered and resumes fade on leave or blur', () => {
    const box = createScrollbox('track-hover-hold');
    initCustomScrollbar(box.container);

    revealByHover(box);
    dispatchPointer(box.container, 'pointerleave', {
      pointerType: 'mouse',
      relatedTarget: box.track(),
    });
    enterBar(box);

    // Even well past FADE_DELAY and across wheel scrolls, track hover holds visibility.
    vi.advanceTimersByTime(5000);
    expect(box.track().style.opacity).toBe('1');
    box.container.scrollTop = 120;
    box.container.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(5000);
    expect(box.track().style.opacity).toBe('1');

    // Leaving the track resumes the normal 1.2s fade.
    leaveBar(box);
    vi.advanceTimersByTime(1199);
    expect(box.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(box.track().style.opacity).toBe('0');

    // Window blur also releases a held track hover so alt-tab never pins it open.
    revealByHover(box, 52, 50);
    enterBar(box);
    windowFocused = false;
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(1200);
    expect(box.track().style.opacity).toBe('0');
  });

  it('respects track hover state when a thumb drag finishes', () => {
    const box = createScrollbox('drag-end-hover');
    initCustomScrollbar(box.container);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;

    // Release while still hovering the track: remains visible until leaving the track.
    revealByHover(box, 50, 20);
    enterBar(box);
    thumb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 20 }));
    expect(thumb.classList.contains('dragging')).toBe(true);
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    expect(thumb.classList.contains('dragging')).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(box.track().style.opacity).toBe('1');

    // Dragging off the track stays visible during drag, then fades after mouseup.
    thumb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 20 }));
    leaveBar(box);
    vi.advanceTimersByTime(5000);
    expect(box.track().style.opacity).toBe('1');
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    vi.advanceTimersByTime(1199);
    expect(box.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(box.track().style.opacity).toBe('0');
  });

  it('reveals only the innermost overflowing container on nested pointer events', () => {
    const outer = createScrollbox('nested-outer-hover');
    const inner = createScrollbox('nested-inner-hover', outer.container);
    const child = document.createElement('div');
    inner.container.appendChild(child);
    initCustomScrollbar(outer.container);
    initCustomScrollbar(inner.container);

    dispatchPointer(child, 'pointerover', {
      pointerType: 'mouse',
      clientX: 30,
      clientY: 30,
    });
    flushAnimationFrame();
    expect(inner.track().style.opacity).toBe('1');
    expect(outer.track().style.opacity).toBe('0');

    dispatchPointer(child, 'pointermove', {
      pointerType: 'mouse',
      clientX: 32,
      clientY: 34,
    });
    flushAnimationFrame();
    expect(inner.track().style.opacity).toBe('1');
    expect(outer.track().style.opacity).toBe('0');

    // When the inner container no longer overflows, hovering over it reveals the outer container.
    inner.setScrollHeight(200);
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    expect(inner.track().style.opacity).toBe('0');

    dispatchPointer(child, 'pointermove', {
      pointerType: 'mouse',
      clientX: 36,
      clientY: 38,
    });
    flushAnimationFrame();
    expect(inner.track().style.opacity).toBe('0');
    expect(outer.track().style.opacity).toBe('1');
  });

  it("counts an inner scroll area's own bar as inner, so the outer bar stays hidden over it", () => {
    const outer = createScrollbox('nested-bar-outer');
    const inner = createScrollbox('nested-bar-inner', outer.container);
    initCustomScrollbar(outer.container);
    initCustomScrollbar(inner.container);
    const innerTrack = inner.track();
    const innerThumb = innerTrack.querySelector<HTMLElement>('.cscroll-thumb')!;
    // The inner bar sits beside the inner container, inside the outer one.
    expect(outer.container.contains(innerTrack)).toBe(true);
    expect(inner.container.contains(innerTrack)).toBe(false);

    revealByHover(inner, 30, 30);
    expect(outer.track().style.opacity).toBe('0');

    // Over and along the inner bar, as when grabbing or dragging its thumb.
    dispatchPointer(innerThumb, 'pointerover', {
      pointerType: 'mouse',
      clientX: 96,
      clientY: 30,
      relatedTarget: inner.container,
    });
    dispatchPointer(innerThumb, 'pointermove', { pointerType: 'mouse', clientX: 96, clientY: 40 });
    dispatchPointer(innerTrack, 'pointermove', { pointerType: 'mouse', clientX: 96, clientY: 90 });
    flushAnimationFrame();
    expect(outer.track().style.opacity).toBe('0');
    expect(inner.track().style.opacity).toBe('1');
  });

  it('re-measures once when a scroll session starts after a hover reveal', () => {
    const box = createScrollbox('hover-then-scroll-session');
    initCustomScrollbar(box.container);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    expect(thumb.style.height).toBe('40px');
    revealByHover(box);

    // Content can grow with no mutation record and no resize the bar watches
    // (text directly in the container, rewrapped by a late font). A wheel
    // inside the hover's fade delay still starts a scroll session, which
    // re-measures once.
    box.setScrollHeight(1600);
    vi.advanceTimersByTime(600);
    box.container.scrollTop = 100;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    expect(thumb.style.height).toBe('30px');

    // The session's later scrolls stay on the cache.
    box.rectSpy.mockClear();
    box.container.scrollTop = 200;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    expect(box.rectSpy).not.toHaveBeenCalled();
  });

  it('extends the scroll session with every scroll, so a long run re-measures once', () => {
    const box = createScrollbox('scroll-session-extends');
    initCustomScrollbar(box.container);
    box.rectSpy.mockClear();

    // Scrolls 1 s apart for 6 s, each inside the fade delay after the last,
    // are one session, which re-measures at its start only.
    for (let i = 1; i <= 6; i += 1) {
      box.container.scrollTop = i * 50;
      box.container.dispatchEvent(new Event('scroll'));
      flushAnimationFrame();
      vi.advanceTimersByTime(1000);
    }
    expect(box.rectSpy).toHaveBeenCalledTimes(1);

    // A full delay without a scroll ends the session; the next scroll starts another.
    vi.advanceTimersByTime(200);
    box.container.scrollTop = 400;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    expect(box.rectSpy).toHaveBeenCalledTimes(2);
  });

  it('measures a hidden bar before a hover shows it, and keeps moves over a shown bar on the cache', () => {
    const box = createScrollbox('hover-measures-first');
    initCustomScrollbar(box.container);

    // The content stopped overflowing with no mutation record and no resize
    // the bar watches (text directly in it, rewrapped by a font swap), so the
    // cache still says it does.
    box.setScrollHeight(200);
    dispatchPointer(box.container, 'pointerover', {
      pointerType: 'mouse',
      clientX: 50,
      clientY: 50,
    });
    flushAnimationFrame();
    vi.advanceTimersByTime(100);
    expect(box.track().style.opacity).toBe('0');
    expect(box.track().style.pointerEvents).toBe('none');

    box.setScrollHeight(1000);
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    revealByHover(box, 52, 50);
    box.rectSpy.mockClear();
    for (let x = 53; x < 63; x += 1) {
      dispatchPointer(box.container, 'pointermove', {
        pointerType: 'mouse',
        clientX: x,
        clientY: 50,
      });
    }
    expect(_rafCallbacks.size).toBe(0);
    flushAnimationFrame();
    expect(box.rectSpy).not.toHaveBeenCalled();
    expect(box.track().style.opacity).toBe('1');
  });

  it('lets a held bar go once the one hover gate turns off, with or without a scroll', () => {
    const box = createScrollbox('hold-gate');
    initCustomScrollbar(box.container);
    revealByHover(box);
    enterBar(box);
    vi.advanceTimersByTime(5000);
    expect(box.track().style.opacity).toBe('1');

    // A touch press elsewhere turns the gate off while the mouse rests on the bar.
    document.documentElement.removeAttribute('data-hover-pointer');
    vi.advanceTimersByTime(1200);
    expect(box.track().style.opacity).toBe('0');

    // Touch scrolling under a resting mouse does not hold the bar either.
    leaveBar(box);
    document.documentElement.setAttribute('data-hover-pointer', '');
    revealByHover(box, 52, 50);
    enterBar(box);
    document.documentElement.removeAttribute('data-hover-pointer');
    box.container.scrollTop = 100;
    box.container.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(5000);
    expect(box.track().style.opacity).toBe('0');
  });

  it("holds the bar on the browser's hover of it, not on a flag of its own", () => {
    const box = createScrollbox('hold-follows-hover');
    initCustomScrollbar(box.container);
    revealByHover(box);
    enterBar(box);
    vi.advanceTimersByTime(5000);
    expect(box.track().style.opacity).toBe('1');

    // The browser stops reporting the bar hovered and no pointerleave reaches it.
    hovered.delete(box.track());
    vi.advanceTimersByTime(1200);
    expect(box.track().style.opacity).toBe('0');
  });

  it('keeps the hold the mouse owns when a pen leaves the bar', () => {
    const box = createScrollbox('hold-two-pointers');
    initCustomScrollbar(box.container);
    revealByHover(box);
    enterBar(box, 'mouse', 1);

    // A pen hovers across the bar and away while the mouse rests on it, so the
    // browser still reports the bar hovered.
    dispatchPointer(box.track(), 'pointerover', { pointerType: 'pen', pointerId: 2 });
    dispatchPointer(box.track(), 'pointerenter', { pointerType: 'pen', pointerId: 2 });
    dispatchPointer(box.track(), 'pointerleave', { pointerType: 'pen', pointerId: 2 });
    vi.advanceTimersByTime(5000);
    expect(box.track().style.opacity).toBe('1');
  });

  it('restarts the countdown when a hover pointer leaves the bar, never when a touch does', () => {
    const box = createScrollbox('leave-hover-only');
    initCustomScrollbar(box.container);
    const scrollTo = (top: number): void => {
      box.container.scrollTop = top;
      box.container.dispatchEvent(new Event('scroll'));
      flushAnimationFrame();
    };

    // On a phone a touch press turned the one hover gate off, and a scroll
    // shows the bar. A swipe that starts on the shown bar gets a pointerleave
    // after its pointerup or pointercancel; the bar still fades a delay after
    // the scroll.
    document.documentElement.removeAttribute('data-hover-pointer');
    scrollTo(100);
    expect(box.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1000);
    enterBar(box, 'touch', 2);
    leaveBar(box, 'touch', 2);
    vi.advanceTimersByTime(200);
    expect(box.track().style.opacity).toBe('0');

    // A mouse that crosses the shown bar fades it a full delay after leaving.
    document.documentElement.setAttribute('data-hover-pointer', '');
    scrollTo(200);
    vi.advanceTimersByTime(900);
    enterBar(box);
    vi.advanceTimersByTime(100);
    leaveBar(box);
    vi.advanceTimersByTime(1199);
    expect(box.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(box.track().style.opacity).toBe('0');
  });

  it('does not keep a hold through content that stops overflowing under the bar', () => {
    const box = createScrollbox('hold-overflow-loss');
    initCustomScrollbar(box.container);
    revealByHover(box);
    enterBar(box);

    // The content stops overflowing: the bar goes, and the browser's hover of
    // it with the bar, though no pointerleave reaches it.
    box.setScrollHeight(200);
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('0');
    hovered.delete(box.track());

    // It overflows again and a scroll shows the bar, which fades on time.
    box.setScrollHeight(1000);
    bus.emit('ui:scrollbar-relayout');
    flushAnimationFrame();
    box.container.scrollTop = 100;
    box.container.dispatchEvent(new Event('scroll'));
    flushAnimationFrame();
    vi.advanceTimersByTime(1199);
    expect(box.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(box.track().style.opacity).toBe('0');
  });

  it('lets go of a mouse hold when a finger drags the thumb', () => {
    const box = createScrollbox('hold-touch-drag');
    initCustomScrollbar(box.container);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    revealByHover(box);
    enterBar(box);

    // The touch press turns the one hover gate off; :hover stays latched on the bar.
    document.documentElement.removeAttribute('data-hover-pointer');
    const finger = { identifier: 1, clientY: 20 };
    dispatchTouch(thumb, 'touchstart', [finger], [finger]);
    expect(thumb.classList.contains('dragging')).toBe(true);
    dispatchTouch(thumb, 'touchend', [], [finger]);
    expect(thumb.classList.contains('dragging')).toBe(false);
    vi.advanceTimersByTime(1199);
    expect(box.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(box.track().style.opacity).toBe('0');
  });

  it('lets an event that names no pointer type follow the one hover gate', () => {
    const box = createScrollbox('hover-untyped');
    initCustomScrollbar(box.container);

    document.documentElement.removeAttribute('data-hover-pointer');
    dispatchPointer(box.container, 'pointerover', { pointerType: '', clientX: 10, clientY: 10 });
    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('0');

    document.documentElement.setAttribute('data-hover-pointer', '');
    dispatchPointer(box.container, 'pointermove', { pointerType: '', clientX: 11, clientY: 10 });
    flushAnimationFrame();
    expect(box.track().style.opacity).toBe('1');
  });

  it('hands a wheel turned over the bar to its scroller, in pixels, lines or pages', () => {
    const box = createScrollbox('wheel-over-bar');
    initCustomScrollbar(box.container);
    revealByHover(box);
    enterBar(box);
    const thumb = box.track().querySelector<HTMLElement>('.cscroll-thumb')!;
    const wheel = (target: HTMLElement, init: WheelEventInit): WheelEvent => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };

    expect(wheel(box.track(), { deltaY: 120 }).defaultPrevented).toBe(true);
    expect(box.container.scrollTop).toBe(120);
    wheel(thumb, { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(box.container.scrollTop).toBe(240);
    wheel(box.track(), { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE });
    expect(box.container.scrollTop).toBe(40);

    // Ctrl with the wheel, or a pinch, zooms the page, and a sideways wheel is
    // not this bar's to take.
    expect(wheel(box.track(), { deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel(box.track(), { deltaX: 80 }).defaultPrevented).toBe(false);
    expect(box.container.scrollTop).toBe(40);
  });

  it('removes every listener it adds to the content and the window on destroy', () => {
    const box = createScrollbox('destroy-hover-cleanup');
    const targets: EventTarget[] = [box.container, window];
    const spies = targets.map((target) => ({
      add: vi.spyOn(target, 'addEventListener'),
      remove: vi.spyOn(target, 'removeEventListener'),
    }));
    initCustomScrollbar(box.container);
    const track = box.track();
    const added = spies.map(({ add }) =>
      add.mock.calls.map(([type, listener]) => [type, listener]),
    );
    expect(added[0].map(([type]) => type)).toEqual(
      expect.arrayContaining(['scroll', 'pointerover', 'pointermove']),
    );
    expect(added[1].length).toBeGreaterThan(0);

    destroyCustomScrollbar(box.container);
    spies.forEach(({ remove }, index) => {
      const removed = remove.mock.calls.map(([type, listener]) => [type, listener]);
      for (const listener of added[index]) expect(removed).toContainEqual(listener);
    });
    expect(track.isConnected).toBe(false);

    dispatchPointer(box.container, 'pointerover', {
      pointerType: 'mouse',
      clientX: 20,
      clientY: 20,
    });
    flushAnimationFrame();
    expect(track.style.opacity).toBe('0');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('inherits pointer-events on the thumb and styles active and dragging states alike', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const root = parseCss(stylesheet);

    let thumbHasPointerEventsAuto = false;
    let hoverDecl: string | null = null;
    let activeDecl: string | null = null;
    let draggingDecl: string | null = null;

    root.walkRules((rule) => {
      for (const rawSelector of rule.selectors) {
        const selector = rawSelector.replace(/\s+/gu, ' ').trim();
        if (selector === '.cscroll-thumb') {
          rule.walkDecls('pointer-events', (decl) => {
            if (decl.value.trim() === 'auto') thumbHasPointerEventsAuto = true;
          });
        }
        if (
          selector ===
          ':where(html[data-hover-pointer]) .cscroll-thumb:hover > .cscroll-thumb-visual'
        ) {
          rule.walkDecls('background-color', (decl) => {
            hoverDecl = decl.value.trim();
          });
        }
        if (selector === '.cscroll-thumb:active > .cscroll-thumb-visual') {
          rule.walkDecls('background-color', (decl) => {
            activeDecl = decl.value.trim();
          });
        }
        if (selector === '.cscroll-thumb.dragging > .cscroll-thumb-visual') {
          rule.walkDecls('background-color', (decl) => {
            draggingDecl = decl.value.trim();
          });
        }
      }
    });

    expect(thumbHasPointerEventsAuto).toBe(false);
    expect(hoverDecl).toBe('var(--scrollbar-thumb-hover)');
    expect(activeDecl).toBe('var(--scrollbar-thumb-active)');
    expect(draggingDecl).toBe('var(--scrollbar-thumb-active)');
  });
});
