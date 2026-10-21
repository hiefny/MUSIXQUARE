/** Visibility is independent from playback: hiding a canvas must not discard a held frame. */
export function watchVisualizerVisibility(wrapper: HTMLElement | null, changed: () => void) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let intersects = true;
  let visible = true;
  let reduced = motion.matches;
  const refresh = (): void => {
    const next =
      !document.hidden &&
      !document.body.hasAttribute('data-visualizer-covered') &&
      intersects &&
      (!wrapper || (wrapper.isConnected && wrapper.clientWidth > 10 && wrapper.clientHeight > 10));
    const nextReduced = motion.matches;
    if (next === visible && nextReduced === reduced) return;
    visible = next;
    reduced = nextReduced;
    changed();
  };
  let observer: IntersectionObserver | null = null;
  if (wrapper && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.target === wrapper) intersects = entry.isIntersecting;
      refresh();
    });
    observer.observe(wrapper);
  }
  document.addEventListener('visibilitychange', refresh);
  document.addEventListener('mxqr:visualizer-visibility', refresh);
  motion.addEventListener('change', refresh);
  return {
    get visible() {
      return visible;
    },
    get reduced() {
      return reduced;
    },
    refresh,
    dispose(): void {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', refresh);
      document.removeEventListener('mxqr:visualizer-visibility', refresh);
      motion.removeEventListener('change', refresh);
    },
  };
}
