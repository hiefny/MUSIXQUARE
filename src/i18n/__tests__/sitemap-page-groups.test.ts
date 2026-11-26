import { readFile, readdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SITEMAP_DIRECTORY = '.workshop/sitemap';
const SITEMAP_HTML = `${SITEMAP_DIRECTORY}/sitemap.html`;
const SITEMAP_CSS = `${SITEMAP_DIRECTORY}/sitemap.css`;
const SITEMAP_SCRIPT = `${SITEMAP_DIRECTORY}/main.ts`;

// Column order, which is also reading and keyboard order: Explore; Help over
// Policies; Resources over Community. sitemap.css balances the three columns
// for exactly these thirteen entries.
const PAGE_GROUPS = [
  ['explore', 'Explore', ['/', '/about', '/history', '/designsystem', '/blog']],
  ['help', 'Help', ['/faq', '/status']],
  ['policies', 'Policies', ['/privacy', '/terms']],
  ['resources', 'Resources', ['/developers', '/translate']],
  [
    'community',
    'Community',
    ['https://github.com/hiefny/MUSIXQUARE', 'https://discord.gg/PmmFhGTBsX'],
  ],
] as const;

let dom: JSDOM;
let document: Document;
let html = '';

beforeAll(async () => {
  html = await readFile(SITEMAP_HTML, 'utf8');
  dom = new JSDOM(html);
  document = dom.window.document;
});

afterAll(() => {
  dom.window.close();
});

describe('the HTML sitemap page groups', () => {
  it('lists the page groups in column order with their links', async () => {
    const groups = [...document.querySelectorAll<HTMLElement>('#pages > section.page-group')];
    expect(groups.map((group) => group.className)).toEqual(
      PAGE_GROUPS.map(([key]) => `page-group page-group--${key}`),
    );
    for (const [index, [key, heading, links]] of PAGE_GROUPS.entries()) {
      const group = groups[index]!;
      expect(group.hasAttribute('data-group'), key).toBe(true);
      expect(group.querySelector('h2')?.textContent, key).toBe(heading);
      expect(
        [...group.querySelectorAll('a.page-link')].map((link) => link.getAttribute('href')),
        key,
      ).toEqual(links);
    }
    expect(document.querySelectorAll('#pages [data-item]')).toHaveLength(13);

    const css = await readFile(SITEMAP_CSS, 'utf8');
    for (const [key] of PAGE_GROUPS) {
      expect(css, key).toContain(`.page-group--${key} {\n  grid-area: ${key};\n}`);
    }
  });

  it('keeps Status a plain page link in the Help group', () => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/status"]')];
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link?.closest('section')?.classList.contains('page-group--help')).toBe(true);
    expect(link?.className).toBe('page-link');
    expect(link?.getAttributeNames().sort()).toEqual(['class', 'href']);
    expect(link?.querySelector('strong')?.textContent).toBe('Status');
    expect(link?.querySelector('.path')?.textContent).toBe('/status');
    expect(link?.textContent?.trim()).toBe('Status/status');
    expect(link?.closest('li')?.getAttributeNames().sort()).toEqual(['data-item', 'data-search']);
  });

  it('shows no live status anywhere on the sitemap', async () => {
    const script = await readFile(SITEMAP_SCRIPT, 'utf8');
    for (const [file, source] of [
      [SITEMAP_HTML, html],
      [SITEMAP_SCRIPT, script],
    ] as const) {
      expect(source, file).not.toContain('/api/status');
    }
    expect(script).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|EventSource|WebSocket/u);
    expect(document.querySelectorAll('[class*="status"]')).toHaveLength(0);
    for (const node of document.querySelectorAll('*')) {
      const names = node.getAttributeNames().filter((name) => name.startsWith('data-'));
      expect(
        names.filter((name) => /status|state/u.test(name)),
        node.tagName,
      ).toEqual([]);
    }
    const files = await readdir(SITEMAP_DIRECTORY);
    expect(files.filter((file) => file.startsWith('variant-'))).toEqual([]);
  });

  it('keeps the hooks the sitemap search script reads', async () => {
    expect(document.querySelector('input#sitemap-search[type="search"]')).not.toBeNull();
    expect(document.querySelector('button.clear-search')).not.toBeNull();
    expect(document.querySelector('.empty')).not.toBeNull();
    expect(document.querySelector('#search-status[role="status"]')).not.toBeNull();
    expect([...document.querySelectorAll('[data-section]')].map((section) => section.id)).toEqual([
      'pages',
      'languages',
    ]);
    expect(document.querySelectorAll('[data-group]')).toHaveLength(PAGE_GROUPS.length);
    expect(document.querySelector('#languages [data-count]')).not.toBeNull();
    const items = [...document.querySelectorAll('[data-item]')];
    expect(items.length).toBeGreaterThan(13);
    expect(items.every((item) => (item.getAttribute('data-search') ?? '').trim() !== '')).toBe(
      true,
    );
    expect(document.querySelector('[data-item][data-search*="/status"]')).not.toBeNull();

    const script = await readFile(SITEMAP_SCRIPT, 'utf8');
    for (const hook of [
      "'#sitemap-search'",
      "'.clear-search'",
      "'.empty'",
      "'#search-status'",
      "'[data-item]'",
      "'[data-section]'",
      "'[data-group]'",
      "'[data-count]'",
      'dataset.search',
    ]) {
      expect(script, hook).toContain(hook);
    }
  });

  it('keeps Community a labelled region', () => {
    const community = document.querySelector('#pages > section#community');
    expect(community?.getAttribute('aria-labelledby')).toBe('community-heading');
    expect(document.querySelector('#community-heading')?.textContent).toBe('Community');
  });
});
