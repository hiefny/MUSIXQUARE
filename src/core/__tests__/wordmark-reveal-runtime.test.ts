import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MATERIAL_ELASTIC_SPINNER_PARTS } from '../../ui/material-elastic-spinner.ts';
import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

// The boot splash (index.html) as the runtime meets it: the wordmark, its
// reveal geometry in nonpainting definitions, and the loader below.
const LOGO = `<svg class="boot-splash-logo" viewBox="43 12 214 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g class="wg"><path d="M43 12h10v4h-6v6h-4Z M60 12h4l6 12h-4Z"/></g>
  <defs><g data-wordmark-strokes>
    <rect class="wl wtb" data-wt="0" data-wd="100" x="43" y="12" width="4" height="10"/>
    <rect class="wl wlr" data-wt="100" data-wd="100" x="47" y="12" width="6" height="4"/>
    <polygon class="wl wdiag" data-wt="200" data-wd="1840" points="60,12 64,12 70,24 66,24"/>
  </g></defs>
</svg>`;
const SPLASH = (logo = LOGO) => `<div class="boot-splash" aria-hidden="true">
  <div class="boot-splash-mark">${logo}<span class="boot-splash-spinner" aria-hidden="true">${MATERIAL_ELASTIC_SPINNER_PARTS}</span></div>
</div>`;
// Strokes start 500 ms into the drawing; the last ends at 500 + 200 + 1840.
const DRAW_END = 2540;
// The ghost finishes rising at 2.9 s.
const END = 2900;

let code: string;
const windows: JSDOM[] = [];

beforeAll(() => {
  code = compileClassicRuntimeForBrowserTest('wordmark-anim.js');
});

afterEach(() => {
  windows.splice(0).forEach((dom) => dom.window.close());
});

interface FixtureOptions {
  reduced?: boolean;
  logo?: string;
  /** The root's classes when the runtime arrives. */
  rootClass?: string;
  /** When the document's first byte arrived (navigation responseStart). */
  arrival?: number;
  /** When the runtime runs, on the same clock. */
  boot?: number;
  /** The wall clock (Date.now) when the runtime runs. */
  wall?: number;
  /** The splash's phase before the runtime runs (bootstrap.js settles it after a reset). */
  phase?: string;
  /**
   * With the Web Animations API: when the mark's CSS fade-in started (null:
   * not yet, it starts with the next frame). Omitted: no API, as in jsdom.
   */
  markStart?: number | null;
}

function fixture({
  reduced = false,
  logo = LOGO,
  rootClass = 'setup-boot-block',
  arrival = 100,
  boot = 150,
  wall = 1_000_000,
  phase,
  markStart,
}: FixtureOptions = {}) {
  const dom = new JSDOM(
    `<!doctype html><html class="${rootClass}"><body>${SPLASH(logo)}</body></html>`,
    { runScripts: 'outside-only', url: 'https://musixquare.com/', pretendToBeVisual: true },
  );
  windows.push(dom);
  const { window } = dom;
  const { document } = window;
  let now = boot;
  let hidden = false;
  let nextFrame = 0;
  let nextTimer = 0;
  let motionListener = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  const timers: Array<{ id: number; due: number; callback: () => void }> = [];
  const media = {
    matches: reduced,
    addEventListener: (_event: string, callback: () => void) => {
      motionListener = callback;
    },
  };
  Object.defineProperty(window.performance, 'now', { value: () => now });
  Object.defineProperty(window.performance, 'getEntriesByType', {
    value: (type: string) => (type === 'navigation' ? [{ responseStart: arrival }] : []),
  });
  Object.defineProperty(window.Date, 'now', { value: () => wall + (now - boot) });
  Object.defineProperty(document, 'hidden', { get: () => hidden });
  Object.defineProperty(window, 'matchMedia', { value: () => media });
  Object.defineProperty(window, 'getComputedStyle', {
    value: (element: Element) => ({
      animationDuration:
        element.localName === 'svg' ? '1.568s' : element.localName === 'circle' ? '5.332s' : '0s',
    }),
  });
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  window.setTimeout = ((callback: () => void, delay = 0) => {
    timers.push({ id: ++nextTimer, due: now + Math.max(0, delay), callback });
    return nextTimer;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index > -1) timers.splice(index, 1);
  }) as typeof window.clearTimeout;
  if (phase !== undefined)
    document.querySelector<HTMLElement>('.boot-splash')!.dataset.phase = phase;
  if (markStart !== undefined) {
    Object.defineProperty(document.querySelector('.boot-splash-mark')!, 'getAnimations', {
      value: () => [{ animationName: 'boot-splash-mark-in', startTime: markStart }],
    });
    // The document timeline that fade-in runs on (same origin as performance.now()).
    Object.defineProperty(document, 'timeline', {
      value: {
        get currentTime() {
          return now;
        },
      },
    });
  }

  const run = () => window.eval(code);
  run();
  const splash = document.querySelector<HTMLElement>('.boot-splash')!;
  return {
    window,
    document,
    frames,
    timers,
    run,
    splash,
    logo: document.querySelector<SVGSVGElement>('.boot-splash-logo')!,
    phase: () => splash.dataset.phase,
    /** Run every timer due by `target` in order, then one frame at `target`. */
    advance(target: number) {
      for (;;) {
        const due = timers
          .filter((timer) => timer.due <= target)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = Math.max(now, due.due);
        due.callback();
      }
      now = target;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(target));
    },
    /** A long task held the page until `target`: every timer due by then runs only now. */
    runLate(target: number) {
      now = target;
      for (;;) {
        const due = timers
          .filter((timer) => timer.due <= target)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.callback();
      }
    },
    visibility(value: boolean) {
      hidden = value;
      document.dispatchEvent(new window.Event('visibilitychange'));
    },
    reduce() {
      media.matches = true;
      motionListener();
    },
    /** End one of the splash's CSS animations, as the browser reports it. */
    animationEnd(target: Element, animationName: string) {
      const event = new window.Event('animationend', { bubbles: true });
      Object.defineProperty(event, 'animationName', { value: animationName });
      target.dispatchEvent(event);
    },
    /** Let a MutationObserver callback run. */
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

function revealedPath(logo: SVGSVGElement): string {
  return logo.querySelector('[data-wordmark-reveal]')?.getAttribute('d') ?? '';
}

describe('boot splash wordmark reveal', () => {
  it('draws once from 0.3 s after the first byte and never reveals the next stroke early', () => {
    // First byte at 100, runtime at 150: the drawing starts at 400.
    const app = fixture();
    expect(app.logo.dataset.wordmarkReady).toBe('true');
    expect(app.logo.querySelector('.wg')?.getAttribute('mask')).toMatch(/^url\(#/u);
    expect(revealedPath(app.logo)).toBe('');
    expect(app.frames.size).toBe(0);
    app.advance(399);
    expect(app.frames.size).toBe(0);
    app.advance(400);
    expect(revealedPath(app.logo)).toBe('');
    expect(app.frames.size).toBe(1);
    app.advance(1000);
    expect(revealedPath(app.logo)).toBe('M43 12L47 12L47 22L43 22Z');
    app.advance(1050);
    const segments = revealedPath(app.logo).split('Z').filter(Boolean);
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatch(/^M47 12L/u);
    expect(revealedPath(app.logo)).not.toContain('M60');
    expect(app.phase()).toBeUndefined();
  });

  it('raises the wordmark with the loader once drawn, keeps the ghost fade, then releases all frame work', () => {
    const app = fixture();
    app.advance(400);
    app.advance(400 + DRAW_END - 1);
    expect(app.phase()).toBeUndefined();
    expect(app.logo.dataset.wordmarkDrawComplete).toBeUndefined();
    app.advance(400 + DRAW_END);
    expect(app.phase()).toBe('loader');
    expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
    expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(true);
    app.advance(400 + END);
    expect(app.frames.size).toBe(0);
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(false);
    app.advance(10_000);
    expect(app.phase()).toBe('loader');
    expect(app.timers).toHaveLength(0);
  });

  it('lets the loader join just after the drawing when no frame reports its end', () => {
    const app = fixture();
    app.advance(400);
    app.visibility(true);
    // The drawing's end plus 0.3 s, from its start.
    app.advance(400 + DRAW_END + 299);
    expect(app.phase()).toBeUndefined();
    app.advance(400 + DRAW_END + 300);
    expect(app.phase()).toBe('loader');
    expect(app.logo.dataset.wordmarkDrawComplete).toBeUndefined();
    app.visibility(false);
    expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
  });

  it('catches up after background suspension instead of stretching the animation', () => {
    const app = fixture();
    app.advance(400);
    app.advance(1000);
    app.visibility(true);
    expect(app.frames.size).toBe(0);
    app.advance(20_000);
    app.visibility(false);
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
    expect(app.frames.size).toBe(0);
  });

  it.each(['the app takes the screen', 'setup latches the splash off', 'boot fails'] as const)(
    'stops the drawing where it is when %s mid-draw, then leaves rendering after the fade',
    async (release) => {
      const app = fixture();
      app.advance(400);
      app.advance(1050);
      const drawn = revealedPath(app.logo);
      const root = app.document.documentElement;
      if (release === 'the app takes the screen') root.classList.remove('setup-boot-block');
      if (release === 'setup latches the splash off') root.classList.add('boot-splash-released');
      if (release === 'boot fails') root.classList.add('setup-boot-failed');
      await app.settle();
      // Drawing the rest at once would flash the whole wordmark in the fade.
      expect(app.frames.size).toBe(0);
      expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(true);
      expect(app.logo.dataset.wordmarkDrawComplete).toBeUndefined();
      app.advance(10_000);
      expect(revealedPath(app.logo)).toBe(drawn);
      expect(app.phase()).toBeUndefined();

      // Only the splash's own fade (or its last-resort fade) retires it.
      app.animationEnd(app.splash.querySelector('.boot-splash-spinner')!, 'boot-splash-out');
      expect(app.splash.hidden).toBe(false);
      app.animationEnd(app.splash, 'boot-splash-mark-in');
      expect(app.splash.hidden).toBe(false);
      app.animationEnd(app.splash, 'boot-splash-out');
      expect(app.splash.hidden).toBe(true);
    },
  );

  // Owner decision 2026-11-16: over an installed iOS app's first screen that
  // iOS gives short by the home indicator strip, the splash stays over the app
  // (the head preflight marks data-boot-hold; platform.ts ends it once the
  // screen grows), so the drawing goes on through the hold.
  it('keeps drawing while a short first screen holds the splash over the app, and stops where it is once the hold ends', async () => {
    const app = fixture();
    const root = app.document.documentElement;
    root.setAttribute('data-boot-hold', '');
    app.advance(400);
    app.advance(1050);
    root.classList.remove('setup-boot-block');
    await app.settle();
    const atRelease = revealedPath(app.logo);
    app.advance(1300);
    expect(revealedPath(app.logo)).not.toBe(atRelease);
    expect(app.frames.size).toBeGreaterThan(0);

    root.removeAttribute('data-boot-hold');
    await app.settle();
    expect(app.frames.size).toBe(0);
    const atHoldEnd = revealedPath(app.logo);
    app.advance(10_000);
    expect(revealedPath(app.logo)).toBe(atHoldEnd);
    expect(app.logo.dataset.wordmarkDrawComplete).toBeUndefined();
  });

  it('never holds a splash boot failure releases', async () => {
    const app = fixture();
    const root = app.document.documentElement;
    root.setAttribute('data-boot-hold', '');
    app.advance(400);
    app.advance(1050);
    root.classList.add('setup-boot-failed');
    await app.settle();
    expect(app.frames.size).toBe(0);
  });

  it('retires the splash after its last-resort fade', () => {
    const app = fixture();
    app.animationEnd(app.splash, 'boot-splash-fail-open');
    expect(app.splash.hidden).toBe(true);
  });

  it('leaves a splash the app already took as it stands, and still retires it', () => {
    const app = fixture({ rootClass: '' });
    expect(app.logo.dataset.wordmarkReady).toBeUndefined();
    expect(app.logo.dataset.wordmarkDrawComplete).toBeUndefined();
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.phase()).toBeUndefined();
    // Its fade may already be over: hidden once a fade's length has surely passed.
    app.advance(150 + 399);
    expect(app.splash.hidden).toBe(false);
    app.advance(150 + 400);
    expect(app.splash.hidden).toBe(true);
    expect(app.frames.size).toBe(0);
  });

  it('leaves the final place bootstrap.js settled after an app reset, and never draws', () => {
    const app = fixture({ phase: 'settled' });
    expect(app.phase()).toBe('settled');
    expect(app.logo.dataset.wordmarkReady).toBe('true');
    expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
    expect(app.logo.querySelector('mask')).toBeNull();
    app.advance(10_000);
    expect(app.phase()).toBe('settled');
    expect(app.frames.size).toBe(0);
    expect(app.timers).toHaveLength(0);
  });

  it('keeps the CSS fallback when it arrives after the static wordmark showed', () => {
    // 1.8 s after the first byte the fallback showed the whole wordmark; its
    // rise stays at 3.2 s.
    const app = fixture({ arrival: 100, boot: 2100 });
    expect(app.logo.dataset.wordmarkReady).toBe('true');
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.phase()).toBeUndefined();
    app.advance(3299);
    expect(app.phase()).toBeUndefined();
    app.advance(3300);
    expect(app.phase()).toBe('loader');
    expect(app.frames.size).toBe(0);
  });

  it('keeps the risen fallback in place when it arrives after 3.2 s', () => {
    const app = fixture({ arrival: 100, boot: 3400 });
    expect(app.phase()).toBe('settled');
    expect(app.logo.dataset.wordmarkReady).toBe('true');
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.frames.size).toBe(0);
  });

  it.each(['initial', 'changed', 'pagehide'] as const)(
    'settles safely on %s motion interruption',
    (mode) => {
      const app = fixture({ reduced: mode === 'initial' });
      if (mode === 'initial') {
        // No loader before the mark: it joins as the mark shows, at 0.3 s.
        expect(app.phase()).toBeUndefined();
        app.advance(399);
        expect(app.phase()).toBeUndefined();
      }
      app.advance(400);
      if (mode === 'initial') expect(app.phase()).toBe('loader');
      app.advance(1050);
      if (mode === 'changed') app.reduce();
      if (mode === 'pagehide') app.window.dispatchEvent(new app.window.Event('pagehide'));
      expect(app.logo.querySelector('mask')).toBeNull();
      expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(false);
      expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
      expect(app.frames.size).toBe(0);
    },
  );

  it('keeps malformed geometry fully visible rather than leaving an incomplete mask', () => {
    const app = fixture({ logo: LOGO.replace('data-wd="100"', 'data-wd="NaN"') });
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(false);
    expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
    expect(app.frames.size).toBe(0);
    // It rises at the sheet's own fallback time, 3.2 s.
    expect(app.phase()).toBeUndefined();
    app.advance(3299);
    expect(app.phase()).toBeUndefined();
    app.advance(3300);
    expect(app.phase()).toBe('loader');
  });

  it.each(['reduced motion turns on', 'the page is hidden and restored'] as const)(
    'lets the loader join when %s before the drawing starts',
    (event) => {
      const app = fixture();
      app.advance(200);
      if (event === 'reduced motion turns on') app.reduce();
      else app.window.dispatchEvent(new app.window.Event('pagehide'));
      // The wordmark stands drawn; the sheet's own rise is off for this runtime.
      expect(app.logo.querySelector('mask')).toBeNull();
      expect(app.phase()).toBeUndefined();
      app.advance(400);
      expect(app.phase()).toBe('loader');
    },
  );

  it("times the loader's late join from the real start, so a delayed start never rises mid-draw", () => {
    const app = fixture();
    // A long task holds the page from the planned start (400) until 1000.
    app.runLate(1000);
    expect(app.frames.size).toBe(1);
    // No frame reports the drawing's end (a hidden tab).
    app.visibility(true);
    app.advance(1000 + DRAW_END + 299);
    expect(app.phase()).toBeUndefined();
    app.advance(1000 + DRAW_END + 300);
    expect(app.phase()).toBe('loader');
  });

  it("counts from the splash's own CSS clock when it can read it", () => {
    // The first byte came at 100 but the splash first styled at 900: the
    // runtime at 1000 starts drawing at 1200, as the sheet's mark shows.
    const app = fixture({ arrival: 100, boot: 1000, markStart: 900 });
    expect(app.logo.querySelector('mask')).not.toBeNull();
    app.advance(1199);
    expect(app.frames.size).toBe(0);
    app.advance(1200);
    expect(app.frames.size).toBe(1);

    // Its fade-in has no start time yet: the sheet's clock starts with the
    // next frame, so this is not the 1.8 s fallback the first byte implies.
    const pending = fixture({ arrival: 100, boot: 2000, markStart: null });
    expect(pending.logo.querySelector('mask')).not.toBeNull();
    pending.advance(2299);
    expect(pending.frames.size).toBe(0);
    pending.advance(2300);
    expect(pending.frames.size).toBe(1);
  });

  it('marks itself apart from an older release runtime, so the sheet keeps its fallbacks for that one', () => {
    const root = fixture().document.documentElement;
    expect(root.getAttribute('data-boot-splash-runtime')).toBe('true');
    expect(root.hasAttribute('data-wordmark-runtime-ready')).toBe(false);
  });

  it('installs once', () => {
    const app = fixture();
    const timers = app.timers.length;
    app.run();
    expect(app.timers).toHaveLength(timers);
    expect(app.logo.querySelectorAll('mask')).toHaveLength(1);
    app.advance(400);
    expect(app.frames.size).toBe(1);
  });

  it('leaves the stamp and the loader to bootstrap.js', () => {
    const app = fixture();
    app.window.sessionStorage.setItem('mxqr-boot-continuity', String(1_000_000 - 1000));
    app.advance(400);
    expect(app.window.sessionStorage.getItem('mxqr-boot-continuity')).not.toBeNull();
    const loader = app.splash.querySelector('.boot-splash-spinner')!;
    // None of the loader's moving parts (src/ui/material-elastic-spinner.ts) is phased here.
    const parts = [
      ...loader.querySelectorAll<HTMLElement | SVGElement>(
        '.material-elastic-turn, .material-elastic-arc, .material-elastic-tail > .material-elastic-ring, .material-elastic-head > .material-elastic-ring',
      ),
    ];
    expect(parts).toHaveLength(4);
    expect(parts.map((part) => part.style.animationDelay)).toEqual(['', '', '', '']);
  });
});
