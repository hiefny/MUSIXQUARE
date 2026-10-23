/**
 * MUSIXQUARE — Playlist row motion (RO-27)
 *
 * What the lazy playlist controllers share about moving rows and the
 * `.tab-body` scroll: the reorder drag (playlist-reorder.ts), the deletion
 * glide (playlist-removal.ts) and the check-column and two-finger selection
 * drags (playlist-selection-gestures.ts). Only those controllers import it,
 * never the eager playlist-view.ts; vite.config.ts lists it with the deferred
 * modules so the build fails if it ever joins the initial bundle.
 *
 * Values that only look alike stay with their own controller: the click
 * suppression after a drop (reorder) and after a range drag (selection), the
 * selection pills' morph and the header crossfade (removal).
 */

/** Travel that turns a press into a drag; it also arms an edge a press starts in. */
export const PLAYLIST_MOVE_TOLERANCE_PX = 8;

/** Rows gliding to a new slot: reorder FLIP and the survivors of a deletion. */
export const PLAYLIST_ROW_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// Edge zones scale with the visible pane. A desktop playlist shares its
// column with chat and can be only three or four rows tall, so a fixed 40px
// floor would turn most of the first and last visible rows into scroll zones.
const EDGE_ZONE_RATIO = 0.12;
const EDGE_ZONE_MAX_PX = 72;
const EDGE_ZONE_MIN_PX = 24;
const EDGE_SCROLL_MAX_PX = 18;

/** A drag's pointer track, as edge auto-scroll reads and arms it. */
interface EdgeAutoScrollTrack {
  readonly startClientY: number;
  readonly lastClientY: number;
  topEdgeArmed: boolean;
  bottomEdgeArmed: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The pane's visible bounds, above a bottom navigation that overlaps it. */
function visibleScrollBounds(scrollContainer: HTMLElement): { top: number; bottom: number } {
  const rect = scrollContainer.getBoundingClientRect();
  let bottom = rect.bottom;
  const bottomNav = document.querySelector<HTMLElement>('.bottom-nav');
  if (bottomNav) {
    const style = window.getComputedStyle(bottomNav);
    const navRect = bottomNav.getBoundingClientRect();
    const overlapsHorizontally = navRect.right > rect.left && navRect.left < rect.right;
    const overlapsVertically = navRect.bottom > rect.top && navRect.top < rect.bottom;
    if (
      style.display !== 'none' &&
      navRect.height > 0 &&
      overlapsHorizontally &&
      overlapsVertically
    ) {
      bottom = Math.min(bottom, navRect.top);
    }
  }
  return { top: rect.top, bottom };
}

/**
 * Pixels to scroll this frame (negative is up) for a drag held near an edge
 * of the visible pane: zero outside the zones, growing quadratically to
 * EDGE_SCROLL_MAX_PX at the edge. Arms each edge on the track as a side
 * effect.
 */
export function edgeAutoScrollVelocity(
  scrollContainer: HTMLElement,
  track: EdgeAutoScrollTrack,
): number {
  const { top, bottom } = visibleScrollBounds(scrollContainer);
  const height = Math.max(1, bottom - top);
  const zone = clamp(height * EDGE_ZONE_RATIO, EDGE_ZONE_MIN_PX, EDGE_ZONE_MAX_PX);
  const y = track.lastClientY;
  const topDepth = top + zone - y;
  const bottomDepth = y - (bottom - zone);
  // Grabbing the first or last visible row starts inside an edge zone. Arm
  // each edge only after the pointer has been outside it or has travelled
  // toward it, so picking up an edge row never scrolls by itself.
  if (topDepth <= 0 || track.startClientY - y >= PLAYLIST_MOVE_TOLERANCE_PX) {
    track.topEdgeArmed = true;
  }
  if (bottomDepth <= 0 || y - track.startClientY >= PLAYLIST_MOVE_TOLERANCE_PX) {
    track.bottomEdgeArmed = true;
  }
  if (topDepth > 0 && track.topEdgeArmed) {
    const ratio = clamp(topDepth / zone, 0, 1);
    return -EDGE_SCROLL_MAX_PX * ratio * ratio;
  }
  if (bottomDepth > 0 && track.bottomEdgeArmed) {
    const ratio = clamp(bottomDepth / zone, 0, 1);
    return EDGE_SCROLL_MAX_PX * ratio * ratio;
  }
  return 0;
}
