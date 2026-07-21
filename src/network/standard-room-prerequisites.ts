import {
  fetchWithCapability,
  isCapabilityChallengeCancelled,
  warmCapabilitySilently,
} from '../core/capability.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
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

const TURN_ENDPOINTS = [
  '/api/get-turn-config',
  'https://musixquare.com/api/get-turn-config',
] as const;
const TURN_REFRESH_SKEW_MS = 60_000;
const FALLBACK_TURN_CACHE_MS = 5 * 60_000;
const TURN_REQUEST_TIMEOUT_MS = 8_000;
const WARMUP_IDLE_TIMEOUT_MS = 1_200;
const PRECONNECT_MARKER = 'data-mxqr-standard-signaling-preconnect';

let cachedTurnCredentials: CachedTurnCredentials | null = null;
let turnCredentialsRequest: Promise<StandardRoomTurnCredentials | null> | null = null;
let warmupScheduled = false;

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

async function requestTurnCredentials(): Promise<StandardRoomTurnCredentials | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(new Error('TURN_REQUEST_TIMEOUT')),
    TURN_REQUEST_TIMEOUT_MS,
  );
  try {
    for (const source of TURN_ENDPOINTS) {
      try {
        const response = await fetchWithCapability(source, 'turn', {
          signal: controller.signal,
        });
        if (!response.ok) {
          log.warn(`[Network] TURN fetch failed: ${source} → HTTP ${response.status}`);
          continue;
        }

        const payload = (await response.json()) as TurnConfigResponse;
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
        const lifetimeMs = cacheLifetimeMs(payload);
        if (lifetimeMs > 0) {
          cachedTurnCredentials = {
            expiresAt: Date.now() + lifetimeMs,
            value: cloneCredentials(value),
          };
        }
        return cloneCredentials(value);
      } catch (error) {
        if (isCapabilityChallengeCancelled(error)) throw error;
        if (controller.signal.aborted) {
          log.warn('[Network] TURN credential request timed out');
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
export async function getStandardRoomTurnCredentials(
  signal?: AbortSignal,
): Promise<StandardRoomTurnCredentials | null> {
  if (signal?.aborted) throw createAbortError(signal);

  const cached = cachedTurnCredentials;
  if (cached && cached.expiresAt > Date.now()) return cloneCredentials(cached.value);
  if (cached) cachedTurnCredentials = null;

  let request = turnCredentialsRequest;
  if (!request) {
    // The page-scoped fetch is shared. A cancelled setup abandons only its
    // wait; it must not tear down useful warmup work for a successor attempt.
    request = requestTurnCredentials().finally(() => {
      if (turnCredentialsRequest === request) turnCredentialsRequest = null;
    });
    turnCredentialsRequest = request;
  }
  return settleWithAbort(request, signal);
}

function signalingHttpOrigin(): string | null {
  const config = getRuntimeTransportConfig();
  if (config.provider !== 'cloudflare' || !config.signalingUrl) return null;
  try {
    const url = new URL(config.signalingUrl, window.location.href);
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

/** Warm capability/PoW and TURN only when doing so is guaranteed silent. */
async function warmStandardRoomPrerequisites(): Promise<void> {
  preconnectToSignaling();
  try {
    if (!(await warmCapabilitySilently(TURN_ENDPOINTS[0], ['turn']))) return;
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

/** Schedule after the landing UI has painted; never create a room or socket. */
export function scheduleStandardRoomPrerequisiteWarmup(): void {
  if (warmupScheduled) return;
  warmupScheduled = true;

  const afterPaint = () => {
    preconnectToSignaling();
    const requestIdle =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback.bind(window)
        : null;
    if (requestIdle) {
      requestIdle(
        () => {
          if (getState('network.appRole') !== 'idle' || getState('setup.sessionStarted')) return;
          void warmStandardRoomPrerequisites();
        },
        { timeout: WARMUP_IDLE_TIMEOUT_MS },
      );
      return;
    }
    window.setTimeout(() => {
      if (getState('network.appRole') !== 'idle' || getState('setup.sessionStarted')) return;
      void warmStandardRoomPrerequisites();
    }, 250);
  };

  window.requestAnimationFrame(() => window.requestAnimationFrame(afterPaint));
}

export const __standardRoomPrerequisitesForTests = {
  turnRequestTimeoutMs: TURN_REQUEST_TIMEOUT_MS,
  warm: warmStandardRoomPrerequisites,
  reset(): void {
    cachedTurnCredentials = null;
    turnCredentialsRequest = null;
    warmupScheduled = false;
    document.head.querySelector(`link[${PRECONNECT_MARKER}]`)?.remove();
  },
};
