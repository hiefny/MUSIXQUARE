/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLURAL_MESSAGES, PLURAL_PARAM_BY_KEY } from '../plural.ts';

async function loadTranslator(language: string) {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
  Object.defineProperty(navigator, 'languages', {
    value: [language],
    configurable: true,
  });
  Object.defineProperty(navigator, 'language', {
    value: language,
    configurable: true,
  });

  const i18n = await import('../index.ts');
  await i18n.initI18n();
  return i18n.t;
}

describe('count-sensitive translations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers every audited count-sensitive message', () => {
    expect(Object.keys(PLURAL_PARAM_BY_KEY)).toHaveLength(10);
  });

  it('uses natural English singular and plural copy for all ten messages', async () => {
    const t = await loadTranslator('en-US');

    const cases = [
      ['playlist.delete_selected', { count: 1 }, 'Delete 1 selected track'],
      ['playlist.delete_selected', { count: 2 }, 'Delete 2 selected tracks'],
      ['connect.device_list', { count: 1 }, '1 Connected Device'],
      ['connect.device_list', { count: 2 }, '2 Connected Devices'],
      [
        'connect.cannot_reduce',
        { count: 1 },
        'Cannot reduce capacity: 1 device is already connected',
      ],
      [
        'connect.cannot_reduce',
        { count: 2 },
        'Cannot reduce capacity: 2 devices are already connected',
      ],
      [
        'demo.session_body_connected',
        { count: 1 },
        '1 device is connected right now.\nSet a role for this device.',
      ],
      [
        'demo.session_body_connected',
        { count: 2 },
        '2 devices are connected right now.\nSet a role for each device.',
      ],
      ['chat.cmd_slowmode_on', { sec: 1 }, 'Slow mode: 1 second between messages'],
      ['chat.cmd_slowmode_on', { sec: 2 }, 'Slow mode: 2 seconds between messages'],
      ['chat.cmd_slowmode_wait', { sec: 1 }, 'Wait 1 second before sending'],
      ['chat.cmd_slowmode_wait', { sec: 2 }, 'Wait 2 seconds before sending'],
      ['toast.added_tracks', { count: 1 }, '1 track added'],
      ['toast.added_tracks', { count: 2 }, '2 tracks added'],
      ['toast.unsupported_files_excluded', { count: 1 }, 'Unsupported file skipped: 1'],
      ['toast.unsupported_files_excluded', { count: 2 }, 'Unsupported files skipped: 2'],
      ['dialog.file_drop.message', { count: 1 }, 'Add 1 track?'],
      ['dialog.file_drop.message', { count: 2 }, 'Add 2 tracks?'],
      ['dialog.file_drop.unsupported_notice', { count: 1 }, "1 unsupported file won't be added."],
      ['dialog.file_drop.unsupported_notice', { count: 2 }, "2 unsupported files won't be added."],
    ] as const;

    for (const [key, params, expected] of cases) {
      expect(t(key, params)).toBe(expected);
    }
  });

  it('selects Russian one, few and many forms, including compound counts', async () => {
    const t = await loadTranslator('ru-RU');

    expect(t('dialog.file_drop.message', { count: 1 })).toBe('Добавить 1 трек?');
    expect(t('dialog.file_drop.message', { count: 2 })).toBe('Добавить 2 трека?');
    expect(t('dialog.file_drop.message', { count: 5 })).toBe('Добавить 5 треков?');
    expect(t('dialog.file_drop.message', { count: 21 })).toBe('Добавить 21 трек?');
    expect(t('dialog.file_drop.message', { count: 22 })).toBe('Добавить 22 трека?');
    expect(t('dialog.file_drop.message', { count: 25 })).toBe('Добавить 25 треков?');
  });

  it('selects Polish one, few and many forms using Polish cardinal rules', async () => {
    const t = await loadTranslator('pl-PL');

    expect(t('toast.added_tracks', { count: 1 })).toBe('Dodano 1 utwór');
    expect(t('toast.added_tracks', { count: 2 })).toBe('Dodano 2 utwory');
    expect(t('toast.added_tracks', { count: 5 })).toBe('Dodano 5 utworów');
    expect(t('toast.added_tracks', { count: 21 })).toBe('Dodano 21 utworów');
    expect(t('toast.added_tracks', { count: 22 })).toBe('Dodano 22 utwory');
    expect(t('toast.added_tracks', { count: 25 })).toBe('Dodano 25 utworów');
  });

  it('keeps invariant Korean counter copy for both singular and plural counts', async () => {
    const t = await loadTranslator('ko-KR');

    expect(t('dialog.file_drop.message', { count: 1 })).toBe('1곡을 추가할까요?');
    expect(t('dialog.file_drop.message', { count: 5 })).toBe('5곡을 추가할까요?');
  });

  it('defines every singular form and every Slavic few/many form', () => {
    const singularLocales = ['en', 'de', 'es', 'fr', 'it', 'nl', 'pt-br'] as const;
    const keys = Object.keys(PLURAL_PARAM_BY_KEY) as Array<keyof typeof PLURAL_PARAM_BY_KEY>;

    for (const locale of singularLocales) {
      for (const key of keys) expect(PLURAL_MESSAGES[locale]?.[key]?.one).toBeTruthy();
    }
    for (const locale of ['pl', 'ru'] as const) {
      for (const key of keys) {
        expect(PLURAL_MESSAGES[locale]?.[key]?.one).toBeTruthy();
        expect(PLURAL_MESSAGES[locale]?.[key]?.few).toBeTruthy();
        expect(PLURAL_MESSAGES[locale]?.[key]?.many).toBeTruthy();
      }
    }
  });

  it('preserves each count placeholder in every plural variant', () => {
    for (const [locale, messages] of Object.entries(PLURAL_MESSAGES)) {
      for (const [key, variants] of Object.entries(messages || {})) {
        const parameter = PLURAL_PARAM_BY_KEY[key as keyof typeof PLURAL_PARAM_BY_KEY];
        for (const [form, value] of Object.entries(variants || {})) {
          const placeholders = [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
          expect(placeholders, `${locale}.${key}.${form}`).toEqual([parameter]);
        }
      }
    }
  });
});
