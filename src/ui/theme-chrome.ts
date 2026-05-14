/**
 * Browser chrome color integration.
 *
 * Mobile browsers use `theme-color` for the address/status/navigation bar.
 * Keep it in sync with the visible app surface instead of leaving it stuck
 * on whichever color was set during boot.
 */

type ResolvedTheme = 'dark' | 'light';

const APP_THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: '#212121',
  light: '#ffffff',
};

const DEMO_PANEL_FALLBACK_COLORS: Record<ResolvedTheme, string> = {
  dark: '#1a1a1a',
  light: '#ffffff',
};

function normalizeTheme(theme?: string | null): ResolvedTheme {
  return theme === 'light' ? 'light' : 'dark';
}

function getCurrentTheme(): ResolvedTheme {
  return normalizeTheme(document.documentElement.getAttribute('data-theme'));
}

function getCssToken(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function setThemeColorMeta(color: string): void {
  let metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
    metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  }
  metas.forEach((meta) => {
    meta.setAttribute('content', color);
  });
}

function setColorSchemeMeta(theme: ResolvedTheme): void {
  document.documentElement.style.colorScheme = theme;
  document.querySelectorAll<HTMLMetaElement>('meta[name="color-scheme"]').forEach((meta) => {
    meta.setAttribute('content', theme);
  });
}

export function syncAppThemeChrome(theme: string | null = getCurrentTheme()): void {
  const resolved = normalizeTheme(theme);
  setColorSchemeMeta(resolved);
  setThemeColorMeta(APP_THEME_COLORS[resolved]);
}

export function syncDemoThemeChrome(theme: string | null = getCurrentTheme()): void {
  const resolved = normalizeTheme(theme);
  setColorSchemeMeta(resolved);
  setThemeColorMeta(getCssToken('--surface-1', DEMO_PANEL_FALLBACK_COLORS[resolved]));
}
