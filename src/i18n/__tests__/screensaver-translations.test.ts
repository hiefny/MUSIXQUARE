import { describe, expect, it } from 'vitest';

import { APP_DICTIONARIES } from '../catalogs.ts';
import { LANGUAGE_OPTIONS } from '../locales.ts';

const SCREEN_SAVER_KEYS = [
  'screensaver.back',
  'screensaver.turn_on',
  'toast.screensaver_youtube',
] as const;

describe('screensaver translations', () => {
  it('provides translated controls and the YouTube restriction in all 42 languages', () => {
    expect(LANGUAGE_OPTIONS).toHaveLength(42);
    for (const { code } of LANGUAGE_OPTIONS) {
      const dictionary = APP_DICTIONARIES[code];
      for (const key of SCREEN_SAVER_KEYS) {
        expect(dictionary[key].trim(), `${code}.${key}`).toBe(dictionary[key]);
        expect(dictionary[key], `${code}.${key}`).not.toBe('');
        if (code !== 'en') {
          expect(dictionary[key], `${code}.${key}`).not.toBe(APP_DICTIONARIES.en[key]);
        }
      }
      expect(dictionary['screensaver.back'].match(/MUSIXQUARE/gu), code).toHaveLength(1);
      expect(dictionary['chat.cmd_u_screensaver'], code).toBe('/screensaver');
      expect(dictionary['chat.cmd_d_screensaver'], code).not.toBe('');
    }
  });

  it('preserves the requested Korean restriction and English controls', () => {
    expect(APP_DICTIONARIES.ko['toast.screensaver_youtube']).toBe(
      '유튜브 재생 중에는 화면 보호기를 사용할 수 없어요',
    );
    expect(APP_DICTIONARIES.en['toast.screensaver_youtube']).toBe(
      'Screensaver is unavailable during YouTube playback',
    );
    expect(APP_DICTIONARIES.en['screensaver.back']).toBe('Back to MUSIXQUARE');
    expect(APP_DICTIONARIES.ko['screensaver.turn_on']).toBe('화면 보호기 켜기');
    expect(APP_DICTIONARIES.en['screensaver.turn_on']).toBe('Turn on screensaver');
  });
});
