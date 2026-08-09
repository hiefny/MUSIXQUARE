import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import ko from '../ko.ts';

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');

describe('initial app-shell translation fallbacks', () => {
  it('keeps every authored Korean fallback aligned with the runtime dictionary', async () => {
    const html = await readFile('index.html', 'utf8');
    const document = new JSDOM(html).window.document;

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      const key = element.dataset.i18n as keyof typeof ko;
      const fallback = normalizeText(element.textContent || '');
      if (!fallback) continue;
      expect(fallback, key).toBe(normalizeText(ko[key]));
    }

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
      const key = element.dataset.i18nHtml as keyof typeof ko;
      const fallback = normalizeText(element.innerHTML);
      if (!fallback) continue;
      expect(fallback, key).toBe(normalizeText(ko[key]));
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
        const key = element.getAttribute(binding) as keyof typeof ko;
        const fallback = element.getAttribute(attribute) || '';
        if (!fallback) continue;
        expect(fallback, `${key} (${attribute})`).toBe(ko[key]);
      }
    }
  });
});
