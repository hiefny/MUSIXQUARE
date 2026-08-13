import { t } from '../i18n/index.ts';
import { copyTextToClipboardWithoutFocus } from './dom.ts';
import { showToast } from './toast.ts';

let _events: AbortController | null = null;
let _copyOperation = 0;

const NESTED_ACTION_SELECTOR =
  'button,a,input,textarea,select,option,[contenteditable="true"],[role="button"],[data-seek]';

function bubbleAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>('.chat-bubble[data-chat-copy-text]')
    : null;
}

function copyBubble(bubble: HTMLElement): void {
  const text = bubble.dataset.chatCopyText;
  if (text === undefined) return;
  const operation = ++_copyOperation;
  void copyTextToClipboardWithoutFocus(text)
    .then((copied) => {
      if (operation !== _copyOperation) return;
      showToast(t(copied ? 'chat.copied' : 'toast.copy_failed'));
    })
    .catch(() => {
      if (operation === _copyOperation) showToast(t('toast.copy_failed'));
    });
}

function hasBubbleSelection(bubble: HTMLElement): boolean {
  try {
    const selection = window.getSelection();
    return !!(
      selection &&
      !selection.isCollapsed &&
      ((selection.anchorNode && bubble.contains(selection.anchorNode)) ||
        (selection.focusNode && bubble.contains(selection.focusNode)) ||
        selection.containsNode(bubble, true))
    );
  } catch {
    return false;
  }
}

function isNestedAction(target: EventTarget | null, bubble: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const action = target.closest(NESTED_ACTION_SELECTOR);
  return !!action && action !== bubble && bubble.contains(action);
}

/** Install delegated single-tap/click and keyboard chat-bubble copying. */
export function initChatCopyGestures(): void {
  _events?.abort();
  _events = new AbortController();
  const { signal } = _events;
  ++_copyOperation;

  document.addEventListener(
    'click',
    (event) => {
      const bubble = bubbleAt(event.target);
      if (!bubble) return;
      if (
        !isNestedAction(event.target, bubble) &&
        (!(event instanceof MouseEvent) || event.button === 0) &&
        !hasBubbleSelection(bubble)
      ) {
        copyBubble(bubble);
      }
    },
    { signal, capture: true },
  );

  document.addEventListener(
    'keydown',
    (event) => {
      const bubble = bubbleAt(event.target);
      if (!bubble || event.target !== bubble || (event.key !== 'Enter' && event.key !== ' '))
        return;
      event.preventDefault();
      event.stopPropagation();
      copyBubble(bubble);
    },
    { signal, capture: true },
  );
}
