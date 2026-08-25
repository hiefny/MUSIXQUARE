/**
 * Lazy Pretendard runtime.
 *
 * This is a stable classic script rather than a module: a failed module fetch
 * can remain sticky in the browser module map, while bootstrap.js can remove
 * and reinsert this script after an interrupted launch.
 */
(function () {
  'use strict';

  interface PrimaryFontRuntime {
    state: 'loading' | 'ready' | 'retrying';
    attempts: number;
    family: string;
    lastError?: string;
  }

  interface PrimaryFontWindow extends Window {
    __mxqrPrimaryFontRuntime?: PrimaryFontRuntime;
  }

  const RUNTIME_KEY = '__mxqrPrimaryFontRuntime';
  const runtimeWindow = window as PrimaryFontWindow;
  if (runtimeWindow[RUNTIME_KEY]) return;

  const CSS_URL = '/primary-font.css';
  const FONT_URL = '/designsystem/fonts/PretendardVariable.woff2';
  const RECOVERY_FAMILY = 'MUSIXQUARE Pretendard Recovery';
  const ATTEMPT_TIMEOUT_MS = 8000;
  const RETRY_DELAYS_MS = [1000, 3000, 10000, 30000] as const;
  let attempt = 0;
  let retryTimer = 0;
  let running = false;
  let complete = false;
  const runtime: PrimaryFontRuntime = { state: 'loading', attempts: 0, family: 'Pretendard' };
  runtimeWindow[RUNTIME_KEY] = runtime;

  function loadStylesheet(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const previous = document.querySelector('link[data-mxqr-primary-font]');
      if (previous) previous.remove();

      const link = document.createElement('link');
      let settled = false;
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      link.setAttribute('data-mxqr-primary-font', 'loading');

      function finish(error?: Error): void {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        link.onload = null;
        link.onerror = null;
        if (error) {
          link.remove();
          reject(error);
        } else {
          link.setAttribute('data-mxqr-primary-font', 'ready');
          resolve();
        }
      }
      function onAbort(): void {
        finish(new Error('PRIMARY_FONT_CSS_ABORTED'));
      }

      link.onload = () => {
        finish();
      };
      link.onerror = () => {
        finish(new Error('PRIMARY_FONT_CSS_FAILED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      document.head.appendChild(link);
    });
  }

  async function loadCssFace(signal: AbortSignal): Promise<void> {
    await loadStylesheet(signal);
    if (!document.fonts || typeof document.fonts.load !== 'function') return;
    const faces = await document.fonts.load('400 1em Pretendard', '가');
    if (!faces || faces.length === 0) throw new Error('PRIMARY_FONT_FACE_UNAVAILABLE');
  }

  async function loadRecoveryFace(signal: AbortSignal): Promise<void> {
    const response = await fetch(FONT_URL, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error('PRIMARY_FONT_FETCH_FAILED:' + response.status);
    const body = await response.arrayBuffer();
    if (typeof FontFace !== 'function' || !document.fonts) {
      throw new Error('PRIMARY_FONT_FACE_API_UNAVAILABLE');
    }
    const face = new FontFace(RECOVERY_FAMILY, body, {
      style: 'normal',
      weight: '45 920',
      display: 'swap',
    });
    const loadedFace = await face.load();
    document.fonts.add(loadedFace);
    document.documentElement.setAttribute('data-mxqr-font-recovery', 'true');
    runtime.family = RECOVERY_FAMILY;
  }

  function scheduleRetry(): void {
    if (complete || retryTimer || document.visibilityState === 'hidden') return;
    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? 30000;
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      startAttemptInBackground();
    }, delay);
  }

  function retryNow(): void {
    if (complete) return;
    if (retryTimer) window.clearTimeout(retryTimer);
    retryTimer = 0;
    if (!running) startAttemptInBackground();
  }

  async function startAttempt(): Promise<void> {
    if (complete || running) return;
    running = true;
    attempt += 1;
    runtime.attempts = attempt;
    const controller = new AbortController();
    let timeout = 0;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = window.setTimeout(() => {
        controller.abort();
        reject(new Error('PRIMARY_FONT_LOAD_TIMEOUT'));
      }, ATTEMPT_TIMEOUT_MS);
    });
    const work =
      attempt === 1 ? loadCssFace(controller.signal) : loadRecoveryFace(controller.signal);

    try {
      await Promise.race([work, deadline]);
      complete = true;
      runtime.state = 'ready';
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = 0;
    } catch (error) {
      runtime.state = 'retrying';
      runtime.lastError = errorMessage(error);
      scheduleRetry();
    } finally {
      window.clearTimeout(timeout);
      controller.abort();
      running = false;
    }
  }

  function startAttemptInBackground(): void {
    startAttempt().catch((error: unknown) => {
      runtime.state = 'retrying';
      runtime.lastError = errorMessage(error);
      scheduleRetry();
    });
  }

  function errorMessage(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error && error.message) {
      return String(error.message);
    }
    return 'PRIMARY_FONT_LOAD_FAILED';
  }

  window.addEventListener('online', retryNow);
  window.addEventListener('pageshow', retryNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') retryNow();
  });
  startAttemptInBackground();
})();
