import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const BASE_ENV = {
  RELEASE_TARGET: 'all',
  MXQR_R2_POLICY_OUTCOME: 'success',
  MXQR_R2_FORWARD_TARGETS: '',
  MXQR_GENERATION_FENCE_OUTCOME: 'success',
  MXQR_WORKER_FLOOR_OUTCOME: 'success',
  MXQR_WORKER_FLOOR_TARGETS: '',
  MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME: 'success',
  MXQR_APPLY_DEVELOPER_API_D1: 'false',
  MXQR_SERVICE_CONTROL_FORWARD_FLOOR: 'false',
  MXQR_REMOTE_SHARE_FORWARD_FLOOR: 'false',
  MXQR_PRO_SYSTEM_AUDIO_FORWARD_FLOOR: 'false',
  MXQR_STANDARD_ROOM_PIN_FORWARD_FLOOR: 'false',
  MXQR_SORO_ARTICLE_VISIBILITY_FORWARD_FLOOR: 'false',
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
      MXQR_STANDARD_ROOM_PIN_FORWARD_FLOOR: 'true',
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
    ['Standard room PIN storage', 'MXQR_STANDARD_ROOM_PIN_FORWARD_FLOOR', ['signaling']],
    ['Soro article visibility', 'MXQR_SORO_ARTICLE_VISIBILITY_FORWARD_FLOOR', ['app']],
  ] as const)('retains the exact %s candidate boundary', (_label, floorVariable, expected) => {
    const result = plan({ RELEASE_TARGET: 'all', [floorVariable]: 'true' });
    expect(result.status, result.stderr).toBe(0);
    expect(new Set(result.stdout.split(','))).toEqual(new Set(expected));
  });

  it.each(['failure', 'cancelled', 'skipped'] as const)(
    'keeps the hardened signaling candidate when domain recovery is %s',
    (recoveryOutcome) => {
      const result = plan({ MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME: recoveryOutcome });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split(',')).toContain('signaling');
    },
  );

  it('ignores a skipped signaling-domain recovery for an app-only release', () => {
    const result = plan({
      RELEASE_TARGET: 'app',
      MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME: 'skipped',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('rejects malformed outcomes, booleans, and Worker names', () => {
    expect(plan({ MXQR_R2_POLICY_OUTCOME: 'unknown' }).status).toBe(1);
    expect(plan({ MXQR_APPLY_DEVELOPER_API_D1: 'yes' }).status).toBe(1);
    expect(plan({ MXQR_PRO_SYSTEM_AUDIO_FORWARD_FLOOR: 'yes' }).status).toBe(1);
    expect(plan({ MXQR_STANDARD_ROOM_PIN_FORWARD_FLOOR: 'yes' }).status).toBe(1);
    expect(plan({ MXQR_SORO_ARTICLE_VISIBILITY_FORWARD_FLOOR: 'yes' }).status).toBe(1);
    expect(plan({ MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME: 'unknown' }).status).toBe(1);
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
