import { describe, expect, it, vi } from 'vitest';

import {
  emergencyCompatibilityTarget,
  emergencyDeploymentMessage,
  emergencyDeploymentPlan,
  emergencyWorkerForDeploymentCommand,
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
      expect(message).toBe(`git:${COMMIT}`);
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

  it('keeps emergency deployment code-only and preserves validation/deployment order', () => {
    const plan = emergencyDeploymentPlan('all-workers', COMMIT)
      .map((command) => command.join(' '))
      .join('\n');
    const orderedTokens = [
      'check:workers',
      'build:checked',
      'cloudflare/wrangler.pro-room.toml',
      'cloudflare/wrangler.remote-share.toml',
      'cloudflare/wrangler.signaling.toml',
      'cloudflare/wrangler.developer-api-facade.toml',
      'cloudflare/wrangler.developer-api.toml',
      'cloudflare/wrangler.app.toml',
    ];
    let previous = -1;
    for (const token of orderedTokens) {
      const index = plan.indexOf(token);
      expect(index, token).toBeGreaterThan(previous);
      previous = index;
    }
    expect(plan).not.toContain('schema:remote');
  });

  it('runs only the authorized plan and stops at the first failed command', () => {
    const authorize = vi.fn(() => ({ target: 'app', commitSha: COMMIT }));
    const compatibilityCheck = vi.fn();
    const compatibilityRecheck = vi.fn();
    const checkpoint = vi.fn();
    const codeOnlyCheck = vi.fn();
    const selectedPreflight = vi.fn();
    const runner = vi.fn((command: string[]) => {
      if (command.includes('build:checked')) throw new Error('validation failed');
    });
    expect(() =>
      runEmergencyDeployment({
        target: 'app',
        authorize,
        runner,
        compatibilityCheck,
        compatibilityRecheck,
        checkpoint,
        codeOnlyCheck,
        selectedPreflight,
        recordDeployment: vi.fn(),
        finalVerification: vi.fn(),
      }),
    ).toThrow('validation failed');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(compatibilityCheck).toHaveBeenCalledWith(
      'app',
      COMMIT,
      `release-artifacts/emergency-deployments/${COMMIT}-app`,
    );
    expect(checkpoint).toHaveBeenCalledWith(
      'app',
      `git:${COMMIT}`,
      `release-artifacts/emergency-deployments/${COMMIT}-app`,
    );
    expect(codeOnlyCheck).toHaveBeenCalledWith(
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
      runEmergencyDeployment({
        target: 'signaling',
        authorize,
        runner,
        compatibilityCheck,
        checkpoint: vi.fn(),
        codeOnlyCheck: vi.fn(),
        selectedPreflight: vi.fn(),
        recordDeployment: vi.fn(),
        finalVerification: vi.fn(),
      }),
    ).toThrow('mixed Worker contract');
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails before commands when the code-only external-state fence rejects the candidate', () => {
    const runner = vi.fn();
    const codeOnlyCheck = vi.fn(() => {
      throw new Error('external-state changes');
    });
    expect(() =>
      runEmergencyDeployment({
        target: 'remote-share',
        authorize: () => ({ target: 'remote-share', commitSha: COMMIT }),
        runner,
        compatibilityCheck: vi.fn(),
        checkpoint: vi.fn(),
        codeOnlyCheck,
        selectedPreflight: vi.fn(),
        recordDeployment: vi.fn(),
        finalVerification: vi.fn(),
      }),
    ).toThrow('external-state changes');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rechecks unselected Workers and the selected baseline immediately before deploy', () => {
    const events: string[] = [];
    const runner = vi.fn((command: string[]) => events.push(`run:${command.join(' ')}`));
    runEmergencyDeployment({
      target: 'app',
      authorize: () => ({ target: 'app', commitSha: COMMIT }),
      runner,
      compatibilityCheck: () => events.push('compatibility'),
      compatibilityRecheck: () => events.push('compatibility-recheck'),
      checkpoint: () => events.push('checkpoint'),
      codeOnlyCheck: () => events.push('code-only'),
      selectedPreflight: (worker: string) => events.push(`preflight:${worker}`),
      recordDeployment: (worker: string) => events.push(`record:${worker}`),
      finalVerification: () => events.push('final-verification'),
    });

    const deployIndex = events.findIndex((entry) => entry.includes('wrangler.app.toml'));
    expect(events.slice(0, deployIndex)).toEqual([
      'compatibility',
      'checkpoint',
      'code-only',
      'run:run --silent smoke:live:signaling',
      'run:run --silent build:checked',
      'compatibility-recheck',
      'preflight:app',
    ]);
    expect(events.slice(deployIndex + 1)).toEqual(['record:app', 'final-verification']);
  });

  it('maps only exact Wrangler deployment commands to selected Workers', () => {
    const plan = emergencyDeploymentPlan('developer-api-stack', COMMIT);
    expect(plan.map(emergencyWorkerForDeploymentCommand)).toEqual([
      null,
      'developer-api-facade',
      'developer-api',
    ]);
  });

  it('records every all-Worker deployment and verifies the complete emergency stack', () => {
    const selectedPreflight = vi.fn();
    const recordDeployment = vi.fn();
    const finalVerification = vi.fn();
    runEmergencyDeployment({
      target: 'all-workers',
      authorize: () => ({ target: 'all-workers', commitSha: COMMIT }),
      runner: vi.fn(),
      checkpoint: vi.fn(),
      codeOnlyCheck: vi.fn(),
      selectedPreflight,
      recordDeployment,
      finalVerification,
    });

    const workers = [
      'pro-room',
      'remote-share',
      'signaling',
      'developer-api-facade',
      'developer-api',
      'app',
    ];
    expect(selectedPreflight.mock.calls.map(([worker]) => worker)).toEqual(workers);
    expect(recordDeployment.mock.calls.map(([worker]) => worker)).toEqual(workers);
    expect(finalVerification).toHaveBeenCalledOnce();
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
