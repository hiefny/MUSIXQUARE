import { getBodyRenderedScale } from '../core/platform.ts';

interface EffectiveScrollViewport {
  renderedScale: number;
  rawTop: number;
  top: number;
  bottom: number;
  heightCss: number;
  centerOffsetCss: number;
}

function resolvedScrollInset(value: string, maximum: number): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(maximum, parsed);
}

/**
 * Resolve the part of a scrollport intended to remain visually unobstructed.
 *
 * Layout metrics such as clientHeight and scrollTop use pre-transform CSS
 * pixels, while DOMRects use rendered viewport pixels. scroll-padding marks
 * mobile navigation/safe-area clearance and therefore belongs to the effective
 * viewport for centering and visibility checks, not just native snap behavior.
 */
export function getEffectiveScrollViewport(scrollContainer: HTMLElement): EffectiveScrollViewport {
  const renderedScale = getBodyRenderedScale();
  const containerRect = scrollContainer.getBoundingClientRect();
  const rawTop = containerRect.top + scrollContainer.clientTop * renderedScale;
  const style = window.getComputedStyle(scrollContainer);
  const topInsetCss = resolvedScrollInset(style.scrollPaddingTop, scrollContainer.clientHeight);
  const bottomInsetCss = resolvedScrollInset(
    style.scrollPaddingBottom,
    Math.max(0, scrollContainer.clientHeight - topInsetCss),
  );
  const heightCss = Math.max(0, scrollContainer.clientHeight - topInsetCss - bottomInsetCss);
  const top = rawTop + topInsetCss * renderedScale;
  const bottom = top + heightCss * renderedScale;

  return {
    renderedScale,
    rawTop,
    top,
    bottom,
    heightCss,
    centerOffsetCss: topInsetCss + heightCss / 2,
  };
}
