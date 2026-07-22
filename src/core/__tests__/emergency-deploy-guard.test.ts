import { describe, expect, it } from 'vitest';

import {
  EMERGENCY_DEPLOY_CONFIRM_ENV,
  assertEmergencyDeployAuthorization,
  authorizeEmergencyDeploy,
  expectedEmergencyDeployConfirmation,
  parseRemoteMainSha,
} from '../../../scripts/guard-emergency-deploy.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    target: 'app',
    commitSha: COMMIT,
    branchName: 'main',
    originMainSha: COMMIT,
    worktreeStatus: '',
    confirmation: expectedEmergencyDeployConfirmation('app', COMMIT),
    ...overrides,
  };
}

describe('emergency deployment guard', () => {
  it('authorizes only the exact target and pushed main commit', () => {
    expect(assertEmergencyDeployAuthorization(authorization())).toEqual({
      target: 'app',
      commitSha: COMMIT,
    });
  });

  it.each([
    ['missing confirmation', undefined],
    ['stale commit', `MUSIXQUARE_EMERGENCY_DEPLOY:app:${'f'.repeat(40)}`],
    ['different target', `MUSIXQUARE_EMERGENCY_DEPLOY:signaling:${COMMIT}`],
    ['extra whitespace', `MUSIXQUARE_EMERGENCY_DEPLOY:app:${COMMIT} `],
  ])('rejects %s', (_label, confirmation) => {
    expect(() => assertEmergencyDeployAuthorization(authorization({ confirmation }))).toThrow(
      EMERGENCY_DEPLOY_CONFIRM_ENV,
    );
  });

  it.each([
    ['tracked change', ' M package.json'],
    ['untracked file', '?? emergency-build.zip'],
  ])('rejects a dirty worktree with a %s', (_label, worktreeStatus) => {
    expect(() => assertEmergencyDeployAuthorization(authorization({ worktreeStatus }))).toThrow(
      'worktree change',
    );
  });

  it('rejects non-main and detached checkouts', () => {
    expect(() =>
      assertEmergencyDeployAuthorization(authorization({ branchName: 'codex/hotfix' })),
    ).toThrow('branch must be main');
    expect(() => assertEmergencyDeployAuthorization(authorization({ branchName: '' }))).toThrow(
      'branch must be main',
    );
  });

  it('rejects a local commit that has not reached origin/main', () => {
    expect(() =>
      assertEmergencyDeployAuthorization(authorization({ originMainSha: 'f'.repeat(40) })),
    ).toThrow('equal to origin/main');
  });

  it('rejects unknown targets and abbreviated commit IDs', () => {
    expect(() => expectedEmergencyDeployConfirmation('unknown', COMMIT)).toThrow(
      'Unknown emergency deployment target',
    );
    expect(() => expectedEmergencyDeployConfirmation('app', COMMIT.slice(0, 12))).toThrow(
      'full lowercase Git commit SHA',
    );
  });

  it('accepts only one exact live origin/main ref', () => {
    expect(parseRemoteMainSha(`${COMMIT}\trefs/heads/main\n`)).toBe(COMMIT);
    expect(parseRemoteMainSha(`${COMMIT.toUpperCase()} refs/heads/main`)).toBe(COMMIT);
    expect(() => parseRemoteMainSha(`${COMMIT}\trefs/heads/release\n`)).toThrow(
      'origin did not return one valid',
    );
    expect(() =>
      parseRemoteMainSha(`${COMMIT}\trefs/heads/main\n${'f'.repeat(40)}\trefs/heads/main\n`),
    ).toThrow('origin did not return one valid');
  });

  it('authorizes against the live remote ref rather than a local tracking ref', () => {
    const calls: string[][] = [];
    const result = authorizeEmergencyDeploy('app', {
      confirmation: expectedEmergencyDeployConfirmation('app', COMMIT),
      readGit: (args: string[]) => {
        calls.push(args);
        if (args[0] === 'rev-parse') return COMMIT;
        if (args[0] === 'symbolic-ref') return 'main';
        if (args[0] === 'status') return '';
        if (args[0] === 'ls-remote') return `${COMMIT}\trefs/heads/main\n`;
        throw new Error(`Unexpected git call: ${args.join(' ')}`);
      },
    });

    expect(result).toEqual({ target: 'app', commitSha: COMMIT });
    expect(calls.at(-1)).toEqual(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
    expect(calls.flat()).not.toContain('refs/remotes/origin/main');
  });

  it('fails closed when the live remote cannot be queried', () => {
    expect(() =>
      authorizeEmergencyDeploy('app', {
        confirmation: expectedEmergencyDeployConfirmation('app', COMMIT),
        readGit: (args: string[]) => {
          if (args[0] === 'rev-parse') return COMMIT;
          if (args[0] === 'symbolic-ref') return 'main';
          if (args[0] === 'status') return '';
          throw new Error('network unavailable');
        },
      }),
    ).toThrow('live origin/main commit could not be verified');
  });
});
