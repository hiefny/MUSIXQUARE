#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const VALUE_DECLARATION_RE =
  /export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
const DEFAULT_DECLARATION_RE = /export\s+default\b/u;

const DECLARATION_TARGETS = Object.freeze([
  {
    label: 'script',
    directory: resolve(REPOSITORY_ROOT, 'scripts'),
    declarationSuffix: '.d.mts',
    runtimeSuffix: '.mjs',
  },
  {
    label: 'Cloudflare',
    directory: resolve(REPOSITORY_ROOT, 'cloudflare'),
    declarationSuffix: '.d.ts',
    runtimeSuffix: '.js',
    inspectRuntimeSource: true,
  },
]);

export function declaredRuntimeNames(source) {
  const names = new Set([...source.matchAll(VALUE_DECLARATION_RE)].map((match) => match[1]));
  if (DEFAULT_DECLARATION_RE.test(source)) names.add('default');
  return names;
}

export function compareRuntimeExports(declarationName, declared, actual) {
  const failures = [];
  for (const name of declared) {
    if (!actual.has(name)) failures.push(`${declarationName}: stale declaration export ${name}`);
  }
  for (const name of actual) {
    if (!declared.has(name)) failures.push(`${declarationName}: undeclared runtime export ${name}`);
  }
  return failures;
}

function hasExportModifier(node) {
  return node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true;
}

export function runtimeSourceNames(source, fileName = 'runtime.js') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add('default');
      continue;
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) names.add(element.name.text);
        }
      }
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) names.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

export function runtimeNameForDeclaration(declarationName, declarationSuffix, runtimeSuffix) {
  if (!declarationName.endsWith(declarationSuffix)) {
    throw new Error(`${declarationName}: expected declaration suffix ${declarationSuffix}`);
  }
  return `${declarationName.slice(0, -declarationSuffix.length)}${runtimeSuffix}`;
}

async function checkModule(target, declarationName) {
  const runtimeName = runtimeNameForDeclaration(
    declarationName,
    target.declarationSuffix,
    target.runtimeSuffix,
  );
  const declarationPath = resolve(target.directory, declarationName);
  const runtimePath = resolve(target.directory, runtimeName);
  const displayName = `${target.label}/${declarationName}`;
  if (!existsSync(runtimePath)) {
    return [`${displayName}: matching runtime module ${runtimeName} is missing`];
  }

  const declared = declaredRuntimeNames(readFileSync(declarationPath, 'utf8'));
  const inspectRuntimeSource =
    target.inspectRuntimeSource || pathToFileURL(runtimePath).href === import.meta.url;
  const actual = inspectRuntimeSource
    ? runtimeSourceNames(readFileSync(runtimePath, 'utf8'), runtimeName)
    : new Set(Object.keys(await import(pathToFileURL(runtimePath).href)));
  return compareRuntimeExports(displayName, declared, actual);
}

export async function checkDeclarationTarget(target) {
  const declarations = readdirSync(target.directory)
    .filter((name) => name.endsWith(target.declarationSuffix))
    .sort();
  return {
    count: declarations.length,
    failures: (await Promise.all(declarations.map((name) => checkModule(target, name)))).flat(),
  };
}

export async function runDeclarationExportChecks(targets = DECLARATION_TARGETS) {
  const results = await Promise.all(targets.map(checkDeclarationTarget));
  return {
    results: targets.map((target, index) => ({ label: target.label, count: results[index].count })),
    failures: results.flatMap(({ failures }) => failures),
  };
}

async function main() {
  const { results, failures } = await runDeclarationExportChecks();
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Runtime declaration exports match ${results.map(({ label, count }) => `${count} ${label} modules`).join(' and ')}.\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
