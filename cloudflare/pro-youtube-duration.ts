import { cancelReadableBody } from './pro-room-body.ts';
import { constantTimeEqual, hmacBase64Url } from './pro-room-crypto.ts';

export const PRO_YOUTUBE_DURATION_PATH = '/internal/pro-youtube-duration';
const INTERNAL_ORIGIN = 'https://pro-youtube-metadata.internal';
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SIGNATURE_HEADER = 'x-mxqr-youtube-metadata-signature';
const TIMESTAMP_HEADER = 'x-mxqr-youtube-metadata-time';
const SIGNATURE_MAX_AGE_MS = 30_000;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const RESPONSE_MAX_BYTES = 32 * 1024;
const UPSTREAM_TIMEOUT_MS = 3_000;
const SERVICE_TIMEOUT_MS = 4_000;
const CACHE_MAX = 256;

export type ProYouTubeDurationResult =
  | { kind: 'finite'; durationSeconds: number }
  | { kind: 'live' }
  | { kind: 'unplayable' }
  | { kind: 'unavailable' }
  | { kind: 'retry' };

interface MetadataServiceEnv {
  readonly PRO_YOUTUBE_METADATA?: { fetch(request: Request): Promise<Response> };
  readonly MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET?: unknown;
}

interface MetadataAppEnv {
  readonly YOUTUBE_API_KEY?: unknown;
  readonly YOUTUBE_DATA_API_KEY?: unknown;
  readonly MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET?: unknown;
}

interface CachedMetadata {
  apiKey: string;
  result: ProYouTubeDurationResult;
  expiresAtMs: number;
}

const metadataCache = new Map<string, CachedMetadata>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32;
}

function signaturePayload(videoId: string, timestamp: string): string {
  // A separate domain prevents an account assertion from authorizing paid
  // metadata access, even though both Workers already share this secret.
  return `musixquare:pro-youtube-duration:v1\nGET\n${INTERNAL_ORIGIN}${PRO_YOUTUBE_DURATION_PATH}\n${videoId}\n${timestamp}`;
}

function durationSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!parts || !parts.slice(1).some((part) => part !== undefined)) return null;
  const duration =
    Number(parts[1] || 0) * 86400 +
    Number(parts[2] || 0) * 3600 +
    Number(parts[3] || 0) * 60 +
    Number(parts[4] || 0);
  return Number.isFinite(duration) && duration > 0 && duration <= MAX_DURATION_SECONDS
    ? duration
    : null;
}

function readVideoMetadata(payload: unknown, videoId: string): ProYouTubeDurationResult {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.items)) return { kind: 'retry' };
  if (root.items.length === 0) return { kind: 'unavailable' };
  if (root.items.length !== 1) return { kind: 'retry' };
  const item = asRecord(root.items[0]);
  if (!item || item.id !== videoId) return { kind: 'retry' };
  const snippet = asRecord(item.snippet);
  const live = asRecord(item.liveStreamingDetails);
  const status = asRecord(item.status);
  if (
    status?.uploadStatus === 'deleted' ||
    status?.uploadStatus === 'rejected' ||
    status?.uploadStatus === 'failed'
  ) {
    return { kind: 'unplayable' };
  }
  if (status?.privacyStatus === 'private') {
    return { kind: 'unavailable' };
  }
  if (status?.embeddable === false) return { kind: 'unplayable' };
  if (
    snippet?.liveBroadcastContent === 'live' ||
    snippet?.liveBroadcastContent === 'upcoming' ||
    (live &&
      (typeof live.actualEndTime !== 'string' || !Number.isFinite(Date.parse(live.actualEndTime))))
  ) {
    return { kind: 'live' };
  }
  // A missing live classification is uncertainty, not evidence that the
  // iframe's growing live duration is a finite end-of-video boundary.
  if (snippet?.liveBroadcastContent !== 'none') return { kind: 'retry' };
  const duration = durationSeconds(asRecord(item.contentDetails)?.duration);
  return duration === null ? { kind: 'retry' } : { kind: 'finite', durationSeconds: duration };
}

async function fetchBoundedJson(
  fetcher: (request: Request) => Promise<Response>,
  request: Request,
  timeoutMs: number,
): Promise<{ status: number; payload: unknown } | null> {
  const controller = new AbortController();
  let expired = false;
  let response: Response | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      cancelReadableBody(reader || response, 'PRO_YOUTUBE_METADATA_TIMEOUT');
      resolve(null);
    }, timeoutMs);
  });
  const operation = (async () => {
    try {
      response = await fetcher(new Request(request, { signal: controller.signal }));
      if (expired) {
        cancelReadableBody(response, 'PRO_YOUTUBE_METADATA_TIMEOUT');
        return null;
      }
      if (!response.ok || !response.body) {
        cancelReadableBody(response, 'PRO_YOUTUBE_METADATA_UNAVAILABLE');
        return { status: response.status, payload: null };
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > RESPONSE_MAX_BYTES)) {
        cancelReadableBody(response, 'PRO_YOUTUBE_METADATA_TOO_LARGE');
        return null;
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (!expired) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > RESPONSE_MAX_BYTES) {
          cancelReadableBody(reader, 'PRO_YOUTUBE_METADATA_TOO_LARGE');
          return null;
        }
        chunks.push(chunk.value);
      }
      if (expired) return null;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        status: response.status,
        payload: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      };
    } catch {
      return null;
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        /* A non-cooperative timed-out stream may still own its read. */
      }
    }
  })();
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Only the canonical room target may be supplied here, never a guest URL. */
export async function resolveProYouTubeDuration(
  env: MetadataServiceEnv,
  videoId: string,
): Promise<ProYouTubeDurationResult> {
  const secret = env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET;
  const service = env.PRO_YOUTUBE_METADATA;
  if (!VIDEO_ID_RE.test(videoId) || !validSecret(secret) || !service) return { kind: 'retry' };
  const timestamp = String(Date.now());
  const signature = await hmacBase64Url(secret, signaturePayload(videoId, timestamp));
  const request = new Request(`${INTERNAL_ORIGIN}${PRO_YOUTUBE_DURATION_PATH}?videoId=${videoId}`, {
    headers: { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp },
    redirect: 'error',
  });
  const response = await fetchBoundedJson(
    (input) => service.fetch(input),
    request,
    SERVICE_TIMEOUT_MS,
  );
  if (!response || response.status !== 200) return { kind: 'retry' };
  const payload = asRecord(response.payload);
  if (!payload || payload.videoId !== videoId) return { kind: 'retry' };
  if (
    payload.kind === 'live' ||
    payload.kind === 'unplayable' ||
    payload.kind === 'unavailable' ||
    payload.kind === 'retry'
  ) {
    return { kind: payload.kind };
  }
  const duration = payload.durationSeconds;
  return payload.kind === 'finite' &&
    typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration > 0 &&
    duration <= MAX_DURATION_SECONDS
    ? { kind: 'finite', durationSeconds: duration }
    : { kind: 'retry' };
}

/** Authenticated service-only proxy; no browser credential can authorize it. */
export async function handleProYouTubeDurationRequest(
  request: Request,
  env: MetadataAppEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('videoId') || '';
  const timestamp = request.headers.get(TIMESTAMP_HEADER) || '';
  const signature = request.headers.get(SIGNATURE_HEADER) || '';
  const secret = env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET;
  if (
    request.method !== 'GET' ||
    url.origin !== INTERNAL_ORIGIN ||
    url.pathname !== PRO_YOUTUBE_DURATION_PATH ||
    url.search !== `?videoId=${videoId}` ||
    !VIDEO_ID_RE.test(videoId) ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > SIGNATURE_MAX_AGE_MS ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !validSecret(secret)
  ) {
    return new Response(null, { status: 404 });
  }
  const expected = await hmacBase64Url(secret, signaturePayload(videoId, timestamp));
  if (!constantTimeEqual(signature, expected)) return new Response(null, { status: 404 });
  const apiKey = env.YOUTUBE_API_KEY || env.YOUTUBE_DATA_API_KEY;
  let result: ProYouTubeDurationResult = { kind: 'retry' };
  if (typeof apiKey === 'string' && apiKey) {
    const cached = metadataCache.get(videoId);
    if (cached && cached.apiKey === apiKey && cached.expiresAtMs > Date.now()) {
      result = cached.result;
    } else {
      const params = new URLSearchParams({
        part: 'contentDetails,snippet,liveStreamingDetails,status',
        id: videoId,
        fields:
          'items(id,contentDetails/duration,snippet/liveBroadcastContent,liveStreamingDetails/actualEndTime,status(embeddable,privacyStatus,uploadStatus))',
      });
      const response = await fetchBoundedJson(
        (input) => fetch(input),
        new Request(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
          headers: { 'x-goog-api-key': apiKey },
          redirect: 'error',
        }),
        UPSTREAM_TIMEOUT_MS,
      );
      result =
        response?.status === 200 ? readVideoMetadata(response.payload, videoId) : { kind: 'retry' };
      if (metadataCache.size >= CACHE_MAX) {
        const oldest = metadataCache.keys().next().value;
        if (oldest !== undefined) metadataCache.delete(oldest);
      }
      metadataCache.delete(videoId);
      metadataCache.set(videoId, {
        apiKey,
        result,
        expiresAtMs:
          Date.now() +
          (result.kind === 'finite' ? 3_600_000 : result.kind === 'retry' ? 5_000 : 30_000),
      });
    }
  }
  return Response.json({ videoId, ...result }, { headers: { 'cache-control': 'no-store' } });
}
