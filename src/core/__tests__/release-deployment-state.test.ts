import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attemptedStates,
  preflight,
  productionVersion,
  queryCurrent,
  retrySync,
  runRollbackWithRetry,
  rollbackDisposition,
  verifyProductionVersion,
} from '../../../scripts/release-deployment-state.mjs';

const SCRIPT_PATH = resolve('scripts/release-deployment-state.mjs');
const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'mxqr-release-deployment-'));
  temporaryDirectories.push(directory);
  return directory;
}

function deployment(versionId: string, message = 'release-message') {
  return {
    id: `deployment-${versionId}`,
    annotations: { 'workers/message': message },
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

function runScript(
  args: string[],
  environment: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('release deployment rollback state', () => {
  it('runs a production-state preflight immediately before every Worker deploy', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    for (const target of [
      'remote-share',
      'signaling',
      'pro-room',
      'developer-api-facade',
      'developer-api',
      'app',
    ]) {
      expect(workflow).toMatch(
        new RegExp(
          `preflight ${target}\\s+node scripts/release-deployment-state\\.mjs attempt ${target}` +
            `\\s+set \\+e\\s+npm run --silent wrangler -- deploy`,
        ),
      );
    }
  });

  it('keeps the Developer API release chain ordered and canary-scoped', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const proRoom = workflow.indexOf('Deploy and record PRO room Worker');
    const facade = workflow.indexOf('Deploy and record Developer API facade Worker');
    const developerApi = workflow.indexOf('Deploy and record Developer API Worker');
    const app = workflow.indexOf('Deploy and record app Worker with immutable dist');

    expect(proRoom).toBeGreaterThan(-1);
    expect(facade).toBeGreaterThan(proRoom);
    expect(developerApi).toBeGreaterThan(facade);
    expect(app).toBeGreaterThan(developerApi);
    expect(workflow).toContain('- developer-api');
    expect(workflow).toContain("MXQR_DEVELOPER_API_SMOKE_ROOM: '000001'");
    expect(workflow).toContain(
      'MXQR_DEVELOPER_API_SMOKE_KEY: ${{ secrets.MXQR_DEVELOPER_API_SMOKE_KEY }}',
    );

    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const deployAll = packageJson.scripts['deploy:all-workers'];
    const proConfig = deployAll.indexOf('cloudflare/wrangler.pro-room.toml');
    const facadeConfig = deployAll.indexOf('cloudflare/wrangler.developer-api-facade.toml');
    const apiConfig = deployAll.indexOf('cloudflare/wrangler.developer-api.toml');
    const appConfig = deployAll.indexOf('cloudflare/wrangler.app.toml');

    expect(facadeConfig).toBeGreaterThan(proConfig);
    expect(apiConfig).toBeGreaterThan(facadeConfig);
    expect(appConfig).toBeGreaterThan(apiConfig);
  });

  it('requires exactly one 100% production version', () => {
    expect(productionVersion(deployment('before'), 'fixture')).toBe('before');
    expect(() =>
      productionVersion(
        {
          versions: [
            { version_id: 'old', percentage: 50 },
            { version_id: 'new', percentage: 50 },
          ],
        },
        'fixture',
      ),
    ).toThrow('exactly one 100% production version');
  });

  it('records before, attempted, and after versions for a deploy', () => {
    const directory = createDirectory();
    writeFileSync(
      resolve(directory, 'signaling-before.json'),
      JSON.stringify(deployment('before')),
    );

    const prepare = runScript(['prepare', 'signaling', directory], {
      RELEASE_MESSAGE: 'release-message',
    });
    expect(prepare.status, prepare.stderr).toBe(0);
    expect(runScript(['attempt', 'signaling', directory]).status).toBe(0);
    writeFileSync(resolve(directory, 'signaling.json'), JSON.stringify(deployment('after')));
    expect(runScript(['record', 'signaling', directory]).status).toBe(0);

    const state = JSON.parse(
      readFileSync(resolve(directory, 'signaling-state.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(state).toMatchObject({
      target: 'signaling',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      attempted: true,
      changed: true,
      ownedByRelease: true,
    });
    expect(runScript(['version', 'signaling', directory]).stdout).toBe('after');
  });

  it('stops before deploy when production changed after preparation', () => {
    for (const [label, current] of [
      [
        'deployment',
        { deploymentId: 'deployment-external', versionId: 'before', message: 'external' },
      ],
      [
        'version',
        { deploymentId: 'deployment-before', versionId: 'external', message: 'external' },
      ],
    ] as const) {
      const directory = createDirectory();
      writeFileSync(
        resolve(directory, 'signaling-before.json'),
        JSON.stringify(deployment('before')),
      );
      expect(
        runScript(['prepare', 'signaling', directory], { RELEASE_MESSAGE: 'release-message' })
          .status,
      ).toBe(0);

      expect(() =>
        preflight('signaling', directory, {
          queryCurrent: () => current,
        }),
      ).toThrow('production changed after release preparation');
      const state = JSON.parse(
        readFileSync(resolve(directory, 'signaling-state.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(state.attempted, label).toBe(false);
      expect(state.preflightCheckedAt, label).toBeUndefined();
    }
  });

  it('records a successful preflight only when deployment and version still match', () => {
    const directory = createDirectory();
    writeFileSync(resolve(directory, 'app-before.json'), JSON.stringify(deployment('before')));
    expect(
      runScript(['prepare', 'app', directory], { RELEASE_MESSAGE: 'release-message' }).status,
    ).toBe(0);

    preflight('app', directory, {
      queryCurrent: () => ({
        deploymentId: 'deployment-before',
        versionId: 'before',
        message: 'release-message',
      }),
    });

    const state = JSON.parse(readFileSync(resolve(directory, 'app-state.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      attempted: false,
      preflightDeploymentId: 'deployment-before',
      preflightVersionId: 'before',
    });
    expect(state.preflightCheckedAt).toEqual(expect.any(String));
  });

  it('retries transient current-deployment queries with bounded backoff', () => {
    const directory = createDirectory();
    const delays: number[] = [];
    let attempts = 0;
    const current = queryCurrent('remote-share', 'wrangler.toml', resolve(directory, 'now.json'), {
      runner: () => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary Cloudflare 503');
        return JSON.stringify(deployment('current'));
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 20,
        sleep: (delayMs: number) => delays.push(delayMs),
        onRetry: () => undefined,
      },
    });

    expect(current.versionId).toBe('current');
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('stops retrying after the configured attempt budget', () => {
    const delays: number[] = [];
    let attempts = 0;

    expect(() =>
      retrySync(
        'always failing operation',
        () => {
          attempts += 1;
          throw new Error('still unavailable');
        },
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 15,
          sleep: (delayMs: number) => delays.push(delayMs),
          onRetry: () => undefined,
        },
      ),
    ).toThrow('still unavailable');
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 15]);
  });

  it('rechecks ownership after a lost rollback response and avoids a duplicate command', () => {
    const directory = createDirectory();
    let queries = 0;
    let commands = 0;
    const state = {
      target: 'app',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: 'release-message',
      ownedByRelease: true,
      config: 'wrangler.toml',
    };

    const result = runRollbackWithRetry(state, 'rollback-message', {
      outputPath: resolve(directory, 'rollback-current.json'),
      queryCurrent: () => {
        queries += 1;
        return {
          versionId: queries === 1 ? 'after' : 'before',
          deploymentId: queries === 1 ? 'deployment-after' : 'deployment-before',
          message: queries === 1 ? 'release-message' : 'rollback-message',
        };
      },
      runner: () => {
        commands += 1;
        throw new Error('response lost after Cloudflare accepted rollback');
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: () => undefined,
        onRetry: () => undefined,
      },
    });

    expect(result.status).toBe('already-restored');
    expect(queries).toBe(2);
    expect(commands).toBe(1);
  });

  it('does not issue another rollback when an external deploy appears between attempts', () => {
    const directory = createDirectory();
    let queries = 0;
    let commands = 0;
    const state = {
      target: 'signaling',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: 'release-message',
      ownedByRelease: true,
      config: 'wrangler.toml',
    };

    const result = runRollbackWithRetry(state, 'rollback-message', {
      outputPath: resolve(directory, 'rollback-current.json'),
      queryCurrent: () => {
        queries += 1;
        return {
          versionId: queries === 1 ? 'after' : 'external',
          deploymentId: queries === 1 ? 'deployment-after' : 'deployment-external',
          message: queries === 1 ? 'release-message' : 'manual-deploy',
        };
      },
      runner: () => {
        commands += 1;
        throw new Error('temporary Cloudflare 502');
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: () => undefined,
        onRetry: () => undefined,
      },
    });

    expect(result.status).toBe('conflict');
    expect(queries).toBe(2);
    expect(commands).toBe(1);
  });

  it('bounds transient rollback current-query and command retries', () => {
    const directory = createDirectory();
    const delays: number[] = [];
    let queries = 0;
    let commands = 0;
    const state = {
      target: 'remote-share',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: 'release-message',
      ownedByRelease: true,
      config: 'wrangler.toml',
    };

    const result = runRollbackWithRetry(state, 'rollback-message', {
      outputPath: resolve(directory, 'rollback-current.json'),
      queryCurrent: () => {
        queries += 1;
        if (queries === 1) throw new Error('temporary current-query 503');
        return {
          versionId: 'after',
          deploymentId: 'deployment-after',
          message: 'release-message',
        };
      },
      runner: () => {
        commands += 1;
        if (commands === 1) throw new Error('temporary rollback 502');
        return '';
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: (delayMs: number) => delays.push(delayMs),
        onRetry: () => undefined,
      },
    });

    expect(result.status).toBe('command-issued');
    expect(queries).toBe(3);
    expect(commands).toBe(2);
    expect(delays).toEqual([5, 10]);
  });

  it('tolerates delayed rollback visibility', () => {
    const directory = createDirectory();

    const verifyDelays: number[] = [];
    let verifyAttempts = 0;
    const restored = verifyProductionVersion(
      'app',
      'wrangler.toml',
      'before',
      resolve(directory, 'rollback.json'),
      {
        runner: () => {
          verifyAttempts += 1;
          return JSON.stringify(deployment(verifyAttempts < 3 ? 'after' : 'before'));
        },
        retry: {
          maxAttempts: 3,
          baseDelayMs: 5,
          maxDelayMs: 10,
          sleep: (delayMs: number) => verifyDelays.push(delayMs),
          onRetry: () => undefined,
        },
      },
    );
    expect(restored.versionId).toBe('before');
    expect(verifyAttempts).toBe(3);
    expect(verifyDelays).toEqual([5, 10]);
  });

  it('rejects a missing deployment change and an externally owned version', () => {
    for (const [suffix, after] of [
      ['unchanged', deployment('before')],
      ['external', deployment('after', 'another-release')],
    ] as const) {
      const directory = createDirectory();
      writeFileSync(resolve(directory, 'app-before.json'), JSON.stringify(deployment('before')));
      expect(
        runScript(['prepare', 'app', directory], { RELEASE_MESSAGE: 'release-message' }).status,
      ).toBe(0);
      expect(runScript(['attempt', 'app', directory]).status).toBe(0);
      writeFileSync(resolve(directory, 'app.json'), JSON.stringify(after));

      const record = runScript(['record', 'app', directory]);
      expect(record.status, suffix).not.toBe(0);
      const state = JSON.parse(
        readFileSync(resolve(directory, 'app-state.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(state).toMatchObject(
        suffix === 'unchanged'
          ? { changed: false, ownedByRelease: true }
          : { changed: true, ownedByRelease: false },
      );
    }
  });

  it('rolls back only a version owned by the failed release', () => {
    const state = {
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: 'this-release',
      ownedByRelease: true,
    };
    expect(rollbackDisposition(state, { versionId: 'before', message: null })).toBe(
      'already-restored',
    );
    expect(
      rollbackDisposition(state, {
        versionId: 'after',
        deploymentId: 'deployment-after',
        message: 'anything',
      }),
    ).toBe('rollback');
    expect(
      rollbackDisposition(state, {
        versionId: 'after',
        deploymentId: 'deployment-external',
        message: 'another-release',
      }),
    ).toBe('conflict');
    expect(
      rollbackDisposition(
        { ...state, afterVersionId: null },
        { versionId: 'unrecorded-after', message: 'this-release' },
      ),
    ).toBe('rollback');
    expect(rollbackDisposition(state, { versionId: 'newer', message: 'another-release' })).toBe(
      'conflict',
    );
  });

  it('orders attempted deployments in reverse release order', () => {
    const directory = createDirectory();
    for (const target of [
      'remote-share',
      'signaling',
      'pro-room',
      'developer-api-facade',
      'developer-api',
      'app',
    ]) {
      writeFileSync(
        resolve(directory, `${target}-state.json`),
        JSON.stringify({ schemaVersion: 1, target, attempted: true }),
      );
    }

    expect(attemptedStates(directory).map((state: { target: string }) => state.target)).toEqual([
      'app',
      'developer-api',
      'developer-api-facade',
      'pro-room',
      'signaling',
      'remote-share',
    ]);
  });
});
