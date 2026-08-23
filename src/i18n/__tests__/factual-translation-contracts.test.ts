import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

import de from '../de.ts';
import en from '../en.ts';
import es from '../es.ts';
import fr from '../fr.ts';
import id from '../id.ts';
import italian from '../it.ts';
import ja from '../ja.ts';
import ko from '../ko.ts';
import nl from '../nl.ts';
import pl from '../pl.ts';
import ptBr from '../pt-br.ts';
import ru from '../ru.ts';
import th from '../th.ts';
import tr from '../tr.ts';
import vi from '../vi.ts';
import zhHans from '../zh-hans.ts';
import zhHant from '../zh-hant.ts';

type LandingDictionary = Record<string, Record<string, string>>;

const completedAppDictionaries = {
  de,
  en,
  es,
  fr,
  id,
  it: italian,
  ja,
  ko,
  nl,
  pl,
  'pt-br': ptBr,
  ru,
  th,
  tr,
  vi,
  'zh-hans': zhHans,
  'zh-hant': zhHant,
};

const completedLanguageContracts = {
  en: [
    'supported browser',
    'supported browser',
    'browser host',
    'room server',
    'computer',
    'sharing device',
    'volume',
    /frame|precis/i,
  ],
  ko: [
    '지원되는 브라우저',
    '지원되는 브라우저',
    '브라우저 방장',
    '방 서버',
    '컴퓨터',
    '송신 중인 기기',
    '볼륨',
    /프레임|정확/,
  ],
  ja: [
    '対応ブラウザ',
    '対応ブラウザ',
    'ブラウザホスト',
    'ルームサーバー',
    'パソコン',
    '共有元デバイス',
    '音量',
    /フレーム|正確/,
  ],
  'zh-hans': [
    '受支持浏览器',
    '受支持的浏览器',
    '浏览器房主',
    '房间服务器',
    '电脑',
    '共享设备',
    '音量',
    /帧|精准|准确/,
  ],
  'zh-hant': [
    '支援瀏覽器',
    '支援的瀏覽器',
    '瀏覽器房主',
    '房間伺服器',
    '電腦',
    '分享裝置',
    '音量',
    /幀|精準|準確/,
  ],
  es: [
    'navegador compatible',
    'navegadores compatibles',
    'anfitrión del navegador',
    'servidor de la sala',
    'ordenadores',
    'dispositivo emisor',
    'volumen',
    /fotograma|precis/i,
  ],
  id: [
    'browser yang didukung',
    'browser yang didukung',
    'host browser',
    'server ruang',
    'komputer',
    'perangkat pengirim',
    'volume',
    /frame|presisi|akurat/i,
  ],
  'pt-br': [
    'navegador compatível',
    'navegadores compatíveis',
    'host do navegador',
    'servidor da sala',
    'computadores',
    'dispositivo transmissor',
    'volume',
    /quadro|precis/i,
  ],
  fr: [
    'navigateur compatible',
    'navigateurs compatibles',
    'hôte du navigateur',
    'serveur du salon',
    'ordinateur',
    'appareil émetteur',
    'volume',
    /image près|précis/i,
  ],
  de: [
    'unterstützten browser',
    'unterstützte browser',
    'browser-host',
    'raumserver',
    'computern',
    'sendenden geräts',
    'lautstärke',
    /bildgenau|framegenau|präzis/i,
  ],
  nl: [
    'ondersteunde browser',
    'ondersteunde browsers',
    'browserhost',
    'kamerserver',
    'computers',
    'delende apparaat',
    'volume',
    /frame.?nauwkeurig|nauwkeurig/i,
  ],
  it: [
    'browser supportato',
    'browser supportati',
    'host del browser',
    'server della stanza',
    'computer',
    'dispositivo che condivide',
    'volume',
    /fotogramm|precis/i,
  ],
  pl: [
    'obsługiwanej przeglądarki',
    'obsługiwane przeglądarki',
    'host przeglądarki',
    'serwer pokoju',
    'komputer',
    'urządzenia udostępniającego',
    'głośność',
    /klatk|dokładn/i,
  ],
  ru: [
    'поддерживаемым браузером',
    'поддерживаемые браузеры',
    'браузер-хост',
    'сервер комнаты',
    'компьютер',
    'устройства-источника',
    'громкость',
    /покадров|кадр|точн/i,
  ],
  th: [
    'เบราว์เซอร์ที่รองรับ',
    'เบราว์เซอร์ที่รองรับ',
    'โฮสต์ในเบราว์เซอร์',
    'เซิร์ฟเวอร์ห้อง',
    'คอมพิวเตอร์',
    'เครื่องที่แชร์',
    'ลดเสียง',
    /เฟรม|แม่น|ละเอียด/i,
  ],
  tr: [
    'desteklenen bir tarayıcı',
    'desteklenen tarayıcılar',
    'tarayıcı hostu',
    'oda sunucusu',
    'bilgisayar',
    'paylaşan cihazın',
    'sesini',
    /kare|hassas|kesin/i,
  ],
  vi: [
    'trình duyệt được hỗ trợ',
    'trình duyệt được hỗ trợ',
    'trình duyệt chủ phòng',
    'máy chủ phòng',
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
    for (const [language, dictionary] of Object.entries(completedAppDictionaries)) {
      expect(dictionary['error.browser_update'], language).not.toMatch(
        /\biOS\b|\bChrome\b|15[.,]2|86\+/i,
      );
    }
  });

  it('keeps supported-browser, synchronization, and system-audio claims factual', async () => {
    const dictionaries = await loadLandingDictionary();
    expect(Object.keys(completedLanguageContracts).sort()).toEqual(
      Object.keys(completedAppDictionaries).sort(),
    );
    expect(Object.keys(completedLanguageContracts).sort()).toEqual(
      Object.keys(dictionaries).sort(),
    );

    for (const [language, contract] of Object.entries(completedLanguageContracts)) {
      const dictionary = dictionaries[language];
      const [
        codeBrowser,
        reachBrowser,
        standardAuthority,
        proAuthority,
        computer,
        sharingDevice,
        volume,
        exaggeratedSync,
      ] = contract;

      expectContains(dictionary['code.lead'], codeBrowser, `${language}.code.lead`);
      expectContains(
        dictionary['remote.reach_value'],
        reachBrowser,
        `${language}.remote.reach_value`,
      );
      expectContains(
        dictionary['sync.transport_value'],
        standardAuthority,
        `${language}.sync.transport_value standard authority`,
      );
      expectContains(
        dictionary['sync.transport_value'],
        proAuthority,
        `${language}.sync.transport_value PRO authority`,
      );
      expect(dictionary['sync.transport_value'], language).toContain('WebRTC');
      expect(dictionary['sync.transport_value'], language).not.toMatch(/peer-to-peer|\bP2P\b/i);
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
