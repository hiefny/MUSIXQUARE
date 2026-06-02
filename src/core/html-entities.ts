const HTML_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i;
const HTML_ENTITY_RE_G = /&(#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi;

const FALLBACK_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '\u2022',
  copy: '\u00a9',
  divide: '\u00f7',
  gt: '>',
  hellip: '\u2026',
  laquo: '\u00ab',
  ldquo: '\u201c',
  lsquo: '\u2018',
  lt: '<',
  mdash: '\u2014',
  middot: '\u00b7',
  nbsp: '\u00a0',
  ndash: '\u2013',
  plusmn: '\u00b1',
  quot: '"',
  raquo: '\u00bb',
  rdquo: '\u201d',
  reg: '\u00ae',
  rsquo: '\u2019',
  times: '\u00d7',
  trade: '\u2122',
};

let decoderTextArea: HTMLTextAreaElement | null = null;

function decodeNumericEntity(entity: string): string | null {
  const isHex = entity.slice(0, 2).toLowerCase() === '#x';
  const raw = isHex ? entity.slice(2) : entity.slice(1);
  const codePoint = Number.parseInt(raw, isHex ? 16 : 10);
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

function decodeHtmlEntitiesFallback(text: string): string {
  return text.replace(HTML_ENTITY_RE_G, (match, entity: string) => {
    if (entity[0] === '#') return decodeNumericEntity(entity) ?? match;
    return FALLBACK_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function decodeHtmlEntities(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!HTML_ENTITY_RE.test(text)) return text;

  if (typeof document === 'undefined') return decodeHtmlEntitiesFallback(text);

  decoderTextArea ||= document.createElement('textarea');
  decoderTextArea.innerHTML = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return decoderTextArea.value;
}
