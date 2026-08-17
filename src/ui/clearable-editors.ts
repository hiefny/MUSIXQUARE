/**
 * Page-wide clear affordances for editable text controls.
 *
 * The buttons are out-of-flow siblings of their editors. Keeping them beside
 * the editor in the DOM preserves modal/accessibility ownership, while
 * viewport-to-offset-parent positioning keeps them visually attached through
 * scrolling and translated dialog/drawer animations.
 */

import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';

const EDITOR_SELECTOR = 'input, textarea, [contenteditable]';
const BUTTON_CLASS = 'clearable-editor-button';
const ACTIVE_CLASS = 'clearable-editor-active';
const CENTERED_CLASS = 'clearable-editor-centered';
const BASE_PADDING_START_PROPERTY = '--clearable-editor-base-padding-inline-start';
const BASE_PADDING_END_PROPERTY = '--clearable-editor-base-padding-inline-end';
const RESERVED_SPACE_PROPERTY = '--clearable-editor-reserved-space';
const CLEAR_LABEL_KEY = 'common.clear_input';
const BUTTON_SIZE = 44;
const FULL_RESERVATION = 48;
const NARROW_RESERVATION = 28;
const NARROW_EDITOR_WIDTH = 176;

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url']);

type ClearableEditor = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

interface EditorEntry {
  button: HTMLButtonElement;
  editor: ClearableEditor;
  generatedId: string | null;
}

interface ClearableEditorsController {
  refresh(): void;
  destroy(): void;
}

let generatedEditorId = 0;

function isHtmlElement(element: Element): element is HTMLElement {
  const Constructor = element.ownerDocument.defaultView?.HTMLElement;
  return Constructor ? element instanceof Constructor : element instanceof HTMLElement;
}

function isInputElement(element: Element): element is HTMLInputElement {
  const Constructor = element.ownerDocument.defaultView?.HTMLInputElement;
  return Constructor ? element instanceof Constructor : element instanceof HTMLInputElement;
}

function isTextAreaElement(element: Element): element is HTMLTextAreaElement {
  const Constructor = element.ownerDocument.defaultView?.HTMLTextAreaElement;
  return Constructor ? element instanceof Constructor : element instanceof HTMLTextAreaElement;
}

function isContentEditor(element: Element): element is HTMLElement {
  if (!isHtmlElement(element)) return false;
  const value = (element.getAttribute('contenteditable') ?? '').toLowerCase();
  return value === '' || value === 'true' || value === 'plaintext-only';
}

function isClearableEditor(element: Element): element is ClearableEditor {
  if (element.getAttribute('data-clearable') === 'false') return false;
  if (
    element.closest('[inert], [aria-hidden="true"], [data-disabled="true"], [aria-disabled="true"]')
  ) {
    return false;
  }
  if (element.getAttribute('aria-readonly') === 'true') return false;

  if (isInputElement(element)) {
    return !element.matches(':disabled') && !element.readOnly && TEXT_INPUT_TYPES.has(element.type);
  }

  if (isTextAreaElement(element)) {
    return !element.matches(':disabled') && !element.readOnly;
  }

  return isContentEditor(element);
}

function editorCandidate(element: Element): ClearableEditor | null {
  return element.matches(EDITOR_SELECTOR) && isHtmlElement(element)
    ? (element as ClearableEditor)
    : null;
}

function editorText(editor: ClearableEditor): string {
  if (isInputElement(editor) || isTextAreaElement(editor)) return editor.value;
  return editor.textContent ?? '';
}

function editorFromEventTarget(target: EventTarget | null): ClearableEditor | null {
  if (!(target instanceof Element)) return null;
  const candidate = target.matches(EDITOR_SELECTOR) ? target : target.closest(EDITOR_SELECTOR);
  return candidate ? editorCandidate(candidate) : null;
}

function dispatchEditingEvent(editor: ClearableEditor, type: 'input' | 'change'): void {
  const view = editor.ownerDocument.defaultView;
  if (type === 'input' && view?.InputEvent) {
    try {
      editor.dispatchEvent(
        new view.InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'deleteContentBackward',
          data: null,
        }),
      );
      return;
    } catch {
      // Embedded browsers can expose InputEvent without supporting its options.
    }
  }

  const EventConstructor = view?.Event ?? Event;
  editor.dispatchEvent(new EventConstructor(type, { bubbles: true, composed: true }));
}

function focusWithoutScrolling(editor: ClearableEditor): void {
  try {
    editor.focus({ preventScroll: true });
  } catch {
    editor.focus();
  }
}

function clearEditor(editor: ClearableEditor): void {
  if (!isClearableEditor(editor)) return;

  focusWithoutScrolling(editor);
  if (isInputElement(editor) || isTextAreaElement(editor)) {
    editor.value = '';
  } else {
    editor.replaceChildren();
  }

  dispatchEditingEvent(editor, 'input');
  dispatchEditingEvent(editor, 'change');
}

function underlyingElementAtPoint(
  ownerDocument: Document,
  button: HTMLButtonElement,
  x: number,
  y: number,
): Element | null {
  const hitTest = ownerDocument.elementFromPoint;
  if (typeof hitTest !== 'function') return null;

  // The clear button can cover the editor's center on compact fields. Exclude
  // it from this one hit test so it cannot hide itself or mask a real overlay.
  const previousPointerEvents = button.style.pointerEvents;
  button.style.pointerEvents = 'none';
  try {
    return hitTest.call(ownerDocument, x, y);
  } finally {
    if (previousPointerEvents) button.style.pointerEvents = previousPointerEvents;
    else button.style.removeProperty('pointer-events');
  }
}

function isVisuallyAvailable(
  editor: ClearableEditor,
  button: HTMLButtonElement,
  rect: DOMRect,
  style: CSSStyleDeclaration,
): boolean {
  if (!editor.isConnected || rect.width <= 0 || rect.height <= 0) return false;
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse'
  ) {
    return false;
  }

  const view = editor.ownerDocument.defaultView;
  if (!view) return false;
  const viewportWidth = view.innerWidth || editor.ownerDocument.documentElement.clientWidth;
  const viewportHeight = view.innerHeight || editor.ownerDocument.documentElement.clientHeight;
  if (
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= viewportWidth ||
    rect.top >= viewportHeight
  ) {
    return false;
  }

  // Do not let a control behind a dialog/backdrop leak its clear button above
  // that overlay. The button is temporarily excluded from hit testing above.
  const x = Math.max(0, Math.min(viewportWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(viewportHeight - 1, rect.top + rect.height / 2));
  const topElement = underlyingElementAtPoint(editor.ownerDocument, button, x, y);
  return !topElement || topElement === editor || editor.contains(topElement);
}

function updateButtonLabel(button: HTMLButtonElement): void {
  const label = t(CLEAR_LABEL_KEY);
  button.setAttribute('aria-label', label);
  button.title = label;
}

function nextAvailableEditorId(ownerDocument: Document): string {
  let id: string;
  do {
    generatedEditorId += 1;
    id = `clearable-editor-${generatedEditorId}`;
  } while (ownerDocument.getElementById(id));
  return id;
}

function setButtonViewportPosition(
  button: HTMLButtonElement,
  viewportLeft: number,
  viewportTop: number,
  renderedSize: number,
): void {
  // Absolute positioning keeps an adjacent button in the editor's modal and
  // accessibility tree. Convert viewport coordinates into its actual CSS
  // containing block, including translated/scaled ancestors and nested scroll.
  button.style.position = 'absolute';
  const offsetParent = button.offsetParent;
  if (!(offsetParent instanceof HTMLElement)) {
    // jsdom and unusual display trees may not expose an offset parent. Fixed
    // viewport coordinates remain a safe visual fallback.
    button.style.position = 'fixed';
    button.style.left = `${Math.round(viewportLeft)}px`;
    button.style.top = `${Math.round(viewportTop)}px`;
    button.style.width = `${renderedSize}px`;
    button.style.height = `${renderedSize}px`;
    return;
  }

  const parentRect = offsetParent.getBoundingClientRect();
  const scaleX =
    offsetParent.offsetWidth > 0 && parentRect.width > 0
      ? parentRect.width / offsetParent.offsetWidth
      : 1;
  const scaleY =
    offsetParent.offsetHeight > 0 && parentRect.height > 0
      ? parentRect.height / offsetParent.offsetHeight
      : 1;
  const originLeft = parentRect.left + offsetParent.clientLeft * scaleX;
  const originTop = parentRect.top + offsetParent.clientTop * scaleY;
  const localLeft = (viewportLeft - originLeft) / scaleX + offsetParent.scrollLeft;
  const localTop = (viewportTop - originTop) / scaleY + offsetParent.scrollTop;

  button.style.left = `${Math.round(localLeft)}px`;
  button.style.top = `${Math.round(localTop)}px`;
  button.style.width = `${Math.round(renderedSize / scaleX)}px`;
  button.style.height = `${Math.round(renderedSize / scaleY)}px`;
}

function createClearableEditorsController(
  ownerDocument: Document = document,
): ClearableEditorsController {
  const view = ownerDocument.defaultView;
  const entries = new Map<ClearableEditor, EditorEntry>();
  const pendingEditors = new Set<ClearableEditor>();
  let destroyed = false;
  let frameId: number | null = null;
  let frameUsesAnimation = false;
  let refreshExistingEntries = false;
  let trackMotionUntil = 0;

  function queueEditor(editor: ClearableEditor): void {
    if (destroyed) return;
    pendingEditors.add(editor);
    scheduleFrame();
  }

  const resizeObserver =
    view && typeof view.ResizeObserver === 'function'
      ? new view.ResizeObserver((records) => {
          records.forEach(({ target }) => {
            const editor = editorCandidate(target);
            if (editor) queueEditor(editor);
          });
        })
      : null;

  function removeEntry(editor: ClearableEditor): void {
    const entry = entries.get(editor);
    if (!entry) return;
    entries.delete(editor);
    resizeObserver?.unobserve(editor);
    entry.button.remove();
    editor.classList.remove(ACTIVE_CLASS, CENTERED_CLASS);
    editor.style.removeProperty(BASE_PADDING_START_PROPERTY);
    editor.style.removeProperty(BASE_PADDING_END_PROPERTY);
    editor.style.removeProperty(RESERVED_SPACE_PROPERTY);
    if (entry.generatedId && editor.id === entry.generatedId) editor.removeAttribute('id');
  }

  function ensureButtonAssociation(entry: EditorEntry): void {
    const { button, editor } = entry;
    if (entry.generatedId && editor.id !== entry.generatedId) entry.generatedId = null;
    if (!editor.id) {
      entry.generatedId = nextAvailableEditorId(ownerDocument);
      editor.id = entry.generatedId;
    }
    button.setAttribute('aria-controls', editor.id);

    // Keep the actionable control beside its editor in both DOM and modal
    // accessibility ownership. position:absolute keeps it out of layout.
    if (button.previousElementSibling !== editor) editor.insertAdjacentElement('afterend', button);
  }

  function createEntry(editor: ClearableEditor): EditorEntry {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.dataset.clearableEditorButton = '';
    button.dataset.i18nAriaLabel = CLEAR_LABEL_KEY;
    button.dataset.i18nTitle = CLEAR_LABEL_KEY;
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z"/></svg>';
    updateButtonLabel(button);

    button.addEventListener('pointerdown', (event) => {
      // Keep the caret/virtual keyboard attached to the editor while tapping X.
      event.preventDefault();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearEditor(editor);
      syncEditor(editor);
    });

    const computedStyle = view?.getComputedStyle(editor);
    editor.style.setProperty(
      BASE_PADDING_START_PROPERTY,
      computedStyle?.paddingInlineStart || '0px',
    );
    editor.style.setProperty(BASE_PADDING_END_PROPERTY, computedStyle?.paddingInlineEnd || '0px');

    const entry: EditorEntry = { button, editor, generatedId: null };
    entries.set(editor, entry);
    ensureButtonAssociation(entry);
    resizeObserver?.observe(editor);
    return entry;
  }

  function positionEntry(entry: EditorEntry): void {
    const { button, editor } = entry;
    ensureButtonAssociation(entry);
    const rect = editor.getBoundingClientRect();
    if (!view) {
      button.hidden = true;
      editor.classList.remove(ACTIVE_CLASS);
      return;
    }

    const style = view.getComputedStyle(editor);
    const visible = isVisuallyAvailable(editor, button, rect, style);
    button.hidden = !visible;
    editor.classList.toggle(ACTIVE_CLASS, visible);
    editor.classList.toggle(CENTERED_CLASS, style.textAlign === 'center');
    if (!visible) return;

    const narrow = rect.width < NARROW_EDITOR_WIDTH;
    const inside = narrow ? BUTTON_SIZE / 2 + 2 : BUTTON_SIZE;
    const reservation = narrow ? NARROW_RESERVATION : FULL_RESERVATION;
    editor.style.setProperty(RESERVED_SPACE_PROPERTY, `${reservation}px`);

    const left =
      style.direction === 'rtl' ? rect.left - (BUTTON_SIZE - inside) : rect.right - inside;
    const viewportHeight = view.innerHeight || ownerDocument.documentElement.clientHeight;
    const rawTop = rect.top + (rect.height - BUTTON_SIZE) / 2;
    const top = Math.max(0, Math.min(Math.max(0, viewportHeight - BUTTON_SIZE), rawTop));
    setButtonViewportPosition(button, left, top, BUTTON_SIZE);
  }

  function syncEditor(editor: ClearableEditor): void {
    if (!editor.isConnected || !isClearableEditor(editor) || editorText(editor).length === 0) {
      removeEntry(editor);
      return;
    }
    positionEntry(entries.get(editor) ?? createEntry(editor));
  }

  function refreshEntries(): void {
    for (const editor of [...entries.keys()]) syncEditor(editor);
  }

  function refresh(): void {
    if (destroyed) return;
    const liveEditors = new Set<ClearableEditor>();
    ownerDocument.querySelectorAll(EDITOR_SELECTOR).forEach((element) => {
      const editor = editorCandidate(element);
      if (!editor || !isClearableEditor(editor)) return;
      liveEditors.add(editor);
      syncEditor(editor);
    });

    for (const editor of [...entries.keys()]) {
      if (!liveEditors.has(editor)) removeEntry(editor);
    }
  }

  function flushScheduledRefresh(): void {
    frameId = null;
    const editors = [...pendingEditors];
    pendingEditors.clear();
    const shouldRefreshEntries = refreshExistingEntries;
    refreshExistingEntries = false;

    editors.forEach(syncEditor);
    if (shouldRefreshEntries) refreshEntries();

    if (view?.requestAnimationFrame && (view.performance?.now() ?? Date.now()) < trackMotionUntil) {
      scheduleEntriesRefresh();
    }
  }

  function scheduleFrame(): void {
    if (destroyed || frameId !== null) return;
    if (view?.requestAnimationFrame) {
      frameUsesAnimation = true;
      frameId = view.requestAnimationFrame(flushScheduledRefresh);
    } else if (view) {
      frameUsesAnimation = false;
      frameId = view.setTimeout(flushScheduledRefresh, 0);
    } else {
      flushScheduledRefresh();
    }
  }

  function scheduleEntriesRefresh(): void {
    if (destroyed) return;
    refreshExistingEntries = true;
    scheduleFrame();
  }

  function handleEditingEvent(event: Event): void {
    const editor = editorFromEventTarget(event.target);
    if (editor) queueEditor(editor);
  }

  function handleFocusIn(event: Event): void {
    const editor = editorFromEventTarget(event.target);
    if (editor) queueEditor(editor);
  }

  function handleLanguageChange(): void {
    entries.forEach(({ button }) => updateButtonLabel(button));
  }

  function motionAffectsEditor(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    for (const editor of entries.keys()) {
      if (target === editor || target.contains(editor)) return true;
    }
    return false;
  }

  function handleMotionStart(event: Event): void {
    if (!motionAffectsEditor(event.target)) return;
    // Dialogs and drawers translate for up to 400ms. Reposition during that
    // short window, without paying this cost for unrelated app animations.
    trackMotionUntil = (view?.performance?.now() ?? Date.now()) + 500;
    scheduleEntriesRefresh();
  }

  function handleMotionEnd(event: Event): void {
    if (motionAffectsEditor(event.target)) scheduleEntriesRefresh();
  }

  function queueElementEditors(element: Element): void {
    const direct = editorCandidate(element);
    if (direct) pendingEditors.add(direct);
    element.querySelectorAll(EDITOR_SELECTOR).forEach((candidate) => {
      const editor = editorCandidate(candidate);
      if (editor) pendingEditors.add(editor);
    });
  }

  function removedNodeContainsEntry(node: Node): boolean {
    for (const editor of entries.keys()) {
      if (node === editor || (node instanceof Element && node.contains(editor))) return true;
    }
    return false;
  }

  function handleMutations(records: MutationRecord[]): void {
    let needsEntryCleanup = false;
    for (const record of records) {
      if (record.type === 'characterData') {
        const parent = record.target.parentElement;
        const closest = parent?.closest(EDITOR_SELECTOR);
        if (closest) {
          const editor = editorCandidate(closest);
          if (editor) pendingEditors.add(editor);
        }
        continue;
      }

      if (record.type === 'childList') {
        if (record.target instanceof Element) {
          const targetEditor = editorCandidate(record.target);
          if (targetEditor) pendingEditors.add(targetEditor);
        }
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) queueElementEditors(node);
        });
        record.removedNodes.forEach((node) => {
          if (removedNodeContainsEntry(node)) needsEntryCleanup = true;
        });
        continue;
      }

      if (record.target instanceof Element) queueElementEditors(record.target);
    }

    if (needsEntryCleanup) refreshExistingEntries = true;
    if (pendingEditors.size > 0 || refreshExistingEntries) scheduleFrame();
  }

  const MutationObserverConstructor = view?.MutationObserver;
  const observer =
    typeof MutationObserverConstructor === 'function'
      ? new MutationObserverConstructor(handleMutations)
      : null;
  observer?.observe(ownerDocument.body || ownerDocument.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'aria-disabled',
      'aria-hidden',
      'aria-readonly',
      'contenteditable',
      'data-clearable',
      'data-disabled',
      'disabled',
      'hidden',
      'id',
      'inert',
      'readonly',
      'type',
      'value',
    ],
  });

  // Bubble-phase editing events run after field-specific sanitizers. The rAF
  // queue then observes their final value without scanning the whole document.
  ownerDocument.addEventListener('input', handleEditingEvent);
  ownerDocument.addEventListener('change', handleEditingEvent);
  ownerDocument.addEventListener('focusin', handleFocusIn, true);
  ownerDocument.addEventListener('scroll', scheduleEntriesRefresh, true);
  ownerDocument.addEventListener('transitionrun', handleMotionStart, true);
  ownerDocument.addEventListener('animationstart', handleMotionStart, true);
  ownerDocument.addEventListener('transitionend', handleMotionEnd, true);
  ownerDocument.addEventListener('animationend', handleMotionEnd, true);
  view?.addEventListener('resize', scheduleEntriesRefresh);
  view?.visualViewport?.addEventListener('resize', scheduleEntriesRefresh);
  view?.visualViewport?.addEventListener('scroll', scheduleEntriesRefresh);
  const unsubscribeLanguage = bus.on('i18n:changed', handleLanguageChange);

  refresh();

  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      resizeObserver?.disconnect();
      ownerDocument.removeEventListener('input', handleEditingEvent);
      ownerDocument.removeEventListener('change', handleEditingEvent);
      ownerDocument.removeEventListener('focusin', handleFocusIn, true);
      ownerDocument.removeEventListener('scroll', scheduleEntriesRefresh, true);
      ownerDocument.removeEventListener('transitionrun', handleMotionStart, true);
      ownerDocument.removeEventListener('animationstart', handleMotionStart, true);
      ownerDocument.removeEventListener('transitionend', handleMotionEnd, true);
      ownerDocument.removeEventListener('animationend', handleMotionEnd, true);
      view?.removeEventListener('resize', scheduleEntriesRefresh);
      view?.visualViewport?.removeEventListener('resize', scheduleEntriesRefresh);
      view?.visualViewport?.removeEventListener('scroll', scheduleEntriesRefresh);
      unsubscribeLanguage();
      if (frameId !== null) {
        if (frameUsesAnimation && view?.cancelAnimationFrame) view.cancelAnimationFrame(frameId);
        else view?.clearTimeout(frameId);
        frameId = null;
      }
      pendingEditors.clear();
      [...entries.keys()].forEach(removeEntry);
    },
  };
}

let globalController: ClearableEditorsController | null = null;

export function initClearableEditors(): ClearableEditorsController {
  globalController?.destroy();
  globalController = createClearableEditorsController(document);
  return globalController;
}
