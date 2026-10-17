/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import {
  __resetModalStackForTests,
  isAnyOverlayShown,
  offerBackToTopWindow,
  syncOverlayState,
  whenBackSurfaceSettled,
} from '../dom.ts';
import { openScreensaver } from '../screensaver.ts';
import { beginScreensaverEntry } from '../screensaver-entry.ts';
import { getFullscreenElement } from '../fullscreen.ts';

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
const originalFullscreen = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
const originalExitFullscreen = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
const prefixedDocumentProperties = [
  'webkitFullscreenElement',
  'webkitCurrentFullScreenElement',
  'webkitExitFullscreen',
  'webkitCancelFullScreen',
] as const;
const originalPrefixedProperties = new Map(
  prefixedDocumentProperties.map((property) => [
    property,
    Object.getOwnPropertyDescriptor(document, property),
  ]),
);

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

function fullscreenFixture(initial: Element | null = null, pending?: Promise<void>) {
  let current = initial;
  const change = (element: Element | null): void => {
    current = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  const request = vi.fn(() => {
    if (pending) return pending;
    change(document.documentElement);
    return Promise.resolve();
  });
  const exit = vi.fn(async () => change(null));
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: request,
  });
  return { request, exit, change };
}

function enableMotion(): void {
  vi.useFakeTimers();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
}

function prefixedFullscreenFixture(
  initial: Element | null = null,
  stateProperty:
    'webkitFullscreenElement' | 'webkitCurrentFullScreenElement' = 'webkitFullscreenElement',
  requestProperty:
    'webkitRequestFullscreen' | 'webkitRequestFullScreen' = 'webkitRequestFullscreen',
  exitProperty: 'webkitExitFullscreen' | 'webkitCancelFullScreen' = 'webkitExitFullscreen',
) {
  let current = initial;
  const change = (element: Element | null): void => {
    current = element;
    document.dispatchEvent(new Event('webkitfullscreenchange'));
  };
  const request = vi.fn<() => Promise<void> | void>(() => change(document.documentElement));
  const exit = vi.fn<() => Promise<void> | void>(() => change(null));
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
  Object.defineProperty(document, stateProperty, { configurable: true, get: () => current });
  Object.defineProperty(document, exitProperty, { configurable: true, value: exit });
  Object.defineProperty(document.documentElement, requestProperty, {
    configurable: true,
    value: request,
  });
  return { request, exit, change };
}

beforeEach(() => {
  bus.clear();
  resetState();
  clearAllManagedTimers();
  localStorage.clear();
  mocks.showToast.mockReset();
  mocks.language = 'en';
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
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

afterEach(async () => {
  if (overlay()) {
    setState('setup.sessionStarted', false);
  }
  document.dispatchEvent(new Event('webkitfullscreenerror'));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  __resetModalStackForTests();
  clearAllManagedTimers();
  bus.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  Reflect.deleteProperty(document.documentElement, 'webkitRequestFullscreen');
  Reflect.deleteProperty(document.documentElement, 'webkitRequestFullScreen');
  for (const [property, descriptor] of originalPrefixedProperties) {
    if (descriptor) Object.defineProperty(document, property, descriptor);
    else Reflect.deleteProperty(document, property);
  }
  if (originalFullscreen) Object.defineProperty(document, 'fullscreenElement', originalFullscreen);
  else Reflect.deleteProperty(document, 'fullscreenElement');
  if (originalExitFullscreen)
    Object.defineProperty(document, 'exitFullscreen', originalExitFullscreen);
  else Reflect.deleteProperty(document, 'exitFullscreen');
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
          title: 'Midnight',
          subtitle: 'MP3 · 320 kbps',
          lang: 'ar',
          dir: 'rtl',
        }),
      },
      window.location.origin,
    );
  });
});

describe('screensaver lifecycle', () => {
  it.each(['webkitFullscreenElement', 'webkitCurrentFullScreenElement'] as const)(
    'preserves an existing prefixed root fullscreen from %s',
    (property) => {
      const fullscreen = prefixedFullscreenFixture(document.documentElement, property);
      openFrame();
      escape();
      expect(fullscreen.request).not.toHaveBeenCalled();
      expect(fullscreen.exit).not.toHaveBeenCalled();
      expect(getFullscreenElement()).toBe(document.documentElement);
    },
  );

  it.each([
    ['webkitFullscreenElement', 'webkitRequestFullscreen', 'webkitExitFullscreen'],
    ['webkitCurrentFullScreenElement', 'webkitRequestFullScreen', 'webkitCancelFullScreen'],
  ] as const)('enters and restores prefixed fullscreen with %s', (state, request, exit) => {
    const fullscreen = prefixedFullscreenFixture(null, state, request, exit);
    openFrame();
    expect(fullscreen.request).toHaveBeenCalledOnce();
    expect(getFullscreenElement()).toBe(document.documentElement);
    escape();
    expect(fullscreen.exit).toHaveBeenCalledOnce();
    expect(getFullscreenElement()).toBeNull();
  });

  it('preserves a prefixed fullscreen subtree and restores its centered dialog on WebKit exit', () => {
    const shell = document.getElementById('app-shell')!;
    const fullscreen = prefixedFullscreenFixture(shell, 'webkitCurrentFullScreenElement');
    openFrame();
    expect(overlay()?.parentElement).toBe(shell);
    expect(overlay()?.closest('[inert]')).toBeNull();
    const dialog = document.getElementById('dialog-overlay')!;
    dialog.classList.add('show');
    syncOverlayState('dialog-overlay');
    expect(dialog.parentElement).toBe(shell);
    fullscreen.change(null);
    expect(overlay()).toBeNull();
    expect(dialog.parentElement).toBe(document.body);
    expect(fullscreen.request).not.toHaveBeenCalled();
    expect(fullscreen.exit).not.toHaveBeenCalled();
  });

  it('restores a void WebKit request that completes asynchronously after close', async () => {
    const fullscreen = prefixedFullscreenFixture();
    fullscreen.request.mockImplementationOnce(() => {});
    openFrame();
    escape();
    await Promise.resolve();
    expect(overlay()).toBeNull();
    expect(beginScreensaverEntry()).toBeNull();
    fullscreen.change(document.documentElement);
    expect(fullscreen.exit).toHaveBeenCalledOnce();
    expect(getFullscreenElement()).toBeNull();
    const retry = beginScreensaverEntry();
    expect(retry).not.toBeNull();
    retry?.release();
  });

  it('waits for a void WebKit exit event before releasing the entry lock', async () => {
    const fullscreen = prefixedFullscreenFixture();
    fullscreen.exit.mockImplementationOnce(() => {});
    openFrame();
    escape();
    await Promise.resolve();
    expect(beginScreensaverEntry()).toBeNull();
    fullscreen.change(null);
    const retry = beginScreensaverEntry();
    expect(retry).not.toBeNull();
    retry?.release();
  });

  it('bounds silent WebKit failure and cleans its pending timers on cancellation', async () => {
    vi.useFakeTimers();
    const fullscreen = prefixedFullscreenFixture();
    fullscreen.request.mockImplementationOnce(() => {});
    const removeListener = vi.spyOn(document, 'removeEventListener');
    openFrame();
    escape();
    expect(beginScreensaverEntry()).toBeNull();
    await vi.advanceTimersByTimeAsync(1500);
    expect(removeListener).toHaveBeenCalledWith('webkitfullscreenchange', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('webkitfullscreenerror', expect.any(Function));
    const retry = beginScreensaverEntry();
    expect(retry).not.toBeNull();
    retry?.release();
    expect(fullscreen.exit).toHaveBeenCalledOnce();
  });

  it('recovers from a prefixed request rejection without closing the overlay', async () => {
    const fullscreen = prefixedFullscreenFixture();
    fullscreen.request.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    openFrame();
    await Promise.resolve();
    expect(overlay()).not.toBeNull();
    escape();
    expect(fullscreen.exit).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });

  it('falls through a rejected standard request to an available prefixed API', async () => {
    const fullscreen = prefixedFullscreenFixture();
    const standard = vi
      .fn()
      .mockRejectedValue(new DOMException('Unavailable', 'NotSupportedError'));
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: standard,
    });
    openFrame();
    await Promise.resolve();
    expect(standard).toHaveBeenCalledOnce();
    expect(fullscreen.request).toHaveBeenCalledOnce();
    escape();
    expect(fullscreen.exit).toHaveBeenCalledOnce();
  });

  it('clears a cancelled pending WebKit request on its native error event', () => {
    const fullscreen = prefixedFullscreenFixture();
    fullscreen.request.mockImplementationOnce(() => {});
    openFrame();
    escape();
    document.dispatchEvent(new Event('webkitfullscreenerror'));
    const retry = beginScreensaverEntry();
    expect(retry).not.toBeNull();
    retry?.release();
  });

  it('ignores a queued standard error while the WebKit fallback or its exit is pending', async () => {
    const fullscreen = prefixedFullscreenFixture();
    fullscreen.request.mockImplementationOnce(() => {});
    fullscreen.exit.mockImplementationOnce(() => {});
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new DOMException('Unavailable', 'NotSupportedError')),
    });
    openFrame();
    await Promise.resolve();
    expect(fullscreen.request).toHaveBeenCalledOnce();
    escape();
    document.dispatchEvent(new Event('fullscreenerror'));
    expect(beginScreensaverEntry()).toBeNull();
    fullscreen.change(document.documentElement);
    expect(fullscreen.exit).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event('fullscreenerror'));
    expect(beginScreensaverEntry()).toBeNull();
    fullscreen.change(null);
    const retry = beginScreensaverEntry();
    expect(retry).not.toBeNull();
    retry?.release();
    await Promise.resolve();
  });

  it('requests fullscreen immediately and exits only the state it acquired', async () => {
    const fullscreen = fullscreenFixture();
    openFrame();
    expect(fullscreen.request).toHaveBeenCalledOnce();
    await Promise.resolve();
    escape();
    expect(fullscreen.exit).toHaveBeenCalledOnce();
  });

  it('preserves fullscreen that was already active', () => {
    const fullscreen = fullscreenFixture(document.documentElement);
    openFrame();
    escape();
    expect(fullscreen.request).not.toHaveBeenCalled();
    expect(fullscreen.exit).not.toHaveBeenCalled();
    expect(document.fullscreenElement).toBe(document.documentElement);
  });

  it('restores a late fullscreen success after the screensaver was already closed', async () => {
    let resolveRequest: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const fullscreen = fullscreenFixture(null, pending);
    openFrame();
    escape();
    expect(overlay()).toBeNull();
    expect(fullscreen.exit).not.toHaveBeenCalled();
    openScreensaver();
    expect(fullscreen.request).toHaveBeenCalledOnce();
    fullscreen.change(document.documentElement);
    resolveRequest();
    await vi.waitFor(() => expect(fullscreen.exit).toHaveBeenCalledOnce());
    expect(document.fullscreenElement).toBeNull();
  });

  it('keeps a functional overlay when the fullscreen request is rejected', async () => {
    const fullscreen = fullscreenFixture();
    fullscreen.request.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    openFrame();
    await Promise.resolve();
    expect(overlay()).not.toBeNull();
    escape();
    expect(overlay()).toBeNull();
    expect(fullscreen.exit).not.toHaveBeenCalled();
  });

  it('closes after the user leaves fullscreen without issuing another exit', () => {
    const fullscreen = fullscreenFixture();
    openFrame();
    fullscreen.change(null);
    expect(overlay()).toBeNull();
    expect(fullscreen.exit).not.toHaveBeenCalled();
  });

  it('mounts inside existing fullscreen and restores nested inert ownership after higher dialogs', () => {
    const shell = document.getElementById('app-shell')!;
    const fullscreen = fullscreenFixture(shell);
    const frame = openFrame();
    expect(overlay()?.parentElement).toBe(shell);
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(document.getElementById('chat-input')?.hasAttribute('inert')).toBe(true);
    const dialog = document.getElementById('dialog-overlay')!;
    const action = document.getElementById('dialog-action')!;
    dialog.classList.add('show');
    syncOverlayState('dialog-overlay');
    expect(dialog.parentElement).toBe(shell);
    action.focus();
    ready(frame);
    expect(document.activeElement).toBe(action);
    expect(escape().defaultPrevented).toBe(false);
    expect(overlay()).not.toBeNull();
    dialog.classList.remove('show');
    syncOverlayState();
    expect(dialog.parentElement).toBe(document.body);
    escape();
    expect(fullscreen.exit).not.toHaveBeenCalled();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(document.activeElement?.id).toBe('chat-input');
  });

  it('restores a portaled dialog after fullscreen ends even if the screensaver already closed', () => {
    const shell = document.getElementById('app-shell')!;
    const fullscreen = fullscreenFixture(shell);
    openFrame();
    const dialog = document.getElementById('dialog-overlay')!;
    const marker = document.createElement('aside');
    dialog.after(marker);
    dialog.classList.add('show');
    syncOverlayState('dialog-overlay');
    expect(dialog.parentElement).toBe(shell);
    setState('playback.mode', 'youtube');
    expect(overlay()).toBeNull();
    expect(dialog.parentElement).toBe(shell);
    fullscreen.change(null);
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.nextSibling).toBe(marker);
    expect(dialog.closest('[inert]')).toBeNull();
  });

  it('does not resurrect a portaled dialog that its own cleanup removed', () => {
    const shell = document.getElementById('app-shell')!;
    fullscreenFixture(shell);
    openFrame();
    const dialog = document.getElementById('dialog-overlay')!;
    dialog.classList.add('show');
    syncOverlayState('dialog-overlay');
    expect(dialog.parentElement).toBe(shell);
    dialog.remove();
    syncOverlayState();
    expect(document.getElementById('dialog-overlay')).toBeNull();
    expect(overlay()?.closest('[inert]')).toBeNull();
  });

  it('restores a dialog stranded in a fullscreen container that was removed', () => {
    const shell = document.getElementById('app-shell')!;
    const fullscreen = fullscreenFixture(shell);
    openFrame();
    const dialog = document.getElementById('dialog-overlay')!;
    dialog.classList.add('show');
    syncOverlayState('dialog-overlay');
    shell.remove();
    fullscreen.change(null);
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.isConnected).toBe(true);
    dialog.classList.remove('show');
    syncOverlayState();
  });

  it('releases a second fullscreen entry attempted while a manual-exit fade is still closing', async () => {
    enableMotion();
    const fullscreen = fullscreenFixture();
    openFrame();
    await vi.advanceTimersByTimeAsync(16);
    fullscreen.change(null);
    expect(overlay()).not.toBeNull();
    const second = beginScreensaverEntry();
    expect(second).not.toBeNull();
    openScreensaver(second!);
    await vi.advanceTimersByTimeAsync(500);
    expect(overlay()).toBeNull();
    expect(document.fullscreenElement).toBeNull();
    expect(fullscreen.exit).toHaveBeenCalledOnce();
    expect(second!.closed).toBe(true);
  });

  it('fades in and keeps its modal until the bounded exit transition completes', async () => {
    enableMotion();
    const frame = openFrame();
    expect(overlay()?.style.opacity).toBe('0');
    await vi.advanceTimersByTimeAsync(16);
    expect(overlay()?.style.opacity).toBe('1');
    ready(frame);
    fromFrame(frame, { type: 'mxqr:screensaver:close' });
    expect(overlay()?.style.opacity).toBe('0');
    expect(document.getElementById('app-shell')?.hasAttribute('inert')).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(overlay()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(overlay()).toBeNull();
    expect(getManagedTimer('screensaver-close')).toBeNull();
  });

  it.each(['transition', 'fallback'] as const)(
    'keeps repeated Back on the same closing frame until its %s completes',
    async (completion) => {
      enableMotion();
      openFrame();
      await vi.advanceTimersByTimeAsync(16);
      const closingOverlay = overlay()!;
      const first = offerBackToTopWindow();
      const firstSettled = vi.fn();
      const observation = first.settled.then(firstSettled);
      expect(first.handled).toBe(true);
      expect(offerBackToTopWindow().handled).toBe(true);
      await vi.advanceTimersByTimeAsync(420);
      expect(overlay()).toBe(closingOverlay);
      expect(firstSettled).not.toHaveBeenCalled();

      if (completion === 'transition') {
        const event = new Event('transitionend');
        Object.defineProperty(event, 'propertyName', { value: 'opacity' });
        closingOverlay.dispatchEvent(event);
      } else {
        await vi.advanceTimersByTimeAsync(80);
      }
      await observation;
      expect(firstSettled).toHaveBeenCalledOnce();
      expect(overlay()).toBeNull();
    },
  );

  it('exposes an explicit close completion and settles it on immediate session teardown', async () => {
    enableMotion();
    openFrame();
    await vi.advanceTimersByTimeAsync(16);
    overlay()!.querySelector<HTMLButtonElement>('button')!.click();
    const settled = whenBackSurfaceSettled();
    const observed = vi.fn();
    const observation = settled.then(observed);
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    setState('setup.sessionStarted', false);
    await observation;
    expect(overlay()).toBeNull();
  });

  it('removes the covering frame immediately if YouTube takes over during the exit fade', async () => {
    enableMotion();
    openFrame();
    await vi.advanceTimersByTimeAsync(16);
    escape();
    expect(overlay()).not.toBeNull();
    setState('playback.mode', 'youtube');
    expect(overlay()).toBeNull();
    expect(getManagedTimer('screensaver-close')).toBeNull();
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith('en:toast.screensaver_youtube');
  });

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
});
