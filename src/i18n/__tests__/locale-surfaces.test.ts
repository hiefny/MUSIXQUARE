import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import { LANGUAGE_OPTIONS } from '../index.ts';

async function classicRuntime(outputPath: string): Promise<string> {
  const asset = CLASSIC_RUNTIME_ASSETS.find((candidate) => candidate.outputPath === outputPath);
  if (!asset) throw new Error(`Classic runtime is missing from the manifest: ${outputPath}`);
  return (await compileClassicRuntimeAsset(process.cwd(), asset)).code;
}

function sourceFile(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function variableInitializer(source: string, fileName: string, name: string): ts.Expression {
  const root = sourceFile(source, fileName);
  let initializer: ts.Expression | undefined;

  function visit(node: ts.Node): void {
    if (
      !initializer &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(root);
  if (!initializer) throw new Error(`Missing ${name} in ${fileName}`);
  return initializer;
}

function unwrapObject(initializer: ts.Expression, name: string): ts.ObjectLiteralExpression {
  let expression = initializer;
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.expression.getText() === 'Object' &&
    expression.expression.name.text === 'freeze'
  ) {
    expression = expression.arguments[0];
  }
  if (!expression || !ts.isObjectLiteralExpression(expression)) {
    throw new Error(`${name} must be an object literal`);
  }
  return expression;
}

function propertyName(property: ts.ObjectLiteralElementLike): string {
  if (!property.name) throw new Error('Object entry is missing a property name');
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    return property.name.text;
  throw new Error(`Unsupported property name: ${property.name.getText()}`);
}

function objectKeys(initializer: ts.Expression, name: string): string[] {
  return unwrapObject(initializer, name).properties.map(propertyName);
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string {
  const property = object.properties.find((entry) => propertyName(entry) === name);
  if (
    !property ||
    !ts.isPropertyAssignment(property) ||
    !ts.isStringLiteral(property.initializer)
  ) {
    throw new Error(`Missing string property ${name}`);
  }
  return property.initializer.text;
}

describe('locale surface parity', () => {
  it('keeps every public locale registry aligned with the app registry', async () => {
    const [appSource, bootstrapSource, staticSource, accountSource, maintenanceSource] =
      await Promise.all([
        readFile('src/i18n/index.ts', 'utf8'),
        classicRuntime('bootstrap.js'),
        classicRuntime('static-language.js'),
        classicRuntime('account-complete.js'),
        readFile('cloudflare/service-maintenance.ts', 'utf8'),
      ]);
    const expectedCodes = LANGUAGE_OPTIONS.map(({ code }) => code).sort();

    const lazyLocaleCodes = objectKeys(
      variableInitializer(appSource, 'src/i18n/index.ts', '_localeLoaders'),
      '_localeLoaders',
    );
    expect([...lazyLocaleCodes, 'en', 'ko'].sort()).toEqual(expectedCodes);

    const bootstrapCodes = objectKeys(
      variableInitializer(bootstrapSource, 'bootstrap.js', 'htmlLangByCode'),
      'htmlLangByCode',
    );
    expect(bootstrapCodes.sort()).toEqual(expectedCodes);

    const accountTranslations = unwrapObject(
      variableInitializer(accountSource, 'account-complete.js', 'translations'),
      'translations',
    );
    expect(accountTranslations.properties.map(propertyName).sort()).toEqual(expectedCodes);
    for (const property of accountTranslations.properties) {
      expect(ts.isPropertyAssignment(property), propertyName(property)).toBe(true);
      if (
        !ts.isPropertyAssignment(property) ||
        !ts.isArrayLiteralExpression(property.initializer)
      ) {
        throw new Error(`Account copy for ${propertyName(property)} must be an array literal`);
      }
      expect(property.initializer.elements, propertyName(property)).toHaveLength(5);
      for (const entry of property.initializer.elements) {
        expect(
          ts.isStringLiteral(entry) && entry.text.trim().length > 0,
          propertyName(property),
        ).toBe(true);
      }
    }

    const maintenanceCodes = objectKeys(
      variableInitializer(
        maintenanceSource,
        'cloudflare/service-maintenance.ts',
        'localizedDescriptions',
      ),
      'localizedDescriptions',
    );
    expect(maintenanceCodes.sort()).toEqual(expectedCodes);

    const staticOptions = variableInitializer(staticSource, 'static-language.js', 'OPTIONS');
    if (!ts.isArrayLiteralExpression(staticOptions)) throw new Error('OPTIONS must be an array');
    const optionRows = staticOptions.elements.map((entry) => {
      if (!ts.isObjectLiteralExpression(entry)) throw new Error('OPTIONS entry must be an object');
      return {
        code: stringProperty(entry, 'code'),
        htmlLang: stringProperty(entry, 'htmlLang'),
        locale: stringProperty(entry, 'locale'),
      };
    });
    expect(optionRows.map(({ code }) => code).sort()).toEqual(expectedCodes);
    expect(optionRows.map(({ code, htmlLang }) => ({ code, htmlLang }))).toEqual(
      LANGUAGE_OPTIONS.map(({ code, htmlLang }) => ({ code, htmlLang })),
    );
    for (const { locale } of optionRows) expect(locale).toMatch(/^[a-z]{2}_[A-Z]{2}$/);
    expect(new Set(optionRows.map(({ locale }) => locale)).size).toBe(optionRows.length);
  });

  it('keeps every app html language on the matching first-paint font stack', async () => {
    const css = await readFile('css/style.css', 'utf8');

    for (const { code, htmlLang } of LANGUAGE_OPTIONS) {
      expect(css, code).toContain(`html:lang(${htmlLang})`);
    }
  });

  it('keeps script-specific font shards paired and retryable through the locale font loader', async () => {
    const source = await readFile('src/i18n/locale-fonts.ts', 'utf8');
    const loaderCodes = objectKeys(
      variableInitializer(source, 'src/i18n/locale-fonts.ts', 'DEFAULT_FONT_LOADERS'),
      'DEFAULT_FONT_LOADERS',
    ).sort();
    const familyCodes = objectKeys(
      variableInitializer(source, 'src/i18n/locale-fonts.ts', 'FONT_FAMILIES'),
      'FONT_FAMILIES',
    ).sort();

    expect(loaderCodes).toEqual(['ja', 'ru', 'th', 'zh-hans', 'zh-hant']);
    expect(familyCodes).toEqual(loaderCodes);
  });
});
