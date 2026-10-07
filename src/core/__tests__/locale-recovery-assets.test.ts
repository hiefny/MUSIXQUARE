import { describe, expect, it } from 'vitest';
import { loadAppLocaleRecoveryData } from '../../../scripts/translation-catalog.ts';
import {
  createLocaleRecoveryAssets,
  localeRecoveryAssets,
} from '../../../scripts/locale-recovery-assets.ts';
import { LANGUAGE_OPTIONS } from '../../i18n/locales.ts';
import en from '../../i18n/en.ts';
import ar, { pluralMessages } from '../../i18n/ar.ts';
import ja from '../../i18n/ja.ts';

describe('locale recovery production assets', () => {
  it('serializes all lazy dictionaries and their plural forms as data at one revision', async () => {
    const data = await loadAppLocaleRecoveryData(process.cwd());
    expect([...data.keys()]).toEqual(
      LANGUAGE_OPTIONS.map(({ code }) => code).filter((code) => !['en', 'ko'].includes(code)),
    );
    expect(data.get('ar')).toEqual({ version: 1, locale: 'ar', dictionary: ar, pluralMessages });
    expect(data.get('ja')).toEqual({
      version: 1,
      locale: 'ja',
      dictionary: ja,
      pluralMessages: {},
    });
    for (const value of data.values())
      expect(Object.keys(value.dictionary).sort()).toEqual(Object.keys(en).sort());
    const generated = createLocaleRecoveryAssets(data);
    expect(generated.assets.size).toBe(data.size);
    for (const [code, value] of data) {
      expect(generated.urls[code]).toMatch(
        /^\/assets\/locale-recovery-[a-z-]+-[A-Za-z0-9_-]{8}\.json$/u,
      );
      expect(JSON.parse(generated.assets.get(generated.urls[code]!.slice(1))!)).toEqual(value);
    }
  });

  it('changes only a modified locale URL and never emits a mutable manifest', () => {
    const before = createLocaleRecoveryAssets(
      new Map([
        ['ja', { word: 'old' }],
        ['ar', { word: 'same' }],
      ]),
    );
    const after = createLocaleRecoveryAssets(
      new Map([
        ['ja', { word: 'new' }],
        ['ar', { word: 'same' }],
      ]),
    );
    expect(after.urls.ja).not.toBe(before.urls.ja);
    expect(after.urls.ar).toBe(before.urls.ar);
    expect(
      [...after.assets.keys()].every((name) => name.startsWith('assets/locale-recovery-')),
    ).toBe(true);
    expect(localeRecoveryAssets().name).toBe('MUSIXQUARE-locale-recovery-assets');
  });
});
