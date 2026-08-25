import ts from 'typescript';

const PIN_PEPPER_BINDING = 'MXQR_STANDARD_ROOM_PIN_PEPPER';
const PLAINTEXT_STORAGE_ERROR =
  'Standard room PINs must never be written or verified through plaintext roomPassword';

function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return null;
}

function validateRoomPasswordWrites(workerSource: string): string[] {
  const sourceFile = ts.createSourceFile(
    'signaling-worker.ts',
    workerSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const expectedInitializers = new Map<string, number>([
    ["''", 2],
    ['standardRoomPinRollbackLock(verifier)', 2],
    ['standardRoomPinRollbackLock(rollbackVerifier)', 1],
    ['value.roomPassword', 1],
    ['standardRoomPinRollbackLock(roomPasswordVerifier)', 1],
  ]);
  const actualInitializers = new Map<string, number>();
  let hasUnexpectedWrite = false;

  walk(sourceFile, (node) => {
    if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === 'roomPassword') {
      const initializer = node.initializer.getText(sourceFile).replace(/\s+/gu, '');
      actualInitializers.set(initializer, (actualInitializers.get(initializer) ?? 0) + 1);
      if (!expectedInitializers.has(initializer)) hasUnexpectedWrite = true;
      return;
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'roomPassword') {
      hasUnexpectedWrite = true;
      return;
    }
    if (!ts.isBinaryExpression(node)) return;
    const operator = node.operatorToken.kind;
    if (operator < ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment) return;
    const left = node.left;
    const writesRoomPassword =
      (ts.isPropertyAccessExpression(left) && left.name.text === 'roomPassword') ||
      (ts.isElementAccessExpression(left) &&
        left.argumentExpression !== undefined &&
        ts.isStringLiteral(left.argumentExpression) &&
        left.argumentExpression.text === 'roomPassword');
    if (writesRoomPassword) hasUnexpectedWrite = true;
  });

  for (const [initializer, expectedCount] of expectedInitializers) {
    if (actualInitializers.get(initializer) !== expectedCount) hasUnexpectedWrite = true;
  }
  for (const initializer of actualInitializers.keys()) {
    if (!expectedInitializers.has(initializer)) hasUnexpectedWrite = true;
  }
  return hasUnexpectedWrite ? [PLAINTEXT_STORAGE_ERROR] : [];
}

/**
 * Pin the Standard-room password storage boundary to a dedicated secret and a
 * verifier-only v2 record. Its opaque roomPassword compatibility token keeps
 * the legacy reader locked during rollback without retaining the PIN and must
 * never leave Durable Object storage.
 * Runtime tests prove behavior; this deploy-time source guard prevents a later
 * refactor from quietly restoring plaintext writes or reusing another key.
 */
export function validateStandardRoomPinStorageBoundary({
  workerSource,
  signalingConfig,
}: {
  workerSource: string;
  signalingConfig: string;
}): string[] {
  const errors: string[] = [];
  errors.push(...validateRoomPasswordWrites(workerSource));

  for (const marker of [
    `readonly ${PIN_PEPPER_BINDING}?: unknown;`,
    'const STANDARD_ROOM_PIN_PEPPER_MIN_BYTES = 32;',
    "const STANDARD_ROOM_PIN_HMAC_PURPOSE = 'MUSIXQUARE:standard-room-pin:v1';",
    "const STANDARD_ROOM_PIN_ROLLBACK_LOCK_PREFIX = 'mxqr-pin-v2:';",
    "const STANDARD_ROOM_PIN_QUARANTINE_LOCK_PREFIX = 'mxqr-pin-invalid:';",
    'crypto.getRandomValues(random);',
    'const candidate = env.MXQR_STANDARD_ROOM_PIN_PEPPER;',
    'parseRemoteShareUploadAssertionKeyring(',
    'const pinKeys = [keyring.current, ...(keyring.previous ? [keyring.previous] : [])];',
    'remoteShareKeyring?.current.secret',
    'const previousPepper = pinKeyring.previous?.secret;',
    "crypto.subtle.sign('HMAC'",
    '!/^\\d{8}$/.test(password)',
    'roomPasswordVerifier:',
    'roomPassword: standardRoomPinRollbackLock(roomPasswordVerifier),',
    'const rollbackVerifier = standardRoomPinVerifierFromRollbackLock(value.roomPassword);',
    'isLegacyRollbackLockedRoomMeta(stored) ||',
    'isQuarantinedRoomMeta(normalized)',
    'stored === undefined && (this.host !== null || this.guests.size > 0)',
    'const futureMeta = isFutureRoomMeta(stored);',
    'hostReleaseAt: Date.now() + HOST_RECLAIM_GRACE_MS',
    'if (value === undefined) return defaultRoomMeta();',
    'if (!hasValidRoomMetaBase(value)) return invalidCurrentRoomMeta(base);',
    "if (typeof value.roomPassword !== 'string') return invalidCurrentRoomMeta(base);",
    'if (!isExactLegacyRoomMeta(value)) return invalidCurrentRoomMeta(base);',
    "closeWithError(ws, 'room-state-invalid', 'ROOM_STATE_INVALID');",
    "this.failStandardRoomPinMutation(ws, pinMutationId, 'ROOM_STATE_INVALID');",
    'await this.saveRoomMeta(currentRoomMeta(meta, legacyVerifier));',
    'await this.saveRoomMeta(currentRoomMeta(meta, presentedVerifier));',
    'await this.saveRoomMeta(currentRoomMeta(meta, verifier));',
  ]) {
    if (!workerSource.includes(marker)) {
      errors.push(`Standard room PIN storage is missing required boundary marker: ${marker}`);
    }
  }

  if (!signalingConfig.includes(`secret put ${PIN_PEPPER_BINDING}`)) {
    errors.push(`Signaling deploy configuration must name the dedicated ${PIN_PEPPER_BINDING}`);
  }
  if (!workerSource.includes('constantTimeStringEqual(secret, otherSecret)')) {
    errors.push('Standard room PIN pepper reuse must fail closed at runtime');
  }
  if (
    /const candidate\s*=\s*env\.MXQR_STANDARD_ROOM_PIN_PEPPER\s*(?:\|\||\?\?)/u.test(workerSource)
  ) {
    errors.push('Standard room PIN pepper must not fall back to another credential');
  }
  if (/password\s*!==\s*meta\.roomPassword/u.test(workerSource)) {
    errors.push(PLAINTEXT_STORAGE_ERROR);
  }

  return [...new Set(errors)];
}
