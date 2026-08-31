import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

import { APP_DICTIONARIES } from '../catalogs.ts';
import { LANGUAGE_OPTIONS } from '../locales.ts';

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
  'zh-hans': ['受支持浏览器', '受支持的浏览器', '电脑', '共享设备', '音量', /帧|精准|准确/],
  'zh-hant': ['支援瀏覽器', '支援的瀏覽器', '電腦', '分享裝置', '音量', /幀|精準|準確/],
  es: [
    'navegador compatible',
    'navegadores compatibles',
    'ordenadores',
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
      if (!Object.prototype.hasOwnProperty.call(completedLanguageContracts, language)) {
        expect(dictionary['standin.caveat'], `${language}.standin.caveat room tier`).toMatch(
          /Standard/iu,
        );
        for (const token of ['Cloudflare', 'SFU', 'PRO', 'LAN-direct']) {
          expect(dictionary['standin.caveat'], `${language}.standin.caveat ${token}`).toContain(
            token,
          );
        }
      }
      // Device and duration limits are deliberately written as inflected number words in many
      // locales (Arabic even uses a dual noun form), so ASCII-digit matching would reject the
      // more natural translation. Their semantic values are covered by the reviewed locale
      // contracts while the invariant product and transport terms stay machine-verifiable here.
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
