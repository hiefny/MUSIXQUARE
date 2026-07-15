import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { LANGUAGE_OPTIONS } from '../index.ts';

type LandingDictionary = Record<string, Record<string, string>>;
type StaticLanguageOption = { code: string };

async function loadLandingDictionary(): Promise<LandingDictionary> {
  const source = await readFile('public/landing-i18n.js', 'utf8');
  const marker = '  function normalizeSelection(lang) {';
  expect(source).toContain(marker);

  const windowObject: Record<string, unknown> = {};
  vm.runInNewContext(
    source.replace(marker, `  window.__landingI18n = i18n;\n  return;\n${marker}`),
    { window: windowObject },
  );
  return windowObject.__landingI18n as LandingDictionary;
}

async function loadStaticLanguageOptions(): Promise<StaticLanguageOption[]> {
  const source = await readFile('public/static-language.js', 'utf8');
  const marker = '  var optionByCode = {};';
  expect(source).toContain(marker);

  const windowObject: Record<string, unknown> = {};
  vm.runInNewContext(
    source.replace(marker, `  window.__staticLanguageOptions = OPTIONS;\n  return;\n${marker}`),
    {
      window: windowObject,
    },
  );
  return windowObject.__staticLanguageOptions as StaticLanguageOption[];
}

describe('landing-page translation integrity', () => {
  it('keeps the app, landing dictionaries, and static language picker in sync', async () => {
    const [dictionaries, options] = await Promise.all([
      loadLandingDictionary(),
      loadStaticLanguageOptions(),
    ]);

    const appLanguages = LANGUAGE_OPTIONS.map(({ code }) => code).sort();
    expect(Object.keys(dictionaries).sort()).toEqual(appLanguages);
    expect(options.map(({ code }) => code).sort()).toEqual(appLanguages);
  });

  it('defines every English key with non-empty copy in every language', async () => {
    const dictionaries = await loadLandingDictionary();
    const englishKeys = Object.keys(dictionaries.en).sort();

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      expect(Object.keys(dictionary).sort(), language).toEqual(englishKeys);
      expect(
        Object.entries(dictionary).filter(
          ([, value]) => typeof value !== 'string' || !value.trim(),
        ),
        language,
      ).toEqual([]);
    }
  });

  it('preserves functional markup and placeholders from the English source', async () => {
    const dictionaries = await loadLandingDictionary();
    const tags = (value: string): string[] => value.match(/<\/?[a-z][^>]*>/gi) || [];
    const placeholders = (value: string): string[] => (value.match(/\{\{\w+\}\}/g) || []).sort();

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      for (const [key, englishValue] of Object.entries(dictionaries.en)) {
        expect(tags(dictionary[key]), `${language}.${key}`).toEqual(tags(englishValue));
        expect(placeholders(dictionary[key]), `${language}.${key}`).toEqual(
          placeholders(englishValue),
        );
      }
    }
  });

  it('describes system-audio support by computer class, not Windows/Mac hardware labels', async () => {
    const dictionaries = await loadLandingDictionary();
    const desktopHardwareTerms =
      /desktop browser|デスクトップ.*Chromium|桌面版.*Chromium|เดสก์ท็อป.*Chromium|masaüstü.*Chromium/i;

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      expect(dictionary['standin.platform_value'], language).not.toMatch(/windows|mac(?:os)?/i);
      expect(dictionary['standin.platform_value'], language).not.toMatch(desktopHardwareTerms);
    }
    expect(dictionaries.en['standin.platform_value']).toBe('Chromium-based browsers on computers');
    expect(dictionaries.ko['standin.platform_value']).toBe('컴퓨터의 Chromium 기반 브라우저');
  });
});
