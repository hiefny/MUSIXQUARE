/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLURAL_PARAM_BY_KEY, pluralMessagesForTests as PLURAL_MESSAGES } from '../plural.ts';

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
    expect(Object.keys(PLURAL_PARAM_BY_KEY)).toHaveLength(12);
  });

  it('uses natural English singular and plural copy for all count-sensitive messages', async () => {
    const t = await loadTranslator('en-US');

    const cases = [
      ['playlist.delete_selected', { count: 1 }, 'Delete 1 selected track'],
      ['playlist.delete_selected', { count: 2 }, 'Delete 2 selected tracks'],
      ['connect.device_list', { count: 1 }, '1 Connected Device'],
      ['connect.device_list', { count: 2 }, '2 Connected Devices'],
      ['connect.administrator_list', { count: 1 }, '1 Administrator'],
      ['connect.administrator_list', { count: 2 }, '2 Administrators'],
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
      ['chat.tracks_added', { name: 'Alex', count: 1 }, 'Alex added 1 track'],
      ['chat.tracks_added', { name: 'Alex', count: 2 }, 'Alex added 2 tracks'],
      [
        'chat.tracks_added_named',
        { name: 'Alex', count: 1, title: 'First' },
        'Alex added 1 track, including First',
      ],
      [
        'chat.tracks_added_named',
        { name: 'Alex', count: 2, title: 'First' },
        'Alex added 2 tracks, including First',
      ],
      ['toast.unsupported_files_excluded', { count: 1 }, 'Unsupported file skipped: 1'],
      ['toast.unsupported_files_excluded', { count: 2 }, 'Unsupported files skipped: 2'],
      ['dialog.file_drop.message', { count: 1 }, 'Add 1 file?'],
      ['dialog.file_drop.message', { count: 2 }, 'Add 2 files?'],
      ['dialog.file_drop.unsupported_notice', { count: 1 }, "1 unsupported file won't be added."],
      ['dialog.file_drop.unsupported_notice', { count: 2 }, "2 unsupported files won't be added."],
    ] as const;

    for (const [key, params, expected] of cases) {
      expect(t(key, params)).toBe(expected);
    }
  });

  it('selects Russian one, few and many forms, including compound counts', async () => {
    const t = await loadTranslator('ru-RU');

    expect(t('dialog.file_drop.message', { count: 1 })).toBe('Добавить 1 файл?');
    expect(t('dialog.file_drop.message', { count: 2 })).toBe('Добавить 2 файла?');
    expect(t('dialog.file_drop.message', { count: 5 })).toBe('Добавить 5 файлов?');
    expect(t('dialog.file_drop.message', { count: 11 })).toBe('Добавить 11 файлов?');
    expect(t('dialog.file_drop.message', { count: 14 })).toBe('Добавить 14 файлов?');
    expect(t('dialog.file_drop.message', { count: 21 })).toBe('Добавить 21 файл?');
    expect(t('dialog.file_drop.message', { count: 22 })).toBe('Добавить 22 файла?');
    expect(t('dialog.file_drop.message', { count: 25 })).toBe('Добавить 25 файлов?');

    expect(t('toast.added_tracks', { count: 1 })).toBe('Добавлен 1 материал');
    expect(t('toast.added_tracks', { count: 2 })).toBe('Добавлено 2 материала');
    expect(t('toast.added_tracks', { count: 5 })).toBe('Добавлено 5 материалов');

    expect(t('connect.administrator_list', { count: 1 })).toBe('1 администратор');
    expect(t('connect.administrator_list', { count: 2 })).toBe('2 администратора');
    expect(t('connect.administrator_list', { count: 5 })).toBe('5 администраторов');
    expect(t('connect.administrator_list', { count: 11 })).toBe('11 администраторов');
    expect(t('connect.administrator_list', { count: 21 })).toBe('21 администратор');

    expect(t('chat.tracks_added', { name: 'Alex', count: 1 })).toBe('Добавлен 1 материал (Alex)');
    expect(t('chat.tracks_added', { name: 'Alex', count: 2 })).toBe('Добавлено 2 материала (Alex)');
    expect(t('chat.tracks_added', { name: 'Alex', count: 11 })).toBe(
      'Добавлено 11 материалов (Alex)',
    );
    expect(t('chat.tracks_added', { name: 'Alex', count: 21 })).toBe('Добавлен 21 материал (Alex)');
  });

  it('selects Polish one, few and many forms using Polish cardinal rules', async () => {
    const t = await loadTranslator('pl-PL');

    expect(t('toast.added_tracks', { count: 1 })).toBe('Dodano 1 materiał');
    expect(t('toast.added_tracks', { count: 2 })).toBe('Dodano 2 materiały');
    expect(t('toast.added_tracks', { count: 5 })).toBe('Dodano 5 materiałów');
    expect(t('toast.added_tracks', { count: 12 })).toBe('Dodano 12 materiałów');
    expect(t('toast.added_tracks', { count: 14 })).toBe('Dodano 14 materiałów');
    expect(t('toast.added_tracks', { count: 21 })).toBe('Dodano 21 materiałów');
    expect(t('toast.added_tracks', { count: 22 })).toBe('Dodano 22 materiały');
    expect(t('toast.added_tracks', { count: 25 })).toBe('Dodano 25 materiałów');

    expect(t('chat.tracks_added', { name: 'Alex', count: 1 })).toBe('Alex: dodano 1 materiał');
    expect(t('chat.tracks_added', { name: 'Alex', count: 2 })).toBe('Alex: dodano 2 materiały');
    expect(t('chat.tracks_added', { name: 'Alex', count: 12 })).toBe('Alex: dodano 12 materiałów');
    expect(t('dialog.file_drop.unsupported_notice', { count: 21 })).toBe(
      '21 nieobsługiwanych plików nie zostanie dodanych.',
    );
  });

  it('uses Romanian singular, few fallback, and de-bearing other forms at numeric boundaries', async () => {
    const t = await loadTranslator('ro-RO');

    expect(t('connect.device_list', { count: 0 })).toBe('0 dispozitive conectate');
    expect(t('connect.device_list', { count: 1 })).toBe('1 dispozitiv conectat');
    expect(t('connect.device_list', { count: 2 })).toBe('2 dispozitive conectate');
    expect(t('connect.device_list', { count: 19 })).toBe('19 dispozitive conectate');
    expect(t('connect.device_list', { count: 20 })).toBe('20 de dispozitive conectate');
    expect(t('connect.device_list', { count: 21 })).toBe('21 de dispozitive conectate');
    expect(t('connect.device_list', { count: 100 })).toBe('100 de dispozitive conectate');
    expect(t('connect.device_list', { count: 101 })).toBe('101 dispozitive conectate');
    expect(t('connect.device_list', { count: 119 })).toBe('119 dispozitive conectate');
    expect(t('connect.device_list', { count: 120 })).toBe('120 de dispozitive conectate');

    expect(t('chat.cmd_slowmode_wait', { sec: 1 })).toBe('Așteaptă 1 secundă înainte de a trimite');
    expect(t('chat.cmd_slowmode_wait', { sec: 2 })).toBe('Așteaptă 2 secunde înainte de a trimite');
    expect(t('chat.cmd_slowmode_wait', { sec: 20 })).toBe(
      'Așteaptă 20 de secunde înainte de a trimite',
    );
    expect(t('chat.tracks_added_named', { name: 'Alex', count: 20, title: 'Prima' })).toBe(
      'Alex a adăugat 20 de piste, inclusiv Prima',
    );

    // These labels deliberately put the count after a neutral plural label.
    expect(t('playlist.delete_selected', { count: 1 })).toBe('Șterge pistele selectate: 1');
    expect(t('toast.unsupported_files_excluded', { count: 20 })).toBe(
      'Fișiere neacceptate omise: 20',
    );
  });

  it('selects Arabic zero, one, two, few, many, and other forms without losing placeholders', async () => {
    const t = await loadTranslator('ar-SA');

    expect(t('dialog.file_drop.message', { count: 0 })).toBe('هل تريد إضافة 0 من الملفات؟');
    expect(t('dialog.file_drop.message', { count: 1 })).toBe('هل تريد إضافة 1 ملف؟');
    expect(t('dialog.file_drop.message', { count: 2 })).toBe('هل تريد إضافة 2 ملفين؟');
    expect(t('dialog.file_drop.message', { count: 3 })).toBe('هل تريد إضافة 3 ملفات؟');
    expect(t('dialog.file_drop.message', { count: 11 })).toBe('هل تريد إضافة 11 ملفًا؟');
    expect(t('dialog.file_drop.message', { count: 100 })).toBe('هل تريد إضافة 100 من الملفات؟');
    expect(t('chat.tracks_added_named', { name: 'ليلى', count: 2, title: 'الأولى' })).toBe(
      'أضاف ليلى 2 مقطعين، منهما الأولى',
    );
  });

  it('uses singular copy in Urdu, Hebrew, and Nordic locales while retaining neutral fallbacks', async () => {
    const cases = [
      ['ur-PK', 'منتخب کیا گیا 1 ٹریک حذف کریں', 'منتخب کیے گئے 2 ٹریک حذف کریں'],
      ['he-IL', 'מחיקת 1 רצועה שנבחרה', 'מחיקת 2 הרצועות שנבחרו'],
      ['sv-SE', 'Radera 1 markerat spår', 'Radera 2 markerade spår'],
      ['da-DK', 'Slet 1 markeret nummer', 'Slet 2 markerede numre'],
      ['nb-NO', 'Slett 1 merket spor', 'Slett 2 merkede spor'],
      ['fi-FI', 'Poista 1 valittu kappale', 'Poista 2 valittua kappaletta'],
    ] as const;

    for (const [locale, singular, plural] of cases) {
      const t = await loadTranslator(locale);
      expect(t('playlist.delete_selected', { count: 1 }), locale).toBe(singular);
      expect(t('playlist.delete_selected', { count: 2 }), locale).toBe(plural);
    }
  });

  it('keeps invariant Korean counter copy for both singular and plural counts', async () => {
    const t = await loadTranslator('ko-KR');

    expect(t('dialog.file_drop.message', { count: 1 })).toBe('파일 1개를 추가할까요?');
    expect(t('dialog.file_drop.message', { count: 5 })).toBe('파일 5개를 추가할까요?');
  });

  it('keeps Thai classifiers intact through the other fallback', async () => {
    const t = await loadTranslator('th-TH');

    const cases = [
      ['playlist.delete_selected', { count: 2 }, 'ลบ 2 รายการที่เลือก'],
      ['connect.device_list', { count: 2 }, 'อุปกรณ์เชื่อมต่อ 2 เครื่อง'],
      ['connect.administrator_list', { count: 2 }, 'ผู้ดูแล 2 คน'],
      [
        'demo.session_body_connected',
        { count: 2 },
        'ขณะนี้มีอุปกรณ์เชื่อมต่อ 2 เครื่อง\nตั้งค่าบทบาทให้แต่ละอุปกรณ์',
      ],
      ['chat.cmd_slowmode_on', { sec: 2 }, 'โหมดช้า: 2 วินาทีระหว่างข้อความ'],
      ['chat.cmd_slowmode_wait', { sec: 2 }, 'รอ 2 วินาทีก่อนส่ง'],
      ['chat.tracks_added', { name: 'Alex', count: 2 }, 'Alex เพิ่ม 2 รายการ'],
      [
        'chat.tracks_added_named',
        { name: 'Alex', count: 2, title: 'รายการแรก' },
        'Alex เพิ่ม 2 รายการ รวมถึง รายการแรก',
      ],
      ['toast.added_tracks', { count: 2 }, 'เพิ่ม 2 รายการแล้ว'],
      ['toast.unsupported_files_excluded', { count: 2 }, 'จะข้ามไฟล์ที่ไม่รองรับ 2 ไฟล์'],
      ['dialog.file_drop.message', { count: 2 }, 'เพิ่มไฟล์ 2 ไฟล์ไหม?'],
      ['dialog.file_drop.unsupported_notice', { count: 2 }, 'ไฟล์ที่ไม่รองรับ 2 ไฟล์จะไม่ถูกเพิ่ม'],
    ] as const;

    for (const [key, params, expected] of cases) expect(t(key, params)).toBe(expected);
  });

  it('keeps Indonesian nouns invariant after cardinal numbers through the other fallback', async () => {
    const t = await loadTranslator('id-ID');

    const cases = [
      ['playlist.delete_selected', { count: 2 }, 'Hapus 2 media terpilih'],
      ['connect.device_list', { count: 2 }, '2 perangkat tersambung'],
      ['connect.administrator_list', { count: 2 }, '2 administrator'],
      [
        'demo.session_body_connected',
        { count: 2 },
        '2 perangkat sedang tersambung.\nAtur peran untuk setiap perangkat.',
      ],
      ['chat.cmd_slowmode_on', { sec: 2 }, 'Mode lambat: jeda 2 dtk antarpesan'],
      ['chat.cmd_slowmode_wait', { sec: 2 }, 'Tunggu 2 dtk sebelum mengirim'],
      ['chat.tracks_added', { name: 'Alex', count: 2 }, 'Alex menambahkan 2 media'],
      [
        'chat.tracks_added_named',
        { name: 'Alex', count: 2, title: 'Pertama' },
        'Alex menambahkan 2 media, termasuk Pertama',
      ],
      ['toast.added_tracks', { count: 2 }, '2 media ditambahkan'],
      ['toast.unsupported_files_excluded', { count: 2 }, '2 file yang tidak didukung dilewati.'],
      ['dialog.file_drop.message', { count: 2 }, 'Tambahkan 2 file?'],
      [
        'dialog.file_drop.unsupported_notice',
        { count: 2 },
        '2 file yang tidak didukung tidak akan ditambahkan.',
      ],
    ] as const;

    for (const [key, params, expected] of cases) expect(t(key, params)).toBe(expected);
  });

  it('keeps Turkish nouns singular after cardinal numbers through the other fallback', async () => {
    const t = await loadTranslator('tr-TR');

    const cases = [
      ['playlist.delete_selected', { count: 2 }, 'Seçilen 2 parçayı sil'],
      ['connect.device_list', { count: 2 }, '2 bağlı cihaz'],
      ['connect.administrator_list', { count: 2 }, '2 yönetici'],
      [
        'demo.session_body_connected',
        { count: 2 },
        'Şu anda 2 cihaz bağlı.\nHer cihaz için bir rol belirle.',
      ],
      ['chat.cmd_slowmode_on', { sec: 2 }, 'Yavaş mod: Mesajlar arasında 2 saniye'],
      ['chat.cmd_slowmode_wait', { sec: 2 }, 'Göndermeden önce 2 saniye bekle'],
      ['chat.tracks_added', { name: 'Alex', count: 2 }, 'Alex 2 medya öğesi ekledi'],
      [
        'chat.tracks_added_named',
        { name: 'Alex', count: 2, title: 'İlk' },
        'Alex 2 medya öğesi ekledi; bunlardan biri İlk',
      ],
      ['toast.added_tracks', { count: 2 }, '2 medya öğesi eklendi'],
      ['toast.unsupported_files_excluded', { count: 2 }, 'Desteklenmeyen 2 dosya atlanacak.'],
      ['dialog.file_drop.message', { count: 2 }, '2 dosya eklensin mi?'],
      ['dialog.file_drop.unsupported_notice', { count: 2 }, 'Desteklenmeyen 2 dosya eklenmeyecek.'],
    ] as const;

    for (const [key, params, expected] of cases) expect(t(key, params)).toBe(expected);
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
        for (const [form, value] of Object.entries(variants || {}) as Array<[string, string]>) {
          const placeholders = [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
          expect(
            placeholders.filter((placeholder) => placeholder === parameter),
            `${locale}.${key}.${form}`,
          ).toEqual([parameter]);
          if (key === 'chat.tracks_added' || key === 'chat.tracks_added_named') {
            expect(placeholders, `${locale}.${key}.${form}`).toContain('name');
          }
          if (key === 'chat.tracks_added_named') {
            expect(placeholders, `${locale}.${key}.${form}`).toContain('title');
          }
        }
      }
    }
  });
});
