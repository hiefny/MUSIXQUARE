// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import {
  initProRoomBranding,
  syncProRoomBrandingForTests as syncProRoomBranding,
} from '../branding.ts';

beforeEach(() => {
  document.body.innerHTML = `
    <svg id="header-standard-wordmark"></svg>
    <svg id="header-pro-wordmark"></svg>
  `;
  document.documentElement.removeAttribute('data-pro-room');
  bus.clear();
  resetState();
});

describe('PRO room branding', () => {
  it('uses a dedicated one-line MXQR PRO wordmark instead of a generic badge', async () => {
    const markup = await readFile('index.html', 'utf8');
    const stylesheet = await readFile('css/style.css', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const standardWordmark = parsed.getElementById('header-standard-wordmark');
    const proWordmark = parsed.getElementById('header-pro-wordmark');
    const betaBadges = parsed.querySelectorAll('.media-source-beta-badge');

    expect(standardWordmark?.tagName).toBe('svg');
    expect(proWordmark?.tagName).toBe('svg');
    expect(proWordmark?.querySelectorAll('path')).toHaveLength(7);
    expect(proWordmark?.querySelector('text')).toBeNull();
    expect(parsed.getElementById('header-pro-badge')).toBeNull();
    expect(stylesheet).toMatch(/\.header-pro-wordmark\s*{\s*display:\s*none;/);
    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+#header-standard-wordmark\s*{\s*display:\s*none;/,
    );
    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+\.header-pro-wordmark\s*{\s*display:\s*block;/,
    );
    expect(betaBadges).toHaveLength(2);
    for (const badge of betaBadges) {
      expect(badge.classList.contains('feature-badge')).toBe(true);
    }
  });

  it('keeps the PRO wordmark on one line before the truly short super-compact breakpoint', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const compactStart = stylesheet.indexOf('@media (min-width: 720px) and (max-width: 1279px) {');
    const compactEnd = stylesheet.indexOf('/* iPad PWA portrait', compactStart);
    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    const compactSidebarStyles = stylesheet.slice(compactStart, compactEnd);

    expect(compactSidebarStyles).toMatch(
      /#app-logo\s*{\s*flex-direction:\s*row;\s*align-items:\s*center;/,
    );
    expect(compactSidebarStyles).toMatch(/@media\s*\(max-height:\s*350px\)/);
    expect(compactSidebarStyles).not.toMatch(/@media\s*\(max-height:\s*400px\)/);
  });

  it('keeps the persistent-storage disclosure contextual to PRO rooms', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');

    expect(stylesheet).toMatch(/\[data-legal-standard-storage\]\s*{\s*display:\s*inline;/);
    expect(stylesheet).toMatch(/\[data-legal-pro-storage\]\s*{\s*display:\s*none;/);
    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+\[data-legal-standard-storage\]\s*{\s*display:\s*none;/,
    );
    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+\[data-legal-pro-storage\]\s*{\s*display:\s*inline;/,
    );
  });

  it('keeps equal PRO role badges on the primary blue identity treatment', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toMatch(
      /\.role-badge\.pro-equal\s*{\s*background:\s*var\(--primary\);\s*color:\s*white;/,
    );
    expect(stylesheet).toMatch(
      /\.role-badge\.pro-equal \.role-dot\s*{\s*background:\s*white;\s*opacity:\s*1;/,
    );
  });

  it('stays hidden for standard and idle sessions', () => {
    syncProRoomBranding('');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);

    syncProRoomBranding('123456');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);
  });

  it('shows only inside the reserved PRO namespace', () => {
    syncProRoomBranding('000001');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(true);
  });

  it('reacts to the canonical session-code state', () => {
    initProRoomBranding();

    setState('network.sessionCode', '000000');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(true);

    setState('network.sessionCode', '654321');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);
  });
});
