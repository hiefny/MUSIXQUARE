/**
 * Universal Custom Scrollbar
 * Replaces native scrollbars with a minimal overlay thumb.
 * Usage: initCustomScrollbar(containerEl) or initAllCustomScrollbars()
 */

import { isCompactLandscape, onCompactLandscapeChange } from '../core/platform.ts';
import { setManagedTimer } from '../core/timers.ts';
import { bus } from '../core/events.ts';

const THUMB_MIN_HEIGHT = 30;
const FADE_DELAY = 1200;

interface ScrollbarState {
  container: HTMLElement;
  track: HTMLElement;
  thumb: HTMLElement;
  isDragging: boolean;
  dragStartY: number;
  dragStartScroll: number;
  observer: MutationObserver;
  resizeObserver: ResizeObserver;
  cleanup: (() => void)[];
  visibleHeight: number;
  thumbHeight: number;
  fadeTimer: number;
  /** Cached transform-containing-block ancestor (resolved lazily on first updateLayout). */
  transformBlock: HTMLElement | null;
  transformBlockResolved: boolean;
}

const _instances = new Map<HTMLElement, ScrollbarState>();

/**
 * Walk up the DOM looking for an ancestor whose computed transform/perspective
 * is non-none. Such an ancestor becomes the containing block for descendant
 * position:fixed elements (CSS spec), which means inline `top: <viewport-px>`
 * on the track no longer lands at the viewport top — it's measured from the
 * ancestor's padding-box top instead. The .chat-drawer's open/close transform
 * is exactly this case: with no adjustment, the track ends up off-screen
 * (the user repro: "scrollbar flew far off to the right" — actually downward
 * by drawer.top, since drawer sits on the bottom half in portrait).
 */
function findFixedContainingBlock(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p && p !== document.documentElement) {
    const cs = getComputedStyle(p);
    if (cs.transform !== 'none' || cs.perspective !== 'none') return p;
    p = p.parentElement;
  }
  return null;
}

function updateLayout(state: ScrollbarState): void {
  const { container, track, thumb } = state;
  const { scrollHeight, clientHeight } = container;

  if (scrollHeight <= clientHeight + 1) {
    thumb.style.display = 'none';
    return;
  }
  thumb.style.display = '';

  // Position track to match container's visible area
  const containerRect = container.getBoundingClientRect();
  let visibleHeight = clientHeight;
  const isDesktop = window.matchMedia('(min-width: 1280px)').matches;
  const isCompactLand = isCompactLandscape();

  if (!isDesktop && !isCompactLand) {
    const bottomNav = document.querySelector('.bottom-nav') as HTMLElement;
    if (bottomNav) {
      const navRect = bottomNav.getBoundingClientRect();
      // Subtract if the container overlaps the bottom nav
      if (navRect.height > 0 && containerRect.bottom > navRect.top) {
        const overlap = containerRect.bottom - navRect.top;
        visibleHeight = Math.max(0, clientHeight - overlap);
      }
    }
  }

  state.visibleHeight = visibleHeight;
  if (isDesktop) {
    // Desktop: track is position:absolute inside parent — offset by container's position within parent
    const parentRect = container.parentElement?.getBoundingClientRect();
    const offsetTop = parentRect ? containerRect.top - parentRect.top : 0;
    track.style.top = `${offsetTop}px`;
    track.style.height = `${visibleHeight}px`;
  } else {
    // Mobile: track is position:fixed. If an ancestor uses transform (or
    // perspective), it becomes the containing block for the fixed track —
    // inline top values are then measured from the ancestor's padding-box
    // top, not from the viewport. Subtract the ancestor's top so the
    // viewport-based containerRect.top still lands at the right place.
    // CSS-side `right: 0` already inherits the same containing block, so
    // X axis works without intervention here (and the chat-drawer scope
    // override in style.css already handles the wider X case).
    //
    // Cache the lookup on first call: the transform ancestor is determined
    // by the DOM structure (e.g. .chat-drawer always wraps .chat-messages),
    // not by runtime values. Re-walking on every updateLayout would burn a
    // getComputedStyle call per ancestor on every chunk arrival or chat
    // message — shallow walks but they add up under heavy traffic.
    if (!state.transformBlockResolved) {
      state.transformBlock = findFixedContainingBlock(container);
      state.transformBlockResolved = true;
    }
    const ancestorTop = state.transformBlock ? state.transformBlock.getBoundingClientRect().top : 0;
    track.style.top = `${containerRect.top - ancestorTop}px`;
    track.style.height = `${visibleHeight}px`;
  }

  const ratio = visibleHeight / scrollHeight;
  state.thumbHeight = Math.max(THUMB_MIN_HEIGHT, ratio * visibleHeight);
  thumb.style.height = `${state.thumbHeight}px`;

  updateScroll(state);
}

function updateScroll(state: ScrollbarState): void {
  const { container, thumb, visibleHeight, thumbHeight } = state;
  const { scrollTop, scrollHeight, clientHeight } = container;

  if (scrollHeight <= clientHeight + 1) return;

  const maxScroll = scrollHeight - clientHeight;
  const maxThumbTop = visibleHeight - thumbHeight;
  let thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * maxThumbTop : 0;

  let h = thumbHeight;

  // Overscroll top: clamp at 0, shrink thumb
  if (thumbTop < 0) {
    h = Math.max(THUMB_MIN_HEIGHT * 0.5, thumbHeight + thumbTop);
    thumbTop = 0;
  }
  // Overscroll bottom: clamp at bottom edge, shrink thumb
  else if (thumbTop > maxThumbTop) {
    const overflow = thumbTop - maxThumbTop;
    h = Math.max(THUMB_MIN_HEIGHT * 0.5, thumbHeight - overflow);
    thumbTop = visibleHeight - h;
  }

  thumb.style.height = `${h}px`;
  // Use GPU-accelerated transform instead of style.top for 120fps scrolling
  thumb.style.transform = `translateY(${thumbTop}px)`;
}

export function initCustomScrollbar(container: HTMLElement): void {
  // Skip if already initialized
  if (_instances.has(container)) return;

  // Track must be a sibling of the container (not inside it, or it scrolls with content).
  // Append to container's parent and ensure parent is positioned.
  const parent = container.parentElement;
  if (!parent) return;

  const parentPos = getComputedStyle(parent).position;
  if (parentPos === 'static') parent.style.position = 'relative';

  // Create track + thumb elements
  const track = document.createElement('div');
  track.className = 'cscroll-track';

  const thumb = document.createElement('div');
  thumb.className = 'cscroll-thumb';
  track.appendChild(thumb);
  parent.appendChild(track);

  const state: ScrollbarState = {
    container,
    track,
    thumb,
    isDragging: false,
    dragStartY: 0,
    dragStartScroll: 0,
    observer: null!,
    resizeObserver: null!,
    cleanup: [],
    visibleHeight: 0,
    thumbHeight: 0,
    fadeTimer: 0,
    transformBlock: null,
    transformBlockResolved: false,
  };

  thumb.style.top = '0px';
  track.style.opacity = '0';
  track.style.transition = 'opacity 0.3s ease';

  function showTrack(): void {
    track.style.opacity = '1';
    clearTimeout(state.fadeTimer);
    state.fadeTimer = window.setTimeout(() => {
      if (!state.isDragging) track.style.opacity = '0';
    }, FADE_DELAY);
  }

  let ticking = false;
  const onScroll = (): void => {
    showTrack();
    if (!ticking) {
      window.requestAnimationFrame(() => {
        updateScroll(state);
        ticking = false;
      });
      ticking = true;
    }
  };
  container.addEventListener('scroll', onScroll, { passive: true });

  // Content mutations → update layout
  state.observer = new MutationObserver(() => updateLayout(state));
  state.observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });

  // Resize → update layout
  state.resizeObserver = new ResizeObserver(() => updateLayout(state));
  state.resizeObserver.observe(container);

  // Orientation change → delayed re-layout (CSS transitions need time to settle)
  const onLayoutChange = () => {
    setManagedTimer('scrollbar-relayout-fast', () => updateLayout(state), 350);
    setManagedTimer('scrollbar-relayout-slow', () => updateLayout(state), 700);
  };
  const cleanupCompactListener = onCompactLandscapeChange(onLayoutChange);
  const orientationMql = window.matchMedia('(orientation: landscape)');
  orientationMql.addEventListener('change', onLayoutChange);

  // Bus signal for transform-based visibility changes (e.g. chat-drawer
  // sliding in via translateY). Neither ResizeObserver nor MutationObserver
  // on the container itself catches a parent transform — the size doesn't
  // change and the open/close class lands on an ancestor — so external
  // callers must signal a relayout when they animate visibility.
  const cleanupRelayoutBus = bus.on('ui:scrollbar-relayout', () => updateLayout(state));

  // Drag thumb to scroll
  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.isDragging = true;
    state.dragStartY = e.clientY;
    state.dragStartScroll = container.scrollTop;
    thumb.classList.add('dragging');
    document.body.style.userSelect = 'none';
    clearTimeout(state.fadeTimer);
    track.style.opacity = '1';
  });

  // Touch support for thumb drag.
  // Must be non-passive so preventDefault() can suppress the browser's own
  // touch-scrolling gesture — otherwise mobile scrolls the page at the same
  // time and the header/chrome drifts along with the drag.
  const onThumbTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    state.isDragging = true;
    clearTimeout(state.fadeTimer);
    track.style.opacity = '1';
    state.dragStartY = e.touches[0].clientY;
    state.dragStartScroll = container.scrollTop;
    thumb.classList.add('dragging');
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!state.isDragging) return;
    const { scrollHeight, clientHeight } = container;
    const maxScroll = scrollHeight - clientHeight;
    const trackHeight = state.visibleHeight - state.thumbHeight;
    if (trackHeight <= 0) return;
    container.scrollTop =
      state.dragStartScroll + ((e.clientY - state.dragStartY) / trackHeight) * maxScroll;
  };

  // Touchmove fires on the original touch target (thumb) for the lifetime of
  // the gesture, even if the finger wanders off — so binding on `thumb` (not
  // window) is sufficient and lets us keep non-passive scoped locally.
  const onThumbTouchMove = (e: TouchEvent) => {
    if (!state.isDragging) return;
    e.preventDefault();
    const { scrollHeight, clientHeight } = container;
    const maxScroll = scrollHeight - clientHeight;
    const trackHeight = state.visibleHeight - state.thumbHeight;
    if (trackHeight <= 0) return;
    container.scrollTop =
      state.dragStartScroll + ((e.touches[0].clientY - state.dragStartY) / trackHeight) * maxScroll;
  };

  const onDragEnd = () => {
    if (!state.isDragging) return;
    state.isDragging = false;
    thumb.classList.remove('dragging');
    document.body.style.userSelect = '';
    updateScroll(state);
    showTrack();
  };

  thumb.addEventListener('touchstart', onThumbTouchStart, { passive: false });
  thumb.addEventListener('touchmove', onThumbTouchMove, { passive: false });
  thumb.addEventListener('touchend', onDragEnd);
  thumb.addEventListener('touchcancel', onDragEnd);

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onDragEnd);
  // Blur fallback: if the user alt-tabs or switches windows mid-drag,
  // mouseup never fires on our window, leaving isDragging=true. The next
  // mouse move (after they come back) would snap the scroll unexpectedly.
  window.addEventListener('blur', onDragEnd);

  state.cleanup = [
    () => container.removeEventListener('scroll', onScroll),
    () => thumb.removeEventListener('touchstart', onThumbTouchStart),
    () => thumb.removeEventListener('touchmove', onThumbTouchMove),
    () => thumb.removeEventListener('touchend', onDragEnd),
    () => thumb.removeEventListener('touchcancel', onDragEnd),
    () => window.removeEventListener('mousemove', onMouseMove),
    () => window.removeEventListener('mouseup', onDragEnd),
    () => window.removeEventListener('blur', onDragEnd),
    () => orientationMql.removeEventListener('change', onLayoutChange),
    cleanupCompactListener,
    cleanupRelayoutBus,
  ];

  // Click on track → jump
  track.addEventListener('mousedown', (e) => {
    if (e.target === thumb) return;
    const rect = track.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / rect.height;
    container.scrollTop = clickRatio * (container.scrollHeight - container.clientHeight);
  });

  _instances.set(container, state);

  // Initial update
  updateLayout(state);
}

/**
 * Auto-initialize custom scrollbars on all elements with [data-custom-scroll]
 */
export function initAllCustomScrollbars(): void {
  document.querySelectorAll<HTMLElement>('[data-custom-scroll]').forEach((el) => {
    initCustomScrollbar(el);
  });
}

export function destroyCustomScrollbar(container: HTMLElement): void {
  const state = _instances.get(container);
  if (!state) return;
  state.observer.disconnect();
  state.resizeObserver.disconnect();
  state.cleanup.forEach((fn) => fn());
  state.track.remove();
  _instances.delete(container);
}
