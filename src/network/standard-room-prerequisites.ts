import {
  fetchWithCapability,
  isCapabilityChallengeCancelled,
  warmCapabilitySilently,
} from '../core/capability.ts';
import { log } from '../core/log.ts';
import {
  cancelResponseBody,
  raceWithAbortSignal,
  readBoundedJsonResponse,
} from '../core/request-lifetime.ts';
import { getState } from '../core/state.ts';
import { localFirstApiEndpoints } from './api-endpoints.ts';
import { getRuntimeTransportConfig } from './transport/config.ts';

interface TurnConfigResponse {
  provider?: unknown;
  ttl?: unknown;
  iceServers?: unknown;
}

interface StandardRoomTurnCredentials {
  readonly provider: string;
  readonly source: string;
  readonly iceServers: readonly RTCIceServer[];
}

interface CachedTurnCredentials {
  readonly expiresAt: number;
  readonly value: StandardRoomTurnCredentials;
}

const TURN_ENDPOINTS = localFirstApiEndpoints('/api/get-turn-config');
const TURN_REFRESH_SKEW_MS = 60_000;
const FALLBACK_TURN_CACHE_MS = 5 * 60_000;
const TURN_REQUEST_TIMEOUT_MS = 8_000;
const TURN_RESPONSE_MAX_BYTES = 64 * 1024;
const ROUTE_PROBE_ATTEMPT_TIMEOUT_MS = 900;
const ROUTE_PROBE_RETRY_DELAY_MS = 250;
const ROUTE_PROBE_BUDGET_MS = 3_000;
const ROUTE_SETTLE_DELAY_MS = 150;
const TURN_ROUTE_READOPTION_LIMIT = 2;
const STANDARD_ROOM_BASE_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const PRECONNECT_MARKER = 'data-mxqr-standard-signaling-preconnect';
const SETUP_INTENT_SELECTOR =
  '#btn-setup-host, #btn-setup-guest, #btn-setup-confirm, #setup-join-code';
const SETUP_ACTIVATION_SELECTOR = '#btn-setup-host, #btn-setup-guest, #btn-setup-confirm';

let cachedTurnCredentials: CachedTurnCredentials | null = null;
let turnCredentialsRequest: Promise<StandardRoomTurnCredentials | null> | null = null;
let turnCredentialsRequestController: AbortController | null = null;
let capabilityWarmupRequest: Promise<boolean> | null = null;
let warmupScheduled = false;
let warmupIntentController: AbortController | null = null;
let routeObservationController: AbortController | null = null;
let networkRouteGeneration = 0;

function turnRequestEndpoints(baseHref = window.location.href): string[] {
  const seen = new Set<string>();
  return TURN_ENDPOINTS.filter((source) => {
    let identity = source;
    try {
      identity = new URL(source, baseHref).href;
    } catch {
      // Keep an invalid candidate so the ordinary request/error path owns it.
    }
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function normalizeIceServerUrls(value: unknown): string[] {
  const urls = Array.isArray(value) ? value : [value];
  return urls.filter((url): url is string => {
    return typeof url === 'string' && /^(stun|turn|turns):/i.test(url);
  });
}

function normalizeRemoteIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];

  const result: RTCIceServer[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const server = item as Record<string, unknown>;
    const urls = normalizeIceServerUrls(server.urls);
    if (urls.length === 0) continue;

    const iceServer: RTCIceServer = {
      urls: urls.length === 1 ? urls[0] : urls,
    };
    if (typeof server.username === 'string' && server.username) {
      iceServer.username = server.username;
    }
    if (typeof server.credential === 'string' && server.credential) {
      iceServer.credential = server.credential;
    }
    result.push(iceServer);
  }

  return result;
}

function hasTurnServer(server: RTCIceServer): boolean {
  return normalizeIceServerUrls(server.urls).some((url) => /^turns?:/i.test(url));
}

function providerLabel(payload: TurnConfigResponse): string {
  return typeof payload.provider === 'string' && payload.provider ? payload.provider : 'remote';
}

function cloneCredentials(value: StandardRoomTurnCredentials): StandardRoomTurnCredentials {
  return {
    provider: value.provider,
    source: value.source,
    iceServers: value.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    })),
  };
}

function cacheLifetimeMs(payload: TurnConfigResponse): number {
  const ttlSeconds =
    typeof payload.ttl === 'number' && Number.isFinite(payload.ttl) && payload.ttl > 0
      ? payload.ttl
      : null;
  if (ttlSeconds === null) return FALLBACK_TURN_CACHE_MS;
  return Math.max(0, ttlSeconds * 1_000 - TURN_REFRESH_SKEW_MS);
}

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === 'string' && signal.reason ? signal.reason : 'Operation aborted',
  );
  error.name = 'AbortError';
  return error;
}

function isNetworkRouteChangedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'NETWORK_ROUTE_CHANGED';
}

function settleWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError(signal));

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
    if (signal.aborted) onAbort();
  });
}

async function requestTurnCredentials(
  controller: AbortController,
): Promise<StandardRoomTurnCredentials | null> {
  if (import.meta.env.MODE === 'e2e') return null;

  const timeout = window.setTimeout(
    () => controller.abort(new Error('TURN_REQUEST_TIMEOUT')),
    TURN_REQUEST_TIMEOUT_MS,
  );
  try {
    for (const source of turnRequestEndpoints()) {
      try {
        if (controller.signal.aborted) throw createAbortError(controller.signal);
        const operation = fetchWithCapability(source, 'turn', {
          signal: controller.signal,
        });
        const response = await raceWithAbortSignal(
          operation,
          controller.signal,
          cancelResponseBody,
        );
        if (!response.ok) {
          await cancelResponseBody(response);
          log.warn(`[Network] TURN fetch failed: ${source} → HTTP ${response.status}`);
          continue;
        }

        const payload = (await readBoundedJsonResponse(
          response,
          TURN_RESPONSE_MAX_BYTES,
          controller.signal,
        )) as TurnConfigResponse;
        const iceServers = normalizeRemoteIceServers(payload.iceServers);
        if (!iceServers.some(hasTurnServer)) {
          log.warn(`[Network] TURN fetch returned no usable ICE servers: ${source}`);
          continue;
        }

        const value: StandardRoomTurnCredentials = {
          provider: providerLabel(payload),
          source,
          iceServers,
        };
        // TURN credentials are route-independent. A cellular -> Wi-Fi hand-off
        // can retire the caller after the paid endpoint already committed its
        // response; preserving that valid result prevents the replacement WSS
        // attempts from spending the same capability quota again.
        if (controller.signal.aborted) {
          throw createAbortError(controller.signal);
        }
        const lifetimeMs = cacheLifetimeMs(payload);
        if (lifetimeMs > 0) {
          cachedTurnCredentials = {
            expiresAt: Date.now() + lifetimeMs,
            value: cloneCredentials(value),
          };
        }
        return cloneCredentials(value);
      } catch (error) {
        if (controller.signal.aborted && isNetworkRouteChangedError(controller.signal.reason)) {
          throw controller.signal.reason;
        }
        if (isCapabilityChallengeCancelled(error)) throw error;
        if (isNetworkRouteChangedError(error)) throw error;
        if (controller.signal.aborted) {
          if (
            controller.signal.reason instanceof Error &&
            controller.signal.reason.message === 'TURN_REQUEST_TIMEOUT'
          ) {
            log.warn('[Network] TURN credential request timed out');
          } else {
            log.debug('[Network] Superseded TURN request retired after network route change');
          }
          if (isNetworkRouteChangedError(controller.signal.reason)) {
            throw controller.signal.reason;
          }
          return null;
        }
        log.warn(
          `[Network] TURN fetch error: ${source} → ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Return cached TURN credentials or share the one active fetch between host
 * and guest setup. The cache lives only for this page lifetime and refreshes
 * before the server-issued credential TTL expires.
 */
async function getStandardRoomTurnCredentialsForRoute(
  signal?: AbortSignal,
  readoptionAttempt = 0,
): Promise<StandardRoomTurnCredentials | null> {
  if (signal?.aborted) throw createAbortError(signal);

  const cached = cachedTurnCredentials;
  if (cached && cached.expiresAt > Date.now()) return cloneCredentials(cached.value);
  if (cached) cachedTurnCredentials = null;

  let request = turnCredentialsRequest;
  if (!request) {
    // The page-scoped fetch is shared. A cancelled setup abandons only its
    // wait; it must not tear down useful warmup work for a successor attempt.
    const controller = new AbortController();
    turnCredentialsRequestController = controller;
    request = requestTurnCredentials(controller).finally(() => {
      if (turnCredentialsRequest === request) {
        turnCredentialsRequest = null;
        turnCredentialsRequestController = null;
      }
    });
    turnCredentialsRequest = request;
  }
  try {
    return await settleWithAbort(request, signal);
  } catch (error) {
    if (
      isNetworkRouteChangedError(error) &&
      !signal?.aborted &&
      readoptionAttempt < TURN_ROUTE_READOPTION_LIMIT
    ) {
      // Chromium does expose cellular <-> Wi-Fi through NetworkInformation.
      // A setup already consuming the superseded shared request must adopt the
      // replacement generation instead of silently continuing STUN-only.
      return getStandardRoomTurnCredentialsForRoute(signal, readoptionAttempt + 1);
    }
    throw error;
  }
}

export async function getStandardRoomTurnCredentials(
  signal?: AbortSignal,
): Promise<StandardRoomTurnCredentials | null> {
  return getStandardRoomTurnCredentialsForRoute(signal);
}

function signalingHttpOrigin(signalingUrl?: string): string | null {
  const config = getRuntimeTransportConfig();
  const source = signalingUrl ?? config.signalingUrl;
  if (config.provider !== 'cloudflare' || !source) return null;
  try {
    const url = new URL(source, window.location.href);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function preconnectToSignaling(): void {
  const origin = signalingHttpOrigin();
  if (!origin || document.head.querySelector(`link[${PRECONNECT_MARKER}]`)) return;

  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  link.crossOrigin = 'anonymous';
  link.setAttribute(PRECONNECT_MARKER, '');
  document.head.appendChild(link);
}

function removeSignalingPreconnect(): void {
  document.head.querySelector(`link[${PRECONNECT_MARKER}]`)?.remove();
}

/**
 * Retire page-scoped work that may still belong to a previous physical route.
 * TURN credentials and their paid in-flight fetch are route-independent. Keep
 * the single shared request alive across a hand-off: aborting after the server
 * has committed a response can consume the per-capability budget without ever
 * publishing the credential. Only the speculative signaling preconnect is
 * retired here.
 */
function invalidateStandardRoomNetworkRoute(): void {
  networkRouteGeneration += 1;
  capabilityWarmupRequest = null;
  removeSignalingPreconnect();
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function probeSignalingRoute(
  signal: AbortSignal,
  timeoutMs: number,
  retrySignalingUrl: string,
): Promise<boolean> {
  const origin = signalingHttpOrigin(retrySignalingUrl);
  if (!origin) return false;

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timeout = window.setTimeout(
    () => controller.abort(new Error('NETWORK_ROUTE_PROBE_TIMEOUT')),
    timeoutMs,
  );
  try {
    const url = new URL('/', origin);
    url.searchParams.set('_mxqr_route', `${networkRouteGeneration}-${Date.now().toString(36)}`);
    const response = await raceWithAbortSignal(
      fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }),
      controller.signal,
      cancelResponseBody,
    );
    await cancelResponseBody(response);
    return true;
  } catch {
    if (signal.aborted) throw createAbortError(signal);
    return false;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * iOS 17 exposes neither NetworkInformation.change nor an offline/online edge
 * for cellular -> Wi-Fi (both routes are "online"). A generic pre-open WSS
 * failure is therefore the only reliable reactive signal. Before one bounded
 * retry, prove a fresh HTTPS path to the signaling origin with an uncached,
 * credential-free request. The root endpoint is read-only and returns service
 * metadata; no room claim/join is performed by this barrier.
 */
export async function prepareStandardRoomNetworkRouteRetry(
  signal: AbortSignal,
  retrySignalingUrl?: string,
): Promise<RTCConfiguration | null> {
  if (signal.aborted) throw createAbortError(signal);
  invalidateStandardRoomNetworkRoute();
  const config = getRuntimeTransportConfig();
  const retryUrl = retrySignalingUrl ?? config.signalingFallbackUrl ?? config.signalingUrl;
  if (!retryUrl) return null;

  const deadline = Date.now() + ROUTE_PROBE_BUDGET_MS;
  while (!signal.aborted && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const routeReady = await probeSignalingRoute(
      signal,
      Math.max(1, Math.min(ROUTE_PROBE_ATTEMPT_TIMEOUT_MS, remainingMs)),
      retryUrl,
    );
    if (routeReady) {
      await abortableDelay(ROUTE_SETTLE_DELAY_MS, signal);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;

      // Start a new shared TURN request only after the fresh signaling route
      // is proven. Abandon this retry's wait at the same three-second setup
      // budget; the page-scoped request may still finish and populate the
      // route-generation-fenced cache for a later connection.
      const waitController = new AbortController();
      const onAbort = () => waitController.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const timeout = window.setTimeout(
        () => waitController.abort(new Error('NETWORK_ROUTE_TURN_WAIT_TIMEOUT')),
        remainingMs,
      );
      try {
        const turnCredentials = await getStandardRoomTurnCredentials(waitController.signal);
        if (signal.aborted) throw createAbortError(signal);
        return {
          iceServers: [
            ...STANDARD_ROOM_BASE_ICE_SERVERS.map((server) => ({ ...server })),
            ...(turnCredentials?.iceServers ?? []),
          ],
          bundlePolicy: 'max-bundle',
        };
      } catch {
        if (signal.aborted) throw createAbortError(signal);
        return null;
      } finally {
        window.clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      }
    }

    const retryDelayMs = Math.min(ROUTE_PROBE_RETRY_DELAY_MS, deadline - Date.now());
    if (retryDelayMs > 0) await abortableDelay(retryDelayMs, signal);
  }
  if (signal.aborted) throw createAbortError(signal);
  return null;
}

function warmStandardRoomCapability(): Promise<boolean> {
  let request = capabilityWarmupRequest;
  if (!request) {
    const source = turnRequestEndpoints()[0] ?? TURN_ENDPOINTS[0];
    request = warmCapabilitySilently(source, ['turn']).then(
      (ready) => {
        if (capabilityWarmupRequest === request) capabilityWarmupRequest = null;
        return ready;
      },
      (error: unknown) => {
        if (capabilityWarmupRequest === request) capabilityWarmupRequest = null;
        throw error;
      },
    );
    capabilityWarmupRequest = request;
  }
  return request;
}

/** Warm capability/PoW and TURN only when doing so is guaranteed silent. */
async function warmStandardRoomPrerequisites(): Promise<void> {
  preconnectToSignaling();
  try {
    if (!(await warmStandardRoomCapability())) return;
    await getStandardRoomTurnCredentials();
  } catch (error) {
    // Warmup is opportunistic. Explicit setup retains the ordinary retry and
    // user-visible error path.
    log.debug(
      `[Network] Standard-room prerequisite warmup skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isStandardRoomSetupIntent(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SETUP_INTENT_SELECTOR) !== null;
}

function isStandardRoomSetupActivation(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SETUP_ACTIVATION_SELECTOR) !== null;
}

function beginWarmupFromSetupIntent(event: Event): void {
  // Hoverless pointers emit pointerover immediately before pointerdown. Ignore
  // that synthetic preview so the activation path below owns one shared TURN
  // request before the ensuing click starts host/join initialization.
  if (
    event.type === 'pointerover' &&
    'pointerType' in event &&
    typeof event.pointerType === 'string' &&
    event.pointerType !== 'mouse'
  ) {
    return;
  }
  if (!isStandardRoomSetupIntent(event.target) || getState('setup.sessionStarted')) return;
  warmupIntentController?.abort();
  warmupIntentController = null;
  if (event.type === 'pointerdown' && isStandardRoomSetupActivation(event.target)) {
    preconnectToSignaling();
    void getStandardRoomTurnCredentials().catch((error) => {
      log.debug(
        `[Network] Standard-room activation warmup skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return;
  }
  warmStandardRoomPrerequisites().catch((error: unknown) => {
    log.debug('[Network] Standard-room prerequisite warmup rejected unexpectedly', error);
  });
}

/**
 * Preconnect signaling as soon as setup is entered, but reserve capability,
 * PoW, and the paid TURN mint for clear standard-room intent. Hover/focus gets
 * one silent warm attempt; activation starts the shared TURN request directly
 * so the ensuing click adopts it. Explicit setup remains the retry owner.
 */
export function scheduleStandardRoomPrerequisiteWarmup(): void {
  if (warmupScheduled) return;
  warmupScheduled = true;
  preconnectToSignaling();
  const routeController = new AbortController();
  routeObservationController = routeController;
  window.addEventListener('online', invalidateStandardRoomNetworkRoute, {
    passive: true,
    signal: routeController.signal,
  });
  const connection = (
    navigator as Navigator & {
      connection?: EventTarget;
    }
  ).connection;
  connection?.addEventListener('change', invalidateStandardRoomNetworkRoute, {
    signal: routeController.signal,
  });
  const controller = new AbortController();
  warmupIntentController = controller;
  const options = { capture: true, passive: true, signal: controller.signal } as const;
  document.addEventListener('pointerover', beginWarmupFromSetupIntent, options);
  document.addEventListener('pointerdown', beginWarmupFromSetupIntent, options);
  document.addEventListener('focusin', beginWarmupFromSetupIntent, options);
}

export const __standardRoomPrerequisitesForTests = {
  turnRequestTimeoutMs: TURN_REQUEST_TIMEOUT_MS,
  routeProbeBudgetMs: ROUTE_PROBE_BUDGET_MS,
  requestEndpoints: turnRequestEndpoints,
  warm: warmStandardRoomPrerequisites,
  invalidateNetworkRoute: invalidateStandardRoomNetworkRoute,
  reset(): void {
    turnCredentialsRequestController?.abort(new Error('TEST_RESET'));
    cachedTurnCredentials = null;
    turnCredentialsRequest = null;
    turnCredentialsRequestController = null;
    capabilityWarmupRequest = null;
    warmupIntentController?.abort();
    warmupIntentController = null;
    routeObservationController?.abort();
    routeObservationController = null;
    warmupScheduled = false;
    networkRouteGeneration = 0;
    removeSignalingPreconnect();
  },
};
