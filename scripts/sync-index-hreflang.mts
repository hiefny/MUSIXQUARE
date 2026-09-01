import { readFile, writeFile } from 'node:fs/promises';

import { LANGUAGE_OPTIONS, localizedAppPath } from '../src/i18n/locales.ts';
import { localeSeoMetadata } from './locale-seo-metadata.mts';

const ORIGIN = 'https://musixquare.com';
const OUTPUT_PATH = 'index.html';
const START_MARKER = '    <!-- mxqr-hreflang:start -->';
const END_MARKER = '    <!-- mxqr-hreflang:end -->';

function renderAlternateLinks(): string {
  const links = LANGUAGE_OPTIONS.map(
    ({ code }) =>
      `    <link rel="alternate" hreflang="${localeSeoMetadata(code).hrefLang}" href="${ORIGIN}${localizedAppPath(code)}" />`,
  );
  links.push(`    <link rel="alternate" hreflang="x-default" href="${ORIGIN}/" />`);
  return [START_MARKER, ...links, END_MARKER].join('\n');
}

function replaceGeneratedBlock(source: string): string {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('The authored hreflang markers are missing or out of order in index.html.');
  }
  if (source.indexOf(START_MARKER, start + START_MARKER.length) >= 0) {
    throw new Error('The authored hreflang start marker must be unique.');
  }
  if (source.indexOf(END_MARKER, end + END_MARKER.length) >= 0) {
    throw new Error('The authored hreflang end marker must be unique.');
  }

  return source.slice(0, start) + renderAlternateLinks() + source.slice(end + END_MARKER.length);
}

const source = await readFile(OUTPUT_PATH, 'utf8');
const expected = replaceGeneratedBlock(source);

if (process.argv.includes('--check')) {
  if (source !== expected) {
    throw new Error('Authored app hreflang links are stale. Run: npm run generate:index-hreflang');
  }
  process.stdout.write(`[index-hreflang] ${LANGUAGE_OPTIONS.length + 1} links verified.\n`);
} else {
  await writeFile(OUTPUT_PATH, expected, 'utf8');
  process.stdout.write(`[index-hreflang] ${LANGUAGE_OPTIONS.length + 1} links written.\n`);
}
