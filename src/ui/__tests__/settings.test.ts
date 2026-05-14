/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { showToast } from '../toast.ts';

// Mock player-controls.ts (transitive dep)
vi.mock('../player-controls.ts', () => ({
  getStandardRolePreset: vi.fn(() => ({})),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

import { initSettings, setTheme, selectStandardChannelButton } from '../settings.ts';

beforeEach(() => {
  vi.restoreAllMocks();
  resetState();
  bus.clear();
  vi.mocked(showToast).mockClear();
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
    <div class="channel-grid" id="grid-theme">
      <div class="ch-opt" data-theme="light" id="theme-light">Light</div>
      <div class="ch-opt" data-theme="dark" id="theme-dark">Dark</div>
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

  it('resolves system to light when matchMedia prefers-color-scheme is light', () => {
    setTheme('system');
    // system → resolved to 'light' (matchMedia returns false)
    expect(document.getElementById('theme-light')!.classList.contains('active')).toBe(true);
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
    expect(meta.getAttribute('content')).toBe('#212121');
  });

  it('updates meta theme-color for light mode', () => {
    setTheme('light');
    const meta = document.querySelector('meta[name="theme-color"]')!;
    expect(meta.getAttribute('content')).toBe('#ffffff');
  });

  it('resolves system theme via matchMedia', () => {
    // jsdom matchMedia returns false by default → light
    setTheme('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('persists system preference as-is in localStorage', () => {
    setTheme('system');
    expect(localStorage.getItem('musixquare-theme')).toBe('system');
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

describe('initSettings playback mode guards', () => {
  it('blocks host channel changes while system audio owns playback', () => {
    const setChannel = vi.fn();
    bus.on('audio:set-channel-mode', setChannel);
    setState('playback.mode', 'system-audio');
    setState('playback.activity', 'playing');

    initSettings();
    document.querySelector<HTMLElement>('#grid-standard .ch-opt[data-ch="-1"]')?.click();

    expect(setChannel).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'Cannot change speaker role while sharing system audio.',
    );
  });
});
