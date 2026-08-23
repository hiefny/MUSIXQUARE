/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const PLAY_PATH = 'M8 5v14l11-7z';
const YOUTUBE_PATH =
  'M21.582 6.186a2.5 2.5 0 0 0-1.768-1.768C18.254 4 12 4 12 4s-6.254 0-7.814.418a2.5 2.5 0 0 0-1.768 1.768C2 7.746 2 12 2 12s0 4.254.418 5.814a2.5 2.5 0 0 0 1.768 1.768C5.746 20 12 20 12 20s6.254 0 7.814-.418a2.5 2.5 0 0 0 1.768-1.768C22 16.254 22 12 22 12s0-4.254-.418-5.814ZM10 15.464V8.536L16 12l-6 3.464Z';
const YOUTUBE_PLAYLIST_PATH = 'M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z';
const FILE_PATH =
  'M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7Z';
const CLOSE_PATH =
  'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z';

const NAV_PATHS = [
  FILE_PATH,
  'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
  'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
  'M433-80q-27 0-46.5-18T363-142l-9-66q-13-5-24.5-12T307-235l-62 26q-25 11-50 2t-39-32l-47-82q-14-23-8-49t27-43l53-40q-1-7-1-13.5v-27q0-6.5 1-13.5l-53-40q-21-17-27-43t8-49l47-82q14-23 39-32t50 2l62 26q11-8 23-15t24-12l9-66q4-26 23.5-44t46.5-18h94q27 0 46.5 18t23.5 44l9 66q13 5 24.5 12t22.5 15l62-26q25-11 50-2t39 32l47 82q14 23 8 49t-27 43l-53 40q1 7 1 13.5v27q0 6.5-2 13.5l53 40q21 17 27 43t-8 49l-48 82q-14 23-39 32t-50-2l-60-26q-11 8-23 15t-24 12l-9 66q-4 26-23.5 44T527-80h-94Zm7-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z',
  'M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z',
] as const;

let designDocument: Document;
let designSource: string;
let designStylesheet: string;
let designTokenStylesheet: string;

function normalizedPath(path: string | null): string {
  return (path ?? '').replace(/[\s,]+/gu, '').toLowerCase();
}

function customPropertyValue(stylesheet: string, token: string): string | undefined {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return stylesheet
    .match(new RegExp(`${escapedToken}\\s*:\\s*([^;]+);`, 'iu'))?.[1]
    ?.trim()
    .toLowerCase();
}

function sectionWithHeading(name: string): HTMLElement {
  const heading = [...designDocument.querySelectorAll('h2')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  expect(heading, `missing ${name} section`).toBeTruthy();
  const section = heading?.closest<HTMLElement>('section');
  expect(section, `missing ${name} section wrapper`).toBeTruthy();
  return section!;
}

beforeAll(() => {
  designSource = readFileSync(resolve('public/designsystem/index.html'), 'utf8');
  const parsedDocument = new DOMParser().parseFromString(designSource, 'text/html');
  document.head.innerHTML = parsedDocument.head.innerHTML;
  document.body.innerHTML = parsedDocument.body.innerHTML;
  designDocument = document;
  designStylesheet = readFileSync(resolve('public/editorial-design.css'), 'utf8');
  designTokenStylesheet = readFileSync(resolve('public/designsystem/colors_and_type.css'), 'utf8');
  const style = designDocument.createElement('style');
  style.textContent = designStylesheet;
  designDocument.head.append(style);
});

describe('public design-system page contract', () => {
  it('keeps editorial numbering and retired app concepts out of the page', () => {
    const visibleCopy = designDocument.body.textContent ?? '';
    const components = sectionWithHeading('Components');

    expect(designDocument.querySelectorAll('.section-head .num')).toHaveLength(0);
    expect(visibleCopy).not.toMatch(/\b(?:HOST|SELF)[\s_-]*CTRL\b/iu);
    expect(components.textContent).not.toMatch(/equalizer/iu);
    expect(
      designDocument.querySelector('.equalizer, .wave, .duration, .right-time, .playlist-duration'),
    ).toBeNull();
  });

  it('documents all three normal text tones in both themes', () => {
    const tones = [...designDocument.querySelectorAll<HTMLElement>('.text-theme-grid .text-tone')];
    const expected = [
      ['--text-main', '#eeeeee'],
      ['--text-sub', '#a1a1aa'],
      ['--text-muted', '#71717a'],
      ['--text-main', '#303540'],
      ['--text-sub', '#495057'],
      ['--text-muted', '#868e96'],
    ] as const;

    expect(tones).toHaveLength(expected.length);
    expect(
      tones.map((tone) => {
        const reference = tone.querySelector('code')?.textContent?.toLowerCase() ?? '';
        const token = reference.match(/--text-(?:main|sub|muted)/u)?.[0];
        const color = reference.match(/#[\da-f]{6}/u)?.[0];
        return [token, color];
      }),
    ).toEqual(expected.map(([token, color]) => [token, color]));
  });

  it('publishes the production semantic color and control tokens', () => {
    const expectedTokens = {
      '--play-action-surface': 'var(--surface-2)',
      '--primary-filled': '#3b82f6',
      '--success-filled': '#20a45a',
      '--danger-filled': '#ef4444',
      '--warning-filled': '#f59e0b',
      '--youtube-filled': '#ff0033',
      '--control-active': 'rgba(var(--primary-rgb), 0.13)',
      '--control-danger': 'rgba(255, 59, 48, 0.09)',
      '--control-danger-hover': 'rgba(255, 59, 48, 0.13)',
    } as const;

    const advertisedTokens = [...designDocument.querySelectorAll('.tokens .tok')].map((token) =>
      (token.textContent ?? '').trim(),
    );
    for (const [token, value] of Object.entries(expectedTokens)) {
      expect(customPropertyValue(designTokenStylesheet, token), `${token} public mirror`).toBe(
        value,
      );
    }
    expect(advertisedTokens).toEqual(expect.arrayContaining(Object.keys(expectedTokens)));

    expect(designSource).not.toContain('The only accent');
  });

  it('shows the current playlist leading state, source icons, and remove action', () => {
    const playlist = sectionWithHeading('Components').querySelector<HTMLElement>('.pl');
    expect(playlist).toBeTruthy();

    const items = [...(playlist?.querySelectorAll<HTMLElement>('.playlist-item') ?? [])];
    const current = items.find((item) =>
      item.matches('.active, .is-current, [aria-current="true"]'),
    );
    const currentLeading = current?.querySelector<HTMLElement>('.playlist-leading');
    const sourcePaths = items.map((item) =>
      normalizedPath(item.querySelector('.playlist-source path')?.getAttribute('d') ?? null),
    );
    const removePaths = items.map((item) =>
      normalizedPath(item.querySelector('.playlist-remove path')?.getAttribute('d') ?? null),
    );

    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(playlist?.querySelector('.dur, .duration, .playlist-duration')).toBeNull();
    expect(playlist?.textContent).not.toMatch(/\b\d+:\d{2}\b/u);
    expect(currentLeading?.textContent?.trim()).toBe('');
    expect(normalizedPath(currentLeading?.querySelector('path')?.getAttribute('d') ?? null)).toBe(
      normalizedPath(PLAY_PATH),
    );
    expect(sourcePaths).toEqual(
      [FILE_PATH, YOUTUBE_PATH, YOUTUBE_PLAYLIST_PATH].map(normalizedPath),
    );
    expect(removePaths).toEqual(items.map(() => normalizedPath(CLOSE_PATH)));
    expect(
      items.every((item) => item.lastElementChild?.classList.contains('playlist-remove')),
    ).toBe(true);
  });

  it('uses the five current compact-navigation labels and exact production icons', () => {
    const nav = designDocument.querySelector<HTMLElement>('.app-bottom-nav');
    const tabs = [...(nav?.querySelectorAll<HTMLElement>('.tab') ?? [])];

    expect(nav).toBeTruthy();
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Home',
      'Playlist',
      'Connect',
      'Settings',
      'Help',
    ]);
    expect(
      tabs.map((tab) => normalizedPath(tab.querySelector('path')?.getAttribute('d') ?? null)),
    ).toEqual(NAV_PATHS.map(normalizedPath));
    expect(tabs[3]?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(tabs.every((tab) => tab instanceof HTMLButtonElement)).toBe(true);
    expect(nav?.getAttribute('role')).toBe('tablist');
    expect(tabs.every((tab) => tab.getAttribute('role') === 'tab')).toBe(true);
    expect(designDocument.querySelector('.glass-nav')).toBeNull();
  });

  it('mirrors manual, OS-preference, and forced-color palette ownership', () => {
    expect(designTokenStylesheet).toContain("html[data-contrast='more']");
    expect(designTokenStylesheet).toContain("html[data-theme='light'][data-contrast='more']");
    expect(designTokenStylesheet).toContain('@media (prefers-contrast: more)');
    expect(designTokenStylesheet).toContain("html:not([data-contrast='normal'])");
    expect(designTokenStylesheet).toContain('@media (forced-colors: active)');
    expect(designTokenStylesheet).toMatch(/--bg:\s*Canvas\s*!important/iu);
    expect(designTokenStylesheet).toMatch(/--primary-filled:\s*Highlight\s*!important/iu);
  });

  it('describes filled icons as the default and exposes a deliberate stroke exception', () => {
    const iconography = sectionWithHeading('Iconography');
    const samples = [...iconography.querySelectorAll<HTMLElement>('.icon-grid .icon-sample')];
    const filled = samples.filter((sample) => sample.dataset.iconStyle === 'filled');
    const stroked = samples.filter((sample) => sample.dataset.iconStyle === 'stroke');
    const pureStroke = stroked.find((sample) => sample.querySelector('.stroke-icon'));
    const mixed = stroked.find((sample) => sample.querySelector('.mixed-icon'));
    const copy = iconography.textContent ?? '';

    expect(copy).toMatch(/filled[\s\S]*default/iu);
    expect(copy).toMatch(/stroke[\s\S]*(?:exception|reserved)/iu);
    expect(filled.length).toBeGreaterThan(stroked.length);
    expect(stroked.length).toBeGreaterThanOrEqual(1);
    expect(
      filled.every(
        (sample) =>
          getComputedStyle(sample.querySelector('svg')!).fill.toLowerCase() === 'currentcolor',
      ),
    ).toBe(true);
    expect(pureStroke).toBeTruthy();
    expect(getComputedStyle(pureStroke!.querySelector('svg')!).fill).toBe('none');
    expect(getComputedStyle(pureStroke!.querySelector('svg')!).stroke.toLowerCase()).toBe(
      'currentcolor',
    );
    expect(mixed).toBeTruthy();
    expect(getComputedStyle(mixed!.querySelector('.speaker')!).fill.toLowerCase()).toBe(
      'currentcolor',
    );
    expect(getComputedStyle(mixed!.querySelector('.waves')!).fill).toBe('none');
    expect(getComputedStyle(mixed!.querySelector('.waves')!).stroke.toLowerCase()).toBe(
      'currentcolor',
    );
    expect(copy).not.toMatch(/24[×x]24 viewbox, single path/iu);
  });

  it('does not advertise design-page recipes as production tokens', () => {
    const advertisedTokens = [...designDocument.querySelectorAll('.tokens .tok')].map((token) =>
      (token.textContent ?? '').trim(),
    );

    expect(advertisedTokens).not.toContain('--radius-pill');
    expect(advertisedTokens.some((token) => /^--space-/u.test(token))).toBe(false);
    expect(advertisedTokens.some((token) => /^--(?:ease|dur)-/u.test(token))).toBe(false);
    expect(designTokenStylesheet).not.toMatch(/^\s*--radius-pill\s*:/mu);
    expect(designTokenStylesheet).toMatch(
      /Documentation-only scale aliases[\s\S]*not production :root tokens/iu,
    );
  });
});
