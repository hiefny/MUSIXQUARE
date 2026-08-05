import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

type PickerHarness = {
  dom: JSDOM;
  scrollTo: ReturnType<typeof vi.fn>;
};

async function createPickerHarness(mobile: boolean): Promise<PickerHarness> {
  const dom = new JSDOM(
    '<!doctype html><html><body><div data-static-lang-picker></div></body></html>',
    {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      url: 'https://musixquare.com/about',
    },
  );
  const scrollTo = vi.fn();

  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      matches: mobile,
    }),
  });
  Object.defineProperty(dom.window, 'scrollY', {
    configurable: true,
    value: 275,
  });
  Object.defineProperty(dom.window, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });

  const source = await readFile('public/static-language.js', 'utf8');
  dom.window.eval(source);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

  return { dom, scrollTo };
}

describe('static page language picker', () => {
  it('isolates mobile scrolling while the picker is open and restores the page afterward', async () => {
    const { dom, scrollTo } = await createPickerHarness(true);
    const { document } = dom.window;
    const picker = document.querySelector<HTMLElement>('[data-static-lang-picker]');
    const trigger = document.querySelector<HTMLButtonElement>('[data-static-lang-trigger]');
    const backdrop = document.querySelector<HTMLElement>('[data-static-lang-backdrop]');

    expect(picker).not.toBeNull();
    expect(trigger).not.toBeNull();
    expect(backdrop).not.toBeNull();

    trigger?.click();

    expect(picker?.classList.contains('is-open')).toBe(true);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(document.documentElement.classList.contains('static-lang-page-locked')).toBe(true);
    expect(document.body.classList.contains('static-lang-page-locked')).toBe(true);
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-275px');

    backdrop?.click();

    expect(picker?.classList.contains('is-open')).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.documentElement.classList.contains('static-lang-page-locked')).toBe(false);
    expect(document.body.classList.contains('static-lang-page-locked')).toBe(false);
    expect(document.body.style.position).toBe('');
    expect(document.body.style.top).toBe('');
    expect(scrollTo).toHaveBeenCalledWith(0, 275);

    dom.window.close();
  });

  it('keeps the desktop picker as a non-modal footer popover', async () => {
    const { dom, scrollTo } = await createPickerHarness(false);
    const { document } = dom.window;
    const trigger = document.querySelector<HTMLButtonElement>('[data-static-lang-trigger]');

    trigger?.click();

    expect(document.documentElement.classList.contains('static-lang-page-locked')).toBe(false);
    expect(document.body.classList.contains('static-lang-page-locked')).toBe(false);
    expect(document.body.style.position).toBe('');
    expect(scrollTo).not.toHaveBeenCalled();

    dom.window.close();
  });

  it('uses a viewport-fixed, touch-contained scroller on mobile', async () => {
    const css = await readFile('public/static-language.css', 'utf8');

    expect(css).toContain('position: fixed;');
    expect(css).toContain('overscroll-behavior-y: contain;');
    expect(css).toContain('touch-action: pan-y;');
    expect(css).toContain('-webkit-overflow-scrolling: touch;');
    expect(css).toContain('100dvh');
  });
});
