import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_STAGE2_DEPLOYMENT_ORDER,
  EXPECTED_ACCOUNT_SCHEMA_OBJECTS,
  PRODUCTION_ACCOUNT_CALLBACK,
  buildWranglerReadOnlyCommand,
  extractAccountSchemaObjects,
  parseD1Rows,
  parsePreflightArguments,
  parseSecretNames,
  runAccountStage2Preflight,
  validateAccountD1Binding,
  validateAccountNicknameRows,
  validateAccountSchemaRows,
  validateDeploymentOrder,
  validateProductionCallback,
  validateRequiredSecretNames,
  verifyLocalAssertionRoundTrips,
} from '../../../scripts/account-stage2-preflight.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const accountAuthSource = readFileSync(resolve(repoRoot, 'cloudflare/account-auth.js'), 'utf8');
const accountSchema = readFileSync(resolve(repoRoot, 'cloudflare/auth.schema.sql'), 'utf8');
const validAppConfig = `
[[d1_databases]]
binding = "MUSIXQUARE_AUTH_DB"
database_name = "musixquare-auth"
database_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
`;

function canonicalRemoteRows() {
  return [...extractAccountSchemaObjects(accountSchema).values()].map((item) => ({
    name: item.name,
    type: item.type,
    sql: item.sql.replace(/\bIF\s+NOT\s+EXISTS\b/i, ''),
  }));
}

function secretList(names: string[]): string {
  return JSON.stringify(names.map((name) => ({ name, type: 'secret_text' })));
}

describe('account Stage 2 activation preflight', () => {
  it('uses the Wrangler 4 secret-list JSON format without deprecated flags', () => {
    expect(
      buildWranglerReadOnlyCommand({
        kind: 'secret-list',
        configPath: 'cloudflare/wrangler.app.toml',
      }),
    ).toEqual(['secret', 'list', '--config', 'cloudflare/wrangler.app.toml', '--format', 'json']);
  });

  it('requires the exact production callback in both the operator acknowledgement and code', () => {
    expect(
      validateProductionCallback(PRODUCTION_ACCOUNT_CALLBACK, accountAuthSource, validAppConfig),
    ).toEqual([]);
    expect(
      validateProductionCallback(
        'https://www.musixquare.com/api/auth/google/callback',
        accountAuthSource,
        validAppConfig,
      ),
    ).toContain(`The acknowledged Google callback must be exactly ${PRODUCTION_ACCOUNT_CALLBACK}.`);
    expect(
      validateProductionCallback(
        PRODUCTION_ACCOUNT_CALLBACK,
        accountAuthSource.replace(PRODUCTION_ACCOUNT_CALLBACK, 'https://example.com/callback'),
        validAppConfig,
      ),
    ).toContain('The App account-auth default callback does not match the production callback.');
  });

  it('accepts exactly one real, dedicated account D1 binding', () => {
    expect(validateAccountD1Binding(validAppConfig)).toEqual({
      binding: {
        databaseName: 'musixquare-auth',
        databaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
      errors: [],
    });
    expect(validateAccountD1Binding('')).toMatchObject({
      binding: null,
      errors: ['App config must contain exactly one MUSIXQUARE_AUTH_DB D1 binding.'],
    });
    expect(
      validateAccountD1Binding(
        validAppConfig.replace('musixquare-auth', 'musixquare-admin-metrics'),
      ).errors,
    ).toContain('MUSIXQUARE_AUTH_DB must be a dedicated database, not an existing shared store.');
    expect(
      validateAccountD1Binding(validAppConfig.replace(/aaaaaaaa[^\"]+/, '<database-id>')).errors,
    ).toContain('MUSIXQUARE_AUTH_DB must use a real UUID database_id.');
    expect(
      validateAccountD1Binding(
        `${validAppConfig}\n[[d1_databases]]\nbinding = "OTHER_DB"\ndatabase_name = "other"\ndatabase_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"`,
      ).errors,
    ).toContain('MUSIXQUARE_AUTH_DB database_id must not be reused by another App binding.');
  });

  it('compares every exact account table and explicit index against the canonical schema', () => {
    const rows = canonicalRemoteRows();
    expect([...extractAccountSchemaObjects(accountSchema).keys()].sort()).toEqual(
      EXPECTED_ACCOUNT_SCHEMA_OBJECTS,
    );
    expect(validateAccountSchemaRows(rows, accountSchema)).toEqual([]);
    expect(
      validateAccountSchemaRows(
        rows.map((row, index) =>
          index === 0 ? { ...row, sql: `${row.sql}\n-- documentation-only drift` } : row,
        ),
        accountSchema,
      ),
    ).toEqual([]);

    expect(validateAccountSchemaRows(rows.slice(1), accountSchema)).toContain(
      `Remote account schema is missing ${rows[0].name}.`,
    );
    expect(
      validateAccountSchemaRows(
        rows.map((row, index) =>
          index === 0 ? { ...row, sql: row.sql.replace(/\bNOT NULL\b/i, '') } : row,
        ),
        accountSchema,
      ),
    ).toContain(
      `Remote account schema object ${rows[0].name} differs from cloudflare/auth.schema.sql.`,
    );
    expect(
      validateAccountSchemaRows(
        [
          ...rows,
          { name: 'mxqr_unreviewed', type: 'table', sql: 'CREATE TABLE mxqr_unreviewed (id)' },
        ],
        accountSchema,
      ),
    ).toContain('Remote account database contains unexpected account object mxqr_unreviewed.');
  });

  it('accepts SQLite canonicalization from a real sqlite_master when the runtime provides it', async (context) => {
    let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
      context.skip();
      return;
    }
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(accountSchema);
      const rows = database
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'index') AND (name LIKE 'mxqr_%' OR name LIKE 'idx_mxqr_%') ORDER BY type, name",
        )
        .all();
      expect(validateAccountSchemaRows(rows, accountSchema)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('parses Wrangler JSON without ever needing secret values', () => {
    expect(
      parseD1Rows(JSON.stringify([{ success: true, results: [{ name: 'mxqr_accounts' }] }])),
    ).toEqual([{ name: 'mxqr_accounts' }]);
    expect([...parseSecretNames(secretList(['ONE', 'TWO']))]).toEqual(['ONE', 'TWO']);
    expect([...parseSecretNames(JSON.stringify({ result: [{ name: 'THREE' }] }))]).toEqual([
      'THREE',
    ]);

    const appNames = parseSecretNames(
      secretList([
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'MXQR_AUTH_SESSION_PEPPER',
        'MXQR_AUTH_SUBJECT_PEPPER',
        'MXQR_OAUTH_STATE_SECRET',
        'MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET',
        'MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET',
      ]),
    );
    expect(validateRequiredSecretNames('app', appNames)).toEqual([]);
    appNames.delete('GOOGLE_OAUTH_CLIENT_SECRET');
    expect(validateRequiredSecretNames('app', appNames)).toContain(
      'app is missing required secret GOOGLE_OAUTH_CLIENT_SECRET.',
    );
    appNames.add('MXQR_AUTH_REDIRECT_URI');
    expect(validateRequiredSecretNames('app', appNames)).toContain(
      'App has MXQR_AUTH_REDIRECT_URI as an unreadable secret; remove it so the verified production default is used.',
    );
  });

  it('verifies persisted nickname keys without exposing account data in errors', () => {
    expect(
      validateAccountNicknameRows([
        { account_id: 'acct_one', nickname: 'MUSIXQUARE', nickname_key: 'musixquare' },
        { account_id: 'acct_two', nickname: '민수', nickname_key: '민수' },
      ]),
    ).toEqual([]);
    expect(
      validateAccountNicknameRows([
        { account_id: 'private-one', nickname: 'ＭＸＱＲ', nickname_key: 'ｍｘｑｒ' },
        { account_id: 'private-two', nickname: 'Name', nickname_key: null },
        { account_id: 'private-three', nickname: 'Other', nickname_key: 'other' },
        { account_id: 'private-four', nickname: 'OTHER', nickname_key: 'other' },
      ]),
    ).toEqual([
      '1 account nickname row(s) have a missing key or display value.',
      '1 account nickname row(s) do not match the canonical comparison key.',
      '1 duplicate account nickname key claim(s) were returned.',
    ]);
  });

  it('accepts only the reviewed signaling -> PRO -> App deployment order', () => {
    expect(validateDeploymentOrder(ACCOUNT_STAGE2_DEPLOYMENT_ORDER)).toEqual([]);
    expect(validateDeploymentOrder('signaling,pro-room,app')).toEqual([]);
    expect(validateDeploymentOrder('app,signaling,pro-room')).toEqual([
      'Stage 2 deployment order must be signaling,pro-room,app.',
    ]);
  });

  it('round-trips PRO, Standard attach, and deletion-only assertion codecs locally', async () => {
    await expect(verifyLocalAssertionRoundTrips()).resolves.toEqual([
      'pro-room',
      'standard-room',
      'standard-room-delete',
    ]);
  });

  it('refuses any remote command unless both explicit production gates are present', async () => {
    const runWrangler = vi.fn(() => {
      throw new Error('must not run');
    });
    await expect(
      runAccountStage2Preflight(
        {
          remote: false,
          confirmProduction: true,
          callback: PRODUCTION_ACCOUNT_CALLBACK,
          deploymentOrder: 'signaling,pro-room,app',
        },
        { runWrangler },
      ),
    ).rejects.toThrow('Refusing remote preflight');
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('uses only a read-only D1 schema query and secret-name listings when explicitly run', async () => {
    const files: Record<string, string> = {
      'cloudflare/wrangler.app.toml': validAppConfig,
      'cloudflare/account-auth.js': accountAuthSource,
      'cloudflare/auth.schema.sql': accountSchema,
    };
    const requests: Array<Record<string, unknown>> = [];
    const runWrangler = vi.fn((request: Record<string, unknown>) => {
      requests.push(request);
      if (request.kind === 'd1-schema') {
        return JSON.stringify([{ success: true, results: canonicalRemoteRows() }]);
      }
      if (request.kind === 'd1-nicknames') {
        return JSON.stringify([
          {
            success: true,
            results: [
              { account_id: 'acct_one', nickname: 'MUSIXQUARE', nickname_key: 'musixquare' },
            ],
          },
        ]);
      }
      if (request.service === 'app') {
        return secretList([
          'GOOGLE_OAUTH_CLIENT_ID',
          'GOOGLE_OAUTH_CLIENT_SECRET',
          'MXQR_AUTH_SESSION_PEPPER',
          'MXQR_AUTH_SUBJECT_PEPPER',
          'MXQR_OAUTH_STATE_SECRET',
          'MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET',
          'MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET',
        ]);
      }
      if (request.service === 'signaling') {
        return secretList(['MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET']);
      }
      return secretList(['MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET']);
    });

    await expect(
      runAccountStage2Preflight(
        {
          remote: true,
          confirmProduction: true,
          callback: PRODUCTION_ACCOUNT_CALLBACK,
          deploymentOrder: 'signaling,pro-room,app',
        },
        {
          readText: async (path) => files[path],
          runWrangler,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      callback: PRODUCTION_ACCOUNT_CALLBACK,
      deploymentOrder: ['signaling', 'pro-room', 'app'],
    });
    expect(requests.map((request) => request.kind)).toEqual([
      'd1-schema',
      'd1-nicknames',
      'secret-list',
      'secret-list',
      'secret-list',
    ]);
    expect(String(requests[0].query)).toMatch(/^SELECT\b/);
    expect(String(requests[0].query)).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i,
    );
    expect(String(requests[1].query)).toMatch(/^SELECT\b/);
  });

  it('parses the deliberately verbose manual invocation without implicit defaults', () => {
    expect(
      parsePreflightArguments([
        '--remote',
        '--confirm-production',
        '--callback',
        PRODUCTION_ACCOUNT_CALLBACK,
        '--ack-deploy-order',
        'signaling,pro-room,app',
      ]),
    ).toEqual({
      remote: true,
      confirmProduction: true,
      callback: PRODUCTION_ACCOUNT_CALLBACK,
      deploymentOrder: 'signaling,pro-room,app',
    });
  });
});
