/**
 * MUSIXQUARE 2.0 — i18n Engine (Key-Based)
 *
 * Provides: t(), initI18n(), setLanguageMode(), getResolvedLanguage().
 * Translates DOM via data-i18n attributes + MutationObserver.
 */

import { log } from '../core/log.ts';
import ko from './ko.ts';
import en from './en.ts';

export type { I18nKey } from './ko.ts';

// ─── Language State ──────────────────────────────────────────────

type LangMode = 'ko' | 'en' | 'system';
type ResolvedLang = 'ko' | 'en';

let _activeMode: LangMode = 'system';
let _resolved: ResolvedLang = _resolveSystem();

const _dicts: Record<ResolvedLang, Record<string, string>> = { ko, en };

// ─── Public API ─────────────────────────────────────────────────

/**
 * Translate a semantic key, optionally interpolating `{{param}}` placeholders.
 *
 * @example
 *   t('common.ok')                                   // "확인" or "OK"
 *   t('toast.device_connected', { name: 'iPhone' })  // "iPhone가 연결됐어요"
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let str: string = _dicts[_resolved][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return str;
}

/** Current effective language (after system resolution). */
export function getResolvedLanguage(): ResolvedLang {
  return _resolved;
}

/** Switch language mode. Persists to localStorage and retranslates DOM. */
export function setLanguageMode(mode: string): void {
  if (mode !== 'ko' && mode !== 'en' && mode !== 'system') mode = 'system';
  _activeMode = mode as LangMode;
  _updateSelector(mode);

  try { localStorage.setItem('musixquare-lang', mode); } catch { /* ignore */ }

  const resolved = mode === 'system' ? _resolveSystem() : mode as ResolvedLang;
  _applyLanguage(resolved);
}

/** Bootstrap — call once from app.ts. */
export function initI18n(): void {
  const saved = localStorage.getItem('musixquare-lang');
  setLanguageMode(saved || 'system');

  try {
    window.addEventListener('languagechange', () => {
      if (_activeMode !== 'system') return;
      _applyLanguage(_resolveSystem());
    });
  } catch { /* ignore */ }

  log.info('[i18n] Initialized');
}

// ─── DOM Translation ────────────────────────────────────────────

const I18N_ATTRS = ['placeholder', 'aria-label', 'title', 'alt'] as const;

function _translateElement(el: Element): void {
  // textContent
  const textKey = el.getAttribute('data-i18n');
  if (textKey) el.textContent = t(textKey);

  // innerHTML (help blocks)
  const htmlKey = el.getAttribute('data-i18n-html');
  if (htmlKey) el.innerHTML = t(htmlKey);

  // Attributes
  for (const attr of I18N_ATTRS) {
    const key = el.getAttribute(`data-i18n-${attr}`);
    if (key) el.setAttribute(attr, t(key));
  }
}

const _I18N_SELECTOR =
  '[data-i18n],[data-i18n-html],[data-i18n-placeholder],[data-i18n-aria-label],[data-i18n-title],[data-i18n-alt]';

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
        m.addedNodes.forEach(n => {
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
  } catch { /* ignore */ }
}

// ─── Internal ───────────────────────────────────────────────────

function _resolveSystem(): ResolvedLang {
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
    return String(langs[0] || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  } catch {
    return 'ko';
  }
}

function _applyLanguage(resolved: ResolvedLang): void {
  _resolved = resolved;
  try { document.documentElement.setAttribute('lang', _resolved); } catch { /* ignore */ }

  _ensureObserver();
  _translateSubtree(document.body || document.documentElement);
}

function _updateSelector(mode: string): void {
  try {
    document.querySelectorAll('.lang-opt').forEach(el => el.classList.remove('active'));
    const id = mode === 'ko' ? 'lang-ko' : mode === 'en' ? 'lang-en' : 'lang-system';
    document.getElementById(id)?.classList.add('active');

    const pillIndex = mode === 'ko' ? 0 : mode === 'en' ? 1 : 2;
    document.querySelectorAll<HTMLElement>('.lang-selector').forEach(sel => {
      sel.style.setProperty('--pill-index', String(pillIndex));
    });
  } catch { /* ignore */ }
}
