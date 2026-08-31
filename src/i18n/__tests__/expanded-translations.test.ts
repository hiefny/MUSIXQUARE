import { describe, expect, it } from 'vitest';

import { APP_DICTIONARIES, type TranslationDictionary } from '../catalogs.ts';
import { LANGUAGE_OPTIONS, type LanguageCode } from '../locales.ts';

const EXPANDED_LANGUAGE_CODES = [
  'ar',
  'bg',
  'bn',
  'cs',
  'da',
  'el',
  'fa',
  'fi',
  'fil',
  'gu',
  'he',
  'hi',
  'hu',
  'kn',
  'ml',
  'mr',
  'ms',
  'nb',
  'pa',
  'ro',
  'sv',
  'ta',
  'te',
  'uk',
  'ur',
] as const satisfies readonly LanguageCode[];

const PROTECTED_TOKENS = [
  'MUSIXQUARE',
  'PRO',
  'WebRTC',
  'YouTube',
  'Google',
  'Cloudflare',
  'SFU',
  'P2P',
  'NTP',
  'MiB',
] as const;

// These messages conventionally express the number as an inflected word or compound adjective
// in several supported languages (for example, Arabic dual forms and Czech “six-digit”). Fixed
// limits such as device counts, percentages, storage sizes, and retention periods remain covered
// by the exact numeric-fact contract below.
const NATURAL_LANGUAGE_NUMBER_KEYS = new Set([
  'connect.room_password_input_aria',
  'setup.enter_code',
  'setup.six_digit_enter',
  'dialog.room_password_placeholder',
  'pro.activation_message',
  'pro.transfer_message',
  'pro.pin_message',
  'pro.pin_change_message',
  'setup.how_to_connect_html',
  'player.play_media_action_html',
  'chat.track_added_named',
  'setup.invite_share_desc_html',
  'system_audio.remote_receive_limit',
  'system_audio.duration_limit_stopped',
]);

const DIGIT_ZERO_CODE_POINTS = [
  0x30, // ASCII
  0x660, // Arabic-Indic
  0x6f0, // Extended Arabic-Indic
  0x966, // Devanagari
  0x9e6, // Bengali
  0xa66, // Gurmukhi
  0xae6, // Gujarati
  0xb66, // Oriya
  0xbe6, // Tamil
  0xc66, // Telugu
  0xce6, // Kannada
  0xd66, // Malayalam
  0xe50, // Thai
] as const;

function placeholders(value: string): string[] {
  return (value.match(/\{\{\w+\}\}/gu) ?? []).sort();
}

function tags(value: string): string[] {
  return value.match(/<\/?[a-z][^>]*>/giu) ?? [];
}

function slashCommands(value: string): string[] {
  return (value.match(/(?<![:\w])\/[a-z][a-z0-9_-]*/giu) ?? []).sort();
}

function tokenCount(value: string, token: string): number {
  return value.split(token).length - 1;
}

function asciiDigits(value: string): string[] {
  let normalized = '';
  for (const character of value) {
    const point = character.codePointAt(0)!;
    const zero = DIGIT_ZERO_CODE_POINTS.find(
      (candidate) => point >= candidate && point <= candidate + 9,
    );
    normalized += zero === undefined ? character : String(point - zero);
  }
  return normalized.match(/\d+/gu) ?? [];
}

describe('expanded translation catalog integrity', () => {
  it('keeps the complete catalog synchronized with the supported locale registry', () => {
    expect(Object.keys(APP_DICTIONARIES).sort()).toEqual(
      LANGUAGE_OPTIONS.map(({ code }) => code).sort(),
    );
    expect(new Set(EXPANDED_LANGUAGE_CODES).size).toBe(EXPANDED_LANGUAGE_CODES.length);
    expect(EXPANDED_LANGUAGE_CODES).toHaveLength(25);
  });

  it('preserves every key, key order, placeholder, line break, tag and numeric fact', () => {
    const englishEntries = Object.entries(APP_DICTIONARIES.en);
    const englishKeys = englishEntries.map(([key]) => key);

    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      expect(Object.keys(dictionary), `${language} key order`).toEqual(englishKeys);
      const isExpanded = (EXPANDED_LANGUAGE_CODES as readonly string[]).includes(language);
      const translations = dictionary as TranslationDictionary;
      for (const [key, englishValue] of englishEntries) {
        const value = translations[key];
        expect(value, `${language}.${key} missing`).toBeTypeOf('string');
        expect(value.trim(), `${language}.${key} empty or padded`).toBe(value);
        expect(value, `${language}.${key} replacement glyph`).not.toContain('\uFFFD');
        if (!isExpanded) continue;
        expect(placeholders(value), `${language}.${key} placeholders`).toEqual(
          placeholders(englishValue),
        );
        expect(value.split('\n').length, `${language}.${key} line breaks`).toBe(
          englishValue.split('\n').length,
        );
        expect(tags(value), `${language}.${key} functional markup`).toEqual(tags(englishValue));
        if (!NATURAL_LANGUAGE_NUMBER_KEYS.has(key)) {
          expect(asciiDigits(value), `${language}.${key} numeric facts`).toEqual(
            asciiDigits(englishValue),
          );
        }
      }
    }
  });

  it('preserves slash commands and product or protocol tokens in every new locale', () => {
    for (const language of EXPANDED_LANGUAGE_CODES) {
      const dictionary = APP_DICTIONARIES[language] as TranslationDictionary;
      for (const [key, englishValue] of Object.entries(APP_DICTIONARIES.en)) {
        const value = dictionary[key];
        expect(slashCommands(value), `${language}.${key} slash commands`).toEqual(
          slashCommands(englishValue),
        );
        for (const token of PROTECTED_TOKENS) {
          expect(tokenCount(value, token), `${language}.${key} ${token}`).toBe(
            tokenCount(englishValue, token),
          );
        }
      }
    }
  });

  it('does not leave an expanded locale as a disguised copy of English', () => {
    const english = APP_DICTIONARIES.en as TranslationDictionary;
    for (const language of EXPANDED_LANGUAGE_CODES) {
      const dictionary = APP_DICTIONARIES[language] as TranslationDictionary;
      const exactEnglishCopies = Object.keys(english).filter(
        (key) => dictionary[key] === english[key] && /\p{Letter}/u.test(english[key]),
      );
      expect(
        exactEnglishCopies.length,
        `${language}: ${exactEnglishCopies.join(', ')}`,
      ).toBeLessThan(90);
    }
  });

  it('isolates physical L and R channel labels inside RTL help copy', () => {
    for (const language of ['ar', 'fa', 'he', 'ur'] as const) {
      const value = APP_DICTIONARIES[language]['player.play_speakers_html'];
      expect(value, `${language} left channel`).toContain('<bdi dir="ltr">L</bdi>');
      expect(value, `${language} right channel`).toContain('<bdi dir="ltr">R</bdi>');
    }
  });
});
