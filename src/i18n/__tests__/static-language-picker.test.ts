import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import { LANGUAGE_OPTIONS } from '../locales.ts';

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
  direction(code: string): 'ltr' | 'rtl';
  ensureFont(code: string): void;
  ensurePickerFonts(): void;
  normalize(code: string): string | null;
  persist(code: string): string;
  resolve(fallback: string): string;
  options: Array<{ code: string; htmlLang: string }>;
};

function languageApi(dom: JSDOM): StaticLanguageApi {
  return (dom.window as unknown as { MXQRStaticLang: StaticLanguageApi }).MXQRStaticLang;
}

async function createPickerHarness(
  mobile: boolean,
  url = 'https://musixquare.com/about',
  headMarkup = '',
): Promise<PickerHarness> {
  const dom = new JSDOM(
    `<!doctype html><html><head>${headMarkup}</head><body><div data-static-lang-picker></div></body></html>`,
    {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      url,
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
  it.each(['Escape', 'backdrop', 'trigger', 'outside'] as const)(
    'removes closed options from keyboard and accessibility navigation after %s',
    async (closeMethod) => {
      const { dom } = await createPickerHarness(true);
      try {
        const { document } = dom.window;
        const trigger = document.querySelector<HTMLButtonElement>('[data-static-lang-trigger]')!;
        const menu = document.querySelector<HTMLElement>('[data-static-lang-menu]')!;
        const options = [...menu.querySelectorAll<HTMLAnchorElement>('[data-lang-set]')];
        const hrefs = options.map((option) => option.href);
        expect(options).toHaveLength(LANGUAGE_OPTIONS.length);
        expect(menu.getAttribute('tabindex')).toBe('-1');
        expect(menu.getAttribute('aria-hidden')).toBe('true');
        expect(options.every((option) => option.tabIndex === -1)).toBe(true);

        trigger.click();
        expect(menu.getAttribute('aria-hidden')).toBe('false');
        expect(options.every((option) => option.tabIndex === 0)).toBe(true);

        if (closeMethod === 'Escape') {
          menu.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
          );
        } else if (closeMethod === 'backdrop') {
          document.querySelector<HTMLElement>('[data-static-lang-backdrop]')!.click();
        } else if (closeMethod === 'trigger') {
          trigger.click();
        } else {
          document.body.click();
        }
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(menu.getAttribute('aria-hidden')).toBe('true');
        expect(options.every((option) => option.tabIndex === -1)).toBe(true);
        expect(options.map((option) => option.href)).toEqual(hrefs);

        trigger.click();
        expect(menu.getAttribute('aria-hidden')).toBe('false');
        expect(options.every((option) => option.tabIndex === 0)).toBe(true);
        expect(options.map((option) => option.href)).toEqual(hrefs);
      } finally {
        dom.window.close();
      }
    },
  );

  it.each(['constructor', 'constructor-US'])(
    'rejects inherited language keys: %s',
    async (input) => {
      const { dom } = await createPickerHarness(false);
      try {
        const api = languageApi(dom);
        expect(api.normalize(input)).toBeNull();
        expect(api.htmlLang(input)).toBe('en');
        api.ensureFont(input);
        expect(dom.window.document.querySelectorAll('[data-static-lang-font]')).toHaveLength(0);
      } finally {
        dom.window.close();
      }
    },
  );

  it('enables the Vite-authored font URL instead of inventing a production path', async () => {
    const { dom } = await createPickerHarness(
      false,
      'https://musixquare.com/ar/about',
      '<link rel="stylesheet" href="/assets/noto-arabic.hash.css" data-static-lang-font-codes="ar fa ur" disabled>',
    );
    const authored = dom.window.document.querySelector<HTMLLinkElement>(
      '[data-static-lang-font-codes]',
    )!;

    expect(authored.disabled).toBe(false);
    expect(authored.href).toBe('https://musixquare.com/assets/noto-arabic.hash.css');
    expect(dom.window.document.querySelectorAll('[data-static-lang-font]')).toHaveLength(0);

    dom.window.close();
  });

  it('loads only the active About font until the full language picker opens', async () => {
    const { dom } = await createPickerHarness(false, 'https://musixquare.com/ar/about');
    const { document } = dom.window;
    const api = languageApi(dom);
    const fontLinks = () => [
      ...document.querySelectorAll<HTMLLinkElement>('link[data-static-lang-font]'),
    ];

    expect(fontLinks().map((link) => link.getAttribute('href'))).toEqual([
      '/css/fonts/noto-arabic.css',
    ]);

    api.ensureFont('fa');
    api.ensureFont('ur');
    expect(fontLinks()).toHaveLength(1);

    fontLinks()[0]?.dispatchEvent(new dom.window.Event('error'));
    expect(fontLinks()).toHaveLength(0);
    api.ensureFont('ar');
    expect(fontLinks()).toHaveLength(1);

    document.querySelector<HTMLButtonElement>('[data-static-lang-trigger]')?.click();
    expect(fontLinks()).toHaveLength(16);
    expect(fontLinks().every((link) => link.href.startsWith('https://musixquare.com/'))).toBe(true);

    dom.window.close();
  });

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

    expect(api.options).toHaveLength(LANGUAGE_OPTIONS.length);
    expect(options).toHaveLength(api.options.length);
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.getAttribute('aria-labelledby')).toBe(current.id);
    expect(current.lang).toBe('en');

    const filipino = options.find((option) => option.dataset.langSet === 'fil');
    expect(filipino?.querySelector('.static-lang-option__native')?.textContent).toBe('Filipino');
    expect(filipino?.querySelector('.static-lang-option__english')?.textContent).toBe(
      'Philippines',
    );

    for (const [index, option] of options.entries()) {
      expect(option.dataset.langSet).toBe(api.options[index].code);
      expect(option.querySelector<HTMLElement>('.static-lang-option__native')?.lang).toBe(
        api.options[index].htmlLang,
      );
      expect(option.querySelector<HTMLElement>('.static-lang-option__native')?.dir).toBe(
        api.direction(api.options[index].code),
      );
      expect(option.querySelector<HTMLElement>('.static-lang-option__english')?.lang).toBe('en');
    }

    dom.window.close();
  });

  it('keeps Arabic, Persian, Hebrew, and Urdu RTL without reversing other locales', async () => {
    const { dom } = await createPickerHarness(false);
    const api = languageApi(dom);

    for (const { code } of api.options) {
      expect(api.direction(code), code).toBe(
        ['ar', 'fa', 'he', 'ur'].includes(code) ? 'rtl' : 'ltr',
      );
    }

    dom.window.close();
  });

  it('lets the About pathname own the language ahead of legacy query and storage hints', async () => {
    const english = await createPickerHarness(false, 'https://musixquare.com/about?lang=ko');
    english.dom.window.localStorage.setItem('mxqr-landing-lang', 'ja');
    expect(languageApi(english.dom).resolve('ko')).toBe('en');
    english.dom.window.close();

    const japanese = await createPickerHarness(false, 'https://musixquare.com/ja/about?lang=en');
    japanese.dom.window.localStorage.setItem('mxqr-landing-lang', 'ko');
    expect(languageApi(japanese.dom).resolve('en')).toBe('ja');
    japanese.dom.window.close();
  });

  it('maps generic Norwegian URLs to the supported Bokmål locale', async () => {
    const norwegian = await createPickerHarness(false, 'https://musixquare.com/no/about');
    expect(languageApi(norwegian.dom).resolve('en')).toBe('nb');
    expect(languageApi(norwegian.dom).htmlLang('nb')).toBe('nb-NO');
    norwegian.dom.window.close();
  });

  it('renders locale counterparts as real links without carrying the legacy lang query', async () => {
    const { dom } = await createPickerHarness(
      false,
      'https://musixquare.com/ja/about?lang=ko&campaign=launch#features',
    );
    const options = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('[data-lang-set]')];
    const english = options.find((option) => option.dataset.langSet === 'en');
    const korean = options.find((option) => option.dataset.langSet === 'ko');

    expect(options.every((option) => option.tagName === 'A')).toBe(true);
    expect(english?.getAttribute('href')).toBe('/about?campaign=launch#features');
    expect(korean?.getAttribute('href')).toBe('/ko/about?campaign=launch#features');

    dom.window.close();
  });

  it('persists the choice for the app without performing a soft URL rewrite', async () => {
    const { dom } = await createPickerHarness(false);
    const replaceState = vi.spyOn(dom.window.history, 'replaceState');
    const softChange = vi.fn();
    dom.window.addEventListener('mxqr:static-language-change', softChange);

    languageApi(dom).persist('ko');

    expect(dom.window.localStorage.getItem('mxqr-landing-lang')).toBe('ko');
    expect(dom.window.localStorage.getItem('musixquare-lang')).toBe('ko');
    expect(replaceState).not.toHaveBeenCalled();
    expect(softChange).not.toHaveBeenCalled();
    expect(dom.window.location.pathname).toBe('/about');

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
    const options = [...document.querySelectorAll<HTMLAnchorElement>('[data-lang-set]')];

    document.querySelector<HTMLButtonElement>('[data-static-lang-trigger]')!.click();
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
