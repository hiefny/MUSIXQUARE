#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const AUTH_SESSION_URL = 'https://musixquare.com/api/auth/session';
export const APP_PUBLIC_BOUNDARY_TIMEOUT_MS = 10_000;
const MUSIXQUARE_COOKIE_RE = /(?:^|[,\r\n]\s*)(?:__Host|__Secure)-mxqr_[^=;,]*=/;

async function readAnonymousSession() {
  const response = await fetch(AUTH_SESSION_URL, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(APP_PUBLIC_BOUNDARY_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Anonymous account session boundary returned invalid JSON');
  }
  return {
    status: response.status,
    cacheControl: response.headers.get('Cache-Control') || '',
    setCookie: response.headers.get('Set-Cookie'),
    payload,
  };
}

export async function verifyAnonymousAccountSessionBoundary({ read = readAnonymousSession } = {}) {
  const result = await read();
  if (
    result?.status !== 200 ||
    result.payload?.configured !== true ||
    result.payload?.authenticated !== false ||
    result.payload?.account !== null
  ) {
    throw new Error('Anonymous account session boundary returned an invalid projection');
  }
  if (
    !String(result.cacheControl || '')
      .toLowerCase()
      .includes('no-store')
  ) {
    throw new Error('Anonymous account session boundary is not no-store');
  }
  if (MUSIXQUARE_COOKIE_RE.test(String(result.setCookie || ''))) {
    throw new Error('Anonymous account session boundary unexpectedly issued a MUSIXQUARE cookie');
  }
  return {
    configured: true,
    anonymousSessionRejected: true,
  };
}

export async function main() {
  const boundary = await verifyAnonymousAccountSessionBoundary();
  console.log(JSON.stringify({ ok: true, boundary }));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
