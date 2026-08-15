/** One-time, non-modal guidance for the setup flow's default Center role. */

import { setManagedTimer } from '../core/timers.ts';
import { bus } from '../core/events.ts';
import { switchTab } from './tabs.ts';

const CENTER_ROLE_GUIDE_STORAGE_KEY = 'mxqr_center_role_guide_seen_v1';

function guideElement(): HTMLElement | null {
  return document.getElementById('center-role-guide');
}

function dismissCenterRoleGuide(): void {
  const guide = guideElement();
  if (!guide) return;
  guide.classList.remove('active');
  guide.hidden = true;
}

function openRoleSettings(): void {
  dismissCenterRoleGuide();
  let focusScheduled = false;
  const scheduleRoleTitleFocus = (): void => {
    if (focusScheduled) return;
    focusScheduled = true;
    setManagedTimer(
      'center-role-guide-focus',
      () => {
        const audioSubtab = document.getElementById('settings-subtab-audio');
        if (audioSubtab?.getAttribute('aria-pressed') !== 'true') audioSubtab?.click();
        const title = document.getElementById('settings-role-title');
        if (!title) return;
        title.setAttribute('tabindex', '-1');
        title.scrollIntoView({ behavior: 'smooth', block: 'start' });
        title.focus({ preventScroll: true });
      },
      0,
    );
  };
  const stopWaitingForTab = bus.once('ui:settings-tab-opened', scheduleRoleTitleFocus);
  switchTab('settings');

  // View Transitions may defer switchTab's DOM callback. Focus from the
  // settings-opened signal, with a bounded fallback for reduced/test runtimes.
  setManagedTimer(
    'center-role-guide-focus-fallback',
    () => {
      stopWaitingForTab();
      scheduleRoleTitleFocus();
    },
    200,
  );
}

export function initCenterRoleGuide(): void {
  const settingsButton = document.getElementById('btn-center-role-settings');
  const dismissButton = document.getElementById('btn-center-role-dismiss');
  if (settingsButton && settingsButton.dataset.roleGuideBound !== '1') {
    settingsButton.dataset.roleGuideBound = '1';
    settingsButton.addEventListener('click', openRoleSettings);
  }
  if (dismissButton && dismissButton.dataset.roleGuideBound !== '1') {
    dismissButton.dataset.roleGuideBound = '1';
    dismissButton.addEventListener('click', dismissCenterRoleGuide);
  }
}

function showCenterRoleGuideOnce(): boolean {
  const guide = guideElement();
  if (!guide || guide.dataset.shown === 'true') return false;

  try {
    if (localStorage.getItem(CENTER_ROLE_GUIDE_STORAGE_KEY) === '1') return false;
    localStorage.setItem(CENTER_ROLE_GUIDE_STORAGE_KEY, '1');
  } catch {
    // Storage can be unavailable in privacy modes. The DOM marker still keeps
    // the guide one-time for the lifetime of this document.
  }

  guide.dataset.shown = 'true';
  guide.hidden = false;
  requestAnimationFrame(() => guide.classList.add('active'));
  return true;
}

export function scheduleCenterRoleGuideOnce(): void {
  setManagedTimer('center-role-guide-show', showCenterRoleGuideOnce, 800);
}
