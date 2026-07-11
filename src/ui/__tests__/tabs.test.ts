/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';

// View transitions are outside this unit; run their callback synchronously.
vi.mock('../dom.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dom.ts')>();
  return {
    ...actual,
    animateTransition: vi.fn((cb: () => void) => cb()),
  };
});

import { switchTab, initTabs } from '../tabs.ts';

beforeEach(() => {
  resetState();
  bus.clear();
  document.body.innerHTML = `
    <nav class="bottom-nav">
      <button class="nav-item active" data-tab="play" aria-selected="true">Play</button>
      <button class="nav-item" data-tab="settings" aria-selected="false">Settings</button>
      <button class="nav-item" data-tab="devices" aria-selected="false">Devices</button>
    </nav>
    <div id="tab-play" class="tab-content active"><div class="tab-body"></div></div>
    <div id="tab-settings" class="tab-content"></div>
    <div id="tab-devices" class="tab-content"></div>
  `;
});

describe('switchTab', () => {
  it('activates the target tab content', () => {
    switchTab('settings');
    expect(document.getElementById('tab-settings')!.classList.contains('active')).toBe(true);
  });

  it('deactivates previously active tab', () => {
    switchTab('settings');
    expect(document.getElementById('tab-play')!.classList.contains('active')).toBe(false);
  });

  it('activates corresponding nav item', () => {
    switchTab('settings');
    const navItem = document.querySelector('.nav-item[data-tab="settings"]')!;
    expect(navItem.classList.contains('active')).toBe(true);
    expect(navItem.getAttribute('aria-selected')).toBe('true');
  });

  it('deactivates other nav items', () => {
    switchTab('settings');
    const playNav = document.querySelector('.nav-item[data-tab="play"]')!;
    expect(playNav.classList.contains('active')).toBe(false);
    expect(playNav.getAttribute('aria-selected')).toBe('false');
  });

  it('emits ui:settings-tab-opened for settings tab', () => {
    const fn = vi.fn();
    bus.on('ui:settings-tab-opened', fn);
    switchTab('settings');
    expect(fn).toHaveBeenCalled();
  });

  it('does not emit ui:settings-tab-opened for play tab', () => {
    const fn = vi.fn();
    bus.on('ui:settings-tab-opened', fn);
    switchTab('play');
    expect(fn).not.toHaveBeenCalled();
  });

  it('emits ui:close-chat-drawer on every tab switch', () => {
    const fn = vi.fn();
    bus.on('ui:close-chat-drawer', fn);
    switchTab('devices');
    expect(fn).toHaveBeenCalled();
  });

  it('emits the generic tab lifecycle signal used to cancel playlist gestures', () => {
    const fn = vi.fn();
    bus.on('ui:tab-changed', fn);
    switchTab('settings');
    expect(fn).toHaveBeenCalledWith('settings');
  });
});

describe('initTabs', () => {
  it('initializes without error', () => {
    expect(() => initTabs()).not.toThrow();
  });

  it('handles programmatic tab switch via bus', () => {
    initTabs();
    bus.emit('ui:switch-tab', 'settings');
    expect(document.getElementById('tab-settings')!.classList.contains('active')).toBe(true);
  });
});
