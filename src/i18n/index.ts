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
import {
  PLURAL_MESSAGES,
  PLURAL_PARAM_BY_KEY,
  type LocalePluralMessages,
  type PluralCategory,
  type PluralI18nKey,
} from './plural.ts';

import type { I18nKey } from './ko.ts';
import { hasLocaleFont, loadLocaleFont } from './locale-fonts.ts';
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
  { code: 'nl', htmlLang: 'nl', nativeName: 'Nederlands', englishName: 'Dutch' },
  { code: 'it', htmlLang: 'it', nativeName: 'Italiano', englishName: 'Italian' },
  { code: 'pl', htmlLang: 'pl', nativeName: 'Polski', englishName: 'Polish' },
  { code: 'ru', htmlLang: 'ru', nativeName: 'Русский', englishName: 'Russian' },
  { code: 'tr', htmlLang: 'tr', nativeName: 'Türkçe', englishName: 'Turkish' },
  { code: 'id', htmlLang: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian' },
  { code: 'vi', htmlLang: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese' },
  { code: 'th', htmlLang: 'th', nativeName: 'ไทย', englishName: 'Thai' },
] as const;

export type LanguageCode = (typeof LANGUAGE_OPTIONS)[number]['code'];
type LanguageMode = LanguageCode | 'system';

let _mode: LanguageMode = 'system';
let _resolved: LanguageCode = _resolveSystem();

const _dicts: Partial<Record<LanguageCode, Record<string, string>>> = {
  ko,
  en,
};

const _pluralRules = new Map<LanguageCode, Intl.PluralRules>();

const _localeLoaders: Partial<
  Record<LanguageCode, () => Promise<{ default: Record<string, string> }>>
> = {
  de: () => import('./de.ts'),
  es: () => import('./es.ts'),
  fr: () => import('./fr.ts'),
  id: () => import('./id.ts'),
  it: () => import('./it.ts'),
  nl: () => import('./nl.ts'),
  ja: () => import('./ja.ts'),
  pl: () => import('./pl.ts'),
  'pt-br': () => import('./pt-br.ts'),
  ru: () => import('./ru.ts'),
  th: () => import('./th.ts'),
  tr: () => import('./tr.ts'),
  vi: () => import('./vi.ts'),
  'zh-hans': () => import('./zh-hans.ts'),
  'zh-hant': () => import('./zh-hant.ts'),
};

const _loadingLocales = new Map<LanguageCode, Promise<void>>();

// ─── Public API ─────────────────────────────────────────────────

type TranslationParams = Record<string, string | number>;

/**
 * Return the browser's primary system language when MUSIXQUARE supports it.
 *
 * Unlike the resolved UI language, this deliberately returns `null` when the
 * primary system language is unsupported instead of applying the English
 * fallback. Callers can therefore distinguish "English is preferred" from
 * "no system preference can be represented in the language picker".
 */
export function getSupportedSystemLanguage(): LanguageCode | null {
  try {
    return _matchLanguage(navigator.language || navigator.languages?.[0] || '');
  } catch {
    return null;
  }
}

function _pluralCategory(value: number): PluralCategory {
  try {
    let rules = _pluralRules.get(_resolved);
    if (!rules) {
      rules = new Intl.PluralRules(_htmlLangFor(_resolved));
      _pluralRules.set(_resolved, rules);
    }
    return rules.select(value) as PluralCategory;
  } catch {
    // Ancient or embedded browsers without Intl.PluralRules still get the
    // English-style cardinal fallback instead of a broken placeholder.
    return value === 1 ? 'one' : 'other';
  }
}

function _pluralFormsFor(code: LanguageCode): LocalePluralMessages | undefined {
  return (PLURAL_MESSAGES as Partial<Record<LanguageCode, LocalePluralMessages>>)[code];
}

function _translationTemplate(key: I18nKey, params?: TranslationParams): string {
  const dict = _dicts[_resolved];
  const pluralKey = key as PluralI18nKey;
  const pluralParam = PLURAL_PARAM_BY_KEY[pluralKey];
  const pluralValue = pluralParam ? params?.[pluralParam] : undefined;

  if (typeof pluralValue === 'number' && Number.isFinite(pluralValue)) {
    const category = _pluralCategory(pluralValue);

    // Only use a locale-specific grammatical variant when that locale's main
    // dictionary loaded successfully. Otherwise keep the established all-
    // English fallback instead of rendering a mixed-language sentence.
    if (dict) {
      return _pluralFormsFor(_resolved)?.[pluralKey]?.[category] ?? dict[key] ?? en[key] ?? key;
    }
    return _pluralFormsFor('en')?.[pluralKey]?.[category] ?? en[key] ?? key;
  }

  return dict?.[key] ?? en[key] ?? key;
}

function _interpolate(str: string, params?: TranslationParams): string {
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return str;
}

/**
 * Translate a semantic key, optionally interpolating `{{param}}` placeholders.
 * Count-sensitive keys also select their locale's grammatical plural form.
 *
 * @example
 *   t('common.ok')                                   // "확인" or "OK"
 *   t('toast.device_connected', { name: 'iPhone' })  // "iPhone님이 연결됐어요"
 *   t('toast.added_tracks', { count: 1 })             // "1 track added"
 */
export function t(key: I18nKey, params?: TranslationParams): string {
  return _interpolate(_translationTemplate(key, params), params);
}

/** Translate with HTML-safe interpolation (escapes param values for innerHTML contexts). */
export function tHtml(key: I18nKey, params?: Record<string, string | number>): string {
  let str = _translationTemplate(key, params);
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

    // Self-heal a lazy locale whose chunk failed to load (e.g. the saved
    // locale 404s during a startup network blip and the user never re-opens
    // the language dialog). The `!_dicts[_resolved]` gate is load-bearing:
    // it makes ordinary connectivity flaps a strict no-op, so 'i18n:changed'
    // is never re-emitted (and its re-render subscribers never churn)
    // unless a previously-requested locale is genuinely missing.
    window.addEventListener('online', () => {
      if (!_dicts[_resolved] && _localeLoaders[_resolved]) void _applyLanguage(_resolved);
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
      // Deliberately cache NOTHING on failure. _dicts is a presence-keyed
      // success cache (entry present = genuine dictionary for that code);
      // writing `en` under the failed code would launder a transient failure
      // (network blip, deploy-skew chunk 404) into permanent success and pin
      // the locale to English until a full reload. t()/tHtml already fall
      // back to English statelessly at read time, so the failure frame
      // renders identically either way; absence keeps the locale retryable
      // on the next _applyLanguage (re-select, languagechange, 'online').
      log.warn(`[i18n] Failed to load locale "${code}", falling back to English`, error);
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

  const needsFontLoad = hasLocaleFont(resolved);
  const fontLoad = needsFontLoad ? loadLocaleFont(resolved) : Promise.resolve();

  if (_dicts[resolved]) {
    if (needsFontLoad) await fontLoad;
    _translateLoadedLanguage(resolved);
    return;
  }

  await Promise.all([_loadLanguage(resolved), fontLoad]);
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
