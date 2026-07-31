import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { accountStatsSchemaState } from '../../../scripts/account-stats-schema-state.mjs';

function fixture(row: Record<string, number>): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'mxqr-account-stats-state-'));
  const path = join(directory, 'state.json');
  writeFileSync(path, JSON.stringify([{ success: true, results: [row], meta: {} }]), 'utf8');
  return { directory, path };
}

describe('account stats release schema state', () => {
  it('distinguishes an absent schema from a ready schema', () => {
    for (const [row, expected] of [
      [{ table_present: 0, columns_ready: 0, foreign_key_ready: 0, schema_ready: 0 }, 'missing'],
      [{ table_present: 1, columns_ready: 1, foreign_key_ready: 1, schema_ready: 1 }, 'ready'],
    ] as const) {
      const { directory, path } = fixture(row);
      try {
        expect(accountStatsSchemaState(path)).toBe(expected);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('fails closed for a partial or malformed existing table', () => {
    const { directory, path } = fixture({
      table_present: 1,
      columns_ready: 1,
      foreign_key_ready: 0,
      schema_ready: 0,
    });
    try {
      expect(() => accountStatsSchemaState(path)).toThrow('incompatible');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the app release fail-closed while avoiding a redundant ready-schema probe', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const probe = workflow.indexOf('- name: Probe account stats migration state');
    const apply = workflow.indexOf('- name: Apply account stats migration');
    const verify = workflow.indexOf('- name: Verify account stats schema');
    const appDeploy = workflow.indexOf('- name: Deploy and record app Worker with immutable dist');
    expect(workflow).toContain('apply_account_stats_d1:');
    expect(workflow).toContain('- name: Validate account stats migration intent');
    expect(probe).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(probe);
    expect(verify).toBeGreaterThan(apply);
    expect(appDeploy).toBeGreaterThan(verify);
    expect(workflow.slice(verify, appDeploy)).toContain(
      "steps.account_stats_schema_plan.outputs.state == 'missing'",
    );
  });
});
