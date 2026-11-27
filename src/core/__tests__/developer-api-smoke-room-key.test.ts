import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkDeveloperMutationCredential,
  developerMutationScopes,
} from '../../../cloudflare/developer-api-credential.ts';
import { expireDeveloperApiKeys } from '../../../cloudflare/developer-api-worker.ts';

// cloudflare/app-worker.ts is the home of the Developer API smoke room and of
// No expiry, the one lifetime past 365 days that admin key issuance accepts,
// in that room only. The copies below cannot import it: the release workflow's
// smoke step, the smoke script's default room and the admin classic runtime
// script. This suite pins each copy to the home and shows that a No expiry key
// passes the existing expiry checks unchanged: the Developer API schema, its
// expiry sweep and the mutation credential check. The Developer API Worker's
// own key read is in developer-api-worker.test.ts.

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return null;
  }
})();

function read(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
}

/** The value text of the one top-level single-line `const NAME = value;` in a source. */
function constantText(source: string, name: string): string {
  const matches = [...source.matchAll(new RegExp(`^const ${name}(?:: [^=]+)? = (.+);$`, 'gmu'))];
  expect(matches, name).toHaveLength(1);
  return matches[0]?.[1] ?? '';
}

function numberConstant(source: string, name: string): number {
  const value = Number(constantText(source, name).replaceAll('_', ''));
  expect(Number.isSafeInteger(value), name).toBe(true);
  return value;
}

function roomCodeConstant(source: string, name: string): string {
  const match = /^'(0\d{5})'$/u.exec(constantText(source, name));
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
}

const WORKER = read('cloudflare/app-worker.ts');
const SMOKE_ROOM = roomCodeConstant(WORKER, 'ADMIN_DEVELOPER_API_SMOKE_ROOM_CODE');
const NO_EXPIRY_DAYS = numberConstant(WORKER, 'ADMIN_DEVELOPER_API_KEY_NO_EXPIRY_DAYS');
const MAX_DAYS = numberConstant(WORKER, 'ADMIN_DEVELOPER_API_KEY_MAX_DAYS');
const DAY_MS = numberConstant(WORKER, 'ADMIN_DEVELOPER_API_DAY_MS');
const ISSUED_AT = Date.parse('2026-11-27T00:00:00.000Z');
// A year and a day later, when a key of the longest ordinary lifetime has expired.
const AFTER_LONGEST_ORDINARY = ISSUED_AT + (MAX_DAYS + 1) * DAY_MS;
const SMOKE_KEY_ID = 'SmokeKeyId000001';

type SqliteValue = string | number | null;

/** A D1 binding over node:sqlite with the statement methods the Developer API reads. */
function d1(db: DatabaseSync) {
  const statement = (sql: string, values: readonly SqliteValue[]) => ({
    bind: (...next: SqliteValue[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    run: async () => db.prepare(sql).run(...values),
  });
  return { prepare: (sql: string) => statement(sql, []) };
}

afterEach(() => vi.useRealTimers());

describe('Developer API smoke room No expiry key', () => {
  it('pins the admin client copies to the App Worker', () => {
    const admin = read('browser/classic-runtime/admin.ts');
    expect(roomCodeConstant(admin, 'DEVELOPER_API_SMOKE_ROOM_CODE')).toBe(SMOKE_ROOM);
    expect(numberConstant(admin, 'DEVELOPER_API_KEY_NO_EXPIRY_DAYS')).toBe(NO_EXPIRY_DAYS);
    expect(numberConstant(admin, 'DEVELOPER_API_DAY_MS')).toBe(DAY_MS);
  });

  it('is the room that the release workflow smoke authenticates to', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(
      [...workflow.matchAll(/^ +MXQR_DEVELOPER_API_SMOKE_ROOM: '(\d{6})'$/gmu)].map(
        (match) => match[1],
      ),
    ).toEqual([SMOKE_ROOM]);
    const smoke = read('scripts/live-developer-api-smoke.mts');
    expect(smoke).toContain(`\n  roomCode = '${SMOKE_ROOM}',\n`);
    expect(smoke).toContain(`env.MXQR_DEVELOPER_API_SMOKE_ROOM?.trim() || '${SMOKE_ROOM}',`);
  });

  it('lasts 100 years, past every ordinary lifetime, with a safe integer expiry', () => {
    expect(NO_EXPIRY_DAYS).toBe(100 * 365.25);
    expect(NO_EXPIRY_DAYS).toBeGreaterThan(MAX_DAYS);
    const expiresAt = ISSUED_AT + NO_EXPIRY_DAYS * DAY_MS;
    expect(Number.isSafeInteger(expiresAt)).toBe(true);
    expect(new Date(expiresAt).toISOString()).toBe('2126-11-28T00:00:00.000Z');
  });

  (sqlite ? it : it.skip)(
    'passes the Developer API schema and outlives the expiry sweep that ends a 365-day key',
    async () => {
      if (!sqlite) throw new Error('node:sqlite is unavailable');
      const db = new sqlite.DatabaseSync(':memory:');
      try {
        db.exec(read('cloudflare/developer-api.schema.sql'));
        const insert = db.prepare(
          `INSERT INTO mxqr_developer_api_keys
             (key_id, room_code, room_generation, authority_epoch, label, secret_digest,
              digest_version, scope_mask, status, created_at, updated_at, expires_at,
              revoked_at, last_used_hour)
           VALUES (?, ?, 0, 0, ?, ?, 1, 255, 'active', ?, ?, ?, NULL, NULL)`,
        );
        for (const [keyId, label, digest, days] of [
          [SMOKE_KEY_ID, 'Release smoke', 'a'.repeat(43), NO_EXPIRY_DAYS],
          ['YearKeyId0000001', 'Yearly bot', 'b'.repeat(43), MAX_DAYS],
        ] as const) {
          insert.run(
            keyId,
            SMOKE_ROOM,
            label,
            digest,
            ISSUED_AT,
            ISSUED_AT,
            ISSUED_AT + days * DAY_MS,
          );
        }

        await expireDeveloperApiKeys({ DEVELOPER_API_DB: d1(db) }, AFTER_LONGEST_ORDINARY);

        expect(
          db.prepare('SELECT key_id, status FROM mxqr_developer_api_keys ORDER BY key_id').all(),
        ).toEqual([
          { key_id: SMOKE_KEY_ID, status: 'active' },
          { key_id: 'YearKeyId0000001', status: 'revoked' },
        ]);
        expect(
          db.prepare('SELECT key_id, action FROM mxqr_developer_api_admin_audit').all(),
        ).toEqual([{ key_id: 'YearKeyId0000001', action: 'key.expire' }]);
      } finally {
        db.close();
      }
    },
  );

  it('passes the mutation credential check a year and a day after issuance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_LONGEST_ORDINARY);
    const row = {
      key_id: SMOKE_KEY_ID,
      room_code: SMOKE_ROOM,
      room_generation: 0,
      authority_epoch: 0,
      status: 'active',
      revoked_at: null,
      expires_at: ISSUED_AT + NO_EXPIRY_DAYS * DAY_MS,
      scope_mask: 255,
    };
    const database = { prepare: () => ({ bind: () => ({ first: async () => row }) }) };
    await expect(
      checkDeveloperMutationCredential(
        database,
        SMOKE_KEY_ID,
        SMOKE_ROOM,
        0,
        0,
        developerMutationScopes.media,
      ),
    ).resolves.toBeNull();
  });
});
