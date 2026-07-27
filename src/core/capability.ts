import {
  cancelResponseBody,
  readBoundedJsonResponse,
  withRequestDeadline,
} from './request-lifetime.ts';

export type CapabilityScope = 'turn' | 'realtime' | 'youtube-search' | 'remote-share';

interface SecurityConfig {
  capabilityRequired: boolean;
  turnstileSiteKey: string;
  turnstileRequired: boolean;
  proofOfWorkRequired: boolean;
  proofOfWorkDifficulty: number;
  proofOfWorkTtl: number;
  ttl: number;
}

interface CapabilityTokenResponse {
  token?: string;
  expiresAt?: number;
}

interface ProofOfWorkChallengeResponse {
  challenge?: string;
  difficulty?: number;
  expiresAt?: number;
  algorithm?: string;
}

interface TurnstileOptions {
  sitekey: string;
  action: string;
  execution: 'execute';
  appearance: 'interaction-only';
  callback: (token: string) => void;
  'before-interactive-callback': () => void;
  'error-callback': () => void;
  'expired-callback': () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
  remove?: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SECURITY_CONFIG_CACHE_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 30;
const TURNSTILE_EXECUTION_TIMEOUT_MS = 30_000;
const TURNSTILE_SCRIPT_LOAD_TIMEOUT_MS = 20_000;
const TURNSTILE_OVERLAY_FADE_MS = 180;
const SILENT_CAPABILITY_WARM_TIMEOUT_MS = 8_000;
const CAPABILITY_HTTP_TIMEOUT_MS = 15_000;
const CAPABILITY_RESPONSE_MAX_BYTES = 64 * 1024;
const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TURNSTILE_STYLE_ID = 'mxqr-turnstile-style';
const CAPABILITY_CHALLENGE_CANCELLED = 'CapabilityChallengeCancelled';
const POW_BATCH_SIZE = 64;
const VALID_SCOPES = new Set<CapabilityScope>([
  'turn',
  'realtime',
  'youtube-search',
  'remote-share',
]);
// Bundle every paid scope into a single mint so, when human verification is
// enabled, it normally runs once per cached token lifetime (10 minutes by
// default) rather than once per scope. Any scope request uses the same bundle
// cache entry. The broader token is constrained by IP binding, the server's
// short configurable TTL, and per-endpoint rate limits.
const BUNDLE_SCOPES: CapabilityScope[] = ['realtime', 'remote-share', 'turn', 'youtube-search'];

const configCache = new Map<string, { expiresAt: number; value: SecurityConfig }>();
const tokenCache = new Map<string, { expiresAt: number; token: string }>();
const tokenRequestCache = new Map<string, Promise<string>>();

function getOrCreateSharedTokenRequest(
  cacheKey: string,
  apiBase: string,
  config: SecurityConfig,
): Promise<string> {
  const existing = tokenRequestCache.get(cacheKey);
  if (existing) return existing;
  // Shared work is intentionally ownerless. Individual caller/warmup aborts
  // race only their own wait and must never cancel another upload or SFU
  // request that adopted the same mint.
  const request = requestCapabilityToken(apiBase, BUNDLE_SCOPES, config).finally(() => {
    if (tokenRequestCache.get(cacheKey) === request) tokenRequestCache.delete(cacheKey);
  });
  tokenRequestCache.set(cacheKey, request);
  return request;
}
let turnstileLoadPromise: Promise<void> | null = null;
let turnstileExecution: Promise<string> | null = null;
let turnstileWidgetId: string | null = null;
let turnstileContainer: HTMLElement | null = null;
let turnstileWidgetHost: HTMLElement | null = null;
let turnstileCancelReject: ((error: Error) => void) | null = null;
let turnstileCleanupTimer: number | null = null;
let capabilityCancelGeneration = 0;

function createCapabilityChallengeCancelledError(reason: string): Error {
  const error = new Error(reason);
  error.name = CAPABILITY_CHALLENGE_CANCELLED;
  return error;
}

function createAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal?.reason === 'string' && signal.reason ? signal.reason : 'Operation aborted',
  );
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal);
}

/** Let one caller abandon shared UI work without cancelling another caller's challenge. */
function settleWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(createAbortError(signal)));

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    // Covers an abort between the caller's initial guard and listener setup.
    if (signal.aborted) onAbort();
  });
}

export function isCapabilityChallengeCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === CAPABILITY_CHALLENGE_CANCELLED;
}

function normalizeScopes(scopes: CapabilityScope[]): CapabilityScope[] {
  const result: CapabilityScope[] = [];
  for (const scope of scopes) {
    if (VALID_SCOPES.has(scope) && !result.includes(scope)) result.push(scope);
  }
  return result.sort();
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return new URL(input.url, window.location.href);
  }
  return new URL(String(input), window.location.href);
}

function apiBaseFor(input: RequestInfo | URL): string {
  const url = requestUrl(input);
  return url.origin === window.location.origin ? '' : url.origin;
}

function tokenCacheKey(apiBase: string, scopes: CapabilityScope[]): string {
  return `${apiBase}:${scopes.join(',')}`;
}

function normalizeSecurityConfig(value: unknown): SecurityConfig {
  const payload = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    capabilityRequired: payload.capabilityRequired === true,
    turnstileSiteKey: typeof payload.turnstileSiteKey === 'string' ? payload.turnstileSiteKey : '',
    turnstileRequired: payload.turnstileRequired === true,
    proofOfWorkRequired: payload.proofOfWorkRequired === true,
    proofOfWorkDifficulty:
      typeof payload.proofOfWorkDifficulty === 'number' &&
      Number.isInteger(payload.proofOfWorkDifficulty)
        ? payload.proofOfWorkDifficulty
        : 0,
    proofOfWorkTtl:
      typeof payload.proofOfWorkTtl === 'number' && Number.isFinite(payload.proofOfWorkTtl)
        ? payload.proofOfWorkTtl
        : 0,
    ttl: typeof payload.ttl === 'number' && Number.isFinite(payload.ttl) ? payload.ttl : 600,
  };
}

async function getSecurityConfig(
  apiBase: string,
  signal?: AbortSignal,
  failOpen = true,
): Promise<SecurityConfig> {
  throwIfAborted(signal);
  const cached = configCache.get(apiBase);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const value = await withRequestDeadline(
      async (requestSignal) => {
        const response = await fetch(`${apiBase}/api/security-config`, {
          headers: { Accept: 'application/json' },
          signal: requestSignal,
        });
        if (!response.ok) {
          await cancelResponseBody(response);
          throw new Error(`security config HTTP ${response.status}`);
        }
        return normalizeSecurityConfig(
          await readBoundedJsonResponse(response, CAPABILITY_RESPONSE_MAX_BYTES, requestSignal),
        );
      },
      {
        signal,
        timeoutMs: CAPABILITY_HTTP_TIMEOUT_MS,
        timeoutReason: 'CAPABILITY_SECURITY_CONFIG_TIMEOUT',
      },
    );
    configCache.set(apiBase, {
      expiresAt: Date.now() + SECURITY_CONFIG_CACHE_MS,
      value,
    });
    return value;
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal);
    if (!failOpen) throw error;
    return {
      capabilityRequired: false,
      turnstileSiteKey: '',
      turnstileRequired: false,
      proofOfWorkRequired: false,
      proofOfWorkDifficulty: 0,
      proofOfWorkTtl: 0,
      ttl: 600,
    };
  }
}

/** Drop the cached security-config probe so the next getSecurityConfig() re-fetches.
 *  Used on a 401 retry: a 401 means the endpoint really required capability, so a
 *  cached `capabilityRequired:false` (possibly from a failed-open probe) was wrong. */
function invalidateSecurityConfig(apiBase: string): void {
  configCache.delete(apiBase);
}

async function loadTurnstile(): Promise<void> {
  if (window.turnstile) return;
  if (turnstileLoadPromise) {
    try {
      return await turnstileLoadPromise;
    } catch (error) {
      turnstileLoadPromise = null;
      throw error;
    }
  }

  turnstileLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    );
    let settled = false;
    let timeoutId: number | null = null;
    let watchedScript: HTMLScriptElement | null = null;
    const onLoad = () => {
      if (watchedScript) finishLoad(watchedScript);
    };
    const onError = () => {
      if (watchedScript) failLoad(watchedScript);
    };
    const cleanup = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      watchedScript?.removeEventListener('load', onLoad);
      watchedScript?.removeEventListener('error', onError);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const finishLoad = (script: HTMLScriptElement) => {
      if (window.turnstile) {
        settle(resolve);
        return;
      }
      // A load event without the public API is just as unusable as a network
      // error. Remove the poisoned node so a later user action can retry.
      settle(() => {
        script.remove();
        reject(new Error('Turnstile unavailable after script load'));
      });
    };
    const failLoad = (script: HTMLScriptElement, reason = 'Turnstile load failed') => {
      // Keeping a failed script makes the next attempt attach listeners to an
      // element whose one-shot error event has already fired, hanging forever.
      settle(() => {
        script.remove();
        reject(new Error(reason));
      });
    };
    const watch = (script: HTMLScriptElement) => {
      watchedScript = script;
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      timeoutId = window.setTimeout(
        () => failLoad(script, 'Turnstile script load timed out'),
        TURNSTILE_SCRIPT_LOAD_TIMEOUT_MS,
      );
    };
    if (existing) {
      watch(existing);
      return;
    }

    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    watch(script);
    document.head.appendChild(script);
  });

  try {
    return await turnstileLoadPromise;
  } catch (error) {
    turnstileLoadPromise = null;
    throw error;
  }
}

function ensureTurnstileStyles(): void {
  if (document.getElementById(TURNSTILE_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = TURNSTILE_STYLE_ID;
  style.textContent = `
#mxqr-turnstile-container {
  opacity: 0;
  pointer-events: none;
  transition: opacity ${TURNSTILE_OVERLAY_FADE_MS}ms ease;
}
#mxqr-turnstile-container.mxqr-turnstile-visible {
  opacity: 1;
  pointer-events: auto;
}
.mxqr-turnstile-frame {
  position: relative;
  display: grid;
  place-items: center;
  min-width: min(300px, calc(100vw - 48px));
}
.mxqr-turnstile-widget {
  position: relative;
  z-index: 1;
}
@media (prefers-reduced-motion: reduce) {
  #mxqr-turnstile-container {
    transition: none;
  }
}
`;
  document.head.appendChild(style);
}

function ensureTurnstileContainer(): HTMLElement {
  if (turnstileCleanupTimer !== null) {
    window.clearTimeout(turnstileCleanupTimer);
    turnstileCleanupTimer = null;
  }

  if (turnstileContainer?.isConnected && turnstileWidgetHost?.isConnected) {
    return turnstileWidgetHost;
  }

  const existing = document.getElementById('mxqr-turnstile-container');
  if (existing) {
    existing.remove();
  }

  ensureTurnstileStyles();

  const container = document.createElement('div');
  container.id = 'mxqr-turnstile-container';
  container.style.position = 'fixed';
  container.style.inset = '0';
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.justifyContent = 'center';
  container.style.boxSizing = 'border-box';
  container.style.padding = '24px';
  container.style.background = 'rgba(6, 10, 18, 0.42)';
  container.style.zIndex = '2147483647';

  const frame = document.createElement('div');
  frame.className = 'mxqr-turnstile-frame';

  const widgetHost = document.createElement('div');
  widgetHost.id = 'mxqr-turnstile-widget';
  widgetHost.className = 'mxqr-turnstile-widget';

  frame.appendChild(widgetHost);
  container.appendChild(frame);
  document.body.appendChild(container);

  turnstileContainer = container;
  turnstileWidgetHost = widgetHost;
  return widgetHost;
}

function showTurnstileOverlay(): void {
  const container = turnstileContainer;
  if (!container) return;
  window.requestAnimationFrame(() => {
    container.classList.add('mxqr-turnstile-visible');
  });
}

function cleanupTurnstileWidget(): void {
  const turnstile = window.turnstile;
  const widgetId = turnstileWidgetId;
  const container = turnstileContainer;

  if (turnstileCleanupTimer !== null) {
    window.clearTimeout(turnstileCleanupTimer);
    turnstileCleanupTimer = null;
  }

  if (widgetId && turnstile?.remove) {
    try {
      turnstile.remove(widgetId);
    } catch {
      /* fall through to DOM cleanup */
    }
  }

  turnstileWidgetId = null;
  if (container) {
    container.classList.remove('mxqr-turnstile-visible');
    turnstileCleanupTimer = window.setTimeout(() => {
      if (turnstileContainer === container) {
        turnstileContainer = null;
        turnstileWidgetHost = null;
      }
      if (container.isConnected) container.remove();
      turnstileCleanupTimer = null;
    }, TURNSTILE_OVERLAY_FADE_MS);
  } else {
    turnstileWidgetHost = null;
    turnstileCleanupTimer = null;
  }
}

export function cancelCapabilityChallenge(reason = 'Capability challenge cancelled'): void {
  capabilityCancelGeneration += 1;
  const reject = turnstileCancelReject;
  const error = createCapabilityChallengeCancelledError(reason);
  if (reject) {
    reject(error);
    return;
  }
  cleanupTurnstileWidget();
}

async function getTurnstileToken(siteKey: string): Promise<string> {
  if (!siteKey) throw new Error('Missing Turnstile site key');
  if (turnstileExecution) return turnstileExecution;

  turnstileExecution = (async () => {
    const cancelGeneration = capabilityCancelGeneration;
    await loadTurnstile();
    if (cancelGeneration !== capabilityCancelGeneration) {
      throw createCapabilityChallengeCancelledError('Capability challenge cancelled');
    }
    const turnstile = window.turnstile;
    if (!turnstile) throw new Error('Turnstile unavailable');

    return new Promise<string>((resolve, reject) => {
      let container = ensureTurnstileContainer();
      if (turnstileWidgetId) {
        cleanupTurnstileWidget();
        container = ensureTurnstileContainer();
      }

      let settled = false;
      let timeoutId: number | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        turnstileCancelReject = null;
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        cleanupTurnstileWidget();
        callback();
      };

      try {
        timeoutId = window.setTimeout(
          () => finish(() => reject(new Error('Turnstile challenge timed out'))),
          TURNSTILE_EXECUTION_TIMEOUT_MS,
        );
        turnstileCancelReject = (error) => finish(() => reject(error));
        turnstileWidgetId = turnstile.render(container, {
          sitekey: siteKey,
          action: 'mxqr-capability',
          execution: 'execute',
          appearance: 'interaction-only',
          callback: (token) => finish(() => resolve(token)),
          'before-interactive-callback': showTurnstileOverlay,
          'error-callback': () => finish(() => reject(new Error('Turnstile challenge failed'))),
          'expired-callback': () => finish(() => reject(new Error('Turnstile challenge expired'))),
        });
        turnstile.execute(turnstileWidgetId);
      } catch (error) {
        finish(() => reject(error));
      }
    });
  })();

  try {
    return await turnstileExecution;
  } finally {
    turnstileExecution = null;
  }
}

function hasLeadingZeroBits(bytes: Uint8Array, difficulty: number): boolean {
  let remaining = difficulty;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    const bits = Math.min(8, remaining);
    if ((byte & (0xff << (8 - bits))) !== 0) return false;
    remaining -= bits;
  }
  return remaining <= 0;
}

async function solveCapabilityProofOfWork(
  challenge: string,
  difficulty: number,
  expiresAt: number,
  cancelGeneration: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!challenge || !Number.isInteger(difficulty) || difficulty < 8 || difficulty > 24) {
    throw new Error('Invalid capability proof-of-work challenge');
  }

  const encoder = new TextEncoder();
  const prefix = `mxqr-pow-v1:${challenge}:`;
  for (let start = 0; start < Number.MAX_SAFE_INTEGER; start += POW_BATCH_SIZE) {
    throwIfAborted(signal);
    if (cancelGeneration !== capabilityCancelGeneration) {
      throw createCapabilityChallengeCancelledError('Capability challenge cancelled');
    }
    if (Date.now() / 1000 >= expiresAt) {
      throw new Error('Capability proof-of-work challenge expired');
    }

    // WebCrypto performs hashing outside the JS main thread. Small batches
    // keep mobile/WebView event loops responsive without a visible challenge.
    const digests = await Promise.all(
      Array.from({ length: POW_BATCH_SIZE }, (_, offset) =>
        crypto.subtle.digest('SHA-256', encoder.encode(`${prefix}${start + offset}`)),
      ),
    );
    throwIfAborted(signal);
    for (let offset = 0; offset < digests.length; offset += 1) {
      if (hasLeadingZeroBits(new Uint8Array(digests[offset]), difficulty)) {
        return String(start + offset);
      }
    }
  }
  throw new Error('Capability proof-of-work solution unavailable');
}

async function getCapabilityProofOfWork(
  apiBase: string,
  scopes: CapabilityScope[],
  config: SecurityConfig,
  signal?: AbortSignal,
): Promise<{ challenge: string; solution: string }> {
  throwIfAborted(signal);
  const cancelGeneration = capabilityCancelGeneration;
  const payload = await withRequestDeadline(
    async (requestSignal) => {
      const response = await fetch(`${apiBase}/api/capability-challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes }),
        signal: requestSignal,
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`capability challenge HTTP ${response.status}`);
      }
      return (await readBoundedJsonResponse(
        response,
        CAPABILITY_RESPONSE_MAX_BYTES,
        requestSignal,
      )) as ProofOfWorkChallengeResponse;
    },
    {
      signal,
      timeoutMs: CAPABILITY_HTTP_TIMEOUT_MS,
      timeoutReason: 'CAPABILITY_CHALLENGE_TIMEOUT',
    },
  );
  if (cancelGeneration !== capabilityCancelGeneration) {
    throw createCapabilityChallengeCancelledError('Capability challenge cancelled');
  }
  const nowSeconds = Date.now() / 1000;
  if (
    !payload.challenge ||
    payload.algorithm !== 'sha256-leading-zero-bits' ||
    typeof payload.difficulty !== 'number' ||
    payload.difficulty !== config.proofOfWorkDifficulty ||
    typeof payload.expiresAt !== 'number' ||
    payload.expiresAt <= nowSeconds ||
    payload.expiresAt > nowSeconds + config.proofOfWorkTtl + 5
  ) {
    throw new Error('Invalid capability proof-of-work response');
  }
  return {
    challenge: payload.challenge,
    solution: await solveCapabilityProofOfWork(
      payload.challenge,
      payload.difficulty,
      payload.expiresAt,
      cancelGeneration,
      signal,
    ),
  };
}

async function requestCapabilityToken(
  apiBase: string,
  scopes: CapabilityScope[],
  config: SecurityConfig,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  let turnstileToken = '';
  if (config.turnstileSiteKey) {
    try {
      turnstileToken = await settleWithAbort(getTurnstileToken(config.turnstileSiteKey), signal);
      throwIfAborted(signal);
    } catch (error) {
      if (isCapabilityChallengeCancelled(error)) throw error;
      throw error;
    }
  }
  if (config.turnstileRequired && !turnstileToken) {
    throw new Error('Turnstile required');
  }

  const proofOfWork =
    config.proofOfWorkRequired && !turnstileToken
      ? await getCapabilityProofOfWork(apiBase, scopes, config, signal)
      : null;

  throwIfAborted(signal);
  const payload = await withRequestDeadline(
    async (requestSignal) => {
      const response = await fetch(`${apiBase}/api/capability-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopes,
          ...(turnstileToken ? { turnstileToken } : {}),
          ...(proofOfWork ? { proofOfWork } : {}),
        }),
        signal: requestSignal,
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`capability token HTTP ${response.status}`);
      }
      return (await readBoundedJsonResponse(
        response,
        CAPABILITY_RESPONSE_MAX_BYTES,
        requestSignal,
      )) as CapabilityTokenResponse;
    },
    {
      signal,
      timeoutMs: CAPABILITY_HTTP_TIMEOUT_MS,
      timeoutReason: 'CAPABILITY_TOKEN_TIMEOUT',
    },
  );
  if (!payload.token || typeof payload.expiresAt !== 'number') {
    throw new Error('Invalid capability token response');
  }

  const cacheKey = tokenCacheKey(apiBase, scopes);
  tokenCache.set(cacheKey, { token: payload.token, expiresAt: payload.expiresAt });
  return payload.token;
}

export async function getCapabilityHeaders(
  input: RequestInfo | URL,
  scopes: CapabilityScope[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  throwIfAborted(signal);
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes.length === 0) return {};

  const apiBase = apiBaseFor(input);
  const config = await getSecurityConfig(apiBase, signal);
  throwIfAborted(signal);
  if (!config.capabilityRequired) return {};

  const cacheKey = tokenCacheKey(apiBase, BUNDLE_SCOPES);
  const cached = tokenCache.get(cacheKey);
  const nowSeconds = Date.now() / 1000;
  if (cached && cached.expiresAt > nowSeconds + TOKEN_REFRESH_SKEW_SECONDS) {
    return { 'X-MXQR-Capability': cached.token };
  }

  try {
    // Always mint the bundle even if the caller asked for a subset — see
    // BUNDLE_SCOPES comment. normalizedScopes is kept above only as an
    // argument-validation gate (empty -> no-op).
    void normalizedScopes;
    let request: Promise<string>;
    const sharedRequest = tokenRequestCache.get(cacheKey);
    if (sharedRequest) {
      request = settleWithAbort(sharedRequest, signal);
    } else if (signal) {
      // An abortable caller owns its mint request. Sharing it would let one
      // upload cancel another caller's challenge/token fetch.
      request = requestCapabilityToken(apiBase, BUNDLE_SCOPES, config, signal);
    } else {
      request = getOrCreateSharedTokenRequest(cacheKey, apiBase, config);
    }
    const token = await request;
    throwIfAborted(signal);
    return { 'X-MXQR-Capability': token };
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal);
    if (isCapabilityChallengeCancelled(error)) throw error;
    return {};
  }
}

/**
 * Populate the ordinary capability cache only when the complete flow is
 * guaranteed to stay non-interactive. This deliberately refuses to load or
 * execute Turnstile; an explicit user action remains responsible for that
 * path if policy enables it later.
 */
export async function warmCapabilitySilently(
  input: RequestInfo | URL,
  scopes: CapabilityScope[],
): Promise<boolean> {
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes.length === 0) return true;

  const apiBase = apiBaseFor(input);
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(new Error('SILENT_CAPABILITY_WARM_TIMEOUT')),
    SILENT_CAPABILITY_WARM_TIMEOUT_MS,
  );
  try {
    const config = await getSecurityConfig(apiBase, controller.signal, false);
    if (!config.capabilityRequired) return true;
    if (config.turnstileRequired || config.turnstileSiteKey) return false;

    const cacheKey = tokenCacheKey(apiBase, BUNDLE_SCOPES);
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() / 1000 + TOKEN_REFRESH_SKEW_SECONDS) return true;

    const request = getOrCreateSharedTokenRequest(cacheKey, apiBase, config);
    await settleWithAbort(request, controller.signal);
    return true;
  } catch (error) {
    if (isCapabilityChallengeCancelled(error)) throw error;
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function invalidateCapabilityToken(input: RequestInfo | URL): void {
  // Drop the cached bundle token so the next getCapabilityHeaders() call
  // re-mints. Use when a downstream endpoint returns 401 even though we sent
  // a token — usually means the cached token was minted before a new scope
  // was added to the bundle (post-deploy transient).
  tokenCache.delete(tokenCacheKey(apiBaseFor(input), BUNDLE_SCOPES));
}

export async function fetchWithCapability(
  input: RequestInfo | URL,
  scope: CapabilityScope,
  init: RequestInit = {},
): Promise<Response> {
  const apiBase = apiBaseFor(input);
  const scopes = normalizeScopes([scope]);
  const headers = new Headers(init.headers);
  const capabilityHeaders = await getCapabilityHeaders(input, scopes, init.signal ?? undefined);
  for (const [name, value] of Object.entries(capabilityHeaders)) headers.set(name, value);
  const response = await fetch(input, { ...init, headers });
  if (response.status !== 401) return response;
  await cancelResponseBody(response);

  // 401 means the endpoint demanded capability. Either our token was stale, or
  // we sent none because the security-config probe failed open (a transient
  // network blip → cached capabilityRequired:false). Invalidate the cached
  // config + token, re-probe, and retry once. A genuinely unprotected endpoint
  // never reaches here (it won't 401), and the server still rejects a truly
  // invalid token — this widens recovery, not access.
  invalidateSecurityConfig(apiBase);
  tokenCache.delete(tokenCacheKey(apiBase, BUNDLE_SCOPES));
  const retryHeaders = new Headers(init.headers);
  const retryCapabilityHeaders = await getCapabilityHeaders(
    input,
    scopes,
    init.signal ?? undefined,
  );
  for (const [name, value] of Object.entries(retryCapabilityHeaders)) {
    retryHeaders.set(name, value);
  }
  return fetch(input, { ...init, headers: retryHeaders });
}
