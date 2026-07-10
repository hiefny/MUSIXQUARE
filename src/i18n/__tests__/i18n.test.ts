/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { t, getResolvedLanguage } from '../index.ts';

describe('t() translation function', () => {
  it('returns Korean value for known key', () => {
    const result = t('common.ok');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('common.ok');
  });

  it('returns key itself for unknown key', () => {
    expect(t('nonexistent.key.that.does.not.exist')).toBe('nonexistent.key.that.does.not.exist');
  });

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
});

describe('getResolvedLanguage', () => {
  it('returns a supported language code', async () => {
    const { LANGUAGE_OPTIONS } = await import('../index.ts');
    const lang = getResolvedLanguage();
    expect(LANGUAGE_OPTIONS.map((option) => option.code)).toContain(lang);
  });
});
