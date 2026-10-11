import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateStandardRoomPinStorageBoundary } from '../../../scripts/standard-room-pin-storage-boundary.mts';

const workerSource = readFileSync(resolve('cloudflare/signaling-worker.ts'), 'utf8');
const signalingConfig = readFileSync(resolve('cloudflare/wrangler.signaling.toml'), 'utf8');
const membershipSource = readFileSync(
  resolve('cloudflare/standard-room-pin-membership.ts'),
  'utf8',
);
const PIN_RECORD_STORAGE_ERROR =
  'Standard room PIN membership and wrong-PIN records must be written only through their normalizers and never carry PIN material';

function validate(
  source = workerSource,
  config = signalingConfig,
  membership: string | undefined = membershipSource,
): ReturnType<typeof validateStandardRoomPinStorageBoundary> {
  return validateStandardRoomPinStorageBoundary({
    workerSource: source,
    signalingConfig: config,
    ...(membership === undefined ? {} : { membershipSource: membership }),
  });
}

describe('Standard room PIN storage boundary', () => {
  it('accepts the production hash-only worker and dedicated deploy contract', () => {
    expect(validate()).toEqual([]);
  });

  it('rejects removal or fallback reuse of the dedicated pepper binding', () => {
    expect(
      validate(workerSource.replace('readonly MXQR_STANDARD_ROOM_PIN_PEPPER?: unknown;', '')),
    ).toContain(
      'Standard room PIN storage is missing required boundary marker: readonly MXQR_STANDARD_ROOM_PIN_PEPPER?: unknown;',
    );
    expect(
      validate(
        workerSource.replace(
          'const candidate = env.MXQR_STANDARD_ROOM_PIN_PEPPER;',
          'const candidate = env.MXQR_STANDARD_ROOM_PIN_PEPPER || env.MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET;',
        ),
      ),
    ).toContain('Standard room PIN pepper must not fall back to another credential');
  });

  it('rejects plaintext PIN persistence and verification regressions', () => {
    expect(validate(`${workerSource}\nconst unsafe = { roomPassword: password };`)).toContain(
      'Standard room PINs must never be written or verified through plaintext roomPassword',
    );
    expect(validate(`${workerSource}\nconst unsafe = password !== meta.roomPassword;`)).toContain(
      'Standard room PINs must never be written or verified through plaintext roomPassword',
    );
    expect(
      validate(
        `${workerSource}\nconst persistedPin = password; const unsafeAlias = { roomPassword: persistedPin };`,
      ),
    ).toContain(
      'Standard room PINs must never be written or verified through plaintext roomPassword',
    );
  });

  it('requires the legacy rollback reader to remain locked by verifier material', () => {
    expect(
      validate(
        workerSource.replace("const STANDARD_ROOM_PIN_ROLLBACK_LOCK_PREFIX = 'mxqr-pin-v2:';", ''),
      ),
    ).toContain(
      "Standard room PIN storage is missing required boundary marker: const STANDARD_ROOM_PIN_ROLLBACK_LOCK_PREFIX = 'mxqr-pin-v2:';",
    );
    expect(
      validate(
        workerSource.replace(
          'roomPassword: standardRoomPinRollbackLock(roomPasswordVerifier),',
          "roomPassword: '',",
        ),
      ),
    ).toContain(
      'Standard room PIN storage is missing required boundary marker: roomPassword: standardRoomPinRollbackLock(roomPasswordVerifier),',
    );
    expect(
      validate(
        workerSource.replace(
          'const rollbackVerifier = standardRoomPinVerifierFromRollbackLock(value.roomPassword);',
          'const rollbackVerifier = null;',
        ),
      ),
    ).toContain(
      'Standard room PIN storage is missing required boundary marker: const rollbackVerifier = standardRoomPinVerifierFromRollbackLock(value.roomPassword);',
    );
    expect(
      validate(workerSource.replace('isLegacyRollbackLockedRoomMeta(stored) ||', 'false')),
    ).toContain(
      'Standard room PIN storage is missing required boundary marker: isLegacyRollbackLockedRoomMeta(stored) ||',
    );
  });

  it('requires malformed legacy storage and keyring secret reuse to fail closed', () => {
    expect(
      validate(workerSource.replace('if (value === undefined) return defaultRoomMeta();', '')),
    ).toContain(
      'Standard room PIN storage is missing required boundary marker: if (value === undefined) return defaultRoomMeta();',
    );
    expect(
      validate(workerSource.replace('remoteShareKeyring?.current.secret', 'undefined')),
    ).toContain(
      'Standard room PIN storage is missing required boundary marker: remoteShareKeyring?.current.secret',
    );
    expect(
      validate(
        workerSource.replace(
          'if (!isExactLegacyRoomMeta(value)) return invalidCurrentRoomMeta(base);',
          '',
        ),
      ),
    ).toContain(
      'Standard room PIN storage is missing required boundary marker: if (!isExactLegacyRoomMeta(value)) return invalidCurrentRoomMeta(base);',
    );
  });

  it('writes the kept-set and wrong-PIN records only through their normalizers', () => {
    expect(validate(workerSource, signalingConfig, undefined)).toEqual([]);
    const bypassed = workerSource.replace(
      /normalizeStandardRoomPinMembership\(rekeyed\),\s*\);/u,
      'rekeyed);',
    );
    expect(bypassed).not.toBe(workerSource);
    expect(validate(bypassed)).toContain(PIN_RECORD_STORAGE_ERROR);
    expect(
      validate(
        `${workerSource}
void storage.put(STANDARD_ROOM_PIN_FAILURES_KEY, normalizeStandardRoomPinFailures({ password }));`,
      ),
    ).toContain(PIN_RECORD_STORAGE_ERROR);
    expect(
      validate(
        `${workerSource}
void storage.put(STANDARD_ROOM_PIN_MEMBERSHIP_KEY, normalizeStandardRoomPinFailures(record));`,
      ),
    ).toContain(PIN_RECORD_STORAGE_ERROR);
    expect(
      validate(`${workerSource}
const key = 'standard-room-pin-failures-v1';`),
    ).toContain(PIN_RECORD_STORAGE_ERROR);
    expect(
      validate(workerSource.replaceAll('STANDARD_ROOM_PIN_FAILURES_KEY,', 'OTHER_KEY,')),
    ).toContain(PIN_RECORD_STORAGE_ERROR);
  });

  it('keeps the record shapes exact and free of PIN material', () => {
    expect(
      validate(
        workerSource,
        signalingConfig,
        membershipSource.replace(
          "!hasExactKeys(entry, ['key', 'count', 'resetAt'])",
          '!isRecord(entry)',
        ),
      ),
    ).toContain(
      "Standard room PIN record storage is missing required boundary marker: !hasExactKeys(entry, ['key', 'count', 'resetAt'])",
    );
    expect(
      validate(
        workerSource,
        signalingConfig,
        `${membershipSource}
export function keepPassword(password: string) { return { password }; }`,
      ),
    ).toContain(PIN_RECORD_STORAGE_ERROR);
  });

  it('requires the dedicated secret in signaling deploy configuration', () => {
    expect(
      validate(
        workerSource,
        signalingConfig.replace(/.*MXQR_STANDARD_ROOM_PIN_PEPPER.*\r?\n/u, ''),
      ),
    ).toContain(
      'Signaling deploy configuration must name the dedicated MXQR_STANDARD_ROOM_PIN_PEPPER',
    );
  });
});
