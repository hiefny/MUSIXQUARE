import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

// Exercise the guard's private HTML predicate without executing its full
// repository/build-artifact CLI or duplicating that predicate in this fixture.
const source = readFileSync('scripts/check-app-font.mts', 'utf8');
const parsed = ts.createSourceFile('check-app-font.mts', source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'hasFontPreload',
);
if (!declaration) throw new Error('Missing font preload guard');
const compiled = ts.transpileModule(declaration.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const fontUrl = '/designsystem/fonts/PretendardVariable.woff2';
const hasFontPreload = Function('fontUrl', `${compiled}; return hasFontPreload;`)(fontUrl) as (
  html: string,
) => boolean;

describe('canonical full font preload guard', () => {
  it.each(['"', "'"])('detects an eager font preload with %s attributes', (quote) => {
    const html = `<link rel=${quote}preload${quote} href=${quote}${fontUrl}${quote} as=${quote}font${quote} type=${quote}font/woff2${quote} crossorigin>`;
    expect(hasFontPreload(html)).toBe(true);
  });

  it('does not confuse a different href or a stylesheet link with the full-font preload', () => {
    expect(
      hasFontPreload(
        '<link rel="preload" href="/icon.svg" as="font" type="font/woff2" crossorigin>',
      ),
    ).toBe(false);
    expect(
      hasFontPreload(
        `<link rel="stylesheet" href="${fontUrl}" as="font" type="font/woff2" crossorigin>`,
      ),
    ).toBe(false);
  });
});

// Execute the actual guard's three bootstrap reads and checks. Keeping their
// binding-to-input relationship catches accidentally checking minified output
// as authored source, or comparing a deployed artifact with the wrong input.
function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!found) throw new Error('Missing font guard contract node');
  return found;
}

function readBinding(name: string): string {
  const declaration = findNode(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.name.elements.some((element) => element.getText(parsed) === name),
  ) as ts.VariableDeclaration;
  if (!ts.isArrayBindingPattern(declaration.name)) throw new Error('Missing read bindings');
  const index = declaration.name.elements.findIndex((element) => element.getText(parsed) === name);
  const initializer = declaration.initializer;
  if (
    !initializer ||
    !ts.isAwaitExpression(initializer) ||
    !ts.isCallExpression(initializer.expression) ||
    initializer.expression.expression.getText(parsed) !== 'Promise.all'
  ) {
    throw new Error('Unexpected font guard read contract');
  }
  const inputs = initializer.expression.arguments[0];
  if (!inputs || !ts.isArrayLiteralExpression(inputs) || !inputs.elements[index]) {
    throw new Error('Missing font guard read input');
  }
  return `const ${name} = await ${inputs.elements[index].getText(parsed)};`;
}

const schedulerMessages = [
  'bootstrap font scheduler lacks bounded retryable loading for the lazy font runtime',
  'bootstrap font scheduler must wait for load/idle and recover on connectivity or visibility',
  'built early bootstrap runtime differs from the classic-runtime compiler output',
] as const;
const schedulerStatements = [
  ...['bootstrapAuthoredSource', 'bootstrapSource', 'distBootstrapRuntime'].map(readBinding),
  ...schedulerMessages.map((message) =>
    findNode(
      (node) =>
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(parsed) === 'check' &&
        node.expression.arguments[1]?.getText(parsed) === `'${message}'`,
    ).getText(parsed),
  ),
].join('\n');
const runSchedulerChecks = Function(
  'readFile',
  'compileClassicRuntimeAsset',
  'bootstrapRuntimeAsset',
  'repoRoot',
  'distDirectory',
  'path',
  `return (async () => {
    const failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    ${schedulerStatements}
    return failures;
  })();`,
) as (
  readFile: (filename: string) => Promise<string>,
  compile: typeof compileClassicRuntimeAsset,
  asset: (typeof CLASSIC_RUNTIME_ASSETS)[number],
  root: string,
  dist: string,
  paths: typeof path,
) => Promise<string[]>;

const bootstrapEntry = CLASSIC_RUNTIME_ASSETS.find((asset) => asset.outputPath === 'bootstrap.js');
if (!bootstrapEntry) throw new Error('Missing bootstrap manifest entry');
const bootstrapAsset = bootstrapEntry;
const repoRoot = path.resolve('.');
const authoredBootstrap = readFileSync(bootstrapAsset.sourcePath, 'utf8');
const compiledBootstrap = (await compileClassicRuntimeAsset(repoRoot, bootstrapAsset)).code;

async function schedulerFailures(authored = authoredBootstrap, built = compiledBootstrap) {
  return runSchedulerChecks(
    async (filename) => {
      if (filename === path.join(repoRoot, bootstrapAsset.sourcePath)) return authored;
      if (filename === path.join(repoRoot, 'dist', 'bootstrap.js')) return built;
      throw new Error(`Unexpected font guard input: ${filename}`);
    },
    compileClassicRuntimeAsset,
    bootstrapAsset,
    repoRoot,
    path.join(repoRoot, 'dist'),
    path,
  );
}

describe('bootstrap font scheduler source and compiled artifact guard', () => {
  it('accepts actual authored contracts with identifier-minified compiled output', async () => {
    expect(compiledBootstrap).not.toContain('RUNTIME_TIMEOUT_MS');
    expect(await schedulerFailures()).toEqual([]);
  });

  it.each([
    ['runtime deadline', 'RUNTIME_TIMEOUT_MS', 'removedDeadline', schedulerMessages[0]],
    ['retry timer', 'retryTimer', 'removedTimer', schedulerMessages[0]],
    ['retry cap', 'Math.min(30000,', 'Math.min(60000,', schedulerMessages[0]],
    ['load gate', "addEventListener('load'", "addEventListener('unused'", schedulerMessages[1]],
    ['idle gate', 'requestIdleCallback', 'removedIdleCallback', schedulerMessages[1]],
    [
      'connectivity retry',
      "addEventListener('online'",
      "addEventListener('unused'",
      schedulerMessages[1],
    ],
    [
      'visibility retry',
      "document.addEventListener('visibilitychange'",
      "document.addEventListener('unused'",
      schedulerMessages[1],
    ],
  ])(
    'rejects a missing %s source contract while the compiled artifact is valid',
    async (_label, token, replacement, message) => {
      expect(authoredBootstrap).toContain(token);
      expect(await schedulerFailures(authoredBootstrap.replaceAll(token, replacement))).toEqual([
        message,
      ]);
    },
  );

  it('rejects changed deployed bytes even when the authored source remains valid', async () => {
    expect(await schedulerFailures(authoredBootstrap, `${compiledBootstrap}\n;`)).toEqual([
      schedulerMessages[2],
    ]);
  });
});
