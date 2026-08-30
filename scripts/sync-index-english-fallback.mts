import { readFile, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

import en from '../src/i18n/en.ts';

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface ElementLocation {
  readonly startTag?: { readonly startOffset: number; readonly endOffset: number };
  readonly endTag?: { readonly startOffset: number; readonly endOffset: number };
  readonly attrs?: Readonly<
    Record<string, { readonly startOffset: number; readonly endOffset: number }>
  >;
}

const ATTRIBUTE_BINDINGS = [
  ['placeholder', 'data-i18n-placeholder'],
  ['aria-label', 'data-i18n-aria-label'],
  ['title', 'data-i18n-title'],
  ['alt', 'data-i18n-alt'],
  ['data-placeholder', 'data-i18n-data-placeholder'],
] as const;

function escapeText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/gu, '&quot;');
}

function translation(key: string | null): string {
  if (!key) throw new Error('An i18n binding is missing its key.');
  const value = (en as Readonly<Record<string, string>>)[key];
  if (value === undefined) throw new Error(`Missing English translation: ${key}`);
  return value;
}

const filePath = 'index.html';
const source = await readFile(filePath, 'utf8');
const dom = new JSDOM(source, { includeNodeLocations: true });
const replacements: Replacement[] = [];

for (const element of dom.window.document.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
  const location = dom.nodeLocation(element) as ElementLocation | null | undefined;
  if (!location?.startTag || !location.endTag)
    throw new Error('Bound HTML element has no source location.');
  replacements.push({
    start: location.startTag.endOffset,
    end: location.endTag.startOffset,
    value: translation(element.getAttribute('data-i18n-html')),
  });
}

for (const element of dom.window.document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  if (element.hasAttribute('data-i18n-html')) continue;
  const location = dom.nodeLocation(element) as ElementLocation | null | undefined;
  if (!location?.startTag || !location.endTag)
    throw new Error('Bound text element has no source location.');
  replacements.push({
    start: location.startTag.endOffset,
    end: location.endTag.startOffset,
    value: escapeText(translation(element.getAttribute('data-i18n'))),
  });
}

for (const [attribute, binding] of ATTRIBUTE_BINDINGS) {
  for (const element of dom.window.document.querySelectorAll<HTMLElement>(`[${binding}]`)) {
    const location = dom.nodeLocation(element) as ElementLocation | null | undefined;
    const attributeLocation = location?.attrs?.[attribute];
    if (!location?.startTag) throw new Error(`Bound element has no source location: ${attribute}`);
    const value = `${attribute}="${escapeAttribute(translation(element.getAttribute(binding)))}"`;
    if (!attributeLocation) {
      let insertionOffset = location.startTag.endOffset - 1;
      if (source[insertionOffset - 1] === '/') insertionOffset -= 1;
      const bindingLocation = location.attrs?.[binding];
      const lineStart = bindingLocation
        ? source.lastIndexOf('\n', bindingLocation.startOffset - 1) + 1
        : -1;
      const indentation =
        lineStart >= 0 && bindingLocation
          ? source.slice(lineStart, bindingLocation.startOffset).match(/^\s*/u)?.[0] || ''
          : '';
      replacements.push({
        start: insertionOffset,
        end: insertionOffset,
        value: source
          .slice(location.startTag.startOffset, location.startTag.endOffset)
          .includes('\n')
          ? `\n${indentation}${value}`
          : ` ${value}`,
      });
      continue;
    }
    replacements.push({
      start: attributeLocation.startOffset,
      end: attributeLocation.endOffset,
      value,
    });
  }
}

replacements.sort((left, right) => right.start - left.start);
let output = source;
let previousStart = source.length;
for (const replacement of replacements) {
  if (replacement.end > previousStart) throw new Error('Overlapping i18n source replacements.');
  output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  previousStart = replacement.start;
}

dom.window.close();
await writeFile(filePath, output, 'utf8');
process.stdout.write(`[sync-index-fallback] updated ${replacements.length} English fallbacks\n`);
