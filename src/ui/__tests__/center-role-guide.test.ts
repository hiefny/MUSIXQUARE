/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  switchTab: vi.fn(),
  setManagedTimer: vi.fn((_name: string, callback: () => void) => callback()),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: mocks.setManagedTimer,
}));

vi.mock('../tabs.ts', () => ({
  switchTab: mocks.switchTab,
}));

import { initCenterRoleGuide, scheduleCenterRoleGuideOnce } from '../center-role-guide.ts';

function renderGuide(): void {
  document.body.innerHTML = `
    <aside id="center-role-guide" hidden>
      <button id="btn-center-role-settings"></button>
      <button id="btn-center-role-dismiss"></button>
    </aside>
    <button id="settings-subtab-audio" aria-pressed="false"></button>
    <h3 id="settings-role-title"></h3>
  `;
  document.getElementById('settings-subtab-audio')?.addEventListener('click', (event) => {
    (event.currentTarget as HTMLElement).setAttribute('aria-pressed', 'true');
  });
  Object.defineProperty(document.getElementById('settings-role-title'), 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
}

describe('one-time Center role guide', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    renderGuide();
  });

  it('shows once, persists the acknowledgement, and stays suppressed in a new document', () => {
    initCenterRoleGuide();
    scheduleCenterRoleGuideOnce();

    const firstGuide = document.getElementById('center-role-guide') as HTMLElement;
    expect(firstGuide.hidden).toBe(false);
    expect(firstGuide.classList).toContain('active');
    expect(localStorage.getItem('mxqr_center_role_guide_seen_v1')).toBe('1');

    renderGuide();
    initCenterRoleGuide();
    scheduleCenterRoleGuideOnce();

    expect((document.getElementById('center-role-guide') as HTMLElement).hidden).toBe(true);
  });

  it('opens the Audio role setting and moves focus to its heading', () => {
    initCenterRoleGuide();
    scheduleCenterRoleGuideOnce();
    document.getElementById('btn-center-role-settings')?.click();

    expect(mocks.switchTab).toHaveBeenCalledWith('settings');
    expect(document.getElementById('settings-subtab-audio')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.activeElement).toBe(document.getElementById('settings-role-title'));
    expect((document.getElementById('center-role-guide') as HTMLElement).hidden).toBe(true);
  });
});
