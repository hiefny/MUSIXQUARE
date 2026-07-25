import { t } from '../i18n/index.ts';
import type { QueueItemId } from '../types/index.ts';
import { getEffectiveScrollViewport } from './scroll-viewport.ts';

const VISIBILITY_TOLERANCE_PX = 2;

export interface PlaylistCurrentSelection {
  queueItemId: QueueItemId | null;
  subIndex: number;
}

interface PlaylistCurrentJumpOptions {
  panel: HTMLElement;
  list: HTMLElement;
  scrollContainer: HTMLElement;
  getSelection: () => PlaylistCurrentSelection;
  isVisible: () => boolean;
  isBlocked?: () => boolean;
  onActivate: (selection: Readonly<PlaylistCurrentSelection>) => void;
}

export interface PlaylistCurrentJumpController {
  afterRender: () => void;
  refresh: () => void;
  destroy: () => void;
}

function normalizeSubIndex(subIndex: number): number {
  return Number.isSafeInteger(subIndex) && subIndex >= 0 ? subIndex : -1;
}

function entryForQueueItem(list: HTMLElement, queueItemId: QueueItemId): HTMLElement | null {
  for (const child of list.children) {
    if (child instanceof HTMLElement && child.dataset.queueItemId === queueItemId) return child;
  }
  return null;
}

function targetForSelection(
  list: HTMLElement,
  selection: Readonly<PlaylistCurrentSelection>,
  allowParentFallback: boolean,
): HTMLElement | null {
  if (!selection.queueItemId) return null;
  const entry = entryForQueueItem(list, selection.queueItemId);
  if (!entry) return null;

  const subIndex = normalizeSubIndex(selection.subIndex);
  if (subIndex >= 0) {
    for (const subItem of entry.querySelectorAll<HTMLElement>('.sub-track-item[data-sub-index]')) {
      if (Number(subItem.dataset.subIndex) === subIndex) return subItem;
    }
    if (!allowParentFallback) return null;
  }

  return entry.querySelector<HTMLElement>('.track-item') ?? entry;
}

function createButton(panel: HTMLElement): HTMLButtonElement {
  panel.querySelector('#btn-playlist-current-track')?.remove();
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'btn-playlist-current-track';
  button.className = 'chat-scroll-down-btn playlist-current-jump-btn';
  button.setAttribute('aria-label', t('playlist.jump_to_current'));
  button.setAttribute('title', t('playlist.jump_to_current'));
  button.setAttribute('data-i18n-aria-label', 'playlist.jump_to_current');
  button.setAttribute('data-i18n-title', 'playlist.jump_to_current');
  button.setAttribute('aria-controls', 'playlist-ui');
  button.setAttribute('aria-hidden', 'true');
  button.tabIndex = -1;
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>';
  panel.appendChild(button);
  return button;
}

/**
 * Shows a chat-style locator only while the active queue occurrence is outside
 * the playlist viewport. The actual centering remains owned by
 * PlaylistFollowController so both automatic follow and explicit follow use the
 * same scaled-coordinate, reduced-motion, and WebKit retry policy.
 */
export function createPlaylistCurrentJumpController(
  options: PlaylistCurrentJumpOptions,
): PlaylistCurrentJumpController {
  const button = createButton(options.panel);
  const abortController = new AbortController();
  const { signal } = abortController;
  let frame = 0;
  let destroyed = false;

  function hideButton(): void {
    button.classList.remove('show', 'is-above');
    button.setAttribute('aria-hidden', 'true');
    button.tabIndex = -1;
    if (document.activeElement === button) {
      options.panel.focus({ preventScroll: true });
    }
  }

  function showButton(direction: 'above' | 'below'): void {
    button.classList.toggle('is-above', direction === 'above');
    button.classList.add('show');
    button.setAttribute('aria-hidden', 'false');
    button.tabIndex = 0;
  }

  function refreshNow(): void {
    frame = 0;
    if (destroyed || !options.isVisible() || options.isBlocked?.()) {
      hideButton();
      return;
    }

    const selection = options.getSelection();
    if (!selection.queueItemId) {
      hideButton();
      return;
    }

    // Prefer the exact expanded sub-track. While its metadata row is still
    // loading, use the parent only to decide whether a locator is useful; the
    // click still asks the follow controller for the exact sub-index and remains
    // pending until that row exists.
    const target =
      targetForSelection(options.list, selection, false) ??
      targetForSelection(options.list, selection, true);
    if (!target) {
      hideButton();
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const viewport = getEffectiveScrollViewport(options.scrollContainer);

    if (
      targetRect.height <= 0 ||
      viewport.heightCss <= 0 ||
      !Number.isFinite(viewport.top) ||
      !Number.isFinite(viewport.bottom)
    ) {
      hideButton();
      return;
    }

    const panelRect = options.panel.getBoundingClientRect();
    const topWithinPanel = (viewport.top - panelRect.top) / viewport.renderedScale + 16;
    button.style.setProperty('--playlist-current-jump-top', `${Math.max(16, topWithinPanel)}px`);

    const clippedAbove = targetRect.top < viewport.top - VISIBILITY_TOLERANCE_PX;
    const clippedBelow = targetRect.bottom > viewport.bottom + VISIBILITY_TOLERANCE_PX;
    if (!clippedAbove && !clippedBelow) {
      hideButton();
      return;
    }

    const direction = clippedAbove ? 'above' : 'below';
    showButton(direction);
  }

  function scheduleRefresh(): void {
    if (destroyed || frame) return;
    frame = window.requestAnimationFrame(refreshNow);
  }

  options.scrollContainer.addEventListener('scroll', scheduleRefresh, {
    passive: true,
    signal,
  });
  window.addEventListener('resize', scheduleRefresh, { passive: true, signal });
  window.addEventListener('orientationchange', scheduleRefresh, {
    passive: true,
    signal,
  });
  button.addEventListener(
    'click',
    () => {
      if (!button.classList.contains('show') || options.isBlocked?.()) return;
      const selection = options.getSelection();
      if (!selection.queueItemId) return;
      hideButton();
      options.onActivate(selection);
      scheduleRefresh();
    },
    { signal },
  );

  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRefresh) : null;
  resizeObserver?.observe(options.scrollContainer);
  resizeObserver?.observe(options.list);
  scheduleRefresh();

  return {
    afterRender: scheduleRefresh,
    refresh: scheduleRefresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abortController.abort();
      resizeObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      button.remove();
    },
  };
}
