const MARKER_HEADER = 'X-MXQR-Staging-Worker';
const MARKER_VALUE = 'invoked';

// This probe intentionally has no production bindings. It exists only to
// prove which requests execute Worker code before Static Assets.
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

function markedResponse(response, method) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set(MARKER_HEADER, MARKER_VALUE);
  headers.set('X-MXQR-Staging-Isolation', 'no-production-bindings');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function markerError(pathname, method) {
  const response = new Response(
    method === 'HEAD'
      ? null
      : JSON.stringify({
          error: 'STAGING_PROBE_ONLY',
          pathname,
        }),
    {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
  return markedResponse(response, method);
}

export default {
  async fetch(request, env) {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    if (method !== 'GET' && method !== 'HEAD') return markerError(url.pathname, method);

    const shellRequest = url.pathname === '/' || /^\/\d{6}\/?$/.test(url.pathname);
    const assetUrl = new URL(request.url);
    if (shellRequest) {
      assetUrl.pathname = '/index.html';
      assetUrl.search = '';
    }
    const response = await env.ASSETS.fetch(
      new Request(assetUrl, {
        method,
        headers: request.headers,
        redirect: 'manual',
      }),
    );
    return response.status === 404
      ? markerError(url.pathname, method)
      : markedResponse(response, method);
  },
};

export { MARKER_HEADER, MARKER_VALUE };
