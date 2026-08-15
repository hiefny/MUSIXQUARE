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
let appRuntimeSource: string;
let platformSource: string;

beforeAll(() => {
  appSource = readFileSync(resolve('index.html'), 'utf8');
  appDocument = new DOMParser().parseFromString(appSource, 'text/html');
  appStylesheet = readFileSync(resolve('css/style.css'), 'utf8');
  desktopStylesheet = readFileSync(resolve('css/desktop.css'), 'utf8');
  settingsSource = readFileSync(resolve('src/ui/settings.ts'), 'utf8');
  appRuntimeSource = readFileSync(resolve('src/app.ts'), 'utf8');
  platformSource = readFileSync(resolve('src/core/platform.ts'), 'utf8');
});

describe('app UX markup contract', () => {
  it('uses native buttons for every invite-code copy action', () => {
    const inviteActions = [...appDocument.querySelectorAll('.invite-code-container')];

    expect(inviteActions).toHaveLength(3);
    expect(inviteActions.every((element) => element.tagName === 'BUTTON')).toBe(true);
    expect(inviteActions.every((element) => element.getAttribute('type') === 'button')).toBe(true);
  });

  it('gives the read-only host room code an accessible name', () => {
    const code = appDocument.getElementById('setup-code');
    const labelId = code?.getAttribute('aria-labelledby');

    expect(labelId).toBe('setup-host-code-label');
    expect(appDocument.getElementById(labelId ?? '')?.getAttribute('data-i18n')).toBe(
      'setup.enter_code_connect',
    );
  });

  it('announces room type before join and exposes an actionable one-time role guide', () => {
    const input = appDocument.getElementById('setup-join-code');
    const roomInfo = appDocument.getElementById('setup-room-type-info');
    const autoJoinInfo = appDocument.getElementById('setup-auto-join-room-type-info');
    const describedBy = input?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];

    expect(describedBy).toContain('setup-room-type-info');
    expect(describedBy).toContain('setup-guest-error');
    expect(roomInfo?.getAttribute('role')).toBe('status');
    expect(roomInfo?.getAttribute('aria-live')).toBe('polite');
    expect(roomInfo?.getAttribute('data-i18n')).toBe('setup.room_type_hint');
    expect(autoJoinInfo?.getAttribute('role')).toBe('status');

    const guide = appDocument.getElementById('center-role-guide');
    const guideCopy = appDocument.getElementById('center-role-guide-copy');
    expect(guide?.hasAttribute('hidden')).toBe(true);
    expect(guide?.getAttribute('role')).toBe('region');
    expect(guide?.getAttribute('aria-labelledby')).toBe('center-role-guide-copy');
    expect(guideCopy?.getAttribute('role')).toBe('status');
    expect(guideCopy?.getAttribute('aria-live')).toBe('polite');
    expect(guide?.querySelector('#btn-center-role-settings')?.getAttribute('data-i18n')).toBe(
      'setup.center_role_open_settings',
    );
    expect(
      guide?.querySelector('#btn-center-role-dismiss')?.getAttribute('data-i18n-aria-label'),
    ).toBe('common.close');
  });

  it('describes media constraints and disabled system-audio reasons accessibly', () => {
    const local = appDocument.getElementById('btn-local-file');
    const system = appDocument.getElementById('btn-system-audio');
    const localDescription = appDocument.getElementById('media-local-file-description');
    const systemLimits = appDocument.getElementById('media-system-audio-limits');
    const systemStatus = appDocument.getElementById('media-system-audio-status');

    expect(local?.getAttribute('aria-describedby')).toBe('media-local-file-description');
    expect(localDescription?.getAttribute('data-i18n')).toBe('help.local_memory_notice');
    expect(system?.getAttribute('aria-describedby')?.split(/\s+/)).toEqual([
      'media-system-audio-limits',
      'media-system-audio-status',
    ]);
    expect(systemLimits?.getAttribute('data-i18n')).toBe('system_audio.preflight_limits');
    expect(systemStatus?.getAttribute('role')).toBe('status');
    expect(systemStatus?.getAttribute('aria-live')).toBe('polite');
    expect(systemStatus?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps the new guidance bounded on narrow screens and media rows content-sized', () => {
    expect(appStylesheet).toContain('width: min(390px, calc(100vw - 32px));');
    expect(appStylesheet).toContain('@media (max-width: 420px)');
    expect(appStylesheet).toContain('width: calc(100vw - 24px);');
    expect(appStylesheet).toMatch(
      /\.file-select-btn\s*\{[\s\S]*?min-height:\s*72px;[\s\S]*?height:\s*auto;/u,
    );
    expect(appStylesheet).toContain('.media-source-disabled-reason[hidden]');
  });

  it('keeps the iOS audio primer rooted on trailing-slash invite documents', () => {
    const primer = appDocument.getElementById('silent-trigger');
    const source = primer?.getAttribute('src');

    expect(source).toBe('/dummy_audio.mp3');
    expect(new URL(source ?? '', 'https://musixquare.com/123456/').pathname).toBe(
      '/dummy_audio.mp3',
    );
  });

  it('connects each settings subtab button to a stable panel and exposes selection', () => {
    const buttons = [
      ...appDocument.querySelectorAll<HTMLButtonElement>('.subtab-pill[data-subtab]'),
    ];

    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      const panelId = button.getAttribute('aria-controls');
      const panel = appDocument.getElementById(panelId ?? '');
      expect(button.type).toBe('button');
      expect(panel?.dataset.panel).toBe(button.dataset.subtab);
      expect(button.getAttribute('aria-pressed')).toBe(
        button.classList.contains('active') ? 'true' : 'false',
      );
    }
  });

  it('exposes demo step selection without an invalid mixed-action tablist', () => {
    const navigation = appDocument.querySelector('.demo-step-nav');
    const steps = [...appDocument.querySelectorAll<HTMLElement>('[data-demo-step]')];
    const next = appDocument.querySelector('[data-demo-next]');

    expect(navigation?.hasAttribute('role')).toBe(false);
    expect(navigation?.contains(next)).toBe(true);
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(steps.every((step) => !step.hasAttribute('aria-selected'))).toBe(true);
  });

  it('keeps one playlist add action without duplicating it in the empty state', () => {
    expect(appDocument.querySelectorAll('#btn-add-media')).toHaveLength(1);
    expect(appDocument.querySelector('#playlist-ui .list-empty-state button')).toBeNull();
  });

  it('keeps the intentional contenteditable URL field and fixed-scale app surface', () => {
    const youtubeField = appDocument.getElementById('youtube-url-input');
    expect(youtubeField?.tagName).toBe('DIV');
    expect(youtubeField?.getAttribute('contenteditable')).toBe('true');

    const viewport = appDocument.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    expect(viewport?.content).toContain('width=device-width');
    expect(viewport?.content).toContain('minimum-scale=1');
    expect(viewport?.content).toContain('maximum-scale=1');
    expect(viewport?.content).toContain('user-scalable=no');
    expect(platformSource).toContain("'gesturestart'");
    expect(platformSource).toContain("'gesturechange'");
    expect(platformSource).toContain("'gestureend'");
    expect(platformSource).toContain('preventIOSPinchZoom();');
  });

  it('keeps Space as the only unmodified single-key playback shortcut', () => {
    const shortcutStart = appRuntimeSource.indexOf('function initKeyboardShortcuts');
    const shortcutEnd = appRuntimeSource.indexOf('\nfunction ', shortcutStart + 1);
    const shortcutSource = appRuntimeSource.slice(shortcutStart, shortcutEnd);

    expect(shortcutSource).toContain("e.code === 'Space'");
    expect(shortcutSource).not.toMatch(/e\.key === ['"][pPsScC]['"]/u);
  });

  it('publishes a cached-navigation launch as degraded bootstrap readiness', () => {
    expect(appRuntimeSource).toContain('NAVIGATION_SOURCE_EVENT');
    expect(appRuntimeSource).toContain(
      "bootstrapReadiness.recordFallback('CachedNavigation', 'orchestration')",
    );
    expect(appRuntimeSource).toContain(
      "document.documentElement.dataset.mxqrNavigationSource === 'cache-fallback'",
    );
    expect(appRuntimeSource).toContain("detail?.source === 'cache-fallback'");
  });

  it('turns a terminal lazy-feature failure into an explicit reload action', () => {
    const connectBoundaryStart = appRuntimeSource.indexOf("safeInit('Connect'");
    const connectBoundaryEnd = appRuntimeSource.indexOf(
      "safeInit('CustomScrollbars'",
      connectBoundaryStart,
    );
    const connectBoundary = appRuntimeSource.slice(connectBoundaryStart, connectBoundaryEnd);

    expect(appRuntimeSource).toContain("bus.on('app:lazy-feature-load-failed'");
    expect(appRuntimeSource).toContain("buttonText: t('common.refresh')");
    expect(appRuntimeSource).toContain("scheduleDocumentReload(t('dialog.refreshing_session')");
    expect(connectBoundary).toContain("bus.emit('app:lazy-feature-load-failed', 'connect', error)");
    expect(connectBoundary).not.toContain('loading = null');
  });

  it('places settings sync last in General and keeps one lock around every Audio section', () => {
    const generalPanel = appDocument.querySelector<HTMLElement>(
      '.settings-subtab-panel[data-panel="general"]',
    );
    const audioPanel = appDocument.querySelector<HTMLElement>(
      '.settings-subtab-panel[data-panel="audio"]',
    );
    const roleSection = audioPanel?.querySelector('#grid-standard')?.closest('.section-group');
    const syncSection = appDocument.getElementById('settings-sync-section');
    const reverbSection = audioPanel?.querySelector('#grid-reverb')?.closest('.section-group');

    expect(generalPanel?.contains(syncSection)).toBe(true);
    expect(audioPanel?.contains(syncSection)).toBe(false);
    expect(syncSection?.closest('.youtube-settings-disabled-wrap')).toBeNull();
    expect(roleSection?.closest('.youtube-settings-disabled-wrap')).not.toBeNull();
    expect(reverbSection?.closest('.youtube-settings-disabled-wrap')).not.toBeNull();
    expect(roleSection?.closest('.youtube-settings-disabled-wrap')).toBe(
      reverbSection?.closest('.youtube-settings-disabled-wrap'),
    );

    const generalSections = [...(generalPanel?.querySelectorAll('.section-group') ?? [])];
    expect(generalSections.at(-1)).toBe(syncSection);

    const audioLock = audioPanel?.querySelector('.youtube-settings-disabled-wrap');
    const audioSections = [...(audioPanel?.querySelectorAll('.section-group') ?? [])];
    expect(audioPanel?.querySelectorAll('.youtube-settings-disabled-wrap')).toHaveLength(1);
    expect(audioSections.length).toBeGreaterThan(1);
    expect(audioSections.every((section) => audioLock?.contains(section))).toBe(true);
  });

  it('shows settings-sync indicators only on the three synchronized effect headers', () => {
    const removedLegacySurface = [appSource, appStylesheet, settingsSource].join('\n');
    expect(removedLegacySurface).not.toContain('badge-host-ctrl');
    expect(removedLegacySurface).not.toContain('settings.host_ctrl');
    expect(removedLegacySurface).not.toContain('settings.self_ctrl');

    const roleSection = appDocument.getElementById('grid-standard')?.closest('.section-group');
    expect(roleSection?.querySelector('[data-settings-sync-indicator]')).toBeNull();

    const expectedEffectTitles = [
      'settings-reverb-title',
      'settings-eq-title',
      'settings-virtual-effects-title',
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
      expect(indicator.tagName).toBe('BUTTON');
      expect((indicator as HTMLButtonElement).type).toBe('button');
      expect(indicator.getAttribute('data-i18n-aria-label')).toBe('toast.settings_sync_enabled');
      expect(indicator.hasAttribute('hidden')).toBe(true);
      expect(indicator.parentElement?.classList.contains('settings-sync-indicator-slot')).toBe(
        true,
      );
    }

    const indicatorSlotRule = appStylesheet.match(
      /\.settings-sync-indicator-slot\s*\{([^}]*)\}/,
    )?.[1];
    expect(indicatorSlotRule).toMatch(/position:\s*relative\s*;/);
    expect(indicatorSlotRule).toMatch(/width:\s*32px\s*;/);
    expect(indicatorSlotRule).toMatch(/height:\s*0\s*;/);
    expect(indicatorSlotRule).toMatch(/flex:\s*0\s+0\s+32px\s*;/);
    expect(indicatorSlotRule).toMatch(/align-self:\s*center\s*;/);

    const indicatorRule = appStylesheet.match(/\.settings-sync-indicator\s*\{([^}]*)\}/)?.[1];
    expect(indicatorRule).toMatch(/position:\s*absolute\s*;/);
    expect(indicatorRule).toMatch(/top:\s*50%\s*;/);
    expect(indicatorRule).toMatch(/transform:\s*translateY\(-50%\)\s*;/);
    expect(indicatorRule).toMatch(/width:\s*32px\s*;/);
    expect(indicatorRule).toMatch(/height:\s*32px\s*;/);

    const hiddenIndicatorRule = appStylesheet.match(
      /\.settings-sync-indicator\[hidden\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(hiddenIndicatorRule).toMatch(/display:\s*none\s*;/);
  });

  it('keeps every settings-sync icon backed by direct non-empty SVG geometry', () => {
    const onButton = appDocument.querySelector<HTMLButtonElement>(
      '#grid-settings-sync [data-settings-sync="on"]',
    );
    const icons = [
      onButton?.querySelector<SVGSVGElement>(':scope > svg'),
      ...[...appDocument.querySelectorAll<HTMLElement>('[data-settings-sync-indicator]')].map(
        (indicator) => indicator.querySelector<SVGSVGElement>(':scope > svg'),
      ),
    ];

    expect(icons).toHaveLength(4);
    const pathData = icons.map((icon) => {
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.querySelector(':scope > use, :scope > defs, :scope > symbol')).toBeNull();
      const paths = icon?.querySelectorAll<SVGPathElement>(':scope > path[d]');
      expect(paths).toHaveLength(1);
      return paths?.item(0).getAttribute('d')?.trim();
    });
    expect(pathData.every(Boolean)).toBe(true);
    expect(new Set(pathData).size).toBe(1);
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
        '#grid-virtual-effects',
        'settings-virtual-effects-title',
        'settings-virtual-effects-description',
        'settings.virtual_effects_desc',
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

  it('keeps the virtual effects in one independent-toggle group without legacy grids', () => {
    expect(appDocument.querySelectorAll('#grid-virtual-effects')).toHaveLength(1);
    expect(appDocument.querySelector('#grid-surround')).toBeNull();
    expect(appDocument.querySelector('#grid-vbass')).toBeNull();
    expect(appDocument.querySelector('#grid-exciter')).toBeNull();

    const controls = [
      ...appDocument.querySelectorAll<HTMLButtonElement>(
        '#grid-virtual-effects [data-virtual-effect]',
      ),
    ];
    expect(controls.map((control) => control.dataset.virtualEffect)).toEqual([
      'bass',
      'treble',
      'surround',
      'off',
    ]);
    expect(controls.every((control) => control.type === 'button')).toBe(true);
    expect(controls.every((control) => control.hasAttribute('aria-pressed'))).toBe(true);
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

    expect(appStylesheet).not.toMatch(
      /#youtube-settings-disabled-wrap\s*>\s*\.section-group:last-of-type/,
    );
    expect(desktopStylesheet).not.toMatch(
      /#youtube-settings-disabled-wrap\s*>\s*\.section-group:last-of-type/,
    );
  });

  it('keeps the iOS YouTube tap gate rectangular under the global pill policy', () => {
    const globalButtonShapeRule = appStylesheet.match(
      /button:not\(\.ch-opt\)[\s\S]*?\{\s*border-radius:\s*999px\s*!important;\s*\}/,
    )?.[0];

    expect(globalButtonShapeRule).toBeDefined();
    expect(globalButtonShapeRule).toContain(':not(#youtube-ios-sync-overlay)');
  });

  it('preserves the row-hover transition from track number to reorder grip on hybrid input', () => {
    expect(appStylesheet).toMatch(
      /@media\s*\(any-hover:\s*hover\)\s*\{\s*\.playlist-reorder-handle:hover/,
    );
    expect(appStylesheet).not.toMatch(
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{\s*\.playlist-reorder-handle:hover/,
    );
    expect(appStylesheet).toMatch(
      /\.track-item:hover\s+\.playlist-reorder-handle\s+\.track-idx[\s\S]*?opacity:\s*0/,
    );
    expect(appStylesheet).toMatch(
      /\.track-item:hover\s+\.playlist-reorder-handle\s+\.playlist-reorder-grip[\s\S]*?opacity:\s*1/,
    );
  });
});
