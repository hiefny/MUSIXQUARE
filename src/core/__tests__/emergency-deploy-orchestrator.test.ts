import { describe, expect, it, vi } from 'vitest';

import {
  emergencyCompatibilityTarget,
  emergencyDeploymentMessage,
  emergencyDeploymentPlan,
  emergencyNpmInvocation,
  parseEmergencyDeploymentArgs,
  runEmergencyDeployment,
} from '../../../scripts/emergency-deploy.mjs';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function deployCommands(plan: string[][]): string[][] {
  return plan.filter((command) => command.includes('deploy'));
}

describe('emergency deployment orchestrator', () => {
  it('creates immutable provenance internally and attaches it to every Worker deployment', () => {
    const expectedCounts: Record<string, number> = {
      'remote-share': 1,
      'pro-room': 1,
      'developer-api-stack': 2,
      signaling: 1,
      app: 1,
      'all-workers': 6,
    };

    for (const target of Object.keys(expectedCounts)) {
      const message = emergencyDeploymentMessage(target, COMMIT);
      expect(message).toBe(`git:${COMMIT} emergency-target:${target}`);
      const deployments = deployCommands(emergencyDeploymentPlan(target, COMMIT));
      expect(deployments).toHaveLength(expectedCounts[target]);
      for (const command of deployments) {
        const messageIndex = command.indexOf('--message');
        expect(messageIndex).toBeGreaterThan(-1);
        expect(command[messageIndex + 1]).toBe(message);
        expect(command.filter((argument) => argument === '--message')).toHaveLength(1);
      }
    }
  });

  it('forces the Developer API facade and backend through the stack contract', () => {
    expect(() => emergencyDeploymentPlan('developer-api-facade', COMMIT)).toThrow(
      'use developer-api-stack',
    );
    expect(() => emergencyDeploymentPlan('developer-api', COMMIT)).toThrow(
      'use developer-api-stack',
    );
    expect(emergencyCompatibilityTarget('developer-api-stack')).toBe('developer-api');
  });

  it('maps every partial emergency route through the approved compatibility gate', () => {
    expect(emergencyCompatibilityTarget('remote-share')).toBe('remote-share');
    expect(emergencyCompatibilityTarget('pro-room')).toBe('pro-room');
    expect(emergencyCompatibilityTarget('signaling')).toBe('signaling');
    expect(emergencyCompatibilityTarget('app')).toBe('app');
    expect(emergencyCompatibilityTarget('all-workers')).toBeNull();
  });

  it('preserves the all-Worker validation, build, D1, and deployment order', () => {
    const plan = emergencyDeploymentPlan('all-workers', COMMIT)
      .map((command) => command.join(' '))
      .join('\n');
    const orderedTokens = [
      'check:workers',
      'build:checked',
      'cloudflare/wrangler.remote-share.toml',
      'cloudflare/wrangler.pro-room.toml',
      'cloudflare/wrangler.signaling.toml',
      'cloudflare/wrangler.developer-api-facade.toml',
      'developer-api:schema:remote',
      'cloudflare/wrangler.developer-api.toml',
      'developer-api:effects-scopes:remote',
      'cloudflare/wrangler.app.toml',
    ];
    let previous = -1;
    for (const token of orderedTokens) {
      const index = plan.indexOf(token);
      expect(index, token).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it('runs only the authorized plan and stops at the first failed command', () => {
    const authorize = vi.fn(() => ({ target: 'app', commitSha: COMMIT }));
    const compatibilityCheck = vi.fn();
    const runner = vi.fn((command: string[]) => {
      if (command.includes('build:checked')) throw new Error('validation failed');
    });
    expect(() =>
      runEmergencyDeployment({ target: 'app', authorize, runner, compatibilityCheck }),
    ).toThrow('validation failed');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(compatibilityCheck).toHaveBeenCalledWith(
      'app',
      COMMIT,
      `release-artifacts/emergency-deployments/${COMMIT}-app`,
    );
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.some(([command]) => command.includes('deploy'))).toBe(false);
  });

  it('stops before validation and deploy when the partial compatibility proof fails', () => {
    const authorize = vi.fn(() => ({ target: 'signaling', commitSha: COMMIT }));
    const runner = vi.fn();
    const compatibilityCheck = vi.fn(() => {
      throw new Error('mixed Worker contract');
    });

    expect(() =>
      runEmergencyDeployment({ target: 'signaling', authorize, runner, compatibilityCheck }),
    ).toThrow('mixed Worker contract');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects arbitrary trailing arguments instead of forwarding them to Wrangler', () => {
    expect(parseEmergencyDeploymentArgs(['app'])).toBe('app');
    expect(() => parseEmergencyDeploymentArgs(['app', '--message', 'operator supplied'])).toThrow(
      'trailing arguments are not accepted',
    );
    expect(() => parseEmergencyDeploymentArgs(['unknown'])).toThrow('Usage:');
    expect(() => parseEmergencyDeploymentArgs([])).toThrow('Usage:');
  });

  it('uses npm without an argument-bearing shell', () => {
    expect(
      emergencyNpmInvocation('win32', {
        nodeExecutable: 'C:/Node/node.exe',
        environment: {},
        fileExists: (path: string) => path.replaceAll('\\', '/').endsWith('/npm-cli.js'),
      }),
    ).toEqual({
      executable: 'C:/Node/node.exe',
      prefixArgs: ['C:\\Node\\node_modules\\npm\\bin\\npm-cli.js'],
    });
    expect(emergencyNpmInvocation('linux')).toEqual({ executable: 'npm', prefixArgs: [] });
  });
});
