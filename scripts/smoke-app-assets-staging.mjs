import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = String(process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/i.test(baseUrl)) {
  console.error('Usage: node scripts/smoke-app-assets-staging.mjs https://<staging-host>');
  process.exit(2);
}

const markerHeader = 'x-mxqr-staging-worker';
const stagingAssets = path.join(repoRoot, 'scratch', 'app-assets-staging-dist', 'assets');
const assetNames = await readdir(stagingAssets);
const samples = ['.js', '.css', '.woff2'].map((extension) => {
  const name = assetNames.find((candidate) => candidate.endsWith(extension));
  if (!name) throw new Error(`No ${extension} staging asset found`);
  return { extension, pathname: `/assets/${encodeURIComponent(name)}` };
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForResponse(pathname, predicate, init = {}) {
  let response;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual', ...init });
    if (predicate(response)) return response;
    if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return response;
}

for (const pathname of [
  '/',
  '/000001',
  '/api/security-config',
  '/service-worker.js',
  '/bootstrap.js',
]) {
  const response = await waitForResponse(
    pathname,
    (candidate) => candidate.headers.get(markerHeader) === 'invoked',
  );
  assert(response.headers.get(markerHeader) === 'invoked', `${pathname}: Worker marker missing`);
}

for (const sample of samples) {
  const response = await waitForResponse(
    sample.pathname,
    (candidate) => candidate.ok && candidate.headers.get(markerHeader) === null,
  );
  assert(response.ok, `${sample.pathname}: HTTP ${response.status}`);
  assert(
    response.headers.get(markerHeader) === null,
    `${sample.pathname}: Worker unexpectedly ran`,
  );
  assert(
    response.headers.get('cache-control') === 'public, max-age=31536000, immutable',
    `${sample.pathname}: cache-control drift`,
  );
  assert(
    response.headers.get('x-content-type-options') === 'nosniff',
    `${sample.pathname}: nosniff missing`,
  );
  assert(
    response.headers.get('strict-transport-security') ===
      'max-age=31536000; includeSubDomains; preload',
    `${sample.pathname}: HSTS drift`,
  );
  assert(
    response.headers.get('x-frame-options') === 'DENY',
    `${sample.pathname}: frame policy drift`,
  );
  assert(
    response.headers.get('referrer-policy') === 'strict-origin-when-cross-origin',
    `${sample.pathname}: referrer policy drift`,
  );
  assert(
    response.headers.get('permissions-policy')?.includes('display-capture=(self)') === true,
    `${sample.pathname}: permissions policy drift`,
  );
  assert(
    response.headers.get('content-security-policy')?.includes("default-src 'self'") === true,
    `${sample.pathname}: CSP missing`,
  );
  assert(
    response.headers.get('access-control-allow-origin') === null,
    `${sample.pathname}: CORS unexpectedly widened`,
  );
  const contentType = response.headers.get('content-type') || '';
  const expected =
    sample.extension === '.js'
      ? /javascript/i
      : sample.extension === '.css'
        ? /text\/css/i
        : /font\/woff2|application\/font-woff2/i;
  assert(expected.test(contentType), `${sample.pathname}: unexpected MIME ${contentType}`);

  const head = await fetch(`${baseUrl}${sample.pathname}`, {
    method: 'HEAD',
    redirect: 'manual',
  });
  assert(head.ok, `${sample.pathname}: HEAD HTTP ${head.status}`);
  assert(head.headers.get(markerHeader) === null, `${sample.pathname}: HEAD ran Worker`);
  assert(
    head.headers.get('cache-control') === 'public, max-age=31536000, immutable',
    `${sample.pathname}: HEAD cache-control drift`,
  );
}

const missing = await fetch(`${baseUrl}/assets/missing-ABCDEFGH.js`, { redirect: 'manual' });
assert(missing.status === 404, `missing asset: expected 404, got ${missing.status}`);
assert(
  !/text\/html/i.test(missing.headers.get('content-type') || ''),
  'missing asset: SPA HTML fallback leaked into module request',
);

console.log('[app-assets-staging] PASS: routing marker and response-header parity verified');
