import {
  assertCapabilityServiceReady,
  fetchWithCapability,
  isCapabilityChallengeCancelled,
  warmCapabilitySilently,
} from '../core/capability.ts';
import { log } from '../core/log.ts';
import {
  cancelResponseBody,
  raceWithAbortSignal,
  readBoundedJsonResponse,
  withRequestDeadline,
} from '../core/request-lifetime.ts';
import { getState } from '../core/state.ts';
import { delay } from '../core/timers.ts';
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
const READINESS_ATTEMPT_TIMEOUT_MS = 2_500;
const READINESS_RETRY_DELAYS_MS = [0, 600, 1_400] as const;
const PRECONNECT_MARKER = 'data-mxqr-standard-signaling-preconnect';
const SETUP_INTENT_SELECTOR =
  '#btn-setup-host, #btn-setup-guest, #btn-setup-confirm, #setup-join-code';
const SETUP_ACTIVATION_SELECTOR = '#btn-setup-host, #btn-setup-guest, #btn-setup-confirm';

let cachedTurnCredentials: CachedTurnCredentials | null = null;
let turnCredentialsRequest: Promise<StandardRoomTurnCredentials | null> | null = null;
let capabilityWarmupRequest: Promise<boolean> | null = null;
let warmupScheduled = false;
let warmupIntentController: AbortController | null = null;

function waitForReadinessRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  const waiting = delayMs > 0 ? delay(delayMs) : Promise.resolve();
  return signal ? raceWithAbortSignal(waiting, signal) : waiting;
}

/**
 * Before standard-room setup opens a signaling identity, prove that the
 * same-origin control plane is live. Only this read-only probe is retried;
 * callers invoke room creation/join exactly once after it succeeds.
 */
async function waitForStandardRoomReadinessInMode(
  mode: string,
  signal?: AbortSignal,
  onAttempt?: (attempt: number, maxAttempts: number) => void,
): Promise<void> {
  // Local development and preview E2E intentionally have no app Worker API.
  // Match the existing browser-only PeerJS/TURN seams so those environments
  // can exercise room setup without contacting production. Test and
  // production builds still require a fresh strict control-plane proof.
  if (mode === 'development' || mode === 'e2e') return;

  let lastError: unknown;
  const maxAttempts = READINESS_RETRY_DELAYS_MS.length;

  for (let index = 0; index < maxAttempts; index++) {
    await waitForReadinessRetry(READINESS_RETRY_DELAYS_MS[index] ?? 0, signal);
    const attempt = index + 1;
    onAttempt?.(attempt, maxAttempts);

    try {
      await withRequestDeadline(
        (requestSignal) => assertCapabilityServiceReady('/api/security-config', requestSignal),
        {
          signal,
          timeoutMs: READINESS_ATTEMPT_TIMEOUT_MS,
        },
      );
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }

  throw new Error('STANDARD_ROOM_READINESS_UNAVAILABLE', { cause: lastError });
}

export function waitForStandardRoomReadiness(
  signal?: AbortSignal,
  onAttempt?: (attempt: number, maxAttempts: number) => void,
): Promise<void> {
  return waitForStandardRoomReadinessInMode(import.meta.env.MODE, signal, onAttempt);
}

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
  if (import.meta.env.MODE === 'e2e') return null;

  const controller = new AbortController();
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
  void warmStandardRoomPrerequisites();
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
  const controller = new AbortController();
  warmupIntentController = controller;
  const options = { capture: true, passive: true, signal: controller.signal } as const;
  document.addEventListener('pointerover', beginWarmupFromSetupIntent, options);
  document.addEventListener('pointerdown', beginWarmupFromSetupIntent, options);
  document.addEventListener('focusin', beginWarmupFromSetupIntent, options);
}

export const __standardRoomPrerequisitesForTests = {
  turnRequestTimeoutMs: TURN_REQUEST_TIMEOUT_MS,
  readinessAttemptTimeoutMs: READINESS_ATTEMPT_TIMEOUT_MS,
  readinessRetryDelaysMs: READINESS_RETRY_DELAYS_MS,
  waitForReadinessInMode: waitForStandardRoomReadinessInMode,
  requestEndpoints: turnRequestEndpoints,
  warm: warmStandardRoomPrerequisites,
  reset(): void {
    cachedTurnCredentials = null;
    turnCredentialsRequest = null;
    capabilityWarmupRequest = null;
    warmupIntentController?.abort();
    warmupIntentController = null;
    warmupScheduled = false;
    document.head.querySelector(`link[${PRECONNECT_MARKER}]`)?.remove();
  },
};
