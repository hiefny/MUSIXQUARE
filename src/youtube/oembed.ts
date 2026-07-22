/**
 * MUSIXQUARE — YouTube oEmbed Fetcher (leaf module)
 *
 * Pure fetch utilities kept separate from youtube/search.ts:
 * fetchWithTimeout, the oEmbed title fetch with its LRU+TTL cache, and
 * external-title normalization. ui/chat-render.ts depends on THIS module —
 * not on search.ts, which pulls in the network/peer facade (broadcast) and
 * would re-create the dissolved ui/network/chat/youtube import cycle.
 *
 * Keep this module a LEAF: imports limited to core/log, core/capability,
 * core/html-entities, and youtube/constants.ts. No bus, no state, no
 * network/* imports — scripts/check-import-graph.mjs ratchets the graph.
 */

import { log } from '../core/log.ts';
import { fetchWithCapability, type CapabilityScope } from '../core/capability.ts';
import { decodeHtmlEntities } from '../core/html-entities.ts';
import {
  cancelResponseBody,
  createLinkedAbortScope,
  readBoundedJsonResponse,
  type LinkedAbortScope,
} from '../core/request-lifetime.ts';
import { OEMBED_CACHE_MAX, OEMBED_CACHE_TTL_MS, OEMBED_FETCH_TIMEOUT_MS } from './constants.ts';

const OEMBED_RESPONSE_MAX_BYTES = 64 * 1024;

const RESPONSE_BODY_METHODS = new Set<PropertyKey>([
  'arrayBuffer',
  'blob',
  'bytes',
  'formData',
  'json',
  'text',
]);

/** Keep the request deadline alive until the response body reaches EOF. */
function bindResponseBodyLifetime(response: Response, scope: LinkedAbortScope): Response {
  if (!response.body) {
    scope.cleanup();
    return response;
  }

  let finished = false;
  let wrappedBody: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    scope.signal.removeEventListener('abort', finish);
    scope.cleanup();
  };
  scope.signal.addEventListener('abort', finish, { once: true });

  const getWrappedBody = (): ReadableStream<Uint8Array> => {
    if (wrappedBody) return wrappedBody;
    wrappedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          reader ??= response.body!.getReader();
          const result = await reader.read();
          if (result.done) {
            reader.releaseLock();
            reader = null;
            controller.close();
            finish();
            return;
          }
          if (result.value) controller.enqueue(result.value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          if (reader) await reader.cancel(reason);
          else await response.body!.cancel(reason);
        } finally {
          if (reader) {
            reader.releaseLock();
            reader = null;
          }
          scope.abort(reason);
          finish();
        }
      },
    });
    return wrappedBody;
  };

  return new Proxy(response, {
    get(target, property) {
      if (property === 'body') return getWrappedBody();
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (RESPONSE_BODY_METHODS.has(property)) {
        return (...args: unknown[]) =>
          Promise.resolve(Reflect.apply(value, target, args)).finally(finish);
      }
      return value.bind(target);
    },
  });
}

// ─── Fetch with Timeout ──────────────────────────────────────────

export async function fetchWithTimeout(
  url: string,
  timeoutMs = OEMBED_FETCH_TIMEOUT_MS,
  externalSignal?: AbortSignal,
  init: RequestInit = {},
  capabilityScope?: CapabilityScope,
): Promise<Response> {
  const scope = createLinkedAbortScope(externalSignal, timeoutMs, 'YOUTUBE_REQUEST_TIMEOUT');
  try {
    const requestInit = { ...init, signal: scope.signal };
    const response = capabilityScope
      ? await fetchWithCapability(url, capabilityScope, requestInit)
      : await fetch(url, requestInit);
    return bindResponseBodyLifetime(response, scope);
  } catch (error) {
    scope.cleanup();
    throw error;
  }
}

// ─── Title Normalization ─────────────────────────────────────────

export function normalizeExternalTitle(value: unknown): string {
  return decodeHtmlEntities(typeof value === 'string' ? value : '').trim();
}

// ─── oEmbed Title Cache (LRU + TTL) ───────────────────────────────

const _oEmbedTitleCache = new Map<string, { title: string; ts: number }>();
const _oEmbedInFlight = new Map<string, Promise<string | null>>();

function _oEmbedCacheGet(key: string): string | null {
  const entry = _oEmbedTitleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > OEMBED_CACHE_TTL_MS) {
    _oEmbedTitleCache.delete(key);
    return null;
  }
  // LRU: move to end
  _oEmbedTitleCache.delete(key);
  _oEmbedTitleCache.set(key, entry);
  return entry.title;
}

function _oEmbedCacheSet(key: string, title: string): void {
  // Evict oldest if at capacity
  if (_oEmbedTitleCache.size >= OEMBED_CACHE_MAX) {
    const oldest = _oEmbedTitleCache.keys().next().value;
    if (oldest !== undefined) _oEmbedTitleCache.delete(oldest);
  }
  _oEmbedTitleCache.set(key, { title, ts: Date.now() });
}

export async function fetchOEmbedTitle(url: string): Promise<string | null> {
  const key = String(url || '');
  if (!key) return null;

  const cached = _oEmbedCacheGet(key);
  if (cached) return cached;
  if (_oEmbedInFlight.has(key)) return _oEmbedInFlight.get(key)!;

  const p = (async (): Promise<string | null> => {
    try {
      const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(key)}&format=json`;
      const response = await fetchWithTimeout(oEmbedUrl);
      if (!response.ok) {
        await cancelResponseBody(response);
        return null;
      }
      const data = (await readBoundedJsonResponse(response, OEMBED_RESPONSE_MAX_BYTES)) as {
        title?: unknown;
      };
      const title = normalizeExternalTitle(data?.title);
      return title || null;
    } catch (e) {
      log.warn('[YouTube oEmbed] Fetch failed:', e);
      return null;
    } finally {
      _oEmbedInFlight.delete(key);
    }
  })();

  _oEmbedInFlight.set(key, p);
  const result = await p;
  if (result) _oEmbedCacheSet(key, result);
  return result;
}
