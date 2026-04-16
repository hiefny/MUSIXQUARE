/**
 * MUSIXQUARE — i18n Engine (Key-Based)
 *
 * Provides: t(), initI18n(), setLanguageMode(), getResolvedLanguage().
 * Translates DOM via data-i18n attributes + MutationObserver.
 */

import { log } from '../core/log.ts';
import ko from './ko.ts';
import en from './en.ts';

import type { I18nKey } from './ko.ts';
export type { I18nKey };

// ─── Language State ──────────────────────────────────────────────

type ResolvedLang = 'ko' | 'en';

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
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  let str: string = _dicts[_resolved][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return str;
}

/** Translate with HTML-safe interpolation (escapes param values for innerHTML contexts). */
export function tHtml(key: I18nKey, params?: Record<string, string | number>): string {
  let str: string = _dicts[_resolved][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      const escaped = String(v).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
      str = str.replaceAll(`{{${k}}}`, escaped);
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
  // Migrate legacy 'system' → resolve to actual value
  if (mode === 'system') mode = _resolveSystem();
  if (mode !== 'ko' && mode !== 'en') mode = _resolveSystem();
  _updateSelector(mode);

  try { localStorage.setItem('musixquare-lang', mode); } catch { /* ignore */ }

  _applyLanguage(mode as ResolvedLang);
}

/** Bootstrap — call once from app.ts. */
export function initI18n(): void {
  const saved = localStorage.getItem('musixquare-lang');
  setLanguageMode(saved || _resolveSystem());

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
    document.querySelectorAll('#grid-lang .ch-opt').forEach(el => el.classList.remove('active'));
    document.querySelector(`#grid-lang .ch-opt[data-lang="${mode}"]`)?.classList.add('active');
  } catch { /* ignore */ }
}
