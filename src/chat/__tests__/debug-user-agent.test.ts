import { describe, expect, it } from 'vitest';
import { parseDebugBrowser } from '../debug-user-agent.ts';

describe('parseDebugBrowser', () => {
  it('recognizes Android WebView before its Safari compatibility token', () => {
    const userAgent =
      'Mozilla/5.0 (Linux; Android 14; SM-S928N Build/UP1A.231005.007; wv) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 ' +
      'Chrome/138.0.7204.157 Mobile Safari/537.36';

    expect(parseDebugBrowser(userAgent)).toBe('Android WebView 138.0.7204.157');
  });

  it('recognizes WebViews that omit the wv marker but retain Version/4.0', () => {
    const userAgent =
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36';

    expect(parseDebugBrowser(userAgent)).toBe('Android WebView 124.0.6367.82');
  });

  it('keeps ordinary Android Chrome distinct from a WebView', () => {
    const userAgent =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/138.0.7204.157 Mobile Safari/537.36';

    expect(parseDebugBrowser(userAgent)).toBe('Chrome 138.0.7204.157');
  });

  it('reports the legacy Android browser instead of Safari', () => {
    const userAgent =
      'Mozilla/5.0 (Linux; U; Android 4.0.3; en-us; Galaxy Nexus Build/IML74K) ' +
      'AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30';

    expect(parseDebugBrowser(userAgent)).toBe('Android Browser 4.0');
  });

  it('keeps real Safari detection for Apple devices', () => {
    const userAgent =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

    expect(parseDebugBrowser(userAgent)).toBe('Safari 17.5');
  });

  it('prioritizes Android Edge and Samsung Internet over generic Chrome', () => {
    const edgeUserAgent =
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/138.0.0.0 Mobile Safari/537.36 EdgA/138.0.3351.83';
    const samsungUserAgent =
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/130.0.0.0 Mobile Safari/537.36 SamsungBrowser/27.0';

    expect(parseDebugBrowser(edgeUserAgent)).toBe('Microsoft Edge Android 138.0.3351.83');
    expect(parseDebugBrowser(samsungUserAgent)).toBe('Samsung Internet 27.0');
  });
});
