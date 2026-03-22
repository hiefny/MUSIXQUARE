/**
 * Universal Custom Scrollbar
 * Replaces native scrollbars with a minimal overlay thumb.
 * Usage: initCustomScrollbar(containerEl) or initAllCustomScrollbars()
 */

const THUMB_MIN_HEIGHT = 30;

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
}

const _instances = new Map<HTMLElement, ScrollbarState>();

function updateThumb(state: ScrollbarState): void {
  const { container, track, thumb } = state;
  const { scrollTop, scrollHeight, clientHeight } = container;

  if (scrollHeight <= clientHeight + 1) {
    thumb.style.display = 'none';
    return;
  }
  thumb.style.display = '';

  // Position track to match container's position within parent
  track.style.top = `${container.offsetTop}px`;
  track.style.height = `${clientHeight}px`;

  const ratio = clientHeight / scrollHeight;
  const thumbHeight = Math.max(THUMB_MIN_HEIGHT, ratio * clientHeight);
  const maxScroll = scrollHeight - clientHeight;
  const thumbTop = maxScroll > 0
    ? (scrollTop / maxScroll) * (clientHeight - thumbHeight)
    : 0;

  thumb.style.height = `${thumbHeight}px`;
  thumb.style.top = `${thumbTop}px`;

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
  };

  // Scroll → update thumb
  container.addEventListener('scroll', () => updateThumb(state), { passive: true });

  // Content mutations → update thumb
  state.observer = new MutationObserver(() => updateThumb(state));
  state.observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });

  // Resize → update thumb
  state.resizeObserver = new ResizeObserver(() => updateThumb(state));
  state.resizeObserver.observe(container);

  // Drag thumb to scroll
  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.isDragging = true;
    state.dragStartY = e.clientY;
    state.dragStartScroll = container.scrollTop;
    thumb.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });

  // Touch support for thumb drag
  thumb.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    state.isDragging = true;
    state.dragStartY = e.touches[0].clientY;
    state.dragStartScroll = container.scrollTop;
    thumb.classList.add('dragging');
  }, { passive: true });

  const onMouseMove = (e: MouseEvent) => {
    if (!state.isDragging) return;
    const { scrollHeight, clientHeight } = container;
    const maxScroll = scrollHeight - clientHeight;
    const thumbHeight = Math.max(THUMB_MIN_HEIGHT, (clientHeight / scrollHeight) * clientHeight);
    const trackHeight = clientHeight - thumbHeight;
    if (trackHeight <= 0) return;
    container.scrollTop = state.dragStartScroll + ((e.clientY - state.dragStartY) / trackHeight) * maxScroll;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!state.isDragging) return;
    const { scrollHeight, clientHeight } = container;
    const maxScroll = scrollHeight - clientHeight;
    const thumbHeight = Math.max(THUMB_MIN_HEIGHT, (clientHeight / scrollHeight) * clientHeight);
    const trackHeight = clientHeight - thumbHeight;
    if (trackHeight <= 0) return;
    container.scrollTop = state.dragStartScroll + ((e.touches[0].clientY - state.dragStartY) / trackHeight) * maxScroll;
  };

  const onDragEnd = () => {
    if (!state.isDragging) return;
    state.isDragging = false;
    thumb.classList.remove('dragging');
    document.body.style.userSelect = '';
    updateThumb(state);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('touchmove', onTouchMove, { passive: true });
  window.addEventListener('mouseup', onDragEnd);
  window.addEventListener('touchend', onDragEnd);

  state.cleanup = [
    () => window.removeEventListener('mousemove', onMouseMove),
    () => window.removeEventListener('touchmove', onTouchMove),
    () => window.removeEventListener('mouseup', onDragEnd),
    () => window.removeEventListener('touchend', onDragEnd),
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
  updateThumb(state);
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
  state.cleanup.forEach(fn => fn());
  state.track.remove();
  _instances.delete(container);
}
