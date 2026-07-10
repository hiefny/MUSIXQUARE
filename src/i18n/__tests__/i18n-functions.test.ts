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
      // Should return Korean string, not the key itself
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
      // Use a key that has a placeholder — we test the mechanism
      // Even if key doesn't exist, interpolation still works on fallback
      const result = t('test.{{name}}.greeting', { name: 'World' });
      expect(result).toBe('test.World.greeting');
    });

    it('replaces multiple placeholders', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { t } = await import('../index.ts');
      // Key doesn't exist → returns key with placeholders replaced
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
      // Saved 'en' overrides system 'ko'
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

      // Re-selecting the locale must re-run the import: absence = retryable.
      // A poisoned _dicts entry (the old `_dicts[code] = en` negative cache)
      // would short-circuit the load gates and pin English until full reload.
      failJaImport = false;
      setLanguageMode('ja'); // fire-and-forget (void _setLanguageMode)
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
        // Completion marker: the assertions below must sample AFTER the late
        // ja module has actually been delivered, otherwise a broken stale-
        // guard could stomp ko after the test already passed (vacuous pin).
        lateJaModuleLoaded = true;
        return mod;
      });

      const { initI18n, setLanguageMode, getResolvedLanguage, t } = await import('../index.ts');
      const { bus } = await import('../../core/events.ts');
      const { default: ko } = await vi.importActual<typeof import('../ko.ts')>('../ko.ts');

      await initI18n(); // ja chunk fails: English frame, retry stays possible

      jaBehavior = 'slow';
      setLanguageMode('ja'); // retry import now pending inside the mock factory
      await vi.waitFor(() => {
        expect(releaseSlowJa).toBeTypeOf('function');
      });

      // User switches away before the slow retry resolves. Preloaded ko takes
      // the synchronous fast path (zero awaits before DOM translation).
      setLanguageMode('ko');
      expect(t('setup.host_button')).toBe(ko['setup.host_button']);
      expect(document.querySelector('button')?.textContent).toBe(ko['setup.host_button']);

      // Capture emissions from here on. Pure DELETION of the stale-guard is
      // invisible to DOM/getResolvedLanguage (the late subtree re-translation
      // reads the dict for the current _resolved, still ko) and is observable
      // ONLY as a spurious 'i18n:changed' carrying 'ja'.
      const emissions: string[] = [];
      const off = bus.on('i18n:changed', (lang) => {
        emissions.push(lang);
      });
      try {
        // Late ja resolution must hit the `_resolved !== resolved` stale-guard
        // in _translateLoadedLanguage and leave the newer selection untouched.
        releaseSlowJa?.();
        await vi.waitFor(() => {
          expect(lateJaModuleLoaded).toBe(true);
        });
        // Past the marker, the remaining continuations (.then dict store,
        // .finally in-flight cleanup, Promise.all, the _applyLanguage tail
        // into _translateLoadedLanguage) are pure microtasks; one macrotask
        // flush guarantees the would-be stomp has landed before sampling.
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

      // Network recovers: the gated 'online' listener retries without any
      // user action (saved-locale startup pin had no re-select to heal it).
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
      await initI18n(); // real ja dict loads successfully (no mock here)

      const emissions: string[] = [];
      const off = bus.on('i18n:changed', (lang) => {
        emissions.push(lang);
      });
      try {
        // Connectivity flap with the dict present must not re-apply the
        // language: an ungated listener would re-emit 'i18n:changed' and
        // churn every re-render subscriber on each flap.
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
