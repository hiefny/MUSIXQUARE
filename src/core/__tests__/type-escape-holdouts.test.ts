import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TYPE_SUPPRESSION_PATTERN = /@ts-(?:nocheck|ignore|expect-error)/u;

function candidateProductionTypeScriptFiles(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ':(glob)**/*.ts',
      ':(glob)**/*.tsx',
      ':(glob)**/*.mts',
      ':(glob)**/*.cts',
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .filter((path) => existsSync(path))
    .filter((path) => {
      const normalized = path.replace(/\\/gu, '/');
      return (
        !normalized.includes('/__tests__/') &&
        !normalized.startsWith('e2e/') &&
        !normalized.startsWith('cloudflare/types/') &&
        !/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/u.test(normalized) &&
        !/\.d\.(?:ts|mts|cts)$/u.test(normalized)
      );
    })
    .sort();
}

function scriptKind(path: string): ts.ScriptKind {
  return extname(path).toLowerCase() === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function typeEscapeLocations(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const locations: string[] = [];

  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      locations.push(`${path}:${line + 1}:${character + 1}: explicit any`);
    }
    if (isAssertionExpression(node)) {
      const inner = unwrapParentheses(node.expression);
      if (
        isAssertionExpression(inner) &&
        (node.type.kind === ts.SyntaxKind.UnknownKeyword ||
          inner.type.kind === ts.SyntaxKind.UnknownKeyword)
      ) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        locations.push(`${path}:${line + 1}:${character + 1}: unknown-bridged double assertion`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return locations;
}

function isAssertionExpression(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

describe('production TypeScript type escapes', () => {
  it('recognizes unknown-bridged double assertions without matching ordinary narrowing', () => {
    expect(
      typeEscapeLocations('fixture.ts', 'const value = input as unknown as string;'),
    ).toHaveLength(1);
    expect(typeEscapeLocations('fixture.ts', 'const value = input as string;')).toEqual([]);
  });

  it('keeps every production TypeScript source free of broad type escapes', () => {
    const offenders = candidateProductionTypeScriptFiles().flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const failures = typeEscapeLocations(path, source);
      if (TYPE_SUPPRESSION_PATTERN.test(source)) {
        failures.push(`${path}: TypeScript suppression directive`);
      }
      return failures;
    });

    expect(offenders).toEqual([]);
  }, 30_000);
});
