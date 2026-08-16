import { JSDOM } from 'jsdom';
import { parseAst } from 'rollup/parseAst';

const STARTUP_DOCUMENT_URL = new URL('https://musixquare.invalid/index.html');
const CLASSIC_SCRIPT_MIME_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

export interface ServiceWorkerAppShell {
  readonly entries: string[];
  readonly buildEntries: string[];
}

function literalArrayEntries(source: string): string[] {
  return [...source.matchAll(/(['"])(.*?)\1/gu)].flatMap((match) => {
    const entry = match[2];
    return entry === undefined ? [] : [entry];
  });
}

/**
 * Resolve the built APP_SHELL without evaluating service-worker code. The
 * bootstrap URL intentionally carries the cache epoch, so treating its symbol
 * as if it were absent would let the HTML and installed cache drift apart.
 */
export function parseServiceWorkerAppShell(serviceWorker: string): ServiceWorkerAppShell {
  const appShellMatch = /\bconst\s+APP_SHELL\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(serviceWorker);
  if (!appShellMatch) throw new Error('Built service worker does not declare APP_SHELL.');

  const buildAssetsMatch = /\bconst\s+BUILD_ENTRY_ASSETS\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(
    serviceWorker,
  );
  if (!buildAssetsMatch || serviceWorker.includes('__MUSIXQUARE_BUILD_ENTRY_ASSETS__')) {
    throw new Error('Built service worker has no injected entry manifest.');
  }
  const appShellBody = appShellMatch[1];
  const buildAssetsBody = buildAssetsMatch[1];
  if (appShellBody === undefined || buildAssetsBody === undefined) {
    throw new Error('Built service worker has malformed app-shell declarations.');
  }
  if (!/\.\.\.BUILD_ENTRY_ASSETS\b/u.test(appShellBody)) {
    throw new Error('APP_SHELL does not include the injected entry manifest.');
  }

  const buildEntries = literalArrayEntries(buildAssetsBody);
  const appShellEntries = literalArrayEntries(appShellBody);
  if (/\bBOOTSTRAP_CACHE_KEY\b/u.test(appShellBody)) {
    const cacheVersionMatch = /\bconst\s+CACHE_VERSION\s*=\s*(['"])(.*?)\1\s*;/u.exec(
      serviceWorker,
    );
    const hasExpectedBootstrapDeclaration =
      /\bconst\s+BOOTSTRAP_CACHE_KEY\s*=\s*`\.\/bootstrap\.js\?cache=\$\{CACHE_VERSION\}`\s*;/u.test(
        serviceWorker,
      );
    if (!cacheVersionMatch || !hasExpectedBootstrapDeclaration) {
      throw new Error('Could not resolve BOOTSTRAP_CACHE_KEY from CACHE_VERSION.');
    }
    const cacheVersion = cacheVersionMatch[2];
    if (cacheVersion === undefined) {
      throw new Error('Could not read CACHE_VERSION for BOOTSTRAP_CACHE_KEY.');
    }
    appShellEntries.push(`./bootstrap.js?cache=${cacheVersion}`);
  }

  if (appShellEntries.length === 0 || buildEntries.length === 0) {
    throw new Error('Built service worker APP_SHELL is empty.');
  }
  return { entries: [...appShellEntries, ...buildEntries], buildEntries };
}

function isExecutableStartupScript(element: Element): boolean {
  const type = (element.getAttribute('type') || '').trim().toLowerCase();
  if (type === '' || type === 'module') return true;
  const [rawMimeType = ''] = type.split(';', 1);
  const mimeType = rawMimeType.trim();
  return CLASSIC_SCRIPT_MIME_TYPES.has(mimeType);
}

function isSameOriginHttpAsset(asset: string): boolean {
  try {
    const url = new URL(asset, STARTUP_DOCUMENT_URL);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === STARTUP_DOCUMENT_URL.origin
    );
  } catch {
    return false;
  }
}

/**
 * Return active same-origin executable-script/CSS startup references.
 * Inline scripts have no URL; external, data:, blob:, and inert markup are
 * deliberately ignored because the app-shell cache cannot satisfy them.
 */
export function collectActiveStartupAssets(indexHtml: string): string[] {
  const window = new JSDOM(indexHtml).window;
  const { document } = window;
  return [...document.querySelectorAll('script[src], link[href]')]
    .filter((element) => {
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
      if (element.closest('template, noscript')) return false;
      if (element.localName === 'script') return isExecutableStartupScript(element);
      return (
        element.localName === 'link' &&
        element instanceof window.HTMLLinkElement &&
        element.relList.contains('stylesheet')
      );
    })
    .map((element) => element.getAttribute(element.localName === 'script' ? 'src' : 'href'))
    .filter(
      (asset): asset is string =>
        typeof asset === 'string' && asset.length > 0 && isSameOriginHttpAsset(asset),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isImportMetaUrl(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const property = node.property;
  const object = node.object;
  if (!isRecord(property) || !isRecord(object)) return false;
  const meta = object.meta;
  const metaProperty = object.property;
  return (
    node.type === 'MemberExpression' &&
    node.computed === false &&
    property.type === 'Identifier' &&
    property.name === 'url' &&
    object.type === 'MetaProperty' &&
    isRecord(meta) &&
    meta.type === 'Identifier' &&
    meta.name === 'import' &&
    isRecord(metaProperty) &&
    metaProperty.type === 'Identifier' &&
    metaProperty.name === 'meta'
  );
}

function renderedWorkerAsset(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const callee = node.callee;
  if (
    node.type !== 'NewExpression' ||
    !isRecord(callee) ||
    callee.type !== 'Identifier' ||
    (callee.name !== 'Worker' && callee.name !== 'SharedWorker') ||
    !Array.isArray(node.arguments)
  ) {
    return null;
  }
  const urlExpression = node.arguments[0];
  if (!isRecord(urlExpression)) return null;
  const urlCallee = urlExpression.callee;
  const urlArguments = urlExpression.arguments;
  if (
    urlExpression.type !== 'NewExpression' ||
    !isRecord(urlCallee) ||
    urlCallee.type !== 'Identifier' ||
    urlCallee.name !== 'URL' ||
    !Array.isArray(urlArguments) ||
    urlArguments.length !== 2
  ) {
    return null;
  }
  const assetLiteral = urlArguments[0];
  if (
    !isRecord(assetLiteral) ||
    assetLiteral.type !== 'Literal' ||
    typeof assetLiteral.value !== 'string' ||
    !isImportMetaUrl(urlArguments[1])
  ) {
    return null;
  }
  try {
    const buildOrigin = new URL('https://musixquare.invalid/');
    const url = new URL(assetLiteral.value, buildOrigin);
    return url.origin === buildOrigin.origin ? decodeURIComponent(url.pathname) : null;
  } catch {
    return null;
  }
}

/** Discover same-origin Worker URLs from rendered module syntax, not filenames. */
export function collectRenderedWorkerAssets(javascript: string): string[] {
  const ast = parseAst(javascript, { allowReturnOutsideFunction: false });
  const assets = new Set<string>();
  const pending: unknown[] = [ast];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!isRecord(value)) continue;
    const workerAsset = renderedWorkerAsset(value);
    if (workerAsset) assets.add(workerAsset);
    for (const [key, child] of Object.entries(value)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(child)) pending.push(...child);
      else if (child && typeof child === 'object') pending.push(child);
    }
  }
  return [...assets].sort();
}
