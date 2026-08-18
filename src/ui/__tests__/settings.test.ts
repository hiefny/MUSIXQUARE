/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { showToast } from '../toast.ts';
import { LANGUAGE_OPTIONS, setLanguageMode, t } from '../../i18n/index.ts';
import type { DataConnection } from '../../types/index.ts';
import { configureSystemAudioCaptureActivityProbe } from '../../audio/system-audio-policy.ts';

const preloadLocaleFontGlyphsMock = vi.hoisted(() =>
  vi.fn<(code: string, text: string) => Promise<boolean>>(() => Promise.resolve(true)),
);

vi.mock('../../i18n/locale-fonts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/locale-fonts.ts')>();
  return {
    ...actual,
    preloadLocaleFontGlyphs: preloadLocaleFontGlyphsMock,
  };
});

// Mock player-controls.ts (transitive dep)
vi.mock('../player-controls.ts', () => ({
  getStandardRolePreset: vi.fn(() => ({})),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

import {
  initSettings,
  openLanguageDialog,
  setTheme,
  selectStandardChannelButton,
} from '../settings.ts';

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
      <div class="channel-grid" id="grid-virtual-effects">
        <button class="ch-opt" data-virtual-effect="bass" aria-pressed="false">Bass</button>
        <button class="ch-opt" data-virtual-effect="treble" aria-pressed="false">Treble</button>
        <button class="ch-opt" data-virtual-effect="surround" aria-pressed="false">Surround</button>
        <button class="ch-opt active" data-virtual-effect="off" aria-pressed="true">Off</button>
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
          <div class="language-list-frame">
            <div
              class="language-list"
              id="language-list"
              role="group"
              aria-labelledby="language-dialog-title"
              data-custom-scroll
              data-custom-scroll-contained
            ></div>
            <span class="language-list-edge language-list-edge-top" aria-hidden="true"></span>
            <span class="language-list-edge language-list-edge-bottom" aria-hidden="true"></span>
          </div>
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

function installUiSoundsDom(): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `
      <div class="channel-grid" id="grid-ui-sounds">
        <button class="ch-opt" data-ui-sounds="on" data-ui-sound="off">On</button>
        <button class="ch-opt active" data-ui-sounds="off" data-ui-sound="off">Off</button>
      </div>
    `,
  );
}

function installSettingsSyncDom(): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="channel-grid" id="grid-settings-sync">
      <button class="ch-opt active" data-settings-sync="on" aria-pressed="true">On</button>
      <button class="ch-opt" data-settings-sync="off" aria-pressed="false">Off</button>
    </div>
    ${['reverb', 'eq', 'virtual-effects']
      .map(
        (effect) => `<button
          type="button"
          id="settings-${effect}-sync-indicator"
          data-settings-sync-indicator
          data-i18n-aria-label="toast.settings_sync_enabled"
          aria-label=""
          hidden
        ></button>`,
      )
      .join('')}`,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetState();
  bus.clear();
  vi.mocked(showToast).mockClear();
  preloadLocaleFontGlyphsMock.mockReset().mockResolvedValue(true);
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
    <span id="settings-role-title">Set this device role</span>
    <p
      id="settings-role-description"
      data-i18n="settings.role_center_desc"
      aria-live="polite"
      aria-atomic="true"
    ></p>
    <div
      id="grid-standard"
      role="group"
      aria-labelledby="settings-role-title"
      aria-describedby="settings-role-description"
    >
      <button class="ch-opt" data-ch="0">Stereo</button>
      <button class="ch-opt" data-ch="-1">Left</button>
      <button class="ch-opt" data-ch="1">Right</button>
      <button class="ch-opt" data-ch="2">Sub</button>
    </div>
    <div data-role-diagram="settings">
      <button class="graphic-speaker" data-role-mode="1">Right diagram</button>
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
    expect(document.getElementById('theme-dark')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('theme-light')!.getAttribute('aria-pressed')).toBe('false');
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
    expect(stereo.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-ch="-1"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it.each([
    [-1, 'settings.role_left_desc'],
    [0, 'settings.role_center_desc'],
    [1, 'settings.role_right_desc'],
    [2, 'settings.role_subwoofer_desc'],
  ] as const)('updates the live role description for channel mode %i', (mode, translationKey) => {
    selectStandardChannelButton(mode);

    const description = document.getElementById('settings-role-description');
    expect(description?.getAttribute('data-i18n')).toBe(translationKey);
    expect(description?.textContent).toBe(t(translationKey));
  });
});

describe('initSettings playback mode guards', () => {
  it.each([
    ['channel grid', '#grid-standard .ch-opt[data-ch="-1"]', -1],
    ['role diagram', '[data-role-diagram="settings"] [data-role-mode="1"]', 1],
  ] as const)('allows a PRO receiver to change roles from the %s', (_surface, selector, mode) => {
    const setChannel = vi.fn();
    bus.on('audio:set-channel-mode', setChannel);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    setState('network.hostConn', null);
    setState('playback.mode', 'system-audio');
    setState('playback.activity', 'playing');
    setState('systemAudio.isReceiving', true);
    const restoreProbe = configureSystemAudioCaptureActivityProbe(() => false);

    try {
      initSettings();
      document.querySelector<HTMLElement>(selector)?.click();

      expect(setChannel).toHaveBeenCalledWith(mode);
      expect(showToast).not.toHaveBeenCalledWith(
        'Cannot change roles during system audio sharing.',
      );
    } finally {
      restoreProbe();
    }
  });

  it('blocks role changes on both surfaces while this device is capturing system audio', () => {
    const setChannel = vi.fn();
    bus.on('audio:set-channel-mode', setChannel);
    setState('playback.mode', 'system-audio');
    setState('playback.activity', 'playing');
    const restoreProbe = configureSystemAudioCaptureActivityProbe(() => true);

    try {
      initSettings();
      document.querySelector<HTMLElement>('#grid-standard .ch-opt[data-ch="-1"]')?.click();
      document
        .querySelector<HTMLElement>('[data-role-diagram="settings"] [data-role-mode="1"]')
        ?.click();

      expect(setChannel).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledTimes(2);
      expect(showToast).toHaveBeenNthCalledWith(
        1,
        'Cannot change roles during system audio sharing.',
      );
      expect(showToast).toHaveBeenNthCalledWith(
        2,
        'Cannot change roles during system audio sharing.',
      );
    } finally {
      restoreProbe();
    }
  });
});

describe('settings synchronization preference', () => {
  it('defaults ON, persists OFF, and unlocks follower-local effect controls', () => {
    installSettingsSyncDom();
    installEffectSettingsDom();
    setState('setup.sessionStarted', true);
    setState('network.appRole', 'guest');
    setState('network.hostConn', { peer: 'host', open: true } as DataConnection);

    initSettings();
    expect(getState('audio.settingsSyncEnabled')).toBe(true);
    expect(document.querySelector('[data-settings-sync="on"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.getElementById('grid-reverb')?.classList).toContain('host-ctrl-locked');

    document.querySelector<HTMLElement>('[data-settings-sync="off"]')?.click();
    expect(getState('audio.settingsSyncEnabled')).toBe(false);
    expect(localStorage.getItem('musixquare-settings-sync')).toBe('off');
    expect(document.querySelector('[data-settings-sync="off"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.getElementById('grid-reverb')?.classList).not.toContain('host-ctrl-locked');
  });

  it('shows translated effect indicators for ON, hides them for OFF, and restores them for ON', () => {
    installSettingsSyncDom();
    setLanguageMode('ko');
    initSettings();

    const indicators = [
      ...document.querySelectorAll<HTMLElement>('[data-settings-sync-indicator]'),
    ];
    expect(indicators).toHaveLength(3);
    expect(indicators.every((indicator) => indicator.hidden === false)).toBe(true);
    expect(
      indicators.every((indicator) => indicator.ariaLabel === t('toast.settings_sync_enabled')),
    ).toBe(true);

    bus.emit('settings-sync:changed', false);
    expect(indicators.every((indicator) => indicator.hidden === true)).toBe(true);

    bus.emit('settings-sync:changed', true);
    expect(indicators.every((indicator) => indicator.hidden === false)).toBe(true);
  });

  it('keeps each visible sync indicator keyboard-accessible and explains it on activation', () => {
    installSettingsSyncDom();
    setLanguageMode('ko');
    initSettings();

    const indicator = document.querySelector<HTMLButtonElement>('[data-settings-sync-indicator]')!;
    expect(indicator.tagName).toBe('BUTTON');
    expect(indicator.type).toBe('button');
    expect(indicator.tabIndex).toBe(0);

    indicator.focus();
    indicator.click();

    expect(document.activeElement).toBe(indicator);
    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(t('toast.settings_sync_enabled'));
  });
});

describe('initSettings PRO device authority', () => {
  it('does not render the legacy ADMIN badge or grant/revoke action', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="device-list"></div>');
    initSettings();

    const deviceList = [
      {
        id: 'peer-1',
        label: 'Привет',
        status: 'connected',
        isHost: false,
        isOp: true,
      },
    ];
    setState('network.lastKnownDeviceList', deviceList);
    bus.emit('network:device-list-update', deviceList);

    expect(document.querySelector('.d-name')?.textContent).not.toContain('ADMIN');
    expect(document.querySelector('.d-name')?.classList).toContain('user-text-font-ru');
    expect(document.querySelector('.btn-action')).toBeNull();

    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });

    expect(document.querySelector('.d-name')?.textContent).not.toContain('ADMIN');
    expect(document.querySelector('.btn-action')).toBeNull();
    expect(document.querySelector('.d-status')?.textContent).toBe('Connected');
  });
});

describe('initSettings language controls', () => {
  it('does not preload hidden language-picker fonts during settings initialization', () => {
    installLanguageSettingsDom();
    initSettings();

    expect(preloadLocaleFontGlyphsMock).not.toHaveBeenCalled();
  });

  it('moves a supported system language to the top of the language list', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ja-JP');
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['ja-JP', 'en-US']);
    setLanguageMode('ko');
    installLanguageSettingsDom();
    initSettings();

    const options = Array.from(document.querySelectorAll<HTMLElement>('.language-option'));

    expect(options[0]?.dataset.lang).toBe('ja');
    expect(options).toHaveLength(LANGUAGE_OPTIONS.length);
    expect(new Set(options.map((option) => option.dataset.lang)).size).toBe(
      LANGUAGE_OPTIONS.length,
    );
    expect(document.querySelector<HTMLElement>('.language-option.active')?.dataset.lang).toBe('ko');
  });

  it('keeps the default order when no system language is supported', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ar-SA');
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['ar-SA', 'ja-JP']);
    installLanguageSettingsDom();
    initSettings();

    const optionCodes = Array.from(
      document.querySelectorAll<HTMLElement>('.language-option'),
      (option) => option.dataset.lang,
    );

    expect(optionCodes).toEqual(LANGUAGE_OPTIONS.map((language) => language.code));
  });

  it('opens the language dialog with all supported languages and a custom scrollbar', () => {
    setLanguageMode('ko');
    installLanguageSettingsDom();
    initSettings();

    document.getElementById('btn-language-select')?.click();

    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    expect(document.querySelectorAll('.language-option')).toHaveLength(LANGUAGE_OPTIONS.length);
    expect(document.querySelector('.language-list-frame > .cscroll-track')).not.toBeNull();
    expect(document.querySelectorAll('.language-list-edge')).toHaveLength(2);
    expect(document.querySelector('.language-dialog-beta-badge')?.textContent?.trim()).toBe('BETA');
    expect(document.querySelector<HTMLElement>('.language-option.active')?.dataset.lang).toBe('ko');
    expect(document.getElementById('language-list')?.getAttribute('role')).toBe('group');
    expect(document.querySelector('.language-option')?.getAttribute('role')).toBeNull();
    expect(
      document
        .querySelector<HTMLElement>('.language-option[data-lang="ko"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(preloadLocaleFontGlyphsMock).toHaveBeenCalledTimes(5);
  });

  it('suppresses only the initial pointer focus ring and restores keyboard focus styling', async () => {
    setLanguageMode('ko');
    installLanguageSettingsDom();
    initSettings();

    const trigger = document.getElementById('btn-language-select')!;
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

    const active = document.querySelector<HTMLElement>('.language-option[data-lang="ko"]')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(active));
    expect(active.classList).toContain('language-option-initial-pointer-focus');

    active.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
    expect(active.classList).not.toContain('language-option-initial-pointer-focus');

    document.getElementById('btn-language-dialog-done')?.click();
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));

    await vi.waitFor(() =>
      expect(active.classList).toContain('language-option-initial-keyboard-focus'),
    );
    expect(document.activeElement).toBe(active);
    expect(active.classList).not.toContain('language-option-initial-pointer-focus');
  });

  it('preloads only the five self-hosted native names on pointer intent before opening', async () => {
    installLanguageSettingsDom();
    initSettings();
    const trigger = document.getElementById('btn-language-select')!;

    trigger.dispatchEvent(new Event('pointerdown'));

    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      false,
    );
    expect(preloadLocaleFontGlyphsMock.mock.calls).toEqual([
      ['ja', '日本語'],
      ['zh-hans', '简体中文'],
      ['zh-hant', '繁體中文'],
      ['ru', 'Русский'],
      ['th', 'ไทย'],
    ]);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    trigger.focus();
    trigger.click();

    expect(preloadLocaleFontGlyphsMock).toHaveBeenCalledTimes(5);
    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
  });

  it('preloads from keyboard focus without opening the dialog', () => {
    installLanguageSettingsDom();
    initSettings();

    document.getElementById('btn-language-select')?.focus();

    expect(preloadLocaleFontGlyphsMock).toHaveBeenCalledTimes(5);
    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      false,
    );
  });

  it('retries a false preload result on the next language-picker intent', async () => {
    preloadLocaleFontGlyphsMock.mockResolvedValue(false);
    installLanguageSettingsDom();
    initSettings();
    const trigger = document.getElementById('btn-language-select')!;

    trigger.dispatchEvent(new Event('pointerdown'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(preloadLocaleFontGlyphsMock).toHaveBeenCalledTimes(5);

    preloadLocaleFontGlyphsMock.mockResolvedValue(true);
    trigger.focus();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(preloadLocaleFontGlyphsMock).toHaveBeenCalledTimes(10);

    trigger.click();
    expect(preloadLocaleFontGlyphsMock).toHaveBeenCalledTimes(10);
  });

  it('keeps the dialog responsive when a glyph preload fails', async () => {
    preloadLocaleFontGlyphsMock.mockRejectedValue(new Error('offline'));
    installLanguageSettingsDom();
    initSettings();

    document.getElementById('btn-language-select')?.click();

    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(preloadLocaleFontGlyphsMock).toHaveBeenCalledTimes(5);
    });
  });

  it('switches between explicit selection and system language mode', () => {
    installLanguageSettingsDom();
    initSettings();

    document.getElementById('btn-language-select')?.click();
    document.querySelector<HTMLElement>('.language-option[data-lang="en"]')?.click();

    expect(localStorage.getItem('musixquare-lang')).toBe('en');
    expect(
      document
        .querySelector<HTMLElement>('.language-option[data-lang="en"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      document
        .querySelector<HTMLElement>('.language-option[data-lang="ko"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(document.getElementById('btn-language-select')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('btn-language-select')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
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
    expect(document.getElementById('btn-language-system')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.getElementById('btn-language-select')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('keeps the language dialog open when the backdrop is clicked', () => {
    installLanguageSettingsDom();
    initSettings();

    document.getElementById('btn-language-select')?.click();
    const overlay = document.getElementById('language-dialog-overlay')!;

    overlay.click();

    expect(overlay.classList.contains('show')).toBe(true);
  });

  it('restores focus to the language button when Done closes the dialog', () => {
    installLanguageSettingsDom();
    initSettings();

    const trigger = document.getElementById('btn-language-select') as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    document.getElementById('btn-language-dialog-done')?.click();

    expect(document.activeElement).toBe(trigger);
    expect(document.getElementById('language-dialog-overlay')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('reuses the language dialog from the setup greeting trigger', async () => {
    installLanguageSettingsDom();
    const setupTrigger = document.createElement('button');
    setupTrigger.dataset.setupLanguageTrigger = '';
    document.body.appendChild(setupTrigger);
    initSettings();

    setupTrigger.focus();
    openLanguageDialog(new MouseEvent('click', { detail: 1 }));
    expect(document.getElementById('language-dialog-overlay')?.classList.contains('show')).toBe(
      true,
    );
    const active = document.querySelector<HTMLElement>('.language-option.active')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(active));
    expect(active.classList).toContain('language-option-initial-pointer-focus');

    document.getElementById('btn-language-dialog-done')?.click();
    expect(document.activeElement).toBe(setupTrigger);
  });

  it('closes on Escape and restores focus to the language button', () => {
    installLanguageSettingsDom();
    initSettings();

    const trigger = document.getElementById('btn-language-select') as HTMLButtonElement;
    const overlay = document.getElementById('language-dialog-overlay')!;
    trigger.focus();
    trigger.click();
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(overlay.classList.contains('show')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('settings subtab scrollbar affordance', () => {
  it('reveals scrollbars in the settings surface after changing subtab', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `
        <section id="tab-settings">
          <button class="subtab-pill active" data-subtab="general" aria-pressed="true">General</button>
          <button class="subtab-pill" data-subtab="audio" aria-pressed="false">Audio</button>
          <div class="settings-subtab-panel active" data-panel="general"></div>
          <div class="settings-subtab-panel" data-panel="audio"></div>
        </section>
      `,
    );
    initSettings();
    const reveal = vi.fn();
    bus.on('ui:scrollbar-reveal', reveal);

    const general = document.querySelector<HTMLButtonElement>('[data-subtab="general"]');
    const audio = document.querySelector<HTMLButtonElement>('[data-subtab="audio"]');
    audio?.click();

    const settingsPanel = document.getElementById('tab-settings');
    expect(general?.classList.contains('active')).toBe(false);
    expect(general?.getAttribute('aria-pressed')).toBe('false');
    expect(audio?.classList.contains('active')).toBe(true);
    expect(audio?.getAttribute('aria-pressed')).toBe('true');
    expect(settingsPanel?.querySelector('[data-panel="audio"]')?.classList.contains('active')).toBe(
      true,
    );
    expect(reveal).toHaveBeenCalledWith(settingsPanel);
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

    expect(showToast).toHaveBeenCalledWith(
      'Settings sync is on.\nOnly room admins can change audio settings.',
    );
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

  it('fails closed when a delegated administrator projection lacks effects control', () => {
    installEffectSettingsDom();
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true } as DataConnection);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', [
      'media.add',
      'playback.control',
      'asset.upload',
      'members.manage',
    ]);
    initSettings();

    document.querySelector<HTMLElement>('#grid-reverb .ch-opt[data-rvb-type="arena"]')?.click();

    expect(showToast).toHaveBeenCalledWith(
      'Settings sync is on.\nOnly room admins can change audio settings.',
    );
    expect(document.getElementById('grid-reverb')?.classList.contains('host-ctrl-locked')).toBe(
      true,
    );
  });

  it('honors an explicitly projected PRO effects capability', () => {
    installEffectSettingsDom();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'coordinator-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['effects.control'],
    });
    initSettings();

    document.querySelector<HTMLElement>('#grid-reverb .ch-opt[data-rvb-type="arena"]')?.click();

    expect(showToast).not.toHaveBeenCalledWith('Only the room owner can change this.');
    const arena = document.querySelector<HTMLElement>(
      '#grid-reverb .ch-opt[data-rvb-type="arena"]',
    );
    const off = document.querySelector<HTMLElement>('#grid-reverb .ch-opt[data-rvb-type="off"]');
    expect(arena?.classList.contains('active')).toBe(true);
    expect(arena?.getAttribute('aria-pressed')).toBe('true');
    expect(off?.classList.contains('active')).toBe(false);
    expect(off?.getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById('grid-reverb')?.classList.contains('host-ctrl-locked')).toBe(
      false,
    );
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
    expect(
      document.querySelector('#grid-eq .ch-opt[data-eq-type="warm"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      document.querySelector('#grid-eq .ch-opt[data-eq-type="off"]')?.getAttribute('aria-pressed'),
    ).toBe('false');
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

  it('toggles bass, treble, and surround independently with pressed-state feedback', () => {
    installEffectSettingsDom();
    bus.on('audio:update-effect', (type, _param, value) => {
      if (type === 'vbass') setState('audio.virtualBass', value / 100);
      if (type === 'exciter') setState('audio.exciter', value > 0);
      if (type === 'stereo') setState('audio.stereoWidth', value / 100);
    });
    initSettings();

    const bass = document.querySelector<HTMLButtonElement>('[data-virtual-effect="bass"]')!;
    const treble = document.querySelector<HTMLButtonElement>('[data-virtual-effect="treble"]')!;
    const surround = document.querySelector<HTMLButtonElement>('[data-virtual-effect="surround"]')!;
    const off = document.querySelector<HTMLButtonElement>('[data-virtual-effect="off"]')!;

    bass.click();
    treble.click();
    surround.click();

    for (const button of [bass, treble, surround]) {
      expect(button.classList.contains('active')).toBe(true);
      expect(button.getAttribute('aria-pressed')).toBe('true');
    }
    expect(off.classList.contains('active')).toBe(false);
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(showToast).toHaveBeenNthCalledWith(1, t('toast.virtual_bass_on'));
    expect(showToast).toHaveBeenNthCalledWith(2, t('toast.virtual_treble_on'));
    expect(showToast).toHaveBeenNthCalledWith(3, t('toast.virtual_surround_on'));

    bass.click();

    expect(bass.classList.contains('active')).toBe(false);
    expect(bass.getAttribute('aria-pressed')).toBe('false');
    expect(treble.classList.contains('active')).toBe(true);
    expect(surround.classList.contains('active')).toBe(true);
    expect(showToast).toHaveBeenLastCalledWith(t('toast.virtual_bass_off'));
  });

  it('keeps per-effect feedback during system-audio sharing and its notice cooldown', () => {
    installEffectSettingsDom();
    setState('playback.mode', 'system-audio');
    setState('playback.activity', 'playing');
    bus.on('audio:update-effect', (type, _param, value) => {
      if (type === 'vbass') setState('audio.virtualBass', value / 100);
      if (type === 'exciter') setState('audio.exciter', value > 0);
    });
    vi.spyOn(Date, 'now').mockReturnValue(10_000_000_000);
    initSettings();

    document.querySelector<HTMLButtonElement>('[data-virtual-effect="bass"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-virtual-effect="treble"]')!.click();

    expect(showToast).toHaveBeenNthCalledWith(
      1,
      `${t('toast.virtual_bass_on')}\n${t('system_audio.effects_guest_only')}`,
    );
    expect(showToast).toHaveBeenNthCalledWith(2, t('toast.virtual_treble_on'));
  });

  it('turns every virtual effect off with one atomic event and one toast', () => {
    installEffectSettingsDom();
    setState('audio.virtualBass', 0.6);
    setState('audio.exciter', true);
    setState('audio.stereoWidth', 1.2);
    const setVirtualEffects = vi.fn();
    bus.on('audio:set-virtual-effects', setVirtualEffects);
    initSettings();

    const off = document.querySelector<HTMLButtonElement>('[data-virtual-effect="off"]')!;
    vi.mocked(showToast).mockClear();
    off.click();

    expect(setVirtualEffects).toHaveBeenCalledOnce();
    expect(setVirtualEffects).toHaveBeenCalledWith({
      bass: false,
      treble: false,
      surround: false,
    });
    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(t('toast.virtual_effects_off'));
    expect(off.classList.contains('active')).toBe(true);
    expect(off.getAttribute('aria-pressed')).toBe('true');
  });

  it('reflects remote virtual-effect sync without producing local action toasts', () => {
    installEffectSettingsDom();
    initSettings();
    vi.mocked(showToast).mockClear();

    setState('audio.virtualBass', 0.6);
    bus.emit('ui:sync-vbass', true);
    setState('audio.exciter', true);
    bus.emit('ui:sync-exciter', true);
    setState('audio.stereoWidth', 1.2);
    bus.emit('ui:sync-surround', true);

    expect(
      [...document.querySelectorAll<HTMLElement>('[data-virtual-effect]')].map((button) => [
        button.dataset.virtualEffect,
        button.getAttribute('aria-pressed'),
      ]),
    ).toEqual([
      ['bass', 'true'],
      ['treble', 'true'],
      ['surround', 'true'],
      ['off', 'false'],
    ]);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('UI sound preference', () => {
  it('starts off and persists opt-in while updating the active control', () => {
    installUiSoundsDom();
    initSettings();

    const on = document.querySelector<HTMLElement>('[data-ui-sounds="on"]')!;
    const off = document.querySelector<HTMLElement>('[data-ui-sounds="off"]')!;
    expect(off.classList.contains('active')).toBe(true);
    expect(on.classList.contains('active')).toBe(false);

    on.click();

    expect(localStorage.getItem('musixquare-ui-sounds-enabled')).toBe('1');
    expect(on.classList.contains('active')).toBe(true);
    expect(off.classList.contains('active')).toBe(false);
    expect(on.getAttribute('aria-pressed')).toBe('true');
  });
});
