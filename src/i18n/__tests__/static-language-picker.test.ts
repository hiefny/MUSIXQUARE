import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

const STATIC_LANGUAGE_ASSET = CLASSIC_RUNTIME_ASSETS.find(
  (candidate) => candidate.outputPath === 'static-language.js',
);
if (!STATIC_LANGUAGE_ASSET) {
  throw new Error('Classic static-language runtime is missing from the manifest.');
}
const STATIC_LANGUAGE_RUNTIME = (
  await compileClassicRuntimeAsset(process.cwd(), STATIC_LANGUAGE_ASSET)
).code;

type PickerHarness = {
  dom: JSDOM;
  scrollTo: ReturnType<typeof vi.fn>;
};

type StaticLanguageApi = {
  htmlLang(code: string): string;
  locale(code: string): string;
  normalize(code: string): string | null;
  options: Array<{ code: string; htmlLang: string }>;
};

function languageApi(dom: JSDOM): StaticLanguageApi {
  return (dom.window as unknown as { MXQRStaticLang: StaticLanguageApi }).MXQRStaticLang;
}

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

  dom.window.eval(STATIC_LANGUAGE_RUNTIME);
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

  it('exposes all locales with valid language ownership and picker relationships', async () => {
    const { dom } = await createPickerHarness(false);
    const { document } = dom.window;
    const api = languageApi(dom);
    const trigger = document.querySelector<HTMLButtonElement>('[data-static-lang-trigger]')!;
    const current = document.querySelector<HTMLElement>('[data-static-lang-current]')!;
    const menu = document.querySelector<HTMLElement>('[data-static-lang-menu]')!;
    const options = [...document.querySelectorAll<HTMLElement>('[data-lang-set]')];

    expect(api.options).toHaveLength(17);
    expect(options).toHaveLength(api.options.length);
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.getAttribute('aria-labelledby')).toBe(current.id);
    expect(current.lang).toBe('en');

    for (const [index, option] of options.entries()) {
      expect(option.dataset.langSet).toBe(api.options[index].code);
      expect(option.querySelector<HTMLElement>('.static-lang-option__native')?.lang).toBe(
        api.options[index].htmlLang,
      );
      expect(option.querySelector<HTMLElement>('.static-lang-option__english')?.lang).toBe('en');
    }

    dom.window.close();
  });

  it('normalizes script-first Chinese and regional Portuguese and Dutch tags', async () => {
    const { dom } = await createPickerHarness(false);
    const api = languageApi(dom);

    expect(api.normalize('zh-Hans-TW')).toBe('zh-hans');
    expect(api.normalize('zh-Hant-CN')).toBe('zh-hant');
    expect(api.normalize('pt-PT')).toBe('pt-br');
    expect(api.normalize('nl-NL')).toBe('nl');
    expect(api.htmlLang('zh-hans')).toBe('zh-Hans');
    expect(api.locale('zh-hans')).toBe('zh_CN');
    expect(api.locale('zh-hant')).toBe('zh_TW');

    dom.window.close();
  });

  it('supports listbox arrow, Home, and End navigation without changing the selection', async () => {
    const { dom } = await createPickerHarness(false);
    const { document } = dom.window;
    const options = [...document.querySelectorAll<HTMLButtonElement>('[data-lang-set]')];

    options[0].focus();
    options[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'End' }),
    );
    expect(document.activeElement).toBe(options.at(-1));
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    options
      .at(-1)
      ?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    expect(document.activeElement).toBe(options[0]);

    options[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }),
    );
    expect(document.activeElement).toBe(options.at(-1));

    options
      .at(-1)
      ?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Home' }));
    expect(document.activeElement).toBe(options[0]);

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
