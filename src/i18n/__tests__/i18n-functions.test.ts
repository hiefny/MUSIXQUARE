/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      initI18n();
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
      initI18n();
      expect(t('nonexistent.key.here')).toBe('nonexistent.key.here');
    });

    it('interpolates {{param}} placeholders', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { t, initI18n } = await import('../index.ts');
      initI18n();
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
      const result = tHtml("{{val}}", { val: "it's" });
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
      initI18n();
      expect(getResolvedLanguage()).toBe('ko');
    });

    it('returns "en" when system language is English', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      initI18n();
      expect(getResolvedLanguage()).toBe('en');
    });

    it('returns "en" for non-Korean languages (fallback)', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ja-JP'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      initI18n();
      expect(getResolvedLanguage()).toBe('en');
    });
  });

  describe('setLanguageMode()', () => {
    it('persists language choice to localStorage', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { setLanguageMode, initI18n } = await import('../index.ts');
      initI18n();
      setLanguageMode('ko');
      expect(localStorage.getItem('musixquare-lang')).toBe('ko');
    });

    it('sets lang attribute on html element', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { setLanguageMode, initI18n } = await import('../index.ts');
      initI18n();
      setLanguageMode('ko');
      expect(document.documentElement.getAttribute('lang')).toBe('ko');
    });

    it('falls back to "system" for invalid mode', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['en-US'],
        configurable: true,
      });
      const { setLanguageMode, initI18n } = await import('../index.ts');
      initI18n();
      setLanguageMode('invalid');
      expect(localStorage.getItem('musixquare-lang')).toBe('system');
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
      initI18n();
      // Saved 'en' overrides system 'ko'
      expect(getResolvedLanguage()).toBe('en');
    });

    it('uses system language when no saved preference', async () => {
      Object.defineProperty(navigator, 'languages', {
        value: ['ko-KR'],
        configurable: true,
      });
      const { getResolvedLanguage, initI18n } = await import('../index.ts');
      initI18n();
      expect(getResolvedLanguage()).toBe('ko');
    });
  });
});
