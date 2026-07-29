import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

export const DEFAULT_LEGACY_BOUNDED_V1_PROTECTED_FILES = Object.freeze([
  'src/player/legacy-bounded-file-v1-bridge.ts',
  'src/player/legacy-bounded-file-v1-negotiation.ts',
  'src/player/legacy-bounded-file-v1-product.ts',
  'src/player/legacy-bounded-file-v1-runtime.ts',
  'src/player/legacy-bounded-file-v1-source.ts',
]);

export const DEFAULT_LEGACY_BOUNDED_V1_FORBIDDEN_MODULE_FILES = Object.freeze([
  'src/network/file-playback-application-session.ts',
  'src/player/file-playback-product-runtime.ts',
]);

const DEFAULT_DATA_CONNECTION_DECLARATION = Object.freeze({
  file: 'src/types/index.ts',
  name: 'DataConnection',
});
const LIFECYCLE_MEMBERS = new Set(['close', 'terminate']);

function absolutePath(root, file) {
  return resolve(root, ...file.split('/'));
}

function canonicalPath(file) {
  const normalized = resolve(file).split(sep).join('/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function displayPath(root, file) {
  const path = relative(root, file).split(sep).join('/');
  return path || '.';
}

function locationOf(root, sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${displayPath(root, sourceFile.fileName)}:${position.line + 1}:${position.character + 1}`;
}

function formatConfigDiagnostic(root, diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return (
    `${displayPath(root, diagnostic.file.fileName)}:${position.line + 1}:` +
    `${position.character + 1} ${message}`
  );
}

function readProgramConfiguration(root, tsconfigFile) {
  const configPath = isAbsolute(tsconfigFile) ? tsconfigFile : absolutePath(root, tsconfigFile);
  const readResult = ts.readConfigFile(configPath, (file) => readFileSync(file, 'utf8'));
  if (readResult.error) {
    return {
      errors: [formatConfigDiagnostic(root, readResult.error)],
      fileNames: [],
      options: {},
      configPath,
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    dirname(configPath),
    { incremental: false, noEmit: true },
    configPath,
  );
  return {
    errors: parsed.errors.map((diagnostic) => formatConfigDiagnostic(root, diagnostic)),
    fileNames: parsed.fileNames,
    options: parsed.options,
    configPath,
  };
}

function findNamedType(checker, sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return checker.getTypeAtLocation(statement.name);
    }
  }
  return null;
}

function nonNullableConstituents(type) {
  const constituents = type.isUnion() ? type.types : [type];
  return constituents.filter(
    (candidate) =>
      (candidate.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) === 0,
  );
}

function typeCouldBeDataConnection(checker, type, dataConnectionType) {
  return nonNullableConstituents(type).some((candidate) => {
    if ((candidate.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
    return checker.isTypeAssignableTo(candidate, dataConnectionType);
  });
}

function unwrapExpression(expression) {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return expression.expression;
  }
  return null;
}

function expressionComesFromDataConnection(checker, expression, dataConnectionType) {
  if (
    typeCouldBeDataConnection(checker, checker.getTypeAtLocation(expression), dataConnectionType)
  ) {
    return true;
  }
  const inner = unwrapExpression(expression);
  return inner ? expressionComesFromDataConnection(checker, inner, dataConnectionType) : false;
}

function staticPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    const expression = node.expression;
    return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
      ? expression.text
      : null;
  }
  return null;
}

function moduleSpecifierFromNode(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return { node: node.moduleSpecifier, specifier: node.moduleSpecifier.text };
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return {
      node: node.moduleReference.expression,
      specifier: node.moduleReference.expression.text,
    };
  }
  return null;
}

function resolveReferencedModule(specifier, sourceFile, compilerOptions) {
  const resolvedModule = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  return resolvedModule ? canonicalPath(resolvedModule.resolvedFileName) : null;
}

function describeForbiddenTarget(root, resolvedFile) {
  return displayPath(root, resolvedFile);
}

function collectModuleBoundaryFindings({
  compilerOptions,
  forbiddenFiles,
  root,
  sourceFile,
  violations,
}) {
  const inspectSpecifier = (reference) => {
    const resolvedFile = resolveReferencedModule(reference.specifier, sourceFile, compilerOptions);
    if (!resolvedFile || !forbiddenFiles.has(resolvedFile)) return;
    violations.push(
      `${locationOf(root, sourceFile, reference.node)} forbidden old V2 module import ` +
        `'${reference.specifier}' resolves to ` +
        `${describeForbiddenTarget(root, resolvedFile)}`,
    );
  };

  const visit = (node) => {
    const staticReference = moduleSpecifierFromNode(node);
    if (staticReference) inspectSpecifier(staticReference);

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteralLike(argument)) {
          violations.push(
            `${locationOf(root, sourceFile, node)} computed ${
              isDynamicImport ? 'dynamic import' : 'require'
            } is forbidden in a protected bounded-V1 module`,
          );
        } else {
          inspectSpecifier({ node: argument, specifier: argument.text });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectConnectionLifecycleFindings({
  checker,
  dataConnectionType,
  root,
  sourceFile,
  violations,
}) {
  const addLifecycleFinding = (node, member, form = 'access') => {
    violations.push(
      `${locationOf(root, sourceFile, node)} DataConnection.${member} lifecycle ${form} ` +
        'is forbidden in a protected bounded-V1 module',
    );
  };

  const inspectBindingPattern = (pattern, owner) => {
    if (
      !ts.isObjectBindingPattern(pattern) ||
      !expressionComesFromDataConnection(checker, owner, dataConnectionType)
    ) {
      return;
    }
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        violations.push(
          `${locationOf(root, sourceFile, element)} spreading DataConnection lifecycle ` +
            'authority through an object-rest binding is forbidden',
        );
        continue;
      }
      const property = element.propertyName ?? element.name;
      const name = staticPropertyName(property);
      if (name === null) {
        violations.push(
          `${locationOf(root, sourceFile, element)} computed DataConnection destructuring ` +
            'is forbidden because lifecycle authority cannot be proven absent',
        );
      } else if (LIFECYCLE_MEMBERS.has(name)) {
        addLifecycleFinding(element, name, 'destructuring');
      }
    }
  };

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && LIFECYCLE_MEMBERS.has(node.name.text)) {
      if (expressionComesFromDataConnection(checker, node.expression, dataConnectionType)) {
        addLifecycleFinding(node, node.name.text);
      }
    } else if (ts.isElementAccessExpression(node)) {
      if (expressionComesFromDataConnection(checker, node.expression, dataConnectionType)) {
        const argument = node.argumentExpression;
        const name =
          argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
            ? argument.text
            : null;
        if (name === null) {
          violations.push(
            `${locationOf(root, sourceFile, node)} computed DataConnection property access ` +
              'is forbidden because lifecycle authority cannot be proven absent',
          );
        } else if (LIFECYCLE_MEMBERS.has(name)) {
          addLifecycleFinding(node, name);
        }
      }
    } else if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      expressionComesFromDataConnection(checker, node.expression, dataConnectionType) &&
      !typeCouldBeDataConnection(checker, checker.getTypeAtLocation(node), dataConnectionType)
    ) {
      violations.push(
        `${locationOf(root, sourceFile, node)} erasing DataConnection's static type is forbidden ` +
          'because it could expose connection lifecycle authority',
      );
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name)
    ) {
      inspectBindingPattern(node.name, node.initializer);
    } else if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name) && node.type) {
      inspectBindingPattern(node.name, node.name);
    } else if (
      ts.isSpreadAssignment(node) &&
      expressionComesFromDataConnection(checker, node.expression, dataConnectionType)
    ) {
      violations.push(
        `${locationOf(root, sourceFile, node)} spreading DataConnection lifecycle authority ` +
          'into another object is forbidden',
      );
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Enforces the deliberately narrow safety boundary of the redesigned stable-V1
 * product. This is a direct-source guard: it does not claim that shared helper
 * modules cannot close connections passed to them.
 */
export function analyzeLegacyBoundedV1Safety({
  root,
  protectedFiles = DEFAULT_LEGACY_BOUNDED_V1_PROTECTED_FILES,
  forbiddenModuleFiles = DEFAULT_LEGACY_BOUNDED_V1_FORBIDDEN_MODULE_FILES,
  dataConnectionDeclaration = DEFAULT_DATA_CONNECTION_DECLARATION,
  tsconfigFile = 'tsconfig.json',
} = {}) {
  if (!root) throw new TypeError('analyzeLegacyBoundedV1Safety requires a root directory');

  const absoluteRoot = resolve(root);
  const configuration = readProgramConfiguration(absoluteRoot, tsconfigFile);
  const violations = configuration.errors.map((error) => `TypeScript configuration: ${error}`);
  const protectedAbsoluteFiles = protectedFiles.map((file) => absolutePath(absoluteRoot, file));
  const rootNames = [...new Set([...configuration.fileNames, ...protectedAbsoluteFiles])];
  const program = ts.createProgram({
    rootNames,
    options: configuration.options,
    configFileParsingDiagnostics: [],
  });
  const checker = program.getTypeChecker();

  const dataConnectionFile = absolutePath(absoluteRoot, dataConnectionDeclaration.file);
  const dataConnectionSource = program.getSourceFile(dataConnectionFile);
  const dataConnectionType = dataConnectionSource
    ? findNamedType(checker, dataConnectionSource, dataConnectionDeclaration.name)
    : null;
  if (!dataConnectionSource || !dataConnectionType) {
    violations.push(
      `DataConnection declaration ${dataConnectionDeclaration.name} was not found in ` +
        dataConnectionDeclaration.file,
    );
  } else {
    for (const requiredMember of ['peer', 'open', 'send', 'close']) {
      if (!checker.getPropertyOfType(dataConnectionType, requiredMember)) {
        violations.push(
          `DataConnection declaration ${dataConnectionDeclaration.name} is missing expected ` +
            `member '${requiredMember}'`,
        );
      }
    }
  }

  const forbiddenFiles = new Set(
    forbiddenModuleFiles.map((file) => canonicalPath(absolutePath(absoluteRoot, file))),
  );
  let protectedFileCount = 0;
  for (const protectedFile of protectedAbsoluteFiles) {
    const sourceFile = program.getSourceFile(protectedFile);
    if (!sourceFile) {
      violations.push(
        `Protected bounded-V1 production module is missing: ${displayPath(absoluteRoot, protectedFile)}`,
      );
      continue;
    }
    protectedFileCount += 1;
    collectModuleBoundaryFindings({
      compilerOptions: configuration.options,
      forbiddenFiles,
      root: absoluteRoot,
      sourceFile,
      violations,
    });
    if (dataConnectionType) {
      collectConnectionLifecycleFindings({
        checker,
        dataConnectionType,
        root: absoluteRoot,
        sourceFile,
        violations,
      });
    }
  }

  return Object.freeze({
    protectedFileCount,
    violations: Object.freeze([...new Set(violations)].sort()),
  });
}
