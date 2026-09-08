import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Catalog } from '../../../scripts/translation-catalog.ts';
export { loadCatalogs } from '../../../scripts/translation-catalog.ts';

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(body));
}

export function isLocalPreviewRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (host !== '127.0.0.1:4317' && host !== 'localhost:4317') return false;
  const origin = request.headers.origin;
  return (
    (!origin || origin === `http://${host}`) && request.headers['sec-fetch-site'] !== 'cross-site'
  );
}

/** Pure request/response boundary; callers install it only on the loopback preview server. */
export function handleCatalogRequest(
  request: IncomingMessage,
  response: ServerResponse,
  catalogs: Map<string, Catalog>,
): boolean {
  const rawUrl = request.url ?? '';
  if (!rawUrl.startsWith('/translation-preview/')) return false;
  if (!isLocalPreviewRequest(request)) {
    sendJson(response, 403, { error: 'Local preview requests only.' });
    return true;
  }
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    sendJson(response, 405, { error: 'Only GET is supported.' });
    return true;
  }
  const url = new URL(rawUrl, 'http://127.0.0.1:4317');
  if (url.pathname !== '/translation-preview/catalog') {
    sendJson(response, 404, { error: 'Unknown preview endpoint.' });
    return true;
  }
  const parameters = [...url.searchParams];
  const locale = url.searchParams.get('locale');
  if (
    parameters.length !== 1 ||
    parameters[0]?.[0] !== 'locale' ||
    !locale ||
    !catalogs.has(locale)
  ) {
    sendJson(response, 400, { error: 'Select an exact supported locale code.' });
    return true;
  }
  sendJson(response, 200, catalogs.get(locale));
  return true;
}
