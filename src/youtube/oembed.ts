/**
 * MUSIXQUARE — YouTube oEmbed Fetcher (leaf module)
 *
 * Pure fetch utilities kept separate from youtube/search.ts:
 * fetchWithTimeout, the oEmbed metadata fetch with its LRU+TTL cache, and
 * external-title normalization. ui/chat-render.ts depends on THIS module —
 * not on search.ts, which pulls in the network/peer facade (broadcast) and
 * would re-create the dissolved ui/network/chat/youtube import cycle.
 *
 * Keep this module a LEAF: imports limited to core/log, core/capability,
 * core/html-entities, and youtube/constants.ts. No bus, no state, no
 * network/* imports — scripts/check-import-graph.mts ratchets the graph.
 */

import { log } from '../core/log.ts';
import { fetchWithCapability, type CapabilityScope } from '../core/capability.ts';
import { decodeHtmlEntities } from '../core/html-entities.ts';
import {
  cancelResponseBody,
  createLinkedAbortScope,
  raceWithAbortSignal,
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
  let bodyConsumerResponse: Response | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let bodyCancelRequested = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    scope.signal.removeEventListener('abort', handleAbort);
    scope.cleanup();
  };
  const cancelUnderlying = (reason?: unknown) => {
    if (bodyCancelRequested) return;
    bodyCancelRequested = true;
    try {
      const cancellation = reader ? reader.cancel(reason) : response.body!.cancel(reason);
      void Promise.resolve(cancellation).catch(() => undefined);
    } catch {
      // Cleanup is best effort and never extends the bounded outcome.
    }
  };
  const handleAbort = () => {
    cancelUnderlying(scope.signal.reason);
    finish();
  };
  if (scope.signal.aborted) handleAbort();
  else scope.signal.addEventListener('abort', handleAbort, { once: true });

  const getWrappedBody = (): ReadableStream<Uint8Array> => {
    if (wrappedBody) return wrappedBody;
    wrappedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          reader ??= response.body!.getReader();
          const result = await raceWithAbortSignal(reader.read(), scope.signal);
          if (result.done) {
            reader.releaseLock();
            reader = null;
            controller.close();
            finish();
            return;
          }
          if (result.value) controller.enqueue(result.value);
        } catch (error) {
          cancelUnderlying(error);
          finish();
          controller.error(error);
        }
      },
      cancel(reason) {
        cancelUnderlying(reason);
        if (reader) {
          try {
            reader.releaseLock();
          } catch {
            // A pending native read can retain the lock until abort settles it.
          }
          reader = null;
        }
        scope.abort(reason);
        finish();
      },
    });
    return wrappedBody;
  };
  const getBodyConsumerResponse = (): Response => {
    bodyConsumerResponse ??= new Response(getWrappedBody(), { headers: response.headers });
    return bodyConsumerResponse;
  };

  return new Proxy(response, {
    get(target, property) {
      if (property === 'body') return getWrappedBody();
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (RESPONSE_BODY_METHODS.has(property)) {
        return (...args: unknown[]) => {
          let operation: PromiseLike<unknown>;
          try {
            const bodyResponse = getBodyConsumerResponse();
            const bodyMethod = Reflect.get(bodyResponse, property, bodyResponse) as (
              ...methodArgs: unknown[]
            ) => unknown;
            operation = Promise.resolve(Reflect.apply(bodyMethod, bodyResponse, args));
          } catch (error) {
            finish();
            throw error;
          }
          return raceWithAbortSignal(operation, scope.signal).finally(finish);
        };
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
    if (scope.signal.aborted) {
      throw scope.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const operation = capabilityScope
      ? fetchWithCapability(url, capabilityScope, requestInit)
      : fetch(url, requestInit);
    const response = await raceWithAbortSignal(operation, scope.signal, cancelResponseBody);
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

// ─── oEmbed Metadata Cache (LRU + TTL) ────────────────────────────

interface YouTubeOEmbedMetadata {
  readonly title: string;
  readonly authorName: string;
}

const _oEmbedMetadataCache = new Map<string, { metadata: YouTubeOEmbedMetadata; ts: number }>();
const _oEmbedInFlight = new Map<string, Promise<YouTubeOEmbedMetadata | null>>();

function _oEmbedCacheGet(key: string): YouTubeOEmbedMetadata | null {
  const entry = _oEmbedMetadataCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > OEMBED_CACHE_TTL_MS) {
    _oEmbedMetadataCache.delete(key);
    return null;
  }
  // LRU: move to end
  _oEmbedMetadataCache.delete(key);
  _oEmbedMetadataCache.set(key, entry);
  return entry.metadata;
}

function _oEmbedCacheSet(key: string, metadata: YouTubeOEmbedMetadata): void {
  // Evict oldest if at capacity
  if (_oEmbedMetadataCache.size >= OEMBED_CACHE_MAX) {
    const oldest = _oEmbedMetadataCache.keys().next().value;
    if (oldest !== undefined) _oEmbedMetadataCache.delete(oldest);
  }
  _oEmbedMetadataCache.set(key, { metadata, ts: Date.now() });
}

export async function fetchOEmbedTitle(
  url: string,
  onMetadata?: (metadata: YouTubeOEmbedMetadata) => void,
): Promise<string | null> {
  const key = String(url || '');
  if (!key) return null;

  const cached = _oEmbedCacheGet(key);
  let metadata = cached;

  if (!metadata) {
    let pending = _oEmbedInFlight.get(key);
    if (!pending) {
      pending = (async (): Promise<YouTubeOEmbedMetadata | null> => {
        try {
          const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(key)}&format=json`;
          const response = await fetchWithTimeout(oEmbedUrl);
          if (!response.ok) {
            await cancelResponseBody(response);
            return null;
          }
          const data = (await readBoundedJsonResponse(response, OEMBED_RESPONSE_MAX_BYTES)) as {
            title?: unknown;
            author_name?: unknown;
          };
          const title = normalizeExternalTitle(data?.title);
          if (!title) return null;
          return {
            title,
            authorName: normalizeExternalTitle(data?.author_name),
          };
        } catch (e) {
          log.warn('[YouTube oEmbed] Fetch failed:', e);
          return null;
        } finally {
          _oEmbedInFlight.delete(key);
        }
      })();
      _oEmbedInFlight.set(key, pending);
    }
    metadata = await pending;
    if (metadata) _oEmbedCacheSet(key, metadata);
  }

  if (!metadata) return null;
  onMetadata?.(metadata);
  return metadata.title;
}
