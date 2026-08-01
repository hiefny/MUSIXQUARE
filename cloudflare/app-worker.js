import { handleProBotRequest } from './pro-bot.js';
import {
  cleanupPendingAccountDeletions,
  cleanupExpiredAccountSessions,
  handleAccountAuthRequest,
  recordAccountProRoomLink,
  retireAccountProRoomLinkBatch,
  retireAccountProRoomLinks,
  resolveAccountSession,
} from './account-auth.js';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  createAccountAssertion,
} from './account-assertion.js';
import {
  INITIAL_PRO_ROOM_GENERATION,
  MAX_PRO_ROOM_GENERATION,
  isProRoomGeneration,
  proRoomGenerationHeaderValue,
  proRoomObjectName,
} from './pro-room-generation.js';

const YOUTUBE_SEARCH_API = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_PLAYLIST_ITEMS_API = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS = 5_000;
const YOUTUBE_PLAYLIST_MANIFEST_PAGE_SIZE = 50;
const YOUTUBE_PLAYLIST_MANIFEST_TIMEOUT_MS = 45_000;
const REALTIME_API_BASE = 'https://rtc.live.cloudflare.com/v1';
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_LIMIT = 12;
const QUERY_MAX_LENGTH = 120;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const CLOUDFLARE_TURN_TTL_DEFAULT = 48 * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const CLOUDFLARE_TURN_TTL_MIN = 60;
const CLOUDFLARE_TURN_TTL_MAX = CLOUDFLARE_TURN_TTL_DEFAULT;
const CAPABILITY_TOKEN_TTL_DEFAULT = 10 * SECONDS_PER_MINUTE;
// Keep the minimum well above the 30s client refresh skew. If challenge mode
// is enabled, a 60s TTL leaves only ~30s of usable cache and executes the
// challenge too frequently for legitimate users.
const CAPABILITY_TOKEN_TTL_MIN = 3 * SECONDS_PER_MINUTE;
const CAPABILITY_TOKEN_TTL_MAX = 30 * SECONDS_PER_MINUTE;
const CAPABILITY_SCOPES = new Set(['turn', 'realtime', 'youtube-search', 'remote-share']);
const CAPABILITY_POW_DIFFICULTY_DEFAULT = 16;
const CAPABILITY_POW_DIFFICULTY_MIN = 8;
const CAPABILITY_POW_DIFFICULTY_MAX = 24;
const CAPABILITY_POW_TTL_DEFAULT = 2 * SECONDS_PER_MINUTE;
const CAPABILITY_POW_TTL_MIN = 30;
const CAPABILITY_POW_TTL_MAX = 5 * SECONDS_PER_MINUTE;
const CAPABILITY_JSON_BODY_MAX_BYTES = 8 * 1024;
const ADMIN_JSON_BODY_MAX_BYTES = 8 * 1024;
const REALTIME_JSON_BODY_MAX_BYTES = 128 * 1024;
// One venue can legitimately place 100 browsers behind one public IP. Keep
// paid-resource room bursts separate from the default API limits and retain a
// per-capability/session limiter below so one browser cannot consume the burst.
const ROOM_BURST_CAPABILITY_LIMIT = 300;
const ROOM_BURST_TURN_LIMIT = 150;
const ROOM_BURST_REALTIME_NEW_SESSION_LIMIT = 250;
const ROOM_BURST_REALTIME_MUTATION_LIMIT = 650;
const REALTIME_NEW_SESSION_PER_CAPABILITY_LIMIT = 4;
const REALTIME_MUTATION_PER_CAPABILITY_LIMIT = 12;
const REALTIME_MUTATION_PER_SESSION_LIMIT = 8;
// Realtime session ownership is a separate, least-privilege capability. The
// general `realtime` capability only permits creating an SFU session; it must
// never be enough to mutate an arbitrary session ID learned from a peer.
const REALTIME_SESSION_CAPABILITY_TTL = 24 * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const REALTIME_SESSION_ID_MAX_LENGTH = 256;
const REALTIME_SESSION_CAPABILITY_MAX_LENGTH = 2048;
const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SORO_RSS_DEFAULT_URL = 'https://app.trysoro.com/api/rss/a07c133f-e3b9-401e-a076-ee36124598a7';
const SORO_RSS_BACKUP_KEY = 'soro-rss-latest-good.xml';
const SORO_RSS_BACKUP_META_KEY = 'soro-rss-latest-good.meta.json';
const SORO_HIDDEN_SLUGS_KEY = 'soro-hidden-slugs.json';
const SORO_BLOG_CACHE_VERSION_KEY = 'soro-blog-cache-version.json';
const ADMIN_ANNOUNCEMENT_KEY = 'admin-announcement.json';
const ADMIN_ANNOUNCEMENT_HISTORY_KEY = 'admin-announcement-history.json';
const ADMIN_ANNOUNCEMENT_HISTORY_LIMIT = 100;
const SORO_RSS_MAX_BYTES = 20 * 1024 * 1024;
const SORO_RSS_FETCH_TIMEOUT_MS = 2500;
const SORO_BACKGROUND_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SORO_BLOG_HTML_CACHE = 'no-store, max-age=0, must-revalidate';
const APP_SHELL_FRESH_CACHE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
});
const SORO_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SORO_IMAGE_FETCH_TIMEOUT_MS = 5000;
const SORO_IMAGE_ROUTE_PREFIX = '/soro-images/';
const SORO_IMAGE_R2_PREFIX = 'featured/';
const SORO_IMAGE_CACHE = 'public, max-age=31536000, immutable';
const ADMIN_SESSION_COOKIE = '__Host-mxqr_admin';
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
const ADMIN_PRO_ROOM_PATH_RE = /^\/api\/admin\/pro-rooms(?:\/(0\d{5})\/activation-claim)?$/;
const ADMIN_PRO_ROOM_OWNER_RECOVERY_PATH_RE =
  /^\/api\/admin\/pro-rooms\/(0\d{5})\/owner-recovery-claim$/;
const ADMIN_PRO_ROOM_STATE_PATH_RE = /^\/api\/admin\/pro-rooms\/(0\d{5})\/state$/;
const ADMIN_PRO_ROOM_LABEL_PATH_RE = /^\/api\/admin\/pro-rooms\/(0\d{5})\/label$/;
const ADMIN_PRO_ROOM_DELETE_PATH_RE = /^\/api\/admin\/pro-rooms\/(0\d{5})$/;
const ADMIN_DEVELOPER_API_KEY_PATH_RE =
  /^\/api\/admin\/pro-rooms\/(0\d{5})\/api-keys(?:\/([A-Za-z0-9_-]{16}))?$/;
const ADMIN_PRO_ROOM_CODE_RE = /^0\d{5}$/;
const ADMIN_PRO_ROOM_REGISTRY_TABLE = 'mxqr_pro_room_registry';
const ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE = 'mxqr_pro_room_generation_history';
const ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE = 'mxqr_pro_room_generation_allocations';
const ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE = 'mxqr_pro_room_generation_cutover';
const ADMIN_PRO_ROOM_AUDIT_TABLE = 'mxqr_pro_room_admin_audit';
const ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION = 1;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const ADMIN_PRO_ROOM_REGISTRY_LIMIT = 1000;
const ADMIN_PRO_ROOM_LABEL_MAX_LENGTH = 64;
const ADMIN_PRO_ROOM_ACTIVATION_CLAIM_MAX_TTL_MS = 15 * 60 * 1000;
const ADMIN_PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_TTL_MS = 10 * 60 * 1000;
const ADMIN_PRO_ROOM_ACTIVATION_RECONCILE_MIN_AGE_MS = 60 * 1000;
const ADMIN_PRO_ROOM_ACTIVATION_RECONCILE_BATCH_SIZE = 25;
const ADMIN_DEVELOPER_API_KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const ADMIN_DEVELOPER_API_KEY_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const ADMIN_DEVELOPER_API_KEY_DEFAULT_DAYS = 90;
const ADMIN_DEVELOPER_API_KEY_MAX_DAYS = 365;
const ADMIN_DEVELOPER_API_DAY_MS = 86_400_000;
const ADMIN_DEVELOPER_API_KEY_MAX_ACTIVE = 3;
const ADMIN_DEVELOPER_API_KEY_LIST_LIMIT = 200;
const ADMIN_DEVELOPER_API_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMIN_DEVELOPER_API_KEY_SCOPES = Object.freeze({
  'room:read': 1,
  'playback:read': 2,
  'playback:control': 4,
  'queue:read': 8,
  'queue:write': 16,
  'media:upload': 32,
  'effects:read': 64,
  'effects:control': 128,
});
const ADMIN_DEVELOPER_API_KEY_ALL_SCOPE_BITS = Object.values(ADMIN_DEVELOPER_API_KEY_SCOPES).reduce(
  (mask, bit) => mask | bit,
  0,
);
const PRO_ROOM_FACADE_PREFIX = '/api/pro-room';
const PRO_ROOM_FACADE_HEALTH_PATH = `${PRO_ROOM_FACADE_PREFIX}/health`;
const PRO_ROOM_FACADE_PATH_RE = /^\/api\/pro-room(\/v1\/rooms\/(0\d{5})(?:\/|$).*)$/;
const PRO_ROOM_UPSTREAM_ORIGIN = 'https://pro-room.internal';
// Buffer every public PRO mutation at the stateless facade before invoking
// the room Durable Object. Otherwise a client that opens a chunked request and
// never finishes it can leave the downstream body parser waiting while it owns
// the room's serialized mutation queue.
const PRO_ROOM_FACADE_BODY_MAX_BYTES = 4 * 1024 * 1024;
const PRO_ROOM_FACADE_BODY_TIMEOUT_MS = 10_000;
const INITIAL_ADMIN_PRO_ROOMS = Object.freeze([
  Object.freeze({ roomCode: '000000', label: 'MUSIXQUARE Developer' }),
  Object.freeze({ roomCode: '000001', label: 'Friends & Family' }),
]);
const ADMIN_METRICS_TABLE = 'mxqr_metric_buckets';
const ADMIN_METRICS_RETENTION_DAYS = 90;
const ADMIN_PRO_ROOM_AUDIT_RETENTION_DAYS = 365;
const MINUTES_PER_DAY = 24 * 60;
const ADMIN_METRIC_EVENTS = [
  { key: 'room_opened', label: 'Rooms opened' },
  { key: 'guest_joined', label: 'Guest joins' },
  { key: 'host_reconnected', label: 'Host reconnects' },
  { key: 'guest_host_unavailable', label: 'Guest host-missing errors' },
  { key: 'guest_auth_pending', label: 'Password prompts' },
  { key: 'guest_auth_failed', label: 'Password failures' },
  { key: 'guest_auth_timeout', label: 'Password timeouts' },
  { key: 'guest_reconnect_denied', label: 'Guest reconnect denials' },
  { key: 'guest_reconnect_conflict', label: 'Guest reconnect conflicts' },
  { key: 'guest_room_full', label: 'Room-full rejections' },
  { key: 'guest_pending_capacity', label: 'Pending guest handshake rejections' },
  { key: 'guest_identity_capacity', label: 'Guest identity limit rejections' },
  { key: 'ws_message_oversized', label: 'Oversized signaling messages' },
  { key: 'ws_message_rate_limited', label: 'Rate-limited signaling messages' },
];

let soroBackgroundRefreshPromise = null;
let soroBackgroundRefreshStartedAt = 0;

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://img.youtube.com https://i.ytimg.com https://app.trysoro.com https://*.trysoro.com https://*.supabase.co; media-src 'self' blob: https://demo.musixquare.com; connect-src 'self' blob: https://www.youtube.com https://musixquare.com https://demo.musixquare.com https://*.musixquare.com wss://*.musixquare.com https://*.workers.dev wss://*.workers.dev https://*.r2.cloudflarestorage.com https://challenges.cloudflare.com https://cloudflareinsights.com https://app.trysoro.com https://*.trysoro.com; frame-src https://www.youtube.com https://challenges.cloudflare.com; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'",
};

function json(body, status = 200, headers = {}) {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        ...headers,
      },
    }),
  );
}

function proRoomCookieNames(roomCode) {
  return {
    upstreamSession: `__Host-mxqr_pro_session_${roomCode}`,
    upstreamOwner: `__Host-mxqr_pro_owner_${roomCode}`,
    facadeSession: `__Secure-mxqr_pro_session_${roomCode}`,
    facadeOwner: `__Secure-mxqr_pro_owner_${roomCode}`,
  };
}

function proRoomFacadeCookiePath(roomCode) {
  return `${PRO_ROOM_FACADE_PREFIX}/v1/rooms/${roomCode}`;
}

function forwardedProRoomCookies(rawCookie, roomCode) {
  if (!rawCookie) return '';
  const names = proRoomCookieNames(roomCode);
  const forwarded = [];
  for (const part of rawCookie.split(';')) {
    const cookie = part.trim();
    const separator = cookie.indexOf('=');
    if (separator <= 0) continue;
    const name = cookie.slice(0, separator);
    const value = cookie.slice(separator + 1);
    if (name === names.facadeSession) {
      forwarded.push(`${names.upstreamSession}=${value}`);
    } else if (name === names.facadeOwner) {
      forwarded.push(`${names.upstreamOwner}=${value}`);
    }
  }
  return forwarded.join('; ');
}

function splitSetCookieHeader(headers) {
  if (typeof headers.getAll === 'function') return headers.getAll('Set-Cookie');
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('Set-Cookie');
  return combined ? combined.split(/,(?=\s*__Host-mxqr_pro_(?:session|owner)_)/) : [];
}

function facadeProRoomSetCookie(value, roomCode) {
  const names = proRoomCookieNames(roomCode);
  let rewritten = value;
  if (rewritten.startsWith(`${names.upstreamSession}=`)) {
    rewritten = `${names.facadeSession}=${rewritten.slice(names.upstreamSession.length + 1)}`;
  } else if (rewritten.startsWith(`${names.upstreamOwner}=`)) {
    rewritten = `${names.facadeOwner}=${rewritten.slice(names.upstreamOwner.length + 1)}`;
  } else {
    return null;
  }
  return rewritten.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${proRoomFacadeCookiePath(roomCode)}`);
}

function withFacadeProRoomCookies(response, roomCode) {
  const headers = new Headers(response.headers);
  // This is an App↔PRO Worker bookkeeping signal, never public API surface.
  headers.delete('x-mxqr-account-linked');
  const setCookies = splitSetCookieHeader(response.headers);
  headers.delete('Set-Cookie');
  for (const value of setCookies) {
    const rewritten = facadeProRoomSetCookie(value.trim(), roomCode);
    if (rewritten) headers.append('Set-Cookie', rewritten);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function preflightRegisteredProBotRoom(env, roomCode) {
  const db = getAdminDb(env);
  if (!db?.prepare) return 'BOT_UNAVAILABLE';
  try {
    const statement = db
      .prepare(
        `SELECT status, room_generation FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHERE room_code = ?1 LIMIT 1`,
      )
      .bind(roomCode);
    const row =
      typeof statement.first === 'function'
        ? await statement.first()
        : (await statement.all())?.results?.[0] || null;
    if (row?.status !== 'registered') return 'BOT_ROOM_ONLY';
    const roomGeneration = Number(row.room_generation);
    return isProRoomGeneration(roomGeneration) ? { roomGeneration } : 'BOT_UNAVAILABLE';
  } catch {
    return 'BOT_UNAVAILABLE';
  }
}

async function preflightRegisteredProRoomAccountLink(env, roomCode) {
  const db = getAdminDb(env);
  if (!db?.prepare) return null;
  const statement = db
    .prepare(
      `SELECT status, room_generation FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       WHERE room_code = ?1 LIMIT 1`,
    )
    .bind(roomCode);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  // `registered` includes an unactivated room: activation is precisely where
  // its first owner/account cleanup edge can be created. Provisioning,
  // suspended and permanently decommissioned rooms must never grow the
  // account reverse index.
  if (row?.status !== 'registered') return null;
  const roomGeneration = Number(row.room_generation);
  return isProRoomGeneration(roomGeneration) ? { roomGeneration } : null;
}

async function repairUnforwardedAccountProRoomLink(env, roomCode, roomGeneration) {
  try {
    const current = await preflightRegisteredProRoomAccountLink(env, roomCode);
    if (current?.roomGeneration === roomGeneration) {
      // The room is still a valid incarnation. Keeping its conservative
      // reverse edge is intentional even though this particular assertion was
      // not forwarded; a later successful link must retain an account-deletion
      // cleanup path.
      return false;
    }
    // A missing, terminal, or recycled registry pointer proves that no account
    // authority can be created in this exact incarnation. Retire all of that
    // incarnation's now-orphaned cleanup edges, never the successor's.
    await retireAccountProRoomLinks(env, roomCode, roomGeneration);
    return true;
  } catch {
    // A registry outage is not proof that an edge is orphaned. Leave the
    // conservative edge for the scheduled decommission repair sweep.
    return false;
  }
}

async function handleProRoomFacade(request, env, url) {
  const isHealth = url.pathname === PRO_ROOM_FACADE_HEALTH_PATH;
  const route = url.pathname.match(PRO_ROOM_FACADE_PATH_RE);
  if (!isHealth && !route) {
    return json({ error: 'PRO_ROOM_ROUTE_NOT_FOUND' }, 404, { 'Cache-Control': 'no-store' });
  }

  if (route) {
    const [, upstreamPath, roomCode] = route;
    if (upstreamPath === `/v1/rooms/${roomCode}/bot/commands`) {
      return handleProBotRequest(request, env, {
        roomCode,
        forwardedCookies: forwardedProRoomCookies(request.headers.get('Cookie'), roomCode),
        preflightRoom: () => preflightRegisteredProBotRoom(env, roomCode),
      });
    }
  }

  if (isHealth) {
    if (url.search) {
      return json({ error: 'INVALID_REQUEST' }, 400, { 'Cache-Control': 'no-store' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405, {
        Allow: 'GET, HEAD',
        'Cache-Control': 'no-store',
      });
    }
    if (!env.PRO_ROOM_PUBLIC_API || typeof env.PRO_ROOM_PUBLIC_API.fetch !== 'function') {
      return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 503, { 'Cache-Control': 'no-store' });
    }
    const headers = new Headers({ Accept: 'application/json' });
    let response;
    try {
      response = await env.PRO_ROOM_PUBLIC_API.fetch(
        new Request(new URL('/health', PRO_ROOM_UPSTREAM_ORIGIN), {
          method: 'GET',
          headers,
          redirect: 'manual',
        }),
      );
    } catch {
      return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502, { 'Cache-Control': 'no-store' });
    }
    return withSecurityHeaders(
      new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      }),
    );
  }

  if (!env.PRO_ROOM_PUBLIC_API || typeof env.PRO_ROOM_PUBLIC_API.fetch !== 'function') {
    return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 503, { 'Cache-Control': 'no-store' });
  }

  let bufferedMutationBody = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const buffered = await readBodyBytesLimited(
      request,
      PRO_ROOM_FACADE_BODY_MAX_BYTES,
      PRO_ROOM_FACADE_BODY_TIMEOUT_MS,
    );
    if (buffered.error === 'too-large') {
      return json({ error: 'PRO_ROOM_REQUEST_BODY_TOO_LARGE' }, 413, {
        'Cache-Control': 'no-store',
      });
    }
    if (buffered.error === 'timeout' || buffered.error === 'aborted') {
      return json({ error: 'PRO_ROOM_REQUEST_BODY_TIMEOUT' }, 408, {
        'Cache-Control': 'no-store',
      });
    }
    if (buffered.error) {
      return json({ error: 'INVALID_REQUEST' }, 400, { 'Cache-Control': 'no-store' });
    }
    bufferedMutationBody = buffered.body;
  }

  const [, upstreamPath, roomCode] = route;
  const headers = new Headers(request.headers);
  // Preserve a browser-supplied Origin so the PRO Worker remains the single
  // CSRF/CORS authority. Same-origin GET/HEAD requests commonly omit it, so
  // synthesize only for those safe methods. A mutation without Origin must
  // still fail closed in the PRO Worker.
  if (!headers.has('Origin') && (request.method === 'GET' || request.method === 'HEAD')) {
    headers.set('Origin', url.origin);
  }
  headers.delete('X-MXQR-Pro-Room-Code');
  headers.delete('X-MXQR-Pro-Room-Generation');
  headers.delete('X-MXQR-Pro-IP-Hash');
  // A browser can name this header but can never supply its value. Account
  // identity is resolved from the App Worker's host-only session cookie and
  // replaced with a short-lived room/audience-bound service assertion.
  headers.delete(ACCOUNT_ASSERTION_HEADER);
  const accountLinkAssertionPaths = new Set([
    `/v1/rooms/${roomCode}/activation`,
    `/v1/rooms/${roomCode}/owner-recovery`,
    `/v1/rooms/${roomCode}/sessions`,
    `/v1/rooms/${roomCode}/sessions/current/account`,
  ]);
  const accountLeaseAssertionPath = `/v1/rooms/${roomCode}/sessions/current/account/lease`;
  if (accountLinkAssertionPaths.has(upstreamPath) || upstreamPath === accountLeaseAssertionPath) {
    let recordedRoomGeneration = null;
    try {
      const account = await resolveAccountSession(request, env);
      const assertionSecret = String(env.MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET || '');
      if (account?.profileComplete && account.nickname && assertionSecret.length >= 32) {
        // A lease renewal skips the reverse-index write because the exact
        // physical session is already linked downstream, but it still resolves
        // the current immutable room generation so a recycled public code can
        // never turn an old account assertion into authority in its successor.
        const roomLink = await preflightRegisteredProRoomAccountLink(env, roomCode);
        if (roomLink) {
          let assertion = await createAccountAssertion(
            {
              accountId: account.accountId,
              nickname: account.nickname,
              roomCode,
              roomGeneration: roomLink.roomGeneration,
              audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
            },
            assertionSecret,
          );
          if (assertion && upstreamPath !== accountLeaseAssertionPath) {
            // Record the conservative cleanup edge before the downstream
            // Worker can persist this account as an owner/administrator. The
            // registry preflight bounds rejected-join edges to real rooms;
            // a missing edge would be unsafe for account deletion.
            const linked = await recordAccountProRoomLink(
              env,
              account.accountId,
              roomCode,
              Date.now(),
              roomLink.roomGeneration,
            );
            if (!linked) throw new Error('PRO_ACCOUNT_LINK_UNAVAILABLE');
            recordedRoomGeneration = roomLink.roomGeneration;
            // Close the registry-preflight/write race. If decommission
            // completed between those operations, remove the just-written
            // exact-incarnation edge and forward no account authority.
            const confirmedRoomLink = await preflightRegisteredProRoomAccountLink(env, roomCode);
            if (confirmedRoomLink?.roomGeneration !== roomLink.roomGeneration) {
              await retireAccountProRoomLinks(env, roomCode, roomLink.roomGeneration);
              assertion = null;
            }
          }
          if (assertion) headers.set(ACCOUNT_ASSERTION_HEADER, assertion);
        }
      }
    } catch (error) {
      if (isProRoomGeneration(recordedRoomGeneration)) {
        await repairUnforwardedAccountProRoomLink(env, roomCode, recordedRoomGeneration);
      }
      // Login is optional. An identity-store outage must not turn a valid room
      // PIN into a playback outage; the PRO service will treat this request as
      // anonymous and never trusts a client-claimed account.
      console.warn('[AccountAuth] PRO assertion unavailable', error);
    }
  }
  const cookies = forwardedProRoomCookies(headers.get('Cookie'), roomCode);
  if (cookies) headers.set('Cookie', cookies);
  else headers.delete('Cookie');

  const upstreamUrl = new URL(upstreamPath, PRO_ROOM_UPSTREAM_ORIGIN);
  upstreamUrl.search = url.search;
  const upstreamInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (bufferedMutationBody !== null) upstreamInit.body = bufferedMutationBody;
  }
  let response;
  try {
    response = await env.PRO_ROOM_PUBLIC_API.fetch(new Request(upstreamUrl, upstreamInit));
  } catch {
    return json({ error: 'PRO_ROOM_API_UNAVAILABLE' }, 502, { 'Cache-Control': 'no-store' });
  }
  return withFacadeProRoomCookies(response, roomCode);
}

async function readBodyBytesLimited(request, maxBytes, timeoutMs) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized)) return { error: 'invalid' };
    if (Number(normalized) > maxBytes) return { error: 'too-large' };
  }
  if (!request.body) return { body: null };

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const timeout = setTimeout(() => {
    stop({ kind: 'timeout' });
    void reader.cancel('PRO_ROOM_REQUEST_BODY_TIMEOUT').catch(() => {});
  }, timeoutMs);
  const abort = () => {
    stop({ kind: 'aborted' });
    void reader.cancel(request.signal.reason).catch(() => {});
  };
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      const outcome = await Promise.race([
        reader.read().then(
          (value) => ({ kind: 'read', value }),
          () => ({ kind: 'invalid' }),
        ),
        stopped,
      ]);
      if (outcome.kind !== 'read') return { error: outcome.kind };
      if (outcome.value.done) break;
      const bytes =
        outcome.value.value instanceof Uint8Array
          ? outcome.value.value
          : new Uint8Array(outcome.value.value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('PRO_ROOM_REQUEST_BODY_TOO_LARGE').catch(() => {});
        return { error: 'too-large' };
      }
      chunks.push(bytes);
    }
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
    // A deliberately stalled stream may still own an unsettled read when the
    // deadline wins. Cancellation is best-effort for custom/host streams, and
    // releaseLock() is allowed to throw while that read remains pending. The
    // facade response must still deterministically be the bounded 408.
    try {
      reader.releaseLock();
    } catch {
      /* pending non-cooperative stream read */
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body };
}

async function readJsonBodyLimited(request, maxBytes) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized)) return { error: 'invalid' };
    if (Number(normalized) > maxBytes) return { error: 'too-large' };
  }

  if (!request.body) return { error: 'invalid' };
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('JSON_BODY_TOO_LARGE').catch(() => {});
        return { error: 'too-large' };
      }
      chunks.push(bytes);
    }
  } catch {
    return { error: 'invalid' };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) return { error: 'invalid' };
  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)) };
  } catch {
    return { error: 'invalid' };
  }
}

function jsonBodyError(result, headers = {}) {
  if (result.error === 'too-large') {
    return json({ error: 'Request body too large' }, 413, headers);
  }
  return json({ error: 'Invalid JSON body' }, 400, headers);
}

function withSecurityHeaders(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const contentType = headers.get('Content-Type') || '';
  if (/^text\/html(?:\s*;|$)/i.test(contentType) && !/;\s*charset=/i.test(contentType)) {
    headers.set('Content-Type', `${contentType.trim().replace(/;\s*$/, '')}; charset=utf-8`);
  }
  headers.delete('Content-Length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeCorsOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function configuredTrustedOrigins(env) {
  const raw = env.TRUSTED_CORS_ORIGINS || env.CORS_ALLOWED_ORIGINS || '';
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map(normalizeCorsOrigin)
      .filter(Boolean),
  );
}

function isConfiguredTrustedOrigin(origin, env) {
  const normalizedOrigin = normalizeCorsOrigin(origin);
  if (!normalizedOrigin) return false;
  return configuredTrustedOrigins(env).has(normalizedOrigin);
}

function trustedCors(request, methods, env = {}, options = {}) {
  const origin = request.headers.get('Origin') || '';
  const host = request.headers.get('Host') || '';
  const fetchSite = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  const trustedPatterns = [
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
    /^https:\/\/(?:[^/]+\.)?toss\.im$/i,
    /^https:\/\/(?:[^/]+\.)?toss-internal\.com$/i,
    /^https:\/\/(?:[^/]+\.)?tossmini\.com$/i,
    /^https:\/\/musixquare\.com$/i,
    /^https:\/\/[^/]*\.musixquare\.com$/i,
  ];

  const sameOrigin = origin && (origin === `https://${host}` || origin === `http://${host}`);
  const browserSameOrigin = fetchSite === 'same-origin';
  const sameOriginInferred =
    !origin &&
    !fetchSite &&
    (host === 'musixquare.com' || host.endsWith('.musixquare.com') || host.startsWith('localhost'));
  // Host-only inference is not authentication. Capability endpoints accept it
  // only as a WebView routing/CORS signal; Turnstile or the signed proof-of-work
  // challenge remains mandatory for minting a token.
  const isTrusted =
    sameOrigin ||
    browserSameOrigin ||
    (options.allowInferred && sameOriginInferred) ||
    trustedPatterns.some((pattern) => pattern.test(origin)) ||
    isConfiguredTrustedOrigin(origin, env);
  const allowOrigin = isTrusted ? origin : '';

  return {
    isTrusted,
    sameOriginInferred,
    headers: allowOrigin
      ? {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': methods,
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MXQR-Capability',
          Vary: 'Origin',
        }
      : {},
  };
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
  );
}

// Per-IP rate limit for sensitive endpoints (paid Cloudflare TURN/SFU /
// YouTube quota). Non-browser clients can spoof Origin or Sec-Fetch-Site, so
// paid-resource endpoints need a separate defense layer. Uses Cache API
// (no extra binding needed) keyed
// on CF-Connecting-IP + endpoint + window minute. Atomicity is best-effort
// — concurrent requests within the same minute can each pass with a stale
// count, but the worst-case overshoot is bounded by edge node concurrency
// per IP. Adequate for paid-resource leak prevention; not for strict abuse
// quotas.
async function checkRateLimit(
  request,
  endpoint,
  limit = 60,
  windowSec = 60,
  identityOverride = '',
) {
  // Graceful bypass if the runtime doesn't expose Cache API (e.g. jsdom unit
  // tests that invoke the worker directly). Production Cloudflare workers
  // always have `caches.default`.
  if (typeof caches === 'undefined' || !caches?.default) return true;

  const identity = identityOverride || getClientIp(request);
  const window = Math.floor(Date.now() / (windowSec * 1000));
  // Use a synthetic cache URL so the key is opaque to upstream caches.
  const cacheKey = new Request(
    `https://ratelimit.internal/${encodeURIComponent(endpoint)}/${encodeURIComponent(identity)}/${window}`,
    { method: 'GET' },
  );
  const cache = caches.default;

  let count = 0;
  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const txt = await cached.text();
      const n = Number.parseInt(txt, 10);
      if (Number.isFinite(n) && n >= 0) count = n;
    }
  } catch {
    /* cache miss treated as 0 */
  }

  if (count >= limit) return false;

  try {
    await cache.put(
      cacheKey,
      new Response(String(count + 1), {
        headers: { 'Cache-Control': `public, max-age=${windowSec * 2}` },
      }),
    );
  } catch {
    /* best-effort */
  }
  return true;
}

function rateLimitResponse(headers) {
  return json({ error: 'Too Many Requests' }, 429, {
    ...headers,
    'Retry-After': '60',
  });
}

function getCapabilitySecret(env) {
  return env.MXQR_CAPABILITY_SECRET || env.CAPABILITY_HMAC_SECRET || env.CAPABILITY_SECRET || '';
}

function isCapabilityAuthEnabled(env) {
  return !!getCapabilitySecret(env);
}

function getTurnstileSiteKey(env) {
  return env.TURNSTILE_SITE_KEY || env.CLOUDFLARE_TURNSTILE_SITE_KEY || '';
}

function getTurnstileSecret(env) {
  return env.TURNSTILE_SECRET_KEY || env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '';
}

function isTurnstileDisabled(env) {
  const raw = String(
    env.MXQR_TURNSTILE_DISABLED ?? env.TURNSTILE_DISABLED ?? env.DISABLE_TURNSTILE ?? 'false',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function isTurnstileConfigured(env) {
  if (isTurnstileDisabled(env)) return false;
  return !!(getTurnstileSiteKey(env) && getTurnstileSecret(env));
}

function normalizeHostname(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim().toLowerCase();
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname.replace(/^\*\./, '');
  } catch {
    return trimmed.replace(/^\*\./, '').replace(/[^a-z0-9.-]/g, '');
  }
}

function configuredTurnstileHostnames(env) {
  const raw = env.MXQR_TURNSTILE_ALLOWED_HOSTNAMES || env.TURNSTILE_ALLOWED_HOSTNAMES || '';
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameMatchesRule(hostname, rule) {
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedRule = normalizeHostname(rule);
  if (!normalizedHostname || !normalizedRule) return false;
  if (normalizedHostname === normalizedRule) return true;
  return rule.trim().startsWith('*.') && normalizedHostname.endsWith(`.${normalizedRule}`);
}

function isAllowedTurnstileHostname(hostname, env) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;

  const configured = configuredTurnstileHostnames(env);
  if (configured.length > 0) {
    return configured.some((rule) => hostnameMatchesRule(normalized, rule));
  }

  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === 'musixquare.com' ||
    normalized === 'www.musixquare.com' ||
    normalized.endsWith('.musixquare.com') ||
    normalized === 'toss.im' ||
    normalized.endsWith('.toss.im') ||
    normalized === 'toss-internal.com' ||
    normalized.endsWith('.toss-internal.com') ||
    normalized === 'tossmini.com' ||
    normalized.endsWith('.tossmini.com')
  );
}

function allowUnguardedPaidApis(env) {
  const raw = String(env.MXQR_ALLOW_UNGUARDED_PAID_APIS ?? env.ALLOW_UNGUARDED_PAID_APIS ?? 'false')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function parseCapabilityTtl(env) {
  const parsed = Number.parseInt(env.MXQR_CAPABILITY_TTL || env.CAPABILITY_TTL || '', 10);
  if (!Number.isFinite(parsed)) return CAPABILITY_TOKEN_TTL_DEFAULT;
  return Math.min(CAPABILITY_TOKEN_TTL_MAX, Math.max(CAPABILITY_TOKEN_TTL_MIN, parsed));
}

function parseCapabilityPowDifficulty(env) {
  const parsed = Number.parseInt(
    env.MXQR_CAPABILITY_POW_DIFFICULTY || env.CAPABILITY_POW_DIFFICULTY || '',
    10,
  );
  if (!Number.isFinite(parsed)) return CAPABILITY_POW_DIFFICULTY_DEFAULT;
  return Math.min(CAPABILITY_POW_DIFFICULTY_MAX, Math.max(CAPABILITY_POW_DIFFICULTY_MIN, parsed));
}

function parseCapabilityPowTtl(env) {
  const parsed = Number.parseInt(env.MXQR_CAPABILITY_POW_TTL || env.CAPABILITY_POW_TTL || '', 10);
  if (!Number.isFinite(parsed)) return CAPABILITY_POW_TTL_DEFAULT;
  return Math.min(CAPABILITY_POW_TTL_MAX, Math.max(CAPABILITY_POW_TTL_MIN, parsed));
}

function parseRequestedScopes(value) {
  if (!Array.isArray(value)) return [];
  const scopes = [];
  for (const scope of value) {
    if (typeof scope === 'string' && CAPABILITY_SCOPES.has(scope) && !scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  return scopes.sort();
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stringToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToString(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256Bytes(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function hasLeadingZeroBits(bytes, difficulty) {
  let remaining = difficulty;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    const bits = Math.min(8, remaining);
    if ((byte & (0xff << (8 - bits))) !== 0) return false;
    remaining -= bits;
  }
  return remaining <= 0;
}

async function capabilityIpHash(secret, request) {
  return hmacSha256(secret, `ip:${getClientIp(request)}`);
}

function randomNonce(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function createCapabilityPowChallenge(scopes, request, env) {
  const secret = getCapabilitySecret(env);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + parseCapabilityPowTtl(env),
    ip: await capabilityIpHash(secret, request),
    difficulty: parseCapabilityPowDifficulty(env),
    capabilityTtl: parseCapabilityTtl(env),
    nonce: randomNonce(),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(secret, `capability-pow:${payloadPart}`);
  return {
    challenge: `${payloadPart}.${signature}`,
    difficulty: payload.difficulty,
    expiresAt: payload.exp,
    algorithm: 'sha256-leading-zero-bits',
  };
}

async function verifyCapabilityPowProof(proof, scopes, request, env) {
  if (!proof || typeof proof !== 'object') return null;
  const challenge = typeof proof.challenge === 'string' ? proof.challenge : '';
  const solution = typeof proof.solution === 'string' ? proof.solution : '';
  if (!challenge || !/^\d{1,20}$/.test(solution)) return null;

  const parts = challenge.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const secret = getCapabilitySecret(env);
  const expectedSignature = await hmacSha256(secret, `capability-pow:${parts[0]}`);
  if (!constantTimeEqual(expectedSignature, parts[1])) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return null;
  if (!Array.isArray(payload.scopes) || JSON.stringify(payload.scopes) !== JSON.stringify(scopes)) {
    return null;
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.exp - payload.iat !== parseCapabilityPowTtl(env)) return null;
  if (payload.difficulty !== parseCapabilityPowDifficulty(env)) return null;
  if (payload.capabilityTtl !== parseCapabilityTtl(env)) return null;
  if (typeof payload.nonce !== 'string' || !payload.nonce) return null;

  const expectedIp = await capabilityIpHash(secret, request);
  if (!constantTimeEqual(String(payload.ip || ''), expectedIp)) return null;

  const digest = await sha256Bytes(`mxqr-pow-v1:${challenge}:${solution}`);
  if (!hasLeadingZeroBits(digest, payload.difficulty)) return null;
  return payload;
}

function readCapabilityToken(request) {
  const headerToken = request.headers.get('X-MXQR-Capability') || '';
  if (headerToken) return headerToken.trim();
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function createCapabilityToken(scopes, request, env, method, anchor = null) {
  const secret = getCapabilitySecret(env);
  const ttl = parseCapabilityTtl(env);
  const now = Math.floor(Date.now() / 1000);
  // Tokens are base64url-encoded, not encrypted. Do not embed the minting
  // method because it would disclose the active verification path.
  void method;
  const payload = {
    v: 1,
    scopes,
    iat: anchor?.iat ?? now,
    exp: (anchor?.iat ?? now) + ttl,
    ip: await capabilityIpHash(secret, request),
    ...(anchor?.jti ? { jti: anchor.jti } : {}),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(secret, payloadPart);
  return {
    token: `${payloadPart}.${signature}`,
    expiresAt: payload.exp,
    scopes,
  };
}

async function verifyCapabilityToken(token, request, env, requiredScope) {
  const secret = getCapabilitySecret(env);
  if (!secret || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  const expectedSignature = await hmacSha256(secret, parts[0]);
  if (!constantTimeEqual(expectedSignature, parts[1])) return false;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return false;
  if (!Array.isArray(payload.scopes) || !payload.scopes.includes(requiredScope)) return false;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return false;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return false;

  const expectedIp = await capabilityIpHash(secret, request);
  return constantTimeEqual(String(payload.ip || ''), expectedIp);
}

function isValidRealtimeSessionId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= REALTIME_SESSION_ID_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

async function createRealtimeSessionCapability(sessionId, appId, appSecret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sid: sessionId,
    app: appId,
    iat: now,
    exp: now + REALTIME_SESSION_CAPABILITY_TTL,
    nonce: randomNonce(),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(appSecret, `realtime-session:${payloadPart}`);
  return `${payloadPart}.${signature}`;
}

async function verifyRealtimeSessionCapability(token, sessionId, appId, appSecret) {
  if (
    typeof token !== 'string' ||
    !token ||
    token.length > REALTIME_SESSION_CAPABILITY_MAX_LENGTH
  ) {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expectedSignature = await hmacSha256(appSecret, `realtime-session:${parts[0]}`);
  if (!constantTimeEqual(expectedSignature, parts[1])) return false;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    payload?.v === 1 &&
    constantTimeEqual(String(payload.sid || ''), sessionId) &&
    constantTimeEqual(String(payload.app || ''), appId) &&
    typeof payload.iat === 'number' &&
    payload.iat <= now + 60 &&
    typeof payload.exp === 'number' &&
    payload.exp > now &&
    payload.exp - payload.iat === REALTIME_SESSION_CAPABILITY_TTL &&
    typeof payload.nonce === 'string' &&
    payload.nonce.length > 0
  );
}

function getAdminPassword(env) {
  return String(env.MXQR_ADMIN_PASSWORD || env.ADMIN_PASSWORD || '').trim();
}

function getAdminSessionSecret(env) {
  return String(env.MXQR_ADMIN_SESSION_SECRET || env.ADMIN_SESSION_SECRET || '').trim();
}

function isAdminConfigured(env) {
  return !!(getAdminPassword(env) && getAdminSessionSecret(env));
}

function getAdminDb(env) {
  return env.MUSIXQUARE_ADMIN_DB || env.ADMIN_METRICS_DB || null;
}

async function verifyAdminPassword(password, env) {
  if (typeof password !== 'string' || !password) return false;
  const storedPassword = getAdminPassword(env);
  return !!storedPassword && constantTimeEqual(password, storedPassword);
}

function readCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function adminCookieHeader(token, request, maxAge = ADMIN_SESSION_TTL_SECONDS) {
  void request;
  return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAge}`;
}

function clearAdminCookieHeader(request) {
  return adminCookieHeader('', request, 0);
}

async function createAdminSessionToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  const payload = {
    v: 1,
    iat: now,
    exp: now + ADMIN_SESSION_TTL_SECONDS,
    nonce: bytesToBase64Url(random),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(getAdminSessionSecret(env), payloadPart);
  return `${payloadPart}.${signature}`;
}

async function verifyAdminSession(request, env) {
  if (!isAdminConfigured(env)) return false;
  const token = readCookies(request).get(ADMIN_SESSION_COOKIE) || '';
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expectedSignature = await hmacSha256(getAdminSessionSecret(env), parts[0]);
  if (!constantTimeEqual(expectedSignature, parts[1])) return false;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    payload?.v === 1 &&
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number' &&
    payload.iat <= now + 60 &&
    payload.exp > now
  );
}

function adminApiMethodAllowed(request, methods) {
  if (methods.includes(request.method)) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
      if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
        return json({ error: 'ADMIN_JSON_REQUIRED' }, 415);
      }
      const requestOrigin = new URL(request.url).origin;
      const origin = request.headers.get('Origin') || '';
      const fetchSite = String(request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
      const sameOrigin = origin === requestOrigin || (!origin && fetchSite === 'same-origin');
      if (!sameOrigin || request.headers.get('X-MXQR-Admin-CSRF') !== '1') {
        return json({ error: 'ADMIN_CSRF_REJECTED' }, 403);
      }
    }
    return null;
  }
  return json({ error: 'METHOD_NOT_ALLOWED' }, 405, {
    Allow: methods.join(', '),
  });
}

async function handleAdminLogin(request, env) {
  const methodError = adminApiMethodAllowed(request, ['POST', 'OPTIONS']);
  if (methodError) return methodError;
  if (request.method === 'OPTIONS') return withSecurityHeaders(new Response(null, { status: 204 }));
  if (!isAdminConfigured(env)) return json({ error: 'ADMIN_NOT_CONFIGURED' }, 503);
  if (!(await checkRateLimit(request, 'admin-login', 10, 60))) {
    return rateLimitResponse({});
  }

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!(await verifyAdminPassword(password, env))) {
    return json({ error: 'INVALID_PASSWORD' }, 401);
  }

  const token = await createAdminSessionToken(env);
  return json(
    {
      ok: true,
      expiresIn: ADMIN_SESSION_TTL_SECONDS,
    },
    200,
    {
      'Set-Cookie': adminCookieHeader(token, request),
    },
  );
}

async function handleAdminLogout(request, env) {
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  void env;
  return json({ ok: true }, 200, {
    'Set-Cookie': clearAdminCookieHeader(request),
  });
}

async function handleAdminSession(request, env) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  const authenticated = await verifyAdminSession(request, env);
  return json({
    authenticated,
    configured: isAdminConfigured(env),
    databaseConfigured: !!getAdminDb(env),
  });
}

const adminProRoomRegistryReadyByDb = new WeakMap();

function getProRoomAdminNamespace(env) {
  const namespace = env.PRO_ROOM_ADMIN_ROOMS;
  return namespace &&
    typeof namespace.idFromName === 'function' &&
    typeof namespace.get === 'function'
    ? namespace
    : null;
}

async function ensureAdminProRoomRegistry(db) {
  if (!db?.prepare) return false;
  const existing = adminProRoomRegistryReadyByDb.get(db);
  if (existing) return existing;
  const initialize = (async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_REGISTRY_TABLE} (
          room_code TEXT PRIMARY KEY NOT NULL,
          label TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'registered',
          activation_state TEXT NOT NULL DEFAULT 'unactivated',
          room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      )
      .run();
    const registryColumnStatement = db.prepare(
      `PRAGMA table_info(${ADMIN_PRO_ROOM_REGISTRY_TABLE})`,
    );
    const registryColumns =
      typeof registryColumnStatement.all === 'function'
        ? await registryColumnStatement.all()
        : { results: [] };
    if (
      !(registryColumns?.results || []).some(
        (column) => String(column?.name || '') === 'room_generation',
      )
    ) {
      try {
        await db
          .prepare(
            `ALTER TABLE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
             ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0
               CHECK (room_generation >= 0)`,
          )
          .run();
      } catch (error) {
        // Two freshly deployed isolates can observe the old schema before
        // either migration commits. The second ALTER is safe only when the
        // exact additive column already won that race.
        if (!/duplicate column name:\s*room_generation/i.test(String(error?.message || error))) {
          throw error;
        }
      }
    }
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE} (
          room_code TEXT NOT NULL,
          room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
          status TEXT NOT NULL CHECK (status = 'decommissioned'),
          decommissioned_at INTEGER NOT NULL,
          request_id TEXT,
          PRIMARY KEY (room_code, room_generation)
        )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE} (
          room_code TEXT NOT NULL,
          room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
          allocated_at INTEGER NOT NULL CHECK (allocated_at >= 0),
          PRIMARY KEY (room_code, room_generation)
        )`,
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
          (room_code, room_generation, allocated_at)
         SELECT room_code, room_generation, created_at
         FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}`,
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
          (room_code, room_generation, allocated_at)
         SELECT room_code, room_generation, decommissioned_at
         FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_allocations_no_update
         BEFORE UPDATE ON ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation allocation is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_allocations_no_delete
         BEFORE DELETE ON ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation allocation is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_no_update
         BEFORE UPDATE ON ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation history is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_requires_allocation
         BEFORE INSERT ON ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
         WHEN NOT EXISTS (
           SELECT 1
           FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
           WHERE room_code = NEW.room_code
             AND room_generation = NEW.room_generation
         )
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation allocation is missing');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_no_delete
         BEFORE DELETE ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room registry pointers are immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_room_code_immutable
         BEFORE UPDATE OF room_code ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NEW.room_code <> OLD.room_code
         BEGIN
           SELECT RAISE(ABORT, 'PRO room registry code is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_status_insert_guard
         BEFORE INSERT ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NEW.status NOT IN (
           'registered',
           'provisioning',
           'suspended',
           'decommissioning',
           'decommissioned'
         )
         BEGIN
           SELECT RAISE(ABORT, 'Invalid PRO room registry status');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_status_transition_guard
         BEFORE UPDATE OF status, room_generation ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NEW.status NOT IN (
             'registered',
             'provisioning',
             'suspended',
             'decommissioning',
             'decommissioned'
           )
           OR (
             NEW.room_generation = OLD.room_generation
             AND (
               (
                 OLD.status = 'decommissioning'
                 AND NEW.status NOT IN ('decommissioning', 'decommissioned')
               )
               OR (
                 OLD.status = 'decommissioned'
                 AND NEW.status <> 'decommissioned'
               )
             )
           )
           OR (
             NEW.room_generation = OLD.room_generation
             AND OLD.status <> 'decommissioned'
             AND NEW.status = 'decommissioned'
             AND (
               NOT EXISTS (
                 SELECT 1
                 FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
                 WHERE room_code = NEW.room_code
                   AND room_generation = NEW.room_generation
               )
               OR NOT EXISTS (
                 SELECT 1
                 FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
                 WHERE room_code = NEW.room_code
                   AND room_generation = NEW.room_generation
                   AND status = 'decommissioned'
               )
             )
           )
         BEGIN
           SELECT RAISE(
             ABORT,
             'Invalid PRO room registry status or terminal evidence transition'
           );
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_initial_generation_guard
         BEFORE INSERT ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NOT EXISTS (
             SELECT 1
             FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
             WHERE room_code = NEW.room_code
           )
           AND (
             NEW.room_generation <> ${INITIAL_PRO_ROOM_GENERATION}
             OR EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
               WHERE room_code = NEW.room_code
             )
             OR EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
               WHERE room_code = NEW.room_code
             )
           )
         BEGIN
           SELECT RAISE(ABORT, 'PRO room registry repair required');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_allocate_initial_generation
         AFTER INSERT ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         BEGIN
           INSERT INTO ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
             (room_code, room_generation, allocated_at)
           VALUES (NEW.room_code, NEW.room_generation, NEW.created_at);
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE} (
          contract_version INTEGER PRIMARY KEY CHECK (contract_version = 1),
          status TEXT NOT NULL CHECK (status IN ('disabled', 'ready')),
          release_sha TEXT,
          ever_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ever_enabled IN (0, 1)),
          floor_release_sha TEXT,
          updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
          CHECK (
            (status = 'disabled' AND release_sha IS NULL)
            OR (
              status = 'ready'
              AND ever_enabled = 1
              AND length(release_sha) = 40
              AND release_sha NOT GLOB '*[^0-9a-f]*'
            )
          ),
          CHECK (
            (ever_enabled = 0 AND floor_release_sha IS NULL)
            OR (
              ever_enabled = 1
              AND length(floor_release_sha) = 40
              AND floor_release_sha NOT GLOB '*[^0-9a-f]*'
            )
          )
        )`,
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
          (
            contract_version,
            status,
            release_sha,
            ever_enabled,
            floor_release_sha,
            updated_at
          )
         VALUES (
           ${ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION},
           'disabled',
           NULL,
           0,
           NULL,
           0
         )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_cutover_floor_immutable
         BEFORE UPDATE OF status, release_sha, ever_enabled, floor_release_sha
         ON ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
         WHEN (
             OLD.ever_enabled = 1
             AND (
               NEW.ever_enabled <> 1
               OR NEW.floor_release_sha IS NOT OLD.floor_release_sha
             )
           )
           OR (
             OLD.ever_enabled = 0
             AND NEW.ever_enabled = 1
             AND (
               NEW.status <> 'ready'
               OR NEW.release_sha IS NULL
               OR NEW.floor_release_sha IS NOT NEW.release_sha
               OR length(NEW.release_sha) <> 40
               OR NEW.release_sha GLOB '*[^0-9a-f]*'
             )
           )
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation rollback floor is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_cutover_no_delete
         BEFORE DELETE ON ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation cutover is permanent');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_allocate_next_generation
         BEFORE UPDATE OF room_generation ON ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         WHEN NEW.room_generation <> OLD.room_generation
         BEGIN
           SELECT CASE
             WHEN OLD.status <> 'decommissioned'
               OR NEW.status <> 'provisioning'
               OR NEW.room_generation <> OLD.room_generation + 1
               OR NEW.room_generation > ${MAX_PRO_ROOM_GENERATION}
             THEN RAISE(ABORT, 'Invalid PRO room generation transition')
           END;
           SELECT CASE
             WHEN NOT EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
               WHERE room_code = OLD.room_code
                 AND room_generation = OLD.room_generation
             )
             THEN RAISE(ABORT, 'PRO room current generation allocation is missing')
           END;
           SELECT CASE
             WHEN NOT EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
               WHERE room_code = OLD.room_code
                 AND room_generation = OLD.room_generation
                 AND status = 'decommissioned'
             )
             THEN RAISE(ABORT, 'PRO room generation history is missing')
           END;
           SELECT CASE
             WHEN NOT EXISTS (
               SELECT 1
               FROM ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
               WHERE contract_version = ${ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION}
                 AND status = 'ready'
                 AND ever_enabled = 1
                 AND length(release_sha) = 40
                 AND release_sha NOT GLOB '*[^0-9a-f]*'
                 AND length(floor_release_sha) = 40
                 AND floor_release_sha NOT GLOB '*[^0-9a-f]*'
             )
             THEN RAISE(ABORT, 'PRO room generation cutover is not ready')
           END;
           INSERT INTO ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
             (room_code, room_generation, allocated_at)
           VALUES (NEW.room_code, NEW.room_generation, NEW.created_at);
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_no_delete
         BEFORE DELETE ON ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
         BEGIN
           SELECT RAISE(ABORT, 'PRO room generation history is immutable');
         END`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${ADMIN_PRO_ROOM_AUDIT_TABLE} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id TEXT NOT NULL,
          action TEXT NOT NULL,
          result TEXT NOT NULL,
          room_code TEXT NOT NULL,
          room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0),
          created_at INTEGER NOT NULL
        )`,
      )
      .run();
    const auditColumnStatement = db.prepare(`PRAGMA table_info(${ADMIN_PRO_ROOM_AUDIT_TABLE})`);
    const auditColumns =
      typeof auditColumnStatement.all === 'function'
        ? await auditColumnStatement.all()
        : { results: [] };
    if (
      !(auditColumns?.results || []).some(
        (column) => String(column?.name || '') === 'room_generation',
      )
    ) {
      try {
        await db
          .prepare(
            `ALTER TABLE ${ADMIN_PRO_ROOM_AUDIT_TABLE}
             ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0
               CHECK (room_generation >= 0)`,
          )
          .run();
      } catch (error) {
        if (!/duplicate column name:\s*room_generation/i.test(String(error?.message || error))) {
          throw error;
        }
      }
    }
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_mxqr_pro_room_admin_audit_incarnation_created
         ON ${ADMIN_PRO_ROOM_AUDIT_TABLE}(room_code, room_generation, created_at)`,
      )
      .run();
    const nowMs = Date.now();
    for (const room of INITIAL_ADMIN_PRO_ROOMS) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
            (room_code, label, status, activation_state, room_generation, created_at, updated_at)
           VALUES (?1, ?2, 'registered', 'unactivated', ${INITIAL_PRO_ROOM_GENERATION}, ?3, ?3)`,
        )
        .bind(room.roomCode, room.label, nowMs)
        .run();
    }
    return true;
  })();
  adminProRoomRegistryReadyByDb.set(db, initialize);
  try {
    return await initialize;
  } catch (error) {
    adminProRoomRegistryReadyByDb.delete(db);
    throw error;
  }
}

function normalizeAdminProRoomRow(row) {
  if (!row || !ADMIN_PRO_ROOM_CODE_RE.test(row.room_code)) return null;
  const label = String(row.label || '').trim();
  const roomGeneration = Number(row.room_generation);
  const status = String(row.status || '');
  if (!label || label.length > ADMIN_PRO_ROOM_LABEL_MAX_LENGTH) return null;
  if (!isProRoomGeneration(roomGeneration)) return null;
  if (
    !['registered', 'provisioning', 'suspended', 'decommissioning', 'decommissioned'].includes(
      status,
    )
  ) {
    return null;
  }
  return {
    roomCode: row.room_code,
    roomGeneration,
    label,
    status,
    // Display-only index. Every privileged decision is re-authorized against
    // the cross-script Durable Object, which owns the canonical room status.
    activationState: row.activation_state === 'active' ? 'active' : 'unactivated',
    createdAt: Number.isSafeInteger(row.created_at) ? row.created_at : 0,
    updatedAt: Number.isSafeInteger(row.updated_at) ? row.updated_at : 0,
  };
}

function normalizeAdminProRoomLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  return label &&
    label.length <= ADMIN_PRO_ROOM_LABEL_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(label)
    ? label
    : null;
}

async function readAdminProRoom(db, roomCode) {
  await ensureAdminProRoomRegistry(db);
  const statement = db
    .prepare(
      `SELECT room_code, label, status, activation_state, created_at, updated_at
              , room_generation
       FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       WHERE room_code = ?1 LIMIT 1`,
    )
    .bind(roomCode);
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return normalizeAdminProRoomRow(row);
}

async function isAdminProRoomGenerationReuseReady(db) {
  if (!db?.prepare) return false;
  try {
    const statement = db
      .prepare(
        `SELECT status, release_sha, ever_enabled, floor_release_sha
         FROM ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE}
         WHERE contract_version = ?1
         LIMIT 1`,
      )
      .bind(ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION);
    const row =
      typeof statement.first === 'function'
        ? await statement.first()
        : (await statement.all())?.results?.[0] || null;
    return (
      row?.status === 'ready' &&
      Number(row.ever_enabled) === 1 &&
      RELEASE_SHA_RE.test(String(row.release_sha || '')) &&
      RELEASE_SHA_RE.test(String(row.floor_release_sha || ''))
    );
  } catch {
    // This row is written only after all three D1 migrations and every
    // generation-aware dependency Worker have been verified. Missing schema,
    // an unavailable database, or malformed evidence must never permit reuse.
    return false;
  }
}

async function readAdminProRoomAllocationEvidence(db, roomCode, roomGeneration = null) {
  if (!db?.prepare || !ADMIN_PRO_ROOM_CODE_RE.test(roomCode || '')) {
    throw new Error('INVALID_PRO_ROOM_ALLOCATION_LOOKUP');
  }
  const generationPredicate = roomGeneration === null ? '' : ' AND room_generation = ?2';
  const statement = db
    .prepare(
      `SELECT
         EXISTS (
           SELECT 1
           FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
           WHERE room_code = ?1${generationPredicate}
         ) AS has_allocation,
         EXISTS (
           SELECT 1
           FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
           WHERE room_code = ?1${generationPredicate}
         ) AS has_history`,
    )
    .bind(...(roomGeneration === null ? [roomCode] : [roomCode, roomGeneration]));
  const row =
    typeof statement.first === 'function'
      ? await statement.first()
      : (await statement.all())?.results?.[0] || null;
  return {
    hasAllocation: Number(row?.has_allocation) === 1,
    hasHistory: Number(row?.has_history) === 1,
  };
}

async function listAdminProRooms(db) {
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `SELECT room_code, label, status, activation_state, created_at, updated_at
              , room_generation
       FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       ORDER BY CASE WHEN status = 'decommissioned' THEN 1 ELSE 0 END ASC,
                room_code ASC
       LIMIT ?1`,
    )
    .bind(ADMIN_PRO_ROOM_REGISTRY_LIMIT)
    .all();
  return (result?.results || []).map(normalizeAdminProRoomRow).filter(Boolean);
}

async function registerAdminProRoom(db, roomCode, label, nowMs = Date.now()) {
  await ensureAdminProRoomRegistry(db);
  const before = await readAdminProRoom(db, roomCode);
  let created = false;
  let reused = false;
  let generationExhausted = false;
  let generationCutoverNotReady = false;
  let repairRequired = false;

  if (!before) {
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
          (room_code, label, status, activation_state, room_generation, created_at, updated_at)
         SELECT ?1, ?2, 'provisioning', 'unactivated',
                ${INITIAL_PRO_ROOM_GENERATION}, ?3, ?3
         WHERE (
           SELECT COUNT(*)
           FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
           WHERE status <> 'decommissioned'
         ) < ?4
           AND NOT EXISTS (
             SELECT 1
             FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE}
             WHERE room_code = ?1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
             WHERE room_code = ?1
           )`,
      )
      .bind(roomCode, label, nowMs, ADMIN_PRO_ROOM_REGISTRY_LIMIT)
      .run();
    created = Number(inserted?.meta?.changes || 0) === 1;
  } else if (before.status === 'decommissioned') {
    if (!(await isAdminProRoomGenerationReuseReady(db))) {
      generationCutoverNotReady = true;
    } else if (before.roomGeneration >= MAX_PRO_ROOM_GENERATION) {
      generationExhausted = true;
    } else {
      // Older deployments only kept the terminal row in the registry. Copy
      // that already-completed incarnation into the immutable history before
      // replacing the public room-code pointer. Newer room workers insert the
      // same row (including request_id) when their deletion saga completes.
      await db
        .prepare(
          `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
            (room_code, room_generation, status, decommissioned_at, request_id)
           SELECT room_code, room_generation, 'decommissioned', updated_at, NULL
           FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
           WHERE room_code = ?1
             AND room_generation = ?2
             AND status = 'decommissioned'`,
        )
        .bind(roomCode, before.roomGeneration)
        .run();
      const replaced = await db
        .prepare(
          `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
           SET label = ?2,
               status = 'provisioning',
               activation_state = 'unactivated',
               room_generation = room_generation + 1,
               created_at = ?3,
               updated_at = ?3
           WHERE room_code = ?1
             AND room_generation = ?4
             AND status = 'decommissioned'
             AND room_generation < ?5
             AND (
               SELECT COUNT(*)
               FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
               WHERE status <> 'decommissioned'
             ) < ?6
             AND EXISTS (
                SELECT 1
                FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE} AS history
                WHERE history.room_code = ?1
                  AND history.room_generation = ?4
                  AND history.status = 'decommissioned'
              )
              AND EXISTS (
                SELECT 1
                FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE} AS current_allocation
                WHERE current_allocation.room_code = ?1
                  AND current_allocation.room_generation = ?4
              )
              AND NOT EXISTS (
                SELECT 1
                FROM ${ADMIN_PRO_ROOM_GENERATION_ALLOCATION_TABLE} AS next_allocation
                WHERE next_allocation.room_code = ?1
                  AND next_allocation.room_generation = ?4 + 1
              )
              AND EXISTS (
                SELECT 1
                FROM ${ADMIN_PRO_ROOM_GENERATION_CUTOVER_TABLE} AS cutover
                WHERE cutover.contract_version = ${ADMIN_PRO_ROOM_GENERATION_CONTRACT_VERSION}
                  AND cutover.status = 'ready'
                  AND cutover.ever_enabled = 1
                  AND length(cutover.release_sha) = 40
                  AND cutover.release_sha NOT GLOB '*[^0-9a-f]*'
                  AND length(cutover.floor_release_sha) = 40
                  AND cutover.floor_release_sha NOT GLOB '*[^0-9a-f]*'
              )`,
        )
        .bind(
          roomCode,
          label,
          nowMs,
          before.roomGeneration,
          MAX_PRO_ROOM_GENERATION,
          ADMIN_PRO_ROOM_REGISTRY_LIMIT,
        )
        .run();
      reused = Number(replaced?.meta?.changes || 0) === 1;
      if (!reused && !(await isAdminProRoomGenerationReuseReady(db))) {
        generationCutoverNotReady = true;
      }
      created = reused;
    }
  }
  const room = await readAdminProRoom(db, roomCode);
  if (!room) {
    const evidence = await readAdminProRoomAllocationEvidence(db, roomCode);
    repairRequired = evidence.hasAllocation || evidence.hasHistory;
  } else if (
    before?.status === 'decommissioned' &&
    !reused &&
    !generationCutoverNotReady &&
    !generationExhausted &&
    room.roomGeneration === before.roomGeneration
  ) {
    const currentEvidence = await readAdminProRoomAllocationEvidence(
      db,
      roomCode,
      before.roomGeneration,
    );
    const nextEvidence = await readAdminProRoomAllocationEvidence(
      db,
      roomCode,
      before.roomGeneration + 1,
    );
    repairRequired =
      !currentEvidence.hasAllocation ||
      !currentEvidence.hasHistory ||
      nextEvidence.hasAllocation ||
      nextEvidence.hasHistory;
  }
  return {
    created,
    reused,
    generationExhausted,
    generationCutoverNotReady,
    repairRequired,
    capacityExceeded:
      (!room && !repairRequired) ||
      (before?.status === 'decommissioned' &&
        !reused &&
        !generationCutoverNotReady &&
        !generationExhausted &&
        !repairRequired &&
        room?.status === 'decommissioned' &&
        room?.roomGeneration === before.roomGeneration),
    room,
  };
}

async function markAdminProRoomRegistered(
  db,
  roomCode,
  roomGeneration,
  activationState,
  nowMs = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       SET status = 'registered', activation_state = ?3, updated_at = ?4
       WHERE room_code = ?1
         AND room_generation = ?2
         AND status NOT IN ('suspended', 'decommissioning', 'decommissioned')`,
    )
    .bind(roomCode, roomGeneration, activationState === 'active' ? 'active' : 'unactivated', nowMs)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function markAdminProRoomOperationalState(
  db,
  roomCode,
  roomGeneration,
  status,
  nowMs = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       SET status = ?3, activation_state = 'active', updated_at = ?4
       WHERE room_code = ?1
         AND room_generation = ?2
         AND status NOT IN ('decommissioning', 'decommissioned')`,
    )
    .bind(roomCode, roomGeneration, status === 'suspended' ? 'suspended' : 'registered', nowMs)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function reconcileAdminProRoomStatus(env, db, roomOrCode) {
  const room = typeof roomOrCode === 'string' ? await readAdminProRoom(db, roomOrCode) : roomOrCode;
  if (!room) return null;
  const { roomCode, roomGeneration } = room;
  const statusResult = await callProRoomAdminObject(
    env,
    roomCode,
    roomGeneration,
    '/internal/admin/status',
    'GET',
  );
  const payload = statusResult.payload;
  if (
    !statusResult.response?.ok ||
    !payload ||
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    payload.provisioned !== true ||
    !['unactivated', 'active', 'suspended'].includes(payload.status)
  ) {
    return null;
  }
  if (payload.status === 'suspended') {
    await ensureAdminProRoomRegistry(db);
    await db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         SET status = 'suspended', activation_state = 'active', updated_at = ?3
         WHERE room_code = ?1
           AND room_generation = ?2
           AND status NOT IN ('decommissioning', 'decommissioned')`,
      )
      .bind(roomCode, roomGeneration, Date.now())
      .run();
  } else {
    await markAdminProRoomRegistered(db, roomCode, roomGeneration, payload.status);
  }
  return payload.status;
}

async function reconcileStaleAdminProRoomActivations(env, db, rooms, nowMs = Date.now()) {
  if (!Array.isArray(rooms) || !getProRoomAdminNamespace(env)) return false;
  const candidates = rooms
    .filter(
      (room) =>
        room?.status === 'registered' &&
        room.activationState === 'unactivated' &&
        Number.isSafeInteger(room.updatedAt) &&
        room.updatedAt > 0 &&
        room.updatedAt <= nowMs - ADMIN_PRO_ROOM_ACTIVATION_RECONCILE_MIN_AGE_MS,
    )
    .sort(
      (left, right) =>
        left.updatedAt - right.updatedAt ||
        String(left.roomCode).localeCompare(String(right.roomCode)),
    )
    .slice(0, ADMIN_PRO_ROOM_ACTIVATION_RECONCILE_BATCH_SIZE);
  if (candidates.length === 0) return false;
  const results = await Promise.allSettled(
    candidates.map((room) => reconcileAdminProRoomStatus(env, db, room)),
  );
  return results.some(
    (result) =>
      result.status === 'fulfilled' && (result.value === 'active' || result.value === 'suspended'),
  );
}

export const reconcileStaleAdminProRoomActivationsForTests = reconcileStaleAdminProRoomActivations;

async function adminProRoomAuditActor(request, env) {
  const sessionToken = readCookies(request).get(ADMIN_SESSION_COOKIE) || '';
  const accessIdentity =
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('cf-access-jwt-assertion') ||
    '';
  return `admin_${(
    await hmacSha256(
      getAdminSessionSecret(env),
      `pro-room-audit\u0000${sessionToken}\u0000${accessIdentity}`,
    )
  ).slice(0, 32)}`;
}

async function appendAdminProRoomAudit(db, request, env, action, result, roomCode, roomGeneration) {
  if (!isProRoomGeneration(roomGeneration)) {
    throw new Error('Invalid PRO room generation for admin audit');
  }
  await ensureAdminProRoomRegistry(db);
  const actorId = await adminProRoomAuditActor(request, env);
  await db
    .prepare(
      `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
        (actor_id, action, result, room_code, room_generation, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(actorId, action, result, roomCode, roomGeneration, Date.now())
    .run();
}

async function writeAdminProRoomAuditOrFail(
  db,
  request,
  env,
  action,
  result,
  roomCode,
  roomGeneration,
) {
  try {
    await appendAdminProRoomAudit(db, request, env, action, result, roomCode, roomGeneration);
    return null;
  } catch {
    return json({ error: 'PRO_ROOM_AUDIT_UNAVAILABLE' }, 503);
  }
}

async function callProRoomAdminObject(
  env,
  roomCode,
  roomGeneration,
  pathname,
  method = 'POST',
  body = undefined,
) {
  const namespace = getProRoomAdminNamespace(env);
  if (!namespace || !isProRoomGeneration(roomGeneration)) {
    return { response: null, payload: null };
  }
  const stub = namespace.get(namespace.idFromName(proRoomObjectName(roomCode, roomGeneration)));
  const wireBody =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...body, roomGeneration } : body;
  let response;
  try {
    response = await stub.fetch(
      new Request(`https://pro-room.internal${pathname}`, {
        method,
        headers: {
          'x-mxqr-pro-room-code': roomCode,
          'x-mxqr-pro-room-generation': proRoomGenerationHeaderValue(roomGeneration),
          ...(wireBody === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(wireBody === undefined ? {} : { body: JSON.stringify(wireBody) }),
      }),
    );
  } catch {
    return { response: null, payload: null };
  }
  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  return { response, payload };
}

function proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !isProRoomGeneration(roomGeneration)
  ) {
    return false;
  }
  return payload.roomCode === roomCode && payload.roomGeneration === roomGeneration;
}

async function purgeProRoomAccountAuthority({ accountId, roomCode, roomGeneration }, env) {
  if (!isProRoomGeneration(roomGeneration)) return false;
  const result = await callProRoomAdminObject(
    env,
    roomCode,
    roomGeneration,
    '/internal/admin/account-authority/purge',
    'POST',
    { accountId },
  );
  return (
    result.response?.ok === true &&
    result.payload?.ok === true &&
    proRoomAdminResponseIdentityMatches(result.payload, roomCode, roomGeneration)
  );
}

function proRoomObjectError(result) {
  if (!result.response) return json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 502);
  if (!result.payload || typeof result.payload !== 'object' || Array.isArray(result.payload)) {
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }
  return json(result.payload, result.response.status);
}

async function markAdminProRoomDecommissioning(db, roomCode, roomGeneration, nowMs = Date.now()) {
  await ensureAdminProRoomRegistry(db);
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       SET status = 'decommissioning', activation_state = 'unactivated', updated_at = ?3
       WHERE room_code = ?1
         AND room_generation = ?2
         AND status NOT IN ('decommissioning', 'decommissioned')`,
    )
    .bind(roomCode, roomGeneration, nowMs)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function markAdminProRoomDecommissioned(
  db,
  roomCode,
  roomGeneration,
  requestId,
  nowMs = Date.now(),
) {
  await ensureAdminProRoomRegistry(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
        (room_code, room_generation, status, decommissioned_at, request_id)
       VALUES (?1, ?2, 'decommissioned', ?4, ?3)`,
    )
    .bind(roomCode, roomGeneration, requestId || null, nowMs)
    .run();
  const result = await db
    .prepare(
      `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
       SET label = 'Decommissioned PRO room', status = 'decommissioned',
           activation_state = 'unactivated', updated_at = ?3
       WHERE room_code = ?1 AND room_generation = ?2`,
    )
    .bind(roomCode, roomGeneration, nowMs)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function retireDecommissionedAccountProRoomEdges(env, { sinceMs = null } = {}) {
  const adminDb = getAdminDb(env);
  if (!adminDb?.prepare || !env.MUSIXQUARE_AUTH_DB?.prepare) {
    return { configured: false, retired: false };
  }
  const hasSince = Number.isSafeInteger(sinceMs) && sinceMs > 0;
  const statement = adminDb.prepare(
    `SELECT room_code, room_generation
         FROM (
           SELECT room_code, room_generation, decommissioned_at AS completed_at
             FROM ${ADMIN_PRO_ROOM_GENERATION_HISTORY_TABLE}
            WHERE status = 'decommissioned'
           UNION
           SELECT room_code, room_generation, updated_at AS completed_at
             FROM ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
            WHERE status = 'decommissioned'
         )
        ${hasSince ? 'WHERE completed_at >= ?1' : ''}
        ORDER BY completed_at DESC, room_code ASC, room_generation ASC
        LIMIT 5000`,
  );
  const bound = hasSince ? statement.bind(sinceMs) : statement;
  const result = await bound.all();
  const incarnations = (result?.results || [])
    .map((row) => ({
      roomCode: typeof row?.room_code === 'string' ? row.room_code : '',
      roomGeneration: Number(row?.room_generation),
    }))
    .filter(
      ({ roomCode, roomGeneration }) =>
        /^0\d{5}$/.test(roomCode) && isProRoomGeneration(roomGeneration),
    );
  return retireAccountProRoomLinkBatch(env, incarnations);
}

function isValidAdminActivationLink(payload, roomCode, roomGeneration) {
  const nowMs = Date.now();
  if (
    !payload ||
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    typeof payload.activationUrl !== 'string' ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= nowMs ||
    payload.expiresAt > nowMs + ADMIN_PRO_ROOM_ACTIVATION_CLAIM_MAX_TTL_MS + 5_000
  ) {
    return false;
  }
  try {
    const url = new URL(payload.activationUrl);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'musixquare.com' &&
      url.port === '' &&
      url.pathname === `/${roomCode}` &&
      url.search === '' &&
      url.hash.startsWith('#pro-claim=') &&
      url.hash.length > '#pro-claim='.length
    );
  } catch {
    return false;
  }
}

function isValidAdminOwnerRecoveryLink(payload, roomCode, roomGeneration) {
  const nowMs = Date.now();
  if (
    !payload ||
    !proRoomAdminResponseIdentityMatches(payload, roomCode, roomGeneration) ||
    typeof payload.recoveryUrl !== 'string' ||
    typeof payload.ownerAccountLinked !== 'boolean' ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= nowMs ||
    payload.expiresAt > nowMs + ADMIN_PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_TTL_MS + 5_000
  ) {
    return false;
  }
  try {
    const url = new URL(payload.recoveryUrl);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname === 'musixquare.com' &&
      url.port === '' &&
      url.pathname === `/${roomCode}` &&
      url.search === '' &&
      /^#pro-recovery=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url.hash)
    );
  } catch {
    return false;
  }
}

function getDeveloperApiAdminDb(env) {
  return env.DEVELOPER_API_DB?.prepare ? env.DEVELOPER_API_DB : null;
}

function developerApiAdminPepper(env) {
  const pepper = String(env.MXQR_DEVELOPER_API_KEY_PEPPER || '');
  return pepper.length >= 32 ? pepper : '';
}

function developerApiScopeNames(scopeMask) {
  if (
    !Number.isSafeInteger(scopeMask) ||
    scopeMask <= 0 ||
    scopeMask > ADMIN_DEVELOPER_API_KEY_ALL_SCOPE_BITS ||
    (scopeMask & ~ADMIN_DEVELOPER_API_KEY_ALL_SCOPE_BITS) !== 0
  ) {
    return null;
  }
  return Object.entries(ADMIN_DEVELOPER_API_KEY_SCOPES)
    .filter(([, bit]) => (scopeMask & bit) !== 0)
    .map(([scope]) => scope);
}

function developerApiKeyStatus(row, nowMs) {
  if (row.status === 'active') return row.expires_at <= nowMs ? 'expired' : 'active';
  return row.revoked_at === row.expires_at ? 'expired' : 'revoked';
}

function normalizeAdminDeveloperApiKeyRow(row, nowMs = Date.now(), expectedRoomGeneration = null) {
  const scopes = developerApiScopeNames(row?.scope_mask);
  const label = typeof row?.label === 'string' ? row.label : '';
  const roomGeneration = Number(row?.room_generation);
  if (
    !row ||
    !ADMIN_DEVELOPER_API_KEY_ID_RE.test(String(row.key_id || '')) ||
    !ADMIN_PRO_ROOM_CODE_RE.test(String(row.room_code || '')) ||
    !isProRoomGeneration(roomGeneration) ||
    (expectedRoomGeneration !== null && roomGeneration !== expectedRoomGeneration) ||
    !label ||
    label.length > 64 ||
    !scopes ||
    !['active', 'revoked'].includes(row.status) ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at < 0 ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < row.created_at ||
    !Number.isSafeInteger(row.expires_at) ||
    row.expires_at <= row.created_at ||
    (row.status === 'active' && row.revoked_at !== null) ||
    (row.status === 'revoked' &&
      (!Number.isSafeInteger(row.revoked_at) || row.revoked_at < row.created_at)) ||
    (row.last_used_hour !== null &&
      (!Number.isSafeInteger(row.last_used_hour) || row.last_used_hour < 0))
  ) {
    return null;
  }
  return {
    keyId: row.key_id,
    roomGeneration,
    label,
    scopes,
    status: developerApiKeyStatus(row, nowMs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_hour,
  };
}

async function cleanupExpiredAdminDeveloperApiKeys(db, roomCode, roomGeneration, nowMs) {
  await db
    .prepare(
      `UPDATE mxqr_developer_api_keys
       SET status = 'revoked',
           revoked_at = expires_at,
           updated_at = CASE
             WHEN updated_at > expires_at THEN updated_at
             ELSE expires_at
           END
       WHERE room_code = ?1 AND room_generation = ?2
         AND status = 'active' AND expires_at <= ?3`,
    )
    .bind(roomCode, roomGeneration, nowMs)
    .run();
}

async function listAdminDeveloperApiKeys(db, roomCode, roomGeneration, nowMs) {
  const result = await db
    .prepare(
      `SELECT key_id, room_code, room_generation, label, scope_mask, status,
              created_at, updated_at,
              expires_at, revoked_at, last_used_hour
       FROM mxqr_developer_api_keys
       WHERE room_code = ?1 AND room_generation = ?2
       ORDER BY created_at DESC
       LIMIT ?3`,
    )
    .bind(roomCode, roomGeneration, ADMIN_DEVELOPER_API_KEY_LIST_LIMIT)
    .all();
  return (result?.results || [])
    .map((row) => normalizeAdminDeveloperApiKeyRow(row, nowMs, roomGeneration))
    .filter(Boolean);
}

function adminDeveloperApiKeyListPayload(roomCode, roomGeneration, keys) {
  return {
    roomCode,
    roomGeneration,
    maxActiveKeys: ADMIN_DEVELOPER_API_KEY_MAX_ACTIVE,
    keys,
  };
}

function parseAdminDeveloperApiKeyIssueBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (
    !keys.includes('label') ||
    !keys.includes('scopes') ||
    !keys.includes('requestId') ||
    !keys.includes('roomGeneration') ||
    keys.some((key) => !['label', 'days', 'scopes', 'requestId', 'roomGeneration'].includes(key))
  ) {
    return null;
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const days = body.days === undefined ? ADMIN_DEVELOPER_API_KEY_DEFAULT_DAYS : body.days;
  const scopes = body.scopes;
  const requestId = typeof body.requestId === 'string' ? body.requestId.toLowerCase() : '';
  if (
    !label ||
    label.length > 64 ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(label) ||
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > ADMIN_DEVELOPER_API_KEY_MAX_DAYS ||
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > Object.keys(ADMIN_DEVELOPER_API_KEY_SCOPES).length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some(
      (scope) =>
        typeof scope !== 'string' ||
        !Object.prototype.hasOwnProperty.call(ADMIN_DEVELOPER_API_KEY_SCOPES, scope),
    ) ||
    !ADMIN_DEVELOPER_API_REQUEST_ID_RE.test(requestId) ||
    !isProRoomGeneration(body.roomGeneration)
  ) {
    return null;
  }
  return {
    label,
    days,
    scopes,
    requestId,
    roomGeneration: body.roomGeneration,
    scopeMask: scopes.reduce((mask, scope) => mask | ADMIN_DEVELOPER_API_KEY_SCOPES[scope], 0),
  };
}

async function deriveAdminDeveloperApiKeyMaterial(env, roomCode, roomGeneration, requestId) {
  const pepper = developerApiAdminPepper(env);
  const generationDomain = `${roomCode}\u0000${roomGeneration}`;
  const keyIdMaterial = await hmacSha256(
    pepper,
    `mxqr-developer-api-admin-issue-id:v2\u0000${generationDomain}\u0000${requestId}`,
  );
  const secret = await hmacSha256(
    pepper,
    `mxqr-developer-api-admin-issue-secret:v2\u0000${generationDomain}\u0000${requestId}`,
  );
  return { keyId: keyIdMaterial.slice(0, 16), secret };
}

async function readAdminDeveloperApiKey(db, roomCode, roomGeneration, keyId) {
  const statement = db
    .prepare(
      `SELECT key_id, room_code, room_generation, label, secret_digest,
              digest_version, scope_mask, status,
              created_at, updated_at, expires_at, revoked_at, last_used_hour
       FROM mxqr_developer_api_keys
       WHERE room_code = ?1 AND room_generation = ?2 AND key_id = ?3
       LIMIT 1`,
    )
    .bind(roomCode, roomGeneration, keyId);
  return typeof statement.first === 'function'
    ? await statement.first()
    : (await statement.all())?.results?.[0] || null;
}

function recoverAdminDeveloperApiKeyReplay(row, issue, digest, nowMs, roomGeneration) {
  const key = normalizeAdminDeveloperApiKeyRow(row, nowMs, roomGeneration);
  if (
    !key ||
    key.status !== 'active' ||
    !constantTimeEqual(String(row?.secret_digest || ''), digest) ||
    row?.digest_version !== 1 ||
    row?.label !== issue.label ||
    row?.scope_mask !== issue.scopeMask ||
    row?.expires_at - row?.created_at !== issue.days * ADMIN_DEVELOPER_API_DAY_MS
  ) {
    return null;
  }
  return key;
}

async function adminDeveloperApiAuditActor(request, env) {
  const sessionToken = readCookies(request).get(ADMIN_SESSION_COOKIE) || '';
  const accessIdentity =
    request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('cf-access-jwt-assertion') ||
    '';
  return `admin_${(
    await hmacSha256(
      getAdminSessionSecret(env),
      `developer-api-admin-audit\u0000${sessionToken}\u0000${accessIdentity}`,
    )
  ).slice(0, 32)}`;
}

function developerApiAdminAuditStatement(
  db,
  actorId,
  action,
  result,
  keyId,
  roomCode,
  roomGeneration,
  nowMs,
  { ignoreDuplicate = false } = {},
) {
  return db
    .prepare(
      `INSERT${ignoreDuplicate ? ' OR IGNORE' : ''} INTO mxqr_developer_api_admin_audit
        (actor_id, action, result, key_id, room_code, room_generation, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(actorId, action, result, keyId, roomCode, roomGeneration, nowMs);
}

function d1MutationChanged(result) {
  return Number(result?.meta?.changes || 0) === 1;
}

function developerApiAdminErrorChainIncludes(error, needle) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (
      String(current?.message || current)
        .toLowerCase()
        .includes(needle)
    )
      return true;
    current = current?.cause;
  }
  return false;
}

function isDeveloperApiActiveKeyLimitError(error) {
  return developerApiAdminErrorChainIncludes(error, 'developer_api_active_key_limit');
}

function isDeveloperApiAuditError(error) {
  return (
    error?.developerApiAuditFailure === true ||
    developerApiAdminErrorChainIncludes(error, 'admin audit') ||
    developerApiAdminErrorChainIncludes(error, 'admin_audit') ||
    developerApiAdminErrorChainIncludes(error, 'audit unavailable')
  );
}

async function runDeveloperApiAdminMutation(db, mutation, audit, cleanupOnAuditFailure) {
  if (typeof db.batch === 'function') {
    const results = await db.batch([mutation, audit]);
    if (!Array.isArray(results) || results.length !== 2 || !d1MutationChanged(results[0])) {
      throw new Error('Developer API key mutation was not confirmed');
    }
    if (!d1MutationChanged(results[1])) {
      throw new Error('Developer API admin audit was not confirmed');
    }
    return;
  }

  const mutationResult = await mutation.run();
  if (!d1MutationChanged(mutationResult)) {
    throw new Error('Developer API key mutation was not confirmed');
  }
  try {
    const auditResult = await audit.run();
    if (!d1MutationChanged(auditResult)) {
      throw new Error('Developer API admin audit was not confirmed');
    }
  } catch (error) {
    await cleanupOnAuditFailure?.().catch(() => {});
    const wrapped = new Error('Developer API admin audit unavailable');
    wrapped.cause = error;
    wrapped.developerApiAuditFailure = true;
    throw wrapped;
  }
}

async function handleAdminDeveloperApiKeys(request, env, pathname) {
  const route = pathname.match(ADMIN_DEVELOPER_API_KEY_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const roomCode = route[1];
  const keyId = route[2] || '';
  const methodError = adminApiMethodAllowed(request, keyId ? ['DELETE'] : ['GET', 'HEAD', 'POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const adminDb = getAdminDb(env);
  const developerDb = getDeveloperApiAdminDb(env);
  if (!adminDb?.prepare || !developerDb) {
    return json({ error: 'DEVELOPER_API_ADMIN_NOT_CONFIGURED' }, 503);
  }

  let room;
  try {
    room = await readAdminProRoom(adminDb, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }

  const nowMs = Date.now();
  try {
    await cleanupExpiredAdminDeveloperApiKeys(developerDb, roomCode, room.roomGeneration, nowMs);
  } catch {
    return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
  }

  if (!keyId && (request.method === 'GET' || request.method === 'HEAD')) {
    try {
      if (request.method === 'HEAD') {
        return withSecurityHeaders(new Response(null, { status: 200 }), {
          'Cache-Control': 'no-store, max-age=0',
        });
      }
      const keys = await listAdminDeveloperApiKeys(
        developerDb,
        roomCode,
        room.roomGeneration,
        nowMs,
      );
      return json(adminDeveloperApiKeyListPayload(roomCode, room.roomGeneration, keys));
    } catch {
      return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
    }
  }

  if (!keyId) {
    if (!developerApiAdminPepper(env)) {
      return json({ error: 'DEVELOPER_API_ADMIN_NOT_CONFIGURED' }, 503);
    }
    const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
    if (parsedBody.error) return jsonBodyError(parsedBody);
    const issue = parseAdminDeveloperApiKeyIssueBody(parsedBody.value);
    if (!issue) return json({ error: 'INVALID_REQUEST' }, 400);
    if (issue.roomGeneration !== room.roomGeneration) {
      return json({ error: 'PRO_ROOM_GENERATION_CONFLICT' }, 409);
    }

    const { keyId: newKeyId, secret } = await deriveAdminDeveloperApiKeyMaterial(
      env,
      roomCode,
      room.roomGeneration,
      issue.requestId,
    );
    if (
      !ADMIN_DEVELOPER_API_KEY_ID_RE.test(newKeyId) ||
      !ADMIN_DEVELOPER_API_KEY_SECRET_RE.test(secret)
    ) {
      return json({ error: 'DEVELOPER_API_KEY_GENERATION_FAILED' }, 503);
    }
    const digest = await hmacSha256(
      developerApiAdminPepper(env),
      `mxqr-developer-api-key:v1\u0000${newKeyId}\u0000${secret}`,
    );
    let replayed;
    try {
      replayed = await readAdminDeveloperApiKey(
        developerDb,
        roomCode,
        room.roomGeneration,
        newKeyId,
      );
    } catch {
      return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
    }
    if (replayed) {
      const replayedKey = recoverAdminDeveloperApiKeyReplay(
        replayed,
        issue,
        digest,
        nowMs,
        room.roomGeneration,
      );
      if (!replayedKey) {
        return json({ error: 'DEVELOPER_API_IDEMPOTENCY_CONFLICT' }, 409);
      }
      return json({
        roomCode,
        roomGeneration: room.roomGeneration,
        apiKey: `mxqr_live_${newKeyId}.${secret}`,
        key: replayedKey,
      });
    }

    const canonicalStatus = await reconcileAdminProRoomStatus(env, adminDb, room).catch(() => null);
    if (!canonicalStatus) {
      return json({ error: 'PRO_ROOM_ADMIN_UNAVAILABLE' }, 502);
    }
    if (canonicalStatus !== 'active') {
      return json(
        {
          error: canonicalStatus === 'suspended' ? 'PRO_ROOM_SUSPENDED' : 'PRO_ROOM_NOT_READY',
        },
        409,
      );
    }

    const expiresAt = nowMs + issue.days * ADMIN_DEVELOPER_API_DAY_MS;
    const mutation = developerDb
      .prepare(
        `INSERT INTO mxqr_developer_api_keys
          (key_id, room_code, room_generation, label, secret_digest,
           digest_version, scope_mask, status, created_at, updated_at,
           expires_at, revoked_at, last_used_hour)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'active', ?7, ?7, ?8, NULL, NULL)`,
      )
      .bind(
        newKeyId,
        roomCode,
        room.roomGeneration,
        issue.label,
        digest,
        issue.scopeMask,
        nowMs,
        expiresAt,
      );
    const actorId = await adminDeveloperApiAuditActor(request, env);
    const audit = developerApiAdminAuditStatement(
      developerDb,
      actorId,
      'key.issue',
      'issued',
      newKeyId,
      roomCode,
      room.roomGeneration,
      nowMs,
    );
    try {
      await runDeveloperApiAdminMutation(developerDb, mutation, audit, async () => {
        await developerDb
          .prepare(
            `DELETE FROM mxqr_developer_api_keys
             WHERE key_id = ?1 AND room_code = ?2 AND room_generation = ?3
               AND secret_digest = ?4`,
          )
          .bind(newKeyId, roomCode, room.roomGeneration, digest)
          .run();
      });
    } catch (error) {
      try {
        const concurrent = await readAdminDeveloperApiKey(
          developerDb,
          roomCode,
          room.roomGeneration,
          newKeyId,
        );
        if (concurrent) {
          const concurrentKey = recoverAdminDeveloperApiKeyReplay(
            concurrent,
            issue,
            digest,
            Date.now(),
            room.roomGeneration,
          );
          if (!concurrentKey) {
            return json({ error: 'DEVELOPER_API_IDEMPOTENCY_CONFLICT' }, 409);
          }
          return json({
            roomCode,
            roomGeneration: room.roomGeneration,
            apiKey: `mxqr_live_${newKeyId}.${secret}`,
            key: concurrentKey,
          });
        }
      } catch {
        // Fall through to the original mutation failure classification.
      }
      if (isDeveloperApiActiveKeyLimitError(error)) {
        return json({ error: 'DEVELOPER_API_ACTIVE_KEY_LIMIT' }, 409);
      }
      return json(
        {
          error: isDeveloperApiAuditError(error)
            ? 'DEVELOPER_API_AUDIT_UNAVAILABLE'
            : 'DEVELOPER_API_ADMIN_UNAVAILABLE',
        },
        503,
      );
    }

    const key = normalizeAdminDeveloperApiKeyRow(
      {
        key_id: newKeyId,
        room_code: roomCode,
        room_generation: room.roomGeneration,
        label: issue.label,
        scope_mask: issue.scopeMask,
        status: 'active',
        created_at: nowMs,
        updated_at: nowMs,
        expires_at: expiresAt,
        revoked_at: null,
        last_used_hour: null,
      },
      nowMs,
      room.roomGeneration,
    );
    return json(
      {
        roomCode,
        roomGeneration: room.roomGeneration,
        apiKey: `mxqr_live_${newKeyId}.${secret}`,
        key,
      },
      201,
    );
  }

  const parsedDeleteBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedDeleteBody.error) return jsonBodyError(parsedDeleteBody);
  if (
    !parsedDeleteBody.value ||
    typeof parsedDeleteBody.value !== 'object' ||
    Array.isArray(parsedDeleteBody.value) ||
    Object.keys(parsedDeleteBody.value).length !== 1 ||
    !isProRoomGeneration(parsedDeleteBody.value.roomGeneration)
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }
  if (parsedDeleteBody.value.roomGeneration !== room.roomGeneration) {
    return json({ error: 'PRO_ROOM_GENERATION_CONFLICT' }, 409);
  }

  let existing;
  try {
    existing = await readAdminDeveloperApiKey(developerDb, roomCode, room.roomGeneration, keyId);
  } catch {
    return json({ error: 'DEVELOPER_API_ADMIN_UNAVAILABLE' }, 503);
  }
  if (!existing) return json({ error: 'DEVELOPER_API_KEY_NOT_FOUND' }, 404);
  if (existing.status !== 'active' || existing.expires_at <= nowMs) {
    return json({
      ok: true,
      roomCode,
      roomGeneration: room.roomGeneration,
      keyId,
    });
  }

  const mutation = developerDb
    .prepare(
      `UPDATE mxqr_developer_api_keys
       SET status = 'revoked', revoked_at = ?4, updated_at = ?4
       WHERE room_code = ?1 AND room_generation = ?2 AND key_id = ?3
         AND status = 'active' AND expires_at > ?4`,
    )
    .bind(roomCode, room.roomGeneration, keyId, nowMs);
  const actorId = await adminDeveloperApiAuditActor(request, env);
  const audit = developerApiAdminAuditStatement(
    developerDb,
    actorId,
    'key.revoke',
    'revoked',
    keyId,
    roomCode,
    room.roomGeneration,
    nowMs,
    { ignoreDuplicate: true },
  );
  try {
    await runDeveloperApiAdminMutation(developerDb, mutation, audit, async () => {
      await developerDb
        .prepare(
          `UPDATE mxqr_developer_api_keys
           SET status = 'active', revoked_at = NULL, updated_at = ?4
           WHERE room_code = ?1 AND room_generation = ?2 AND key_id = ?3
             AND status = 'revoked' AND revoked_at = ?4`,
        )
        .bind(roomCode, room.roomGeneration, keyId, nowMs)
        .run();
    });
  } catch (error) {
    try {
      const current = await readAdminDeveloperApiKey(
        developerDb,
        roomCode,
        room.roomGeneration,
        keyId,
      );
      if (current && (current.status !== 'active' || current.expires_at <= nowMs)) {
        return json({
          ok: true,
          roomCode,
          roomGeneration: room.roomGeneration,
          keyId,
        });
      }
    } catch {
      // Preserve the original failure below when reconciliation is unavailable.
    }
    return json(
      {
        error: isDeveloperApiAuditError(error)
          ? 'DEVELOPER_API_AUDIT_UNAVAILABLE'
          : 'DEVELOPER_API_ADMIN_UNAVAILABLE',
      },
      503,
    );
  }
  return json({
    ok: true,
    roomCode,
    roomGeneration: room.roomGeneration,
    keyId,
  });
}

async function handleAdminProRooms(request, env, pathname) {
  const route = pathname.match(ADMIN_PRO_ROOM_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const activationClaimRoomCode = route[1] || '';
  const allowedMethods = activationClaimRoomCode ? ['POST'] : ['GET', 'HEAD', 'POST'];
  const methodError = adminApiMethodAllowed(request, allowedMethods);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_ADMIN_NOT_CONFIGURED' }, 503);
  }

  if (!activationClaimRoomCode && (request.method === 'GET' || request.method === 'HEAD')) {
    try {
      let rooms = await listAdminProRooms(db);
      // HEAD is a non-mutating availability probe. Only an operator's full
      // list read may repair the D1 projection from canonical room state.
      if (
        request.method === 'GET' &&
        (await reconcileStaleAdminProRoomActivations(env, db, rooms))
      ) {
        rooms = await listAdminProRooms(db);
      }
      if (request.method === 'HEAD') {
        return withSecurityHeaders(new Response(null, { status: 200 }), {
          'Cache-Control': 'no-store, max-age=0',
        });
      }
      return json({ generatedAt: new Date().toISOString(), rooms });
    } catch {
      return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
    }
  }

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;

  if (!activationClaimRoomCode) {
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !keys.includes('roomCode') ||
      keys.some((key) => key !== 'roomCode' && key !== 'label')
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    const roomCode = body.roomCode;
    const rawLabel = body.label === undefined ? `PRO Room ${roomCode}` : body.label;
    const label = normalizeAdminProRoomLabel(rawLabel);
    if (!ADMIN_PRO_ROOM_CODE_RE.test(roomCode) || !label) {
      return json({ error: 'INVALID_PRO_ROOM' }, 400);
    }

    try {
      const registered = await registerAdminProRoom(db, roomCode, label);
      if (registered.generationCutoverNotReady) {
        const auditError = await writeAdminProRoomAuditOrFail(
          db,
          request,
          env,
          'room.register',
          'generation_cutover_not_ready',
          roomCode,
          registered.room?.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION,
        );
        if (auditError) return auditError;
        return json({ error: 'PRO_ROOM_GENERATION_CUTOVER_NOT_READY' }, 503);
      }
      if (registered.repairRequired) {
        const auditError = await writeAdminProRoomAuditOrFail(
          db,
          request,
          env,
          'room.register',
          'registry_repair_required',
          roomCode,
          registered.room?.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION,
        );
        if (auditError) return auditError;
        return json({ error: 'PRO_ROOM_REGISTRY_REPAIR_REQUIRED' }, 409);
      }
      if (registered.capacityExceeded) {
        const auditError = await writeAdminProRoomAuditOrFail(
          db,
          request,
          env,
          'room.register',
          'registry_capacity_reached',
          roomCode,
          registered.room?.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION,
        );
        if (auditError) return auditError;
        return json({ error: 'PRO_ROOM_REGISTRY_CAPACITY_REACHED' }, 409);
      }
      if (registered.generationExhausted) {
        return json({ error: 'PRO_ROOM_GENERATION_EXHAUSTED' }, 409);
      }
      if (registered.room?.status === 'decommissioning') {
        return json({ error: 'PRO_ROOM_DECOMMISSION_IN_PROGRESS' }, 409);
      }
      if (!registered.room || registered.room.status === 'decommissioned') {
        return json({ error: 'PRO_ROOM_REGISTRATION_CONFLICT' }, 409);
      }
      const previousStatus = registered.room?.status || 'provisioning';
      const roomGeneration = registered.room.roomGeneration;
      const provisioned = await callProRoomAdminObject(
        env,
        roomCode,
        roomGeneration,
        '/internal/admin/provision',
      );
      const validProvisionResponse =
        provisioned.payload?.ok === true &&
        proRoomAdminResponseIdentityMatches(provisioned.payload, roomCode, roomGeneration) &&
        ['unactivated', 'active', 'suspended'].includes(provisioned.payload?.status);
      if (!provisioned.response?.ok || !validProvisionResponse) {
        const auditError = await writeAdminProRoomAuditOrFail(
          db,
          request,
          env,
          'room.register',
          'provision_failed',
          roomCode,
          roomGeneration,
        );
        if (auditError) return auditError;
        return provisioned.response?.ok
          ? json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502)
          : proRoomObjectError(provisioned);
      }
      await markAdminProRoomRegistered(db, roomCode, roomGeneration, provisioned.payload.status);
      const room = (await readAdminProRoom(db, roomCode)) || registered.room;
      if (
        room.roomGeneration !== roomGeneration ||
        room.status === 'decommissioning' ||
        room.status === 'decommissioned'
      ) {
        return json({ error: 'PRO_ROOM_REGISTRATION_CONFLICT' }, 409);
      }
      const auditError = await writeAdminProRoomAuditOrFail(
        db,
        request,
        env,
        'room.register',
        registered.created
          ? registered.reused
            ? 'recreated'
            : 'created'
          : previousStatus === 'provisioning'
            ? 'provisioning_recovered'
            : 'already_registered',
        roomCode,
        roomGeneration,
      );
      if (auditError) return auditError;
      return json({ room }, registered.created ? 201 : 200);
    } catch {
      return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
    }
  }

  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !isProRoomGeneration(body.roomGeneration)
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'invalid_request',
      activationClaimRoomCode,
      isProRoomGeneration(body?.roomGeneration) ? body.roomGeneration : INITIAL_PRO_ROOM_GENERATION,
    );
    if (auditError) return auditError;
    return json({ error: 'INVALID_REQUEST' }, 400);
  }
  let room;
  try {
    room = await readAdminProRoom(db, activationClaimRoomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'room_not_found',
      activationClaimRoomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'generation_mismatch',
      activationClaimRoomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (room.status === 'provisioning') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'provisioning_incomplete',
      activationClaimRoomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' }, 409);
  }
  if (room.status !== 'registered') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'room_suspended',
      activationClaimRoomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }

  const issued = await callProRoomAdminObject(
    env,
    activationClaimRoomCode,
    room.roomGeneration,
    '/internal/admin/activation-claim',
  );
  if (!issued.response?.ok) {
    await reconcileAdminProRoomStatus(env, db, room).catch(() => {});
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      issued.response ? 'service_rejected' : 'service_unavailable',
      activationClaimRoomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return proRoomObjectError(issued);
  }
  if (!isValidAdminActivationLink(issued.payload, activationClaimRoomCode, room.roomGeneration)) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'activation_claim.issue',
      'invalid_service_response',
      activationClaimRoomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }
  const auditError = await writeAdminProRoomAuditOrFail(
    db,
    request,
    env,
    'activation_claim.issue',
    'issued',
    activationClaimRoomCode,
    room.roomGeneration,
  );
  // The DO has already rotated and persisted the claim generation. If D1
  // auditing fails, discard this credential; the next retry rotates again so
  // no unaudited link can subsequently be used.
  if (auditError) return auditError;
  return json({
    ...issued.payload,
    roomCode: activationClaimRoomCode,
    roomGeneration: room.roomGeneration,
  });
}

async function handleAdminProRoomOwnerRecoveryClaim(request, env, pathname) {
  const route = pathname.match(ADMIN_PRO_ROOM_OWNER_RECOVERY_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const roomCode = route[1];
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_ADMIN_NOT_CONFIGURED' }, 503);
  }

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !isProRoomGeneration(body.roomGeneration)
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'invalid_request',
      roomCode,
      isProRoomGeneration(body?.roomGeneration) ? body.roomGeneration : INITIAL_PRO_ROOM_GENERATION,
    );
    if (auditError) return auditError;
    return json({ error: 'INVALID_REQUEST' }, 400);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'room_not_found',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (
    room.status === 'registered' &&
    room.activationState !== 'active' &&
    (await reconcileAdminProRoomStatus(env, db, room).catch(() => null)) === 'active'
  ) {
    room = (await readAdminProRoom(db, roomCode).catch(() => null)) || room;
  }
  if (room.status !== 'registered' || room.activationState !== 'active') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      room.status === 'suspended' ? 'room_suspended' : 'room_not_active',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE' }, 409);
  }

  const issued = await callProRoomAdminObject(
    env,
    roomCode,
    room.roomGeneration,
    '/internal/admin/owner-recovery-claim',
  );
  if (!issued.response?.ok) {
    await reconcileAdminProRoomStatus(env, db, room).catch(() => {});
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      issued.response ? 'service_rejected' : 'service_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return proRoomObjectError(issued);
  }
  if (!isValidAdminOwnerRecoveryLink(issued.payload, roomCode, room.roomGeneration)) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'invalid_service_response',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }
  const currentRoom = await readAdminProRoom(db, roomCode).catch(() => null);
  if (
    !currentRoom ||
    currentRoom.roomGeneration !== room.roomGeneration ||
    currentRoom.status !== 'registered' ||
    currentRoom.activationState !== 'active'
  ) {
    const staleAuditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'owner_recovery_claim.issue',
      'registry_changed',
      roomCode,
      room.roomGeneration,
    );
    if (staleAuditError) return staleAuditError;
    return json({ error: 'PRO_ROOM_OWNER_RECOVERY_UNAVAILABLE' }, 409);
  }
  const auditError = await writeAdminProRoomAuditOrFail(
    db,
    request,
    env,
    'owner_recovery_claim.issue',
    'issued',
    roomCode,
    room.roomGeneration,
  );
  // Recovery URLs are bearer credentials. If the audit write cannot be
  // confirmed, discard the response and never expose the URL to the browser.
  if (auditError) return auditError;
  return json({
    roomCode,
    roomGeneration: room.roomGeneration,
    recoveryUrl: issued.payload.recoveryUrl,
    expiresAt: issued.payload.expiresAt,
    ownerAccountLinked: issued.payload.ownerAccountLinked,
  });
}

async function handleAdminProRoomState(request, env, pathname) {
  const route = pathname.match(ADMIN_PRO_ROOM_STATE_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_ADMIN_NOT_CONFIGURED' }, 503);
  }

  const roomCode = route[1];
  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const targetStatus = body?.status;
  if (
    keys.length !== 2 ||
    !keys.includes('roomGeneration') ||
    !keys.includes('status') ||
    !isProRoomGeneration(body.roomGeneration) ||
    (targetStatus !== 'active' && targetStatus !== 'suspended')
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      targetStatus === 'suspended' ? 'room.suspend' : 'room.resume',
      'room_not_found',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  }
  if (room.roomGeneration !== body.roomGeneration) {
    const action = targetStatus === 'suspended' ? 'room.suspend' : 'room.resume';
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      action,
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (room.status === 'provisioning') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      targetStatus === 'suspended' ? 'room.suspend' : 'room.resume',
      'provisioning_incomplete',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' }, 409);
  }

  const action = targetStatus === 'suspended' ? 'room.suspend' : 'room.resume';
  const internalPath =
    targetStatus === 'suspended' ? '/internal/admin/suspend' : '/internal/admin/resume';
  const changed = await callProRoomAdminObject(env, roomCode, room.roomGeneration, internalPath);
  const payload = changed.payload;
  if (!changed.response?.ok) {
    await reconcileAdminProRoomStatus(env, db, room).catch(() => {});
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      action,
      changed.response ? 'service_rejected' : 'service_unavailable',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return proRoomObjectError(changed);
  }
  if (
    !payload ||
    payload.ok !== true ||
    !proRoomAdminResponseIdentityMatches(payload, roomCode, room.roomGeneration) ||
    payload.status !== targetStatus ||
    typeof payload.changed !== 'boolean'
  ) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      action,
      'invalid_service_response',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_ADMIN_INVALID_RESPONSE' }, 502);
  }

  try {
    const updated = await markAdminProRoomOperationalState(
      db,
      roomCode,
      room.roomGeneration,
      targetStatus,
    );
    if (!updated) return json({ error: 'PRO_ROOM_STATE_CONFLICT' }, 409);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  const auditError = await writeAdminProRoomAuditOrFail(
    db,
    request,
    env,
    action,
    payload.changed ? 'changed' : 'already_applied',
    roomCode,
    room.roomGeneration,
  );
  if (auditError) return auditError;
  return json({
    ok: true,
    roomCode,
    roomGeneration: room.roomGeneration,
    status: targetStatus,
    changed: payload.changed,
  });
}

async function handleAdminProRoomLabel(request, env, pathname) {
  const route = pathname.match(ADMIN_PRO_ROOM_LABEL_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || typeof db.batch !== 'function') {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  const roomCode = route[1];
  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  const label = normalizeAdminProRoomLabel(body?.label);
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(body, 'roomGeneration') ||
    !Object.prototype.hasOwnProperty.call(body, 'label') ||
    !isProRoomGeneration(body.roomGeneration) ||
    !label
  ) {
    return json({ error: 'INVALID_REQUEST' }, 400);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.label.update',
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (room.status === 'decommissioning' || room.status === 'decommissioned') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.label.update',
      'room_closed',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (room.status === 'provisioning') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.label.update',
      'provisioning_incomplete',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' }, 409);
  }
  if (room.label === label) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.label.update',
      'already_applied',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
    return json({
      ok: true,
      roomCode,
      roomGeneration: room.roomGeneration,
      label,
      changed: false,
    });
  }

  const nowMs = Date.now();
  let actorId;
  try {
    actorId = await adminProRoomAuditActor(request, env);
    const audit = db
      .prepare(
        `INSERT INTO ${ADMIN_PRO_ROOM_AUDIT_TABLE}
          (actor_id, action, result, room_code, room_generation, created_at)
         VALUES (?1, 'room.label.update', 'authorized', ?2, ?3, ?4)`,
      )
      .bind(actorId, roomCode, room.roomGeneration, nowMs);
    const mutation = db
      .prepare(
        `UPDATE ${ADMIN_PRO_ROOM_REGISTRY_TABLE}
         SET label = ?4, updated_at = ?5
         WHERE room_code = ?1
           AND room_generation = ?2
           AND label = ?3
           AND status IN ('registered', 'suspended')`,
      )
      .bind(roomCode, room.roomGeneration, room.label, label, nowMs);
    const results = await db.batch([audit, mutation]);
    if (!Array.isArray(results) || !d1MutationChanged(results[0])) {
      throw new Error('PRO room label audit was not confirmed');
    }
    if (d1MutationChanged(results[1])) {
      return json({
        ok: true,
        roomCode,
        roomGeneration: room.roomGeneration,
        label,
        changed: true,
      });
    }
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }

  let current;
  try {
    current = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!current) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (current.roomGeneration !== room.roomGeneration) {
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }
  if (current.status === 'decommissioning' || current.status === 'decommissioned') {
    return json({ error: 'PRO_ROOM_PERMANENTLY_DECOMMISSIONED' }, 410);
  }
  if (current.status === 'provisioning') {
    return json({ error: 'PRO_ROOM_PROVISIONING_INCOMPLETE' }, 409);
  }
  if (current.label === label) {
    return json({
      ok: true,
      roomCode,
      roomGeneration: current.roomGeneration,
      label,
      changed: false,
    });
  }
  return json({ error: 'PRO_ROOM_LABEL_CONFLICT' }, 409);
}

async function handleAdminProRoomDelete(request, env, pathname) {
  const route = pathname.match(ADMIN_PRO_ROOM_DELETE_PATH_RE);
  if (!route) return json({ error: 'NOT_FOUND' }, 404);
  const methodError = adminApiMethodAllowed(request, ['DELETE']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const db = getAdminDb(env);
  if (!db?.prepare || !getProRoomAdminNamespace(env)) {
    return json({ error: 'PRO_ROOM_DECOMMISSION_NOT_CONFIGURED' }, 503);
  }

  const roomCode = route[1];
  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 3 ||
    body.confirmRoomCode !== roomCode ||
    !isProRoomGeneration(body.roomGeneration) ||
    !ADMIN_DEVELOPER_API_REQUEST_ID_RE.test(body.requestId || '')
  ) {
    return json({ error: 'PRO_ROOM_DELETE_CONFIRMATION_MISMATCH' }, 400);
  }

  let room;
  try {
    room = await readAdminProRoom(db, roomCode);
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  if (!room) return json({ error: 'PRO_ROOM_NOT_FOUND' }, 404);
  if (room.roomGeneration !== body.roomGeneration) {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.delete',
      'generation_mismatch',
      roomCode,
      body.roomGeneration,
    );
    if (auditError) return auditError;
    return json({ error: 'PRO_ROOM_GENERATION_MISMATCH' }, 409);
  }

  if (room.status !== 'decommissioning' && room.status !== 'decommissioned') {
    const auditError = await writeAdminProRoomAuditOrFail(
      db,
      request,
      env,
      'room.delete',
      'authorized',
      roomCode,
      room.roomGeneration,
    );
    if (auditError) return auditError;
  }
  const decommissioned = await callProRoomAdminObject(
    env,
    roomCode,
    room.roomGeneration,
    '/internal/admin/decommission',
    'POST',
    { roomCode, roomGeneration: room.roomGeneration, requestId: body.requestId },
  );
  const payload = decommissioned.payload;
  if (
    !decommissioned.response?.ok ||
    !payload ||
    payload.ok !== true ||
    !proRoomAdminResponseIdentityMatches(payload, roomCode, room.roomGeneration) ||
    !['decommissioning', 'decommissioned'].includes(payload.status)
  ) {
    return proRoomObjectError(decommissioned);
  }

  try {
    if (payload.status === 'decommissioned') {
      await markAdminProRoomDecommissioned(db, roomCode, room.roomGeneration, body.requestId);
      // A completed incarnation has no persistent account authority left to
      // revoke. Retire only this exact generation's reverse edges so terminal
      // history cannot consume account deletion capacity forever. A later room
      // reusing the public code remains isolated in its own generation rows.
      await retireAccountProRoomLinks(env, roomCode, room.roomGeneration);
    } else {
      // The room Durable Object owns the retry alarm. Move the display index
      // only after that durable saga exists; otherwise a lost cross-script
      // call could leave an inert D1 fence with no worker scheduled to purge.
      await markAdminProRoomDecommissioning(db, roomCode, room.roomGeneration);
    }
  } catch {
    return json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, 503);
  }
  return json(
    {
      ok: true,
      roomCode,
      roomGeneration: room.roomGeneration,
      status: payload.status,
      purgeAfterMs: Number.isSafeInteger(payload.purgeAfterMs) ? payload.purgeAfterMs : null,
      completedAtMs: Number.isSafeInteger(payload.completedAtMs) ? payload.completedAtMs : null,
    },
    payload.status === 'decommissioned' ? 200 : 202,
  );
}

function emptyAdminCounters() {
  return Object.fromEntries(ADMIN_METRIC_EVENTS.map((event) => [event.key, 0]));
}

function addMetricCount(target, event, count) {
  if (!Object.prototype.hasOwnProperty.call(target, event)) return;
  target[event] += count;
}

function buildAdminMetricBuckets(rows, nowMs) {
  const last24 = emptyAdminCounters();
  const previous24 = emptyAdminCounters();
  const last7 = emptyAdminCounters();
  const hourStartMs = Math.floor(nowMs / 3600000) * 3600000;
  const dayStartMs = Math.floor(nowMs / 86400000) * 86400000;
  const hourly = [];
  const daily = [];
  const daily30 = [];

  for (let i = 23; i >= 0; i -= 1) {
    const startMs = hourStartMs - i * 3600000;
    hourly.push({
      start: new Date(startMs).toISOString(),
      events: emptyAdminCounters(),
    });
  }

  for (let i = 6; i >= 0; i -= 1) {
    const startMs = dayStartMs - i * 86400000;
    daily.push({
      start: new Date(startMs).toISOString(),
      events: emptyAdminCounters(),
    });
  }

  for (let i = 29; i >= 0; i -= 1) {
    const startMs = dayStartMs - i * 86400000;
    daily30.push({
      start: new Date(startMs).toISOString(),
      events: emptyAdminCounters(),
    });
  }

  const last24Start = nowMs - 24 * 3600000;
  const previous24Start = nowMs - 48 * 3600000;
  const last7Start = nowMs - 7 * 86400000;

  for (const row of rows) {
    const event = String(row.event || '');
    const count = Number(row.count || 0);
    const bucketMs = Number(row.bucket_minute || 0) * 60000;
    if (!event || !Number.isFinite(count) || !Number.isFinite(bucketMs)) continue;
    if (bucketMs >= last7Start && bucketMs <= nowMs) addMetricCount(last7, event, count);
    if (bucketMs >= last24Start && bucketMs <= nowMs) addMetricCount(last24, event, count);
    else if (bucketMs >= previous24Start && bucketMs < last24Start) {
      addMetricCount(previous24, event, count);
    }
  }

  for (const row of rows) {
    const event = String(row.event || '');
    const count = Number(row.count || 0);
    const bucketMs = Number(row.bucket_minute || 0) * 60000;
    if (!event || !Number.isFinite(count) || !Number.isFinite(bucketMs)) continue;

    for (const bucket of hourly) {
      const startMs = Date.parse(bucket.start);
      if (bucketMs >= startMs && bucketMs < startMs + 3600000) {
        addMetricCount(bucket.events, event, count);
        break;
      }
    }

    for (const bucket of daily) {
      const startMs = Date.parse(bucket.start);
      if (bucketMs >= startMs && bucketMs < startMs + 86400000) {
        addMetricCount(bucket.events, event, count);
        break;
      }
    }

    for (const bucket of daily30) {
      const startMs = Date.parse(bucket.start);
      if (bucketMs >= startMs && bucketMs < startMs + 86400000) {
        addMetricCount(bucket.events, event, count);
        break;
      }
    }
  }

  return { last24, previous24, last7, hourly, daily, daily30 };
}

function metricDelta(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

async function cleanupExpiredAdminMetrics(env, nowMs = Date.now()) {
  const db = getAdminDb(env);
  if (!db?.prepare) return 'unconfigured';

  const cutoffMinute = Math.floor(nowMs / 60000) - ADMIN_METRICS_RETENTION_DAYS * MINUTES_PER_DAY;
  try {
    await db
      .prepare(`DELETE FROM ${ADMIN_METRICS_TABLE} WHERE bucket_minute < ?1`)
      .bind(cutoffMinute)
      .run();
    return 'cleaned';
  } catch (error) {
    // Retention is maintenance, not a prerequisite for serving the dashboard
    // or refreshing Soro. Keep the scheduled task best-effort and observable.
    console.warn('[AdminMetrics] retention cleanup failed:', error?.message || error);
    return 'failed';
  }
}

async function cleanupExpiredProRoomAdminAudit(env, nowMs = Date.now()) {
  const db = getAdminDb(env);
  if (!db?.prepare) return 'unconfigured';
  const cutoffMs = nowMs - ADMIN_PRO_ROOM_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    await db
      .prepare(`DELETE FROM ${ADMIN_PRO_ROOM_AUDIT_TABLE} WHERE created_at < ?1`)
      .bind(cutoffMs)
      .run();
    return 'cleaned';
  } catch (error) {
    console.warn('[PRO Admin Audit] retention cleanup failed:', error?.message || error);
    return 'failed';
  }
}

async function readAdminMetrics(env) {
  const db = getAdminDb(env);
  if (!db?.prepare) return { error: 'ADMIN_DB_NOT_CONFIGURED', status: 503 };

  const nowMs = Date.now();
  const nowMinute = Math.floor(nowMs / 60000);
  const sinceMinute = nowMinute - 30 * 24 * 60;
  let result;
  try {
    result = await db
      .prepare(
        `SELECT bucket_minute, event, count
         FROM ${ADMIN_METRICS_TABLE}
         WHERE bucket_minute >= ?1
         ORDER BY bucket_minute ASC`,
      )
      .bind(sinceMinute)
      .all();
  } catch (error) {
    const message = String(error?.message || error || '');
    if (/no such table/i.test(message)) {
      return { error: 'ADMIN_METRICS_SCHEMA_MISSING', status: 503 };
    }
    return { error: 'ADMIN_METRICS_QUERY_FAILED', status: 500 };
  }

  const rows = Array.isArray(result?.results) ? result.results : [];
  const buckets = buildAdminMetricBuckets(rows, nowMs);
  const roomCount = buckets.last24.room_opened || 0;
  const guestCount = buckets.last24.guest_joined || 0;
  const authFailures =
    (buckets.last24.guest_auth_failed || 0) + (buckets.last24.guest_auth_timeout || 0);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    events: ADMIN_METRIC_EVENTS,
    cards: [
      {
        key: 'room_opened',
        label: 'Rooms opened',
        value: roomCount,
        previous: buckets.previous24.room_opened || 0,
        delta: metricDelta(roomCount, buckets.previous24.room_opened || 0),
      },
      {
        key: 'guest_joined',
        label: 'Guest joins',
        value: guestCount,
        previous: buckets.previous24.guest_joined || 0,
        delta: metricDelta(guestCount, buckets.previous24.guest_joined || 0),
      },
      {
        key: 'guest_per_room',
        label: 'Guests per room',
        value: roomCount ? Number((guestCount / roomCount).toFixed(2)) : 0,
        previous: buckets.previous24.room_opened
          ? Number((buckets.previous24.guest_joined / buckets.previous24.room_opened).toFixed(2))
          : 0,
      },
      {
        key: 'auth_issues',
        label: 'Password issues',
        value: authFailures,
        previous:
          (buckets.previous24.guest_auth_failed || 0) +
          (buckets.previous24.guest_auth_timeout || 0),
      },
    ],
    summary: buckets,
  };
}

async function handleAdminMetrics(request, env) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const metrics = await readAdminMetrics(env);
  if (metrics.error) return json({ error: metrics.error }, metrics.status || 500);
  return json(metrics);
}

function buildAdminArticleRows(feeds, hiddenSlugs) {
  const bySlug = new Map();
  const addArticle = (article, source) => {
    if (!article?.slug || !isValidSoroSlug(article.slug)) return;
    const existing = bySlug.get(article.slug);
    if (!existing || source === 'live') {
      bySlug.set(article.slug, {
        title: article.title || article.slug,
        slug: article.slug,
        pubDate: article.pubDate || '',
        description: article.description || '',
        image: article.image || '',
        href: soroArticlePath(article.slug),
        source,
        hidden: hiddenSlugs.has(article.slug),
      });
      return;
    }
    existing.source = existing.source === source ? source : 'live+backup';
  };

  for (const article of feeds.backup.articles) addArticle(article, 'backup');
  for (const article of feeds.live.articles) addArticle(article, 'live');

  return sortedSoroArticles([...bySlug.values()]);
}

async function handleAdminArticles(request, env) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const [feeds, hiddenSlugs] = await Promise.all([loadSoroFeeds(env), readSoroHiddenSlugs(env)]);
  const articles = buildAdminArticleRows(feeds, hiddenSlugs);
  return json({
    generatedAt: new Date().toISOString(),
    source: feeds.source,
    backupStatus: feeds.backupStatus || 'unknown',
    hiddenCount: articles.filter((article) => article.hidden).length,
    articles,
  });
}

async function handleAdminArticleVisibility(request, env) {
  const methodError = adminApiMethodAllowed(request, ['POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  const slug = String(body?.slug || '').trim();
  if (!isValidSoroSlug(slug)) return json({ error: 'INVALID_SLUG' }, 400);

  const hiddenSlugs = await readSoroHiddenSlugs(env);
  const wasHidden = hiddenSlugs.has(slug);
  if (body?.hidden === false) hiddenSlugs.delete(slug);
  else hiddenSlugs.add(slug);
  const isHidden = hiddenSlugs.has(slug);

  const status = await writeSoroHiddenSlugs(env, hiddenSlugs);
  if (status === 'unbound') return json({ error: 'SORO_BACKUP_NOT_CONFIGURED' }, 503);
  const cacheVersion =
    wasHidden === isHidden
      ? await readSoroBlogCacheVersion(env)
      : await touchSoroBlogCacheVersion(env, 'visibility');
  return json({
    ok: true,
    slug,
    hidden: isHidden,
    cacheVersion,
  });
}

function getAdminConfigStore(env) {
  return env.MUSIXQUARE_ADMIN_CONFIG || env.SORO_RSS_BACKUP || null;
}

function createAnnouncementId() {
  const suffix = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${suffix}`;
}

function normalizeAnnouncementRecord(value) {
  const source = value && typeof value === 'object' ? value : {};
  const message = String(source.message || '')
    .trim()
    .slice(0, 280);
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : '';
  const updatedAt =
    typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : '';
  const expiresAt =
    typeof source.expiresAt === 'string' && !Number.isNaN(new Date(source.expiresAt).getTime())
      ? new Date(source.expiresAt).toISOString()
      : null;
  return {
    id,
    message,
    enabled: Boolean(source.enabled) && Boolean(message),
    expiresAt,
    updatedAt,
  };
}

function getAnnouncementHistoryAction(announcement) {
  if (announcement.enabled && announcement.message) return 'published';
  if (announcement.message) return 'disabled';
  return 'cleared';
}

function normalizeAnnouncementHistoryEntry(value) {
  const announcement = normalizeAnnouncementRecord(value);
  const source = value && typeof value === 'object' ? value : {};
  const action = ['published', 'disabled', 'cleared'].includes(source.action)
    ? source.action
    : getAnnouncementHistoryAction(announcement);
  return {
    ...announcement,
    action,
  };
}

async function readAdminAnnouncementHistory(env) {
  const store = getAdminConfigStore(env);
  if (!store) return { status: 'unbound', history: [] };
  const text = await store.get(ADMIN_ANNOUNCEMENT_HISTORY_KEY);
  if (!text) return { status: 'missing', history: [] };
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { status: 'invalid', history: [] };
    return {
      status: 'ok',
      history: parsed
        .map(normalizeAnnouncementHistoryEntry)
        .slice(0, ADMIN_ANNOUNCEMENT_HISTORY_LIMIT),
    };
  } catch {
    return { status: 'invalid', history: [] };
  }
}

async function appendAdminAnnouncementHistory(env, announcement) {
  const store = getAdminConfigStore(env);
  if (!store) return { status: 'unbound', history: [] };
  const { history } = await readAdminAnnouncementHistory(env);
  const entry = normalizeAnnouncementHistoryEntry({
    ...announcement,
    action: getAnnouncementHistoryAction(announcement),
  });
  const nextHistory = [entry, ...history].slice(0, ADMIN_ANNOUNCEMENT_HISTORY_LIMIT);
  await store.put(ADMIN_ANNOUNCEMENT_HISTORY_KEY, JSON.stringify(nextHistory, null, 2));
  return { status: 'written', history: nextHistory };
}

function isAnnouncementActive(announcement, now = Date.now()) {
  if (!announcement.enabled || !announcement.message) return false;
  if (!announcement.expiresAt) return true;
  return new Date(announcement.expiresAt).getTime() > now;
}

async function readAdminAnnouncement(env) {
  const store = getAdminConfigStore(env);
  if (!store) return { status: 'unbound', announcement: normalizeAnnouncementRecord({}) };
  const text = await store.get(ADMIN_ANNOUNCEMENT_KEY);
  if (!text) return { status: 'missing', announcement: normalizeAnnouncementRecord({}) };
  try {
    return {
      status: 'ok',
      announcement: normalizeAnnouncementRecord(JSON.parse(text)),
    };
  } catch {
    return { status: 'invalid', announcement: normalizeAnnouncementRecord({}) };
  }
}

async function writeAdminAnnouncement(env, announcement) {
  const store = getAdminConfigStore(env);
  if (!store) return 'unbound';
  await store.put(ADMIN_ANNOUNCEMENT_KEY, JSON.stringify(announcement, null, 2));
  return 'written';
}

function announcementPublicPayload(announcement) {
  if (!isAnnouncementActive(announcement)) {
    return { enabled: false };
  }
  return {
    enabled: true,
    id: announcement.id,
    message: announcement.message,
    expiresAt: announcement.expiresAt,
  };
}

async function handleAdminAnnouncement(request, env) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD', 'POST']);
  if (methodError) return methodError;
  if (!(await verifyAdminSession(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const { status, announcement } = await readAdminAnnouncement(env);
    if (status === 'unbound') return json({ error: 'ADMIN_CONFIG_NOT_CONFIGURED' }, 503);
    const { history } = await readAdminAnnouncementHistory(env);
    return json({
      generatedAt: new Date().toISOString(),
      announcement,
      history,
    });
  }

  const parsedBody = await readJsonBodyLimited(request, ADMIN_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody);
  const body = parsedBody.value;
  const message = String(body?.message || '')
    .trim()
    .slice(0, 280);
  const enabled = Boolean(body?.enabled) && Boolean(message);
  const expiresAtRaw = String(body?.expiresAt || '').trim();
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  if (expiresAtRaw && Number.isNaN(expiresAt.getTime())) {
    return json({ error: 'INVALID_EXPIRES_AT' }, 400);
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return json({ error: 'EXPIRES_AT_IN_PAST' }, 400);
  }

  const announcement = normalizeAnnouncementRecord({
    id: createAnnouncementId(),
    message,
    enabled,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    updatedAt: new Date().toISOString(),
  });
  const status = await writeAdminAnnouncement(env, announcement);
  if (status === 'unbound') return json({ error: 'ADMIN_CONFIG_NOT_CONFIGURED' }, 503);
  const { history } = await appendAdminAnnouncementHistory(env, announcement);
  return json({
    ok: true,
    announcement,
    history,
  });
}

async function handlePublicAnnouncement(request, env) {
  const methodError = adminApiMethodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  const { announcement } = await readAdminAnnouncement(env);
  return json(announcementPublicPayload(announcement), 200, {
    'Cache-Control': 'public, max-age=30',
  });
}

function renderAdminPage(request, env) {
  const body =
    request.method === 'HEAD'
      ? null
      : `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>MUSIXQUARE Admin</title>
  <link rel="icon" href="/designsystem/assets/favicon.svg">
  <link rel="stylesheet" href="/admin.css">
  <script src="/admin.js" defer></script>
</head>
<body>
  <main class="admin-shell" data-admin-configured="${isAdminConfigured(env) ? 'true' : 'false'}">
    <section class="login-panel" data-login-panel>
      <span class="admin-wordmark" aria-label="MUSIXQUARE"></span>
      <h1>Admin Dashboard</h1>
      <form data-login-form>
        <div class="login-row">
          <input id="admin-password" class="login-password" name="password" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" required>
          <button class="login-submit" type="submit" aria-label="Log in">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.59 5.58L12 20l8-8-8-8z"></path>
            </svg>
          </button>
        </div>
        <p class="status" data-login-status></p>
      </form>
    </section>

    <section class="dashboard" data-dashboard hidden>
      <header class="dashboard-header">
        <div>
          <span class="admin-wordmark admin-wordmark-small" aria-label="MUSIXQUARE"></span>
          <h1 data-dashboard-title>Operations</h1>
          <p data-updated-at>Loading metrics...</p>
        </div>
        <div class="header-actions">
          <button type="button" data-refresh>Refresh</button>
          <button type="button" data-logout>Logout</button>
        </div>
      </header>
      <nav class="admin-tabs" aria-label="Admin sections">
        <button class="is-active" type="button" data-admin-tab="operations">Operations</button>
        <button type="button" data-admin-tab="pro-rooms">PRO Rooms</button>
        <button type="button" data-admin-tab="articles">Articles</button>
        <button type="button" data-admin-tab="announcements">Announcements</button>
      </nav>
      <section class="admin-view is-active" data-admin-view="operations">
        <section class="metric-grid" data-metric-cards></section>
        <section class="panel">
          <div class="panel-head">
            <h2>Last 24 hours</h2>
          </div>
          <div class="chart" data-hourly-chart></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Seven day trend</h2>
          </div>
          <div class="trend-list" data-daily-list></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Thirty day trend</h2>
          </div>
          <div class="spectrum-chart" data-monthly-chart></div>
        </section>
        <section class="panel compact">
          <div class="panel-head">
            <h2>Signals</h2>
          </div>
          <div class="signal-grid" data-signal-grid></div>
        </section>
      </section>
      <section class="admin-view" data-admin-view="pro-rooms" hidden>
        <section class="pro-room-management">
          <section class="panel pro-room-register-panel">
            <div class="panel-head">
              <div>
                <h2>Register a PRO room</h2>
                <p>Register an available room number. Reusing a deleted number creates a new, isolated room.</p>
              </div>
              <span>1 GiB per room</span>
            </div>
            <form class="pro-room-form" data-pro-room-form>
              <label class="pro-room-field pro-room-code-field">
                <span>Room number</span>
                <input name="roomCode" type="text" inputmode="numeric" autocomplete="off" maxlength="6" pattern="0[0-9]{5}" placeholder="000002" aria-describedby="pro-room-code-help" data-pro-room-code required>
                <small id="pro-room-code-help">Six digits beginning with 0</small>
              </label>
              <label class="pro-room-field">
                <span>Purpose / label</span>
                <input name="label" type="text" autocomplete="off" maxlength="64" placeholder="Friends listening room" data-pro-room-label>
                <small>Optional · visible only to administrators</small>
              </label>
              <button class="pro-room-register" type="submit" data-pro-room-register>Register</button>
            </form>
            <p class="pro-room-status" role="status" aria-live="polite" data-pro-room-status></p>
          </section>

          <section class="pro-room-claim panel" aria-live="polite" data-pro-room-claim hidden>
            <div class="pro-room-claim-copy">
              <strong data-pro-room-claim-title>Owner activation link</strong>
              <span data-pro-room-claim-expiry></span>
            </div>
            <div class="pro-room-claim-row">
              <input type="text" readonly aria-label="Owner activation link" data-pro-room-claim-url>
              <button type="button" data-pro-room-claim-copy>Copy link</button>
              <button class="is-secondary" type="button" aria-label="Dismiss activation link" data-pro-room-claim-dismiss>Dismiss</button>
            </div>
            <p>This link grants ownership. Send it privately and do not paste it into chat.</p>
          </section>

          <section class="pro-room-list-section">
            <div class="pro-room-list-head">
              <div>
                <h2>Registered rooms</h2>
                <p>Expand a room to manage access, lifecycle, and API keys.</p>
                <p data-pro-room-list-status>Loading PRO rooms...</p>
              </div>
            </div>
            <div class="pro-room-list" data-pro-room-list></div>
          </section>
        </section>
      </section>
      <section class="admin-view" data-admin-view="articles" hidden>
        <section class="article-management">
          <p class="article-status" data-article-status>Loading articles...</p>
          <div class="article-list" data-article-list></div>
        </section>
      </section>
      <section class="admin-view" data-admin-view="announcements" hidden>
        <section class="announcement-management">
          <form class="announcement-form" data-announcement-form>
            <div class="announcement-topline">
              <label class="announcement-switch">
                <input type="checkbox" name="enabled" data-announcement-enabled>
                <span class="announcement-switch-track" aria-hidden="true"></span>
                <span>Active</span>
              </label>
            </div>
            <label class="announcement-field">
              <span>Message</span>
              <textarea name="message" rows="4" maxlength="280" placeholder="Write an announcement" data-announcement-message></textarea>
            </label>
            <label class="announcement-field announcement-expires">
              <span>Expires</span>
              <input type="text" name="expiresAt" inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD HH:MM" data-announcement-expires>
            </label>
            <div class="announcement-actions">
              <button type="submit" data-announcement-save>Save</button>
              <button type="button" data-announcement-clear>Clear</button>
            </div>
            <p class="announcement-status" data-announcement-status>Loading announcement...</p>
          </form>
          <article class="announcement-preview" data-announcement-preview hidden></article>
          <section class="announcement-history" aria-label="Announcement history">
            <div class="announcement-history-head">
              <span>History</span>
              <small data-announcement-history-status></small>
            </div>
            <div class="announcement-history-list" data-announcement-history-list></div>
          </section>
        </section>
      </section>
    </section>
  </main>
</body>
</html>`;

  return withSecurityHeaders(
    new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
    }),
    {
      'X-Robots-Tag': 'noindex, nofollow',
    },
  );
}

async function verifyTurnstileToken(turnstileToken, request, env) {
  if (!isTurnstileConfigured(env) || typeof turnstileToken !== 'string' || !turnstileToken) {
    return false;
  }

  const body = new URLSearchParams();
  body.set('secret', getTurnstileSecret(env));
  body.set('response', turnstileToken);
  const ip = getClientIp(request);
  if (ip !== 'unknown') body.set('remoteip', ip);

  try {
    const response = await fetch(TURNSTILE_VERIFY_ENDPOINT, {
      method: 'POST',
      body,
    });
    const payload = await response.json().catch(() => ({}));
    return (
      !!payload.success &&
      payload.action === 'mxqr-capability' &&
      isAllowedTurnstileHostname(payload.hostname, env)
    );
  } catch {
    return false;
  }
}

async function guardSensitiveRequest(
  request,
  env,
  trust,
  capabilityScope,
  rateLimitKey,
  rateLimit,
  options = {},
) {
  if (!isCapabilityAuthEnabled(env)) {
    if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, trust.headers);
    if (!allowUnguardedPaidApis(env)) {
      return json({ error: 'CAPABILITY_NOT_CONFIGURED' }, 503, trust.headers);
    }
    if (!(await checkRateLimit(request, rateLimitKey, rateLimit, 60))) {
      return rateLimitResponse(trust.headers);
    }
    return null;
  }

  const authenticatedRateLimit = Number.isSafeInteger(options.authenticatedRateLimit)
    ? options.authenticatedRateLimit
    : rateLimit;
  if (!(await checkRateLimit(request, rateLimitKey, authenticatedRateLimit, 60))) {
    return rateLimitResponse(trust.headers);
  }

  const token = readCapabilityToken(request);
  if (!(await verifyCapabilityToken(token, request, env, capabilityScope))) {
    return json({ error: 'CAPABILITY_REQUIRED' }, 401, trust.headers);
  }

  if (Number.isSafeInteger(options.perCapabilityLimit) && options.perCapabilityLimit > 0) {
    const tokenIdentity = (await hmacSha256(getCapabilitySecret(env), `rate:${token}`)).slice(
      0,
      32,
    );
    const allowed = await checkRateLimit(
      request,
      `${rateLimitKey}-capability`,
      options.perCapabilityLimit,
      60,
      tokenIdentity,
    );
    if (!allowed) return rateLimitResponse(trust.headers);
  }
  return null;
}

async function handleSecurityConfig(request, env) {
  const trust = trustedCors(request, 'GET, OPTIONS', env, { allowInferred: true });
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, headers);

  const turnstileConfigured = isTurnstileConfigured(env);
  const capabilityRequired = isCapabilityAuthEnabled(env);
  const proofOfWorkRequired = capabilityRequired && !turnstileConfigured;

  return json(
    {
      capabilityRequired,
      turnstileSiteKey: turnstileConfigured ? getTurnstileSiteKey(env) : '',
      turnstileRequired: capabilityRequired && turnstileConfigured,
      proofOfWorkRequired,
      proofOfWorkDifficulty: proofOfWorkRequired ? parseCapabilityPowDifficulty(env) : 0,
      proofOfWorkTtl: proofOfWorkRequired ? parseCapabilityPowTtl(env) : 0,
      ttl: parseCapabilityTtl(env),
    },
    200,
    headers,
  );
}

async function handleCapabilityChallenge(request, env) {
  const trust = trustedCors(request, 'POST, OPTIONS', env, { allowInferred: true });
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  if (!isCapabilityAuthEnabled(env)) {
    return json({ capabilityRequired: false }, 200, headers);
  }
  if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, headers);
  if (isTurnstileConfigured(env)) return json({ error: 'TURNSTILE_REQUIRED' }, 409, headers);

  const parsedBody = await readJsonBodyLimited(request, CAPABILITY_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody, headers);
  const scopes = parseRequestedScopes(parsedBody.value?.scopes);
  if (scopes.length === 0) return json({ error: 'Invalid scopes' }, 400, headers);
  const roomBurst = scopes.includes('realtime') || scopes.includes('turn');
  if (
    !(await checkRateLimit(
      request,
      roomBurst ? 'capability-challenge-room' : 'capability-challenge',
      roomBurst ? ROOM_BURST_CAPABILITY_LIMIT : 30,
      60,
    ))
  ) {
    return rateLimitResponse(headers);
  }
  return json(await createCapabilityPowChallenge(scopes, request, env), 200, headers);
}

async function handleCapabilityToken(request, env) {
  const trust = trustedCors(request, 'POST, OPTIONS', env, { allowInferred: true });
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
  if (!isCapabilityAuthEnabled(env)) {
    return json({ capabilityRequired: false }, 200, headers);
  }
  if (!trust.isTrusted) return json({ error: 'Forbidden' }, 403, headers);

  const parsedBody = await readJsonBodyLimited(request, CAPABILITY_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody, headers);
  const body = parsedBody.value;
  const scopes = parseRequestedScopes(body?.scopes);
  if (scopes.length === 0) return json({ error: 'Invalid scopes' }, 400, headers);
  const roomBurst = scopes.includes('realtime') || scopes.includes('turn');
  if (
    !(await checkRateLimit(
      request,
      roomBurst ? 'capability-token-room' : 'capability-token',
      roomBurst ? ROOM_BURST_CAPABILITY_LIMIT : 30,
      60,
    ))
  ) {
    return rateLimitResponse(headers);
  }

  if (isTurnstileConfigured(env) && typeof body?.turnstileToken === 'string') {
    if (!(await verifyTurnstileToken(body.turnstileToken, request, env))) {
      return json({ error: 'TURNSTILE_FAILED' }, 403, headers);
    }
    return json(await createCapabilityToken(scopes, request, env, 'turnstile'), 200, headers);
  }
  if (!isTurnstileConfigured(env)) {
    const challenge = await verifyCapabilityPowProof(body?.proofOfWork, scopes, request, env);
    if (!challenge) return json({ error: 'PROOF_OF_WORK_FAILED' }, 403, headers);
    // Reusing the same proof returns the same token and cannot extend expiry.
    return json(
      await createCapabilityToken(scopes, request, env, 'proof-of-work', {
        iat: challenge.iat,
        jti: challenge.nonce,
      }),
      200,
      headers,
    );
  }
  return json({ error: 'TURNSTILE_REQUIRED' }, 403, headers);
}

function clampMaxResults(raw, env) {
  const envDefault = Number.parseInt(env.YOUTUBE_SEARCH_MAX_RESULTS || '', 10);
  const fallback = Number.isFinite(envDefault) ? envDefault : DEFAULT_MAX_RESULTS;
  const parsed = Number.parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(1, parsed));
}

function getBestThumbnail(thumbnails) {
  if (!thumbnails || typeof thumbnails !== 'object') return '';
  return (
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    thumbnails.standard?.url ||
    thumbnails.maxres?.url ||
    ''
  );
}

const HTML_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i;
const HTML_ENTITY_RE_G = /&(#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi;
const HTML_ENTITY_FALLBACKS = {
  amp: '&',
  apos: "'",
  bull: '\u2022',
  copy: '\u00a9',
  divide: '\u00f7',
  gt: '>',
  hellip: '\u2026',
  laquo: '\u00ab',
  ldquo: '\u201c',
  lsquo: '\u2018',
  lt: '<',
  mdash: '\u2014',
  middot: '\u00b7',
  nbsp: '\u00a0',
  ndash: '\u2013',
  plusmn: '\u00b1',
  quot: '"',
  raquo: '\u00bb',
  rdquo: '\u201d',
  reg: '\u00ae',
  rsquo: '\u2019',
  times: '\u00d7',
  trade: '\u2122',
};

function decodeNumericEntity(entity) {
  const isHex = entity.slice(0, 2).toLowerCase() === '#x';
  const raw = isHex ? entity.slice(2) : entity.slice(1);
  const codePoint = Number.parseInt(raw, isHex ? 16 : 10);
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!HTML_ENTITY_RE.test(text)) return text;
  return text.replace(HTML_ENTITY_RE_G, (match, entity) => {
    if (entity[0] === '#') return decodeNumericEntity(entity) || match;
    return HTML_ENTITY_FALLBACKS[entity.toLowerCase()] || match;
  });
}

function normalizeExternalText(value) {
  return typeof value === 'string' ? decodeHtmlEntities(value).trim() : '';
}

function normalizeResults(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const videoId = item?.id?.videoId;
      const snippet = item?.snippet || {};
      if (typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
      return {
        videoId,
        title: normalizeExternalText(snippet.title),
        channelTitle: normalizeExternalText(snippet.channelTitle),
        thumbnailUrl: getBestThumbnail(snippet.thumbnails),
        publishedAt: typeof snippet.publishedAt === 'string' ? snippet.publishedAt : '',
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    })
    .filter(Boolean);
}

function normalizePlaylistEntry(items, playlistId) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const videoId = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
    if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(videoId)) continue;

    const privacyStatus = item?.status?.privacyStatus;
    if (privacyStatus === 'private') continue;

    const title = normalizeExternalText(item?.snippet?.title).slice(0, 300);
    if (!title || title === 'Deleted video' || title === 'Private video') continue;
    return { playlistId, videoId, title };
  }
  return null;
}

function normalizePlaylistManifestItem(item) {
  const videoId = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
  if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(videoId)) return null;

  const privacyStatus = item?.status?.privacyStatus;
  if (privacyStatus === 'private') return null;

  const title = normalizeExternalText(item?.snippet?.title).slice(0, 300);
  if (!title || title === 'Deleted video' || title === 'Private video') return null;
  return { videoId, title };
}

function parsePlaylistManifestPage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.items)) return null;
  const totalResults = payload.pageInfo?.totalResults;
  if (!Number.isSafeInteger(totalResults) || totalResults < 0) return null;
  const nextPageToken = payload.nextPageToken;
  if (nextPageToken !== undefined && (typeof nextPageToken !== 'string' || !nextPageToken)) {
    return null;
  }
  return {
    items: payload.items,
    totalResults,
    nextPageToken: nextPageToken || null,
  };
}

function normalizeUpstreamError(payload) {
  const firstError = payload?.error?.errors?.[0] || {};
  return {
    reason: firstError.reason || payload?.error?.status || 'unknown',
    message: firstError.message || payload?.error?.message || '',
  };
}

function getClientStatusForUpstreamError(status, reason) {
  const quotaReasons = new Set([
    'quotaExceeded',
    'dailyLimitExceeded',
    'rateLimitExceeded',
    'userRateLimitExceeded',
  ]);
  if (quotaReasons.has(reason)) return 429;
  if (status === 400 || status === 401 || status === 403) return 403;
  return 502;
}

async function handleYoutubeSearch(request, env) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(request, env, trust, 'youtube-search', 'yt-search', 30);
  if (guard) return guard;

  const apiKey = env.YOUTUBE_API_KEY || env.YOUTUBE_DATA_API_KEY || '';
  if (!apiKey) return json({ error: 'YOUTUBE_SEARCH_UNAVAILABLE' }, 503, headers);

  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || '')
    .trim()
    .slice(0, QUERY_MAX_LENGTH);
  if (!query) return json({ error: 'Missing query' }, 400, headers);

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    safeSearch: env.YOUTUBE_SAFE_SEARCH || 'moderate',
    maxResults: String(clampMaxResults(url.searchParams.get('maxResults'), env)),
    q: query,
    fields:
      'items(id/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt,snippet/thumbnails)',
  });
  if (/^[A-Za-z]{2}$/.test(env.YOUTUBE_REGION_CODE || '')) {
    params.set('regionCode', env.YOUTUBE_REGION_CODE.toUpperCase());
  }
  if (/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(env.YOUTUBE_RELEVANCE_LANGUAGE || '')) {
    params.set('relevanceLanguage', env.YOUTUBE_RELEVANCE_LANGUAGE);
  }

  try {
    const response = await fetch(`${YOUTUBE_SEARCH_API}?${params.toString()}`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamError = normalizeUpstreamError(payload);
      return json(
        {
          error: 'YOUTUBE_SEARCH_FAILED',
          upstreamStatus: response.status,
          reason: upstreamError.reason,
          message: upstreamError.message,
        },
        getClientStatusForUpstreamError(response.status, upstreamError.reason),
        headers,
      );
    }
    return json({ query, results: normalizeResults(payload.items) }, 200, headers);
  } catch (error) {
    return json(
      { error: 'YOUTUBE_SEARCH_PROXY_FAILED', message: error?.message || String(error) },
      502,
      headers,
    );
  }
}

async function handleYoutubePlaylistEntry(request, env) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(
    request,
    env,
    trust,
    'youtube-search',
    'yt-playlist-entry',
    20,
  );
  if (guard) return guard;

  const apiKey = env.YOUTUBE_API_KEY || env.YOUTUBE_DATA_API_KEY || '';
  if (!apiKey) return json({ error: 'YOUTUBE_PLAYLIST_RESOLUTION_UNAVAILABLE' }, 503, headers);

  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const playlistIds = url.searchParams.getAll('playlistId');
  if (
    keys.length !== 1 ||
    keys[0] !== 'playlistId' ||
    playlistIds.length !== 1 ||
    !YOUTUBE_PLAYLIST_ID_RE.test(playlistIds[0])
  ) {
    return json({ error: 'INVALID_YOUTUBE_PLAYLIST_ID' }, 400, headers);
  }
  const playlistId = playlistIds[0];

  const params = new URLSearchParams({
    part: 'snippet,contentDetails,status',
    playlistId,
    // One quota unit resolves up to 50 rows. Scan the first page so a private
    // or deleted leading item does not make an otherwise usable list fail.
    maxResults: '50',
    fields:
      'items(contentDetails/videoId,snippet/resourceId/videoId,snippet/title,status/privacyStatus)',
  });

  try {
    const response = await fetch(`${YOUTUBE_PLAYLIST_ITEMS_API}?${params.toString()}`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamError = normalizeUpstreamError(payload);
      return json(
        {
          error: 'YOUTUBE_PLAYLIST_RESOLUTION_FAILED',
          upstreamStatus: response.status,
          reason: upstreamError.reason,
        },
        getClientStatusForUpstreamError(response.status, upstreamError.reason),
        headers,
      );
    }

    const entry = normalizePlaylistEntry(payload.items, playlistId);
    if (!entry) {
      return json({ error: 'YOUTUBE_PLAYLIST_HAS_NO_PLAYABLE_ENTRY' }, 404, headers);
    }
    return json(entry, 200, headers);
  } catch {
    return json({ error: 'YOUTUBE_PLAYLIST_RESOLUTION_PROXY_FAILED' }, 502, headers);
  }
}

async function handleYoutubePlaylistManifest(request, env) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(
    request,
    env,
    trust,
    'youtube-search',
    'yt-playlist-manifest',
    10,
  );
  if (guard) return guard;

  const apiKey = env.YOUTUBE_API_KEY || env.YOUTUBE_DATA_API_KEY || '';
  if (!apiKey) return json({ error: 'YOUTUBE_PLAYLIST_RESOLUTION_UNAVAILABLE' }, 503, headers);

  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const playlistIds = url.searchParams.getAll('playlistId');
  if (
    keys.length !== 1 ||
    keys[0] !== 'playlistId' ||
    playlistIds.length !== 1 ||
    !YOUTUBE_PLAYLIST_ID_RE.test(playlistIds[0])
  ) {
    return json({ error: 'INVALID_YOUTUBE_PLAYLIST_ID' }, 400, headers);
  }
  const playlistId = playlistIds[0];
  const params = new URLSearchParams({
    part: 'snippet,contentDetails,status',
    playlistId,
    maxResults: String(YOUTUBE_PLAYLIST_MANIFEST_PAGE_SIZE),
    fields:
      'nextPageToken,pageInfo/totalResults,items(contentDetails/videoId,snippet/resourceId/videoId,snippet/title,status/privacyStatus)',
  });
  const deadline = Date.now() + YOUTUBE_PLAYLIST_MANIFEST_TIMEOUT_MS;
  const seenPageTokens = new Set();
  const videoIds = [];
  let firstTitle = '';
  let expectedTotal = null;
  let receivedItems = 0;
  let pageToken = null;

  try {
    while (true) {
      if (pageToken) params.set('pageToken', pageToken);
      else params.delete('pageToken');

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' }, 502, headers);
      }
      const response = await fetchWithTimeout(
        `${YOUTUBE_PLAYLIST_ITEMS_API}?${params.toString()}`,
        { headers: { 'x-goog-api-key': apiKey } },
        Math.min(8_000, remainingMs),
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const upstreamError = normalizeUpstreamError(payload);
        return json(
          {
            error: 'YOUTUBE_PLAYLIST_RESOLUTION_FAILED',
            upstreamStatus: response.status,
            reason: upstreamError.reason,
          },
          getClientStatusForUpstreamError(response.status, upstreamError.reason),
          headers,
        );
      }

      const page = parsePlaylistManifestPage(payload);
      if (!page || (expectedTotal !== null && page.totalResults !== expectedTotal)) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' }, 502, headers);
      }
      expectedTotal ??= page.totalResults;
      if (expectedTotal > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_TOO_LARGE' }, 413, headers);
      }

      receivedItems += page.items.length;
      if (receivedItems > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_TOO_LARGE' }, 413, headers);
      }
      for (const item of page.items) {
        const playable = normalizePlaylistManifestItem(item);
        if (!playable) continue;
        if (!firstTitle) firstTitle = playable.title;
        videoIds.push(playable.videoId);
      }

      if (!page.nextPageToken) {
        if (receivedItems !== expectedTotal) {
          return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' }, 502, headers);
        }
        break;
      }
      if (
        page.items.length === 0 ||
        receivedItems >= expectedTotal ||
        seenPageTokens.has(page.nextPageToken)
      ) {
        return json({ error: 'YOUTUBE_PLAYLIST_MANIFEST_INCOMPLETE' }, 502, headers);
      }
      seenPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }

    if (videoIds.length === 0 || !firstTitle) {
      return json({ error: 'YOUTUBE_PLAYLIST_HAS_NO_PLAYABLE_ENTRY' }, 404, headers);
    }
    return json({ playlistId, videoId: videoIds[0], videoIds, title: firstTitle }, 200, headers);
  } catch {
    return json({ error: 'YOUTUBE_PLAYLIST_RESOLUTION_PROXY_FAILED' }, 502, headers);
  }
}

function parseTurnTtl(env) {
  const parsed = Number.parseInt(env.CLOUDFLARE_TURN_TTL || env.CF_TURN_TTL || '', 10);
  if (!Number.isFinite(parsed)) return CLOUDFLARE_TURN_TTL_DEFAULT;
  return Math.min(CLOUDFLARE_TURN_TTL_MAX, Math.max(CLOUDFLARE_TURN_TTL_MIN, parsed));
}

function normalizeUrls(value) {
  const urls = Array.isArray(value) ? value : [value];
  return urls.filter((url) => {
    if (typeof url !== 'string') return false;
    if (!/^(stun|turn|turns):/i.test(url)) return false;
    return !/^turns?:turn\.cloudflare\.com:53(?:[/?]|$)/i.test(url);
  });
}

function normalizeIceServers(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const urls = normalizeUrls(item.urls);
    if (urls.length === 0) continue;
    const hasTurn = urls.some((url) => /^turns?:/i.test(url));
    if (hasTurn && (!item.username || !item.credential)) continue;
    const server = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof item.username === 'string' && item.username) server.username = item.username;
    if (typeof item.credential === 'string' && item.credential) {
      server.credential = item.credential;
    }
    if (item.credentialType === 'password' || item.credentialType === 'oauth') {
      server.credentialType = item.credentialType;
    }
    result.push(server);
  }
  return result;
}

async function getCloudflareIceServers(env) {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID || env.CF_TURN_KEY_ID || '';
  const apiToken =
    env.CLOUDFLARE_TURN_API_TOKEN || env.CF_TURN_API_TOKEN || env.CLOUDFLARE_API_TOKEN || '';
  if (!keyId || !apiToken) return null;

  const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
    keyId,
  )}/credentials/generate-ice-servers`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: parseTurnTtl(env) }),
  });
  if (!response.ok) throw new Error(`Cloudflare TURN HTTP ${response.status}`);

  const payload = await response.json();
  const iceServers = normalizeIceServers(payload?.iceServers);
  const hasTurn = iceServers.some((server) =>
    normalizeUrls(server.urls).some((url) => /^turns?:/i.test(url)),
  );
  if (!hasTurn) throw new Error('Cloudflare TURN returned no usable TURN servers');
  return { provider: 'cloudflare', ttl: parseTurnTtl(env), iceServers };
}

async function handleTurnConfig(request, env) {
  const trust = trustedCors(request, 'GET, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  const guard = await guardSensitiveRequest(request, env, trust, 'turn', 'turn-config', 60, {
    authenticatedRateLimit: ROOM_BURST_TURN_LIMIT,
    perCapabilityLimit: 4,
  });
  if (guard) return guard;

  try {
    const cloudflareConfig = await getCloudflareIceServers(env);
    if (cloudflareConfig) return json(cloudflareConfig, 200, headers);
  } catch (error) {
    console.warn('[TURN] Cloudflare config failed:', error?.message || error);
  }
  return json({ error: 'TURN_CONFIG_UNAVAILABLE' }, 503, headers);
}

function getRealtimeEnv(env) {
  return {
    appId:
      env.CLOUDFLARE_REALTIME_APP_ID ||
      env.CLOUDFLARE_CALLS_APP_ID ||
      env.CLOUDFLARE_SFU_APP_ID ||
      '',
    appSecret:
      env.CLOUDFLARE_REALTIME_APP_SECRET ||
      env.CLOUDFLARE_REALTIME_API_TOKEN ||
      env.CLOUDFLARE_CALLS_APP_SECRET ||
      env.CLOUDFLARE_CALLS_API_TOKEN ||
      env.CLOUDFLARE_SFU_APP_SECRET ||
      env.CLOUDFLARE_SFU_API_TOKEN ||
      '',
  };
}

function buildRealtimeRequest(action, appId, sessionId, correlationId) {
  const encodedAppId = encodeURIComponent(appId);
  const encodedSessionId = sessionId ? encodeURIComponent(sessionId) : '';
  const query =
    typeof correlationId === 'string' && correlationId
      ? `?correlationId=${encodeURIComponent(correlationId.slice(0, 128))}`
      : '';
  switch (action) {
    case 'new-session':
      return {
        method: 'POST',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/new${query}`,
      };
    case 'tracks-new':
      return {
        method: 'POST',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/tracks/new`,
      };
    case 'renegotiate':
      return {
        method: 'PUT',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/renegotiate`,
      };
    case 'tracks-close':
      return {
        method: 'PUT',
        url: `${REALTIME_API_BASE}/apps/${encodedAppId}/sessions/${encodedSessionId}/tracks/close`,
      };
    default:
      return null;
  }
}

function shouldSendPayloadBody(action, payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (action !== 'new-session') return true;
  return Object.keys(payload).length > 0;
}

async function handleRealtime(request, env) {
  const trust = trustedCors(request, 'POST, OPTIONS', env);
  const { headers } = trust;
  if (request.method === 'OPTIONS')
    return withSecurityHeaders(new Response(null, { status: 204, headers }));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);

  const parsedBody = await readJsonBodyLimited(request, REALTIME_JSON_BODY_MAX_BYTES);
  if (parsedBody.error) return jsonBodyError(parsedBody, headers);
  const body = parsedBody.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const isNewSession = action === 'new-session';
  const guard = await guardSensitiveRequest(
    request,
    env,
    trust,
    'realtime',
    isNewSession ? 'realtime-new-session' : 'realtime-mutation',
    30,
    {
      authenticatedRateLimit: isNewSession
        ? ROOM_BURST_REALTIME_NEW_SESSION_LIMIT
        : ROOM_BURST_REALTIME_MUTATION_LIMIT,
      perCapabilityLimit: isNewSession
        ? REALTIME_NEW_SESSION_PER_CAPABILITY_LIMIT
        : REALTIME_MUTATION_PER_CAPABILITY_LIMIT,
    },
  );
  if (guard) return guard;

  const { appId, appSecret } = getRealtimeEnv(env);
  if (!appId || !appSecret) return json({ error: 'REALTIME_SFU_UNAVAILABLE' }, 503, headers);

  const realtimeRequest = buildRealtimeRequest(action, appId, sessionId, body.correlationId);
  if (!realtimeRequest) return json({ error: 'Unsupported action' }, 400, headers);
  if (action !== 'new-session') {
    if (!isValidRealtimeSessionId(sessionId)) {
      return json({ error: 'Invalid sessionId' }, 400, headers);
    }
    const ownsSession = await verifyRealtimeSessionCapability(
      body.sessionOwnerToken,
      sessionId,
      appId,
      appSecret,
    );
    if (!ownsSession) {
      return json({ error: 'REALTIME_SESSION_CAPABILITY_REQUIRED' }, 403, headers);
    }
    const sessionRateIdentity = (
      await hmacSha256(appSecret, `rate:${body.sessionOwnerToken}`)
    ).slice(0, 32);
    if (
      !(await checkRateLimit(
        request,
        'realtime-session-mutation',
        REALTIME_MUTATION_PER_SESSION_LIMIT,
        60,
        sessionRateIdentity,
      ))
    ) {
      return rateLimitResponse(headers);
    }
  }

  try {
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const requestBody = shouldSendPayloadBody(action, payload)
      ? JSON.stringify(payload)
      : undefined;
    const cfResponse = await fetch(realtimeRequest.url, {
      method: realtimeRequest.method,
      headers: {
        Authorization: `Bearer ${appSecret}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
    const text = await cfResponse.text();
    let responseBody;
    try {
      responseBody = text ? JSON.parse(text) : {};
    } catch {
      responseBody = { raw: text };
    }
    if (
      action === 'new-session' &&
      cfResponse.ok &&
      isValidRealtimeSessionId(responseBody?.sessionId)
    ) {
      responseBody.sessionOwnerToken = await createRealtimeSessionCapability(
        responseBody.sessionId,
        appId,
        appSecret,
      );
    }
    return json(responseBody, cfResponse.status, headers);
  } catch (error) {
    return json(
      { error: 'CLOUDFLARE_REALTIME_PROXY_FAILED', message: error?.message || String(error) },
      502,
      headers,
    );
  }
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeJsonForHtmlScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function replaceMetaProperty(html, property, content) {
  return html.replace(
    new RegExp(`<meta\\b(?=[^>]*\\bproperty=["']${property}["'])[^>]*>`, 'i'),
    `<meta property="${property}" content="${esc(content)}" />`,
  );
}

function replaceMetaName(html, name, content) {
  return html.replace(
    new RegExp(`<meta\\b(?=[^>]*\\bname=["']${name}["'])[^>]*>`, 'i'),
    `<meta name="${name}" content="${esc(content)}" />`,
  );
}

function rewriteInviteMeta(html, code, origin) {
  const imageUrl = `${origin}/og-invite.png`;
  const pageUrl = `${origin}/${code}`;
  const title = `Session ${code} - MUSIXQUARE`;
  const description = `Join a MUSIXQUARE session with code ${code}.`;
  const alt = `MUSIXQUARE - Session ${code}`;

  let rewritten = html;
  rewritten = replaceMetaProperty(rewritten, 'og:url', pageUrl);
  rewritten = replaceMetaProperty(rewritten, 'og:title', title);
  rewritten = replaceMetaProperty(rewritten, 'og:description', description);
  rewritten = replaceMetaProperty(rewritten, 'og:image', imageUrl);
  rewritten = replaceMetaProperty(rewritten, 'og:image:alt', alt);
  rewritten = replaceMetaName(rewritten, 'twitter:title', title);
  rewritten = replaceMetaName(rewritten, 'twitter:description', description);
  rewritten = replaceMetaName(rewritten, 'twitter:image', imageUrl);
  return rewritten;
}

function stripCdata(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return match ? match[1] : text;
}

function decodeXmlText(value) {
  return stripCdata(value)
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readRssTag(xml, tagName) {
  const tag = escapeRegExp(tagName);
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXmlText(match[1]) : '';
}

function readRssAttr(xml, tagPattern, attrName) {
  const tagMatch = String(xml).match(new RegExp(`<${tagPattern}\\b[^>]*>`, 'i'));
  if (!tagMatch) return '';
  const attr = escapeRegExp(attrName);
  const attrMatch = tagMatch[0].match(new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i'));
  return attrMatch ? decodeXmlText(attrMatch[1]) : '';
}

function isValidSoroSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120;
}

function extractSlugFromUrl(link) {
  try {
    const url = new URL(link);
    const post = url.searchParams.get('post') || '';
    if (isValidSoroSlug(post)) return post;
    const parts = url.pathname.split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || '';
    return isValidSoroSlug(slug) ? slug : '';
  } catch {
    return '';
  }
}

function soroArticlePath(slug) {
  return `/blog/${slug}`;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    /* invalid URL */
  }
  return '';
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`Response body exceeds ${maxBytes} bytes`);
    this.name = 'ResponseBodyTooLargeError';
  }
}

function responseContentLength(response) {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

async function cancelResponseBody(response, reason) {
  if (!response.body) return;
  await response.body.cancel(reason).catch(() => {});
}

async function readResponseBodyLimited(response, maxBytes, signal) {
  const declaredBytes = responseContentLength(response);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    await cancelResponseBody(response, 'RESPONSE_BODY_TOO_LARGE');
    throw new ResponseBodyTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const abortReason = () =>
    signal.reason instanceof Error ? signal.reason : new Error('Response body read aborted');
  const handleAbort = () => {
    void reader.cancel(abortReason()).catch(() => {});
  };
  signal.addEventListener('abort', handleAbort, { once: true });

  try {
    while (true) {
      if (signal.aborted) throw abortReason();
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortReason();
      if (done) break;
      if (!value) continue;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('RESPONSE_BODY_TOO_LARGE').catch(() => {});
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(bytes);
    }
  } finally {
    signal.removeEventListener('abort', handleAbort);
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function fetchAndConsumeWithTimeout(resource, options, timeoutMs, consume) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Response body read timed out')),
    timeoutMs,
  );
  try {
    const response = await fetch(resource, { ...options, signal: controller.signal });
    return await consume(response, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export async function readResponseBodyLimitedForTests(response, maxBytes) {
  return readResponseBodyLimited(response, maxBytes, new AbortController().signal);
}

function sanitizeSoroImageSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

function contentTypeToSoroImageExt(contentType) {
  const type = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  switch (type) {
    case 'image/avif':
      return 'avif';
    case 'image/gif':
      return 'gif';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return '';
  }
}

function imageExtFromUrl(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/);
    const ext = match ? match[1] : '';
    if (['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch {
    /* invalid URL */
  }
  return '';
}

function isAllowedSoroImageContentType(contentType) {
  return Boolean(contentTypeToSoroImageExt(contentType));
}

function soroImageKey(article, contentType = '') {
  if (!article?.slug || !isValidSoroSlug(article.slug)) return '';
  const source = sanitizeSoroImageSource(article.image);
  if (!source) return '';
  const ext = imageExtFromUrl(source) || contentTypeToSoroImageExt(contentType) || 'webp';
  return `${SORO_IMAGE_R2_PREFIX}${article.slug}.${ext}`;
}

function soroImagePublicPath(key) {
  return `${SORO_IMAGE_ROUTE_PREFIX}${key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function soroImageKeyFromPathname(pathname) {
  if (!pathname.startsWith(SORO_IMAGE_ROUTE_PREFIX)) return '';
  try {
    const key = decodeURIComponent(pathname.slice(SORO_IMAGE_ROUTE_PREFIX.length));
    if (!key.startsWith(SORO_IMAGE_R2_PREFIX)) return '';
    if (key.includes('..') || key.includes('\\')) return '';
    if (!/^featured\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:avif|gif|jpg|png|webp)$/.test(key)) {
      return '';
    }
    return key;
  } catch {
    return '';
  }
}

async function ensureSoroImageMirror(env, article, options = {}) {
  if (!article?.image) return 'none';
  const sourceUrl = sanitizeSoroImageSource(article.image);
  if (!sourceUrl) return 'invalid-source';
  if (!env.SORO_IMAGE_BUCKET) return 'unbound';

  const key = soroImageKey(article);
  if (!key) return 'invalid-key';
  const localPath = soroImagePublicPath(key);

  let existing = null;
  try {
    existing = await env.SORO_IMAGE_BUCKET.head(key);
  } catch {
    existing = null;
  }

  if (existing?.customMetadata?.sourceUrl === sourceUrl) {
    article.localImagePath = localPath;
    return 'cached';
  }
  if (existing && !options.fetchMissing) {
    article.localImagePath = localPath;
    return 'cached';
  }
  if (!options.fetchMissing) return 'source';

  try {
    const fetched = await fetchAndConsumeWithTimeout(
      sourceUrl,
      {
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1',
        },
      },
      SORO_IMAGE_FETCH_TIMEOUT_MS,
      async (response, signal) => {
        if (!response.ok) {
          await cancelResponseBody(response, 'SORO_IMAGE_HTTP_ERROR');
          return { status: 'fetch-error' };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!isAllowedSoroImageContentType(contentType)) {
          await cancelResponseBody(response, 'SORO_IMAGE_INVALID_TYPE');
          return { status: 'invalid-type' };
        }

        try {
          return {
            status: 'ok',
            contentType,
            bytes: await readResponseBodyLimited(response, SORO_IMAGE_MAX_BYTES, signal),
          };
        } catch (error) {
          if (error instanceof ResponseBodyTooLargeError) return { status: 'too-large' };
          throw error;
        }
      },
    );
    if (fetched.status !== 'ok') return existing ? 'cached' : fetched.status;

    await env.SORO_IMAGE_BUCKET.put(key, fetched.bytes, {
      httpMetadata: {
        contentType: fetched.contentType.split(';')[0].trim().toLowerCase(),
        cacheControl: SORO_IMAGE_CACHE,
      },
      customMetadata: {
        sourceUrl,
        slug: article.slug,
        mirroredAt: new Date().toISOString(),
      },
    });
    article.localImagePath = localPath;
    return existing ? 'updated' : 'written';
  } catch {
    if (existing) {
      article.localImagePath = localPath;
      return 'cached';
    }
    return 'error';
  }
}

async function mirrorSoroImages(env, articles, options = {}) {
  if (!env.SORO_IMAGE_BUCKET) return 'unbound';
  const counts = {};
  for (const article of articles) {
    const status = await ensureSoroImageMirror(env, article, options);
    counts[status] = (counts[status] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
}

function sortedSoroArticles(articles) {
  return [...articles].sort((a, b) => {
    const bTime = Date.parse(b.pubDate || '') || 0;
    const aTime = Date.parse(a.pubDate || '') || 0;
    return bTime - aTime;
  });
}

function soroArticleDisplayDate(pubDate) {
  const date = new Date(pubDate || '');
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function soroArticleIsoDate(pubDate) {
  const date = new Date(pubDate || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function soroArticleExcerpt(article) {
  return (
    article.description ||
    String(article.content || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
  );
}

function soroArticleImageUrl(article, origin, source) {
  if (article.localImagePath) return new URL(article.localImagePath, origin).href;
  if (source !== 'backup' && article.image) return article.image;
  return `${origin}/og-blog.png`;
}

function mapSoroListImagePaths(articles) {
  const counts = {};
  const visibleCount = Math.min(articles.length, 12);

  for (let index = 0; index < articles.length; index += 1) {
    const article = articles[index];
    if (!article?.image) {
      counts.none = (counts.none || 0) + 1;
      continue;
    }

    const key = soroImageKey(article);
    if (!key) {
      counts.invalid = (counts.invalid || 0) + 1;
      continue;
    }

    article.localImagePath = soroImagePublicPath(key);
    const status = index < visibleCount ? 'mapped' : 'deferred';
    counts[status] = (counts[status] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
}

function mapSoroArticleImagePath(article) {
  if (!article?.image) return 'none';
  const key = soroImageKey(article);
  if (!key) return 'invalid';
  article.localImagePath = soroImagePublicPath(key);
  return 'mapped';
}

function renderSoroBlogListHtml(articles, origin, source) {
  if (!articles.length) {
    return `<div class="soro-blog"><div class="soro-blog-content"><p class="soro-blog-card-excerpt">No articles are available yet.</p></div></div>`;
  }

  const cards = articles
    .map((article) => {
      const href = soroArticlePath(article.slug);
      const image = soroArticleImageUrl(article, origin, source);
      const displayDate = soroArticleDisplayDate(article.pubDate);
      const isoDate = soroArticleIsoDate(article.pubDate);
      const dateHtml = displayDate
        ? `<time class="soro-blog-card-date" datetime="${esc(isoDate)}">${esc(displayDate)}</time>`
        : '';
      return `<a class="soro-blog-card" href="${esc(href)}">
        <img class="soro-blog-card-image" src="${esc(image)}" alt="${esc(article.title)}" loading="lazy" decoding="async">
        <div class="soro-blog-card-content">
          <h3 class="soro-blog-card-title">${esc(article.title)}</h3>
          <p class="soro-blog-card-excerpt">${esc(soroArticleExcerpt(article))}</p>
          ${dateHtml}
        </div>
      </a>`;
    })
    .join('');

  return `<div class="soro-blog"><div class="soro-blog-content"><div class="soro-blog-list">${cards}</div></div></div>`;
}

function firstImageFromHtml(html) {
  const match = String(html).match(/<img\b[^>]*\bsrc=(["'])(.*?)\1/i);
  return match ? sanitizeUrl(decodeXmlText(match[2])) : '';
}

const SORO_ARTICLE_ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);
const SORO_ARTICLE_VOID_TAGS = new Set(['br', 'hr', 'img']);
const SORO_ARTICLE_MAX_NESTING = 128;
const SORO_ARTICLE_MAX_ATTRIBUTES = 64;
const SORO_ARTICLE_DROP_CONTENT_TAGS = new Set([
  'applet',
  'button',
  'canvas',
  'form',
  'iframe',
  'math',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'script',
  'select',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'xmp',
]);
const SORO_ARTICLE_DROP_TAGS = new Set(['base', 'embed', 'input', 'link', 'meta']);
const SORO_ARTICLE_GLOBAL_ATTRIBUTES = new Set(['class', 'dir', 'lang', 'title']);
const SORO_ARTICLE_TAG_ATTRIBUTES = {
  a: new Set(['href', 'target']),
  img: new Set(['alt', 'decoding', 'height', 'loading', 'src', 'width']),
  li: new Set(['value']),
  ol: new Set(['reversed', 'start', 'type']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
};

function decodeSoroHtmlAttribute(value) {
  return String(value ?? '')
    .replace(/&#(\d+);?/g, (match, code) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&#x([0-9a-f]+);?/gi, (match, code) => {
      const point = Number.parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function sanitizeSoroArticleUrl(value, kind) {
  const raw = String(value ?? '');
  if (raw.length > 4096) return '';
  const decoded = decodeSoroHtmlAttribute(raw).trim();
  if (!decoded || decoded.length > 4096) return '';
  // Unknown entities can be interpreted differently by an HTML parser. Drop
  // the URL instead of trying to maintain a partial HTML entity table here.
  if (/&(?:#x?[0-9a-f]+|[a-z][a-z0-9]+);/i.test(decoded)) return '';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) return '';

  try {
    const url = new URL(decoded, 'https://musixquare.com/');
    if (url.protocol === 'http:' || url.protocol === 'https:') return decoded;
    if (kind === 'href' && (url.protocol === 'mailto:' || url.protocol === 'tel:')) {
      return decoded;
    }
  } catch {
    /* invalid URL */
  }
  return kind === 'href' && decoded.startsWith('#') ? decoded : '';
}

function findSoroHtmlTagEnd(html, start) {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function parseSoroHtmlAttributes(source) {
  const attributes = [];
  let index = 0;
  while (index < source.length && attributes.length < SORO_ARTICLE_MAX_ATTRIBUTES) {
    while (/\s/.test(source[index] || '')) index += 1;
    if (index >= source.length || source[index] === '/') break;

    const nameMatch = source.slice(index).match(/^([a-z_:][a-z0-9:._-]*)/i);
    if (!nameMatch) {
      index += 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    index += nameMatch[0].length;
    while (/\s/.test(source[index] || '')) index += 1;

    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] || '')) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const end = source.indexOf(quote, index);
        value = end < 0 ? source.slice(index) : source.slice(index, end);
        index = end < 0 ? source.length : end + 1;
      } else {
        const valueMatch = source.slice(index).match(/^[^\s>]+/);
        value = valueMatch?.[0] || '';
        index += value.length;
      }
    }
    attributes.push({ name, value });
  }
  return attributes;
}

function sanitizeSoroArticleClass(value) {
  return decodeSoroHtmlAttribute(String(value ?? '').slice(0, 2048))
    .split(/\s+/)
    .filter((token) => /^[-_a-z0-9]{1,64}$/i.test(token))
    .slice(0, 16)
    .join(' ');
}

function sanitizeSoroArticleAttribute(tagName, attribute) {
  const { name, value } = attribute;
  const tagAttributes = SORO_ARTICLE_TAG_ATTRIBUTES[tagName];
  if (!SORO_ARTICLE_GLOBAL_ATTRIBUTES.has(name) && !tagAttributes?.has(name)) return '';
  if (value.length > 4096) return '';

  if (name === 'class') {
    const safeClass = sanitizeSoroArticleClass(value);
    return safeClass ? ` class="${esc(safeClass)}"` : '';
  }
  if (name === 'dir') {
    const safeDir = decodeSoroHtmlAttribute(value).toLowerCase();
    return ['auto', 'ltr', 'rtl'].includes(safeDir) ? ` dir="${safeDir}"` : '';
  }
  if (name === 'lang') {
    const safeLang = decodeSoroHtmlAttribute(value);
    return /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i.test(safeLang) ? ` lang="${safeLang}"` : '';
  }
  if (name === 'href' || name === 'src') {
    const safeUrl = sanitizeSoroArticleUrl(value, name);
    return safeUrl ? ` ${name}="${esc(safeUrl)}"` : '';
  }
  if (name === 'target') {
    const target = decodeSoroHtmlAttribute(value).toLowerCase();
    return target === '_blank' || target === '_self' ? ` target="${target}"` : '';
  }
  if (name === 'loading') {
    const loading = decodeSoroHtmlAttribute(value).toLowerCase();
    return loading === 'lazy' || loading === 'eager' ? ` loading="${loading}"` : '';
  }
  if (name === 'decoding') {
    const decoding = decodeSoroHtmlAttribute(value).toLowerCase();
    return ['async', 'auto', 'sync'].includes(decoding) ? ` decoding="${decoding}"` : '';
  }
  if (['height', 'width', 'colspan', 'rowspan', 'start', 'value'].includes(name)) {
    const number = decodeSoroHtmlAttribute(value);
    return /^-?\d{1,6}$/.test(number) ? ` ${name}="${number}"` : '';
  }
  if (name === 'scope') {
    const scope = decodeSoroHtmlAttribute(value).toLowerCase();
    return ['col', 'colgroup', 'row', 'rowgroup'].includes(scope) ? ` scope="${scope}"` : '';
  }
  if (name === 'type' && tagName === 'ol') {
    const type = decodeSoroHtmlAttribute(value);
    return ['1', 'a', 'A', 'i', 'I'].includes(type) ? ` type="${type}"` : '';
  }
  if (name === 'reversed') return ' reversed';

  const safeText = decodeSoroHtmlAttribute(value.slice(0, 2048));
  return safeText ? ` ${name}="${esc(safeText)}"` : '';
}

function sanitizeSoroArticleHtml(html) {
  const input = String(html ?? '');
  const output = [];
  const openTags = [];
  let index = 0;

  while (index < input.length) {
    const tagStart = input.indexOf('<', index);
    if (tagStart < 0) {
      output.push(input.slice(index));
      break;
    }
    output.push(input.slice(index, tagStart));

    if (input.startsWith('<!--', tagStart)) {
      const commentEnd = input.indexOf('-->', tagStart + 4);
      index = commentEnd < 0 ? input.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findSoroHtmlTagEnd(input, tagStart + 1);
    if (tagEnd < 0) {
      const fallbackEnd = input.indexOf('>', tagStart + 1);
      if (fallbackEnd >= 0 && /^<\s*\/?[a-z]/i.test(input.slice(tagStart, fallbackEnd + 1))) {
        // A quote that never closes makes the token ambiguous. Discard that
        // token through its next delimiter rather than letting attribute-like
        // text or a browser repair heuristic reinterpret it.
        index = fallbackEnd + 1;
        continue;
      }
      output.push('&lt;');
      index = tagStart + 1;
      continue;
    }

    const rawTag = input.slice(tagStart + 1, tagEnd);
    const closingMatch = rawTag.match(/^\s*\/\s*([a-z0-9:-]+)/i);
    if (closingMatch) {
      const tagName = closingMatch[1].toLowerCase();
      const openIndex = openTags.lastIndexOf(tagName);
      if (SORO_ARTICLE_ALLOWED_TAGS.has(tagName) && openIndex >= 0) {
        while (openTags.length > openIndex) output.push(`</${openTags.pop()}>`);
      }
      index = tagEnd + 1;
      continue;
    }

    const openingMatch = rawTag.match(/^\s*([a-z0-9:-]+)/i);
    if (!openingMatch) {
      index = tagEnd + 1;
      continue;
    }
    const tagName = openingMatch[1].toLowerCase();
    if (SORO_ARTICLE_DROP_CONTENT_TAGS.has(tagName)) {
      const closePattern = new RegExp(`<\\s*\\/\\s*${escapeRegExp(tagName)}\\b[^>]*>`, 'gi');
      closePattern.lastIndex = tagEnd + 1;
      const closeMatch = closePattern.exec(input);
      index = closeMatch ? closePattern.lastIndex : input.length;
      continue;
    }
    if (SORO_ARTICLE_DROP_TAGS.has(tagName)) {
      index = tagEnd + 1;
      continue;
    }
    if (!SORO_ARTICLE_ALLOWED_TAGS.has(tagName)) {
      index = tagEnd + 1;
      continue;
    }

    const attributesSource = rawTag.slice(openingMatch[0].length);
    const seenAttributes = new Set();
    let safeAttributes = '';
    let targetBlank = false;
    for (const attribute of parseSoroHtmlAttributes(attributesSource)) {
      if (seenAttributes.has(attribute.name)) continue;
      seenAttributes.add(attribute.name);
      const safeAttribute = sanitizeSoroArticleAttribute(tagName, attribute);
      if (!safeAttribute) continue;
      safeAttributes += safeAttribute;
      if (attribute.name === 'target' && safeAttribute.includes('_blank')) targetBlank = true;
    }
    if (tagName === 'a' && targetBlank) safeAttributes += ' rel="noopener noreferrer"';

    const isVoid = SORO_ARTICLE_VOID_TAGS.has(tagName);
    if (!isVoid && openTags.length >= SORO_ARTICLE_MAX_NESTING) {
      index = tagEnd + 1;
      continue;
    }
    output.push(`<${tagName}${safeAttributes}>`);
    if (!isVoid) openTags.push(tagName);
    index = tagEnd + 1;
  }

  while (openTags.length) output.push(`</${openTags.pop()}>`);
  return output.join('');
}

export function sanitizeSoroArticleHtmlForTests(html) {
  return sanitizeSoroArticleHtml(html);
}

function replaceHtmlTag(html, pattern, replacement) {
  return pattern.test(html) ? html.replace(pattern, replacement) : html;
}

function parseSoroRss(xml) {
  const items = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  return items
    .map((match) => {
      const item = match[1];
      const title = readRssTag(item, 'title');
      const link = readRssTag(item, 'link');
      const slug = extractSlugFromUrl(link);
      const description = readRssTag(item, 'description');
      const pubDate = readRssTag(item, 'pubDate');
      const guid = readRssTag(item, 'guid');
      const content = readRssTag(item, 'content:encoded');
      const mediaImage =
        sanitizeUrl(readRssAttr(item, 'media:(?:content|thumbnail)', 'url')) ||
        sanitizeUrl(readRssAttr(item, 'enclosure', 'url'));
      const image = mediaImage || firstImageFromHtml(content);
      return {
        title,
        slug,
        link,
        description,
        pubDate,
        guid,
        content,
        image,
      };
    })
    .filter((article) => article.title && article.slug && article.content);
}

function isLikelyValidSoroFeed(xml, articles) {
  return (
    typeof xml === 'string' &&
    xml.length > 0 &&
    xml.length <= SORO_RSS_MAX_BYTES &&
    /<rss\b/i.test(xml) &&
    Array.isArray(articles) &&
    articles.length > 0
  );
}

async function readSoroBackup(env) {
  if (!env.SORO_RSS_BACKUP) return { text: '', articles: [] };
  const text = (await env.SORO_RSS_BACKUP.get(SORO_RSS_BACKUP_KEY)) || '';
  const articles = text ? parseSoroRss(text) : [];
  return { text, articles };
}

async function readSoroHiddenSlugs(env) {
  if (!env.SORO_RSS_BACKUP) return new Set();
  const text = (await env.SORO_RSS_BACKUP.get(SORO_HIDDEN_SLUGS_KEY)) || '[]';
  try {
    const slugs = JSON.parse(text);
    if (!Array.isArray(slugs)) return new Set();
    return new Set(slugs.filter((slug) => typeof slug === 'string' && isValidSoroSlug(slug)));
  } catch {
    return new Set();
  }
}

async function writeSoroHiddenSlugs(env, hiddenSlugs) {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  const slugs = [...hiddenSlugs].filter(isValidSoroSlug).sort();
  await env.SORO_RSS_BACKUP.put(SORO_HIDDEN_SLUGS_KEY, JSON.stringify(slugs, null, 2));
  return 'written';
}

function normalizeSoroBlogCacheVersion(value) {
  const version = String(value || '').trim();
  if (!version || version.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(version)) return '0';
  return version;
}

async function readSoroBlogCacheVersion(env) {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  const text = await env.SORO_RSS_BACKUP.get(SORO_BLOG_CACHE_VERSION_KEY);
  if (!text) return '0';
  try {
    const data = JSON.parse(text);
    return normalizeSoroBlogCacheVersion(data?.version);
  } catch {
    return normalizeSoroBlogCacheVersion(text);
  }
}

function createSoroBlogCacheVersion() {
  const suffix = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${suffix}`;
}

async function touchSoroBlogCacheVersion(env, reason = 'content') {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  const updatedAt = new Date().toISOString();
  const version = createSoroBlogCacheVersion();
  await env.SORO_RSS_BACKUP.put(
    SORO_BLOG_CACHE_VERSION_KEY,
    JSON.stringify({ version, updatedAt, reason }),
  );
  return version;
}

function soroBlogCacheHeaders(cacheVersion) {
  const version = normalizeSoroBlogCacheVersion(cacheVersion);
  return {
    'Cache-Control': SORO_BLOG_HTML_CACHE,
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    Expires: '0',
    Pragma: 'no-cache',
    'X-Soro-Blog-Cache-Version': version,
    ETag: `W/"soro-blog-${version}"`,
  };
}

function injectSoroBlogCacheVersion(html, cacheVersion) {
  const version = normalizeSoroBlogCacheVersion(cacheVersion);
  const meta = `  <meta name="soro-blog-cache-version" content="${esc(version)}">`;
  return html.includes('</head>') ? html.replace('</head>', `${meta}\n</head>`) : html;
}

function filterVisibleSoroArticles(articles, hiddenSlugs) {
  if (!hiddenSlugs?.size) return articles;
  return articles.filter((article) => !hiddenSlugs.has(article.slug));
}

async function writeSoroBackup(env, text, articles, previousText, previousArticles) {
  if (!env.SORO_RSS_BACKUP) return 'unbound';
  if (text === previousText) return 'unchanged';
  if (previousArticles.length && articles.length < previousArticles.length) return 'skip-smaller';

  const metadata = {
    updatedAt: new Date().toISOString(),
    itemCount: articles.length,
    bytes: text.length,
  };
  const cacheVersion = {
    version: createSoroBlogCacheVersion(),
    updatedAt: metadata.updatedAt,
    reason: 'rss-backup',
  };
  const write = Promise.all([
    env.SORO_RSS_BACKUP.put(SORO_RSS_BACKUP_KEY, text),
    env.SORO_RSS_BACKUP.put(SORO_RSS_BACKUP_META_KEY, JSON.stringify(metadata)),
    env.SORO_RSS_BACKUP.put(SORO_BLOG_CACHE_VERSION_KEY, JSON.stringify(cacheVersion)),
  ]);
  await write;
  return 'written';
}

async function fetchLiveSoroRss(env) {
  const rssUrl = String(env.SORO_RSS_URL || SORO_RSS_DEFAULT_URL).trim();
  return fetchAndConsumeWithTimeout(
    rssUrl,
    {
      headers: {
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
      },
    },
    SORO_RSS_FETCH_TIMEOUT_MS,
    async (response, signal) => {
      if (!response.ok) {
        await cancelResponseBody(response, 'SORO_RSS_HTTP_ERROR');
        throw new Error(`Soro RSS HTTP ${response.status}`);
      }
      let bytes;
      try {
        bytes = await readResponseBodyLimited(response, SORO_RSS_MAX_BYTES, signal);
      } catch (error) {
        if (error instanceof ResponseBodyTooLargeError) throw new Error('Soro RSS too large');
        throw error;
      }
      const text = new TextDecoder().decode(bytes);
      const articles = parseSoroRss(text);
      if (!isLikelyValidSoroFeed(text, articles)) throw new Error('Soro RSS invalid');
      return { text, articles };
    },
  );
}

async function loadSoroFeeds(env, options = {}) {
  const backup = await readSoroBackup(env);
  try {
    const live = await fetchLiveSoroRss(env);
    const backupStatus = await writeSoroBackup(
      env,
      live.text,
      live.articles,
      backup.text,
      backup.articles,
    );
    const imageStatus = options.mirrorImages
      ? await mirrorSoroImages(env, live.articles, { fetchMissing: true })
      : 'skipped';
    return { live, backup, source: 'live', backupStatus, imageStatus };
  } catch (error) {
    console.warn('[SoroBlog] live RSS unavailable:', error?.message || error);
    const imageStatus = options.mirrorImages
      ? await mirrorSoroImages(env, backup.articles, { fetchMissing: false })
      : 'skipped';
    return {
      live: { text: '', articles: [] },
      backup,
      source: 'backup',
      backupStatus: 'live-error',
      imageStatus,
    };
  }
}

function queueSoroBackgroundRefresh(env, ctx) {
  if (!ctx?.waitUntil || !env.SORO_RSS_BACKUP) return;
  const now = Date.now();
  if (
    soroBackgroundRefreshPromise &&
    now - soroBackgroundRefreshStartedAt < SORO_BACKGROUND_REFRESH_MIN_INTERVAL_MS
  ) {
    ctx.waitUntil(soroBackgroundRefreshPromise);
    return;
  }
  if (now - soroBackgroundRefreshStartedAt < SORO_BACKGROUND_REFRESH_MIN_INTERVAL_MS) return;

  soroBackgroundRefreshStartedAt = now;
  const refresh = loadSoroFeeds(env, { mirrorImages: true }).catch((error) => {
    console.warn('[SoroBlog] background refresh unavailable:', error?.message || error);
  });
  const tracked = refresh.finally(() => {
    if (soroBackgroundRefreshPromise === tracked) soroBackgroundRefreshPromise = null;
  });
  soroBackgroundRefreshPromise = tracked;
  ctx.waitUntil(tracked);
}

async function loadSoroFeedsForPublic(env, ctx, options = {}) {
  const backup = await readSoroBackup(env);
  if (backup.articles.length > 0) {
    queueSoroBackgroundRefresh(env, ctx);
    return {
      live: { text: '', articles: [] },
      backup,
      source: 'backup',
      backupStatus: 'cached',
    };
  }

  return loadSoroFeeds(env, { mirrorImages: Boolean(options.mirrorImages) });
}

function findSoroArticle(feeds, slug) {
  const liveArticle = feeds.live.articles.find((article) => article.slug === slug);
  if (liveArticle) return { article: liveArticle, source: 'live' };
  const backupArticle = feeds.backup.articles.find((article) => article.slug === slug);
  if (backupArticle) return { article: backupArticle, source: 'backup' };
  return { article: null, source: '' };
}

function isPotentialSoroArticlePath(pathname) {
  const match = pathname.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (!match) return '';
  const slug = match[1];
  const reserved = new Set([
    'about',
    'blog',
    'privacy',
    'terms',
    'faq',
    'history',
    'designsystem',
    'landing',
    'changelog',
    'roadmap',
    'index',
    'robots',
    'sitemap',
  ]);
  return reserved.has(slug) ? '' : slug;
}

function isPotentialSoroBlogArticlePath(pathname) {
  const match = pathname.match(/^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  return match ? match[1] : '';
}

function renderSoroArticleBodyHtml(article, image, published, blogUrl, safeContent) {
  return `<div class="soro-blog">
    <article class="soro-blog-article">
      <div class="soro-blog-header">
        <a class="soro-blog-back" href="${esc(blogUrl)}"><span class="soro-blog-back-arrow" aria-hidden="true">&larr;</span> <span class="soro-blog-back-label">All articles</span></a>
      </div>
      <header>
        <h1 class="soro-blog-article-title">${esc(article.title)}</h1>
        ${published ? `<time class="soro-blog-article-date" datetime="${esc(published)}">${esc(article.pubDate)}</time>` : ''}
      </header>
      ${image ? `<img class="soro-blog-article-image" src="${esc(image)}" alt="${esc(article.title)}">` : ''}
      <div class="soro-blog-article-content">${safeContent}</div>
    </article>
  </div>`;
}

function renderSoroArticleInBlogShell(templateHtml, article, requestUrl, source) {
  const url = new URL(requestUrl);
  const pageUrl = `${url.origin}${soroArticlePath(article.slug)}`;
  const blogUrl = `${url.origin}/blog`;
  const title = `${article.title} · MUSIXQUARE`;
  const description = article.description || 'MUSIXQUARE blog article.';
  const image = soroArticleImageUrl(article, url.origin, source);
  const published = article.pubDate ? new Date(article.pubDate).toISOString() : '';
  const safeContent = sanitizeSoroArticleHtml(article.content);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    description,
    datePublished: published || undefined,
    image,
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    publisher: {
      '@type': 'Organization',
      name: 'MUSIXQUARE',
      url: url.origin,
    },
  };
  const articleHtml = renderSoroArticleBodyHtml(article, image, published, blogUrl, safeContent);

  let html = templateHtml
    .replace('<div id="soro-blog"></div>', `<div id="soro-blog">${articleHtml}</div>`)
    .replace(
      /\n?<script src="https:\/\/app\.trysoro\.com\/api\/embed\/a07c133f-e3b9-401e-a076-ee36124598a7" defer><\/script>/,
      '',
    )
    .replace(
      /<body\b([^>]*)>/i,
      (_match, attributes) =>
        `<body${attributes} data-soro-source="${esc(source)}" data-soro-view="article">`,
    )
    .replace('<h2>Latest articles</h2>', '<h2>Article</h2>');

  html = replaceHtmlTag(html, /<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = replaceHtmlTag(
    html,
    /<link rel="canonical" href="[^"]*">/i,
    `<link rel="canonical" href="${esc(pageUrl)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta name="description" content="[^"]*">/i,
    `<meta name="description" content="${esc(description)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:title" content="[^"]*">/i,
    `<meta property="og:title" content="${esc(article.title)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:description" content="[^"]*">/i,
    `<meta property="og:description" content="${esc(description)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:type" content="[^"]*">/i,
    '<meta property="og:type" content="article">',
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:url" content="[^"]*">/i,
    `<meta property="og:url" content="${esc(pageUrl)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:image" content="[^"]*">/i,
    `<meta property="og:image" content="${esc(image)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta property="og:image:alt" content="[^"]*">/i,
    `<meta property="og:image:alt" content="${esc(article.title)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta name="twitter:title" content="[^"]*">/i,
    `<meta name="twitter:title" content="${esc(article.title)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta name="twitter:description" content="[^"]*">/i,
    `<meta name="twitter:description" content="${esc(description)}">`,
  );
  html = replaceHtmlTag(
    html,
    /<meta name="twitter:image" content="[^"]*">/i,
    `<meta name="twitter:image" content="${esc(image)}">`,
  );
  return html.replace(
    '</head>',
    `  <script type="application/ld+json">${serializeJsonForHtmlScript(jsonLd)}</script>\n</head>`,
  );
}

function renderSoroArticleHtml(article, requestUrl, source, templateHtml = '') {
  if (templateHtml) return renderSoroArticleInBlogShell(templateHtml, article, requestUrl, source);

  const url = new URL(requestUrl);
  const pageUrl = `${url.origin}${soroArticlePath(article.slug)}`;
  const blogUrl = `${url.origin}/blog`;
  const title = `${article.title} · MUSIXQUARE`;
  const description = article.description || 'MUSIXQUARE blog article.';
  const image = soroArticleImageUrl(article, url.origin, source);
  const published = article.pubDate ? new Date(article.pubDate).toISOString() : '';
  const safeContent = sanitizeSoroArticleHtml(article.content);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    description,
    datePublished: published || undefined,
    image,
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    publisher: {
      '@type': 'Organization',
      name: 'MUSIXQUARE',
      url: url.origin,
    },
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#1a1a1a">
  <title>${esc(title)}</title>
  <link rel="canonical" href="${esc(pageUrl)}">
  <link rel="alternate" type="application/rss+xml" title="MUSIXQUARE Blog RSS" href="${esc(String(SORO_RSS_DEFAULT_URL))}">
  <meta name="description" content="${esc(description)}">
  <meta property="og:title" content="${esc(article.title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="MUSIXQUARE">
  <meta property="og:locale" content="en_US">
  <meta property="og:url" content="${esc(pageUrl)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:image:alt" content="${esc(article.title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(article.title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(image)}">
  <link rel="icon" href="/designsystem/assets/favicon.svg">
  <link rel="preload" href="/designsystem/fonts/PretendardVariable.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/designsystem/src_ref/pretendard.css">
  <link rel="stylesheet" href="/designsystem/colors_and_type.css">
  <link rel="stylesheet" href="/editorial-base.css">
  <style>
    .soro-article-page { max-width: 880px; padding-top: 168px; }
    .soro-article-back { display: inline-flex; gap: 8px; margin-bottom: 34px; color: #c6cbd6; font-size: 14px; font-weight: 800; text-decoration: none; }
    .soro-article-back-label { text-decoration: underline; text-underline-offset: 4px; }
    .soro-article-title { margin: 0 0 14px; color: var(--text-main); font-size: clamp(38px, 6vw, 72px); line-height: 1.02; letter-spacing: 0; }
    .soro-article-meta { margin: 0 0 32px; color: #9aa3b2; font-size: 14px; font-weight: 800; }
    .soro-article-image { width: 100%; margin: 0 0 38px; display: block; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; background: var(--surface-2); }
    .soro-article-content { color: #d7dbe4; font-size: 18px; line-height: 1.78; }
    .soro-article-content p { margin: 0 0 18px; color: #d7dbe4; }
    .soro-article-content h2, .soro-article-content h3 { color: var(--text-main); letter-spacing: 0; }
    .soro-article-content h2 { margin: 44px 0 16px; font-size: 31px; line-height: 1.18; }
    .soro-article-content h3 { margin: 32px 0 14px; font-size: 23px; line-height: 1.25; }
    .soro-article-content ul, .soro-article-content ol { margin: 0 0 18px; padding-left: 24px; }
    .soro-article-content li { margin-bottom: 8px; }
    .soro-article-content a { color: #86b7ff; text-decoration: underline; text-underline-offset: 3px; }
    .soro-article-content img { max-width: 100%; height: auto; border-radius: 8px; }
    @media (max-width: 720px) {
      .soro-article-page { padding-top: 118px; }
      .soro-article-content { font-size: 16px; }
      .soro-article-content h2 { font-size: 26px; }
    }
  </style>
  <script type="application/ld+json">${serializeJsonForHtmlScript(jsonLd)}</script>
</head>
<body class="editorial-page editorial-blog" data-soro-source="${esc(source)}" data-soro-view="article">
<header class="lp-header">
  <div class="lp-header-progress" aria-hidden="true"></div>
  <a class="lp-logo" href="https://musixquare.com" aria-label="MUSIXQUARE home">
    <span class="editorial-wordmark" aria-hidden="true"></span>
  </a>
  <a class="lp-try" href="https://musixquare.com" aria-label="Try MUSIXQUARE now">
    <span class="lp-try__dot" aria-hidden="true"></span>
    <span>Try it now</span>
  </a>
</header>
<nav class="editorial-site-tabs" aria-label="MUSIXQUARE editorial pages">
  <div class="editorial-site-tabs__inner">
    <a class="editorial-site-tab" href="/about">About</a>
    <a class="editorial-site-tab is-active" href="/blog" aria-current="page">Blog</a>
    <a class="editorial-site-tab" href="/history">History</a>
    <a class="editorial-site-tab" href="/designsystem">Design</a>
  </div>
</nav>
<main class="page soro-article-page">
  <article>
    <a class="soro-article-back" href="${esc(blogUrl)}"><span class="soro-article-back-arrow" aria-hidden="true">&larr;</span> <span class="soro-article-back-label">All articles</span></a>
    <header>
      <h1 class="soro-article-title">${esc(article.title)}</h1>
      ${published ? `<time class="soro-article-meta" datetime="${esc(published)}">${esc(article.pubDate)}</time>` : ''}
    </header>
    ${image ? `<img class="soro-article-image" src="${esc(image)}" alt="${esc(article.title)}">` : ''}
    <div class="soro-article-content">${safeContent}</div>
  </article>
</main>
<footer>
  <span>
    © 2026 MUSIXQUARE
    <span aria-hidden="true">·</span>
    <a href="mailto:contact@musixquare.com">contact@musixquare.com</a>
  </span>
  <span>
    <a href="https://musixquare.com" target="_blank" rel="noopener noreferrer">App</a>
    <a href="https://github.com/hiefny/MUSIXQUARE" target="_blank" rel="noopener noreferrer">GitHub</a>
    <a href="https://discord.gg/PmmFhGTBsX" target="_blank" rel="noopener noreferrer">Discord</a>
  </span>
</footer>
</body>
</html>`;
}

async function serveSoroArticlePage(request, env, slug, ctx) {
  let [feeds, hiddenSlugs] = await Promise.all([
    loadSoroFeedsForPublic(env, ctx),
    readSoroHiddenSlugs(env),
  ]);
  const cacheVersion = await readSoroBlogCacheVersion(env);
  if (hiddenSlugs.has(slug)) return null;
  let { article, source } = findSoroArticle(feeds, slug);
  if (!article && feeds.source === 'backup') {
    feeds = await loadSoroFeeds(env);
    ({ article, source } = findSoroArticle(feeds, slug));
    if (hiddenSlugs.has(slug)) return null;
  }
  if (!article) return null;
  const imageStatus = mapSoroArticleImagePath(article);

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    ...soroBlogCacheHeaders(cacheVersion),
    'X-Soro-Article-Source': source,
    'X-Soro-Backup-Status': feeds.backupStatus || 'unknown',
    'X-Soro-Image-Status': imageStatus,
  };
  if (request.method === 'HEAD') {
    return withSecurityHeaders(new Response(null, { status: 200, headers }), headers);
  }

  const shellResponse = await fetchAsset(env, request, '/blog/index.html');
  const shellContentType = shellResponse.headers.get('content-type') || '';
  const shellHtml = shellContentType.includes('text/html') ? await shellResponse.text() : '';
  const html = injectSoroBlogCacheVersion(
    renderSoroArticleHtml(article, request.url, source, shellHtml),
    cacheVersion,
  );
  return withSecurityHeaders(
    new Response(html, {
      status: 200,
      headers,
    }),
    headers,
  );
}

async function hasSoroArticlePublic(env, ctx, slug) {
  const [feeds, hiddenSlugs] = await Promise.all([
    loadSoroFeedsForPublic(env, ctx),
    readSoroHiddenSlugs(env),
  ]);
  if (hiddenSlugs.has(slug)) return false;
  const { article } = findSoroArticle(feeds, slug);
  return Boolean(article);
}

async function findSoroImageArticleForKey(env, key) {
  const backup = await readSoroBackup(env);
  let article = backup.articles.find((candidate) => soroImageKey(candidate) === key);
  if (article) return article;

  try {
    const feeds = await loadSoroFeeds(env);
    article = [...feeds.live.articles, ...feeds.backup.articles].find(
      (candidate) => soroImageKey(candidate) === key,
    );
    return article || null;
  } catch {
    return null;
  }
}

async function serveSoroBlogIndex(request, env, ctx) {
  const response = await fetchAsset(env, request, '/blog/index.html');
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return withSecurityHeaders(response);

  const [feeds, hiddenSlugs] = await Promise.all([
    loadSoroFeedsForPublic(env, ctx),
    readSoroHiddenSlugs(env),
  ]);
  const cacheVersion = await readSoroBlogCacheVersion(env);
  const source = feeds.source === 'live' ? 'live' : 'backup';
  const articles = sortedSoroArticles(
    filterVisibleSoroArticles(
      source === 'live' ? feeds.live.articles : feeds.backup.articles,
      hiddenSlugs,
    ),
  );
  const imageStatus = mapSoroListImagePaths(articles);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    ...soroBlogCacheHeaders(cacheVersion),
    'X-Soro-Index-Source': source,
    'X-Soro-Backup-Status': feeds.backupStatus || 'unknown',
    'X-Soro-Image-Status': imageStatus || 'none',
  };

  if (request.method === 'HEAD') {
    return withSecurityHeaders(
      new Response(null, { status: response.status, headers: response.headers }),
      headers,
    );
  }

  const origin = new URL(request.url).origin;
  const blogHtml = renderSoroBlogListHtml(articles, origin, source);
  let html = await response.text();
  html = html
    .replace('<div id="soro-blog"></div>', `<div id="soro-blog">${blogHtml}</div>`)
    .replace(
      /\n?<script src="https:\/\/app\.trysoro\.com\/api\/embed\/a07c133f-e3b9-401e-a076-ee36124598a7" defer><\/script>/,
      '',
    );
  html = injectSoroBlogCacheVersion(html, cacheVersion);

  return withSecurityHeaders(
    new Response(html, { status: response.status, headers: response.headers }),
    headers,
  );
}

async function serveSoroImage(request, env, key) {
  if (!env.SORO_IMAGE_BUCKET) {
    return withSecurityHeaders(new Response('Not found', { status: 404 }));
  }

  let object = await env.SORO_IMAGE_BUCKET.get(key);
  if (!object && request.method !== 'HEAD') {
    const article = await findSoroImageArticleForKey(env, key);
    if (article) {
      await ensureSoroImageMirror(env, article, { fetchMissing: true });
      object = await env.SORO_IMAGE_BUCKET.get(key);
    }
  }
  if (!object) return withSecurityHeaders(new Response('Not found', { status: 404 }));

  const headers = {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': object.httpMetadata?.cacheControl || SORO_IMAGE_CACHE,
  };
  if (object.httpEtag) headers.ETag = object.httpEtag;

  if (request.method === 'HEAD') {
    return withSecurityHeaders(new Response(null, { status: 200, headers }), headers);
  }

  return withSecurityHeaders(new Response(object.body, { status: 200, headers }), headers);
}

async function fetchAsset(env, request, pathname = null) {
  const assetUrl = new URL(request.url);
  if (pathname) assetUrl.pathname = pathname;
  assetUrl.search = pathname ? '' : assetUrl.search;
  return env.ASSETS.fetch(new Request(assetUrl, request));
}

async function serveInvitePage(request, env, code) {
  const response = await fetchAsset(env, request, '/index.html');
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return withSecurityHeaders(response);
  const inviteHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    ...APP_SHELL_FRESH_CACHE_HEADERS,
    // Invite URLs can expose a live or persistent room code when shared in a
    // crawlable context. Keep rich Open Graph previews, but do not let search
    // engines turn private entry points into search results.
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Invite-Rewrite': code,
  };
  if (request.method === 'HEAD') {
    return withSecurityHeaders(
      new Response(null, { status: response.status, headers: response.headers }),
      inviteHeaders,
    );
  }
  const html = rewriteInviteMeta(await response.text(), code, new URL(request.url).origin);
  return withSecurityHeaders(
    new Response(html, { status: response.status, headers: response.headers }),
    inviteHeaders,
  );
}

function redirectTarget(pathname) {
  const lower = pathname.toLowerCase();
  if (['/landing', '/landing/'].includes(lower)) return '/about';
  if (['/changelog', '/changelog/', '/roadmap', '/roadmap/'].includes(lower)) return '/history';
  const canonical = new Map([
    ['/about', '/about'],
    ['/blog', '/blog'],
    ['/privacy', '/privacy'],
    ['/terms', '/terms'],
    ['/faq', '/faq'],
    ['/developers', '/developers'],
    ['/history', '/history'],
    ['/designsystem', '/designsystem'],
  ]);
  if (pathname !== lower && canonical.has(lower.replace(/\/$/, ''))) {
    return canonical.get(lower.replace(/\/$/, ''));
  }
  return null;
}

function routeStaticPath(pathname) {
  const path = pathname.toLowerCase();
  if (path === '/about' || path === '/about/') return '/about.html';
  if (path === '/blog' || path === '/blog/') return '/blog/index.html';
  if (path === '/privacy' || path === '/privacy/') return '/privacy.html';
  if (path === '/terms' || path === '/terms/') return '/terms.html';
  if (path === '/faq' || path === '/faq/') return '/faq.html';
  if (path === '/developers' || path === '/developers/') return '/developers.html';
  if (path === '/history' || path === '/history/') return '/history/index.html';
  if (path === '/designsystem' || path === '/designsystem/') return '/designsystem/index.html';
  return null;
}

function cacheHeadersForPath(pathname, assetPathname = pathname) {
  if (assetPathname === '/service-worker.js') return { 'Cache-Control': 'no-cache' };
  if (/^\/og-.+\.png$/.test(assetPathname)) {
    return { 'Cache-Control': 'public, max-age=86400, s-maxage=604800' };
  }
  if (
    assetPathname.startsWith('/assets/') ||
    assetPathname.startsWith('/fonts/') ||
    assetPathname.startsWith('/landing/') ||
    assetPathname.startsWith('/designsystem/fonts/') ||
    assetPathname.startsWith('/designsystem/assets/')
  ) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  if (
    [
      '/about',
      '/blog',
      '/privacy',
      '/terms',
      '/faq',
      '/developers',
      '/history',
      '/designsystem',
    ].includes(pathname.toLowerCase().replace(/\/$/, ''))
  ) {
    return {
      'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
    };
  }
  return {};
}

function isLocalHttpHost(hostname) {
  const normalized = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/:\d+$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLocalHttpRequest(request, url) {
  return (
    isLocalHttpHost(url.hostname) ||
    isLocalHttpHost(url.host) ||
    isLocalHttpHost(request.headers.get('host'))
  );
}

async function serveStatic(request, env, ctx) {
  const url = new URL(request.url);
  const redirect = redirectTarget(url.pathname);
  if (redirect) return Response.redirect(new URL(redirect, url), 301);

  if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    return withSecurityHeaders(
      await fetchAsset(env, request, '/index.html'),
      APP_SHELL_FRESH_CACHE_HEADERS,
    );
  }

  if (url.pathname === '/index.html' && (request.method === 'GET' || request.method === 'HEAD')) {
    return withSecurityHeaders(
      await fetchAsset(env, request, '/index.html'),
      APP_SHELL_FRESH_CACHE_HEADERS,
    );
  }

  const inviteMatch = url.pathname.match(/^\/(\d{6})$/);
  if (inviteMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveInvitePage(request, env, inviteMatch[1]);
  }

  if (/^\/og\/invite\/\d{6}\.png$/.test(url.pathname)) {
    const response = await fetchAsset(env, request, '/og-invite.png');
    return withSecurityHeaders(response, {
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-OG-Source': 'static',
    });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (url.pathname === '/blog' || url.pathname === '/blog/') {
      const post = url.searchParams.get('post') || '';
      if (isValidSoroSlug(post)) {
        const hiddenSlugs = await readSoroHiddenSlugs(env);
        if (!hiddenSlugs.has(post))
          return Response.redirect(new URL(soroArticlePath(post), url), 301);
      }
      return serveSoroBlogIndex(request, env, ctx);
    }

    const soroBlogSlug = isPotentialSoroBlogArticlePath(url.pathname);
    if (soroBlogSlug) {
      const canonicalPath = soroArticlePath(soroBlogSlug);
      if (url.pathname !== canonicalPath)
        return Response.redirect(new URL(canonicalPath, url), 301);
      const articleResponse = await serveSoroArticlePage(request, env, soroBlogSlug, ctx);
      return articleResponse || withSecurityHeaders(new Response('Not found', { status: 404 }));
    }

    const soroImageKey = soroImageKeyFromPathname(url.pathname);
    if (soroImageKey) return serveSoroImage(request, env, soroImageKey);

    const soroSlug = isPotentialSoroArticlePath(url.pathname);
    if (soroSlug) {
      if (await hasSoroArticlePublic(env, ctx, soroSlug)) {
        return Response.redirect(new URL(soroArticlePath(soroSlug), url), 301);
      }
    }
  }

  const assetPathname = routeStaticPath(url.pathname);
  const response = assetPathname
    ? await fetchAsset(env, request, assetPathname)
    : await fetchAsset(env, request);

  // Allow HEAD alongside GET so link unfurlers (Slack/Discord/iMessage) that
  // HEAD-probe before fetching don't see a broken-link 404 for SPA routes.
  // Keep this aligned with the GET+HEAD pairing at the invite path.
  if (
    response.status === 404 &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    (request.headers.get('Accept') || '').includes('text/html')
  ) {
    return withSecurityHeaders(
      await fetchAsset(env, request, '/index.html'),
      APP_SHELL_FRESH_CACHE_HEADERS,
    );
  }

  return withSecurityHeaders(response, {
    ...cacheHeadersForPath(url.pathname, assetPathname || url.pathname),
  });
}

export default {
  async scheduled(event, env, ctx) {
    const cron = typeof event?.cron === 'string' ? event.cron : null;
    if (cron === null || cron === '0 */6 * * *') {
      ctx.waitUntil(loadSoroFeeds(env, { mirrorImages: true }));
      ctx.waitUntil(cleanupExpiredAdminMetrics(env));
      ctx.waitUntil(cleanupExpiredProRoomAdminAudit(env));
      if (env.MUSIXQUARE_AUTH_DB) ctx.waitUntil(cleanupExpiredAccountSessions(env));
      if (env.MUSIXQUARE_AUTH_DB && getAdminDb(env)?.prepare) {
        // Repair sweep: the room Durable Object can finish decommissioning
        // through its own alarm without another admin DELETE request.
        ctx.waitUntil(retireDecommissionedAccountProRoomEdges(env));
      }
      if (getAdminDb(env)?.prepare && getProRoomAdminNamespace(env)) {
        // Repair the display/index mirror after a successful canonical room
        // activation whose best-effort D1 write was interrupted. Exact
        // generation and terminal-state predicates remain enforced by the
        // reconciliation update.
        ctx.waitUntil(
          (async () => {
            try {
              const db = getAdminDb(env);
              const rooms = await listAdminProRooms(db);
              await reconcileStaleAdminProRoomActivations(env, db, rooms);
            } catch (error) {
              console.warn('[PRO registry] activation-state reconciliation failed', error);
            }
          })(),
        );
      }
    }
    if (env.MUSIXQUARE_AUTH_DB && (cron === null || cron === '* * * * *')) {
      ctx.waitUntil(
        cleanupPendingAccountDeletions(env, {
          purgeProRoomAccountAuthority: (input) => purgeProRoomAccountAuthority(input, env),
        }),
      );
      if (getAdminDb(env)?.prepare) {
        ctx.waitUntil(
          retireDecommissionedAccountProRoomEdges(env, {
            sinceMs: Date.now() - 15 * 60 * 1000,
          }),
        );
      }
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mustUpgradeProtocol = url.protocol === 'http:' && !isLocalHttpRequest(request, url);
    const mustUseCanonicalHost = url.hostname === 'www.musixquare.com';
    const trailingInviteMatch =
      request.method === 'GET' || request.method === 'HEAD'
        ? url.pathname.match(/^\/(\d{6})\/$/)
        : null;
    if (mustUpgradeProtocol || mustUseCanonicalHost || trailingInviteMatch) {
      if (mustUpgradeProtocol) url.protocol = 'https:';
      if (mustUseCanonicalHost) url.hostname = 'musixquare.com';
      if (trailingInviteMatch) url.pathname = `/${trailingInviteMatch[1]}`;
      return withSecurityHeaders(Response.redirect(url, 308));
    }

    if (url.pathname.startsWith('/api/auth/')) {
      let rateKey = 'account-auth-mutation';
      let rateLimit = 120;
      let rateWindowSeconds = 60;
      if (url.pathname === '/api/auth/google/start') {
        rateKey = 'account-auth-start';
        // Match the advertised 100-device venue ceiling while retaining a
        // bounded per-IP OAuth initiation budget.
        rateLimit = 120;
        rateWindowSeconds = 10 * 60;
      } else if (url.pathname === '/api/auth/google/callback') {
        rateKey = 'account-auth-callback';
        rateLimit = 120;
        rateWindowSeconds = 10 * 60;
      } else if (url.pathname === '/api/auth/session') {
        // A 100-device venue can legitimately restore many tabs together.
        // This generous ceiling only bounds obviously automated D1 probing.
        rateKey = 'account-auth-session';
        rateLimit = 600;
      } else if (url.pathname === '/api/auth/stats') {
        // Aggregate-only reporting is optional and may flush concurrently for
        // many signed-in listeners behind one venue NAT. Isolate it so a
        // reporting burst cannot consume profile/logout mutation capacity.
        rateKey = 'account-auth-stats';
        rateLimit = 300;
      } else if (url.pathname === '/api/auth/room-assertion') {
        // A full 100-device room refreshes 60-second assertions every 40s:
        // roughly 150 requests/minute behind one venue NAT. Keep this separate
        // from low-frequency profile/logout mutations so a healthy room cannot
        // rate-limit its own identity leases and enter a retry storm.
        rateKey = 'account-auth-room-assertion';
        rateLimit = 600;
      }
      if (!(await checkRateLimit(request, rateKey, rateLimit, rateWindowSeconds))) {
        return json({ error: 'AUTH_RATE_LIMITED' }, 429, {
          'Retry-After': String(rateWindowSeconds),
        });
      }
      return withSecurityHeaders(
        await handleAccountAuthRequest(request, env, url, {
          purgeProRoomAccountAuthority: (input) => purgeProRoomAccountAuthority(input, env),
          ...(typeof ctx?.waitUntil === 'function'
            ? {
                deferAccountDeletion: (accountId) =>
                  ctx.waitUntil(
                    cleanupPendingAccountDeletions(
                      env,
                      {
                        purgeProRoomAccountAuthority: (input) =>
                          purgeProRoomAccountAuthority(input, env),
                      },
                      { accountId },
                    ),
                  ),
              }
            : {}),
        }),
      );
    }

    if (url.pathname.startsWith(`${PRO_ROOM_FACADE_PREFIX}/`)) {
      return handleProRoomFacade(request, env, url);
    }

    if (
      (url.pathname === '/admin' || url.pathname === '/admin/') &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return renderAdminPage(request, env);
    }

    if (ADMIN_PRO_ROOM_PATH_RE.test(url.pathname)) {
      return handleAdminProRooms(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_OWNER_RECOVERY_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomOwnerRecoveryClaim(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_STATE_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomState(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_LABEL_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomLabel(request, env, url.pathname);
    }

    if (ADMIN_PRO_ROOM_DELETE_PATH_RE.test(url.pathname)) {
      return handleAdminProRoomDelete(request, env, url.pathname);
    }

    if (ADMIN_DEVELOPER_API_KEY_PATH_RE.test(url.pathname)) {
      return handleAdminDeveloperApiKeys(request, env, url.pathname);
    }

    switch (url.pathname) {
      case '/api/security-config':
        return handleSecurityConfig(request, env);
      case '/api/capability-challenge':
        return handleCapabilityChallenge(request, env);
      case '/api/capability-token':
        return handleCapabilityToken(request, env);
      case '/api/youtube-search':
        return handleYoutubeSearch(request, env);
      case '/api/youtube-playlist-entry':
        return handleYoutubePlaylistEntry(request, env);
      case '/api/youtube-playlist-manifest':
        return handleYoutubePlaylistManifest(request, env);
      case '/api/get-turn-config':
        return handleTurnConfig(request, env);
      case '/api/cloudflare-realtime':
        return handleRealtime(request, env);
      case '/api/announcement/current':
        return handlePublicAnnouncement(request, env);
      case '/api/admin/login':
        return handleAdminLogin(request, env);
      case '/api/admin/logout':
        return handleAdminLogout(request, env);
      case '/api/admin/session':
        return handleAdminSession(request, env);
      case '/api/admin/metrics':
        return handleAdminMetrics(request, env);
      case '/api/admin/articles':
        return handleAdminArticles(request, env);
      case '/api/admin/articles/visibility':
        return handleAdminArticleVisibility(request, env);
      case '/api/admin/announcement':
        return handleAdminAnnouncement(request, env);
      default:
        return serveStatic(request, env, ctx);
    }
  },
};
