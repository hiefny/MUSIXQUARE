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
