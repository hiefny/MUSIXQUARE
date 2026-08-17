(function () {
  'use strict';

  const EDITOR_SELECTOR = 'input, textarea, [contenteditable]';
  const BUTTON_CLASS = 'clearable-editor-button';
  const ACTIVE_CLASS = 'clearable-editor-active';
  const CENTERED_CLASS = 'clearable-editor-centered';
  const BASE_PADDING_START_PROPERTY = '--clearable-editor-base-padding-inline-start';
  const BASE_PADDING_END_PROPERTY = '--clearable-editor-base-padding-inline-end';
  const RESERVED_SPACE_PROPERTY = '--clearable-editor-reserved-space';
  const BUTTON_SIZE = 44;
  const FULL_RESERVATION = 48;
  const NARROW_RESERVATION = 28;
  const NARROW_EDITOR_WIDTH = 176;
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url']);

  type ClearableEditor = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

  interface EditorEntry {
    readonly button: HTMLButtonElement;
    readonly editor: ClearableEditor;
    generatedId: string | null;
  }

  const entries = new Map<ClearableEditor, EditorEntry>();
  const pendingEditors = new Set<ClearableEditor>();
  let generatedEditorId = 0;
  let frameId: number | null = null;
  let refreshExistingEntries = false;
  let trackMotionUntil = 0;

  function isContentEditor(element: Element): element is HTMLElement {
    if (!(element instanceof HTMLElement)) return false;
    const value = (element.getAttribute('contenteditable') ?? '').toLowerCase();
    return value === '' || value === 'true' || value === 'plaintext-only';
  }

  function isClearableEditor(element: Element): element is ClearableEditor {
    if (element.getAttribute('data-clearable') === 'false') return false;
    if (
      element.closest(
        '[inert], [aria-hidden="true"], [data-disabled="true"], [aria-disabled="true"]',
      )
    ) {
      return false;
    }
    if (element.getAttribute('aria-readonly') === 'true') return false;

    if (element instanceof HTMLInputElement) {
      return (
        !element.matches(':disabled') && !element.readOnly && TEXT_INPUT_TYPES.has(element.type)
      );
    }
    if (element instanceof HTMLTextAreaElement) {
      return !element.matches(':disabled') && !element.readOnly;
    }
    return isContentEditor(element);
  }

  function editorCandidate(element: Element): ClearableEditor | null {
    return element.matches(EDITOR_SELECTOR) && element instanceof HTMLElement
      ? (element as ClearableEditor)
      : null;
  }

  function editorFromTarget(target: EventTarget | null): ClearableEditor | null {
    if (!(target instanceof Element)) return null;
    const element = target.matches(EDITOR_SELECTOR) ? target : target.closest(EDITOR_SELECTOR);
    return element ? editorCandidate(element) : null;
  }

  function editorText(editor: ClearableEditor): string {
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      return editor.value;
    }
    return editor.textContent ?? '';
  }

  function clearLabel(): string {
    return document.documentElement.lang.trim().toLowerCase().startsWith('ko')
      ? '입력 내용 지우기'
      : 'Clear input';
  }

  function updateButtonLabels(): void {
    const label = clearLabel();
    entries.forEach(({ button }) => {
      button.setAttribute('aria-label', label);
      button.title = label;
    });
  }

  function nextAvailableEditorId(): string {
    let id: string;
    do {
      generatedEditorId += 1;
      id = `clearable-editor-${generatedEditorId}`;
    } while (document.getElementById(id));
    return id;
  }

  function dispatchEditingEvent(editor: ClearableEditor, type: 'input' | 'change'): void {
    if (type === 'input' && typeof InputEvent === 'function') {
      try {
        editor.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'deleteContentBackward',
            data: null,
          }),
        );
        return;
      } catch {
        // Older embedded browsers expose InputEvent without accepting its options.
      }
    }
    editor.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  function clearEditor(editor: ClearableEditor): void {
    if (!isClearableEditor(editor)) return;
    try {
      editor.focus({ preventScroll: true });
    } catch {
      editor.focus();
    }
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      editor.value = '';
    } else {
      editor.replaceChildren();
    }
    dispatchEditingEvent(editor, 'input');
    dispatchEditingEvent(editor, 'change');
  }

  function ensureAssociation(entry: EditorEntry): void {
    const { button, editor } = entry;
    if (entry.generatedId && editor.id !== entry.generatedId) entry.generatedId = null;
    if (!editor.id) {
      entry.generatedId = nextAvailableEditorId();
      editor.id = entry.generatedId;
    }
    button.setAttribute('aria-controls', editor.id);
    if (button.previousElementSibling !== editor) editor.insertAdjacentElement('afterend', button);
  }

  function createEntry(editor: ClearableEditor): EditorEntry {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.dataset.clearableEditorButton = '';
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z"></path></svg>';
    const label = clearLabel();
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearEditor(editor);
      syncEditor(editor);
    });

    const style = getComputedStyle(editor);
    editor.style.setProperty(BASE_PADDING_START_PROPERTY, style.paddingInlineStart || '0px');
    editor.style.setProperty(BASE_PADDING_END_PROPERTY, style.paddingInlineEnd || '0px');
    const entry: EditorEntry = { button, editor, generatedId: null };
    entries.set(editor, entry);
    ensureAssociation(entry);
    resizeObserver?.observe(editor);
    return entry;
  }

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

  function underlyingElementAtPoint(
    button: HTMLButtonElement,
    x: number,
    y: number,
  ): Element | null {
    if (typeof document.elementFromPoint !== 'function') return null;
    const previousPointerEvents = button.style.pointerEvents;
    button.style.pointerEvents = 'none';
    try {
      return document.elementFromPoint(x, y);
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
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= viewportWidth ||
      rect.top >= viewportHeight
    ) {
      return false;
    }
    const x = Math.max(0, Math.min(viewportWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(viewportHeight - 1, rect.top + rect.height / 2));
    const topElement = underlyingElementAtPoint(button, x, y);
    return !topElement || topElement === editor || editor.contains(topElement);
  }

  function setButtonPosition(
    button: HTMLButtonElement,
    viewportLeft: number,
    viewportTop: number,
  ): void {
    button.style.position = 'absolute';
    const offsetParent = button.offsetParent;
    if (!(offsetParent instanceof HTMLElement)) {
      button.style.position = 'fixed';
      button.style.left = `${Math.round(viewportLeft)}px`;
      button.style.top = `${Math.round(viewportTop)}px`;
      button.style.width = `${BUTTON_SIZE}px`;
      button.style.height = `${BUTTON_SIZE}px`;
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
    button.style.left = `${Math.round(
      (viewportLeft - originLeft) / scaleX + offsetParent.scrollLeft,
    )}px`;
    button.style.top = `${Math.round(
      (viewportTop - originTop) / scaleY + offsetParent.scrollTop,
    )}px`;
    button.style.width = `${Math.round(BUTTON_SIZE / scaleX)}px`;
    button.style.height = `${Math.round(BUTTON_SIZE / scaleY)}px`;
  }

  function positionEntry(entry: EditorEntry): void {
    const { button, editor } = entry;
    ensureAssociation(entry);
    const rect = editor.getBoundingClientRect();
    const style = getComputedStyle(editor);
    const visible = isVisuallyAvailable(editor, button, rect, style);
    button.hidden = !visible;
    editor.classList.toggle(ACTIVE_CLASS, visible);
    editor.classList.toggle(CENTERED_CLASS, style.textAlign === 'center');
    if (!visible) return;

    const narrow = rect.width < NARROW_EDITOR_WIDTH;
    const inside = narrow ? BUTTON_SIZE / 2 + 2 : BUTTON_SIZE;
    editor.style.setProperty(
      RESERVED_SPACE_PROPERTY,
      `${narrow ? NARROW_RESERVATION : FULL_RESERVATION}px`,
    );
    const left =
      style.direction === 'rtl' ? rect.left - (BUTTON_SIZE - inside) : rect.right - inside;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const rawTop = rect.top + (rect.height - BUTTON_SIZE) / 2;
    const top = Math.max(0, Math.min(Math.max(0, viewportHeight - BUTTON_SIZE), rawTop));
    setButtonPosition(button, left, top);
  }

  function syncEditor(editor: ClearableEditor): void {
    if (!editor.isConnected || !isClearableEditor(editor) || editorText(editor).length === 0) {
      removeEntry(editor);
      return;
    }
    positionEntry(entries.get(editor) ?? createEntry(editor));
  }

  function scanEditors(): void {
    document.querySelectorAll(EDITOR_SELECTOR).forEach((element) => {
      const editor = editorCandidate(element);
      if (!editor || !isClearableEditor(editor)) return;
      syncEditor(editor);
    });
  }

  function refreshEntries(): void {
    for (const editor of [...entries.keys()]) syncEditor(editor);
  }

  function flush(): void {
    frameId = null;
    const queued = [...pendingEditors];
    pendingEditors.clear();
    queued.forEach(syncEditor);
    if (refreshExistingEntries) {
      refreshExistingEntries = false;
      refreshEntries();
    }
    if (performance.now() < trackMotionUntil) scheduleEntriesRefresh();
  }

  function schedule(): void {
    if (frameId !== null) return;
    if (typeof requestAnimationFrame === 'function') frameId = requestAnimationFrame(flush);
    else frameId = window.setTimeout(flush, 0);
  }

  function scheduleEntriesRefresh(): void {
    refreshExistingEntries = true;
    schedule();
  }

  function queueTarget(target: EventTarget | null): void {
    const editor = editorFromTarget(target);
    if (!editor) return;
    pendingEditors.add(editor);
    schedule();
  }

  function motionAffectsEditor(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    for (const editor of entries.keys()) {
      if (target === editor || target.contains(editor)) return true;
    }
    return false;
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

  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((records) => records.forEach(({ target }) => queueTarget(target)))
      : null;

  const observer = new MutationObserver((records) => {
    let needsEntryCleanup = false;
    for (const record of records) {
      if (record.type === 'characterData') {
        const editor = record.target.parentElement?.closest(EDITOR_SELECTOR);
        if (editor) {
          const candidate = editorCandidate(editor);
          if (candidate) pendingEditors.add(candidate);
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
    if (pendingEditors.size > 0 || refreshExistingEntries) schedule();
  });
  observer.observe(document.body, {
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
      'open',
      'readonly',
      'type',
      'value',
    ],
  });
  new MutationObserver(updateButtonLabels).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['lang'],
  });

  document.addEventListener('input', (event) => queueTarget(event.target));
  document.addEventListener('change', (event) => queueTarget(event.target));
  document.addEventListener('focusin', (event) => queueTarget(event.target), true);
  document.addEventListener('scroll', scheduleEntriesRefresh, true);
  document.addEventListener(
    'transitionrun',
    (event) => {
      if (!motionAffectsEditor(event.target)) return;
      trackMotionUntil = performance.now() + 500;
      scheduleEntriesRefresh();
    },
    true,
  );
  document.addEventListener(
    'animationstart',
    (event) => {
      if (!motionAffectsEditor(event.target)) return;
      trackMotionUntil = performance.now() + 500;
      scheduleEntriesRefresh();
    },
    true,
  );
  document.addEventListener(
    'transitionend',
    (event) => {
      if (motionAffectsEditor(event.target)) scheduleEntriesRefresh();
    },
    true,
  );
  document.addEventListener(
    'animationend',
    (event) => {
      if (motionAffectsEditor(event.target)) scheduleEntriesRefresh();
    },
    true,
  );
  window.addEventListener('resize', scheduleEntriesRefresh);
  window.visualViewport?.addEventListener('resize', scheduleEntriesRefresh);
  window.visualViewport?.addEventListener('scroll', scheduleEntriesRefresh);

  scanEditors();
})();
