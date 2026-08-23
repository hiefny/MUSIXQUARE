/**
 * Per-device contrast preference.
 *
 * `auto` deliberately has no DOM attribute: CSS follows
 * `prefers-contrast: more` directly, so the OS preference participates in the
 * first paint and remains live without JavaScript repainting the palette.
 * Explicit overrides use `data-contrast="more"` and `data-contrast="normal"`.
 * Forced-colors mode is never represented or suppressed here; the browser's
 * genuine `forced-colors: active` cascade remains authoritative.
 */

export type ContrastPreference = 'auto' | 'on' | 'off';

export interface ContrastStatus {
  readonly preference: ContrastPreference;
  readonly authoredContrastActive: boolean;
  readonly systemPrefersMore: boolean;
  readonly forcedColorsActive: boolean;
}

const CONTRAST_STORAGE_KEY = 'musixquare-contrast'; // brand-capitalization: allow-technical
const PREFERS_MORE_QUERY = '(prefers-contrast: more)';
const FORCED_COLORS_QUERY = '(forced-colors: active)';

let volatilePreference: ContrastPreference | null = null;
let prefersMoreMedia: MediaQueryList | null = null;
let initialized = false;

function normalizeContrastPreference(value: unknown): ContrastPreference {
  return value === 'on' || value === 'off' ? value : 'auto';
}

function readContrastPreference(): ContrastPreference {
  if (volatilePreference !== null) return volatilePreference;
  try {
    return normalizeContrastPreference(localStorage.getItem(CONTRAST_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

function readMediaMatch(query: string): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

function getPrefersMoreMedia(): MediaQueryList | null {
  if (prefersMoreMedia) return prefersMoreMedia;
  try {
    if (typeof window.matchMedia === 'function') {
      prefersMoreMedia = window.matchMedia(PREFERS_MORE_QUERY);
    }
  } catch {
    prefersMoreMedia = null;
  }
  return prefersMoreMedia;
}

function systemPrefersMore(): boolean {
  return getPrefersMoreMedia()?.matches ?? false;
}

function applyContrastPreference(preference: ContrastPreference): void {
  const root = document.documentElement;
  if (preference === 'on') {
    root.setAttribute('data-contrast', 'more');
    return;
  }
  if (preference === 'off') {
    root.setAttribute('data-contrast', 'normal');
    return;
  }
  root.removeAttribute('data-contrast');
}

function handleSystemContrastChange(): void {
  // CSS reacts to the media query itself. Reapplying the attribute contract
  // makes the JS controller resilient if another local surface touched it.
  if (readContrastPreference() === 'auto') applyContrastPreference('auto');
}

function subscribeToSystemContrast(media: MediaQueryList): void {
  try {
    media.addEventListener('change', handleSystemContrastChange);
  } catch {
    // Older WebKit exposes only the legacy MediaQueryList listener API.
    try {
      media.addListener(handleSystemContrastChange);
    } catch {
      /* CSS still follows prefers-contrast even without a JS status listener. */
    }
  }
}

export function getContrastStatus(): ContrastStatus {
  const preference = readContrastPreference();
  const prefersMore = systemPrefersMore();
  return {
    preference,
    authoredContrastActive: preference === 'on' || (preference === 'auto' && prefersMore),
    systemPrefersMore: prefersMore,
    forcedColorsActive: readMediaMatch(FORCED_COLORS_QUERY),
  };
}

export function setContrastPreference(preference: ContrastPreference): ContrastStatus {
  volatilePreference = preference;
  try {
    if (preference === 'auto') localStorage.removeItem(CONTRAST_STORAGE_KEY);
    else localStorage.setItem(CONTRAST_STORAGE_KEY, preference);
  } catch {
    /* Keep the explicit override active for this page when storage is blocked. */
  }
  applyContrastPreference(preference);
  return getContrastStatus();
}

export function initContrastPreference(): void {
  applyContrastPreference(readContrastPreference());
  if (initialized) return;
  initialized = true;
  const media = getPrefersMoreMedia();
  if (media) subscribeToSystemContrast(media);
}
