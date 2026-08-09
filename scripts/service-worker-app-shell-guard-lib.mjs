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

function literalArrayEntries(source) {
  return [...source.matchAll(/(['"])(.*?)\1/gu)].map((match) => match[2]);
}

/**
 * Resolve the built APP_SHELL without evaluating service-worker code. The
 * bootstrap URL intentionally carries the cache epoch, so treating its symbol
 * as if it were absent would let the HTML and installed cache drift apart.
 */
export function parseServiceWorkerAppShell(serviceWorker) {
  const appShellMatch = /\bconst\s+APP_SHELL\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(serviceWorker);
  if (!appShellMatch) throw new Error('Built service worker does not declare APP_SHELL.');

  const buildAssetsMatch = /\bconst\s+BUILD_ENTRY_ASSETS\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(
    serviceWorker,
  );
  if (!buildAssetsMatch || serviceWorker.includes('__MUSIXQUARE_BUILD_ENTRY_ASSETS__')) {
    throw new Error('Built service worker has no injected entry manifest.');
  }
  if (!/\.\.\.BUILD_ENTRY_ASSETS\b/u.test(appShellMatch[1])) {
    throw new Error('APP_SHELL does not include the injected entry manifest.');
  }

  const buildEntries = literalArrayEntries(buildAssetsMatch[1]);
  const appShellEntries = literalArrayEntries(appShellMatch[1]);
  if (/\bBOOTSTRAP_CACHE_KEY\b/u.test(appShellMatch[1])) {
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
    appShellEntries.push(`./bootstrap.js?cache=${cacheVersionMatch[2]}`);
  }

  if (appShellEntries.length === 0 || buildEntries.length === 0) {
    throw new Error('Built service worker APP_SHELL is empty.');
  }
  return { entries: [...appShellEntries, ...buildEntries], buildEntries };
}

function isExecutableStartupScript(element) {
  const type = (element.getAttribute('type') || '').trim().toLowerCase();
  if (type === '' || type === 'module') return true;
  const mimeType = type.split(';', 1)[0].trim();
  return CLASSIC_SCRIPT_MIME_TYPES.has(mimeType);
}

function isSameOriginHttpAsset(asset) {
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
export function collectActiveStartupAssets(indexHtml) {
  const document = new JSDOM(indexHtml).window.document;
  return [...document.querySelectorAll('script[src], link[href]')]
    .filter((element) => {
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
      if (element.closest('template, noscript')) return false;
      if (element.localName === 'script') return isExecutableStartupScript(element);
      return element.localName === 'link' && element.relList.contains('stylesheet');
    })
    .map((element) => element.getAttribute(element.localName === 'script' ? 'src' : 'href'))
    .filter(
      (asset) => typeof asset === 'string' && asset.length > 0 && isSameOriginHttpAsset(asset),
    );
}

function isImportMetaUrl(node) {
  return (
    node?.type === 'MemberExpression' &&
    node.computed === false &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'url' &&
    node.object?.type === 'MetaProperty' &&
    node.object.meta?.type === 'Identifier' &&
    node.object.meta.name === 'import' &&
    node.object.property?.type === 'Identifier' &&
    node.object.property.name === 'meta'
  );
}

function renderedWorkerAsset(node) {
  if (
    node?.type !== 'NewExpression' ||
    node.callee?.type !== 'Identifier' ||
    (node.callee.name !== 'Worker' && node.callee.name !== 'SharedWorker')
  ) {
    return null;
  }
  const urlExpression = node.arguments?.[0];
  if (
    urlExpression?.type !== 'NewExpression' ||
    urlExpression.callee?.type !== 'Identifier' ||
    urlExpression.callee.name !== 'URL' ||
    urlExpression.arguments?.length !== 2 ||
    urlExpression.arguments[0]?.type !== 'Literal' ||
    typeof urlExpression.arguments[0].value !== 'string' ||
    !isImportMetaUrl(urlExpression.arguments[1])
  ) {
    return null;
  }
  try {
    const buildOrigin = new URL('https://musixquare.invalid/');
    const url = new URL(urlExpression.arguments[0].value, buildOrigin);
    return url.origin === buildOrigin.origin ? decodeURIComponent(url.pathname) : null;
  } catch {
    return null;
  }
}

/** Discover same-origin Worker URLs from rendered module syntax, not filenames. */
export function collectRenderedWorkerAssets(javascript) {
  const ast = parseAst(javascript, { allowReturnOutsideFunction: false });
  const assets = new Set();
  const pending = [ast];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
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
