export function prefersReducedScrollMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Use the browser's native smooth-scroll implementation so long jumps stay on
 * the compositor and share the same motion curve everywhere in the app.
 */
export function scrollToWithPreferredMotion(
  scrollContainer: HTMLElement,
  top: number,
): ScrollBehavior {
  const behavior: ScrollBehavior = prefersReducedScrollMotion() ? 'auto' : 'smooth';
  if (typeof scrollContainer.scrollTo === 'function') {
    try {
      scrollContainer.scrollTo({ top, behavior });
      return behavior;
    } catch {
      // Legacy/embedded webviews can expose scrollTo while rejecting the
      // options-object overload. Keep the control functional without motion.
    }
  }
  scrollContainer.scrollTop = top;
  return 'auto';
}

/**
 * Interrupt an in-flight native smooth scroll without changing its current
 * visual position. This is used when the user takes direct control or a newer
 * destination supersedes the old one.
 */
export function cancelNativeSmoothScroll(scrollContainer: HTMLElement): void {
  const top = scrollContainer.scrollTop;
  if (typeof scrollContainer.scrollTo === 'function') {
    try {
      scrollContainer.scrollTo({ top, behavior: 'auto' });
      return;
    } catch {
      // Fall through to the legacy property assignment.
    }
  }
  scrollContainer.scrollTop = top;
}
