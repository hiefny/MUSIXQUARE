function matchVersion(userAgent: string, pattern: RegExp): string | null {
  return userAgent.match(pattern)?.[1] ?? null;
}

/**
 * Human-readable browser label for the local-only `/debug` report.
 *
 * Android WebViews deliberately expose the compatibility tokens
 * `Version/4.0`, `Chrome/...`, and `Mobile Safari/...` together. Specific
 * Chromium-family products and WebViews therefore have to be matched before
 * the generic Safari fallback.
 */
export function parseDebugBrowser(userAgent: string): string {
  let version: string | null;

  version = matchVersion(userAgent, /SamsungBrowser\/([\d.]+)/i);
  if (version) return `Samsung Internet ${version}`;

  version =
    matchVersion(userAgent, /OPR\/([\d.]+)/i) ?? matchVersion(userAgent, /Opera\/([\d.]+)/i);
  if (version) return `Opera ${version}`;

  version = matchVersion(userAgent, /EdgA\/([\d.]+)/i);
  if (version) return `Microsoft Edge Android ${version}`;

  version = matchVersion(userAgent, /EdgiOS\/([\d.]+)/i);
  if (version) return `Microsoft Edge iOS ${version}`;

  version = matchVersion(userAgent, /Edg\/([\d.]+)/i);
  if (version) return `Microsoft Edge ${version}`;

  version = matchVersion(userAgent, /Whale\/([\d.]+)/i);
  if (version) return `Naver Whale ${version}`;

  version = matchVersion(userAgent, /FxiOS\/([\d.]+)/i);
  if (version) return `Firefox iOS ${version}`;

  version = matchVersion(userAgent, /Firefox\/([\d.]+)/i);
  if (version) return `Firefox ${version}`;

  version = matchVersion(userAgent, /CriOS\/([\d.]+)/i);
  if (version) return `Chrome iOS ${version}`;

  const chromeVersion = matchVersion(userAgent, /Chrome\/([\d.]+)/i);
  const isAndroid = /Android/i.test(userAgent);
  const isAndroidWebView =
    isAndroid && (/(?:^|[;\s])wv(?:[);]|$)/i.test(userAgent) || /Version\/4\.0/i.test(userAgent));
  if (chromeVersion && isAndroidWebView) return `Android WebView ${chromeVersion}`;
  if (chromeVersion) return `Chrome ${chromeVersion}`;

  version = matchVersion(userAgent, /Version\/([\d.]+).*Safari/i);
  if (version && isAndroid) return `Android Browser ${version}`;
  if (version) return `Safari ${version}`;

  return userAgent.slice(0, 50);
}
