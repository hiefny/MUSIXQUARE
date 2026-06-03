/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// platform.ts reads navigator.userAgent at module scope, so we must mock
// before importing. We test via dynamic import with vi.resetModules().

describe('Platform Detection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe('IS_IOS', () => {
    it('detects iPhone userAgent as iOS', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        configurable: true,
      });
      const { IS_IOS } = await import('../platform.ts');
      expect(IS_IOS).toBe(true);
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
      const { IS_ANDROID } = await import('../platform.ts');
      expect(IS_ANDROID).toBe(true);
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
      const { IS_WINDOWS } = await import('../platform.ts');
      expect(IS_WINDOWS).toBe(true);
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

  describe('isStandaloneDisplayMode', () => {
    it('returns false in normal browser mode', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0)',
        configurable: true,
      });
      // matchMedia returns false by default in jsdom
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

  describe('preventIOSPinchZoom', () => {
    it('is exported as a function', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0)',
        configurable: true,
      });
      const { preventIOSPinchZoom } = await import('../platform.ts');
      expect(typeof preventIOSPinchZoom).toBe('function');
    });
  });
});
