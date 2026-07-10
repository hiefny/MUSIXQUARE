export type CapabilityScope = 'turn' | 'realtime' | 'youtube-search' | 'remote-share';

interface SecurityConfig {
  capabilityRequired: boolean;
  turnstileSiteKey: string;
  turnstileRequired: boolean;
  inferredFallback: boolean;
  ttl: number;
}

interface CapabilityTokenResponse {
  token?: string;
  expiresAt?: number;
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
const TURNSTILE_OVERLAY_FADE_MS = 180;
const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TURNSTILE_STYLE_ID = 'mxqr-turnstile-style';
const CAPABILITY_CHALLENGE_CANCELLED = 'CapabilityChallengeCancelled';
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
const BUNDLE_SCOPES: CapabilityScope[] = [
  'realtime',
  'remote-share',
  'turn',
  'youtube-search',
];

const configCache = new Map<string, { expiresAt: number; value: SecurityConfig }>();
const tokenCache = new Map<string, { expiresAt: number; token: string }>();
let turnstileLoadPromise: Promise<void> | null = null;
let turnstileExecution: Promise<string> | null = null;
let turnstileWidgetId: string | null = null;
let turnstileContainer: HTMLElement | null = null;
let turnstileWidgetHost: HTMLElement | null = null;
let turnstileCancelReject: ((error: Error) => void) | null = null;
let turnstileCleanupTimer: number | null = null;
let turnstileCancelGeneration = 0;

function createCapabilityChallengeCancelledError(reason: string): Error {
  const error = new Error(reason);
  error.name = CAPABILITY_CHALLENGE_CANCELLED;
  return error;
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
    inferredFallback: payload.inferredFallback === true,
    ttl: typeof payload.ttl === 'number' && Number.isFinite(payload.ttl) ? payload.ttl : 600,
  };
}

async function getSecurityConfig(apiBase: string): Promise<SecurityConfig> {
  const cached = configCache.get(apiBase);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const response = await fetch(`${apiBase}/api/security-config`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`security config HTTP ${response.status}`);
    const value = normalizeSecurityConfig(await response.json());
    configCache.set(apiBase, {
      expiresAt: Date.now() + SECURITY_CONFIG_CACHE_MS,
      value,
    });
    return value;
  } catch {
    return {
      capabilityRequired: false,
      turnstileSiteKey: '',
      turnstileRequired: false,
      inferredFallback: false,
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
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Turnstile load failed')), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Turnstile load failed')), {
      once: true,
    });
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
  turnstileCancelGeneration += 1;
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
    const cancelGeneration = turnstileCancelGeneration;
    await loadTurnstile();
    if (cancelGeneration !== turnstileCancelGeneration) {
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
          'error-callback': () =>
            finish(() => reject(new Error('Turnstile challenge failed'))),
          'expired-callback': () =>
            finish(() => reject(new Error('Turnstile challenge expired'))),
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

async function requestCapabilityToken(
  apiBase: string,
  scopes: CapabilityScope[],
  config: SecurityConfig,
): Promise<string> {
  let turnstileToken = '';
  if (config.turnstileSiteKey) {
    try {
      turnstileToken = await getTurnstileToken(config.turnstileSiteKey);
    } catch (error) {
      if (isCapabilityChallengeCancelled(error)) throw error;
      if (!config.inferredFallback) throw error;
    }
  }
  if (config.turnstileRequired && !turnstileToken && !config.inferredFallback) {
    throw new Error('Turnstile required');
  }

  const response = await fetch(`${apiBase}/api/capability-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scopes,
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  });
  if (!response.ok) throw new Error(`capability token HTTP ${response.status}`);

  const payload = (await response.json()) as CapabilityTokenResponse;
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
): Promise<Record<string, string>> {
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes.length === 0) return {};

  const apiBase = apiBaseFor(input);
  const config = await getSecurityConfig(apiBase);
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
    const token = await requestCapabilityToken(apiBase, BUNDLE_SCOPES, config);
    return { 'X-MXQR-Capability': token };
  } catch (error) {
    if (isCapabilityChallengeCancelled(error)) throw error;
    return {};
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
  const capabilityHeaders = await getCapabilityHeaders(input, scopes);
  for (const [name, value] of Object.entries(capabilityHeaders)) headers.set(name, value);
  const response = await fetch(input, { ...init, headers });
  if (response.status !== 401) return response;

  // 401 means the endpoint demanded capability. Either our token was stale, or
  // we sent none because the security-config probe failed open (a transient
  // network blip → cached capabilityRequired:false). Invalidate the cached
  // config + token, re-probe, and retry once. A genuinely unprotected endpoint
  // never reaches here (it won't 401), and the server still rejects a truly
  // invalid token — this widens recovery, not access.
  invalidateSecurityConfig(apiBase);
  tokenCache.delete(tokenCacheKey(apiBase, BUNDLE_SCOPES));
  const retryHeaders = new Headers(init.headers);
  const retryCapabilityHeaders = await getCapabilityHeaders(input, scopes);
  for (const [name, value] of Object.entries(retryCapabilityHeaders)) {
    retryHeaders.set(name, value);
  }
  return fetch(input, { ...init, headers: retryHeaders });
}
