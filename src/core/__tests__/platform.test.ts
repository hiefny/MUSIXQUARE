/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// platform.ts reads navigator.userAgent at import time, so each case installs
// its browser inputs before dynamically importing a reset module.

interface VisualViewportStub {
  width: number;
  height: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatch(type: 'resize' | 'scroll'): void;
  setMediaLandscape(value: boolean): void;
}

function installIOSStandaloneViewport(options: {
  innerWidth: number;
  innerHeight: number;
  visualWidth?: number;
  visualHeight?: number;
  mediaLandscape?: boolean;
  screenHeight?: number;
}): VisualViewportStub {
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X)',
    configurable: true,
  });
  Object.defineProperty(navigator, 'platform', { value: 'iPhone', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
  Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  Object.defineProperty(window, 'innerWidth', {
    value: options.innerWidth,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: options.innerHeight,
    configurable: true,
  });
  Object.defineProperty(window.screen, 'height', {
    value: options.screenHeight ?? Math.max(options.innerWidth, options.innerHeight),
    configurable: true,
  });

  const viewportListeners = new Map<string, EventListenerOrEventListenerObject[]>();
  let mediaLandscape = options.mediaLandscape ?? options.innerWidth > options.innerHeight;
  const visualViewport: VisualViewportStub = {
    width: options.visualWidth ?? options.innerWidth,
    height: options.visualHeight ?? options.innerHeight,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const listeners = viewportListeners.get(type) ?? [];
      listeners.push(listener);
      viewportListeners.set(type, listeners);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const listeners = viewportListeners.get(type) ?? [];
      viewportListeners.set(
        type,
        listeners.filter((candidate) => candidate !== listener),
      );
    }),
    dispatch(type) {
      const event = new Event(type);
      for (const listener of viewportListeners.get(type) ?? []) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
    setMediaLandscape(value) {
      mediaLandscape = value;
    },
  };
  Object.defineProperty(window, 'visualViewport', {
    value: visualViewport,
    configurable: true,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches:
        query === '(display-mode: standalone)'
          ? true
          : query === '(orientation: landscape)'
            ? mediaLandscape
            : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  return visualViewport;
}

afterEach(async () => {
  try {
    const { platformViewportForTests } = await import('../platform.ts');
    platformViewportForTests.reset();
  } catch {
    /* noop */
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
  document.body.replaceChildren();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
});

describe('Platform Detection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.body.style.removeProperty('--desktop-ui-scale');
  });

  describe('body rendered scale', () => {
    it('converts both large-screen density tiers back to body-local CSS pixels', async () => {
      const { getBodyRenderedScale, viewportLengthToBodyCssPixels } =
        await import('../platform.ts');

      document.body.style.setProperty('--desktop-ui-scale', '1.2');
      expect(getBodyRenderedScale()).toBe(1.2);
      expect(viewportLengthToBodyCssPixels(120)).toBeCloseTo(100);

      document.body.style.setProperty('--desktop-ui-scale', '1.5');
      expect(getBodyRenderedScale()).toBe(1.5);
      expect(viewportLengthToBodyCssPixels(150)).toBeCloseTo(100);
    });

    it('falls back to an identity scale for absent or invalid values', async () => {
      const { getBodyRenderedScale, viewportLengthToBodyCssPixels } =
        await import('../platform.ts');

      expect(getBodyRenderedScale()).toBe(1);
      document.body.style.setProperty('--desktop-ui-scale', '0');
      expect(getBodyRenderedScale()).toBe(1);
      expect(viewportLengthToBodyCssPixels(75)).toBe(75);
    });
  });

  describe('IS_IOS', () => {
    it('detects iPhone userAgent as iOS', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        configurable: true,
      });
      const { IS_IOS, getDevicePlatform } = await import('../platform.ts');
      expect(IS_IOS).toBe(true);
      expect(getDevicePlatform()).toBe('ios');
    });

    it('cancels every Safari page-zoom gesture with non-passive listeners', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)',
        configurable: true,
      });
      vi.useFakeTimers();
      const addEventListener = vi.spyOn(document, 'addEventListener');

      try {
        const { initPlatform } = await import('../platform.ts');
        initPlatform();

        const gestureCalls = addEventListener.mock.calls.filter(([eventName]) =>
          String(eventName).startsWith('gesture'),
        );

        expect(gestureCalls.map(([eventName, _listener, options]) => [eventName, options])).toEqual(
          [
            ['gesturestart', { passive: false }],
            ['gesturechange', { passive: false }],
            ['gestureend', { passive: false }],
          ],
        );

        for (const [, listener] of gestureCalls) {
          const preventDefault = vi.fn();
          (listener as EventListener)({ preventDefault } as unknown as Event);
          expect(preventDefault).toHaveBeenCalledOnce();
        }
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it('detects iPad userAgent as iOS', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
        configurable: true,
      });
      const { IS_IOS } = await import('../platform.ts');
      expect(IS_IOS).toBe(true);
    });

    it('detects iPad Pro (MacIntel + touch) as iOS', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        configurable: true,
      });
      const { IS_IOS } = await import('../platform.ts');
      expect(IS_IOS).toBe(true);
    });

    it('does not flag desktop Chrome as iOS', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        configurable: true,
      });
      const { IS_IOS } = await import('../platform.ts');
      expect(IS_IOS).toBe(false);
    });
  });

  describe('IS_ANDROID', () => {
    it('detects Android userAgent', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120',
        configurable: true,
      });
      const { IS_ANDROID, getDevicePlatform } = await import('../platform.ts');
      expect(IS_ANDROID).toBe(true);
      expect(getDevicePlatform()).toBe('android');
    });

    it('does not flag iOS as Android', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        configurable: true,
      });
      const { IS_ANDROID } = await import('../platform.ts');
      expect(IS_ANDROID).toBe(false);
    });
  });

  describe('IS_WINDOWS', () => {
    it('detects Windows userAgent as Windows', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });
      const { IS_WINDOWS, getDevicePlatform } = await import('../platform.ts');
      expect(IS_WINDOWS).toBe(true);
      expect(getDevicePlatform()).toBe('windows');
    });

    it('does not flag Android as Windows', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux armv8l',
        configurable: true,
      });
      const { IS_WINDOWS } = await import('../platform.ts');
      expect(IS_WINDOWS).toBe(false);
    });
  });

  describe('coarse device platform', () => {
    it('accepts only the six room-visible platform categories', async () => {
      const { normalizeDevicePlatform } = await import('../platform.ts');
      for (const platform of ['ios', 'android', 'windows', 'macos', 'linux', 'other'] as const) {
        expect(normalizeDevicePlatform(platform)).toBe(platform);
      }
      expect(normalizeDevicePlatform('IOS')).toBe('other');
      expect(normalizeDevicePlatform(' ios ')).toBe('other');
      expect(normalizeDevicePlatform({ platform: 'ios' })).toBe('other');
      expect(normalizeDevicePlatform(null)).toBe('other');
    });

    it('reports macOS without exposing a raw user agent', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
      const { getDevicePlatform } = await import('../platform.ts');
      expect(getDevicePlatform()).toBe('macos');
    });

    it('reports Linux and falls back to other for unknown platforms', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (X11; Linux x86_64)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
      let platform = await import('../platform.ts');
      expect(platform.getDevicePlatform()).toBe('linux');

      vi.resetModules();
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (UnknownOS)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', { value: '', configurable: true });
      platform = await import('../platform.ts');
      expect(platform.getDevicePlatform()).toBe('other');
    });
  });

  describe('isStandaloneDisplayMode', () => {
    it('returns false in normal browser mode', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0)',
        configurable: true,
      });
      const { isStandaloneDisplayMode } = await import('../platform.ts');
      expect(isStandaloneDisplayMode()).toBe(false);
    });

    it('returns true when navigator.standalone is set (iOS Safari)', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'standalone', {
        value: true,
        configurable: true,
      });
      const { isStandaloneDisplayMode } = await import('../platform.ts');
      expect(isStandaloneDisplayMode()).toBe(true);
    });
  });

  describe('iOS standalone viewport reconciliation', () => {
    it('covers a cold landscape surface when visualViewport and root omit the safe area', async () => {
      installIOSStandaloneViewport({
        innerWidth: 852,
        innerHeight: 393,
        visualHeight: 372,
        mediaLandscape: false,
        screenHeight: 852,
      });
      Object.defineProperty(document.documentElement, 'clientHeight', {
        value: 372,
        configurable: true,
      });

      const { platformViewportForTests } = await import('../platform.ts');
      platformViewportForTests.updateNow();

      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');
      expect(document.documentElement.style.height).toBe('');
      expect(document.documentElement.classList.contains('ios-standalone')).toBe(true);
      platformViewportForTests.reset();
    });

    it('uses geometry instead of a stale landscape media query in portrait', async () => {
      installIOSStandaloneViewport({
        innerWidth: 393,
        innerHeight: 852,
        visualHeight: 820,
        mediaLandscape: true,
        screenHeight: 852,
      });

      const { platformViewportForTests } = await import('../platform.ts');
      platformViewportForTests.updateNow();

      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('852px');
      expect(document.documentElement.style.height).toBe('852px');
      platformViewportForTests.reset();
    });

    it('uses the CSS layout probe when the initial inner height is orientation-stale', async () => {
      installIOSStandaloneViewport({
        innerWidth: 852,
        innerHeight: 852,
        visualWidth: 852,
        visualHeight: 372,
        mediaLandscape: true,
        screenHeight: 852,
      });
      const offsetWidth = vi
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.style.width === '100vw' ? 852 : 0;
        });
      const offsetHeight = vi
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.style.height === '100vh' ? 393 : 0;
        });

      const { platformViewportForTests } = await import('../platform.ts');
      platformViewportForTests.updateNow();

      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');
      expect(document.documentElement.style.height).toBe('');
      offsetWidth.mockRestore();
      offsetHeight.mockRestore();
      platformViewportForTests.reset();
    });

    it('rejects an implausibly tall 100vh probe instead of moving the sidebar off-screen', async () => {
      installIOSStandaloneViewport({
        innerWidth: 852,
        innerHeight: 393,
        visualHeight: 372,
      });
      const offsetWidth = vi
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.style.width === '100vw' ? 852 : 0;
        });
      const offsetHeight = vi
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.style.height === '100vh' ? 844 : 0;
        });

      const { platformViewportForTests } = await import('../platform.ts');
      platformViewportForTests.updateNow();

      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');
      offsetWidth.mockRestore();
      offsetHeight.mockRestore();
      platformViewportForTests.reset();
    });

    it('preserves the committed height while every cold landscape signal is transitional', async () => {
      installIOSStandaloneViewport({
        innerWidth: 852,
        innerHeight: 852,
        visualWidth: 852,
        visualHeight: 100,
        mediaLandscape: true,
      });
      document.documentElement.style.setProperty('--app-height', '390px');
      const offsetWidth = vi
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.style.width === '100vw' ? 852 : 0;
        });
      const offsetHeight = vi
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.style.height === '100vh' ? 393 : 0;
        });

      const { platformViewportForTests } = await import('../platform.ts');
      platformViewportForTests.updateNow();

      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('390px');
      offsetWidth.mockRestore();
      offsetHeight.mockRestore();
      platformViewportForTests.reset();
    });

    it('locks cold-start keyboard inference and settles with bounded timers only', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
      const visualViewport = installIOSStandaloneViewport({
        innerWidth: 852,
        innerHeight: 370,
        visualHeight: 260,
        mediaLandscape: false,
      });
      document.documentElement.classList.add('keyboard-open');
      const rafCallbacks: FrameRequestCallback[] = [];
      let nextRafId = 1;
      const requestAnimationFrame = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          rafCallbacks.push(callback);
          return nextRafId++;
        });
      const flushAnimationFrames = (): void => {
        for (let callback = rafCallbacks.shift(); callback; callback = rafCallbacks.shift()) {
          callback(performance.now());
        }
      };

      const { initPlatform, platformViewportForTests } = await import('../platform.ts');
      const { getManagedTimer } = await import('../timers.ts');
      initPlatform();
      flushAnimationFrames();

      expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('--keyboard-overlap')).toBe('0px');
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('370px');
      expect(getManagedTimer('boot-height-ios-300')).not.toBeNull();
      expect(getManagedTimer('boot-height-ios-1300')).not.toBeNull();
      expect(getManagedTimer('boot-end')).not.toBeNull();

      Object.defineProperty(window, 'innerHeight', { value: 393, configurable: true });
      visualViewport.height = 372;
      vi.advanceTimersByTime(300);
      flushAnimationFrames();
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');
      expect(getManagedTimer('boot-height-ios-300')).toBeNull();

      vi.advanceTimersByTime(1000);
      flushAnimationFrames();
      expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
      expect(getManagedTimer('boot-height-ios-1300')).toBeNull();
      expect(getManagedTimer('boot-end')).not.toBeNull();

      vi.advanceTimersByTime(100);
      flushAnimationFrames();
      expect(getManagedTimer('boot-end')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);

      requestAnimationFrame.mockRestore();
      platformViewportForTests.reset();
    });

    it('reconciles a viewport resize that arrives before editable focus', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
      const visualViewport = installIOSStandaloneViewport({
        innerWidth: 852,
        innerHeight: 393,
        visualHeight: 393,
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      const rafCallbacks: FrameRequestCallback[] = [];
      const requestAnimationFrame = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          rafCallbacks.push(callback);
          return rafCallbacks.length;
        });
      const flushAnimationFrames = (): void => {
        for (let callback = rafCallbacks.shift(); callback; callback = rafCallbacks.shift()) {
          callback(performance.now());
        }
      };

      const { initPlatform, platformViewportForTests } = await import('../platform.ts');
      initPlatform();
      flushAnimationFrames();
      vi.advanceTimersByTime(1400);
      flushAnimationFrames();
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');

      visualViewport.height = 250;
      visualViewport.dispatch('resize');
      flushAnimationFrames();
      expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);

      input.focus();
      flushAnimationFrames();
      expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');

      visualViewport.height = 393;
      visualViewport.dispatch('resize');
      flushAnimationFrames();
      expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);

      vi.advanceTimersByTime(400);
      flushAnimationFrames();
      expect(vi.getTimerCount()).toBe(0);
      requestAnimationFrame.mockRestore();
      platformViewportForTests.reset();
    });

    it('accepts an agreed portrait rotation after a focused landscape page resumes', async () => {
      vi.useFakeTimers();
      const visualViewport = installIOSStandaloneViewport({
        innerWidth: 852,
        innerHeight: 393,
        visualWidth: 852,
        visualHeight: 393,
        mediaLandscape: true,
        screenHeight: 852,
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      const rafCallbacks: FrameRequestCallback[] = [];
      const requestAnimationFrame = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          rafCallbacks.push(callback);
          return rafCallbacks.length;
        });
      const flushAnimationFrames = (): void => {
        for (let callback = rafCallbacks.shift(); callback; callback = rafCallbacks.shift()) {
          callback(performance.now());
        }
      };

      const { initPlatform, platformViewportForTests } = await import('../platform.ts');
      initPlatform();
      flushAnimationFrames();
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');
      expect(document.documentElement.style.height).toBe('');

      input.focus();
      Object.defineProperty(window, 'innerWidth', { value: 393, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 852, configurable: true });
      visualViewport.width = 393;
      visualViewport.height = 820;
      visualViewport.setMediaLandscape(false);
      window.dispatchEvent(new Event('pageshow'));
      flushAnimationFrames();

      expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('852px');
      expect(document.documentElement.style.height).toBe('852px');

      vi.clearAllTimers();
      requestAnimationFrame.mockRestore();
      platformViewportForTests.reset();
    });

    it('resets the portrait keyboard baseline when a focused page resumes in landscape', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
      const visualViewport = installIOSStandaloneViewport({
        innerWidth: 393,
        innerHeight: 852,
        visualWidth: 393,
        visualHeight: 820,
        mediaLandscape: false,
        screenHeight: 852,
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      const rafCallbacks: FrameRequestCallback[] = [];
      const requestAnimationFrame = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          rafCallbacks.push(callback);
          return rafCallbacks.length;
        });
      const flushAnimationFrames = (): void => {
        for (let callback = rafCallbacks.shift(); callback; callback = rafCallbacks.shift()) {
          callback(performance.now());
        }
      };

      const { initPlatform, platformViewportForTests } = await import('../platform.ts');
      initPlatform();
      flushAnimationFrames();
      vi.advanceTimersByTime(1400);
      flushAnimationFrames();
      input.focus();
      flushAnimationFrames();

      Object.defineProperty(window, 'innerWidth', { value: 852, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 393, configurable: true });
      visualViewport.width = 852;
      visualViewport.height = 372;
      visualViewport.setMediaLandscape(true);
      window.dispatchEvent(new Event('pageshow'));
      flushAnimationFrames();

      expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('--keyboard-overlap')).toBe('0px');
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');
      expect(document.documentElement.style.height).toBe('');

      vi.clearAllTimers();
      requestAnimationFrame.mockRestore();
      platformViewportForTests.reset();
    });

    it('does not mistake a focused portrait keyboard for a resumed landscape rotation', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
      const visualViewport = installIOSStandaloneViewport({
        innerWidth: 393,
        innerHeight: 852,
        visualWidth: 393,
        visualHeight: 820,
        mediaLandscape: false,
        screenHeight: 852,
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      const rafCallbacks: FrameRequestCallback[] = [];
      const requestAnimationFrame = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          rafCallbacks.push(callback);
          return rafCallbacks.length;
        });
      const flushAnimationFrames = (): void => {
        for (let callback = rafCallbacks.shift(); callback; callback = rafCallbacks.shift()) {
          callback(performance.now());
        }
      };

      const { initPlatform, platformViewportForTests } = await import('../platform.ts');
      initPlatform();
      flushAnimationFrames();
      vi.advanceTimersByTime(1400);
      flushAnimationFrames();
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('852px');

      input.focus();
      flushAnimationFrames();
      Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
      visualViewport.height = 280;
      visualViewport.setMediaLandscape(true);
      window.dispatchEvent(new Event('pageshow'));
      flushAnimationFrames();

      expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('852px');
      expect(document.documentElement.style.height).toBe('852px');

      vi.clearAllTimers();
      requestAnimationFrame.mockRestore();
      platformViewportForTests.reset();
    });

    it('retries focused foreground orientation after stale first-frame geometry settles', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
      const visualViewport = installIOSStandaloneViewport({
        innerWidth: 852,
        innerHeight: 393,
        visualWidth: 852,
        visualHeight: 393,
        mediaLandscape: true,
        screenHeight: 852,
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      const rafCallbacks: FrameRequestCallback[] = [];
      const requestAnimationFrame = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          rafCallbacks.push(callback);
          return rafCallbacks.length;
        });
      const flushAnimationFrames = (): void => {
        for (let callback = rafCallbacks.shift(); callback; callback = rafCallbacks.shift()) {
          callback(performance.now());
        }
      };

      const { initPlatform, platformViewportForTests } = await import('../platform.ts');
      initPlatform();
      flushAnimationFrames();
      vi.advanceTimersByTime(1400);
      flushAnimationFrames();
      input.focus();
      flushAnimationFrames();

      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      flushAnimationFrames();
      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('393px');

      Object.defineProperty(window, 'innerWidth', { value: 393, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 852, configurable: true });
      visualViewport.width = 393;
      visualViewport.height = 820;
      visualViewport.setMediaLandscape(false);
      vi.advanceTimersByTime(300);
      flushAnimationFrames();

      expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('852px');
      expect(document.documentElement.style.height).toBe('852px');

      vi.clearAllTimers();
      requestAnimationFrame.mockRestore();
      platformViewportForTests.reset();
    });
  });
});
