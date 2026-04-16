/**
 * MUSIXQUARE — Dialog / Modal System
 *
 * Manages: Promise-based modal dialogs with queue, focus trap, a11y.
 */

import { log } from '../core/log.ts';
import { setManagedTimer } from '../core/timers.ts';
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
  inputField?: {
    placeholder?: string;
    defaultValue?: string;
    maxLength?: number;
    hint?: string;
    validator?: (value: string) => string | null;
  };
}

export interface DialogResult {
  action: string;
  inputValue?: string;
}

interface DialogActiveState {
  resolve: (result: DialogResult) => void;
  prevFocus: Element | null;
  cleanup: (() => void)[];
}

// ─── State ───────────────────────────────────────────────────────

let _dialogActive: DialogActiveState | null = null;
let _dialogInput: HTMLElement | null = null;
let _dialogHint: HTMLDivElement | null = null;
let _dialogValidator: ((value: string) => string | null) | null = null;
let _dialogHintDefault = '';
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

  const inputValue = _dialogInput ? (_dialogInput.textContent || '').trim() : undefined;
  _dialogInput = null;

  if (typeof active?.resolve === 'function') {
    try { active.resolve({ action, inputValue }); } catch { /* ignore */ }
  }

  setManagedTimer('dialog-drain', drainDialogQueue, 0);
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
    setManagedTimer('dialog-drain', drainDialogQueue, 0);
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

  // Input field support
  const inputCfg = (typeof opts === 'object' && opts) ? opts.inputField : undefined;
  if (inputCfg) {
    const input = document.createElement('div');
    input.contentEditable = 'true';
    input.className = 'dialog-input';
    input.setAttribute('role', 'textbox');
    if (inputCfg.placeholder) input.setAttribute('data-placeholder', inputCfg.placeholder);
    if (inputCfg.defaultValue) input.textContent = inputCfg.defaultValue;
    const maxLen = inputCfg.maxLength || 0;
    // Paste: plain text only
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') || '';
      document.execCommand('insertText', false, maxLen ? text.slice(0, maxLen) : text);
    });
    // Maxlength enforcement
    if (maxLen) {
      input.addEventListener('beforeinput', (e) => {
        if (e.inputType === 'insertCompositionText') return; // Don't break IME
        const current = (input.textContent || '').length;
        const sel = window.getSelection();
        const selectedLen = sel && sel.rangeCount ? sel.toString().length : 0;
        if (e.data && (current - selectedLen + e.data.length) > maxLen) e.preventDefault();
      });
    }
    msgEl.appendChild(input);
    _dialogInput = input;

    const hint = document.createElement('div');
    hint.className = 'dialog-hint';
    hint.textContent = inputCfg.hint || '';
    msgEl.appendChild(hint);
    _dialogHint = hint;
    _dialogHintDefault = inputCfg.hint || '';
    _dialogValidator = inputCfg.validator || null;
  } else {
    _dialogInput = null;
    _dialogHint = null;
    _dialogValidator = null;
    _dialogHintDefault = '';
  }

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

  const tryValidateAndClose = () => {
    if (_dialogValidator && _dialogInput) {
      const val = (_dialogInput.textContent || '').trim();
      const error = _dialogValidator(val);
      if (error) {
        // Show inline error
        if (_dialogHint) {
          _dialogHint.textContent = error;
          _dialogHint.classList.add('error');
        }
        _dialogInput.classList.add('invalid');
        _dialogInput.classList.remove('shake');
        // Force reflow to restart animation
        void _dialogInput.offsetWidth;
        _dialogInput.classList.add('shake');
        _dialogInput.addEventListener('animationend', () => {
          _dialogInput?.classList.remove('shake');
        }, { once: true });
        return;
      }
    }
    closeDialog('ok');
  };

  const clearInputError = () => {
    if (_dialogHint && _dialogHint.classList.contains('error')) {
      _dialogHint.textContent = _dialogHintDefault;
      _dialogHint.classList.remove('error');
    }
    _dialogInput?.classList.remove('invalid');
  };

  // Clear error on input change
  if (_dialogInput) {
    on(_dialogInput, 'input', () => clearInputError());
  }

  const done = (action: string) => closeDialog(action);

  on(overlay, 'click', (e) => {
    if (!dismissible || !_dialogActive) return;
    if (e.target === overlay) done('overlay');
  });

  on(okBtn, 'click', () => tryValidateAndClose());
  if (hasSecondary && secondaryBtn) {
    on(secondaryBtn, 'click', () => done('secondary'));
  }
  // Hide close button when dialog is not dismissible
  if (!dismissible) {
    closeBtn.style.display = 'none';
    cleanup.push(() => { closeBtn.style.display = ''; });
  }
  on(closeBtn, 'click', () => done('close'));

  // Enter key on input confirms dialog (with validation)
  if (_dialogInput) {
    on(_dialogInput, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        (e as KeyboardEvent).preventDefault();
        tryValidateAndClose();
      }
    });
  }

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
        _dialogInput as HTMLElement | null,
        hasSecondary ? secondaryBtn : null,
        okBtn,
      ].filter((x): x is HTMLElement => x != null && x.offsetParent !== null);
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
        if (activeEl === last || !overlay.contains(activeEl)) {
          ke.preventDefault();
          first.focus();
        }
      }
    }
  });

  setManagedTimer('dialog-focus', () => {
    try {
      if (_dialogInput) {
        _dialogInput.focus({ preventScroll: false, focusVisible: false } as FocusOptions);
        // Select all text in contenteditable
        const sel = window.getSelection();
        if (sel && _dialogInput.textContent) {
          const range = document.createRange();
          range.selectNodeContents(_dialogInput);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else {
        const pick = (defaultFocus === 'secondary' && hasSecondary && secondaryBtn)
          ? secondaryBtn
          : (defaultFocus === 'close' ? closeBtn : okBtn);
        (pick || okBtn)!.focus();
      }
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
