import { describe, expect, it } from 'vitest';

import { APP_DICTIONARIES, type TranslationDictionary } from '../catalogs.ts';

/**
 * PRO room registration dialog (src/pro-room/activation-account.ts), owner
 * decision 2026-10-28. The body asks pro.activation_account_message
 * ("Register this room to the “{{name}}” account?"), so the primary button is
 * a short answer to that question: ko 등록, en Register. Every other locale
 * uses the verb its own message uses, in the form its action buttons take.
 */
const KEY = 'pro.activation_account_continue';

/** The generic "continue" labels the button carried before 2026-10-28. */
const PREVIOUS_LABELS: Readonly<Record<string, string>> = {
  ar: 'متابعة',
  bg: 'Продължаване',
  bn: 'চালিয়ে যান',
  cs: 'Pokračovat',
  da: 'Fortsæt',
  de: 'Fortfahren',
  el: 'Συνέχεια',
  en: 'Continue',
  es: 'Continuar',
  fa: 'ادامه',
  fi: 'Jatka',
  fil: 'Magpatuloy',
  fr: 'Continuer',
  gu: 'આગળ વધો',
  he: 'המשך',
  hi: 'जारी रखें',
  hu: 'Folytatás',
  id: 'Lanjutkan',
  it: 'Continua',
  ja: '続行',
  kn: 'ಮುಂದುವರಿಸಿ',
  ko: '이 계정으로 등록',
  ml: 'തുടരുക',
  mr: 'पुढे जा',
  ms: 'Teruskan',
  nb: 'Fortsett',
  nl: 'Doorgaan',
  pa: 'ਅੱਗੇ ਵਧੋ',
  pl: 'Kontynuuj',
  'pt-br': 'Continuar',
  ro: 'Continuă',
  ru: 'Продолжить',
  sv: 'Fortsätt',
  ta: 'தொடர்',
  te: 'కొనసాగించు',
  th: 'ไปต่อ',
  tr: 'Devam et',
  uk: 'Продовжити',
  ur: 'جاری رکھیں',
  vi: 'Tiếp tục',
  'zh-hans': '继续',
  'zh-hant': '繼續',
};

/**
 * The dialog stacks both actions full width. Full-width action buttons hold at
 * most 22 graphemes (docs/design/short-wait-labels-2026-10-14.md §1).
 */
const FULL_WIDTH_BUTTON_MAX_GRAPHEMES = 22;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemeCount = (value: string): number => [...graphemes.segment(value)].length;
const ENGLISH_REGISTER = /(?:^|[^\p{L}])register(?:$|[^\p{L}])/iu;

const dictionaries = Object.entries(APP_DICTIONARIES) as Array<[string, TranslationDictionary]>;

describe('PRO room registration button copy', () => {
  it('answers the registration question with the register verb in the source locales', () => {
    const { ko, en } = APP_DICTIONARIES;
    expect(ko[KEY]).toBe('등록');
    expect(en[KEY]).toBe('Register');
    expect(ko['pro.activation_account_message']).toContain('등록');
    expect(en['pro.activation_account_message']).toMatch(/^Register /u);
  });

  it('covers every app locale', () => {
    expect(Object.keys(PREVIOUS_LABELS).sort()).toEqual(Object.keys(APP_DICTIONARIES).sort());
  });

  it('replaces the old continue label in every locale with a short local verb', () => {
    const english = APP_DICTIONARIES.en[KEY];
    for (const [locale, dictionary] of dictionaries) {
      const label = dictionary[KEY];
      expect(label, `${locale}.${KEY} empty`).toBeTruthy();
      expect(label, `${locale}.${KEY} surrounding whitespace`).toBe(label.trim());
      expect(label, `${locale}.${KEY} single plain line`).not.toMatch(/[\r\n<>]/u);
      expect(label, `${locale}.${KEY} final punctuation`).not.toMatch(/[.。।۔…?？!！]$/u);
      expect(label, `${locale}.${KEY} still the old label`).not.toBe(PREVIOUS_LABELS[locale]);
      expect(label, `${locale}.${KEY} reads as sign-in`).not.toBe(
        dictionary['pro.claim_login_button'],
      );
      expect(label, `${locale}.${KEY} matches the other action`).not.toBe(
        dictionary['pro.activation_account_switch'],
      );
      expect(
        graphemeCount(label),
        `${locale}.${KEY} exceeds ${FULL_WIDTH_BUTTON_MAX_GRAPHEMES} graphemes`,
      ).toBeLessThanOrEqual(FULL_WIDTH_BUTTON_MAX_GRAPHEMES);
      if (locale !== 'en') {
        expect(label, `${locale}.${KEY} copies English`).not.toBe(english);
        expect(label, `${locale}.${KEY} uses the English word`).not.toMatch(ENGLISH_REGISTER);
      }
    }
  });
});
