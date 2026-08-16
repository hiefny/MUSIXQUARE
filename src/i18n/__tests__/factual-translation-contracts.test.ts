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
    'round-trip latency',
    'shared master clock',
    'computer',
    'host',
    'volume',
    /frame|precis/i,
  ],
  ko: [
    '지원되는 브라우저',
    '지원되는 브라우저',
    '왕복 지연',
    '공유 마스터 클록',
    '컴퓨터',
    '방장',
    '볼륨',
    /프레임|정확/,
  ],
  ja: [
    '対応ブラウザ',
    '対応ブラウザ',
    '往復遅延',
    '共有マスタークロック',
    'パソコン',
    'ホスト',
    '音量',
    /フレーム|正確/,
  ],
  'zh-hans': [
    '受支持浏览器',
    '受支持的浏览器',
    '往返延迟',
    '共享主时钟',
    '电脑',
    '房主',
    '音量',
    /帧|精准|准确/,
  ],
  'zh-hant': [
    '支援瀏覽器',
    '支援的瀏覽器',
    '往返延遲',
    '共用主時鐘',
    '電腦',
    '房主',
    '音量',
    /幀|精準|準確/,
  ],
  es: [
    'navegador compatible',
    'navegadores compatibles',
    'ida y vuelta',
    'reloj maestro compartido',
    'ordenadores',
    'anfitrión',
    'volumen',
    /fotograma|precis/i,
  ],
  id: [
    'browser yang didukung',
    'browser yang didukung',
    'latensi bolak-balik',
    'jam utama bersama',
    'komputer',
    'host',
    'volume',
    /frame|presisi|akurat/i,
  ],
  'pt-br': [
    'navegador compatível',
    'navegadores compatíveis',
    'ida e volta',
    'relógio mestre compartilhado',
    'computadores',
    'anfitrião',
    'volume',
    /quadro|precis/i,
  ],
  fr: [
    'navigateur compatible',
    'navigateurs compatibles',
    'aller-retour',
    'horloge maîtresse commune',
    'ordinateur',
    'hôte',
    'volume',
    /image près|précis/i,
  ],
  de: [
    'unterstützten browser',
    'unterstützte browser',
    'hin- und rückweg',
    'gemeinsamen referenztakt',
    'computern',
    'host',
    'lautstärke',
    /bildgenau|framegenau|präzis/i,
  ],
  nl: [
    'ondersteunde browser',
    'ondersteunde browsers',
    'roundtriplatentie',
    'gedeelde masterklok',
    'computers',
    'host',
    'volume',
    /frame.?nauwkeurig|nauwkeurig/i,
  ],
  it: [
    'browser supportato',
    'browser supportati',
    'andata e ritorno',
    'riferimento temporale condiviso',
    'computer',
    'host',
    'volume',
    /fotogramm|precis/i,
  ],
  pl: [
    'obsługiwanej przeglądarki',
    'obsługiwane przeglądarki',
    'w obie strony',
    'wspólnego zegara głównego',
    'komputer',
    'host',
    'głośność',
    /klatk|dokładn/i,
  ],
  ru: [
    'поддерживаемым браузером',
    'поддерживаемые браузеры',
    'до хоста и обратно',
    'общим эталонным часам',
    'компьютер',
    'хост',
    'громкость',
    /покадров|кадр|точн/i,
  ],
  th: [
    'เบราว์เซอร์ที่รองรับ',
    'เบราว์เซอร์ที่รองรับ',
    'เวลาไป-กลับ',
    'นาฬิกาหลักร่วมกัน',
    'คอมพิวเตอร์',
    'เจ้าของห้อง',
    'เสียงอุปกรณ์',
    /เฟรม|แม่น|ละเอียด/i,
  ],
  tr: [
    'desteklenen bir tarayıcı',
    'desteklenen tarayıcılar',
    'gidiş-dönüş',
    'ortak ana saat',
    'bilgisayar',
    'oda sahibi',
    'sesini',
    /kare|hassas|kesin/i,
  ],
  vi: [
    'trình duyệt được hỗ trợ',
    'trình duyệt được hỗ trợ',
    'độ trễ khứ hồi',
    'đồng hồ chủ dùng chung',
    'máy tính',
    'chủ phòng',
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
        roundTrip,
        sharedClock,
        computer,
        host,
        volume,
        exaggeratedSync,
      ] = contract;

      expectContains(dictionary['code.lead'], codeBrowser, `${language}.code.lead`);
      expectContains(
        dictionary['remote.reach_value'],
        reachBrowser,
        `${language}.remote.reach_value`,
      );
      expectContains(dictionary['sync.lead'], roundTrip, `${language}.sync.lead round trip`);
      expectContains(dictionary['sync.lead'], sharedClock, `${language}.sync.lead shared clock`);
      expect(
        `${dictionary['sync.h2']} ${dictionary['sync.video_value']}`,
        `${language} sync precision claim`,
      ).not.toMatch(exaggeratedSync);
      expectContains(
        dictionary['standin.platform_value'],
        computer,
        `${language}.standin.platform_value`,
      );
      expectContains(dictionary['standin.caveat'], host, `${language}.standin.caveat host`);
      expectContains(dictionary['standin.caveat'], volume, `${language}.standin.caveat volume`);
    }
  });
});
