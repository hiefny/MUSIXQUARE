/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { showToast } from '../toast.ts';
import { LANGUAGE_OPTIONS, setLanguageMode } from '../../i18n/index.ts';
import type { DataConnection } from '../../types/index.ts';

// Mock player-controls.ts (transitive dep)
vi.mock('../player-controls.ts', () => ({
  getStandardRolePreset: vi.fn(() => ({})),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

import { initSettings, setTheme, selectStandardChannelButton } from '../settings.ts';

class ResizeObserverStub {
  observe(): void {
    /* noop */
  }

  unobserve(): void {
    /* noop */
  }

  disconnect(): void {
    /* noop */
  }
}

function installEffectSettingsDom(): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `
      <div class="channel-grid" id="grid-reverb">
        <button class="ch-opt" data-rvb-type="studio">Studio</button>
        <button class="ch-opt" data-rvb-type="arena">Arena</button>
        <button class="ch-opt" data-rvb-type="advanced">Advanced</button>
        <button class="ch-opt active" data-rvb-type="off">Off</button>
      </div>
      <div id="reverb-sliders-area" class="reverb-sliders-area collapsed">
        <span id="val-reverb">0%</span>
        <input type="range" id="reverb-slider" min="0" max="100" value="0" />
        <span id="val-rvb-decay">5.0s</span>
        <input type="range" id="reverb-decay-slider" min="0.1" max="10.0" step="0.1" value="5.0" />
        <span id="val-rvb-predelay">0.1s</span>
        <input type="range" id="reverb-predelay-slider" min="0" max="0.5" step="0.01" value="0.1" />
        <span id="val-rvb-lowcut">20Hz</span>
        <input type="range" id="reverb-lowcut-slider" min="0" max="100" step="1" value="0" />
        <span id="val-rvb-highcut">20.0kHz</span>
        <input type="range" id="reverb-highcut-slider" min="0" max="100" step="1" value="0" />
      </div>
      <div class="channel-grid" id="grid-eq">
        <button class="ch-opt" data-eq-type="bright">Bright</button>
        <button class="ch-opt" data-eq-type="warm">Warm</button>
        <button class="ch-opt" data-eq-type="advanced">Advanced</button>
        <button class="ch-opt active" data-eq-type="off">Off</button>
      </div>
      <div class="channel-grid" id="grid-exciter">
        <button class="ch-opt" data-toggle="on">On</button>
        <button class="ch-opt active" data-toggle="off">Off</button>
      </div>
      <div id="eq-sliders-area" class="reverb-sliders-area collapsed">
        ${Array.from(
          { length: 5 },
          (_, i) => `
            <span id="eq-val-${i}">0</span>
            <input type="range" class="eq-slider" id="eq-slider-${i}" min="-12" max="12" value="0" />
          `,
        ).join('')}
      </div>
    `,
  );
}

function installLanguageSettingsDom(): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `
      <div class="channel-grid language-mode-grid" id="grid-lang">
        <button
          type="button"
          class="ch-opt"
          id="btn-language-select"
          data-lang-action="select"
        >
          <span>Select</span>
        </button>
        <button
          type="button"
          class="ch-opt"
          id="btn-language-system"
          data-lang-action="system"
        >
          <span>System</span>
        </button>
      </div>
      <div
        class="dialog-overlay language-dialog-overlay"
        id="language-dialog-overlay"
        aria-hidden="true"
      >
        <div class="dialog language-dialog">
          <div class="dialog-header">
            <span class="dialog-title" id="language-dialog-title">Select Language</span>
            <span class="media-source-beta-badge language-dialog-beta-badge" aria-label="Beta">
              BETA
            </span>
          </div>
          <div
            class="language-list"
            id="language-list"
            role="listbox"
            data-custom-scroll
            data-custom-scroll-contained
          ></div>
          <div class="dialog-actions">
            <button type="button" class="dialog-primary" id="btn-language-dialog-done">
              Done
            </button>
          </div>
        </div>
      </div>
    `,
  );
}

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
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverStub,
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
  setLanguageMode('en');
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
    expect(meta.getAttribute('content')).toBe('#1a1a1a');
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
    expect(showToast).toHaveBeenCalledWith('Cannot change roles during system audio sharing.');
  });
});

describe('initSettings language controls', () => {
  it('opens the language dialog with all supported languages and a custom scrollbar', () => {
    setLanguageMode('ko');
    installLanguageSettingsDom();
    initSettings();

    document.getElementById('btn-language-select')?.click();

    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    expect(document.querySelectorAll('.language-option')).toHaveLength(LANGUAGE_OPTIONS.length);
    expect(document.querySelector('.language-dialog > .cscroll-track')).not.toBeNull();
    expect(document.querySelector('.language-dialog-beta-badge')?.textContent?.trim()).toBe('BETA');
    expect(document.querySelector<HTMLElement>('.language-option.active')?.dataset.lang).toBe('ko');
  });

  it('switches between explicit selection and system language mode', () => {
    installLanguageSettingsDom();
    initSettings();

    document.getElementById('btn-language-select')?.click();
    document.querySelector<HTMLElement>('.language-option[data-lang="en"]')?.click();

    expect(localStorage.getItem('musixquare-lang')).toBe('en');
    expect(document.getElementById('btn-language-select')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );

    document.getElementById('btn-language-dialog-done')?.click();
    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      false,
    );

    document.getElementById('btn-language-system')?.click();

    expect(localStorage.getItem('musixquare-lang')).toBe('system');
    expect(document.getElementById('btn-language-system')?.classList.contains('active')).toBe(true);
  });

  it('keeps the language dialog open when the backdrop is clicked', () => {
    installLanguageSettingsDom();
    initSettings();

    document.getElementById('btn-language-select')?.click();
    const overlay = document.getElementById('language-dialog-overlay')!;

    overlay.click();

    expect(overlay.classList.contains('show')).toBe(true);
  });
});

describe('initSettings effect slider fill sync', () => {
  it('updates reverb range fill when a preset sets hidden advanced sliders', () => {
    installEffectSettingsDom();
    initSettings();

    document.querySelector<HTMLElement>('#grid-reverb .ch-opt[data-rvb-type="arena"]')?.click();
    document.querySelector<HTMLElement>('#grid-reverb .ch-opt[data-rvb-type="advanced"]')?.click();

    const slider = document.getElementById('reverb-slider') as HTMLInputElement;
    expect(slider.value).toBe('50');
    expect(slider.style.getPropertyValue('--range-progress')).toBe('50%');
    expect(document.getElementById('reverb-sliders-area')?.classList.contains('collapsed')).toBe(
      false,
    );
  });

  it('explains locked global audio settings to non-admin guests', () => {
    installEffectSettingsDom();
    setState('network.hostConn', { open: true } as DataConnection);
    setState('network.isOperator', false);
    initSettings();

    document.querySelector<HTMLElement>('#grid-reverb .ch-opt[data-rvb-type="arena"]')?.click();

    expect(showToast).toHaveBeenCalledWith('Only admins can change global settings');
    expect(
      document
        .querySelector('#grid-reverb .ch-opt[data-rvb-type="arena"]')
        ?.classList.contains('active'),
    ).toBe(false);
    expect(document.getElementById('grid-reverb')?.classList.contains('host-ctrl-locked')).toBe(
      true,
    );
    expect(document.getElementById('grid-reverb')?.getAttribute('aria-disabled')).toBe('true');
    expect((document.getElementById('reverb-slider') as HTMLInputElement).disabled).toBe(true);
  });

  it('detects host-synced reverb presets from the audio preset constants', () => {
    installEffectSettingsDom();
    initSettings();

    bus.emit('ui:sync-reverb-param', 'mix', 50);
    bus.emit('ui:sync-reverb-param', 'decay', 5);
    bus.emit('ui:sync-reverb-param', 'predelay', 0.12);
    bus.emit('ui:sync-reverb-param', 'lowcut', 0);
    // Arena's highCut knob value 40 maps to an approximately 6 kHz wet low-pass.
    bus.emit('ui:sync-reverb-param', 'highcut', 40);

    expect(
      document
        .querySelector('#grid-reverb .ch-opt[data-rvb-type="arena"]')
        ?.classList.contains('active'),
    ).toBe(true);
    expect(document.getElementById('reverb-sliders-area')?.classList.contains('collapsed')).toBe(
      true,
    );
  });

  it('updates EQ range fill when a preset sets hidden advanced sliders', () => {
    installEffectSettingsDom();
    initSettings();

    document.querySelector<HTMLElement>('#grid-eq .ch-opt[data-eq-type="bright"]')?.click();
    document.querySelector<HTMLElement>('#grid-eq .ch-opt[data-eq-type="advanced"]')?.click();

    const slider = document.getElementById('eq-slider-4') as HTMLInputElement;
    expect(slider.value).toBe('6');
    expect(slider.style.getPropertyValue('--range-progress')).toBe('75%');
    expect(document.getElementById('eq-sliders-area')?.classList.contains('collapsed')).toBe(false);
  });

  it('updates range fill for host-synced effect values', () => {
    installEffectSettingsDom();
    initSettings();

    bus.emit('ui:sync-reverb-param', 'mix', 30);
    bus.emit('ui:sync-eq-band', 0, -6);

    const reverbSlider = document.getElementById('reverb-slider') as HTMLInputElement;
    const eqSlider = document.getElementById('eq-slider-0') as HTMLInputElement;
    expect(reverbSlider.style.getPropertyValue('--range-progress')).toBe('30%');
    expect(eqSlider.style.getPropertyValue('--range-progress')).toBe('25%');
  });

  it('updates EQ preset chips from host-synced band values', () => {
    installEffectSettingsDom();
    initSettings();

    [5, 3, 0, -2, -3].forEach((value, index) => {
      bus.emit('ui:sync-eq-band', index, value);
    });

    expect(
      document.querySelector('#grid-eq .ch-opt[data-eq-type="warm"]')?.classList.contains('active'),
    ).toBe(true);
    expect(document.getElementById('eq-sliders-area')?.classList.contains('collapsed')).toBe(true);
  });

  it('marks EQ as advanced when host-synced band values do not match a preset', () => {
    installEffectSettingsDom();
    initSettings();

    bus.emit('ui:sync-eq-band', 0, -6);

    expect(
      document
        .querySelector('#grid-eq .ch-opt[data-eq-type="advanced"]')
        ?.classList.contains('active'),
    ).toBe(true);
    expect(document.getElementById('eq-sliders-area')?.classList.contains('collapsed')).toBe(false);
  });

  it('marks EQ as off when host-synced band values return to flat', () => {
    installEffectSettingsDom();
    initSettings();

    bus.emit('ui:sync-eq-band', 0, -6);
    for (let index = 0; index < 5; index += 1) {
      bus.emit('ui:sync-eq-band', index, 0);
    }

    expect(
      document.querySelector('#grid-eq .ch-opt[data-eq-type="off"]')?.classList.contains('active'),
    ).toBe(true);
    expect(document.getElementById('eq-sliders-area')?.classList.contains('collapsed')).toBe(true);
  });

  it('shows the distortion warning when virtual treble is enabled', () => {
    installEffectSettingsDom();
    initSettings();

    document.querySelector<HTMLElement>('#grid-exciter .ch-opt[data-toggle="on"]')?.click();

    expect(showToast).toHaveBeenCalledWith('May cause distortion');
  });
});
