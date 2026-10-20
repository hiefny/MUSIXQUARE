/**
 * Layout bands shared by every CSS media query and JS matchMedia check.
 *
 * Media features measure the unscaled layout viewport in CSS pixels. The
 * desktop density transform (`--desktop-ui-scale`) only scales the body after
 * these bands are chosen, and only on viewports far taller than 900px, so the
 * same strings decide the layout in CSS and JS.
 *
 * - Phone: width < 720px.
 * - Compact (tablet sidebar): 720–1279px wide, or wider but shorter than 720px.
 * - Desktop dashboard: width >= 1280px and height >= 720px. Below 900px tall,
 *   the header spans only the Play column.
 *
 * `css/style.css`, `css/desktop.css` and `css/playback-actions.css` repeat
 * these exact strings; `layout-breakpoints-contract.test.ts` keeps them equal.
 */
const DESKTOP_LAYOUT_MIN_WIDTH = 1280;
const DESKTOP_LAYOUT_MIN_HEIGHT = 720;

export const DESKTOP_LAYOUT_QUERY = '(min-width: 1280px) and (min-height: 720px)';
export const NOT_DESKTOP_LAYOUT_QUERY = '(max-width: 1279px), (max-height: 719px)';
export const COMPACT_LAYOUT_QUERY =
  '(min-width: 720px) and (max-width: 1279px), (min-width: 1280px) and (max-height: 719px)';
export const SHORT_DESKTOP_LAYOUT_QUERY =
  '(min-width: 1280px) and (min-height: 720px) and (max-height: 899px)';

/** Wide dashboard layout. False when matchMedia is unavailable. */
export function isDesktopLayout(): boolean {
  try {
    return window.matchMedia(DESKTOP_LAYOUT_QUERY).matches;
  } catch {
    /* matchMedia can be unavailable in jsdom and old browsers. */
    return false;
  }
}

/** The desktop decision for an explicit viewport size, in CSS pixels. */
export function isDesktopLayoutSize(width: number, height: number): boolean {
  return width >= DESKTOP_LAYOUT_MIN_WIDTH && height >= DESKTOP_LAYOUT_MIN_HEIGHT;
}
