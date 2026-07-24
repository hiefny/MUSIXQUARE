import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  developerApiKeySchemaStateFromSql,
  migrationDisposition,
  parseD1Rows,
  runEffectsScopeMigration,
  runEffectsScopeReleaseRollback,
  scopeMaskLimitFromSchema,
} from '../../../scripts/developer-api-effects-scope-migration.mjs';
import { emergencyDeploymentPlan } from '../../../scripts/emergency-deploy.mjs';

function schemaResult(limit: number, hasRoomGeneration = false): string {
  return JSON.stringify([
    {
      success: true,
      results: [
        {
          sql: `CREATE TABLE mxqr_developer_api_keys (${hasRoomGeneration ? 'room_generation INTEGER NOT NULL, ' : ''}scope_mask INTEGER CHECK (scope_mask BETWEEN 1 AND ${limit}))`,
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
    expect(developerApiKeySchemaStateFromSql(parseD1Rows(schemaResult(255, true))[0]?.sql)).toEqual(
      { scopeMaskLimit: 255, hasRoomGeneration: true },
    );
  });

  it('never lets the legacy table rebuild erase generation binding', () => {
    const applyRunner = vi.fn((args: string[]) => {
      if (args[0] === '--command') return schemaResult(63, true);
      throw new Error(`unexpected mutation: ${args.join(' ')}`);
    });
    const stdout = { write: vi.fn() };

    expect(() =>
      runEffectsScopeMigration('apply', {
        runner: applyRunner,
        outputPath: null,
        stdout,
      }),
    ).toThrow('does not preserve room_generation');
    expect(applyRunner.mock.calls.filter(([args]) => args[0] === '--file')).toHaveLength(0);

    const alreadyAppliedRunner = vi.fn((args: string[]) => {
      if (args[0] === '--command') return schemaResult(255, true);
      throw new Error(`unexpected mutation: ${args.join(' ')}`);
    });
    expect(
      runEffectsScopeMigration('apply', {
        runner: alreadyAppliedRunner,
        outputPath: null,
        stdout,
      }),
    ).toEqual({ applied: false, scopeMaskLimit: 255 });
    expect(alreadyAppliedRunner.mock.calls.filter(([args]) => args[0] === '--file')).toHaveLength(
      0,
    );
  });

  it('fails release rollback closed instead of dropping room_generation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mxqr-effects-generation-'));
    const journalPath = join(directory, 'journal.json');
    const runner = vi.fn((args: string[]) => {
      if (args[0] === '--command') return schemaResult(255, true);
      throw new Error(`unexpected mutation: ${args.join(' ')}`);
    });
    const stdout = { write: vi.fn() };

    try {
      writeFileSync(
        journalPath,
        `${JSON.stringify({
          version: 1,
          operation: 'apply',
          beforeScopeMaskLimit: 63,
        })}\n`,
        'utf8',
      );
      expect(() =>
        runEffectsScopeReleaseRollback({
          runner,
          outputPath: null,
          stdout,
          journalPath,
        }),
      ).toThrow('does not preserve room_generation');
      expect(runner.mock.calls.filter(([args]) => args[0] === '--file')).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    const baseSchema = workflow.indexOf('Apply Developer API base schema');
    const deploy = workflow.indexOf('Deploy and record Developer API Worker');
    const migrate = workflow.indexOf('Expand Developer API effects scopes');
    const smoke = workflow.indexOf('Smoke Developer API Worker');
    const rollbackSchema = workflow.indexOf('developer-api:effects-scopes:release-rollback');
    const rollbackWorkers = workflow.indexOf(
      'release-deployment-state.mjs rollback',
      rollbackSchema,
    );

    expect(baseSchema).toBeGreaterThan(-1);
    expect(baseSchema).toBeLessThan(deploy);
    expect(migrate).toBeGreaterThan(deploy);
    expect(smoke).toBeGreaterThan(migrate);
    expect(rollbackSchema).toBeGreaterThan(smoke);
    expect(rollbackWorkers).toBeGreaterThan(rollbackSchema);
    expect(workflow).toContain('MXQR_EFFECTS_SCOPE_RELEASE_JOURNAL');
    expect(workflow).toContain('apply_developer_api_d1:');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}');
    expect(workflow).toContain(
      'UPDATE mxqr_developer_api_keys SET updated_at = updated_at WHERE 0',
    );

    const schemaRollbackStart = workflow.indexOf(
      'Restore Developer API schema after a failed release',
    );
    const workerRollbackStart = workflow.indexOf(
      'Restore Worker deployments after a failed release',
    );
    const uploadStart = workflow.indexOf('Upload deployment records');
    const schemaRollbackBlock = workflow.slice(schemaRollbackStart, workerRollbackStart);
    const workerRollbackBlock = workflow.slice(workerRollbackStart, uploadStart);
    expect(schemaRollbackStart).toBeGreaterThan(smoke);
    expect(workerRollbackStart).toBeGreaterThan(schemaRollbackStart);
    expect(schemaRollbackBlock).toContain(
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}',
    );
    expect(schemaRollbackBlock).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workerRollbackBlock).toContain(
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    );
    expect(workerRollbackBlock).not.toContain('secrets.CLOUDFLARE_D1_API_TOKEN');
    expect(workerRollbackBlock).toContain('rollback_skip_targets="developer-api"');
    expect(workerRollbackBlock).toContain('MXQR_ROLLBACK_SKIP_TARGETS="$rollback_skip_targets"');

    const recoveryFailureGate = workflow.indexOf(
      'Fail release when automatic recovery is incomplete',
    );
    expect(recoveryFailureGate).toBeGreaterThan(workflow.indexOf('Release summary'));
    expect(workflow).toContain("steps.schema_rollback.outcome == 'failure'");
    expect(workflow).toContain("steps.worker_rollback.outcome == 'failure'");
    expect(workflow).toContain("steps.schema_rollback.outcome || 'not-requested'");
    expect(workflow).toContain("steps.worker_rollback.outcome || 'not-requested'");

    const credentialProbe = workflow.indexOf('Verify Developer API D1 migration credentials');
    const firstDeploymentRecord = workflow.indexOf('Record current remote-share deployment');
    expect(credentialProbe).toBeGreaterThan(-1);
    expect(credentialProbe).toBeLessThan(firstDeploymentRecord);

    const deployBlock = workflow.slice(deploy, migrate);
    expect(deployBlock).not.toContain('developer-api:schema:remote');
    expect(workflow.match(/developer-api:schema:remote/g)).toHaveLength(1);

    for (const target of ['developer-api-stack', 'all-workers']) {
      const plan = emergencyDeploymentPlan(target, '1'.repeat(40)).flat().join(' ');
      expect(plan.indexOf('cloudflare/wrangler.developer-api.toml')).toBeLessThan(
        plan.indexOf('developer-api:effects-scopes:remote'),
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
    const migration = readFileSync(
      resolve('cloudflare/developer-api.effects-scopes.migration.sql'),
      'utf8',
    );
    const rollback = readFileSync(
      resolve('cloudflare/developer-api.effects-scopes.rollback.sql'),
      'utf8',
    );

    expect(rollback).toContain('scope_mask BETWEEN 1 AND 63');
    expect(rollback).toContain('(scope_mask & 63) = 0');
    expect(rollback).toContain('scope_mask & 63');
    expect(rollback).toContain('CHECK (ok = 1)');
    for (const script of [migration, rollback]) {
      expect(script).toContain('CREATE TRIGGER trg_mxqr_developer_api_keys_decommissioned_room');
      expect(script).toContain("RAISE(ABORT, 'PRO_ROOM_DECOMMISSIONED')");
    }
  });
});
