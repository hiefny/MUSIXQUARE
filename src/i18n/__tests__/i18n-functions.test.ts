/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { I18nKey } from '../index.ts';

// i18n/index.ts reads localStorage and navigator.languages at module scope.
// We test via dynamic import after setting up mocks.

describe('i18n functions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
    localStorage.clear();
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('lang');
  });

  describe('t()', () => {
    it('returns Korean translation by default (system → ko)', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ko-KR'],
        configurable: true,
      });
      Object.defineProperty(navigator, 'language', {
        value: 'ko-KR',
        configurable: true,
      });
      const { t, initI18n } = await import('../index.ts');
      await initI18n();
      const result = t('common.ok');
      expect(result).not.toBe('common.ok');
      expect(typeof result).toBe('string');
    });

    it('returns the key itself for missing translations', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ko-KR'],
        configurable: true,
      });
      const { t, initI18n } = await import('../index.ts');
      await initI18n();
      expect(t('nonexistent.key.here' as I18nKey)).toBe('nonexistent.key.here');
    });

    it('interpolates {{param}} placeholders', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { t, initI18n } = await import('../index.ts');
      await initI18n();
      const result = t('test.{{name}}.greeting' as I18nKey, { name: 'World' });
      expect(result).toBe('test.World.greeting');
    });

    it('replaces multiple placeholders', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { t } = await import('../index.ts');
      const result = t('{{a}} and {{b}}' as I18nKey, { a: 'X', b: 'Y' });
      expect(result).toBe('X and Y');
    });

    it('handles numeric placeholder values', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { t } = await import('../index.ts');
      const result = t('count: {{n}}' as I18nKey, { n: 42 });
      expect(result).toBe('count: 42');
    });
  });

  describe('tHtml()', () => {
    it('escapes HTML special characters in params', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { tHtml } = await import('../index.ts');
      const result = tHtml('hello {{name}}' as I18nKey, {
        name: '<script>alert("xss")</script>',
      });
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes ampersands', async () => {
      Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
      const { tHtml } = await import('../index.ts');
      const result = tHtml('{{val}}' as I18nKey, { val: 'A & B' });
      expect(result).toBe('A &amp; B');
    });

    it('escapes quotes', async () => {
      Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
      const { tHtml } = await import('../index.ts');
      const result = tHtml('{{val}}' as I18nKey, { val: 'say "hello"' });
      expect(result).toContain('&quot;');
    });

    it('escapes single quotes', async () => {
      Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
      const { tHtml } = await import('../index.ts');
      const result = tHtml('{{val}}' as I18nKey, { val: "it's" });
      expect(result).toContain('&#39;');
    });
  });

  describe('getResolvedLanguage()', () => {
    it('returns "ko" when system language is Korean', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ko-KR', 'en-US'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('ko');
    });

    it('returns "en" when system language is English', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('en');
    });

    it('returns a supported non-English language when available', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ja-JP'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('ja');
    });

    it('returns "en" for unsupported languages (fallback)', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['sw-KE'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('en');
    });

    it('returns "ru" when system language is Russian', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ru-RU'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('ru');
    });

    it('maps traditional Chinese system locales', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['zh-TW'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('zh-hant');
    });
  });

  describe('setLanguageMode()', () => {
    it('persists language choice to localStorage', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { setLanguageMode, initI18n } = await import('../index.ts');
      await initI18n();
      setLanguageMode('ko');
      expect(localStorage.getItem('musixquare-lang')).toBe('ko');
    });

    it('sets lang attribute on html element', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { setLanguageMode, initI18n } = await import('../index.ts');
      await initI18n();
      setLanguageMode('ko');
      expect(document.documentElement.getAttribute('lang')).toBe('ko');
    });

    it('requests a full-document locale counterpart when a localized app path owns the URL', async () => {
      window.history.replaceState(null, '', '/ko/?campaign=launch#player');
      localStorage.setItem('musixquare-lang', 'en');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { setLanguageMode, initI18n } = await import('../index.ts');
      await initI18n();
      expect(localStorage.getItem('musixquare-lang')).toBe('en');

      const navigationRequests: string[] = [];
      window.addEventListener(
        'mxqr:locale-navigation-request',
        (event) => {
          navigationRequests.push((event as CustomEvent<{ href: string }>).detail.href);
          event.preventDefault();
        },
        { once: true },
      );
      const replaceState = vi.spyOn(window.history, 'replaceState');

      setLanguageMode('ja');

      expect(navigationRequests).toEqual(['/ja/?campaign=launch#player']);
      expect(localStorage.getItem('musixquare-lang')).toBe('ja');
      expect(replaceState).not.toHaveBeenCalled();
      // The cancelable request is a test seam. An uncancelled browser event
      // continues to Location.assign(), replacing the whole document/head.
      expect(window.location.pathname).toBe('/ko/');
      expect(window.location.search).toBe('?campaign=launch');
      expect(window.location.hash).toBe('#player');
    });

    it('uses the explicit English entry when switching from another localized app path', async () => {
      window.history.replaceState(null, '', '/ko/?campaign=launch#player');
      localStorage.setItem('musixquare-lang', 'ko');
      const navigationRequests: string[] = [];
      window.addEventListener(
        'mxqr:locale-navigation-request',
        (event) => {
          navigationRequests.push((event as CustomEvent<{ href: string }>).detail.href);
          event.preventDefault();
        },
        { once: true },
      );

      const { initI18n, setLanguageMode } = await import('../index.ts');
      await initI18n();
      setLanguageMode('en');

      expect(navigationRequests).toEqual(['/en/?campaign=launch#player']);
      expect(localStorage.getItem('musixquare-lang')).toBe('en');
      expect(window.location.pathname).toBe('/ko/');
    });

    it('does not move the root app or a six-digit room URL when the UI language changes', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const navigationRequest = vi.fn((event: Event) => event.preventDefault());
      window.addEventListener('mxqr:locale-navigation-request', navigationRequest);
      const rootI18n = await import('../index.ts');
      await rootI18n.initI18n();
      rootI18n.setLanguageMode('ko');
      expect(window.location.pathname).toBe('/');
      expect(rootI18n.getResolvedLanguage()).toBe('ko');

      vi.resetModules();
      window.history.replaceState(null, '', '/123456?source=invite#queue');
      localStorage.setItem('musixquare-lang', 'en');
      const roomI18n = await import('../index.ts');
      await roomI18n.initI18n();
      roomI18n.setLanguageMode('ko');

      expect(window.location.pathname).toBe('/123456');
      expect(window.location.search).toBe('?source=invite');
      expect(window.location.hash).toBe('#queue');
      expect(roomI18n.getResolvedLanguage()).toBe('ko');
      expect(navigationRequest).not.toHaveBeenCalled();
      window.removeEventListener('mxqr:locale-navigation-request', navigationRequest);
    });

    it('treats the English app alias as URL-owned when selecting another locale', async () => {
      window.history.replaceState(null, '', '/en/?campaign=launch#player');
      localStorage.setItem('musixquare-lang', 'ja');
      const navigationRequests: string[] = [];
      window.addEventListener(
        'mxqr:locale-navigation-request',
        (event) => {
          navigationRequests.push((event as CustomEvent<{ href: string }>).detail.href);
          event.preventDefault();
        },
        { once: true },
      );

      const { getResolvedLanguage, initI18n, setLanguageMode } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('en');
      expect(localStorage.getItem('musixquare-lang')).toBe('ja');

      setLanguageMode('ko');

      expect(navigationRequests).toEqual(['/ko/?campaign=launch#player']);
      expect(localStorage.getItem('musixquare-lang')).toBe('ko');
      expect(window.location.pathname).toBe('/en/');
    });

    it('re-projects a live YouTube iframe accessibility title without component listeners', async () => {
      localStorage.setItem('musixquare-lang', 'en');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      document.body.innerHTML =
        '<iframe id="youtube-frame" data-i18n-title="common.youtube_video"></iframe>';

      const { setLanguageMode, initI18n } = await import('../index.ts');
      const { default: en } = await vi.importActual<typeof import('../en.ts')>('../en.ts');
      const { default: ko } = await vi.importActual<typeof import('../ko.ts')>('../ko.ts');
      await initI18n();

      const iframe = document.querySelector<HTMLIFrameElement>('#youtube-frame');
      expect(iframe?.title).toBe(en['common.youtube_video']);

      setLanguageMode('ko');
      await vi.waitFor(() => {
        expect(iframe?.title).toBe(ko['common.youtube_video']);
      });
    });

    it('falls back to system mode for invalid mode', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { setLanguageMode, initI18n } = await import('../index.ts');
      await initI18n();
      setLanguageMode('invalid');
      expect(localStorage.getItem('musixquare-lang')).toBe('system');
    });

    it('persists system mode while resolving to the browser language', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ja-JP'],
        configurable: true,
      });
      const { getLanguageMode, getResolvedLanguage, setLanguageMode, initI18n } =
        await import('../index.ts');
      await initI18n();
      setLanguageMode('system');
      expect(localStorage.getItem('musixquare-lang')).toBe('system');
      expect(getLanguageMode()).toBe('system');
      expect(getResolvedLanguage()).toBe('ja');
    });

    it('keeps the language mode buttons visually and semantically aligned', async () => {
      localStorage.setItem('musixquare-lang', 'en');
      document.body.innerHTML = `
        <div id="grid-lang">
          <button class="ch-opt" data-lang-action="select" aria-pressed="false"></button>
          <button class="ch-opt" data-lang-action="system" aria-pressed="false"></button>
        </div>
      `;
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { setLanguageMode, initI18n } = await import('../index.ts');
      await initI18n();

      const select = document.querySelector<HTMLElement>('[data-lang-action="select"]');
      const system = document.querySelector<HTMLElement>('[data-lang-action="system"]');
      expect(select?.classList.contains('active')).toBe(true);
      expect(select?.getAttribute('aria-pressed')).toBe('true');
      expect(system?.classList.contains('active')).toBe(false);
      expect(system?.getAttribute('aria-pressed')).toBe('false');

      setLanguageMode('system');

      expect(select?.classList.contains('active')).toBe(false);
      expect(select?.getAttribute('aria-pressed')).toBe('false');
      expect(system?.classList.contains('active')).toBe(true);
      expect(system?.getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('initI18n()', () => {
    it('reads saved language from localStorage', async () => {
      localStorage.setItem('musixquare-lang', 'en');
      Object.defineProperty(navigator, 'languages', {
        value: ['ko-KR'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('en');
    });

    it('uses system language when no saved preference', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ko-KR'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      await initI18n();
      expect(getResolvedLanguage()).toBe('ko');
    });

    it.each(['system', 'ko'])(
      'lets a non-English pathname control this document without replacing the saved %s preference',
      async (savedPreference) => {
        window.history.replaceState(null, '', '/ja/');
        localStorage.setItem('musixquare-lang', savedPreference);
        Object.defineProperty(navigator, 'languages', {
          value: ['en-US'],
          configurable: true,
        });
        const { getLanguageMode, getResolvedLanguage, initI18n } = await import('../index.ts');

        await initI18n();

        expect(getLanguageMode()).toBe('ja');
        expect(getResolvedLanguage()).toBe('ja');
        expect(localStorage.getItem('musixquare-lang')).toBe(savedPreference);
      },
    );

    it.each(['system', 'ja'])(
      'lets the English alias control this document without replacing the saved %s preference',
      async (savedPreference) => {
        window.history.replaceState(null, '', '/en/');
        localStorage.setItem('musixquare-lang', savedPreference);
        Object.defineProperty(navigator, 'languages', {
          value: ['ko-KR'],
          configurable: true,
        });
        const { getLanguageMode, getResolvedLanguage, initI18n } = await import('../index.ts');

        await initI18n();

        expect(getLanguageMode()).toBe('en');
        expect(getResolvedLanguage()).toBe('en');
        expect(localStorage.getItem('musixquare-lang')).toBe(savedPreference);
      },
    );

    it('keeps a six-digit room pathname outside locale ownership', async () => {
      window.history.replaceState(null, '', '/123456');
      localStorage.setItem('musixquare-lang', 'ko');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');

      await initI18n();

      expect(getResolvedLanguage()).toBe('ko');
      expect(window.location.pathname).toBe('/123456');
    });

    it('loads a saved lazy language before resolving initial DOM translation', async () => {
      localStorage.setItem('musixquare-lang', 'ja');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      document.body.innerHTML = '<button data-i18n="setup.host_button"></button>';

      const { initI18n, t } = await import('../index.ts');
      await initI18n();
      const { default: ja } = await import('../ja.ts');

      expect(t('setup.host_button')).toBe(ja['setup.host_button']);
      expect(document.querySelector('button')?.textContent).toBe(ja['setup.host_button']);
    });
  });

  describe('lazy locale chunk failure (no negative cache)', () => {
    afterEach(() => {
      vi.doUnmock('../ja.ts');
    });

    it('falls back to English on a failed lazy chunk and genuinely retries on re-select', async () => {
      localStorage.setItem('musixquare-lang', 'ja');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      document.body.innerHTML = '<button data-i18n="setup.host_button"></button>';

      let failJaImport = true;
      vi.doMock('../ja.ts', async (importOriginal) => {
        if (failJaImport) throw new Error('simulated lazy chunk 404');
        return await importOriginal();
      });

      const { initI18n, setLanguageMode, getResolvedLanguage, t } = await import('../index.ts');
      const { default: en } = await vi.importActual<typeof import('../en.ts')>('../en.ts');
      const { default: ja } = await vi.importActual<typeof import('../ja.ts')>('../ja.ts');

      await initI18n();

      // Failure frame: read-time fallback renders English while the resolved
      // language remains the requested one (graceful, non-throwing startup).
      expect(t('setup.host_button')).toBe(en['setup.host_button']);
      expect(document.querySelector('button')?.textContent).toBe(en['setup.host_button']);
      expect(getResolvedLanguage()).toBe('ja');
      expect(document.documentElement.getAttribute('lang')).toBe('en');

      // A failed locale must remain absent from the dictionary cache so a
      // later selection retries the chunk instead of pinning the fallback.
      failJaImport = false;
      setLanguageMode('ja');
      await vi.waitFor(() => {
        expect(t('setup.host_button')).toBe(ja['setup.host_button']);
      });
      expect(document.querySelector('button')?.textContent).toBe(ja['setup.host_button']);
      expect(document.documentElement.getAttribute('lang')).toBe('ja');
    });

    it('does not let a late lazy-locale retry stomp a newer language selection', async () => {
      localStorage.setItem('musixquare-lang', 'ja');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      document.body.innerHTML = '<button data-i18n="setup.host_button"></button>';

      let jaBehavior: 'fail' | 'slow' = 'fail';
      const slowJaRequest = { release: null as (() => void) | null };
      let lateJaModuleLoaded = false;
      vi.doMock('../ja.ts', async (importOriginal) => {
        if (jaBehavior === 'fail') throw new Error('simulated lazy chunk 404');
        await new Promise<void>((resolve) => {
          slowJaRequest.release = () => resolve();
        });
        const mod = await importOriginal();
        // The test must sample after the delayed module is delivered; sampling
        // earlier would miss a stale completion overwriting the newer locale.
        lateJaModuleLoaded = true;
        return mod;
      });

      const { initI18n, setLanguageMode, getResolvedLanguage, t } = await import('../index.ts');
      const { bus } = await import('../../core/events.ts');
      const { default: ko } = await vi.importActual<typeof import('../ko.ts')>('../ko.ts');

      await initI18n();

      jaBehavior = 'slow';
      setLanguageMode('ja');
      await vi.waitFor(() => {
        expect(slowJaRequest.release).toBeTypeOf('function');
      });

      // Switch to a preloaded locale while the retry is still unresolved.
      setLanguageMode('ko');
      expect(t('setup.host_button')).toBe(ko['setup.host_button']);
      expect(document.querySelector('button')?.textContent).toBe(ko['setup.host_button']);

      // A stale completion can leave the DOM looking correct yet still emit a
      // spurious change event, so the event stream is part of the contract.
      const emissions: string[] = [];
      const off = bus.on('i18n:changed', (lang) => {
        emissions.push(lang);
      });
      try {
        // Releasing the stale request must not replace or re-announce Korean.
        const releaseSlowJa = slowJaRequest.release;
        if (!releaseSlowJa) throw new Error('slow Japanese locale request was not captured');
        releaseSlowJa();
        await vi.waitFor(() => {
          expect(lateJaModuleLoaded).toBe(true);
        });
        // Cross a macrotask boundary so all promise continuations settle before
        // sampling the final language and event stream.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getResolvedLanguage()).toBe('ko');
        expect(t('setup.host_button')).toBe(ko['setup.host_button']);
        expect(document.querySelector('button')?.textContent).toBe(ko['setup.host_button']);
        expect(document.documentElement.getAttribute('lang')).toBe('ko');
        expect(emissions).toEqual([]);
      } finally {
        off();
      }
    });

    it("retries the failed saved locale when connectivity returns ('online')", async () => {
      localStorage.setItem('musixquare-lang', 'ja');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      document.body.innerHTML = '<button data-i18n="setup.host_button"></button>';

      let failJaImport = true;
      vi.doMock('../ja.ts', async (importOriginal) => {
        if (failJaImport) throw new Error('simulated lazy chunk 404');
        return await importOriginal();
      });

      const { initI18n, getResolvedLanguage, t } = await import('../index.ts');
      const { default: en } = await vi.importActual<typeof import('../en.ts')>('../en.ts');
      const { default: ja } = await vi.importActual<typeof import('../ja.ts')>('../ja.ts');

      await initI18n();
      expect(t('setup.host_button')).toBe(en['setup.host_button']);
      expect(getResolvedLanguage()).toBe('ja');

      // The online listener is the only retry trigger for a failed saved
      // locale when the user makes no subsequent selection.
      failJaImport = false;
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => {
        expect(t('setup.host_button')).toBe(ja['setup.host_button']);
      });
      expect(document.querySelector('button')?.textContent).toBe(ja['setup.host_button']);
    });

    it("keeps 'online' a no-op when the active lazy locale is already loaded (no i18n:changed churn)", async () => {
      localStorage.setItem('musixquare-lang', 'ja');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });

      const { initI18n } = await import('../index.ts');
      const { bus } = await import('../../core/events.ts');
      await initI18n();

      const emissions: string[] = [];
      const off = bus.on('i18n:changed', (lang) => {
        emissions.push(lang);
      });
      try {
        // Once loaded, connectivity changes must not re-announce the locale
        // and churn every translation subscriber.
        window.dispatchEvent(new Event('online'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(emissions).toEqual([]);
      } finally {
        off();
      }
    });
  });
});
