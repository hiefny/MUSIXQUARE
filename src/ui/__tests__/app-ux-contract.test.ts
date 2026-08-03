/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let appDocument: Document;
let appSource: string;
let appStylesheet: string;
let desktopStylesheet: string;
let settingsSource: string;

beforeAll(() => {
  appSource = readFileSync(resolve('index.html'), 'utf8');
  appDocument = new DOMParser().parseFromString(appSource, 'text/html');
  appStylesheet = readFileSync(resolve('css/style.css'), 'utf8');
  desktopStylesheet = readFileSync(resolve('css/desktop.css'), 'utf8');
  settingsSource = readFileSync(resolve('src/ui/settings.ts'), 'utf8');
});

describe('app UX markup contract', () => {
  it('uses native buttons for every invite-code copy action', () => {
    const inviteActions = [...appDocument.querySelectorAll('.invite-code-container')];

    expect(inviteActions).toHaveLength(3);
    expect(inviteActions.every((element) => element.tagName === 'BUTTON')).toBe(true);
    expect(inviteActions.every((element) => element.getAttribute('type') === 'button')).toBe(true);
  });

  it('keeps one playlist add action without duplicating it in the empty state', () => {
    expect(appDocument.querySelectorAll('#btn-add-media')).toHaveLength(1);
    expect(appDocument.querySelector('#playlist-ui .list-empty-state button')).toBeNull();
  });

  it('keeps the intentional contenteditable URL field and mobile zoom lock', () => {
    const youtubeField = appDocument.getElementById('youtube-url-input');
    expect(youtubeField?.tagName).toBe('DIV');
    expect(youtubeField?.getAttribute('contenteditable')).toBe('true');

    const viewport = appDocument.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    expect(viewport?.content).toContain('maximum-scale=1');
    expect(viewport?.content).toContain('user-scalable=no');
  });

  it('places settings sync between the device role and reverb sections', () => {
    const generalPanel = appDocument.querySelector<HTMLElement>(
      '.settings-subtab-panel[data-panel="general"]',
    );
    const audioPanel = appDocument.querySelector<HTMLElement>(
      '.settings-subtab-panel[data-panel="audio"]',
    );
    const roleSection = audioPanel?.querySelector('#grid-standard')?.closest('.section-group');
    const syncSection = appDocument.getElementById('settings-sync-section');
    const reverbSection = audioPanel?.querySelector('#grid-reverb')?.closest('.section-group');

    expect(generalPanel?.contains(syncSection)).toBe(false);
    expect(audioPanel?.contains(syncSection)).toBe(true);
    expect(syncSection?.closest('.youtube-settings-disabled-wrap')).toBeNull();
    expect(roleSection?.closest('.youtube-settings-disabled-wrap')).not.toBeNull();
    expect(reverbSection?.closest('.youtube-settings-disabled-wrap')).not.toBeNull();
    expect(roleSection?.closest('.youtube-settings-disabled-wrap')).not.toBe(
      reverbSection?.closest('.youtube-settings-disabled-wrap'),
    );

    const audioSections = [...(audioPanel?.querySelectorAll('.section-group') ?? [])];
    const roleIndex = audioSections.indexOf(roleSection as Element);
    const syncIndex = audioSections.indexOf(syncSection as Element);
    const reverbIndex = audioSections.indexOf(reverbSection as Element);

    expect(roleIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBe(roleIndex + 1);
    expect(reverbIndex).toBe(syncIndex + 1);
  });

  it('shows settings-sync indicators only on the five synchronized effect headers', () => {
    const removedLegacySurface = [appSource, appStylesheet, settingsSource].join('\n');
    expect(removedLegacySurface).not.toContain('badge-host-ctrl');
    expect(removedLegacySurface).not.toContain('settings.host_ctrl');
    expect(removedLegacySurface).not.toContain('settings.self_ctrl');

    const roleSection = appDocument.getElementById('grid-standard')?.closest('.section-group');
    expect(roleSection?.querySelector('[data-settings-sync-indicator]')).toBeNull();

    const expectedEffectTitles = [
      'settings-reverb-title',
      'settings-eq-title',
      'settings-surround-title',
      'settings-bass-title',
      'settings-exciter-title',
    ];
    const indicators = [
      ...appDocument.querySelectorAll<HTMLElement>('[data-settings-sync-indicator]'),
    ];
    expect(indicators).toHaveLength(expectedEffectTitles.length);
    expect(
      indicators.map(
        (indicator) =>
          indicator.closest('.section-header-row')?.querySelector<HTMLElement>('.section-title')
            ?.id,
      ),
    ).toEqual(expectedEffectTitles);
    for (const indicator of indicators) {
      expect(indicator.getAttribute('role')).toBe('img');
      expect(indicator.getAttribute('data-i18n-aria-label')).toBe('settings.sync_settings');
      expect(indicator.hasAttribute('hidden')).toBe(true);
    }

    const hiddenIndicatorRule = appStylesheet.match(
      /\.settings-sync-indicator\[hidden\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(hiddenIndicatorRule).toMatch(/display:\s*none\s*;/);
  });

  it('associates every settings description with its own control group', () => {
    const descriptions = [
      [
        '#grid-lang',
        'settings-language-title',
        'settings-language-description',
        'settings.language_desc',
      ],
      ['#grid-theme', 'settings-theme-title', 'settings-theme-description', 'settings.theme_desc'],
      [
        '#grid-ui-sounds',
        'settings-ui-sounds-title',
        'settings-ui-sounds-description',
        'settings.ui_sounds_desc',
      ],
      [
        '#grid-visualizer',
        'settings-visualizer-title',
        'settings-visualizer-description',
        'settings.visualizer_desc',
      ],
      [
        '#grid-settings-sync',
        'settings-sync-title',
        'settings-sync-description',
        'settings.sync_settings_desc',
      ],
      [
        '#grid-standard',
        'settings-role-title',
        'settings-role-description',
        'settings.role_center_desc',
      ],
      [
        '#grid-reverb',
        'settings-reverb-title',
        'settings-reverb-description',
        'settings.reverb_desc',
      ],
      ['#grid-eq', 'settings-eq-title', 'settings-eq-description', 'settings.eq_desc'],
      [
        '#grid-surround',
        'settings-surround-title',
        'settings-surround-description',
        'settings.surround_desc',
      ],
      ['#grid-vbass', 'settings-bass-title', 'settings-bass-description', 'settings.bass_desc'],
      [
        '#grid-exciter',
        'settings-exciter-title',
        'settings-exciter-description',
        'settings.exciter_desc',
      ],
    ] as const;

    for (const [controlSelector, titleId, descriptionId, translationKey] of descriptions) {
      const control = appDocument.querySelector<HTMLElement>(controlSelector);
      const description = appDocument.getElementById(descriptionId);

      expect(description?.getAttribute('data-i18n'), descriptionId).toBe(translationKey);
      expect(control?.getAttribute('role'), controlSelector).toBe('group');
      expect(control?.getAttribute('aria-labelledby'), controlSelector).toBe(titleId);
      expect(control?.getAttribute('aria-describedby'), controlSelector).toBe(descriptionId);
      expect(control?.closest('.section-group'), controlSelector).toBe(
        description?.closest('.section-group'),
      );
    }

    expect(appDocument.querySelectorAll('#tab-settings .settings-option-description')).toHaveLength(
      descriptions.length,
    );
  });

  it('announces the currently selected device role from the role control group', () => {
    const title = appDocument.getElementById('settings-role-title');
    const description = appDocument.getElementById('settings-role-description');
    const roleGroup = appDocument.getElementById('grid-standard');

    expect(title).not.toBeNull();
    expect(description?.getAttribute('data-i18n')).toBe('settings.role_center_desc');
    expect(description?.getAttribute('aria-live')).toBe('polite');
    expect(description?.getAttribute('aria-atomic')).toBe('true');
    expect(roleGroup?.getAttribute('role')).toBe('group');
    expect(roleGroup?.getAttribute('aria-labelledby')).toBe('settings-role-title');
    expect(roleGroup?.getAttribute('aria-describedby')).toBe('settings-role-description');
  });

  it('preserves role-description line breaks with supporting-copy spacing', () => {
    const roleDescriptionRule = appStylesheet.match(
      /\.settings-option-description\.settings-role-description\s*\{([^}]*)\}/,
    )?.[1];

    expect(roleDescriptionRule).toBeDefined();
    expect(roleDescriptionRule).toMatch(/white-space:\s*pre-line\s*;/);
    expect(roleDescriptionRule).toMatch(/margin-bottom:\s*24px\s*;/);
  });

  it('keeps settings descriptions on the desktop title and control inset', () => {
    const descriptionRule = desktopStylesheet.match(
      /\.settings-option-description\s*\{([^}]*)\}/,
    )?.[1];

    expect(descriptionRule).toBeDefined();
    expect(descriptionRule).toMatch(/margin:\s*-8px\s+20px\s+16px\s*;/);

    const splitLockDividerRule = appStylesheet.match(
      /#youtube-settings-disabled-wrap\s*>\s*\.section-group:last-of-type\s*\{([^}]*)\}/,
    )?.[1];
    expect(splitLockDividerRule).toMatch(/border-bottom:\s*1px\s+solid\s+var\(--divider\)/);

    const desktopSplitLockDividerRule = desktopStylesheet.match(
      /#youtube-settings-disabled-wrap\s*>\s*\.section-group:last-of-type\s*\{([^}]*)\}/,
    )?.[1];
    expect(desktopSplitLockDividerRule).toMatch(/border-bottom:\s*1px\s+solid\s+var\(--divider\)/);
  });
});
