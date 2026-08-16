import ts from 'typescript';

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
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

function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function literalPropertyName(
  expression: ts.Expression,
  constantStrings: ReadonlyMap<string, string>,
): string | null {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (!ts.isElementAccessExpression(current) || !current.argumentExpression) return null;
  return staticStringValue(current.argumentExpression, constantStrings);
}

function staticStringValue(
  expression: ts.Expression,
  constantStrings: ReadonlyMap<string, string>,
): string | null {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }
  if (ts.isIdentifier(current)) return constantStrings.get(current.text) ?? null;
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(current.left, constantStrings);
    const right = staticStringValue(current.right, constantStrings);
    return left === null || right === null ? null : `${left}${right}`;
  }
  return null;
}

function analyzeWorker(workerSource: string): {
  readsTicketQuery: boolean;
  credentialReaderBody: string;
} {
  const sourceFile = ts.createSourceFile(
    'signaling-worker.ts',
    workerSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const constantAssignments: Array<{ name: string; expression: ts.Expression }> = [];
  const constantStrings = new Map<string, string>();

  walk(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      constantAssignments.push({ name: node.name.text, expression: node.initializer });
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of constantAssignments) {
      if (constantStrings.has(assignment.name)) continue;
      const value = staticStringValue(assignment.expression, constantStrings);
      if (value !== null) {
        constantStrings.set(assignment.name, value);
        changed = true;
      }
    }
  }

  let readsTicketQuery = false;
  let credentialReaderBody = '';
  walk(sourceFile, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'readProSignalingCredential' &&
      node.body
    ) {
      credentialReaderBody = node.body.getText(sourceFile);
    }
    if (!ts.isCallExpression(node) || node.arguments.length < 1) return;
    const callable = unwrapExpression(node.expression);
    if (!ts.isPropertyAccessExpression(callable) && !ts.isElementAccessExpression(callable)) {
      return;
    }
    const method = literalPropertyName(callable, constantStrings);
    if (method !== 'get' && method !== 'getAll' && method !== 'has') return;
    const receiver = unwrapExpression(callable.expression);
    const receiverProperty = literalPropertyName(receiver, constantStrings);
    const argument = node.arguments[0];
    if (argument === undefined) return;
    const key = staticStringValue(argument, constantStrings);
    if (key === 'ticket' || (receiverProperty === 'searchParams' && key === null)) {
      readsTicketQuery = true;
    }
  });

  return { readsTicketQuery, credentialReaderBody };
}

/**
 * Permanently pin the PRO WebSocket credential to the two-token subprotocol
 * contract. URL query credentials and their retired rollout machinery must
 * never return through a later refactor.
 */
export function validateProSignalingCredentialBoundary({
  workerSource,
}: {
  workerSource: string;
}): string[] {
  const errors: string[] = [];
  const { readsTicketQuery, credentialReaderBody } = analyzeWorker(workerSource);

  if (readsTicketQuery) {
    errors.push('PRO signaling must never read a ticket credential from URL search parameters');
  }
  if (!workerSource.includes("const PRO_SIGNALING_WEBSOCKET_PROTOCOL = 'mxqr.pro-signaling.v1';")) {
    errors.push('PRO signaling must retain the stable WebSocket protocol marker');
  }
  if (!workerSource.includes("const PRO_SIGNALING_TICKET_PROTOCOL_PREFIX = 'mxqr.ticket.';")) {
    errors.push('PRO signaling must retain the dedicated ticket subprotocol prefix');
  }
  if (!credentialReaderBody.includes("request.headers.get('Sec-WebSocket-Protocol')")) {
    errors.push('PRO signaling credentials must come from Sec-WebSocket-Protocol');
  }
  if (!credentialReaderBody.includes('url.search || url.hash')) {
    errors.push('PRO signaling credential parsing must reject every URL query or fragment');
  }
  if (!credentialReaderBody.includes('protocols.length !== 2')) {
    errors.push('PRO signaling must require exactly the stable marker and one ticket token');
  }
  if (/PRO_SIGNALING_[A-Z0-9_]*QUERY[A-Z0-9_]*UNTIL/u.test(workerSource)) {
    errors.push('PRO signaling must not retain a dated query-credential cutoff');
  }
  if (/PRO_SIGNALING_[A-Z0-9_]*UPDATE_REQUIRED/u.test(workerSource)) {
    errors.push('PRO signaling must not retain retired client-refresh compatibility');
  }
  return errors;
}
