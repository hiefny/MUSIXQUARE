import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let appCss: string;
let appIndex: string;
let appReadme: string;
let appShell: string;
let colorsTextPreview: string;
let entrySource: string;
let iconsSource: string;
let inviteCodePreview: string;
let navPreview: string;
let playlistPreview: string;
let playlistSource: string;
let settingsSource: string;

beforeAll(() => {
  appCss = readFileSync(resolve('browser/ui-kit/static/app/app.css'), 'utf8');
  appIndex = readFileSync(resolve('browser/ui-kit/static/app/index.html'), 'utf8');
  appReadme = readFileSync(resolve('browser/ui-kit/static/app/README.md'), 'utf8');
  appShell = readFileSync(resolve('browser/ui-kit/app/AppShell.tsx'), 'utf8');
  colorsTextPreview = readFileSync(resolve('public/designsystem/preview/colors-text.html'), 'utf8');
  entrySource = readFileSync(resolve('browser/ui-kit/app/entry.tsx'), 'utf8');
  iconsSource = readFileSync(resolve('browser/ui-kit/app/icons.tsx'), 'utf8');
  inviteCodePreview = readFileSync(resolve('public/designsystem/preview/invite-code.html'), 'utf8');
  navPreview = readFileSync(resolve('public/designsystem/preview/nav-pill.html'), 'utf8');
  playlistPreview = readFileSync(resolve('public/designsystem/preview/playlist.html'), 'utf8');
  playlistSource = readFileSync(resolve('browser/ui-kit/app/Playlist.tsx'), 'utf8');
  settingsSource = readFileSync(resolve('browser/ui-kit/app/Settings.tsx'), 'utf8');
});

describe('auxiliary design-system development samples', () => {
  it('keeps the UI kit explicitly subordinate to the production contract', () => {
    expect(appReadme).toContain('not an authoritative or complete copy');
    expect(appReadme).toMatch(/`index\.html`, `css\/style\.css`, and\s+`src\/ui\/`/u);
    expect(appIndex).toContain('Non-authoritative click-through component sample');
  });

  it('mirrors the solid edge-to-edge navigation and current navigation glyphs', () => {
    expect(appCss).toMatch(
      /\.mq-nav\s*\{[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?left:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*var\(--surface-1\);/u,
    );
    expect(appCss).not.toMatch(/\.mq-nav\s*\{[^}]*backdrop-filter/u);
    expect(appShell).toContain("{ id: 'connect', label: 'Connect', icon: I.connect }");
    expect(appShell).toContain("{ id: 'guide', label: 'Help', icon: I.help }");
    expect(appShell).not.toContain('I.users');
    expect(appCss).toMatch(/grid-template-columns:\s*repeat\(5,/u);
    expect(appShell).toContain('<nav className="mq-nav" role="tablist">');
    expect(appShell).toContain('role="tab"');
    expect(appShell).toContain('aria-selected={tab === item.id}');
    expect(navPreview).toContain('role="tablist"');
    expect(navPreview.match(/role="tab"/gu)).toHaveLength(5);
    expect(navPreview).toContain('<html data-theme="dark">');

    const header = appShell.slice(appShell.indexOf('<header'), appShell.indexOf('</header>'));
    expect(header).toContain('mq-role-badge');
    expect(header).toContain('onAccount');
    expect(header).not.toContain('<i />');
    expect(appCss).not.toContain('.mq-role-badge i');
    expect(header).not.toContain('<I.help');
    expect(appShell).not.toContain('onLeave');
  });

  it('paints destructive labels with the danger foreground and the button label tokens', () => {
    // public/designsystem/README.md: --danger-foreground colors destructive
    // labels over --control-danger; the filled --danger-filled is a surface.
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return appCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';
    };
    const leave = rule('.mq-leave-session');
    expect(leave).toContain('color: var(--danger-foreground, #ff3b30);');
    expect(leave).toContain('background: var(--control-danger, rgba(255, 59, 48, 0.09));');
    expect(leave).toContain('font-size: var(--button-label-size, 15px);');
    expect(leave).toContain('font-weight: var(--font-weight-label, 600);');
    expect(leave).toContain('line-height: var(--button-label-line-height, 1.25);');
    expect(leave).toContain('letter-spacing: var(--button-label-letter-spacing, normal);');
    expect(rule('.mq-track-remove:hover')).toContain('color: var(--danger-foreground, #ff3b30);');
    expect(appCss).not.toMatch(/color:\s*var\(--danger-filled/u);
    expect(appCss).not.toMatch(/#ef4444/u);
  });

  it('gives the sample buttons the button label roles', () => {
    // Owner decision (2026-10-28): the CTA role (15px / 600 / 1.25 / normal)
    // on every action button and the chip role (14px) on choice cards, with
    // the production values as fallbacks. Under the final weight policy the
    // CTA reads the label weight and the choice and role cards, selection
    // groups, read the unselected weight with the selected weight on the
    // chosen card.
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return appCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';
    };
    const shared = [
      'line-height: var(--button-label-line-height, 1.25);',
      'letter-spacing: var(--button-label-letter-spacing, normal);',
    ];
    for (const selector of ['.mq-cta', '.mq-leave-session']) {
      const declarations = rule(selector);
      expect(declarations, selector).toContain('font-size: var(--button-label-size, 15px);');
      expect(declarations, selector).toContain('font-weight: var(--font-weight-label, 600);');
      for (const declaration of shared) expect(declarations, selector).toContain(declaration);
    }
    for (const [selector, selected] of [
      ['.mq-setting-option', '.mq-setting-option.active'],
      ['.mq-role .label', '.mq-role.active .label'],
    ] as const) {
      const declarations = rule(selector);
      expect(declarations, selector).toContain('font-size: var(--button-label-chip-size, 14px);');
      expect(declarations, selector).toContain('font-weight: var(--font-weight-unselected, 500);');
      for (const declaration of shared) expect(declarations, selector).toContain(declaration);
      expect(rule(selected), selected).toContain('font-weight: var(--font-weight-selected, 700);');
    }
    expect(appCss).not.toMatch(/--button-label-weight|--font-weight-display/u);
    expect(appReadme).toContain('the button label roles: the CTA role (15px / 600)');
  });

  it('sets the sample toast at the label weight like the app toast', () => {
    // Owner decision (2026-10-29): toast text reads at the label weight 600.
    const toast = appCss.match(/(?:^|\n)\.mq-toast\s*\{([^}]*)\}/u)?.[1] ?? '';
    expect(toast).toContain('font-weight: var(--font-weight-label, 600);');
  });

  it('uses the 64px playback action and 28px glyph', () => {
    expect(appCss).toMatch(/\.mq-fab\s*\{[^}]*width:\s*64px;[^}]*height:\s*64px;/u);
    expect(appCss).toMatch(/\.mq-fab svg\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/u);
  });

  it('shows current playlist anatomy without legacy waveforms or row durations', () => {
    const playlistArtifacts = `${playlistSource}\n${playlistPreview}`;

    expect(playlistArtifacts).not.toMatch(/\bwave\b|track\.dur|class="dur"/iu);
    expect(playlistArtifacts).toContain('M8 5v14l11-7z');
    expect(playlistArtifacts).toContain('M12 3v9.28');
    expect(playlistArtifacts).toContain('M21.582 6.186');
    expect(playlistArtifacts).toContain('M19 6.41');
    expect(playlistSource).toContain('mq-reorder-grip');
    expect(playlistSource).toContain('mq-track-remove');

    const gripIcon = iconsSource.slice(
      iconsSource.indexOf('grip: (props)'),
      iconsSource.indexOf('moon: (props)'),
    );
    expect(gripIcon).toContain("stroke-icon${props.className ? ` ${props.className}` : ''}");
  });

  it('keeps the General settings sample flat and removes retired control labels', () => {
    expect(settingsSource).not.toMatch(/HOST-CTRL|SELF-CTRL|Equalizer|Reverb/u);
    expect(settingsSource.indexOf('>Language<')).toBeLessThan(settingsSource.indexOf('>Theme<'));
    expect(settingsSource.indexOf('>Theme<')).toBeLessThan(settingsSource.indexOf('>UI Sounds<'));
    expect(settingsSource.indexOf('>UI Sounds<')).toBeLessThan(
      settingsSource.indexOf('>Settings Sync<'),
    );
    const sectionRule = appCss.match(/\.mq-setting-section\s*\{([^}]*)\}/u)?.[1];
    expect(sectionRule).toBeTruthy();
    expect(sectionRule).not.toContain('background:');
    expect(appCss).toContain('border-bottom: 1px solid var(--divider);');
    expect(appCss).toMatch(/\.mq-settings-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr;/u);
    expect(settingsSource).toContain('aria-label="leave"');
    expect(settingsSource).toContain('onClick={onLeave}');
    expect(entrySource).toContain("onLeave={() => setStage('start')}");
    expect(appReadme).toContain('dedicated leave-session action');
  });

  it('documents every light text role and the compact invite-code cluster', () => {
    expect(colorsTextPreview).toContain('#868E96');
    expect(colorsTextPreview).toContain('light text-muted');
    expect(inviteCodePreview).toMatch(/\.cluster\s*\{[^}]*height:\s*36px;/u);
    expect(inviteCodePreview).toMatch(/\.value\s*\{[^}]*font-size:\s*16px;/u);
    expect(inviteCodePreview).not.toMatch(/font-size:\s*48px/u);
  });
});
