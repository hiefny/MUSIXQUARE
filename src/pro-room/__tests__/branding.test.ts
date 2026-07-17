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
  document.body.innerHTML = '<span id="header-pro-badge" hidden>PRO</span>';
  document.documentElement.removeAttribute('data-pro-room');
  bus.clear();
  resetState();
});

describe('PRO room branding', () => {
  it('shares the feature badge component with both BETA badges', async () => {
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const proBadge = parsed.getElementById('header-pro-badge');
    const betaBadges = parsed.querySelectorAll('.media-source-beta-badge');

    expect(proBadge?.classList.contains('feature-badge')).toBe(true);
    expect(betaBadges).toHaveLength(2);
    for (const badge of betaBadges) {
      expect(badge.classList.contains('feature-badge')).toBe(true);
    }
  });

  it('stacks the PRO badge below the wordmark in the compact sidebar', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const compactStart = stylesheet.indexOf('@media (min-width: 720px) and (max-width: 1279px) {');
    const compactEnd = stylesheet.indexOf('/* iPad PWA portrait', compactStart);
    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    const compactSidebarStyles = stylesheet.slice(compactStart, compactEnd);

    expect(compactSidebarStyles).toMatch(
      /#app-logo\s*{\s*flex-direction:\s*column;\s*align-items:\s*flex-start;/,
    );
    expect(compactSidebarStyles).toMatch(
      /\.header-pro-badge\s*{\s*align-self:\s*flex-start;\s*margin-top:\s*12px;\s*margin-left:\s*0;/,
    );
    expect(compactSidebarStyles).toMatch(/@media\s*\(max-height:\s*400px\)/);
    expect(compactSidebarStyles).not.toMatch(/@media\s*\(max-height:\s*350px\)/);
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

  it('stays hidden for standard and idle sessions', () => {
    const badge = document.getElementById('header-pro-badge') as HTMLElement;

    syncProRoomBranding('');
    expect(badge.hidden).toBe(true);
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);

    syncProRoomBranding('123456');
    expect(badge.hidden).toBe(true);
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);
  });

  it('shows only inside the reserved PRO namespace', () => {
    const badge = document.getElementById('header-pro-badge') as HTMLElement;

    syncProRoomBranding('000001');
    expect(badge.hidden).toBe(false);
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(true);
  });

  it('reacts to the canonical session-code state', () => {
    const badge = document.getElementById('header-pro-badge') as HTMLElement;
    initProRoomBranding();

    setState('network.sessionCode', '000000');
    expect(badge.hidden).toBe(false);
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(true);

    setState('network.sessionCode', '654321');
    expect(badge.hidden).toBe(true);
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);
  });
});
