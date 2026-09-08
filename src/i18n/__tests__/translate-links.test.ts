/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_DICTIONARIES } from '../catalogs.ts';
import { LANGUAGE_OPTIONS } from '../locales.ts';

const appHtml = readFileSync('index.html', 'utf8');
const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

function expectSessionPreservingLink(link: HTMLAnchorElement | null): void {
  expect(link).not.toBeNull();
  expect(link?.getAttribute('href')).toBe('/translate');
  expect(link?.target).toBe('_blank');
  expect(link?.rel.split(/\s+/).sort()).toEqual(['noopener', 'noreferrer']);
  expect(link?.textContent?.trim()).not.toBe('');
}

describe('app translation contribution links', () => {
  it('places one translation link between Design and GitHub in every localized legal footer', () => {
    for (const { code } of LANGUAGE_OPTIONS) {
      const dictionary = APP_DICTIONARIES[code];
      const document = parse(dictionary['legal.content_html']);
      const links = [...document.querySelectorAll<HTMLAnchorElement>('a')];
      const designIndex = links.findIndex((link) => link.getAttribute('href') === '/designsystem');
      expect(designIndex, code).toBeGreaterThanOrEqual(0);
      expectSessionPreservingLink(links[designIndex + 1] ?? null);
      expect(links[designIndex + 2]?.getAttribute('href'), code).toBe(
        'https://github.com/hiefny/MUSIXQUARE',
      );
      expect(document.querySelectorAll('a[href="/translate"]'), code).toHaveLength(1);
      expect(dictionary['settings.help_translate'].trim(), code).not.toBe('');
    }
    expect(APP_DICTIONARIES.en['settings.help_translate']).toBe('Help translate');
    expect(APP_DICTIONARIES.ko['settings.help_translate']).toBe('번역 참여');
  });

  it('keeps both initial legal fallbacks identical to the complete English legal copy', () => {
    const document = parse(appHtml);
    const fallbacks = document.querySelectorAll('[data-i18n-html="legal.content_html"]');
    const expected = parse(APP_DICTIONARIES.en['legal.content_html']).body.innerHTML;
    expect(fallbacks).toHaveLength(2);
    for (const fallback of fallbacks) expect(fallback.innerHTML).toBe(expected);
  });

  it('offers a normal new-tab link below Done inside the labelled language dialog', () => {
    const document = parse(appHtml);
    const dialog = document.querySelector('#language-dialog-overlay [role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('language-dialog-title');
    const done = dialog?.querySelector<HTMLButtonElement>('#btn-language-dialog-done');
    expect(done?.type).toBe('button');
    expect(done?.getAttribute('data-i18n')).toBe('common.done');
    const links = done?.closest('.dialog-actions')?.nextElementSibling;
    const translate = links?.querySelector<HTMLAnchorElement>('a[href="/translate"]') ?? null;
    expectSessionPreservingLink(translate);
    expect(translate?.getAttribute('data-i18n')).toBe('settings.help_translate');
    expect(translate?.tabIndex).toBe(0);
    expect(translate?.closest('[hidden], [inert]')).toBeNull();
  });
});
