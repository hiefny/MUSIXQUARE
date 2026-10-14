import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

import { APP_DICTIONARIES } from '../catalogs.ts';
import { LANGUAGE_OPTIONS, languageDirection, type LanguageCode } from '../locales.ts';

type LandingDictionary = Record<string, Record<string, string>>;

const completedLanguageContracts = {
  en: [
    'supported browser',
    'supported browser',
    'computer',
    'sharing device',
    'volume',
    /frame|precis/i,
  ],
  ko: ['브라우저만 있으면', '지원되는 브라우저', '컴퓨터', '송신 중인 기기', '볼륨', /완벽|무오차/],
  ja: ['対応ブラウザ', '対応ブラウザ', 'パソコン', '共有元デバイス', '音量', /フレーム|正確/],
  'zh-hans': ['受支持浏览器', '受支持的浏览器', '电脑', '发起共享的设备', '音量', /帧|精准|准确/],
  'zh-hant': ['支援瀏覽器', '支援的瀏覽器', '電腦', '發起分享的裝置', '音量', /幀|精準|準確/],
  es: [
    'navegador compatible',
    'navegadores compatibles',
    'computadoras',
    'dispositivo emisor',
    'volumen',
    /fotograma|precis/i,
  ],
  id: [
    'browser yang didukung',
    'browser yang didukung',
    'komputer',
    'perangkat pengirim',
    'volume',
    /frame|presisi|akurat/i,
  ],
  'pt-br': [
    'navegador compatível',
    'navegadores compatíveis',
    'computadores',
    'dispositivo transmissor',
    'volume',
    /quadro|precis/i,
  ],
  fr: [
    'navigateur compatible',
    'navigateurs compatibles',
    'ordinateur',
    'appareil émetteur',
    'volume',
    /image près|précis/i,
  ],
  de: [
    'unterstützten browser',
    'unterstützte browser',
    'computern',
    'sendenden geräts',
    'lautstärke',
    /bildgenau|framegenau|präzis/i,
  ],
  nl: [
    'ondersteunde browser',
    'ondersteunde browsers',
    'computers',
    'delende apparaat',
    'volume',
    /frame.?nauwkeurig|nauwkeurig/i,
  ],
  it: [
    'browser supportato',
    'browser supportati',
    'computer',
    'dispositivo che condivide',
    'volume',
    /fotogramm|precis/i,
  ],
  pl: [
    'obsługiwanej przeglądarki',
    'obsługiwane przeglądarki',
    'komputer',
    'urządzenia udostępniającego',
    'głośność',
    /klatk|dokładn/i,
  ],
  ru: [
    'поддерживаемым браузером',
    'поддерживаемые браузеры',
    'компьютер',
    'устройства-источника',
    'громкость',
    /покадров|кадр|точн/i,
  ],
  th: [
    'เบราว์เซอร์ที่รองรับ',
    'เบราว์เซอร์ที่รองรับ',
    'คอมพิวเตอร์',
    'เครื่องที่แชร์',
    'ลดเสียง',
    /เฟรม|แม่น|ละเอียด/i,
  ],
  tr: [
    'desteklenen bir tarayıcı',
    'desteklenen tarayıcılar',
    'bilgisayar',
    'paylaşan cihazın',
    'sesini',
    /kare|hassas|kesin/i,
  ],
  vi: [
    'trình duyệt được hỗ trợ',
    'trình duyệt được hỗ trợ',
    'máy tính',
    'thiết bị phát',
    'âm lượng',
    /khung hình|chính xác/i,
  ],
} as const;

async function loadLandingDictionary(): Promise<LandingDictionary> {
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'landing-i18n.js',
  );
  if (!asset) throw new Error('Classic landing i18n runtime is missing from the manifest.');
  const source = (await compileClassicRuntimeAsset(process.cwd(), asset)).code;
  const marker = /(\s+function normalizeSelection\(lang\) \{)/u;
  const windowObject: Record<string, unknown> = {};
  vm.runInNewContext(
    source.replace(marker, '\n    window.__landingI18n = i18n;\n    return;\n$1'),
    { window: windowObject },
  );
  return windowObject.__landingI18n as LandingDictionary;
}

function expectContains(value: string, fragment: string, context: string): void {
  expect(value.toLowerCase(), context).toContain(fragment.toLowerCase());
}

describe('completed translation factual contracts', () => {
  it('does not pin browser-update guidance to retired browser version floors', () => {
    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      expect(dictionary['error.browser_update'], language).not.toMatch(
        /\biOS\b|\bChrome\b|15[.,]2|86\+/i,
      );
    }
  });

  it('keeps PRO join refusal copy translated and factual in every locale', () => {
    const english = APP_DICTIONARIES.en;
    const keys = [
      'pro.room_full',
      'pro.room_full_detail',
      'pro.join_rate_limited',
      'pro.join_rate_limited_later',
    ] as const;
    expect(Object.keys(APP_DICTIONARIES)).toHaveLength(42);

    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      // A PRO room seats 100 devices in total and keeps one of them for the
      // owner. No other number belongs in the capacity explanation.
      expect(dictionary['pro.room_full_detail'].match(/[0-9]+/gu), language).toEqual(['100']);
      expect(dictionary['pro.room_full'], language).toContain('PRO');
      expect(dictionary['pro.room_full_detail'], language).toContain('PRO');
      // The wait is the server Retry-After in whole minutes; the fallback
      // has no number because the server did not provide one.
      expect(dictionary['pro.join_rate_limited'].match(/\{\{\w+\}\}/gu), language).toEqual([
        '{{count}}',
      ]);
      expect(dictionary['pro.join_rate_limited_later'], language).not.toMatch(/\{\{|[0-9]/u);
      if (language === 'en') continue;
      for (const key of keys) {
        expect(dictionary[key], `${language}.${key} English copy`).not.toBe(english[key]);
      }
    }

    expect(APP_DICTIONARIES.ko['pro.room_full']).toBe('PRO 방이 가득 찼어요');
    expect(APP_DICTIONARIES.ko['pro.join_rate_limited_later']).toBe(
      '입장 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.',
    );
    // Standard rooms keep their own host-inclusive capacity copy.
    expect(APP_DICTIONARIES.en['network.session_full_detail']).toBe(
      'This room already has the maximum of 100 connected devices, including the host.',
    );
  });

  it('gives the Standard wrong-password lockout its own copy in every locale', () => {
    const english = APP_DICTIONARIES.en;
    const keys = [
      'dialog.room_password_rate_limited',
      'dialog.room_password_rate_limited_later',
    ] as const;
    const commonPrefix = (left: string, right: string): string => {
      let index = 0;
      while (index < left.length && left[index] === right[index]) index += 1;
      return left.slice(0, index);
    };
    expect(Object.keys(APP_DICTIONARIES)).toHaveLength(42);

    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      // The wait is the Worker's retryAfterSeconds in whole minutes; the
      // fallback has no number because the Worker did not provide one.
      expect(
        dictionary['dialog.room_password_rate_limited'].match(/\{\{\w+\}\}/gu),
        language,
      ).toEqual(['{{count}}']);
      expect(dictionary['dialog.room_password_rate_limited_later'], language).not.toMatch(
        /\{\{|[0-9]/u,
      );
      // The lead says the password was wrong too often, not the PRO join
      // throttle's "too many join attempts".
      const standardLead = commonPrefix(
        dictionary['dialog.room_password_rate_limited'],
        dictionary['dialog.room_password_rate_limited_later'],
      );
      const proLead = commonPrefix(
        dictionary['pro.join_rate_limited'],
        dictionary['pro.join_rate_limited_later'],
      );
      expect(standardLead.trim().length, language).toBeGreaterThan(0);
      expect(dictionary['pro.join_rate_limited'], language).not.toContain(standardLead.trim());
      expect(dictionary['dialog.room_password_rate_limited'], language).not.toContain(
        proLead.trim(),
      );
      if (language === 'en') continue;
      for (const key of keys) {
        expect(dictionary[key], `${language}.${key} English copy`).not.toBe(english[key]);
      }
    }

    expect(keys.map((key) => APP_DICTIONARIES.ko[key])).toEqual([
      '암호를 여러 번 틀렸어요. {{count}}분 후에 다시 시도해 주세요.',
      '암호를 여러 번 틀렸어요. 잠시 후 다시 시도해 주세요.',
    ]);
    expect(keys.map((key) => english[key])).toEqual([
      'You entered the wrong password too many times. Try again in {{count}} minutes.',
      'You entered the wrong password too many times. Try again in a little while.',
    ]);
    // PRO join throttling keeps its own wording.
    expect(APP_DICTIONARIES.ko['pro.join_rate_limited']).toBe(
      '입장 시도가 너무 많아요. {{count}}분 후에 다시 시도해 주세요.',
    );
  });

  it('gives the in-room update notice a browser-tab and a home-screen form in every locale', () => {
    const english = APP_DICTIONARIES.en;
    const tabKey = 'chat.update_available_tab_system_message';
    const appKey = 'chat.update_available_app_system_message';
    const commonPrefix = (left: string, right: string): string => {
      let index = 0;
      while (index < left.length && left[index] === right[index]) index += 1;
      return left.slice(0, index);
    };
    expect(Object.keys(APP_DICTIONARIES)).toHaveLength(42);

    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const tab = dictionary[tabKey];
      const app = dictionary[appKey];
      for (const [key, text] of [
        [tabKey, tab],
        [appKey, app],
      ] as const) {
        // The brand stays exact; the notice is plain chat text with no
        // placeholders, markup, or numbers.
        expect(text, `${language}.${key}`).toContain('MUSIXQUARE');
        expect(text, `${language}.${key}`).not.toMatch(/\{\{|<|[0-9]/u);
      }
      // Both say the same news ("a new MUSIXQUARE version is available") and
      // differ only in how it applies: reload the tab, or reopen the app.
      expect(app, language).not.toBe(tab);
      expect(commonPrefix(tab, app), language).toContain('MUSIXQUARE');
      // Chat rows render with dir="auto", which takes the line direction from
      // its first strong character. An RTL notice that opened with the Latin
      // brand would be laid out left to right.
      if (languageDirection(language as LanguageCode) === 'rtl') {
        for (const text of [tab, app]) {
          expect(text, `${language} opens with RTL script`).toMatch(
            /^(?:\p{Script=Arabic}|\p{Script=Hebrew}|\u200F)/u,
          );
        }
      }
      if (language === 'en') continue;
      expect(tab, `${language}.${tabKey} English copy`).not.toBe(english[tabKey]);
      expect(app, `${language}.${appKey} English copy`).not.toBe(english[appKey]);
    }

    expect([APP_DICTIONARIES.ko[tabKey], APP_DICTIONARIES.ko[appKey]]).toEqual([
      'MUSIXQUARE의 새 버전이 있어요. 페이지를 새로고침하면 적용돼요.',
      'MUSIXQUARE의 새 버전이 있어요. 앱을 다시 열면 적용돼요.',
    ]);
    expect([english[tabKey], english[appKey]]).toEqual([
      'A new version of MUSIXQUARE is available. Refresh the page to apply it.',
      'A new version of MUSIXQUARE is available. Reopen the app to apply it.',
    ]);
  });

  it('gives the lazy-feature recovery dialog its own refresh copy in every locale', () => {
    const english = APP_DICTIONARIES.en;
    const titleKey = 'dialog.feature_refresh_title';
    const messageKey = 'dialog.feature_refresh_msg';
    expect(Object.keys(APP_DICTIONARIES)).toHaveLength(42);

    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const title = dictionary[titleKey];
      const message = dictionary[messageKey];
      for (const [key, text] of [
        [titleKey, title],
        [messageKey, message],
      ] as const) {
        // Plain dialog text: no placeholders, markup, numbers, or line breaks.
        expect(text, `${language}.${key}`).not.toMatch(/\{\{|<|[0-9]|\n/u);
        expect(text.trim(), `${language}.${key}`).toBe(text);
      }
      // The message names the brand exactly once (it was updated); the short
      // title does not.
      expect(message.split('MUSIXQUARE'), `${language}.${messageKey}`).toHaveLength(2);
      expect(title, `${language}.${titleKey}`).not.toContain('MUSIXQUARE');
      // Distinct from the waiting-worker update dialog, which the recovery
      // dialog used to borrow.
      expect(title, `${language} title`).not.toBe(dictionary['dialog.sw_update_title']);
      expect(message, `${language} message`).not.toBe(dictionary['dialog.sw_update_msg']);
      // An RTL message that opened with the Latin brand would be laid out left
      // to right wherever it is rendered with dir="auto".
      if (languageDirection(language as LanguageCode) === 'rtl') {
        for (const text of [title, message]) {
          expect(text, `${language} opens with RTL script`).toMatch(
            /^(?:\p{Script=Arabic}|\p{Script=Hebrew}|\u200F)/u,
          );
        }
      }
      if (language === 'en') continue;
      expect(title, `${language}.${titleKey} English copy`).not.toBe(english[titleKey]);
      expect(message, `${language}.${messageKey} English copy`).not.toBe(english[messageKey]);
    }

    // Owner's copy (2026-10-11). The message says the app was updated and
    // needs a refresh to keep working normally; it names no single feature.
    expect([APP_DICTIONARIES.ko[titleKey], APP_DICTIONARIES.ko[messageKey]]).toEqual([
      '새로고침이 필요해요',
      'MUSIXQUARE가 업데이트되었어요. 정상적으로 사용하려면 새로고침이 필요해요.',
    ]);
    expect([english[titleKey], english[messageKey]]).toEqual([
      'Refresh needed',
      'MUSIXQUARE has been updated. Refresh to keep using it normally.',
    ]);
    // The regular update dialog keeps its copy.
    expect([
      APP_DICTIONARIES.ko['dialog.sw_update_title'],
      APP_DICTIONARIES.ko['dialog.sw_update_msg'],
    ]).toEqual(['업데이트', '새 버전이 준비되었어요. 새로고침하면 업데이트가 적용돼요.']);
  });

  it('keeps supported-browser, synchronization, and system-audio claims factual', async () => {
    const dictionaries = await loadLandingDictionary();
    expect(Object.keys(dictionaries).sort()).toEqual(
      LANGUAGE_OPTIONS.map(({ code }) => code).sort(),
    );

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      expect(dictionary['code.lead'], `${language}.code.lead`).not.toMatch(/\bPRO\b/iu);
      expect(dictionary['sync.lead'], `${language}.sync.lead`).not.toMatch(/\bPRO\b/iu);
      expect(dictionary['sync.transport_value'], `${language}.sync.transport_value`).not.toMatch(
        /\bPRO\b/iu,
      );
      expect(dictionary['sync.transport_value'], language).toContain('WebRTC');
      expect(
        `${dictionary['sync.h2']} ${dictionary['sync.lead']} ${dictionary['sync.video_value']}`,
        `${language} unsupported synchronization guarantee`,
      ).not.toMatch(
        /frame[- ]?perfect|sample[- ]?accurate|zero[- ]?latency|perfect(?:ly)? synchronized/iu,
      );
      expect(dictionary['standin.feature_value'], `${language}.standin.feature_value`).toContain(
        'Beta',
      );
      // The consumer copy describes direct versus remote/relayed sharing without
      // internal routing names. Runtime duration coverage lives in system-capture-stop.test.ts.
      for (const token of ['Beta', 'Chromium']) {
        expect(dictionary['standin.caveat'], `${language}.standin.caveat ${token}`).toContain(
          token,
        );
      }
      // Device and duration limits are deliberately written as inflected number words in many
      // locales (Arabic even uses a dual noun form), so ASCII-digit matching would reject the
      // more natural translation. Their semantic values are covered by the reviewed locale
      // contracts while the browser requirement and Beta label stay machine-verifiable here.
    }

    for (const [language, contract] of Object.entries(completedLanguageContracts)) {
      const dictionary = dictionaries[language];
      const [codeBrowser, reachBrowser, computer, sharingDevice, volume, exaggeratedSync] =
        contract;

      expectContains(dictionary['code.lead'], codeBrowser, `${language}.code.lead`);
      expectContains(
        dictionary['remote.reach_value'],
        reachBrowser,
        `${language}.remote.reach_value`,
      );
      expect(dictionary['code.lead'], `${language}.code.lead`).not.toMatch(/\bPRO\b/iu);
      expect(dictionary['sync.lead'], `${language}.sync.lead`).not.toMatch(/\bPRO\b/iu);
      expect(dictionary['sync.transport_value'], `${language}.sync.transport_value`).not.toMatch(
        /\bPRO\b/iu,
      );
      expect(dictionary['sync.transport_value'], language).toContain('WebRTC');
      expect(
        `${dictionary['sync.h2']} ${dictionary['sync.video_value']}`,
        `${language} sync precision claim`,
      ).not.toMatch(exaggeratedSync);
      expectContains(
        dictionary['standin.platform_value'],
        computer,
        `${language}.standin.platform_value`,
      );
      expectContains(
        dictionary['standin.caveat'],
        sharingDevice,
        `${language}.standin.caveat sharing device`,
      );
      expectContains(dictionary['standin.caveat'], volume, `${language}.standin.caveat volume`);
    }
  });
});
