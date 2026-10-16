/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { __resetModalStackForTests, isAnyOverlayShown, syncOverlayState } from '../dom.ts';
import { openScreensaver } from '../screensaver.ts';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  language: 'en' as 'en' | 'ar',
}));

vi.mock('../toast.ts', () => ({ showToast: mocks.showToast }));
vi.mock('../../i18n/index.ts', () => ({
  getResolvedLanguage: () => mocks.language,
  t: (key: string) => `${mocks.language}:${key}`,
}));

const MUSIC_PREFERENCE_KEY = 'mxqr:screensaver:music';

function overlay(): HTMLElement | null {
  return document.getElementById('screensaver-overlay');
}

function openFrame(): HTMLIFrameElement {
  openScreensaver();
  return document.querySelector<HTMLIFrameElement>('#screensaver-overlay iframe')!;
}

function fromFrame(
  frame: HTMLIFrameElement,
  data: unknown,
  origin = window.location.origin,
  source: MessageEventSource | null = frame.contentWindow,
): void {
  window.dispatchEvent(new MessageEvent('message', { origin, source, data }));
}

function ready(frame: HTMLIFrameElement): void {
  fromFrame(frame, { type: 'mxqr:screensaver:ready' });
}

function escape(options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...options,
  });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  bus.clear();
  resetState();
  clearAllManagedTimers();
  localStorage.clear();
  mocks.showToast.mockReset();
  mocks.language = 'en';
  document.body.className = '';
  document.body.innerHTML = `
    <main id="app-shell">
      <input id="chat-input" />
      <span id="track-artist">MP3 · 320 kbps</span>
    </main>
    <div id="dialog-overlay"><button id="dialog-action">OK</button></div>
  `;
  __resetModalStackForTests();
  setState('setup.sessionStarted', true);
  setState('playback.mode', 'file');
  setState('player.currentTrackMeta', { type: 'file', name: 'Midnight.mp3' });
  document.getElementById('chat-input')!.focus();
});

afterEach(() => {
  if (overlay()) {
    setState('setup.sessionStarted', false);
  }
  __resetModalStackForTests();
  clearAllManagedTimers();
  bus.clear();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('screensaver host playback boundary', () => {
  it.each(['mode', 'metadata'] as const)('blocks YouTube selected through %s', (path) => {
    if (path === 'mode') setState('playback.mode', 'youtube');
    else setState('player.currentTrackMeta', { type: 'youtube', title: 'Video' });

    openScreensaver();

    expect(overlay()).toBeNull();
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith('en:toast.screensaver_youtube');
    expect(bus.debug()).toEqual({});
  });

  it.each(['mode', 'metadata'] as const)(
    'closes immediately and emits one restriction toast when %s becomes YouTube',
    (path) => {
      const frame = openFrame();
      ready(frame);
      if (path === 'mode') setState('playback.mode', 'youtube');
      else setState('player.currentTrackMeta', { type: 'youtube', title: 'Video' });

      expect(overlay()).toBeNull();
      expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith('en:toast.screensaver_youtube');
      expect(document.activeElement?.id).toBe('chat-input');
      expect(bus.debug()).toEqual({});
      setState('playback.mode', 'youtube');
      setState('player.currentTrackMeta', { type: 'youtube', title: 'Next video' });
      expect(mocks.showToast).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a late ready message after YouTube takes over before the frame loads', () => {
    const frame = openFrame();
    const source = frame.contentWindow;
    const postMessage = vi.spyOn(source!, 'postMessage');
    setState('playback.mode', 'youtube');

    fromFrame(frame, { type: 'mxqr:screensaver:ready' }, window.location.origin, source);

    expect(overlay()).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });

  it('keeps file and system-audio playback state intact while opening and closing', () => {
    const file = getState('player.currentTrackMeta');
    openScreensaver();
    escape();
    expect(getState('player.currentTrackMeta')).toBe(file);
    expect(getState('playback.mode')).toBe('file');

    const system = {
      type: 'file' as const,
      name: 'system-audio-receiving',
      systemAudioMode: 'receiving' as const,
      systemAudioSurface: 'browser' as const,
    };
    setState('player.currentTrackMeta', system);
    const frame = openFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    document.getElementById('track-artist')!.textContent = '';
    ready(frame);

    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'mxqr:screensaver:update',
        payload: expect.objectContaining({
          title: 'Receiving system audio',
          subtitle: '≤256 kbps · BROWSER',
        }),
      },
      window.location.origin,
    );
    fromFrame(frame, { type: 'mxqr:screensaver:close' });
    expect(getState('player.currentTrackMeta')).toBe(system);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});

describe('screensaver frame bridge', () => {
  it('creates one registered modal and waits for a trusted readiness handshake', () => {
    const frame = openFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    openScreensaver();

    expect(document.querySelectorAll('#screensaver-overlay')).toHaveLength(1);
    expect(frame.getAttribute('src')).toBe('/screensaver.html');
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    );
    expect(frame.allow).toContain('geolocation');
    expect(isAnyOverlayShown()).toBe(true);
    expect(document.body.classList.contains('overlay-open')).toBe(true);
    expect(document.getElementById('app-shell')!.hasAttribute('inert')).toBe(true);
    expect(overlay()?.getAttribute('aria-modal')).toBe('true');
    expect(overlay()?.contains(document.activeElement)).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();

    ready(frame);

    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'mxqr:screensaver:update',
        payload: {
          backLabel: 'en:screensaver.back',
          musicLabel: 'en:screensaver.show_music',
          showMusic: true,
          title: 'Midnight',
          subtitle: 'MP3 · 320 kbps',
          lang: 'en',
          dir: 'ltr',
        },
      },
      window.location.origin,
    );
    expect(overlay()?.querySelector('button')?.hidden).toBe(true);
    expect(document.activeElement).toBe(frame);
  });

  it.each(['origin', 'source'] as const)('rejects messages with an untrusted %s', (invalid) => {
    const frame = openFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    const origin = invalid === 'origin' ? 'https://untrusted.example' : window.location.origin;
    const source = invalid === 'source' ? window : frame.contentWindow;
    for (const data of [
      { type: 'mxqr:screensaver:ready' },
      { type: 'mxqr:screensaver:music-toggle', enabled: false },
      { type: 'mxqr:screensaver:close' },
    ]) {
      fromFrame(frame, data, origin, source);
    }

    expect(postMessage).not.toHaveBeenCalled();
    expect(overlay()).not.toBeNull();
    expect(localStorage.getItem(MUSIC_PREFERENCE_KEY)).toBeNull();
    ready(frame);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed payloads and non-boolean preference values', () => {
    const frame = openFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    ready(frame);
    for (const data of [
      null,
      'mxqr:screensaver:close',
      {},
      { type: 'unrecognized' },
      { type: 'mxqr:screensaver:music-toggle', enabled: 'false' },
      { type: 'mxqr:screensaver:music-toggle', enabled: 0 },
    ]) {
      fromFrame(frame, data);
    }
    expect(overlay()).not.toBeNull();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(MUSIC_PREFERENCE_KEY)).toBeNull();
  });

  it('uses live track display copy and reacts when its actual subtitle changes', async () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'different-file.flac',
      title: 'Actual track title',
    });
    const frame = openFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    ready(frame);
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'mxqr:screensaver:update',
        payload: expect.objectContaining({
          title: 'Actual track title',
          subtitle: 'MP3 · 320 kbps',
        }),
      },
      window.location.origin,
    );
    document.getElementById('track-artist')!.textContent = '  FLAC · 24 bit / 96 kHz  ';
    await Promise.resolve();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'mxqr:screensaver:update',
        payload: expect.objectContaining({ subtitle: 'FLAC · 24 bit / 96 kHz' }),
      },
      window.location.origin,
    );
    const count = postMessage.mock.calls.length;
    bus.emit('audio:ready');
    expect(postMessage).toHaveBeenCalledTimes(count);

    setState('player.currentTrackMeta', null);
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'mxqr:screensaver:update',
        payload: expect.objectContaining({ title: '', subtitle: '' }),
      },
      window.location.origin,
    );
  });

  it('updates control translations and direction without translating track information', () => {
    const frame = openFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    ready(frame);
    mocks.language = 'ar';
    bus.emit('i18n:changed', 'ar');

    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'mxqr:screensaver:update',
        payload: expect.objectContaining({
          backLabel: 'ar:screensaver.back',
          musicLabel: 'ar:screensaver.show_music',
          title: 'Midnight',
          subtitle: 'MP3 · 320 kbps',
          lang: 'ar',
          dir: 'rtl',
        }),
      },
      window.location.origin,
    );
  });

  it('persists a valid music toggle across closing and reopening', () => {
    const frame = openFrame();
    ready(frame);
    fromFrame(frame, { type: 'mxqr:screensaver:music-toggle', enabled: false });
    expect(localStorage.getItem(MUSIC_PREFERENCE_KEY)).toBe('off');
    escape();

    const reopened = openFrame();
    const postMessage = vi.spyOn(reopened.contentWindow!, 'postMessage');
    ready(reopened);
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'mxqr:screensaver:update',
        payload: expect.objectContaining({ showMusic: false }),
      },
      window.location.origin,
    );
    fromFrame(reopened, { type: 'mxqr:screensaver:music-toggle', enabled: true });
    expect(localStorage.getItem(MUSIC_PREFERENCE_KEY)).toBe('on');
  });

  it('works when preference storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    const frame = openFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    ready(frame);
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'mxqr:screensaver:update',
        payload: expect.objectContaining({ showMusic: true }),
      },
      window.location.origin,
    );
    expect(() =>
      fromFrame(frame, { type: 'mxqr:screensaver:music-toggle', enabled: false }),
    ).not.toThrow();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'mxqr:screensaver:update',
        payload: expect.objectContaining({ showMusic: false }),
      },
      window.location.origin,
    );
  });
});

describe('screensaver lifecycle', () => {
  it.each(['escape', 'back', 'bridge', 'session'] as const)(
    'cleans up listeners, the frame, and modal focus after closing through %s',
    async (method) => {
      const frame = openFrame();
      const source = frame.contentWindow;
      const postMessage = vi.spyOn(source!, 'postMessage');
      ready(frame);
      postMessage.mockClear();
      expect(Object.keys(bus.debug()).length).toBeGreaterThan(0);

      if (method === 'escape') expect(escape().defaultPrevented).toBe(true);
      else if (method === 'back') overlay()!.querySelector<HTMLButtonElement>('button')!.click();
      else if (method === 'bridge') fromFrame(frame, { type: 'mxqr:screensaver:close' });
      else setState('setup.sessionStarted', false);

      expect(overlay()).toBeNull();
      expect(isAnyOverlayShown()).toBe(false);
      expect(document.body.classList.contains('overlay-open')).toBe(false);
      expect(document.getElementById('app-shell')!.hasAttribute('inert')).toBe(false);
      expect(document.activeElement?.id).toBe('chat-input');
      expect(bus.debug()).toEqual({});
      expect(escape().defaultPrevented).toBe(false);
      document.getElementById('track-artist')!.textContent = 'Later subtitle';
      bus.emit('audio:ready');
      fromFrame(frame, { type: 'mxqr:screensaver:ready' }, window.location.origin, source);
      await Promise.resolve();
      expect(postMessage).not.toHaveBeenCalled();
    },
  );

  it('keeps keyboard focus inside its loading UI and ignores IME Escape', () => {
    openFrame();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(overlay()?.querySelector('button'));
    expect(escape({ isComposing: true }).defaultPrevented).toBe(false);
    expect(overlay()).not.toBeNull();
  });

  it('yields interaction and focus to a dialog opened above the screensaver', () => {
    const frame = openFrame();
    const dialog = document.getElementById('dialog-overlay')!;
    const action = document.getElementById('dialog-action')!;
    dialog.classList.add('show');
    syncOverlayState('dialog-overlay');
    action.focus();
    expect(overlay()?.hasAttribute('inert')).toBe(true);

    ready(frame);
    fromFrame(frame, { type: 'mxqr:screensaver:music-toggle', enabled: false });
    fromFrame(frame, { type: 'mxqr:screensaver:close' });
    expect(escape().defaultPrevented).toBe(false);
    expect(overlay()).not.toBeNull();
    expect(localStorage.getItem(MUSIC_PREFERENCE_KEY)).toBeNull();
    expect(document.activeElement).toBe(action);

    setState('playback.mode', 'youtube');
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(action);
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith('en:toast.screensaver_youtube');
  });

  it('exits only fullscreen owned by the screensaver when removing its iframe', () => {
    const frame = openFrame();
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const previousFullscreen = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    const previousExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
    const fullscreen = vi.fn((): Element => frame);
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: fullscreen });
    try {
      escape();
      expect(exitFullscreen).toHaveBeenCalledOnce();

      fullscreen.mockReturnValue(document.documentElement);
      openFrame();
      escape();
      expect(exitFullscreen).toHaveBeenCalledOnce();
    } finally {
      if (previousFullscreen)
        Object.defineProperty(document, 'fullscreenElement', previousFullscreen);
      else Reflect.deleteProperty(document, 'fullscreenElement');
      if (previousExit) Object.defineProperty(document, 'exitFullscreen', previousExit);
      else Reflect.deleteProperty(document, 'exitFullscreen');
    }
  });
});
