/**
 * MUSIXQUARE 2.0 — Dialog / Modal System
 * Extracted from original app.js lines 10150-10336
 *
 * Manages: Promise-based modal dialogs with queue, focus trap, a11y.
 */

import { log } from '../core/log.ts';
import { showToast } from './toast.ts';
import { t } from '../i18n/index.ts';

// ─── Types ───────────────────────────────────────────────────────

export interface DialogOptions {
  title?: string;
  message?: string;
  buttonText?: string;
  secondaryText?: string;
  cancelText?: string;
  dismissible?: boolean;
  defaultFocus?: 'primary' | 'secondary' | 'close';
}

export interface DialogResult {
  action: string;
}

interface DialogActiveState {
  resolve: (result: DialogResult) => void;
  prevFocus: Element | null;
  cleanup: (() => void)[];
}

// ─── State ───────────────────────────────────────────────────────

let _dialogActive: DialogActiveState | null = null;
const _dialogQueue: Array<{ opts: DialogOptions | string; resolve: (result: DialogResult) => void }> = [];

// ─── Internal ────────────────────────────────────────────────────

function drainDialogQueue(): void {
  if (_dialogActive) return;
  const next = _dialogQueue.shift();
  if (!next) return;
  _openDialog(next.opts, next.resolve);
}

export function closeDialog(action = 'close'): void {
  const overlay = document.getElementById('dialog-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  }

  const active = _dialogActive;
  _dialogActive = null;

  try {
    if (active && Array.isArray(active.cleanup)) {
      active.cleanup.forEach(fn => { try { fn(); } catch { /* ignore */ } });
    }
  } catch { /* ignore */ }

  if (active?.prevFocus && typeof (active.prevFocus as HTMLElement).focus === 'function') {
    try { (active.prevFocus as HTMLElement).focus(); } catch { /* ignore */ }
  }

  if (typeof active?.resolve === 'function') {
    try { active.resolve({ action }); } catch { /* ignore */ }
  }

  setTimeout(drainDialogQueue, 0);
}

function _openDialog(opts: DialogOptions | string, resolve: (result: DialogResult) => void): void {
  const overlay = document.getElementById('dialog-overlay');
  const titleEl = document.getElementById('dialog-title');
  const msgEl = document.getElementById('dialog-message');
  const okBtn = document.getElementById('btn-dialog-ok') as HTMLButtonElement | null;
  const secondaryBtn = document.getElementById('btn-dialog-secondary') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('btn-dialog-close') as HTMLButtonElement | null;

  if (!overlay || !titleEl || !msgEl || !okBtn || !closeBtn) {
    showToast(typeof opts === 'string' ? opts : (opts?.message || t('common.info')));
    resolve({ action: 'fallback' });
    setTimeout(drainDialogQueue, 0);
    return;
  }

  const o = (typeof opts === 'object' && opts) ? opts : { message: String(opts ?? '') };
  const title = (typeof opts === 'string') ? t('common.info') : (o.title || t('common.info'));
  const message = (typeof opts === 'string') ? String(opts ?? '') : String(o.message || '');
  const buttonText = o.buttonText ? String(o.buttonText) : t('common.ok');
  const secondaryTextRaw = (o.secondaryText !== undefined && o.secondaryText !== null)
    ? o.secondaryText
    : ((o.cancelText !== undefined && o.cancelText !== null) ? o.cancelText : '');
  const secondaryText = String(secondaryTextRaw ?? '').trim();
  const hasSecondary = !!secondaryText;
  const dismissible = (o.dismissible !== undefined) ? !!o.dismissible : true;
  const defaultFocus = o.defaultFocus
    ? String(o.defaultFocus)
    : (hasSecondary ? 'secondary' : 'primary');

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = buttonText;

  if (secondaryBtn) {
    if (hasSecondary) {
      secondaryBtn.textContent = secondaryText;
      secondaryBtn.style.display = '';
    } else {
      secondaryBtn.style.display = 'none';
    }
  }

  const prevFocus = document.activeElement;

  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');

  const cleanup: (() => void)[] = [];
  const on = (target: EventTarget | null, type: string, handler: EventListener) => {
    if (!target) return;
    target.addEventListener(type, handler);
    cleanup.push(() => {
      try { target.removeEventListener(type, handler); } catch { /* ignore */ }
    });
  };

  _dialogActive = { resolve, prevFocus, cleanup };

  const done = (action: string) => closeDialog(action);

  on(overlay, 'click', (e) => {
    if (!dismissible) return;
    if (e.target === overlay) done('overlay');
  });

  on(okBtn, 'click', () => done('ok'));
  if (hasSecondary && secondaryBtn) {
    on(secondaryBtn, 'click', () => done('secondary'));
  }
  on(closeBtn, 'click', () => {
    if (!dismissible) return done('ok');
    done('close');
  });

  on(window, 'keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Escape') {
      if (!dismissible) return;
      ke.preventDefault();
      done('escape');
      return;
    }

    if (ke.key === 'Tab') {
      const focusables = [
        closeBtn,
        hasSecondary ? secondaryBtn : null,
        okBtn,
      ].filter((x): x is HTMLButtonElement => x != null && x.offsetParent !== null);
      if (focusables.length === 0) return;

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const activeEl = document.activeElement;

      if (ke.shiftKey) {
        if (activeEl === first || !overlay.contains(activeEl)) {
          ke.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last) {
          ke.preventDefault();
          first.focus();
        }
      }
    }
  });

  setTimeout(() => {
    try {
      const pick = (defaultFocus === 'secondary' && hasSecondary && secondaryBtn)
        ? secondaryBtn
        : (defaultFocus === 'close' ? closeBtn : okBtn);
      (pick || okBtn)!.focus();
    } catch { /* ignore */ }
  }, 0);
}

// ─── Public API ──────────────────────────────────────────────────

export function showDialog(opts: DialogOptions | string = {}): Promise<DialogResult> {
  return new Promise((resolve) => {
    _dialogQueue.push({ opts, resolve });
    drainDialogQueue();
  });
}

export function initDialog(): void {
  log.info('[Dialog] Initialized');
}
