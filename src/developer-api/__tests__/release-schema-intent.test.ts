import { describe, expect, it, vi } from 'vitest';

import {
  assertBaselineContractChanged,
  assertDeveloperApiSchemaRelease,
  releaseCommitFromDeployment,
} from '../../../scripts/check-developer-api-schema-release.mjs';
import { loadD1MigrationManifest } from '../../../scripts/check-d1-migration-contract.mjs';

const PREVIOUS = '1'.repeat(40);
const CURRENT = '2'.repeat(40);

function deployment(message: string | null) {
  return message === null ? {} : { annotations: { 'workers/message': message } };
}

describe('Developer API schema release intent', () => {
  it('extracts only a full traceable release SHA', () => {
    expect(releaseCommitFromDeployment(deployment(`git:${PREVIOUS} run:1 target:all`))).toBe(
      PREVIOUS,
    );
    expect(releaseCommitFromDeployment(deployment('manual deployment'))).toBeNull();
    expect(releaseCommitFromDeployment(deployment('git:abc123'))).toBeNull();
  });

  it('allows a code-only release when tracked schema files did not change', () => {
    const runner = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'ls-tree') return '';
      if (args[0] === 'diff') return '';
      throw new Error(`Unexpected git operation: ${args[0]}`);
    });
    expect(
      assertDeveloperApiSchemaRelease({
        deployment: deployment(`git:${PREVIOUS} run:1`),
        currentCommit: CURRENT,
        applyRequested: false,
        runner,
      }),
    ).toEqual({ previousCommit: PREVIOUS, changed: [] });
    expect(runner).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'diff',
        '--name-only',
        PREVIOUS,
        CURRENT,
        '--',
        'cloudflare/developer-api.schema.sql',
      ]),
      { encoding: 'utf8' },
    );
  });

  it('checks every database migration history on every traceable release', () => {
    const previousManifest = JSON.parse(JSON.stringify(loadD1MigrationManifest()));
    previousManifest.databases[1].migrations[0].forwardSha256 = '0'.repeat(64);
    const runner = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'ls-tree') return 'cloudflare/d1-migrations.manifest.json\n';
      if (args[0] === 'show') return JSON.stringify(previousManifest);
      if (args[0] === 'diff') return '';
      throw new Error(`Unexpected git operation: ${args[0]}`);
    });

    expect(() =>
      assertDeveloperApiSchemaRelease({
        deployment: deployment(`git:${PREVIOUS} run:1`),
        currentCommit: CURRENT,
        applyRequested: false,
        runner,
      }),
    ).toThrow('migration history is append-only');
    expect(runner).not.toHaveBeenCalledWith('git', expect.arrayContaining(['diff']), {
      encoding: 'utf8',
    });
  });

  it('requires the D1 option when a schema contract changed', () => {
    expect(() =>
      assertDeveloperApiSchemaRelease({
        deployment: deployment(`git:${PREVIOUS} run:1`),
        currentCommit: CURRENT,
        applyRequested: false,
        runner: () => 'cloudflare/developer-api.schema.sql\n',
      }),
    ).toThrow('Enable the D1 migration release option');
  });

  it('fails closed for an untraceable prior deployment but accepts an explicit D1 release', () => {
    expect(() =>
      assertDeveloperApiSchemaRelease({
        deployment: deployment(null),
        currentCommit: CURRENT,
        applyRequested: false,
        runner: vi.fn(),
      }),
    ).toThrow('no traceable git SHA');
    expect(
      assertDeveloperApiSchemaRelease({
        deployment: deployment(null),
        currentCommit: CURRENT,
        applyRequested: true,
        runner: vi.fn(),
      }),
    ).toEqual({ previousCommit: null, changed: [] });
  });

  it('requires baseline changes to carry a changed migration or recovery contract', () => {
    const currentManifest = loadD1MigrationManifest();
    const unchangedRunner = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'diff') return 'cloudflare/developer-api.schema.sql\n';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'ls-tree') return 'cloudflare/d1-migrations.manifest.json\n';
      if (args[0] === 'show') return JSON.stringify(currentManifest);
      throw new Error(`Unexpected git operation: ${args[0]}`);
    });

    expect(() =>
      assertDeveloperApiSchemaRelease({
        deployment: deployment(`git:${PREVIOUS} run:1`),
        currentCommit: CURRENT,
        applyRequested: true,
        runner: unchangedRunner,
      }),
    ).toThrow('baseline schema changed without a changed migration/recovery contract');

    const previousManifest = JSON.parse(JSON.stringify(currentManifest));
    const previousDeveloper = previousManifest.databases.find(
      (database: { database: string }) => database.database === 'musixquare-developer-api',
    );
    const currentDeveloper = currentManifest.databases.find(
      (database: { database: string }) => database.database === 'musixquare-developer-api',
    );
    if (!currentDeveloper) throw new Error('Expected the current Developer API contract');
    previousDeveloper.baselineRevision = currentDeveloper.baselineRevision - 1;
    previousDeveloper.baselineSha256 = '0'.repeat(64);
    previousDeveloper.baselineMigration = currentDeveloper.migrations.at(-2)?.id ?? null;
    previousDeveloper.migrations = currentDeveloper.migrations.slice(0, -1);
    const changedRunner = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'diff') return 'cloudflare/developer-api.schema.sql\n';
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'ls-tree') return 'cloudflare/d1-migrations.manifest.json\n';
      if (args[0] === 'show') return JSON.stringify(previousManifest);
      throw new Error(`Unexpected git operation: ${args[0]}`);
    });
    expect(
      assertDeveloperApiSchemaRelease({
        deployment: deployment(`git:${PREVIOUS} run:1`),
        currentCommit: CURRENT,
        applyRequested: true,
        runner: changedRunner,
      }),
    ).toEqual({ previousCommit: PREVIOUS, changed: [] });
  });

  it('accepts the first manifest adoption as the explicit baseline recovery contract', () => {
    const runner = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'ls-tree') return '';
      throw new Error(`Unexpected git operation: ${args[0]}`);
    });
    expect(assertBaselineContractChanged({ previousCommit: PREVIOUS, runner })).toEqual({
      adopted: true,
    });
  });

  it('does not confuse a missing or unreadable deployed commit with first adoption', () => {
    const missingCommitRunner = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'cat-file') throw new Error('unknown revision');
      throw new Error(`Unexpected git operation: ${args[0]}`);
    });
    expect(() =>
      assertBaselineContractChanged({ previousCommit: PREVIOUS, runner: missingCommitRunner }),
    ).toThrow('Cannot verify the deployed git commit');

    const failedTreeRunner = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'ls-tree') throw new Error('git process failed');
      throw new Error(`Unexpected git operation: ${args[0]}`);
    });
    expect(() =>
      assertBaselineContractChanged({ previousCommit: PREVIOUS, runner: failedTreeRunner }),
    ).toThrow("Cannot inspect the deployed commit's D1 migration contract");
  });
});
