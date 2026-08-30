#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const AUTH_SESSION_URL = 'https://musixquare.com/api/auth/session';
const SECURITY_CONFIG_URL = 'https://musixquare.com/api/security-config';
const PAID_BOUNDARY_URL = 'https://musixquare.com/api/get-turn-config';
const UNRELATED_TOSS_ORIGIN = 'https://unrelated.apps.tossmini.com';
export const APP_PUBLIC_BOUNDARY_TIMEOUT_MS = 10_000;
const MUSIXQUARE_COOKIE_RE = /(?:^|[,\r\n]\s*)(?:__Host|__Secure)-mxqr_[^=;,]*=/;

export interface AnonymousAccountSessionBoundaryRead {
  status: number;
  cacheControl: string;
  setCookie: string | null;
  payload: unknown;
}

export interface AnonymousAccountSessionBoundaryResult {
  configured: true;
  anonymousSessionRejected: true;
}

export interface ProductionCapabilityBoundaryRead {
  configStatus: number;
  config: unknown;
  paidStatus: number;
  paid: unknown;
}

export interface ProductionCapabilityBoundaryResult {
  capabilityRequired: true;
  anonymousPaidApiRejected: true;
}

export interface ProductionOriginBoundaryRead {
  status: number;
  allowOrigin: string | null;
}

export interface ProductionOriginBoundaryResult {
  unrelatedTossOriginRejected: true;
}

export interface LocalizedSeoBoundaryRead {
  path: string;
  status: number;
  cacheControl: string;
  lang: string;
  title: string;
  canonical: string;
  description: string;
  openGraphUrl: string;
  alternateCount: number;
  xDefault: string;
}

export interface LocalizedSeoBoundaryResult {
  localizedSeoReady: true;
  pages: number;
}

const LOCALIZED_SEO_EXPECTATIONS = [
  { path: '/', lang: 'en', title: 'MUSIXQUARE', canonical: 'https://musixquare.com/', page: 'app' },
  {
    path: '/ko/',
    lang: 'ko',
    title: '뮤직스퀘어 | MUSIXQUARE',
    canonical: 'https://musixquare.com/ko/',
    page: 'app',
  },
  {
    path: '/ja/',
    lang: 'ja',
    title: 'ミュージックスクエア | MUSIXQUARE',
    canonical: 'https://musixquare.com/ja/',
    page: 'app',
  },
  {
    path: '/zh-hans/about',
    lang: 'zh-Hans',
    title: '关于 MUSIXQUARE',
    canonical: 'https://musixquare.com/zh-hans/about',
    page: 'about',
  },
  {
    path: '/pt-br/about',
    lang: 'pt-BR',
    title: 'Sobre o MUSIXQUARE',
    canonical: 'https://musixquare.com/pt-br/about',
    page: 'about',
  },
  {
    path: '/th/about',
    lang: 'th',
    title: 'เกี่ยวกับ MUSIXQUARE',
    canonical: 'https://musixquare.com/th/about',
    page: 'about',
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readAnonymousSession(): Promise<AnonymousAccountSessionBoundaryRead> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(AUTH_SESSION_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(APP_PUBLIC_BOUNDARY_TIMEOUT_MS),
    });
    text = await response.text();
  } catch {
    throw new Error('Anonymous account session boundary request failed');
  }
  let payload: unknown;
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

async function readCapabilityBoundary(): Promise<ProductionCapabilityBoundaryRead> {
  let configResponse: Response;
  let paidResponse: Response;
  let configText: string;
  let paidText: string;
  try {
    [configResponse, paidResponse] = await Promise.all([
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
    [configText, paidText] = await Promise.all([configResponse.text(), paidResponse.text()]);
  } catch {
    throw new Error('Production capability boundary request failed');
  }
  let config: unknown;
  let paid: unknown;
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

async function readOriginBoundary(): Promise<ProductionOriginBoundaryRead> {
  let response: Response;
  try {
    response = await fetch(PAID_BOUNDARY_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json', Origin: UNRELATED_TOSS_ORIGIN },
      signal: AbortSignal.timeout(APP_PUBLIC_BOUNDARY_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Production App origin boundary request failed');
  }
  try {
    return {
      status: response.status,
      allowOrigin: response.headers.get('Access-Control-Allow-Origin'),
    };
  } finally {
    try {
      await response.body?.cancel();
    } catch {
      // Body cleanup cannot replace the origin-boundary result.
    }
  }
}

async function readLocalizedSeoBoundary(): Promise<LocalizedSeoBoundaryRead[]> {
  return Promise.all(
    LOCALIZED_SEO_EXPECTATIONS.map(async ({ path }) => {
      let response: Response;
      let html: string;
      try {
        response = await fetch(`https://musixquare.com${path}`, {
          cache: 'no-store',
          headers: { Accept: 'text/html' },
          signal: AbortSignal.timeout(APP_PUBLIC_BOUNDARY_TIMEOUT_MS),
        });
        html = await response.text();
      } catch {
        throw new Error(`Localized SEO boundary request failed: ${path}`);
      }

      const dom = new JSDOM(html);
      const document = dom.window.document;
      const result = {
        path,
        status: response.status,
        cacheControl: response.headers.get('Cache-Control') || '',
        lang: document.documentElement.lang,
        title: document.title,
        canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || '',
        description:
          document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content || '',
        openGraphUrl:
          document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content || '',
        alternateCount: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
        xDefault: document.querySelector<HTMLLinkElement>('link[hreflang="x-default"]')?.href || '',
      };
      dom.window.close();
      return result;
    }),
  );
}

export async function verifyAnonymousAccountSessionBoundary({
  read = readAnonymousSession,
}: {
  read?: () => Promise<AnonymousAccountSessionBoundaryRead>;
} = {}): Promise<AnonymousAccountSessionBoundaryResult> {
  const result: unknown = await read();
  if (!isRecord(result)) {
    throw new Error('Anonymous account session boundary returned an invalid projection');
  }
  const payload = result.payload;
  if (
    result.status !== 200 ||
    !isRecord(payload) ||
    payload.configured !== true ||
    payload.authenticated !== false ||
    payload.account !== null
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

export async function verifyProductionCapabilityBoundary({
  read = readCapabilityBoundary,
}: {
  read?: () => Promise<ProductionCapabilityBoundaryRead>;
} = {}): Promise<ProductionCapabilityBoundaryResult> {
  const result: unknown = await read();
  if (!isRecord(result)) {
    throw new Error('Production App capability protection is disabled or unreadable');
  }
  const config = result.config;
  const paid = result.paid;
  if (result.configStatus !== 200 || !isRecord(config) || config.capabilityRequired !== true) {
    throw new Error('Production App capability protection is disabled or unreadable');
  }
  if (result.paidStatus !== 401 || !isRecord(paid) || paid.error !== 'CAPABILITY_REQUIRED') {
    throw new Error('Anonymous paid API request was not rejected by the capability boundary');
  }
  return { capabilityRequired: true, anonymousPaidApiRejected: true };
}

export async function verifyProductionOriginBoundary({
  read = readOriginBoundary,
}: {
  read?: () => Promise<ProductionOriginBoundaryRead>;
} = {}): Promise<ProductionOriginBoundaryResult> {
  const result: unknown = await read();
  if (
    !isRecord(result) ||
    (result.status !== 401 && result.status !== 403) ||
    result.allowOrigin === UNRELATED_TOSS_ORIGIN ||
    result.allowOrigin === '*'
  ) {
    throw new Error('Production App still trusts an unrelated Toss app origin');
  }
  return { unrelatedTossOriginRejected: true };
}

export async function verifyLocalizedSeoBoundary({
  read = readLocalizedSeoBoundary,
}: {
  read?: () => Promise<LocalizedSeoBoundaryRead[]>;
} = {}): Promise<LocalizedSeoBoundaryResult> {
  const pages = await read();
  if (pages.length !== LOCALIZED_SEO_EXPECTATIONS.length) {
    throw new Error('Localized SEO boundary returned an incomplete page matrix');
  }

  for (const expectation of LOCALIZED_SEO_EXPECTATIONS) {
    const page = pages.find(({ path }) => path === expectation.path);
    const expectedXDefault =
      expectation.page === 'app' ? 'https://musixquare.com/' : 'https://musixquare.com/about';
    const cacheControl = String(page?.cacheControl || '').toLowerCase();
    if (
      !page ||
      page.status !== 200 ||
      page.lang !== expectation.lang ||
      page.title !== expectation.title ||
      page.canonical !== expectation.canonical ||
      page.openGraphUrl !== expectation.canonical ||
      page.description.trim().length === 0 ||
      page.alternateCount !== 18 ||
      page.xDefault !== expectedXDefault ||
      (expectation.page === 'app'
        ? !cacheControl.includes('no-store')
        : !cacheControl.includes('s-maxage=86400'))
    ) {
      throw new Error(`Localized SEO boundary is invalid: ${expectation.path}`);
    }
  }

  return { localizedSeoReady: true, pages: pages.length };
}

export async function main(): Promise<void> {
  const [accountBoundary, capabilityBoundary, originBoundary, localizedSeoBoundary] =
    await Promise.all([
      verifyAnonymousAccountSessionBoundary(),
      verifyProductionCapabilityBoundary(),
      verifyProductionOriginBoundary(),
      verifyLocalizedSeoBoundary(),
    ]);
  console.log(
    JSON.stringify({
      ok: true,
      accountBoundary,
      capabilityBoundary,
      originBoundary,
      localizedSeoBoundary,
    }),
  );
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
