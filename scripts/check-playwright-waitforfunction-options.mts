import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT = path.resolve('e2e');
const fix = process.argv.includes('--fix');

interface WaitForFunctionViolation {
  insertAt: number;
  line: number;
  column: number;
}

interface FileViolation extends WaitForFunctionViolation {
  file: string;
}

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(target);
      return entry.isFile() && target.endsWith('.ts') ? [target] : [];
    }),
  );
  return nested.flat();
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function isTimeoutObject(node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => {
    if (!('name' in property) || !property.name) return false;
    return propertyNameText(property.name) === 'timeout';
  });
}

function hasZeroCallbackParameters(node: ts.Node): boolean {
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parameters.length === 0
  );
}

function findMisusedCalls(sourceFile: ts.SourceFile): WaitForFunctionViolation[] {
  const violations: WaitForFunctionViolation[] = [];
  const visit = (node: ts.Node): void => {
    const callback = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    const options = ts.isCallExpression(node) ? node.arguments[1] : undefined;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'waitForFunction' &&
      node.arguments.length === 2 &&
      callback !== undefined &&
      options !== undefined &&
      hasZeroCallbackParameters(callback) &&
      isTimeoutObject(options)
    ) {
      const insertAt = options.getStart(sourceFile);
      const location = sourceFile.getLineAndCharacterOfPosition(insertAt);
      violations.push({
        insertAt,
        line: location.line + 1,
        column: location.character + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

const files = await listTypeScriptFiles(ROOT);
const allViolations: FileViolation[] = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = findMisusedCalls(sourceFile);
  if (violations.length === 0) continue;
  allViolations.push(...violations.map((violation) => ({ file, ...violation })));

  if (fix) {
    let updated = source;
    for (const violation of violations.toSorted((a, b) => b.insertAt - a.insertAt)) {
      updated = `${updated.slice(0, violation.insertAt)}undefined, ${updated.slice(violation.insertAt)}`;
    }
    await writeFile(file, updated);
  }
}

if (allViolations.length > 0 && !fix) {
  console.error(
    'Playwright waitForFunction options were passed as the callback argument. ' +
      'Use waitForFunction(fn, undefined, { timeout }).',
  );
  for (const violation of allViolations) {
    console.error(
      `- ${path.relative(process.cwd(), violation.file)}:${violation.line}:${violation.column}`,
    );
  }
  process.exitCode = 1;
} else if (fix) {
  console.log(`Fixed ${allViolations.length} waitForFunction option call(s).`);
} else {
  console.log('Playwright waitForFunction option signatures are valid.');
}
