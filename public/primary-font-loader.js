/**
 * Lazy Pretendard runtime.
 *
 * This is a stable classic script rather than a module: a failed module fetch
 * can remain sticky in the browser module map, while bootstrap.js can remove
 * and reinsert this script after an interrupted launch.
 */
(function () {
  'use strict';

  var RUNTIME_KEY = '__mxqrPrimaryFontRuntime';
  if (window[RUNTIME_KEY]) return;

  var CSS_URL = '/primary-font.css';
  var FONT_URL = '/designsystem/fonts/PretendardVariable.woff2';
  var RECOVERY_FAMILY = 'MUSIXQUARE Pretendard Recovery';
  var ATTEMPT_TIMEOUT_MS = 8000;
  var RETRY_DELAYS_MS = [1000, 3000, 10000, 30000];
  var attempt = 0;
  var retryTimer = 0;
  var running = false;
  var complete = false;
  var runtime = { state: 'loading', attempts: 0, family: 'Pretendard' };
  window[RUNTIME_KEY] = runtime;

  function loadStylesheet(signal) {
    return new Promise(function (resolve, reject) {
      var previous = document.querySelector('link[data-mxqr-primary-font]');
      if (previous) previous.remove();

      var link = document.createElement('link');
      var settled = false;
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      link.setAttribute('data-mxqr-primary-font', 'loading');

      function finish(error) {
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
      function onAbort() {
        finish(new Error('PRIMARY_FONT_CSS_ABORTED'));
      }

      link.onload = function () {
        finish();
      };
      link.onerror = function () {
        finish(new Error('PRIMARY_FONT_CSS_FAILED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      document.head.appendChild(link);
    });
  }

  async function loadCssFace(signal) {
    await loadStylesheet(signal);
    if (!document.fonts || typeof document.fonts.load !== 'function') return;
    var faces = await document.fonts.load('400 1em Pretendard', '가');
    if (!faces || faces.length === 0) throw new Error('PRIMARY_FONT_FACE_UNAVAILABLE');
  }

  async function loadRecoveryFace(signal) {
    var response = await fetch(FONT_URL, { credentials: 'same-origin', signal: signal });
    if (!response.ok) throw new Error('PRIMARY_FONT_FETCH_FAILED:' + response.status);
    var body = await response.arrayBuffer();
    if (typeof FontFace !== 'function' || !document.fonts) {
      throw new Error('PRIMARY_FONT_FACE_API_UNAVAILABLE');
    }
    var face = new FontFace(RECOVERY_FAMILY, body, {
      style: 'normal',
      weight: '45 920',
      display: 'swap',
    });
    var loadedFace = await face.load();
    document.fonts.add(loadedFace);
    document.documentElement.setAttribute('data-mxqr-font-recovery', 'true');
    runtime.family = RECOVERY_FAMILY;
  }

  function scheduleRetry() {
    if (complete || retryTimer || document.visibilityState === 'hidden') return;
    var delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    retryTimer = window.setTimeout(function () {
      retryTimer = 0;
      startAttempt();
    }, delay);
  }

  function retryNow() {
    if (complete) return;
    if (retryTimer) window.clearTimeout(retryTimer);
    retryTimer = 0;
    if (!running) startAttempt();
  }

  async function startAttempt() {
    if (complete || running) return;
    running = true;
    attempt += 1;
    runtime.attempts = attempt;
    var controller = new AbortController();
    var timeout = 0;
    var deadline = new Promise(function (_resolve, reject) {
      timeout = window.setTimeout(function () {
        controller.abort();
        reject(new Error('PRIMARY_FONT_LOAD_TIMEOUT'));
      }, ATTEMPT_TIMEOUT_MS);
    });
    var work = attempt === 1 ? loadCssFace(controller.signal) : loadRecoveryFace(controller.signal);

    try {
      await Promise.race([work, deadline]);
      complete = true;
      runtime.state = 'ready';
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = 0;
    } catch (error) {
      runtime.state = 'retrying';
      runtime.lastError =
        error && error.message ? String(error.message) : 'PRIMARY_FONT_LOAD_FAILED';
      scheduleRetry();
    } finally {
      window.clearTimeout(timeout);
      controller.abort();
      running = false;
    }
  }

  window.addEventListener('online', retryNow);
  window.addEventListener('pageshow', retryNow);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden') retryNow();
  });
  startAttempt();
})();
