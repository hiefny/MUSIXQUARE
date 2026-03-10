/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock player-controls.ts (transitive dep)
vi.mock('../player-controls.ts', () => ({
  getStandardRolePreset: vi.fn(() => ({})),
}));

import { setTheme, selectStandardChannelButton } from '../settings.ts';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // Polyfill matchMedia for jsdom
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  document.body.innerHTML = `
    <div class="theme-selector" style="">
      <button id="theme-light" class="theme-opt">Light</button>
      <button id="theme-dark" class="theme-opt">Dark</button>
      <button id="theme-system" class="theme-opt">System</button>
    </div>
    <div id="grid-standard">
      <button class="ch-opt" data-ch="0">Stereo</button>
      <button class="ch-opt" data-ch="-1">Left</button>
      <button class="ch-opt" data-ch="1">Right</button>
      <button class="ch-opt" data-ch="2">Sub</button>
    </div>
    <meta name="theme-color" content="">
    <meta name="color-scheme" content="">
  `;
});

describe('setTheme', () => {
  it('activates light theme button', () => {
    setTheme('light');
    expect(document.getElementById('theme-light')!.classList.contains('active')).toBe(true);
    expect(document.getElementById('theme-dark')!.classList.contains('active')).toBe(false);
  });

  it('activates dark theme button', () => {
    setTheme('dark');
    expect(document.getElementById('theme-dark')!.classList.contains('active')).toBe(true);
    expect(document.getElementById('theme-light')!.classList.contains('active')).toBe(false);
  });

  it('activates system theme button', () => {
    setTheme('system');
    expect(document.getElementById('theme-system')!.classList.contains('active')).toBe(true);
  });

  it('sets data-theme attribute on html', () => {
    setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('persists preference to localStorage', () => {
    setTheme('dark');
    expect(localStorage.getItem('musixquare-theme')).toBe('dark');
  });

  it('sets color-scheme style on html', () => {
    setTheme('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('updates meta theme-color for dark mode', () => {
    setTheme('dark');
    const meta = document.querySelector('meta[name="theme-color"]')!;
    expect(meta.getAttribute('content')).toBe('#000000');
  });

  it('updates meta theme-color for light mode', () => {
    setTheme('light');
    const meta = document.querySelector('meta[name="theme-color"]')!;
    expect(meta.getAttribute('content')).toBe('#f2f2f7');
  });

  it('resolves system theme via matchMedia', () => {
    // jsdom matchMedia returns false by default → light
    setTheme('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('sets pill index for sliding animation', () => {
    setTheme('dark');
    const selector = document.querySelector('.theme-selector') as HTMLElement;
    expect(selector.style.getPropertyValue('--pill-index')).toBe('1');
  });

  it('sets pill index 0 for light', () => {
    setTheme('light');
    const selector = document.querySelector('.theme-selector') as HTMLElement;
    expect(selector.style.getPropertyValue('--pill-index')).toBe('0');
  });

  it('sets pill index 2 for system', () => {
    setTheme('system');
    const selector = document.querySelector('.theme-selector') as HTMLElement;
    expect(selector.style.getPropertyValue('--pill-index')).toBe('2');
  });
});

describe('selectStandardChannelButton', () => {
  it('activates stereo button (mode 0)', () => {
    selectStandardChannelButton(0);
    const stereo = document.querySelector('.ch-opt[data-ch="0"]')!;
    expect(stereo.classList.contains('active')).toBe(true);
  });

  it('activates left button (mode -1)', () => {
    selectStandardChannelButton(-1);
    const left = document.querySelector('.ch-opt[data-ch="-1"]')!;
    expect(left.classList.contains('active')).toBe(true);
  });

  it('deactivates other buttons when selecting', () => {
    // First activate stereo
    selectStandardChannelButton(0);
    // Then activate left
    selectStandardChannelButton(-1);
    const stereo = document.querySelector('.ch-opt[data-ch="0"]')!;
    expect(stereo.classList.contains('active')).toBe(false);
  });
});
