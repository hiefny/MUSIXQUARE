/**
 * Register the full Pretendard face only after the initial page has loaded.
 *
 * The app's system/Noto fallback stacks paint the first frame. Vite keeps the
 * dynamic stylesheet in a separate chunk, so its 2 MiB font cannot compete
 * with the release-critical HTML, CSS, and JavaScript graph.
 */

import { log } from '../core/log.ts';

const PRIMARY_FONT_IDLE_TIMEOUT_MS = 2_000;

type PrimaryFontLoader = () => Promise<unknown>;
type IdleCapableWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

const loadPrimaryFontCss: PrimaryFontLoader = () => import('../../css/pretendard.css');

export function schedulePrimaryFontLoad(
  targetWindow: Window = window,
  targetDocument: Document = document,
  loader: PrimaryFontLoader = loadPrimaryFontCss,
): void {
  const loadAfterIdle = () => {
    const startLoad = () => {
      void loader().catch((error) => {
        // Font failure must leave the already-painted fallback stack intact.
        log.warn('[Font] Could not load the optional Pretendard face', error);
      });
    };
    const idleWindow = targetWindow as IdleCapableWindow;
    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleWindow.requestIdleCallback(startLoad, { timeout: PRIMARY_FONT_IDLE_TIMEOUT_MS });
    } else {
      // Safari has no requestIdleCallback. A new task after `load` preserves
      // the same network ordering without holding the font indefinitely.
      targetWindow.setTimeout(startLoad, 0);
    }
  };

  if (targetDocument.readyState === 'complete') {
    loadAfterIdle();
  } else {
    targetWindow.addEventListener('load', loadAfterIdle, { once: true });
  }
}
