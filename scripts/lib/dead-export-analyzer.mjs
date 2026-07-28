import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SANCTIONED_SEAM_RE = /ForTests$/;
const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/g;

const slash = (value) => value.replace(/\\/g, '/');

function isTestPath(file) {
  const path = slash(file);
  return path.includes('/__tests__/') || path.endsWith('.test.ts') || path.endsWith('.spec.ts');
}

function walk(dir, extensions, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') walk(full, extensions, out);
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
}

function sourceRole(root, file) {
  const path = slash(relative(root, file));
  if (path.startsWith('src/')) return isTestPath(path) ? 'test' : 'prod';
  return 'live';
}

function readCompilerOptions(root) {
  const configPath = join(root, 'tsconfig.json');
  let inherited = {};
  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      inherited = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
    }
  }
  return {
    ...inherited,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    allowImportingTsExtensions: true,
  };
}

function gatherCorpus(root) {
  const files = [];
  for (const file of walk(join(root, 'src'), ['.ts'])) {
    if (!file.endsWith('.d.ts')) files.push(file);
  }
  for (const directory of ['e2e', 'scripts']) {
    for (const file of walk(join(root, directory), ['.ts', '.js', '.mjs'])) {
      const path = slash(relative(root, file));
      if (
        path === 'scripts/check-dead-exports.mjs' ||
        path === 'scripts/lib/dead-export-analyzer.mjs'
      ) {
        continue;
      }
      files.push(file);
    }
  }
  for (const file of walk(join(root, 'public'), ['.js', '.mjs'])) files.push(file);
  return [...new Set(files.map((file) => resolve(file)))];
}

function resolveAlias(checker, symbol) {
  let current = symbol;
  const seen = new Set();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function declarationNameNodes(symbol) {
  const nodes = new Set();
  for (const declaration of symbol.declarations ?? []) {
    const name = declaration.name;
    if (!name) continue;
    const visitName = (node) => {
      if (ts.isIdentifier(node)) nodes.add(node);
      else ts.forEachChild(node, visitName);
    };
    visitName(name);
  }
  return nodes;
}

function isExportSurfaceName(node) {
  return ts.isExportSpecifier(node.parent) || ts.isNamespaceExport(node.parent);
}

function bindingKind(symbol) {
  return (symbol.flags & ts.SymbolFlags.Value) !== 0 ? 'value' : 'type';
}

function primaryDeclarationPath(root, symbol, sites) {
  const declaration = (symbol.declarations ?? []).find((candidate) => {
    const path = slash(relative(root, candidate.getSourceFile().fileName));
    return path.startsWith('src/');
  });
  return declaration ? slash(relative(root, declaration.getSourceFile().fileName)) : sites[0].file;
}

function bindingKey(binding) {
  return `${binding.declarationFile}::${binding.localName}`;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStringValues(sourceFile, checker) {
  const values = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) values.set(symbol, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function readStaticString(node, checker, values) {
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? (values.get(symbol) ?? null) : null;
  }
  return null;
}

function dynamicImportArgument(node) {
  const expression = unwrapExpression(node);
  return ts.isCallExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
    expression.arguments.length === 1
    ? expression.arguments[0]
    : null;
}

function classifyBindings(root, program, checker, corpusFiles) {
  const bySymbol = new Map();
  const ignoredDefaultExports = [];
  const prodSourceFiles = corpusFiles
    .map((file) => program.getSourceFile(file))
    .filter((sourceFile) => sourceFile && sourceRole(root, sourceFile.fileName) === 'prod');

  for (const sourceFile of prodSourceFiles) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const exportedName = exported.getName();
      if (exportedName === 'default') {
        ignoredDefaultExports.push({
          file: slash(relative(root, sourceFile.fileName)),
          name: exportedName,
        });
        continue;
      }
      const target = resolveAlias(checker, exported);
      let binding = bySymbol.get(target);
      if (!binding) {
        binding = {
          symbol: target,
          localName: target.getName(),
          kind: bindingKind(target),
          sites: [],
          declarationNames: declarationNameNodes(target),
          prodRefs: 0,
          testRefs: 0,
          selfRefs: 0,
          externalFallbackRefs: 0,
        };
        bySymbol.set(target, binding);
      }
      const file = slash(relative(root, sourceFile.fileName));
      if (!binding.sites.some((site) => site.file === file && site.name === exportedName)) {
        binding.sites.push({ file, name: exportedName });
      }
    }
  }

  for (const binding of bySymbol.values()) {
    binding.sites.sort((left, right) =>
      `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`),
    );
    binding.declarationFile = primaryDeclarationPath(root, binding.symbol, binding.sites);
    binding.ownFiles = new Set([
      binding.declarationFile,
      ...binding.sites.map((site) => site.file),
    ]);
  }

  const bindingBySite = new Map();
  for (const binding of bySymbol.values()) {
    for (const site of binding.sites) {
      bindingBySite.set(`${site.file}::${site.name}`, binding);
    }
  }

  const options = program.getCompilerOptions();
  const host = ts.createCompilerHost(options, true);
  const prodFiles = new Set(prodSourceFiles.map((sourceFile) => resolve(sourceFile.fileName)));
  const recordReference = (binding, role, path) => {
    if (role === 'test') binding.testRefs += 1;
    else if (binding.ownFiles.has(path)) binding.selfRefs += 1;
    else binding.prodRefs += 1;
  };

  for (const file of corpusFiles) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const role = sourceRole(root, file);
    const path = slash(relative(root, file));
    const visit = (node) => {
      if (ts.isIdentifier(node) && !isExportSurfaceName(node)) {
        const raw = checker.getSymbolAtLocation(node);
        if (raw) {
          const target = resolveAlias(checker, raw);
          const binding = bySymbol.get(target);
          if (binding && !binding.declarationNames.has(node)) {
            recordReference(binding, role, path);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // TypeScript cannot infer a module namespace when import() uses a constant
  // path or is returned through a helper. Resolve those small, static patterns
  // so test evidence remains attached to the exact module export binding.
  for (const file of corpusFiles) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const role = sourceRole(root, file);
    const path = slash(relative(root, file));
    const strings = staticStringValues(sourceFile, checker);
    const importFunctions = new Map();
    const namespaceVariables = new Map();
    const resolveImport = (argument) => {
      const specifier = readStaticString(argument, checker, strings);
      return specifier
        ? moduleFileForSpecifier(sourceFile, specifier, options, host, prodFiles)
        : null;
    };
    const recordSite = (moduleFile, name) => {
      const modulePath = slash(relative(root, moduleFile));
      const binding = bindingBySite.get(`${modulePath}::${name}`);
      if (binding) recordReference(binding, role, path);
    };

    const findImportFunction = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        for (const statement of node.body.statements) {
          if (!ts.isReturnStatement(statement) || !statement.expression) continue;
          const argument = dynamicImportArgument(statement.expression);
          const moduleFile = argument ? resolveImport(argument) : null;
          const symbol = checker.getSymbolAtLocation(node.name);
          if (moduleFile && symbol) importFunctions.set(symbol, moduleFile);
        }
      }
      ts.forEachChild(node, findImportFunction);
    };
    findImportFunction(sourceFile);

    const moduleFromInitializer = (initializer) => {
      const expression = unwrapExpression(initializer);
      const argument = dynamicImportArgument(expression);
      if (argument) return resolveImport(argument);
      if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        const symbol = checker.getSymbolAtLocation(expression.expression);
        return symbol ? (importFunctions.get(symbol) ?? null) : null;
      }
      return null;
    };
    const collectNamespaces = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const moduleFile = moduleFromInitializer(node.initializer);
        if (moduleFile && ts.isIdentifier(node.name)) {
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol) namespaceVariables.set(symbol, moduleFile);
        } else if (moduleFile && ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const exportedName = element.propertyName ?? element.name;
            if (ts.isIdentifier(exportedName)) recordSite(moduleFile, exportedName.text);
          }
        }
      }
      ts.forEachChild(node, collectNamespaces);
    };
    collectNamespaces(sourceFile);

    const collectNamespaceProperties = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const moduleFile = symbol ? namespaceVariables.get(symbol) : null;
        if (moduleFile) recordSite(moduleFile, node.name.text);
      } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const moduleFile = symbol ? namespaceVariables.get(symbol) : null;
        const name = node.argumentExpression
          ? readStaticString(node.argumentExpression, checker, strings)
          : null;
        if (moduleFile && name) recordSite(moduleFile, name);
      }
      ts.forEachChild(node, collectNamespaceProperties);
    };
    collectNamespaceProperties(sourceFile);
  }

  // HTML is not part of the TypeScript program. Preserve a conservative
  // fallback only when an identifier names exactly one exported binding.
  const bindingsByExportedName = new Map();
  for (const binding of bySymbol.values()) {
    for (const site of binding.sites) {
      const list = bindingsByExportedName.get(site.name) ?? new Set();
      list.add(binding);
      bindingsByExportedName.set(site.name, list);
    }
  }
  const ambiguousExternalNames = new Set();
  const htmlFiles = [
    join(root, 'index.html'),
    ...walk(join(root, 'public'), ['.html']),
    ...walk(join(root, 'e2e'), ['.html']),
    ...walk(join(root, 'scripts'), ['.html']),
  ];
  for (const file of htmlFiles) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    IDENTIFIER_RE.lastIndex = 0;
    let match;
    while ((match = IDENTIFIER_RE.exec(text))) {
      const candidates = bindingsByExportedName.get(match[0]);
      if (!candidates) continue;
      if (candidates.size === 1) {
        const [binding] = candidates;
        binding.prodRefs += 1;
        binding.externalFallbackRefs += 1;
      } else {
        ambiguousExternalNames.add(match[0]);
      }
    }
  }

  const result = {
    fullyDead: [],
    testOnly: [],
    selfOnly: [],
    live: [],
    sanctionedSeams: [],
    ambiguousExternalNames: [...ambiguousExternalNames].sort(),
    ignoredDefaultExports: ignoredDefaultExports.sort((left, right) =>
      `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`),
    ),
  };

  for (const binding of bySymbol.values()) {
    const record = {
      key: bindingKey(binding),
      name: binding.localName,
      kind: binding.kind,
      declarationFile: binding.declarationFile,
      sites: binding.sites,
      refs: {
        prod: binding.prodRefs,
        test: binding.testRefs,
        self: binding.selfRefs,
        externalFallback: binding.externalFallbackRefs,
      },
    };
    const sanctioned = binding.sites.every((site) => SANCTIONED_SEAM_RE.test(site.name));
    if (sanctioned) result.sanctionedSeams.push(record);
    else if (binding.prodRefs > 0) result.live.push(record);
    else if (binding.selfRefs > 0) result.selfOnly.push(record);
    else if (binding.testRefs > 0) result.testOnly.push(record);
    else result.fullyDead.push(record);
  }

  const byKey = (left, right) => left.key.localeCompare(right.key);
  for (const list of [
    result.fullyDead,
    result.testOnly,
    result.selfOnly,
    result.live,
    result.sanctionedSeams,
  ]) {
    list.sort(byKey);
  }
  return result;
}

function moduleFileForSpecifier(sourceFile, specifier, options, host, prodFiles) {
  if (!specifier.startsWith('.')) return null;
  const resolvedModule = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    options,
    host,
  ).resolvedModule;
  if (!resolvedModule) return null;
  const file = resolve(resolvedModule.resolvedFileName);
  return prodFiles.has(file) ? file : null;
}

function stringModuleSpecifier(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function isImportMetaUrl(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function moduleReachability(root, program, options, corpusFiles) {
  const checker = program.getTypeChecker();
  const prodSourceFiles = corpusFiles
    .map((file) => program.getSourceFile(file))
    .filter((sourceFile) => sourceFile && sourceRole(root, sourceFile.fileName) === 'prod');
  const prodFiles = new Set(prodSourceFiles.map((sourceFile) => resolve(sourceFile.fileName)));
  const host = ts.createCompilerHost(options, true);
  const edges = new Map([...prodFiles].map((file) => [file, new Set()]));

  for (const sourceFile of prodSourceFiles) {
    const source = resolve(sourceFile.fileName);
    const strings = staticStringValues(sourceFile, checker);
    const add = (specifier) => {
      const target = moduleFileForSpecifier(sourceFile, specifier, options, host, prodFiles);
      if (target) edges.get(source).add(target);
    };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = stringModuleSpecifier(node.moduleSpecifier);
        if (specifier) add(specifier);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1
      ) {
        const specifier = readStaticString(node.arguments[0], checker, strings);
        if (specifier) add(specifier);
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'URL' &&
        node.arguments?.length === 2 &&
        isImportMetaUrl(node.arguments[1])
      ) {
        const specifier = readStaticString(node.arguments[0], checker, strings);
        if (specifier) add(specifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const roots = [];
  const app = resolve(join(root, 'src', 'app.ts'));
  if (prodFiles.has(app)) roots.push(app);
  const reachable = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const source = queue.shift();
    for (const target of edges.get(source) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  const toPath = (file) => slash(relative(root, file));
  return {
    roots: roots.map(toPath).sort(),
    total: prodFiles.size,
    reachable: reachable.size,
    unreachable: prodFiles.size - reachable.size,
    unreachableFiles: [...prodFiles]
      .filter((file) => !reachable.has(file))
      .map(toPath)
      .sort(),
  };
}

export function analyzeDeadExports({ root }) {
  const absoluteRoot = resolve(root);
  const corpusFiles = gatherCorpus(absoluteRoot);
  const options = readCompilerOptions(absoluteRoot);
  const program = ts.createProgram({ rootNames: corpusFiles, options });
  const checker = program.getTypeChecker();
  const bindings = classifyBindings(absoluteRoot, program, checker, corpusFiles);
  return {
    root: slash(absoluteRoot),
    prodFileCount: corpusFiles.filter((file) => sourceRole(absoluteRoot, file) === 'prod').length,
    bindingCount:
      bindings.fullyDead.length +
      bindings.testOnly.length +
      bindings.selfOnly.length +
      bindings.live.length +
      bindings.sanctionedSeams.length,
    ...bindings,
    moduleReachability: moduleReachability(absoluteRoot, program, options, corpusFiles),
  };
}
