/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { t, tHtml, getResolvedLanguage, type I18nKey } from '../index.ts';

describe('t() translation function', () => {
  it('returns Korean value for known key', () => {
    const result = t('common.ok');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('common.ok');
  });

  it('returns key itself for unknown key', () => {
    expect(t('nonexistent.key.that.does.not.exist' as I18nKey)).toBe(
      'nonexistent.key.that.does.not.exist',
    );
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'keeps inherited object name %s as an unknown translation key',
    (key) => {
      for (const translate of [t, tHtml]) {
        expect(translate(key as I18nKey)).toBe(key);
        expect(translate(key as I18nKey, { count: 1, name: '<peer>' })).toBe(key);
      }
    },
  );

  it('interpolates {{name}} parameter', () => {
    const result = t('toast.device_connected', { name: 'iPhone' });
    expect(result).toContain('iPhone');
    expect(result).not.toContain('{{name}}');
  });

  it('interpolates {{count}} numeric parameter', () => {
    const result = t('toast.added_tracks', { count: 5 });
    expect(result).toContain('5');
    expect(result).not.toContain('{{count}}');
  });

  it('handles missing params gracefully (keeps placeholder)', () => {
    const result = t('toast.device_connected');
    expect(result).toContain('{{name}}');
  });

  it('interpolates multiple parameters', () => {
    const result = t('toast.device_connected', { name: 'Test' });
    expect(result).toContain('Test');
  });

  it.each([t, tHtml])('never reinterprets inserted values as template slots (%#)', (translate) => {
    for (const params of [
      { title: 'Song {{position}} $&', position: 1 },
      { position: 1, title: 'Song {{position}} $&' },
    ]) {
      const result = translate('playlist.reorder_handle', params);
      expect(result).toContain(
        translate === tHtml ? 'Song {{position}} $&amp;' : 'Song {{position}} $&',
      );
      expect(result).not.toContain('{{title}}');
      expect(result).toContain('1');
    }
  });

  it('escapes inserted HTML once while leaving unknown template slots intact', () => {
    expect(tHtml('playlist.reorder_handle', { title: '<Song {{position}}> & "test"' })).toContain(
      '&lt;Song {{position}}&gt; &amp; &quot;test&quot;',
    );
    expect(t('playlist.reorder_handle', Object.create({ title: 'Inherited' }))).toContain(
      '{{title}}',
    );
  });
});

describe('getResolvedLanguage', () => {
  it('returns a supported language code', async () => {
    const { LANGUAGE_OPTIONS } = await import('../index.ts');
    const lang = getResolvedLanguage();
    expect(LANGUAGE_OPTIONS.map((option) => option.code)).toContain(lang);
  });
});

describe('hebrew script integrity', () => {
  it('does not contain foreign Indic/Gujarati characters in he.ts', async () => {
    const heModule = await import('../he.ts');
    const catalog = heModule.default;
    for (const [key, value] of Object.entries(catalog)) {
      for (const char of value as string) {
        const code = char.codePointAt(0)!;
        expect(
          code >= 0x0900 && code <= 0x0d7f,
          `Found unexpected Indic character '${char}' (U+${code.toString(16).toUpperCase()}) in he.ts for key '${key}'`,
        ).toBe(false);
      }
    }
  });
});
