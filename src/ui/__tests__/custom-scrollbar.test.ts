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
      matches: false,
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

class ResizeObserverStub {
  observe(): void {
    /* noop */
  }

  unobserve(): void {
    /* noop */
  }

  disconnect(): void {
    /* noop */
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
function createScrollbox(id: string): Scrollbox {
  const parent = document.createElement('div');
  const container = document.createElement('div');
  container.id = id;
  container.setAttribute('data-custom-scroll', '');
  container.setAttribute('data-custom-scroll-contained', '');
  container.style.overflowY = 'auto';
  parent.appendChild(container);
  document.body.appendChild(parent);

  let clientHeight = 200;
  let scrollHeight = 1000;
  Object.defineProperty(container, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(container, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  const rectSpy = vi.fn((): DOMRect => makeRect(clientHeight));
  container.getBoundingClientRect = rectSpy;

  const box = {
    container,
    rectSpy,
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

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  bus.clear();
});

afterEach(() => {
  // Deregister from the module's live instance map — relayoutAll iterates it,
  // so leaking instances across tests would pollute later run counts.
  for (const box of _boxes) destroyCustomScrollbar(box.container);
  _boxes.length = 0;
  clearAllManagedTimers();
  vi.useRealTimers();
  document.body.style.removeProperty('--desktop-ui-scale');
  document.body.innerHTML = '';
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
    expect(background.track().style.opacity).toBe('0');
    vi.advanceTimersByTime(1199);
    expect(scoped.track().style.opacity).toBe('1');
    vi.advanceTimersByTime(1);
    expect(scoped.track().style.opacity).toBe('0');
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
