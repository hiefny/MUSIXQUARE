/**
 * MUSIXQUARE — i18n Engine (Key-Based)
 *
 * Provides: t(), initI18n(), setLanguageMode(), getResolvedLanguage().
 * Translates DOM via data-i18n attributes + MutationObserver.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import ko from './ko.ts';
import en from './en.ts';

import type { I18nKey } from './ko.ts';
export type { I18nKey };

// ─── Language State ──────────────────────────────────────────────

export const LANGUAGE_OPTIONS = [
  { code: 'en', htmlLang: 'en', nativeName: 'English', englishName: 'Default' },
  { code: 'ko', htmlLang: 'ko', nativeName: '한국어', englishName: 'Korean' },
  { code: 'ja', htmlLang: 'ja', nativeName: '日本語', englishName: 'Japanese' },
  {
    code: 'zh-hans',
    htmlLang: 'zh-Hans',
    nativeName: '简体中文',
    englishName: 'Chinese (Simplified)',
  },
  {
    code: 'zh-hant',
    htmlLang: 'zh-Hant',
    nativeName: '繁體中文',
    englishName: 'Chinese (Traditional)',
  },
  { code: 'es', htmlLang: 'es', nativeName: 'Español', englishName: 'Spanish' },
  {
    code: 'pt-br',
    htmlLang: 'pt-BR',
    nativeName: 'Português (Brasil)',
    englishName: 'Portuguese (Brazil)',
  },
  { code: 'fr', htmlLang: 'fr', nativeName: 'Français', englishName: 'French' },
  { code: 'de', htmlLang: 'de', nativeName: 'Deutsch', englishName: 'German' },
  { code: 'id', htmlLang: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian' },
  { code: 'vi', htmlLang: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese' },
  { code: 'th', htmlLang: 'th', nativeName: 'ไทย', englishName: 'Thai' },
] as const;

export type LanguageCode = (typeof LANGUAGE_OPTIONS)[number]['code'];
export type LanguageMode = LanguageCode | 'system';

let _mode: LanguageMode = 'system';
let _resolved: LanguageCode = _resolveSystem();

const _dicts: Partial<Record<LanguageCode, Record<string, string>>> = {
  ko,
  en,
};

const _localeLoaders: Partial<
  Record<LanguageCode, () => Promise<{ default: Record<string, string> }>>
> = {
  de: () => import('./de.ts'),
  es: () => import('./es.ts'),
  fr: () => import('./fr.ts'),
  id: () => import('./id.ts'),
  ja: () => import('./ja.ts'),
  'pt-br': () => import('./pt-br.ts'),
  th: () => import('./th.ts'),
  vi: () => import('./vi.ts'),
  'zh-hans': () => import('./zh-hans.ts'),
  'zh-hant': () => import('./zh-hant.ts'),
};

const _loadingLocales = new Map<LanguageCode, Promise<void>>();

// ─── Public API ─────────────────────────────────────────────────

/**
 * Translate a semantic key, optionally interpolating `{{param}}` placeholders.
 *
 * @example
 *   t('common.ok')                                   // "확인" or "OK"
 *   t('toast.device_connected', { name: 'iPhone' })  // "iPhone가 연결됐어요"
 */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const dict = _dicts[_resolved] || en;
  let str: string = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return str;
}

/** Translate with HTML-safe interpolation (escapes param values for innerHTML contexts). */
export function tHtml(key: I18nKey, params?: Record<string, string | number>): string {
  const dict = _dicts[_resolved] || en;
  let str: string = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      const escaped = String(v).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c,
      );
      str = str.replaceAll(`{{${k}}}`, escaped);
    }
  }
  return str;
}

/** Current effective language (after system resolution). */
export function getResolvedLanguage(): LanguageCode {
  return _resolved;
}

/** Current preference mode. `system` means the effective language follows the browser. */
export function getLanguageMode(): LanguageMode {
  return _mode;
}

/** Switch language mode. Persists to localStorage and retranslates DOM. */
export function setLanguageMode(mode: string): void {
  void _setLanguageMode(mode);
}

async function _setLanguageMode(mode: string): Promise<void> {
  const normalizedMode = _normalizeLanguageMode(mode);
  const resolved = normalizedMode === 'system' ? _resolveSystem() : normalizedMode;
  _mode = normalizedMode;
  _updateSelector(normalizedMode);

  try {
    localStorage.setItem('musixquare-lang', normalizedMode);
  } catch {
    /* ignore */
  }

  await _applyLanguage(resolved);
}

/** Bootstrap — call once from app.ts. */
export async function initI18n(): Promise<void> {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('musixquare-lang');
  } catch {
    /* ignore */
  }

  await _setLanguageMode(saved || 'system');

  try {
    window.addEventListener('languagechange', () => {
      if (_mode === 'system') setLanguageMode('system');
    });
  } catch {
    /* ignore */
  }

  log.info('[i18n] Initialized');
}

// ─── DOM Translation ────────────────────────────────────────────

const I18N_ATTRS = ['placeholder', 'aria-label', 'title', 'alt', 'data-placeholder'] as const;

function _translateElement(el: Element): void {
  // innerHTML (help blocks) — use tHtml for safe interpolation
  const htmlKey = el.getAttribute('data-i18n-html');
  if (htmlKey) el.innerHTML = tHtml(htmlKey as I18nKey);

  // textContent (skip if innerHTML already set — avoids overwrite)
  const textKey = el.getAttribute('data-i18n');
  if (textKey && !htmlKey) el.textContent = t(textKey as I18nKey);

  // Attributes
  for (const attr of I18N_ATTRS) {
    const key = el.getAttribute(`data-i18n-${attr}`);
    if (key) el.setAttribute(attr, t(key as I18nKey));
  }
}

const _I18N_SELECTOR =
  '[data-i18n],[data-i18n-html],[data-i18n-placeholder],[data-i18n-aria-label],[data-i18n-title],[data-i18n-alt],[data-i18n-data-placeholder]';

function _translateSubtree(root: Element | Document): void {
  if (root instanceof Element) _translateElement(root);
  root.querySelectorAll(_I18N_SELECTOR).forEach(_translateElement);
}

// ─── MutationObserver ───────────────────────────────────────────

let _observer: MutationObserver | null = null;

function _ensureObserver(): void {
  if (_observer || typeof MutationObserver === 'undefined') return;

  _observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) _translateSubtree(n as Element);
        });
      }
    }
  });

  try {
    _observer.observe(document.body || document.documentElement, {
      subtree: true,
      childList: true,
    });
  } catch {
    /* ignore */
  }
}

// ─── Internal ───────────────────────────────────────────────────

function _normalizeLanguageMode(value: string | null | undefined): LanguageMode {
  if (value === 'system') return 'system';
  return _matchLanguage(value) ?? 'system';
}

function _matchLanguage(value: string | null | undefined): LanguageCode | null {
  const normalized = String(value || '')
    .trim()
    .replace(/_/g, '-')
    .toLowerCase();
  if (!normalized) return null;

  if (normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) return 'zh-hans';
  if (normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) return 'zh-hant';
  if (normalized.startsWith('zh')) {
    if (
      normalized.includes('tw') ||
      normalized.includes('hk') ||
      normalized.includes('mo') ||
      normalized.includes('hant')
    ) {
      return 'zh-hant';
    }
    return 'zh-hans';
  }

  if (normalized === 'pt-br' || normalized.startsWith('pt-br-')) return 'pt-br';
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-br';

  const primary = normalized.split('-')[0];
  if (LANGUAGE_OPTIONS.some((lang) => lang.code === primary)) return primary as LanguageCode;
  return null;
}

function _resolveSystem(): LanguageCode {
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
    for (const lang of langs) {
      const matched = _matchLanguage(lang);
      if (matched) return matched;
    }
    return 'en';
  } catch {
    return 'en';
  }
}

function _htmlLangFor(code: LanguageCode): string {
  return LANGUAGE_OPTIONS.find((lang) => lang.code === code)?.htmlLang ?? code;
}

function _loadLanguage(code: LanguageCode): Promise<void> {
  if (_dicts[code]) return Promise.resolve();
  const loader = _localeLoaders[code];
  if (!loader) return Promise.resolve();

  const existing = _loadingLocales.get(code);
  if (existing) return existing;

  const pending = loader()
    .then((mod) => {
      _dicts[code] = mod.default;
    })
    .catch((error) => {
      log.warn(`[i18n] Failed to load locale "${code}", falling back to English`, error);
      _dicts[code] = en;
    })
    .finally(() => {
      _loadingLocales.delete(code);
    });

  _loadingLocales.set(code, pending);
  return pending;
}

function _translateLoadedLanguage(resolved: LanguageCode): void {
  if (_resolved !== resolved) return;
  _ensureObserver();
  _translateSubtree(document.body || document.documentElement);

  // Notify components that cache translated strings outside of data-i18n
  // attributes (toast text, dialog contents, dynamically rendered lists, etc.).
  bus.emit('i18n:changed', resolved);
}

async function _applyLanguage(resolved: LanguageCode): Promise<void> {
  _resolved = resolved;
  try {
    document.documentElement.setAttribute('lang', _htmlLangFor(_resolved));
  } catch {
    /* ignore */
  }

  if (_dicts[resolved]) {
    _translateLoadedLanguage(resolved);
    return;
  }

  await _loadLanguage(resolved);
  _translateLoadedLanguage(resolved);
}

function _updateSelector(mode: LanguageMode): void {
  try {
    document.querySelectorAll('#grid-lang .ch-opt').forEach((el) => el.classList.remove('active'));
    const action = mode === 'system' ? 'system' : 'select';
    document
      .querySelector(`#grid-lang .ch-opt[data-lang-action="${action}"]`)
      ?.classList.add('active');
    document.querySelector(`#grid-lang .ch-opt[data-lang="${mode}"]`)?.classList.add('active');
  } catch {
    /* ignore */
  }
}
