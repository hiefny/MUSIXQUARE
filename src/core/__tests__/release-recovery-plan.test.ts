import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const BASE_ENV = {
  RELEASE_TARGET: 'all',
  MXQR_R2_POLICY_OUTCOME: 'success',
  MXQR_R2_FORWARD_TARGETS: '',
  MXQR_GENERATION_FENCE_OUTCOME: 'success',
  MXQR_WORKER_FLOOR_OUTCOME: 'success',
  MXQR_WORKER_FLOOR_TARGETS: '',
  MXQR_APPLY_DEVELOPER_API_D1: 'false',
  MXQR_SERVICE_CONTROL_FORWARD_FLOOR: 'false',
  MXQR_REMOTE_SHARE_FORWARD_FLOOR: 'false',
  MXQR_PRO_SYSTEM_AUDIO_FORWARD_FLOOR: 'false',
};

function plan(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['scripts/release-recovery-plan.mts'], {
    cwd: process.cwd(),
    env: { ...process.env, ...BASE_ENV, ...overrides },
    encoding: 'utf8',
  });
}

describe('release recovery target plan', () => {
  it('keeps a fully assessed rollback free of invented forward floors', () => {
    const result = plan();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('fails closed to selected R2 and Worker consumers when assessments fail', () => {
    const result = plan({
      MXQR_R2_POLICY_OUTCOME: 'failure',
      MXQR_WORKER_FLOOR_OUTCOME: 'cancelled',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(new Set(result.stdout.split(','))).toEqual(
      new Set([
        'remote-share',
        'pro-room',
        'app',
        'signaling',
        'developer-api-facade',
        'developer-api',
      ]),
    );
  });

  it('combines explicit policy, schema, generation, and contract floors without duplicates', () => {
    const result = plan({
      RELEASE_TARGET: 'developer-api',
      MXQR_R2_FORWARD_TARGETS: 'app',
      MXQR_GENERATION_FENCE_OUTCOME: 'failure',
      MXQR_WORKER_FLOOR_TARGETS: 'developer-api-facade',
      MXQR_APPLY_DEVELOPER_API_D1: 'true',
      MXQR_SERVICE_CONTROL_FORWARD_FLOOR: 'true',
      MXQR_REMOTE_SHARE_FORWARD_FLOOR: 'true',
      MXQR_PRO_SYSTEM_AUDIO_FORWARD_FLOOR: 'true',
    });
    expect(result.status, result.stderr).toBe(0);
    const targets = result.stdout.split(',');
    expect(new Set(targets)).toEqual(new Set([...WORKERS]));
    expect(targets).toHaveLength(new Set(targets).size);
  });

  it.each([
    ['service-control', 'MXQR_SERVICE_CONTROL_FORWARD_FLOOR', ['pro-room', 'app']],
    ['remote-share', 'MXQR_REMOTE_SHARE_FORWARD_FLOOR', ['remote-share', 'app']],
    ['PRO system-audio', 'MXQR_PRO_SYSTEM_AUDIO_FORWARD_FLOOR', ['pro-room', 'signaling', 'app']],
  ] as const)('retains the exact %s candidate boundary', (_label, floorVariable, expected) => {
    const result = plan({ RELEASE_TARGET: 'all', [floorVariable]: 'true' });
    expect(result.status, result.stderr).toBe(0);
    expect(new Set(result.stdout.split(','))).toEqual(new Set(expected));
  });

  it('rejects malformed outcomes, booleans, and Worker names', () => {
    expect(plan({ MXQR_R2_POLICY_OUTCOME: 'unknown' }).status).toBe(1);
    expect(plan({ MXQR_APPLY_DEVELOPER_API_D1: 'yes' }).status).toBe(1);
    expect(plan({ MXQR_PRO_SYSTEM_AUDIO_FORWARD_FLOOR: 'yes' }).status).toBe(1);
    expect(plan({ MXQR_R2_FORWARD_TARGETS: 'not-a-worker' }).status).toBe(1);
  });
});

const WORKERS = [
  'app',
  'developer-api',
  'developer-api-facade',
  'pro-room',
  'remote-share',
  'signaling',
] as const;
