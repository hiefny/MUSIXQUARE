import { t } from '../i18n/index.ts';
import { copyTextToClipboard } from './dom.ts';
import { showToast } from './toast.ts';

type CopyPress = [HTMLElement, number, number, number, number, boolean];

let _events: AbortController | null = null;

function bubbleAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>('.chat-bubble[data-chat-copy-text]')
    : null;
}

function copyBubble(bubble: HTMLElement): void {
  const text = bubble.dataset.chatCopyText;
  if (text === undefined) return;
  void copyTextToClipboard(text).then((copied) => {
    showToast(t(copied ? 'chat.copied' : 'toast.copy_failed'));
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

/** Install the delegated chat-bubble copy gestures. */
export function initChatCopyGestures(): void {
  _events?.abort();
  _events = new AbortController();
  const { signal } = _events;
  let press: CopyPress | null = null;
  let touchBubble: HTMLElement | null = null;
  let copiedBubble: HTMLElement | null = null;
  let ignoreClickUntil = 0;

  const cancel = (): void => {
    if (press) window.clearTimeout(press[4]);
    press = null;
  };

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'mouse' || !event.isPrimary || event.button) return;
      const bubble = bubbleAt(event.target);
      if (!bubble) return;
      cancel();
      copiedBubble = null;
      touchBubble = bubble;
      ignoreClickUntil = Date.now() + 1_500;
      const next: CopyPress = [bubble, event.pointerId, event.clientX, event.clientY, 0, false];
      next[4] = window.setTimeout(() => {
        if (press === next) next[5] = true;
      }, 500);
      press = next;
    },
    { signal, passive: true },
  );

  document.addEventListener(
    'pointermove',
    (event) => {
      if (
        press &&
        event.pointerId === press[1] &&
        Math.hypot(event.clientX - press[2], event.clientY - press[3]) > 10
      ) {
        cancel();
      }
    },
    { signal, passive: true },
  );

  document.addEventListener(
    'pointerup',
    (event) => {
      const completed = press;
      if (!completed || event.pointerId !== completed[1]) return;
      cancel();
      if (!completed[5] || !completed[0].isConnected) return;
      copiedBubble = completed[0];
      ignoreClickUntil = Date.now() + 1_500;
      event.preventDefault();
      copyBubble(completed[0]);
    },
    { signal },
  );

  document.addEventListener('pointercancel', cancel, { signal, passive: true });
  document.addEventListener('scroll', cancel, { signal, capture: true, passive: true });
  signal.addEventListener('abort', cancel, { once: true });

  document.addEventListener(
    'contextmenu',
    (event) => {
      if (bubbleAt(event.target) === touchBubble && Date.now() < ignoreClickUntil) {
        event.preventDefault();
      }
    },
    { signal, capture: true },
  );

  // Capture runs before the established timestamp/YouTube delegates, allowing
  // a completed hold to consume the compatibility click without changing a
  // quick tap on either inline action.
  document.addEventListener(
    'click',
    (event) => {
      const bubble = bubbleAt(event.target);
      if (!bubble) return;
      if (bubble === touchBubble && Date.now() < ignoreClickUntil) {
        if (bubble === copiedBubble) {
          copiedBubble = null;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (
        !(event.target as Element).closest('button,[data-seek]') &&
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
