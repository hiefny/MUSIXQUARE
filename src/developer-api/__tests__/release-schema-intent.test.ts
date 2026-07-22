import { describe, expect, it, vi } from 'vitest';

import {
  assertDeveloperApiSchemaRelease,
  releaseCommitFromDeployment,
} from '../../../scripts/check-developer-api-schema-release.mjs';

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
    const runner = vi.fn(() => '');
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
      expect.arrayContaining(['diff', '--name-only', PREVIOUS, CURRENT, '--']),
      { encoding: 'utf8' },
    );
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
});
