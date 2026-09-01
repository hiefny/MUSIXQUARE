/**
 * MUSIXQUARE — i18n Engine (Key-Based)
 *
 * Provides: t(), initI18n(), setLanguageMode(), getResolvedLanguage().
 * Translates DOM via data-i18n attributes + MutationObserver.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { syncExclusivePressedState } from '../core/aria-state.ts';
import ko from './ko.ts';
import en from './en.ts';
import { EN_PLURAL_MESSAGES } from './plural-en.ts';
import {
  PLURAL_PARAM_BY_KEY,
  type LocalePluralMessages,
  type PluralCategory,
  type PluralI18nKey,
} from './plural-contract.ts';

import type { I18nKey } from './ko.ts';
import { hasLocaleFont } from './locale-font-contract.ts';
import {
  currentAppPathLanguage,
  currentAppPathMatchesLanguage,
  updateKnownLocalizedAppUrlMetadata,
  updateLocalizedAppPath,
} from './localized-app-document.ts';
import {
  languageDirection,
  LANGUAGE_OPTIONS,
  localizedAboutPath,
  type LanguageCode,
} from './locales.ts';
export type { I18nKey };
export { LANGUAGE_OPTIONS } from './locales.ts';
export type { LanguageCode } from './locales.ts';

// ─── Language State ──────────────────────────────────────────────

type LanguageMode = LanguageCode | 'system';

let _mode: LanguageMode = 'system';
let _resolved: LanguageCode = _resolveSystem();

const _dicts: Partial<Record<LanguageCode, Record<string, string>>> = {
  ko,
  en,
};

const _pluralRules = new Map<LanguageCode, Intl.PluralRules>();
const _pluralMessages: Partial<Record<LanguageCode, LocalePluralMessages>> = {
  en: EN_PLURAL_MESSAGES,
};

interface LocaleModule {
  readonly default: Record<string, string>;
  readonly pluralMessages?: LocalePluralMessages;
}

const _localeLoaders: Partial<Record<LanguageCode, () => Promise<LocaleModule>>> = {
  ar: () => import('./ar.ts'),
  bn: () => import('./bn.ts'),
  bg: () => import('./bg.ts'),
  cs: () => import('./cs.ts'),
  da: () => import('./da.ts'),
  de: () => import('./de.ts'),
  el: () => import('./el.ts'),
  es: () => import('./es.ts'),
  fa: () => import('./fa.ts'),
  fi: () => import('./fi.ts'),
  fil: () => import('./fil.ts'),
  fr: () => import('./fr.ts'),
  he: () => import('./he.ts'),
  hi: () => import('./hi.ts'),
  hu: () => import('./hu.ts'),
  id: () => import('./id.ts'),
  it: () => import('./it.ts'),
  gu: () => import('./gu.ts'),
  kn: () => import('./kn.ts'),
  ml: () => import('./ml.ts'),
  mr: () => import('./mr.ts'),
  nb: () => import('./nb.ts'),
  nl: () => import('./nl.ts'),
  ja: () => import('./ja.ts'),
  pl: () => import('./pl.ts'),
  pa: () => import('./pa.ts'),
  'pt-br': () => import('./pt-br.ts'),
  ro: () => import('./ro.ts'),
  ru: () => import('./ru.ts'),
  ms: () => import('./ms.ts'),
  sv: () => import('./sv.ts'),
  ta: () => import('./ta.ts'),
  te: () => import('./te.ts'),
  th: () => import('./th.ts'),
  tr: () => import('./tr.ts'),
  uk: () => import('./uk.ts'),
  ur: () => import('./ur.ts'),
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
  return _pluralMessages[code];
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
      str = str.split(`{{${k}}}`).join(String(v));
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
      str = str.split(`{{${k}}}`).join(escaped);
    }
  }
  return str;
}

/** Current effective language (after system resolution). */
export function getResolvedLanguage(): LanguageCode {
  return _resolved;
}

/** Current document mode. A localized URL may override the durable preference for this visit. */
export function getLanguageMode(): LanguageMode {
  return _mode;
}

/** Switch language mode. Persists to localStorage and retranslates DOM. */
export function setLanguageMode(mode: string): void {
  _setLanguageMode(mode).catch((error) => {
    log.warn('[i18n] Language mode update failed', error);
  });
}

type LocalizedAppHead = typeof import('./localized-app-head.ts');
let _localizedAppHead: LocalizedAppHead | undefined;
let _localizedAppHeadLoad: Promise<LocalizedAppHead | undefined> | undefined;
let _localizedHeadIntent = 0;

function _loadLocalizedAppHead(): Promise<LocalizedAppHead | undefined> {
  if (_localizedAppHead) return Promise.resolve(_localizedAppHead);
  return (_localizedAppHeadLoad ??= import('./localized-app-head.ts')
    .then((module) => (_localizedAppHead = module))
    .catch(() => {
      _localizedAppHeadLoad = undefined;
      return undefined;
    }));
}

function _synchronizeLocalizedHead(
  resolved: LanguageCode,
  intent: number,
  options: { forceDocumentTitle?: boolean } = {},
): void {
  void _loadLocalizedAppHead()
    .then((head) => {
      if (!head || intent !== _localizedHeadIntent) return;
      return head.synchronizeLocalizedAppHead(
        resolved,
        () => intent === _localizedHeadIntent && _resolved === resolved,
        options,
      );
    })
    .catch(() => {
      // Metadata synchronization is best-effort; URL and translated UI already
      // hold the selected locale even if this deferred boundary fails.
    });
}

/** Restore canonical app metadata after an invite-room URL is cleaned in place. */
export function synchronizeCurrentLocalizedAppHead(): void {
  const resolved = _resolved;
  if (!currentAppPathMatchesLanguage(resolved)) return;

  updateKnownLocalizedAppUrlMetadata(resolved);
  const headIntent = ++_localizedHeadIntent;
  _localizedAppHead?.cancelLocalizedAppHeadSync();
  if (_dicts[resolved]) {
    _synchronizeLocalizedHead(resolved, headIntent, { forceDocumentTitle: true });
  }
}

async function _setLanguageMode(mode: string): Promise<void> {
  const headIntent = ++_localizedHeadIntent;
  _localizedAppHead?.cancelLocalizedAppHeadSync();
  const normalizedMode = _normalizeLanguageMode(mode);
  const resolved = normalizedMode === 'system' ? _resolveSystem() : normalizedMode;
  _mode = normalizedMode;
  _updateSelector(normalizedMode);

  try {
    localStorage.setItem('musixquare-lang', normalizedMode);
  } catch {
    /* ignore */
  }

  const pathUpdate = updateLocalizedAppPath(resolved);
  if (pathUpdate === 'navigating') return;
  await _applyLanguage(resolved);
  if (
    (pathUpdate === 'replaced' || pathUpdate === 'unchanged') &&
    _resolved === resolved &&
    _dicts[resolved] &&
    currentAppPathLanguage() === resolved
  ) {
    _synchronizeLocalizedHead(resolved, headIntent);
  }
}

function _initialLanguageMode(saved: string | null): LanguageMode {
  return _normalizeLanguageMode(saved || 'system');
}

/** Bootstrap — call once from app.ts. */
export async function initI18n(): Promise<void> {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('musixquare-lang');
  } catch {
    /* ignore */
  }

  const pathLanguage = currentAppPathLanguage();
  const savedMode = _initialLanguageMode(saved);
  if (pathLanguage) {
    // A localized URL owns this document's presentation without rewriting the
    // durable PWA preference, so returning to `/` still uses the saved choice.
    _mode = pathLanguage;
    _updateSelector(pathLanguage);
    await _applyLanguage(pathLanguage);
  } else {
    await _setLanguageMode(savedMode);
  }

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
      if (!_dicts[_resolved] && _localeLoaders[_resolved]) {
        setLanguageMode(_mode);
      }
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
  if (htmlKey) {
    el.innerHTML = tHtml(htmlKey as I18nKey);
    const aboutPath = localizedAboutPath(_resolved);
    el.querySelectorAll<HTMLAnchorElement>('a[href="/about"]').forEach((link) => {
      link.setAttribute('href', aboutPath);
    });
  }

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
  if (normalized === 'in' || normalized.startsWith('in-')) return 'id';
  if (normalized === 'iw' || normalized.startsWith('iw-')) return 'he';
  if (normalized === 'no' || normalized.startsWith('no-')) return 'nb';
  if (normalized === 'tl' || normalized.startsWith('tl-')) return 'fil';

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
      // The dictionary and its grammatical overrides are exports of one lazy
      // module. Commit both synchronously only after that chunk resolves, so a
      // deploy-skew failure can never leave mixed-language plural copy cached.
      const dictionary = mod.default;
      const pluralMessages = 'pluralMessages' in mod ? mod.pluralMessages : undefined;
      _dicts[code] = dictionary;
      if (pluralMessages) _pluralMessages[code] = pluralMessages;
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
  // A failed lazy chunk renders the complete English dictionary. Keep the
  // document language aligned with those actual words so assistive
  // technology does not pronounce English through the requested locale.
  // `_resolved` intentionally remains unchanged so re-select/online can
  // retry the missing chunk; a successful retry restores the requested tag.
  try {
    const renderedLanguage = _dicts[resolved] ? resolved : 'en';
    document.documentElement.setAttribute('lang', _htmlLangFor(renderedLanguage));
    document.documentElement.setAttribute('dir', languageDirection(renderedLanguage));
  } catch {
    /* ignore */
  }
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
    document.documentElement.setAttribute('dir', languageDirection(_resolved));
  } catch {
    /* ignore */
  }

  const needsFontLoad = hasLocaleFont(resolved);
  const fontLoad = needsFontLoad
    ? import('./locale-fonts.ts').then(({ default: localeFonts }) =>
        localeFonts.loadLocaleFont(resolved),
      )
    : Promise.resolve();

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
    const action = mode === 'system' ? 'system' : 'select';
    syncExclusivePressedState(
      document.querySelectorAll<HTMLElement>('#grid-lang .ch-opt'),
      (element) => element.dataset.langAction === action || element.dataset.lang === mode,
    );
  } catch {
    /* ignore */
  }
}
