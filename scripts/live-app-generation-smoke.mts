#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';
import ts from 'typescript';

export const APP_ORIGIN = 'https://musixquare.com';
export const APP_GENERATION_TIMEOUT_MS = 90_000;
export const APP_GENERATION_REQUEST_TIMEOUT_MS = 10_000;
export const APP_GENERATION_POLL_MS = 1_500;
export const REQUIRED_CONSECUTIVE_GENERATION_READS = 3;
export const APP_INDEX_MAX_BYTES = 512 * 1024;
export const APP_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const APP_MAIN_ASSET_MAX_BYTES = APP_ASSET_MAX_BYTES;

const DIST_DIRECTORY = resolve('dist');
const HASHED_MAIN_ASSET_RE = /^\/assets\/main-[A-Za-z0-9_-]{8}\.js$/u;
const JAVASCRIPT_CONTENT_TYPE_RE = /^(?:application|text)\/(?:java|ecma)script(?:\s*;|$)/iu;
const CSS_CONTENT_TYPE_RE = /^text\/css(?:\s*;|$)/iu;
const EAGER_LINK_RELATIONS = new Set(['modulepreload', 'preload', 'stylesheet']);
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

type BinaryRead = (path: string) => Promise<string | Uint8Array>;
type Utf8Read = (path: string, encoding: 'utf8') => Promise<string>;

export interface AppGenerationReadResult {
  status: number;
  mainScript: string | null;
  byteLength?: number | null;
  sha256?: string | null;
}

export interface AppAssetIdentity {
  url: string;
  byteLength: number;
  sha256: string;
}

interface CandidateAssetIdentity extends AppAssetIdentity {
  bytes: Uint8Array;
}

export interface AppAssetReadResult {
  assetUrl: string;
  status: number;
  contentType: string;
  byteLength: number | null;
  sha256: string | null;
}

interface VerifyPublicAppGenerationOptions {
  expectedMain: string;
  expectedIndexBytes?: number;
  expectedIndexSha256?: string;
  expectedAssets?: readonly AppAssetIdentity[];
  expectedAssetBytes?: number;
  expectedAssetSha256?: string;
  read?: (options: { timeoutMs: number }) => Promise<AppGenerationReadResult>;
  readAsset?: (options: { assetUrl: string; timeoutMs: number }) => Promise<AppAssetReadResult>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollMs?: number;
  requiredConsecutiveReads?: number;
}

export interface AppGenerationResult {
  expectedMain: string;
  consecutiveReads: number;
  mainAssetBytes: number;
  verifiedAssetCount: number;
}

function bytesOf(body: unknown): Uint8Array {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  throw new Error('candidate asset is unreadable');
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function normalizeSameOriginAssetUrl(value: unknown, baseUrl = `${APP_ORIGIN}/`): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('initial app asset URL is empty');
  }
  let parsed;
  try {
    parsed = new URL(value, baseUrl);
  } catch {
    throw new Error(`initial app asset URL is invalid: ${value}`);
  }
  if (
    parsed.origin !== APP_ORIGIN ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.pathname === '/'
  ) {
    throw new Error(`initial app asset must be a same-origin file: ${value}`);
  }
  return `${parsed.pathname}${parsed.search}`;
}

function localAssetPath(assetUrl: string): string {
  const parsed = new URL(assetUrl, APP_ORIGIN);
  const decodedPath = decodeURIComponent(parsed.pathname);
  if (decodedPath.includes('\\') || decodedPath.includes('\0')) {
    throw new Error(`initial app asset path is invalid: ${assetUrl}`);
  }
  const segments = decodedPath.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`initial app asset path is invalid: ${assetUrl}`);
  }
  const target = resolve(DIST_DIRECTORY, ...segments);
  if (!target.startsWith(`${DIST_DIRECTORY}${sep}`)) {
    throw new Error(`initial app asset escapes dist/: ${assetUrl}`);
  }
  return target;
}

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/u, 1)[0])
    .filter((value): value is string => Boolean(value));
}

function withParsedDocument<Result>(
  html: string,
  inspect: (document: DocumentFragment) => Result,
): Result {
  // Fragment parsing keeps scripting disabled without applying document-mode
  // noscript recovery that can hoist candidate-looking markup into the head.
  const document = JSDOM.fragment(html);
  if (document.querySelector('base[href]')) {
    throw new Error('app index must not redefine its asset base URL');
  }
  return inspect(document);
}

function isActiveHtmlElement(element: Element): boolean {
  return element.namespaceURI === HTML_NAMESPACE && element.closest('noscript') === null;
}

export function extractMainScript(html: string): string | null {
  return withParsedDocument(html, (document) => {
    const mainScripts = [...document.querySelectorAll('script[type][src]')]
      .filter(isActiveHtmlElement)
      .filter((script) => script.getAttribute('type')?.trim().toLowerCase() === 'module')
      .map((script) => script.getAttribute('src'))
      .filter((source) => typeof source === 'string' && HASHED_MAIN_ASSET_RE.test(source));
    return mainScripts.length === 1 ? (mainScripts[0] ?? null) : null;
  });
}

function collectEagerAssetUrls(html: string): {
  entryScriptUrl: string;
  urls: string[];
  moduleUrls: string[];
} {
  return withParsedDocument(html, (document) => {
    const urls: string[] = [];
    const moduleUrls: string[] = [];
    const moduleEntries: string[] = [];

    for (const script of [...document.querySelectorAll('script[src]')].filter(
      isActiveHtmlElement,
    )) {
      const url = normalizeSameOriginAssetUrl(script.getAttribute('src'));
      urls.push(url);
      if (script.getAttribute('type')?.trim().toLowerCase() === 'module') {
        moduleUrls.push(url);
        if (HASHED_MAIN_ASSET_RE.test(url)) moduleEntries.push(url);
      }
    }

    for (const link of [...document.querySelectorAll('link[rel]')].filter(isActiveHtmlElement)) {
      const relations = (link.getAttribute('rel') || '')
        .toLowerCase()
        .split(/\s+/u)
        .filter(Boolean);
      if (!relations.some((relation) => EAGER_LINK_RELATIONS.has(relation))) continue;
      const href = link.getAttribute('href');
      if (href) {
        const url = normalizeSameOriginAssetUrl(href);
        urls.push(url);
        if (relations.includes('modulepreload')) moduleUrls.push(url);
      }
      for (const candidate of srcsetUrls(link.getAttribute('imagesrcset') || '')) {
        urls.push(normalizeSameOriginAssetUrl(candidate));
      }
    }

    for (const source of [...document.querySelectorAll('source[srcset]')].filter(
      isActiveHtmlElement,
    )) {
      for (const candidate of srcsetUrls(source.getAttribute('srcset') || '')) {
        urls.push(normalizeSameOriginAssetUrl(candidate));
      }
    }

    for (const image of [...document.querySelectorAll('img')].filter(isActiveHtmlElement)) {
      if (image.getAttribute('loading')?.trim().toLowerCase() === 'lazy') continue;
      const source = image.getAttribute('src');
      if (source) urls.push(normalizeSameOriginAssetUrl(source));
      for (const candidate of srcsetUrls(image.getAttribute('srcset') || '')) {
        urls.push(normalizeSameOriginAssetUrl(candidate));
      }
    }

    for (const media of [...document.querySelectorAll('audio, video')].filter(
      isActiveHtmlElement,
    )) {
      if (media.tagName.toLowerCase() === 'video') {
        const poster = media.getAttribute('poster');
        if (poster) urls.push(normalizeSameOriginAssetUrl(poster));
      }
      const preload = media.getAttribute('preload');
      const automaticPreload =
        media.hasAttribute('preload') &&
        ['', 'auto'].includes((preload || '').trim().toLowerCase());
      if (!media.hasAttribute('autoplay') && !automaticPreload) continue;
      const source = media.getAttribute('src');
      if (!source) throw new Error(`eager ${media.tagName.toLowerCase()} must declare src`);
      urls.push(normalizeSameOriginAssetUrl(source));
    }

    if (moduleEntries.length !== 1) {
      throw new Error('app index must declare exactly one canonical hashed module entry');
    }
    const entryScriptUrl = moduleEntries[0];
    if (entryScriptUrl === undefined) {
      throw new Error('app index must declare exactly one canonical hashed module entry');
    }
    return {
      entryScriptUrl,
      urls: [...new Set(urls)],
      moduleUrls: [...new Set(moduleUrls)],
    };
  });
}

function staticModuleImports(source: string, importerUrl: string): string[] {
  const sourceFile = ts.createSourceFile(
    importerUrl,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (
    'parseDiagnostics' in sourceFile &&
    Array.isArray(sourceFile.parseDiagnostics) &&
    sourceFile.parseDiagnostics.length > 0
  ) {
    throw new Error(`candidate module cannot be parsed: ${importerUrl}`);
  }
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return specifiers.map((specifier) => {
    if (!specifier.startsWith('/') && !specifier.startsWith('./') && !specifier.startsWith('../')) {
      throw new Error(`candidate module contains a bare static import: ${importerUrl}`);
    }
    const resolved = normalizeSameOriginAssetUrl(
      specifier,
      new URL(importerUrl, `${APP_ORIGIN}/`).href,
    );
    if (!/\.m?js(?:\?|$)/iu.test(resolved)) {
      throw new Error(`candidate module contains a non-JavaScript static import: ${resolved}`);
    }
    return resolved;
  });
}

async function candidateAssetIdentity(
  assetUrl: string,
  read: BinaryRead,
): Promise<CandidateAssetIdentity> {
  const bytes = bytesOf(await read(localAssetPath(assetUrl)));
  if (bytes.byteLength === 0) throw new Error(`candidate asset is empty: ${assetUrl}`);
  if (bytes.byteLength > APP_ASSET_MAX_BYTES) {
    throw new Error(`candidate asset exceeds the live-smoke byte cap: ${assetUrl}`);
  }
  return { url: assetUrl, byteLength: bytes.byteLength, sha256: digestBytes(bytes), bytes };
}

export async function expectedAppAssetGraph({
  read = readFile,
}: { read?: BinaryRead } = {}): Promise<{
  mainScript: string;
  indexByteLength: number;
  indexSha256: string;
  assets: AppAssetIdentity[];
}> {
  const indexBytes = bytesOf(await read(resolve(DIST_DIRECTORY, 'index.html')));
  if (indexBytes.byteLength === 0 || indexBytes.byteLength > APP_INDEX_MAX_BYTES) {
    throw new Error('candidate app index is empty or exceeds the live-smoke byte cap');
  }
  const indexHtml = decodeUtf8(indexBytes, 'candidate app index');
  const { entryScriptUrl, urls, moduleUrls } = collectEagerAssetUrls(indexHtml);
  const identities = new Map<string, CandidateAssetIdentity>();
  const ensureIdentity = async (assetUrl: string): Promise<CandidateAssetIdentity> => {
    const normalized = normalizeSameOriginAssetUrl(assetUrl);
    let identity = identities.get(normalized);
    if (!identity) {
      identity = await candidateAssetIdentity(normalized, read);
      identities.set(normalized, identity);
    }
    return identity;
  };

  for (const url of urls) await ensureIdentity(url);

  const pendingModules = [...moduleUrls];
  const parsedModules = new Set<string>();
  while (pendingModules.length > 0) {
    const moduleUrl = pendingModules.shift();
    if (moduleUrl === undefined) continue;
    if (parsedModules.has(moduleUrl)) continue;
    parsedModules.add(moduleUrl);
    const identity = await ensureIdentity(moduleUrl);
    const source = decodeUtf8(identity.bytes, `candidate module ${moduleUrl}`);
    for (const dependency of staticModuleImports(source, moduleUrl)) {
      await ensureIdentity(dependency);
      pendingModules.push(dependency);
    }
  }

  return {
    mainScript: entryScriptUrl,
    indexByteLength: indexBytes.byteLength,
    indexSha256: digestBytes(indexBytes),
    assets: [...identities.values()]
      .map(({ url, byteLength, sha256 }) => ({ url, byteLength, sha256 }))
      .sort((left, right) => left.url.localeCompare(right.url)),
  };
}

export async function expectedMainScript({
  read = readFile,
}: { read?: Utf8Read } = {}): Promise<string> {
  const mainScript = extractMainScript(await read('dist/index.html', 'utf8'));
  if (!mainScript) throw new Error('candidate dist does not declare a hashed main script');
  return mainScript;
}

export async function expectedMainAsset({
  mainScript,
  read = readFile,
}: {
  mainScript: string;
  read?: BinaryRead;
}): Promise<{ byteLength: number; sha256: string }> {
  if (!HASHED_MAIN_ASSET_RE.test(mainScript)) {
    throw new Error('expected main script is not a canonical hashed asset path');
  }
  const { byteLength, sha256 } = await candidateAssetIdentity(mainScript, read);
  return { byteLength, sha256 };
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9._-]+\b/gu, '[redacted-token]')
    .replace(/((?:https?|wss?):\/\/[^\s?#]+)[?#][^\s)]+/gu, '$1?[redacted]');
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try {
    const cancellation = body?.cancel();
    void Promise.resolve(cancellation).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never delay the bounded smoke result.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const cancellation = reader.cancel();
    void Promise.resolve(cancellation).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never delay the bounded smoke result.
  }
}

function declaredContentLength(response: Response): number | null {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/u.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; byteLength: number; sha256: string }> {
  const declaredLength = declaredContentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    cancelBody(response.body);
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error('response body is missing');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const digest = createHash('sha256');
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
      digest.update(chunk.value);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, byteLength, sha256: digest.digest('hex') };
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed releaseLock cannot change the already bounded result.
    }
  }
}

async function digestBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ byteLength: number; sha256: string }> {
  const declaredLength = declaredContentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    cancelBody(response.body);
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error('response body is missing');

  const reader = response.body.getReader();
  const digest = createHash('sha256');
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
      digest.update(chunk.value);
    }
    if (byteLength === 0) throw new Error('response body is empty');
    return { byteLength, sha256: digest.digest('hex') };
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed releaseLock cannot change the already bounded result.
    }
  }
}

export async function readPublicIndex({
  timeoutMs,
}: {
  timeoutMs: number;
}): Promise<AppGenerationReadResult> {
  const response = await fetch(`${APP_ORIGIN}/?release-generation=${randomUUID()}`, {
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) {
    cancelBody(response.body);
    return { status: response.status, mainScript: null, byteLength: null, sha256: null };
  }
  const contentType = response.headers.get('content-type') || '';
  if (!/^text\/html(?:\s*;|$)/iu.test(contentType)) {
    cancelBody(response.body);
    throw new Error(`app index returned an invalid Content-Type: ${contentType || 'missing'}`);
  }
  const body = await readBoundedText(response, APP_INDEX_MAX_BYTES);
  return {
    status: response.status,
    mainScript: extractMainScript(body.text),
    byteLength: body.byteLength,
    sha256: body.sha256,
  };
}

function validAssetContentType(assetUrl: string, contentType: string): boolean {
  const pathname = new URL(assetUrl, APP_ORIGIN).pathname;
  if (/\.m?js$/iu.test(pathname)) return JAVASCRIPT_CONTENT_TYPE_RE.test(contentType);
  if (/\.css$/iu.test(pathname)) return CSS_CONTENT_TYPE_RE.test(contentType);
  return contentType.trim() !== '';
}

export async function readPublicAsset({
  assetUrl,
  timeoutMs,
}: {
  assetUrl: string;
  timeoutMs: number;
}): Promise<AppAssetReadResult> {
  const normalizedUrl = normalizeSameOriginAssetUrl(assetUrl);
  const response = await fetch(`${APP_ORIGIN}${normalizedUrl}`, {
    cache: 'no-store',
    redirect: 'error',
    headers: {
      Accept: '*/*',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = response.headers.get('content-type') || '';
  if (response.status !== 200 || !validAssetContentType(normalizedUrl, contentType)) {
    cancelBody(response.body);
    return {
      assetUrl: normalizedUrl,
      status: response.status,
      contentType,
      byteLength: null,
      sha256: null,
    };
  }
  return {
    assetUrl: normalizedUrl,
    status: response.status,
    contentType,
    ...(await digestBoundedBody(response, APP_ASSET_MAX_BYTES)),
  };
}

export async function readPublicMainAsset({
  mainScript,
  timeoutMs,
}: {
  mainScript: string;
  timeoutMs: number;
}): Promise<AppAssetReadResult> {
  return readPublicAsset({ assetUrl: mainScript, timeoutMs });
}

export async function verifyPublicAppGeneration({
  expectedMain,
  expectedIndexBytes,
  expectedIndexSha256,
  expectedAssets,
  expectedAssetBytes,
  expectedAssetSha256,
  read = readPublicIndex,
  readAsset = readPublicAsset,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  timeoutMs = APP_GENERATION_TIMEOUT_MS,
  requestTimeoutMs = APP_GENERATION_REQUEST_TIMEOUT_MS,
  pollMs = APP_GENERATION_POLL_MS,
  requiredConsecutiveReads = REQUIRED_CONSECUTIVE_GENERATION_READS,
}: VerifyPublicAppGenerationOptions): Promise<AppGenerationResult> {
  if (!HASHED_MAIN_ASSET_RE.test(expectedMain)) {
    throw new Error('expected main script is not a canonical hashed asset path');
  }
  const assetsToVerify = expectedAssets ?? [
    { url: expectedMain, byteLength: expectedAssetBytes, sha256: expectedAssetSha256 },
  ];
  if (
    assetsToVerify.length === 0 ||
    !assetsToVerify.some(({ url }) => normalizeSameOriginAssetUrl(url) === expectedMain)
  ) {
    throw new Error('candidate initial asset graph does not contain the main script');
  }
  const normalizedAssets = assetsToVerify.map((asset) => ({
    ...asset,
    url: normalizeSameOriginAssetUrl(asset.url),
  }));
  if (new Set(normalizedAssets.map(({ url }) => url)).size !== normalizedAssets.length) {
    throw new Error('candidate initial asset graph contains duplicate URLs');
  }

  const deadline = now() + timeoutMs;
  const observed = new Set<string>();
  let consecutive = 0;

  while (now() < deadline) {
    const remainingMs = Math.max(1, deadline - now());
    try {
      const result = await read({ timeoutMs: Math.min(requestTimeoutMs, remainingMs) });
      if (result?.status !== 200) {
        observed.add(`http-${result?.status ?? 'unknown'}`);
        consecutive = 0;
      } else {
        const actualMain = result.mainScript || 'missing-main-script';
        observed.add(actualMain);
        if (
          expectedIndexBytes !== undefined &&
          (result.byteLength !== expectedIndexBytes ||
            result.sha256?.toLowerCase() !== expectedIndexSha256?.toLowerCase())
        ) {
          throw new Error('production app index does not match the candidate');
        }
        consecutive = actualMain === expectedMain ? consecutive + 1 : 0;
        if (consecutive >= requiredConsecutiveReads) {
          let mainAssetBytes = 0;
          for (const expectedAsset of normalizedAssets) {
            const assetRemainingMs = deadline - now();
            if (assetRemainingMs <= 0) {
              throw new Error('initial asset graph verification deadline expired');
            }
            const asset = await readAsset({
              assetUrl: expectedAsset.url,
              timeoutMs: Math.min(requestTimeoutMs, assetRemainingMs),
            });
            if (
              asset?.assetUrl !== expectedAsset.url ||
              asset.status !== 200 ||
              !validAssetContentType(expectedAsset.url, asset.contentType || '') ||
              typeof asset.byteLength !== 'number' ||
              !Number.isSafeInteger(asset.byteLength) ||
              asset.byteLength <= 0 ||
              typeof asset.sha256 !== 'string' ||
              !/^[a-f0-9]{64}$/u.test(asset.sha256)
            ) {
              throw new Error(
                `production asset returned an invalid projection: ${expectedAsset.url}`,
              );
            }
            if (
              expectedAsset.byteLength !== undefined &&
              asset.byteLength !== expectedAsset.byteLength
            ) {
              throw new Error(`production asset length does not match: ${expectedAsset.url}`);
            }
            if (
              expectedAsset.sha256 !== undefined &&
              asset.sha256.toLowerCase() !== expectedAsset.sha256.toLowerCase()
            ) {
              throw new Error(`production asset digest does not match: ${expectedAsset.url}`);
            }
            if (expectedAsset.url === expectedMain) mainAssetBytes = asset.byteLength;
          }
          return {
            expectedMain,
            consecutiveReads: consecutive,
            mainAssetBytes,
            verifiedAssetCount: normalizedAssets.length,
          };
        }
      }
    } catch (error) {
      observed.add(`probe-error:${sanitizeDiagnostic(String(error))}`);
      consecutive = 0;
    }

    const remainingAfterReadMs = deadline - now();
    if (remainingAfterReadMs <= 0) break;
    await sleep(Math.min(pollMs, remainingAfterReadMs));
  }

  throw new Error(
    `production app generation did not converge to ${expectedMain}; observed=${[...observed].join(
      ',',
    )}`,
  );
}

export async function main(): Promise<void> {
  const expected = await expectedAppAssetGraph();
  const result = await verifyPublicAppGeneration({
    expectedMain: expected.mainScript,
    expectedIndexBytes: expected.indexByteLength,
    expectedIndexSha256: expected.indexSha256,
    expectedAssets: expected.assets,
  });
  console.log(JSON.stringify({ productionGenerationConverged: true, ...result }));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
