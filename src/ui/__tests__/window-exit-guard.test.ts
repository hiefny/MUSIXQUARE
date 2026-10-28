/**
 * @vitest-environment jsdom
 */
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { I18nKey } from '../../i18n/ko.ts';

// Owner policy (2026-10-28): every state a person can leave shows a visible
// exit, Close or Cancel, and a two-button pair puts it on the left with the
// action on the right (the adaptive action group mirrors both for
// right-to-left languages). No dialog leaves a person with action buttons
// alone, as the sign-in view did when it offered only Retry. These guards read
// the source, so a new dialog or window names its exit before it ships.

// A lone button with one of these labels only closes, so it is the exit.
const CLOSE_ONLY_LABELS: readonly I18nKey[] = ['common.ok', 'common.close', 'dialog.got_it'];

// Labels that leave a dialog without acting, for its left (secondary) slot.
const EXIT_LABELS: readonly I18nKey[] = [
  'common.cancel',
  'common.close',
  'common.ok',
  'common.later',
  'common.stay',
  'dialog.go_back',
  'dialog.keep_waiting',
  'demo.prompt_later',
];

// The dialogs that offer no exit, by name, with the reason. Each matches one
// finding of the scan below; an entry that matches nothing fails as stale.
type DialogSlot = 'primary' | 'secondary' | 'choice back';
interface NoExitException {
  readonly file: string;
  readonly slot: DialogSlot;
  readonly label: I18nKey;
  readonly reason: string;
}
const NO_EXIT_EXCEPTIONS: Readonly<Record<string, NoExitException>> = {
  'audio recovery': {
    file: 'src/app.ts',
    slot: 'primary',
    label: 'dialog.audio_recovery_action',
    reason:
      'Only this tap, inside the user gesture, can restart the audio, so the dialog ' +
      'has one button and Back and Escape keep it open.',
  },
  'forced update': {
    file: 'src/sw-register.ts',
    slot: 'primary',
    label: 'dialog.sw_update_apply',
    reason:
      'A build below the floor cannot stay (owner decision 2026-10-25): Apply is the ' +
      'only way on, and Back and Escape keep the dialog open.',
  },
  'room PIN page 2': {
    file: 'src/ui/connect.ts',
    slot: 'choice back',
    label: 'dialog.step_back',
    reason:
      "Page 2's left action applies nothing and steps back to page 1 with the PIN kept, " +
      'where Cancel on the left leaves; it stays so the PIN can still be fixed ' +
      '(owner decision 2026-10-28).',
  },
};

// Windows other than showDialog name a label in this list for their exit.
const WINDOW_EXIT_LABELS: readonly string[] = [
  ...EXIT_LABELS,
  // Closes the language list and the manual sync panel, whose rows apply as
  // they are tapped, so nothing waits on Done.
  'common.done',
  'demo.exit',
  'chat.close',
  'screensaver.back',
  // The onboarding diagnostics are an English-only support tool.
  'CLOSE',
] satisfies ReadonlyArray<I18nKey | 'CLOSE'>;

// How each window registered in dom.ts shows its exit. A markup entry is read
// from index.html and a source entry from the module that builds the window
// at runtime. `leftOf` is the action the exit sits left of in its pair;
// `own row` is a row of its own (alone, or the full-width row under a pair);
// `top start` is the window's first control, in its top start corner.
type Placement = { readonly leftOf: string } | 'own row' | 'top start';
type WindowExit =
  | { readonly notAWindow: string }
  | { readonly markup: ReadonlyArray<{ readonly exit: string; readonly placement: Placement }> }
  | {
      readonly source: string;
      readonly exit: string;
      readonly placement: { readonly leftOf: readonly string[] } | 'own row';
    };
const WINDOW_EXITS: Readonly<Record<string, WindowExit>> = {
  'setup-overlay': {
    notAWindow:
      'The setup screens are the page itself, not a window over it (dom.ts BASE_SCREEN_ID).',
  },
  'demo-overlay': {
    markup: [
      { exit: '#btn-demo-exit', placement: 'top start' },
      { exit: '[data-demo-exit]', placement: { leftOf: '[data-demo-info]' } },
    ],
  },
  'media-source-overlay': {
    markup: [{ exit: '#btn-close-media-popup', placement: 'own row' }],
  },
  'youtube-url-overlay': {
    markup: [{ exit: '#btn-yt-cancel', placement: { leftOf: '#youtube-play-btn' } }],
  },
  'screensaver-overlay': {
    source: 'src/ui/screensaver.ts',
    exit: 'fallbackBack',
    placement: 'own row',
  },
  // The labels come from the showDialog callers, checked above.
  'dialog-overlay': {
    markup: [{ exit: '#btn-dialog-secondary', placement: { leftOf: '#btn-dialog-ok' } }],
  },
  'signaling-recovery-overlay': {
    markup: [
      {
        exit: '#btn-signaling-recovery-confirm',
        placement: { leftOf: '#btn-signaling-recovery-retry' },
      },
    ],
  },
  'account-dialog-overlay': {
    markup: [
      { exit: '#btn-account-login-close', placement: { leftOf: '#btn-account-login-retry' } },
      { exit: '#btn-account-center-close', placement: 'own row' },
    ],
  },
  'administrator-permissions-overlay': {
    markup: [
      {
        exit: '#btn-administrator-permissions-cancel',
        placement: { leftOf: '#btn-administrator-permissions-save' },
      },
    ],
  },
  'language-dialog-overlay': {
    markup: [{ exit: '#btn-language-dialog-done', placement: 'own row' }],
  },
  'playlist-slots-overlay': {
    markup: [
      { exit: '#btn-playlist-slots-cancel', placement: { leftOf: '#btn-playlist-slots-done' } },
    ],
  },
  'playlist-transfer-overlay': {
    markup: [{ exit: '#btn-playlist-transfer-close', placement: 'own row' }],
  },
  'manual-sync-overlay': {
    markup: [{ exit: '#btn-sync-done', placement: { leftOf: '#btn-auto-sync' } }],
  },
  'onboarding-diagnostics-overlay': {
    source: 'src/ui/onboarding-diagnostics.ts',
    exit: 'closeButton',
    placement: { leftOf: ['copyButton', 'refreshButton'] },
  },
  // The phone chat sheet: dom.ts reaches it outside the registry.
  'chat-drawer': {
    markup: [{ exit: '#btn-chat-close', placement: 'top start' }],
  },
};
const CHAT_SHEET_SELECTOR = '#chat-drawer.open[aria-modal="true"]';

// ─── Source reading ──────────────────────────────────────────────

const read = (path: string): string => readFileSync(resolve(path), 'utf8');
const repositoryPath = (file: string): string => relative(resolve('.'), file).replaceAll('\\', '/');

function sourceFiles(directory = resolve('src')): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sourceFiles(path));
    } else if (/\.m?tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}
const SOURCE_FILES = sourceFiles().map((file) => ({
  path: repositoryPath(file),
  text: readFileSync(file, 'utf8'),
}));

const parsedFiles = new Map<string, ts.SourceFile>();
// `element.id = ID` assignments, by the declaration of `element`.
const assignedElementIds = new Map<ts.Node, string>();

function parse(path: string): ts.SourceFile {
  const cached = parsedFiles.get(path);
  if (cached) return cached;
  const text = SOURCE_FILES.find((file) => file.path === path)?.text ?? read(path);
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsedFiles.set(path, sourceFile);
  walk(sourceFile, (node) => {
    if (!isAssignment(node) || !ts.isPropertyAccessExpression(node.left)) return;
    if (node.left.name.text !== 'id') return;
    const target = unwrap(node.left.expression);
    const value = stringValue(node.right);
    const declaration = ts.isIdentifier(target) ? declarationOf(target) : undefined;
    if (declaration && value) assignedElementIds.set(declaration, value);
  });
  return sourceFile;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

const lineOf = (node: ts.Node): number =>
  node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

type Binding = ts.VariableDeclaration | ts.FunctionDeclaration | ts.ParameterDeclaration;

/** The nearest enclosing declaration of `name`, by lexical scope. */
function declarationOf(name: ts.Identifier): Binding | undefined {
  for (let scope: ts.Node | undefined = name.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name.text,
      );
      if (parameter) return parameter;
    }
    const statements =
      ts.isSourceFile(scope) ||
      ts.isBlock(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseClause(scope) ||
      ts.isDefaultClause(scope)
        ? scope.statements
        : undefined;
    for (const statement of statements ?? []) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name.text) {
        return statement;
      }
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name.text,
      );
      if (declaration) return declaration;
    }
  }
  return undefined;
}

/** A string literal, directly or through a constant. */
function stringValue(node: ts.Expression): string | null {
  const expression = unwrap(node);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isIdentifier(expression)) return null;
  const declaration = declarationOf(expression);
  return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
    ? stringValue(declaration.initializer)
    : null;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

const ELEMENT_LOOKUPS = new Set(['getUiElement', 'getElementById', 'byId', 'querySelector']);

/** The element id `node` holds, through lookups by id and `element.id = ID`. */
function elementIdOf(node: ts.Expression, seen = new Set<ts.Node>()): string | null {
  const expression = unwrap(node);
  if (ts.isCallExpression(expression)) {
    const argument = expression.arguments[0];
    const name = calleeName(expression);
    if (!argument || !name || !ELEMENT_LOOKUPS.has(name)) return null;
    const value = stringValue(argument);
    return value?.startsWith('#') ? value.slice(1) : value;
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return elementIdOf(expression.left, seen);
  }
  if (!ts.isIdentifier(expression)) return null;
  const declaration = declarationOf(expression);
  if (!declaration || !ts.isVariableDeclaration(declaration) || seen.has(declaration)) return null;
  seen.add(declaration);
  const assigned = assignedElementIds.get(declaration);
  if (assigned) return assigned;
  return declaration.initializer ? elementIdOf(declaration.initializer, seen) : null;
}

/** Every i18n key a `t(...)` call inside `node` can show, across its branches. */
function translatedKeys(node: ts.Node): string[] {
  const keys: string[] = [];
  const branches = (expression: ts.Expression): void => {
    const value = unwrap(expression);
    if (ts.isStringLiteralLike(value)) keys.push(value.text);
    else if (ts.isConditionalExpression(value)) {
      branches(value.whenTrue);
      branches(value.whenFalse);
    }
  };
  walk(node, (child) => {
    if (!ts.isCallExpression(child) || !ts.isIdentifier(child.expression)) return;
    if (child.expression.text === 't' && child.arguments[0]) branches(child.arguments[0]);
  });
  return keys;
}

// ─── showDialog ──────────────────────────────────────────────────

interface DialogFinding {
  readonly file: string;
  readonly line: number;
  readonly slot: DialogSlot;
  readonly labels: readonly string[];
  /** History Back and Escape close the dialog unless `closeOnBack: false`. */
  readonly closeOnBack: boolean | 'unreadable';
}

const UNREADABLE = '(unreadable: write the label as t(key) in the options literal)';
const DIALOG_OPTIONS = new Set(['buttonText', 'secondaryText', 'cancelText', 'closeOnBack']);

type Conditions = ReadonlyMap<string, boolean>;
const conditionText = (node: ts.Expression): string => node.getText().replace(/\s+/gu, ' ');

/** The branch of a conditional spread or label that `conditions` selects. */
function choose(node: ts.Expression, conditions: Conditions): ts.Expression | null {
  const expression = unwrap(node);
  if (ts.isConditionalExpression(expression)) {
    const branch = conditions.get(conditionText(expression.condition))
      ? expression.whenTrue
      : expression.whenFalse;
    return choose(branch, conditions);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return conditions.get(conditionText(expression.left))
      ? choose(expression.right, conditions)
      : null;
  }
  return expression;
}

/** Conditions that pick a button label, an exit or a spread of options. */
function collectConditions(options: ts.ObjectLiteralExpression, into: Set<string>): void {
  const spread = (node: ts.Expression): void => {
    const expression = unwrap(node);
    if (ts.isConditionalExpression(expression)) {
      into.add(conditionText(expression.condition));
      spread(expression.whenTrue);
      spread(expression.whenFalse);
    } else if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      into.add(conditionText(expression.left));
      spread(expression.right);
    } else if (ts.isObjectLiteralExpression(expression)) {
      collectConditions(expression, into);
    }
  };
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) spread(property.expression);
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name.getText().replace(/^['"]|['"]$/gu, '');
    if (!DIALOG_OPTIONS.has(name) && name !== 'choiceStep') continue;
    walk(property.initializer, (node) => {
      if (ts.isConditionalExpression(node)) into.add(conditionText(node.condition));
    });
  }
}

/** The options one set of conditions produces, or null for an opaque spread. */
function resolveOptions(
  options: ts.ObjectLiteralExpression,
  conditions: Conditions,
  into = new Map<string, ts.Expression>(),
): Map<string, ts.Expression> | null {
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property)) {
      into.set(property.name.getText().replace(/^['"]|['"]$/gu, ''), property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      into.set(property.name.text, property.name);
    } else if (ts.isSpreadAssignment(property)) {
      const chosen = choose(property.expression, conditions);
      if (chosen === null) continue;
      if (!ts.isObjectLiteralExpression(chosen)) return null;
      if (!resolveOptions(chosen, conditions, into)) return null;
    }
  }
  return into;
}

/** The i18n keys one dialog label shows, or null when it cannot be read. */
function dialogLabels(node: ts.Expression, conditions: Conditions): string[] | null {
  const expression = choose(node, conditions);
  if (!expression) return null;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    const body = expression.body;
    if (!ts.isBlock(body)) return dialogLabels(body, conditions);
    const [statement] = body.statements;
    return body.statements.length === 1 && statement && ts.isReturnStatement(statement)
      ? statement.expression
        ? dialogLabels(statement.expression, conditions)
        : null
      : null;
  }
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return null;
  if (expression.expression.text !== 't' || !expression.arguments[0]) return null;
  const key = choose(expression.arguments[0], conditions);
  return key && ts.isStringLiteralLike(key) ? [key.text] : null;
}

function closeOnBackOf(options: ReadonlyMap<string, ts.Expression>): boolean | 'unreadable' {
  const value = options.get('closeOnBack');
  if (!value) return true;
  const expression = unwrap(value);
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  return 'unreadable';
}

function dialogFindings(
  file: string,
  call: ts.CallExpression,
  options: ReadonlyMap<string, ts.Expression>,
  conditions: Conditions,
): DialogFinding[] {
  const line = lineOf(call);
  const closeOnBack = closeOnBackOf(options);
  const finding = (slot: DialogSlot, labels: readonly string[] | null): DialogFinding => ({
    file,
    line,
    slot,
    labels: labels ?? [UNREADABLE],
    closeOnBack,
  });
  const findings: DialogFinding[] = [];
  const exit = options.get('secondaryText') ?? options.get('cancelText');
  if (exit) {
    // The engine shows the secondary action on the left of the pair.
    const labels = dialogLabels(exit, conditions);
    if (!labels || labels.some((label) => !(EXIT_LABELS as readonly string[]).includes(label))) {
      findings.push(finding('secondary', labels));
    }
  } else {
    const primary = options.get('buttonText');
    const labels = primary ? dialogLabels(primary, conditions) : ['common.ok'];
    if (
      !labels ||
      labels.some((label) => !(CLOSE_ONLY_LABELS as readonly string[]).includes(label))
    ) {
      findings.push(finding('primary', labels));
    }
  }
  const choiceStep = options.get('choiceStep');
  if (choiceStep) {
    const page = unwrap(choiceStep);
    const pageOptions = ts.isObjectLiteralExpression(page)
      ? resolveOptions(page, conditions)
      : null;
    const back = pageOptions?.get('backText');
    const labels = back ? dialogLabels(back, conditions) : null;
    if (!labels || labels.some((label) => !(EXIT_LABELS as readonly string[]).includes(label))) {
      findings.push(finding('choice back', labels));
    }
  }
  return findings;
}

function scanDialogs(): { calls: number; findings: DialogFinding[] } {
  let calls = 0;
  const findings = new Map<string, DialogFinding>();
  for (const { path, text } of SOURCE_FILES) {
    if (!text.includes('showDialog')) continue;
    walk(parse(path), (node) => {
      if (!ts.isCallExpression(node) || calleeName(node) !== 'showDialog') return;
      calls += 1;
      const argument = node.arguments[0] ? unwrap(node.arguments[0]) : undefined;
      // No options, or a message alone, shows OK by itself.
      if (!argument || ts.isStringLiteralLike(argument)) return;
      const add = (finding: DialogFinding): void => {
        findings.set(
          `${finding.file}:${finding.line} ${finding.slot} ${finding.labels.join('|')}`,
          finding,
        );
      };
      if (!ts.isObjectLiteralExpression(argument)) {
        add({
          file: path,
          line: lineOf(node),
          slot: 'primary',
          labels: [UNREADABLE],
          closeOnBack: true,
        });
        return;
      }
      const names = new Set<string>();
      collectConditions(argument, names);
      const conditions = [...names];
      expect(conditions.length, `${path}:${lineOf(node)} has too many branches`).toBeLessThan(9);
      for (let mask = 0; mask < 2 ** conditions.length; mask += 1) {
        const values = new Map(
          conditions.map((name, index) => [name, (mask & (1 << index)) !== 0]),
        );
        const options = resolveOptions(argument, values);
        if (!options) {
          add({
            file: path,
            line: lineOf(node),
            slot: 'primary',
            labels: [UNREADABLE],
            closeOnBack: true,
          });
          continue;
        }
        for (const finding of dialogFindings(path, node, options, values)) add(finding);
      }
    });
  }
  return { calls, findings: [...findings.values()] };
}

const exceptionFor = (finding: DialogFinding): [string, NoExitException] | undefined =>
  Object.entries(NO_EXIT_EXCEPTIONS).find(
    ([, exception]) =>
      exception.file === finding.file &&
      exception.slot === finding.slot &&
      finding.labels.length === 1 &&
      finding.labels[0] === exception.label,
  );

const describeFinding = (finding: DialogFinding): string =>
  `${finding.file}:${finding.line} ${finding.slot} ${finding.labels.join(' | ')}`;

// ─── Custom windows ──────────────────────────────────────────────

/** The `id` of every entry in dom.ts's overlay registry. */
function registeredOverlayIds(): string[] {
  const ids: string[] = [];
  walk(parse('src/ui/dom.ts'), (node) => {
    if (!ts.isVariableDeclaration(node) || node.name.getText() !== 'OVERLAYS') return;
    const list = node.initializer ? unwrap(node.initializer) : undefined;
    if (!list || !ts.isArrayLiteralExpression(list)) return;
    for (const element of list.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      for (const property of element.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText() === 'id') {
          const id = stringValue(property.initializer);
          if (id) ids.push(id);
        }
      }
    }
  });
  return ids;
}

function domConstant(name: string): string | null {
  let value: string | null = null;
  walk(parse('src/ui/dom.ts'), (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer) {
      value = stringValue(node.initializer);
    }
  });
  return value;
}

/** i18n keys or literal labels written to element `id` by the app at runtime. */
function runtimeLabelsForElement(id: string): string[] {
  const labels: string[] = [];
  const LABEL_PROPERTIES = new Set(['textContent', 'innerText', 'ariaLabel']);
  for (const { path, text } of SOURCE_FILES) {
    if (!text.includes(id)) continue;
    walk(parse(path), (node) => {
      if (isAssignment(node) && ts.isPropertyAccessExpression(node.left)) {
        const { name, expression } = node.left;
        if (LABEL_PROPERTIES.has(name.text) && elementIdOf(expression) === id) {
          labels.push(...translatedKeys(node.right));
        }
        return;
      }
      if (!ts.isCallExpression(node) || calleeName(node) !== 'setAttribute') return;
      const callee = unwrap(node.expression);
      const [attribute, value] = node.arguments;
      if (!ts.isPropertyAccessExpression(callee) || !attribute || !value) return;
      if (elementIdOf(callee.expression) !== id) return;
      const name = stringValue(attribute);
      if (name === 'aria-label') labels.push(...translatedKeys(value));
      if (name === 'data-i18n' || name === 'data-i18n-aria-label') {
        const key = stringValue(value);
        if (key) labels.push(key);
      }
    });
  }
  return labels;
}

function markupLabels(element: Element): string[] {
  const labels = [element, ...element.querySelectorAll('[data-i18n]')]
    .map((node) => node.getAttribute('data-i18n'))
    .filter((key): key is string => !!key);
  const aria = element.getAttribute('data-i18n-aria-label');
  if (aria) labels.push(aria);
  if (element.id) labels.push(...runtimeLabelsForElement(element.id));
  return labels;
}

function labelProblem(where: string, labels: readonly string[]): string | null {
  if (labels.length === 0) return `${where} has no label the guard can read`;
  const actions = labels.filter((label) => !WINDOW_EXIT_LABELS.includes(label));
  return actions.length ? `${where} is labelled as an action: ${actions.join(', ')}` : null;
}

function markupExitProblems(
  windowId: string,
  root: Element,
  exit: string,
  placement: Placement,
): string[] {
  const where = `${windowId} ${exit}`;
  const element = root.querySelector(exit);
  if (!element) return [`${where} is missing from index.html`];
  const problems: string[] = [];
  const label = labelProblem(where, markupLabels(element));
  if (label) problems.push(label);
  if (placement === 'top start') {
    if (root.querySelector('button') !== element) {
      problems.push(`${where} is not the window's first control`);
    }
  } else if (placement === 'own row') {
    const row = element.parentElement;
    const siblings = row ? [...row.querySelectorAll(':scope > button')] : [];
    if (siblings.length > 1 && !element.classList.contains('adaptive-action-group-full')) {
      problems.push(`${where} shares its row with an action`);
    }
  } else {
    const partner = root.querySelector(placement.leftOf);
    if (!partner) problems.push(`${where}: its pair ${placement.leftOf} is missing`);
    else if (partner.parentElement !== element.parentElement) {
      problems.push(`${where} is not in one row with ${placement.leftOf}`);
    } else if (!(element.compareDocumentPosition(partner) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      problems.push(`${where} is not on the left of ${placement.leftOf}`);
    }
  }
  return problems;
}

function sourceExitProblems(
  windowId: string,
  path: string,
  exit: string,
  placement: { readonly leftOf: readonly string[] } | 'own row',
): string[] {
  const where = `${windowId} ${path} ${exit}`;
  const sourceFile = parse(path);
  const declarations: ts.VariableDeclaration[] = [];
  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === exit) declarations.push(node);
  });
  const [declaration] = declarations;
  if (declarations.length !== 1 || !declaration?.initializer) {
    return [`${where} is not one variable with an initializer`];
  }
  const initializer = unwrap(declaration.initializer);
  const factory = ts.isCallExpression(initializer) ? calleeName(initializer) : null;
  const labels: string[] = [];
  // A factory call such as createAction('CLOSE') carries a literal label.
  if (ts.isCallExpression(initializer) && factory !== 'createElement') {
    for (const argument of initializer.arguments) {
      const value = stringValue(argument);
      if (value) labels.push(value);
    }
  }
  const refersToExit = (node: ts.Expression): boolean => {
    const expression = unwrap(node);
    return ts.isIdentifier(expression) && declarationOf(expression) === declaration;
  };
  const appends: ts.CallExpression[] = [];
  walk(sourceFile, (node) => {
    if (isAssignment(node) && ts.isPropertyAccessExpression(node.left)) {
      if (node.left.name.text === 'textContent' && refersToExit(node.left.expression)) {
        labels.push(...translatedKeys(node.right));
      }
    }
    if (ts.isCallExpression(node) && calleeName(node) === 'append') {
      if (node.arguments.some(refersToExit)) appends.push(node);
    }
  });
  const problems: string[] = [];
  const label = labelProblem(where, labels);
  if (label) problems.push(label);
  const [append] = appends;
  if (appends.length !== 1 || !append) return [...problems, `${where} is not appended once`];
  const names = append.arguments.map((argument) => unwrap(argument).getText());
  if (placement === 'own row') {
    const isButton = (argument: ts.Expression): boolean => {
      const expression = unwrap(argument);
      const other = ts.isIdentifier(expression) ? declarationOf(expression) : undefined;
      const value =
        other && ts.isVariableDeclaration(other) && other.initializer
          ? unwrap(other.initializer)
          : undefined;
      if (!value || !ts.isCallExpression(value)) return false;
      if (factory !== 'createElement' && calleeName(value) === factory) return true;
      const [tag] = value.arguments;
      return calleeName(value) === 'createElement' && !!tag && stringValue(tag) === 'button';
    };
    if (append.arguments.some((argument) => !refersToExit(argument) && isButton(argument))) {
      problems.push(`${where} shares its row with an action`);
    }
  } else {
    for (const partner of placement.leftOf) {
      const index = names.indexOf(partner);
      if (index < 0) problems.push(`${where}: ${partner} is not in its row`);
      else if (index < names.indexOf(exit)) problems.push(`${where} is not left of ${partner}`);
    }
  }
  return problems;
}

describe('every leavable window shows a visible exit (owner policy 2026-10-28)', () => {
  it('gives every showDialog state an exit on the left, or names why it has none', () => {
    const { calls, findings } = scanDialogs();
    expect(calls).toBeGreaterThan(30);

    const unexplained = findings.filter((finding) => !exceptionFor(finding));
    expect(unexplained.map(describeFinding)).toEqual([]);

    const stale = Object.entries(NO_EXIT_EXCEPTIONS)
      .filter(([name]) => !findings.some((finding) => exceptionFor(finding)?.[0] === name))
      .map(([name, exception]) => `${name} (${exception.file} ${exception.label})`);
    expect(stale).toEqual([]);

    // A dialog with no exit stays only while nothing can leave it: if Back
    // or Escape closed it, the state would be leavable with no visible exit.
    const leavable = findings.filter(
      (finding) => exceptionFor(finding)?.[1].slot === 'primary' && finding.closeOnBack !== false,
    );
    expect(leavable.map(describeFinding)).toEqual([]);
  });

  it('gives every window registered in dom.ts an exit, on the left of any pair', () => {
    const registered = registeredOverlayIds();
    expect(registered).toContain('dialog-overlay');
    expect(read('src/ui/dom.ts')).toContain(CHAT_SHEET_SELECTOR);
    const windows = [...registered, 'chat-drawer'];
    expect(Object.keys(WINDOW_EXITS).sort()).toEqual([...windows].sort());

    const notWindows = Object.entries(WINDOW_EXITS)
      .filter(([, entry]) => 'notAWindow' in entry)
      .map(([id]) => id);
    expect(notWindows).toEqual([domConstant('BASE_SCREEN_ID')]);

    const markup = new DOMParser().parseFromString(read('index.html'), 'text/html');
    const problems: string[] = [];
    for (const [windowId, entry] of Object.entries(WINDOW_EXITS)) {
      if ('notAWindow' in entry) continue;
      if ('source' in entry) {
        problems.push(...sourceExitProblems(windowId, entry.source, entry.exit, entry.placement));
        continue;
      }
      const root = markup.getElementById(windowId);
      if (!root) {
        problems.push(`${windowId} is missing from index.html`);
        continue;
      }
      for (const { exit, placement } of entry.markup) {
        problems.push(...markupExitProblems(windowId, root, exit, placement));
      }
    }
    expect(problems).toEqual([]);
  });
});
