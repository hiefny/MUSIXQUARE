import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { APP_DICTIONARIES, type TranslationDictionary } from '../catalogs.ts';

// Owner decision 2026-10-29: the help tab names the four roles with the same
// words the role chips show (demo.role_center_short, common.left,
// common.right, demo.role_bass_short), so a reader matches each list item to
// a chip at a glance. Only the name inside <strong> follows the chips; the
// separator after it (':' or ' :' or '：'), the description, the markup and
// the <bdi dir="ltr"> channel letters stay as each catalog wrote them.
const ROLE_NAME_KEYS = [
  'demo.role_center_short',
  'common.left',
  'common.right',
  'demo.role_bass_short',
] as const;

const SEPARATOR = /\s*[:：]$/u;

function chipWords(dictionary: TranslationDictionary): string[] {
  return ROLE_NAME_KEYS.map((key) => {
    const value = dictionary[key];
    if (value === undefined) throw new Error(`Missing chip word ${key}`);
    return value;
  });
}

function helpRoleNames(html: string): string[] {
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  return [...document.querySelectorAll('ul.help-list > li > strong')].map((strong) => {
    const text = strong.textContent ?? '';
    expect(text, `separator after ${text}`).toMatch(SEPARATOR);
    return text.replace(SEPARATOR, '');
  });
}

describe('help tab role names', () => {
  it('name the four roles with each locale’s chip words', () => {
    const mismatches: string[] = [];
    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const names = helpRoleNames(dictionary['player.play_speakers_html'] ?? '');
      const expected = chipWords(dictionary);
      expect(names, `${language} list items`).toHaveLength(ROLE_NAME_KEYS.length);
      if (names.join('|') !== expected.join('|')) {
        mismatches.push(`${language}: ${JSON.stringify(names)} != ${JSON.stringify(expected)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keep the English fallback in both index.html help panels on the chip words', async () => {
    const html = await readFile('index.html', 'utf8');
    const document = new JSDOM(html).window.document;
    const panels = [...document.querySelectorAll('[data-i18n-html="player.play_speakers_html"]')];
    expect(panels).toHaveLength(2);
    const expected = chipWords(APP_DICTIONARIES.en);
    for (const panel of panels) {
      expect(helpRoleNames(panel.innerHTML)).toEqual(expected);
    }
  });
});
