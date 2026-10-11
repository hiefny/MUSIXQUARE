/**
 * MUSIXQUARE — Dialog / Modal System
 *
 * Manages: Promise-based modal dialogs with queue, focus trap, a11y.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { showToast } from './toast.ts';
import { t } from '../i18n/index.ts';
import { syncOverlayState, normalizeEmptyContentEditable } from './dom.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';

// ─── Types ───────────────────────────────────────────────────────

/** Literal copy is stable; callbacks opt into refresh on locale changes. */
type DialogText = string | (() => string);

interface DialogOptions {
  title?: DialogText;
  message?: DialogText;
  buttonText?: DialogText;
  secondaryText?: DialogText;
  cancelText?: DialogText;
  dismissible?: boolean;
  defaultFocus?: 'primary' | 'secondary';
  /** Places primary then secondary on separate full-width rows. */
  actionLayout?: 'stacked';
  /** Runs synchronously inside the validated primary click/Enter gesture. */
  onPrimaryActivation?: () => void;
  /** Runs synchronously inside the secondary click/Enter gesture. */
  onSecondaryActivation?: () => void;
  /** Cancels a queued or active dialog without disturbing another dialog. */
  signal?: AbortSignal;
  inputField?: {
    placeholder?: DialogText;
    defaultValue?: string;
    maxLength?: number;
    inputMode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search';
    pattern?: string;
    autocomplete?: string;
    splitEvery?: number;
    separator?: string;
    hint?: DialogText;
    validator?: (value: string) => string | null;
    /** Keep significant whitespace for validators and the resolved value. */
    preserveWhitespace?: boolean;
  };
  /**
   * A second page with one required single choice. The first page's primary
   * action validates the input and shows this page in place; its secondary
   * action returns to the first page with the input kept, and its primary
   * action resolves `ok` with the input value and the checked `choiceValue`.
   */
  choiceStep?: {
    /** Replaces the dialog title while the page is shown. */
    title: DialogText;
    /** Radio group name; unique per document while the dialog is open. */
    name: string;
    defaultValue: string;
    options: ReadonlyArray<{ value: string; label: DialogText; detail?: DialogText }>;
    buttonText: DialogText;
    backText: DialogText;
  };
}

export interface DialogResult {
  action: string;
  inputValue?: string;
  /** The checked `choiceStep` value, read before the dialog is torn down. */
  choiceValue?: string;
}

interface DialogChoiceState {
  frame: HTMLElement;
  list: HTMLElement;
  radios: HTMLInputElement[];
  value: () => string | undefined;
  focusTarget: () => HTMLInputElement | null;
  refresh: () => void;
  updateEdges: () => void;
  destroy: () => void;
}

interface DialogActiveState {
  resolve: (result: DialogResult) => void;
  prevFocus: Element | null;
  cleanup: (() => void)[];
}

// ─── State ───────────────────────────────────────────────────────

let _dialogActive: DialogActiveState | null = null;
let _dialogInput: HTMLElement | null = null;
let _dialogInputFocusTarget: HTMLElement | null = null;
let _dialogInputValueGetter: (() => string) | null = null;
let _dialogHint: HTMLDivElement | null = null;
let _dialogValidator: ((value: string) => string | null) | null = null;
let _dialogHintDefault = '';
let _dialogPreserveWhitespace = false;
let _dialogChoice: DialogChoiceState | null = null;
const _dialogQueue: Array<{
  opts: DialogOptions | string;
  resolve: (result: DialogResult) => void;
}> = [];

// ─── Internal ────────────────────────────────────────────────────

function dialogText(text?: DialogText): string {
  return typeof text === 'function' ? text() : text || '';
}

function drainDialogQueue(): void {
  if (_dialogActive) return;
  const next = _dialogQueue.shift();
  if (!next) return;
  _openDialog(next.opts, next.resolve);
}

function setDialogInputInvalid(invalid: boolean): void {
  if (!_dialogInput) return;
  _dialogInput.setAttribute('aria-invalid', String(invalid));
  _dialogInput
    .querySelectorAll<HTMLElement>('input, [role="textbox"]')
    .forEach((input) => input.setAttribute('aria-invalid', String(invalid)));
}

export function closeDialog(action = 'close'): void {
  clearManagedTimer('dialog-focus');
  // Read the choice before cleanup or focus restoration can touch the radios.
  const choiceValue = _dialogChoice?.value();
  _dialogChoice = null;
  const overlay = document.getElementById('dialog-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    syncOverlayState();
  }

  const active = _dialogActive;
  _dialogActive = null;

  try {
    if (active && Array.isArray(active.cleanup)) {
      active.cleanup.forEach((fn) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      });
    }
  } catch {
    /* ignore */
  }

  if (active?.prevFocus && typeof (active.prevFocus as HTMLElement).focus === 'function') {
    try {
      (active.prevFocus as HTMLElement).focus();
    } catch {
      /* ignore */
    }
  }

  const rawInputValue = _dialogInputValueGetter
    ? _dialogInputValueGetter()
    : _dialogInput
      ? _dialogInput.textContent || ''
      : undefined;
  const inputValue =
    rawInputValue === undefined || _dialogPreserveWhitespace ? rawInputValue : rawInputValue.trim();
  _dialogInput = null;
  _dialogInputFocusTarget = null;
  _dialogInputValueGetter = null;
  _dialogPreserveWhitespace = false;

  if (typeof active?.resolve === 'function') {
    try {
      active.resolve({
        action,
        inputValue,
        ...(choiceValue === undefined ? {} : { choiceValue }),
      });
    } catch {
      /* ignore */
    }
  }

  setManagedTimer('dialog-drain', drainDialogQueue, 0);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// A stepped dialog reuses both action buttons in place ("Next" becomes "OK",
// "Back" sits where "Cancel" was). Ignore action activations this soon after
// a page swap, so a double click or double tap cannot press both.
const STEP_SWAP_ACTION_GUARD_MS = 400;

// Relative offset (css/style.css) that keeps a stepped panel's top edge still.
const STEP_OFFSET_PROPERTY = '--dialog-step-offset';

/** The language list's check mark, so both selection lists read the same. */
function createChoiceCheck(): HTMLSpanElement {
  const check = document.createElement('span');
  check.className = 'dialog-choice-check';
  check.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M5 12.5l4.2 4.2L19 6.9');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  check.appendChild(svg);
  return check;
}

/**
 * Builds the hidden choice page right after the message. Each row is a native
 * radio (one Tab stop, arrow keys, checked state for assistive technology)
 * that is visually replaced by a selectable surface with an end-edge check.
 */
function createDialogChoiceStep(
  anchor: HTMLElement,
  config: NonNullable<DialogOptions['choiceStep']>,
  titleId: string,
): DialogChoiceState | null {
  if (config.options.length === 0) return null;
  const frame = document.createElement('div');
  frame.className = 'dialog-choice-frame';
  frame.hidden = true;
  const list = document.createElement('div');
  list.className = 'dialog-choice-list';
  list.setAttribute('role', 'radiogroup');
  // The page title asks the question, so it names the group.
  if (titleId) list.setAttribute('aria-labelledby', titleId);
  const radios: HTMLInputElement[] = [];
  const texts: Array<{ node: HTMLElement; text: DialogText }> = [];
  config.options.forEach((option, index) => {
    const row = document.createElement('label');
    row.className = 'dialog-choice-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.className = 'dialog-choice-radio';
    radio.name = config.name;
    radio.value = option.value;
    radio.checked = option.value === config.defaultValue;
    const surface = document.createElement('span');
    surface.className = 'dialog-choice-surface';
    // The radio reads the label and the detail by reference; hiding the
    // painted copy keeps a screen reader's browse mode from reading it twice.
    surface.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'dialog-choice-text';
    const label = document.createElement('span');
    label.className = 'dialog-choice-label';
    label.id = `dialog-choice-label-${index}`;
    // The wrapping <label> keeps the whole row clickable, but its text would
    // also fold the detail into the name. Name the radio by its label only;
    // the detail stays its description.
    radio.setAttribute('aria-labelledby', label.id);
    copy.appendChild(label);
    texts.push({ node: label, text: option.label });
    if (option.detail !== undefined) {
      const detail = document.createElement('span');
      detail.className = 'dialog-choice-detail';
      detail.id = `dialog-choice-detail-${index}`;
      radio.setAttribute('aria-describedby', detail.id);
      copy.appendChild(detail);
      texts.push({ node: detail, text: option.detail });
    }
    surface.append(copy, createChoiceCheck());
    row.append(radio, surface);
    list.appendChild(row);
    radios.push(radio);
  });
  if (!radios.some((radio) => radio.checked)) radios[0]!.checked = true;
  const edgeTop = document.createElement('span');
  edgeTop.className = 'dialog-choice-edge dialog-choice-edge-top';
  edgeTop.setAttribute('aria-hidden', 'true');
  const edgeBottom = document.createElement('span');
  edgeBottom.className = 'dialog-choice-edge dialog-choice-edge-bottom';
  edgeBottom.setAttribute('aria-hidden', 'true');
  frame.append(list, edgeTop, edgeBottom);
  anchor.after(frame);

  const refresh = () => {
    for (const { node, text } of texts) {
      node.textContent = dialogText(text);
      applyUserTextFontFallback(node, node.textContent);
    }
  };
  refresh();

  // Short landscape viewports scroll the list between the fixed title and
  // actions; fade whichever end has more options, as the language list does.
  const updateEdges = () => {
    const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    const hasOverflow = maxScrollTop > 2;
    list.classList.toggle('can-scroll-up', hasOverflow && list.scrollTop > 2);
    list.classList.toggle('can-scroll-down', hasOverflow && list.scrollTop < maxScrollTop - 2);
  };
  list.addEventListener('scroll', updateEdges, { passive: true });
  window.addEventListener('resize', updateEdges);
  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => updateEdges()) : null;
  resizeObserver?.observe(list);

  const checked = () => radios.find((radio) => radio.checked) ?? null;
  return {
    frame,
    list,
    radios,
    value: () => checked()?.value,
    // A native radio group is one Tab stop: its checked radio.
    focusTarget: () => checked() ?? radios[0] ?? null,
    refresh,
    updateEdges,
    destroy: () => {
      list.removeEventListener('scroll', updateEdges);
      window.removeEventListener('resize', updateEdges);
      resizeObserver?.disconnect();
      frame.remove();
    },
  };
}

function _openDialog(opts: DialogOptions | string, resolve: (result: DialogResult) => void): void {
  if (typeof opts === 'object' && opts?.signal?.aborted) {
    resolve({ action: 'superseded' });
    setManagedTimer('dialog-drain', drainDialogQueue, 0);
    return;
  }
  const overlay = document.getElementById('dialog-overlay');
  const titleEl = document.getElementById('dialog-title');
  const msgEl = document.getElementById('dialog-message');
  const okBtn = document.getElementById('btn-dialog-ok') as HTMLButtonElement | null;
  const secondaryBtn = document.getElementById('btn-dialog-secondary') as HTMLButtonElement | null;

  if (!overlay || !titleEl || !msgEl || !okBtn) {
    showToast(typeof opts === 'string' ? opts : dialogText(opts?.message) || t('common.info'));
    resolve({ action: 'fallback' });
    setManagedTimer('dialog-drain', drainDialogQueue, 0);
    return;
  }

  const o = typeof opts === 'object' && opts ? opts : { message: String(opts ?? '') };
  const title = dialogText(o.title) || t('common.info');
  const message = dialogText(o.message);
  const buttonText = dialogText(o.buttonText) || t('common.ok');
  const secondaryTextRaw =
    o.secondaryText !== undefined && o.secondaryText !== null
      ? o.secondaryText
      : o.cancelText !== undefined && o.cancelText !== null
        ? o.cancelText
        : '';
  const secondaryText = dialogText(secondaryTextRaw).trim();
  const hasSecondary = !!secondaryText;
  const dismissible = o.dismissible === true;
  const defaultFocus = o.defaultFocus
    ? String(o.defaultFocus)
    : hasSecondary
      ? 'secondary'
      : 'primary';

  // These elements become runtime-owned once a dialog opens. Static bootstrap
  // translation keys must not overwrite custom copy when action rows move or
  // the i18n observer translates a newly inserted element.
  titleEl.removeAttribute('data-i18n');
  okBtn.removeAttribute('data-i18n');
  secondaryBtn?.removeAttribute('data-i18n');
  titleEl.textContent = title;
  msgEl.hidden = false;
  msgEl.textContent = message;
  // Keep the message separate so locale refresh never rebuilds the editor.
  const messageNode = document.createTextNode(message);
  msgEl.replaceChildren(messageNode);
  applyUserTextFontFallback(titleEl, title);
  applyUserTextFontFallback(msgEl, message);

  // Input field support
  const inputCfg = typeof opts === 'object' && opts ? opts.inputField : undefined;
  const placeholder = dialogText(inputCfg?.placeholder);
  if (inputCfg) {
    _dialogPreserveWhitespace = inputCfg.preserveWhitespace === true;
    const maxLen = inputCfg.maxLength || 0;
    const splitEvery = inputCfg.splitEvery || 0;
    if (maxLen > 0 && splitEvery > 0 && splitEvery < maxLen) {
      const group = document.createElement('div');
      group.className = 'dialog-input-split';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', placeholder || title);

      const inputs: HTMLInputElement[] = [];
      const separator = inputCfg.separator ?? '-';
      const initialDigits = (inputCfg.defaultValue || '').replace(/\D+/g, '').slice(0, maxLen);
      const distributeDigits = (digits: string) => {
        let offset = 0;
        inputs.forEach((input) => {
          input.value = digits.slice(offset, offset + splitEvery);
          offset += splitEvery;
        });
      };
      const focusByLength = (digits: string) => {
        const index = Math.min(
          inputs.length - 1,
          Math.floor(Math.max(0, digits.length - 1) / splitEvery),
        );
        inputs[index]?.focus();
      };

      for (let offset = 0; offset < maxLen; offset += splitEvery) {
        const index = inputs.length;
        const size = Math.min(splitEvery, maxLen - offset);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'dialog-input-segment';
        // The two segments form one logical PIN. Per-segment clear buttons
        // compete with four digits in a compact field and imply the wrong
        // clearing scope, so keep the group on its native editing controls.
        input.dataset.clearable = 'false';
        input.inputMode = inputCfg.inputMode || 'text';
        input.maxLength = size;
        if (inputCfg.pattern) input.pattern = inputCfg.pattern;
        if (inputCfg.autocomplete) input.setAttribute('autocomplete', inputCfg.autocomplete);
        input.setAttribute('aria-label', `${placeholder || title} ${index + 1}`);

        input.addEventListener('beforeinput', (e) => {
          if (e.inputType === 'insertCompositionText') return;
          if (inputCfg.inputMode === 'numeric' && e.data && /\D/.test(e.data)) e.preventDefault();
        });
        input.addEventListener('input', () => {
          const digits = input.value.replace(/\D+/g, '').slice(0, size);
          if (input.value !== digits) input.value = digits;
          if (digits.length >= size) inputs[index + 1]?.focus();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && input.value.length === 0 && index > 0) {
            e.preventDefault();
            inputs[index - 1]?.focus();
          }
        });
        input.addEventListener('paste', (e) => {
          e.preventDefault();
          const digits = (e.clipboardData?.getData('text/plain') || '')
            .replace(/\D+/g, '')
            .slice(0, maxLen);
          distributeDigits(digits);
          focusByLength(digits);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        inputs.push(input);
        group.appendChild(input);
        if (offset + size < maxLen) {
          const sep = document.createElement('span');
          sep.className = 'dialog-input-separator';
          sep.textContent = separator;
          group.appendChild(sep);
        }
      }

      if (initialDigits) distributeDigits(initialDigits);

      msgEl.appendChild(group);
      _dialogInput = group;
      _dialogInputFocusTarget = inputs[0] || group;
      _dialogInputValueGetter = () => inputs.map((input) => input.value).join('');
    } else {
      const input = document.createElement('div');
      input.contentEditable = 'true';
      input.className = 'dialog-input';
      input.dir = 'auto';
      input.setAttribute('role', 'textbox');
      input.setAttribute('aria-label', placeholder || title);
      if (placeholder) input.setAttribute('data-placeholder', placeholder);
      if (inputCfg.inputMode) input.setAttribute('inputmode', inputCfg.inputMode);
      if (inputCfg.pattern) input.setAttribute('pattern', inputCfg.pattern);
      if (inputCfg.autocomplete) input.setAttribute('autocomplete', inputCfg.autocomplete);
      if (inputCfg.defaultValue) input.textContent = inputCfg.defaultValue;
      applyUserTextFontFallback(input, inputCfg.defaultValue || '');
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') || '';
        document.execCommand('insertText', false, maxLen ? text.slice(0, maxLen) : text);
      });
      // Stray-<br> placeholder restore — shared helper, see dom.ts.
      input.addEventListener('input', (e) => {
        normalizeEmptyContentEditable(input, e);
        applyUserTextFontFallback(input, input.textContent || '');
      });
      if (maxLen) {
        input.addEventListener('beforeinput', (e) => {
          if (e.inputType === 'insertCompositionText') return; // Don't break IME
          const current = (input.textContent || '').length;
          const sel = window.getSelection();
          const selectedLen = sel && sel.rangeCount ? sel.toString().length : 0;
          if (e.data && current - selectedLen + e.data.length > maxLen) e.preventDefault();
        });
      }
      msgEl.appendChild(input);
      _dialogInput = input;
      _dialogInputFocusTarget = input;
      _dialogInputValueGetter = () => input.textContent || '';
    }

    const hint = document.createElement('div');
    hint.id = 'dialog-input-hint';
    hint.className = 'dialog-hint';
    hint.setAttribute('aria-live', 'polite');
    hint.setAttribute('aria-atomic', 'true');
    hint.textContent = dialogText(inputCfg.hint);
    applyUserTextFontFallback(hint, hint.textContent);
    msgEl.appendChild(hint);
    _dialogInput?.setAttribute('aria-describedby', hint.id);
    _dialogInput
      ?.querySelectorAll<HTMLElement>('input, [role="textbox"]')
      .forEach((input) => input.setAttribute('aria-describedby', hint.id));
    setDialogInputInvalid(false);
    _dialogHint = hint;
    _dialogHintDefault = dialogText(inputCfg.hint);
    _dialogValidator = inputCfg.validator || null;
  } else {
    _dialogInput = null;
    _dialogInputFocusTarget = null;
    _dialogInputValueGetter = null;
    _dialogHint = null;
    _dialogValidator = null;
    _dialogHintDefault = '';
    _dialogPreserveWhitespace = false;
  }

  const stepCfg = typeof opts === 'object' && opts ? opts.choiceStep : undefined;
  const choice = stepCfg ? createDialogChoiceStep(msgEl, stepCfg, titleEl.id) : null;
  _dialogChoice = choice;
  let choicePageShown = false;
  // The choice page has no message, so it drops the description while shown.
  const dialogPanel = msgEl.closest<HTMLElement>('[role="dialog"]');
  dialogPanel?.setAttribute('aria-describedby', msgEl.id);

  okBtn.textContent = buttonText;

  if (secondaryBtn) {
    // The static markup uses the HTML5 `hidden` attribute to avoid inline
    // styles. User-agent CSS resolves `[hidden] { display: none }`, so a
    // bare `style.display = ''` doesn't show the button — the attribute is
    // still on. Toggle the property directly; that removes the attribute and
    // also clears any stale inline display from earlier dialogs.
    secondaryBtn.hidden = !hasSecondary;
    if (hasSecondary) {
      secondaryBtn.textContent = secondaryText;
    }
  }

  const prevFocus = document.activeElement;

  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState('dialog-overlay');

  const cleanup: (() => void)[] = [];
  const stackedActions = o.actionLayout === 'stacked';
  const actions = okBtn.closest('.dialog-actions');
  if (stackedActions && actions) {
    actions.classList.add('dialog-actions-stacked');
    cleanup.push(() => actions.classList.remove('dialog-actions-stacked'));
    if (secondaryBtn?.parentElement === actions && okBtn.parentElement === actions) {
      // Keep keyboard and screen-reader order aligned with the visible rows.
      const originalNextSibling = okBtn.nextSibling;
      actions.insertBefore(okBtn, secondaryBtn);
      cleanup.push(() => actions.insertBefore(okBtn, originalNextSibling));
    }
  }
  const on = (target: EventTarget | null, type: string, handler: EventListener) => {
    if (!target) return;
    target.addEventListener(type, handler);
    cleanup.push(() => {
      try {
        target.removeEventListener(type, handler);
      } catch {
        /* ignore */
      }
    });
  };

  _dialogActive = { resolve, prevFocus, cleanup };

  // The centred panel would re-centre when the taller choice page replaces
  // the first page, moving the title up. Keep its top edge where the first
  // page put it instead, so the title stays in place and the page grows
  // downwards; where the viewport is too short for that, move up only as far
  // as needed to keep the whole panel inside the overlay. A resize or locale
  // change re-centres it, and the next swap anchors again.
  let stepAnchorTop: number | null = null;
  const resetStepOffset = () => {
    stepAnchorTop = null;
    dialogPanel?.style.removeProperty(STEP_OFFSET_PROPERTY);
  };
  const anchorStepPanel = () => {
    // Layout offsets, not client rects: the slide-in transform may still run.
    if (dialogPanel && stepAnchorTop === null) stepAnchorTop = dialogPanel.offsetTop;
  };
  const alignStepPanel = () => {
    if (!dialogPanel || stepAnchorTop === null) return;
    dialogPanel.style.removeProperty(STEP_OFFSET_PROPERTY);
    const overlayStyle = getComputedStyle(overlay);
    const minTop = parseFloat(overlayStyle.paddingTop) || 0;
    const maxTop =
      overlay.clientHeight -
      (parseFloat(overlayStyle.paddingBottom) || 0) -
      dialogPanel.offsetHeight;
    const top = Math.min(Math.max(stepAnchorTop, minTop), Math.max(minTop, maxTop));
    const offset = Math.round(top - dialogPanel.offsetTop);
    if (offset !== 0) dialogPanel.style.setProperty(STEP_OFFSET_PROPERTY, `${offset}px`);
  };

  if (choice) {
    // Both pages share the short-viewport spacing, so the title keeps its
    // offset inside the panel.
    overlay.classList.add('dialog-stepped');
    cleanup.push(() => {
      overlay.classList.remove('dialog-stepped');
      resetStepOffset();
      choice.destroy();
      msgEl.hidden = false;
      dialogPanel?.setAttribute('aria-describedby', msgEl.id);
    });
    on(window, 'resize', resetStepOffset);
  }

  // The choice page swaps the title and both actions in place; the first
  // page keeps the caller's copy.
  const pageTitle = () =>
    choicePageShown && stepCfg
      ? dialogText(stepCfg.title)
      : dialogText(o.title) || t('common.info');
  const pagePrimaryText = () =>
    (choicePageShown && stepCfg ? dialogText(stepCfg.buttonText) : dialogText(o.buttonText)) ||
    t('common.ok');
  const pageSecondaryText = () =>
    (choicePageShown && stepCfg
      ? dialogText(stepCfg.backText)
      : dialogText(secondaryTextRaw)
    ).trim();
  const secondaryShown = () => !!secondaryBtn && !secondaryBtn.hidden;
  const applyPageCopy = () => {
    const currentTitle = pageTitle();
    titleEl.textContent = currentTitle;
    applyUserTextFontFallback(titleEl, currentTitle);
    okBtn.textContent = pagePrimaryText();
    if (secondaryBtn) {
      const currentSecondary = pageSecondaryText();
      secondaryBtn.hidden = !currentSecondary;
      if (currentSecondary) secondaryBtn.textContent = currentSecondary;
    }
  };

  cleanup.push(
    bus.on('i18n:changed', () => {
      applyPageCopy();
      const inputTitle = dialogText(o.title) || t('common.info');
      messageNode.textContent = dialogText(o.message);
      applyUserTextFontFallback(msgEl, messageNode.textContent || '');
      if (_dialogInput && inputCfg) {
        const currentPlaceholder = dialogText(inputCfg.placeholder);
        _dialogInput.setAttribute('aria-label', currentPlaceholder || inputTitle);
        if (_dialogInput.classList.contains('dialog-input')) {
          if (currentPlaceholder) _dialogInput.setAttribute('data-placeholder', currentPlaceholder);
          else _dialogInput.removeAttribute('data-placeholder');
        }
        _dialogInput.querySelectorAll('.dialog-input-segment').forEach((input, index) => {
          input.setAttribute('aria-label', `${currentPlaceholder || inputTitle} ${index + 1}`);
        });
        _dialogHintDefault = dialogText(inputCfg.hint);
        if (_dialogHint) {
          const rawValue = _dialogInputValueGetter?.() || '';
          const value = _dialogPreserveWhitespace ? rawValue : rawValue.trim();
          _dialogHint.textContent =
            (_dialogHint.classList.contains('error') ? _dialogValidator?.(value) : null) ||
            _dialogHintDefault;
          applyUserTextFontFallback(_dialogHint, _dialogHint.textContent);
        }
      }
      if (choice) {
        choice.refresh();
        resetStepOffset();
        choice.updateEdges();
      }
    }),
  );
  if (o.signal) {
    on(o.signal, 'abort', () => {
      if (_dialogActive?.resolve === resolve) closeDialog('superseded');
    });
  }

  const validateInput = (): boolean => {
    if (!_dialogValidator || !_dialogInput) return true;
    const rawValue = _dialogInputValueGetter
      ? _dialogInputValueGetter()
      : _dialogInput.textContent || '';
    const val = _dialogPreserveWhitespace ? rawValue : rawValue.trim();
    const error = _dialogValidator(val);
    if (!error) return true;
    // Show inline error
    if (_dialogHint) {
      _dialogHint.textContent = error;
      applyUserTextFontFallback(_dialogHint, error);
      _dialogHint.classList.add('error');
    }
    _dialogInput.classList.add('invalid');
    setDialogInputInvalid(true);
    _dialogInput.classList.remove('shake');
    // Force reflow to restart animation
    void _dialogInput.offsetWidth;
    _dialogInput.classList.add('shake');
    _dialogInput.addEventListener(
      'animationend',
      () => {
        _dialogInput?.classList.remove('shake');
      },
      { once: true },
    );
    return false;
  };

  let pageSwappedAt = Number.NEGATIVE_INFINITY;
  const justSwappedPage = () =>
    choice !== null && Date.now() - pageSwappedAt < STEP_SWAP_ACTION_GUARD_MS;

  const resetPageScroll = () => {
    (dialogPanel ?? overlay).scrollTop = 0;
    if (choice) choice.list.scrollTop = 0;
  };

  // A pointer activation must not paint a keyboard ring on the checked row
  // (iOS keeps focus-visible from the PIN input). The next key, or focus
  // leaving the group, restores the normal ring.
  const suppressPointerFocusRing = () => {
    if (!choice) return;
    const { list } = choice;
    list.classList.add('dialog-choice-pointer-focus');
    const restore = () => {
      list.classList.remove('dialog-choice-pointer-focus');
      list.removeEventListener('focusout', restore);
      overlay.removeEventListener('keydown', restore, true);
    };
    list.addEventListener('focusout', restore);
    overlay.addEventListener('keydown', restore, true);
    cleanup.push(restore);
  };

  const showChoicePage = (viaPointer: boolean) => {
    if (!choice) return;
    choicePageShown = true;
    pageSwappedAt = Date.now();
    anchorStepPanel();
    msgEl.hidden = true;
    choice.frame.hidden = false;
    dialogPanel?.removeAttribute('aria-describedby');
    applyPageCopy();
    alignStepPanel();
    resetPageScroll();
    choice.updateEdges();
    const target = choice.focusTarget();
    if (!target) return;
    if (viaPointer) suppressPointerFocusRing();
    target.focus();
  };

  const showInputPage = () => {
    if (!choice) return;
    choicePageShown = false;
    pageSwappedAt = Date.now();
    choice.frame.hidden = true;
    msgEl.hidden = false;
    dialogPanel?.setAttribute('aria-describedby', msgEl.id);
    applyPageCopy();
    alignStepPanel();
    resetPageScroll();
    const target = (_dialogInputFocusTarget || _dialogInput || okBtn) as HTMLElement;
    target.focus({ preventScroll: true });
  };

  const activatePrimary = (viaPointer = false) => {
    if (justSwappedPage()) return;
    if (!choicePageShown && !validateInput()) return;
    if (choice && !choicePageShown) {
      showChoicePage(viaPointer);
      return;
    }
    try {
      o.onPrimaryActivation?.();
    } catch (error) {
      // Activation hooks prime optional browser capabilities. A browser API
      // failure must not trap the user in an otherwise valid dialog.
      log.debug('[Dialog] Primary activation hook failed:', error);
    }
    closeDialog('ok');
  };

  const clearInputError = () => {
    if (_dialogHint && _dialogHint.classList.contains('error')) {
      _dialogHint.textContent = _dialogHintDefault;
      applyUserTextFontFallback(_dialogHint, _dialogHintDefault);
      _dialogHint.classList.remove('error');
    }
    _dialogInput?.classList.remove('invalid');
    setDialogInputInvalid(false);
  };

  // Clear error on input change
  if (_dialogInput) {
    on(_dialogInput, 'input', () => clearInputError());
  }

  const done = (action: string) => closeDialog(action);
  const activateSecondary = () => {
    if (justSwappedPage()) return;
    if (choicePageShown) {
      showInputPage();
      return;
    }
    try {
      o.onSecondaryActivation?.();
    } catch (error) {
      log.debug('[Dialog] Secondary activation hook failed:', error);
    }
    done('secondary');
  };

  on(overlay, 'click', (e) => {
    if (!dismissible || !_dialogActive) return;
    if (e.target === overlay) done('overlay');
  });

  if (choice) {
    // The taller choice page moves the actions down, so the second press of a
    // double press on Next can land on a row instead of OK. Keep the default
    // then. Arrow keys fire clicks with no pointer detail; they stay immediate.
    on(choice.list, 'click', (e) => {
      if (justSwappedPage() && (e as MouseEvent).detail > 0) e.preventDefault();
    });
  }
  on(okBtn, 'click', (e) => activatePrimary((e as MouseEvent).detail > 0));
  if ((hasSecondary || choice) && secondaryBtn) {
    on(secondaryBtn, 'click', activateSecondary);
  }

  // Enter key on input confirms dialog (with validation)
  if (_dialogInput) {
    on(_dialogInput, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.isComposing || ke.keyCode === 229) return;
      if (ke.key === 'Enter') {
        ke.preventDefault();
        // A held Enter must not run on into the next page's OK.
        if (choice && ke.repeat) return;
        activatePrimary();
      }
    });
  }

  on(window, 'keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.defaultPrevented || overlay.hasAttribute('inert')) return;
    if (ke.isComposing || ke.keyCode === 229) return;
    if (ke.key === 'Escape') {
      // A stepped dialog closes on Escape from either page, like the language
      // list; nothing is applied until its final primary action.
      if (!dismissible && !choice) return;
      ke.preventDefault();
      done('escape');
      return;
    }

    if (ke.key === 'Enter') {
      if (choice && ke.repeat) {
        ke.preventDefault();
        return;
      }
      const focused = document.activeElement;
      if (
        choicePageShown &&
        choice &&
        focused instanceof HTMLInputElement &&
        choice.radios.includes(focused)
      ) {
        // A radio has no Enter behavior of its own: confirm the choice.
        ke.preventDefault();
        activatePrimary();
      } else if (focused === okBtn && !okBtn.disabled) {
        ke.preventDefault();
        activatePrimary();
      } else if (
        secondaryShown() &&
        secondaryBtn &&
        focused === secondaryBtn &&
        !secondaryBtn.disabled
      ) {
        ke.preventDefault();
        activateSecondary();
      }
      return;
    }

    if (ke.key === 'Tab') {
      const secondary = secondaryShown() ? secondaryBtn : null;
      const actionButtons = stackedActions ? [okBtn, secondary] : [secondary, okBtn];
      const pageTarget =
        choicePageShown && choice
          ? choice.focusTarget()
          : ((_dialogInputFocusTarget || _dialogInput) as HTMLElement | null);
      const focusables = [pageTarget, ...actionButtons].filter(
        (x): x is HTMLElement => x != null && x.offsetParent !== null,
      );
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

  setManagedTimer(
    'dialog-focus',
    () => {
      if (_dialogActive?.resolve !== resolve) return;
      try {
        if (_dialogInput) {
          const focusTarget = _dialogInputFocusTarget || _dialogInput;
          focusTarget.focus({ preventScroll: false, focusVisible: false } as FocusOptions);
          if (focusTarget instanceof HTMLInputElement) {
            focusTarget.select();
          } else {
            // Select all text in contenteditable
            const sel = window.getSelection();
            if (sel && _dialogInput.textContent) {
              const range = document.createRange();
              range.selectNodeContents(_dialogInput);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        } else {
          const pick =
            defaultFocus === 'secondary' && hasSecondary && secondaryBtn ? secondaryBtn : okBtn;
          (pick || okBtn)!.focus();
        }
      } catch {
        /* ignore */
      }
    },
    0,
  );
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
