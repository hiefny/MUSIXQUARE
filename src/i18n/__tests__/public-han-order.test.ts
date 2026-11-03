/**
 * The app's Han order on the pages outside the app: /han-order.js marks the
 * root with data-mxqr-han-order from the browser's languages exactly as the
 * app does at startup (src/i18n/startup-han-order.ts, applied by
 * src/i18n/locale-fonts.ts), so /web-fonts/stacks.css draws Han in the same
 * family first. A classic script cannot import the app module; this test
 * holds its copy to the app's.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import { PUBLIC_HAN_ORDER_SCRIPT_URL } from '../public-font-urls.ts';
import { resolveHanOrder } from '../startup-han-order.ts';

const asset = CLASSIC_RUNTIME_ASSETS.find(
  ({ outputPath }) => `/${outputPath}` === PUBLIC_HAN_ORDER_SCRIPT_URL,
);
const runtime = asset ? (await compileClassicRuntimeAsset(process.cwd(), asset)).code : '';

/** The root's Han order mark after the script runs under these browser languages. */
function markUnder(languages: readonly string[] | undefined, language = ''): string | null {
  const dom = new JSDOM('<!doctype html><html lang="en"><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://musixquare.com/about',
  });
  Object.defineProperty(dom.window.navigator, 'languages', {
    configurable: true,
    value: languages,
  });
  Object.defineProperty(dom.window.navigator, 'language', { configurable: true, value: language });
  dom.window.eval(runtime);
  const mark = dom.window.document.documentElement.getAttribute('data-mxqr-han-order');
  dom.window.close();
  return mark;
}

/** What the app sets: nothing for Korean, the order's name otherwise. */
function appMark(languages: readonly string[]): string | null {
  const order = resolveHanOrder(languages);
  return order === 'ko' ? null : order;
}

const LANGUAGE_LISTS: readonly (readonly string[])[] = [
  [],
  [''],
  ['en-US'],
  ['en-US', 'en'],
  ['ko'],
  ['ko-KR', 'ja-JP'],
  ['ja'],
  ['ja-JP'],
  ['JA-jp'],
  [' ja '],
  ['jav'],
  ['kok'],
  ['zh'],
  ['zh', 'ko'],
  ['zh-CN'],
  ['zh_CN'],
  ['zh-Hans'],
  ['zh-Hans-CN'],
  ['zh-hansx'],
  ['zh-SG'],
  ['zh-TW'],
  ['zh-HK'],
  ['zh-MO'],
  ['zh-Hant'],
  ['zh-Hant-TW'],
  ['zh_TW'],
  ['en-GB', 'fr', 'ja-JP', 'ko'],
  ['de', 'zh-TW', 'ja'],
  ['fr-FR', 'zh-CN', 'zh-TW'],
  ['es', 'pt-BR'],
];

describe('the public pages mark the app Han order', () => {
  it('ships as a classic runtime at the URL the pages load', () => {
    expect(asset).toBeDefined();
    expect(runtime).toContain('data-mxqr-han-order');
  });

  it.each(LANGUAGE_LISTS.map((list) => [JSON.stringify(list), list] as const))(
    'marks the root as the app does under browser languages %s',
    (_label, languages) => {
      expect(markUnder(languages)).toBe(appMark(languages));
    },
  );

  it('falls back to navigator.language when the browser lists no languages, as the app does', () => {
    for (const language of ['ja-JP', 'zh-TW', 'ko-KR', 'en-US', '']) {
      expect(markUnder([], language), language).toBe(appMark([language]));
      expect(markUnder(undefined, language), language).toBe(appMark([language]));
    }
  });
});
