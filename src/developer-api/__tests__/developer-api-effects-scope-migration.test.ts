import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  migrationDisposition,
  parseD1Rows,
  runEffectsScopeMigration,
  runEffectsScopeReleaseRollback,
  scopeMaskLimitFromSchema,
} from '../../../scripts/developer-api-effects-scope-migration.mjs';

function schemaResult(limit: number): string {
  return JSON.stringify([
    {
      success: true,
      results: [
        {
          sql: `CREATE TABLE mxqr_developer_api_keys (scope_mask INTEGER CHECK (scope_mask BETWEEN 1 AND ${limit}))`,
        },
      ],
    },
  ]);
}

describe('Developer API effects-scope migration', () => {
  it('recognizes only the legacy and effects-capable scope constraints', () => {
    expect(scopeMaskLimitFromSchema(parseD1Rows(schemaResult(63))[0]?.sql)).toBe(63);
    expect(scopeMaskLimitFromSchema(parseD1Rows(schemaResult(255))[0]?.sql)).toBe(255);
    expect(migrationDisposition(63, 'apply')).toBe('apply');
    expect(migrationDisposition(255, 'apply')).toBe('skip');
    expect(migrationDisposition(255, 'rollback')).toBe('apply');
    expect(migrationDisposition(63, 'rollback')).toBe('skip');
    expect(() => migrationDisposition(127, 'apply')).toThrow('unexpected scope limit 127');
  });

  it('applies once, verifies the new constraint, and skips a repeat', () => {
    let limit = 63;
    const runner = vi.fn((args: string[]) => {
      if (args[0] === '--command') return schemaResult(limit);
      expect(args).toEqual(['--file', 'cloudflare/developer-api.effects-scopes.migration.sql']);
      limit = 255;
      return '';
    });
    const stdout = { write: vi.fn() };

    expect(runEffectsScopeMigration('apply', { runner, outputPath: null, stdout })).toEqual({
      applied: true,
      scopeMaskLimit: 255,
    });
    expect(runEffectsScopeMigration('apply', { runner, outputPath: null, stdout })).toEqual({
      applied: false,
      scopeMaskLimit: 255,
    });
    expect(runner.mock.calls.filter(([args]) => args[0] === '--file')).toHaveLength(1);
  });

  it('orders Worker deployment before migration and schema rollback before Worker rollback', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const deploy = workflow.indexOf('Deploy and record Developer API Worker');
    const migrate = workflow.indexOf('Expand Developer API effects scopes');
    const smoke = workflow.indexOf('Smoke Developer API Worker');
    const rollbackSchema = workflow.indexOf('developer-api:effects-scopes:release-rollback');
    const rollbackWorkers = workflow.indexOf(
      'release-deployment-state.mjs rollback',
      rollbackSchema,
    );

    expect(migrate).toBeGreaterThan(deploy);
    expect(smoke).toBeGreaterThan(migrate);
    expect(rollbackSchema).toBeGreaterThan(smoke);
    expect(rollbackWorkers).toBeGreaterThan(rollbackSchema);
    expect(workflow).toContain('MXQR_EFFECTS_SCOPE_RELEASE_JOURNAL');

    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const scriptName of ['deploy:developer-api-stack', 'deploy:all-workers']) {
      const script = packageJson.scripts[scriptName];
      expect(script.indexOf('cloudflare/wrangler.developer-api.toml')).toBeLessThan(
        script.indexOf('developer-api:effects-scopes:remote'),
      );
    }
  });

  it('uses a pre-migration journal to recover a committed schema after response loss', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mxqr-effects-migration-'));
    const journalPath = join(directory, 'journal.json');
    let limit = 63;
    let loseApplyResponse = true;
    const runner = vi.fn((args: string[]) => {
      if (args[0] === '--command') return schemaResult(limit);
      if (args[1] === 'cloudflare/developer-api.effects-scopes.migration.sql') {
        limit = 255;
        if (loseApplyResponse) {
          loseApplyResponse = false;
          throw new Error('response lost');
        }
      } else if (args[1] === 'cloudflare/developer-api.effects-scopes.rollback.sql') {
        limit = 63;
      } else {
        throw new Error(`unexpected file: ${args[1]}`);
      }
      return '';
    });
    const stdout = { write: vi.fn() };

    try {
      expect(() =>
        runEffectsScopeMigration('apply', {
          runner,
          outputPath: null,
          stdout,
          journalPath,
        }),
      ).toThrow('after D1 committed');
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
        operation: 'apply',
        beforeScopeMaskLimit: 63,
      });
      expect(
        runEffectsScopeReleaseRollback({ runner, outputPath: null, stdout, journalPath }),
      ).toEqual({ applied: true, scopeMaskLimit: 63 });
      expect(limit).toBe(63);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls masks back without silently granting a legacy scope', () => {
    const rollback = readFileSync(
      resolve('cloudflare/developer-api.effects-scopes.rollback.sql'),
      'utf8',
    );

    expect(rollback).toContain('scope_mask BETWEEN 1 AND 63');
    expect(rollback).toContain('(scope_mask & 63) = 0');
    expect(rollback).toContain('scope_mask & 63');
    expect(rollback).toContain('CHECK (ok = 1)');
  });
});
