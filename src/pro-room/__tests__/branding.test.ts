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

  it('stays hidden for standard and idle sessions', () => {
    const badge = document.getElementById('header-pro-badge') as HTMLElement;

    syncProRoomBranding('');
    expect(badge.hidden).toBe(true);

    syncProRoomBranding('123456');
    expect(badge.hidden).toBe(true);
  });

  it('shows only inside the reserved PRO namespace', () => {
    const badge = document.getElementById('header-pro-badge') as HTMLElement;

    syncProRoomBranding('000001');
    expect(badge.hidden).toBe(false);
  });

  it('reacts to the canonical session-code state', () => {
    const badge = document.getElementById('header-pro-badge') as HTMLElement;
    initProRoomBranding();

    setState('network.sessionCode', '000000');
    expect(badge.hidden).toBe(false);

    setState('network.sessionCode', '654321');
    expect(badge.hidden).toBe(true);
  });
});
