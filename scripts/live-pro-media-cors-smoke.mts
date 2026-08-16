#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_ORIGIN = 'https://musixquare.com';
const PRO_MEDIA_CORS_PROBE_URL =
  'https://01353882e4eea3a5acaa0c45e8336af4.r2.cloudflarestorage.com/' +
  'musixquare-pro-media/__mxqr_cors_probe__';
const PROPAGATION_TIMEOUT_MS = 45_000;
const RETRY_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ProMediaCorsPreflightResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
}

function headerSet(response: ProMediaCorsPreflightResponse, name: string): Set<string> {
  return new Set(
    (response.headers.get(name) || '')
      .toLowerCase()
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The HTTP/CORS result remains authoritative.
  }
}

export function assertProMediaCorsPreflight(response: ProMediaCorsPreflightResponse): void {
  if (!response.ok) {
    throw new Error(`PRO media R2 CORS preflight HTTP ${response.status}`);
  }
  if (response.headers.get('access-control-allow-origin') !== APP_ORIGIN) {
    throw new Error('PRO media R2 CORS preflight returned the wrong allowed origin');
  }
  if (!headerSet(response, 'access-control-allow-methods').has('get')) {
    throw new Error('PRO media R2 CORS preflight does not allow GET');
  }
  if (!headerSet(response, 'access-control-allow-headers').has('range')) {
    throw new Error('PRO media R2 CORS preflight does not allow Range');
  }
}

async function readProMediaCorsPreflight(): Promise<Response> {
  const deadline = Date.now() + PROPAGATION_TIMEOUT_MS;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(PRO_MEDIA_CORS_PROBE_URL, {
        method: 'OPTIONS',
        headers: {
          Origin: APP_ORIGIN,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'range',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('PRO media R2 CORS preflight request failed');
    }
    if (response.ok) return response;
    if (response.status !== 403 || Date.now() >= deadline) {
      await discard(response);
      throw new Error(`PRO media R2 CORS preflight HTTP ${response.status}`);
    }
    await discard(response);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()))),
    );
  }
}

export async function main(): Promise<void> {
  const response = await readProMediaCorsPreflight();
  try {
    assertProMediaCorsPreflight(response);
  } finally {
    await discard(response);
  }
  console.log('PRO media R2 Range CORS is active.');
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
