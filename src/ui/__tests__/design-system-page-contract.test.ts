/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const PLAY_PATH = 'M8 5v14l11-7z';
const PLAY_MEDIA_PATH =
  'm431-341 184-122q9-6 9-17t-9-17L431-619q-10-7-20.5-1.5T400-603v246q0 12 10.5 17.5T431-341Zm49 261q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-32 5-64t15-63q5-16 20.5-21.5T150-626q15 8 21.5 23.5T173-570q-6 22-9.5 44.5T160-480q0 134 93 227t227 93q134 0 227-93t93-227q0-134-93-227t-227-93q-24 0-47.5 3.5T386-786q-17 5-32-1t-22-21q-7-15-.5-30.5T354-859q30-11 62-16t64-5q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80ZM177.5-697.5Q160-715 160-740t17.5-42.5Q195-800 220-800t42.5 17.5Q280-765 280-740t-17.5 42.5Q245-680 220-680t-42.5-17.5ZM480-480Z';
const YOUTUBE_PATH =
  'M21.582 6.186a2.5 2.5 0 0 0-1.768-1.768C18.254 4 12 4 12 4s-6.254 0-7.814.418a2.5 2.5 0 0 0-1.768 1.768C2 7.746 2 12 2 12s0 4.254.418 5.814a2.5 2.5 0 0 0 1.768 1.768C5.746 20 12 20 12 20s6.254 0 7.814-.418a2.5 2.5 0 0 0 1.768-1.768C22 16.254 22 12 22 12s0-4.254-.418-5.814ZM10 15.464V8.536L16 12l-6 3.464Z';
const YOUTUBE_PLAYLIST_PATH = 'M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z';
const FILE_PATH =
  'M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.16-1.75 4.45-4H15V6h4V3h-7Z';
const CLOSE_PATH =
  'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z';
const EXPAND_PATH = 'm6.5 9 5.5 5.5L17.5 9';
const REPEAT_PATH = 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z';
const SHUFFLE_PATH =
  'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41ZM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5Zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13Z';
const ADD_PATH = 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z';

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
    const playlist = components.querySelector('.playlist-comp');

    expect(designDocument.querySelectorAll('.section-head .num')).toHaveLength(0);
    expect(visibleCopy).not.toMatch(/\b(?:HOST|SELF)[\s_-]*CTRL\b/iu);
    expect(playlist?.textContent).not.toMatch(/equalizer/iu);
    expect(
      playlist?.querySelector('.equalizer, .wave, .duration, .right-time, .playlist-duration'),
    ).toBeNull();
  });

  it('joins all four palettes into one continuous system', () => {
    const foundations = sectionWithHeading('Foundations');
    const stack = foundations.querySelector<HTMLElement>('.theme-palette-stack');
    const boards = [...(stack?.children ?? [])];

    expect(stack).toBeTruthy();
    expect(foundations.querySelectorAll('.theme-palette-stack')).toHaveLength(1);
    expect(stack?.getAttribute('role')).toBe('group');
    expect(stack?.getAttribute('aria-label')).toBe('MUSIXQUARE authored color palettes');
    expect(
      boards.map((board) => ({
        palette: (board as HTMLElement).dataset.palette,
        tag: board.tagName,
        title: board.querySelector('.theme-palette-title')?.textContent?.trim(),
        titleLevel: board.querySelector('.theme-palette-title')?.tagName,
      })),
    ).toEqual([
      { palette: 'dark', tag: 'ARTICLE', title: 'Dark', titleLevel: 'H3' },
      { palette: 'light', tag: 'ARTICLE', title: 'Light', titleLevel: 'H3' },
      {
        palette: 'contrast-dark',
        tag: 'ARTICLE',
        title: 'High contrast dark',
        titleLevel: 'H3',
      },
      {
        palette: 'contrast-light',
        tag: 'ARTICLE',
        title: 'High contrast light',
        titleLevel: 'H3',
      },
    ]);
    expect(
      foundations.querySelector(
        '.palette-family-stack, .palette-mode-group, .palette-mode-title, .semantic-palette, .semantic-spectrum, .semantic-band, .semantic-fill-block',
      ),
    ).toBeNull();
  });

  it('shows every authored palette as one complete contextual board', () => {
    const expected = {
      dark: [
        '#121212',
        '#1a1a1a',
        '#202020',
        '#404040',
        '#262626',
        '#3b82f6',
        '#eeeeee',
        '#a1a1aa',
        '#71717a',
      ],
      light: [
        '#f8f9fa',
        '#ffffff',
        '#eff1f3',
        '#b7b9bb',
        '#d4d6d8',
        '#3b82f6',
        '#303540',
        '#495057',
        '#868e96',
      ],
      'contrast-dark': [
        '#000000',
        '#0a0a0a',
        '#1f1f1f',
        '#4d4d4d',
        '#262626',
        '#8ab4ff',
        '#ffffff',
        '#f2f2f2',
        '#d0d0d0',
      ],
      'contrast-light': [
        '#f2f2f2',
        '#ffffff',
        '#d4d4d4',
        '#a8a8a8',
        '#d4d6d8',
        '#0047a8',
        '#000000',
        '#111111',
        '#333333',
      ],
    } as const;
    const tokenOrder = [
      '--bg',
      '--surface-1',
      '--surface-2',
      '--surface-3',
      '--divider',
      '--primary',
      '--text-main',
      '--text-sub',
      '--text-muted',
    ] as const;
    const documentOrder = [
      '--bg',
      '--text-main',
      '--text-sub',
      '--text-muted',
      '--primary',
      '--surface-1',
      '--surface-2',
      '--surface-3',
      '--divider',
    ] as const;
    const boards = [...designDocument.querySelectorAll<HTMLElement>('.theme-palette')];

    expect(boards.map((board) => board.dataset.palette)).toEqual(Object.keys(expected));
    for (const board of boards) {
      const palette = board.dataset.palette as keyof typeof expected;
      expect(
        board
          .querySelector('.theme-palette-title')
          ?.parentElement?.classList.contains('palette-context'),
      ).toBe(true);
      expect(board.querySelectorAll('.palette-band')).toHaveLength(5);
      expect(board.querySelectorAll('.palette-text')).toHaveLength(3);
      const values = new Map(
        [...board.querySelectorAll<HTMLElement>('[data-token]')].map((sample) => [
          sample.dataset.token,
          sample.querySelector('code')?.textContent?.trim().toLowerCase(),
        ]),
      );
      expect([...values.keys()]).toEqual(documentOrder);
      expect(tokenOrder.map((token) => values.get(token))).toEqual(expected[palette]);
    }

    const visibleCopy = sectionWithHeading('Foundations').textContent ?? '';
    expect(visibleCopy).not.toMatch(
      /Default theme|Light theme|Increased contrast|Forced colors|CanvasText|Highlight/iu,
    );
    expect(designStylesheet).not.toMatch(
      /\.palette-(?:sample|surface-grid|type-grid)|\.semantic-(?:matrix|set|sample)\b/u,
    );
    expect(designStylesheet).toMatch(
      /\.editorial-designsystem\s+\.page\s*>\s*\.section\s*\{[^}]*max-width:\s*calc\(1240px\s*-\s*var\(--pad-x\)\s*-\s*var\(--pad-x\)\)/iu,
    );
    expect(designStylesheet).not.toMatch(/\.editorial-designsystem\s*\{[^}]*--max-w\s*:/iu);
  });

  it('publishes the production semantic color and control tokens', () => {
    const expectedTokens = {
      '--play-action-surface': 'var(--surface-2)',
      '--primary-filled': '#3b82f6',
      '--success-filled': '#20a45a',
      '--danger-filled': '#ef4444',
      '--warning-filled': '#f59e0b',
      '--warning-foreground': '#f59e0b',
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
    expect(advertisedTokens).toEqual(
      expect.arrayContaining([
        '--play-action-surface',
        '--control-active',
        '--control-danger',
        '--control-danger-hover',
      ]),
    );
    expect(designSource).not.toContain('The only accent');
  });

  it('shows the current playlist leading state, source icons, disclosure, and remove action', () => {
    const playlist = sectionWithHeading('Components').querySelector<HTMLElement>('.pl');
    expect(playlist).toBeTruthy();

    const entries = [...(playlist?.querySelectorAll<HTMLElement>('.playlist-entry-sample') ?? [])];
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
    const expandButtons = [
      ...(playlist?.querySelectorAll<HTMLButtonElement>('.expand-toggle') ?? []),
    ];
    const thirdItem = items[2];
    const thirdEntry = entries[2];
    const thirdExpand = thirdItem?.querySelector<HTMLButtonElement>('.expand-toggle');
    const thirdRemove = thirdItem?.querySelector<HTMLButtonElement>('.playlist-remove');
    const subTracks = [...(thirdEntry?.querySelectorAll<HTMLElement>('.sub-track-item') ?? [])];

    expect(entries).toHaveLength(3);
    expect(items).toHaveLength(3);
    expect(playlist?.querySelector('.dur, .duration, .playlist-duration')).toBeNull();
    expect(playlist?.textContent).not.toMatch(/\b\d+:\d{2}\b/u);
    expect(currentLeading?.textContent?.trim()).toBe('');
    expect(normalizedPath(currentLeading?.querySelector('path')?.getAttribute('d') ?? null)).toBe(
      normalizedPath(PLAY_PATH),
    );
    expect(sourcePaths).toEqual(
      [FILE_PATH, YOUTUBE_PATH, YOUTUBE_PLAYLIST_PATH].map(normalizedPath),
    );
    expect(expandButtons).toHaveLength(1);
    expect(items.slice(0, 2).every((item) => item.querySelector('.expand-toggle') === null)).toBe(
      true,
    );
    expect(thirdExpand?.type).toBe('button');
    expect(thirdExpand?.dataset.action).toBe('expand');
    expect(thirdExpand?.dataset.queueItemId).toBe('design-playlist-3');
    expect(thirdExpand?.getAttribute('aria-label')).toBe('Expand/collapse playlist');
    expect(thirdExpand?.getAttribute('aria-expanded')).toBe('true');
    expect(thirdExpand?.classList.contains('active')).toBe(true);
    expect(thirdExpand?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(thirdExpand?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(normalizedPath(thirdExpand?.querySelector('path')?.getAttribute('d') ?? null)).toBe(
      normalizedPath(EXPAND_PATH),
    );
    expect(thirdExpand?.nextElementSibling).toBe(thirdRemove);
    expect(removePaths).toEqual(items.map(() => normalizedPath(CLOSE_PATH)));
    expect(
      items.every((item) => item.lastElementChild?.classList.contains('playlist-remove')),
    ).toBe(true);
    expect(subTracks).toHaveLength(4);
    expect(subTracks.map((track) => track.dataset.subIndex)).toEqual(['0', '1', '2', '3']);
    expect(
      subTracks.map((track) => track.querySelector('.sub-idx-number')?.textContent?.trim()),
    ).toEqual(['1', '2', '3', '4']);
    expect(subTracks.map((track) => track.querySelector('.sub-name')?.textContent?.trim())).toEqual(
      ['Neon Expressway', 'Tokyo After Rain', '2AM Convenience Store', 'Last Train Home'],
    );
    expect(
      subTracks.every(
        (track) =>
          track.getAttribute('role') === 'button' && track.getAttribute('tabindex') === '0',
      ),
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

  it('keeps component examples canonical and free of decorative wrapper cards', () => {
    const components = sectionWithHeading('Components');
    const playback = components.querySelector<HTMLElement>('.playback-comp');
    const playlist = components.querySelector<HTMLElement>('.playlist-comp');
    const mediaIcon = playback?.querySelector('.btn.primary svg');
    const choices = [...components.querySelectorAll<HTMLButtonElement>('.choice-card')];
    const dialogActions = [
      ...components.querySelectorAll<HTMLButtonElement>('.dialog-actions > button'),
    ];
    const playlistActions = [
      ...components.querySelectorAll<HTMLButtonElement>('.tab-action-btn-sample'),
    ];
    const selectionPanel = components.querySelector<HTMLElement>('.playlist-selection-pill');
    const controlLayout = components.querySelector<HTMLElement>('.component-control-layout');
    const controlStack = controlLayout?.querySelector<HTMLElement>('.component-control-stack');
    const listLayout = components.querySelector<HTMLElement>('.component-list-layout');

    expect(mediaIcon?.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(normalizedPath(mediaIcon?.querySelector('path')?.getAttribute('d') ?? null)).toBe(
      normalizedPath(PLAY_MEDIA_PATH),
    );
    expect(playlistActions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Repeat one',
      'Shuffle',
      'Add media',
    ]);
    expect(
      playlistActions.map((button) =>
        normalizedPath(button.querySelector('path')?.getAttribute('d') ?? null),
      ),
    ).toEqual([REPEAT_PATH, SHUFFLE_PATH, ADD_PATH].map(normalizedPath));
    expect(
      playlistActions.filter((button) => button.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1);
    expect(playlist?.querySelector('.lbl')?.textContent?.trim()).toBe('Playlist area');
    expect(playback?.querySelector('.tab-action-btn-sample')).toBeNull();
    expect(playlist?.querySelectorAll('.tab-action-btn-sample')).toHaveLength(3);
    expect(
      components.querySelector('.btn-playlist-remove.is-selected[aria-pressed="true"]'),
    ).toBeTruthy();
    expect(selectionPanel?.getAttribute('role')).toBe('group');
    expect(
      [...(selectionPanel?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Select all', 'Delete 1 selected track', 'Cancel']);
    expect(selectionPanel?.querySelector('.playlist-selection-count')?.textContent?.trim()).toBe(
      '1',
    );
    expect(
      [...(controlLayout?.children ?? [])].map((child) => (child as HTMLElement).className),
    ).toEqual(['component-control-stack', 'comp ranges-comp']);
    expect(
      [...(controlStack?.children ?? [])].map((child) => (child as HTMLElement).className),
    ).toEqual(['comp playback-comp', 'comp selection-comp']);
    expect(
      [...((listLayout?.children ?? []) as HTMLCollectionOf<HTMLElement>)].map(
        (child) => child.className,
      ),
    ).toEqual(['comp playlist-comp', 'comp device-comp']);
    expect(choices.map((choice) => choice.textContent?.trim())).toEqual(['On', 'Off']);
    expect(choices.filter((choice) => choice.getAttribute('aria-pressed') === 'true')).toHaveLength(
      1,
    );
    expect(choices[0]?.parentElement?.getAttribute('role')).toBe('group');
    expect(components.querySelector('.invite, .copy-button')).toBeNull();
    expect(components.textContent).not.toMatch(/Invite cluster/iu);
    expect(getComputedStyle(components.querySelector('.comp')!).backgroundColor).toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(dialogActions.map((button) => button.textContent?.trim())).toEqual(['Stay', 'Leave']);
    expect(dialogActions.map((button) => getComputedStyle(button).borderRadius)).toEqual([
      '999px',
      '999px',
    ]);
  });

  it('covers current range, messaging, input, loading, and device patterns', () => {
    const components = sectionWithHeading('Components');
    const ranges = [...components.querySelectorAll<HTMLInputElement>('.design-range')];
    const eqRanges = ranges.filter((range) => range.classList.contains('design-range-eq'));
    const bubbles = [...components.querySelectorAll<HTMLElement>('.chat-demo-stage .chat-bubble')];
    const tabs = [
      ...components.querySelectorAll<HTMLButtonElement>('.settings-subtab-sample button'),
    ];
    const composer = components.querySelector<HTMLElement>('.chat-input');
    const search = components.querySelector<HTMLElement>('.yt-intro-text');
    const devices = [...components.querySelectorAll<HTMLElement>('.device-row-sample')];

    expect(ranges).toHaveLength(8);
    expect(ranges.map((range) => range.style.getPropertyValue('--range-progress'))).toEqual([
      '38%',
      '72%',
      '42%',
      '58%',
      '44%',
      '50%',
      '36%',
      '54%',
    ]);
    expect(eqRanges).toHaveLength(5);
    expect(
      [...components.querySelectorAll('.range-eq-label')].map((label) => label.textContent?.trim()),
    ).toEqual(['60', '230', '910', '3.6k', '14k']);
    expect(components.querySelector('.design-range-volume')?.getAttribute('aria-label')).toBe(
      'Volume',
    );
    expect(components.querySelector('.volume-cycle-demo')?.getAttribute('aria-label')).toBe(
      'Volume cycles between audible and muted',
    );
    expect(components.querySelectorAll('.volume-cycle-demo .volume-wave')).toHaveLength(2);
    expect(components.querySelectorAll('.volume-cycle-demo .volume-muted-mark')).toHaveLength(1);
    expect(designStylesheet).toContain('@keyframes design-volume-wave-cycle');
    expect(designStylesheet).toContain('@keyframes design-volume-muted-cycle');
    expect(designStylesheet).toContain('@keyframes design-volume-level-cycle');
    expect(designStylesheet).toMatch(
      /@property\s+--range-progress\s*\{[^}]*syntax:\s*'<percentage>';[^}]*inherits:\s*true;[^}]*initial-value:\s*0%;[^}]*\}/su,
    );
    expect(designStylesheet).toMatch(
      /\.range-volume-demo\s*\{[^}]*max-width:\s*140px;[^}]*grid-column:\s*span 3;/su,
    );
    expect(designStylesheet).toMatch(/\.range-effect-demo\s*\{[^}]*grid-column:\s*span 9;/su);

    expect(components.querySelector('.chat-pinned-notice-text')?.textContent?.trim()).toBe(
      'Drop your playlist recs',
    );
    expect(bubbles).toHaveLength(4);
    expect(bubbles.some((bubble) => bubble.matches('.others:not(.whisper)'))).toBe(true);
    expect(bubbles.some((bubble) => bubble.matches('.mine:not(.whisper)'))).toBe(true);
    expect(bubbles.some((bubble) => bubble.matches('.mine.whisper'))).toBe(true);
    expect(components.querySelector('.chat-youtube-btn .chat-yt-title')?.textContent?.trim()).toBe(
      'Late Night Drive · Tokyo Mix',
    );
    expect(
      components.querySelector('.chat-group.mine:not(.whisper)')?.querySelectorAll('.chat-row'),
    ).toHaveLength(2);
    expect(designStylesheet).toMatch(
      /\.chat-group \.chat-row \+ \.chat-row:last-child \.chat-bubble\.mine\s*\{[^}]*border-top-right-radius:\s*4px;[^}]*border-bottom-right-radius:\s*var\(--radius-m\);/su,
    );

    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'General',
      'Audio',
      'Connect',
      'Help',
    ]);
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(composer?.getAttribute('contenteditable')).toBe('true');
    expect(composer?.getAttribute('data-placeholder')).toBe('Message or /command');
    expect(search?.getAttribute('contenteditable')).toBe('true');
    expect(search?.textContent?.trim()).toBe('midnight mix');
    expect(components.querySelector('.material-elastic-spinner--large circle')).toBeTruthy();
    expect(components.querySelector('.large-spinner-stage')?.textContent?.trim()).toBe('');
    expect(components.querySelector('.app-loading-header-progress')).toBeTruthy();
    expect(components.querySelector('.app-loading-header-status')?.textContent?.trim()).toBe(
      'Loading...',
    );
    expect(components.querySelector('.app-loading-header-badge i')).toBeTruthy();
    expect(designStylesheet).toContain('@keyframes app-header-badge-cycle');
    expect(designStylesheet).toMatch(
      /\.large-spinner-stage\s*\{[^}]*height:\s*60px;[^}]*background:\s*var\(--surface-2\);/su,
    );
    expect(designStylesheet).toMatch(/\.app-loading-header-demo\s*\{[^}]*height:\s*60px;/su);
    expect(designStylesheet).toMatch(
      /48%\s*\{[^}]*stroke-dasharray:\s*74 26;[^}]*stroke-dashoffset:\s*-12;/su,
    );
    expect(designStylesheet).toMatch(
      /100%\s*\{[^}]*stroke-dasharray:\s*2 98;[^}]*stroke-dashoffset:\s*-100;/su,
    );

    const deviceEntries = [...components.querySelectorAll<HTMLElement>('.device-entry-sample')];
    const deviceNames = devices.map((row) =>
      row.querySelector('.d-name-label')?.textContent?.trim(),
    );
    const expandedAccount = deviceEntries[2];
    const deviceExpand = expandedAccount?.querySelector<HTMLButtonElement>('.device-expand-toggle');
    const deviceSubrows = [
      ...(expandedAccount?.querySelectorAll<HTMLElement>('.device-subrow-sample') ?? []),
    ];

    expect(deviceEntries).toHaveLength(3);
    expect(devices).toHaveLength(3);
    expect(deviceNames).toEqual(['Mina Park', 'Jules Kim', 'Noah Lee']);
    expect(devices[0]?.getAttribute('aria-current')).toBe('true');
    expect(devices[1]?.querySelector('.btn-kick-device')).toBeTruthy();
    expect(deviceExpand?.getAttribute('aria-expanded')).toBe('true');
    expect(deviceExpand?.getAttribute('aria-controls')).toBe('design-device-sublist-3');
    expect(deviceExpand?.classList.contains('active')).toBe(true);
    expect(devices[2]?.querySelector('.btn-kick-device')).toBeTruthy();
    expect(deviceSubrows).toHaveLength(4);
    expect(
      deviceSubrows.map((row) => row.querySelector('.device-sub-index')?.textContent?.trim()),
    ).toEqual(['1', '2', '3', '4']);
    expect(
      deviceSubrows.map((row) => row.querySelector('.device-sub-name')?.textContent?.trim()),
    ).toEqual([
      'macOS device (A1B2)',
      'Windows device (C3D4)',
      'iOS device (E5F6)',
      'Android device (G7H8)',
    ]);
    const physicalKickButtons = deviceSubrows.map((row) =>
      row.querySelector<HTMLButtonElement>('.btn-kick-physical-device'),
    );
    expect(physicalKickButtons.map((button) => button?.getAttribute('aria-label'))).toEqual([
      'Remove macOS device (A1B2)',
      'Remove Windows device (C3D4)',
      'Remove iOS device (E5F6)',
      'Remove Android device (G7H8)',
    ]);
    expect(
      physicalKickButtons.every(
        (button, index) =>
          button === deviceSubrows[index]?.lastElementChild &&
          normalizedPath(button?.querySelector('path')?.getAttribute('d') ?? null) ===
            normalizedPath(CLOSE_PATH),
      ),
    ).toBe(true);
  });

  it('keeps motion recipes borderless and lets their timing note use the section width', () => {
    const motion = sectionWithHeading('Shape & motion');
    const note = motion.querySelector<HTMLElement>('.motion-note');

    expect(motion.querySelectorAll('.motion-card')).toHaveLength(3);
    expect(note?.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
      'Entrance targets stagger by up to 400ms and finish within 1200ms. Reduced-motion mode removes movement and delay.',
    );
    expect(designStylesheet).toMatch(/\.motion-card\s*\{[^}]*border:\s*0;/su);
    expect(designStylesheet).toMatch(/\.motion-note\s*\{[^}]*max-width:\s*none;/su);
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
    expect(getComputedStyle(mixed!.querySelector('.volume-speaker')!).fill.toLowerCase()).toBe(
      'currentcolor',
    );
    for (const wave of mixed!.querySelectorAll('.volume-wave-inner, .volume-wave-outer')) {
      expect(getComputedStyle(wave).fill).toBe('none');
      expect(getComputedStyle(wave).stroke.toLowerCase()).toBe('currentcolor');
    }
    expect(iconography.querySelector('.youtube-icon')).toBeNull();
    expect(copy).not.toMatch(/YouTube/iu);
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
