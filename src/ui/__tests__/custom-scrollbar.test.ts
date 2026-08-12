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
import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { bus } from '../../core/events.ts';
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

const _resizeObservers = new Map<Element, ResizeObserverStub>();

class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    _resizeObservers.set(target, this);
  }

  unobserve(target: Element): void {
    if (_resizeObservers.get(target) === this) _resizeObservers.delete(target);
  }

  disconnect(): void {
    for (const [target, observer] of _resizeObservers) {
      if (observer === this) _resizeObservers.delete(target);
    }
  }

  notify(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
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
const COMPACT_QUERY = '(min-width: 720px) and (max-width: 1279px)';

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
 */
function createScrollbox(id: string, mount: HTMLElement = document.body): Scrollbox {
  const parent = document.createElement('div');
  const container = document.createElement('div');
  container.id = id;
  container.setAttribute('data-custom-scroll', '');
  container.setAttribute('data-custom-scroll-contained', '');
  container.style.overflowY = 'auto';
  parent.appendChild(container);
  mount.appendChild(parent);

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
      const t = parent.querySelector<HTMLElement>('.cscroll-track');
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
  _resizeObservers.clear();
  _mqlMatches.clear();
  clearAllManagedTimers();
  vi.useRealTimers();
  document.body.style.removeProperty('--desktop-ui-scale');
  document.body.innerHTML = '';
});

describe('custom-scrollbar ownership', () => {
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
    fireMqlChange(COMPACT_QUERY);
    vi.advanceTimersByTime(350);
    expect(a.track().style.height).toBe('280px');
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

      destroyCustomScrollbar(box.container);
      expect(animations[1].cancel).toHaveBeenCalledOnce();
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

  it('keeps timeline thumb height normal when relayout happens during rubber-band offsets', async () => {
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

      box.container.scrollTop = -20;
      box.setClientHeight(220);
      _resizeObservers.get(box.container)?.notify();
      flushAnimationFrame();
      expect(box.track().dataset.scrollDriver).toBe('timeline');
      expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(48.4, 5);
      expect(thumb.style.transform).toBe('translateY(0px)');
      expect(visual.style.height).toBe('');
      expect(readVisualTransform(visual).translateY).toBe(0);
      expect(readVisualTransform(visual).scaleY).toBeCloseTo(44 / 48.4, 5);

      box.container.scrollTop = 900;
      box.setClientHeight(240);
      _resizeObservers.get(box.container)?.notify();
      flushAnimationFrame();
      expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(57.6, 5);
      expect(thumb.style.transform).toBe('translateY(182.4px)');
      expect(visual.style.height).toBe('');
      expect(readVisualTransform(visual).translateY).toBeCloseTo(33.6, 5);
      expect(readVisualTransform(visual).scaleY).toBeCloseTo(24 / 57.6, 5);
      expect(animate).toHaveBeenCalledTimes(3); // only the two changed endpoints rebuild
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

    // Simulate an image/font changing intrinsic content size without changing
    // the scrollport border box (therefore no container ResizeObserver entry).
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
    _resizeObservers.get(box.container)?.notify();
    bus.emit('ui:scrollbar-relayout');
    await flushMutationObservers();

    // MutationObserver, ResizeObserver and the bus all converge on one frame.
    expect(box.rectSpy).not.toHaveBeenCalled();
    flushAnimationFrame();
    expect(box.rectSpy).toHaveBeenCalledTimes(1);
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
    const compactStart = stylesheet.indexOf('@media (min-width: 720px) and (max-width: 1279px) {');
    const compactEnd = stylesheet.indexOf('/* iPad PWA portrait', compactStart);
    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    const compactStyles = stylesheet.slice(compactStart, compactEnd);

    expect(compactStyles).toMatch(
      /body\s*>\s*\.cscroll-track\s*\{[^}]*right:\s*calc\(200px \+ var\(--safe-right\)\)\s*!important;/s,
    );
    expect(compactStyles).not.toMatch(
      /(?:^|})\s*\.cscroll-track\s*\{[^}]*right:\s*calc\(200px \+ var\(--safe-right\)\)\s*!important;/s,
    );
  });

  it('does not style the setup scrollbar as an onboarding content section', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toMatch(
      /\.onboarding-card\s*>\s*div:not\(\.ob-actions,\s*\.cscroll-track\)\s*\{/,
    );
    expect(stylesheet).toMatch(
      /\.setup-mobile-view\s*>\s*div:not\(\.ob-actions,\s*\.setup-header-pill,\s*\.cscroll-track\)\s*\{/,
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
      /#media-source-overlay\s+\.setup-slot-list\s*\{[^}]*align-self:\s*stretch\s*!important;[^}]*overflow-y:\s*auto\s*!important;/s,
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
      /#media-source-overlay\s+\.setup-card\.full-screen\s*>\s*div:not\(\.ob-actions,\s*\.cscroll-track\)/,
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
