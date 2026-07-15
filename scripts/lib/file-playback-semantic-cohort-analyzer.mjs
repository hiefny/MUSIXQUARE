import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, posix, resolve, sep } from 'node:path';
import ts from 'typescript';

import {
  FILE_PLAYBACK_BARE_SUPPORT_ALLOWLIST,
  FILE_PLAYBACK_RELATIVE_SUPPORT_ALLOWLIST,
  FILE_PLAYBACK_SEMANTIC_COHORT_DECLARATION,
  FILE_PLAYBACK_SEMANTIC_COHORT_EXPORT,
  FILE_PLAYBACK_SEMANTIC_COHORT_SCHEMA,
  FILE_PLAYBACK_SEMANTIC_CRITICAL_ENTRY_FILES,
  FILE_PLAYBACK_SEMANTIC_FLAC_PACKAGE_ROOT,
  FILE_PLAYBACK_SEMANTIC_INTEGRATION_FILES,
  FILE_PLAYBACK_SEMANTIC_MP3_PACKAGE_ROOT,
  FILE_PLAYBACK_SEMANTIC_PACKAGE_ROOTS,
  FILE_PLAYBACK_SEMANTIC_SURFACE_FILES,
} from '../file-playback-semantic-surface.mjs';

const SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']);
const PRODUCTION_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SEMREV_LITERAL_PLACEHOLDER = '__FILE_PLAYBACK_SEMREV__';

const DEFAULT_CONFIGURATION = Object.freeze({
  bareSupportAllowlist: FILE_PLAYBACK_BARE_SUPPORT_ALLOWLIST,
  cohortDeclaration: FILE_PLAYBACK_SEMANTIC_COHORT_DECLARATION,
  cohortExport: FILE_PLAYBACK_SEMANTIC_COHORT_EXPORT,
  criticalEntryFiles: FILE_PLAYBACK_SEMANTIC_CRITICAL_ENTRY_FILES,
  flacPackageRoot: FILE_PLAYBACK_SEMANTIC_FLAC_PACKAGE_ROOT,
  integrationFiles: FILE_PLAYBACK_SEMANTIC_INTEGRATION_FILES,
  mp3PackageRoot: FILE_PLAYBACK_SEMANTIC_MP3_PACKAGE_ROOT,
  packageRoots: FILE_PLAYBACK_SEMANTIC_PACKAGE_ROOTS,
  relativeSupportAllowlist: FILE_PLAYBACK_RELATIVE_SUPPORT_ALLOWLIST,
  schema: FILE_PLAYBACK_SEMANTIC_COHORT_SCHEMA,
  surfaceFiles: FILE_PLAYBACK_SEMANTIC_SURFACE_FILES,
});

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStrings(values) {
  return [...values].sort(compareCodeUnits);
}

function toKey(root, absolutePath) {
  const relative = absolutePath
    .slice(resolve(root).length + 1)
    .split(sep)
    .join('/');
  return posix.normalize(relative);
}

function packageRoot(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function resolveSourceBase(root, base) {
  const extension = extname(base);
  const candidates = extension
    ? extension === '.js'
      ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, base]
      : [base]
    : [
        ...SOURCE_EXTENSIONS.map((candidateExtension) => `${base}${candidateExtension}`),
        ...SOURCE_EXTENSIONS.map((candidateExtension) =>
          resolve(base, `index${candidateExtension}`),
        ),
      ];
  const target = candidates.find((candidate) => existsSync(candidate));
  return target ? toKey(root, target) : null;
}

function resolveProjectSource(root, importer, specifier) {
  if (specifier.startsWith('.')) {
    return resolveSourceBase(root, resolve(root, dirname(importer), specifier));
  }
  if (specifier.startsWith('@/')) {
    return resolveSourceBase(root, resolve(root, 'src', specifier.slice(2)));
  }
  return null;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function literalSpecifier(expression) {
  return ts.isStringLiteralLike(expression) ? expression.text : null;
}

function importDeclarationHasRuntimeValue(node) {
  if (!node.importClause) return true;
  if (node.importClause.isTypeOnly) return false;
  if (node.importClause.name) return true;
  const bindings = node.importClause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntimeValue(node) {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return true;
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function isImportMeta(node) {
  return (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === 'meta'
  );
}

function isImportMetaUrl(node) {
  return (
    ts.isPropertyAccessExpression(node) && node.name.text === 'url' && isImportMeta(node.expression)
  );
}

function isImportMetaUrlExpression(node) {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'URL' &&
    node.arguments?.length === 2 &&
    isImportMetaUrl(node.arguments[1]) &&
    literalSpecifier(node.arguments[0]) !== null
  );
}

function collectImportMetaUrlBindings(sourceFile) {
  const bindings = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isImportMetaUrlExpression(node.initializer)
    ) {
      bindings.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function isClassifiedAssetExpression(node, importMetaUrlBindings) {
  return (
    isImportMetaUrlExpression(node) ||
    (ts.isIdentifier(node) && importMetaUrlBindings.has(node.text))
  );
}

function isGlobalLikeMethod(expression, method) {
  if (ts.isIdentifier(expression)) return expression.text === method;
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === method &&
    ts.isIdentifier(expression.expression) &&
    ['globalThis', 'self', 'window'].includes(expression.expression.text)
  );
}

function isWebAssemblyMethod(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'WebAssembly' &&
    ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming'].includes(
      expression.name.text,
    )
  );
}

function isWebAssemblyConstructor(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'WebAssembly' &&
    ['Instance', 'Module'].includes(expression.name.text)
  );
}

function isImportMetaLoader(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    isImportMeta(expression.expression) &&
    ['glob', 'globEager', 'resolve'].includes(expression.name.text)
  );
}

function isRequireResolve(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'require' &&
    expression.name.text === 'resolve'
  );
}

function collectRuntimeEdges(file, text) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const importMetaUrlBindings = collectImportMetaUrlBindings(sourceFile);
  const edges = [];
  const violations = [];

  const add = (specifier, kind, node) => {
    edges.push({ specifier, kind, line: lineOf(sourceFile, node) });
  };
  const reject = (node, reason) => {
    violations.push(`${file}:${lineOf(sourceFile, node)} ${reason}`);
  };

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      importDeclarationHasRuntimeValue(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, 'static import', node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) {
        add(expression.text, 'import-equals require', node);
      } else {
        reject(node, 'computed import-equals require cannot be classified');
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      exportDeclarationHasRuntimeValue(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, 'static re-export', node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : null;
      if (specifier === null) {
        reject(node, 'computed dynamic import cannot be classified');
      } else {
        add(specifier, 'dynamic import', node);
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : null;
      if (specifier === null) reject(node, 'computed require cannot be classified');
      else add(specifier, 'require', node);
    } else if (ts.isCallExpression(node) && isRequireResolve(node.expression)) {
      const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : null;
      if (specifier === null) reject(node, 'computed require.resolve cannot be classified');
      else add(specifier, 'require.resolve asset', node);
    } else if (
      ts.isCallExpression(node) &&
      (isGlobalLikeMethod(node.expression, 'importScripts') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'importScripts'))
    ) {
      if (!node.arguments.length) reject(node, 'empty importScripts loader cannot be classified');
      for (const argument of node.arguments) {
        const specifier = literalSpecifier(argument);
        if (specifier === null) reject(node, 'computed importScripts loader cannot be classified');
        else add(specifier, 'importScripts asset', node);
      }
    } else if (ts.isCallExpression(node) && isImportMetaLoader(node.expression)) {
      reject(node, `import.meta.${node.expression.name.text} loader is not exactly classified`);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['SharedWorker', 'Worker'].includes(node.expression.text)
    ) {
      const asset = node.arguments?.[0];
      if (!asset || !isClassifiedAssetExpression(asset, importMetaUrlBindings)) {
        reject(node, `direct ${node.expression.text} loader must use a literal import.meta URL`);
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addModule'
    ) {
      const asset = node.arguments[0];
      if (!asset || !isClassifiedAssetExpression(asset, importMetaUrlBindings)) {
        reject(node, 'AudioWorklet addModule loader must use a literal import.meta URL');
      }
    } else if (ts.isCallExpression(node) && isGlobalLikeMethod(node.expression, 'fetch')) {
      const asset = node.arguments[0];
      if (!asset || !isClassifiedAssetExpression(asset, importMetaUrlBindings)) {
        reject(node, 'fetch asset loader is not exactly classified');
      }
    } else if (ts.isCallExpression(node) && isWebAssemblyMethod(node.expression)) {
      reject(
        node,
        `direct WebAssembly.${node.expression.name.text} loader is not exactly classified`,
      );
    } else if (ts.isNewExpression(node) && isWebAssemblyConstructor(node.expression)) {
      reject(
        node,
        `direct WebAssembly.${node.expression.name.text} loader is not exactly classified`,
      );
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.length === 2 &&
      isImportMetaUrl(node.arguments[1])
    ) {
      const specifier = literalSpecifier(node.arguments[0]);
      if (specifier === null) reject(node, 'computed import.meta URL is forbidden');
      else add(specifier, 'import.meta URL', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { edges, violations };
}

/** Test seam for the fail-closed runtime-loader classifier. */
export function collectFilePlaybackRuntimeEdgesForTests(file, text) {
  return collectRuntimeEdges(file, text);
}

/**
 * Digest source normalization is intentionally minimal. Comments, spacing,
 * quote choice, and every token boundary remain semantic revision inputs.
 */
export function normalizeSemanticSource(_file, text) {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return withoutBom.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function exactRelativeAllowlist(entries) {
  const result = new Map();
  for (const entry of entries) {
    if (!entry.reason?.trim())
      throw new Error(`Relative support edge lacks reason: ${JSON.stringify(entry)}`);
    const key = `${entry.importer}\0${entry.target}`;
    if (result.has(key))
      throw new Error(`Duplicate relative support edge: ${entry.importer} -> ${entry.target}`);
    result.set(key, entry);
  }
  return result;
}

function exactBareAllowlist(entries) {
  const result = new Map();
  for (const entry of entries) {
    if (!entry.reason?.trim())
      throw new Error(`Bare support edge lacks reason: ${JSON.stringify(entry)}`);
    const key = `${entry.importer}\0${entry.specifier}`;
    if (result.has(key))
      throw new Error(`Duplicate bare support edge: ${entry.importer} -> ${entry.specifier}`);
    result.set(key, entry);
  }
  return result;
}

function packageLockClosure(root, packageRoots) {
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json must use lockfileVersion 3 with a packages map');
  }
  const closure = new Map();
  const pending = sortedStrings(packageRoots);
  while (pending.length) {
    const name = pending.shift();
    if (closure.has(name)) continue;
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || typeof entry.version !== 'string' || typeof entry.integrity !== 'string') {
      throw new Error(`Semantic runtime package is not fully locked: ${name}`);
    }
    const dependencies = sortedStrings(Object.keys(entry.dependencies ?? {}));
    closure.set(
      name,
      Object.freeze({
        name,
        version: entry.version,
        integrity: entry.integrity,
        dependencies,
      }),
    );
    pending.push(...dependencies);
    pending.sort(compareCodeUnits);
  }
  return [...closure.values()].sort((left, right) => compareCodeUnits(left.name, right.name));
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function unwrapLiteralInitializer(initializer) {
  let current = initializer;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current && ts.isStringLiteral(current) ? current : null;
}

function inspectCohortDeclaration({ file, text, exportName, canonicalPrefix, schema }) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];
  const directCandidates = [];
  let runtimeBindingCount = 0;
  let aliasExportCount = 0;

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName) continue;
        runtimeBindingCount += 1;
        const isDirect =
          hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
          !hasModifier(statement, ts.SyntaxKind.DeclareKeyword) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        if (isDirect) directCandidates.push({ declaration, statement });
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === exportName
    ) {
      runtimeBindingCount += 1;
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement) && statement.name.text === exportName) {
      runtimeBindingCount += 1;
      continue;
    }
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name?.text === exportName) runtimeBindingCount += 1;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === exportName) {
        runtimeBindingCount += 1;
      } else if (bindings && ts.isNamedImports(bindings)) {
        runtimeBindingCount += bindings.elements.filter(
          (element) => element.name.text === exportName,
        ).length;
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      aliasExportCount += statement.exportClause.elements.filter(
        (element) => element.name.text === exportName,
      ).length;
    }
  }

  if (directCandidates.length !== 1 || runtimeBindingCount !== 1 || aliasExportCount !== 0) {
    violations.push(
      `${file} must contain exactly one direct export const ${exportName} binding and no alias export`,
    );
  }

  const literal =
    directCandidates.length === 1
      ? unwrapLiteralInitializer(directCandidates[0].declaration.initializer)
      : null;
  if (!literal) {
    violations.push(`${file} ${exportName} must be initialized by one plain string literal`);
    return { declaredCohortId: null, normalized: normalizeSemanticSource(file, text), violations };
  }

  const declaredCohortId = literal.text;
  const marker = ';semrev=';
  const markerMatches = declaredCohortId.match(/;semrev=/gu) ?? [];
  if (markerMatches.length !== 1) {
    violations.push(`${file} universal cohort ID must contain exactly one semrev field`);
  }
  if (!declaredCohortId.startsWith(canonicalPrefix)) {
    violations.push(
      `${file} universal cohort ID must use the canonical package-derived prefix ${canonicalPrefix}`,
    );
  }
  const semrevValue = declaredCohortId.startsWith(canonicalPrefix)
    ? declaredCohortId.slice(canonicalPrefix.length)
    : '';
  if (!new RegExp(`^${schema}-[A-Za-z0-9_-]{43}$`, 'u').test(semrevValue)) {
    violations.push(
      `${file} universal semrev must be ${schema}- followed by 43 base64url characters`,
    );
  }

  const literalStart = literal.getStart(sourceFile);
  const literalEnd = literal.getEnd();
  const rawLiteral = text.slice(literalStart, literalEnd);
  const quote = rawLiteral[0];
  if (
    !["'", '"'].includes(quote) ||
    rawLiteral.at(-1) !== quote ||
    rawLiteral.slice(1, -1) !== declaredCohortId
  ) {
    violations.push(`${file} universal cohort ID must use an unescaped plain string literal`);
    return { declaredCohortId, normalized: normalizeSemanticSource(file, text), violations };
  }

  const markerIndex = declaredCohortId.lastIndexOf(marker);
  if (markerIndex < 0) {
    return { declaredCohortId, normalized: normalizeSemanticSource(file, text), violations };
  }
  const stableLiteral = `${quote}${declaredCohortId.slice(0, markerIndex + marker.length)}${SEMREV_LITERAL_PLACEHOLDER}${quote}`;
  const replaced = `${text.slice(0, literalStart)}${stableLiteral}${text.slice(literalEnd)}`;
  return { declaredCohortId, normalized: normalizeSemanticSource(file, replaced), violations };
}

function canonicalCohortPrefix(packageClosure, configuration) {
  const packages = new Map(packageClosure.map((entry) => [entry.name, entry]));
  const flac = packages.get(configuration.flacPackageRoot);
  const mp3 = packages.get(configuration.mp3PackageRoot);
  if (!flac || !mp3) {
    throw new Error(
      'Canonical FLAC and mpg123 package roots must be in the locked package closure',
    );
  }
  return (
    `file-playback;session=v2;route=universal-v1;flac=wasm-${flac.version};` +
    `linear-pcm=worker-v1;mp3=mpg123-${mp3.version};adts-aac=webcodecs-v1;` +
    'm4a-aac=webcodecs-v1;semrev='
  );
}

function productionSourceFiles(root) {
  const sourceRoot = resolve(root, 'src');
  if (!existsSync(sourceRoot)) return [];
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = toKey(root, absolute);
      const extension = extname(key);
      if (
        PRODUCTION_SOURCE_EXTENSIONS.has(extension) &&
        !key.endsWith('.d.ts') &&
        !/\.(?:spec|test)\.[^.]+$/u.test(key)
      ) {
        files.push(key);
      }
    }
  };
  visit(sourceRoot);
  return files.sort(compareCodeUnits);
}

function stablePolicyDescriptor(configuration) {
  const relativeSupportAllowlist = [...configuration.relativeSupportAllowlist]
    .map(({ importer, target, reason }) => ({ importer, target, reason }))
    .sort((left, right) =>
      compareCodeUnits(
        `${left.importer}\0${left.target}\0${left.reason}`,
        `${right.importer}\0${right.target}\0${right.reason}`,
      ),
    );
  const bareSupportAllowlist = [...configuration.bareSupportAllowlist]
    .map(({ importer, specifier, reason }) => ({ importer, specifier, reason }))
    .sort((left, right) =>
      compareCodeUnits(
        `${left.importer}\0${left.specifier}\0${left.reason}`,
        `${right.importer}\0${right.specifier}\0${right.reason}`,
      ),
    );
  return {
    bareSupportAllowlist,
    cohortDeclaration: configuration.cohortDeclaration,
    cohortExport: configuration.cohortExport,
    criticalEntryFiles: sortedStrings(configuration.criticalEntryFiles),
    flacPackageRoot: configuration.flacPackageRoot,
    integrationFiles: sortedStrings(configuration.integrationFiles),
    mp3PackageRoot: configuration.mp3PackageRoot,
    packageRoots: sortedStrings(configuration.packageRoots),
    relativeSupportAllowlist,
    schema: configuration.schema,
    surfaceFiles: sortedStrings(configuration.surfaceFiles),
  };
}

function mergeConfiguration(overrides) {
  return Object.freeze({ ...DEFAULT_CONFIGURATION, ...(overrides ?? {}) });
}

export function analyzeFilePlaybackSemanticCohort({ root, configuration: overrides }) {
  const configuration = mergeConfiguration(overrides);
  const surface = [...configuration.surfaceFiles];
  const integration = [...configuration.integrationFiles];
  const criticalEntries = [...configuration.criticalEntryFiles];
  const sortedSurface = sortedStrings(surface);
  const sortedIntegration = sortedStrings(integration);
  const violations = [];

  if (new Set(surface).size !== surface.length)
    violations.push('Semantic surface contains duplicate files');
  if (new Set(integration).size !== integration.length)
    violations.push('Semantic integration roots contain duplicate files');
  const firstSurfaceSortMismatch = surface.findIndex(
    (file, index) => file !== sortedSurface[index],
  );
  if (firstSurfaceSortMismatch !== -1) {
    violations.push(
      `Semantic surface must stay code-unit sorted: expected ${sortedSurface[firstSurfaceSortMismatch]} before ${surface[firstSurfaceSortMismatch]}`,
    );
  }
  const firstIntegrationSortMismatch = integration.findIndex(
    (file, index) => file !== sortedIntegration[index],
  );
  if (firstIntegrationSortMismatch !== -1) {
    violations.push(
      `Semantic integration roots must stay code-unit sorted: expected ${sortedIntegration[firstIntegrationSortMismatch]} before ${integration[firstIntegrationSortMismatch]}`,
    );
  }
  if (!surface.includes(configuration.cohortDeclaration)) {
    violations.push('Semantic-cohort declaration must be present in the hashed core surface');
  }

  const surfaceSet = new Set(surface);
  const integrationSet = new Set(integration);
  const classifiedSet = new Set([...surface, ...integration]);
  for (const file of integration) {
    if (surfaceSet.has(file))
      violations.push(`Integration root is also in the core surface: ${file}`);
  }
  for (const file of criticalEntries) {
    if (!surfaceSet.has(file))
      violations.push(`Critical entry is not in the core surface: ${file}`);
  }

  const relativeAllowlist = exactRelativeAllowlist(configuration.relativeSupportAllowlist);
  const bareAllowlist = exactBareAllowlist(configuration.bareSupportAllowlist);
  const usedRelative = new Set();
  const usedBare = new Set();
  const packageClosure = packageLockClosure(root, configuration.packageRoots);
  const canonicalPrefix = canonicalCohortPrefix(packageClosure, configuration);
  const normalizedFiles = [];
  let declaredCohortId = null;
  let edgeCount = 0;
  let integrationBoundaryEdgeCount = 0;

  for (const category of ['core', 'integration']) {
    const files = category === 'core' ? surface : integration;
    for (const file of files) {
      const absolute = resolve(root, file);
      if (!existsSync(absolute)) {
        violations.push(`Semantic ${category} file does not exist: ${file}`);
        continue;
      }
      const text = readFileSync(absolute, 'utf8');
      if (file === configuration.cohortDeclaration) {
        const declaration = inspectCohortDeclaration({
          canonicalPrefix,
          exportName: configuration.cohortExport,
          file,
          schema: configuration.schema,
          text,
        });
        declaredCohortId = declaration.declaredCohortId;
        violations.push(...declaration.violations);
        normalizedFiles.push({ category, file, normalized: declaration.normalized });
      } else {
        normalizedFiles.push({ category, file, normalized: normalizeSemanticSource(file, text) });
      }

      const collected = collectRuntimeEdges(file, text);
      violations.push(...collected.violations);
      for (const edge of collected.edges) {
        edgeCount += 1;
        if (edge.specifier.startsWith('.') || edge.specifier.startsWith('@/')) {
          const target = resolveProjectSource(root, file, edge.specifier);
          if (!target) {
            violations.push(`${file}:${edge.line} unresolved ${edge.kind}: ${edge.specifier}`);
            continue;
          }
          if (classifiedSet.has(target)) continue;
          if (category === 'integration') {
            integrationBoundaryEdgeCount += 1;
            continue;
          }
          const key = `${file}\0${target}`;
          if (relativeAllowlist.has(key)) {
            usedRelative.add(key);
            continue;
          }
          violations.push(`${file}:${edge.line} unclassified ${edge.kind}: ${target}`);
          continue;
        }

        const rootName = packageRoot(edge.specifier);
        if (configuration.packageRoots.includes(rootName)) continue;
        if (category === 'integration') {
          integrationBoundaryEdgeCount += 1;
          continue;
        }
        const key = `${file}\0${edge.specifier}`;
        if (bareAllowlist.has(key)) {
          usedBare.add(key);
          continue;
        }
        violations.push(`${file}:${edge.line} unclassified bare ${edge.kind}: ${edge.specifier}`);
      }
    }
  }

  for (const key of relativeAllowlist.keys()) {
    if (!usedRelative.has(key))
      violations.push(`Stale relative support allowlist edge: ${key.replace('\0', ' -> ')}`);
  }
  for (const key of bareAllowlist.keys()) {
    if (!usedBare.has(key))
      violations.push(`Stale bare support allowlist edge: ${key.replace('\0', ' -> ')}`);
  }

  const criticalSet = new Set(criticalEntries);
  const integrationCriticalEdges = new Map(integration.map((file) => [file, 0]));
  for (const file of productionSourceFiles(root)) {
    const text = readFileSync(resolve(root, file), 'utf8');
    const collected = collectRuntimeEdges(file, text);
    if (!classifiedSet.has(file)) {
      for (const finding of collected.violations) {
        if (
          /computed (?:dynamic import|import-equals require|require(?:\.resolve)?)/u.test(
            finding,
          ) ||
          /import\.meta\.(?:glob|globEager|resolve)/u.test(finding)
        ) {
          violations.push(`Repository-wide unclassifiable module loader: ${finding}`);
        }
      }
    }
    for (const edge of collected.edges) {
      if (!edge.specifier.startsWith('.') && !edge.specifier.startsWith('@/')) continue;
      const target = resolveProjectSource(root, file, edge.specifier);
      if (!target || !criticalSet.has(target)) continue;
      if (!classifiedSet.has(file)) {
        violations.push(
          `${file}:${edge.line} unclassified reverse caller of critical entry ${target}`,
        );
      } else if (integrationSet.has(file)) {
        integrationCriticalEdges.set(file, (integrationCriticalEdges.get(file) ?? 0) + 1);
      }
    }
  }
  for (const [file, count] of integrationCriticalEdges) {
    if (count === 0)
      violations.push(`Stale semantic integration root has no critical edge: ${file}`);
  }

  const hash = createHash('sha256');
  hash.update(`file-playback-semantic-cohort\0${configuration.schema}\0`);
  for (const entry of normalizedFiles) {
    hash.update(
      `${entry.category.length}:${entry.category}\0${entry.file.length}:${entry.file}\0${entry.normalized.length}:`,
    );
    hash.update(entry.normalized);
    hash.update('\0');
  }
  hash.update(JSON.stringify(packageClosure));
  hash.update('\0');
  hash.update(JSON.stringify(stablePolicyDescriptor(configuration)));
  const digest = hash.digest('base64url');
  const suffix = `;semrev=${configuration.schema}-${digest}`;
  const expectedCohortId = `${canonicalPrefix}${configuration.schema}-${digest}`;
  if (declaredCohortId !== null && declaredCohortId !== expectedCohortId) {
    violations.push(
      `Cohort ID mismatch: expected ${expectedCohortId}, declared ${declaredCohortId}`,
    );
  }
  if (digest.length !== 43)
    violations.push(`SHA-256 base64url digest must be 43 characters, got ${digest.length}`);

  return Object.freeze({
    canonicalPrefix,
    coreFileCount: surface.length,
    declaredCohortId,
    digest,
    edgeCount,
    expectedCohortId,
    fileCount: normalizedFiles.length,
    integrationBoundaryEdgeCount,
    integrationFileCount: integration.length,
    packageClosure: Object.freeze(packageClosure),
    suffix,
    violations: Object.freeze(violations),
  });
}
