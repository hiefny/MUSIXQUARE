import { describe, it, expect } from 'vitest';
import ko from '../ko.ts';
import en from '../en.ts';
import ar from '../ar.ts';
import de from '../de.ts';
import es from '../es.ts';
import fil from '../fil.ts';
import fr from '../fr.ts';
import hi from '../hi.ts';
import id from '../id.ts';
import italian from '../it.ts';
import ja from '../ja.ts';
import pl from '../pl.ts';
import ptBr from '../pt-br.ts';
import ru from '../ru.ts';
import th from '../th.ts';
import tr from '../tr.ts';
import vi from '../vi.ts';
import zhHans from '../zh-hans.ts';
import zhHant from '../zh-hant.ts';

const koKeys = Object.keys(ko);
const locales = {
  ko,
  en,
  ar,
  de,
  es,
  fil,
  fr,
  hi,
  id,
  italian,
  ja,
  pl,
  ptBr,
  ru,
  th,
  tr,
  vi,
  zhHans,
  zhHant,
};

describe('Translation key integrity', () => {
  it('all locales have the same number of keys as ko', () => {
    for (const [locale, dict] of Object.entries(locales)) {
      expect(Object.keys(dict), locale).toHaveLength(koKeys.length);
    }
  });

  it('every ko key exists in each locale', () => {
    for (const [locale, dict] of Object.entries(locales)) {
      const missing = koKeys.filter((k) => !(k in dict));
      expect(missing, locale).toEqual([]);
    }
  });

  it('every locale key exists in ko', () => {
    for (const [locale, dict] of Object.entries(locales)) {
      const extra = Object.keys(dict).filter((k) => !(k in ko));
      expect(extra, locale).toEqual([]);
    }
  });

  it('no empty values in any locale', () => {
    for (const [locale, dict] of Object.entries(locales)) {
      const empty = Object.entries(dict).filter(([, value]) => !value);
      expect(empty, locale).toEqual([]);
    }
  });

  it('{{param}} placeholders match between ko and every locale', () => {
    const paramRe = /\{\{(\w+)\}\}/g;
    const mismatched: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of koKeys) {
        const koVal = ko[key as keyof typeof ko] || '';
        const localeVal = dict[key as keyof typeof dict] || '';

        const koParams = [...koVal.matchAll(paramRe)].map((m) => m[1]).sort();
        const localeParams = [...localeVal.matchAll(paramRe)].map((m) => m[1]).sort();

        if (JSON.stringify(koParams) !== JSON.stringify(localeParams)) {
          mismatched.push(
            `${locale}.${key}: ko=${koParams.join(',')} ${locale}=${localeParams.join(',')}`,
          );
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('HTML tag sequences match English in every locale', () => {
    const tagRe = /<[^>]+>/g;
    const mismatched: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      if (locale === 'ko') continue;
      for (const key of Object.keys(en)) {
        const enVal = en[key as keyof typeof en] || '';
        if (!enVal.includes('<')) continue;

        const localeVal = dict[key as keyof typeof dict] || '';
        const enTags = [...enVal.matchAll(tagRe)].map((m) => m[0]);
        const localeTags = [...localeVal.matchAll(tagRe)].map((m) => m[0]);

        if (JSON.stringify(enTags) !== JSON.stringify(localeTags)) {
          mismatched.push(`${locale}.${key}`);
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('no machine-translation protection tokens remain in locale values', () => {
    const tokenRe = /(?:ZXQ[A-Z0-9]+QXZ|QZX[A-Z0-9]+XZQ|ZXQZX[A-Z0-9]+)/;
    const leaked: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      for (const [key, value] of Object.entries(dict)) {
        if (tokenRe.test(value)) leaked.push(`${locale}.${key}`);
      }
    }

    expect(leaked).toEqual([]);
  });
});
