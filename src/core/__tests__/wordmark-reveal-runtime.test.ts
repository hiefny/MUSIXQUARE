import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const LOGO = `<svg class="logo-welcome" viewBox="43 12 214 24" xmlns="http://www.w3.org/2000/svg">
  <defs><g data-wordmark-strokes>
    <rect class="wl wtb" data-wt="0" data-wd="100" x="43" y="12" width="4" height="10"/>
    <rect class="wl wlr" data-wt="100" data-wd="100" x="47" y="12" width="6" height="4"/>
    <polygon class="wl wdiag" data-wt="200" data-wd="1840" points="60,12 64,12 70,24 66,24"/>
  </g></defs>
  <g class="wg"><path d="M43 12h10v4h-6v6h-4Z M60 12h4l6 12h-4Z"/></g>
</svg>`;

let code: string;
const windows: JSDOM[] = [];

beforeAll(() => {
  code = compileClassicRuntimeForBrowserTest('wordmark-anim.js');
});

afterEach(() => {
  windows.splice(0).forEach((dom) => dom.window.close());
});

function fixture({ reduced = false, html = LOGO, requested = false } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html${requested ? ' data-wordmark-start-requested' : ''}><body>${html}</body></html>`,
    { runScripts: 'outside-only', url: 'https://musixquare.com/', pretendToBeVisual: true },
  );
  windows.push(dom);
  const { window } = dom;
  const { document } = window;
  let now = 0;
  let hidden = false;
  let nextFrame = 0;
  let motionListener = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  const media = {
    matches: reduced,
    addEventListener: (_event: string, callback: () => void) => {
      motionListener = callback;
    },
  };
  Object.defineProperty(window.performance, 'now', { value: () => now });
  Object.defineProperty(document, 'hidden', { get: () => hidden });
  Object.defineProperty(window, 'matchMedia', { value: () => media });
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const send = (name: string) => document.dispatchEvent(new window.CustomEvent(name));
  const run = () => window.eval(code);
  run();
  return {
    window,
    document,
    frames,
    run,
    send,
    logo: document.querySelector<SVGSVGElement>('.logo-welcome')!,
    start: () => send('mxqr:wordmark-start'),
    advance(value: number) {
      now = value;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(value));
    },
    visibility(value: boolean) {
      hidden = value;
      document.dispatchEvent(new window.Event('visibilitychange'));
    },
    reduce() {
      media.matches = true;
      motionListener();
    },
  };
}

function revealedPath(logo: SVGSVGElement): string {
  return logo.querySelector('[data-wordmark-reveal]')?.getAttribute('d') ?? '';
}

describe('setup wordmark exact reveal lifecycle', () => {
  it('keeps a static fallback until setup starts and never reveals the next stroke early', () => {
    const app = fixture();
    app.advance(10_000);
    expect(app.frames.size).toBe(0);
    expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(false);
    app.start();
    expect(revealedPath(app.logo)).toBe('');
    app.advance(10_600);
    expect(revealedPath(app.logo)).toBe('M43 12L47 12L47 22L43 22Z');
    app.advance(10_650);
    const segments = revealedPath(app.logo).split('Z').filter(Boolean);
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatch(/^M47 12L/);
    expect(revealedPath(app.logo)).not.toContain('M60');
  });

  it('gives desktop copies distinct masks on the same timeline and ignores duplicate installation/start', () => {
    const app = fixture();
    app.start();
    app.advance(640);
    const sourceId = app.logo.querySelector('mask')!.id;
    const clone = app.logo.cloneNode(true) as SVGSVGElement;
    app.document.body.append(clone);
    app.send('mxqr:wordmark-refresh');
    expect(clone.querySelector('mask')!.id).not.toBe(sourceId);
    expect(clone.querySelectorAll('mask')).toHaveLength(1);
    expect(revealedPath(clone)).toBe(revealedPath(app.logo));
    expect(app.frames.size).toBe(1);
    const path = revealedPath(app.logo);
    app.run();
    app.start();
    expect(app.frames.size).toBe(1);
    expect(revealedPath(app.logo)).toBe(path);
    expect(app.logo.querySelectorAll('mask')).toHaveLength(1);
  });

  it('notifies when drawing ends, retains the ghost fade, then releases all frame work', () => {
    const app = fixture();
    const completed: EventTarget[] = [];
    app.document.addEventListener('mxqr:wordmark-draw-complete', (event) => {
      if (event.target) completed.push(event.target);
    });
    app.start();
    app.advance(2539);
    expect(completed).toHaveLength(0);
    app.advance(2540);
    expect(completed).toEqual([app.logo]);
    expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
    expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(true);
    app.advance(2900);
    expect(app.frames.size).toBe(0);
    expect(completed).toEqual([app.logo]);
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(false);
    app.send('mxqr:wordmark-refresh');
    expect(app.frames.size).toBe(0);
    expect(completed).toHaveLength(1);
  });

  it('catches up after background suspension instead of stretching the animation', () => {
    const app = fixture();
    app.start();
    app.advance(600);
    app.visibility(true);
    expect(app.frames.size).toBe(0);
    app.advance(20_000);
    app.visibility(false);
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
    expect(app.frames.size).toBe(0);
  });

  it('releases a removed instance and resumes a replacement at the shared elapsed time', () => {
    const app = fixture();
    app.start();
    app.advance(640);
    app.logo.remove();
    app.advance(700);
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.frames.size).toBe(0);
    app.document.body.append(app.logo);
    app.send('mxqr:wordmark-refresh');
    expect(revealedPath(app.logo)).toContain('M47 12L53 12L53 16L47 16Z');
    expect(app.frames.size).toBe(1);
    app.advance(2900);
    const later = app.logo.cloneNode(true) as SVGSVGElement;
    app.document.body.append(later);
    app.send('mxqr:wordmark-refresh');
    expect(later.dataset.wordmarkDrawComplete).toBe('true');
    expect(later.querySelector('mask')).toBeNull();
    expect(app.frames.size).toBe(0);
  });

  it.each(['initial', 'changed', 'pagehide'] as const)(
    'settles safely on %s motion interruption',
    (mode) => {
      const app = fixture({ reduced: mode === 'initial' });
      app.start();
      if (mode === 'changed') app.reduce();
      if (mode === 'pagehide') app.window.dispatchEvent(new app.window.Event('pagehide'));
      expect(app.logo.querySelector('mask')).toBeNull();
      expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(false);
      expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
      expect(app.frames.size).toBe(0);
    },
  );

  it('honors an earlier start request but never replays behind an already shown greeting', () => {
    const early = fixture({ requested: true });
    expect(early.frames.size).toBe(1);
    const late = fixture({
      requested: true,
      html: `<div class="setup-brand-greeting-stage is-greeting-visible">${LOGO}</div>`,
    });
    expect(late.frames.size).toBe(0);
    expect(late.logo.dataset.wordmarkDrawComplete).toBe('true');
    expect(late.logo.querySelector('mask')).toBeNull();
  });

  it('keeps malformed geometry fully visible rather than leaving an incomplete mask', () => {
    const app = fixture({ html: LOGO.replace('data-wd="100"', 'data-wd="NaN"') });
    app.start();
    expect(app.logo.querySelector('mask')).toBeNull();
    expect(app.logo.querySelector('.wg')?.hasAttribute('mask')).toBe(false);
    expect(app.logo.dataset.wordmarkDrawComplete).toBe('true');
    expect(app.frames.size).toBe(0);
  });
});
