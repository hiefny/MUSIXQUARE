/**
 * MUSIXQUARE — Tab Navigation
 *
 * Manages: Tab switching (mobile bottom nav & desktop grid).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { isPlaybackModeYouTube } from '../player/ownership.ts';
import { setManagedTimer } from '../core/timers.ts';
import { animateTransition } from './dom.ts';

// ─── Tab Switching ───────────────────────────────────────────────

export function switchTab(tabId: string): void {
  animateTransition(() => {
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.remove('active');
      el.setAttribute('aria-selected', 'false');
      el.setAttribute('tabindex', '-1');
    });
    const tabEl = document.getElementById(`tab-${tabId}`);
    if (tabEl) tabEl.classList.add('active');
    // Select nav item by data-tab attribute instead of index to avoid
    // DOM-order coupling with the hardcoded array.
    const navItem = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
    if (navItem) {
      navItem.classList.add('active');
      navItem.setAttribute('aria-selected', 'true');
      navItem.setAttribute('tabindex', '0');
    }

    if (tabId === 'settings') {
      bus.emit('ui:settings-tab-opened');
    }

    if (tabId === 'connect') {
      bus.emit('ui:connect-tab-opened');
    }

    if (tabId === 'playlist') {
      bus.emit('ui:playlist-tab-opened');
    }

    if (tabId === 'play') {
      setManagedTimer(
        'tab-play-check',
        () => {
          if (isPlaybackModeYouTube()) {
            bus.emit('youtube:refresh-display');
          }
          bus.emit('ui:visualizer-check');
        },
        50,
      );
    }

    bus.emit('ui:close-chat-drawer');
  });
}

// ─── Init ────────────────────────────────────────────────────────

export function initTabs(): void {
  // Bottom navigation
  const navItems = Array.from(
    document.querySelectorAll<HTMLElement>('.bottom-nav .nav-item[data-tab]'),
  );

  // Set up WAI-ARIA roles and tabindex
  navItems.forEach((el) => {
    el.setAttribute('role', 'tab');
    if (el.classList.contains('active')) {
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-selected', 'true');
    } else {
      el.setAttribute('tabindex', '-1');
      el.setAttribute('aria-selected', 'false');
    }
  });

  navItems.forEach((el) => {
    el.addEventListener('click', () => {
      try {
        el.blur();
      } catch {
        /* ignore */
      }
      if (el.classList.contains('active')) {
        const tabBody = document.querySelector(`#tab-${el.dataset.tab} .tab-body`);
        if (tabBody) tabBody.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        if (el.dataset.tab) switchTab(el.dataset.tab);
      }
    });

    // Arrow key navigation following WAI-ARIA tabs pattern
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      const idx = navItems.indexOf(el);
      if (idx === -1) return;
      const len = navItems.length;
      let targetIdx: number;

      switch (e.key) {
        case 'ArrowRight':
          targetIdx = (idx + 1) % len;
          break;
        case 'ArrowLeft':
          targetIdx = (idx - 1 + len) % len;
          break;
        case 'Home':
          targetIdx = 0;
          break;
        case 'End':
          targetIdx = len - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      const target = navItems[targetIdx];
      target.focus();
      if (target.dataset.tab) switchTab(target.dataset.tab);
    });
  });

  // New compact help button (landscape < 315px)
  const compactHelpBtn = document.getElementById('btn-help-compact');
  if (compactHelpBtn) {
    compactHelpBtn.addEventListener('click', () => {
      switchTab('guide');
    });
  }

  // Programmatic tab switch via bus (e.g. from playlist.ts on track play)
  bus.on('ui:switch-tab', (tabId) => {
    switchTab(tabId);
  });

  try {
    const desktopMql = window.matchMedia('(min-width: 1280px)');
    const refreshDesktopPanels = () => {
      if (!desktopMql.matches) return;
      setManagedTimer(
        'tabs-desktop-panel-refresh',
        () => {
          if (isPlaybackModeYouTube()) {
            bus.emit('youtube:refresh-display');
          }
          bus.emit('ui:player-panel-visible');
          bus.emit('ui:visualizer-check');
          bus.emit('ui:scrollbar-relayout');
        },
        80,
      );
    };
    desktopMql.addEventListener('change', refreshDesktopPanels);
  } catch {
    /* matchMedia may be unavailable in tests or very old browsers. */
  }

  log.info('[Tabs] Initialized');
}
