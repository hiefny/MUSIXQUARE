import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  MAX_TRANSLATION_TEXT_LENGTH,
  validateProposal,
  type ApprovedTranslationDraft,
  type ApprovedTranslationsExport,
} from '../src/i18n/translation-community.ts';
import { loadCatalogs } from './translation-catalog.ts';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const ABOUT_FILE = 'browser/classic-runtime/landing-i18n.ts';
const DRAFT_KEYS = [
  'id',
  'surface',
  'key',
  'sourceEn',
  'sourceKo',
  'current',
  'locale',
  'proposed',
  'reason',
  'updatedAt',
  'suggestionId',
  'reviewRevision',
  'approvedAt',
];

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isText(value: unknown, max: number, nonempty = false): value is string {
  return typeof value === 'string' && value.length <= max && (!nonempty || !!value.trim());
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function approvedExport(value: unknown): ApprovedTranslationsExport {
  if (
    !exactRecord(value, ['version', 'kind', 'exportedAt', 'drafts']) ||
    value.version !== 1 ||
    value.kind !== 'musixquare-approved-translations' ||
    !isTimestamp(value.exportedAt) ||
    !Array.isArray(value.drafts) ||
    value.drafts.length === 0 ||
    value.drafts.length > 1000
  ) {
    throw new Error('Expected a nonempty version 1 approved-translations export.');
  }
  const drafts: ApprovedTranslationDraft[] = [];
  const suggestions = new Set<string>();
  const targets = new Set<string>();
  for (const item of value.drafts) {
    if (
      !exactRecord(item, DRAFT_KEYS) ||
      !isText(item.id, 256, true) ||
      !isText(item.key, 256, true) ||
      (item.surface !== 'app' && item.surface !== 'about') ||
      item.id !== `${item.surface}:${item.key}` ||
      !isText(item.locale, 32) ||
      !/^[a-z]{2,3}(?:-[a-z]+)?$/u.test(item.locale) ||
      !isText(item.sourceEn, MAX_TRANSLATION_TEXT_LENGTH) ||
      !isText(item.sourceKo, MAX_TRANSLATION_TEXT_LENGTH) ||
      !isText(item.current, MAX_TRANSLATION_TEXT_LENGTH) ||
      !isText(item.proposed, MAX_TRANSLATION_TEXT_LENGTH) ||
      !isText(item.reason, 4000) ||
      !isTimestamp(item.updatedAt) ||
      !isText(item.suggestionId, 128) ||
      !/^[A-Za-z0-9_-]+$/u.test(item.suggestionId) ||
      !positiveInteger(item.reviewRevision) ||
      !positiveInteger(item.approvedAt)
    ) {
      throw new Error('Invalid approved translation fields.');
    }
    const target = JSON.stringify([item.locale, item.id]);
    if (suggestions.has(item.suggestionId) || targets.has(target)) {
      throw new Error('Duplicate suggestion/revision or conflicting translation target.');
    }
    suggestions.add(item.suggestionId);
    targets.add(target);
    drafts.push({
      id: item.id,
      surface: item.surface,
      key: item.key,
      sourceEn: item.sourceEn,
      sourceKo: item.sourceKo,
      current: item.current,
      locale: item.locale,
      proposed: item.proposed,
      reason: item.reason,
      updatedAt: item.updatedAt,
      suggestionId: item.suggestionId,
      reviewRevision: item.reviewRevision,
      approvedAt: item.approvedAt,
    });
  }
  return {
    version: 1,
    kind: 'musixquare-approved-translations',
    exportedAt: value.exportedAt,
    drafts,
  };
}

/** Bound the actual read, including a file that grows after stat, before decoding/parsing. */
async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`File exceeds size limit: ${file}`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(`File exceeds size limit: ${file}`);
    return Buffer.from(buffer.subarray(0, length));
  } finally {
    await handle.close();
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function parseInput(bytes: Uint8Array): ApprovedTranslationsExport {
  const text = decode(bytes).replace(/^\uFEFF/u, '');
  const value: unknown = JSON.parse(text);
  // JSON.parse otherwise silently accepts duplicate field names in review data.
  const source = ts.parseJsonText('approved-translations.json', text);
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
        if (seen.has(property.name.text)) throw new Error('Duplicate JSON field.');
        seen.add(property.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return approvedExport(value);
}

interface Snapshot {
  relativePath: string;
  absolutePath: string;
  bytes: Buffer;
  text: string;
  mode: number;
}

async function snapshot(root: string, relativePath: string): Promise<Snapshot> {
  const absolutePath = path.resolve(root, relativePath);
  const realPath = await fs.realpath(absolutePath);
  const relative = path.relative(root, realPath);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative) ||
    relative !== path.relative(root, absolutePath)
  ) {
    throw new Error(`Source must be a regular path inside the repository: ${relativePath}`);
  }
  const bytes = await readBounded(absolutePath, 16 * 1024 * 1024);
  return {
    relativePath,
    absolutePath,
    bytes,
    text: decode(bytes),
    mode: (await fs.stat(absolutePath)).mode,
  };
}

async function assertUnchanged(root: string, sources: readonly Snapshot[]): Promise<void> {
  for (const source of sources) {
    const current = await snapshot(root, source.relativePath);
    if (!current.bytes.equals(source.bytes))
      throw new Error(`Source changed during review: ${source.relativePath}`);
  }
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function variable(statements: ts.NodeArray<ts.Statement>, name: string): ts.Expression {
  const matches = statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations].filter(
          (item) => ts.isIdentifier(item.name) && item.name.text === name,
        )
      : [],
  );
  if (matches.length !== 1 || !matches[0]?.initializer)
    throw new Error(`Missing or duplicate dictionary: ${name}`);
  return unwrap(matches[0].initializer);
}

function object(expression: ts.Expression): ts.ObjectLiteralExpression {
  const value = unwrap(expression);
  if (!ts.isObjectLiteralExpression(value))
    throw new Error('Expected an explicit dictionary object.');
  return value;
}

function property(dictionary: ts.ObjectLiteralExpression, key: string): ts.Expression {
  const matches = dictionary.properties.filter(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) &&
      (ts.isStringLiteral(item.name) || ts.isIdentifier(item.name)) &&
      item.name.text === key,
  );
  if (matches.length !== 1 || !matches[0])
    throw new Error(`Expected one explicit dictionary key: ${key}`);
  return unwrap(matches[0].initializer);
}

function parseSource(file: Snapshot, text = file.text): ts.SourceFile {
  const source = ts.createSourceFile(
    file.relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics.length) throw new Error(`Invalid TypeScript source: ${file.relativePath}`);
  return source;
}

function dictionaryFor(
  source: ts.SourceFile,
  draft: ApprovedTranslationDraft,
): ts.ObjectLiteralExpression {
  if (draft.surface === 'app') {
    const exports = source.statements.filter(ts.isExportAssignment);
    if (exports.length !== 1 || !exports[0] || exports[0].isExportEquals)
      throw new Error('Expected one default dictionary export.');
    const value = unwrap(exports[0].expression);
    return object(ts.isIdentifier(value) ? variable(source.statements, value.text) : value);
  }
  const statement = source.statements.find(ts.isExpressionStatement);
  const call = statement && unwrap(statement.expression);
  const fn = call && ts.isCallExpression(call) ? unwrap(call.expression) : undefined;
  if (!fn || !ts.isFunctionExpression(fn)) throw new Error('Expected the About dictionary IIFE.');
  const statements = fn.body.statements;
  const base = object(variable(statements, 'baseDictionaries'));
  const matches: ts.ObjectLiteralExpression[] = [];
  for (const item of base.properties) {
    if (
      ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === draft.locale
    ) {
      matches.push(object(item.initializer));
    }
  }
  for (const item of statements) {
    if (!ts.isExpressionStatement(item)) continue;
    const expression = unwrap(item.expression);
    if (
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      expression.expression.text !== 'addLang' ||
      expression.arguments.length !== 2
    )
      continue;
    const code = unwrap(expression.arguments[0]!);
    if (
      (ts.isStringLiteral(code) || ts.isNoSubstitutionTemplateLiteral(code)) &&
      code.text === draft.locale
    ) {
      matches.push(object(expression.arguments[1]!));
    }
  }
  if (matches.length !== 1 || !matches[0])
    throw new Error(`Expected one About dictionary: ${draft.locale}`);
  return matches[0];
}

function stringLiteral(value: string): string {
  // Always emit a literal, including apostrophes, backticks, ${...} and newlines.
  const escaped = value
    .replace(/\\/gu, '\\\\')
    .replace(/'/gu, "\\'")
    .replace(/[\u0000-\u001f\u2028\u2029\uD800-\uDFFF]/gu, (character) => {
      if (character === '\n') return '\\n';
      if (character === '\r') return '\\r';
      if (character === '\t') return '\\t';
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });
  return `'${escaped}'`;
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
}
interface Change {
  source: Snapshot;
  text: string;
  count: number;
}

async function commit(root: string, snapshots: Snapshot[], changes: Change[]): Promise<void> {
  const staged: { change: Change; temporary: string; backup: string; committed: boolean }[] = [];
  const retained = new Set<string>();
  const created = new Set<string>();
  async function stage(file: string, data: string | Buffer, mode: number): Promise<void> {
    const handle = await fs.open(file, 'wx', mode);
    created.add(file);
    try {
      await fs.writeFile(handle, data);
    } finally {
      await handle.close();
    }
  }
  try {
    for (const change of changes) {
      const suffix = `.translation-${randomUUID()}`;
      const item = {
        change,
        temporary: `${change.source.absolutePath}${suffix}.tmp`,
        backup: `${change.source.absolutePath}${suffix}.bak`,
        committed: false,
      };
      staged.push(item);
      await stage(item.temporary, change.text, change.source.mode);
      await stage(item.backup, change.source.bytes, change.source.mode);
    }
    // Check every reference and target again after staging, before touching any source.
    await assertUnchanged(root, snapshots);
    for (const item of staged) {
      await fs.rename(item.temporary, item.change.source.absolutePath);
      item.committed = true;
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const item of [...staged].reverse()) {
      if (!item.committed) continue;
      try {
        const current = await snapshot(root, item.change.source.relativePath);
        if (current.text !== item.change.text)
          throw new Error('A concurrent edit prevents rollback.');
        await fs.rename(item.backup, item.change.source.absolutePath);
      } catch (rollbackError) {
        retained.add(item.backup);
        failures.push(
          new Error(`Restore the original from ${item.backup}`, { cause: rollbackError }),
        );
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'Apply failed; an original backup requires manual recovery.',
      );
    throw error;
  } finally {
    for (const file of created) {
      if (retained.has(file)) continue;
      // Cleanup failure must not hide a commit/rollback result. Keep the exact
      // path visible for recovery, and never delete a file this run did not create.
      await fs.rm(file, { force: true }).catch((error: unknown) => {
        console.error(`Could not remove translation temporary file: ${file}`, error);
      });
    }
  }
}

/** Approval metadata is review evidence, not a signature; use a trusted admin export. */
export async function applyTranslationSuggestions(
  repoRoot: string,
  inputPath: string,
  write = false,
): Promise<{
  mode: 'dry-run' | 'write';
  suggestions: number;
  files: { path: string; changes: number }[];
}> {
  const approved = parseInput(await readBounded(inputPath, MAX_INPUT_BYTES));
  const root = await fs.realpath(repoRoot);
  const paths = new Set(['src/i18n/locales.ts', 'src/i18n/en.ts', 'src/i18n/ko.ts', ABOUT_FILE]);
  for (const draft of approved.drafts) paths.add(`src/i18n/${draft.locale}.ts`);
  const snapshots = await Promise.all([...paths].map((file) => snapshot(root, file)));
  const sources = new Map(snapshots.map((source) => [source.relativePath, source]));
  const catalogs = await loadCatalogs(root);
  await assertUnchanged(root, snapshots);
  const edits = new Map<Snapshot, Edit[]>();
  for (const draft of approved.drafts) {
    const entry = catalogs.get(draft.locale)?.entries.find((item) => item.id === draft.id);
    if (!entry || entry.surface !== draft.surface || entry.key !== draft.key)
      throw new Error(`Unsupported translation: ${draft.locale}/${draft.id}`);
    if (
      entry.sourceEn !== draft.sourceEn ||
      entry.sourceKo !== draft.sourceKo ||
      entry.current !== draft.current
    ) {
      throw new Error(`Stale translation baseline: ${draft.locale}/${draft.id}`);
    }
    const issues = validateProposal(entry, draft.proposed);
    if (issues.length)
      throw new Error(`Invalid proposal ${draft.locale}/${draft.id}: ${issues.join(', ')}`);
    const file = sources.get(draft.surface === 'app' ? `src/i18n/${draft.locale}.ts` : ABOUT_FILE)!;
    const source = parseSource(file);
    const literal = property(dictionaryFor(source, draft), draft.key);
    if (
      (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal)) ||
      literal.text !== draft.current
    ) {
      throw new Error(
        `Translation must be one explicit string literal: ${draft.locale}/${draft.id}`,
      );
    }
    const list = edits.get(file) ?? [];
    list.push({
      start: literal.getStart(source),
      end: literal.end,
      replacement: stringLiteral(draft.proposed),
    });
    edits.set(file, list);
  }
  const changes: Change[] = [];
  for (const [source, ranges] of edits) {
    let text = source.text;
    let nextStart = text.length;
    for (const edit of ranges.sort((a, b) => b.start - a.start)) {
      if (edit.end > nextStart)
        throw new Error(`Overlapping translation edits: ${source.relativePath}`);
      text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
      nextStart = edit.start;
    }
    parseSource(source, text);
    changes.push({ source, text, count: ranges.length });
  }
  if (write) await commit(root, snapshots, changes);
  return {
    mode: write ? 'write' : 'dry-run',
    suggestions: approved.drafts.length,
    files: changes.map(({ source, count }) => ({ path: source.relativePath, changes: count })),
  };
}

async function main(args: string[]): Promise<void> {
  const input = args.find((argument) => !argument.startsWith('--'));
  if (
    !input ||
    args.some((argument) => argument !== input && argument !== '--write') ||
    args.filter((argument) => argument === input).length !== 1 ||
    args.filter((argument) => argument === '--write').length > 1
  ) {
    throw new Error(
      'Usage: node scripts/apply-translation-suggestions.mts <approved.json> [--write]',
    );
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await applyTranslationSuggestions(
    root,
    path.resolve(input),
    args.includes('--write'),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
