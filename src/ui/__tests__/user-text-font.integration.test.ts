/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fontRuntimeFactory = vi.hoisted(() => vi.fn(() => ({ default: {} })));
vi.mock('../../i18n/locale-fonts.ts', fontRuntimeFactory);

import { applyUserTextFontFallback } from '../user-text-font.ts';

afterEach(() => {
  document.documentElement.lang = '';
  document.documentElement.removeAttribute('data-mxqr-han-order');
  document.head.replaceChildren();
});

const SAMPLES = [
  'MUSIXQUARE 가나다',
  'かなの曲',
  '这本书',
  '這本書',
  '東京中文',
  'Привет',
  'สวัสดี',
  'مرحبا',
  '练习 練習',
] as const;

function render(lang: string): string[] {
  document.documentElement.lang = lang;
  return SAMPLES.map((text) => {
    const element = document.createElement('span');
    applyUserTextFontFallback(element, text);
    return `${element.className}|${element.dataset.userTextFonts ?? ''}`;
  });
}

describe('user text font boundary in the app document', () => {
  it('marks the same text the same way in the Korean, English and Japanese UIs', () => {
    const korean = render('ko');
    expect(render('en')).toEqual(korean);
    expect(render('ja')).toEqual(korean);
    expect(render('zh-Hant')).toEqual(korean);
  });

  it('ignores the startup Han order, which only the stylesheet reads', () => {
    const korean = render('ko');
    document.documentElement.setAttribute('data-mxqr-han-order', 'ja');
    expect(render('ko')).toEqual(korean);
  });

  it('loads no font runtime and adds no stylesheet', async () => {
    render('ko');
    await vi.dynamicImportSettled();

    expect(fontRuntimeFactory).not.toHaveBeenCalled();
    expect(document.head.querySelector('link, style')).toBeNull();
  });
});
