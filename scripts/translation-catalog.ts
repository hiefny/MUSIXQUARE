import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export interface CatalogLanguage {
  code: string;
  nativeName: string;
  htmlLang: string;
}

export interface CatalogEntry {
  id: string;
  surface: 'app' | 'about';
  key: string;
  sourceEn: string;
  sourceKo: string;
  current: string;
}

export interface Catalog {
  locale: CatalogLanguage;
  languages: CatalogLanguage[];
  entries: CatalogEntry[];
}

type Dictionary = Record<string, string>;

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

function literalString(expression: ts.Expression): string {
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return literalString(value.left) + literalString(value.right);
  }
  throw new Error(`Unsupported translation value: ${ts.SyntaxKind[value.kind]}`);
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  throw new Error('Computed or non-string dictionary key is not supported.');
}

function objectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression {
  const value = unwrap(expression);
  if (!ts.isObjectLiteralExpression(value)) throw new Error('Expected a literal dictionary.');
  return value;
}

function stringDictionary(
  expression: ts.Expression,
  spreads = new Map<string, Dictionary>(),
): Dictionary {
  const result: Dictionary = Object.create(null);
  const explicitKeys = new Set<string>();
  for (const property of objectLiteral(expression).properties) {
    if (ts.isSpreadAssignment(property)) {
      const source = unwrap(property.expression);
      const dictionary = ts.isIdentifier(source) ? spreads.get(source.text) : undefined;
      if (!dictionary)
        throw new Error('Only a known literal English dictionary spread is supported.');
      Object.assign(result, dictionary);
      continue;
    }
    if (!ts.isPropertyAssignment(property))
      throw new Error('Dictionary methods/getters are not supported.');
    const key = propertyName(property.name);
    if (explicitKeys.has(key)) throw new Error(`Duplicate dictionary key: ${key}`);
    explicitKeys.add(key);
    result[key] = literalString(property.initializer);
  }
  return result;
}

async function parseSource(repoRoot: string, relativePath: string): Promise<ts.SourceFile> {
  const text = await readFile(path.join(repoRoot, relativePath), 'utf8');
  const source = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics.length > 0) throw new Error(`Cannot parse ${relativePath}.`);
  return source;
}

function variableInitializer(statements: ts.NodeArray<ts.Statement>, name: string): ts.Expression {
  const declarations = statements.flatMap((statement) =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
  );
  const matches = declarations.filter(
    (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
  );
  if (matches.length !== 1 || !matches[0]?.initializer)
    throw new Error(`Missing or duplicate ${name}.`);
  return matches[0].initializer;
}

async function readLanguages(repoRoot: string): Promise<CatalogLanguage[]> {
  const source = await parseSource(repoRoot, 'src/i18n/locales.ts');
  const expression = unwrap(variableInitializer(source.statements, 'LANGUAGE_OPTIONS'));
  if (!ts.isArrayLiteralExpression(expression))
    throw new Error('Language options must be a literal array.');
  const languages = expression.elements.map((element) => {
    const row = stringDictionary(element);
    const { code, nativeName, htmlLang } = row;
    if (!code || !nativeName || !htmlLang || !/^[a-z]{2,3}(?:-[a-z]+)?$/u.test(code)) {
      throw new Error('Invalid language metadata.');
    }
    return { code, nativeName, htmlLang };
  });
  if (new Set(languages.map(({ code }) => code)).size !== languages.length) {
    throw new Error('Supported language codes must be distinct.');
  }
  if (
    !languages.some(({ code }) => code === 'en') ||
    !languages.some(({ code }) => code === 'ko')
  ) {
    throw new Error('English and Korean references are required.');
  }
  return languages;
}

async function readAppDictionary(
  repoRoot: string,
  code: string,
  english?: Dictionary,
): Promise<Dictionary> {
  const source = await parseSource(repoRoot, `src/i18n/${code}.ts`);
  const exports = source.statements.filter(ts.isExportAssignment);
  const exported = exports[0];
  if (exports.length !== 1 || !exported || exported.isExportEquals)
    throw new Error(`Invalid default export: ${code}`);
  const value = unwrap(exported.expression);
  const expression = ts.isIdentifier(value)
    ? variableInitializer(source.statements, value.text)
    : value;
  const spreads = new Map<string, Dictionary>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const clause = statement.importClause;
    if (
      !clause?.name ||
      clause.namedBindings ||
      literalString(statement.moduleSpecifier) !== './en.ts' ||
      !english
    ) {
      throw new Error(`Unsupported runtime dictionary import: ${code}`);
    }
    spreads.set(clause.name.text, english);
  }
  return stringDictionary(expression, spreads);
}

async function readAboutDictionaries(repoRoot: string): Promise<Map<string, Dictionary>> {
  const source = await parseSource(repoRoot, 'browser/classic-runtime/landing-i18n.ts');
  const entry = source.statements.find(ts.isExpressionStatement);
  const call = entry && unwrap(entry.expression);
  const fn = call && ts.isCallExpression(call) ? unwrap(call.expression) : undefined;
  if (!fn || !ts.isFunctionExpression(fn)) throw new Error('Expected the About dictionary IIFE.');
  const statements = fn.body.statements;
  const base = objectLiteral(variableInitializer(statements, 'baseDictionaries'));
  const i18n = unwrap(variableInitializer(statements, 'i18n'));
  if (!ts.isIdentifier(i18n) || i18n.text !== 'baseDictionaries')
    throw new Error('Unknown About merge structure.');
  const addLang = statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'addLang',
  );
  const assignStatement = addLang?.body?.statements[0];
  const assignment =
    assignStatement && ts.isExpressionStatement(assignStatement)
      ? assignStatement.expression
      : undefined;
  if (
    addLang?.body?.statements.length !== 1 ||
    !assignment ||
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isElementAccessExpression(assignment.left) ||
    assignment.left.expression.getText(source) !== 'i18n' ||
    assignment.left.argumentExpression.getText(source) !== 'code' ||
    assignment.right.getText(source) !== 'dict'
  )
    throw new Error('Unknown About addLang semantics.');

  const dictionaries = new Map<string, Dictionary>();
  for (const property of base.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error('Unknown About base structure.');
    const code = propertyName(property.name);
    if (dictionaries.has(code)) throw new Error(`Duplicate About locale: ${code}`);
    dictionaries.set(code, stringDictionary(property.initializer));
  }
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = unwrap(statement.expression);
    if (
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      expression.expression.text !== 'addLang'
    )
      continue;
    if (expression.arguments.length !== 2) throw new Error('Unexpected About addLang arguments.');
    const code = literalString(expression.arguments[0]!);
    if (dictionaries.has(code)) throw new Error(`Duplicate About locale: ${code}`);
    dictionaries.set(code, stringDictionary(expression.arguments[1]!));
  }
  return dictionaries;
}

function assertKeys(dictionary: Dictionary, reference: string[], label: string): void {
  const keys = Object.keys(dictionary);
  if (
    keys.length !== reference.length ||
    reference.some((key) => !Object.hasOwn(dictionary, key))
  ) {
    throw new Error(`Dictionary keys do not match the reference: ${label}`);
  }
}

/** Parse data only. No locale module, browser script, or translation expression is executed. */
export async function loadCatalogs(repoRoot: string): Promise<Map<string, Catalog>> {
  const languages = await readLanguages(repoRoot);
  const english = await readAppDictionary(repoRoot, 'en');
  const korean = await readAppDictionary(repoRoot, 'ko');
  const about = await readAboutDictionaries(repoRoot);
  const appKeys = Object.keys(korean);
  const aboutEn = about.get('en');
  const aboutKo = about.get('ko');
  if (!aboutEn || !aboutKo) throw new Error('Missing About references.');
  const aboutKeys = Object.keys(aboutEn);
  if (appKeys.length === 0 || aboutKeys.length === 0 || about.size !== languages.length) {
    throw new Error('Expected nonempty app and About references for every supported language.');
  }
  assertKeys(english, appKeys, 'app:en');
  assertKeys(aboutKo, aboutKeys, 'about:ko');

  const catalogs = new Map<string, Catalog>();
  for (const locale of languages) {
    const app =
      locale.code === 'en'
        ? english
        : locale.code === 'ko'
          ? korean
          : await readAppDictionary(repoRoot, locale.code, english);
    const currentAbout = about.get(locale.code);
    if (!currentAbout) throw new Error(`Missing About locale: ${locale.code}`);
    assertKeys(app, appKeys, `app:${locale.code}`);
    assertKeys(currentAbout, aboutKeys, `about:${locale.code}`);
    const entries: CatalogEntry[] = [
      ...appKeys.map((key): CatalogEntry => ({
        id: `app:${key}`,
        surface: 'app',
        key,
        sourceEn: english[key]!,
        sourceKo: korean[key]!,
        current: app[key]!,
      })),
      ...aboutKeys.map((key): CatalogEntry => ({
        id: `about:${key}`,
        surface: 'about',
        key,
        sourceEn: aboutEn[key]!,
        sourceKo: aboutKo[key]!,
        current: currentAbout[key]!,
      })),
    ];
    catalogs.set(locale.code, { locale, languages, entries });
  }
  return catalogs;
}
