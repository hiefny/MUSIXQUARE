/**
 * Universal Custom Scrollbar
 * Replaces native scrollbars with a minimal overlay thumb.
 * Usage: initCustomScrollbar(containerEl) or initAllCustomScrollbars()
 */

import {
  getBodyRenderedScale,
  isCompactLandscape,
  onCompactLandscapeChange,
} from '../core/platform.ts';
import { setManagedTimer } from '../core/timers.ts';
import { bus } from '../core/events.ts';

const THUMB_MIN_HEIGHT = 30;
const FADE_DELAY = 1200;
const OVERFLOW_ROUNDING_TOLERANCE_PX = 2;
const SCROLL_PUMP_IDLE_FRAMES = 3;
// iOS can publish rubber-band scrollTop values after its asynchronous scroller
// has already painted the endpoint. Keep the lightweight sampler alive long
// enough to observe that handoff without making normal scrolling script-owned.
const SCROLL_PUMP_ENDPOINT_TAIL_MS = 150;
const SCROLLABLE_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'overlay']);

type ScrollDriver = 'script' | 'timeline';

interface ScrollTimelineConstructor {
  new (options: { source: Element; axis?: 'block' | 'inline' | 'x' | 'y' }): AnimationTimeline;
}

interface ScrollbarState {
  container: HTMLElement;
  track: HTMLElement;
  thumb: HTMLElement;
  thumbVisual: HTMLElement;
  isDragging: boolean;
  dragStartY: number;
  dragStartScroll: number;
  dragRenderedScale: number;
  observer: MutationObserver;
  resizeObserver: ResizeObserver;
  cleanup: (() => void)[];
  visibleHeight: number;
  thumbHeight: number;
  fadeTimer: number;
  fadeDeadline: number;
  trackVisible: boolean | null;
  hasOverflow: boolean;
  maxScroll: number;
  maxThumbTop: number;
  renderedThumbHeight: number;
  renderedThumbTop: number;
  renderedVisualTransform: string;
  layoutFrame: number | null;
  scrollFrame: number | null;
  scrollIdleFrames: number;
  lastTimelineScrollTop: number;
  timelineEndpointTailUntil: number;
  scrollDriver: ScrollDriver;
  scrollAnimation: Animation | null;
  scrollTimeline: AnimationTimeline | null;
  timelineMaxThumbTop: number;
  timelineGeneration: number;
  revealAfterLayout: boolean;
  destroyed: boolean;
  /** Cached transform-containing-block ancestor (resolved lazily on first updateLayout). */
  transformBlock: HTMLElement | null;
  transformBlockResolved: boolean;
}

const _instances = new Map<HTMLElement, ScrollbarState>();

function getScrollTimelineConstructor(): ScrollTimelineConstructor | null {
  const ctor = (globalThis as typeof globalThis & { ScrollTimeline?: ScrollTimelineConstructor })
    .ScrollTimeline;
  return typeof ctor === 'function' ? ctor : null;
}

function setScrollDriver(state: ScrollbarState, driver: ScrollDriver): void {
  if (state.scrollDriver === driver) return;
  state.scrollDriver = driver;
  state.track.dataset.scrollDriver = driver;
}

function setThumbVisualTransform(state: ScrollbarState, transform: string): boolean {
  if (state.renderedVisualTransform === transform) return false;
  state.renderedVisualTransform = transform;
  state.thumbVisual.style.transform = transform;
  return true;
}

function resetScriptThumbVisual(state: ScrollbarState): boolean {
  // The proven script fallback retains ownership of the outer thumb's height
  // and position, including its rubber-band compression. The nested visual
  // simply fills that exact geometry in this mode.
  return setThumbVisualTransform(state, 'translateY(0px) scaleY(1)');
}

function cancelScrollTimeline(state: ScrollbarState): void {
  state.timelineGeneration += 1;
  state.scrollAnimation?.cancel();
  state.scrollAnimation = null;
  state.scrollTimeline = null;
  state.timelineMaxThumbTop = Number.NaN;
  state.lastTimelineScrollTop = Number.NaN;
  state.timelineEndpointTailUntil = 0;
  setScrollDriver(state, 'script');
  resetScriptThumbVisual(state);
}

function fallBackToScriptDriver(
  state: ScrollbarState,
  animation: Animation,
  generation: number,
): void {
  if (
    state.destroyed ||
    state.scrollAnimation !== animation ||
    state.timelineGeneration !== generation
  ) {
    return;
  }
  cancelScrollTimeline(state);
  // The animation did not commit inline styles. Invalidate the write cache so
  // the first fallback sample always restores the exact current position.
  state.renderedThumbTop = Number.NaN;
  updateScroll(state);
  state.scrollIdleFrames = 0;
  scheduleScrollPump(state);
}

function seedTimelineInlinePosition(state: ScrollbarState): void {
  const clampedScrollTop = Math.min(state.maxScroll, Math.max(0, state.container.scrollTop));
  const top = state.maxScroll > 0 ? (clampedScrollTop / state.maxScroll) * state.maxThumbTop : 0;
  // Scroll timelines clamp rubber-band offsets to their 0%/100% endpoints.
  // Keep the underlying inline state equally clamped so a rebuilt timeline
  // cannot strand the script-only compressed thumb height after bounce-back.
  setThumbHeight(state, state.thumbHeight);
  setThumbTop(state, top);
}

/**
 * Recreate the original elastic endpoint feel without competing with the
 * browser-owned position transform. The outer thumb remains a fixed-size
 * ScrollTimeline target; only its nested visual compresses. At the bottom the
 * child moves down by exactly the amount it lost, preserving the old fixed
 * bottom edge (`visibleHeight - elasticHeight`) geometry.
 */
function updateTimelineElasticity(
  state: ScrollbarState,
  now = performance.now(),
  fromScrollEvent = false,
): boolean {
  const { container, thumbHeight, maxScroll, maxThumbTop } = state;
  if (state.scrollDriver !== 'timeline' || !state.hasOverflow || maxScroll <= 0) return false;

  const rawScrollTop = container.scrollTop;
  const positionChanged = rawScrollTop !== state.lastTimelineScrollTop;
  state.lastTimelineScrollTop = rawScrollTop;

  const atEndpoint = rawScrollTop <= 0 || rawScrollTop >= maxScroll;
  if (atEndpoint && (fromScrollEvent || positionChanged)) {
    state.timelineEndpointTailUntil = now + SCROLL_PUMP_ENDPOINT_TAIL_MS;
  } else if (!atEndpoint && positionChanged) {
    state.timelineEndpointTailUntil = 0;
  }

  const rawThumbTop = (rawScrollTop / maxScroll) * maxThumbTop;
  const compression = Math.min(0, rawThumbTop, maxThumbTop - rawThumbTop);
  const elasticHeight = Math.max(THUMB_MIN_HEIGHT * 0.5, thumbHeight + compression);
  const visualChanged = setThumbVisualTransform(
    state,
    `translateY(${rawThumbTop > maxThumbTop ? thumbHeight - elasticHeight : 0}px) scaleY(${
      elasticHeight / thumbHeight
    })`,
  );
  // In timeline mode ordinary movement changes only the browser-owned outer
  // thumb. Count the sampled raw offset as activity so this pump does not go
  // idle three frames into an otherwise active asynchronous scroll session.
  return visualChanged || positionChanged;
}

/**
 * Hand normal-range thumb movement to the browser's scroll timeline when the
 * complete imperative API works. Transform-only scroll-linked animations are
 * compositor eligible in modern Chromium and WebKit. Older/partial engines
 * stay on the exact requestAnimationFrame implementation below.
 */
function ensureScrollTimeline(state: ScrollbarState): boolean {
  if (!state.hasOverflow || state.maxScroll <= 0 || state.maxThumbTop < 0) return false;
  if (
    state.scrollAnimation &&
    state.scrollTimeline &&
    state.timelineMaxThumbTop === state.maxThumbTop
  ) {
    return true;
  }

  const ScrollTimeline = getScrollTimelineConstructor();
  if (!ScrollTimeline || typeof state.thumb.animate !== 'function') {
    cancelScrollTimeline(state);
    return false;
  }

  seedTimelineInlinePosition(state);
  cancelScrollTimeline(state);
  try {
    const timeline = new ScrollTimeline({ source: state.container, axis: 'block' });
    const animation = state.thumb.animate(
      [{ transform: 'translateY(0px)' }, { transform: `translateY(${state.maxThumbTop}px)` }],
      {
        fill: 'both',
        timeline,
      },
    );

    // A few early implementations accepted the option but silently attached
    // the document timeline. Never suppress the proven script path there.
    if (animation.timeline !== timeline) {
      animation.cancel();
      return false;
    }

    const generation = state.timelineGeneration + 1;
    state.timelineGeneration = generation;
    state.scrollTimeline = timeline;
    state.scrollAnimation = animation;
    state.timelineMaxThumbTop = state.maxThumbTop;
    setScrollDriver(state, 'timeline');
    updateTimelineElasticity(state);

    // Scroll-linked animations become ready asynchronously. A rejected ready
    // promise must not leave a visually frozen thumb on a partially working
    // engine; demote this exact animation instance back to the rAF driver.
    void animation.ready.catch(() => fallBackToScriptDriver(state, animation, generation));
    return true;
  } catch {
    cancelScrollTimeline(state);
    return false;
  }
}

function setStyleIfChanged(style: CSSStyleDeclaration, property: string, value: string): void {
  if (style.getPropertyValue(property) !== value) style.setProperty(property, value);
}

function setThumbHeight(state: ScrollbarState, height: number): boolean {
  if (state.renderedThumbHeight === height) return false;
  state.renderedThumbHeight = height;
  state.thumb.style.height = `${height}px`;
  return true;
}

function setThumbTop(state: ScrollbarState, top: number): boolean {
  if (state.renderedThumbTop === top) return false;
  state.renderedThumbTop = top;
  state.thumb.style.transform = `translateY(${top}px)`;
  return true;
}

function hasVisibleOverflow(container: HTMLElement): boolean {
  const { scrollHeight, clientHeight } = container;
  const style = getComputedStyle(container);
  // A parked tab/dialog can retain its content scrollHeight while its layout
  // box collapses to zero. Visibility-hidden overlays retain full geometry,
  // so exclude those too; otherwise their faded track remains an invisible
  // pointer target above the active screen.
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    SCROLLABLE_OVERFLOW_VALUES.has(style.overflowY) &&
    clientHeight > 1 &&
    scrollHeight > clientHeight + OVERFLOW_ROUNDING_TOLERANCE_PX
  );
}

function setTrackVisible(state: ScrollbarState, visible: boolean): void {
  if (state.trackVisible === visible) return;
  state.trackVisible = visible;
  state.track.style.opacity = visible ? '1' : '0';
  state.track.style.pointerEvents = visible ? 'auto' : 'none';
}

function cancelFade(state: ScrollbarState): void {
  if (state.fadeTimer) window.clearTimeout(state.fadeTimer);
  state.fadeTimer = 0;
  state.fadeDeadline = 0;
}

function armFade(state: ScrollbarState): void {
  if (state.destroyed || state.isDragging || state.fadeTimer || !state.hasOverflow) return;

  const remaining = Math.max(0, state.fadeDeadline - Date.now());
  state.fadeTimer = window.setTimeout(() => {
    state.fadeTimer = 0;
    if (state.destroyed || state.isDragging || !state.hasOverflow) return;

    const nextRemaining = state.fadeDeadline - Date.now();
    if (nextRemaining > 0) {
      armFade(state);
      return;
    }
    setTrackVisible(state, false);
  }, remaining);
}

/** Reveal from cached layout state; the scroll hot path must never force style/layout. */
function showTrack(state: ScrollbarState): void {
  if (!state.hasOverflow) {
    cancelFade(state);
    setTrackVisible(state, false);
    return;
  }

  setTrackVisible(state, true);
  state.fadeDeadline = Date.now() + FADE_DELAY;
  armFade(state);
}

function scheduleLayout(state: ScrollbarState): void {
  if (state.destroyed || state.layoutFrame !== null) return;
  state.layoutFrame = window.requestAnimationFrame(() => {
    state.layoutFrame = null;
    if (!state.destroyed) updateLayout(state);
  });
}

function runLayoutNow(state: ScrollbarState): void {
  if (state.layoutFrame !== null) {
    window.cancelAnimationFrame(state.layoutFrame);
    state.layoutFrame = null;
  }
  if (!state.destroyed) updateLayout(state);
}

// ─── Global settled re-layout (orientation / breakpoint changes) ─────────
//
// Orientation and compact-landscape MQL changes are page-global events, so
// the settled re-layout response is global too: ONE listener pair and ONE
// debounce pair driving a re-layout of every live instance. Registering the
// debounce per instance under a fixed managed-timer key would last-writer-win
// (setManagedTimer replaces by name), leaving only the last-registered
// instance with a settled re-layout — this module-level shape makes that
// collision unrepresentable here (no per-instance setManagedTimer remains).

function relayoutAll(): void {
  // Iterate the live registry at FIRE time, not a snapshot captured at
  // debounce registration: destroyCustomScrollbar can run inside the
  // 350/700ms settle window (dialog teardown) and a snapshot would touch a
  // removed track.
  for (const state of _instances.values()) {
    runLayoutNow(state);
  }
}

// Two-tier delay: CSS transitions settle late after rotation, so a single
// early (or synchronous) re-measure captures mid-transition geometry — same
// 350ms pattern as the visualizer's resize handling. These delayed timers are
// the only settled re-measure path for track *position*: ResizeObserver
// reacts to container box-size changes, never to getBoundingClientRect
// position changes (bottom-nav overlap, transform-block offset, track top).
function onGlobalLayoutChange(): void {
  setManagedTimer('scrollbar-relayout-fast', relayoutAll, 350);
  setManagedTimer('scrollbar-relayout-slow', relayoutAll, 700);
}

let _globalLayoutListenersBound = false;

function ensureGlobalLayoutListeners(): void {
  if (_globalLayoutListenersBound) return;
  _globalLayoutListenersBound = true;
  // App-lifetime listeners, never removed (same once-guard precedent as the
  // visualizer's resize listener). Instance lifecycle is handled by
  // relayoutAll iterating the live registry — no per-instance listener
  // bookkeeping needed.
  onCompactLandscapeChange(onGlobalLayoutChange);
  window.matchMedia('(orientation: landscape)').addEventListener('change', onGlobalLayoutChange);
}

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
  const isContained = container.hasAttribute('data-custom-scroll-contained');

  if (!hasVisibleOverflow(container)) {
    cancelScrollTimeline(state);
    cancelFade(state);
    state.hasOverflow = false;
    state.maxScroll = 0;
    state.maxThumbTop = 0;
    state.visibleHeight = 0;
    state.thumbHeight = 0;
    state.revealAfterLayout = false;
    setTrackVisible(state, false);
    setStyleIfChanged(track.style, 'height', '0px');
    setStyleIfChanged(thumb.style, 'display', 'none');
    resetScriptThumbVisual(state);
    return;
  }
  state.hasOverflow = true;
  setStyleIfChanged(thumb.style, 'display', '');

  const containerRect = container.getBoundingClientRect();
  let visibleHeight = clientHeight;
  const isDesktop = window.matchMedia('(min-width: 1280px)').matches;
  const isCompactLand = isCompactLandscape();

  if (
    !isContained &&
    !isDesktop &&
    !isCompactLand &&
    !document.body.classList.contains('mode-demo')
  ) {
    const bottomNav = document.querySelector('.bottom-nav') as HTMLElement;
    if (bottomNav) {
      const navRect = bottomNav.getBoundingClientRect();
      if (navRect.height > 0 && containerRect.bottom > navRect.top) {
        const overlap = containerRect.bottom - navRect.top;
        visibleHeight = Math.max(0, clientHeight - overlap);
      }
    }
  }

  state.visibleHeight = visibleHeight;
  if (isDesktop || isContained) {
    const parentRect = container.parentElement?.getBoundingClientRect();
    const offsetTop = parentRect
      ? (containerRect.top - parentRect.top) / getBodyRenderedScale()
      : 0;
    setStyleIfChanged(track.style, 'top', `${offsetTop}px`);
    setStyleIfChanged(track.style, 'height', `${visibleHeight}px`);
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
    setStyleIfChanged(track.style, 'top', `${containerRect.top - ancestorTop}px`);
    setStyleIfChanged(track.style, 'height', `${visibleHeight}px`);
  }

  const ratio = visibleHeight / scrollHeight;
  state.thumbHeight = Math.max(THUMB_MIN_HEIGHT, ratio * visibleHeight);
  state.maxScroll = scrollHeight - clientHeight;
  state.maxThumbTop = visibleHeight - state.thumbHeight;
  setThumbHeight(state, state.thumbHeight);

  // Rebuild only when the endpoint changed; the once-per-scroll-session
  // intrinsic layout refresh therefore does not restart a healthy animation.
  // A drag can begin after that refresh is queued but before its rAF runs.
  // Keep script ownership until mouseup/touchend instead of resurrecting a
  // compositor animation underneath the active gesture.
  if (state.isDragging || !ensureScrollTimeline(state)) updateScroll(state);
  else updateTimelineElasticity(state);

  if (state.revealAfterLayout) {
    state.revealAfterLayout = false;
    showTrack(state);
  }
}

/**
 * Sample only scrollTop against cached layout geometry. During ordinary
 * scrolling this performs one layout-value read and, when the thumb moved,
 * one compositor-only transform write. Full geometry is refreshed separately
 * by the coalesced layout path.
 */
function updateScroll(state: ScrollbarState): boolean {
  const { container, visibleHeight, thumbHeight, maxScroll, maxThumbTop } = state;
  if (!state.hasOverflow || maxScroll <= 0) return false;

  const { scrollTop } = container;
  let thumbTop = (scrollTop / maxScroll) * maxThumbTop;

  let h = thumbHeight;

  if (thumbTop < 0) {
    h = Math.max(THUMB_MIN_HEIGHT * 0.5, thumbHeight + thumbTop);
    thumbTop = 0;
  } else if (thumbTop > maxThumbTop) {
    const overflow = thumbTop - maxThumbTop;
    h = Math.max(THUMB_MIN_HEIGHT * 0.5, thumbHeight - overflow);
    thumbTop = visibleHeight - h;
  }

  // Height is static throughout the normal range. It is written only when
  // iOS rubber-band overscroll compresses the thumb, or when returning from
  // that compressed state.
  const heightChanged = setThumbHeight(state, h);
  // Use GPU-accelerated transform instead of style.top for 120fps scrolling
  return setThumbTop(state, thumbTop) || heightChanged;
}

function scheduleScrollPump(state: ScrollbarState): void {
  if (state.destroyed || !state.hasOverflow || state.scrollFrame !== null) {
    return;
  }
  state.scrollFrame = window.requestAnimationFrame((now) => {
    state.scrollFrame = null;
    if (state.destroyed) return;

    const changed =
      state.scrollDriver === 'timeline' ? updateTimelineElasticity(state) : updateScroll(state);
    state.scrollIdleFrames = changed ? 0 : state.scrollIdleFrames + 1;

    // Keep sampling for a few quiet frames. On iOS the native scroller can
    // advance on the compositor between main-thread scroll events; this short
    // pump lets the thumb observe those intermediate positions exactly, with
    // no EMA/easing lag.
    const withinEndpointTail =
      state.scrollDriver === 'timeline' && now < state.timelineEndpointTailUntil;
    if (
      state.isDragging ||
      state.scrollIdleFrames < SCROLL_PUMP_IDLE_FRAMES ||
      withinEndpointTail
    ) {
      scheduleScrollPump(state);
    }
  });
}

function nodeIsCustomScrollbarUi(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest('.cscroll-track'));
}

function childListOnlyChangesCustomScrollbarUi(record: MutationRecord): boolean {
  if (record.type !== 'childList') return false;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return changed.length > 0 && changed.every((node) => nodeIsCustomScrollbarUi(node));
}

function isRangePaintMutation(record: MutationRecord): boolean {
  if (record.type !== 'attributes' || record.attributeName !== 'style') return false;
  const target = record.target;
  // App range inputs use inline style exclusively for --range-progress, a
  // paint-only gradient stop updated by seek playback as often as every rAF.
  // Class changes remain observed for any layout-affecting state. Avoiding
  // attributeOldValue also prevents copying the style string at 60/120 Hz.
  return target instanceof HTMLInputElement && target.type === 'range';
}

function mutationsNeedLayout(records: MutationRecord[]): boolean {
  return records.some((record) => {
    if (nodeIsCustomScrollbarUi(record.target)) return false;
    if (childListOnlyChangesCustomScrollbarUi(record)) return false;
    if (isRangePaintMutation(record)) return false;
    return true;
  });
}

export function initCustomScrollbar(container: HTMLElement): void {
  if (_instances.has(container)) return;

  // Track must be a sibling of the container (not inside it, or it scrolls with content).
  // Append to container's parent and ensure parent is positioned.
  const parent = container.parentElement;
  if (!parent) return;

  const parentPos = getComputedStyle(parent).position;
  if (parentPos === 'static') parent.style.position = 'relative';

  const track = document.createElement('div');
  track.className = 'cscroll-track';
  if (container.hasAttribute('data-custom-scroll-contained')) {
    track.classList.add('cscroll-track-contained');
  }

  const thumb = document.createElement('div');
  thumb.className = 'cscroll-thumb';
  const thumbVisual = document.createElement('div');
  thumbVisual.className = 'cscroll-thumb-visual';
  thumb.appendChild(thumbVisual);
  track.appendChild(thumb);
  parent.appendChild(track);

  const state: ScrollbarState = {
    container,
    track,
    thumb,
    thumbVisual,
    isDragging: false,
    dragStartY: 0,
    dragStartScroll: 0,
    dragRenderedScale: 1,
    observer: null!,
    resizeObserver: null!,
    cleanup: [],
    visibleHeight: 0,
    thumbHeight: 0,
    fadeTimer: 0,
    fadeDeadline: 0,
    trackVisible: null,
    hasOverflow: false,
    maxScroll: 0,
    maxThumbTop: 0,
    renderedThumbHeight: Number.NaN,
    renderedThumbTop: Number.NaN,
    renderedVisualTransform: '',
    layoutFrame: null,
    scrollFrame: null,
    scrollIdleFrames: SCROLL_PUMP_IDLE_FRAMES,
    lastTimelineScrollTop: Number.NaN,
    timelineEndpointTailUntil: 0,
    scrollDriver: 'script',
    scrollAnimation: null,
    scrollTimeline: null,
    timelineMaxThumbTop: Number.NaN,
    timelineGeneration: 0,
    revealAfterLayout: false,
    destroyed: false,
    transformBlock: null,
    transformBlockResolved: false,
  };

  thumb.style.top = '0px';
  resetScriptThumbVisual(state);
  track.style.transition = 'opacity 0.3s ease';
  track.dataset.scrollDriver = 'script';

  setTrackVisible(state, false);

  const onScroll = (): void => {
    const startsNewSession = state.trackVisible !== true;
    if (!state.hasOverflow || startsNewSession) {
      // Refresh once at session start for intrinsic/font/image size changes
      // that alter scrollHeight without changing the container's border box.
      state.revealAfterLayout = !state.hasOverflow;
      scheduleLayout(state);
    }
    showTrack(state);
    state.scrollIdleFrames = 0;
    // Remove the avoidable extra-frame delay at the endpoint. This samples
    // one cached scalar and writes only the nested visual's transform; normal
    // thumb movement remains exclusively owned by ScrollTimeline.
    if (state.scrollDriver === 'timeline') {
      updateTimelineElasticity(state, performance.now(), true);
    }
    scheduleScrollPump(state);
  };
  container.addEventListener('scroll', onScroll, { passive: true });

  state.observer = new MutationObserver((records) => {
    if (mutationsNeedLayout(records)) scheduleLayout(state);
  });
  state.observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });

  state.resizeObserver = new ResizeObserver(() => scheduleLayout(state));
  state.resizeObserver.observe(container);

  // Orientation/breakpoint change → delayed re-layout, handled module-wide:
  // one global event, one debounce, relayout-all (see relayoutAll above).
  ensureGlobalLayoutListeners();

  // Bus signal for transform-based visibility changes (e.g. chat-drawer
  // sliding in via translateY). Neither ResizeObserver nor MutationObserver
  // on the container itself catches a parent transform — the size doesn't
  // change and the open/close class lands on an ancestor — so external
  // callers must signal a relayout when they animate visibility.
  const cleanupRelayoutBus = bus.on('ui:scrollbar-relayout', () => scheduleLayout(state));
  const cleanupRevealBus = bus.on('ui:scrollbar-reveal', (scope) => {
    if (scope && scope !== container && !scope.contains(container)) return;
    state.revealAfterLayout = !state.hasOverflow;
    scheduleLayout(state);
    // Already-measured live surfaces reveal immediately. A parked surface
    // waits for the scheduled layout, which consumes revealAfterLayout once
    // its non-zero geometry becomes available.
    if (state.hasOverflow) showTrack(state);
  });

  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.isDragging = true;
    cancelScrollTimeline(state);
    state.renderedThumbTop = Number.NaN;
    updateScroll(state);
    state.dragStartY = e.clientY;
    state.dragStartScroll = container.scrollTop;
    state.dragRenderedScale = getBodyRenderedScale();
    thumb.classList.add('dragging');
    document.body.style.userSelect = 'none';
    cancelFade(state);
    setTrackVisible(state, true);
  });

  // Touch support for thumb drag.
  // Must be non-passive so preventDefault() can suppress the browser's own
  // touch-scrolling gesture — otherwise mobile scrolls the page at the same
  // time and the header/chrome drifts along with the drag.
  const onThumbTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    state.isDragging = true;
    cancelScrollTimeline(state);
    state.renderedThumbTop = Number.NaN;
    updateScroll(state);
    cancelFade(state);
    setTrackVisible(state, true);
    state.dragStartY = e.touches[0].clientY;
    state.dragStartScroll = container.scrollTop;
    state.dragRenderedScale = getBodyRenderedScale();
    thumb.classList.add('dragging');
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!state.isDragging) return;
    const { scrollHeight, clientHeight } = container;
    const maxScroll = scrollHeight - clientHeight;
    const trackHeight = state.visibleHeight - state.thumbHeight;
    if (trackHeight <= 0) return;
    const localDeltaY = (e.clientY - state.dragStartY) / state.dragRenderedScale;
    container.scrollTop = state.dragStartScroll + (localDeltaY / trackHeight) * maxScroll;
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
    const localDeltaY = (e.touches[0].clientY - state.dragStartY) / state.dragRenderedScale;
    container.scrollTop = state.dragStartScroll + (localDeltaY / trackHeight) * maxScroll;
  };

  const onDragEnd = () => {
    if (!state.isDragging) return;
    state.isDragging = false;
    thumb.classList.remove('dragging');
    document.body.style.userSelect = '';
    updateScroll(state);
    ensureScrollTimeline(state);
    showTrack(state);
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
    cleanupRelayoutBus,
    cleanupRevealBus,
  ];

  track.addEventListener('mousedown', (e) => {
    if (e.target === thumb) return;
    const rect = track.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / rect.height;
    container.scrollTop = clickRatio * (container.scrollHeight - container.clientHeight);
  });

  _instances.set(container, state);

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
  state.destroyed = true;
  cancelScrollTimeline(state);
  cancelFade(state);
  if (state.layoutFrame !== null) window.cancelAnimationFrame(state.layoutFrame);
  if (state.scrollFrame !== null) window.cancelAnimationFrame(state.scrollFrame);
  state.layoutFrame = null;
  state.scrollFrame = null;
  if (state.isDragging) document.body.style.userSelect = '';
  state.observer.disconnect();
  state.resizeObserver.disconnect();
  state.cleanup.forEach((fn) => fn());
  state.track.remove();
  _instances.delete(container);
}
