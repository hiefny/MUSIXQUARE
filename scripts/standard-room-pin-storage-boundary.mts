import ts from 'typescript';

const PIN_PEPPER_BINDING = 'MXQR_STANDARD_ROOM_PIN_PEPPER';
const PLAINTEXT_STORAGE_ERROR =
  'Standard room PINs must never be written or verified through plaintext roomPassword';
const PIN_RECORD_STORAGE_ERROR =
  'Standard room PIN membership and wrong-PIN records must be written only through their normalizers and never carry PIN material';
const PIN_RECORD_NORMALIZERS = new Map<string, string>([
  ['STANDARD_ROOM_PIN_MEMBERSHIP_KEY', 'normalizeStandardRoomPinMembership'],
  ['STANDARD_ROOM_PIN_FAILURES_KEY', 'normalizeStandardRoomPinFailures'],
]);
const PIN_RECORD_STORAGE_KEYS = [
  'standard-room-pin-membership-v1',
  'standard-room-pin-failures-v1',
];

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
 * The kept-set and wrong-PIN records live under their own keys so an older
 * Worker never reads them. Every write must pass the exact-key normalizer of
 * its record, whose shapes hold only digests, peer IDs and counters, and no
 * argument may reach for PIN material.
 */
function validatePinRecordWrites(workerSource: string): string[] {
  const sourceFile = ts.createSourceFile(
    'signaling-worker.ts',
    workerSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const writes = new Map<string, number>();
  let unsafe = PIN_RECORD_STORAGE_KEYS.some((key) => workerSource.includes(key));
  walk(sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'put'
    ) {
      return;
    }
    const [keyArgument, valueArgument] = node.arguments;
    if (!keyArgument) return;
    const normalizer = PIN_RECORD_NORMALIZERS.get(keyArgument.getText(sourceFile));
    if (!normalizer) return;
    writes.set(normalizer, (writes.get(normalizer) ?? 0) + 1);
    if (
      !valueArgument ||
      !ts.isCallExpression(valueArgument) ||
      !ts.isIdentifier(valueArgument.expression) ||
      valueArgument.expression.text !== normalizer ||
      /password|pepper/iu.test(valueArgument.getText(sourceFile))
    ) {
      unsafe = true;
    }
  });
  for (const normalizer of PIN_RECORD_NORMALIZERS.values()) {
    if (!writes.get(normalizer)) unsafe = true;
  }
  return unsafe ? [PIN_RECORD_STORAGE_ERROR] : [];
}

/**
 * The record helpers must keep their exact-key shapes. Only the wire
 * validator may read the frame's `password` field; no other code in the
 * module may touch PIN material.
 */
function validatePinRecordShapes(membershipSource: string): string[] {
  const errors: string[] = [];
  for (const marker of [
    "export const STANDARD_ROOM_PIN_MEMBERSHIP_KEY = 'standard-room-pin-membership-v1';",
    "export const STANDARD_ROOM_PIN_FAILURES_KEY = 'standard-room-pin-failures-v1';",
    "!hasExactKeys(value, ['v', 'roomSecretHash', 'verifierDigest', 'kept'])",
    "!hasExactKeys(entry, ['peerId', 'secretHash'])",
    "!hasExactKeys(value, ['v', 'entries'])",
    "!hasExactKeys(entry, ['key', 'count', 'resetAt'])",
    "const ATTEMPT_KEY_PURPOSE = 'MUSIXQUARE:standard-room-pin-attempt:v1';",
  ]) {
    if (!membershipSource.includes(marker)) {
      errors.push(
        `Standard room PIN record storage is missing required boundary marker: ${marker}`,
      );
    }
  }
  const sourceFile = ts.createSourceFile(
    'standard-room-pin-membership.ts',
    membershipSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let touchesPinMaterial = false;
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'validateStandardRoomPasswordSetFrame'
    ) {
      continue;
    }
    walk(statement, (node) => {
      if (ts.isIdentifier(node) && /password/iu.test(node.text)) touchesPinMaterial = true;
      if (ts.isStringLiteralLike(node) && /password/iu.test(node.text)) touchesPinMaterial = true;
    });
  }
  if (touchesPinMaterial) errors.push(PIN_RECORD_STORAGE_ERROR);
  return errors;
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
  membershipSource,
}: {
  workerSource: string;
  signalingConfig: string;
  membershipSource?: string;
}): string[] {
  const errors: string[] = [];
  errors.push(...validateRoomPasswordWrites(workerSource));
  errors.push(...validatePinRecordWrites(workerSource));
  if (membershipSource !== undefined) errors.push(...validatePinRecordShapes(membershipSource));

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
