import ts from 'typescript';

export const PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS = Date.UTC(2026, 8, 9);

function section(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'u'))?.[1] ?? '';
}

function assignment(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`^\\s*${escaped}\\s*=\\s*([^#\\r\\n]+)`, 'mu'))?.[1]?.trim();
}

function unwrapExpression(expression) {
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

function accessedPropertyName(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    (ts.isStringLiteral(current.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
  ) {
    return current.argumentExpression.text;
  }
  return null;
}

function callReceiver(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.expression;
  if (ts.isElementAccessExpression(current)) return current.expression;
  return null;
}

function walk(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
    );
  }
  return [];
}

function mutatedRootName(expression) {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function assignmentTargetNames(target) {
  const current = unwrapExpression(target);
  if (ts.isIdentifier(current)) return [current.text];
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) =>
      ts.isOmittedExpression(element) || ts.isSpreadElement(element)
        ? []
        : assignmentTargetNames(element),
    );
  }
  const mutatedRoot = mutatedRootName(current);
  return mutatedRoot ? [mutatedRoot] : [];
}

function analyzeTicketQueryFlow(workerSource) {
  const sourceFile = ts.createSourceFile(
    'signaling-worker.js',
    workerSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const assignments = [];
  const constantStringAssignments = [];
  const constantStrings = new Map();
  const searchParamsAliases = new Set();

  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const names = bindingNames(node.name);
      if (names.length > 0) assignments.push({ names, expression: node.initializer });
      if (
        ts.isIdentifier(node.name) &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        constantStringAssignments.push({ name: node.name.text, expression: node.initializer });
      }
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const names = assignmentTargetNames(node.left);
      if (names.length > 0) assignments.push({ names, expression: node.right });
    }
  });

  const staticStringValue = (expression) => {
    const current = unwrapExpression(expression);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      return current.text;
    }
    if (ts.isIdentifier(current)) return constantStrings.get(current.text) ?? null;
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticStringValue(current.left);
      const right = staticStringValue(current.right);
      return left === null || right === null ? null : `${left}${right}`;
    }
    return null;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const assignmentNode of constantStringAssignments) {
      if (constantStrings.has(assignmentNode.name)) continue;
      const value = staticStringValue(assignmentNode.expression);
      if (value !== null) {
        constantStrings.set(assignmentNode.name, value);
        changed = true;
      }
    }
  }

  const isSearchParamsExpression = (expression) => {
    const current = unwrapExpression(expression);
    return (
      accessedPropertyName(current) === 'searchParams' ||
      (ts.isIdentifier(current) && searchParamsAliases.has(current.text))
    );
  };

  changed = true;
  while (changed) {
    changed = false;
    for (const assignmentNode of assignments) {
      if (
        assignmentNode.names.some((name) => !searchParamsAliases.has(name)) &&
        isSearchParamsExpression(assignmentNode.expression)
      ) {
        for (const name of assignmentNode.names) searchParamsAliases.add(name);
        changed = true;
      }
    }
  }

  const ticketQueryMethod = (node) => {
    if (!ts.isCallExpression(node) || node.arguments.length < 1) return null;
    const callable = unwrapExpression(node.expression);
    const receiver = callReceiver(node.expression);
    if (!receiver) return null;
    const key = staticStringValue(node.arguments[0]);
    let method = accessedPropertyName(callable);
    if (method === null && ts.isElementAccessExpression(callable)) {
      method = callable.argumentExpression ? staticStringValue(callable.argumentExpression) : null;
      if (method === null && (key === null || key === 'ticket')) {
        // A dynamic method on a potential ticket reader may resolve to get or
        // getAll. Classify it as a value read so the cutoff guard fails closed.
        method = 'getAll';
      }
    }
    if (method !== 'get' && method !== 'getAll' && method !== 'has') return null;
    const knownSearchParamsReceiver = isSearchParamsExpression(receiver);
    if (!knownSearchParamsReceiver && key !== 'ticket') return null;
    // An unresolved dynamic key could still be `ticket`. Treat it as a
    // credential read so future refactors fail closed rather than silently
    // bypassing the dated privacy/admission guard.
    return key === null || key === 'ticket' ? method : null;
  };

  const isReviewedStructuralProbe = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(unwrapExpression(node.expression)) &&
    unwrapExpression(node.expression).text === 'isStructurallyPlausibleProSignalingTicket';

  let readsTicketQuery = false;
  walk(sourceFile, (node) => {
    if (ticketQueryMethod(node)) readsTicketQuery = true;
  });

  const bearerIdentifiers = new Set();
  const expressionContainsBearer = (expression) => {
    let found = false;
    const visit = (node) => {
      if (found || isReviewedStructuralProbe(node)) return;
      const method = ticketQueryMethod(node);
      if (method === 'get' || method === 'getAll') {
        found = true;
        return;
      }
      if (ts.isIdentifier(node) && bearerIdentifiers.has(node.text)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(unwrapExpression(expression));
    return found;
  };

  changed = true;
  while (changed) {
    changed = false;
    for (const assignmentNode of assignments) {
      if (
        assignmentNode.names.some((name) => !bearerIdentifiers.has(name)) &&
        expressionContainsBearer(assignmentNode.expression)
      ) {
        for (const name of assignmentNode.names) bearerIdentifiers.add(name);
        changed = true;
      }
    }
  }

  let exposesQueryBearer = false;
  let verifiesQueryBearer = false;
  walk(sourceFile, (node) => {
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      expressionContainsBearer(node.expression)
    ) {
      exposesQueryBearer = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(unwrapExpression(node.expression)) &&
      unwrapExpression(node.expression).text === 'verifyProSignalingTicket' &&
      node.arguments.some((argument) => expressionContainsBearer(argument))
    ) {
      verifiesQueryBearer = true;
    }
  });

  return {
    readsTicketQuery,
    acceptsLegacyQuery: exposesQueryBearer || verifiesQueryBearer,
  };
}

/**
 * Keep URL-bearer compatibility, aggregate metrics, and provider telemetry in
 * one fail-closed lifecycle. The runtime date stops admission; this guard makes
 * the next source deployment remove the dead admission branch as well.
 */
export function validateProSignalingTicketCutover({
  workerSource,
  signalingConfig,
  adminWorkerSource = '',
  nowMs = Date.now(),
}) {
  const errors = [];
  const { readsTicketQuery, acceptsLegacyQuery } = analyzeTicketQueryFlow(workerSource);
  const hasCutoff = workerSource.includes(
    'const PRO_SIGNALING_LEGACY_QUERY_ACCEPT_UNTIL_MS = Date.UTC(2026, 8, 9);',
  );
  const hasRefreshContract =
    workerSource.includes(
      "const PRO_SIGNALING_CLIENT_UPDATE_REQUIRED = 'PRO_SIGNALING_CLIENT_UPDATE_REQUIRED';",
    ) && workerSource.includes("{ 'x-mxqr-client-action': 'refresh' }");
  const hasAcceptedMetric = workerSource.includes("'pro_ticket_legacy_query_used'");
  const hasRefreshMetric = workerSource.includes("'pro_ticket_legacy_query_update_required'");
  const refreshBranchVerifies = [
    ...workerSource.matchAll(
      /if\s*\(isProSignalingClientUpdateRequired\(credential\)\)\s*\{([\s\S]*?)return\s+proSignalingClientUpdateRequired\(\);/gu,
    ),
  ].some((match) => match[1].includes('verifyProSignalingTicket'));
  const postCutoffCredentialExposesBearer = [
    ...workerSource.matchAll(
      /return\s*\{\s*error:\s*PRO_SIGNALING_CLIENT_UPDATE_REQUIRED([\s\S]*?)\n\s*\};/gu,
    ),
  ].some((match) => /\bticket\s*:/u.test(match[1]));
  const logs = section(signalingConfig, 'observability.logs');
  const traces = section(signalingConfig, 'observability.traces');
  const invocationLogs = assignment(logs, 'invocation_logs');
  const tracesEnabled = assignment(traces, 'enabled');
  const hasAdminMetricsBinding = /^\s*binding\s*=\s*['"]MUSIXQUARE_ADMIN_DB['"]\s*$/mu.test(
    signalingConfig,
  );
  const hasServiceControlBinding = /^\s*name\s*=\s*['"]MUSIXQUARE_SERVICE_CONTROL['"]\s*$/mu.test(
    signalingConfig,
  );

  if (acceptsLegacyQuery && !hasCutoff) {
    errors.push('legacy PRO query-ticket admission must retain the exact 2026-09-09 UTC cutoff');
  }
  if (acceptsLegacyQuery && nowMs >= PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS) {
    errors.push(
      'legacy PRO query-ticket admission is past cutoff; remove its ticket verification/admission branch before deploying',
    );
  }
  if (readsTicketQuery && !hasRefreshContract) {
    errors.push('legacy PRO query detection must return the explicit refresh/update contract');
  }
  if (refreshBranchVerifies || postCutoffCredentialExposesBearer) {
    errors.push('post-cutoff refresh handling must not retain or verify the query bearer');
  }
  if (acceptsLegacyQuery && !hasAcceptedMetric) {
    errors.push('pre-cutoff legacy PRO query admission must retain its aggregate usage metric');
  }
  if (readsTicketQuery && !hasRefreshMetric) {
    errors.push('legacy PRO query detection must retain the aggregate refresh metric');
  }
  if (readsTicketQuery && !hasAdminMetricsBinding) {
    errors.push(
      'legacy PRO query-ticket metrics require the MUSIXQUARE_ADMIN_DB signaling binding',
    );
  }
  if (readsTicketQuery && !hasServiceControlBinding) {
    errors.push(
      'legacy PRO query-ticket metrics require the MUSIXQUARE_SERVICE_CONTROL signaling binding',
    );
  }
  if (acceptsLegacyQuery && !adminWorkerSource.includes("key: 'pro_ticket_legacy_query_used'")) {
    errors.push('the admin metric inventory must expose the legacy PRO usage counter');
  }
  if (
    readsTicketQuery &&
    !adminWorkerSource.includes("key: 'pro_ticket_legacy_query_update_required'")
  ) {
    errors.push('the admin metric inventory must expose the legacy PRO refresh counter');
  }
  if (readsTicketQuery && invocationLogs !== 'false') {
    errors.push(
      'signaling invocation_logs must stay false while any legacy ticket query can arrive',
    );
  }
  if (readsTicketQuery && tracesEnabled !== 'false') {
    errors.push(
      'signaling automatic traces must stay disabled while any legacy ticket query can arrive',
    );
  }

  return errors;
}
