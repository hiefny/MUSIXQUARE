import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { experimental_readRawConfig } from 'wrangler';
import {
  readConfigurationAssignment,
  validateAccountRolloutConfig,
  validateRemoteShareRolloutConfig,
} from '../../../scripts/production-security-rollout.mts';

const PRO_WITH_AUTH_DB = `
[[d1_databases]]
binding = "MUSIXQUARE_AUTH_DB"
database_name = "musixquare-auth"
`;

const APP_WITH_AUTH_DB = `
[[d1_databases]]
binding = "MUSIXQUARE_AUTH_DB"
database_name = "musixquare-auth"
`;

const REMOTE_SHARE_ROLLOUT = `
[version_metadata]
binding = "CF_VERSION_METADATA"
[vars]
ROOM_UPLOADS_PER_WINDOW = "120"
ROOM_UPLOAD_ASSERTION_MODE = "required"
# npm run wrangler -- secret put MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET
[[d1_databases]]
binding = "MUSIXQUARE_ADMIN_DB"
`;

const SIGNALING_ASSERTION_SECRET = `
# npm run wrangler -- secret put MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET
`;

describe('configuration assignment comments', () => {
  it('enforces the file values through the real guard while preserving environment literals', () => {
    // Keep the fixture inside the ignored scratch tree so its unchanged
    // TypeScript helper imports resolve from this checkout's dependencies.
    const cache = resolve('scratch/security-guard-fixtures');
    mkdirSync(cache, { recursive: true });
    const root = mkdtempSync(resolve(cache, 'mxqr-security-guard-'));
    const cleanup = () => {
      if (!root.startsWith(`${cache}${sep}`)) throw new Error('Invalid guard fixture cleanup path');
      rmSync(root, { recursive: true, force: true });
    };
    try {
      const files = [
        'scripts/assert-production-security-config.mts',
        'scripts/production-security-rollout.mts',
        'scripts/pro-signaling-credential-boundary.mts',
        'scripts/standard-room-pin-storage-boundary.mts',
        'cloudflare/wrangler.pro-room.toml',
        'cloudflare/wrangler.app.toml',
        'cloudflare/wrangler.remote-share.toml',
        'cloudflare/wrangler.signaling.toml',
        'cloudflare/signaling-worker.ts',
      ];
      for (const file of files) {
        const target = resolve(root, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(file, target);
      }
      const configPath = resolve(root, 'cloudflare/wrangler.remote-share.toml');
      const source = readFileSync(configPath, 'utf8');
      for (const [fileValue, environmentValue, expectedExit] of [
        ['"true" # operator note', '', 1],
        ["'true' # operator note", '', 1],
        ['false # operator note', '', 0],
        ['"true#value" # operator note', '', 0],
        ['"false" # operator note', 'true # literal environment value', 0],
        ['"false" # operator note', 'true', 1],
      ] as const) {
        writeFileSync(
          configPath,
          source.replace('[vars]', `[vars]\nMXQR_ALLOW_UNGUARDED_REMOTE_SHARE = ${fileValue}`),
        );
        const result = spawnSync(process.execPath, [resolve(root, files[0]!)], {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: environmentValue },
        });
        expect(result.status, result.stdout + result.stderr).toBe(expectedExit);
      }
      for (const [assignment, value, expectedExit] of [
        ['"MXQR_ALLOW_UNGUARDED_REMOTE_SHARE" = "true"', 'true', 1],
        ["'MXQR_ALLOW_UNGUARDED_REMOTE_SHARE' = true", 'true', 1],
        ['"MXQR_ALLOW_UNGUARDED_REMOTE_SH\\u0041RE" = "true"', 'true', 1],
        ['MXQR_ALLOW_UNGUARDED_REMOTE_SHARE = "tr\\u0075e"', 'true', 1],
        ['MXQR_ALLOW_UNGUARDED_REMOTE_SHARE = """true"""', 'true', 1],
        ['MXQR_ALLOW_UNGUARDED_REMOTE_SHARE = """\ntrue"""', 'true', 1],
        ['"MXQR_ALLOW_UNGUARDED_REMOTE_SHARE" = false # safe', 'false', 0],
        ['"MXQR_ALLOW_UNGUARDED_REMOTE_SHARE" = "true#literal"', 'true#literal', 0],
        ['"MXQR_ALLOW_UNGUARDED_REMOTE_SHARE" = \'"true"\'', '"true"', 0],
      ] as const) {
        writeFileSync(configPath, source.replace('[vars]', `['vars']\n${assignment}`));
        const parsed = experimental_readRawConfig({ config: configPath }).rawConfig;
        expect(String(parsed.vars?.MXQR_ALLOW_UNGUARDED_REMOTE_SHARE)).toBe(value);
        const result = spawnSync(process.execPath, [resolve(root, files[0]!)], {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: '' },
        });
        expect(result.status, result.stdout + result.stderr).toBe(expectedExit);
      }
      writeFileSync(configPath, source);
      const proPath = resolve(root, 'cloudflare/wrangler.pro-room.toml');
      const proSource = readFileSync(proPath, 'utf8');
      writeFileSync(
        proPath,
        proSource.replace('[vars]', '[vars]\n"PRO_ROOM_MEMBER_AUTHORITY_PROJECTION" = false'),
      );
      const retired = spawnSync(process.execPath, [resolve(root, files[0]!)], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: '' },
      });
      expect(retired.status, retired.stdout + retired.stderr).toBe(1);
      expect(retired.stderr).toContain('PRO_ROOM_MEMBER_AUTHORITY_PROJECTION');
      writeFileSync(proPath, proSource);
      writeFileSync(configPath, '[vars]\nsecret = "sensitive-parser-excerpt\n');
      const invalid = spawnSync(process.execPath, [resolve(root, files[0]!)], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: '' },
      });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('Production security configuration is unreadable');
      expect(invalid.stdout + invalid.stderr).not.toContain('sensitive-parser-excerpt');
    } finally {
      cleanup();
    }
  }, 60_000);

  it.each([
    ['true # operator note', 'true'],
    ['"true" # operator note', '"true"'],
    ["'true' # operator note", "'true'"],
    ['false # operator note', 'false'],
    ['"false" # operator note', '"false"'],
    ['"true#value" # operator note', '"true#value"'],
    ["'true#value' # operator note", "'true#value'"],
    ['"value\\"#inside" # outside', '"value\\"#inside"'],
    ['"value\\\\" # outside', '"value\\\\"'],
  ])('reads file value %s', (source, expected) => {
    expect(readConfigurationAssignment(`FLAG = ${source}`, 'FLAG')).toBe(expected);
    expect(readConfigurationAssignment(`# FLAG = ${source}`, 'FLAG')).toBeNull();
  });

  it('accepts inline comments on the existing Remote Share rollout values', () => {
    const config = REMOTE_SHARE_ROLLOUT.replace('"120"', '"120" # room limit').replace(
      '"required"',
      '"required" # assertion policy',
    );
    expect(validateRemoteShareRolloutConfig(config, SIGNALING_ASSERTION_SECRET)).toEqual([]);
  });
});

describe('production account launch guard', () => {
  it('rejects either retired projection flag while ignoring comments', () => {
    expect(
      validateAccountRolloutConfig(
        `${PRO_WITH_AUTH_DB}\nPRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = "1"`,
        APP_WITH_AUTH_DB,
      ),
    ).toEqual(['Retired PRO account projection flags must not be present.']);
    expect(
      validateAccountRolloutConfig(
        `${PRO_WITH_AUTH_DB}\nPRO_ROOM_MEMBER_AUTHORITY_PROJECTION = "0"`,
        APP_WITH_AUTH_DB,
      ),
    ).toEqual(['Retired PRO account projection flags must not be present.']);
    expect(
      validateAccountRolloutConfig(
        `${PRO_WITH_AUTH_DB}\n# PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION = "1"`,
        APP_WITH_AUTH_DB,
      ),
    ).toEqual([]);
  });

  it('requires the account database in both PRO and App Workers', () => {
    expect(validateAccountRolloutConfig('', APP_WITH_AUTH_DB)).toEqual([
      'PRO room decommissioning is enabled without an active MUSIXQUARE_AUTH_DB Worker binding.',
    ]);
    expect(validateAccountRolloutConfig(PRO_WITH_AUTH_DB, '')).toEqual([
      'Account identity is enabled without an active MUSIXQUARE_AUTH_DB App binding.',
    ]);
    expect(validateAccountRolloutConfig('', '')).toEqual([
      'PRO room decommissioning is enabled without an active MUSIXQUARE_AUTH_DB Worker binding.',
      'Account identity is enabled without an active MUSIXQUARE_AUTH_DB App binding.',
    ]);
  });

  it('accepts the launch contract with both exact account bindings', () => {
    expect(validateAccountRolloutConfig(PRO_WITH_AUTH_DB, APP_WITH_AUTH_DB)).toEqual([]);
  });
});

describe('production Remote Share rollout guard', () => {
  it('accepts required assertions with a bounded room limit and metrics binding', () => {
    expect(
      validateRemoteShareRolloutConfig(REMOTE_SHARE_ROLLOUT, SIGNALING_ASSERTION_SECRET),
    ).toEqual([]);
  });

  it.each(['0', '-1', '1.5', '1025', 'not-a-number'])(
    'rejects unsafe room allocation limit %s',
    (limit) => {
      expect(
        validateRemoteShareRolloutConfig(
          REMOTE_SHARE_ROLLOUT.replace('"120"', `"${limit}"`),
          SIGNALING_ASSERTION_SECRET,
        ),
      ).toContain('ROOM_UPLOADS_PER_WINDOW must be an integer from 1 through 1024.');
    },
  );

  it('rejects optional, disabled, or missing assertions, telemetry, and either secret declaration', () => {
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('"required"', '"optional"'),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('ROOM_UPLOAD_ASSERTION_MODE must be required in production.');
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('"required"', '"disabled"'),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('ROOM_UPLOAD_ASSERTION_MODE must be required in production.');
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('ROOM_UPLOAD_ASSERTION_MODE = "required"', ''),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('ROOM_UPLOAD_ASSERTION_MODE must be required in production.');
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('binding = "MUSIXQUARE_ADMIN_DB"', ''),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('Remote Share assertion rollout requires the MUSIXQUARE_ADMIN_DB binding.');
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET', 'OTHER_SECRET'),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('Remote Share and signaling must both declare the shared assertion secret name.');
    expect(validateRemoteShareRolloutConfig(REMOTE_SHARE_ROLLOUT, '')).toContain(
      'Remote Share and signaling must both declare the shared assertion secret name.',
    );
    expect(
      validateRemoteShareRolloutConfig(
        REMOTE_SHARE_ROLLOUT.replace('binding = "CF_VERSION_METADATA"', ''),
        SIGNALING_ASSERTION_SECRET,
      ),
    ).toContain('Remote Share release approval requires the CF_VERSION_METADATA binding.');
  });
});
