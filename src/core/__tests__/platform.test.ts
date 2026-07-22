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
