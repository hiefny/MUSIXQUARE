/**
 * @vitest-environment jsdom
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const EM_DASH = '\u2014';
const ESCAPED_EM_DASH_RE = /\\u(?:2014|\{2014\})/iu;
const CSS_ESCAPED_EM_DASH_RE = /\\0{0,4}2014(?:\s|;|\\)?/iu;
const HTML_DASH_SOURCE_RE = /\u2014|&mdash;|&#(?:0*8212|[xX]0*2014);?/u;

const SCRIPT_ROOTS = ['src', 'browser', 'cloudflare', '.workshop'] as const;
const HTML_ROOTS = ['.workshop', 'public'] as const;
const CSS_ROOTS = ['css', 'public', '.workshop'] as const;
const TOP_LEVEL_HTML = ['index.html'] as const;
const BLOG_PREFIX = 'public/blog/';
const EXTERNAL_DECODER_FILES = new Set(['cloudflare/app-worker.ts', 'src/core/html-entities.ts']);

interface Finding {
  readonly path: string;
  readonly location: string;
}

function repositoryPath(filePath: string): string {
  return relative(resolve('.'), filePath).replaceAll('\\', '/');
}

function collectFiles(root: string, extensions: ReadonlySet<string>): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...collectFiles(filePath, extensions));
      continue;
    }
    if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) files.push(filePath);
  }
  return files;
}

function authoredScriptText(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) return node.getText(sourceFile);
  if (
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  ) {
    return node.getText(sourceFile);
  }
  return null;
}

function propertyName(node: ts.Node): string | null {
  const parent = node.parent;
  if (!ts.isPropertyAssignment(parent) || parent.initializer !== node) return null;
  if (ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name)) return parent.name.text;
  return null;
}

function isExternalDecoderException(path: string, node: ts.Node): boolean {
  return EXTERNAL_DECODER_FILES.has(path) && propertyName(node) === 'mdash';
}

function scanScript(
  filePath: string,
  source = readFileSync(filePath, 'utf8'),
): { findings: Finding[]; decoderExceptions: string[] } {
  const path = repositoryPath(filePath);
  if (path.endsWith('.d.ts')) return { findings: [], decoderExceptions: [] };
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const decoderExceptions: string[] = [];

  const visit = (node: ts.Node): void => {
    const authoredText = authoredScriptText(node, sourceFile);
    if (
      authoredText !== null &&
      (authoredText.includes(EM_DASH) || ESCAPED_EM_DASH_RE.test(authoredText))
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (isExternalDecoderException(path, node)) decoderExceptions.push(path);
      else findings.push({ path, location: `line ${line}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { findings, decoderExceptions };
}

function sourceLine(source: string): number {
  const match = HTML_DASH_SOURCE_RE.exec(source);
  if (!match) return 1;
  return source.slice(0, match.index).split(/\r?\n/u).length;
}

function hasAuthoredCssDash(source: string): boolean {
  const authoredCss = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  return authoredCss.includes(EM_DASH) || CSS_ESCAPED_EM_DASH_RE.test(authoredCss);
}

function scanHtml(filePath: string, source = readFileSync(filePath, 'utf8')): Finding[] {
  const path = repositoryPath(filePath);
  const document = new DOMParser().parseFromString(source, 'text/html');
  const findings: Finding[] = [];
  const line = sourceLine(source);
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent?.closest('script, style, template, noscript')) continue;
    if (node.textContent?.includes(EM_DASH)) {
      findings.push({ path, location: `visible text near line ${line}` });
    }
  }

  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (
        attribute.value.includes(EM_DASH) ||
        (attribute.name === 'style' && hasAuthoredCssDash(attribute.value))
      ) {
        findings.push({
          path,
          location: `${element.tagName.toLowerCase()}[${attribute.name}] near line ${line}`,
        });
      }
    }
  }

  for (const style of document.querySelectorAll('style')) {
    if (hasAuthoredCssDash(style.textContent ?? '')) {
      findings.push({ path, location: `inline style near line ${line}` });
    }
  }
  return findings;
}

function scanCss(filePath: string, source = readFileSync(filePath, 'utf8')): Finding[] {
  if (!hasAuthoredCssDash(source)) return [];
  return [{ path: repositoryPath(filePath), location: 'non-comment CSS' }];
}

function formatFindings(findings: readonly Finding[]): string {
  return findings.map(({ path, location }) => `${path}: ${location}`).join('\n');
}

describe('user-facing em dash guard', () => {
  it('rejects em dashes in production TypeScript string literals except external decoders', () => {
    const scriptFiles = SCRIPT_ROOTS.flatMap((root) =>
      collectFiles(resolve(root), new Set(['.ts', '.tsx'])),
    );
    const scans = scriptFiles.map((filePath) => scanScript(filePath));
    const findings = scans.flatMap(({ findings: fileFindings }) => fileFindings);
    const decoderExceptions = scans
      .flatMap(({ decoderExceptions: exceptions }) => exceptions)
      .sort();

    expect(findings, formatFindings(findings)).toEqual([]);
    expect(decoderExceptions).toEqual([...EXTERNAL_DECODER_FILES].sort());
  }, 30_000);

  it('rejects decoded em dashes in public HTML while excluding only the blog path', () => {
    const htmlFiles = [
      ...TOP_LEVEL_HTML.map((path) => resolve(path)),
      ...HTML_ROOTS.flatMap((root) => collectFiles(resolve(root), new Set(['.html']))),
    ];
    const findings = htmlFiles
      .filter((filePath) => !repositoryPath(filePath).startsWith(BLOG_PREFIX))
      .flatMap((filePath) => scanHtml(filePath));

    expect(findings, formatFindings(findings)).toEqual([]);
    expect(BLOG_PREFIX).toBe('public/blog/');
    expect(repositoryPath(resolve('public/blog/index.html')).startsWith(BLOG_PREFIX)).toBe(true);
  });

  it('rejects literal and escaped em dashes in authored CSS outside comments', () => {
    const cssFiles = CSS_ROOTS.flatMap((root) => collectFiles(resolve(root), new Set(['.css'])));
    const findings = cssFiles.flatMap((filePath) => scanCss(filePath));

    expect(findings, formatFindings(findings)).toEqual([]);
  });

  it('recognizes escaped script literals and named or numeric HTML entities', () => {
    const scriptFixture = String.raw`const literal = '—'; const escaped = '\u2014';`;
    const scriptFindings = scanScript(resolve('fixture.ts'), scriptFixture).findings;
    const htmlFindings = scanHtml(
      resolve('fixture.html'),
      String.raw`<p>&mdash;</p><meta name="description" content="&#8212;"><span>&#x2014;</span><style>.x::before{content:'\2014'}</style><i style="--label:'\2014'"></i>`,
    );
    const cssFindings = scanCss(resolve('fixture.css'), String.raw`.x::before{content:'\2014'}`);

    expect(scriptFindings).toHaveLength(2);
    expect(htmlFindings).toHaveLength(5);
    expect(cssFindings).toHaveLength(1);
  });
});
