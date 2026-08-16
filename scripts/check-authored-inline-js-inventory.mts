#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_INLINE_INVENTORY_PATH =
  'docs/typescript-migration/authored-inline-js-baseline.json' as const;

const NON_EXECUTABLE_SCRIPT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'importmap',
  'speculationrules',
]);
const EXECUTABLE_MARKUP_PATH_RE = /\.(?:html?|xhtml|svg)$/iu;
const JAVASCRIPT_URL_ATTRIBUTES = new Set([
  'action',
  'data',
  'formaction',
  'href',
  'src',
  'xlink:href',
]);
const RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'style',
  'textarea',
  'title',
  'xmp',
]);

type InlineSourceStatus = 'remaining' | 'retired';

export interface AuthoredInlineSource {
  path: string;
  baselineBlocks: number;
  status: InlineSourceStatus;
}

export interface AuthoredInlineManifest {
  schemaVersion: number;
  capturedAt: string;
  policy: string;
  historicalBlocks: number;
  remainingBlocks: number;
  sources: AuthoredInlineSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRepositoryPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function isExecutableMarkupPath(value: string): boolean {
  return EXECUTABLE_MARKUP_PATH_RE.test(value);
}

interface MarkupAttribute {
  name: string;
  value: string | null;
}

interface MarkupStartTag {
  attributes: MarkupAttribute[];
  end: number;
  name: string;
}

function parseMarkupAttributes(source: string): MarkupAttribute[] {
  const attributes: MarkupAttribute[] = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? '') || source[index] === '/') index += 1;
    if (index >= source.length) break;

    const nameStart = index;
    while (index < source.length && !/[\s=/>]/u.test(source[index] ?? '')) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = source.slice(nameStart, index).toLowerCase();
    while (/\s/u.test(source[index] ?? '')) index += 1;

    let value: string | null = null;
    if (source[index] === '=') {
      index += 1;
      while (/\s/u.test(source[index] ?? '')) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < source.length && !/\s/u.test(source[index] ?? '')) index += 1;
        value = source.slice(valueStart, index).replace(/\/$/u, '');
      }
    }
    attributes.push({ name, value });
  }
  return attributes;
}

function readMarkupStartTag(source: string, start: number): MarkupStartTag | null {
  let index = start + 1;
  if (!/[A-Za-z]/u.test(source[index] ?? '')) return null;
  const nameStart = index;
  while (/[A-Za-z0-9:_-]/u.test(source[index] ?? '')) index += 1;
  const name = source.slice(nameStart, index).toLowerCase();
  const attributesStart = index;
  let quote: '"' | "'" | null = null;
  while (index < source.length) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return {
        attributes: parseMarkupAttributes(source.slice(attributesStart, index)),
        end: index + 1,
        name,
      };
    }
    index += 1;
  }
  return {
    attributes: parseMarkupAttributes(source.slice(attributesStart)),
    end: source.length,
    name,
  };
}

function decodeMarkupCharacterReferences(value: string): string {
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/giu, (reference, hexadecimal, decimal) => {
      const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return reference;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return reference;
      }
    })
    .replace(/&colon;?/giu, ':')
    .replace(/&tab;?/giu, '\t')
    .replace(/&newline;?/giu, '\n');
}

function isJavascriptUrl(value: string): boolean {
  const normalized = decodeMarkupCharacterReferences(value)
    .replace(/^[\u0000-\u0020]+/u, '')
    .replace(/[\t\n\r]/gu, '')
    .toLowerCase();
  return normalized.startsWith('javascript:');
}

function executableAttributeCount(attributes: readonly MarkupAttribute[]): number {
  return attributes.filter((attribute) => {
    if (/^on.+/iu.test(attribute.name)) return true;
    return (
      attribute.value !== null &&
      JAVASCRIPT_URL_ATTRIBUTES.has(attribute.name) &&
      isJavascriptUrl(attribute.value)
    );
  }).length;
}

function closingTag(source: string, start: number, name: string): RegExpExecArray | null {
  const matcher = new RegExp(`</${name}\\s*>`, 'giu');
  matcher.lastIndex = start;
  return matcher.exec(source);
}

/**
 * Count authored executable inline JavaScript constructs. The historical
 * manifest calls these "blocks"; one script body or executable attribute is
 * one block so the original script-block baseline remains stable.
 */
export function countExecutableInlineScripts(source: string): number {
  let count = 0;
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('<', index);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4);
      index = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', start)) {
      const cdataEnd = source.indexOf(']]>', start + 9);
      index = cdataEnd < 0 ? source.length : cdataEnd + 3;
      continue;
    }

    const tag = readMarkupStartTag(source, start);
    if (!tag) {
      index = start + 1;
      continue;
    }
    count += executableAttributeCount(tag.attributes);

    const localName = tag.name.split(':').at(-1) ?? tag.name;
    if (localName === 'script') {
      const closing = closingTag(source, tag.end, tag.name);
      const bodyEnd = closing?.index ?? source.length;
      const body = source.slice(tag.end, bodyEnd);
      const type = decodeMarkupCharacterReferences(
        tag.attributes.find((attribute) => attribute.name === 'type')?.value ?? '',
      )
        .trim()
        .toLowerCase();
      const external = tag.attributes.some((attribute) => attribute.name === 'src');
      if (body.trim().length > 0 && !external && !NON_EXECUTABLE_SCRIPT_TYPES.has(type)) {
        count += 1;
      }
      index = closing ? closing.index + closing[0].length : source.length;
      continue;
    }

    if (RAW_TEXT_ELEMENTS.has(localName)) {
      const closing = closingTag(source, tag.end, tag.name);
      index = closing ? closing.index + closing[0].length : source.length;
      continue;
    }
    index = tag.end;
  }
  return count;
}

export function validateInlineManifest(value: unknown): string[] {
  if (!isRecord(value)) return ['Inline inventory manifest must be a JSON object.'];
  const errors: string[] = [];
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (value.policy !== 'authored-inline-js-shrink-only') {
    errors.push('policy must be "authored-inline-js-shrink-only".');
  }
  if (typeof value.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.capturedAt)) {
    errors.push('capturedAt must be an ISO calendar date.');
  }
  if (!Number.isSafeInteger(value.historicalBlocks) || Number(value.historicalBlocks) < 0) {
    errors.push('historicalBlocks must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(value.remainingBlocks) || Number(value.remainingBlocks) < 0) {
    errors.push('remainingBlocks must be a non-negative integer.');
  }
  if (!Array.isArray(value.sources)) {
    errors.push('sources must be an array.');
    return errors;
  }

  const sources: AuthoredInlineSource[] = [];
  const seen = new Set<string>();
  let previousPath = '';
  for (const [index, candidate] of value.sources.entries()) {
    if (!isRecord(candidate)) {
      errors.push(`sources[${index}] must be an object.`);
      continue;
    }
    const candidatePath =
      typeof candidate.path === 'string' ? normalizeRepositoryPath(candidate.path) : '';
    const baselineBlocks = candidate.baselineBlocks;
    const status = candidate.status;
    if (
      !isExecutableMarkupPath(candidatePath) ||
      candidatePath.startsWith('/') ||
      candidatePath.includes('../')
    ) {
      errors.push(
        `sources[${index}].path must be a normalized repository-relative executable markup path.`,
      );
    }
    if (!Number.isSafeInteger(baselineBlocks) || Number(baselineBlocks) <= 0) {
      errors.push(`${candidatePath || `sources[${index}]`}.baselineBlocks must be positive.`);
    }
    if (status !== 'remaining' && status !== 'retired') {
      errors.push(`${candidatePath || `sources[${index}]`}.status must be remaining or retired.`);
    }
    if (seen.has(candidatePath)) errors.push(`Duplicate source path: ${candidatePath}.`);
    if (previousPath && candidatePath.localeCompare(previousPath, 'en') <= 0) {
      errors.push(`sources must be sorted by path: ${candidatePath} follows ${previousPath}.`);
    }
    seen.add(candidatePath);
    previousPath = candidatePath;
    if (
      candidatePath &&
      Number.isSafeInteger(baselineBlocks) &&
      Number(baselineBlocks) > 0 &&
      (status === 'remaining' || status === 'retired')
    ) {
      sources.push({
        path: candidatePath,
        baselineBlocks: Number(baselineBlocks),
        status,
      });
    }
  }

  const historicalBlocks = sources.reduce((total, source) => total + source.baselineBlocks, 0);
  const remainingBlocks = sources
    .filter((source) => source.status === 'remaining')
    .reduce((total, source) => total + source.baselineBlocks, 0);
  if (value.historicalBlocks !== historicalBlocks) {
    errors.push(
      `historicalBlocks is ${String(value.historicalBlocks)}; sources derive ${historicalBlocks}.`,
    );
  }
  if (value.remainingBlocks !== remainingBlocks) {
    errors.push(
      `remainingBlocks is ${String(value.remainingBlocks)}; sources derive ${remainingBlocks}.`,
    );
  }
  return errors;
}

function repositoryFiles(repository: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repository,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepositoryPath);
}

export function listCurrentInlineSources(repository = process.cwd()): Map<string, number> {
  const current = new Map<string, number>();
  for (const repositoryPath of repositoryFiles(repository).filter((value) =>
    isExecutableMarkupPath(value),
  )) {
    const absolutePath = path.resolve(repository, repositoryPath);
    if (!existsSync(absolutePath)) continue;
    const blocks = countExecutableInlineScripts(readFileSync(absolutePath, 'utf8'));
    if (blocks > 0) current.set(repositoryPath, blocks);
  }
  return current;
}

export function checkCurrentInlineInventory(
  manifest: AuthoredInlineManifest,
  current: ReadonlyMap<string, number>,
): string[] {
  const known = new Map(manifest.sources.map((source) => [source.path, source]));
  const errors: string[] = [];
  for (const [repositoryPath, blocks] of [...current].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    const source = known.get(repositoryPath);
    if (!source) {
      errors.push(`New executable inline script is outside the baseline: ${repositoryPath}.`);
    } else if (source.status === 'retired') {
      errors.push(`Retired executable inline script was restored: ${repositoryPath}.`);
    } else if (blocks !== source.baselineBlocks) {
      errors.push(
        `${repositoryPath} has ${blocks} executable inline blocks; baseline is ${source.baselineBlocks}.`,
      );
    }
  }
  for (const source of manifest.sources) {
    if (source.status === 'remaining' && !current.has(source.path)) {
      errors.push(`Remaining inline source is absent: ${source.path}. Mark it retired atomically.`);
    }
  }
  const currentBlocks = [...current.values()].reduce((total, blocks) => total + blocks, 0);
  if (currentBlocks !== manifest.remainingBlocks) {
    errors.push(
      `Current executable inline block count is ${currentBlocks}; remaining baseline is ${manifest.remainingBlocks}.`,
    );
  }
  return errors;
}

export function checkInlineMonotonicProgress(
  previous: AuthoredInlineManifest,
  current: AuthoredInlineManifest,
): string[] {
  const errors: string[] = [];
  if (previous.capturedAt !== current.capturedAt) errors.push('capturedAt is immutable.');
  if (previous.historicalBlocks !== current.historicalBlocks) {
    errors.push('historicalBlocks is immutable.');
  }
  const previousSources = new Map(previous.sources.map((source) => [source.path, source]));
  const currentSources = new Map(current.sources.map((source) => [source.path, source]));
  for (const [repositoryPath, source] of previousSources) {
    const next = currentSources.get(repositoryPath);
    if (!next) {
      errors.push(`Historical inline source was deleted instead of retired: ${repositoryPath}.`);
      continue;
    }
    if (source.baselineBlocks !== next.baselineBlocks) {
      errors.push(`Historical baselineBlocks changed for ${repositoryPath}.`);
    }
    if (source.status === 'retired' && next.status === 'remaining') {
      errors.push(`Inline baseline regressed from retired to remaining: ${repositoryPath}.`);
    }
  }
  for (const repositoryPath of currentSources.keys()) {
    if (!previousSources.has(repositoryPath)) {
      errors.push(`Historical inline source was added: ${repositoryPath}.`);
    }
  }
  return errors;
}

function optionalGitText(repository: string, args: readonly string[]): string | null {
  try {
    return String(
      execFileSync('git', [...args], {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

function readPreviousManifest(
  repository: string,
  inventoryPath: string,
): AuthoredInlineManifest | null {
  const repositoryPath = normalizeRepositoryPath(path.relative(repository, inventoryPath));
  const status = optionalGitText(repository, ['status', '--porcelain', '--', repositoryPath]);
  const source = status?.trim()
    ? optionalGitText(repository, ['show', `HEAD:${repositoryPath}`])
    : null;
  if (!source) return null;
  const parsed: unknown = JSON.parse(source);
  const errors = validateInlineManifest(parsed);
  if (errors.length > 0) {
    throw new Error(`Previous inline inventory manifest is invalid:\n- ${errors.join('\n- ')}`);
  }
  return parsed as AuthoredInlineManifest;
}

export function runInlineInventoryGuard(
  repository = process.cwd(),
  inventoryPath = path.resolve(repository, DEFAULT_INLINE_INVENTORY_PATH),
): { errors: string[]; manifest: AuthoredInlineManifest | null; current: Map<string, number> } {
  const parsed: unknown = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const errors = validateInlineManifest(parsed);
  if (errors.length > 0) return { errors, manifest: null, current: new Map() };
  const manifest = parsed as AuthoredInlineManifest;
  const current = listCurrentInlineSources(repository);
  errors.push(...checkCurrentInlineInventory(manifest, current));
  const previous = readPreviousManifest(repository, inventoryPath);
  if (previous) errors.push(...checkInlineMonotonicProgress(previous, manifest));
  return { errors, manifest, current };
}

function runCli(): void {
  try {
    const result = runInlineInventoryGuard();
    if (result.errors.length > 0) {
      console.error('[authored-inline-js] FAIL');
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
      return;
    }
    const blocks = [...result.current.values()].reduce((total, count) => total + count, 0);
    console.log(`[authored-inline-js] PASS: ${blocks} executable inline blocks remain.`);
  } catch (error) {
    console.error('[authored-inline-js] FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) runCli();
