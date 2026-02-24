/**
 * MUSIXQUARE 2.0 — Tab Navigation
 * Extracted from original app.js lines 1927-1959
 *
 * Manages: Tab switching (mobile bottom nav & desktop grid).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';
import { animateTransition } from './dom.ts';

// ─── Chat Drawer State ───────────────────────────────────────────

let _isChatDrawerOpen = false;

export function isChatDrawerOpen(): boolean {
  return _isChatDrawerOpen;
}

export function setChatDrawerOpen(open: boolean): void {
  _isChatDrawerOpen = open;
}

// ─── Tab Switching ───────────────────────────────────────────────

export function switchTab(tabId: string): void {
  animateTransition(() => {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const tabEl = document.getElementById(`tab-${tabId}`);
    if (tabEl) tabEl.classList.add('active');
    const tabs = ['play', 'playlist', 'settings', 'guide'];
    const idx = tabs.indexOf(tabId);
    if (idx >= 0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active');

    if (tabId === 'settings') {
      bus.emit('ui:settings-tab-opened');
    }

    if (tabId === 'play') {
      setTimeout(() => {
        const currentState = getState<string>('appState');
        if (currentState === APP_STATE.PLAYING_YOUTUBE) {
          bus.emit('youtube:refresh-display');
        }
        bus.emit('ui:visualizer-check');
      }, 50);
    }

    if (_isChatDrawerOpen) {
      bus.emit('ui:toggle-chat-drawer');
    }
  });
}

// ─── Init ────────────────────────────────────────────────────────

export function initTabs(): void {
  // Bottom navigation
  document.querySelectorAll<HTMLElement>('.bottom-nav .nav-item[data-tab]').forEach(el => {
    el.addEventListener('click', () => {
      try { el.blur(); } catch { /* ignore */ }
      if (el.classList.contains('active')) {
        const tabBody = document.querySelector(`#tab-${el.dataset.tab} .tab-body`);
        if (tabBody) tabBody.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        switchTab(el.dataset.tab!);
      }
    });
  });

  // Listen for programmatic tab switch
  bus.on('ui:switch-tab', ((...args: unknown[]) => {
    const tabId = args[0] as string;
    if (tabId) switchTab(tabId);
  }) as (...args: unknown[]) => void);

  log.info('[Tabs] Initialized');
}
