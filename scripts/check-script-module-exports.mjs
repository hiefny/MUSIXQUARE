#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = resolve(import.meta.dirname);
const VALUE_DECLARATION_RE =
  /export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;

function declaredRuntimeNames(source) {
  return new Set([...source.matchAll(VALUE_DECLARATION_RE)].map((match) => match[1]));
}

async function checkModule(declarationName) {
  const runtimeName = declarationName.replace(/\.d\.mts$/u, '.mjs');
  const declarationPath = resolve(SCRIPT_DIRECTORY, declarationName);
  const runtimePath = resolve(SCRIPT_DIRECTORY, runtimeName);
  if (!existsSync(runtimePath)) {
    return [`${declarationName}: matching runtime module ${runtimeName} is missing`];
  }

  const declared = declaredRuntimeNames(readFileSync(declarationPath, 'utf8'));
  const runtimeModule = await import(pathToFileURL(runtimePath).href);
  const actual = new Set(Object.keys(runtimeModule));
  const failures = [];
  for (const name of declared) {
    if (!actual.has(name)) failures.push(`${declarationName}: stale declaration export ${name}`);
  }
  for (const name of actual) {
    if (!declared.has(name)) failures.push(`${declarationName}: undeclared runtime export ${name}`);
  }
  return failures;
}

const declarations = readdirSync(SCRIPT_DIRECTORY)
  .filter((name) => name.endsWith('.d.mts'))
  .sort();
const failures = (await Promise.all(declarations.map(checkModule))).flat();

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Script declaration exports match ${declarations.length} runtime modules.\n`,
  );
}
