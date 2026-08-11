/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// platform.ts reads navigator.userAgent at import time, so each case installs
// its browser inputs before dynamically importing a reset module.

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
});
