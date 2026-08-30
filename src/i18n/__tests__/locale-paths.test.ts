import { describe, expect, it } from 'vitest';

import {
  LANGUAGE_OPTIONS,
  appLanguageFromPathname,
  localizedAboutPath,
  localizedAppPath,
} from '../locales.ts';

describe('localized canonical paths', () => {
  it('uses unprefixed canonical URLs for English and locale prefixes for every other language', () => {
    expect(localizedAppPath('en')).toBe('/');
    expect(localizedAboutPath('en')).toBe('/about');

    for (const option of LANGUAGE_OPTIONS.filter(({ code }) => code !== 'en')) {
      expect(localizedAppPath(option.code)).toBe(`/${option.code}/`);
      expect(localizedAboutPath(option.code)).toBe(`/${option.code}/about`);
    }
  });

  it('recognizes only canonical app and About locale routes', () => {
    expect(appLanguageFromPathname('/ko/')).toBe('ko');
    expect(appLanguageFromPathname('/pt-br/index.html')).toBe('pt-br');
    expect(appLanguageFromPathname('/')).toBeNull();
    expect(appLanguageFromPathname('/ko')).toBeNull();
    expect(appLanguageFromPathname('/123456')).toBeNull();
    expect(appLanguageFromPathname('/blog')).toBeNull();
  });
});
