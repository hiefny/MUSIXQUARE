import type { Entry } from './drafts';

export interface CatalogLanguage {
  code: string;
  nativeName: string;
  htmlLang: string;
}

export interface TranslationCatalog {
  locale: CatalogLanguage;
  languages: CatalogLanguage[];
  entries: Entry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLanguage(value: unknown): value is CatalogLanguage {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.nativeName === 'string' &&
    typeof value.htmlLang === 'string'
  );
}

function isEntry(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    (value.surface === 'app' || value.surface === 'about') &&
    typeof value.key === 'string' &&
    value.id === `${value.surface}:${value.key}` &&
    typeof value.sourceEn === 'string' &&
    typeof value.sourceKo === 'string' &&
    typeof value.current === 'string'
  );
}

/** Read the current static manifest when loading phrases or checking a public submission. */
export async function loadTranslationCatalog(
  locale: string,
  signal?: AbortSignal,
): Promise<TranslationCatalog> {
  if (!/^[a-z]{2,3}(?:-[a-z]+)?$/u.test(locale)) throw new Error('Unsupported catalog locale.');
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15_000);
  try {
    if (controller.signal.aborted) throw new DOMException('Catalog request aborted.', 'AbortError');
    const options: RequestInit = {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    };
    const manifestResponse = await fetch('/translation-catalogs.json', options);
    if (!manifestResponse.ok)
      throw new Error(`Catalog manifest request failed: ${manifestResponse.status}`);
    const manifest: unknown = await manifestResponse.json();
    const catalogUrl =
      isRecord(manifest) &&
      manifest.version === 1 &&
      isRecord(manifest.locales) &&
      Object.prototype.hasOwnProperty.call(manifest.locales, locale)
        ? manifest.locales[locale]
        : null;
    if (
      typeof catalogUrl !== 'string' ||
      !new RegExp(`^/assets/translation-catalog-${locale}-[A-Za-z0-9_-]{8}\\.json$`, 'u').test(
        catalogUrl,
      )
    ) {
      throw new Error('Unsupported catalog locale or asset URL.');
    }
    const response = await fetch(catalogUrl, options);
    if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
    const catalog: unknown = await response.json();
    if (
      !isRecord(catalog) ||
      !isLanguage(catalog.locale) ||
      catalog.locale.code !== locale ||
      !Array.isArray(catalog.languages) ||
      !catalog.languages.every(isLanguage) ||
      !Array.isArray(catalog.entries) ||
      catalog.entries.length === 0 ||
      !catalog.entries.every(isEntry) ||
      new Set(catalog.entries.map(({ id }) => id)).size !== catalog.entries.length
    ) {
      throw new Error('Invalid translation catalog.');
    }
    return { locale: catalog.locale, languages: catalog.languages, entries: catalog.entries };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
