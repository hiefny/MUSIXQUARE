/**
 * Overflow-aware playlist title marquee.
 *
 * CSS decides *when* an overflowing title may move (hover/focus on a
 * hover-capable device, or the exact current row on a coarse touch device).
 * This module only measures the amount of hidden text, so short titles remain
 * completely static and the animation never changes row geometry.
 */

const TITLE_SELECTOR = '.track-name-text, .sub-name';
const CONTENT_CLASS = 'playlist-title-marquee-content';
const OVERFLOW_CLASS = 'is-playlist-title-overflowing';
const MIN_OVERFLOW_PX = 1;
const TRAVEL_SPEED_PX_PER_SECOND = 40;
const PING_PONG_PAUSE_SECONDS = 4;

let _measureFrame = 0;
let _list: HTMLElement | null = null;
let _resizeObserver: ResizeObserver | null = null;
let _resizeAbort: AbortController | null = null;
let _observedListWidth = -1;
const _pendingTitles = new Set<HTMLElement>();

type TitleMeasureRoot = ParentNode | readonly HTMLElement[];

function titleContainers(root: TitleMeasureRoot): HTMLElement[] {
  if (Array.isArray(root)) return [...root];
  const parent = root as ParentNode;
  const containers: HTMLElement[] = [];
  if (parent instanceof HTMLElement && parent.matches(TITLE_SELECTOR)) containers.push(parent);
  containers.push(...parent.querySelectorAll<HTMLElement>(TITLE_SELECTOR));
  return containers;
}

function clearOverflow(container: HTMLElement): void {
  container.classList.remove(OVERFLOW_CLASS);
  container.style.removeProperty('--playlist-marquee-offset');
  container.style.removeProperty('--playlist-marquee-duration');
}

function flushMeasurements(): void {
  _measureFrame = 0;
  const pending = Array.from(_pendingTitles);
  _pendingTitles.clear();

  // Read all geometry before writing classes and custom properties. This
  // prevents one title's style update from forcing layout for every next row.
  const measurements = pending.map((container) => {
    if (!container.isConnected) return { container, overflow: 0, valid: false };
    const content = container.querySelector<HTMLElement>(`:scope > .${CONTENT_CLASS}`);
    if (!content) return { container, overflow: 0, valid: false };
    // Keep the child inline while idle so the parent's native ellipsis still
    // paints. offsetWidth reports the untransformed intrinsic inline width;
    // scrollWidth is retained as a DOM-test/older-engine fallback.
    const intrinsicWidth = content.offsetWidth || content.scrollWidth;
    return { container, overflow: Math.ceil(intrinsicWidth - container.clientWidth), valid: true };
  });

  for (const { container, overflow, valid } of measurements) {
    if (!valid || overflow <= MIN_OVERFLOW_PX) {
      clearOverflow(container);
      continue;
    }
    container.classList.add(OVERFLOW_CLASS);
    container.style.setProperty('--playlist-marquee-offset', `${-overflow}px`);
    const travelSeconds = overflow / TRAVEL_SPEED_PX_PER_SECOND;
    container.style.setProperty(
      '--playlist-marquee-duration',
      `${Math.max(PING_PONG_PAUSE_SECONDS, travelSeconds * 2 + PING_PONG_PAUSE_SECONDS)}s`,
    );
  }
}

/** Queue one title (or every title below a root) for a batched overflow read. */
export function schedulePlaylistTitleMarqueeMeasure(root: TitleMeasureRoot): void {
  for (const container of titleContainers(root)) _pendingTitles.add(container);
  if (_measureFrame) return;
  _measureFrame = requestAnimationFrame(flushMeasurements);
}

/** Install resize remeasurement for the currently mounted playlist. */
export function initPlaylistTitleMarquee(list: HTMLElement): void {
  _resizeObserver?.disconnect();
  _resizeObserver = null;
  _resizeAbort?.abort();
  _resizeAbort = new AbortController();
  _list = list;
  _observedListWidth = list.getBoundingClientRect().width;

  const remeasure = () => {
    if (_list === list && list.isConnected) schedulePlaylistTitleMarqueeMeasure(list);
  };

  // Script-specific user fonts are loaded lazily. Their intrinsic glyph
  // widths can change while the playlist box itself remains exactly the same
  // size, so a list-only ResizeObserver cannot detect that title geometry is
  // stale. Recheck after both the current font set and later loading batches.
  const fonts = document.fonts;
  if (fonts) {
    fonts.addEventListener('loadingdone', remeasure, { signal: _resizeAbort.signal });
    void fonts.ready.then(remeasure).catch(() => {
      /* A failed font load keeps the already measured fallback-font width. */
    });
  }

  if (typeof ResizeObserver === 'function') {
    _resizeObserver = new ResizeObserver((entries) => {
      const width = entries.find((entry) => entry.target === list)?.contentRect.width;
      if (width === undefined || Math.abs(width - _observedListWidth) <= 0.5) return;
      _observedListWidth = width;
      remeasure();
    });
    _resizeObserver.observe(list);
  } else {
    window.addEventListener('resize', remeasure, { signal: _resizeAbort.signal });
  }
}
