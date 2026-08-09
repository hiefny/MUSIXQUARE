#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const AUTH_SESSION_URL = 'https://musixquare.com/api/auth/session';
const SECURITY_CONFIG_URL = 'https://musixquare.com/api/security-config';
const PAID_BOUNDARY_URL = 'https://musixquare.com/api/get-turn-config';
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

async function readCapabilityBoundary() {
  const [configResponse, paidResponse] = await Promise.all([
    fetch(SECURITY_CONFIG_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(APP_PUBLIC_BOUNDARY_TIMEOUT_MS),
    }),
    fetch(PAID_BOUNDARY_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(APP_PUBLIC_BOUNDARY_TIMEOUT_MS),
    }),
  ]);
  const [configText, paidText] = await Promise.all([configResponse.text(), paidResponse.text()]);
  let config;
  let paid;
  try {
    config = JSON.parse(configText);
    paid = JSON.parse(paidText);
  } catch {
    throw new Error('Production capability boundary returned invalid JSON');
  }
  return {
    configStatus: configResponse.status,
    config,
    paidStatus: paidResponse.status,
    paid,
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

export async function verifyProductionCapabilityBoundary({ read = readCapabilityBoundary } = {}) {
  const result = await read();
  if (result?.configStatus !== 200 || result.config?.capabilityRequired !== true) {
    throw new Error('Production App capability protection is disabled or unreadable');
  }
  if (result.paidStatus !== 401 || result.paid?.error !== 'CAPABILITY_REQUIRED') {
    throw new Error('Anonymous paid API request was not rejected by the capability boundary');
  }
  return { capabilityRequired: true, anonymousPaidApiRejected: true };
}

export async function main() {
  const [accountBoundary, capabilityBoundary] = await Promise.all([
    verifyAnonymousAccountSessionBoundary(),
    verifyProductionCapabilityBoundary(),
  ]);
  console.log(JSON.stringify({ ok: true, accountBoundary, capabilityBoundary }));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
