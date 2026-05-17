export type CapabilityScope = 'turn' | 'realtime' | 'youtube-search';

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
const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const VALID_SCOPES = new Set<CapabilityScope>(['turn', 'realtime', 'youtube-search']);

const configCache = new Map<string, { expiresAt: number; value: SecurityConfig }>();
const tokenCache = new Map<string, { expiresAt: number; token: string }>();
let turnstileLoadPromise: Promise<void> | null = null;
let turnstileExecution: Promise<string> | null = null;
let turnstileWidgetId: string | null = null;
let turnstileContainer: HTMLElement | null = null;

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

function ensureTurnstileContainer(): HTMLElement {
  if (turnstileContainer?.isConnected) return turnstileContainer;

  const existing = document.getElementById('mxqr-turnstile-container');
  if (existing) {
    turnstileContainer = existing;
    return turnstileContainer;
  }

  const container = document.createElement('div');
  container.id = 'mxqr-turnstile-container';
  container.style.position = 'fixed';
  container.style.right = '16px';
  container.style.bottom = '16px';
  container.style.zIndex = '2147483647';
  document.body.appendChild(container);
  turnstileContainer = container;
  return container;
}

function cleanupTurnstileWidget(): void {
  const turnstile = window.turnstile;
  const widgetId = turnstileWidgetId;
  const container = turnstileContainer;

  if (widgetId && turnstile?.remove) {
    try {
      turnstile.remove(widgetId);
    } catch {
      /* fall through to DOM cleanup */
    }
  }

  turnstileWidgetId = null;
  if (container) {
    container.remove();
  }
  turnstileContainer = null;
}

async function getTurnstileToken(siteKey: string): Promise<string> {
  if (!siteKey) throw new Error('Missing Turnstile site key');
  if (turnstileExecution) return turnstileExecution;

  turnstileExecution = (async () => {
    await loadTurnstile();
    const turnstile = window.turnstile;
    if (!turnstile) throw new Error('Turnstile unavailable');

    return new Promise<string>((resolve, reject) => {
      let container = ensureTurnstileContainer();
      if (turnstileWidgetId) {
        cleanupTurnstileWidget();
        container = ensureTurnstileContainer();
      }

      try {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupTurnstileWidget();
          reject(new Error('Turnstile challenge timed out'));
        }, TURNSTILE_EXECUTION_TIMEOUT_MS);
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          cleanupTurnstileWidget();
          callback();
        };
        turnstileWidgetId = turnstile.render(container, {
          sitekey: siteKey,
          action: 'mxqr-capability',
          execution: 'execute',
          appearance: 'interaction-only',
          callback: (token) => finish(() => resolve(token)),
          'error-callback': () =>
            finish(() => reject(new Error('Turnstile challenge failed'))),
          'expired-callback': () =>
            finish(() => reject(new Error('Turnstile challenge expired'))),
        });
        turnstile.execute(turnstileWidgetId);
      } catch (error) {
        cleanupTurnstileWidget();
        reject(error);
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

  const cacheKey = tokenCacheKey(apiBase, normalizedScopes);
  const cached = tokenCache.get(cacheKey);
  const nowSeconds = Date.now() / 1000;
  if (cached && cached.expiresAt > nowSeconds + TOKEN_REFRESH_SKEW_SECONDS) {
    return { 'X-MXQR-Capability': cached.token };
  }

  try {
    const token = await requestCapabilityToken(apiBase, normalizedScopes, config);
    return { 'X-MXQR-Capability': token };
  } catch {
    return {};
  }
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
  if (response.status !== 401 || !capabilityHeaders['X-MXQR-Capability']) return response;

  tokenCache.delete(tokenCacheKey(apiBase, scopes));
  const retryHeaders = new Headers(init.headers);
  const retryCapabilityHeaders = await getCapabilityHeaders(input, scopes);
  for (const [name, value] of Object.entries(retryCapabilityHeaders)) {
    retryHeaders.set(name, value);
  }
  return fetch(input, { ...init, headers: retryHeaders });
}
