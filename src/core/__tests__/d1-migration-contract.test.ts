import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertD1MigrationManifestAppendOnly,
  assertD1MigrationContract,
  assertD1MigrationRepositoryHistory,
  loadD1MigrationManifest,
  trackedD1PathsForDatabase,
} from '../../../scripts/check-d1-migration-contract.mjs';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recovery(strategy = 'roll-forward-or-provider-restore') {
  return {
    strategy,
    runbook: 'docs/recovery.md',
    note: 'This test recovery contract is deliberately explicit and sufficiently descriptive.',
  };
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

describe('D1 migration contract', () => {
  it('accounts for every checked-in D1 baseline, forward migration, and rollback', () => {
    expect(assertD1MigrationContract()).toEqual({
      schemaVersion: 1,
      databaseCount: 3,
      migrationCount: 8,
      pairedMigrationCount: 1,
      forwardOnlyMigrationCount: 7,
    });
  });

  it('derives Developer API release tracking from the manifest', () => {
    const manifest = loadD1MigrationManifest();
    expect(trackedD1PathsForDatabase(manifest, 'musixquare-developer-api')).toEqual([
      'cloudflare/developer-api.schema.sql',
      'cloudflare/developer-api.effects-scopes.migration.sql',
      'cloudflare/developer-api.effects-scopes.rollback.sql',
      'cloudflare/developer-api-room-generation.migration.sql',
      'cloudflare/developer-api.launch-cleanup.migration.sql',
    ]);
  });

  it('fails closed when a discovered forward migration is not registered', () => {
    const root = mkdtempSync(join(tmpdir(), 'mxqr-d1-contract-'));
    try {
      mkdirSync(join(root, 'cloudflare'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(
        join(root, 'cloudflare', 'sample.schema.sql'),
        'CREATE TABLE sample (id TEXT);\n',
      );
      writeFileSync(
        join(root, 'cloudflare', 'sample.migration.sql'),
        'ALTER TABLE sample ADD value TEXT;\n',
      );
      writeFileSync(join(root, 'docs', 'recovery.md'), '# Recovery\n');
      const manifest = {
        schemaVersion: 1,
        databases: [
          {
            database: 'sample-db',
            baseline: 'cloudflare/sample.schema.sql',
            baselineRevision: 1,
            baselineSha256: sha256('CREATE TABLE sample (id TEXT);\n'),
            baselineMigration: null,
            baselineRecovery: recovery(),
            migrations: [],
          },
        ],
      };

      expect(() => assertD1MigrationContract({ root, manifest })).toThrow(
        'unregistered: cloudflare/sample.migration.sql',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers SQL contracts recursively instead of overlooking nested migrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'mxqr-d1-contract-'));
    try {
      mkdirSync(join(root, 'cloudflare', 'migrations'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      const baseline = 'CREATE TABLE sample (id TEXT);\n';
      const forward = 'ALTER TABLE sample ADD value TEXT;\n';
      writeFileSync(join(root, 'cloudflare', 'sample.schema.sql'), baseline);
      writeFileSync(join(root, 'cloudflare', 'migrations', 'sample.migration.sql'), forward);
      writeFileSync(join(root, 'docs', 'recovery.md'), '# Recovery\n');
      const manifest = {
        schemaVersion: 1,
        databases: [
          {
            database: 'sample-db',
            baseline: 'cloudflare/sample.schema.sql',
            baselineRevision: 1,
            baselineSha256: sha256(baseline),
            baselineMigration: null,
            baselineRecovery: recovery(),
            migrations: [],
          },
        ],
      };

      expect(() => assertD1MigrationContract({ root, manifest })).toThrow(
        'unregistered: cloudflare/migrations/sample.migration.sql',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds baseline and migration contracts to their checked-in SQL bytes', () => {
    const manifest = clone(loadD1MigrationManifest());
    manifest.databases[0].baselineSha256 = '0'.repeat(64);
    expect(() => assertD1MigrationContract({ manifest })).toThrow(
      'baselineSha256 does not match the checked-in file',
    );

    const migrationManifest = clone(loadD1MigrationManifest());
    migrationManifest.databases[1].migrations[0].forwardSha256 = '0'.repeat(64);
    expect(() => assertD1MigrationContract({ manifest: migrationManifest })).toThrow(
      'forwardSha256 does not match the checked-in file',
    );
  });

  it('keeps existing migrations immutable and links baseline revisions to new migrations', () => {
    const current = clone(loadD1MigrationManifest());
    const previous = clone(current);
    const auth = previous.databases.find(
      (database: { database: string }) => database.database === 'musixquare-auth',
    );
    if (!auth) throw new Error('Expected the auth database contract');
    auth.baselineRevision = current.databases[1].baselineRevision - 1;
    auth.baselineSha256 = '0'.repeat(64);
    auth.baselineMigration = current.databases[1].migrations.at(-2)?.id ?? null;
    auth.migrations = current.databases[1].migrations.slice(0, -1);
    expect(
      assertD1MigrationManifestAppendOnly({ previousManifest: previous, currentManifest: current }),
    ).toEqual({ previousDatabaseCount: 3 });

    const rewritten = clone(current);
    rewritten.databases[1].migrations[0].forwardSha256 = '1'.repeat(64);
    expect(() =>
      assertD1MigrationManifestAppendOnly({
        previousManifest: current,
        currentManifest: rewritten,
      }),
    ).toThrow('migration history is append-only');

    const reused = clone(current);
    reused.databases[1].baselineRevision += 1;
    reused.databases[1].baselineSha256 = '2'.repeat(64);
    expect(() =>
      assertD1MigrationManifestAppendOnly({
        previousManifest: current,
        currentManifest: reused,
      }),
    ).toThrow('must reference a newly appended migration');
  });

  it('verifies every visible repository manifest revision before the working tree', () => {
    const current = clone(loadD1MigrationManifest());
    const first = clone(current);
    const firstDeveloper = first.databases.find(
      (database: { database: string }) => database.database === 'musixquare-developer-api',
    );
    if (!firstDeveloper) throw new Error('Expected the Developer API database contract');
    firstDeveloper.baselineRevision = current.databases[2].baselineRevision - 1;
    firstDeveloper.baselineSha256 = '0'.repeat(64);
    firstDeveloper.baselineMigration = current.databases[2].migrations.at(-2)?.id ?? null;
    firstDeveloper.migrations = current.databases[2].migrations.slice(0, -1);
    const firstCommit = '1'.repeat(40);
    const secondCommit = '2'.repeat(40);
    const runner = (command: string, args: string[]) => {
      expect(command).toBe('git');
      if (args[0] === 'log') return `${firstCommit}\n${secondCommit}\n`;
      if (args[0] === 'show' && args[1].startsWith(firstCommit)) return JSON.stringify(first);
      if (args[0] === 'show' && args[1].startsWith(secondCommit)) return JSON.stringify(current);
      throw new Error(`Unexpected git operation: ${args.join(' ')}`);
    };

    expect(assertD1MigrationRepositoryHistory({ currentManifest: current, runner })).toEqual({
      visibleRevisionCount: 2,
    });
  });

  it('fails closed for malformed or rewritten historical manifests', () => {
    const current = clone(loadD1MigrationManifest());
    const commit = '1'.repeat(40);
    const malformedRunner = (_command: string, args: string[]) => {
      if (args[0] === 'log') return `${commit}\n`;
      if (args[0] === 'show') return '{invalid';
      throw new Error(`Unexpected git operation: ${args.join(' ')}`);
    };
    expect(() =>
      assertD1MigrationRepositoryHistory({ currentManifest: current, runner: malformedRunner }),
    ).toThrow('contains an invalid D1 migration manifest');

    const rewritten = clone(current);
    rewritten.databases[1].migrations[0].forwardSha256 = '0'.repeat(64);
    const secondCommit = '2'.repeat(40);
    const rewrittenRunner = (_command: string, args: string[]) => {
      if (args[0] === 'log') return `${commit}\n${secondCommit}\n`;
      if (args[0] === 'show' && args[1].startsWith(commit)) return JSON.stringify(current);
      if (args[0] === 'show' && args[1].startsWith(secondCommit)) {
        return JSON.stringify(rewritten);
      }
      throw new Error(`Unexpected git operation: ${args.join(' ')}`);
    };
    expect(() =>
      assertD1MigrationRepositoryHistory({
        currentManifest: rewritten,
        runner: rewrittenRunner,
      }),
    ).toThrow('migration history is append-only');
  });

  it('requires an exact rollback pair or an explicit forward-only recovery boundary', () => {
    const manifest = clone(loadD1MigrationManifest());
    const developer = manifest.databases.find(
      (database: { database: string }) => database.database === 'musixquare-developer-api',
    );
    if (!developer) throw new Error('Expected the Developer API database contract');
    developer.migrations[0].rollback = null;
    expect(() => assertD1MigrationContract({ manifest })).toThrow(
      'developer-api-effects-scopes-v1.rollback must be a repository-relative .rollback.sql path',
    );

    const forwardOnly = clone(loadD1MigrationManifest());
    const auth = forwardOnly.databases.find(
      (database: { database: string }) => database.database === 'musixquare-auth',
    );
    if (!auth) throw new Error('Expected the auth database contract');
    auth.migrations[0].rollback = 'cloudflare/developer-api.effects-scopes.rollback.sql';
    expect(() => assertD1MigrationContract({ manifest: forwardOnly })).toThrow(
      'forward-only migration must use rollback: null',
    );
  });
});
