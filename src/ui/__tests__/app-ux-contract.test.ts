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
let youtubeIframeSource: string;

function declarationsForSelector(selector: string): string[] {
  const rulePattern = /([^{}]+)\{([^{}]*)\}/gu;
  const declarations: string[] = [];

  for (const match of appStylesheet.matchAll(rulePattern)) {
    const selectors = (match[1] ?? '')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split(',')
      .map((candidate) => candidate.trim());
    if (selectors.includes(selector)) declarations.push(match[2] ?? '');
  }

  return declarations;
}

beforeAll(() => {
  appSource = readFileSync(resolve('index.html'), 'utf8');
  appDocument = new DOMParser().parseFromString(appSource, 'text/html');
  appStylesheet = readFileSync(resolve('css/style.css'), 'utf8');
  desktopStylesheet = readFileSync(resolve('css/desktop.css'), 'utf8');
  settingsSource = readFileSync(resolve('src/ui/settings.ts'), 'utf8');
  appRuntimeSource = readFileSync(resolve('src/app.ts'), 'utf8');
  platformSource = readFileSync(resolve('src/core/platform.ts'), 'utf8');
  youtubeIframeSource = readFileSync(resolve('src/youtube/iframe.ts'), 'utf8');
});

describe('app UX markup contract', () => {
  it('uses stable filled question icons on help titles without changing navigation icons', () => {
    const icons = [...appDocument.querySelectorAll<SVGElement>('.help-question-icon')];
    const compactNavPath = appDocument.querySelector('#btn-help-compact path')?.getAttribute('d');
    const bottomNavPath = appDocument.querySelector('#nav-guide path')?.getAttribute('d');
    const outlineNavPath =
      'M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z';
    const filledMarkPath =
      'M11 18h2v-2h-2v2zm1-12c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z';

    expect(icons).toHaveLength(2);
    expect(compactNavPath).toBe(outlineNavPath);
    expect(bottomNavPath).toBe(outlineNavPath);
    expect(appDocument.querySelector('#btn-help-compact circle')).toBeNull();
    expect(appDocument.querySelector('#nav-guide circle')).toBeNull();
    for (const icon of icons) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('focusable')).toBe('false');
      expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(icon.querySelectorAll('circle')).toHaveLength(1);
      expect(icon.querySelectorAll('path')).toHaveLength(1);
      expect(icon.querySelector('circle')?.getAttribute('class')).toBe('help-question-icon-bg');
      expect(icon.querySelector('circle')?.getAttribute('cx')).toBe('12');
      expect(icon.querySelector('circle')?.getAttribute('cy')).toBe('12');
      expect(icon.querySelector('circle')?.getAttribute('r')).toBe('10');
      expect(icon.querySelector('path')?.getAttribute('class')).toBe('help-question-icon-mark');
      expect(icon.querySelector('path')?.getAttribute('d')).toBe(filledMarkPath);
      expect(icon.querySelector('path')?.getAttribute('d')).not.toBe(compactNavPath);
    }
    expect(appStylesheet).toMatch(
      /\.help-title svg\s*\{[^}]*display:\s*block;[^}]*flex:\s*none;[^}]*width:\s*22px;[^}]*height:\s*22px;[^}]*fill:\s*var\(--primary\);/u,
    );
    expect(appStylesheet).toMatch(
      /\.help-question-icon-bg\s*\{[^}]*fill:\s*var\(--primary-filled\);/u,
    );
    expect(appStylesheet).toMatch(/\.help-question-icon-mark\s*\{[^}]*fill:\s*#fff;/u);
  });

  it('expresses the intentional theme-specific play-action elevation through a semantic token', () => {
    expect(appStylesheet).toMatch(/:root\s*\{[^}]*--play-action-surface:\s*var\(--surface-2\);/u);
    expect(appStylesheet).toMatch(
      /html\[data-theme='light'\]\s*\{[^}]*--play-action-surface:\s*var\(--surface-1\);/u,
    );
    expect(declarationsForSelector('.chat-preview-btn').join('\n')).toContain(
      'background: var(--play-action-surface);',
    );
    expect(declarationsForSelector('.file-select-btn').join('\n')).toContain(
      'background: var(--play-action-surface);',
    );

    const lightChatRules = declarationsForSelector("[data-theme='light'] .chat-preview-btn");
    const lightMediaRules = declarationsForSelector("[data-theme='light'] .file-select-btn");
    const lightChatStickyHoverRules = declarationsForSelector(
      "[data-theme='light'] .chat-preview-btn:hover:not(:active)",
    );
    const lightMediaStickyHoverRules = declarationsForSelector(
      "[data-theme='light'] .file-select-btn:hover:not(:active)",
    );
    const lightPlayActionRules = [
      ...lightChatRules,
      ...lightMediaRules,
      ...lightChatStickyHoverRules,
      ...lightMediaStickyHoverRules,
    ].join('\n');
    expect(lightPlayActionRules).not.toMatch(/background:\s*#fff(?:fff)?/iu);
    expect(lightChatStickyHoverRules.join('\n')).toContain(
      'background: var(--play-action-surface);',
    );
    expect(lightMediaStickyHoverRules.join('\n')).toContain(
      'background: var(--play-action-surface);',
    );
  });

  it('makes the visualizer itself the accessible mode control and removes the settings row', () => {
    const visualizer = appDocument.getElementById('visualizerCanvas');

    expect(visualizer?.getAttribute('role')).toBe('button');
    expect(visualizer?.getAttribute('tabindex')).toBe('0');
    expect(visualizer?.getAttribute('aria-pressed')).toBe('false');
    expect(visualizer?.getAttribute('aria-labelledby')).toBe(
      'visualizer-accessible-label visualizer-current-mode',
    );
    expect(visualizer?.getAttribute('aria-describedby')).toBe('visualizer-mode-hint');
    expect(appDocument.getElementById('visualizer-current-mode')?.getAttribute('data-i18n')).toBe(
      'player.visualizer_circular',
    );
    expect(appDocument.getElementById('grid-visualizer')).toBeNull();
    expect(settingsSource).not.toContain('musixquare-viz-mode');
    expect(appStylesheet).toMatch(
      /#visualizerCanvas\s*\{[\s\S]*?cursor:\s*pointer;[\s\S]*?touch-action:\s*manipulation;/u,
    );
    expect(appStylesheet).toMatch(
      /#visualizerCanvas:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--primary\);[\s\S]*?outline-offset:\s*-[1-9]\d*px;/u,
    );
  });

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

  it('keeps setup and media actions on the compact pre-audit surface', () => {
    const joinInput = appDocument.getElementById('setup-join-code');
    const localFile = appDocument.getElementById('btn-local-file');
    const fileInput = appDocument.getElementById('file-input') as HTMLInputElement | null;
    const mediaSourceOverlay = appDocument.getElementById('media-source-overlay');
    const systemAudio = appDocument.getElementById('btn-system-audio');
    const mainSync = appDocument.getElementById('btn-sync');
    const mainMedia = appDocument.getElementById('btn-media-source');
    const compactNavLabels = [
      ['nav-playlist', 'nav.playlist'],
      ['nav-connect', 'nav.connect'],
      ['nav-settings', 'nav.settings'],
    ] as const;

    expect(joinInput?.getAttribute('aria-describedby')).toBe('setup-guest-error');
    expect(appDocument.getElementById('setup-room-type-info')).toBeNull();
    expect(appDocument.getElementById('center-role-guide')).toBeNull();
    expect(appDocument.getElementById('media-local-file-description')).toBeNull();
    expect(appDocument.getElementById('media-system-audio-limits')).toBeNull();
    expect(localFile?.hasAttribute('aria-describedby')).toBe(false);
    expect(fileInput?.hidden).toBe(true);
    expect(mediaSourceOverlay?.contains(fileInput)).toBe(true);
    expect(systemAudio?.hasAttribute('aria-describedby')).toBe(false);
    expect(mainSync?.querySelector('span')?.getAttribute('data-i18n')).toBe('player.sync_compact');
    expect(mainSync?.getAttribute('data-i18n-aria-label')).toBe('common.sync');
    expect(mainMedia?.querySelector('span')?.getAttribute('data-i18n')).toBe(
      'player.play_media_compact',
    );
    expect(mainMedia?.getAttribute('data-i18n-aria-label')).toBe('player.play_media');
    for (const [id, fullKey] of compactNavLabels) {
      const navButton = appDocument.getElementById(id);
      expect(navButton?.getAttribute('data-i18n-aria-label')).toBe(fullKey);
      expect(navButton?.getAttribute('aria-label')).toBeTruthy();
    }
    expect(appStylesheet).toMatch(
      /\.file-select-btn\s*\{[\s\S]*?height:\s*72px;[\s\S]*?padding:\s*0 20px;/u,
    );
    expect(appStylesheet).toMatch(
      /#btn-sync,\s*\n\s*#btn-media-source\s*\{[\s\S]*?min-height:\s*56px;[\s\S]*?height:\s*auto;[\s\S]*?padding:\s*10px 14px;/u,
    );
    expect(desktopStylesheet).toMatch(
      /@media \(min-width:\s*1280px\)\s*\{[\s\S]*?\.play-action-buttons \.file-select-btn\s*\{[\s\S]*?width:\s*160px;[\s\S]*?min-width:\s*160px;[\s\S]*?flex:\s*none;/u,
    );
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

  it('keeps explanatory disabled actions focus-visible without expanding compact halos', () => {
    const largeActions = ['#btn-sync', '#btn-media-source'];
    const compactActions = ['#btn-add-media', '#btn-repeat', '#btn-shuffle'];

    for (const selector of [...largeActions, ...compactActions]) {
      const button = appDocument.querySelector<HTMLButtonElement>(selector);
      expect(button?.tagName, selector).toBe('BUTTON');
      expect(button?.hasAttribute('disabled'), selector).toBe(false);

      const disabledRule = declarationsForSelector(`${selector}[aria-disabled='true']`);
      expect(disabledRule, `${selector} disabled style`).toHaveLength(1);
      expect(disabledRule[0]).toMatch(/opacity:\s*0\.42\s*;/u);

      const focusRule = declarationsForSelector(`${selector}[aria-disabled='true']:focus-visible`);
      expect(focusRule, `${selector} focus-visible style`).toHaveLength(1);
      expect(focusRule[0]).toMatch(/opacity:\s*1\s*;/u);
    }

    for (const selector of largeActions) {
      for (const state of ['hover', 'active']) {
        const rules = declarationsForSelector(`${selector}[aria-disabled='true']:${state}`);
        expect(rules, `${selector} ${state} style`).toHaveLength(1);
        expect(rules[0]).toMatch(/background:\s*var\(--surface-2\)\s*;/u);
        if (state === 'active') expect(rules[0]).toMatch(/transform:\s*none\s*;/u);
      }
    }

    for (const selector of compactActions) {
      for (const state of ['hover', 'active']) {
        const rules = declarationsForSelector(`${selector}[aria-disabled='true']:${state}`);
        expect(rules, `${selector} ${state} style`).toHaveLength(1);
        expect(rules[0]).toMatch(/background:\s*transparent\s*;/u);
        expect(rules[0]).not.toContain('var(--surface-2)');
        if (state === 'active') expect(rules[0]).toMatch(/transform:\s*none\s*;/u);
      }
    }
  });

  it('keeps the chat composer bottom-aligned with a small optical lift for send', () => {
    expect(appStylesheet).toMatch(/\.chat-input-wrapper\s*\{[\s\S]*?align-items:\s*flex-end;/u);
    expect(appStylesheet).toMatch(/\.chat-send-btn\s*\{[\s\S]*?margin-bottom:\s*2px;/u);
  });

  it('uses the official centered contenteditable for manual sync without an auto column', () => {
    const overlay = appDocument.getElementById('manual-sync-overlay');
    const editor = appDocument.getElementById('manual-sync-value');

    expect(overlay?.querySelector('#auto-sync-value')).toBeNull();
    expect(overlay?.querySelector('[data-i18n="player.auto_sync_label"]')).toBeNull();
    expect(editor?.tagName).toBe('DIV');
    expect(editor?.getAttribute('contenteditable')).toBe('true');
    expect(editor?.getAttribute('role')).toBe('textbox');
    expect(editor?.getAttribute('inputmode')).toBe('text');
    expect(editor?.getAttribute('enterkeyhint')).toBe('done');
    expect(editor?.getAttribute('aria-describedby')).toBe('manual-sync-range-hint');
    expect(appDocument.getElementById('manual-sync-range-hint')?.textContent).toContain(
      '-9999 … +9999 ms',
    );
    expect(
      appDocument.getElementById('manual-sync-range-hint')?.classList.contains('sr-only'),
    ).toBe(true);
    expect(editor?.classList.contains('chat-input')).toBe(true);
    expect(editor?.parentElement?.classList.contains('chat-input-wrapper')).toBe(true);
    expect(appStylesheet).toMatch(
      /\.sync-manual-display\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?gap:\s*6px;/u,
    );
    expect(appStylesheet).toMatch(
      /\.sync-manual-display\s*\{[\s\S]*?margin:\s*12px 0 20px;[\s\S]*?padding:\s*0;/u,
    );
    expect(appStylesheet).toMatch(/\.sync-manual-input-wrapper\s*\{[\s\S]*?padding-bottom:\s*0;/u);
    expect(appStylesheet).toMatch(/\.sync-manual-input\s*\{[\s\S]*?text-align:\s*center;/u);
    expect(appStylesheet).toMatch(/\.sync-manual-input\s*\{[\s\S]*?padding-block:\s*8px;/u);
  });

  it('keeps the intentional contenteditable URL field and fixed-scale app surface', () => {
    const youtubeField = appDocument.getElementById('youtube-url-input');
    const youtubeSearch = appDocument.getElementById('youtube-search-btn');
    const youtubeInputWrapper = youtubeField?.closest('.yt-search-input-wrapper');
    expect(youtubeField?.tagName).toBe('DIV');
    expect(youtubeField?.getAttribute('contenteditable')).toBe('true');
    expect(youtubeField?.getAttribute('aria-describedby')).toBe('youtube-preview-status');
    expect(youtubeInputWrapper?.contains(youtubeSearch ?? null)).toBe(true);
    expect(youtubeSearch?.tagName).toBe('BUTTON');
    expect((youtubeSearch as HTMLButtonElement | null)?.type).toBe('button');
    expect((youtubeSearch as HTMLButtonElement | null)?.disabled).toBe(true);
    expect(youtubeSearch?.getAttribute('aria-controls')).toBe('youtube-search-results');
    expect(youtubeSearch?.getAttribute('data-i18n-aria-label')).toBe('youtube.search_button');
    expect(appStylesheet).toMatch(
      /\.yt-search-input-wrapper\s*\{[\s\S]*?display:\s*flex;[\s\S]*?border-bottom:\s*2px solid var\(--surface-3\);/u,
    );
    expect(appStylesheet).toMatch(
      /\.yt-search-input-wrapper \.yt-intro-text\s*\{[\s\S]*?text-align:\s*left;[\s\S]*?border-bottom:\s*0;/u,
    );
    expect(appStylesheet).toMatch(
      /\.yt-search-submit-btn:not\(:disabled\)\s*\{[\s\S]*?color:\s*var\(--primary\);/u,
    );
    expect(appStylesheet).toMatch(
      /#youtube-url-overlay \.setup-join-area\s*\{[\s\S]*?text-align:\s*left;/u,
    );

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
    const recoveryStart = appRuntimeSource.indexOf('const runLazyFeatureRecovery');
    const recoveryEnd = appRuntimeSource.indexOf('\n// bootstrap.js', recoveryStart);
    const recoverySource = appRuntimeSource.slice(recoveryStart, recoveryEnd);
    const connectBoundaryStart = appRuntimeSource.indexOf("safeInit('Connect'");
    const connectBoundaryEnd = appRuntimeSource.indexOf(
      "safeInit('CustomScrollbars'",
      connectBoundaryStart,
    );
    const connectBoundary = appRuntimeSource.slice(connectBoundaryStart, connectBoundaryEnd);

    expect(appRuntimeSource).toContain("bus.on('app:lazy-feature-load-failed'");
    expect(appRuntimeSource).toContain("buttonText: t('common.refresh')");
    expect(appRuntimeSource).toContain("scheduleDocumentReload(t('dialog.refreshing_session')");
    expect(recoverySource).toContain("showToast(t('error.network_generic'))");
    expect(recoverySource.match(/reportLazyFeatureLoadFailure\(/gu)).toHaveLength(1);
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

  it('keeps the QR scanner and iOS YouTube tap gate rectangular under the global pill policy', () => {
    const globalButtonShapeRule = appStylesheet.match(
      /button:not\(\.ch-opt\)[\s\S]*?\{\s*border-radius:\s*999px\s*!important;\s*\}/,
    )?.[0];
    const normalizedGlobalButtonShapeRule = globalButtonShapeRule?.replace(/\s+/gu, '');
    const scannerShapeRules = declarationsForSelector('.setup-qr-scan-button');

    expect(globalButtonShapeRule).toBeDefined();
    expect(normalizedGlobalButtonShapeRule).toContain(':not(.setup-qr-scan-button)');
    expect(normalizedGlobalButtonShapeRule).toContain(':not(#youtube-ios-sync-overlay)');
    expect(scannerShapeRules.some((rule) => /border-radius:\s*0\s*;/u.test(rule))).toBe(true);
    expect(youtubeIframeSource).toMatch(
      /overlay\.style\.cssText\s*=\s*`[\s\S]*?border:0;border-radius:0;padding:0;/u,
    );
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
