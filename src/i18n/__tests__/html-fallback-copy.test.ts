import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import en from '../en.ts';

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');
const normalizeHtml = (value: string): string => {
  const document = new JSDOM(`<body>${value}</body>`).window.document;
  return normalizeText(document.body.innerHTML);
};

describe('initial app-shell translation fallbacks', () => {
  it('keeps every authored English fallback aligned with the runtime dictionary', async () => {
    const html = await readFile('index.html', 'utf8');
    const document = new JSDOM(html).window.document;

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      const key = element.dataset.i18n as keyof typeof en;
      const fallback = normalizeText(element.textContent || '');
      if (!fallback) continue;
      expect(fallback, key).toBe(normalizeText(en[key]));
    }

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
      const key = element.dataset.i18nHtml as keyof typeof en;
      const fallback = normalizeHtml(element.innerHTML);
      if (!fallback) continue;
      expect(fallback, key).toBe(normalizeHtml(en[key]));
    }

    const attributeBindings = [
      ['placeholder', 'data-i18n-placeholder'],
      ['aria-label', 'data-i18n-aria-label'],
      ['title', 'data-i18n-title'],
      ['alt', 'data-i18n-alt'],
      ['data-placeholder', 'data-i18n-data-placeholder'],
    ] as const;

    for (const [attribute, binding] of attributeBindings) {
      for (const element of document.querySelectorAll<HTMLElement>(`[${binding}]`)) {
        const key = element.getAttribute(binding) as keyof typeof en;
        const fallback = element.getAttribute(attribute) || '';
        if (!fallback) continue;
        expect(fallback, `${key} (${attribute})`).toBe(en[key]);
      }
    }

    expect(document.querySelector('#seek-slider')?.getAttribute('aria-valuetext')).toBe(
      en['player.no_media'],
    );
    const emptyDeviceList = en['connect.device_list'].replace('{{count}}', '0');
    expect(document.querySelector('#connect-device-title')?.textContent).toBe(emptyDeviceList);
    expect(document.querySelector('#desktop-device-title')?.textContent).toBe(emptyDeviceList);
  });
});
