/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// i18n/index.ts reads localStorage and navigator.languages at module scope.
// We test via dynamic import after setting up mocks.

describe('i18n functions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
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
      expect(t('nonexistent.key.here')).toBe('nonexistent.key.here');
    });

    it('interpolates {{param}} placeholders', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { t, initI18n } = await import('../index.ts');
      await initI18n();
      const result = t('test.{{name}}.greeting', { name: 'World' });
      expect(result).toBe('test.World.greeting');
    });

    it('replaces multiple placeholders', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { t } = await import('../index.ts');
      const result = t('{{a}} and {{b}}', { a: 'X', b: 'Y' });
      expect(result).toBe('X and Y');
    });

    it('handles numeric placeholder values', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { t } = await import('../index.ts');
      const result = t('count: {{n}}', { n: 42 });
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
      const result = tHtml('hello {{name}}', { name: '<script>alert("xss")</script>' });
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes ampersands', async () => {
      Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
      const { tHtml } = await import('../index.ts');
      const result = tHtml('{{val}}', { val: 'A & B' });
      expect(result).toBe('A &amp; B');
    });

    it('escapes quotes', async () => {
      Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
      const { tHtml } = await import('../index.ts');
      const result = tHtml('{{val}}', { val: 'say "hello"' });
      expect(result).toContain('&quot;');
    });

    it('escapes single quotes', async () => {
      Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
      const { tHtml } = await import('../index.ts');
      const result = tHtml('{{val}}', { val: "it's" });
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

      // A failed locale must remain absent from the dictionary cache so a
      // later selection retries the chunk instead of pinning the fallback.
      failJaImport = false;
      setLanguageMode('ja');
      await vi.waitFor(() => {
        expect(t('setup.host_button')).toBe(ja['setup.host_button']);
      });
      expect(document.querySelector('button')?.textContent).toBe(ja['setup.host_button']);
    });

    it('does not let a late lazy-locale retry stomp a newer language selection', async () => {
      localStorage.setItem('musixquare-lang', 'ja');
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      document.body.innerHTML = '<button data-i18n="setup.host_button"></button>';

      let jaBehavior: 'fail' | 'slow' = 'fail';
      let releaseSlowJa: (() => void) | null = null;
      let lateJaModuleLoaded = false;
      vi.doMock('../ja.ts', async (importOriginal) => {
        if (jaBehavior === 'fail') throw new Error('simulated lazy chunk 404');
        await new Promise<void>((resolve) => {
          releaseSlowJa = () => resolve();
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
        expect(releaseSlowJa).toBeTypeOf('function');
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
        releaseSlowJa?.();
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
