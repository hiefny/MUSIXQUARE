import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import { LANGUAGE_OPTIONS } from '../index.ts';

type LandingDictionary = Record<string, Record<string, string>>;
type StaticLanguageOption = { code: string };

async function loadLandingDictionary(): Promise<LandingDictionary> {
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'landing-i18n.js',
  );
  if (!asset) throw new Error('Classic landing i18n runtime is missing from the manifest.');
  const source = (await compileClassicRuntimeAsset(process.cwd(), asset)).code;
  const marker = /(\s+function normalizeSelection\(lang\) \{)/u;
  expect(source).toMatch(marker);

  const windowObject: Record<string, unknown> = {};
  vm.runInNewContext(
    source.replace(marker, '\n    window.__landingI18n = i18n;\n    return;\n$1'),
    { window: windowObject },
  );
  return windowObject.__landingI18n as LandingDictionary;
}

async function loadStaticLanguageOptions(): Promise<StaticLanguageOption[]> {
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'static-language.js',
  );
  if (!asset) throw new Error('Classic static-language runtime is missing from the manifest.');
  const source = (await compileClassicRuntimeAsset(process.cwd(), asset)).code;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://musixquare.com/',
  });
  try {
    dom.window.eval(source);
    const runtime = (
      dom.window as unknown as {
        MXQRStaticLang?: { options: StaticLanguageOption[] };
      }
    ).MXQRStaticLang;
    if (!runtime) throw new Error('Compiled static-language runtime did not publish its API.');
    return runtime.options;
  } finally {
    dom.window.close();
  }
}

describe('landing-page translation integrity', () => {
  it('keeps the app, landing dictionaries, and static language picker in sync', async () => {
    const [dictionaries, options] = await Promise.all([
      loadLandingDictionary(),
      loadStaticLanguageOptions(),
    ]);

    const appLanguages = LANGUAGE_OPTIONS.map(({ code }) => code).sort();
    expect(Object.keys(dictionaries).sort()).toEqual(appLanguages);
    expect(options.map(({ code }) => code).sort()).toEqual(appLanguages);
  });

  it('defines every English key with non-empty copy in every language', async () => {
    const dictionaries = await loadLandingDictionary();
    const englishKeys = Object.keys(dictionaries.en).sort();

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      expect(Object.keys(dictionary).sort(), language).toEqual(englishKeys);
      expect(
        Object.entries(dictionary).filter(
          ([, value]) => typeof value !== 'string' || !value.trim(),
        ),
        language,
      ).toEqual([]);
    }
  });

  it('preserves functional markup and placeholders from the English source', async () => {
    const dictionaries = await loadLandingDictionary();
    const tags = (value: string): string[] => value.match(/<\/?[a-z][^>]*>/gi) || [];
    const placeholders = (value: string): string[] => (value.match(/\{\{\w+\}\}/g) || []).sort();

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      for (const [key, englishValue] of Object.entries(dictionaries.en)) {
        expect(tags(dictionary[key]), `${language}.${key}`).toEqual(tags(englishValue));
        expect(placeholders(dictionary[key]), `${language}.${key}`).toEqual(
          placeholders(englishValue),
        );
      }
    }
  });

  it('keeps the About marketing copy open to multiple devices in any location', async () => {
    const dictionaries = await loadLandingDictionary();
    const removedSpatialClaims: Record<string, string[]> = {
      en: ['in the room'],
      ko: ['같은 방', '같은 공간'],
      ja: ['同じ空間'],
      'zh-hans': ['同一空间'],
      'zh-hant': ['同一空間'],
      es: ['de una sala', 'de un mismo espacio'],
      'pt-br': ['no mesmo ambiente', 'no mesmo espaço'],
      fr: ['d’un même espace'],
      de: ['im selben raum'],
      nl: ['in dezelfde ruimte'],
      it: ['nello stesso spazio'],
      pl: ['w tym samym miejscu'],
      ru: ['в одном пространстве'],
      tr: ['aynı ortamdaki', 'aynı alandaki'],
      id: ['di tempat yang sama', 'di ruang yang sama'],
      vi: ['trong cùng một không gian'],
      th: ['ในพื้นที่เดียวกัน'],
    };

    for (const [language, fragments] of Object.entries(removedSpatialClaims)) {
      const marketingCopy = [
        dictionaries[language]['meta.description'],
        dictionaries[language]['hero.lead'],
      ]
        .join(' ')
        .toLowerCase();
      for (const fragment of fragments) {
        expect(marketingCopy, `${language}: ${fragment}`).not.toContain(fragment.toLowerCase());
      }
    }

    expect(dictionaries.ko['hero.lead']).toBe(
      'MUSIXQUARE는 여러 개의 폰, 태블릿, 노트북을 하나의 사운드 시스템으로 묶어줘요. 설치 없이 코드 하나만 공유하면 돼요.',
    );
  });

  it('uses concise chat and NTP synchronization labels in every language', async () => {
    const dictionaries = await loadLandingDictionary();
    const expected: Record<string, readonly [chat: string, sync: string]> = {
      en: ['Real-time chat', '60-sample NTP-style sync'],
      ko: ['실시간 채팅', '60샘플 NTP 방식 동기화'],
      ja: ['リアルタイムチャット', '60サンプルのNTP方式同期'],
      'zh-hans': ['实时聊天', '60 个样本的 NTP 方式同步'],
      'zh-hant': ['即時聊天', 'NTP 式同步（60 次取樣）'],
      es: ['Chat en tiempo real', 'Sincronización tipo NTP con 60 muestras'],
      'pt-br': ['Chat em tempo real', 'Sincronização tipo NTP com 60 amostras'],
      fr: ['Chat en temps réel', 'Synchronisation de type NTP sur 60 échantillons'],
      de: ['Echtzeit-Chat', 'NTP-ähnliche Synchronisierung mit 60 Messungen'],
      nl: ['Realtimechat', 'NTP-achtige synchronisatie met 60 metingen'],
      it: ['Chat in tempo reale', 'Sincronizzazione tipo NTP con 60 campioni'],
      pl: ['Czat w czasie rzeczywistym', 'Synchronizacja typu NTP z 60 próbkami'],
      ru: ['Чат в реальном времени', 'Синхронизация в стиле NTP по 60 замерам'],
      tr: ['Gerçek zamanlı sohbet', '60 örnekli NTP tarzı senkronizasyon'],
      id: ['Chat waktu nyata', 'Sinkronisasi ala NTP dengan 60 sampel'],
      vi: ['Trò chuyện thời gian thực', 'Đồng bộ kiểu NTP với 60 mẫu'],
      th: ['แชตแบบเรียลไทม์', 'ซิงก์แบบ NTP ด้วย 60 ตัวอย่าง'],
    };

    expect(Object.keys(expected).sort()).toEqual(Object.keys(dictionaries).sort());
    for (const [language, [chat, sync]] of Object.entries(expected)) {
      expect(dictionaries[language]['remote.chat_value'], language).toBe(chat);
      expect(dictionaries[language]['sync.meta'], language).toBe(sync);
    }
  });

  it('keeps the Korean showcase chat casual and conversational', async () => {
    const dictionary = (await loadLandingDictionary()).ko;

    expect({
      pin: dictionary['remote.pin_text'],
      hostQuestion: dictionary['remote.host_msg1'],
      peerReply: dictionary['remote.peer_msg1'],
      timestampReply: dictionary['remote.peer_ts_msg'],
      hostReply: dictionary['remote.host_msg2'],
      whisper: dictionary['remote.whisper_msg'],
    }).toEqual({
      pin: '플리 추천받습니다',
      hostQuestion: '어디야?',
      peerReply: '카페에서 작업중ㅋㅋ',
      timestampReply: '이 곡 좋은 듯',
      hostReply: '이따 틀어줄게',
      whisper: '공지로 플리 추천 좀 받아봐',
    });
  });

  it('keeps the Indonesian About copy within the supported-browser and sync contracts', async () => {
    const dictionary = (await loadLandingDictionary()).id;

    expect(dictionary['code.lead']).toContain('browser yang didukung');
    expect(dictionary['remote.reach_value']).toBe('Browser yang didukung, lintas jaringan');
    expect(dictionary['remote.pin_text']).toBe('Minta rekomendasi playlist dong');
    expect(dictionary['remote.whisper_msg']).toContain('pengumuman');
    expect(dictionary['remote.peer_name']).toBe('Peserta 1');
    expect(dictionary['sync.h2']).not.toMatch(/frame/i);
    expect(dictionary['sync.video_value']).toBe('Pemutaran media tersinkronisasi');
    expect(dictionary['code.lead']).not.toMatch(/\bPRO\b/iu);
    expect(dictionary['sync.lead']).not.toMatch(/\bPRO\b/iu);
    expect(dictionary['sync.transport_value']).toContain('WebRTC');
  });

  it('provides a localized lifetime room-count sentence in every language', async () => {
    const dictionaries = await loadLandingDictionary();

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      expect(dictionary['hero.rooms_opened'].match(/\{\{count\}\}/g), language).toHaveLength(1);
    }
    expect(dictionaries.ko['hero.rooms_opened']).toBe('지금까지 {{count}}개의 방이 열렸어요.');
    expect(dictionaries.pl['hero.rooms_opened']).toBe(
      'Liczba dotychczas otwartych pokoi: {{count}}.',
    );
  });

  it('keeps the static English About fallback aligned with its dictionary', async () => {
    const [dictionaries, html] = await Promise.all([
      loadLandingDictionary(),
      readFile('.workshop/landing/landing.html', 'utf8'),
    ]);
    const document = new JSDOM(html).window.document;
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const fallback: Record<string, string> = {
      'meta.title': document.title,
      'meta.description': document.querySelector<HTMLMetaElement>('meta[name="description"]')!
        .content,
      'meta.og_title': document.querySelector<HTMLMetaElement>('meta[property="og:title"]')!
        .content,
      'meta.og_description': document.querySelector<HTMLMetaElement>(
        'meta[property="og:description"]',
      )!.content,
      'meta.og_image_alt': document.querySelector<HTMLMetaElement>('meta[property="og:image:alt"]')!
        .content,
      'meta.tw_title': document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')!
        .content,
      'meta.tw_description': document.querySelector<HTMLMetaElement>(
        'meta[name="twitter:description"]',
      )!.content,
    };

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      fallback[element.dataset.i18n!] = normalize(element.innerHTML);
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
      for (const binding of element.dataset.i18nAttr!.split(',')) {
        const [attribute, key] = binding.split(':');
        fallback[key] = element.getAttribute(attribute)!;
      }
    }

    const runtimeOnlyOrUnused = new Set([
      'hero.rooms_opened',
      'code.toast_success',
      'code.toast_fail',
      'footer.history',
      'footer.designsystem',
      'sync.meta',
    ]);
    expect(Object.keys(fallback).sort()).toEqual(
      Object.keys(dictionaries.en)
        .filter((key) => !runtimeOnlyOrUnused.has(key))
        .sort(),
    );
    for (const [key, value] of Object.entries(fallback)) {
      expect(value, key).toBe(normalize(dictionaries.en[key]));
    }
  });

  it('describes system-audio support by computer class, not Windows/Mac hardware labels', async () => {
    const dictionaries = await loadLandingDictionary();
    const desktopHardwareTerms =
      /desktop browser|デスクトップ.*Chromium|桌面版.*Chromium|เดสก์ท็อป.*Chromium|masaüstü.*Chromium/i;

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      expect(dictionary['standin.platform_value'], language).not.toMatch(/windows|mac(?:os)?/i);
      expect(dictionary['standin.platform_value'], language).not.toMatch(desktopHardwareTerms);
    }
    expect(dictionaries.en['standin.platform_value']).toBe('Chromium-based browsers on computers');
    expect(dictionaries.ko['standin.platform_value']).toBe('컴퓨터의 Chromium 기반 브라우저');
  });
});
